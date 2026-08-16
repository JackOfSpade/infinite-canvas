import { normalizeJobCollectionLimits } from './jobCollectionLimits.js';

/**
 * Collection-safety contract for each supported job source.
 *
 * A platform can opt out of an unlimited setting only when its collector has
 * no independent terminal condition for that dimension.  Do not mark a source
 * unsafe merely because it is browser-driven: every current browser walker has
 * a finite page backstop and data-driven terminal conditions.  Keeping that
 * fact here makes adding a future, genuinely unbounded collector deliberate.
 *
 * `all` is the normal mode. The other modes are intentionally supported so the
 * UI can prevent enabling a future source while either relevant field is All:
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
 * tests (and future source integrations) can prove every All combination.
 */
export function getJobCollectionSafetyForMode(mode, collectionLimits) {
  const limits = normalizeJobCollectionLimits(collectionLimits);
  const normalized = normalizedMode(mode);
  const jobsAll = limits.jobsPerPlatform == null;
  const pagesAll = limits.pagesPerPlatform == null;

  let code = null;
  if (normalized === 'finite-jobs' && jobsAll) code = 'unlimited-jobs';
  if (normalized === 'finite-pages' && pagesAll) code = 'unlimited-pages';
  if (normalized === 'finite-both' && jobsAll && pagesAll) code = 'unlimited-jobs-and-pages';
  // A collector that needs BOTH finite values must also be disabled when just
  // either one is All. Spell the single-field reason out for a useful UI warning.
  if (normalized === 'finite-both' && !code && jobsAll) code = 'unlimited-jobs';
  if (normalized === 'finite-both' && !code && pagesAll) code = 'unlimited-pages';

  const reasonByCode = {
    'unlimited-jobs': 'This platform needs a job limit before it can be enabled; Jobs per platform is set to All.',
    'unlimited-pages': 'This platform needs a page limit before it can be enabled; Browser pages per search is set to All.',
    'unlimited-jobs-and-pages': 'This platform needs job and page limits before it can be enabled; both are set to All.',
  };
  return { enabled: code == null, code, reason: code == null ? null : reasonByCode[code] };
}

/**
 * Whether this source can be selected for the supplied card collection limits.
 * Unknown source ids are conservative only while an All setting is active:
 * explicit finite limits remain usable, while an unreviewed unlimited collector
 * cannot accidentally enter a non-terminating walk.
 */
export function getJobPlatformSafety(sourceId, collectionLimits) {
  const id = String(sourceId || '').trim();
  const mode = JOB_PLATFORM_COLLECTION_SAFETY[id];
  const safety = getJobCollectionSafetyForMode(mode || 'finite-both', collectionLimits);
  return {
    sourceId: id,
    ...safety,
    ...(mode ? {} : {
      code: safety.enabled ? null : 'unreviewed-unlimited-collector',
      reason: safety.enabled ? null : 'This platform has not been reviewed for unlimited collection. Set both collection limits to a number before enabling it.',
    }),
  };
}

/** Return the requested source ids that cannot safely run with these limits. */
export function getUnsafeJobPlatformIds(collectionLimits, sourceIds = Object.keys(JOB_PLATFORM_COLLECTION_SAFETY)) {
  const ids = Array.isArray(sourceIds) ? sourceIds : [];
  return ids.filter(sourceId => !getJobPlatformSafety(sourceId, collectionLimits).enabled);
}
