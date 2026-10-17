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

export function undoHistoryLimit(snapshot, maximum) {
  const bytes = estimateUndoSnapshotBytes(snapshot);
  // Keep a current baseline and one previous state even for an oversized
  // workspace. Small workspaces retain the existing device-based depth.
  return Math.min(maximum, Math.max(2, Math.floor(UNDO_MEMORY_BUDGET_BYTES / Math.max(1, bytes))));
}
