// Pure shared policy for the ownership-discovery upgrade. A source-input
// semantic hash binds a decision to a listing, but cannot prove that the older
// discovery/ownership implementation examined every candidate it rejected.
// Version 4 also retires negatives made before per-page navigation limits were
// recorded as partial coverage. Finding no verified source, or comparing only
// a capped part of its inventory, cannot establish absence.
// The host adds this marker only after a new settled semantic negative.
export const OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL = 'ownership-discovery-v4';

export function officialPostingNegativeNeedsRecheck(posting) {
  return Boolean(posting && typeof posting === 'object' && !Array.isArray(posting)
    && ['L5', 'L6'].includes(posting.level)
    && ['not-found', 'ambiguous'].includes(posting.outcome)
    && !(Array.isArray(posting.trail) && posting.trail.includes(OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL)));
}
