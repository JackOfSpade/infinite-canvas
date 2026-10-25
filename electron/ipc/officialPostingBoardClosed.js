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
import { normalizeBoardClosed, normalizeOfficialPosting, officialResearchSettled } from './officialPostingFields.js';

const TEXT_LEVELS = new Set(['L1', 'L2', 'L3']);
const OFFICIAL_LINK_LEVELS = new Set(['L1', 'L2', 'L3', 'L4']);
const MAX_TELEMETRY_BOARDS = 24;
const COUNT_FIELDS = Object.freeze(['detected', 'keptOfficial', 'keptUnchecked', 'dropped']);
const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;

export const BOARD_CLOSED_DISPOSITIONS = Object.freeze({
  keptOfficial: 'kept-official',
  keptUnchecked: 'kept-unchecked',
  droppedNoDescription: 'dropped-no-description',
  droppedSettled: 'dropped-settled',
});

export function boardClosedOf(job) { return normalizeBoardClosed(job?.boardClosed); }
export function isBoardClosedRow(job) { return boardClosedOf(job) !== null; }

/** Returns a copy carrying the marker, or the row unchanged when the board/reason is not valid. */
export function withBoardClosed(job, { board, reason, now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const boardClosed = Number.isFinite(at.getTime()) ? normalizeBoardClosed({ board, reason, at: at.toISOString() }) : null;
  return boardClosed ? { ...job, boardClosed } : job;
}

function hostnameOf(value) {
  try { return new URL(String(value ?? '')).hostname.toLowerCase().replace(/\.$/u, ''); } catch { return ''; }
}

/**
 * A detail page may only mark a row board-closed when EVERY URL involved is an
 * aggregator host. If the page we reached (or the page we meant to reach) is the
 * employer's or an ATS host, that source is the official one and its "gone"
 * verdict is final: the row is dropped exactly as before.
 */
export function boardClosedDetailAllowed({ expectedUrl = '', finalUrl = '' } = {}) {
  const hosts = [expectedUrl, finalUrl].map(hostnameOf).filter(Boolean);
  return hosts.length > 0 && hosts.every(host => isAggregatorHost(host));
}

/**
 * First-wins dedup keeps the earlier row, so a closed copy must never beat an
 * open copy of the same posting. Returns the SAME array when nothing is flagged.
 */
export function preferOpenRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.some(isBoardClosedRow)) return list;
  return [...list.filter(job => !isBoardClosedRow(job)), ...list.filter(isBoardClosedRow)];
}

/** Board-closed rows the evidence gate dropped: they still go to the resolver. */
export function boardClosedSetAside(evidence) {
  return (Array.isArray(evidence?.dropped) ? evidence.dropped : []).filter(isBoardClosedRow);
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
 * Keep or drop every board-closed row after the resolver ran. Rows without the
 * marker pass through untouched.
 *
 *  1. A live official posting (L1-L3) with evidence (the scraped description, or
 *     the stored official text: official text counts) : KEEP, official.
 *  2. Otherwise no score-safe scraped description: DROP, exactly as before.
 *  3. A live official link (L4) beside a scraped description: KEEP, official.
 *  4. Otherwise (the board still gave us a description): DROP only after a
 *     settled research conclusion; if research did not run, KEEP, unchecked.
 *
 * `kept` preserves input order; `dispositions` maps each kept board-closed row
 * to why it was kept, `dropped` lists each removed row with why.
 */
export async function settleBoardClosedRows(rows, { scoreSafe, getView, minChars = 400 } = {}) {
  const kept = []; const dropped = []; const dispositions = new Map();
  const keep = (row, disposition) => { kept.push(row); dispositions.set(row, disposition); };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isBoardClosedRow(row)) { kept.push(row); continue; }
    const posting = normalizeOfficialPosting(row.officialPosting);
    const scrapedOk = typeof scoreSafe === 'function' && scoreSafe(row) === true;
    const live = Boolean(posting) && ['found', 'link-only'].includes(posting.outcome);
    if (live && TEXT_LEVELS.has(posting.level) && (scrapedOk || await officialTextIsEvidence(row, { getView, minChars }))) {
      keep(row, BOARD_CLOSED_DISPOSITIONS.keptOfficial); continue;
    }
    if (!scrapedOk) { dropped.push({ row, disposition: BOARD_CLOSED_DISPOSITIONS.droppedNoDescription }); continue; }
    if (live && OFFICIAL_LINK_LEVELS.has(posting.level)) { keep(row, BOARD_CLOSED_DISPOSITIONS.keptOfficial); continue; }
    if (officialResearchSettled(posting)) { dropped.push({ row, disposition: BOARD_CLOSED_DISPOSITIONS.droppedSettled }); continue; }
    keep(row, BOARD_CLOSED_DISPOSITIONS.keptUnchecked);
  }
  return { kept, dropped, dispositions };
}

// ── Counts only: per source board, never a title, URL or page text. ──────────
function boardOf(job) { return boardClosedOf(job)?.board || ''; }
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
    bump(block, boardOf(row), disposition === BOARD_CLOSED_DISPOSITIONS.keptOfficial ? 'keptOfficial' : 'keptUnchecked');
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
    .filter(isBoardClosedRow).map(sourceJobKey).filter(Boolean));
  const droppedKeys = (Array.isArray(resolution?.boardClosedDrops) ? resolution.boardClosedDrops : [])
    .map(entry => sourceJobKey(entry?.dropped)).filter(Boolean);
  return { keptKeys, droppedKeys };
}
