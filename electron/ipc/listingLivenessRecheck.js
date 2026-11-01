// Continue-time recheck of rows the search-time liveness pass left 'pending'.
// Their page evidence died with the search request, so each one is visited again
// and the fresh evidence goes through the same AI session as a search-time row.
import { listingEvidenceKey, recordListingEvidence } from './listingLivenessStore.js';
import { normalizeListingLiveness, normalizeOfficialPosting } from './officialPostingFields.js';
import { isProbeableListingHost } from './listingLivenessProbe.js';

export const LISTING_RECHECK_MAX_ROWS = 40;
const MAX_CONSECUTIVE_UNKNOWN = 3;
const stillPending = row => normalizeListingLiveness(row?.listingLiveness)?.verdict === 'pending'
  && !['L1', 'L2', 'L3', 'L4'].includes(normalizeOfficialPosting(row?.officialPosting)?.level);

/**
 * Returns rows in their input order with only the liveness pair changed, plus
 * counts for the report. A wall (three unknown visits in a row) stops the pass
 * early; every row not resolved here stays pending and is counted.
 */
export async function recheckPendingListings(rows, { createProbe, createSession, signal = null } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const candidates = input.filter(row => stillPending(row) && isProbeableListingHost(row?.url))
    .slice(0, LISTING_RECHECK_MAX_ROWS);
  const withEvidence = [];
  let visited = 0; let unknown = 0;
  for (const row of candidates) {
    if (signal?.aborted) throw signal.reason || new Error('Listing recheck cancelled.');
    const evidence = await createProbe({ job: row }).probe(row.url, { signal });
    visited += 1;
    if (!evidence || evidence.unknown || !recordListingEvidence(row, evidence)) {
      unknown += 1;
      if (unknown >= MAX_CONSECUTIVE_UNKNOWN) break;
      continue;
    }
    unknown = 0;
    withEvidence.push(row);
  }
  const resolved = new Map();
  if (withEvidence.length) {
    const checked = await createSession().classifyPrimary(withEvidence);
    for (const row of checked) if (!stillPending(row)) resolved.set(listingEvidenceKey(row), row);
  }
  const output = input.map(row => {
    const fresh = stillPending(row) ? resolved.get(listingEvidenceKey(row)) : null;
    if (!fresh) return row;
    const merged = { ...row, listingLiveness: fresh.listingLiveness };
    if (fresh.boardClosed !== undefined) merged.boardClosed = fresh.boardClosed;
    return merged;
  });
  return { rows: output, visited, rechecked: resolved.size, stillPending: output.filter(stillPending).length };
}
