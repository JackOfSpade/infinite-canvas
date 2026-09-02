// The board's card filter: a single source pill + a min-score slider. Job
// cards are deliberately disposable (anti-CRM) — there is no status field to
// filter on, so the filter contract is exactly these two knobs.
export function isJobCardVisible(jobData = {}, {
  sourceFilter = null,
  scoreThreshold = 0,
} = {}) {
  const sourceOk = !sourceFilter || jobData.source === sourceFilter;
  const scoreOk = (jobData.matchScore ?? 0) >= scoreThreshold;
  return sourceOk && scoreOk;
}

// Canonical { scoreThreshold, sourceFilter } shape derived from a hub's own
// persisted data, mirroring isJobCardVisible's defaults. Every call site that
// feeds a hub's filter into computeJobTreeView should build it through here
// instead of reconstructing the object literal by hand.
export function hubCardFilter(hubData = {}) {
  return {
    scoreThreshold: hubData.scoreThreshold ?? 0,
    sourceFilter: hubData.sourceFilter ?? null,
  };
}
