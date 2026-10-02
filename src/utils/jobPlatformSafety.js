import { normalizeJobCollectionLimits, resolveJobsPerPlatform, resolvePageCeiling } from './jobCollectionLimits.js';

/**
 * Collection-safety contract for each supported job source.
 *
 * A platform can opt out of Auto only when its collector has no independent
 * terminal condition for that dimension. Do not mark a source
 * unsafe merely because it is browser-driven: every current browser walker has
 * a finite page backstop and data-driven terminal conditions.  Keeping that
 * fact here makes adding a future, genuinely unbounded collector deliberate.
 *
 * `all` is the normal mode. The other modes remain forward-compatible labels;
 * Auto resolves to finite values, so they do not reject a saved null config.
 *
 * - `finite-jobs`: needs a positive jobs-per-platform setting
 * - `finite-pages`: needs a positive pages-per-platform setting
 * - `finite-both`: needs both settings to be positive
 */
export const JOB_PLATFORM_COLLECTION_SAFETY = Object.freeze({
  google:          'all', // one-shot reveal, itself iteration-capped
  indeed:          'all', // empty/no-new/age stops + finite page backstop
  linkedin:        'all', // hard provider-result ceiling
  remoteok:        'all', // single finite feed response
  weworkremotely:  'all', // single finite feed response
  ziprecruiter:    'all', // empty/no-new stops + finite page backstop
  glassdoor:       'all', // missing load-more/no-new stops + finite backstop
  dice:            'all', // bounded API fan-out
  usajobs:         'all', // bounded API response
});

const VALID_MODES = new Set(['all', 'finite-jobs', 'finite-pages', 'finite-both']);

function normalizedMode(mode) {
  return VALID_MODES.has(mode) ? mode : 'finite-both';
}

/**
 * Evaluate a safety mode independently of the source registry. Exported so
 * tests (and future source integrations) can prove every Auto combination.
 */
export function getJobCollectionSafetyForMode(mode, collectionLimits) {
  const limits = normalizeJobCollectionLimits(collectionLimits);
  const normalized = normalizedMode(mode);
  // Resolve here rather than testing raw null: existing saved Auto settings
  // are bounded (500 jobs, 10 pages/query) without a destructive migration.
  const finite = Number.isFinite(resolveJobsPerPlatform(limits)) && Number.isFinite(resolvePageCeiling(limits));
  return { enabled: finite, code: finite ? null : 'invalid-collection-limits', reason: finite ? null : `This platform needs valid finite collection limits for ${normalized}.` };
}

/**
 * Whether this source can be selected for the supplied card collection limits.
 * Unknown source ids are conservative only while the user has selected Auto:
 * a newly added collector must explicitly prove it applies Auto's bounds.
 */
export function getJobPlatformSafety(sourceId, collectionLimits) {
  const id = String(sourceId || '').trim();
  const mode = JOB_PLATFORM_COLLECTION_SAFETY[id];
  const safety = getJobCollectionSafetyForMode(mode || 'finite-both', collectionLimits);
  const normalizedLimits = normalizeJobCollectionLimits(collectionLimits);
  // Each blank field independently selects an Auto limit. Unknown collectors
  // must be reviewed for every Auto dimension, not just the both-blank shape.
  const usesAutoPolicy = normalizedLimits.jobsPerPlatform == null || normalizedLimits.pagesPerPlatform == null;
  return {
    sourceId: id,
    ...safety,
    ...(mode ? {} : {
      enabled: usesAutoPolicy ? false : safety.enabled,
      code: usesAutoPolicy ? 'unreviewed-auto-collector' : safety.enabled ? null : 'unreviewed-collector',
      reason: usesAutoPolicy
        ? 'This platform has not been reviewed to enforce the finite Auto collection budget. Set explicit limits before enabling it.'
        : safety.enabled ? null : 'This platform has not been reviewed for the supplied collection limits.',
    }),
  };
}

/** Return the requested source ids that cannot safely run with these limits. */
export function getUnsafeJobPlatformIds(collectionLimits, sourceIds = Object.keys(JOB_PLATFORM_COLLECTION_SAFETY)) {
  const ids = Array.isArray(sourceIds) ? sourceIds : [];
  return ids.filter(sourceId => !getJobPlatformSafety(sourceId, collectionLimits).enabled);
}
