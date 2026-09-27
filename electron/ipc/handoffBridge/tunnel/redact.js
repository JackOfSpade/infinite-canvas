const ESC = String.fromCharCode(27);
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, 'g');
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
const OPAQUE = /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi;
const NAMED_SECRET = /\b(secret|token|authorization|bearer|password|key|TunnelSecret|AccountTag)\s*[:=]\s*(?:Bearer\s+)?\S+/gi;

export function redactLine(value, { home = '', userData = '', hostname = '' } = {}) {
  let line = String(value || '').replace(ANSI, '').replace(CONTROL, ' ');
  if (userData) line = line.split(userData).join('<userData>');
  if (home) line = line.split(home).join('~');
  if (hostname) line = line.split(hostname).join('<host>');
  return line.replace(NAMED_SECRET, '$1=<redacted>').replace(/\b([A-Za-z_][A-Za-z0-9_]{0,63})=([^\s]+)/g, '$1=<redacted>').replace(/\?[^\s]*/g, '?<redacted>').replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+/g, '<jwt>').replace(OPAQUE, '<opaque>').replace(UUID, match => `${match.slice(0, 8)}-...`).slice(0, 1024);
}
