// Transient renderer ownership outlives a hidden card's React instance. This
// contains no job facts and holds no application lane while research runs.
const preparations = new Map();
const listeners = new Set();
const keyFor = (canvasFilePath, nodeId) => JSON.stringify([canvasFilePath || '', nodeId || '']);
const publish = () => {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* One renderer must not interrupt another. */ }
  }
};

export function getOfficialPostingPreparation(canvasFilePath, nodeId) {
  return preparations.get(keyFor(canvasFilePath, nodeId)) || null;
}

export function subscribeOfficialPostingPreparation(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A synchronous claim also fences callbacks captured before a rerender. */
export function beginOfficialPostingPreparation({ canvasFilePath, nodeId, cancel }) {
  const key = keyFor(canvasFilePath, nodeId);
  if (preparations.has(key)) return null;
  let cancelled = false;
  const entry = Object.freeze({
    state: 'resolving', position: null,
    cancel() {
      if (preparations.get(key) !== entry || cancelled) return;
      cancelled = true;
      cancel?.();
    },
    finish() {
      if (preparations.get(key) !== entry) return;
      preparations.delete(key);
      publish();
    },
  });
  preparations.set(key, entry);
  publish();
  return entry;
}
