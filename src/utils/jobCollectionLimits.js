/**
 * User-configurable job-collection breadth, stored on the Job Search hub.
 *
 * A blank/null value is the safe **Auto** policy (kept as null on disk for
 * backwards compatibility):
 *   - at most 500 jobs per platform;
 *   - at most 10 pages for one generated query;
 *   - at most 40 browser pages for that platform across every generated query.
 *
 * A positive number remains an explicit user override. It may intentionally be
 * deeper than Auto and is never silently narrowed by Auto's aggregate budget.
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

/** The effective limits for a blank/null (Auto) collection policy. */
export const JOB_COLLECTION_AUTO_LIMITS = Object.freeze({
  jobsPerPlatform: 500,
  pagesPerQuery: 10,
  pagesPerPlatform: 40,
});

// Compatibility name retained for callers/report fixtures that describe the
// resolved no-number policy. It is no longer a pathological 1,000-page cap.
export const JOB_COLLECTION_PAGE_CEILING = JOB_COLLECTION_AUTO_LIMITS.pagesPerQuery;

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

/** True when Pages is using Auto rather than an explicit page count. */
export function isUnlimitedPages(limits) {
  return normalizeJobCollectionLimits(limits).pagesPerPlatform == null;
}

export function isAutoJobCollection(limits) {
  const normalized = normalizeJobCollectionLimits(limits);
  return normalized.jobsPerPlatform == null && normalized.pagesPerPlatform == null;
}

/** Effective per-platform row cap. Null on disk means Auto's finite row cap. */
export function resolveJobsPerPlatform(limits) {
  return normalizeJobCollectionLimits(limits).jobsPerPlatform ?? JOB_COLLECTION_AUTO_LIMITS.jobsPerPlatform;
}

/**
 * The FINITE per-query ceiling every walker loop should use. A blank setting
 * resolves to Auto's 10 pages; an explicit number is used verbatim.
 */
export function resolvePageCeiling(limits) {
  return normalizeJobCollectionLimits(limits).pagesPerPlatform ?? JOB_COLLECTION_AUTO_LIMITS.pagesPerQuery;
}

/**
 * Allocate Auto's platform-wide browser-page budget across generated queries.
 * Earlier queries receive one extra page when division is uneven, which makes
 * the allocation deterministic and preserves the first-query resume contract.
 * Explicit page values intentionally opt out of this aggregate Auto budget.
 */
export function resolveBrowserPageBudgets(limits, queryCount) {
  const count = Math.max(0, Math.floor(Number(queryCount) || 0));
  if (count === 0) return [];
  const explicit = normalizeJobCollectionLimits(limits).pagesPerPlatform;
  if (explicit != null) return Array(count).fill(explicit);
  const total = Math.min(
    JOB_COLLECTION_AUTO_LIMITS.pagesPerPlatform,
    JOB_COLLECTION_AUTO_LIMITS.pagesPerQuery * count,
  );
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_unused, index) => base + (index < remainder ? 1 : 0));
}

/** Human-readable breadth for logs, diagnostics and bug reports. */
export function describeJobCollectionLimits(limits) {
  const { jobsPerPlatform, pagesPerPlatform } = normalizeJobCollectionLimits(limits);
  return {
    jobs: jobsPerPlatform == null ? `auto (${JOB_COLLECTION_AUTO_LIMITS.jobsPerPlatform})` : String(jobsPerPlatform),
    pages: pagesPerPlatform == null
      ? `auto (${JOB_COLLECTION_AUTO_LIMITS.pagesPerQuery}/query, ${JOB_COLLECTION_AUTO_LIMITS.pagesPerPlatform}/platform)`
      : String(pagesPerPlatform),
  };
}
