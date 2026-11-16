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
// Nothing here is trusted to stay in step. A key the app process does not hold
// makes resolve() return null and the window sends the whole canvas the old
// way. Manual save and the save on quit always send the whole canvas.
//
// Both halves live in one module (the window imports the encoder, the app
// process the store) so the record shape cannot drift between them.

const isObject = value => value !== null && typeof value === 'object';
const isPlainObject = value => isObject(value) && !Array.isArray(value);
const isObjectArray = value => Array.isArray(value) && value.every(isObject);

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
  return keys;
}

/**
 * Window half. `encode(data)` returns what to send for one save:
 * `{ session, root, chunks, settle }`. `chunks` holds only the records the app
 * process is not known to hold. Call `settle(outcome)` once the request is
 * over: 'saved' when the app process rebuilt the canvas, 'failed' when it may
 * or may not have, 'lost' when its copy can no longer be relied on.
 */
export function createCanvasDeltaEncoder({ session = newSessionId() } = {}) {
  const keys = new WeakMap();
  // Keys the app process holds, with the child keys of each group record.
  let held = new Map();
  let counter = 0;

  function encode(data) {
    const chunks = [];
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

    const nodeRecord = (node) => {
      const canvasData = node.type === 'group' && isPlainObject(node.data) ? node.data.canvasData : null;
      if (!isPlainObject(canvasData)) return { value: node };
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

    return { session, root: rootRefs ? { value: rootValue, refs: rootRefs } : { value: rootValue }, chunks, settle };
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

  function valueOf(key) {
    const record = records.get(key);
    if (!record || record.state === 'filling') return null;
    if (record.state === 'ready') return record.value;
    record.state = 'filling';
    const owner = record.refs ? record.value?.data?.canvasData : null;
    const filled = record.refs ? isPlainObject(owner) && fill(owner, record.refs) : true;
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
