// Bounded, count-only listing checks. Page evidence and row identity must never
// enter a receipt or the bug report through this block.
import { normalizeBoardClosed, normalizeListingLiveness } from './officialPostingFields.js';

export const LISTING_LIVENESS_COUNT_FIELDS = Object.freeze([
  'observed', 'structuralClosed', 'aiChecked', 'aiOpen', 'aiClosed', 'aiUnclear',
  'aiPending', 'aiSkippedOfficial', 'alternateRestored', 'keptAmbiguous',
  'deferredUnchecked', 'droppedOfficialClosed', 'auditChecked', 'auditDisagreed',
  'rulePromoted', 'ruleDemoted', 'expiryOnlyClosedCopies',
  'expiryCandidatesConfirmedClosed', 'expiryCandidatesNotConfirmed',
]);
const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const MAX_BOARDS = 24;
const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;

export function bumpListingLivenessCount(block, board, field, amount = 1) {
  if (!block || !BOARD_ID_RE.test(board) || !LISTING_LIVENESS_COUNT_FIELDS.includes(field)) return;
  if (!Object.hasOwn(block, board) && Object.keys(block).length >= MAX_BOARDS) return;
  const entry = Object.hasOwn(block, board) ? block[board]
    : (block[board] = Object.fromEntries(LISTING_LIVENESS_COUNT_FIELDS.map(key => [key, 0])));
  entry[field] += count(amount);
}

export function mergeListingLivenessTelemetry(...blocks) {
  const result = {};
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [board, entry] of Object.entries(block)) {
      if (!BOARD_ID_RE.test(board) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      for (const field of LISTING_LIVENESS_COUNT_FIELDS) bumpListingLivenessCount(result, board, field, entry[field] ?? 0);
    }
  }
  return result;
}

/** Counts only the current resolver input; AI/audit additions are merged later. */
export function listingLivenessTelemetryBlock({ input = [], settled = null, officialClosedDrops = [] } = {}) {
  const block = {};
  for (const row of Array.isArray(input) ? input : []) {
    const state = normalizeListingLiveness(row?.listingLiveness);
    if (!state) continue;
    bumpListingLivenessCount(block, state.board, 'observed');
    if (state.verdict === 'closed' && state.basis === 'structural') bumpListingLivenessCount(block, state.board, 'structuralClosed');
  }
  for (const [row, disposition] of settled?.dispositions || []) {
    const board = normalizeListingLiveness(row?.listingLiveness)?.board || normalizeBoardClosed(row?.boardClosed)?.board;
    if (board && disposition === 'kept-ambiguous') bumpListingLivenessCount(block, board, 'keptAmbiguous');
  }
  for (const entry of settled?.dropped || []) {
    const board = normalizeListingLiveness(entry?.row?.listingLiveness)?.board
      || normalizeBoardClosed(entry?.row?.boardClosed)?.board;
    if (board && entry.disposition === 'deferred-unchecked') bumpListingLivenessCount(block, board, 'deferredUnchecked');
  }
  for (const entry of Array.isArray(officialClosedDrops) ? officialClosedDrops : []) {
    const state = normalizeListingLiveness(entry?.dropped?.listingLiveness);
    if (state) bumpListingLivenessCount(block, state.board, 'droppedOfficialClosed');
  }
  return block;
}
