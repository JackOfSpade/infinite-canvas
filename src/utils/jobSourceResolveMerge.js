import { jobTitleCompanyKey, uniqueJobsNotIn } from './jobIdentity.js';

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
  // Dedup with the SAME-RUN key (title|company — see jobIdentity.js policy):
  // had this source not blocked, the backend's cross-source dedup would have
  // collapsed its copy of a posting another source already returned. The
  // URL key used here previously let those cross-source copies through, so a
  // Solve could send the same posting to the scorer (and the board) twice.
  const fresh = uniqueJobsNotIn(keep, incoming, jobTitleCompanyKey);

  return {
    keep,
    fresh,
    mergedPending: [...keep, ...fresh],
    replacedExisting: previous.length - keep.length,
  };
}
