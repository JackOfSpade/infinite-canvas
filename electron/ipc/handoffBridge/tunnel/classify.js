export function classifyExit({ code = null, signal = null, lines = [], requested = false } = {}) {
  const text = lines.join('\n').toLowerCase();
  if (/flag provided but not defined/.test(text)) return 'flag-rejected';
  if (/tunnel authentication failed|authentication rejected|unauthorized.*tunnel/.test(text)) return 'tunnel-auth-rejected';
  if (/credentials|tunnel secret|authentication failed/.test(text)) return 'credentials-invalid';
  if (/network is unreachable|no route/.test(text)) return 'network-unreachable';
  if (/address already in use/.test(text)) return 'metrics-port-in-use';
  if (!requested && code === 0 && !signal) return 'exited-unrequested';
  if (code === 0 && !signal) return 'exited';
  return 'exited-early';
}

export function classifyProbe({ status, body, online = true, publicAddress = true, server = '' } = {}) {
  if (!online) return 'offline';
  if (!publicAddress) return 'hostname-not-public';
  if (status === 200 && body?.resource) return 'ok';
  if (status === 530) return 'tunnel-not-serving';
  if ([502, 503, 504].includes(status)) return 'origin-unreachable';
  if (status === 404) return 'ingress-mismatch';
  if ([403, 429].includes(status) && /cloudflare/i.test(server)) return 'edge-blocked';
  if (status >= 300 && status < 400) return 'unexpected-redirect';
  if (status === 'ENOTFOUND') return 'dns-not-found';
  return 'edge-unreachable';
}
