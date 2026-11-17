// Run-id and cleanup-receipt helpers shared by the Job Search and Job Board
// nodes. Both persist manual-AI run receipts in node data with the same shape.

export function createPrefixedManualAiRunId(prefix, nodeId) {
  const entropy = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${nodeId}:${entropy}`;
}

export function rememberBoundedRunId(runIds, runId, limit = 32) {
  if (!(runIds instanceof Set) || !runId) return;
  runIds.add(runId);
  while (runIds.size > limit) {
    runIds.delete(runIds.values().next().value);
  }
}

export function normalizeManualAiCleanupReceipts(receipts) {
  if (!Array.isArray(receipts)) return [];
  const byRunId = new Map();
  for (const receipt of receipts) {
    if (typeof receipt?.runId !== 'string' || !receipt.runId) continue;
    byRunId.set(receipt.runId, { ...(byRunId.get(receipt.runId) || {}), ...receipt });
  }
  return [...byRunId.values()].slice(-32);
}

export function upsertManualAiCleanupReceipt(receipts, receipt) {
  return normalizeManualAiCleanupReceipts([
    ...normalizeManualAiCleanupReceipts(receipts).filter(item => item.runId !== receipt?.runId),
    receipt,
  ]);
}

export function removeManualAiCleanupReceipt(receipts, runId) {
  return normalizeManualAiCleanupReceipts(receipts).filter(receipt => receipt.runId !== runId);
}

// A hidden/minimized Electron window can throttle animation frames. Keep a
// short timer fallback so a completed source never holds a lane indefinitely
// merely because the canvas is not being painted right now.
export function waitForRendererCommitFrame() {
  return new Promise((resolve) => {
    let settled = false;
    let fallbackTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (fallbackTimer != null) clearTimeout(fallbackTimer);
      resolve();
    };
    fallbackTimer = setTimeout(finish, 50);
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(finish);
    }
  });
}
