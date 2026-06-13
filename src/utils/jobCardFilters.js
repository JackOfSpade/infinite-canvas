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
