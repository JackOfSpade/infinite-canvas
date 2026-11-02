// Hostname and socket-path checks copied from the shared bridge config helper
// so the practice connector has no dependency on bridge code.
const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${HOST_LABEL}(?:\\.${HOST_LABEL}){2,}$`);
const SAFE_SOCKET = /^[A-Za-z0-9_./ -]+$/;
const CONTROL_OR_NON_ASCII = /[^\x20-\x7e]/;

export function isValidHostname(value) {
  return typeof value === 'string'
    && value.length <= 253
    && value === value.toLowerCase()
    && !value.endsWith('.')
    && !CONTROL_OR_NON_ASCII.test(value)
    && !value.includes('..')
    && value.split('.').every(label => !label.startsWith('xn--'))
    && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
    && !value.includes(':')
    && HOSTNAME.test(value);
}

export function isValidSocketPath(value, maxBytes = 100) {
  return typeof value === 'string'
    && value.startsWith('/')
    && value.length > 1
    && !value.endsWith('/')
    && new TextEncoder().encode(value).length <= maxBytes
    && SAFE_SOCKET.test(value)
    && !value.includes('//')
    && !value.split('/').some(part => part === '.' || part === '..');
}

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
