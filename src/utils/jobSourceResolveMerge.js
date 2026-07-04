import { uniqueJobsAcrossSources } from './jobIdentity.js';

export function mergeResolvedSourceItems(prevPending, incomingItems, sourceId, {
  replaceSourceItems = false,
} = {}) {
  const previous = Array.isArray(prevPending) ? prevPending : [];
  const incoming = Array.isArray(incomingItems) ? incomingItems : [];

  // LinkedIn re-fetch returns the full source set with fresher descriptions, so
  // replace prior LinkedIn cards. Captcha/Continue flows return only newly
  // unlocked pages, so keep existing same-source jobs and append deduped fresh
  // items instead of dropping work already captured before the block.
  const keep = replaceSourceItems
    ? previous.filter(job => job?.source !== sourceId)
    : previous;
  // Dedup with the SAME location-aware logic the backend's cross-source dedup
  // uses (jobIdentity.js's dedupJobsAcrossSources): had this source not
  // blocked, the backend would have collapsed its copy of a posting another
  // source already returned, INCLUDING keeping distinct same-title/company
  // reqs in different cities apart. A plain title+company key (or the URL key
  // used here previously) either lets cross-source copies through twice or
  // over-collapses distinct cities onto each other.
  const fresh = uniqueJobsAcrossSources(keep, incoming);

  return {
    keep,
    fresh,
    mergedPending: [...keep, ...fresh],
    replacedExisting: previous.length - keep.length,
  };
}
