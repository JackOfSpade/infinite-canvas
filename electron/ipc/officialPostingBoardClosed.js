// Board-closed rows. An aggregator job board (LinkedIn, Indeed, ZipRecruiter ...)
// can report a listing gone while the employer's own posting is still live, so
// the board's verdict is evidence, not the final word: the most official source
// decides. A row carries a bounded `boardClosed` marker to the official-posting
// resolver and is dropped afterwards only when no official source keeps it.
//
// Pure helpers only: no Electron, no network, no store. The caller injects the
// scraped-evidence test and the stored-view reader so this stays unit-testable.
import { sourceJobKey } from '../../src/utils/jobIdentity.js';
import { isAggregatorHost } from './officialSourceHosts.js';
import { listingStateRank, normalizeBoardClosed, normalizeListingLiveness, normalizeOfficialPosting, officialResearchSettled } from './officialPostingFields.js';

const TEXT_LEVELS = new Set(['L1', 'L2', 'L3']);
const OFFICIAL_LINK_LEVELS = new Set(['L1', 'L2', 'L3', 'L4']);
const MAX_TELEMETRY_BOARDS = 24;
const COUNT_FIELDS = Object.freeze(['detected', 'keptOfficial', 'keptUnchecked', 'dropped']);
const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;

export const BOARD_CLOSED_DISPOSITIONS = Object.freeze({
  keptOfficial: 'kept-official',
  keptUnchecked: 'kept-unchecked',
  keptAmbiguous: 'kept-ambiguous',
  deferredUnchecked: 'deferred-unchecked',
  droppedNoDescription: 'dropped-no-description',
  droppedSettled: 'dropped-settled',
  droppedOfficialClosed: 'dropped-official-closed',
});

export function boardClosedOf(job) { return normalizeBoardClosed(job?.boardClosed); }
export function isBoardClosedRow(job) { return boardClosedOf(job) !== null; }

/** Returns a copy carrying the marker, or the row unchanged when the board/reason is not valid. */
export function withBoardClosed(job, { board, reason, now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const boardClosed = Number.isFinite(at.getTime()) ? normalizeBoardClosed({ board, reason, at: at.toISOString() }) : null;
  return boardClosed ? { ...job, boardClosed } : job;
}

/** The two liveness fields are replaced together so an old close cannot survive a fresh visit. */
export function withListingLiveness(job, { verdict, basis, board, now = new Date() } = {}) {
  if (verdict === 'closed') return job;
  const at = now instanceof Date ? now : new Date(now);
  const listingLiveness = Number.isFinite(at.getTime())
    ? normalizeListingLiveness({ verdict, basis, board, at: at.toISOString() }) : null;
  if (!listingLiveness) return job;
  const { boardClosed: _oldClosed, listingLiveness: _oldLiveness, ...rest } = job || {};
  return { ...rest, listingLiveness };
}

export function withListingClosed(job, { board, reason, basis = 'structural', now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) return job;
  const boardClosed = normalizeBoardClosed({ board, reason, at: at.toISOString() });
  const listingLiveness = normalizeListingLiveness({ verdict: 'closed', basis, board, at: at.toISOString() });
  if (!boardClosed || !listingLiveness || !['structural', 'ai'].includes(basis)) return job;
  const { boardClosed: _oldClosed, listingLiveness: _oldLiveness, ...rest } = job || {};
  return { ...rest, boardClosed, listingLiveness };
}

function hostnameOf(value) {
  try { return new URL(String(value ?? '')).hostname.toLowerCase().replace(/\.$/u, ''); } catch { return ''; }
}

/**
 * The final host owns the detail-page verdict. The expected URL is used only
 * when navigation did not reveal a final URL.
 */
export function boardClosedDetailAllowed({ expectedUrl = '', finalUrl = '' } = {}) {
  const host = hostnameOf(finalUrl) || hostnameOf(expectedUrl);
  return Boolean(host) && isAggregatorHost(host);
}

/**
 * First-wins dedup keeps the earlier row. Partition copies by the shared
 * liveness rank, preserving arrival order within each rank. A uniform list
 * returns the same array so callers can retain their identity fast path.
 */
export function preferOpenRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 2) return list;
  const ranks = list.map(listingStateRank);
  if (ranks.every(rank => rank === ranks[0])) return list;
  return [1, 2, 3, 4].flatMap(rank => list.filter((_, index) => ranks[index] === rank));
}

/** Pending-closed and confirmed-closed rows the evidence gate set aside still reach the resolver. */
export function boardClosedSetAside(evidence) {
  return (Array.isArray(evidence?.dropped) ? evidence.dropped : []).filter(job => listingStateRank(job) >= 3);
}

/**
 * Score-safe rows plus the set-aside board-closed rows, in the order dedup and the resolver need.
 * Open rows always come first, even when nothing was set aside: a described flagged row passes
 * the evidence gate on its own and must not precede an open copy of the same posting.
 */
export function scoreSafeRowsWithBoardClosed(evidence) {
  const jobs = Array.isArray(evidence?.jobs) ? evidence.jobs : [];
  const aside = boardClosedSetAside(evidence);
  return preferOpenRows(aside.length ? [...jobs, ...aside] : jobs);
}

const normalizedText = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
// Match the request-local evidence key without importing its IPC context into
// this pure settlement module. Some boards use the same bare native job id.
const setAsideIdentity = row => {
  const source = typeof row?.source === 'string' ? row.source : '';
  const identity = sourceJobKey(row);
  return source && identity ? `${source}|${identity}` : '';
};

async function officialTextIsEvidence(row, { getView, minChars }) {
  if (typeof getView !== 'function') return false;
  let view;
  try { view = await getView(row); } catch { return false; }
  const served = normalizeOfficialPosting(view?.officialPosting);
  if (!served || !TEXT_LEVELS.has(served.level) || (served.trail || []).includes('official-text-missing')) return false;
  const body = normalizedText(view.description);
  return body.length >= minChars && body !== normalizedText(row?.snippet || row?.description);
}

/**
 * Settle confirmed-closed rows and pending-closed rows. A row that has been
 * stamped open or unclear after its description-less set-aside also enters;
 * those observations do not make its blank text score-safe.
 *
 * `kept` preserves input order; `dispositions` maps each kept board-closed row
 * to why it was kept, `dropped` lists each removed row with why.
 */
export async function settleBoardClosedRows(rows, {
  scoreSafe, getView, minChars = 400, setAsideKeys = null, expiryCandidatesConfirmedClosed = null,
} = {}) {
  const kept = []; const dropped = []; const dispositions = new Map();
  const keep = (row, disposition) => { kept.push(row); dispositions.set(row, disposition); };
  for (const row of Array.isArray(rows) ? rows : []) {
    const rank = listingStateRank(row);
    const scrapedOk = typeof scoreSafe === 'function' && scoreSafe(row) === true;
    // The caller preserves the identity of a description-less set-aside row
    // across an AI restamp that can remove its closed marker and lower its rank.
    const wasSetAside = setAsideKeys instanceof Set && setAsideKeys.has(setAsideIdentity(row));
    if (rank < 3 && !wasSetAside) { kept.push(row); continue; }
    const posting = normalizeOfficialPosting(row.officialPosting);
    const live = Boolean(posting) && ['found', 'link-only'].includes(posting.outcome);
    if (live && TEXT_LEVELS.has(posting.level) && (scrapedOk || await officialTextIsEvidence(row, { getView, minChars }))) {
      keep(row, BOARD_CLOSED_DISPOSITIONS.keptOfficial); continue;
    }
    if (live && posting.level === 'L4' && scrapedOk) { keep(row, BOARD_CLOSED_DISPOSITIONS.keptOfficial); continue; }
    if (rank !== 4) {
      if (scrapedOk) kept.push(row);
      else dropped.push({ row, disposition: BOARD_CLOSED_DISPOSITIONS.deferredUnchecked });
      continue;
    }
    if (live && OFFICIAL_LINK_LEVELS.has(posting.level) && !scrapedOk) {
      dropped.push({ row, disposition: BOARD_CLOSED_DISPOSITIONS.droppedNoDescription }); continue;
    }
    if (posting?.outcome === 'ambiguous' || posting?.trail?.includes('comparative-disagree')) {
      if (scrapedOk) keep(row, BOARD_CLOSED_DISPOSITIONS.keptAmbiguous);
      else dropped.push({ row, disposition: BOARD_CLOSED_DISPOSITIONS.deferredUnchecked });
      continue;
    }
    const expiryUnconfirmed = posting?.trail?.includes('closed')
      && typeof expiryCandidatesConfirmedClosed === 'function'
      && expiryCandidatesConfirmedClosed(row) !== true;
    if (!expiryUnconfirmed && officialResearchSettled(posting) && ['not-found', 'closed'].includes(posting.outcome)) {
      dropped.push({ row, disposition: scrapedOk ? BOARD_CLOSED_DISPOSITIONS.droppedSettled : BOARD_CLOSED_DISPOSITIONS.droppedNoDescription });
      continue;
    }
    if (!scrapedOk) { dropped.push({ row, disposition: BOARD_CLOSED_DISPOSITIONS.deferredUnchecked }); continue; }
    keep(row, BOARD_CLOSED_DISPOSITIONS.keptUnchecked);
  }
  return { kept, dropped, dispositions };
}

// ── Counts only: per source board, never a title, URL or page text. ──────────
export function boardOf(job) { return boardClosedOf(job)?.board || normalizeListingLiveness(job?.listingLiveness)?.board || ''; }
function bump(block, board, field) {
  if (!BOARD_ID_RE.test(board) || !COUNT_FIELDS.includes(field)) return;
  if (!block[board] && Object.keys(block).length >= MAX_TELEMETRY_BOARDS) return;
  const entry = block[board] || (block[board] = { detected: 0, keptOfficial: 0, keptUnchecked: 0, dropped: 0 });
  entry[field] += 1;
}

/**
 * `input` are the rows that reached the resolver boundary, `settled` is the
 * settleBoardClosedRows result and `officialDedupDrops` the official dedup
 * receipts (a flagged duplicate of another row's official posting counts as
 * dropped for its board).
 */
export function boardClosedTelemetryBlock({ input = [], settled = null, officialDedupDrops = [] } = {}) {
  const block = {};
  for (const row of Array.isArray(input) ? input : []) if (isBoardClosedRow(row)) bump(block, boardOf(row), 'detected');
  for (const [row, disposition] of settled?.dispositions || []) {
    if (disposition === BOARD_CLOSED_DISPOSITIONS.keptOfficial) bump(block, boardOf(row), 'keptOfficial');
    else if (disposition === BOARD_CLOSED_DISPOSITIONS.keptUnchecked) bump(block, boardOf(row), 'keptUnchecked');
  }
  for (const entry of settled?.dropped || []) bump(block, boardOf(entry.row), 'dropped');
  for (const entry of Array.isArray(officialDedupDrops) ? officialDedupDrops : []) {
    if (isBoardClosedRow(entry?.dropped)) bump(block, boardOf(entry.dropped), 'dropped');
  }
  return block;
}

const count = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
/** Sums per-board counts, ignoring anything that is not a well-formed block. */
export function mergeBoardClosedTelemetry(...blocks) {
  const result = {};
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [board, entry] of Object.entries(block)) {
      if (!BOARD_ID_RE.test(board) || !entry || typeof entry !== 'object') continue;
      if (!result[board] && Object.keys(result).length >= MAX_TELEMETRY_BOARDS) continue;
      const target = result[board] || (result[board] = { detected: 0, keptOfficial: 0, keptUnchecked: 0, dropped: 0 });
      for (const field of COUNT_FIELDS) target[field] += count(entry[field]);
    }
  }
  return result;
}

/** Keys a renderer-held pending row set must retire or keep after a resolver pass. */
export function boardClosedRetirement(resolution) {
  const keptKeys = new Set((Array.isArray(resolution?.jobs) ? resolution.jobs : [])
    .map(sourceJobKey).filter(Boolean));
  const drops = Array.isArray(resolution?.boardClosedDrops) ? resolution.boardClosedDrops : [];
  const droppedKeys = drops.filter(entry => entry?.retire !== false).map(entry => sourceJobKey(entry?.dropped)).filter(Boolean);
  const deferredKeys = new Set(drops.filter(entry => entry?.retire === false).map(entry => sourceJobKey(entry?.dropped)).filter(Boolean));
  return { keptKeys, droppedKeys, deferredKeys };
}
