const DEFAULT_JOB_STATUS = 'New';

export function isJobCardVisible(jobData = {}, {
  sourceFilter = null,
  scoreThreshold = 0,
  statusFilters = [],
} = {}) {
  const activeStatusFilters = Array.isArray(statusFilters) ? statusFilters : [];
  const sourceOk = !sourceFilter || jobData.source === sourceFilter;
  const scoreOk = (jobData.matchScore ?? 0) >= scoreThreshold;
  const statusOk = activeStatusFilters.length === 0 ||
    activeStatusFilters.includes(jobData.status || DEFAULT_JOB_STATUS);

  return sourceOk && scoreOk && statusOk;
}
