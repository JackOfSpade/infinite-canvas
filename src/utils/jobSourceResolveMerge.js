import { jobTitleCompanyUrlKey, uniqueJobsNotIn } from './jobIdentity.js';

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
  const fresh = uniqueJobsNotIn(keep, incoming, jobTitleCompanyUrlKey);

  return {
    keep,
    fresh,
    mergedPending: [...keep, ...fresh],
    replacedExisting: previous.length - keep.length,
  };
}
