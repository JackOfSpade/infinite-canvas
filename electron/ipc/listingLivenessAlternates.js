// Search-local copies lost by first-wins cross-source dedup. These full rows
// never belong on a job, staging snapshot, receipt, or diagnostic report.
import { listingStateRank, normalizeAlternateListings, normalizeBoardClosed, normalizeListingLiveness, normalizeOfficialPosting, officialHttpsUrl } from './officialPostingFields.js';
import { listingEvidenceKey } from './listingLivenessStore.js';
import { strictEmployerEqual } from './officialSourceHosts.js';
import { resolveScrapedEmployer } from './officialPostingMatch.js';
import { nodeCancellationError } from './ipcUtils.js';

const CROSS_SOURCE_REASONS = new Set(['cross-source-full-description', 'cross-source-title-company-location']);
const MAX_ALTERNATES = 4;

const keyOf = row => listingEvidenceKey(row);
function active(signal) { if (signal?.aborted) throw signal.reason || nodeCancellationError(); }

/** Follow both search dedups to the representative that reaches the resolver. */
export function collectListingAlternates({ admissionDrops = [], finalDrops = [], officialDrops = [], finalKept = [] } = {}) {
  const buckets = new Map();
  let order = 0;
  const append = (key, row, index) => {
    if (!key || !keyOf(row) || keyOf(row) === key) return;
    const bucket = buckets.get(key) || [];
    bucket.push({ row, order: index });
    buckets.set(key, bucket);
  };
  const transfer = receipt => {
    const keptKey = keyOf(receipt?.kept);
    const droppedKey = keyOf(receipt?.dropped);
    if (keptKey && droppedKey && keptKey !== droppedKey && buckets.has(droppedKey)) {
      const bucket = buckets.get(keptKey) || [];
      bucket.push(...buckets.get(droppedKey));
      buckets.set(keptKey, bucket);
      buckets.delete(droppedKey);
    }
    return keptKey;
  };
  for (const receipt of Array.isArray(admissionDrops) ? admissionDrops : []) {
    const index = order++;
    if (CROSS_SOURCE_REASONS.has(receipt?.reason)) append(keyOf(receipt.kept), receipt.dropped, index);
  }
  for (const receipt of Array.isArray(finalDrops) ? finalDrops : []) {
    const index = order++;
    const keptKey = transfer(receipt);
    // A same-source receipt can move an earlier winner's alternates, but is
    // itself another copy of the same listing and is never a candidate.
    if (CROSS_SOURCE_REASONS.has(receipt?.reason)) append(keptKey, receipt.dropped, index);
  }
  // Official dedup can replace the final cross-source representative with its
  // own official URL. It moves earlier candidates, but its loser is not a new
  // board alternate and never enters this list.
  for (const receipt of Array.isArray(officialDrops) ? officialDrops : []) transfer(receipt);
  const result = new Map();
  const finalKeys = new Set((Array.isArray(finalKept) ? finalKept : []).map(keyOf).filter(Boolean));
  for (const key of finalKeys) {
    const seen = new Set();
    const rows = (buckets.get(key) || []).sort((left, right) => left.order - right.order)
      .flatMap(({ row }) => {
        const alternateKey = keyOf(row);
        if (!alternateKey || alternateKey === key || seen.has(alternateKey)) return [];
        seen.add(alternateKey);
        return [row];
      }).slice(0, MAX_ALTERNATES);
    if (rows.length) result.set(key, rows);
  }
  return result;
}

/** Carry only safe board links from search-local dedup copies to kept rows. */
export function carryListingAlternates(rows, { alternatesByKey = new Map(), restored = [], classified = new Map() } = {}) {
  const originByReplacement = new Map((Array.isArray(restored) ? restored : []).map(({ winner, row }) => [row, winner]));
  return (Array.isArray(rows) ? rows : []).map(row => {
    const origin = originByReplacement.get(row) || row;
    const primaryUrl = officialHttpsUrl(row?.url);
    const candidates = alternatesByKey instanceof Map ? alternatesByKey.get(keyOf(origin)) : null;
    const links = normalizeAlternateListings((Array.isArray(candidates) ? candidates : []).slice(0, MAX_ALTERNATES)
      .map(candidate => classified.get(keyOf(candidate)) || candidate)
      .filter(candidate => listingStateRank(candidate) !== 4 && officialHttpsUrl(candidate?.url) !== primaryUrl)
      .map(candidate => ({ board: candidate?.source, url: candidate?.url })));
    if (!links.length && !Object.hasOwn(row, 'alternateListings')) return row;
    const copy = { ...row };
    if (links.length) copy.alternateListings = links;
    else delete copy.alternateListings;
    return copy;
  });
}

function classifiedLiveness(original, classified) {
  if (!classified || keyOf(original) !== keyOf(classified)) return original;
  const state = normalizeListingLiveness(classified.listingLiveness);
  if (!state) return original;
  const closed = normalizeBoardClosed(classified.boardClosed);
  if (state.verdict === 'closed') {
    if (!closed || closed.board !== state.board || closed.at !== state.at) return original;
  } else if (closed) return original;
  const row = { ...original, listingLiveness: state };
  if (closed) row.boardClosed = closed;
  else delete row.boardClosed;
  return row;
}

function restoredRow(winner, alternate, scoreSafe) {
  const alternateSafe = scoreSafe(alternate) === true;
  if (!alternateSafe && scoreSafe(winner) !== true) return null;
  const posting = normalizeOfficialPosting(winner?.officialPosting);
  const row = { ...alternate, officialPosting: winner?.officialPosting };
  row.postedBy = posting?.employer
    ? strictEmployerEqual(posting.employer, alternate?.company) ? undefined : alternate?.company
    : posting && ['L5', 'L6'].includes(posting.level)
      ? resolveScrapedEmployer(alternate).postedBy || undefined : undefined;
  if (!alternateSafe) {
    row.snippet = winner?.snippet;
    row.description = winner?.description;
    delete row.descriptionDeferredReason;
  }
  return scoreSafe(row) === true ? row : null;
}

/**
 * One optional second AI round classifies evidence-bearing candidates before
 * rank selection. `classifyPending` receives rows once and returns stamped
 * rows in the same order; only their normalized liveness pair is accepted.
 * `shouldTryWinner` applies the settlement table's rows 1 and 2 first.
 */
export async function restoreListingAlternates(rows, {
  alternatesByKey = new Map(), scoreSafe, shouldTryWinner, hasEvidence = () => false,
  classifyPending = null, signal = null,
} = {}) {
  const input = Array.isArray(rows) ? rows : [];
  if (!(alternatesByKey instanceof Map) || alternatesByKey.size === 0) return { rows: input, restored: [] };
  if (typeof scoreSafe !== 'function' || typeof shouldTryWinner !== 'function') {
    throw new TypeError('Alternate restoration requires scoreSafe and shouldTryWinner.');
  }
  active(signal);
  const eligible = [];
  for (const [index, winner] of input.entries()) {
    if (listingStateRank(winner) !== 4) continue;
    const alternates = alternatesByKey.get(keyOf(winner));
    if (!Array.isArray(alternates) || alternates.length === 0) continue;
    if (!(await shouldTryWinner(winner))) { active(signal); continue; }
    active(signal);
    const winnerSafe = scoreSafe(winner) === true;
    const candidates = alternates.slice(0, MAX_ALTERNATES).filter(row => listingStateRank(row) !== 4
      && (winnerSafe || scoreSafe(row) === true));
    if (candidates.length) eligible.push({ index, winner, candidates });
  }
  if (!eligible.length) return { rows: input, restored: [] };

  const pending = [];
  const pendingKeys = new Set();
  for (const { candidates } of eligible) for (const row of candidates) {
    const key = keyOf(row);
    if (!key || pendingKeys.has(key)
      || normalizeListingLiveness(row.listingLiveness)?.verdict !== 'pending'
      || !hasEvidence(row)) continue;
    pendingKeys.add(key);
    pending.push(row);
  }
  const classified = new Map();
  if (pending.length && typeof classifyPending === 'function') {
    try {
      active(signal);
      const results = await classifyPending(pending);
      active(signal);
      if (Array.isArray(results) && results.length === pending.length) {
        for (let index = 0; index < pending.length; index += 1) {
          classified.set(keyOf(pending[index]), classifiedLiveness(pending[index], results[index]));
        }
      }
    } catch {
      active(signal);
      // An AI failure leaves candidates pending; the official result survives.
    }
  }

  let next = input;
  const restored = [];
  for (const { index, winner, candidates } of eligible) {
    active(signal);
    const ranked = candidates.map((row, receiptOrder) => ({
      row: classified.get(keyOf(row)) || row, receiptOrder,
    })).filter(({ row }) => listingStateRank(row) !== 4)
      .sort((left, right) => listingStateRank(left.row) - listingStateRank(right.row)
        || left.receiptOrder - right.receiptOrder);
    for (const { row: alternate } of ranked) {
      const replacement = restoredRow(winner, alternate, scoreSafe);
      if (!replacement) continue;
      if (next === input) next = input.slice();
      next[index] = replacement;
      restored.push({ winner, alternate, row: replacement });
      break;
    }
  }
  return { rows: next, restored, classified };
}
