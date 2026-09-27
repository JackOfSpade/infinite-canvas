import { isValidHostname, isValidSocketPath } from '../../../../src/utils/handoffBridgeConfig.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9 _.@+=,()~/-]+$/;

export function validateTunnelId(value) {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

export function validateTunnelHostname(value) { return isValidHostname(value) ? value : null; }

export function validateCredentialsPath(value, tunnelId = null) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 || !value.startsWith('/') || value.includes('..') || !SAFE_PATH_RE.test(value)) return null;
  const basename = value.split('/').at(-1);
  if (!UUID_RE.test(basename.slice(0, -5)) || !basename.endsWith('.json')) return null;
  if (tunnelId && basename !== `${tunnelId}.json`) return null;
  return value;
}

export function validateTunnelConfig({ tunnelId, hostname, credentialsPath, socketPath } = {}) {
  const id = validateTunnelId(tunnelId);
  const host = validateTunnelHostname(hostname);
  const credentials = validateCredentialsPath(credentialsPath, id);
  const socket = isValidSocketPath(socketPath) ? socketPath : null;
  return id && host && credentials && socket ? Object.freeze({ tunnelId: id, hostname: host, credentialsPath: credentials, socketPath: socket }) : null;
}
