/**
 * User-configurable job-collection breadth, stored on the Job Search hub.
 *
 * `null` jobsPerPlatform means no aggregate result cap. Browser pages keep the
 * existing production safety default of 10; API/feed sources do not paginate
 * and simply ignore pagesPerPlatform.
 */
export const JOB_COLLECTION_LIMITS_DEFAULT = Object.freeze({
  jobsPerPlatform: null,
  pagesPerPlatform: 10,
});

export const JOB_COLLECTION_LIMITS_MAX = Object.freeze({
  jobsPerPlatform: 10_000,
  pagesPerPlatform: 1_000,
});

function positiveInteger(value, fallback, maximum) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(Math.floor(number), maximum)
    : fallback;
}

export function normalizeJobCollectionLimits(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    jobsPerPlatform: positiveInteger(source.jobsPerPlatform, null, JOB_COLLECTION_LIMITS_MAX.jobsPerPlatform),
    pagesPerPlatform: positiveInteger(source.pagesPerPlatform, JOB_COLLECTION_LIMITS_DEFAULT.pagesPerPlatform, JOB_COLLECTION_LIMITS_MAX.pagesPerPlatform),
  };
}
