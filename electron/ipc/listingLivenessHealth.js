import { classifyListingLiveness } from './listingLiveness.js';
import { forgetListingEvidence } from './listingLivenessStore.js';
import { withListingLiveness } from './officialPostingBoardClosed.js';
import { normalizeBoardClosed, normalizeListingLiveness } from './officialPostingFields.js';
import { reportScrapeHealth, scrapeShareBroken } from './scrapeAlarms.js';

/**
 * Alarms when listing-page visits look like a broken reader or route instead of a few odd listings. Only the alarm is
 * raised here: no verdict is changed. A 404 or 410 still stamps a listing closed upstream, so a real burst of them
 * would have closed those rows before anyone investigated.
 *
 * Limits are provisional: per-visit rates are not saved anywhere. The saved canvas (2026-11-05) holds 305 listing
 * checks, 4 of 57 Dice rows closed within about 11 seconds, and no board near the limits below.
 */
export const LIVENESS_HEALTH_LIMITS = Object.freeze({ minAttempts: 10, minBad: 5, maxShare: 0.5 });
// A pass stops after three unknown pages in a row, so few different unreadable listings are ever seen. Five is more than a pass can show.
const UNREADABLE_LIMITS = Object.freeze({ minAttempts: 5, minBad: 5, maxShare: 0.5 });
// One recheck pass stops after three consecutive unknown pages, so reads from several passes are judged together.
export const LIVENESS_HEALTH_WINDOW = 20;
const MAX_BOARDS = 24;
const SURFACE = 'listing checks';

/** Known blocks and per-visit limits: the site or the app said no, so the page was not read. */
const WALL_REASONS = new Set(['login-wall', 'rate-limit', 'challenge', 'http-wall', 'appcast', 'profile-reserved',
  'lock-timeout', 'visit-timeout']);
/** Not a read of the board's own page at all. */
const NOT_A_READ_REASONS = new Set(['unobservable', 'other-host-not-found']);

/** 'wall' | 'closed-not-found' | 'unreadable' | 'healthy' | null (not a read of the board). Pure and never throws. */
export function classifyListingVisit(evidence) {
  try {
    if (!evidence || typeof evidence !== 'object') return null;
    if (evidence.unknown !== undefined) {
      const reason = String(evidence.unknown);
      if (WALL_REASONS.has(reason)) return 'wall';
      return NOT_A_READ_REASONS.has(reason) ? null : 'unreadable';
    }
    const verdict = classifyListingLiveness(evidence);
    if (verdict.basis === 'wall') return 'wall';
    if (verdict.basis === 'thin') return 'unreadable';
    if (verdict.verdict === 'closed' && [404, 410].includes(Number(evidence.httpStatus))) return 'closed-not-found';
    return 'healthy';
  } catch { return null; }
}

/** Counts for one board. `walls` are visited but are neither bad nor healthy reads. */
export function tallyListingVisits(outcomes) {
  const counts = { visited: 0, closedNotFound: 0, unreadable: 0, walls: 0, healthy: 0 };
  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    if (outcome === 'wall') counts.walls += 1;
    else if (outcome === 'closed-not-found') counts.closedNotFound += 1;
    else if (outcome === 'unreadable') counts.unreadable += 1;
    else if (outcome === 'healthy') counts.healthy += 1;
    else continue;
    counts.visited += 1;
  }
  return counts;
}

/**
 * Pure. Returns the reports to send for one board: a failure, or `failure: null` to clear. Nothing when the board had too
 * few real reads, so an existing alarm is left in place.
 */
export function assessListingLivenessHealth(board, counts) {
  const closed = Number(counts?.closedNotFound) || 0;
  const unreadable = Number(counts?.unreadable) || 0;
  const reads = closed + unreadable + (Number(counts?.healthy) || 0);
  if (!board) return [];
  const check = (suffix, bad, limits, what) => {
    const broken = scrapeShareBroken({ attempts: reads, bad, ...limits });
    // Clearing takes a full sample of clean reads, not just a sample too small to fire.
    if (!broken && reads - bad < LIVENESS_HEALTH_LIMITS.minAttempts) return [];
    return [{ key: `liveness:${board}:${suffix}`, surface: SURFACE, site: board, failure: broken ? { what, attempts: reads, bad } : null }];
  };
  return [
    ...check('closed-burst', closed, LIVENESS_HEALTH_LIMITS, 'Most recent listing visits returned 404 or 410, and such listings are marked closed'),
    ...check('unreadable', unreadable, UNREADABLE_LIMITS, 'Most recent listing visits returned pages that could not be read (empty, thin or failed)'),
  ];
}

const recent = new Map();

/**
 * `visits` is [{ board, outcome, listing }] from one finished batch. Never throws. A page that stays unread is visited
 * again by every later pass, so a listing counts once, by its latest read: a few dead links can't fill the window alone.
 */
export function recordListingLivenessBatch(visits) {
  try {
    const batch = new Map();
    for (const { board, outcome, listing } of Array.isArray(visits) ? visits : []) {
      if (typeof board !== 'string' || !board || !outcome) continue;
      if (!batch.has(board)) batch.set(board, []);
      batch.get(board).push({ outcome, listing: listing || Symbol('unnamed') });
    }
    for (const [board, outcomes] of batch) {
      if (!recent.has(board) && recent.size >= MAX_BOARDS) continue;
      const latest = new Map((recent.get(board) || []).map(read => [read.listing, read]));
      for (const read of outcomes) {
        if (read.outcome === 'wall') continue;
        latest.delete(read.listing);
        latest.set(read.listing, read);
      }
      const window = [...latest.values()].slice(-LIVENESS_HEALTH_WINDOW);
      recent.set(board, window);
      const walls = outcomes.filter(read => read.outcome === 'wall').length;
      const counts = { ...tallyListingVisits(window.map(read => read.outcome)), walls };
      counts.visited += walls;
      for (const report of assessListingLivenessHealth(board, counts)) reportScrapeHealth(report);
    }
  } catch { /* Alarm bookkeeping must not disturb the check that called it. */ }
}

export function resetListingLivenessHealthForTests() { recent.clear(); }

const NOT_FOUND_HELD = 'Most listing pages on this board returned 404 or 410 at once, so they were kept pending instead of closed until a later check agrees';

/** Whether one board's reads look like a broken route rather than closed jobs. Same limits as the alarm. */
export function notFoundBurst(reads, notFound) {
  return scrapeShareBroken({ attempts: reads, bad: notFound, ...LIVENESS_HEALTH_LIMITS });
}

/**
 * A 404 closes a listing with no second signal, so a broken URL, route or proxy would close real jobs. When most of a
 * board's freshly read listings closed that way in one batch, those closes are undone: the rows go back to pending with
 * no captured page, so nothing judges them from the 404, and a later recheck decides. Rows on other boards, and closes
 * for any other reason, are untouched. Never throws: on any fault the rows come back unchanged.
 */
export function holdNotFoundBursts(rows, { now = new Date(), report = reportScrapeHealth, forget = forgetListingEvidence } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  try {
    const byBoard = new Map();
    for (const row of input) {
      const board = normalizeListingLiveness(row?.listingLiveness)?.board;
      if (!board) continue;
      const entry = byBoard.get(board) || { reads: 0, notFound: 0 };
      entry.reads += 1;
      if (closedByNotFound(row)) entry.notFound += 1;
      byBoard.set(board, entry);
    }
    const held = new Set([...byBoard].filter(([, entry]) => notFoundBurst(entry.reads, entry.notFound)).map(([board]) => board));
    if (!held.size) return { rows: input, held: {} };
    const counts = {};
    const output = input.map(row => {
      const board = normalizeListingLiveness(row?.listingLiveness)?.board;
      if (!held.has(board) || !closedByNotFound(row)) return row;
      forget(row);
      counts[board] = (counts[board] || 0) + 1;
      return withListingLiveness(row, { verdict: 'pending', basis: 'neither', board, now });
    });
    for (const board of held) {
      try { report({ key: `liveness:${board}:closed-burst`, surface: SURFACE, site: board, failure: { what: NOT_FOUND_HELD, attempts: byBoard.get(board).reads, bad: counts[board] } }); } catch { /* the hold stands */ }
    }
    return { rows: output, held: counts };
  } catch { return { rows: input, held: {} }; }
}

function closedByNotFound(row) {
  const state = normalizeListingLiveness(row?.listingLiveness);
  return state?.verdict === 'closed' && state.basis === 'structural' && normalizeBoardClosed(row?.boardClosed)?.reason === 'http-not-found';
}
