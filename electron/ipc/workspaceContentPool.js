// Removes repeated content from a saved canvas without changing what any other
// code sees. The same listing text and assessments legitimately live in several
// places in memory (candidate pool, audits, scored jobs, job cards). On disk each
// repeated value is kept once in a top-level pool and replaced by a reference,
// and loading restores the full canvas with independent copies, so nothing above
// this file knows the format exists.

import { createHash } from 'crypto';

export const WORKSPACE_POOL_KEY = '$canvasContentPool';
export const WORKSPACE_REF_KEY = '$canvasRef';
const POOL_VERSION = 1;
// A pooled file is deliberately not plain JSON. A build without this code would
// otherwise parse it, treat each reference as real data and save those references
// back with the pool gone, destroying the content. This line makes it refuse.
export const WORKSPACE_POOLED_HEADER = 'infinite-canvas-pooled-v1\n';
// A reference costs about 20 bytes, so anything this size saves real space
// without filling the pool with values that barely repeat.
const MIN_POOLED_CHARS = 256;

function isUnserializable(value) {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function setOwn(target, key, value) {
  // Plain assignment would set the prototype, while JSON.parse makes a real key.
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

function createPlainReader() {
  const converted = new Map();
  return (value) => {
    if (value === null || typeof value !== 'object' || typeof value.toJSON !== 'function') return value;
    if (!converted.has(value)) converted.set(value, value.toJSON());
    return converted.get(value);
  };
}

/**
 * Returns the canvas with repeated values pooled, or null when pooling cannot
 * apply: nothing repeats, or the data already holds a key this format reserves.
 */
export function poolWorkspaceContent(data) {
  const plain = createPlainReader();
  const valueKeys = new Map();
  const counts = new Map();
  let reservedKeyFound = false;

  // Each value's identity is built from its children's identities, so a parent
  // never rehashes content its children already hashed.
  const identify = (input) => {
    const value = plain(input);
    if (typeof value === 'string') {
      if (value.length < MIN_POOLED_CHARS) return JSON.stringify(value);
      const known = valueKeys.get(value);
      if (known) return known;
      const key = `#s${createHash('sha256').update(value).digest('base64')}`;
      valueKeys.set(value, key);
      return key;
    }
    if (value === null || typeof value !== 'object') {
      return isUnserializable(value) ? 'null' : JSON.stringify(value);
    }
    const known = valueKeys.get(value);
    if (known) return known;
    let identity;
    if (Array.isArray(value)) {
      identity = '[';
      for (const item of value) identity += `${identify(item)},`;
    } else {
      identity = '{';
      for (const key of Object.keys(value)) {
        if (key === WORKSPACE_REF_KEY || key === WORKSPACE_POOL_KEY) reservedKeyFound = true;
        const item = plain(value[key]);
        if (isUnserializable(item)) continue;
        identity += `${JSON.stringify(key)}:${identify(item)},`;
      }
    }
    if (identity.length < MIN_POOLED_CHARS) return identity;
    const key = `#o${createHash('sha256').update(identity).digest('base64')}`;
    valueKeys.set(value, key);
    return key;
  };

  const rootIsObject = data !== null && typeof data === 'object' && !Array.isArray(data);
  if (!rootIsObject) return null;
  identify(data);
  if (reservedKeyFound) return null;

  // Do not look inside a repeat: its children are already counted once, and
  // counting them again would pool values that only occur inside this one.
  const count = (input) => {
    const value = plain(input);
    if (typeof value === 'string') {
      const key = valueKeys.get(value);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const key = valueKeys.get(value);
    if (key) {
      const seen = (counts.get(key) || 0) + 1;
      counts.set(key, seen);
      if (seen > 1) return;
    }
    if (Array.isArray(value)) value.forEach(count);
    else Object.keys(value).forEach(name => count(value[name]));
  };
  count(data);

  const poolIds = new Map();
  const values = [];
  const reference = (key, value) => {
    let id = poolIds.get(key);
    if (id === undefined) {
      id = values.length;
      poolIds.set(key, id);
      values.push(null);
      values[id] = typeof value === 'string' ? value : encodeChildren(value);
    }
    return { [WORKSPACE_REF_KEY]: id };
  };
  const encode = (input) => {
    const value = plain(input);
    if (typeof value === 'string' || (value !== null && typeof value === 'object')) {
      const key = valueKeys.get(value);
      if (key && counts.get(key) > 1) return reference(key, value);
    }
    return value !== null && typeof value === 'object' ? encodeChildren(value) : value;
  };
  function encodeChildren(value) {
    if (Array.isArray(value)) return value.map(encode);
    const output = {};
    for (const key of Object.keys(value)) {
      const item = plain(value[key]);
      if (!isUnserializable(item)) setOwn(output, key, encode(item));
    }
    return output;
  }

  const encoded = encodeChildren(data);
  if (values.length === 0) return null;
  encoded[WORKSPACE_POOL_KEY] = { version: POOL_VERSION, values };
  return encoded;
}

/**
 * Restores a parsed canvas in place of its pooled form. A file with no pool is
 * returned as it is. Every reference gets its own copy, because sharing objects
 * would let an edit to one job change another.
 */
export function restoreWorkspaceContent(parsed) {
  if (parsed === null || typeof parsed !== 'object' || !Object.hasOwn(parsed, WORKSPACE_POOL_KEY)) return parsed;
  const pool = parsed[WORKSPACE_POOL_KEY];
  if (pool?.version !== POOL_VERSION || !Array.isArray(pool.values)) {
    throw new Error('Canvas file uses a newer or unknown storage format.');
  }
  const { values } = pool;
  const restore = (value) => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(restore);
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === WORKSPACE_REF_KEY) {
      const id = value[WORKSPACE_REF_KEY];
      if (!Number.isInteger(id) || id < 0 || id >= values.length) {
        throw new Error('Canvas file has a broken content reference.');
      }
      return restore(values[id]);
    }
    const output = {};
    for (const key of keys) setOwn(output, key, restore(value[key]));
    return output;
  };
  const { [WORKSPACE_POOL_KEY]: _pool, ...rest } = parsed;
  return restore(rest);
}

/** The file text for a pooled canvas. */
export function formatPooledWorkspace(pooled) {
  return WORKSPACE_POOLED_HEADER + JSON.stringify(pooled);
}

/** Every reader of a saved canvas parses through here. Plain files still load. */
export function parseWorkspaceText(text) {
  if (!text.startsWith(WORKSPACE_POOLED_HEADER)) return JSON.parse(text);
  return restoreWorkspaceContent(JSON.parse(text.slice(WORKSPACE_POOLED_HEADER.length)));
}
