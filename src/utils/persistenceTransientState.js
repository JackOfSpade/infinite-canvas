export const TRANSIENT_PROCESSING_HUB_STATES = [
  'parsing',
  'querying',
  'searching',
  'scoring',
  'analyzing',
  'researching',
];

const JOBHUB_TRANSIENT_KEYS = [
  'scrapeWarnings',
  'pendingJobs',
  'pendingTargetRole',
  'errorMessage',
  'isRateLimit',
];

const JOBHUB_SOURCES_READY_TRANSIENT_KEYS = [
  'errorMessage',
  'isRateLimit',
];

export const SELLHUB_TRANSIENT_KEYS = [
  'platformFitPending',
];

export function getJobHubTransientKeysForSave(hubState) {
  return hubState === 'sources-ready'
    ? JOBHUB_SOURCES_READY_TRANSIENT_KEYS
    : JOBHUB_TRANSIENT_KEYS;
}
