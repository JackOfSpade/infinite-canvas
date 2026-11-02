// Operational values the practice connector needs.  The socket location is
// deliberately the one an existing setup already uses, so it keeps working
// without being redone.
export const CONSTANTS = Object.freeze({
  SOCKET_RELATIVE_PATH: 'handoff-bridge/b.sock',
  SOCKET_PATH_MAX_BYTES: 100,
  SOCKET_MODE_OCTAL: 0o600,
  BRIDGE_DIRECTORY_MODE_OCTAL: 0o700,
  BUCKET_SOURCE_V6_BITS: 64,
});
