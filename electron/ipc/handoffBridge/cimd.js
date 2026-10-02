import crypto from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const DEFAULT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const DEFAULT_JWKS_URL = 'https://chatgpt.com/oauth/jwks.json';
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CAP_BYTES = 16 * 1024;
const DEFAULT_CONCURRENCY = 4;
const CACHE_MS = 60 * 60_000;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');

const NON_PUBLIC = new net.BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) NON_PUBLIC.addSubnet(address, bits, 'ipv4');
for (const [address, bits] of [
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) NON_PUBLIC.addSubnet(address, bits, 'ipv6');

export function isPublicAddress(address) {
  const family = net.isIP(address);
  return family !== 0 && !NON_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// The check is performed by the lookup callback used by the TLS socket, so
// there is no check/connect rebinding window. One private answer poisons the
// whole result; selecting a public member from a mixed response is unsafe.
export function guardedLookup(host, options, callback, lookup = dns.lookup) {
  const requested = isObject(options) ? options : {};
  lookup(host, { ...requested, all: true, verbatim: true }, (error, answer) => {
    if (error) return callback(error);
    const records = Array.isArray(answer) ? answer : (answer ? [answer] : []);
    if (records.length === 0 || records.some(record => !isObject(record) || !isPublicAddress(record.address))) {
      return callback(new Error('hostname did not resolve exclusively to public addresses'));
    }
    if (requested.all) return callback(null, records);
    return callback(null, records[0].address, records[0].family);
  });
}

function exactPinnedUrl(value, pins) {
  if (typeof value !== 'string' || !pins.includes(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.href !== value || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) return null;
    if (net.isIP(parsed.hostname.replace(/^\[|\]$/g, ''))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function contentTypeIsJson(headers) {
  const type = String(headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

export function createGuardedJsonFetcher({
  request = https.request,
  lookup = dns.lookup,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  capBytes = DEFAULT_CAP_BYTES,
  concurrency = DEFAULT_CONCURRENCY,
  pins,
  cacheMs = 0,
} = {}) {
  if (!Array.isArray(pins) || pins.length === 0 || pins.some(pin => !exactPinnedUrl(pin, pins))) throw new TypeError('one or more exact HTTPS pins are required');
  let active = 0;
  const cache = new Map();

  return async value => {
    const target = exactPinnedUrl(value, pins);
    if (!target) return null;
    const cached = cache.get(value);
    if (cached && cached.expiresAt > now()) return cached.document;
    if (active >= concurrency) return null;
    active += 1;
    try {
      const document = await new Promise((resolve, reject) => {
        let settled = false;
        let hardTimer;
        let req;
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          try { if (hardTimer !== undefined) clearTimeoutImpl(hardTimer); } catch { /* settlement must continue */ }
          if (error) reject(error); else resolve(result);
        };
        try {
          req = request(target, {
            method: 'GET',
            headers: { accept: 'application/json', 'user-agent': 'infinite-canvas-oauth/1' },
            agent: false,
            lookup: (host, options, callback) => guardedLookup(host, options, callback, lookup),
          }, response => {
            if (response.statusCode !== 200 || response.headers?.location || !contentTypeIsJson(response.headers)) {
              response.resume?.();
              finish(new Error('guarded JSON response rejected'));
              return;
            }
            const chunks = [];
            let total = 0;
            response.on('data', chunk => {
              if (settled) return;
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              total += bytes.length;
              if (total > capBytes) {
                try { req.destroy?.(); } catch { /* finish below */ }
                finish(new Error('guarded JSON response too large'));
              } else chunks.push(bytes);
            });
            response.on('end', () => {
              if (settled) return;
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!isObject(parsed)) throw new TypeError('JSON response must be an object');
                finish(null, parsed);
              } catch (error) { finish(error); }
            });
            response.on('error', error => finish(error));
          });
          hardTimer = setTimeoutImpl(() => {
            try { req?.destroy?.(); } catch { /* finish below */ }
            finish(new Error('guarded JSON request timed out'));
          }, timeoutMs);
          hardTimer?.unref?.();
          if (settled) {
            try { clearTimeoutImpl(hardTimer); } catch { /* already settled */ }
          }
          req.setTimeout?.(timeoutMs, () => {
            try { req.destroy?.(); } catch { /* finish below */ }
            finish(new Error('guarded JSON request timed out'));
          });
          req.on?.('error', error => finish(error));
          req.end?.();
        } catch (error) { finish(error); }
      }).catch(() => null);
      if (document && cacheMs > 0) cache.set(value, { document, expiresAt: now() + cacheMs });
      return document;
    } finally {
      active -= 1;
    }
  };
}

export function validateClientMetadata(document, clientId) {
  if (!isObject(document) || document.client_id !== clientId) return null;
  if (!Array.isArray(document.redirect_uris) || document.redirect_uris.length === 0 || !document.redirect_uris.some(uri => uri === REDIRECT_URI)) return null;
  if (document.redirect_uris.some(uri => uri !== REDIRECT_URI)) return null;
  if (Object.keys(document).some(key => /^client_secret(?:_|$)/.test(key))) return null;
  const methods = document.token_endpoint_auth_methods_supported;
  if (!Array.isArray(methods) || !methods.includes('none') || methods.some(method => method !== 'none' && method !== 'private_key_jwt')) return null;
  if (methods.includes('private_key_jwt')) {
    if (document.jwks_uri !== DEFAULT_JWKS_URL) return null;
    if (document.token_endpoint_auth_signing_alg !== undefined && document.token_endpoint_auth_signing_alg !== 'RS256') return null;
  }
  return Object.freeze({
    id: clientId,
    clientKind: 'cimd',
    clientHost: new URL(clientId).host,
    name: cleanClientName(document.client_name),
    redirectUris: Object.freeze([REDIRECT_URI]),
    grantTypes: Object.freeze(['authorization_code', 'refresh_token']),
    authMethods: Object.freeze([...methods]),
    jwksUri: methods.includes('private_key_jwt') ? DEFAULT_JWKS_URL : null,
    metadataHash: digest(JSON.stringify(document)),
  });
}

function cleanClientName(value) {
  if (typeof value !== 'string') return 'ChatGPT';
  const plain = value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  return Array.from(plain).slice(0, 120).join('').trim() || 'ChatGPT';
}

export function createCimdFetcher(options = {}) {
  const clientIds = options.clientIds || Object.freeze([DEFAULT_CLIENT_ID]);
  const fetchJson = options.fetchJson || createGuardedJsonFetcher({
    ...options,
    pins: clientIds,
    cacheMs: options.cacheMs ?? CACHE_MS,
  });
  return async clientId => {
    if (!clientIds.includes(clientId)) return null;
    const document = await fetchJson(clientId);
    return validateClientMetadata(document, clientId);
  };
}

export function createJwksFetcher(options = {}) {
  const jwksUrl = options.jwksUrl || DEFAULT_JWKS_URL;
  const fetchJson = options.fetchJson || createGuardedJsonFetcher({ ...options, pins: [jwksUrl] });
  return async () => {
    const document = await fetchJson(jwksUrl);
    if (!isObject(document) || !Array.isArray(document.keys)) return null;
    return { keys: document.keys.filter(isObject).map(key => {
      const copy = Object.create(null);
      for (const name of ['kty', 'use', 'key_ops', 'alg', 'kid', 'n', 'e']) if (Object.hasOwn(key, name)) copy[name] = key[name];
      return copy;
    }) };
  };
}

export { DEFAULT_CLIENT_ID, DEFAULT_JWKS_URL, REDIRECT_URI };
