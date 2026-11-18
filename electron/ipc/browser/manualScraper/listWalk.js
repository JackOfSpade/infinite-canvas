import {
  NAV_SETTLE_MS,
  CONTENT_TIMEOUT_MS,
  SCROLL_SOURCES,
  NEXT_PAGE_SELECTORS,
  SOURCE_LABELS,
  parseClaimedResultTotal,
} from './walkRules.js';
import { updateOverlay, safePageUrl } from './scrapeBrowser.js';
import { recordManualScraperTelemetry } from './scrapeTelemetry.js';
import { logger } from '../../../logger.js';
import { humanDelay } from '../../../utils/humanDelay.js';
import { sourceJobKey } from '../../../../src/utils/jobIdentity.js';
import { resolvePageCeiling } from '../../../../src/utils/jobCollectionLimits.js';

export function countDistinctJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return 0;
  const seen = new Set();
  let count = 0;
  for (const job of jobs) {
    const key = sourceJobKey(job);
    if (seen.has(key)) continue;
    seen.add(key);
    count++;
  }
  return count;
}

// ── Extractor runner ──────────────────────────────────────────────────────────
// Returns { jobs: Array, siteChangedError: Error|null, evalError: Error|null }.
// evalError is any OTHER thrown error (not SITE_CHANGED) — usually a genuine
// transient (context destroyed by a mid-evaluate navigation) that resolves on
// its own next tick, but a real bug in the extractor throws the exact same
// shape. Without surfacing it distinctly, a persistently-failing extractor is
// indistinguishable from "the page briefly navigated" and silently degrades
// to "0 jobs, done" with no diagnostic trail. The caller tracks a consecutive
// streak (mirroring siteChangedStreak) and only warns once it persists.
export async function runExtractor(page, extractorJS) {
  try {
    const raw = await page.evaluate(extractorJS);
    return { jobs: Array.isArray(raw) ? raw : [], siteChangedError: null, evalError: null };
  } catch (err) {
    if (/SITE_CHANGED/i.test(err?.message)) return { jobs: [], siteChangedError: err, evalError: null };
    return { jobs: [], siteChangedError: null, evalError: err }; // context destroyed / transient — retry next tick, unless it persists
  }
}

// ── Next-page clicker ─────────────────────────────────────────────────────────
// Inspect a conventional next-page control independently of each source's
// configured selector. This is deliberately narrow: a visible, enabled control
// whose accessible text/title says "next page" is strong evidence that stopping
// here would silently truncate a paginated search. It lets us surface selector
// drift as an actionable warning instead of treating page 1 as a clean finish.
// Which label family counts as "there is more to fetch" depends on how the
// source advances. A board that appends in place ("Show more jobs") is just as
// much proof of an unfinished walk as a conventional pager, but a
// `next page`-only pattern cannot see one — so a load-more source whose
// configured selector had gone stale ended at page 1 and was reported as a
// clean `completed`.
//
// The two families stay SEPARATE rather than merging into one pattern: a pager
// source that has genuinely reached its last page often still shows an
// end-of-results "More jobs like this" link, and matching that would turn every
// completed pager walk into a false blocking warning.
//
// Held as pattern SOURCE strings, not RegExp literals, because the matching runs
// inside page.evaluate — which is serialized into the browser and cannot close
// over anything here. Passing the source across keeps one testable definition
// instead of a copy in the page context that could silently drift.
export const ADVANCE_CONTROL_LABEL_PATTERNS = Object.freeze({
  pager:    String.raw`\bnext\s+page\b`,
  loadMore: String.raw`\b(show|load|view|see)\s+(\d+\s+)?more\s+jobs?\b`,
});

export async function inspectNextPageControl(page, { loadMore = false } = {}) {
  const labelPattern = loadMore
    ? ADVANCE_CONTROL_LABEL_PATTERNS.loadMore
    : ADVANCE_CONTROL_LABEL_PATTERNS.pager;
  try {
    return await page.evaluate((patternSource) => {
      const normalized = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const ADVANCE_LABEL = new RegExp(patternSource);
      const candidate = [...document.querySelectorAll('a, button')].find((el) => {
        const label = normalized([
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.textContent,
          el.querySelector('svg title, img[alt]')?.textContent || el.querySelector('img')?.getAttribute('alt'),
        ].filter(Boolean).join(' '));
        const style = window.getComputedStyle(el);
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
        return !disabled && style.display !== 'none' && style.visibility !== 'hidden' &&
          ADVANCE_LABEL.test(label);
      });
      if (!candidate) return null;
      return {
        label: String(candidate.getAttribute('aria-label') || candidate.getAttribute('title') || candidate.textContent || 'Next page').replace(/\s+/g, ' ').trim(),
        href: candidate instanceof HTMLAnchorElement ? candidate.href : null,
      };
    }, labelPattern);
  } catch {
    return null;
  }
}

// Returns the click result plus any enabled next-page control that remains
// unhandled. Callers must never collapse the latter into a normal completion.
export async function clickNextPage(page, sourceId) {
  const sel = NEXT_PAGE_SELECTORS[sourceId];
  // A SCROLL source has no pager by construction, so probing for one can only
  // produce a false alarm — and the probe raises a BLOCK-severity warning.
  // It matches on the TEXT of every <a>/<button>, and on a job board that text
  // is job-title-derived: a posting titled "Next Page Media — Engineer" would
  // trip it. Measured on Google: zero real controls among 846 anchors and 1125
  // buttons, plus four near-misses in card aria-labels ("…Next-Generation
  // Network Management Platform…") that only escaped because they are
  // role="button" divs. Skip the probe rather than wait for one to land.
  if (!sel && SCROLL_SOURCES.has(sourceId)) return { clicked: false, unhandled: null };
  if (!sel) return { clicked: false, unhandled: await inspectNextPageControl(page) };
  try {
    const clicked = await page.evaluate((s, allowLabelFallback) => {
      const usable = el => {
        if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      const btn = [...document.querySelectorAll(s)].find(usable)
        || (allowLabelFallback && [...document.querySelectorAll('a, button')].find(el => (
          usable(el) && [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent]
            .some(label => /^next\s+page$/i.test(String(label || '').trim()))
        )));
      if (!btn) return false;
      btn.click();
      return true;
    }, sel, sourceId === 'ziprecruiter');
    return { clicked, unhandled: clicked ? null : await inspectNextPageControl(page) };
  } catch {
    return { clicked: false, unhandled: await inspectNextPageControl(page) };
  }
}

// ── Load-more ("Show more jobs") advance ──────────────────────────────────────
// Some boards replaced their pager with an in-page append: one URL load, then a
// button that grows the SAME list. Glassdoor did exactly that (see the
// `loadMoreSelector` note on its entry in jobs.js) — its `?p=N` param is
// ignored, so a URL/pager walk re-serves page 1 forever and a next-page click
// finds nothing. The selector is supplied by the task rather than inferred here,
// so this stays a wiring path and not a guess about any site's markup.
//
// Same contract as clickNextPage: never collapse an unhandled-but-present
// control into a normal completion, or a stale selector reads as an exhausted
// board.
export async function clickLoadMore(page, sel) {
  try {
    const clicked = await page.evaluate((s) => {
      const usable = el => {
        if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      // Glassdoor alternates Show/See more jobs without a stable data-test.
      // Only exact action labels qualify; recommendation links and job titles
      // mentioning these words are not pagination controls.
      const btn = [...document.querySelectorAll(s)].find(usable)
        || [...document.querySelectorAll('button, a')].find(el => (
          usable(el) && [el.getAttribute('aria-label'), el.textContent]
            .some(label => /^(?:show|load|view|see)\s+(?:\d+\s+)?more\s+jobs?$/i.test(String(label || '').trim()))
        ));
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    }, sel);
    return { clicked, unhandled: clicked ? null : await inspectNextPageControl(page, { loadMore: true }) };
  } catch {
    return { clicked: false, unhandled: await inspectNextPageControl(page, { loadMore: true }) };
  }
}

/**
 * Wait for a URL-paginated source to actually land on a new URL after a
 * next-page click. Returns true once the URL differs from `beforeUrl`, false if
 * it never changes within CONTENT_TIMEOUT_MS.
 *
 * This is the missing assertion behind the "no-new-jobs" false stop: the click
 * itself resolves immediately, so without waiting for the URL to change the
 * extractor can read the previous page's document.
 */
export async function waitForUrlChange(page, beforeUrl, signal, timeoutMs = CONTENT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    const current = safePageUrl(page);
    if (current && current !== beforeUrl) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

// Wait for an in-page append to actually add rows. Unlike a pager there is no
// navigation to await, and the click resolves long before the XHR lands. A
// count that never grows means the board had nothing more to give — a real
// end-of-results, not a failure.
//
// Measures the RAW row count, deliberately not countDistinctJobs: the caller's
// baseline is `extracted.length`, and that same raw length is what its
// `extracted.slice(prevCount)` index is expressed in. Mixing a de-duplicated
// count against a raw-length baseline would under-report growth on a list
// carrying duplicate DOM rows and end the walk early. Duplicates are already
// absorbed downstream by the providerSeen/seen key sets.
export async function waitForListGrowth(page, extractorJS, previousCount, signal, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return previousCount;
    const raw = await page.evaluate(extractorJS).catch(() => []);
    const count = Array.isArray(raw) ? raw.length : 0;
    if (count > previousCount) return count;
    await new Promise(r => setTimeout(r, 500));
  }
  return previousCount;
}

/**
 * Read a board's own advertised result total, where that number is known to be
 * trustworthy.
 *
 * Only ZipRecruiter qualifies, and only on its query-string SERP: walked to the
 * end, its header matched the reachable count exactly (520 reachable against a
 * 520 header). Its /jobs-search/N path form instead shows a capped "1000+" that
 * is not a count at all. Every other board measured is unusable for this —
 * Glassdoor UNDER-reports and its number drifts upward while paginating,
 * LinkedIn buckets to "1,000+" over a corpus that stops at 1,000, and Google
 * publishes no total.
 *
 * Returns null when no trustworthy number is present. Never throws.
 *
 * @returns {Promise<number|null>}
 */
export async function readClaimedResultTotal(page, sourceId) {
  if (sourceId !== 'ziprecruiter') return null;
  try {
    // Our own overlay is a real DOM node inside the page, so document.innerText
    // INCLUDES its status line ("Loading jobs… 141"). Reading the whole body
    // could therefore report the scraper's own number as the board-advertised
    // total. Hide the panel for the read (innerText skips display:none), prefer
    // the results heading, and restore the panel immediately.
    const text = await page.evaluate(() => {
      const overlay = document.getElementById('__ic-panel');
      const prev = overlay ? overlay.style.display : null;
      if (overlay) overlay.style.display = 'none';
      try {
        const heading = document.querySelector('h1')?.innerText || '';
        return heading.trim() || document.body?.innerText || '';
      } finally {
        if (overlay) overlay.style.display = prev || '';
      }
    });
    return parseClaimedResultTotal(text);
  } catch {
    return null;
  }
}

/**
 * Scroll a lazy list with TRUSTED wheel input.
 *
 * Puppeteer's page.mouse.wheel dispatches through CDP Input.dispatchMouseEvent,
 * so the page sees `isTrusted: true` — the difference that decides whether
 * Google's batch loader runs at all. The mouse is parked over a real card first,
 * because a wheel event scrolls whatever sits under the cursor: without the
 * move, the wheel lands on the document instead of the inner results container
 * and the list never advances.
 *
 * Fails soft. This is a reveal optimisation, not a correctness gate — a
 * detached frame or a card that never rendered must not end the scrape.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} cardSelector Any card in the list, used to aim the cursor.
 * @param {number} steps Wheel ticks to send.
 */
export async function revealByTrustedWheel(page, cardSelector, steps = 12) {
  try {
    // Aim at a card that is actually ON SCREEN. querySelector returns the FIRST
    // card, which scrolls above the viewport after the first pass — its rect
    // goes negative, and a wheel dispatched at negative coordinates lands
    // outside the results container and reveals nothing. Pick the first card
    // intersecting the viewport instead, and fall back to the viewport centre so
    // a pass is never skipped just because no card rect was usable.
    const box = await page.evaluate((sel) => {
      const vh = window.innerHeight || 800;
      const vw = window.innerWidth || 1200;
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.bottom <= 0 || r.top >= vh) continue;      // fully off-screen
        const y = Math.min(Math.max(r.top + Math.min(r.height / 2, 80), 8), vh - 8);
        const x = Math.min(Math.max(r.left + r.width / 2, 8), vw - 8);
        return { x, y };
      }
      return { x: Math.floor(vw / 2), y: Math.floor(vh / 2) };
    }, cardSelector);
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return false;
    await page.mouse.move(box.x, box.y);
    const viewport = page.viewport?.() || { height: 800 };
    for (let i = 0; i < steps; i++) {
      const height = Number(viewport?.height) > 0 ? Number(viewport.height) : 800;
      const delta = Math.floor(height * (0.55 + Math.random() * 0.3));
      await page.mouse.wheel({ deltaY: delta });
      await new Promise(r => setTimeout(r, 90 + Math.random() * 120));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Consecutive no-growth reveal passes required before calling a scroll list
 * finished. Must exceed the longest observed stall INSIDE a still-growing list
 * (one pass, at each ten-card batch boundary on Google) with margin for a slow
 * network, while staying far below the iteration ceiling.
 */
export const REVEAL_STABLE_PASSES = 5;

/**
 * A list that adds almost nothing over ten passes is trickling, not loading —
 * Google can add one card per reveal action forever, which the plateau exit
 * never catches and the iteration ceiling only catches hours later.
 */
export const REVEAL_LOW_GROWTH_PASSES = 10;

export const REVEAL_LOW_GROWTH_SHARE = 0.05;

export const REVEAL_LOW_GROWTH_MIN_START = 20;

/**
 * True when the last REVEAL_LOW_GROWTH_PASSES passes together added less than
 * REVEAL_LOW_GROWTH_SHARE of the count at the start of that window, and that
 * start count is big enough (>= 20) for the share to mean anything.
 * `counts` is the card count observed after each pass, oldest first.
 */
export function revealLowGrowthStop(counts) {
  if (!Array.isArray(counts) || counts.length < REVEAL_LOW_GROWTH_PASSES + 1) return false;
  const window = counts
    .slice(-(REVEAL_LOW_GROWTH_PASSES + 1))
    .map(value => Math.max(0, Number.isFinite(value) ? value : 0));
  const start = window[0];
  if (start < REVEAL_LOW_GROWTH_MIN_START) return false;
  return window[window.length - 1] - start < start * REVEAL_LOW_GROWTH_SHARE;
}

/**
 * Board-published "no more results" markers, checked during the reveal loop.
 *
 * Google keeps this node present on a ZERO-result page with empty text, so the
 * predicate must read the text, never just the element. Anchored on `jsname`,
 * which held stable across every page observed; the sibling class names are
 * obfuscated build output and churn.
 */
export const REVEAL_END_OF_LIST_SELECTORS = { google: '[jsname="OR4M9d"]' };

export async function revealEndOfListReached(page, sourceId) {
  const selector = REVEAL_END_OF_LIST_SELECTORS[sourceId];
  if (!selector) return false;
  try {
    return await page.evaluate(
      (sel) => !!document.querySelector(sel)?.textContent?.trim(),
      selector,
    );
  } catch {
    // Diagnostics-grade signal only — a detached frame must never end a walk.
    return false;
  }
}

// ── Pre-loader for scroll sources ─────────────────────────────────────────────
// Scrolls until the source reaches its remaining per-platform job allowance, or
// its configured reveal/page ceiling. Used for sources without traditional
// pagination and called before extraction sees the fully loaded set.
//
// A parallel "click a Load More button" strategy existed here as dead code:
// it was gated on a LOAD_MORE_SELECTORS map that was always `{}` (no source
// was ever configured), meaning any source actually needing that strategy
// silently got NO preload at all rather than a working fallback — worse than
// having no such feature, since it looked supported. Removed rather than
// guessing a selector for a source we can't verify; add it back with a real,
// verified selector if a specific source needs it.
export async function preloadContent(page, sourceId, extractorJS, overlayBase, signal, { maxPages, jobsPerPlatform, existingJobs = 0 }) {
  if (!SCROLL_SOURCES.has(sourceId)) return null;

  let prevCount = -1;
  let iterations = 0;
  let count = 0;
  let stableStreak = 0;
  // How the reveal loop ended, so a run that stopped early stops being
  // indistinguishable from one that revealed the whole list. Without this the
  // scroll loop emitted NO telemetry at all and a reveal that plateaued at 30 of
  // ~96 cards was reported downstream as a clean `completed`.
  let exit = 'plateau';
  // Card count after each pass, oldest first — the low-growth stop below reads
  // a ten-pass window from it.
  const passCounts = [];
  while (true) {
    if (signal?.aborted) { exit = 'aborted'; break; }
    // Ceiling on top of the "count stopped increasing" exit below. A source
    // that trickles in one marginally-new item per reveal action forever would
    // otherwise never plateau exactly.
    if (++iterations > maxPages) {
      logger.info(`[BrowserScraper] preloadContent(${sourceId}) hit the ${maxPages}-iteration ceiling — stopping reveal actions`);
      exit = 'iteration-ceiling';
      break;
    }
    const raw   = await page.evaluate(extractorJS).catch(() => []);
    count = countDistinctJobs(raw);
    passCounts.push(count);
    const target = Number.isFinite(jobsPerPlatform) ? Math.max(0, jobsPerPlatform - existingJobs) : null;
    await updateOverlay(page, {
      ...overlayBase,
      // Both paints in this hot loop describe the same reveal operation. Keep
      // the visible count fresh in Chrome, but coalesce their renderer beats.
      activityKey: 'google-preload',
      status: `Loading jobs… ${count}${target == null ? '' : `/${target}`}`,
    });
    if (target != null && count >= target) { exit = 'target-reached'; break; }

    // The board's OWN end-of-list marker is definitive — stop immediately rather
    // than spending the whole no-growth streak proving what the page already
    // says. Measured on Google: the node exists on a zero-result page too, but
    // with EMPTY text, so presence alone would read "reached the end" on a page
    // that never had a list. Test the text.
    if (await revealEndOfListReached(page, sourceId)) { exit = 'end-of-list'; break; }

    // A SINGLE no-growth pass is not the end of the list. Measured on Google:
    // cards arrive in batches of ten and the count stalls for one full pass at
    // every batch boundary (…40, 40, 50… / …70, 70, 80…), while a complete
    // reveal takes 18-47 passes. Breaking on the first plateau therefore stopped
    // at a batch boundary and silently under-collected — which from the outside
    // looks exactly like the list virtualizing (it does not; the DOM accumulates
    // monotonically, verified across 29 passes with zero decreases).
    if (count === prevCount) {
      stableStreak++;
      if (stableStreak >= REVEAL_STABLE_PASSES) { exit = 'plateau'; break; }
    } else {
      stableStreak = 0;
      prevCount = count;
    }

    // Trickle stop. A list that adds a few cards over ten passes is feeding on a
    // marginal new item per action, so the plateau exit never fires and only the
    // iteration ceiling would end it — hours later, with no sign it gave up.
    // Plateau and end-of-list are proof and win when both apply.
    if (revealLowGrowthStop(passCounts)) {
      const gained = count - passCounts[passCounts.length - 1 - REVEAL_LOW_GROWTH_PASSES];
      logger.warn(`[BrowserScraper] preloadContent(${sourceId}) reveal stalled: ${count} cards after ${iterations} passes — only ${gained} added over the last ${REVEAL_LOW_GROWTH_PASSES} passes`);
      exit = 'reveal-stalled';
      break;
    }
    // Google for Jobs renders cards in its own scrollable container inside the page.
    // Walk up from the first card to find that container and scroll it; also
    // scroll document.body so either trigger path gets hit.
    await updateOverlay(page, {
      ...overlayBase,
      activityKey: 'google-preload',
      status: `Loading the full Google list — not selecting cards yet… ${count}`,
    });
    // TRUSTED wheel events are REQUIRED here. Google's batch loader ignores
    // programmatic scrolling entirely: `window.scrollTo`/`scrollBy` and
    // `el.scrollTop` move the viewport to the page floor and load NOTHING —
    // measured sitting at exactly 20 cards across 14 passes, with no
    // end-of-list sentinel. That is indistinguishable from a genuine small
    // result set, so the failure is silent. Synthetic `WheelEvent` dispatch
    // and `End` keypresses are equally ignored (both are untrusted).
    // page.mouse.wheel goes through CDP Input.dispatchMouseEvent, which the
    // page receives as a real user wheel.
    await revealByTrustedWheel(page, '.EimVGf, [jscontroller="b11o3b"]');
    // Keep a programmatic nudge AFTER the wheel pass. It cannot trigger the
    // loader, but it costs nothing and still helps any lazy <img>/observer
    // work that keys off scroll position rather than input trust.
    await page.evaluate(async () => {
      const step = Math.floor(window.innerHeight * (0.55 + Math.random() * 0.3));
      let steps = 0;
      while (window.scrollY + window.innerHeight < document.body.scrollHeight - 10 && steps < 6) {
        window.scrollBy(0, step);
        await new Promise(r => setTimeout(r, 55 + Math.random() * 90));
        steps++;
      }
    }).catch(() => {});
    await new Promise(r => setTimeout(r, humanDelay(NAV_SETTLE_MS)));
  }
  // Observation only — never a stop rule, a filter, or a retry trigger. `exit`
  // says WHY revealing stopped; `count` is what was actually on the page when it
  // did. A `plateau` well below a source's known list length is the signature of
  // a reveal that stalled, which previously looked identical to success.
  // updateActive:false — this is an OUTCOME, not the scraper's current phase.
  // Extraction runs immediately after this returns, so advancing `active` here
  // would pin "reveal-finished" onto every later render of the phase field.
  recordManualScraperTelemetry({
    phase: 'reveal-finished',
    sourceId,
    srcName: SOURCE_LABELS[sourceId] || sourceId,
    iterations,
    count,
    // 'end-of-list' means the board said so; 'plateau' means we inferred it from
    // a no-growth streak. Only the first is proof the list was fully revealed.
    exit,
  }, { updateActive: false });
  return { exit, iterations, count };
}

/**
 * Load the complete scroll-backed provider list inside an already-open Solve
 * window. The generic captcha poll sees only Google's initially mounted ten
 * cards; the ordinary source preloader must run before recovery decides which
 * persisted deferred identities still need their detail panel opened.
 */
export async function preloadResolvedJobList(page, sourceId, extractorJS, signal = null) {
  const srcName = SOURCE_LABELS[sourceId] || sourceId || 'Job source';
  const overlayBase = {
    srcLabel: 'Resolved source', srcName,
    qLabel: 'Recovery', qText: 'Loading the full result list',
  };
  await preloadContent(page, sourceId, extractorJS, overlayBase, signal, {
    maxPages: resolvePageCeiling(null),
    // Scroll until the provider count plateaus. The recovery pool intentionally
    // omits age/history rows whose physical positions may be anywhere in the
    // larger list, so its own size cannot be used as the reveal target.
    jobsPerPlatform: Infinity,
    existingJobs: 0,
  });
  if (signal?.aborted) return [];
  const rows = await page.evaluate(extractorJS);
  return Array.isArray(rows) ? rows : [];
}
