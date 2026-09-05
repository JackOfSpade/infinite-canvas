// Minimal stand-in for the `electron-store` package for scripts/test-runner.js.
// electron-store v11 imports the real `electron` package unconditionally at
// its own module top level, so it fails to even load without a real Electron
// binary present — independent of anything in this app's code. This stub
// gives callers a working in-memory dot-path store instead. Wired in via
// scripts/test-stubs/register.mjs, not by editing application source.

function getAtPath(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function setAtPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function deleteAtPath(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export default class Store {
  constructor(options = {}) {
    this._data = deepClone(options.defaults) || {};
  }

  get(key, defaultValue) {
    // dot-prop treats a non-string path as "no path" — reads return the whole
    // container (callers use a bare `.get()` to sweep a cache), while `has`
    // reports false and `delete` is a no-op.
    if (typeof key !== 'string') return defaultValue === undefined ? this._data : defaultValue;
    const value = getAtPath(this._data, key);
    return value === undefined ? defaultValue : value;
  }

  set(key, value) {
    if (typeof key === 'object' && key !== null) {
      for (const [k, v] of Object.entries(key)) setAtPath(this._data, k, v);
      return;
    }
    setAtPath(this._data, key, value);
  }

  has(key) {
    if (typeof key !== 'string') return false;
    return getAtPath(this._data, key) !== undefined;
  }

  delete(key) {
    if (typeof key !== 'string') return;
    deleteAtPath(this._data, key);
  }

  clear() {
    this._data = {};
  }

  get store() {
    return deepClone(this._data);
  }

  set store(value) {
    this._data = deepClone(value) || {};
  }

  get path() {
    return '';
  }
}
