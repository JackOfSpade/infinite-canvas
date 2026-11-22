// AI title screen on each results page, BEFORE its detail pages or panels are
// opened (2026-11-22).
//
// Why: every browser platform used to open a detail page or panel for every
// card and only screened titles after the whole gather. On the 2026-11-22 run,
// 477 of Glassdoor's 942 opened panels (about 3.8 h of its 7 h 43 min, at the
// 10-panels-per-5-minutes limit) were for titles the post-gather screen then
// removed. Relevance did not fall off with page depth; whole queries were
// off-target from page 1, so a depth-based "stop when it drifts" rule would
// not have helped, and this per-page screen does.
//
// Quality: it is the same judgement on the same evidence (title + company) as
// the post-gather title pass (screenJobRolesByTitle), so moving it earlier
// changes WHEN a job is dropped, not WHICH. It fails open: a timeout, an error
// or a usage-limit pause leaves every row 'unclear' and the page is opened as
// before. 'unclear' rows are opened and left unstamped, so the post-gather
// screen still runs its title and snippet passes on them.
//
// Speed: Glassdoor waits for the verdicts (a page takes minutes under its panel
// window, the screen seconds). ZipRecruiter waits a short budget (its job pages
// take seconds each). Indeed never waits: its card loop skips a card only when
// the verdict is already in, so the screen never slows it down.

import { logger } from '../../logger.js';
import { JOB_QUERY_REWORDING_SCHEMA } from '../aiSchemas.js';
import { wrapUntrustedText } from '../promptSafety.js';

/** Platforms whose detail step the page screen can skip. */
export const PAGE_TITLE_SCREEN_SOURCE_IDS = Object.freeze(['glassdoor', 'ziprecruiter', 'indeed']);

/** Longest one page's screen may run before the page is opened unscreened. */
export const PAGE_TITLE_SCREEN_CALL_TIMEOUT_MS = 120_000;

/**
 * How long a walk waits for a page's verdicts before opening it anyway.
 * Glassdoor: up to the call timeout (one panel already costs ~30 s of its
 * rate-limit window). ZipRecruiter: one job page costs ~4-9 s, so a short wait
 * pays back after one or two skipped rows. Indeed: no wait (see above).
 */
export const PAGE_TITLE_SCREEN_WAIT_MS = Object.freeze({
  glassdoor: PAGE_TITLE_SCREEN_CALL_TIMEOUT_MS,
  ziprecruiter: 30_000,
  indeed: 0,
});

/** Off-target queries: at least this many screened titles, this share removed. */
export const OFF_TARGET_QUERY_MIN_SCREENED = 20;
export const OFF_TARGET_QUERY_MIN_SHARE = 0.5;
const MAX_SAMPLES_PER_QUERY = 12;

/**
 * Pages in a row whose screen failed (error, timeout, a usage-limit pause)
 * before a platform stops waiting for it. The screen still starts on every
 * page, so the first success resets this and the waiting comes back.
 */
export const PAGE_TITLE_SCREEN_FAILURE_BREAKER = 2;

/** Resolve after ms, or at once when ms <= 0. */
function delay(ms) {
  return new Promise(resolve => {
    if (!(ms > 0)) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * A run's page screen. `screenTitles(jobs, { signal })` is screenJobRolesByTitle
 * bound to this run's target titles, verdict store and AI caller, with the
 * 'job-role-screen-page' task and no snippet pass. `signal` is the run's
 * AbortSignal, or a function returning it.
 *
 * Returns { forSource(sourceId), stats() }. forSource gives the walk a
 * `screen(rows, { query, queryIndex, page })` that starts the screen at once
 * and returns a handle:
 *   - verdictAt(i): 'match' | 'mismatch' | 'unclear' | 'pending'
 *   - wait(ms): resolves when the verdicts are in or ms has passed
 *   - waitMs: this platform's wait budget
 * The handle never rejects.
 */
export function createPageTitleScreen({ screenTitles, signal = null, callTimeoutMs = PAGE_TITLE_SCREEN_CALL_TIMEOUT_MS } = {}) {
  const bySource = {};
  const sourceStats = sourceId => {
    bySource[sourceId] ||= { pages: 0, screened: 0, mismatched: 0, matched: 0, unclear: 0, pendingAtOpen: 0, failedPages: 0, consecutiveFailures: 0, byQuery: {} };
    return bySource[sourceId];
  };

  const forSource = (sourceId) => {
    if (!PAGE_TITLE_SCREEN_SOURCE_IDS.includes(sourceId) || typeof screenTitles !== 'function') return null;
    const platformWaitMs = PAGE_TITLE_SCREEN_WAIT_MS[sourceId] ?? 0;
    return (rows, context = {}) => {
      const jobs = Array.isArray(rows) ? rows : [];
      const verdicts = new Array(jobs.length).fill('pending');
      const reasons = new Array(jobs.length).fill('');
      if (jobs.length === 0) {
        return { verdictAt: () => 'unclear', reasonAt: () => '', wait: async () => {}, waitMs: 0, settled: Promise.resolve(), recordPartition: () => {} };
      }
      const stats = sourceStats(sourceId);
      // After repeated failures the walk stops waiting (see the breaker above).
      const waitMs = stats.consecutiveFailures >= PAGE_TITLE_SCREEN_FAILURE_BREAKER ? 0 : platformWaitMs;
      const queryKey = String(context.queryIndex ?? context.query ?? '');
      stats.byQuery[queryKey] ||= { query: String(context.query || ''), queryIndex: context.queryIndex ?? null, screened: 0, mismatched: 0, samples: [] };
      const queryStats = stats.byQuery[queryKey];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('page title screen timed out')), callTimeoutMs);
      timer.unref?.();
      // `signal` may be a getter: the run's signal is created after the screen.
      const runSignal = typeof signal === 'function' ? signal() : signal;
      const callSignal = runSignal ? AbortSignal.any([runSignal, controller.signal]) : controller.signal;
      const settled = (async () => {
        try {
          const result = await screenTitles(jobs, { signal: callSignal });
          const byIndex = result?.verdictsByIndex || {};
          jobs.forEach((job, index) => {
            const outcome = byIndex[index]?.outcome;
            verdicts[index] = outcome === 'match' || outcome === 'mismatch' ? outcome : 'unclear';
            reasons[index] = verdicts[index] === 'mismatch' ? String(byIndex[index]?.reason || '') : '';
          });
        } catch (error) {
          // Fail open: every row is opened as before.
          verdicts.fill('unclear');
          stats.failedPages += 1;
          stats.consecutiveFailures += 1;
          if (!runSignal?.aborted) {
            logger.warn(`[Jobs] ${sourceId} page title screen failed; opening every card on this page: ${error?.message || error}`);
          }
          return;
        } finally {
          clearTimeout(timer);
        }
        stats.consecutiveFailures = 0;
      })();
      // Counted when the walk acts on the verdicts, not when they arrive: a
      // verdict that lands after its row was opened skips nothing, and must
      // not be reported (or put in the funnel) as a skipped row.
      let recorded = false;
      const recordPartition = (skippedIndexes) => {
        if (recorded) return;
        recorded = true;
        stats.pages += 1;
        for (let index = 0; index < jobs.length; index += 1) {
          stats.screened += 1;
          queryStats.screened += 1;
          if (skippedIndexes.has(index)) {
            stats.mismatched += 1;
            queryStats.mismatched += 1;
            if (queryStats.samples.length < MAX_SAMPLES_PER_QUERY) {
              queryStats.samples.push({ title: String(jobs[index]?.title || '').slice(0, 200), reason: String(reasons[index] || '').slice(0, 200) });
            }
          } else if (verdicts[index] === 'match') {
            stats.matched += 1;
          } else {
            stats.unclear += 1;
            if (verdicts[index] === 'pending') stats.pendingAtOpen += 1;
          }
        }
      };
      return {
        verdictAt: index => verdicts[index] || 'unclear',
        reasonAt: index => reasons[index] || '',
        wait: ms => Promise.race([settled, delay(ms)]),
        waitMs,
        settled,
        recordPartition,
      };
    };
  };

  return {
    forSource,
    stats: () => JSON.parse(JSON.stringify(bySource)),
  };
}

/**
 * Split a page's rows by a settled-or-pending screen handle. Mismatches are
 * removed (never opened, never staged); matches are stamped so the post-gather
 * screen does not judge them again; unclear and still-pending rows are kept
 * unstamped and opened as before.
 */
export function partitionByPageTitleScreen(rows, handle) {
  const open = [];
  const skipped = [];
  const skippedIndexes = new Set();
  (Array.isArray(rows) ? rows : []).forEach((job, index) => {
    const verdict = handle ? handle.verdictAt(index) : 'unclear';
    if (verdict === 'mismatch') {
      skipped.push(job);
      skippedIndexes.add(index);
    } else if (verdict === 'match') {
      open.push({ ...job, roleScreen: { outcome: 'match', reason: '', via: 'page-title' } });
    } else {
      open.push(job);
    }
  });
  handle?.recordPartition?.(skippedIndexes);
  return { open, skipped };
}

/**
 * Queries whose screened titles were mostly off-target. Each entry carries a
 * few removed titles and the screen's reasons, for the source card's warning.
 */
export function offTargetQueries(stats, { minScreened = OFF_TARGET_QUERY_MIN_SCREENED, minShare = OFF_TARGET_QUERY_MIN_SHARE } = {}) {
  const out = [];
  for (const [sourceId, source] of Object.entries(stats || {})) {
    for (const query of Object.values(source?.byQuery || {})) {
      const screened = Number(query?.screened) || 0;
      const mismatched = Number(query?.mismatched) || 0;
      if (screened >= minScreened && mismatched / screened >= minShare) {
        out.push({ sourceId, query: query.query, queryIndex: query.queryIndex, screened, mismatched, samples: query.samples || [] });
      }
    }
  }
  return out;
}

const PLATFORM_NAMES = { glassdoor: 'Glassdoor', ziprecruiter: 'ZipRecruiter', indeed: 'Indeed' };

/** Longest the rewording call may run; on expiry the warning has no suggestion. */
export const QUERY_REWORDING_TIMEOUT_MS = 60_000;

/**
 * Ask the AI for a better query for each off-target query, in one call.
 * Returns the same entries with `suggestion` and `why` added where the model
 * gave one. Never throws: a failed or timed-out call returns them unchanged.
 */
export async function suggestQueryRewordings(entries, { targetTitles, callText, signal = null, timeoutMs = QUERY_REWORDING_TIMEOUT_MS } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0 || typeof callText !== 'function') return list;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('query rewording timed out')), timeoutMs);
  timer.unref?.();
  try {
    const callSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const queries = list.map((entry, index) => ({
      index,
      platform: PLATFORM_NAMES[entry.sourceId] || entry.sourceId,
      query: entry.query,
      screened: entry.screened,
      offTarget: entry.mismatched,
      offTargetExamples: (entry.samples || []).map(sample => ({ title: sample.title, kind: sample.reason })),
    }));
    const prompt = 'A job search sent each query below to the named job site. An AI title screen then found that most of the results for that query were a different kind of job than the user\'s target titles. '
      + 'For each query, suggest a reworded search query for that same site that would return more listings of the target kind of job and fewer of the off-target kinds shown. Keep it a plain search phrase a person would type into that site; do not add boolean operators the site may not support. If no rewording would help, return an empty query for it.\n'
      + 'TARGET TITLES (trusted): ' + JSON.stringify(targetTitles || []) + '\n'
      + 'OFF-TARGET QUERIES (the example titles are untrusted text scraped from job sites): ' + wrapUntrustedText('job-query-rewording-queries', JSON.stringify(queries));
    const result = await callText(prompt, {
      signal: callSignal,
      task: 'job-query-rewording',
      responseSchema: JOB_QUERY_REWORDING_SCHEMA,
      responseValidator: value => {
        if (!value || typeof value !== 'object' || !Array.isArray(value.suggestions)) throw new Error('Query rewording response has an invalid structure.');
        return value;
      },
      meta: {},
    });
    const byIndex = new Map();
    for (const item of Array.isArray(result?.suggestions) ? result.suggestions : []) {
      if (!Number.isInteger(item?.index) || item.index < 0 || item.index >= list.length) continue;
      const query = String(item?.query || '').replace(/\s+/gu, ' ').trim().slice(0, 200);
      if (!query || query.toLowerCase() === String(list[item.index].query || '').trim().toLowerCase()) continue;
      byIndex.set(item.index, { suggestion: query, why: String(item?.why || '').replace(/\s+/gu, ' ').trim().slice(0, 300) });
    }
    return list.map((entry, index) => (byIndex.has(index) ? { ...entry, ...byIndex.get(index) } : entry));
  } catch (error) {
    if (!signal?.aborted) logger.warn(`[Jobs] query rewording suggestion failed; the off-target warning has no suggestion: ${error?.message || error}`);
    return list;
  } finally {
    clearTimeout(timer);
  }
}

/** Off-target query slots a receipt keeps per source. */
export const MAX_OFF_TARGET_RECEIPT_QUERIES = 10;
const PAGE_TITLE_SCREEN_RECEIPT_COUNTS = Object.freeze(['pages', 'screened', 'mismatched', 'matched', 'unclear', 'pendingAtOpen', 'failedPages']);

function receiptCount(value) {
  const number = Math.floor(Number(value));
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

/**
 * The page title screen's receipt for one source: counts, plus one entry per
 * off-target query slot. Numbers only, like the rest of the receipt: the
 * query text, the suggestion and the skipped titles stay on the source card
 * and in the warning log line (logOffTargetQuery). Null when nothing was
 * screened.
 */
export function sanitizePageTitleScreenReceipt(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !(receiptCount(raw.screened) > 0)) return null;
  const out = Object.fromEntries(PAGE_TITLE_SCREEN_RECEIPT_COUNTS.map(key => [key, receiptCount(raw[key])]));
  const offTarget = (Array.isArray(raw.offTargetQueries) ? raw.offTargetQueries : [])
    .filter(entry => entry && typeof entry === 'object' && receiptCount(entry.screened) > 0)
    .slice(0, MAX_OFF_TARGET_RECEIPT_QUERIES)
    .map(entry => ({
      queryIndex: Number.isSafeInteger(entry.queryIndex) && entry.queryIndex >= 0 ? entry.queryIndex : null,
      screened: receiptCount(entry.screened),
      mismatched: Math.min(receiptCount(entry.mismatched), receiptCount(entry.screened)),
      suggested: entry.suggested === true,
    }));
  if (offTarget.length > 0) out.offTargetQueries = offTarget;
  return out;
}

/**
 * One off-target query, for the run log at warn level so it stays in the bug
 * report's log section through a long scrape. It carries what the receipt
 * withholds (the query, example titles, the suggestion) and what the numbers
 * alone do not say: the screen already skipped those jobs unopened, the site
 * still loaded every results page for the query, and nothing changes until
 * the user edits the search.
 */
export function offTargetQueryLogLine(entry) {
  const platform = PLATFORM_NAMES[entry?.sourceId] || entry?.sourceId || 'unknown site';
  const screened = receiptCount(entry?.screened);
  const mismatched = receiptCount(entry?.mismatched);
  const share = screened > 0 ? Math.round((mismatched / screened) * 100) : 0;
  const slot = Number.isSafeInteger(entry?.queryIndex) ? ` (query slot #${entry.queryIndex + 1})` : '';
  const examples = [...new Set((entry?.samples || []).map(sample => sample?.title).filter(Boolean))].slice(0, 4);
  const suggestion = entry?.suggestion
    ? `AI-suggested rewording: "${entry.suggestion}"${entry.why ? ` (${String(entry.why).replace(/\.$/u, '')})` : ''}.`
    : 'No rewording was suggested (the call failed, timed out or found none).';
  return `[PageTitleScreen] off-target query on ${platform}${slot}: "${entry?.query || ''}" - ${mismatched} of ${screened} screened titles (${share}%) were a different kind of job${examples.length ? `, e.g. ${examples.join(' | ')}` : ''}. `
    + 'The title screen already skipped them without opening their details, but the site still loaded every results page for this query, so these pages cost scrape time on every run. '
    + `${suggestion} Not applied automatically: the source card shows the warning, and the search only changes if the user edits it.`;
}

/**
 * The source-card warning for one off-target query. Severity 'warn' keeps the
 * source's status as it is (the jobs it found are still kept and scored).
 */
export function offTargetQueryWarning(entry) {
  const platform = PLATFORM_NAMES[entry?.sourceId] || entry?.sourceId || 'This site';
  const share = entry?.screened > 0 ? Math.round((entry.mismatched / entry.screened) * 100) : 0;
  const examples = [...new Set((entry?.samples || []).map(sample => sample.title).filter(Boolean))].slice(0, 4);
  const suggestion = entry?.suggestion
    ? `Try searching "${entry.suggestion}" instead${entry.why ? ` (${entry.why.replace(/\.$/u, '')})` : ''}.`
    : 'Consider rewording or removing this query for this site.';
  return {
    code: 'query-off-target',
    severity: 'warn',
    evidence: `On ${platform}, ${share}% of the ${entry?.screened || 0} titles found for "${entry?.query || ''}" were a different kind of job${examples.length ? ` (for example ${examples.join(', ')})` : ''}. They were skipped without being opened.`,
    suggestion,
    offTargetQuery: {
      query: String(entry?.query || ''),
      screened: Number(entry?.screened) || 0,
      mismatched: Number(entry?.mismatched) || 0,
      ...(entry?.suggestion ? { suggestion: entry.suggestion } : {}),
    },
  };
}
