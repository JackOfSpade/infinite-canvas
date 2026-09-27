import crypto from 'node:crypto';
import https from 'node:https';
import { guardedLookup } from './cimd.js';

// This module is deliberately the one small exception to the bridge's usual
// "no network imports" rule.  `fetch` cannot select an address family or take
// our guarded DNS lookup, so pairing and the tunnel public check both come
// through this injected, bounded https.request seam.

export const PROBE_PATH = '/.well-known/oauth-protected-resource/mcp';
export const PROBE_MAX_BYTES = 16 * 1024;
export const PROBE_TIMEOUT_MS = 8_000;
const MAX_ACTIVE_PROBE_NONCES = 8;
const PROBE_NONCE_RE = /^[A-Za-z0-9_-]{24}$/;
const PROBE_MAC_RE = /^[A-Za-z0-9_-]{43}$/;

const isHostname = value => typeof value === 'string'
  && value.length <= 253
  // A normal public hostname has at least two labels: `example.com` is a
  // valid probe target too.  Keep this deliberately ASCII-only; URL parsing
  // and DNS must never turn renderer/config input into an IDN surprise.
  && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);

function safeBuffer(value) {
  try {
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'string' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return Buffer.from(value);
  } catch { /* hostile chunks are a failed request, not an uncaught event */ }
  return null;
}

function classifyResponse({ statusCode, headers, body }, hostname) {
  const status = Number(statusCode);
  if (status === 200) {
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      return parsed && parsed.resource === `https://${hostname}/mcp` ? 'ok' : 'wrong-origin';
    } catch { return 'wrong-origin'; }
  }
  if (status >= 300 && status < 400) return 'unexpected-redirect';
  if (status === 530) return 'tunnel-not-serving';
  if ([502, 503, 504].includes(status)) return 'origin-unreachable';
  if (status === 404) return 'ingress-mismatch';
  if ([403, 429].includes(status) && /cloudflare/i.test(String(headers?.server || ''))) return 'edge-blocked';
  return 'edge-unreachable';
}

function requestErrorCode(error) {
  if (error?.code === 'ECONNREFUSED') return 'refused';
  if (error?.code === 'ETIMEDOUT') return 'timeout';
  return 'network';
}

function classifyTransportError(error) {
  if (error === 'timeout') return 'timeout';
  if (error === 'too_large') return 'too_large';
  if (error === 'refused') return 'refused';
  return 'edge-unreachable';
}

function requestBounded(request, target, options, {
  timeoutMs = PROBE_TIMEOUT_MS,
  maxBytes = PROBE_MAX_BYTES,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof request !== 'function') return Promise.resolve({ error: 'unavailable' });
  const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, PROBE_MAX_BYTES) : PROBE_MAX_BYTES;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PROBE_TIMEOUT_MS;
  return new Promise(resolve => {
    let done = false;
    let timer = null;
    let req;
    const finish = value => {
      if (done) return;
      done = true;
      try { if (timer !== null) clearTimeoutImpl(timer); } catch { /* no work remains */ }
      resolve(value);
    };
    const fail = kind => {
      try { req?.destroy?.(); } catch { /* finish controls settlement */ }
      finish({ error: kind });
    };
    try {
      req = target === null ? request(options, response => {
        const chunks = [];
        let total = 0;
        response.on?.('data', value => {
          if (done) return;
          const chunk = safeBuffer(value);
          if (!chunk) { fail('network'); return; }
          total += chunk.length;
          if (total > limit) { fail('too_large'); return; }
          chunks.push(chunk);
        });
        response.on?.('error', error => fail(requestErrorCode(error)));
        response.on?.('aborted', () => fail('network'));
        response.on?.('close', () => { if (!done) fail('network'); });
        response.on?.('end', () => finish({ statusCode: response.statusCode, headers: response.headers || {}, body: Buffer.concat(chunks) }));
        response.resume?.();
      }) : request(target, options, response => {
        const chunks = [];
        let total = 0;
        response.on?.('data', value => {
          if (done) return;
          const chunk = safeBuffer(value);
          if (!chunk) { fail('network'); return; }
          total += chunk.length;
          if (total > limit) { fail('too_large'); return; }
          chunks.push(chunk);
        });
        response.on?.('error', error => fail(requestErrorCode(error)));
        response.on?.('aborted', () => fail('network'));
        response.on?.('close', () => { if (!done) fail('network'); });
        response.on?.('end', () => finish({ statusCode: response.statusCode, headers: response.headers || {}, body: Buffer.concat(chunks) }));
        // A tiny fake response can be EventEmitter-like without resume().
        response.resume?.();
      });
      req.on?.('error', error => fail(requestErrorCode(error)));
      req.on?.('abort', () => fail('network'));
      req.on?.('close', () => { if (!done) fail('network'); });
      req.setTimeout?.(timeout, () => fail('timeout'));
      timer = setTimeoutImpl(() => fail('timeout'), timeout);
      timer?.unref?.();
      // Some injected request fakes deliver a whole response synchronously.
      // Do not leave their synthetic timeout behind after that completed call.
      if (done) {
        try { clearTimeoutImpl(timer); } catch { /* already settled */ }
      }
      req.end?.();
    } catch { fail('network'); }
  });
}

function makeGuardedLookup(lookup, result) {
  return (host, options, callback) => guardedLookup(host, options, (error, address, family) => {
    if (error) {
      result.lookupError = error?.code === 'ENOTFOUND' || error?.code === 'EAI_AGAIN' ? 'dns-not-found' : 'hostname-not-public';
      callback(error);
      return;
    }
    callback(null, address, family);
  }, lookup);
}

/**
 * Probe the public protected-resource document.  The guarded lookup is passed
 * to the TLS request itself, preventing a lookup/connect rebinding race.
 */
export async function publicProbe({
  hostname,
  request = https.request,
  lookup,
  timeoutMs = PROBE_TIMEOUT_MS,
  maxBytes = PROBE_MAX_BYTES,
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  if (!isHostname(hostname)) return Object.freeze({ ok: false, code: 'hostname-not-public' });
  const result = {};
  const response = await requestBounded(request, `https://${hostname}${PROBE_PATH}`, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'infinite-canvas-probe/1' },
    // `servername` is explicit for an https request whose lookup is injected.
    // Deliberately do not set rejectUnauthorized: Node's default verification
    // remains in force and a caller cannot opt out through this API.
    servername: hostname,
    agent: false,
    lookup: makeGuardedLookup(lookup, result),
  }, { timeoutMs, maxBytes, setTimeoutImpl, clearTimeoutImpl });
  if (response.error) return Object.freeze({ ok: false, code: result.lookupError || classifyTransportError(response.error) });
  const code = classifyResponse(response, hostname);
  return Object.freeze({ ok: code === 'ok', code });
}

/** Test-mode public probe.  It cannot resolve or connect to a hostname. */
export async function socketPublicProbe({
  request,
  socketPath,
  hostname,
  timeoutMs = PROBE_TIMEOUT_MS,
  maxBytes = PROBE_MAX_BYTES,
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  if (typeof socketPath !== 'string' || socketPath.length === 0 || !isHostname(hostname)) return Object.freeze({ ok: false, code: 'edge-unreachable' });
  const response = await requestBounded(request, null, {
    socketPath,
    path: PROBE_PATH,
    method: 'GET',
    headers: { host: hostname, accept: 'application/json', 'user-agent': 'infinite-canvas-probe/1' },
  }, { timeoutMs, maxBytes, setTimeoutImpl, clearTimeoutImpl });
  if (response.error) return Object.freeze({ ok: false, code: classifyTransportError(response.error) });
  const code = classifyResponse(response, hostname);
  return Object.freeze({ ok: code === 'ok', code });
}

function nonce(randomBytes) {
  const value = randomBytes(18);
  if (!Buffer.isBuffer(value) || value.length < 18) throw new TypeError('probe random source failed');
  return value.subarray(0, 18).toString('base64url');
}

/** A per-boot HMAC verifier for the listener's own public egress observations. */
export function createProbeAuthenticator({ randomBytes = crypto.randomBytes, key = null, now = Date.now } = {}) {
  const secret = key === null ? randomBytes(32) : key;
  if (!Buffer.isBuffer(secret) || secret.length < 16) throw new TypeError('probe key must be at least 16 bytes');
  const active = new Map();
  const sign = value => crypto.createHmac('sha256', secret).update(value).digest('base64url');
  const currentTime = () => {
    try { const value = Number(now()); return Number.isFinite(value) && value >= 0 ? value : null; } catch { return null; }
  };
  const prune = stamp => {
    if (stamp === null) return;
    for (const [value, expiresAt] of active) if (expiresAt < stamp) active.delete(value);
  };
  const issue = ({ ttlMs = PROBE_TIMEOUT_MS * 2 } = {}) => {
    const stamp = currentTime();
    if (stamp === null) return null;
    // Observations normally consume their nonce in the listener.  A broken
    // route must not turn missed observations into an unbounded in-memory
    // collection, so prune before issuing and refuse rather than evicting a
    // still-valid token that belongs to an in-flight probe.
    prune(stamp);
    if (active.size >= MAX_ACTIVE_PROBE_NONCES) return null;
    let value;
    try { value = nonce(randomBytes); } catch { return null; }
    if (active.has(value)) return null;
    const expiresAt = stamp + Math.max(1, Number(ttlMs) || 1);
    active.set(value, expiresAt);
    return Object.freeze({ nonce: value, header: `${value}.${sign(value)}` });
  };
  const verify = header => {
    if (typeof header !== 'string' || header.length > 256) return false;
    const [value, mac, extra] = header.split('.');
    if (extra !== undefined || !PROBE_NONCE_RE.test(value) || !PROBE_MAC_RE.test(mac)) return false;
    const expected = sign(value);
    const left = Buffer.from(mac, 'base64url'); const right = Buffer.from(expected, 'base64url');
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return false;
    const stamp = currentTime();
    const expiresAt = active.get(value);
    if (stamp === null || expiresAt === undefined) return false;
    if (expiresAt < stamp) { active.delete(value); return false; }
    active.delete(value); // one observed request per nonce
    return true;
  };
  const clearExpired = () => prune(currentTime());
  return Object.freeze({ issue, verify, clearExpired });
}

/** Runs family 4 first then 6.  A failed family is not a reason to skip the other. */
export async function probeOwnEgress({
  hostname,
  request = https.request,
  lookup,
  authenticator,
  observe = () => undefined,
  timeoutMs = PROBE_TIMEOUT_MS,
  maxBytes = PROBE_MAX_BYTES,
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  if (!isHostname(hostname) || !authenticator?.issue) return Object.freeze({ ok: false, attempts: Object.freeze([]) });
  const attempts = [];
  for (const family of [4, 6]) {
    let token = null;
    try { token = authenticator.issue({ ttlMs: timeoutMs * 2 }); } catch { token = null; }
    if (!token || typeof token.nonce !== 'string' || typeof token.header !== 'string') {
      attempts.push(Object.freeze({ family, ok: false, code: 'edge-unreachable' }));
      continue;
    }
    const response = await requestBounded(request, `https://${hostname}${PROBE_PATH}`, {
      method: 'GET',
      family,
      servername: hostname,
      agent: false,
      headers: { accept: 'application/json', 'user-agent': 'infinite-canvas-probe/1', 'x-ic-probe': token.header },
      lookup: makeGuardedLookup(lookup, {}),
    }, { timeoutMs, maxBytes, setTimeoutImpl, clearTimeoutImpl });
    const code = response.error ? classifyTransportError(response.error) : classifyResponse(response, hostname);
    const item = Object.freeze({ family, ok: code === 'ok', code });
    attempts.push(item);
    // The listener alone receives CF-Connecting-IP.  It verifies the HMAC and
    // calls observe; this module neither trusts nor exposes an address.
    try { observe({ family, nonce: token.nonce, ok: item.ok }); } catch { /* observer is optional */ }
  }
  return Object.freeze({ ok: attempts.some(item => item.ok), attempts: Object.freeze(attempts) });
}

export { classifyResponse, isHostname };
