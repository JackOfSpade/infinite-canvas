import { fetchOfficialPosting, OfficialPostingFetchError, officialPostingFetchUrl, OFFICIAL_FETCH_HOP_CAPABILITY } from './officialPostingFetch.js';
import { createHash } from 'node:crypto';
import { officialPostingResourceHeaders } from './officialPostingResourceHeaders.js';
import { normalizeOfficialPostingPublicSearchHeaders } from './officialPostingReadOnlySearch.js';

export const OFFICIAL_FETCH_NEGATIVE_CACHE_MS = 10 * 60 * 1_000;
export const OFFICIAL_FETCH_GLOBAL_LIMIT = 8;
export const OFFICIAL_FETCH_HOST_LIMIT = 2;
export const OFFICIAL_FETCH_HOST_SPACING_MS = 250;
export const OFFICIAL_FETCH_RETRY_AFTER_CAP_MS = 30_000;

function aborted(signal) {
  return signal?.reason instanceof OfficialPostingFetchError ? signal.reason
    : new OfficialPostingFetchError(signal?.reason?.code === 'fetch-timeout' ? 'fetch-timeout' : 'bridge-aborted');
}
function waitFor(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(aborted(signal)); };
    if (signal.aborted) { reject(aborted(signal)); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
function delay(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(aborted(signal)); };
    if (signal?.aborted) { reject(aborted(signal)); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
  });
}
function retryAfterMs(value, now) {
  const text = String(value || '').trim();
  const ms = /^\d+(?:\.\d+)?$/u.test(text) ? Number(text) * 1_000 : Date.parse(text) - now;
  return Number.isFinite(ms) ? Math.max(0, Math.min(OFFICIAL_FETCH_RETRY_AFTER_CAP_MS, ms)) : 0;
}
// The host breaker tracks host health: transport failures, timeouts, 429 and 5xx. A page that is gone (404/410), mistyped,
// oversized, unsafe, forbidden or otherwise rejected for its own bytes says nothing about the host, and shared ATS hosts serve
// many employers. Such an outcome neither adds to nor clears the consecutive-failure count.
const PER_URL_OUTCOMES = new Set(['closed', 'unsupported-content-type', 'oversize', 'invalid-text', 'unsafe-url', 'unsafe-address']);
function hostFailure(error) {
  if (error.code === 'bridge-aborted' || PER_URL_OUTCOMES.has(error.code)) return false;
  const status = error.statusCode;
  return !Number.isInteger(status) || status >= 500 || status === 408 || status === 429;
}

/** One host-owned run cache and scheduler. A caller signal cancels only its
 * subscription; the factory's run signal owns the shared network requests. */
export function createOfficialPostingFetchSession({ fetch = fetchOfficialPosting, signal: parentSignal, now = Date.now, sleep = delay,
  upgradeSameHostRedirects = fetch === fetchOfficialPosting, cacheFailures = true, hostBreaker = true } = {}) {
  const controller = new AbortController(); const signal = controller.signal;
  const abortRun = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortRun(); else parentSignal?.addEventListener('abort', abortRun, { once: true });
  const clock = () => Number(now());
  const cache = new Map(); const hosts = new Map(); const queue = []; const uniqueUrls = new Set();
  const retriedUrls = new Set();
  const stats = { fetches: 0, uniqueUrls: 0, cacheHits: 0, maxPerHostRate: 0, breakerTrips: 0 };
  let active = 0; let wake = null; let pumping = false;
  const hostState = host => {
    if (!hosts.has(host)) hosts.set(host, { active: 0, lastStart: -Infinity, blockedUntil: 0, failures: 0, tripped: false, starts: [],
      sequence: 0, nextOutcome: 0, outcomes: new Map() });
    return hosts.get(host);
  };
  const cached = key => {
    const entry = cache.get(key);
    if (entry && entry.expiresAt <= clock()) { cache.delete(key); return null; }
    return entry;
  };
  const cancelWake = () => { if (wake) { wake.controller.abort(); wake = null; } };
  const wakeAt = at => {
    if (wake && wake.at <= at) return;
    cancelWake();
    const ticket = { at, controller: new AbortController() }; wake = ticket;
    Promise.resolve().then(() => sleep(Math.max(0, at - clock()), { signal: ticket.controller.signal })).then(() => {
      if (wake !== ticket) return;
      wake = null; pump();
    }, () => { if (wake === ticket) wake = null; });
  };
  const complete = (state, sequence, error) => {
    state.active -= 1; active -= 1;
    if ([429, 503].includes(error?.statusCode)) state.blockedUntil = Math.max(state.blockedUntil, clock() + retryAfterMs(error.retryAfter, clock()));
    state.outcomes.set(sequence, error || null);
    // Response timing cannot reorder the host's consecutive-failure history.
    // Admissions wait on any gap, so later callbacks cannot race the breaker.
    while (state.outcomes.has(state.nextOutcome)) {
      const outcome = state.outcomes.get(state.nextOutcome); state.outcomes.delete(state.nextOutcome++);
      if (!outcome) state.failures = 0;
      else if (hostFailure(outcome)) state.failures += 1;
      // Long-lived snapshot lookups may keep pacing a temporarily unhealthy
      // shared ATS host without excluding all of its later recovered rows.
      if (hostBreaker && state.failures >= 3 && !state.tripped) { state.tripped = true; stats.breakerTrips += 1; }
    }
    pump();
  };
  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      cancelWake();
      let earliest = Infinity;
      for (let index = 0; index < queue.length;) {
        const item = queue[index]; const state = hostState(item.host);
        if (item.signal?.aborted || signal?.aborted || state.tripped) {
          queue.splice(index, 1); item.cleanup();
          item.reject(item.signal?.aborted ? aborted(item.signal) : signal?.aborted ? aborted(signal) : new OfficialPostingFetchError('fetch-failed'));
          continue;
        }
        if (active >= OFFICIAL_FETCH_GLOBAL_LIMIT || state.active >= OFFICIAL_FETCH_HOST_LIMIT || state.outcomes.size) { index += 1; continue; }
        const ready = Math.max(state.lastStart + OFFICIAL_FETCH_HOST_SPACING_MS, state.blockedUntil);
        if (ready > clock()) { earliest = Math.min(earliest, ready); index += 1; continue; }
        queue.splice(index, 1); item.cleanup(); active += 1; state.active += 1;
        state.lastStart = clock(); // Reserve spacing until the actual transport starts.
        let released = false; let started = false; let sequence;
        item.resolve({
          start() {
            if (started || released) return;
            started = true; sequence = state.sequence++; state.lastStart = clock();
            state.starts = state.starts.filter(start => start > state.lastStart - 60_000); state.starts.push(state.lastStart);
            stats.fetches += 1; uniqueUrls.add(item.url); stats.uniqueUrls = uniqueUrls.size;
            stats.maxPerHostRate = Math.max(stats.maxPerHostRate, state.starts.length);
          },
          release(error) {
            if (released) return;
            released = true;
            if (started) complete(state, sequence, error);
            else { state.active -= 1; active -= 1; pump(); }
          },
        });
      }
      if (queue.length && Number.isFinite(earliest)) wakeAt(earliest);
    } finally { pumping = false; }
  }
  const acquire = (url, requestSignal) => new Promise((resolve, reject) => {
    const host = new URL(url).hostname.toLowerCase().replace(/\.+$/u, '');
    const item = { url, host, signal: requestSignal, resolve, reject };
    const onAbort = () => {
      const at = queue.indexOf(item);
      if (at >= 0) { queue.splice(at, 1); item.cleanup(); reject(aborted(requestSignal)); pump(); }
    };
    item.cleanup = () => requestSignal?.removeEventListener('abort', onAbort);
    requestSignal?.addEventListener('abort', onAbort, { once: true });
    queue.push(item); pump();
  });
  const reaches = (entry, target, seen = new Set()) => {
    if (entry === target) return true;
    if (seen.has(entry)) return false;
    seen.add(entry);
    return [...entry.waitsFor].some(next => reaches(next, target, seen));
  };
  const runFetch = (key, owner, resource, resourceHeaders, publicSearchHeaders, resourcePrefix) => {
    const cacheKey = url => resource ? `${resourcePrefix}|${url}` : url;
    const hooks = { beforeRequest: async (url, { signal: hopSignal }) => {
      const alias = officialPostingFetchUrl(url).href; const existing = cached(cacheKey(alias));
      if (existing && existing !== owner) {
        if (reaches(existing, owner)) throw new OfficialPostingFetchError('unsafe-url');
        stats.cacheHits += 1; owner.waitsFor.add(existing);
        return { reuse: existing.promise.finally(() => owner.waitsFor.delete(existing)) };
      }
      cache.set(cacheKey(alias), owner);
      return acquire(alias, hopSignal);
    } };
    if (fetch[OFFICIAL_FETCH_HOP_CAPABILITY] === true) return fetch(key, { signal, now: clock, hopHooks: hooks, resource, resourceHeaders, publicSearchHeaders, upgradeSameHostRedirects });
    // Injected test fetches without the hop contract represent one request.
    // Production forwarding wrappers explicitly copy the capability marker.
    return (async () => {
      const lease = await acquire(key, signal); let error; let result;
      try { lease.start(); result = await waitFor(Promise.resolve().then(() => fetch(key, { signal, resource, resourceHeaders, publicSearchHeaders })), signal); return result; }
      catch (caught) { error = caught; throw caught; }
      finally { lease.release(error, result); }
    })();
  };
  const fetchCached = (value, { signal: callerSignal, resource = false, resourceHeaders: suppliedHeaders, publicSearchHeaders: suppliedSearchHeaders } = {}) => {
    if (signal?.aborted) return Promise.reject(aborted(signal));
    if (callerSignal?.aborted) return Promise.reject(aborted(callerSignal));
    let key;
    try { key = officialPostingFetchUrl(value).href; } catch (error) { return Promise.reject(error); }
    resource = resource === true;
    const resourceHeaders = resource ? officialPostingResourceHeaders(suppliedHeaders) : {};
    const publicSearchHeaders = resource ? normalizeOfficialPostingPublicSearchHeaders(key, suppliedSearchHeaders) || {} : {};
    const representation = { ...resourceHeaders, ...publicSearchHeaders };
    const resourcePrefix = Object.keys(representation).length
      ? `resource:${createHash('sha256').update(JSON.stringify(representation)).digest('hex')}` : 'resource';
    const cacheKey = url => resource ? `${resourcePrefix}|${url}` : url;
    // A shared or aliased transfer is the same bytes, never the same request: each caller is told the URL it asked for, so an
    // apex reader and a www reader of one redirect chain cannot change each other's origin checks.
    const asked = result => (result && typeof result === 'object' ? { ...result, requestedUrl: key } : result);
    let entry = cached(cacheKey(key));
    if (entry) { stats.cacheHits += 1; return waitFor(entry.promise, callerSignal).then(asked); }
    entry = { expiresAt: Infinity, waitsFor: new Set(), promise: null };
    entry.promise = Promise.resolve().then(() => runFetch(key, entry, resource, resourceHeaders, publicSearchHeaders, resourcePrefix)).then(result => {
      const recorded = result && typeof result === 'object' ? { ...result, requestedUrl: result.requestedUrl || key } : result;
      const final = result?.url || result?.sourceUrl;
      if (final) { try { const alias = cacheKey(officialPostingFetchUrl(final).href); if (!cached(alias)) cache.set(alias, entry); } catch { /* The transport owns result validation. */ } }
      return recorded;
    }, error => {
      entry.failure = error;
      if (cacheFailures) entry.expiresAt = clock() + OFFICIAL_FETCH_NEGATIVE_CACHE_MS;
      else {
        // Current subscribers share the same transfer, but a later snapshot
        // must be able to observe a page that has recovered. Redirect aliases
        // cannot retain that transfer's rejected promise either.
        for (const [alias, cachedEntry] of cache) if (cachedEntry === entry) cache.delete(alias);
      }
      throw error;
    });
    // A row may detach before a shared operation settles. Its eventual
    // rejection still belongs to the cache, never the unhandled-rejection queue.
    void entry.promise.catch(() => {});
    cache.set(cacheKey(key), entry);
    return waitFor(entry.promise, callerSignal).then(asked);
  };
  const retryFailedUrls = values => {
    let evicted = 0;
    for (const value of Array.isArray(values) ? values : []) {
      let key;
      try { key = officialPostingFetchUrl(value).href; } catch { continue; }
      if (retriedUrls.has(key)) continue;
      const entry = cached(key);
      // A research lead may retry a settled transport failure once. Successes,
      // in-flight transfers and definitive per-page rejections stay shared.
      // Host health, Retry-After and the circuit breaker remain authoritative.
      if (!entry?.failure || !hostFailure(entry.failure)) continue;
      for (const [alias, cachedEntry] of cache) if (cachedEntry === entry) {
        retriedUrls.add(alias); cache.delete(alias);
      }
      retriedUrls.add(key); evicted += 1;
    }
    return evicted;
  };
  const retire = () => { cancelWake(); pump(); };
  signal.addEventListener('abort', retire, { once: true });
  return { fetch: fetchCached, retryFailedUrls, telemetry: () => ({ ...stats }), dispose() {
    parentSignal?.removeEventListener('abort', abortRun);
    controller.abort(); signal.removeEventListener('abort', retire); cancelWake(); cache.clear();
  } };
}
