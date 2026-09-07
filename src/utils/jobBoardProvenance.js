// Preserve exact source-run ownership when a Job Board is cleared. Fresh
// connected modules use `{ id, runId }`; a persisted combine receipt already
// uses `{ sourceHubId, runId }`. Accept only these two explicit shapes so a
// board clear cannot turn a coerced value into report-verifying provenance.
export function boundedCombinedSourceRuns(entries, limit = 25) {
  const seen = new Set();
  const sourceRuns = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const hasPersistedSourceHubId = entry != null && typeof entry === 'object' && Object.hasOwn(entry, 'sourceHubId');
    const hasLiveModuleId = entry != null && typeof entry === 'object' && Object.hasOwn(entry, 'id');
    if ((hasPersistedSourceHubId && typeof entry.sourceHubId !== 'string')
      || (hasLiveModuleId && typeof entry.id !== 'string')) continue;
    const persistedSourceHubId = typeof entry?.sourceHubId === 'string' ? entry.sourceHubId.trim() : '';
    const liveModuleId = typeof entry?.id === 'string' ? entry.id.trim() : '';
    // A normal connected module carries `id`; a stored receipt carries
    // `sourceHubId`. If a mixed object provides both, it must agree exactly —
    // silently preferring either field could turn inconsistent provenance into
    // an exact-run proof in the support report.
    if ((hasPersistedSourceHubId && !/^[A-Za-z0-9_.:-]{1,180}$/.test(persistedSourceHubId))
      || (hasLiveModuleId && !/^[A-Za-z0-9_.:-]{1,180}$/.test(liveModuleId))
      || (persistedSourceHubId && liveModuleId && persistedSourceHubId !== liveModuleId)) continue;
    const sourceHubId = persistedSourceHubId || liveModuleId;
    const runId = typeof entry?.runId === 'string' ? entry.runId.trim() : '';
    if (!/^[A-Za-z0-9_.:-]{1,180}$/.test(sourceHubId)
      || !/^[A-Za-z0-9_.:-]{1,180}$/.test(runId)) continue;
    const key = `${sourceHubId}\u0000${runId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sourceRuns.push({ sourceHubId, runId });
    if (sourceRuns.length >= limit) break;
  }
  return sourceRuns;
}

// A board's pre-clear result count is diagnostic evidence. Accept only the
// exact in-memory number shape that the board owns; coercing persisted junk
// such as `false` or an empty string would manufacture a plausible zero count.
export function normalizeBoardResultCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
