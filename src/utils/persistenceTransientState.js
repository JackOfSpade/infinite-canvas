export const TRANSIENT_PROCESSING_HUB_STATES = [
  'parsing',
  'querying',
  'searching',
  'scoring',
  'analyzing',
  'researching',
];

const JOBSEARCH_TRANSIENT_KEYS = [
  'scrapeWarnings',
  'pendingJobs',
  'pendingTargetRole',
  'errorMessage',
  'isRateLimit',
];

const JOBSEARCH_SOURCES_READY_TRANSIENT_KEYS = [
  'errorMessage',
  'isRateLimit',
];

export const SELLHUB_TRANSIENT_KEYS = [
  'platformFitPending',
];

export function getJobSearchTransientKeysForSave(hubState) {
  return hubState === 'sources-ready'
    ? JOBSEARCH_SOURCES_READY_TRANSIENT_KEYS
    : JOBSEARCH_TRANSIENT_KEYS;
}
