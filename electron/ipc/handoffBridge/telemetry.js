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

let latest = null;
const finite = value => Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? Math.round(value) : null;
const enumOr = (value, allowed, fallback = 'unknown') => allowed.has(value) ? value : fallback;

export function clearFailedStartDiagnostic() { latest = null; }

export function recordFailedStartDiagnostic({ telemetry = false, phase, cause, tunnel, startedAt = null, at = Date.now() } = {}) {
  const rawTunnel = tunnel && typeof tunnel === 'object' ? tunnel : {};
  const stamp = finite(at) ?? Date.now();
  const began = finite(startedAt);
  const probe = rawTunnel.probe && typeof rawTunnel.probe === 'object' ? rawTunnel.probe : {};
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
    }),
    at: stamp,
    elapsedMs: began === null ? null : Math.max(0, Math.min(10 * 60_000, stamp - began)),
  });
  return latest;
}

export function getFailedStartDiagnostic() { return latest; }
