/**
 * Browser Pool — Manages concurrent stealth scraping through puppeteer-extra.
 *
 * Anti-ban architecture:
 *   - Global concurrency cap that shrinks under cross-domain block pressure
 *   - Max 1 concurrent page per domain (prevents pattern detection)
 *   - Adaptive per-domain cooldown that tightens on throttle/block signals and
 *     relaxes on success (see rateLimiter.js — the seed cooldowns are the floor)
 *   - Gaussian-distributed inter-request delays (not uniform = detectable)
 *
 * Public API:
 *   queueScrape(url, extractorJS, options) → Promise<any>
 *   scrapeMultiple(tasks) → Promise<Array<{id, success, data?, error?}>>
 */
import {
  createStealthPage,
  humanMouseMove,
  dismissCookieBanner,
  humanScroll,
} from './stealthBrowser.js';
import { randomUUID } from 'crypto';
import { logger } from '../logger.js';
import { READINESS, resolveBudget, recordReady, recordBodySize, getBodyBaseline } from './scrapeBudget.js';
import {
  extractDomain,
  isCoolingDown,
  effectiveConcurrency,
  perDomainLimit,
  recordOutcome,
  nextWakeMs,
} from './rateLimiter.js';
import { detectAntiBotSignal } from './antiBotDetector.js';
import { JOB_COLLECTION_PAGE_CEILING } from '../../src/utils/jobCollectionLimits.js';

// Queue dispatch cadence. These are housekeeping intervals, not rate limits —
// the rate limiter (cooldowns) governs actual request pacing. The idle poller
// is a backstop; it wakes at the soonest cooldown expiry (bounded by
// POLLER_MAX_MS) so a freed domain dispatches promptly without busy-spinning.
const POLLER_MAX_MS = 1000;   // longest gap between idle re-checks
const POLLER_MIN_MS = 100;    // shortest, so we never tight-loop
const REQUEUE_DELAY_MS = 500; // re-check delay after a task frees a slot

let activeCount = 0;
const activeDomains = new Map(); // domain -> count of active pages
const queue = [];
const activeTasks = new Map(); // cacheKey -> Promise (deduplicates both queued and running tasks)
const pageHandles = new Map(); // uuid -> { page, startTime }
let isShuttingDown = false;
let queuePauseDepth = 0;
const queuePauseReasons = new Map(); // reason -> count

// ── Utility Functions ───────────────────────────────────────────────────────

/**
 * Gracefully close a puppeteer page with a timeout to prevent hanging.
 */
async function safeClose(page, timeoutMs = 2000) {
  if (!page || page.isClosed() || page.__closing) return;
  page.__closing = true;
  let closeTimeoutId;
  try {
    await Promise.race([
      page.close(),
      new Promise(r => { closeTimeoutId = setTimeout(r, timeoutMs); })
    ]);
  } catch (e) {
    logger.warn('[BrowserPool] safeClose error:', e?.message || e);
  } finally {
    if (closeTimeoutId) clearTimeout(closeTimeoutId);
  }
}

// ── Queue Dispatch ───────────────────────────────────────────────────────────
// All rate-limiting policy (cooldowns, tighten, escalation, pressure) lives in
// rateLimiter.js. This layer only owns the queue + concurrency slots.

function canProcessTask(task) {
  const domain = extractDomain(task.url);
  const domainActive = activeDomains.get(domain) || 0;
  // Per-domain concurrency cap AND per-domain cooldown. Skipping cooling tasks
  // lets us dispatch others, maximizing global slot utilization.
  return domainActive < perDomainLimit && !isCoolingDown(domain);
}

let queuePoller = null;

function isQueuePaused() {
  return queuePauseDepth > 0;
}

function addPauseReason(reason) {
  const key = reason || 'manual';
  queuePauseReasons.set(key, (queuePauseReasons.get(key) || 0) + 1);
  return key;
}

function removePauseReason(reason) {
  const key = reason || 'manual';
  const count = queuePauseReasons.get(key) || 0;
  if (count <= 1) queuePauseReasons.delete(key);
  else queuePauseReasons.set(key, count - 1);
}

export function pauseBrowserPool(reason = 'manual') {
  const key = addPauseReason(reason);
  queuePauseDepth++;
  logger.info(`[BrowserPool] Queue paused (${key}); depth=${queuePauseDepth}`);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    queuePauseDepth = Math.max(0, queuePauseDepth - 1);
    removePauseReason(key);
    logger.info(`[BrowserPool] Queue resumed (${key}); depth=${queuePauseDepth}`);
    if (!isQueuePaused()) processQueue();
  };
}

export function getBrowserPoolQueueState() {
  return {
    active: activeCount,
    queued: queue.length,
    paused: isQueuePaused(),
    pauseDepth: queuePauseDepth,
    pauseReasons: Array.from(queuePauseReasons.keys()),
  };
}

/** Backstop wake: re-check the queue when the soonest domain cooldown expires. */
function scheduleQueueWake() {
  if (queuePoller || queue.length === 0 || isShuttingDown || isQueuePaused()) return;
  const wait = Math.max(POLLER_MIN_MS, Math.min(nextWakeMs() ?? POLLER_MAX_MS, POLLER_MAX_MS));
  queuePoller = setTimeout(() => {
    queuePoller = null;
    processQueue();
  }, wait);
}

function processQueue() {
  if (isQueuePaused()) return;
  // Effective concurrency shrinks under cross-domain block pressure.
  while (activeCount < effectiveConcurrency() && queue.length > 0) {
    // Find the first task whose domain isn't cooling down / at capacity
    const taskIdx = queue.findIndex(t => canProcessTask(t));
    if (taskIdx === -1) break; // All queued tasks are for busy/cooling domains

    const task = queue.splice(taskIdx, 1)[0];
    const { url, extractorJS, options, resolve, reject } = task;
    const domain = extractDomain(url);

    activeCount++;
    activeDomains.set(domain, (activeDomains.get(domain) || 0) + 1);

    // A task with `options.paginate` walks multiple result pages in ONE stealth
    // session (date-bounded deep pagination); it occupies a single queue slot for
    // the whole sequence, so domain gating / concurrency apply to the source, not
    // each page. Everything else runs the one-shot path unchanged.
    const run = options.paginate
      ? executeScrapePaginated(extractorJS, options)
      : executeScrape(url, extractorJS, options);
    run
      .then(resolve)
      // Always reject — never swallow. This task was already spliced out of
      // `queue` above, so it is NOT one of the tasks closeAllPages() drains
      // and rejects directly (that path only covers tasks still sitting in
      // `queue`, never yet dispatched). A task already active/dispatched when
      // shutdown starts settles its `run` promise exactly once (async
      // functions can't double-settle), so there is no double-reject risk —
      // suppressing the reject here previously left THIS task's caller (e.g.
      // scrapeMultiple) awaiting a promise that would never resolve or
      // reject, hanging forever instead of surfacing the shutdown/cancel.
      .catch(reject)
      .finally(() => {
        activeCount--;
        const count = activeDomains.get(domain) || 1;
        if (count <= 1) activeDomains.delete(domain);
        else activeDomains.set(domain, count - 1);

        // A slot freed — re-check soon (cooldowns may also have moved on).
        // Skip entirely when nothing is waiting; scheduling a pointless
        // macrotask on every single task completion adds up under load.
        if (queue.length > 0) setTimeout(processQueue, REQUEUE_DELAY_MS);
      });
  }

  // Tasks still waiting (pool full or every domain cooling) — arm the backstop.
  if (queue.length > 0) scheduleQueueWake();
}

/**
 * Bounded page.content() read. A Cloudflare/DataDome-style anti-bot reload
 * loop can leave the page's execution context perpetually unstable, and
 * page.content() then blocks INDEFINITELY waiting for a stable context —
 * sailing past the scrape's own hard timeout instead of letting the caller
 * reach a graceful classification (SITE_CHANGED reclassification, anti-bot
 * detection, etc.). The bare `page.content().catch(() => '')` this replaces
 * only guards against a *rejection*, not a hang — a stuck page never resolves
 * NOR rejects, so `.catch()` never runs and the whole readiness pipeline sits
 * there until the OUTER race's hard timeout fires, surfacing as an opaque
 * "Scrape timed out after Nms" instead of a normal empty/blocked result. This
 * mirrors the identical fix already shipped in stealthBrowser.js's
 * fetchHtmlAuthed/fetchHtmlClean for the same underlying Puppeteer behavior.
 * Falls back to '' on either a rejection or a timeout, same as the code it
 * replaces — callers already treat an empty body as "couldn't confirm
 * anti-bot signal", not a hard failure.
 */
export async function readPageContentBounded(page, maxMs) {
  const bound = Math.max(1000, maxMs);
  try {
    return await Promise.race([
      page.content(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('page.content() timed out — page may be stuck in an anti-bot reload loop')), bound)),
    ]);
  } catch {
    return '';
  }
}

/**
 * On a scrape hard-timeout, capture the page's state (final URL, body size,
 * title, a visible-text snippet) and FOLD it into the thrown error's message,
 * behind a `[timeout-state …]` marker, so it survives into the caller's
 * persisted warning.evidence and the bug report — not ONLY the ephemeral
 * ~60-line main-process log ring buffer where it used to live. That buffer
 * rotates within minutes, so a report generated even an hour after the scrape
 * had already lost this, leaving a genuine page-never-loaded failure
 * indistinguishable from an anti-bot tarpit (exactly what masked the
 * poshmark/swappa timeout root-cause). Mirrors the eBay SITE_CHANGED
 * extractor's inline `[diag …]` self-diagnosis convention; the `[timeout-state`
 * marker is recognized by the marketplace/job warning classifiers (which widen
 * their evidence slice for it) and the Recent-Logs cap in bugReport.js.
 *
 * Best-effort and BOUNDED: the diag read is itself raced against a short timer
 * because page.evaluate() on a page stuck in a reload loop can hang the same way
 * page.content() does (see readPageContentBounded) — a diagnostic must never
 * mask, delay, or replace the real failure. Returns the (possibly mutated) same
 * error so callers can `throw await enrichTimeoutError(page, error)`.
 */
export async function enrichTimeoutError(page, error) {
  if (!page || !error || !/timed?\s*out|timeout/i.test(error.message || '')) return error;
  // Don't double-append if this error already carries the marker.
  if (/\[timeout-state /.test(error.message || '')) return error;
  try {
    const failUrl = (typeof page.url === 'function' ? page.url() : '') || 'unknown';
    const diag = await Promise.race([
      page.evaluate(() => ({
        bodyLen: document.body?.innerText?.length ?? 0,
        bodyHead: (document.body?.innerText ?? '').substring(0, 300),
        title: document.title ?? '',
      })),
      new Promise((_, reject) => setTimeout(() => reject(new Error('diag-timeout')), 3000)),
    ]).catch(() => null);
    const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, n);
    const state = `[timeout-state finalUrl=${failUrl} bodyLen=${diag?.bodyLen ?? 0}`
      + ` title="${clean(diag?.title, 60)}" bodyHead="${clean(diag?.bodyHead, 200)}"]`;
    logger.info(`[BrowserPool] Timeout state — ${state}`);
    // Append rather than replace: the classifiers match the original "timed out"
    // copy to route this to the scrape-timeout code.
    try { error.message = `${error.message} ${state}`; } catch { /* frozen msg — logged above regardless */ }
  } catch { /* ignored — diagnostics must never mask the real error */ }
  return error;
}

/**
 * Internal — creates a stealth page, navigates, extracts data.
 *
 * Options:
 *   timeoutMs    — SEED hard timeout (default 30000). Treated as a ceiling:
 *                  scrapeBudget learns each source's typical time-to-ready and
 *                  derives a tighter working budget for fast sources, never
 *                  looser than this seed. See scrapeBudget.resolveBudget.
 *   waitFor      — CSS selector to wait for before extracting (optional)
 *   scrollFirst  — if true, simulate human scrolling before extraction (default false)
 *   dismissCookies — if true, try to dismiss cookie banners (default true)
 *   referer      — spoofed Referer header (optional)
 *   sourceLabel  — stable source id used as the budget key (set by scrapeMultiple)
 *
 * NOTE: the legacy `waitMs` settle is gone — the readiness loop below decides
 * when results are ready, and the pre-first-read beat is sized from learned
 * timing. `waitMs` in a config is now ignored (kept only for cache-key purposes).
 */
async function executeScrape(url, extractorJS, options = {}) {
  const {
    timeoutMs = 30000,
    waitFor = null,
    scrollFirst = false,
    dismissCookies = true,
    referer = null,
  } = options;

  const domain = extractDomain(url);
  // Budget key: prefer the explicit source id (e.g. 'ebay-sold'); fall back to
  // domain for ad-hoc single scrapes. `timeoutMs` is the seed/ceiling.
  const sourceKey = options.sourceLabel || domain;
  const { timeoutMs: budgetMs, firstBeatMs, learned } = resolveBudget(sourceKey, timeoutMs);
  if (learned && budgetMs < timeoutMs) {
    logger.info(`[BrowserPool] ${sourceKey}: using learned budget ${budgetMs}ms (seed ${timeoutMs}ms)`);
  }
  const pageId = randomUUID(); // Track this specific page instance
  let page = null;
  let timeoutId = null;
  let isSettled = false;

  if (isShuttingDown) {
    throw new Error('Browser pool is shutting down');
  }

  const scrapeStart = Date.now();
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Scrape timed out after ${budgetMs}ms for ${url}`)), budgetMs);
    });

    const scrapePromise = (async () => {
      let abortHandler = null;
      try {
        page = await createStealthPage();
        if (isShuttingDown || isSettled || options.signal?.aborted) {
          if (page) {
            await page.close().catch(() => {});
          }
          if (options.signal?.aborted) throw new Error('Aborted');
          // Match the pre-launch check below (which throws), not a silent
          // null — a caller watching progress during the shutdown window
          // would otherwise see a false "successful scrape, no data"
          // instead of a clear cancellation.
          if (isShuttingDown) throw new Error('Browser pool is shutting down');
          return null;
        }
        pageHandles.set(pageId, { page, startTime: Date.now() });

        if (options.signal) {
          abortHandler = () => {
            safeClose(page, 2000);
          };
          options.signal.addEventListener('abort', abortHandler, { once: true });
        }

        // If the outer operation already timed out before we got the page, abort.
        if (isSettled) {
          return null;
        }

        // Set page-level timeout (headroom carved out of the working budget)
        page.setDefaultNavigationTimeout(Math.max(5000, budgetMs - READINESS.DEFAULT_NAV_HEADROOM_MS));

        // Set referrer organically if specified
        if (referer) {
          await page.evaluateOnNewDocument((ref) => {
            Object.defineProperty(document, 'referrer', { get: () => ref });
          }, referer);
        }

        // Navigate. Default to 'domcontentloaded' rather than 'networkidle2':
        // ad/tracking-heavy result pages (e.g. eBay sold listings) never reach
        // network-idle, so networkidle2 burned the entire timeout budget and
        // tripped the outer hard timeout. We instead get the DOM fast and let
        // the extractor-stabilization loop below decide when results are ready
        // — a far better readiness signal than "the network went quiet." Still
        // capture the Response for anti-bot detection (status / final URL); if
        // navigation fails we keep going so the extractor gets a shot.
        let pageResponse = null;
        try {
          pageResponse = await page.goto(url, { waitUntil: options.waitUntil || 'domcontentloaded', timeout: Math.max(5000, budgetMs - READINESS.NAV_HEADROOM_MS) });
        } catch (e) {
          if (!e?.message?.includes('ERR_ABORTED') && !e?.message?.includes('net::ERR_') && !e?.message?.includes('TimeoutError') && !e?.message?.includes('timeout')) {
            throw e;
          }
        }

        // Dismiss cookie/privacy banners
        if (dismissCookies) {
          await dismissCookieBanner(page);
        }

        // Wait for specific content selector if provided. Bounded by SELECTOR_WAIT_MS
        // but never more than the budget's readiness window — the stabilization
        // loop below is the real readiness signal, this is just an early hint.
        if (waitFor) {
          try {
            const selectorWait = Math.min(READINESS.SELECTOR_WAIT_MS, Math.max(2000, budgetMs - READINESS.READINESS_HEADROOM_MS));
            await page.waitForSelector(waitFor, { timeout: selectorWait });
          } catch {
            // Selector didn't appear — continue anyway, extractor may still find content
          }
        }

        // Human-like behavior: mouse movement + scrolling
        if (scrollFirst) {
          await humanScroll(page, 3);
        } else {
          // Even without scrolling, do a quick mouse wiggle to look human
          await humanMouseMove(page);
        }

        // ── Dynamic content readiness ───────────────────────────────────────
        // Replaces the old "fixed settle delay → single extract." Poll the
        // extractor and wait for its item COUNT to stabilize: a server-rendered
        // page is ready on the first read; a JS/lazy grid is waited on exactly
        // as long as items keep arriving, then stops. This is what makes the
        // lighter 'domcontentloaded' navigation safe, and it removes the
        // guess-a-settle-time magic number. Bounded by the remaining timeout
        // budget (with headroom for anti-bot detection + close) and by a short
        // zero-streak so a genuinely-empty page returns promptly.
        const countItems = (r) => Array.isArray(r)
          ? r.length
          : (r && typeof r === 'object' && Array.isArray(r.items) ? r.items.length : (r ? -1 : 0));
        // -1 = an opaque (non-array, non-{items}) shape we can't count → accept on sight.
        // Detection constants + headroom are centralized in scrapeBudget.READINESS
        // so this loop and authWindows' captcha loop can't drift apart.
        const readinessDeadline = scrapeStart + budgetMs - READINESS.READINESS_HEADROOM_MS;

        // One short human-like beat before the first read, sized from this
        // source's learned timing (clamped) instead of a fixed settle guess.
        await new Promise(r => setTimeout(r, firstBeatMs));

        let extractorResult = null;
        // A SITE_CHANGED throw (extractor matched 0 cards) is DEFERRED here, not
        // rethrown on the spot: a 0-card page is sometimes an anti-bot challenge
        // (Cloudflare "Just a moment…", a 403/503 interstitial) rather than real
        // selector drift, and an immediate throw skips the anti-bot detector below
        // — mislabeling a hard block as `stale-selectors` (warn) all the way to the
        // source card. Keep polling after the first throw as well: slow SRP pages
        // can legitimately have a huge body/title before their listing nodes are
        // attached, and breaking on the first throw turns that timing gap into a
        // false selector-drift warning.
        let siteChangedError = null;
        let lastCount = -2;   // sentinel so the first real read always "changes"
        let stableReads = 0;
        let zeroReads = 0;
        let settledPositively = false;  // true only when we break on a stable, >0 count
        // A non-SITE_CHANGED evaluate() throw is usually a genuine transient
        // (the page navigated mid-evaluate) and self-resolves next tick — but
        // if it keeps happening it's a real bug in the extractor, and without
        // this it's indistinguishable from a genuinely empty page: the loop
        // just falls through to "0 results, success" with no diagnostic
        // trail, exactly the failure mode antiBotDetector exists to catch
        // (bypassed here, upstream of it).
        let evalErrStreak = 0;
        let lastEvalErrMsg = null;
        while (true) {
          // isShuttingDown: closeAllPages() force-closes tracked pages during
          // shutdown, but without this check a readiness loop already polling
          // one keeps retrying page.evaluate against the closed target until
          // its own readinessDeadline (up to the full scrape budget) elapses.
          if (isSettled || isShuttingDown || options.signal?.aborted) break;
          let r = null;
          try { r = await page.evaluate(extractorJS); }
          catch (evalErr) {
            if (/SITE_CHANGED/i.test(evalErr?.message || '')) {
              siteChangedError = evalErr;
              if (Date.now() >= readinessDeadline) break;
              await new Promise(res => setTimeout(res, READINESS.POLL_MS));
              continue;
            }
            lastEvalErrMsg = evalErr?.message || String(evalErr);
            if (++evalErrStreak === READINESS.STABLE_READS) {
              logger.warn(`[BrowserPool] ${sourceKey}: extractor threw ${evalErrStreak}x in a row (non-SITE_CHANGED) — "${lastEvalErrMsg}". If this persists, the extractor itself may have a bug, not just a transient mid-navigation eval.`);
            }
            /* navigated mid-evaluate — retry next tick */
          }
          if (r != null) {
            evalErrStreak = 0;
            siteChangedError = null;
            extractorResult = r;                 // always keep the freshest result
            const count = countItems(r);
            if (count === -1) break;             // opaque shape — done
            if (count > 0) {
              zeroReads = 0;
              if (count === lastCount) {
                if (++stableReads >= READINESS.STABLE_READS) { settledPositively = true; break; }
              } else { stableReads = 0; lastCount = count; }
            } else {
              // count === 0. A page that HAS candidate rows but extracted nothing
              // (yieldStats.seen > 0) is still rendering its per-card fields — e.g.
              // PriceCharting injects the price text into <span class="js-price">
              // AFTER the row skeleton exists, so an early read is seen>0/items=0.
              // Keep polling to the budget deadline so those fields can populate;
              // only a genuinely empty page (no rows seen) takes the fast zero-streak
              // exit. Bounded by readinessDeadline below either way.
              const seenCount = (r && r.yieldStats && typeof r.yieldStats.seen === 'number') ? r.yieldStats.seen : 0;
              if (seenCount === 0 && ++zeroReads >= READINESS.MAX_ZERO_READS) {
                break;                           // genuinely empty (or unparseable)
              }
            }
          }
          if (Date.now() >= readinessDeadline) break;  // budget spent — take freshest
          await new Promise(res => setTimeout(res, READINESS.POLL_MS));
        }
        // Time-to-ready for the budget learner — only the clean positive-stable
        // case (recorded below, after anti-bot detection rules out a block).
        const stableElapsedMs = settledPositively ? Date.now() - scrapeStart : null;
        // Guarantee a value even if every evaluate threw (rare). Skip when a
        // SITE_CHANGED is already deferred — re-running the extractor would just
        // re-throw, and we want detection to run on the page we already have.
        if (extractorResult == null && !siteChangedError) {
          try { extractorResult = await page.evaluate(extractorJS); }
          catch (evalErr) {
            if (/SITE_CHANGED/i.test(evalErr?.message || '')) siteChangedError = evalErr;
            else extractorResult = [];
          }
        }

        // Unwrap the extractor's optional { items, yieldStats } envelope up front
        // so the anti-bot detector can consult the cards-seen denominator AND the
        // site's own result-count header (yieldStats.claimedTotal): a sub-floor
        // count on a page the extractor read cleanly is a thin query, not a block.
        const __wrapped = extractorResult && !Array.isArray(extractorResult) && Array.isArray(extractorResult.items);
        const yieldStats = __wrapped ? (extractorResult.yieldStats || null) : null;

        // Run anti-bot detection on what we observed. Both the raw extractor
        // result and the warning (if any) flow back to the caller so the UI can
        // render a visible signal instead of silently accepting a blocked page.
        let warning = null;
        try {
          // Clamp to what's left of THIS scrape's budget (minus a small margin)
          // so a stuck page still yields a graceful classification instead of
          // burning the remainder and tripping the outer hard timeout — see
          // readPageContentBounded.
          const html       = await readPageContentBounded(page, (scrapeStart + budgetMs) - Date.now() - 1500);
          const finalUrl   = page.url() || url;
          const status     = pageResponse?.status?.() ?? 0;
          const itemCount  = __wrapped
            ? extractorResult.items.length
            : (Array.isArray(extractorResult) ? extractorResult.length : null);
          warning = detectAntiBotSignal({
            status,
            finalUrl,
            html,
            itemsExtracted: itemCount,
            expectedMinItems: options.expectedMinItems || 0,
            expectedBodySize: getBodyBaseline(sourceKey),  // learned typical good-body size
            sourceLabel: options.sourceLabel || domain,
            yieldStats,
          });
          if (warning) {
            logger.warn(`[BrowserPool] Anti-bot signal on ${url}: ${warning.code} — ${warning.evidence}`);
          } else if (itemCount > 0 && html) {
            // Clean response with real items — feed the body-size baseline so
            // future suspicious-empty checks are judged against this source's norm.
            recordBodySize(sourceKey, String(html).length);
          }
        } catch (e) {
          logger.warn('[BrowserPool] Anti-bot detector failed (non-fatal):', e?.message || String(e));
        }

        // Feed the budget learner: a positive-count stabilization that wasn't
        // flagged as a hard block is a clean "this is how long success takes"
        // sample. Blocks/throttles/empties are intentionally excluded so the
        // EMA tracks healthy timing, not stall duration.
        if (stableElapsedMs != null && warning?.severity !== 'block') {
          recordReady(sourceKey, stableElapsedMs);
        }

        // Resolve a deferred SITE_CHANGED throw now that anti-bot detection has
        // run on the same page. If the 0-card page is actually a hard block
        // (Cloudflare "Just a moment…", 403/503, a challenge interstitial), surface
        // the BLOCK — it carries a Solve affordance and the correct 'block'
        // rate-limiter outcome — instead of letting the throw mislabel it as
        // stale-selectors downstream. A genuinely-served page with 0 cards (real
        // design-system drift, e.g. eBay changing su-styled-text) re-throws and
        // stays stale-selectors. Conservative on purpose: reroute ONLY on a
        // high-confidence `block`, never a throttle/empty, so real drift is never
        // downgraded into an unclearable Solve loop.
        if (siteChangedError) {
          if (warning?.severity === 'block') {
            return { data: [], warning, yieldStats: null };
          }
          throw siteChangedError;
        }

        // `data` stays a bare array for every downstream consumer; yieldStats was
        // unwrapped above (the cards-seen denominator + per-card field drops behind
        // a healthy-looking count, plus the site's claimed result total).
        return {
          data: __wrapped ? extractorResult.items : extractorResult,
          warning,
          yieldStats,
        };
      } finally {
        if (options.signal && abortHandler) {
          options.signal.removeEventListener('abort', abortHandler);
        }
        isSettled = true; // Ensure inner settle happens even on errors
        pageHandles.delete(pageId);
        await safeClose(page, 2000);
      }
    })();

    // Prevent unhandled promise rejection if timeout wins and scrapePromise later rejects
    scrapePromise.catch(() => { });

    const result = await Promise.race([scrapePromise, timeoutPromise]);

    // Feed the rate limiter the REAL outcome. A soft block/throttle (HTTP 200 +
    // anti-bot warning) must back the domain off and count toward escalation —
    // it is not a clean success. Aborts/shutdowns (null result) record nothing.
    if (result) {
      const severity = result.warning?.severity;
      recordOutcome(domain, severity === 'block' ? 'block' : severity === 'throttle' ? 'throttle' : 'ok');
    }
    return result;
  } catch (error) {
    const isAborted = options.signal?.aborted || error?.message === 'Aborted' || isShuttingDown;

    if (isAborted) {
      logger.info(`[BrowserPool] Scrape aborted/shutting down for ${url}`);
    } else {
      logger.error(`[BrowserPool] Scrape failed for ${url}:`, error);
      recordOutcome(domain, 'error');  // network/nav-timeout/hard-timeout → tighten
      // Capture page state at the moment of a timeout and FOLD it into the error
      // so it survives into the persisted warning + bug report (not just the log
      // ring buffer). Best-effort + bounded — see enrichTimeoutError. Must run
      // while the page is still open (before safeClose below).
      await enrichTimeoutError(page, error);
    }

    // Clean up handle
    pageHandles.delete(pageId);

    // Safety: ensure no concurrent close calls
    await safeClose(page, 2000);
    
    throw error;
  } finally {
    isSettled = true;
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ── Same-session paginating scrape (date-bounded deep pagination) ────────────
/** Jittered human "reading" pause (triangular ≈ gaussian — uniform is detectable). */
function jitteredDelay(min, max) {
  const t = (Math.random() + Math.random()) / 2; // central-tendency, not flat
  return Math.round(min + t * (max - min));
}

/**
 * Drive ONE stealth page through up to `maxPages` result pages of a single
 * source, navigating page→page in the SAME context like a human clicking
 * "Next". Keeping the session means the anti-bot clearance cookie
 * (cf_clearance / session) and referer chain persist across pages — materially
 * safer than a fresh context per page, which re-faces the bot challenge and
 * looks like a visitor teleporting straight to page N (a bot tell). Speed is
 * deliberately traded away: a jittered "reading" pause separates page loads,
 * and we stop the instant a hard block appears (never paginate into a tripwire).
 *
 * Stays domain-agnostic — it knows nothing about job dates. The CALLER owns the
 * "should we keep paging?" decision via `onPageScraped`, which returns
 * { stop, reason }. The job pipeline's callback (makeJobPageStop, in
 * electron/ipc/jobPageStop.js) reports one of three data-driven reasons:
 * `empty-page` (a page extracted zero rows — terminal, lossless), `age-window`
 * (two consecutive pages conclusively outside the caller's look-back window),
 * or `no-new-jobs` (the pager has stopped advancing / re-serving seen rows).
 * browserPool itself only stops independently for a hard anti-bot block or the
 * `maxPages` ceiling — with the hub's page count now defaulting to "All", that
 * ceiling is a BACKSTOP against a runaway pager, not the expected way a
 * well-behaved walk ends.
 *
 * Mirrors executeScrape's per-page readiness + anti-bot block; the shared
 * READINESS constants (scrapeBudget.js) keep the two loops from drifting — the
 * same arrangement authWindows' captcha loop uses.
 *
 * options (beyond executeScrape's): nextUrl(pageIndex)→url, maxPages,
 *   onPageScraped({items,warning,pageIndex})→{stop,reason}, pageDelayMs:[min,max].
 * @returns {{ data: any[], warning: object|null, pagesWalked: number, stopReason: string }}
 */
async function executeScrapePaginated(extractorJS, options = {}) {
  const {
    timeoutMs = 30000,
    waitFor = null,
    scrollFirst = false,
    dismissCookies = true,
    referer = null,
    maxPages: maxPagesOption = 1,
    nextUrl,
    onPageScraped = null,
    pageDelayMs = [4000, 9000],
    expectedMinItems = 0,
    // When set, p>0 iterations click this selector instead of navigating to a
    // new URL. Glassdoor uses "Show more" infinite-scroll rather than page
    // params, so URL pagination is broken — one load + N button clicks instead.
    loadMoreSelector = null,
  } = options;
  // Defensive: a `null`/non-finite maxPages (e.g. a caller forwarding an
  // un-resolved "All" pagesPerPlatform straight through) must fall back to the
  // shared backstop, NOT the `= 1` destructuring default — that default only
  // triggers for `undefined`, so an explicit `maxPages: null` would otherwise
  // survive as literal `null` and make `p < maxPages` false on the very first
  // iteration, silently returning a 0-page "success" instead of scraping.
  const maxPages = Number.isFinite(maxPagesOption) && maxPagesOption > 0
    ? Math.floor(maxPagesOption)
    : JOB_COLLECTION_PAGE_CEILING;

  if (typeof nextUrl !== 'function') throw new Error('executeScrapePaginated requires options.nextUrl');
  const domain = extractDomain(nextUrl(0));
  const sourceKey = options.sourceLabel || domain;
  const countItems = (r) => Array.isArray(r)
    ? r.length
    : (r && typeof r === 'object' && Array.isArray(r.items) ? r.items.length : (r ? -1 : 0));

  const pageId = randomUUID();
  let page = null;
  let abortHandler = null;
  const all = [];
  let strongest = null;
  let pagesWalked = 0;
  let stopReason = 'ceiling';
  // Accumulated extraction-yield stats ({ seen, noFields }) across pages, so a
  // partial per-card drop is visible even when items.length stays > 0. For
  // load-more (cumulative DOM) the extractor's counts are already running totals,
  // so replace rather than sum; for real page navigations, sum across pages.
  let aggYieldStats = null;
  // Tracks how many items the extractor had returned before the last "Show
  // more" click — used to slice out only the newly-loaded items so we don't
  // push the full accumulated list on every load-more iteration.
  let loadMorePrevCount = 0;

  try {
    if (isShuttingDown) throw new Error('Browser pool is shutting down');
    page = await createStealthPage();
    pageHandles.set(pageId, { page, startTime: Date.now() });
    if (options.signal) {
      abortHandler = () => safeClose(page, 2000);
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }
    if (referer) {
      await page.evaluateOnNewDocument((ref) => {
        Object.defineProperty(document, 'referrer', { get: () => ref });
      }, referer);
    }

    for (let p = 0; p < maxPages; p++) {
      if (isShuttingDown || options.signal?.aborted) { stopReason = 'aborted'; break; }

      // Load-more mode: p>0 clicks a "Show more" button instead of navigating.
      const useLoadMore = loadMoreSelector != null && p > 0;

      const url = nextUrl(p);
      const { timeoutMs: budgetMs, firstBeatMs } = resolveBudget(sourceKey, timeoutMs);
      const pageStart = Date.now();

      let pageResponse = null;
      if (useLoadMore) {
        // Click the "Show more" button and wait a beat for the XHR to settle.
        const clicked = await page.evaluate((sel) => {
          const btn = document.querySelector(sel);
          if (!btn || btn.disabled) return false;
          btn.click();
          return true;
        }, loadMoreSelector).catch(() => false);
        if (!clicked) { stopReason = 'empty-page'; break; }
        // Fixed pre-poll wait — gives the XHR response time to land before
        // the readiness loop starts counting stable items.
        await new Promise(r => setTimeout(r, 3000));
      } else {
        page.setDefaultNavigationTimeout(Math.max(5000, budgetMs - READINESS.DEFAULT_NAV_HEADROOM_MS));
        try {
          pageResponse = await page.goto(url, { waitUntil: options.waitUntil || 'domcontentloaded', timeout: Math.max(5000, budgetMs - READINESS.NAV_HEADROOM_MS) });
        } catch (e) {
          if (!e?.message?.includes('ERR_ABORTED') && !e?.message?.includes('net::ERR_') && !/timeout/i.test(e?.message || '')) throw e;
        }
        // Cookie/consent banner only appears once per session — dismiss on page 0.
        if (p === 0 && dismissCookies) await dismissCookieBanner(page);
        if (waitFor) {
          try {
            const selectorWait = Math.min(READINESS.SELECTOR_WAIT_MS, Math.max(2000, budgetMs - READINESS.READINESS_HEADROOM_MS));
            await page.waitForSelector(waitFor, { timeout: selectorWait });
          } catch { /* extractor may still find content */ }
        }
        if (scrollFirst) await humanScroll(page, 3); else await humanMouseMove(page);
      }

      // Readiness: poll the extractor until its item count stabilizes (shared
      // READINESS constants with executeScrape). Per-page deadline off pageStart.
      const readinessDeadline = pageStart + budgetMs - READINESS.READINESS_HEADROOM_MS;
      // Load-more: already waited 3s after clicking; seed lastCount at the
      // previous accumulated total so we don't settle before new items arrive.
      if (!useLoadMore) await new Promise(r => setTimeout(r, firstBeatMs));
      let extractorResult = null, lastCount = useLoadMore ? loadMorePrevCount : -2, stableReads = 0, zeroReads = 0, settledPositively = false;
      // See executeScrape's matching evalErrStreak — a persistently-throwing
      // extractor otherwise silently masquerades as "zero results, success."
      let evalErrStreak = 0, lastEvalErrMsg = null;
      while (true) {
        // See executeScrape's matching check — a force-closed page during
        // shutdown would otherwise keep getting polled until the deadline.
        if (isShuttingDown || options.signal?.aborted) break;
        let r = null;
        try { r = await page.evaluate(extractorJS); }
        catch (evalErr) {
          lastEvalErrMsg = evalErr?.message || String(evalErr);
          if (++evalErrStreak === READINESS.STABLE_READS) {
            logger.warn(`[BrowserPool] ${sourceKey} (paginated p${p}): extractor threw ${evalErrStreak}x in a row — "${lastEvalErrMsg}". If this persists, the extractor itself may have a bug, not just a transient mid-navigation eval.`);
          }
        }
        if (r != null) {
          evalErrStreak = 0;
          extractorResult = r;
          const count = countItems(r);
          if (count === -1) break;
          if (count > 0) {
            zeroReads = 0;
            if (count === lastCount) { if (++stableReads >= READINESS.STABLE_READS) { settledPositively = true; break; } }
            else { stableReads = 0; lastCount = count; }
          } else if (++zeroReads >= READINESS.MAX_ZERO_READS) break;
        }
        if (Date.now() >= readinessDeadline) break;
        await new Promise(res => setTimeout(res, READINESS.POLL_MS));
      }
      const stableElapsedMs = settledPositively ? Date.now() - pageStart : null;
      if (extractorResult == null) { try { extractorResult = await page.evaluate(extractorJS); } catch { extractorResult = []; } }
      const allExtracted = Array.isArray(extractorResult)
        ? extractorResult
        : (Array.isArray(extractorResult?.items) ? extractorResult.items : []);
      const pageYieldStats = (extractorResult && !Array.isArray(extractorResult) && extractorResult.yieldStats) || null;
      if (pageYieldStats) {
        if (!aggYieldStats) aggYieldStats = { seen: 0, noFields: 0 };
        if (useLoadMore) {                                  // cumulative counts → take the latest
          aggYieldStats.seen = pageYieldStats.seen || 0;
          aggYieldStats.noFields = pageYieldStats.noFields || 0;
        } else {                                            // per-page counts → sum
          aggYieldStats.seen += pageYieldStats.seen || 0;
          aggYieldStats.noFields += pageYieldStats.noFields || 0;
        }
      }
      // Load-more: the extractor returns all visible DOM items (old + new) — slice
      // to get only the items added by this "Show more" click.
      const pageItems = useLoadMore ? allExtracted.slice(loadMorePrevCount) : allExtracted;
      if (useLoadMore) loadMorePrevCount = allExtracted.length;

      // Anti-bot detection: load-more clicks are in-page XHR (no navigation, no
      // HTTP status, URL unchanged) — skip detector for those iterations and only
      // run it for real page loads.
      let warning = null;
      if (!useLoadMore) {
        try {
          // See readPageContentBounded — clamp to this page's remaining budget
          // so an anti-bot reload loop can't hang past the outer hard timeout.
          const html = await readPageContentBounded(page, (pageStart + budgetMs) - Date.now() - 1500);
          const finalUrl = page.url() || url;
          const status = pageResponse?.status?.() ?? 0;
          warning = detectAntiBotSignal({
            status, finalUrl, html,
            itemsExtracted: allExtracted.length,
            expectedMinItems,
            expectedBodySize: getBodyBaseline(sourceKey),
            sourceLabel: sourceKey,
            // Per-page (not aggregated) stats so seen/itemsExtracted share a basis.
            yieldStats: pageYieldStats,
          });
          if (warning) logger.warn(`[BrowserPool] Anti-bot signal on ${url} (p${p}): ${warning.code} — ${warning.evidence}`);
          else if (allExtracted.length > 0 && html) recordBodySize(sourceKey, String(html).length);
        } catch (e) {
          logger.warn('[BrowserPool] Anti-bot detector failed (non-fatal):', e?.message || String(e));
        }
      }

      // Load-more clicks are not separate HTTP requests — only feed the rate
      // limiter for real navigations so throttle signals aren't inflated.
      const severity = warning?.severity;
      if (!useLoadMore) {
        recordOutcome(domain, severity === 'block' ? 'block' : severity === 'throttle' ? 'throttle' : 'ok');
        if (stableElapsedMs != null && severity !== 'block') recordReady(sourceKey, stableElapsedMs);
      }

      if (warning && (!strongest || (warning.severity === 'block' && strongest.severity !== 'block'))) strongest = warning;
      all.push(...pageItems);
      pagesWalked = p + 1;

      if (severity === 'block') { stopReason = 'blocked'; break; }     // never paginate into a wall

      // Caller decides the date-cutoff / no-new-jobs stop.
      let decision = null;
      if (onPageScraped) {
        try { decision = await onPageScraped({ items: pageItems, warning, pageIndex: p }); }
        catch (e) { logger.warn('[BrowserPool] onPageScraped threw (non-fatal):', e?.message || String(e)); }
      }
      if (decision?.stop) { stopReason = decision.reason || 'caller-stop'; break; }
      if (p + 1 >= maxPages) { stopReason = 'ceiling'; break; }

      // Human "reading" pause before turning the page; longer if throttled.
      let delay = jitteredDelay(pageDelayMs[0], pageDelayMs[1]);
      if (severity === 'throttle') delay *= 2;
      await new Promise(r => setTimeout(r, delay));
    }
  } catch (error) {
    const isAborted = options.signal?.aborted || error?.message === 'Aborted' || isShuttingDown;
    if (!isAborted) {
      logger.error(`[BrowserPool] Paginated scrape failed for ${sourceKey}:`, error);
      recordOutcome(domain, 'error');
    }
    if (all.length === 0) {
      // Fold timeout page-state into the error before we close the page, so a
      // 0-gather paginated timeout is as diagnosable as the single-page path.
      if (!isAborted) await enrichTimeoutError(page, error);
      pageHandles.delete(pageId);
      if (options.signal && abortHandler) options.signal.removeEventListener('abort', abortHandler);
      await safeClose(page, 2000);
      throw error;   // total failure with nothing gathered → surface it
    }
    stopReason = isAborted ? 'aborted' : 'error';   // partial gather → keep what we have
  } finally {
    if (options.signal && abortHandler) options.signal.removeEventListener('abort', abortHandler);
    pageHandles.delete(pageId);
    await safeClose(page, 2000);
  }

  return { data: all, warning: strongest, pagesWalked, stopReason, yieldStats: aggYieldStats };
}

// ── Process Exit Cleanup ────────────────────────────────────────────────────
/**
 * Forcefully close all active pages in the pool.
 * Called during application shutdown.
 */
export async function closeAllPages() {
  isShuttingDown = true;
  if (queuePoller) {
    clearTimeout(queuePoller);
    queuePoller = null;
  }

  // Reject every task still waiting in the queue — closeAllPages previously
  // only closed pages already tracked in pageHandles. A queued-but-never-
  // dispatched task's promise was never settled: if a lingering
  // scheduleQueueWake/REQUEUE_DELAY_MS timer later called processQueue()
  // and dispatched it, executeScrape's pre-launch isShuttingDown throw was
  // silently swallowed by the `if (!isShuttingDown) reject(err)` guard in
  // processQueue's catch — leaving the caller's promise hanging forever.
  const queued = queue.splice(0, queue.length);
  for (const task of queued) {
    task.reject(new Error('Browser pool is shutting down'));
  }

  const handles = Array.from(pageHandles.values());
  pageHandles.clear();

  logger.info(`[BrowserPool] Closing ${handles.length} active pages (${queued.length} queued task(s) cancelled) during shutdown...`);

  await Promise.allSettled(handles.map(async ({ page }) => {
    await safeClose(page, 1000);
  }));
}

// Diagnostic-only: Node's synchronous 'exit' event can't await page.close()
// (a Promise), so this can log an orphaned page but can't actually clean one
// up — real cleanup depends entirely on closeAllPages() being called from
// main.js's before-quit handler before the process exits.
process.on('exit', () => {
  for (const { page } of pageHandles.values()) {
    try {
      if (!page.isClosed()) {
        logger.info('[BrowserPool] Orphaned page detected on exit (not closed — see comment above)');
      }
    } catch { /* ignore */ }
  }
});

// Stable per-AbortSignal id for cache-key purposes (see queueScrape below) —
// AbortSignal has no natural string identity, and two callers sharing a
// cache key must NOT be coupled unless they're also sharing the same signal.
const signalIds = new WeakMap();
let nextSignalId = 1;
function idFor(signal) {
  if (!signal) return 'none';
  let id = signalIds.get(signal);
  if (!id) {
    id = nextSignalId++;
    signalIds.set(signal, id);
  }
  return id;
}

/**
 * Queue a single scrape task. Respects the (adaptive) global concurrency cap.
 * @param {string} url
 * @param {string} extractorJS — JS string to evaluate in page context
 * @param {object} [options] — { timeoutMs, waitFor, scrollFirst, dismissCookies, referer, sourceLabel }
 * @returns {Promise<any>}
 */
export function queueScrape(url, extractorJS, options = {}) {
  // Deduplication: if an identical task is already processing (queued OR
  // active), reuse its promise. Must cover every field that changes the
  // task's behavior or result shape — omitting sourceLabel/paginate/timeoutMs/
  // referer/signal previously let two calls that only differed in one of
  // those get incorrectly coupled: the SECOND caller's own options (including
  // its AbortSignal) were silently discarded in favor of the FIRST caller's,
  // so the second caller's abort did nothing, while the first caller's abort
  // would reject every deduped caller — even ones that never asked to
  // cancel. Including the signal's identity means two callers only dedupe
  // when they're also sharing the same signal (e.g. all tasks in one
  // scrapeMultiple() batch, which do), not just coincidentally targeting the
  // same URL from unrelated call sites.
  const cacheKey = [
    url, extractorJS,
    options.sourceLabel || '',
    options.paginate ? 1 : 0,
    options.timeoutMs || 0,
    options.referer || '',
    options.scrollFirst || false,
    idFor(options.signal),
  ].join('|');

  if (activeTasks.has(cacheKey)) {
    return activeTasks.get(cacheKey);
  }

  let onAbort;
  const promise = new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error('Aborted'));
    
    if (options.signal) {
      onAbort = () => {
        const idx = queue.findIndex(t => t.resolve === resolve);
        if (idx !== -1) {
          queue.splice(idx, 1);
          reject(new Error('Aborted'));
        }
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // We intentionally don't handle chained resolves manually anymore,
    // since everyone shares this one root promise returned from the map!
    queue.push({ url, extractorJS, options, resolve, reject });
    processQueue();
  }).finally(() => {
    if (options.signal && onAbort) {
      options.signal.removeEventListener('abort', onAbort);
    }
    // Once settled (success or failure), remove from active map so future requests run fresh.
    activeTasks.delete(cacheKey);
  });

  activeTasks.set(cacheKey, promise);
  return promise;
}

/**
 * Queue multiple scrape tasks. All go through the concurrency limiter.
 * @param {Array<{id: string, url: string, extractorJS: string, options?: object}>} tasks
 * @returns {Promise<Array<{id: string, success: boolean, data?: any, warning?: object, error?: string}>>}
 *
 * Each result now carries an optional `warning` from antiBotDetector — surfaced
 * up the stack via the onProgress callback and the final return so callers
 * can show "this source was likely blocked/throttled" instead of silently
 * accepting an empty extractor result.
 */
export async function scrapeMultiple(tasks, onProgress = null, signal = null) {
  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      try {
        if (signal?.aborted) throw new Error('Aborted');
        // executeScrape/queueScrape now return { data, warning }; preserve
        // both on the per-task result.
        const wrapped = await queueScrape(task.url, task.extractorJS, { ...task.options, signal, sourceLabel: task.id });
        const data = wrapped?.data ?? null;
        const warning = wrapped?.warning ?? null;
        const result = { id: task.id, success: true, data, warning, yieldStats: wrapped?.yieldStats ?? null };
        // Paginated tasks also report how far they walked and why they stopped.
        if (wrapped && wrapped.pagesWalked != null) {
          result.pagesWalked = wrapped.pagesWalked;
          result.stopReason = wrapped.stopReason;
        }
        onProgress?.(result);
        return result;
      } catch (err) {
        const result = { id: task.id, success: false, error: err?.message || 'Unknown error' };
        onProgress?.(result);
        throw err;
      }
    })
  );

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { id: tasks[i].id, success: false, error: r.reason?.message || 'Unknown error' };
  });
}
