import { normalizeBoardClosed, normalizeOfficialPosting } from '../../electron/ipc/officialPostingFields.js';
import { dedupJobsAcrossSources, sourceJobKey, uniqueJobsAcrossSources } from './jobIdentity.js';

const isBoardClosed = job => normalizeBoardClosed(job?.boardClosed) !== null;
const hasVerifiedPosting = job => {
  const posting = normalizeOfficialPosting(job?.officialPosting);
  return posting !== null && ['L1', 'L2', 'L3', 'L4'].includes(posting.level) && ['found', 'link-only'].includes(posting.outcome);
};

/** Priority for first-wins source dedup; every row stays present and inputs stay untouched. */
function orderSourceCopiesOpenFirst(retained, incoming) {
  const previous = Array.isArray(retained) ? retained : [];
  const next = Array.isArray(incoming) ? incoming : [];
  const combined = [...previous, ...next];
  if (!combined.some(isBoardClosed)) return combined;
  const open = job => !isBoardClosed(job);
  const protectedClosed = previous.filter(job => isBoardClosed(job) && hasVerifiedPosting(job));
  // A pending verified official result beats an unchecked incoming board copy;
  // an incoming verified open copy can still replace it.
  return [
    ...previous.filter(open), ...next.filter(job => open(job) && hasVerifiedPosting(job)),
    ...protectedClosed, ...next.filter(job => open(job) && !hasVerifiedPosting(job)),
    ...previous.filter(job => isBoardClosed(job) && !hasVerifiedPosting(job)), ...next.filter(isBoardClosed),
  ];
}

/**
 * Dedup `incoming` against `retained` the way uniqueJobsAcrossSources does
 * (retained rows win), except an incoming open copy can replace a pending
 * board-closed copy after a blocked source resumes. A verified pending copy
 * requires a verified replacement. Returns only pending rows whose incoming
 * open replacement actually survived the dedup as `supplanted`.
 */
function dedupIncomingOpenFirst(retained, incoming) {
  if (!retained.some(isBoardClosed) || incoming.every(isBoardClosed)) {
    return { fresh: uniqueJobsAcrossSources(retained, incoming), supplanted: new Set() };
  }
  const retainedSet = new Set(retained);
  const supplanted = new Set();
  const duplicatePairs = [];
  const isOpen = job => !isBoardClosed(job);
  const survivors = new Set(dedupJobsAcrossSources(orderSourceCopiesOpenFirst(retained, incoming), {
    onDuplicate: ({ kept, dropped }) => {
      if (retainedSet.has(dropped) && isBoardClosed(dropped) && !retainedSet.has(kept) && isOpen(kept)) duplicatePairs.push({ kept, dropped });
    },
  }));
  for (const { kept, dropped } of duplicatePairs) if (survivors.has(kept)) supplanted.add(dropped);
  // Each surviving incoming row once, in the order the source returned them.
  const fresh = [...new Set(incoming)].filter(job => survivors.has(job) && !retainedSet.has(job));
  return { fresh, supplanted };
}

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
  const remaining = removedKeys.size === 0
    ? keep
    : keep.filter(job => job?.source !== sourceId || !removedKeys.has(sourceJobKey(job)));
  // Dedup with the SAME location-aware logic the backend's cross-source dedup
  // uses (jobIdentity.js's dedupJobsAcrossSources): had this source not
  // blocked, the backend would have collapsed its copy of a posting another
  // source already returned, INCLUDING keeping distinct same-title/company
  // reqs in different cities apart. A plain title+company key (or the URL key
  // used here previously) either lets cross-source copies through twice or
  // over-collapses distinct cities onto each other.
  const { fresh, supplanted } = dedupIncomingOpenFirst(remaining, incoming);
  const retained = supplanted.size === 0 ? remaining : remaining.filter(job => !supplanted.has(job));

  return {
    keep: retained,
    fresh,
    mergedPending: [...retained, ...fresh],
    replacedExisting: previous.length - retained.length,
  };
}
