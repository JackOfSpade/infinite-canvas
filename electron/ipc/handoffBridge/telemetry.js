// A single redacted failed-start receipt survives runtime disposal so a FULL
// bug report can distinguish a rejected tunnel configuration from a readiness
// timeout. This module deliberately accepts and retains only closed values.

const PHASES = new Set(['listener-start', 'listener-probe', 'tunnel-start', 'tunnel-readiness']);
const CAUSES = new Set([
  'socket-unavailable', 'startup-timeout', 'readiness-timeout',
  'config-rejected', 'spawn-failed', 'flag-rejected', 'credentials-invalid',
  'tunnel-auth-rejected', 'hostname-not-public', 'network-unreachable',
  'binary-untrusted', 'binary-not-found', 'binary-changed', 'binary-copy-failed',
  'binary-copy-missing', 'binary-quarantined', 'binary-signature-invalid',
  'binary-unrecognized', 'binary-unsafe-path', 'binary-command-failed', 'owned-elsewhere',
  'metrics-port-in-use', 'unrequested-exit-loop', 'crash-loop', 'exited-early',
  'exited-unrequested', 'exited', 'stop-stuck', 'orphan-stuck', 'pid-reused', 'cancelled',
  // These can be surfaced by the supervisor's public-probe/restart path or
  // by a startup port that returns a closed supervisor result directly.
  'bad-hostname', 'bad-socket-path', 'not-ready', 'tunnel-not-serving',
  'origin-unreachable', 'ingress-mismatch', 'edge-blocked', 'edge-unreachable',
  'dns-not-found', 'offline', 'wrong-origin', 'unexpected-redirect', 'timeout',
  'too_large', 'refused', 'probe-failed', 'probe-restart', 'ps-failed', 'busy',
]);
const STATES = new Set(['off', 'blocked', 'needs-setup', 'needs-trust', 'starting', 'connecting', 'checking-public', 'online', 'degraded', 'backoff', 'paused', 'stopping', 'failed']);
const PROBE_STATES = new Set(['unknown', 'ok', 'failing']);
const PROBE_REASONS = new Set(['wrong-origin', 'unexpected-redirect', 'tunnel-not-serving', 'origin-unreachable', 'ingress-mismatch', 'edge-blocked', 'edge-unreachable', 'dns-not-found', 'hostname-not-public', 'offline', 'timeout', 'too_large', 'refused', 'other']);
const OAUTH_REJECTION_ROUTES = new Set(['authorize', 'token', 'revoke', 'mcp']);
const OAUTH_REJECTION_METHODS = new Set(['GET', 'POST']);
const OAUTH_REJECTION_REASONS = new Set(['origin-mismatch', 'fetch-site']);
const FETCH_SITES = new Set(['none', 'same-origin', 'same-site', 'cross-site', 'other']);
const OAUTH_REJECTION_STAGES = new Set(['http', 'consent']);
const FETCH_MODES = new Set(['navigate', 'other', 'absent']);
const FETCH_DESTINATIONS = new Set(['document', 'other', 'absent']);
const ORIGIN_SHAPES = new Set(['absent', 'self-exact', 'self-canonical', 'chatgpt-exact', 'opaque-null', 'https-other', 'invalid']);
const CONSENT_ACTIONS = new Set(['approve', 'deny', 'other', 'uninspected']);
const TRANSACTION_PRESENCE = new Set(['yes', 'no', 'uninspected']);
const CONSENT_POLICY_VERSIONS = new Set(['document-navigation-v2']);
const SOURCE_REJECTION_ROUTES = new Set(['mcp', 'token', 'revoke']);
const SOURCE_REJECTION_MODES = new Set(['enforce', 'alert']);
// The caller's network, placed in a closed class. A source prefix is sensitive
// link metadata, so the prefix itself never reaches this sink.
const SOURCE_CLASSES = new Set(['link-family', 'connector-range', 'other-public', 'private', 'unknown']);
const LINK_PRESENCE = new Set(['none', 'one', 'many', 'unreadable']);
// Exactly the token-endpoint outcome vocabulary from clientAuth.js. This is
// the MG1 measurement: which client authentication ChatGPT actually used.
const CLIENT_AUTH_OUTCOMES = new Set(['none', 'assertion_ok', 'assertion_bad_signature',
  'assertion_bad_claims', 'assertion_replay', 'assertion_unknown_kid', 'other']);
// Which grant was authenticated. Requiring an assertion is only justified once
// `refresh_token` has been seen signed; the code exchange alone is not enough.
const CLIENT_AUTH_GRANTS = new Set(['authorization_code', 'refresh_token', 'other']);

let latest = null;
let latestOAuthRejection = null;
let latestSourceRejection = null;
let latestClientAuth = null;
const finite = value => Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? Math.round(value) : null;
const enumOr = (value, allowed, fallback = 'unknown') => allowed.has(value) ? value : fallback;

export function clearFailedStartDiagnostic() { latest = null; }

export function recordFailedStartDiagnostic({ telemetry = false, phase, cause, tunnel, startedAt = null, at = Date.now() } = {}) {
  const rawTunnel = tunnel && typeof tunnel === 'object' ? tunnel : {};
  const stamp = finite(at) ?? Date.now();
  const began = finite(startedAt);
  const probe = rawTunnel.probe && typeof rawTunnel.probe === 'object' ? rawTunnel.probe : {};
  const readiness = rawTunnel.readiness && typeof rawTunnel.readiness === 'object' ? rawTunnel.readiness : {};
  latest = Object.freeze({
    telemetry: telemetry === true,
    phase: enumOr(phase, PHASES),
    cause: enumOr(cause ?? rawTunnel.lastExit, CAUSES),
    tunnel: Object.freeze({
      state: enumOr(rawTunnel.state, STATES),
      lastExit: enumOr(rawTunnel.lastExit, CAUSES, null),
      probe: Object.freeze({
        state: enumOr(probe.state, PROBE_STATES),
        reason: enumOr(probe.reason, PROBE_REASONS),
        consecutiveFailures: Math.max(0, Math.min(999, finite(probe.consecutiveFailures) ?? 0)),
      }),
      readiness: Object.freeze({
        configurationValidated: readiness.configurationValidated === true,
        environmentHealthy: readiness.environmentHealthy === true,
        localReadinessPassed: readiness.localReadinessPassed === true,
        registeredConnectionCount: Math.max(0, Math.min(8, finite(readiness.registeredConnectionCount) ?? 0)),
      }),
    }),
    at: stamp,
    elapsedMs: began === null ? null : Math.max(0, Math.min(10 * 60_000, stamp - began)),
  });
  return latest;
}

export function getFailedStartDiagnostic() { return latest; }

// A rejected browser-origin check is useful support evidence, but its raw
// request data is never safe to retain. Keep one bounded, opt-in aggregate of
// fixed policy categories instead. In particular, this accepts no URL,
// hostname, Origin value, header, body, OAuth state, code, pairing value, or
// credential. Header values are classified inside http.js before this sink.
export function clearOAuthRejectionDiagnostic() { latestOAuthRejection = null; }

export function recordOAuthRejectionDiagnostic({ telemetry = false, route, method, reason, stage, fetchSite, fetchMode, fetchDest, originShape, consentAction, hasTxn, consentPolicyVersion, at = Date.now() } = {}) {
  if (telemetry !== true) return null;
  const stamp = finite(at) ?? Date.now();
  latestOAuthRejection = Object.freeze({
    telemetry: true,
    count: Math.min(999, (latestOAuthRejection?.telemetry === true ? latestOAuthRejection.count : 0) + 1),
    at: stamp,
    last: Object.freeze({
      route: enumOr(route, OAUTH_REJECTION_ROUTES),
      method: enumOr(method, OAUTH_REJECTION_METHODS),
      reason: enumOr(reason, OAUTH_REJECTION_REASONS),
      stage: enumOr(stage, OAUTH_REJECTION_STAGES),
      fetchSite: enumOr(fetchSite, FETCH_SITES),
      fetchMode: enumOr(fetchMode, FETCH_MODES),
      fetchDest: enumOr(fetchDest, FETCH_DESTINATIONS),
      originShape: enumOr(originShape, ORIGIN_SHAPES),
      consentAction: enumOr(consentAction, CONSENT_ACTIONS),
      hasTxn: enumOr(hasTxn, TRANSACTION_PRESENCE),
      consentPolicyVersion: enumOr(consentPolicyVersion, CONSENT_POLICY_VERSIONS),
      status: 403,
    }),
  });
  return latestOAuthRejection;
}

export function getOAuthRejectionDiagnostic() { return latestOAuthRejection; }

// A refused source answers ONE question a generic 401 cannot: the caller
// authenticated fine but reached us from a network this link was not paired
// from. Without it the failure reads as an expired token and the real cause --
// the connector's egress moving outside the pinned prefixes -- is invisible.
// Closed classes only: no address, prefix, hostname, header, or credential.
export function clearSourceRejectionDiagnostic() { latestSourceRejection = null; }

export function recordSourceRejectionDiagnostic({ telemetry = false, route, mode, sourceClass, links, at = Date.now() } = {}) {
  if (telemetry !== true) return null;
  const stamp = finite(at) ?? Date.now();
  latestSourceRejection = Object.freeze({
    telemetry: true,
    count: Math.min(999, (latestSourceRejection?.telemetry === true ? latestSourceRejection.count : 0) + 1),
    at: stamp,
    last: Object.freeze({
      route: enumOr(route, SOURCE_REJECTION_ROUTES),
      mode: enumOr(mode, SOURCE_REJECTION_MODES),
      sourceClass: enumOr(sourceClass, SOURCE_CLASSES),
      links: enumOr(links, LINK_PRESENCE),
    }),
  });
  return latestSourceRejection;
}

export function getSourceRejectionDiagnostic() { return latestSourceRejection; }

// Which client authentication the connector actually used at the token
// endpoint. The outcome was already computed there and then discarded, so the
// choice between pinning `private_key_jwt` and accepting `none` had no
// evidence behind it. Closed outcome vocabulary only: no assertion, key,
// header, claim, or credential.
export function clearClientAuthDiagnostic() { latestClientAuth = null; }

export function recordClientAuthDiagnostic({ telemetry = false, outcome, grant, at = Date.now() } = {}) {
  if (telemetry !== true) return null;
  const stamp = finite(at) ?? Date.now();
  const resolved = enumOr(outcome, CLIENT_AUTH_OUTCOMES);
  const resolvedGrant = enumOr(grant, CLIENT_AUTH_GRANTS);
  const priorRefresh = latestClientAuth?.telemetry === true && latestClientAuth.refreshSigned === true;
  latestClientAuth = Object.freeze({
    telemetry: true,
    count: Math.min(999, (latestClientAuth?.telemetry === true ? latestClientAuth.count : 0) + 1),
    at: stamp,
    outcome: resolved,
    grant: resolvedGrant,
    // Sticky: the decisive fact is whether a refresh has EVER been seen signed,
    // not whether the most recent exchange happened to be one.
    refreshSigned: priorRefresh || (resolvedGrant === 'refresh_token' && resolved === 'assertion_ok'),
    // The single fact the pin decision needs, stated without inference.
    method: resolved === 'none' ? 'none' : resolved === 'assertion_ok' ? 'assertion' : 'unknown',
  });
  return latestClientAuth;
}

export function getClientAuthDiagnostic() { return latestClientAuth; }

// The live supervisor owns a redacted output ring, but a failed startup tears
// that owner down before the renderer can ask for it.  Preserve a short
// *structured* substitute rather than copying arbitrary child output into a
// longer-lived store.  Every interpolated value below has already passed a
// closed enum gate in recordFailedStartDiagnostic(), so this cannot disclose a
// path, hostname, tunnel/connector id, credential, or secret.
export function getFailedStartDiagnosticLines() {
  if (latest?.telemetry !== true) return Object.freeze([]);
  const tunnel = latest.tunnel || {};
  const probe = tunnel.probe || {};
  const readiness = tunnel.readiness || {};
  const lines = [
    `Bridge startup failed: ${latest.phase}.`,
    `Startup cause: ${latest.cause}.`,
    `Tunnel state: ${tunnel.state}; last exit: ${tunnel.lastExit || 'none'}.`,
    `Configuration validation: ${readiness.configurationValidated === true ? 'passed' : 'not completed'}; environment check: ${readiness.environmentHealthy === true ? 'healthy' : 'not observed'}; local readiness: ${readiness.localReadinessPassed === true ? 'passed' : 'not confirmed'}.`,
    `Observed registered tunnel connections: ${readiness.registeredConnectionCount || 0}.`,
  ];
  if (probe.state === 'failing') {
    lines.push(`Public probe: ${probe.reason}; consecutive failures: ${probe.consecutiveFailures}.`);
  }
  return Object.freeze(lines);
}
