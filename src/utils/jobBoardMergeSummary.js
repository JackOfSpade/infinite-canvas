/**
 * Per-Search inputs to one Board merge. `count` is the rows that really entered the merge, `sourceCount` the Search's
 * saved result. `mergedArrays` is indexed by `ready` modules, so a completed module that wasn't ready contributed 0.
 */
export function boardCombinePerModule(completed, ready, mergedArrays) {
  const merged = new Map((ready || []).map((module, index) => [module.id, mergedArrays?.[index]?.length || 0]));
  return (completed || []).map(module => ({ label: module.label, count: merged.get(module.id) ?? 0, sourceCount: module.count }));
}

const whole = value => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0);

/**
 * "saved · Board preferences · incoming" for a merge log or report. The Board preference numbers are rows per Search
 * because those balance against incoming: checked rows - removed rows = incoming. Saved results don't flow into that
 * sum, because Board preferences also check each Search's candidate pool, so saved is shown only for reference.
 */
export function describeBoardMergeInputs(stats = {}) {
  const perModule = Array.isArray(stats.perModule) ? stats.perModule : [];
  const incoming = perModule.length ? `${perModule.map(item => item?.count ?? '?').join('+')}=${stats.totalIncoming ?? '?'}` : `${stats.totalIncoming ?? '?'}`;
  if (!Number.isFinite(stats.overrideCheckedRows)) return incoming;
  const saved = perModule.map(item => item?.sourceCount ?? '?').join('+');
  return `saved ${saved} · Board preferences checked ${whole(stats.overrideCheckedRows)} rows (${whole(stats.overrideChecked)} distinct), `
    + `removed ${whole(stats.overrideRemovedRows)} · incoming ${incoming}`;
}
