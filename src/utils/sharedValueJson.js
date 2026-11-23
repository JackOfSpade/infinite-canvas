// JSON text in which an object that sits in several places is written once.
// Used by the save (electron/ipc/workspaceContentPool.js holds the file format
// and the loader) and by the window's load-time content fingerprint, which must
// not expand those objects either: a canvas the save can write must also be one
// the window can compare after opening it. No Node or browser-only APIs here.

export const WORKSPACE_SHARED_KEY = '$canvasSharedValues';
export const WORKSPACE_SHARED_REF_KEY = '$canvasShared';

function isContainer(value) {
  return value !== null && typeof value === 'object' && typeof value.toJSON !== 'function';
}

function isEmptyContainer(value) {
  if (Array.isArray(value)) return value.length === 0;
  for (const _key in value) return false;
  return true;
}

/**
 * The canvas as JSON text with every object that sits in more than one place
 * written once. Returns `{ text, shared }`; `shared` is false (and `text` is
 * plain JSON.stringify output) when nothing is shared or the canvas already
 * uses a key this format reserves. Throws the RangeError JSON.stringify throws
 * for text past the runtime's string limit.
 */
export function stringifyWorkspaceSharingValues(data) {
  const seen = new Set();
  const shared = new Set();
  let reservedKeyFound = false;
  const stack = [data];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!isContainer(value)) continue;
    if (seen.has(value)) {
      if (!isEmptyContainer(value)) shared.add(value);
      continue;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
    } else {
      for (const key of Object.keys(value)) {
        if (key === WORKSPACE_SHARED_KEY || key === WORKSPACE_SHARED_REF_KEY) reservedKeyFound = true;
        stack.push(value[key]);
      }
    }
  }
  seen.clear();
  const rootIsObject = isContainer(data) && !Array.isArray(data);
  if (shared.size === 0 || reservedKeyFound || !rootIsObject || shared.has(data)) {
    return { text: JSON.stringify(data), shared: false };
  }

  const ids = new Map();
  const entries = [];
  let entryRoot = null;
  function replacer(key, value) {
    if (value === entryRoot && key === '' ) return value;
    if (value === null || typeof value !== 'object' || !shared.has(value)) return value;
    let id = ids.get(value);
    if (id === undefined) {
      id = entries.length;
      ids.set(value, id);
      entries.push(value);
    }
    return { [WORKSPACE_SHARED_REF_KEY]: id };
  }
  const body = JSON.stringify(data, replacer);
  // An entry can itself hold other shared values, which joins them to the
  // list while it is being written; the loop reaches them too.
  const written = [];
  for (let index = 0; index < entries.length; index += 1) {
    entryRoot = entries[index];
    written.push(JSON.stringify(entryRoot, replacer));
  }
  entryRoot = null;
  if (entries.length === 0) return { text: body, shared: false };
  const list = `${JSON.stringify(WORKSPACE_SHARED_KEY)}:[${written.join(',')}]`;
  const text = body === '{}' ? `{${list}}` : `${body.slice(0, -1)},${list}}`;
  return { text, shared: true };
}
