// A node-count limit alone can retain gigabytes of job-search data. Estimate
// the full snapshot, including nested canvases, without making a JSON copy.
export const UNDO_MEMORY_BUDGET_BYTES = 128 * 1024 * 1024;

export function estimateUndoSnapshotBytes(value) {
  const seen = new WeakSet();
  const pending = [value];
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') { bytes += item.length * 2; continue; }
    if (!item || typeof item !== 'object') { bytes += 8; continue; }
    if (seen.has(item)) continue;
    seen.add(item);
    if (ArrayBuffer.isView(item)) { bytes += item.byteLength; continue; }
    if (item instanceof ArrayBuffer) { bytes += item.byteLength; continue; }
    bytes += 64;
    for (const key of Object.keys(item)) {
      bytes += key.length * 2 + 16;
      pending.push(item[key]);
    }
  }
  return bytes;
}

// A canvas node is never changed in place, so its size is measured once and
// remembered. Without this, every history entry re-walked the whole canvas
// (about a quarter of a second on a canvas with large job-search results).
const nodeBytesCache = new WeakMap();

function cachedNodeBytes(node) {
  if (!node || typeof node !== 'object') return estimateUndoSnapshotBytes(node);
  let bytes = nodeBytesCache.get(node);
  if (bytes === undefined) {
    bytes = estimateUndoSnapshotBytes(node);
    nodeBytesCache.set(node, bytes);
  }
  return bytes;
}

export function undoHistoryLimit(snapshot, maximum) {
  let bytes;
  if (snapshot && typeof snapshot === 'object' && Array.isArray(snapshot.nodes)) {
    // Measuring node by node counts anything two nodes share once per node.
    // That only ever overstates the size, which keeps the limit on the safe side.
    const { nodes, ...rest } = snapshot;
    bytes = estimateUndoSnapshotBytes(rest);
    for (const node of nodes) bytes += cachedNodeBytes(node);
  } else {
    bytes = estimateUndoSnapshotBytes(snapshot);
  }
  // Keep a current baseline and one previous state even for an oversized
  // workspace. Small workspaces retain the existing device-based depth.
  return Math.min(maximum, Math.max(2, Math.floor(UNDO_MEMORY_BUDGET_BYTES / Math.max(1, bytes))));
}
