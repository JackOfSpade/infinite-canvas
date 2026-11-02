// Values local to the cloudflared supervisor.  This module deliberately has
// no imports: it is also used by the source-level safety scan.
export const TUNNEL_CONSTANTS = Object.freeze({
  DIRECTORY_MODE_OCTAL: 0o700,
  FILE_MODE_OCTAL: 0o600,
  BINARY_MODE_OCTAL: 0o500,
  MIN_BINARY_BYTES: 5 * 1024 * 1024,
  MAX_BINARY_BYTES: 256 * 1024 * 1024,
  METRICS_PORT_MIN: 49152,
  METRICS_PORT_MAX: 65535,
  LOG_RING_LINES: 400,
  LOG_RING_BYTES: 128 * 1024,
  CRASH_WINDOW_MS: 10 * 60_000,
  CRASH_LIMIT: 5,
  UNREQUESTED_EXIT_LIMIT: 3,
  BACKOFF_SECONDS: Object.freeze([1, 2, 4, 8, 16, 30]),
  READY_POLL_MS: 1_000,
  PUBLIC_PROBE_INITIAL_MS: 2_000,
  PUBLIC_PROBE_MS: 5_000,
  TUNNEL_LABEL: 'infinite-canvas',
  TUNNEL_GRACE_PERIOD: '2s',
  MANAGEMENT_DIAGNOSTICS: 'false',
});

export const MESSAGES = Object.freeze({
  'binary-not-found': 'Choose a cloudflared binary.', 'binary-unsafe-path': 'The binary path is not safe.',
  'binary-quarantined': 'The binary is quarantined.', 'binary-signature-invalid': 'The binary signature could not be verified.',
  'binary-unrecognized': 'The binary version is not recognized.', 'binary-untrusted': 'Approve the copied binary first.',
  'binary-changed': 'The approved binary copy changed.', 'binary-copy-failed': 'The binary copy could not be prepared.',
  'flag-rejected': 'This cloudflared version rejects a required safety flag.', 'hostname-not-public': 'The hostname is not publicly reachable.',
  'unrequested-exit-loop': 'The tunnel exited unexpectedly too often.', 'credentials-invalid': 'The tunnel credentials are not valid.',
  'bad-hostname': 'The hostname is not valid.', 'bad-socket-path': 'The bridge socket path is not valid.',
  'config-rejected': 'The tunnel configuration was rejected.', 'spawn-failed': 'The tunnel could not be started.',
  'not-ready': 'Tunnel setup is incomplete.', 'tunnel-not-serving': 'The tunnel is not serving the bridge.',
  'origin-unreachable': 'The bridge origin is unreachable.', 'ingress-mismatch': 'The tunnel ingress does not match.',
  'edge-blocked': 'The edge rejected the tunnel.', 'wrong-origin': 'The public endpoint returned the wrong origin.',
  'dns-not-found': 'The hostname could not be resolved.', 'edge-unreachable': 'The edge is unreachable.',
  offline: 'The computer is offline.', backoff: 'The tunnel will retry shortly.', 'crash-loop': 'The tunnel crashed too often.',
  'stop-stuck': 'The tunnel did not stop in time.', 'owned-elsewhere': 'A tunnel is already owned elsewhere.',
  'tunnel-auth-rejected': 'The tunnel authentication was rejected.',
  'cert-present': 'A legacy cert.pem was found and is not used.',
  'binary-old': 'The approved cloudflared copy is over 180 days old.',
});

// Do not interpolate into this program.  Every dynamic value is a positional
// argument supplied to /bin/sh, which lets the watchdog survive an app crash.
export const WATCHDOG_SCRIPT = `app=$1; shift
"$@" & c=$!
s=
stopc() { kill -TERM "$c" 2>/dev/null; n=0; while kill -0 "$c" 2>/dev/null && [ "$n" -lt 12 ]; do sleep 0.2 & s=$!; wait $s; n=$((n+1)); done; kill -TERM "$c" 2>/dev/null; if kill -0 "$c" 2>/dev/null; then sleep 1 & s=$!; wait $s; kill -KILL "$c" 2>/dev/null; fi; wait "$c" 2>/dev/null; }
trap 'kill $s 2>/dev/null; stopc; exit 0' TERM INT
while kill -0 "$app" 2>/dev/null && kill -0 "$c" 2>/dev/null; do sleep 1 & s=$!; wait $s; done
stopc`;

export default TUNNEL_CONSTANTS;
