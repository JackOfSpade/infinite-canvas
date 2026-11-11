/**
 * Per-page "should we keep paging?" decision for every browser job walker
 * (manualScraper's per-query loop, indeedBrowser, browserPool's paginated
 * scrape). One implementation so the three loops cannot drift.
 *
 * Why this exists: the hub's page count is now "All" by default, so a walker no
 * longer stops because it counted to 10 — it stops because the DATA says there
 * is nothing worth fetching on the next page. Four terminal conditions:
 *
 *   empty-page   A page extracted zero rows. Terminal and lossless — no results
 *                exist past an empty offset.
 *   age-window   The page is decisively OUTSIDE the hub's automatic date window.
 *   no-new-jobs  The pager has stopped advancing (every row already seen).
 *   pager-trickle  Full pages keep re-serving old results while adding a token
 *                new row, so the walk would otherwise page to the backstop.
 *
 * On the age rule and why it is NOT the date-cutoff heuristic that was removed
 * from jobs.js: boards serve RELEVANCE-sorted results, so posted dates are not
 * monotonic down the walk and "the first out-of-window row ends the source" does
 * prune real jobs. This rule fires only when a page carries enough dated
 * evidence to be conclusive (>= MIN_DATED_EVIDENCE rows with a parseable date,
 * and at least half the page dated) AND not one row on it is in-window — TWICE
 * in a row. A relevance reshuffle does not produce two consecutive
 * entirely-out-of-window pages; a walk that has paged past the window does.
 * Unparseable dates never count as evidence, so a source that exposes no posted
 * date on its cards can never trip this rule (it stops on empty-page instead).
 *
 * no-new-jobs and pager-trickle are gated on unlimited walks on purpose. A clamped pager (page
 * param silently ignored → page 1 re-served forever) is only a hang risk when
 * there is no user-set ceiling, and a duplicate-page heuristic can false-positive
 * under relevance sort; with an explicit ceiling the old lossless behaviour
 * (walk it out, let the cross-source dedup absorb repeats) still applies.
 */
import { parsePostedDate, postedDateMeetsAgeCutoff } from './jobDateFilter.js';
import { sourceJobKey } from '../../src/utils/jobIdentity.js';

/** Consecutive conclusive pages required before a heuristic rule stops a walk. */
export const STOP_STREAK = 2;
/** Dated rows a page needs before "no in-window rows" counts as evidence. */
export const MIN_DATED_EVIDENCE = 3;
/**
 * Pager-trickle rule: TRICKLE_PAGES consecutive full pages (>= TRICKLE_MIN_ROWS
 * rows) that each add at most TRICKLE_MAX_NEW fresh rows mean the pager is
 * re-serving old results and the walk is not advancing.
 */
export const TRICKLE_PAGES = 3;
export const TRICKLE_MAX_NEW = 1;
export const TRICKLE_MIN_ROWS = 5;

/**
 * @param {object}   opts
 * @param {number?}  opts.maxAgeDays  broad provider date horizon; null disables the age rule
 * @param {boolean}  opts.unlimited   true when the hub page count is "All"
 * @param {string}   opts.sourceLabel for the stop reason's log line
 * @param {function} opts.now         injectable clock (tests)
 * @returns {function(({items:any[],pageIndex:number})): {stop:boolean, reason?:string, detail?:string}}
 *          The returned function carries a `.stats` object for diagnostics.
 *          pager-trickle also returns a shared `guard` record
 *          ({kind, page, pages, newRows, detail}); walkers add source/query.
 */
export function makeJobPageStop({ maxAgeDays = null, unlimited = false, sourceLabel = '', now = () => new Date() } = {}) {
  const days = Number(maxAgeDays) > 0 ? Math.floor(Number(maxAgeDays)) : null;
  const seenKeys = new Set();
  let outOfWindowStreak = 0;
  let staleStreak = 0;
  let trickleStreak = 0;
  let trickleFreshRows = 0;

  const stats = {
    pagesEvaluated: 0,
    rowsSeen: 0,
    rowsInWindow: 0,
    rowsDated: 0,
    outOfWindowPages: 0,
    stalePages: 0,
    tricklePages: 0,
    stopReason: null,
  };

  const decide = ({ items, pageIndex = 0 } = {}) => {
    const rows = Array.isArray(items) ? items : [];
    stats.pagesEvaluated++;
    stats.rowsSeen += rows.length;

    if (rows.length === 0) {
      stats.stopReason = 'empty-page';
      return { stop: true, reason: 'empty-page', detail: `${sourceLabel || 'source'} page ${pageIndex + 1} extracted 0 jobs` };
    }

    // ── age-window ────────────────────────────────────────────────────────────
    if (days != null) {
      const clock = now();
      const cutoff = clock.getTime() - days * 86400000;
      let dated = 0;
      let inWindow = 0;
      for (const row of rows) {
        const posted = parsePostedDate(row?.posted, clock);
        if (!posted) continue;          // unparseable → not evidence either way
        dated++;
        if (postedDateMeetsAgeCutoff(posted, cutoff)) inWindow++;
      }
      stats.rowsDated += dated;
      stats.rowsInWindow += inWindow;
      const conclusive = dated >= MIN_DATED_EVIDENCE && dated * 2 >= rows.length;
      if (conclusive && inWindow === 0) {
        outOfWindowStreak++;
        stats.outOfWindowPages++;
        if (outOfWindowStreak >= STOP_STREAK) {
          stats.stopReason = 'age-window';
          return {
            stop: true,
            reason: 'age-window',
            detail: `${sourceLabel || 'source'} page ${pageIndex + 1}: ${STOP_STREAK} consecutive pages with no listing inside the ${days}-day provider date horizon (${dated}/${rows.length} rows dated)`,
          };
        }
      } else {
        outOfWindowStreak = 0;
      }
    }

    // ── no-new-jobs / pager-trickle (unlimited walks only) ───────────────────
    if (unlimited) {
      let fresh = 0;
      for (const row of rows) {
        const key = sourceJobKey(row);
        if (!key) { fresh++; continue; }   // keyless row → can't call it a repeat
        if (!seenKeys.has(key)) { fresh++; seenKeys.add(key); }
      }
      if (fresh === 0) {
        staleStreak++;
        stats.stalePages++;
        if (staleStreak >= STOP_STREAK) {
          stats.stopReason = 'no-new-jobs';
          return {
            stop: true,
            reason: 'no-new-jobs',
            detail: `${sourceLabel || 'source'} page ${pageIndex + 1}: ${STOP_STREAK} consecutive pages returned only jobs already gathered — the pager is not advancing`,
          };
        }
      } else {
        staleStreak = 0;
      }

      // A full page that adds almost nothing new means the pager is re-serving
      // old results; a walk down such a pager never honestly reaches the
      // backstop. no-new-jobs above keeps precedence (it is evaluated first),
      // and a fresh===0 page counts toward both streaks.
      if (rows.length >= TRICKLE_MIN_ROWS && fresh <= TRICKLE_MAX_NEW) {
        trickleStreak++;
        trickleFreshRows += fresh;
        stats.tricklePages++;
        if (trickleStreak >= TRICKLE_PAGES) {
          const detail = `${sourceLabel || 'source'} page ${pageIndex + 1}: ${TRICKLE_PAGES} consecutive pages each added at most ${TRICKLE_MAX_NEW} new job (${trickleFreshRows} in all) — the pager is re-serving old results`;
          stats.stopReason = 'pager-trickle';
          return {
            stop: true,
            reason: 'pager-trickle',
            detail,
            guard: { kind: 'pager-trickle', page: pageIndex + 1, pages: TRICKLE_PAGES, newRows: trickleFreshRows, detail },
          };
        }
      } else {
        trickleStreak = 0;
        trickleFreshRows = 0;
      }
    }

    return { stop: false };
  };

  decide.stats = stats;
  return decide;
}
