// Auto-save hand-over that sends only what changed.
//
// Copying a whole large canvas out of the window froze it for about a second
// on every auto-save, even when three cards had changed. Canvas state is
// immutable: an edit replaces the node object (and every group above it) and
// leaves the rest untouched. So the window gives each node object, and each
// edges/drawings array, a key the first time it is sent, and afterwards names
// it by that key. The app process keeps what it was sent and rebuilds the
// whole canvas from the keys, then serializes, verifies and writes it exactly
// as before. The file on disk is unchanged in form and content.
//
// A node can itself be huge: a Job Search card holding its candidate pool was
// 169 MB, and so was the Job Board card holding that search's rollback. A
// progress write replaces such a node but keeps the big values inside it, so
// sending the whole node again froze the window for 13 seconds on every
// results page (2026-11-23). A node's big values are therefore keyed and sent
// the same way, by identity, however deep they sit: a record carries `parts`,
// pairs of [property name or array index, key], where its big values were.
//
// Nothing here is trusted to stay in step. A key the app process does not hold
// makes resolve() return null and the window sends the whole canvas the old
// way. Manual save and the save on quit always send the whole canvas.
//
// Both halves live in one module (the window imports the encoder, the app
// process the store) so the record shape cannot drift between them.

const isObject = value => value !== null && typeof value === 'object';
const isPlainObject = value => isObject(value) && !Array.isArray(value);
const isObjectArray = value => Array.isArray(value) && value.every(isObject);

// A value at least this heavy is sent as its own record. The unit is roughly
// one character of the saved text. Below it, copying is cheaper than the
// bookkeeping; a job row is about 20,000.
export const PART_MIN_WEIGHT = 1_000_000;
// Weights below this are not remembered: a canvas holds millions of small
// objects, and remembering each would cost more memory than re-adding them.
const WEIGHT_MEMO_MIN = 4_096;
const WEIGHT_MAX_DEPTH = 200;

function isSplittable(value) {
  if (Array.isArray(value)) return true;
  if (!isObject(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPartName(name) {
  return (typeof name === 'string' && name !== '__proto__') || (Number.isInteger(name) && name >= 0);
}

function newSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function addClosure(key, childrenOf, into) {
  const pending = [key];
  while (pending.length) {
    const next = pending.pop();
    if (into.has(next)) continue;
    into.add(next);
    const children = childrenOf(next);
    if (children) for (const child of children) pending.push(child);
  }
}

function refKeys(refs) {
  if (!refs) return [];
  const keys = refs.nodes ? [...refs.nodes] : [];
  if (refs.edges) keys.push(refs.edges);
  if (refs.drawings) keys.push(refs.drawings);
  if (refs.parts) for (const part of refs.parts) keys.push(part[1]);
  return keys;
}

/**
 * Window half. `encode(data)` returns what to send for one save:
 * `{ session, root, chunks, attached, settle }`. `chunks` holds only the records
 * the app process is not known to hold; `attached` names the part records,
 * which must travel in the same call as the record that follows them. Call `settle(outcome)` once the request is
 * over: 'saved' when the app process rebuilt the canvas, 'failed' when it may
 * or may not have, 'lost' when its copy can no longer be relied on.
 */
export function createCanvasDeltaEncoder({ session = newSessionId() } = {}) {
  const keys = new WeakMap();
  // Canvas values are never changed in place, so a value's weight never changes.
  const weights = new WeakMap();
  const weightOf = (value, depth = 0) => {
    if (typeof value === 'string') return value.length + 2;
    if (!isObject(value)) return 8;
    const known = weights.get(value);
    if (known !== undefined) return known;
    if (depth > WEIGHT_MAX_DEPTH || !isSplittable(value)) return 8;
    let total = 2;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) total += weightOf(value[i], depth + 1) + 1;
    } else {
      for (const name of Object.keys(value)) total += name.length + 3 + weightOf(value[name], depth + 1);
    }
    if (total >= WEIGHT_MEMO_MIN) weights.set(value, total);
    return total;
  };
  // Keys the app process holds, with the child keys of each group record.
  let held = new Map();
  let counter = 0;

  function encode(data) {
    const chunks = [];
    // Keys of part records. Each is listed just before the record it was cut
    // from, and the sender keeps them in one call: two values that share an
    // object stay sharing it only when they are copied in the same call.
    const attached = new Set();
    let partDepth = 0;
    const fresh = new Map();
    const reach = new Set();
    const childrenOf = key => fresh.get(key) ?? held.get(key);

    const keyOf = (value, build) => {
      let key = keys.get(value);
      if (!key) {
        key = `k${(counter += 1).toString(36)}`;
        keys.set(value, key);
      }
      if (!held.has(key) && !fresh.has(key)) {
        // Reserve before building so a value reached twice is sent once.
        fresh.set(key, null);
        const record = build();
        fresh.set(key, refKeys(record.refs));
        chunks.push(record.refs ? [key, record.value, record.refs] : [key, record.value]);
        if (partDepth > 0) attached.add(key);
      }
      return key;
    };

    // Replace a canvas level's three collections with keys. `owner` is a fresh
    // shallow copy; a slot keeps its position so key order survives the trip.
    const splitLevel = (owner) => {
      const refs = {};
      if (isObjectArray(owner.nodes)) {
        refs.nodes = owner.nodes.map(node => keyOf(node, () => nodeRecord(node)));
        owner.nodes = 0;
      }
      for (const slot of ['edges', 'drawings']) {
        const list = owner[slot];
        if (Array.isArray(list)) {
          refs[slot] = keyOf(list, () => ({ value: list }));
          owner[slot] = 0;
        }
      }
      return refs.nodes || refs.edges || refs.drawings ? refs : null;
    };

    // Replace each big value directly inside `container` with a key. The big
    // value's own record is split the same way, so a big value nested inside
    // another is still sent once and then named.
    const partsRecord = (container) => {
      let copy = null;
      const parts = [];
      const visit = (name, child) => {
        if (!isPartName(name) || !isSplittable(child) || weightOf(child) < PART_MIN_WEIGHT) return;
        partDepth += 1;
        let key;
        try { key = keyOf(child, () => partsRecord(child)); } finally { partDepth -= 1; }
        if (!copy) copy = Array.isArray(container) ? container.slice() : { ...container };
        copy[name] = 0;
        parts.push([name, key]);
      };
      if (Array.isArray(container)) container.forEach((child, index) => visit(index, child));
      else for (const name of Object.keys(container)) visit(name, container[name]);
      return parts.length ? { value: copy, refs: { parts } } : { value: container };
    };

    const nodeRecord = (node) => {
      const canvasData = node.type === 'group' && isPlainObject(node.data) ? node.data.canvasData : null;
      if (!isPlainObject(canvasData)) {
        if (node.type === 'group' || !isSplittable(node) || weightOf(node) < PART_MIN_WEIGHT) return { value: node };
        return partsRecord(node);
      }
      const level = { ...canvasData };
      const refs = splitLevel(level);
      if (!refs) return { value: node };
      return { value: { ...node, data: { ...node.data, canvasData: level } }, refs };
    };

    const rootValue = { ...data };
    const rootRefs = splitLevel(rootValue);
    for (const key of refKeys(rootRefs)) addClosure(key, childrenOf, reach);

    const settle = (outcome) => {
      if (outcome === 'lost') {
        held = new Map();
        return;
      }
      const next = new Map();
      for (const key of reach) {
        // After a failure the app process may hold either this request's keys
        // or the previous one's. Only keys in both are certain.
        if (outcome === 'saved' || held.has(key)) next.set(key, childrenOf(key) ?? null);
      }
      held = next;
    };

    return { session, root: rootRefs ? { value: rootValue, refs: rootRefs } : { value: rootValue }, chunks, attached, settle };
  }

  return { session, encode };
}

/**
 * App-process half: one per window. `stage()` stores records ahead of a save;
 * `resolve()` stores any that came with the save and returns the whole canvas,
 * or null when a key is missing or the request is malformed.
 */
export function createCanvasDeltaStore() {
  let session = null;
  let records = new Map();
  let previousReach = new Set();

  function adopt(requestSession) {
    if (typeof requestSession !== 'string' || !requestSession) return false;
    if (requestSession !== session) {
      // A reloaded window restarts its key counter. Its keys must never meet
      // records kept for the window it replaced.
      session = requestSession;
      records = new Map();
      previousReach = new Set();
    }
    return true;
  }

  function validRefs(refs) {
    if (refs === undefined) return true;
    if (!isPlainObject(refs)) return false;
    if (refs.nodes !== undefined && !(Array.isArray(refs.nodes) && refs.nodes.every(key => typeof key === 'string'))) return false;
    if (refs.parts !== undefined && !(Array.isArray(refs.parts) && refs.parts.every(part => (
      Array.isArray(part) && part.length === 2 && isPartName(part[0]) && typeof part[1] === 'string'
    )))) return false;
    return ['edges', 'drawings'].every(slot => refs[slot] === undefined || typeof refs[slot] === 'string');
  }

  function store(chunks) {
    if (!Array.isArray(chunks)) return false;
    for (const chunk of chunks) {
      if (!Array.isArray(chunk) || typeof chunk[0] !== 'string' || !isObject(chunk[1]) || !validRefs(chunk[2])) return false;
      // A key always names the same content, so the first copy stands.
      if (!records.has(chunk[0])) records.set(chunk[0], { value: chunk[1], refs: chunk[2] || null, state: 'new' });
    }
    return true;
  }

  function fill(owner, refs) {
    if (!refs) return true;
    if (refs.nodes) {
      const nodes = [];
      for (const key of refs.nodes) {
        const node = valueOf(key);
        if (!node) return false;
        nodes.push(node);
      }
      owner.nodes = nodes;
    }
    for (const slot of ['edges', 'drawings']) {
      if (!refs[slot]) continue;
      const list = valueOf(refs[slot]);
      if (!Array.isArray(list)) return false;
      owner[slot] = list;
    }
    return true;
  }

  // Put each big value back where its key stands. The same key under two
  // owners gives both the same object, as it was in the window.
  function fillParts(owner, parts) {
    for (const [name, key] of parts) {
      if (Array.isArray(owner) ? !Number.isInteger(name) : typeof name !== 'string') return false;
      const value = valueOf(key);
      if (!isObject(value)) return false;
      owner[name] = value;
    }
    return true;
  }

  function valueOf(key) {
    const record = records.get(key);
    if (!record || record.state === 'filling') return null;
    if (record.state === 'ready') return record.value;
    record.state = 'filling';
    const refs = record.refs;
    let filled = true;
    if (refs && (refs.nodes || refs.edges || refs.drawings)) {
      const owner = record.value?.data?.canvasData;
      filled = isPlainObject(owner) && fill(owner, refs);
    }
    if (filled && refs?.parts) filled = fillParts(record.value, refs.parts);
    record.state = filled ? 'ready' : 'new';
    return filled ? record.value : null;
  }

  return {
    stage(request) {
      return adopt(request?.session) && store(request?.chunks);
    },
    resolve(request) {
      if (!adopt(request?.session) || !store(request?.chunks ?? [])) return null;
      const root = request?.root;
      if (!isPlainObject(root) || !isPlainObject(root.value) || !validRefs(root.refs)) return null;
      const data = { ...root.value };
      if (!fill(data, root.refs || null)) return null;
      const reach = new Set();
      for (const key of refKeys(root.refs)) addClosure(key, child => refKeys(records.get(child)?.refs), reach);
      // Keep this canvas and the one before it: a save that fails after this
      // point leaves the window unsure which of the two is held.
      for (const key of records.keys()) {
        if (!reach.has(key) && !previousReach.has(key)) records.delete(key);
      }
      previousReach = reach;
      return data;
    },
    size: () => records.size,
  };
}
