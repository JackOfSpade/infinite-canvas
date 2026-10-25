import { normalizeBoardClosed } from '../../electron/ipc/officialPostingFields.js';
import { dedupJobsAcrossSources, sourceJobKey, uniqueJobsAcrossSources } from './jobIdentity.js';

const isBoardClosed = job => normalizeBoardClosed(job?.boardClosed) !== null;

/**
 * Dedup `incoming` against `retained` the way uniqueJobsAcrossSources does
 * (retained rows win), with one exception: a pending board-closed copy never
 * beats an open copy of the same posting. The main process already orders open
 * rows ahead of closed ones before its first-wins dedup; this is the only other
 * place the two copies meet (a source that was blocked during the search, then
 * resumed), so it applies the same rule. Returns the retained rows that lost to
 * an incoming open copy as `supplanted`.
 */
function dedupIncomingOpenFirst(retained, incoming) {
  if (!retained.some(isBoardClosed) || incoming.every(isBoardClosed)) {
    return { fresh: uniqueJobsAcrossSources(retained, incoming), supplanted: new Set() };
  }
  const retainedSet = new Set(retained);
  const supplanted = new Set();
  const isOpen = job => !isBoardClosed(job);
  // Open rows first (pending, then incoming), then the closed ones: first-wins dedup.
  const survivors = new Set(dedupJobsAcrossSources([
    ...retained.filter(isOpen), ...incoming.filter(isOpen),
    ...retained.filter(isBoardClosed), ...incoming.filter(isBoardClosed),
  ], {
    onDuplicate: ({ kept, dropped }) => {
      if (retainedSet.has(dropped) && isBoardClosed(dropped) && !retainedSet.has(kept) && isOpen(kept)) supplanted.add(dropped);
    },
  }));
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
