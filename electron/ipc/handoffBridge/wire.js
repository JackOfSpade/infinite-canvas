import { CONSTANTS } from './constants.js';

const MAX_FORM_PAIRS = 100;
const MAX_PARAM_CHARS = 8192;

export class WireError extends Error {
  constructor(code, description, status = 400, headers = null) {
    super(description || code);
    this.name = 'WireError';
    this.code = code;
    this.description = description;
    this.status = status;
    this.headers = headers;
  }
}

const requestError = (description, status = 400) => new WireError('invalid_request', description, status);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function makeBucket(capacity, perSecond, now = Date.now) {
  let tokens = capacity;
  let last = now();
  const refill = () => {
    const current = now();
    tokens = Math.min(capacity, tokens + Math.max(0, current - last) / 1000 * perSecond);
    last = current;
  };
  const wait = () => Math.max(1, Math.ceil((1 - tokens) / perSecond));
  const take = () => {
    refill();
    if (tokens >= 1) {
      tokens -= 1;
      return 0;
    }
    return wait();
  };
  take.peek = () => {
    refill();
    return tokens >= 1 ? 0 : wait();
  };
  return take;
}

// Bounded, recency-updating bucket map.  The HTTP layer owns the policy for
// aggregate-only fallback; this class exposes a deterministic eviction count.
export class KeyedBuckets {
  constructor({ capacity, perSecond, now = Date.now, maxKeys = CONSTANTS.BUCKET_LRU_KEYS } = {}) {
    if (!Number.isFinite(capacity) || capacity < 1 || !Number.isFinite(perSecond) || perSecond <= 0) {
      throw new TypeError('KeyedBuckets requires positive capacity and perSecond');
    }
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.now = now;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
    this.evictions = [];
  }

  get(key) {
    if (this.buckets.has(key)) {
      const bucket = this.buckets.get(key);
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
      return bucket;
    }
    if (this.buckets.size >= this.maxKeys) {
      this.buckets.delete(this.buckets.keys().next().value);
      this.evictions.push(this.now());
    }
    const bucket = makeBucket(this.capacity, this.perSecond, this.now);
    this.buckets.set(key, bucket);
    return bucket;
  }

  take(key) { return this.get(key)(); }
  peek(key) { return this.get(key).peek(); }
  get size() { return this.buckets.size; }

  evictionsInLastMinute() {
    const cutoff = this.now() - 60_000;
    while (this.evictions.length && this.evictions[0] < cutoff) this.evictions.shift();
    return this.evictions.length;
  }
}

export function formDecode(text) {
  try {
    return decodeURIComponent(String(text).replace(/\+/g, ' '));
  } catch {
    throw requestError('Malformed percent-encoding');
  }
}

export function parseForm(text) {
  const values = Object.create(null);
  const dups = new Set();
  if (text === '') return { values, dups };
  const pairs = String(text).split('&');
  if (pairs.length > MAX_FORM_PAIRS) throw requestError('Too many parameters');
  for (const pair of pairs) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = formDecode(eq < 0 ? pair : pair.slice(0, eq));
    const value = formDecode(eq < 0 ? '' : pair.slice(eq + 1));
    if (value.length > MAX_PARAM_CHARS) throw requestError('A parameter is too long');
    if (Object.hasOwn(values, key)) {
      if (!(key === 'resource' && values[key] === value)) dups.add(key);
    } else {
      values[key] = value;
    }
  }
  return { values, dups };
}

// Parsed request data is never spread or assigned into application objects.
// Callers provide the small schema they accept, which also excludes prototype
// keys regardless of what JSON.parse produced.
export function parseJsonObject(text, knownKeys = []) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw requestError('The body is not valid JSON');
  }
  if (!isObject(doc)) throw requestError('The body must be a JSON object');
  const values = Object.create(null);
  for (const key of knownKeys) {
    if (Object.hasOwn(doc, key)) values[key] = doc[key];
  }
  return values;
}

export function jsonToParams(text, knownKeys = []) {
  const doc = parseJsonObject(text, knownKeys);
  const values = Object.create(null);
  for (const key of knownKeys) {
    if (!Object.hasOwn(doc, key) || doc[key] === null || doc[key] === undefined) continue;
    if (typeof doc[key] !== 'string' || doc[key].length > MAX_PARAM_CHARS) {
      throw requestError('Every parameter must be a string of reasonable length');
    }
    values[key] = doc[key];
  }
  return values;
}

export const mimeOf = req => String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();

export function tooLarge() {
  return requestError('The request body is too large', 413);
}

function closeResponse(response) {
  if (!response) return;
  if (typeof response.setHeader === 'function' && !response.headersSent) response.setHeader('Connection', 'close');
}

// The caller chooses draining only for authenticated MCP overflow.  Every
// other rejection closes and destroys the request immediately, preventing an
// anonymous sender from occupying a read permit after its response is ready.
export function readBody(req, {
  capBytes,
  timeoutMs,
  drainCapBytes = capBytes * CONSTANTS.DRAIN_CAP_MULTIPLIER,
  drainOnOverflow = false,
  response = null,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!Number.isSafeInteger(capBytes) || capBytes < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('readBody requires non-negative integer capBytes and timeoutMs');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    let dropped = false;
    let destroyed = false;
    const destroy = () => {
      if (!destroyed && typeof req.destroy === 'function') {
        destroyed = true;
        req.destroy();
      }
    };
    // A 408/413 must be visible to the peer before the socket goes away.  The
    // HTTP handler ends the response after this promise rejects; tiny unit
    // fakes without an event API still need the conservative immediate close.
    const destroyAfterResponse = () => {
      if (response && typeof response.once === 'function' && typeof response.writableEnded === 'boolean' && response.writableEnded !== true) {
        // The rejection continuation writes the fixed response in the first
        // promise microtask.  Defer our observation one turn so a synchronous
        // ServerResponse.end cannot race the finish subscription.
        queueMicrotask(() => {
          if (response.writableEnded === true) destroy();
          else response.once('finish', destroy);
        });
      } else destroy();
    };
    let timer = null;
    const finish = (error, value, { destroyRequest = false } = {}) => {
      if (done) return;
      done = true;
      try { if (timer !== null) clearTimeoutImpl(timer); } catch { /* reject still has to settle */ }
      if (error) {
        closeResponse(response);
        if (destroyRequest) destroyAfterResponse();
        reject(error);
      } else {
        resolve(value);
      }
    };
    try {
      timer = setTimeoutImpl(() => finish(requestError('The request body timed out', 408), undefined, { destroyRequest: true }), timeoutMs);
      timer?.unref?.();
      // A deterministic test timer is allowed to fire synchronously.
      if (done && timer !== null) clearTimeoutImpl(timer);
    } catch {
      finish(requestError('The request body timed out', 408), undefined, { destroyRequest: true });
    }
    const declared = req.headers?.['content-length'];
    if (declared !== undefined && /^(?:0|[1-9]\d*)$/.test(String(declared)) && Number(declared) > capBytes) {
      dropped = true;
      finish(tooLarge(), undefined, { destroyRequest: !drainOnOverflow });
    }
    req.on('data', chunk => {
      size += chunk.length;
      if (dropped) {
        if (size > drainCapBytes) destroy();
        return;
      }
      if (size > capBytes) {
        dropped = true;
        chunks.length = 0;
        finish(tooLarge(), undefined, { destroyRequest: !drainOnOverflow });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks)));
    req.on('error', () => finish(requestError('The request body could not be read'), undefined, { destroyRequest: true }));
    req.on('close', () => {
      if (!req.complete) finish(requestError('The request ended early'), undefined, { destroyRequest: true });
    });
  });
}
