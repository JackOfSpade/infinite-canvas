// Card preparation is routed through its parent hub's AI bridge, but the card
// owns the request. Search-owned official-posting checks reuse the Search run
// id and must continue to participate in normal hub recovery.
export function isCardOfficialPostingRunId(runId) {
  return typeof runId === 'string' && runId.startsWith('official-posting:');
}

// Remove only accidentally adopted card markers. This never retires the
// card's backend run, resets completed Search results, or changes real hub
// checkpoints and cleanup receipts.
export function cardOfficialPostingHubMarkerCleanup(data) {
  if (!data || typeof data !== 'object') return null;
  const patch = {};
  if (isCardOfficialPostingRunId(data.manualAiResume?.runId)) patch.manualAiResume = null;
  if (Array.isArray(data.manualAiCleanupReceipts)) {
    const kept = data.manualAiCleanupReceipts.filter(receipt => !isCardOfficialPostingRunId(receipt?.runId));
    if (kept.length !== data.manualAiCleanupReceipts.length) patch.manualAiCleanupReceipts = kept;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
