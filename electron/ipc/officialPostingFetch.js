import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

export const OFFICIAL_FETCH_MAX_BYTES = 3 * 1024 * 1024;
export const OFFICIAL_FETCH_TIMEOUT_MS = 15_000;
export const OFFICIAL_FETCH_MAX_REDIRECTS = 5;
export const OFFICIAL_FETCH_HOP_CAPABILITY = Symbol.for('infinite-canvas.official-posting-fetch-hop-hooks');

export class OfficialPostingFetchError extends Error {
  constructor(code, { statusCode, retryAfter } = {}) {
    super(`Official posting fetch rejected: ${code}`); this.name = 'OfficialPostingFetchError'; this.code = code;
    if (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) this.statusCode = statusCode;
    if (typeof retryAfter === 'string') this.retryAfter = retryAfter.slice(0, 160);
  }
}

function hasUnsafeTextControl(body) {
  for (const character of body) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

export function isPublicOfficialAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%')) return false;
  // Restrict IPv6 to global unicast. This also excludes IPv4-mapped,
  // compatible, loopback, unspecified, ULA, multicast and link-local forms.
  // Empty components in a compressed address are zero, including the second
  // component in 2001::/32. Conservatively exclude protocol-assignment and
  // documentation prefixes from the IANA special-purpose registries.
  const [first, second] = address.split(':').map(part => Number.parseInt(part || '0', 16));
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
    && !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    && !(first === 0x3fff && second < 0x1000);
}

function fetchUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new OfficialPostingFetchError('unsafe-url'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || (url.port && url.port !== '443')
    || [...String(value)].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
    || /(?:^|\.)linkedin\.com$/iu.test(url.hostname.replace(/\.+$/u, ''))) throw new OfficialPostingFetchError('unsafe-url');
  url.hash = '';
  return url;
}
export { fetchUrl as officialPostingFetchUrl };

async function pinnedAddress(url, lookup) {
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (net.isIP(host)) {
    if (!isPublicOfficialAddress(host)) throw new OfficialPostingFetchError('unsafe-address');
    return { address: host, family: net.isIP(host) };
  }
  let rows;
  try { rows = await lookup(host, { all: true, verbatim: true }); }
  catch { throw new OfficialPostingFetchError('fetch-failed'); }
  if (!Array.isArray(rows)) rows = [rows];
  if (!rows.length || rows.some(row => !isPublicOfficialAddress(row?.address))) throw new OfficialPostingFetchError('unsafe-address');
  return { address: rows[0].address, family: net.isIP(rows[0].address) };
}

// The URL retains the original hostname for certificate verification and SNI;
// the request lookup hook returns only the already validated address. A second
// DNS lookup cannot swap a public answer for an internal address.
export async function fetchOfficialPosting(value, {
  lookup = dns.lookup, request = https.request, now = Date.now, signal, hopHooks,
} = {}) {
  let deadline = now() + OFFICIAL_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = () => controller.abort(new OfficialPostingFetchError('fetch-timeout'));
  let timer = setTimeout(timeout, OFFICIAL_FETCH_TIMEOUT_MS);
  timer.unref?.();
  const interrupted = () => controller.signal.reason instanceof OfficialPostingFetchError
    ? controller.signal.reason : new OfficialPostingFetchError('bridge-aborted');
  const bounded = promise => new Promise((resolve, reject) => {
    const cleanup = () => controller.signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(interrupted()); };
    if (controller.signal.aborted) { reject(interrupted()); return; }
    controller.signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
  // Only the trusted run scheduler/cache may pause this budget. DNS, HTTP
  // headers/body and redirect work retain one shared hard fifteen seconds.
  const hostWait = async promise => {
    const start = now(); clearTimeout(timer);
    try { return await bounded(promise); }
    finally {
      deadline += Math.max(0, now() - start);
      timer = setTimeout(timeout, Math.max(0, deadline - now())); timer.unref?.();
    }
  };
  try {
    let url = fetchUrl(value);
    const requestedUrl = url.href;
    for (let redirects = 0; ; redirects += 1) {
      if (controller.signal.aborted) throw interrupted();
      if (now() >= deadline) throw new OfficialPostingFetchError('fetch-timeout');
      const pinned = await bounded(pinnedAddress(url, lookup));
      if (controller.signal.aborted) throw interrupted();
      if (now() >= deadline) throw new OfficialPostingFetchError('fetch-timeout');
      let lease; let result; let hopError;
      try {
        if (hopHooks?.beforeRequest) {
          const pendingLease = Promise.resolve().then(() => hopHooks.beforeRequest(url.href, { signal: controller.signal }));
          try { lease = await hostWait(pendingLease); }
          catch (error) { void pendingLease.then(value => value?.release?.(error), () => {}); throw error; }
          if (lease?.reuse) {
            // Another chain already transferred this hop. Its bytes and final URL are ours, its request origin is not.
            const reused = await hostWait(lease.reuse);
            return reused && typeof reused === 'object' ? { ...reused, requestedUrl } : reused;
          }
        }
        if (controller.signal.aborted) throw interrupted();
        if (now() >= deadline) throw new OfficialPostingFetchError('fetch-timeout');
        result = await new Promise((resolve, reject) => {
        let req; let response; let finished = false;
        const cleanup = () => controller.signal.removeEventListener('abort', onAbort);
        const fail = error => {
          if (finished) return; finished = true; cleanup();
          response?.destroy(); req?.destroy();
          reject(error instanceof OfficialPostingFetchError ? error : new OfficialPostingFetchError('fetch-failed'));
        };
        const onAbort = () => fail(interrupted());
        controller.signal.addEventListener('abort', onAbort, { once: true });
        try {
          lease?.start?.();
          req = request(url, {
            method: 'GET', agent: false,
            headers: { Accept: 'text/html, application/json, application/ld+json, application/xml, text/xml, application/rss+xml',
              'Accept-Encoding': 'identity', 'User-Agent': 'InfiniteCanvas-OfficialPosting/1.0' },
            lookup(_hostname, options, callback) {
              if (typeof options === 'function') { callback = options; options = {}; }
              if (options?.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family);
            },
          }, res => {
            response = res;
            res.on('error', fail);
            res.on('aborted', () => fail(new OfficialPostingFetchError('fetch-failed')));
            res.on('close', () => { if (!finished) fail(new OfficialPostingFetchError('fetch-failed')); });
            const status = res.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(status)) {
              const location = res.headers.location;
              if (!location || redirects >= OFFICIAL_FETCH_MAX_REDIRECTS) { fail(new OfficialPostingFetchError('unsafe-url')); return; }
              let next;
              try { next = fetchUrl(new URL(location, url).href); } catch (error) { fail(error); return; }
              finished = true; cleanup(); res.destroy(); req?.destroy(); resolve({ redirect: next, statusCode: status }); return;
            }
            if (status !== 200) { fail(new OfficialPostingFetchError(status === 404 || status === 410 ? 'closed' : 'fetch-failed', {
              statusCode: status, retryAfter: String(res.headers['retry-after'] || ''),
            })); return; }
            const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (!/^(?:text\/(?:html|xml)|application\/(?:json|ld\+json|xml|rss\+xml|atom\+xml|xhtml\+xml))$/u.test(contentType)
              || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
              fail(new OfficialPostingFetchError('unsupported-content-type')); return;
            }
            if (Number(res.headers['content-length']) > OFFICIAL_FETCH_MAX_BYTES) { fail(new OfficialPostingFetchError('oversize')); return; }
            const chunks = []; let bytes = 0;
            res.on('data', chunk => {
              if (finished) return;
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              bytes += buffer.length;
              if (bytes > OFFICIAL_FETCH_MAX_BYTES) { fail(new OfficialPostingFetchError('oversize')); return; }
              chunks.push(buffer);
            });
            res.on('end', () => {
              if (finished) return;
              let body;
              try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
              catch { fail(new OfficialPostingFetchError('invalid-text')); return; }
              if (hasUnsafeTextControl(body)) { fail(new OfficialPostingFetchError('invalid-text')); return; }
              finished = true; cleanup(); resolve({ body, url: url.href, sourceUrl: url.href, contentType, statusCode: status, bytes });
            });
          });
          req.on('error', fail);
          req.end();
          if (controller.signal.aborted) onAbort();
        } catch (error) { fail(error); }
        });
        if (now() >= deadline) throw new OfficialPostingFetchError('fetch-timeout');
      } catch (error) { hopError = error; throw error; }
      finally { lease?.release?.(hopError, result); }
      if (!result.redirect) return { ...result, requestedUrl };
      url = result.redirect;
    }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}
fetchOfficialPosting[OFFICIAL_FETCH_HOP_CAPABILITY] = true;
