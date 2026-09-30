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

// ---------------------------------------------------------------------------
// Application lane queue, for FULL bug reports.
//
// The report used to carry no lane state at all, so a released lane whose
// bundle had been discarded could not be told apart from a healthy one. This
// is a PULL: the composition registers a provider, the report asks for a view
// when it is generated, and everything is reduced here to closed enums,
// integers and an 8-hex job prefix. No path, title, company, prompt, handoff
// code, chat key or hostname can pass through it. The provider returns null
// when the person's report-telemetry opt-in is off.
const QUEUE_PHASES = new Set(['unread', 'awaiting', 'host', 'needs_user', 'held', 'done', 'gone']);
const QUEUE_STAGES = new Set(['evidence-plan', 'resume', 'cover-letter', 'review']);
const QUEUE_REASONS = new Set(['user_hold', 'human_advance', 'rejection_cap', 'junk_cap', 'review_round_cap', 'job_broken', 'render_retry', 'canvas_unavailable', 'read_failed', 'write_failed', 'submit_stuck', 'host_silent', 'lapsed', 'restart']);
const QUEUE_SERVING = new Set(['off', 'live', 'paused', 'stopping', 'starting', 'failed', 'error']);
const QUEUE_PAUSE_CAUSES = new Set(['user', 'idle', 'anomaly', 'network', 'expiry', 'sleep', 'quit', 'tunnel', 'other']);
const QUEUE_FAULTS = new Set(['persist_failed', 'source_failed', 'other']);
const QUEUE_CHAT_STATES = new Set(['none', 'awaiting-first-call', 'reached', 'working', 'idle', 'full', 'ended']);
const QUEUE_COUNT_KEYS = ['releaseCalls', 'releaseNoops', 'unreleaseCalls', 'lanesDropped', 'droppedDiscarded', 'droppedPruned', 'droppedMissing', 'droppedSaved'];
const QUEUE_MAX_LANES = 20;

let queueProvider = null;
let retiredQueue = null;

const smallInt = (value, max = 999999) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;

export function reduceBridgeQueue(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = finite(raw.at) ?? Date.now();
  const applications = raw.queue && typeof raw.queue === 'object' ? raw.queue : {};
  const chat = raw.chat && typeof raw.chat === 'object' ? raw.chat : {};
  const lanes = [];
  // Live lanes are what a report is FOR, so they are kept first and in full;
  // the room left over goes to the most recently changed finished lanes. (The
  // first-N-in-array-order this replaced kept the OLDEST lanes and could drop a
  // live one behind finished ones.)
  const rawLanes = Array.isArray(raw.lanes) ? raw.lanes.filter(lane => lane && typeof lane === 'object') : [];
  const isTerminal = lane => lane.phase === 'done' || lane.phase === 'gone';
  const changedAtOf = lane => finite(lane.changedAt) ?? 0;
  const ordered = [
    ...rawLanes.filter(lane => !isTerminal(lane)),
    ...rawLanes.filter(isTerminal).sort((a, b) => changedAtOf(b) - changedAtOf(a)),
  ].slice(0, QUEUE_MAX_LANES);
  for (const lane of ordered) {
    const match = typeof lane.jobId === 'string' ? /^([a-f0-9]{8})-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.exec(lane.jobId) : null;
    if (!match) continue;
    const changed = finite(lane.changedAt);
    lanes.push(Object.freeze({
      job: match[1].toLowerCase(),
      phase: enumOr(lane.phase, QUEUE_PHASES, 'unread'),
      stage: enumOr(lane.stage, QUEUE_STAGES, null),
      reason: enumOr(lane.reason, QUEUE_REASONS, null),
      servedToChat: Number.isSafeInteger(lane.servedToChat) && lane.servedToChat >= 0,
      ageSeconds: changed === null ? null : Math.max(0, Math.floor((at - changed) / 1000)),
    }));
  }
  const counts = {};
  for (const key of QUEUE_COUNT_KEYS) counts[key] = smallInt(raw.counts?.[key]);
  // Chat keys the engine did not recognise: counts and one time, nothing more.
  const keys = raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
  const lastUnrecognisedAt = finite(keys.lastUnrecognisedAt);
  return Object.freeze({
    at,
    enabled: raw.enabled === true,
    serving: enumOr(raw.serving, QUEUE_SERVING, 'unknown'),
    // Counted from the whole queue, never from the (possibly truncated) list.
    liveLanes: smallInt(smallInt(applications.ready) + smallInt(applications.working) + smallInt(applications.needsYou)),
    autoRelease: raw.autoRelease === true,
    paused: raw.paused === null || raw.paused === undefined ? null : enumOr(raw.paused, QUEUE_PAUSE_CAUSES, 'other'),
    fault: raw.fault === null || raw.fault === undefined ? null : enumOr(raw.fault, QUEUE_FAULTS, 'other'),
    applications: Object.freeze({
      ready: smallInt(applications.ready), working: smallInt(applications.working), needsYou: smallInt(applications.needsYou),
      held: smallInt(applications.held), done: smallInt(applications.done),
    }),
    chat: Object.freeze({
      state: enumOr(chat.state, QUEUE_CHAT_STATES, 'none'),
      jobsAssigned: smallInt(chat.jobsAssigned, 99), jobsCap: smallInt(chat.jobsCap, 99),
    }),
    lanes: Object.freeze(lanes),
    counts: Object.freeze(counts),
    keys: Object.freeze({
      unrecognisedRecent: smallInt(keys.unrecognisedRecent, 1000),
      unrecognisedWindowMinutes: smallInt(keys.unrecognisedWindowMinutes, 1440) || 10,
      lastUnrecognisedAt: lastUnrecognisedAt === null || lastUnrecognisedAt < 0 ? null : lastUnrecognisedAt,
      ended: smallInt(keys.ended),
    }),
  });
}

export function setBridgeQueueDiagnosticProvider(provider) {
  queueProvider = typeof provider === 'function' ? provider : null;
  retiredQueue = null;
}

// Called when a runtime is torn down: remember its final view (still evidence
// for a report generated afterwards) and stop reading the dead engine.
export function retireBridgeQueueDiagnosticProvider(provider = queueProvider) {
  // Only the provider that is still current may retire: a late teardown of an
  // old runtime must not blank the replacement's live view.
  if (queueProvider && queueProvider === provider) {
    try { retiredQueue = reduceBridgeQueue(queueProvider()); } catch { /* keep the previous view */ }
    queueProvider = null;
  }
}

export function clearBridgeQueueDiagnostic() { queueProvider = null; retiredQueue = null; }

export function getBridgeQueueDiagnostic() {
  if (queueProvider) {
    try { return reduceBridgeQueue(queueProvider()); } catch { return null; }
  }
  return retiredQueue;
}
