/**
 * User-configurable job-collection breadth, stored on the Job Search hub.
 *
 * BOTH fields are "All" by default (stored as `null`, rendered as a blank input
 * with an "All" placeholder):
 *   - `jobsPerPlatform: null` — no aggregate result cap.
 *   - `pagesPerPlatform: null` — no page ceiling: a browser board keeps paging
 *     until it runs out of results, until its listings fall outside the hub's
 *     automatic date window (see makeJobPageStop in electron/ipc/jobPageStop.js),
 *     or until the JOB_COLLECTION_PAGE_CEILING backstop below.
 * Feed sources (RemoteOK, WeWorkRemotely) are single un-paginated requests and
 * have no page count to limit. Dice, however, walks its API `page` parameter
 * and honors pagesPerPlatform directly (with the finite backstop below when
 * Pages is All). LinkedIn and USAJobs retain their source-specific walk bounds.
 */
export const JOB_COLLECTION_LIMITS_DEFAULT = Object.freeze({
  jobsPerPlatform: null,
  pagesPerPlatform: null,
});

export const JOB_COLLECTION_LIMITS_MAX = Object.freeze({
  jobsPerPlatform: 10_000,
  pagesPerPlatform: 1_000,
});

/**
 * Hard backstop applied when pagesPerPlatform is "All". Unlimited means "walk
 * until the data says stop" (empty page / out-of-window page / a pager that has
 * stopped serving new rows), NOT "loop forever": a board with a broken pager
 * that re-serves page 1 indefinitely would otherwise never terminate. Same
 * number as the max a user can type, so "All" is never narrower than an
 * explicit setting.
 */
export const JOB_COLLECTION_PAGE_CEILING = JOB_COLLECTION_LIMITS_MAX.pagesPerPlatform;

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
    pagesPerPlatform: positiveInteger(source.pagesPerPlatform, null, JOB_COLLECTION_LIMITS_MAX.pagesPerPlatform),
  };
}

/** True when the hub asks a browser board to page without a user-set ceiling. */
export function isUnlimitedPages(limits) {
  return normalizeJobCollectionLimits(limits).pagesPerPlatform == null;
}

/**
 * The FINITE page ceiling every walker loop should use. Callers must never
 * branch on null themselves — `limits.pagesPerPlatform || 10` (the old idiom)
 * silently turns "All" back into the retired 10-page default.
 */
export function resolvePageCeiling(limits) {
  return normalizeJobCollectionLimits(limits).pagesPerPlatform ?? JOB_COLLECTION_PAGE_CEILING;
}

/** Human-readable breadth for logs, diagnostics and bug reports. */
export function describeJobCollectionLimits(limits) {
  const { jobsPerPlatform, pagesPerPlatform } = normalizeJobCollectionLimits(limits);
  return {
    jobs: jobsPerPlatform == null ? 'all' : String(jobsPerPlatform),
    pages: pagesPerPlatform == null ? `all (backstop ${JOB_COLLECTION_PAGE_CEILING})` : String(pagesPerPlatform),
  };
}
