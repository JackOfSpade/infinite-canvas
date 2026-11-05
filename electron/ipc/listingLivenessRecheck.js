// Continue-time recheck of rows the search-time liveness pass left 'pending'.
// Their page evidence died with the search request, so each one is visited again
// and the fresh evidence goes through the same AI session as a search-time row.
import { forgetListingEvidence, listingEvidenceKey, recordListingEvidence } from './listingLivenessStore.js';
import { normalizeListingLiveness, normalizeOfficialPosting } from './officialPostingFields.js';
import { isProbeableListingHost } from './listingLivenessProbe.js';
import { classifyListingVisit, notFoundBurst, recordListingLivenessBatch } from './listingLivenessHealth.js';

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
  let withEvidence = [];
  let visited = 0; let unknown = 0;
  const healthVisits = [];
  for (const row of candidates) {
    if (signal?.aborted) throw signal.reason || new Error('Listing recheck cancelled.');
    const evidence = await createProbe({ job: row }).probe(row.url, { signal });
    visited += 1;
    healthVisits.push({ board: normalizeListingLiveness(row.listingLiveness)?.board || row.source, outcome: classifyListingVisit(evidence), listing: row.url });
    if (!evidence || evidence.unknown || !recordListingEvidence(row, evidence)) {
      unknown += 1;
      if (unknown >= MAX_CONSECUTIVE_UNKNOWN) break;
      continue;
    }
    unknown = 0;
    withEvidence.push(row);
  }
  recordListingLivenessBatch(healthVisits);
  // A board where most of this pass's pages returned 404 at once looks like a broken route: those rows stay pending,
  // and nothing judges them from the 404 page.
  const tally = new Map();
  healthVisits.forEach((visit, index) => {
    if (!['closed-not-found', 'unreadable', 'healthy'].includes(visit.outcome)) return;
    const entry = tally.get(visit.board) || { reads: 0, notFound: 0, rows: [] };
    entry.reads += 1;
    if (visit.outcome === 'closed-not-found') { entry.notFound += 1; entry.rows.push(candidates[index]); }
    tally.set(visit.board, entry);
  });
  const held = new Set([...tally.values()].filter(entry => notFoundBurst(entry.reads, entry.notFound)).flatMap(entry => entry.rows));
  if (held.size) {
    for (const row of held) forgetListingEvidence(row);
    withEvidence = withEvidence.filter(row => !held.has(row));
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
