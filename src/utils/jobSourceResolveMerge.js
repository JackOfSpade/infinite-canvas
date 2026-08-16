import { sourceJobKey, uniqueJobsAcrossSources } from './jobIdentity.js';

export function mergeResolvedSourceItems(prevPending, incomingItems, sourceId, {
  replaceSourceItems = false,
  replaceMatchingItems = false,
  removedItemKeys = [],
} = {}) {
  const previous = Array.isArray(prevPending) ? prevPending : [];
  const incoming = Array.isArray(incomingItems) ? incomingItems : [];

  // LinkedIn re-fetch returns the full source set with fresher descriptions, so
  // replace prior LinkedIn cards. Captcha/Continue flows return only newly
  // unlocked pages, so keep existing same-source jobs and append deduped fresh
  // items instead of dropping work already captured before the block.
  const incomingSourceKeys = replaceMatchingItems
    ? new Set(incoming.filter(job => job?.source === sourceId).map(sourceJobKey))
    : null;
  const removedKeys = new Set(Array.isArray(removedItemKeys) ? removedItemKeys : []);
  const keep = replaceSourceItems
    ? previous.filter(job => job?.source !== sourceId)
    : replaceMatchingItems
      ? previous.filter(job => job?.source !== sourceId || !incomingSourceKeys.has(sourceJobKey(job)))
      : previous;
  const retained = removedKeys.size === 0
    ? keep
    : keep.filter(job => job?.source !== sourceId || !removedKeys.has(sourceJobKey(job)));
  // Dedup with the SAME location-aware logic the backend's cross-source dedup
  // uses (jobIdentity.js's dedupJobsAcrossSources): had this source not
  // blocked, the backend would have collapsed its copy of a posting another
  // source already returned, INCLUDING keeping distinct same-title/company
  // reqs in different cities apart. A plain title+company key (or the URL key
  // used here previously) either lets cross-source copies through twice or
  // over-collapses distinct cities onto each other.
  const fresh = uniqueJobsAcrossSources(retained, incoming);

  return {
    keep: retained,
    fresh,
    mergedPending: [...retained, ...fresh],
    replacedExisting: previous.length - retained.length,
  };
}
