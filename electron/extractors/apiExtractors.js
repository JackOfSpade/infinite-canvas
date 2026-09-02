/**
 * API-Based Job Extractors — LinkedIn, USAJobs, RemoteOK, WeWorkRemotely, Dice,
 * plus the Indeed HTML-extraction helper shared with the browser-based scraper.
 *
 * These bypass Puppeteer entirely, using plain HTTP fetch() against
 * publicly accessible JSON APIs or hidden HTML endpoints.
 * Zero WAF risk, structured data, no auth needed.
 *
 * All functions return the standard job shape:
 *   { title, company, location, salary, snippet, url, posted, source }
 */
import { logger } from '../logger.js';
import { getRandomUA, refreshDiceApiKey, getStealthBrowser, getStealthBrowserInfo } from '../ipc/stealthBrowser.js';
import { humanDelay } from '../utils/humanDelay.js';
import { getDiceApiKey } from '../ipc/settings.js';
import { htmlToText } from 'html-to-text';
import { JSDOM } from 'jsdom';
import { resolveBudget } from '../ipc/scrapeBudget.js';
import { safeApiFetch } from '../ipc/antiBotDetector.js';
import { filterJobsByAge } from '../ipc/jobDateFilter.js';
import { sourceJobKey, jobTitleCompanyLocationKey } from '../../src/utils/jobIdentity.js';
import { isPriceChartingApplicable, isAptDecoApplicable } from '../../src/utils/compSourceScope.js';
import { parseSalaryToNumeric } from '../../src/nodes/jobsearch/buildJobTree.js';
import { decodeHtmlEntities, repairMojibake } from '../../src/utils/textEncoding.js';

// Per-source API fetch timeouts. These are SEEDS / ceilings, read through the
// shared scrapeBudget store so they live in one place and share the budget
// machinery used by the browser scrape path. NOTE: unlike the browser path
// these are single-shot fetches with no "time to stable" to learn from, so
// they're not actively learned yet — this indirection removes the scattered
// magic literals and leaves a single hook to switch on learning later.
const API_TIMEOUT_SEEDS = {
  'linkedin-api':   10000,
  'usajobs-api':    10000,
  'remoteok-api':   10000,
  'wwr-api':        10000,
  'reverb-api':     12000,
  'pricecharting-api': 10000,
  'aptdeco-api':    10000,
  'dice-api':       10000,
};

/** Resolve an API fetch timeout from its seed via the shared budget store. */
function apiTimeout(key) {
  return resolveBudget(key, API_TIMEOUT_SEEDS[key] ?? 10000).timeoutMs;
}


/**
 * Combines an IPC abort signal (for window closes) with a hard timeout.
 * Prevents fetch requests from hanging forever if the backend drops connection.
 */
function createTimeoutSignal(baseSignal, timeoutMs) {
  // Electron's bundled Chromium/Node always provides AbortSignal.any/.timeout, so
  // combine the IPC abort signal (window close) with a hard timeout directly.
  // (A legacy manual-AbortController fallback used to live here but was both
  // unreachable on supported runtimes and leaked its setTimeout on the happy path.)
  return AbortSignal.any([baseSignal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
}

/**
 * A tiny bespoke HTML stripper for snippets (no heavy external dom parser)
 * Real rendering to markdown is handled in python/gemini stages if needed.
 */
function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  try {
    return htmlToText(html, { wordwrap: false, selectors: [] });
  } catch {
    return String(html).replace(/<[^>]*>?/gm, ''); // Fallback regex stripping
  }
}

// ── LinkedIn Hidden API ─────────────────────────────────────────────────────
/**
 * Why one LinkedIn query's page walk stopped — the pure decision behind the
 * loop, so it is testable without a network round trip.
 *
 *   'exhausted'      — the page carried no well-formed cards at all.
 *   'no-new-rows'    — cards were present but none were new TO THIS QUERY, i.e.
 *                      the pager stopped advancing.
 *   'result-ceiling' — the offset budget ran out with the query still yielding.
 *   null             — keep walking.
 *
 * The critical distinction is that a page whose rows were all already returned
 * by an EARLIER QUERY is none of these. Freshness used to be measured against
 * the run-wide dedup set, so ordinary cross-query overlap — the expected case,
 * since the generator emits several near-synonym queries — read as exhaustion
 * and ended the walk on page 1, reported as "results exhausted".
 *
 * @param {{cardsOnPage: number, newToThisQuery: number, nextStart: number, maxResults: number}} state
 * @returns {'exhausted'|'no-new-rows'|'result-ceiling'|null}
 */
export function linkedInPageStopReason({
  cardsOnPage,
  newToThisQuery,
  unproductiveStreak = 0,
  maxUnproductivePages = LINKEDIN_MAX_UNPRODUCTIVE_PAGES,
  nextStart,
  maxResults,
} = {}) {
  if (!(cardsOnPage > 0)) return 'exhausted';
  if (!(newToThisQuery > 0)) return 'no-new-rows';
  // Freshness-to-this-query proves the PAGER is advancing, but not that the walk
  // is still producing OUTPUT. A query almost fully covered by an earlier one
  // keeps yielding new-to-this-query cards that are all run-wide duplicates, so
  // without this it would spend its entire offset budget adding zero rows. Two
  // consecutive unproductive pages is the signal; one is normal (a page can be
  // fully covered while the next is not).
  if (unproductiveStreak >= maxUnproductivePages) return 'redundant-query';
  if (Number.isFinite(nextStart) && Number.isFinite(maxResults) && nextStart >= maxResults) return 'result-ceiling';
  return null;
}

/**
 * Consecutive pages that may add zero NEW OUTPUT before a query's walk gives up.
 * Bounds the cost of a query whose results an earlier query already returned.
 */
const LINKEDIN_MAX_UNPRODUCTIVE_PAGES = 2;

/**
 * Offset ceiling for one LinkedIn query's walk (6 pages x 25). The binding
 * constraint is not LinkedIn's own result cap but our enrichment budget: every
 * gathered row costs one browser navigation in
 * enrichLinkedInDescriptionsBrowser, which feeds the rate-limit wall. Raising
 * this without also raising MAX_CONTEXT_ROTATIONS trades breadth for a block.
 */
const LINKEDIN_MAX_RESULTS = 150;

// Public endpoint: linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
// Returns HTML snippets of job cards — no auth, no page rendering needed.
// Paginates in increments of 25 via the `start` parameter.

/**
 * Fetch jobs from LinkedIn's public API endpoint (no login needed).
 * Accepts a single query string or an array of up to 3 query strings.
 * Multiple queries are walked sequentially with an inter-query jitter pause
 * and deduplicated by job URL so the same posting isn't returned twice.
 *
 * @param {(payload: { completed: number, total: number, count: number, detail: string }) => void} [onProgress]
 *   Optional heartbeat, called at each query boundary and after every page is
 *   fetched+parsed. The multi-minute humanDelay-paced walk below otherwise emits
 *   nothing until the whole function resolves — a false "hung" read downstream
 *   (see fetchHttpSources). Never throws into the scrape.
 */
export async function fetchLinkedInJobs(queries, signal = null, maxAgeDays = null, location = '', onProgress = null) {
  const locParam = String(location || '').trim();
  const queryList = Array.isArray(queries) ? queries : [queries];
  const seenUrls = new Set();
  const allJobs = [];
  let warning = null;
  // Per-query walk outcomes, so a ceiling-truncated source is distinguishable
  // from an exhausted one in the bug report (see the return value below).
  const queryStopReasons = [];

  for (let qi = 0; qi < queryList.length; qi++) {
    if (signal?.aborted) break;
    // Stop querying if a previous query was blocked — subsequent ones will be too.
    if (warning) break;
    // Inter-query pause (not before the first query). humanDelay gives a
    // log-normal spread around the anchor so a multi-query walk doesn't look
    // like a fixed drumbeat (anchor ≈ the old 3–6s uniform window's midpoint).
    if (qi > 0) await new Promise(res => setTimeout(res, humanDelay(4500)));

    const query = queryList[qi];
    // Query-boundary heartbeat — see onProgress doc above.
    try {
      onProgress?.({ completed: qi, total: queryList.length, count: allJobs.length, detail: `q${qi + 1}/${queryList.length}` });
    } catch {
      // Progress callback is diagnostics-only — never let it break the scrape.
    }
    // Walk up to 150 results (6 pages × 25). LinkedIn's guest API is heavily
    // anti-bot, so depth is PACED, not blitzed:
    //   • a humanDelay log-normal gap (~6s anchor) before each page after the first
    //     (a fixed 2s drumbeat is a tell — an organically-spread cadence is the
    //     main signal we control),
    //   • an early-exit the moment a page returns no cards, or no card this
    //     QUERY has not already seen (below), so a low-volume query never walks
    //     all 6 pages — we only go deep when results justify it. Freshness is
    //     deliberately per-query: measuring it against the run-wide dedup set
    //     ended a query's walk whenever an earlier query had already returned
    //     that page's rows, which is the normal case, not an edge case,
    //   • bail on the first block/non-OK (below), returning whatever we gathered so
    //     far rather than hammering through and turning a soft throttle into a 0.
    // Freshness is tracked per query; `seenUrls` remains the run-wide OUTPUT
    // dedup so the same posting is never returned twice across queries.
    const seenInThisQuery = new Set();
    let stopReason = null;
    let unproductiveStreak = 0;
    for (let start = 0; start < LINKEDIN_MAX_RESULTS; start += 25) {
      if (signal?.aborted) break;
      // Human-scale log-normal pause before each subsequent page.
      if (start > 0) await new Promise(res => setTimeout(res, humanDelay(6000)));
      const params = new URLSearchParams({
        keywords: query,
        start: String(start),
        sortBy: 'R', // explicit relevance (= LinkedIn's default; the value its own UI sends, so anti-bot-neutral)
      });
      // Target location → LinkedIn guest API's `location` filter. Without it a
      // location-free query searched nationwide (how Miami corporate roles
      // surfaced for a Denver search). Empty → omitted (nationwide).
      if (locParam) params.set('location', locParam);
      // LinkedIn's "Time Posted" filter takes seconds (`r604800` = past week)
      if (maxAgeDays && maxAgeDays > 0) {
        params.set('f_TPR', `r${Math.floor(maxAgeDays * 86400)}`);
      }

      const r = await safeApiFetch(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`, {
        headers: {
          'Accept': 'text/html',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Referer': 'https://www.linkedin.com/jobs/search/',
        },
        signal: createTimeoutSignal(signal, apiTimeout('linkedin-api')),
      }, 'linkedin');

      // First detected warning wins — the rest of the loop bails. LinkedIn is
      // a heavy anti-bot source so if page 0 is blocked, page 1 will be too.
      if (r.warning && !warning) warning = r.warning;
      if (!r.ok) {
        logger.warn(`[LinkedIn API] Query ${qi + 1}/${queryList.length} page ${start / 25} returned ${r.status}${r.warning ? ` (${r.warning.code})` : ''}`);
        stopReason = 'blocked';
        break;
      }

      const html = r.text;
      if (!html || html.trim().length < 50) { stopReason = 'empty-response'; break; }

      // Parse HTML snippets with regex — LinkedIn returns <li> cards
      // Each card has: title in <h3>, company in <h4>, location, link, datetime
      const cardPattern = /<li[\s\S]*?<\/li>/gi;
      const cards = html.match(cardPattern) || [];

      let pageUrlMisses = 0;
      // Run-wide output count before this page, so the productivity stop below
      // can tell "the pager advanced" from "the walk actually gained rows".
      const before = allJobs.length;
      // Freshness must be measured PER QUERY, not against the run-wide seenUrls
      // set. `seenUrls`/`allJobs` span every query, so a page made entirely of
      // cards an earlier query already returned would add nothing to
      // `allJobs.length` and trip the exhaustion break below — ending THIS
      // query's walk on page 1. Heavy page-1 overlap is the expected case
      // (the generator emits 2-3 exact-title plus 3-5 adjacent-role queries),
      // and the old behaviour reported it as "results exhausted".
      let cardsOnPage = 0;
      let newToThisQuery = 0;
      for (const card of cards) {
        try {
          const titleMatch = card.match(/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i) ||
                             card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
          const companyMatch = card.match(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) ||
                               card.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i);
          const locationMatch = card.match(/<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
          // Try multiple href-extraction strategies in order of specificity:
          // 1. class="base-card__full-link" followed by href (common order)
          // 2. href followed by class="base-card__full-link" (reversed attribute order)
          // 3. Any absolute linkedin.com/jobs/view href
          // 4. Any relative /jobs/view href → prepend domain
          const linkMatch =
            card.match(/<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/i) ||
            card.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*base-card__full-link[^"]*"/i) ||
            card.match(/href="(https:\/\/www\.linkedin\.com\/jobs\/view\/[^"]+)"/i) ||
            card.match(/href="(\/jobs\/view\/[^"?]+)/i);
          const dateMatch = card.match(/<time[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/i);

          const title = stripHtml(titleMatch?.[1] || '').trim();
          if (!title) continue;
          // A well-formed card counts toward "did this page return anything at
          // all", independently of whether we keep it — that is what separates
          // true exhaustion from a page of cross-query repeats.
          cardsOnPage++;

          let rawUrl = linkMatch?.[1]?.split('?')[0] || '';
          // Normalize relative /jobs/view/ paths to absolute URLs
          if (rawUrl.startsWith('/')) rawUrl = `https://www.linkedin.com${rawUrl}`;
          const url = rawUrl;
          if (!url) pageUrlMisses++;
          if (url && !seenInThisQuery.has(url)) {
            seenInThisQuery.add(url);
            newToThisQuery++;
          }
          if (url && seenUrls.has(url)) continue; // cross-query dedup by job URL
          if (url) seenUrls.add(url);

          // LinkedIn cards occasionally include a short description excerpt in
          // <p class="job-search-card__snippet">. It's ~100–200 chars — not a
          // full JD, but better than nothing and costs zero extra requests.
          const snippetMatch = card.match(/<p[^>]*class="[^"]*job-search-card__snippet[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
          const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : '';

          allJobs.push({
            title,
            company: stripHtml(companyMatch?.[1] || companyMatch?.[2] || '').trim(),
            location: stripHtml(locationMatch?.[1] || '').trim(),
            salary: '',
            snippet,
            url,
            posted: dateMatch?.[2] ? stripHtml(dateMatch[2]).trim() : (dateMatch?.[1] || ''),
            source: 'linkedin',
          });
        } catch {
          // Skip malformed cards
        }
      }

      // Log URL extraction misses so we can diagnose degraded card HTML.
      if (pageUrlMisses > 0) {
        logger.warn(`[LinkedIn API] Query ${qi + 1} page ${start / 25}: ${pageUrlMisses} card(s) had no extractable URL`);
      }

      // Page-boundary heartbeat — see onProgress doc above.
      try {
        onProgress?.({ completed: qi, total: queryList.length, count: allJobs.length, detail: `q${qi + 1}/${queryList.length} · p${start / 25 + 1}` });
      } catch {
        // Progress callback is diagnostics-only — never let it break the scrape.
      }

      // Two genuinely different stop conditions, kept apart so the report can
      // say which one happened:
      //   • no well-formed cards at all → results exhausted (or a soft block
      //     served an empty shell);
      //   • cards present but none new TO THIS QUERY → the pager has stopped
      //     advancing (LinkedIn re-serving the same offset).
      // A page whose rows were all already returned by an EARLIER QUERY is
      // neither — it is normal overlap, and the walk continues.
      // Did this page add anything to the RUN's output (not merely to this
      // query's seen set)? `before` is captured above, per page.
      if (allJobs.length > before) unproductiveStreak = 0;
      else unproductiveStreak++;
      const pageStop = linkedInPageStopReason({
        cardsOnPage,
        newToThisQuery,
        unproductiveStreak,
        nextStart: start + 25,
        maxResults: LINKEDIN_MAX_RESULTS,
      });
      if (pageStop) {
        stopReason = pageStop;
        if (pageStop !== 'result-ceiling') break;
      }
    }
    if (stopReason) queryStopReasons.push({ query, stopReason });
  }

  // `gathered` is the pre-user-limit match count. jobs.js applies the persisted
  // per-platform allowance centrally so every source shares the same semantics.
  //
  // `stopReasons` + `cap` make a ceiling-truncated walk distinguishable from an
  // exhausted one. Without them a query stopped by LINKEDIN_MAX_RESULTS and a
  // query that genuinely ran out both reported the same thing, and `capOverflow`
  // in jobs.js could never fire because `gathered` was already the truncated
  // number. Observation only — nothing downstream branches on it.
  const ceilingBound = queryStopReasons.some(r => r.stopReason === 'result-ceiling');
  return {
    items: allJobs,
    warning,
    gathered: allJobs.length,
    stopReasons: queryStopReasons,
    cap: ceilingBound ? { type: 'source-internal', limit: LINKEDIN_MAX_RESULTS } : null,
  };
}

/**
 * Browser-based second-pass enrichment for LinkedIn job descriptions.
 *
 * LinkedIn returns HTTP 999 to plain Node.js fetch(), so plain HTTP is a dead
 * end. This function reuses the already-running shared stealth browser
 * (getStealthBrowser), opens ONE new page (tab), navigates it sequentially
 * through each job URL, extracts the JobPosting JSON-LD description, and
 * closes the tab when done. No browser launch/close overhead per job.
 *
 * Stops immediately if a login wall is detected (LinkedIn starts requiring
 * auth after N rapid navigations). Logs how many succeeded before the wall.
 *
 * @param {Array}       jobs   — deduped job objects from fetchLinkedInJobs
 * @param {AbortSignal} signal — propagated abort signal
 * @returns {Promise<{ jobs: Array, loginWall: boolean, loginWallUrl: string|null }>}
 *   jobs       — same jobs array with description + snippet where extractable
 *   loginWall  — true if enrichment was stopped by a LinkedIn auth redirect
 *   loginWallUrl — the redirect URL that triggered the wall (for error surfacing)
 */
/**
 * Is the current egress (the system network / VPN) actually online? Node fetch
 * rides the same uplink as the stealth browser, so this reflects what the browser
 * can reach. Returns true if ANY HTTP response comes back (DNS+TCP+TLS worked) —
 * status is irrelevant; we only care that the pipe is alive — and false on
 * timeout / network error. Tries a couple of fast, neutral endpoints (first win)
 * and bails instantly if the caller aborts (reset / window close).
 *
 * Why this exists: when a VPN switch lands on a dead server (no internet), every
 * guest job navigation silently times out (15s each) and the pass grinds through
 * hundreds of jobs with NO log output — indistinguishable from a hang. One probe
 * tells a dead uplink apart from a LinkedIn rate-limit wall (where requests DO
 * succeed and LinkedIn serves an authwall), so we can stop and ask the user to
 * switch to a working VPN server instead of stalling.
 */
export async function probeInternet(signal, timeoutMs = 5000) {
  if (signal?.aborted) return true; // caller bailing — don't misreport as offline
  const urls = ['https://www.google.com/generate_204', 'https://api.ipify.org'];
  for (const url of urls) {
    let timer = null;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    try {
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      await fetch(url, { signal: ctrl.signal });
      return true; // a response of any status means the uplink is alive
    } catch {
      if (signal?.aborted) return true; // aborted, not offline
      // try the next endpoint
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }
  return false;
}

// getStealthBrowser deliberately rejects while a visible login/captcha window owns
// the one shared Chrome profile.  This is not a LinkedIn clean pass: the caller
// must keep the source retryable instead of interpreting the unchanged jobs as
// fully enriched.
export function linkedInBrowserUnavailableResult(jobs, error) {
  const browserError = error?.message || String(error || 'Unknown shared-browser error');
  const profileReserved = /shared browser profile is reserved/i.test(browserError);
  return {
    jobs,
    loginWall: false,
    loginWallUrl: null,
    browserUnavailable: true,
    profileReserved,
    retryable: true,
    browserError,
    successCount: 0,
    attempted: 0,
    contextRotations: 0,
  };
}

export async function enrichLinkedInDescriptionsBrowser(jobs, signal, { preferAuthenticated = false } = {}) {
  if (!jobs?.length) return { jobs, loginWall: false, loginWallUrl: null };

  // Count jobs without URLs before touching the browser — these are silently
  // skipped in the loop and would otherwise make the success rate look wrong.
  const noUrlCount = jobs.filter(j => !j.url).length;
  if (noUrlCount > 0) {
    logger.warn(`[LinkedIn/Browser] ${noUrlCount}/${jobs.length} jobs have no URL — will be skipped in enrichment`);
  }

  // Fast-fail if the egress IP has no internet at all (e.g. a VPN switch that
  // landed on a dead server). Without this, every navigation below times out
  // silently and the pass looks hung; instead we return noInternet so the caller
  // can ask the user to switch to a working VPN server. The mid-run detector in
  // the loop catches an uplink that dies partway through.
  if (!(await probeInternet(signal))) {
    logger.warn('[LinkedIn/Browser] Connectivity probe failed before enrichment — egress IP appears offline. Skipping; user should switch VPN to a working server.');
    return { jobs, loginWall: false, loginWallUrl: null, noInternet: true, successCount: 0, attempted: 0, contextRotations: 0 };
  }

  let browser;
  try {
    browser = await getStealthBrowser();
  } catch (err) {
    logger.warn(`[LinkedIn/Browser] Cannot get shared browser for enrichment: ${err.message}`);
    return { ...linkedInBrowserUnavailableResult(jobs, err), usedAuthenticated: preferAuthenticated, authenticatedFallback: false };
  }
  // Browser-process identity for this pass. Returned to the caller so the bug
  // report's egress-IP trail can show whether consecutive passes ran on the SAME
  // browser instance — the discriminator for "browser/session-based limit vs
  // per-IP": if the IP changes but the limit doesn't recover within one browser
  // generation, it's the browser; if a relaunch (new generation) on the same IP
  // recovers it, it's the browser too — not the IP.
  const browserInfo = getStealthBrowserInfo();

  // Prefer the user's verified LinkedIn session when one is available. The old
  // implementation *always* created an isolated context, explicitly discarding
  // that session and consequently reporting a healthy LinkedIn login alongside
  // repeated "guest wall" Solve passes. Authenticated pages are an SPA and may
  // not expose JSON-LD at DOMContentLoaded, but their rendered description is
  // available through the selector fallback below after a short hydration wait.
  //
  // If the authenticated page does not yield a description (a stale session,
  // changed layout, or an individual restricted listing), fall back once to the
  // established cookie-free SEO path. That preserves recovery for users without
  // a session without silently treating a cached `connected` verdict as proof.
  // Guest contexts remain isolated so their cookies never contaminate the saved
  // Chrome profile. Stealth flags (UA, WebGL, etc.) still apply in both modes.
  //
  // Context rotation (the wall lever): LinkedIn walls anonymous guest access to
  // job-view pages after ~4 requests. If that ceiling is tracked per guest
  // *session* (cookies on the isolated context) rather than per IP, recreating
  // the context resets it — letting us stay on the clean JSON-LD path without
  // logging in. We rotate reactively: on a wall, spin up a fresh context and
  // retry the job. If a FRESH context walls before completing any job, the limit
  // is IP/fingerprint-based (rotation can't help) and we stop.
  const MAX_CONTEXT_ROTATIONS = 80; // safety cap (~255 jobs / ~4 per ctx ≈ 64)
  let isolatedCtx = null;
  let authenticatedPage = null;
  let page = null;
  let mode = preferAuthenticated ? 'authenticated' : 'guest';
  let authenticatedFallback = false;
  let contextRotations = 0;
  let jobsThisContext = 0; // completed (non-walling) navigations on the current context
  const rotateContext = async () => {
    await isolatedCtx?.close().catch(() => {});
    isolatedCtx = await browser.createBrowserContext();
    page = await isolatedCtx.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    jobsThisContext = 0;
  };
  const applyGuestFallback = async (reason) => {
    if (mode !== 'authenticated') return false;
    logger.info(`[LinkedIn/Browser] authenticated description path unavailable (${reason}); falling back to guest SEO context`);
    await authenticatedPage?.close().catch(() => {});
    authenticatedPage = null;
    mode = 'guest';
    authenticatedFallback = true;
    await rotateContext();
    return true;
  };
  try {
    if (mode === 'authenticated') {
      authenticatedPage = await browser.newPage();
      page = authenticatedPage;
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    } else {
      await rotateContext(); // initial context (contextRotations stays 0 — see below)
    }
  } catch (err) {
    logger.warn(`[LinkedIn/Browser] Cannot open tab for enrichment: ${err.message}`);
    await isolatedCtx?.close().catch(() => {});
    return { jobs, loginWall: false, loginWallUrl: null };
  }

  const enriched = [...jobs];
  let successCount = 0;
  let navErrors = 0;
  let noDesc = 0;
  // no-desc splits two ways and the distinction decides whether the residual is
  // permanent or recoverable: a real LinkedIn job page ALWAYS carries JobPosting
  // JSON-LD (SEO — see the JSON-LD comment below), so pageTitle="" + 0 JSON-LD is
  // a rate-limit soft-block serving a gutted page (recoverable on a later pass),
  // NOT a posting that genuinely has no description. Only the latter is permanent.
  let noDescSoftBlock = 0; // title="" && 0 JSON-LD — gutted page, retryable
  let noDescGenuine = 0;   // had JSON-LD / a title but no description text — permanent
  let evalErrors = 0;
  // Dead-egress detection. A run of network-level nav failures (15s timeouts /
  // net::ERR_*) means the VPN IP went offline mid-pass — NOT a LinkedIn wall. We
  // probe to confirm, then stop with noInternet so we don't silently grind every
  // remaining job through a 15s timeout (which reads as a hang).
  let noInternet = false;
  let stoppedNoInternetAt = null;
  let consecutiveNavErrors = 0;
  const NO_INTERNET_NAV_ERRORS = 2; // consecutive network failures → probe & confirm
  let loginWallAt = null;
  // The exact URL LinkedIn redirected to when a wall was detected — returned
  // to the caller so it can surface a user-actionable error on the source card.
  let loginWallUrl = null;
  // Capture the first failure's URL + reason for ring-buffer diagnostics.
  let firstFailNote = null;
  // Consecutive eval-error counter. LinkedIn's JS-redirect soft block causes
  // page.evaluate() to throw by navigating away before the evaluate context
  // resolves — the HTTP-redirect login wall check passes because page.url()
  // is still the jobs/view URL at that moment. 3+ in a row = stop.
  let consecutiveEvalErrors = 0;
  const JS_REDIRECT_WALL_THRESHOLD = 3;
  // Count unique candidate rows that were actually navigated. The former
  // index-based value excluded the walling row, included URL-less rows, and
  // became misleading after a context rotation retried the same URL.
  const attemptedIndexes = new Set();

  // Shared login-wall URL pattern. Applied to both the pre-evaluate finalUrl
  // (HTTP redirects) and the post-evaluate page.url() (JS redirects).
  const LOGIN_WALL_RE = /\/(login|uas\/|checkpoint|authwall|signup|join|session)\b/i;

  // Wall handler: rotate the guest context and retry, OR stop. Returns true if
  // the caller should STOP (set loginWallAt first); false means "rotated, retry
  // this job" (caller does i--; continue). A fresh context that walls before
  // completing any job ⇒ IP-based limit ⇒ stop (rotation is futile).
  const handleWall = async (wallUrl, atIndex) => {
    if (contextRotations > 0 && jobsThisContext === 0) {
      loginWallAt = atIndex;
      loginWallUrl = wallUrl;
      logger.warn(`[LinkedIn/Browser] wall persists on a FRESH guest context (job ${atIndex + 1}, after ${contextRotations} rotation(s)) — IP/fingerprint-based limit, rotation can't help. Stopping.`);
      return true;
    }
    if (contextRotations >= MAX_CONTEXT_ROTATIONS) {
      loginWallAt = atIndex;
      loginWallUrl = wallUrl;
      logger.warn(`[LinkedIn/Browser] hit max ${MAX_CONTEXT_ROTATIONS} context rotations — stopping.`);
      return true;
    }
    logger.info(`[LinkedIn/Browser] guest wall at job ${atIndex + 1} after ${jobsThisContext} job(s) on this context — rotating guest context (#${contextRotations + 1}) and retrying`);
    contextRotations++;
    await rotateContext();
    consecutiveEvalErrors = 0; // fresh context — reset the eval-error streak
    return false;
  };

  try {
    for (let i = 0; i < enriched.length; i++) {
      if (signal?.aborted) break;
      const job = enriched[i];
      if (!job.url) continue;

      // Set only once this job's navigation actually completed, so the tally
      // below counts what its name says. A nav error means the page never
      // loaded — counting it would make a fresh context look "productive" and
      // silently disable the IP-limit stop in handleWall.
      let navOk = false;

      try {
        attemptedIndexes.add(i);
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        navOk = true;

        const finalUrl = page.url();
        consecutiveNavErrors = 0; // a navigation completed → the uplink is alive

        // HTTP-redirect login wall: LinkedIn changed the URL to an auth page.
        if (LOGIN_WALL_RE.test(finalUrl)) {
          if (await applyGuestFallback('authenticated session redirected to an auth page')) {
            i--; continue;
          }
          if (await handleWall(finalUrl, i)) break;
          i--; continue; // retry this job on the fresh context
        }

        // The authenticated LinkedIn app hydrates its description after
        // DOMContentLoaded; the guest SEO page already has JSON-LD and doesn't
        // need this wait. A bounded wait is substantially cheaper than throwing
        // away the user's session for every job.
        if (mode === 'authenticated') {
          await page.waitForFunction(() => {
            const selectors = ['#job-details', '.jobs-description-content__text', '.jobs-description__content', '.jobs-box__html-content'];
            return selectors.some(sel => (document.querySelector(sel)?.textContent || '').trim().length > 50);
          }, { timeout: 4000 }).catch(() => {});
        }

        // Description extractor — runs inside the page context (no closures).
        // Tries JSON-LD first (server-rendered for SEO / unauthenticated crawlers),
        // then falls back to CSS selectors covering both the guest page layout and
        // the authenticated React SPA layout. Returns ldCount + ldTypes so the
        // no-desc log is self-diagnosing without a separate browser session.
        const extractDesc = function () {
          const pageTitle = (document.title || '').slice(0, 80);

          // ── JSON-LD path ─────────────────────────────────────────────────
          const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
          for (const script of ldScripts) {
            try {
              const data = JSON.parse(script.textContent || '');
              const entries = Array.isArray(data) ? data : [data];
              for (const entry of entries) {
                if (entry?.['@type'] !== 'JobPosting' || !entry.description) continue;
                const div = document.createElement('div');
                div.innerHTML = entry.description;
                const text = (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim();
                if (text.length > 50) return { ok: true, text };
              }
            } catch {
              // Ignore malformed structured data and fall back to selectors.
            }
          }

          // ── CSS-selector path ────────────────────────────────────────────
          // Covers: guest/unauthenticated view, authenticated app view (current
          // and older class names). LinkedIn rotates class names on deploys so
          // keep a broad list; first match with ≥50 chars wins.
          const sels = [
            // Authenticated SPA layout (2024 +)
            '#job-details',
            '.jobs-description-content__text',
            '.jobs-description__content',
            '.jobs-box__html-content',
            // Guest / older class names
            '.description__text',
            '.show-more-less-html__markup',
          ];
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (el) {
              const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
              if (text.length > 50) return { ok: true, text };
            }
          }

          // No description — return diagnostics so the log is self-explaining.
          const ldTypes = ldScripts.slice(0, 4).map(s => {
            try {
              const d = JSON.parse(s.textContent);
              return Array.isArray(d)
                ? d.map(e => e?.['@type']).filter(Boolean).join('|')
                : (d?.['@type'] || null);
            } catch { return 'parse-err'; }
          }).filter(Boolean);
          return { ok: false, pageTitle, ldCount: ldScripts.length, ldTypes };
        };

        const evalCatch = () => {
          // page.evaluate() throwing means LinkedIn's JS navigated away mid-call.
          // Capture page.url() synchronously to see the redirect target.
          const postEvalUrl = page.url();
          return { ok: false, pageTitle: '(eval error)', evalFailed: true, postEvalUrl };
        };

        // Guest/SEO page: description is server-rendered in JSON-LD at
        // domcontentloaded — no hydration wait needed.
        const result = await page.evaluate(extractDesc).catch(evalCatch);

        if (result.ok) {
          enriched[i] = { ...job, description: result.text, snippet: result.text };
          successCount++;
          consecutiveEvalErrors = 0; // reset streak on success
        } else if (result.evalFailed) {
          evalErrors++;
          consecutiveEvalErrors++;
          if (firstFailNote === null) {
            firstFailNote = `eval-error · post-eval URL: ${(result.postEvalUrl || '?').slice(0, 80)} · job: ${finalUrl.slice(0, 60)}`;
          }
          // A profile-page execution failure is enough to abandon that
          // representation for this pass. Waiting for three failures would
          // leave the first two candidates stranded until a later Solve.
          if (mode === 'authenticated' && await applyGuestFallback('authenticated page evaluation failed')) {
            i--; continue;
          }
          // JS-redirect login wall: LinkedIn redirected mid-evaluate.
          if (LOGIN_WALL_RE.test(result.postEvalUrl || '')) {
            if (await applyGuestFallback('authenticated session redirected while reading the page')) {
              i--; continue;
            }
            if (await handleWall(result.postEvalUrl, i)) break;
            i--; continue; // retry this job on the fresh context
          }
          // N consecutive eval errors without a URL-matchable redirect → still
          // treat as a systematic wall; rotate-and-retry (handleWall stops if a
          // fresh context fails too).
          if (consecutiveEvalErrors >= JS_REDIRECT_WALL_THRESHOLD) {
            if (await applyGuestFallback('authenticated page evaluation repeatedly failed')) {
              i--; continue;
            }
            if (await handleWall(result.postEvalUrl || page.url(), i - (consecutiveEvalErrors - 1))) break;
            i--; continue; // retry on the fresh context
          }
        } else {
          // The profile page rendered but never exposed a usable description.
          // Try the guest SEO representation once before classifying the row as
          // genuinely description-less; otherwise a logged-in user receives no
          // benefit from their session and the report never explains why.
          if (mode === 'authenticated' && await applyGuestFallback('no usable rendered description')) {
            i--; continue;
          }
          noDesc++;
          // Classify: gutted soft-block page (no title, no JSON-LD) vs a real page
          // that genuinely lacks a description. The former is recoverable.
          if (!result.pageTitle && (result.ldCount || 0) === 0) noDescSoftBlock++;
          else noDescGenuine++;
          consecutiveEvalErrors = 0;
          if (firstFailNote === null) {
            const ldDiag = result.ldCount != null
              ? ` (${result.ldCount} JSON-LD${result.ldTypes?.length ? `: ${result.ldTypes.join(',')}` : ''})`
              : '';
            firstFailNote = `no-desc${ldDiag} · title="${result.pageTitle}" · ${finalUrl.slice(0, 80)}`;
          }
        }
      } catch (err) {
        if (signal?.aborted) break;
        navErrors++;
        consecutiveEvalErrors = 0; // nav errors are distinct from eval errors
        if (firstFailNote === null) {
          firstFailNote = `nav-error · ${String(err.message || err).slice(0, 100)} · ${job.url.slice(0, 80)}`;
        }
        // Dead-egress detection: a navigation timeout / net::ERR_* is a
        // transport failure (the page never loaded), unlike an authwall (which
        // loads fine and redirects). A run of them means the VPN IP has no
        // internet — confirm with a probe, then STOP rather than silently
        // timing out every remaining job (15s each ≈ tens of minutes of false
        // "hang"). Genuinely-flaky single pages don't trip it (streak resets on
        // any successful nav, and the probe must also fail).
        const msg = String(err?.message || err);
        const networkLevel = err?.name === 'TimeoutError' || /Navigation timeout|net::ERR_/i.test(msg);
        if (networkLevel) {
          consecutiveNavErrors++;
          if (consecutiveNavErrors >= NO_INTERNET_NAV_ERRORS && !(await probeInternet(signal))) {
            noInternet = true;
            stoppedNoInternetAt = i;
            logger.warn(`[LinkedIn/Browser] No internet on current egress IP — ${consecutiveNavErrors} consecutive network failure(s) and a connectivity probe failed. Stopping (${enriched.length - i - 1} job(s) unattempted); user should switch VPN to a working server.`);
            break;
          }
        } else {
          consecutiveNavErrors = 0;
        }
      }

      // Reaching here means the navigation completed WITHOUT triggering a wall
      // rotation (wall paths do `i--; continue` and skip this). Counts toward the
      // current context's tally — used to detect "fresh context walled immediately".
      if (navOk) jobsThisContext++;

      // Brief pause between navigations — only when there are more jobs to visit.
      // humanDelay gives a log-normal spread around the anchor (~500ms ±20%)
      // so the cadence looks organic rather than a fixed drumbeat.
      if (i < enriched.length - 1 && !signal?.aborted && loginWallAt === null) {
        const hasMoreWithUrl = enriched.slice(i + 1).some(j => j.url);
        if (hasMoreWithUrl) await new Promise(r => setTimeout(r, humanDelay(500)));
      }
    }
  } finally {
    // Closing the isolated context also closes its pages and frees cookies.
    await isolatedCtx?.close().catch(() => {});
    await authenticatedPage?.close().catch(() => {});
  }

  const attempted = attemptedIndexes.size;
  const failParts = [];
  if (navErrors > 0) failParts.push(`${navErrors} nav-err`);
  if (evalErrors > 0) failParts.push(`${evalErrors} eval-err`);
  if (noDesc > 0) failParts.push(`${noDesc} no-desc [${noDescSoftBlock} soft-block, ${noDescGenuine} genuine]`);
  const failSuffix = failParts.length ? ` (${failParts.join(', ')})` : '';
  const wallSuffix = loginWallAt !== null ? ` — login wall at job ${loginWallAt + 1}, ${Math.max(0, enriched.length - attempted)} remaining` : '';
  const offlineSuffix = noInternet ? ` — STOPPED: egress offline at job ${(stoppedNoInternetAt ?? 0) + 1}, ${enriched.length - (stoppedNoInternetAt ?? enriched.length) - 1} unattempted` : '';
  const rotateSuffix = contextRotations > 0 ? ` — ${contextRotations} context rotation(s)` : '';
  const firstFailSuffix = firstFailNote !== null ? ` — first fail: ${firstFailNote}` : '';
  logger.info(`[LinkedIn/Browser] ${successCount}/${attempted} descriptions enriched${failSuffix}${rotateSuffix}${wallSuffix}${offlineSuffix}${firstFailSuffix}`);
  return {
    jobs: enriched, loginWall: loginWallAt !== null, loginWallUrl, successCount, attempted, contextRotations, noInternet,
    usedAuthenticated: preferAuthenticated,
    authenticatedFallback,
    // Failure breakdown so a caller can categorise the residual still-empty jobs.
    // noDesc splits into soft-block (gutted page — recoverable on a later pass)
    // vs genuine (real page, no description — permanent). The continuous loop uses
    // noDescSoftBlock to decide whether a "clean finish" was actually rate-limited
    // (soft-blocks don't trip the URL-based wall detector). evalErrors/navErrors
    // are transient transport failures. Without this split a "still empty" count is
    // ambiguous between "nothing to fetch" and "we quit while soft-blocked".
    noDesc, noDescSoftBlock, noDescGenuine, evalErrors, navErrors,
    browserGen: browserInfo.generation,
    browserAgeMs: browserInfo.launchedAt ? (Date.now() - browserInfo.launchedAt) : null,
  };
}

// ── Shared query-relevance filter (board/API sources) ────────────────────────
// Greenhouse / Lever / RemoteOK / WeWorkRemotely fetch a fixed company board (or
// the whole feed) and then keyword-filter by the query. The old filter — "match
// if ANY ≥2-char query token appears anywhere in title+company+location+desc" —
// was far too loose: a query like "Junior Cinematographer Denver" matched every
// Datadog "Junior …" role (on "junior") and every Denver-based job (on "denver"),
// flooding a cinematographer search with dozens of unrelated SWE jobs.
//
// Fix: relevance must come from the ROLE/skill nouns, so we (a) drop generic
// tokens — seniority/role-modifiers, work-mode, and structural filler — that
// match everything, and (b) match against the role text (title/company/team),
// NOT the location field or the long JD body, so a city/"remote"/ambient-keyword
// token can't pull in an off-target role. A multi-noun query also needs at least
// two of its role terms: accepting one term from "Customer Service Coordinator"
// admitted every unrelated remote-board listing with an incidental "service"
// tag. Single-noun and entirely-generic queries retain their deliberately broad
// fallback so a query such as "Coordinator" or "Senior Manager" still works.
const JOB_MATCH_STOPWORDS = new Set([
  'junior', 'senior', 'jr', 'sr', 'entry', 'mid', 'midlevel', 'principal', 'staff',
  'lead', 'associate', 'head', 'chief', 'director', 'manager', 'mgr', 'vp', 'svp',
  'intern', 'internship', 'remote', 'hybrid', 'onsite', 'remotefirst',
  'the', 'a', 'an', 'and', 'or', 'for', 'of', 'in', 'at', 'on', 'with', 'to',
  'jobs', 'job', 'position', 'role', 'opening', 'opportunity', 'careers',
]);

// Narrow title-level role concepts for whole-feed remote boards. These are not
// a fuzzy taxonomy: they deliberately cover only adjacent terms that a job
// seeker commonly uses interchangeably in a search title. Each alias still
// occupies ONE query concept, so a lone "support" cannot satisfy both
// "Administrative" and "Assistant" and reopen the old one-word leak.
const JOB_ROLE_CONCEPT_ALIASES = new Map([
  ['customer', [['client']]],
  ['service', [['services'], ['support'], ['success'], ['advocate'], ['care']]],
  ['administrative', [['admin'], ['back', 'office']]],
  ['assistant', [['support'], ['coordinator'], ['helper']]],
  // Job boards freely alternate engineer/developer for the same software role
  // (and sometimes list both slash-separated aliases in one title). The second
  // role concept still has to corroborate locally, so a generic "Engineer"
  // cannot satisfy "Backend Developer" without the backend concept beside it.
  ['engineer', [['developer']]],
  ['developer', [['engineer']]],
  // Common title abbreviations/near-equivalents. These remain safe because a
  // multi-concept query still needs local corroboration: "Maintenance Tech" and
  // "Maintenance Worker" match Maintenance Technician, while "Field Service
  // Technician" still lacks the maintenance concept and is rejected.
  ['technician', [['tech'], ['worker']]],
]);

// Technical architecture titles vary their domain qualifier much more than
// ordinary role titles do: employers use Software/Solutions/Systems/Cloud/etc.
// Architect for overlapping work. Treat those qualifiers as one concept only
// when BOTH the query and the candidate title contain the `architect` head.
// This keeps the two-concept safety rule intact (qualifier + architect) and
// avoids admitting unrelated single-word matches such as Landscape Architect
// or an arbitrary Systems Analyst.
const TECHNICAL_ARCHITECTURE_QUALIFIERS = new Set([
  'software', 'solution', 'system', 'platform', 'application', 'cloud',
  'infrastructure', 'enterprise', 'technical', 'technology', 'digital',
  'data', 'analytics', 'security', 'network', 'integration', 'observability',
]);

// A small number of job-title words have established meanings in unrelated
// fields. The broad-board matcher intentionally permits a single meaningful
// word for a query such as "Lead Server" (the modifier `lead` is generic), but
// that previously made hospitality searches admit every IT role containing
// "server". Do not turn this into a broad industry classifier: only reject a
// title when an unambiguous technical companion word establishes that *this*
// use of `server` is computing-related. A query that includes one of those
// companion words is explicitly a technical-server search and remains valid.
const AMBIGUOUS_ROLE_DOMAIN_GUARDS = new Map([
  // "Technical" is a useful broad engineering/architecture signal, but it is
  // also the standard adjective on commercial titles such as "Technical Sales
  // Enablement Manager".  A generated "Technical Lead" query used to admit
  // that sales role on `technical` alone because `lead` is intentionally a
  // generic modifier.  Preserve genuine Technical Architect/Engineer matches,
  // while requiring an explicitly commercial query before commercial uses of
  // the word can count as role evidence.
  ['technical', new Set([
    'sales', 'enablement',
  ])],
  ['server', new Set([
    'software', 'engineering', 'engineer', 'systems', 'system', 'sql', 'dba',
    'database', 'storage', 'infrastructure', 'cloud', 'devops', 'vmware',
    'virtualization', 'linux', 'windows', 'ibm', 'iseries', 'java', 'python',
    'technical', 'technology', 'digital', 'architect', 'developer', 'programmer',
  ])],
  // "Production" is a valid broad match for factory roles such as Production
  // Operator, but it is also routinely used as an environment qualifier in
  // technical titles (Production Engineer, Production SQL Server DBA,
  // Production Scientist). A search for "Production Associate" used to admit
  // those rows because "associate" is intentionally a generic modifier. Keep
  // the broad factory-role behavior, while requiring an explicit technical
  // term in the query before that use of production can count as evidence.
  ['production', new Set([
    'engineering', 'engineer', 'scientist', 'science', 'sql', 'dba', 'database',
    'software', 'developer', 'programmer', 'technical', 'technology', 'data',
    'cloud', 'devops', 'infrastructure', 'systems', 'system', 'architect',
  ])],
]);

const EMPTY_GEO = new Set();

// Punctuation that starts a new clause in a job title. Two role concepts sitting
// on opposite sides of one of these are describing different things ("… ASSISTANT
// (PERSONAL PROPERTY)"), so they do not corroborate each other. A spaced dash
// counts; an intra-word hyphen ("Customer-Service", "Part-Time") does not.
const PHRASE_BREAK_BETWEEN = /[,;:()[\]{}|/•·]|\s[-–—]\s/;

/**
 * Fold a simple English plural so a pluralized title token answers a singular
 * query token ("Officers" → "officer"). Intentionally minimal: a real stemmer
 * conflates unrelated roles. Words ending in "ss" (business, access) are never
 * plurals, and short words are left alone so "gas"/"bus" survive intact.
 */
function singularizeRoleToken(word) {
  const w = String(word || '');
  if (w.length > 4 && /(?:ch|sh|s|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && /[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
}

/**
 * Tokenize the candidate's locations (resume profile.locations, e.g.
 * "Denver, CO") into a set of geo tokens to EXCLUDE from role matching.
 * >=3 chars to mirror the meaningful-term threshold ("co" is already too short
 * to qualify, so it's a no-op there but harmless to include the longer ones).
 */
export function buildGeoTermSet(locations = []) {
  const set = new Set();
  for (const loc of (Array.isArray(locations) ? locations : [])) {
    for (const tok of String(loc).toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length >= 3) set.add(tok);
    }
  }
  return set;
}

/**
 * Shared decision logic for keyword-less relevance matching. jobRelevanceEvidence
 * (evidence for an ADMITTED title) and jobRelevanceRejection (why a REJECTED
 * title failed, used by the bug report) both call this and walk the exact same
 * checks in the exact same order, so the two views of the gate can never drift
 * apart from each other.
 */
function computeJobRelevanceDecision(roleText, query, geoTerms = EMPTY_GEO) {
  const text = String(roleText || '').toLowerCase();
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(t => t.length >= 2);
  // Meaningful = role/skill nouns. Three filters, each dropping a class of token
  // that substring-matches too loosely on a keyword-less company board:
  //  - >=3 chars: a 2-char token ("Denver CO" → "co") matched every
  //    "aCCOunt / COntent / COordinator" title.
  //  - not a generic stopword (seniority / work-mode / structural filler).
  //  - not one of the CANDIDATE'S OWN location tokens. Tech boards bake the city
  //    into the TITLE ("Account Executive - Denver", "Sales Dev Rep (Denver)"),
  //    so a "denver"/"boulder" query token matched every co-located role and
  //    flooded a cinematographer search with ~10 Datadog/Cloudflare SWE+sales
  //    jobs. Location is a filter, never a role-relevance signal — and the
  //    location-capable sources (Indeed l=, Glassdoor locKeyword=, ZipRecruiter
  //    location=, LinkedIn location=, USAJobs LocationName, Dice location) pass
  //    the target location as a real param, so this geo-strip only guards the
  //    keyword-less remote feeds (RemoteOK/WeWorkRemotely) that have no such field.
  // Real role tokens (camera, video, design, engineer…) survive all three.
  const norm = t => t.replace(/[^a-z0-9]/g, '');
  const meaningful = terms.filter(t => {
    const n = norm(t);
    return n.length >= 3 && !JOB_MATCH_STOPWORDS.has(n) && !geoTerms.has(n);
  });
  // Fall back when a query is entirely generic (all stopwords) so we don't
  // over-filter to zero — but only RELAX the stopword rule, never the >=3-char
  // floor (a correctness guard against 2-char substring noise) or the geo
  // exclusion. So "Senior Manager" still matches, while a bare "Denver CO"
  // matches nothing rather than leaking via the "co" substring.
  const useTerms = meaningful.length > 0
    ? meaningful
    : terms.filter(t => norm(t).length >= 3 && !geoTerms.has(norm(t)));
  // Computed up front (not just at the corroboration check below) so a
  // no-usable-terms rejection can still report the threshold that would have
  // applied, and so every return path shares one source of truth for it.
  const minMatches = meaningful.length >= 2 ? 2 : 1;
  const fallbackTerms = meaningful.length === 0;
  if (useTerms.length === 0) {
    return {
      ok: false, reason: 'no-usable-query-terms', matchedConcepts: [],
      useTermsNorm: [], requiredMatches: minMatches, fallbackTerms,
    };
  }
  const useTermsNorm = useTerms.map(norm).slice(0, 12);
  // Match whole words, never substrings: "service" must not match the
  // unrelated company name "Professional Services". Tokenizing also makes
  // punctuation variants such as "Customer-Service Coordinator" equivalent
  // to the query's separate words.
  const roleTokenMatches = [...text.matchAll(/[a-z0-9]+/g)];
  const roleTokenList = roleTokenMatches.map(m => m[0]);
  const roleTokenStarts = roleTokenMatches.map(m => m.index);
  const roleTokenEnds = roleTokenMatches.map(m => m.index + m[0].length);
  const roleTokens = new Set(roleTokenList);
  // Boards pluralize the same role at will ("Security Officers - 2nd Shift",
  // "POSITIONS FOR Armed Security Officers"). Comparing raw tokens dropped those
  // rows because the query said "Officer", leaving only ONE matched concept —
  // below the two-concept floor. Fold a simple English plural on both sides so a
  // pluralized title is the same concept, not a different one. Deliberately not
  // a stemmer: a real stemmer conflates unrelated roles (operations/operator).
  const roleTokenSingulars = roleTokenList.map(singularizeRoleToken);
  const queryTokens = new Set(terms.map(norm).filter(Boolean));
  const queryTokenSingulars = new Set([...queryTokens].map(singularizeRoleToken));
  const technicalArchitectureContext = queryTokenSingulars.has('architect')
    && roleTokenSingulars.includes('architect');
  const aliasesFor = (term) => {
    const aliases = [...(JOB_ROLE_CONCEPT_ALIASES.get(term) || [])];
    if (technicalArchitectureContext && TECHNICAL_ARCHITECTURE_QUALIFIERS.has(singularizeRoleToken(term))) {
      for (const qualifier of TECHNICAL_ARCHITECTURE_QUALIFIERS) {
        if (qualifier !== singularizeRoleToken(term)) aliases.push([qualifier]);
      }
    }
    return aliases;
  };
  const tokenEq = (roleIdx, queryWord) => roleTokenList[roleIdx] === queryWord
    || roleTokenSingulars[roleIdx] === singularizeRoleToken(queryWord);
  const spansFor = (phrase) => {
    const words = Array.isArray(phrase) ? phrase : [];
    const spans = [];
    for (let start = 0; start <= roleTokenList.length - words.length; start++) {
      if (words.every((word, offset) => tokenEq(start + offset, word))) {
        spans.push({ start, end: start + words.length - 1 });
      }
    }
    return spans;
  };
  // Report the role tokens actually present, so evidence reads "officers"
  // when the query said "officer" instead of echoing the query back.
  const matchedText = (span) => roleTokenList.slice(span.start, span.end + 1).join(' ');
  const matchConcept = (term) => {
    const exact = spansFor([term]);
    if (exact.length > 0) return {
      queryTerm: term, matched: matchedText(exact[0]), matchedTokens: [term], kind: 'exact',
    };
    for (const alias of aliasesFor(term)) {
      const aliasSpans = spansFor(alias);
      if (aliasSpans.length > 0) {
        return {
          queryTerm: term, matched: matchedText(aliasSpans[0]), matchedTokens: alias, kind: 'synonym',
        };
      }
    }
    return null;
  };
  const matchedConcepts = [...new Set(useTerms.map(norm))].map(matchConcept).filter(Boolean);
  // Keep the guard after exact/synonym matching so it only applies when the
  // ambiguous word is actual match evidence, not merely incidental text.
  // E.g. "Lead Server Systems Debug Engineer" is a technical server role for
  // a hospitality "Lead Server" query, while "Lead SQL Server DBA" remains a
  // legitimate result for the technical query "SQL Server DBA".
  const hasConflictingAmbiguousDomain = matchedConcepts.some(({ queryTerm }) => {
    const technicalTerms = AMBIGUOUS_ROLE_DOMAIN_GUARDS.get(queryTerm);
    return technicalTerms
      && ![...technicalTerms].some(term => queryTokens.has(term))
      && [...technicalTerms].some(term => roleTokens.has(term));
  });
  if (hasConflictingAmbiguousDomain) {
    return {
      ok: false, reason: 'ambiguous-domain-conflict', matchedConcepts,
      useTermsNorm, requiredMatches: minMatches, fallbackTerms,
    };
  }
  // A query with two or more actual role/skill nouns has enough signal to
  // require corroboration. Two-of-three intentionally keeps close variants
  // such as "Customer Service Representative" for a "Customer Service
  // Coordinator" search, while excluding a job that only happens to mention
  // "customer" or "service" in a tag. Do not tighten a single-noun query or
  // the all-generic fallback; those have no second role signal to require.
  if (matchedConcepts.length < minMatches) {
    return {
      ok: false, reason: 'too-few-matched-concepts', matchedConcepts,
      useTermsNorm, requiredMatches: minMatches, fallbackTerms,
    };
  }
  // Matching two disconnected words is not corroboration. In particular,
  // USAJobs' broad Keyword endpoint returned "TRANSPORTATION ASSISTANT
  // (PERSONAL PROPERTY)" for "Property Management Assistant": `assistant`
  // and `property` satisfied the old two-of-three rule despite describing an
  // unrelated transportation job. Require a multi-concept match to occur as
  // one local title phrase. This retains genuine word-order variants such as
  // "Assistant Property Manager" (assistant/property are adjacent) and
  // "Housing Management Assistant" (management/assistant are adjacent), but
  // does not allow distant ambient terms to assemble a false role match.
  // "One local title phrase" is not the same as "touching". Requiring zero gap
  // rejected "Security patrol officer" and "Security Officer, Overnight" — one
  // ordinary modifier between two role nouns is still a single phrase. Allow at
  // most ONE intervening word, and only when no punctuation between the two
  // concepts opens a new clause. The parenthesis in "TRANSPORTATION ASSISTANT
  // (PERSONAL PROPERTY)" is exactly such a break, so the false USAJobs match
  // this rule was written for stays rejected on the punctuation, not the gap.
  const samePhrase = (a, b) => {
    const [first, second] = a.end <= b.end ? [a, b] : [b, a];
    const gap = second.start - first.end - 1;
    if (gap < 0) return true;
    if (gap > 1) return false;
    return !PHRASE_BREAK_BETWEEN.test(text.slice(roleTokenEnds[first.end], roleTokenStarts[second.start]));
  };
  if (minMatches > 1) {
    // A title can contain both an exact term and a closer synonym in separate
    // slash aliases ("Backend Engineer / Software Developer"). Locality must
    // consider every valid realization of the concept, not only the first exact
    // occurrence chosen above for compact telemetry.
    const conceptSpans = (concept) => [
      spansFor([concept.queryTerm]),
      ...aliasesFor(concept.queryTerm).map(spansFor),
    ].flat();
    const locallyCorroborated = matchedConcepts.some((left, i) =>
      matchedConcepts.slice(i + 1).some(right =>
        conceptSpans(left).some(a => conceptSpans(right).some(b => samePhrase(a, b))),
      ),
    );
    if (!locallyCorroborated) {
      return {
        ok: false, reason: 'not-one-title-phrase', matchedConcepts,
        useTermsNorm, requiredMatches: minMatches, fallbackTerms,
      };
    }
  }
  return {
    ok: true, reason: null, matchedConcepts,
    useTermsNorm, requiredMatches: minMatches, fallbackTerms,
  };
}

/**
 * Compact evidence for a keyword-less remote-feed match. This is kept out of
 * the job object itself: it is report telemetry, not prompt/card payload.
 */
export function jobRelevanceEvidence(roleText, query, geoTerms = EMPTY_GEO) {
  const decision = computeJobRelevanceDecision(roleText, query, geoTerms);
  if (!decision.ok) return null;
  return {
    query: String(query || '').slice(0, 120),
    terms: decision.useTermsNorm,
    // `matchedTerms` is kept for compact/backward-compatible report output;
    // `matchedConcepts` records exact versus synonym evidence for diagnosis.
    matchedTerms: decision.matchedConcepts.map(match => match.queryTerm).slice(0, 12),
    matchedConcepts: decision.matchedConcepts.map(match => ({
      queryTerm: match.queryTerm, matched: match.matched, kind: match.kind,
    })).slice(0, 12),
    requiredMatches: decision.requiredMatches,
    fallbackTerms: decision.fallbackTerms,
  };
}

/**
 * The rejection-side twin of jobRelevanceEvidence: same decision (via
 * computeJobRelevanceDecision), but for a title that FAILED the gate it
 * returns why instead of returning null. Built so the bug report can explain
 * a rejected title instead of only printing it — a bare title gave no way to
 * tell a correct rejection from an over-strict one. Returns null when the
 * title IS relevant (nothing to explain). `reason` is one of:
 * 'no-usable-query-terms', 'too-few-matched-concepts',
 * 'not-one-title-phrase', 'ambiguous-domain-conflict'.
 */
export function jobRelevanceRejection(roleText, query, geoTerms = EMPTY_GEO) {
  const decision = computeJobRelevanceDecision(roleText, query, geoTerms);
  if (decision.ok) return null;
  return {
    reason: decision.reason,
    matched: decision.matchedConcepts.map(match => match.queryTerm),
    required: decision.requiredMatches,
  };
}

export function jobRelevanceMatch(roleText, query, geoTerms = EMPTY_GEO) {
  return !!jobRelevanceEvidence(roleText, query, geoTerms);
}

/**
 * Admit rows from a feed that has no query endpoint. Unlike an actual job-search
 * API, a whole-feed response has not been ranked or filtered for the user's
 * role, so it must satisfy at least one supplied role query locally before it
 * consumes collection, history, or scoring capacity. Evidence is deliberately
 * title-only: company, location, tags, and long descriptions are ambient text
 * and must not turn an unrelated role into a match.
 * With no usable role query, the caller requested no role constraint, so rows
 * are preserved rather than treating an absent search as a rejection.
 *
 * `traceExtrasForJob`, when provided, may add source-specific diagnostic-only
 * fields (for example RemoteOK's tags) to an admitted-row trace. It never
 * affects admission.
 */
export function filterWholeFeedJobsByTitleRelevance(jobs, queries, geoTerms = EMPTY_GEO, traceExtrasForJob = null) {
  const providerRows = Array.isArray(jobs) ? jobs : [];
  const roleQueries = (Array.isArray(queries) ? queries : [queries])
    .map(query => decodeHtmlEntities(String(query || '')))
    .filter(query => query.trim());
  const items = [];
  const rejectedCandidates = [];
  const relevanceTrace = [];

  for (const [order, job] of providerRows.entries()) {
    // Whole-feed extractors can carry encoded text straight from JSON/RSS. The
    // admission boundary needs the human title, not its serialized HTML form:
    // `Systems &amp; Analytics Architect` otherwise inserts a fake `amp` word
    // between the two role concepts and can fail the local-phrase guard. Keep
    // the source object intact — this normalized value is matcher/telemetry-only
    // and normal pipeline markup cleanup still owns the persisted job fields.
    // Keep the source object untouched, but make the admission decision and its
    // diagnostic sample read the human title. RemoteOK occasionally returns
    // UTF-8 mojibake (for example "MACAÃ"), and this boundary otherwise runs
    // before the final kept-job cleanup where that text is normally repaired.
    const title = decodeHtmlEntities(repairMojibake(String(job?.title || '')));
    const matched = roleQueries.length === 0
      ? []
      : roleQueries
        .map(query => jobRelevanceEvidence(title, query, geoTerms))
        .filter(Boolean);
    if (roleQueries.length > 0 && matched.length === 0) {
      // Keep the bounded diagnostic sample useful: a title sharing one role
      // concept is more valuable when debugging a zero than an arbitrary
      // first-feed-row miss. Sorting only the report sample never changes
      // provider ordering or admission. Original feed order resolves ties.
      const closestMatchedConcepts = roleQueries.reduce((best, query) =>
        Math.max(best, computeJobRelevanceDecision(title, query, geoTerms).matchedConcepts.length), 0);
      if (title) rejectedCandidates.push({ title, closestMatchedConcepts, order });
      continue;
    }

    items.push(job);
    if (relevanceTrace.length < 20) {
      const extras = typeof traceExtrasForJob === 'function'
        ? traceExtrasForJob(job)
        : null;
      relevanceTrace.push({
        url: String(job?.url || ''),
        title: title.slice(0, 160),
        company: String(job?.company || '').slice(0, 120),
        matched,
        ...(extras && typeof extras === 'object' ? extras : {}),
      });
    }
  }

  return {
    items,
    providerGathered: providerRows.length,
    gathered: items.length,
    relevanceDropped: providerRows.length - items.length,
    // The hub's central funnel starts from admitted rows, so carry this
    // source-admission drop separately to reconstruct the full feed count.
    preCapRelevanceDropped: providerRows.length - items.length,
    relevanceRejected: rejectedCandidates
      .sort((a, b) => b.closestMatchedConcepts - a.closestMatchedConcepts || a.order - b.order)
      .slice(0, 8)
      .map(({ title }) => title),
    relevanceTrace,
  };
}

// ── USAJobs API ─────────────────────────────────────────────────────────────
// Official API: data.usajobs.gov/api/search
// Requires free API key from developer.usajobs.gov

// USAJobs' PositionRemuneration.RateIntervalCode is an internal pay-interval
// CODE (source: USAJobs' documented rate-interval-code list), not a cadence
// WORD — the shared annualizer (parseSalaryToNumeric, imported above from
// src/nodes/jobsearch/buildJobTree.js) only recognizes cadence words/slash
// forms like "hour"/"/hr" or the literal phrase "bi-weekly". A raw "/ PH"
// suffix matched none of those, so every hourly USAJobs listing silently
// annualized to 0 ("Unspecified") even though real pay was present — and the
// raw code was shown to the user verbatim on the card. Map each code to a
// suffix the annualizer already understands instead. PB has no recognized
// slash form, so it uses the literal word "bi-weekly".
const USAJOBS_RATE_SUFFIX = {
  PA: '/ yr',       // per annum
  PH: '/ hr',       // per hour
  PD: '/ day',      // per day
  PW: '/ wk',       // per week
  PM: '/ mo',       // per month
  PB: 'bi-weekly',  // per bi-week
  FY: '/ yr',       // fee basis, paid per year
  // PS (per piece) and SY (per school year) are intentionally NOT mapped —
  // the annualizer has no multiplier for either, and guessing one would
  // misreport pay. WC (without compensation) is handled separately below:
  // there is no pay at all, so no salary string is emitted for it.
};

/**
 * Format a USAJobs PositionRemuneration entry into a display string the
 * shared annualizer can read. Returns '' when there's no amount to show
 * (no entry, no range, or RateIntervalCode === 'WC' — "without
 * compensation", i.e. no pay at all). For a code with no defined multiplier
 * (PS, SY) or an unrecognized/future code, keeps the amount but appends the
 * raw code in parens rather than fabricating a cadence the annualizer would
 * misread — the amount still shows, and an unmapped code stays diagnosable.
 * Collapses a degenerate "$X - $X" range into a single "$X".
 * Exported for unit testing.
 * @param {{MinimumRange?: string|number, MaximumRange?: string|number, RateIntervalCode?: string}} salary
 * @returns {string}
 */
export function formatUSAJobsSalary(salary) {
  if (!salary) return '';
  const code = salary.RateIntervalCode || '';
  if (code === 'WC') return ''; // without compensation — no pay at all
  const { MinimumRange: min, MaximumRange: max } = salary;
  if (min == null && max == null) return '';
  // Comma-group like formatDiceBaseSalary does — USAJobs ships bare integers, and
  // "$106437" on a card is hard to read at a glance. Non-numeric values pass
  // through untouched rather than being silently zeroed.
  const amt = (x) => (Number.isFinite(Number(x)) ? Number(x).toLocaleString('en-US') : String(x));
  const amount = (min != null && max != null && String(min) === String(max))
    ? `$${amt(min)}`
    : `$${amt(min ?? max)} - $${amt(max ?? min)}`;
  const suffix = USAJOBS_RATE_SUFFIX[code];
  if (suffix) return `${amount} ${suffix}`;
  return code ? `${amount} (${code})` : amount;
}

/**
 * Fetch federal jobs from USAJobs.
 * @param {string} query — search keywords
 * @param {string} apiKey — USAJobs API key (from .env or config)
 * @param {string} email — registered email for User-Agent header
 */
export async function fetchUSAJobs(query, apiKey, email, signal = null, maxAgeDays = 30, location = '', rowBudget = Infinity) {
  if (!apiKey) {
    logger.warn('[USAJobs] No API key configured — skipping');
    // Surface the skip reason as a `warning` so the source card can render
    // it instead of silently sitting at "idle/0". Severity `info` (not block
    // or throttle) so the card colors it neutrally — this isn't a failure,
    // it's a "open Settings → Job Sources to enable this source."
    return {
      items: [],
      warning: {
        code: 'config-missing',
        severity: 'info',
        evidence: 'USAJobs API key + email not set',
        suggestion: 'Get a free key at developer.usajobs.gov, then open Settings → Job Sources and paste the API key + your email to enable this source.',
      },
    };
  }

  return runUSAJobsSearch(query, apiKey, email, signal, maxAgeDays, location, rowBudget);
}

/**
 * One page of USAJobs rows → our job shape. Split out of fetchUSAJobs so the
 * paging loop below can map each page as it arrives.
 */
function mapUSAJobsRows(resultItems) {
  return resultItems.map(item => {
    const pos = item.MatchedObjectDescriptor || {};
    const salary = pos.PositionRemuneration?.[0];
    const salaryStr = formatUSAJobsSalary(salary);

    return {
      title: pos.PositionTitle || '',
      company: pos.OrganizationName || pos.DepartmentName || '',
      location: pos.PositionLocationDisplay || '',
      salary: salaryStr,
      snippet: (() => {
        const d = pos.UserArea?.Details || {};
        const duties = Array.isArray(d.MajorDuties) ? d.MajorDuties.join('\n') : (d.MajorDuties || '');
        return [
          stripHtml(pos.QualificationSummary || ''),
          stripHtml(duties),
          stripHtml(d.Requirements || ''),
        ].filter(Boolean).join('\n\n');
      })(),
      url: pos.PositionURI || pos.ApplyURI?.[0] || '',
      posted: pos.PublicationStartDate || '',
      source: 'usajobs',
    };
  });
}

/**
 * Rows per USAJobs request. 500 is accepted by the API (verified live) and
 * keeps a typical query to one or two requests instead of seven.
 */
const USAJOBS_RESULTS_PER_PAGE = 500;

/**
 * Backstop on the page walk. The real stop condition is the provider's own
 * SearchResultCountAll; this only bounds a pathological response where the
 * reported total never agrees with the rows actually served.
 */
const USAJOBS_MAX_PAGES = 10;

export async function fetchUSAJobsPages(query, apiKey, email, signal, requestedAgeDays, location, rowBudget = Infinity) {
  const rows = [];
  let providerTotal = null;
  let warning = null;
  let lastStatusOk = false;
  let pagesFetched = 0;
  // True when the walk stopped because a LATER page failed, i.e. we hold a
  // partial result set rather than the whole corpus.
  let truncatedByError = false;

  for (let page = 1; page <= USAJOBS_MAX_PAGES; page++) {
    if (signal?.aborted) break;
    const params = new URLSearchParams({
      Keyword: query,
      ResultsPerPage: String(USAJOBS_RESULTS_PER_PAGE),
      Page: String(page),
      // USAJobs accepts only 0–60. Omitting it above 60 preserves breadth; the
      // shared client age filter applies the user's larger requested window.
      ...(requestedAgeDays <= 60 ? { DatePosted: String(requestedAgeDays) } : {}),
      ...(location ? { LocationName: location } : {}),
    });

    const r = await safeApiFetch(`https://data.usajobs.gov/api/search?${params}`, {
      headers: {
        'Host': 'data.usajobs.gov',
        'User-Agent': email || 'job-search-app@example.com',
        'Authorization-Key': apiKey,
      },
      signal: createTimeoutSignal(signal, apiTimeout('usajobs-api')),
    }, 'usajobs');

    if (!r.ok) {
      if (r.warning) logger.warn(`[USAJobs] ${r.warning.code}: ${r.warning.evidence}`);
      else logger.error(`[USAJobs] API returned ${r.status}`);
      // A failure PART-WAY through the walk is not the same as a failure on page
      // one: rows were gathered, but the set is now truncated at an arbitrary
      // point. Record it so the caller cannot report a partial gather as a clean
      // success, and never overwrite an earlier warning with a later one.
      if (!warning) {
        warning = r.warning || {
          code: 'scrape-failed',
          severity: pagesFetched > 0 ? 'warn' : 'block',
          evidence: `USAJobs returned ${r.status} on page ${page} of the result walk.`,
          suggestion: 'Retry this source — the federal API intermittently rejects rapid paging.',
        };
      }
      truncatedByError = pagesFetched > 0;
      break;
    }
    lastStatusOk = true;
    if (r.warning && !warning) warning = r.warning;
    pagesFetched++;

    const search = r.json?.SearchResult;
    const pageItems = search?.SearchResultItems || [];
    // The provider's exact corpus size for this query. Read once; it is the
    // walk's stop condition and the only way to tell a truncated query from a
    // genuinely small one — previously both reported the same row count.
    if (providerTotal == null) {
      const all = Number(search?.SearchResultCountAll);
      if (Number.isFinite(all) && all >= 0) providerTotal = all;
    }
    if (pageItems.length === 0) break;
    rows.push(...pageItems);
    if (providerTotal != null && rows.length >= providerTotal) break;
    // Stop as soon as the user's per-platform allowance is satisfied. Walking
    // the provider's full corpus and slicing afterwards would fetch (and later
    // LLM-score) rows the user already said they did not want — JOB_SCORE_CAP is
    // Infinity, so every gathered row is scored. Infinity ("All") keeps walking.
    if (rows.length >= rowBudget) break;
    if (pageItems.length < USAJOBS_RESULTS_PER_PAGE) break; // short page = last page
  }

  return { rows, providerTotal, warning, lastStatusOk, pagesFetched, truncatedByError };
}

async function runUSAJobsSearch(query, apiKey, email, signal, maxAgeDays, location, rowBudget = Infinity) {
  const requestedAgeDays = Math.max(1, Math.floor(maxAgeDays || 30));
  const { rows, providerTotal, warning, lastStatusOk, pagesFetched, truncatedByError } =
    await fetchUSAJobsPages(query, apiKey, email, signal, requestedAgeDays, location, rowBudget);

  if (!lastStatusOk && rows.length === 0) return { items: [], warning };

  const mapped = mapUSAJobsRows(rows);
  // Trust USAJobs' own keyword matching. A second local title gate was tried and
  // removed because it starved the source: federal position titles are written
  // in their own vocabulary ("IT Specialist (INFOSEC)") and legitimately differ
  // from the user's role phrase. This is NOT a claim that the ranking is good —
  // measured on-target rate is flat across depth, with no usable relevance
  // ordering — only that a local gate discards more real rows than it removes.
  const items = mapped;
  // A 200 carrying zero rows is a real, reportable outcome and is otherwise
  // indistinguishable from an empty federal search.
  if (providerTotal === 0) {
    logger.info(`[USAJobs] 200 with SearchResultCountAll=0 for "${query}" — provider reports no matching federal postings`);
  } else if (providerTotal != null && rows.length < providerTotal) {
    const why = truncatedByError ? 'a page request failed mid-walk'
      : Number.isFinite(rowBudget) && rows.length >= rowBudget ? 'the per-platform allowance was reached'
      : 'the walk ended early';
    logger.info(`[USAJobs] "${query}": gathered ${rows.length} of ${providerTotal} reported after ${pagesFetched} page(s) — ${why}`);
  }
  return {
    items,
    warning,
    gathered: mapped.length,
    providerGathered: rows.length,
    // The provider's own count for this query. Distinct from providerGathered so
    // "150 of 973" is legible instead of looking like a 150-row corpus.
    providerTotal,
    // Set only when a LATER page failed, so the caller can distinguish a partial
    // set from a complete one. Without it a truncated walk was indistinguishable
    // from a source that genuinely had this many rows.
    truncated: truncatedByError,
    relevanceDropped: 0,
    relevanceRejected: [],
  };
}


// ── Shared Utilities ────────────────────────────────────────────────────────


// ── RemoteOK Direct API ─────────────────────────────────────────────────────
// Open JSON endpoint: remoteok.com/api — no auth, no browser, no WAF.
// Returns a raw JSON array of job objects with salary, tags, and company.

// Pseudo-employers RemoteOK uses for paid ad slots in the /api feed. There is no
// `sponsored` flag on the row to key off — the company name IS the marker — so
// this is a deliberate, narrow platform-specific rule rather than a heuristic
// that could suppress a real employer. Compared lowercased.
const SPONSORED_EMPLOYERS = new Set(['ai supermarket']);

export function isRemoteOkSponsoredPlacement(job) {
  return SPONSORED_EMPLOYERS.has(String(job?.company || '').trim().toLowerCase());
}

/**
 * RemoteOK ships bare integers in salary_min / salary_max, and uses 0 (not
 * null) to mean "no figure". Emit a range only when both bounds are real
 * positive numbers, a single figure when only one is, and '' when neither is —
 * never a half-formed "$X - $undefined". Exported for unit testing.
 *
 * @param {number|string|null|undefined} min
 * @param {number|string|null|undefined} max
 * @returns {string}
 */
export function formatRemoteOkSalary(min, max) {
  const num = (x) => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const lo = num(min);
  const hi = num(max);
  const money = (n) => `$${n.toLocaleString('en-US')}`;
  if (lo != null && hi != null) return lo === hi ? money(lo) : `${money(lo)} - ${money(hi)}`;
  if (lo != null) return money(lo);
  if (hi != null) return money(hi);
  return '';
}

/**
 * Tags to request from RemoteOK in addition to the bare feed, derived from the
 * run's own queries.
 *
 * The bare /api response is capped at roughly 100 postings (plus its metadata
 * object) — verified live: `?limit=200` and `?offset=100` are ignored. `?tag=`
 * is the only server-side selector that works, and it returns different
 * inventory, so it reaches rows the bare feed cannot show. A bogus tag returns
 * metadata only, which
 * is what proves the parameter is honoured server-side and also makes a wrong
 * guess harmless — it yields zero rows after the slice(1), never an error.
 *
 * Deliberately bounded: RemoteOK's own API terms (element 0 of every response)
 * threaten to suspend access for misuse, so this adds at most
 * REMOTEOK_MAX_TAG_FETCHES requests per run, never one per query.
 *
 * @param {string[]} queries
 * @returns {string[]} lowercase single-word tags, deduped, capped
 */
export function remoteOkTagsFromQueries(queries, max = REMOTEOK_MAX_TAG_FETCHES) {
  const seen = new Set();
  const tags = [];
  for (const query of Array.isArray(queries) ? queries : [queries]) {
    for (const word of String(query || '').toLowerCase().split(/[^a-z0-9+#]+/)) {
      // RemoteOK tags are single tokens. Very short words are ambiguous and very
      // long ones are never tags; stopwords would match half the feed.
      if (word.length < 3 || word.length > 20) continue;
      if (REMOTEOK_TAG_STOPWORDS.has(word)) continue;
      if (seen.has(word)) continue;
      seen.add(word);
      tags.push(word);
      if (tags.length >= max) return tags;
    }
  }
  return tags;
}

/** At most this many extra tag-scoped requests per run (ToS courtesy). */
const REMOTEOK_MAX_TAG_FETCHES = 3;

/** Words that are never useful RemoteOK tags. */
const REMOTEOK_TAG_STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'jobs', 'job', 'remote', 'senior', 'junior', 'lead',
  'staff', 'principal', 'entry', 'level', 'years', 'experience', 'work', 'time',
  'full', 'part', 'new', 'all', 'any', 'top', 'best',
]);

async function fetchRemoteOkFeed(url, signal) {
  const r = await safeApiFetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: createTimeoutSignal(signal, apiTimeout('remoteok-api')),
  }, 'remoteok');
  return r;
}

/**
 * Fetch jobs from RemoteOK's open JSON API (bypasses Puppeteer entirely).
 *
 * ATTRIBUTION: RemoteOK's API terms (returned as element 0 of every response)
 * require linking back to the posting's Remote OK URL and naming Remote OK as
 * the source, or they may suspend API access. We satisfy this by carrying each
 * posting's own remoteok.com `url` through to the job card, which is what the
 * user opens — do not replace it with a rewritten or direct-employer link.
 */
export async function fetchRemoteOKJobs(queries, signal = null, geoTerms = EMPTY_GEO) {
  const r = await fetchRemoteOkFeed('https://remoteok.com/api', signal);

  if (!r.ok) {
    if (r.warning) logger.warn(`[RemoteOK API] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.warn(`[RemoteOK API] Returned ${r.status}`);
    return { items: [], warning: r.warning, sponsoredDropped: 0 };
  }

  const data = r.json;
  // First element is metadata, rest are jobs
  const jobs = Array.isArray(data) ? data.slice(1) : [];
  // Compact source provenance for the Jobs/FULL diagnostic report. These are
  // feed scopes derived from the already-reported role queries, never posting
  // payloads or descriptions; keeping this separately explains a historical
  // all-rejected result without retaining rejected jobs themselves.
  const feedProvenance = [{ scope: 'bare', received: jobs.length, added: jobs.length }];
  // The bare feed is capped at roughly 100 postings, so widen with a few tag-scoped
  // fetches that return DIFFERENT inventory. Additive only: the bare feed is
  // always the base and is never replaced, and rows are deduped by id/url below.
  const seenFeedKeys = new Set(jobs.map(j => String(j?.id || j?.url || '')).filter(Boolean));
  for (const tag of remoteOkTagsFromQueries(queries)) {
    if (signal?.aborted) break;
    const tagged = await fetchRemoteOkFeed(`https://remoteok.com/api?tag=${encodeURIComponent(tag)}`, signal);
    if (!tagged.ok || !Array.isArray(tagged.json)) continue;
    const received = Math.max(0, tagged.json.length - 1);
    let added = 0;
    for (const job of tagged.json.slice(1)) {
      const key = String(job?.id || job?.url || '');
      if (!key || seenFeedKeys.has(key)) continue;
      seenFeedKeys.add(key);
      jobs.push(job);
      added++;
    }
    feedProvenance.push({ scope: 'tag', tag, received, added });
    logger.info(`[RemoteOK API] ?tag=${tag} added ${added} posting(s) beyond the bare feed`);
  }

  // Remove sponsored placements before role admission. RemoteOK's endpoint is
  // a whole feed, not a query result, so the remaining rows are filtered below.
  // Those are product ads sold
  // into the same /api feed, not postings: `company` is the literal pseudo-
  // employer "AI Supermarket", `position` holds a PRODUCT name, and the
  // description is ~14k chars of boilerplate ad copy repeated verbatim across
  // every placement. They carry a 25-tag scattershot tag list that matches
  // almost any query, so they sail through relevance — a live run surfaced six
  // of them ("Apify", "Beehiiv", "Meshy"…) as 6 of RemoteOK's 10 results, all
  // scored and shown to the user as if they were jobs.
  const sponsored = [];
  const providerRows = jobs.flatMap(job => {
    if (isRemoteOkSponsoredPlacement(job)) {
      sponsored.push(String(job.position || '?'));
      return [];
    }
    return [job];
  });
  if (sponsored.length > 0) {
    logger.info(`[RemoteOK API] dropped ${sponsored.length} sponsored ad placement(s): ${sponsored.slice(0, 6).join(', ')}`);
  }

  const feedJobs = providerRows.map((job) => {
    // RemoteOK's API returns description as raw HTML — strip tags to plain text.
    const descText = job.description ? job.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const tags = (job.tags || []).join(', ');
    const url = job.url ? (String(job.url).startsWith('http') ? job.url : `https://remoteok.com${job.url}`) : '';
    return {
      title: job.position || '',
      company: job.company || '',
      location: job.location || 'Remote',
      // Build from whichever bounds are real numbers. The feed has no `salary`
      // key at all, so that branch never fires; and guarding only salary_min
      // meant a max-only posting reported NO salary (bucketed Unspecified and
      // excluded from the 75+ compensation-fit gate) while a min-only posting
      // rendered the literal "$120000 - $undefined" on the card and in the
      // scoring prompt. Never invent a cadence — parseSalaryToNumeric's range
      // path annualizes correctly from this shape.
      salary: formatRemoteOkSalary(job.salary_min, job.salary_max),
      // Pipeline convention: the FULL JD lives in `snippet` — that's the field the
      // scorer reads (jobs.js slimBatch + "Description: ${job.snippet}") and the
      // bug-report field-quality check measures. RemoteOK's API hands us the full
      // description up front, so it belongs in `snippet`; fall back to the tag
      // list only when a posting genuinely has none. (Previously snippet=tags with
      // the real JD stranded in `description`, which nothing downstream reads — so
      // every remoteOK job was scored on a bare tag list, not its description.)
      snippet: descText || tags,
      description: descText,
      // RemoteOK's `url` is sometimes already absolute ("https://remoteOK.com/…")
      // and sometimes a relative path; only prefix the relative form, else we get
      // a doubled "https://remoteok.comhttps://remoteOK.com/…" broken link.
      url,
      posted: job.date || '',
      source: 'remoteok',
      // Trace-only source metadata. The shared whole-feed matcher ignores this
      // field; it is retained solely to show that tags were not admission evidence.
      _relevanceTraceTags: Array.isArray(job.tags)
        ? job.tags.map(tag => String(tag).slice(0, 50)).slice(0, 20)
        : [],
    };
  });
  const admission = filterWholeFeedJobsByTitleRelevance(
    feedJobs,
    queries,
    geoTerms,
    job => ({ tags: job._relevanceTraceTags || [] }),
  );
  const items = admission.items.map(job => {
    const cleanJob = { ...job };
    delete cleanJob._relevanceTraceTags;
    return cleanJob;
  });
  const withDesc = items.filter(j => j.description).length;
  logger.info(`[RemoteOK API] ${items.length}/${admission.providerGathered} role-matched feed jobs, ${withDesc}/${items.length} have descriptions`);
  // Keep sponsorship removal distinct from role-title admission. They are both
  // expected exclusions, but conflating them makes an empty RemoteOK run look
  // like the query matcher rejected postings that were actually product ads.
  return {
    ...admission,
    items,
    sponsoredDropped: sponsored.length,
    remoteFeedProvenance: feedProvenance,
    warning: r.warning,
  };
}


// ── WeWorkRemotely RSS Feed ─────────────────────────────────────────────────
// RSS/XML feed at weworkremotely.com — no browser, no rate limits, no WAF.

// WWR's RSS carries NO structured salary field, but ~40% of postings state pay in
// the description body. Pull the first $ amount/range that is either (a) followed by
// an explicit pay unit (/yr, per year, per month, annually, a year/hour) — a strong standalone
// signal — or (b) anchored to a salary keyword within ~40 chars. Requiring comma-
// grouped thousands ($80,000, not $80) avoids matching funding/revenue figures like
// "$100M in bookings". Returns '' when no confident salary is present.
// Money figures that are NOT the role's pay. A JD routinely quotes equity grants,
// signing bonuses, referral awards and company revenue in the same prose, and the
// unit-anchored pattern below is otherwise happy to take the first one it sees.
// Live example: a "Customer Advocate Lead" whose real range was
// "$106,912.00 - $132,675.40" was recorded as "$346,104.00 per year" — the
// ceiling of a *Performance Share Unit* grant, which happened to be the only
// figure in that JD carrying an explicit cadence. Checked against the ~70 chars
// on either side of a candidate match.
const NON_PAY_CONTEXT = /\b(?:equity|share unit|psus?|rsus?|stock|option|grant|token|vest|bonus|signing|referral|revenue|funding|raised|valuation|budget of|arr|mrr)\b/i;

// Hoisted to module scope (not rebuilt per call): extractSalaryFromText runs once
// per RSS item in fetchWeWorkRemotelyJobs' item loop, so re-constructing these two
// RegExp objects (each built from a string-concatenated pattern) on every posting
// was pure per-item waste. UNIT is global (used via matchAll, which clones its own
// iteration state, so sharing it across calls is safe); KEYWORD is non-global and
// used only via .match(), so it carries no lastIndex state either.
const SALARY_AMOUNT_RE = String.raw`\$\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s?(?:[-–—]|to)\s?\$?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?)?`;
// Keep a currency code and cadence with the amount. Returning only "$2,500"
// from "$2,500 USD per month" loses the signal required to annualize the pay.
const SALARY_CADENCE_RE = String.raw`(?:\/\s?(?:yr|year|hr|hour|mo|month|wk|week|day)|per\s+(?:year|hour|month|week|day|annum)|a\s+(?:year|hour|month|week|day)|(?:annually|annual|yearly|monthly|weekly|daily|hourly))`;
const SALARY_CURRENCY_AND_CADENCE_RE = String.raw`(?:\s*(?:USD|CAD|AUD|EUR|GBP)\b)?\s*${SALARY_CADENCE_RE}`;
const SALARY_UNIT_RE = new RegExp(`${SALARY_AMOUNT_RE}${SALARY_CURRENCY_AND_CADENCE_RE}`, 'gi');
// "budget for this role" is how remote-first JDs (Hospitable, GitLab…) phrase
// the pay band; a BARE "budget" is not on this list on purpose — that matches
// marketing/infra spend far more often than compensation.
const SALARY_KEYWORD_RE = new RegExp(
  String.raw`\b(?:salary|salaries|compensation|base pay|pay range|pay rate|pay|budget for this (?:role|position)|total budget for this (?:role|position))\b[^$]{0,40}(${SALARY_AMOUNT_RE})(${SALARY_CURRENCY_AND_CADENCE_RE})?`,
  'i',
);

export function extractSalaryFromText(text) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ');
  // Pay-anchored wins over free-floating: a figure the JD itself labels as pay is
  // better evidence than one that merely carries a cadence somewhere in the body.
  const m2 = s.match(SALARY_KEYWORD_RE);
  if (m2 && !NON_PAY_CONTEXT.test(contextAround(s, m2.index, m2[0].length))) return `${m2[1]}${m2[2] || ''}`.trim();
  for (const m of s.matchAll(SALARY_UNIT_RE)) {
    if (!NON_PAY_CONTEXT.test(contextAround(s, m.index, m[0].length))) return m[0].trim();
  }
  return '';
}

// The ±70 chars surrounding a match, for the non-pay context test above.
function contextAround(s, index, length, pad = 70) {
  return s.slice(Math.max(0, index - pad), Math.min(s.length, index + length + pad));
}

/**
 * Fetch jobs from WeWorkRemotely's RSS feed (bypasses Puppeteer entirely).
 */
/**
 * WeWorkRemotely category feeds, keyed by the query words that imply them.
 *
 * The main feed is ~90 postings and has NO keyword parameter (`?search=` is a
 * verified no-op, returning the identical feed). Category feeds are the only
 * server-side selector that works, and they carry genuinely different
 * inventory: measured live, three categories contributed 78 postings the main
 * feed did not list at all.
 *
 * Only categories implied by the run's own queries are fetched, so an unrelated
 * taxonomy branch is never pulled just to be discarded by the title gate. Some
 * slugs return 403 (WWR rate-limits, and not every guessable slug exists), which
 * is why every fetch here is best-effort and additive.
 */
const WWR_CATEGORY_FEEDS = [
  { slug: 'remote-programming-jobs', match: /\b(engineer|engineering|developer|programmer|architect|software|backend|frontend|fullstack|devops|data|ml|ai)\b/ },
  { slug: 'remote-devops-sysadmin-jobs', match: /\b(devops|sysadmin|sre|infrastructure|platform|cloud|operations|reliability)\b/ },
  { slug: 'remote-design-jobs', match: /\b(design|designer|ux|ui|product design|graphic|brand)\b/ },
  { slug: 'remote-product-jobs', match: /\b(product|pm|roadmap|owner)\b/ },
  { slug: 'remote-customer-support-jobs', match: /\b(support|customer|success|helpdesk|service)\b/ },
];

/** At most this many extra category requests per run (WWR rate-limits). */
const WWR_MAX_CATEGORY_FETCHES = 3;

/**
 * Which category feeds do this run's queries imply?
 * @param {string[]} queries
 * @returns {string[]} category slugs, capped
 */
export function wwrCategoriesFromQueries(queries, max = WWR_MAX_CATEGORY_FETCHES) {
  const text = (Array.isArray(queries) ? queries : [queries])
    .map(q => String(q || '').toLowerCase()).join(' ');
  if (!text.trim()) return [];
  const slugs = [];
  for (const { slug, match } of WWR_CATEGORY_FEEDS) {
    if (match.test(text)) slugs.push(slug);
    if (slugs.length >= max) break;
  }
  return slugs;
}

async function fetchWwrFeed(url, signal) {
  return safeApiFetch(url, {
    headers: {
      'Accept': 'application/rss+xml, application/xml, text/xml',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: createTimeoutSignal(signal, apiTimeout('wwr-api')),
  }, 'weworkremotely');
}

export async function fetchWeWorkRemotelyJobs(queries, signal = null, geoTerms = EMPTY_GEO) {
  const r = await fetchWwrFeed('https://weworkremotely.com/remote-jobs.rss', signal);

  if (!r.ok) {
    if (r.warning) logger.warn(`[WWR RSS] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.warn(`[WWR RSS] Returned ${r.status}`);
    return { items: [], warning: r.warning };
  }

  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  let xml = r.text;
  // Widen with the category feeds this run's queries imply. Additive only: the
  // main feed is always the base, duplicates are dropped by <link>, and a 403 or
  // an unknown slug simply contributes nothing.
  const mainLinks = new Set((xml.match(itemPattern) || [])
    .map(item => (item.match(/<link>\s*([^<\s]+)\s*<\/link>/i) || [])[1])
    .filter(Boolean));
  for (const slug of wwrCategoriesFromQueries(queries)) {
    if (signal?.aborted) break;
    const cat = await fetchWwrFeed(`https://weworkremotely.com/categories/${slug}.rss`, signal);
    if (!cat.ok || !cat.text) {
      logger.info(`[WWR RSS] category ${slug} returned ${cat.status} — skipped`);
      continue;
    }
    const fresh = (cat.text.match(itemPattern) || []).filter(item => {
      const link = (item.match(/<link>\s*([^<\s]+)\s*<\/link>/i) || [])[1];
      if (!link || mainLinks.has(link)) return false;
      mainLinks.add(link);
      return true;
    });
    if (fresh.length > 0) xml += fresh.join('');
    logger.info(`[WWR RSS] category ${slug} added ${fresh.length} posting(s) beyond the main feed`);
  }

  // Parse RSS items with regex (no XML parser dependency needed)
  const rssItems = xml.match(itemPattern) || [];
  const jobs = [];

  for (const item of rssItems) {
    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) ||
                        item.match(/<title>(.*?)<\/title>/i);
    const linkMatch = item.match(/<link>(.*?)<\/link>/i);
    const descMatch = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) ||
                       item.match(/<description>([\s\S]*?)<\/description>/i);
    const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/i);
    const regionMatch = item.match(/<region><!\[CDATA\[(.*?)\]\]><\/region>/i) ||
                         item.match(/<region>(.*?)<\/region>/i);

    const title = titleMatch?.[1]?.trim() || '';
    if (!title) continue;

    // Extract company from title (WWR formats as "Company: Job Title")
    const titleParts = title.split(':');
    const company = titleParts.length > 1 ? titleParts[0].trim() : '';
    const jobTitle = titleParts.length > 1 ? titleParts.slice(1).join(':').trim() : title;

    // WWR RSS <description> CDATA is the full job HTML — strip tags to plain text.
    const descText = stripHtml(descMatch?.[1] || '').trim();

    const url = linkMatch?.[1]?.trim() || '';
    jobs.push({
      title: jobTitle,
      company,
      location: regionMatch?.[1]?.trim() || 'Remote',
      salary: extractSalaryFromText(descText),
      snippet: descText,
      description: descText,
      url,
      // ISO, never toLocaleDateString(). The locale form is only parseable on
      // en-US: "27/08/2026" or "27.8.2026" makes Date.parse NaN, so
      // parsePostedDate returns null, filterJobsByAge then KEEPS the row
      // unconditionally, and postedMs falls back to -Infinity so every WWR job
      // sorts last. A malformed pubDate previously stored the literal string
      // "Invalid Date" and rendered it verbatim on the card.
      posted: (() => {
        const d = pubDateMatch?.[1] ? new Date(pubDateMatch[1]) : null;
        return d && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
      })(),
      source: 'weworkremotely',
    });
  }

  const admission = filterWholeFeedJobsByTitleRelevance(jobs, queries, geoTerms);
  const { items } = admission;
  const withDesc = items.filter(j => j.description).length;
  logger.info(`[WWR RSS] ${items.length}/${admission.providerGathered} role-matched feed jobs, ${withDesc}/${items.length} have descriptions`);

  return { ...admission, warning: r.warning };
}


// ── Reverb Internal REST API (ACTIVE listings) ──────────────────────────────
// Reverb PERMANENTLY retired its public Price Guide (sold-transaction) API in
// mid-2026: /api/priceguide AND /api/priceguide/<id>/transactions now return
// HTTP 403 `{"Error":"This endpoint is no longer publicly available."}` on every
// path probed (verified live 2026-07-09 — this is the api-endpoint-deprecated
// signal in antiBotDetector.js). Sold prices survive ONLY on the Cloudflare-
// walled Price Guide *web* pages, which can't be fetched reliably or unit-tested,
// so Reverb was reclassified from a SOLD source to an ACTIVE one:
//   • /api/listings/all (keyless; Accept-Version: 3.0 + Accept: application/hal+json)
//     is still live and returns for-sale inventory (asking prices). CRITICAL:
//     it ONLY ever returns state=live — `state=sold`/`state=ended` AND the
//     `condition` filter are SILENTLY IGNORED (verified live: identical result
//     set with/without either param; a "sold" query returns brand-new dealer
//     listings at full retail). So it is an ACTIVE asking-price source only —
//     category:active in constants.js + marketplace.js, mirroring swappa /
//     ebay-active. Each listing keeps its `condition` so synthesis can discount
//     new-retail vs used; no client-side filter is applied because Reverb
//     ignores it (adding one would be a silent no-op, the exact bug class that
//     hid the priceguide deprecation).
const REVERB_HEADERS = {
  'Accept': 'application/hal+json',
  'Accept-Version': '3.0',
  'Content-Type': 'application/hal+json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

/**
 * Map Reverb /api/listings/all live listings to the standard ACTIVE-comp shape.
 * Guards price > 0 (like every other extractor here) and dedups by listing id
 * (falling back to the web URL). Pure (no I/O) for testability.
 */
export function reverbListingsToComps(listings) {
  const out = [];
  const seen = new Set();
  for (const l of (Array.isArray(listings) ? listings : [])) {
    const amount = l?.price?.amount;
    const price = amount != null ? parseFloat(amount) : 0;
    if (!(price > 0)) continue;
    const web = l?._links?.web?.href || '';
    const key = l?.id != null ? String(l.id) : web;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const condition = typeof l?.condition === 'string'
      ? l.condition
      : (l?.condition?.display_name || '');
    out.push({
      title: l?.title || `${l?.make || ''} ${l?.model || ''}`.trim(),
      price,
      priceText: l?.price?.display || `$${price}`,
      condition,
      url: web,
      source: 'reverb',
    });
  }
  return out;
}

/**
 * Reverb ACTIVE comps via the live-listings API (asking prices — the sold Price
 * Guide API was retired; see the section header). Returns the standard
 * { items, warning } envelope so a block/throttle surfaces in the UI.
 */
async function fetchReverbActiveListings(query, signal, safeApiFetch) {
  const res = await safeApiFetch(
    `https://api.reverb.com/api/listings/all?query=${encodeURIComponent(query)}&per_page=40`,
    { headers: REVERB_HEADERS, signal: createTimeoutSignal(signal, apiTimeout('reverb-api')) },
    'reverb',
  );
  if (!res.ok) {
    if (res.warning) logger.warn(`[Reverb] ${res.warning.code}: ${res.warning.evidence}`);
    else logger.warn(`[Reverb] listings API returned ${res.status}`);
    return { items: [], warning: res.warning };
  }
  const items = reverbListingsToComps(res.json?.listings || []);
  logger.info(`[Reverb] "${query}" → ${items.length} active listing(s)`);
  return { items, warning: null };
}

/**
 * Fetch ACTIVE-comp marketplace data from Reverb's live-listings API. (The prior
 * Price Guide sold path was permanently deprecated by Reverb — see the section
 * header; this is the honest, still-working replacement, reclassified as active.)
 */
export async function fetchReverbListings(query, signal = null) {
  return fetchReverbActiveListings(query, signal, safeApiFetch);
}

// ── PriceCharting (direct HTTP, NOT the stealth browser) ────────────────────
// PriceCharting's per-product price columns are SERVER-RENDERED into
// <span class="js-price"> (verified by curl), but its CLIENT-SIDE JS BLANKS them
// when it detects automation (navigator.webdriver / CDP) — so the Puppeteer scrape
// always read "N rows, 0 prices" no matter how long it waited. A plain HTTP GET
// with a browser UA runs no JS, so the server-rendered prices survive. Same
// direct-HTTP pattern as Reverb.
//
// CAUTION — PriceCharting's /search-products is a FUZZY, WHOLE-CATALOG keyword
// match that does NOT return [] for off-catalog queries (an earlier comment here
// wrongly claimed it did). A non-game query fuzzily matches dozens of unrelated
// catalog entries on stray single tokens — a "BISSELL … Crosswave 80 oz" vacuum
// query returns "Azur Lane: Crosswave", "Formula One 99", "Wizard of Oz", … (137
// "matches"). Two guards keep that noise out of the comp pool: (1) the caller
// SKIPS the request for a clearly-non-collectible category (isPriceChartingApplicable),
// and (2) filterPriceChartingByRelevance drops any returned row that doesn't share
// enough of the query's distinctive tokens with its title — a genuine match shares
// most, a fuzzy junk match shares one.
const PRICECHARTING_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

// Parse the search-results table out of PriceCharting HTML. PURE (no I/O) for
// testability. Each result row (`#games_table tbody tr`) carries a title link
// (`td.title a` → name + /game/ URL) and three price columns in order:
// loose/used | CIB | new. We take the FIRST (loose/used) as the FMV anchor — the
// right comp for a typical used/refurbished listing. Rows without a parseable
// price (unpriced accessories) are skipped; de-duped by URL. JSDOM does not run
// scripts or load resources, so the anti-automation JS can't blank the prices here.
export function parsePriceChartingHtml(html) {
  const doc = new JSDOM(String(html || '')).window.document;
  const parsePrice = (txt) => {
    const m = String(txt || '').replace(/[,\s]/g, '').match(/\$?(\d+(?:\.\d{1,2})?)/);
    return m ? parseFloat(m[1]) : 0;
  };
  const items = [];
  const seen = new Set();
  for (const row of doc.querySelectorAll('#games_table tbody tr')) {
    const a = row.querySelector('td.title a');
    if (!a) continue;
    const title = (a.textContent || '').trim();
    const href = a.getAttribute('href') || '';
    if (!title || !href) continue;
    const priceEl = row.querySelector('td.price .js-price') || row.querySelector('td.price');
    const price = parsePrice(priceEl && priceEl.textContent);
    if (!(price > 0)) continue;   // unpriced row (e.g. an accessory with no loose price)
    const url = href.startsWith('http')
      ? href
      : 'https://www.pricecharting.com' + (href.startsWith('/') ? href : '/' + href);
    if (seen.has(url)) continue;
    seen.add(url);
    items.push({ title, price, priceText: '$' + price.toFixed(2), url, condition: 'Loose (cart-only)', source: 'pricecharting' });
  }
  return items;
}

// Distinctive query tokens (≥2 chars, common stopwords + units removed) used to
// score a PriceCharting row's relevance. Units like "oz"/"lb" are dropped so the
// "80 oz" in a vacuum query can't pull in "Wizard of Oz".
const PC_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'of', 'a', 'an', 'to', 'in', 'on', 'by', 'or', 'at', 'it', 'is',
  'oz', 'lb', 'lbs', 'ml', 'pack', 'set', 'new', 'used', 'piece', 'pcs', 'count', 'ct',
]);
function pcTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !PC_STOPWORDS.has(t));
}

/**
 * Drop PriceCharting rows that don't genuinely match the query. PriceCharting's
 * search fuzzily matches the WHOLE catalog on any single shared token, so a
 * non-game query returns dozens of unrelated games/cards/comics. A real match
 * shares MOST of the query's distinctive tokens with the result title; a junk
 * fuzzy match shares one. Keep a row only when it clears a token-overlap bar:
 * a 1–2-token query must match ALL its tokens; a longer query must match ≥2
 * tokens AND ≥40% of them. Applies ONLY to PriceCharting (the fuzzy source) —
 * other comp sources are unaffected. PURE for testability.
 */
export function filterPriceChartingByRelevance(items, query) {
  const list = Array.isArray(items) ? items : [];
  const qToks = [...new Set(pcTokens(query))];
  if (qToks.length === 0) return list;                 // nothing to match on → don't over-filter
  const need = qToks.length <= 2 ? qToks.length : 2;
  return list.filter(it => {
    const tToks = new Set(pcTokens(it?.title));
    let hits = 0;
    for (const t of qToks) if (tToks.has(t)) hits++;
    return hits >= need && hits / qToks.length >= 0.4;
  });
}

export async function fetchPriceChartingComps(query, signal = null, { category } = {}) {
  const q = String(query || '').trim();
  if (!q) return { items: [], warning: null };
  // Skip the request entirely for a clearly-non-collectible category — saves a
  // wasted round-trip and stops a game-price site from appearing as a source for
  // a vacuum/appliance/etc. Unknown/blank category falls through (still fetched,
  // then relevance-filtered). `skipped` lets the caller distinguish "n/a here"
  // from a genuine empty result.
  if (category !== undefined && !isPriceChartingApplicable(category)) {
    return { items: [], url: null, warning: null, skipped: true };
  }
  const url = `https://www.pricecharting.com/search-products?q=${encodeURIComponent(q)}&type=prices`;
  let res;
  try {
    res = await fetch(url, { headers: PRICECHARTING_HEADERS, signal: createTimeoutSignal(signal, apiTimeout('pricecharting-api')) });
  } catch (e) {
    logger.warn(`[PriceCharting] fetch failed: ${String(e?.message || e).slice(0, 160)}`);
    return { items: [], url, warning: { code: 'task-failed', severity: 'block', evidence: `fetch failed: ${String(e?.message || e).slice(0, 200)}` } };
  }
  if (!res.ok) {
    logger.warn(`[PriceCharting] HTTP ${res.status}`);
    return { items: [], url, warning: { code: 'task-failed', severity: 'block', evidence: `HTTP ${res.status} (server bot-gate or rate-limit)` } };
  }
  const parsed = parsePriceChartingHtml(await res.text());
  const items = filterPriceChartingByRelevance(parsed, q);
  if (parsed.length > 0 && items.length < parsed.length) {
    logger.info(`[PriceCharting] relevance filter kept ${items.length}/${parsed.length} row(s) for "${q.slice(0, 80)}"`);
  }
  return { items, url, warning: null };
}

// ── AptDeco (direct HTTP, NOT the stealth browser) ──────────────────────────
// AptDeco is a secondhand FURNITURE / home-furnishings marketplace. Its
// /catalog?q= page is a Next.js App-Router route whose server-rendered HTML
// EMBEDS the full first page of Algolia search results as literal JSON (a
// `"hits":[ ... ]` array of ~57 records, relevance-ranked). A plain HTTP GET with
// a browser UA gets them — no browser/JS needed. These are ACTIVE asking prices
// (each record's `price` is the current ask; `original_price` is retail context),
// so the source is classified category:'active' (like swappa/ebay-active), NOT
// sold. Same direct-HTTP pattern as Reverb/PriceCharting; the caller SKIPS the
// request for a non-furniture category (isAptDecoApplicable) since AptDeco's
// fuzzy Algolia returns loose matches even for off-category queries.
const APTDECO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

// Extract the first `"hits":[ … ]` JSON array from a blob of HTML and parse it.
// String-aware: tracks quote/escape state so a `[` or `]` INSIDE a record's string
// value (e.g. a title "Sofa [Floor Model]") can't unbalance the bracket counter.
// Returns [] on any miss/parse failure — a malformed or restructured page yields
// no comps rather than throwing. PURE (no I/O) for testability.
export function extractAlgoliaHits(html) {
  const s = String(html || '');
  const marker = '"hits":[';
  const at = s.indexOf(marker);
  if (at < 0) return [];
  const open = at + marker.length - 1;   // index of the '['
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let k = open; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  if (end < 0) return [];
  try {
    const arr = JSON.parse(s.slice(open, end));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// Map AptDeco's embedded Algolia records → the standard comp shape. PURE (no I/O)
// for testability. Keeps only available/saleable, positively-priced listings;
// de-duped by product URL. `price` is the current ask (the comp value);
// `original_price`/MSRP is retail context and is NOT used as the comp price.
export function parseAptDecoComps(html) {
  const items = [];
  const seen = new Set();
  for (const rec of extractAlgoliaHits(html)) {
    if (!rec || typeof rec !== 'object') continue;
    // Skip sold/unavailable inventory — these are ACTIVE asking-price comps.
    if (rec.is_available === false || rec.is_saleable === false) continue;
    const title = String(rec.title || '').trim();
    const price = Number(rec.price);
    const slug = String(rec.page_url || '').trim();
    if (!title || !slug || !(price > 0)) continue;
    const url = `https://www.aptdeco.com/product/${slug}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const condition = String(rec.condition_title || '').trim();
    items.push({
      title,
      price,
      priceText: '$' + price.toFixed(2),
      url,
      source: 'aptdeco-active',
      ...(condition ? { condition } : {}),
    });
  }
  return items;
}

export async function fetchAptDecoComps(query, signal = null, { category } = {}) {
  const q = String(query || '').trim();
  if (!q) return { items: [], url: null, warning: null };
  // Skip the request for a clearly non-furniture category — AptDeco's fuzzy
  // Algolia returns loose matches that would pollute an electronics/fashion item.
  // `skipped` lets the caller tell "n/a here" apart from a genuine empty result.
  if (category !== undefined && !isAptDecoApplicable(category)) {
    return { items: [], url: null, warning: null, skipped: true };
  }
  const url = `https://www.aptdeco.com/catalog?q=${encodeURIComponent(q)}`;
  let res;
  try {
    res = await fetch(url, { headers: APTDECO_HEADERS, signal: createTimeoutSignal(signal, apiTimeout('aptdeco-api')) });
  } catch (e) {
    logger.warn(`[AptDeco] fetch failed: ${String(e?.message || e).slice(0, 160)}`);
    return { items: [], url, warning: { code: 'task-failed', severity: 'block', evidence: `fetch failed: ${String(e?.message || e).slice(0, 200)}` } };
  }
  if (!res.ok) {
    logger.warn(`[AptDeco] HTTP ${res.status}`);
    return { items: [], url, warning: { code: 'task-failed', severity: 'block', evidence: `HTTP ${res.status} (server bot-gate or rate-limit)` } };
  }
  const items = parseAptDecoComps(await res.text());
  return { items, url, warning: null };
}

// ── Dice Public API ─────────────────────────────────────────────────────────
// DHI Group (Dice's parent) exposes a public job search API used by the Dice
// frontend. Returns structured JSON with all fields we need.
// Zero WAF risk — this is a direct API endpoint, no browser needed.
//
// Discovered during tier upgrade audit: previously Tier 3 (Puppeteer),
// now upgraded to Tier 1 (direct API).

// Dice API key is persisted in settings (getDiceApiKey) and auto-refreshed
// by refreshDiceApiKey() when the server returns 500 — see stealthBrowser.js.

function decodeScriptText(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function compactText(value, maxLen = 500) {
  if (value == null) return '';
  const text = stripHtml(typeof value === 'string' ? value : String(value));
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function firstText(...values) {
  for (const value of values) {
    const text = compactText(value);
    if (text) return text;
  }
  return '';
}

function getNested(obj, path) {
  let cur = obj;
  for (const part of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function readBalancedJsonObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

function parseJsonSafely(raw) {
  if (!raw) return null;
  const variants = [String(raw), decodeScriptText(raw)];
  for (const candidate of variants) {
    try { return JSON.parse(candidate); } catch { /* try decoded variant */ }
  }
  return null;
}

function extractJobKeyFromUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(String(rawUrl), 'https://www.indeed.com');
    return url.searchParams.get('jk') || '';
  } catch {
    const m = String(rawUrl).match(/[?&]jk=([^&]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }
}

function normalizeIndeedJobKey(value) {
  const key = String(value || '').trim();
  return /^[a-z0-9_-]{8,}$/i.test(key) ? key : '';
}

// Recognizes a placeholder-shaped jobkey — template/companion blocks buried in
// Indeed's own embedded JSON (skeleton cards, carousel filler, …) that get
// walked into candidates alongside real listings but were never assigned a
// real per-listing hash. Real Indeed jobkeys are effectively random 16-hex
// ids; these are the opposite — recognizably synthetic/sequential filler.
// Deliberately narrow to the exact families observed (see FACT 2 in the
// investigation this guards against): a false POSITIVE here silently
// discards a real job, which is worse than letting a rare phantom through,
// so this does not attempt to catch every conceivable synthetic id — only
// the ones actually seen, plus their immediate family. Verified against all
// 42 real jobkeys in a live scrape and 75 real Indeed rows sampled from
// canvas.jobs-history.csv: zero false positives.
export function isPlaceholderIndeedJobKey(key) {
  const k = String(key || '').trim().toLowerCase();
  if (k.length < 8) return false;

  // Family: the whole key is one character repeated (any charset) —
  // "aaaaaaaaaaaaaaaa", "00000000", ...
  if (/^(.)\1+$/.test(k)) return true;

  // Everything below only applies to pure lowercase-hex keys — Indeed's real
  // jobkey charset. A genuine random hex id could only coincidentally hit one
  // of these exact shapes with vanishing probability.
  if (!/^[0-9a-f]+$/.test(k)) return false;

  // Family: a 16-hex key whose nibble PAIRS (positions 0&1, 2&3, ...) are each
  // a hex digit and its 4-bit complement, i.e. every pair sums to 15 —
  // 0f1e2d3c4b5a6978.
  if (k.length === 16) {
    let allComplementary = true;
    for (let i = 0; i < k.length; i += 2) {
      if (parseInt(k[i], 16) + parseInt(k[i + 1], 16) !== 15) { allComplementary = false; break; }
    }
    if (allComplementary) return true;
  }

  // Family: the entire key is a strictly ascending or descending run of hex
  // digits, cyclically wrapping mod 16. This covers every rotation of
  // "0123456789abcdef" (789abcdef0123456, cdef0123456789ab, ...) and its
  // reverse, without special-casing "rotation" separately — a rotation IS a
  // cyclic run starting partway through.
  let ascending = true;
  let descending = true;
  for (let i = 1; i < k.length; i++) {
    const diff = (parseInt(k[i], 16) - parseInt(k[i - 1], 16) + 16) % 16;
    if (diff !== 1) ascending = false;
    if (diff !== 15) descending = false;
  }
  if (ascending || descending) return true;

  // The live phantom `890abcdef0123456` has one extra nibble in an otherwise
  // cyclic ascending run (`89abcdef0123456` after removing that nibble).
  // Restrict this near-family tolerance to a 16-character key and require the
  // remaining 15 characters to be an *exact* cyclic run. This is deliberately
  // much narrower than a fuzzy "hex-like" test that could discard a real job.
  if (k.length !== 16) return false;
  for (let skip = 0; skip < k.length; skip++) {
    for (const expectedDiff of [1, 15]) {
      let previous = null;
      let run = true;
      for (let i = 0; i < k.length; i++) {
        if (i === skip) continue;
        if (previous !== null) {
          const diff = (parseInt(k[i], 16) - parseInt(previous, 16) + 16) % 16;
          if (diff !== expectedDiff) { run = false; break; }
        }
        previous = k[i];
      }
      if (run) return true;
    }
  }
  return false;
}

function salaryText(salary, fallback = '') {
  if (!salary) return compactText(fallback, 160);
  if (typeof salary === 'string') return compactText(salary, 160);
  if (typeof salary !== 'object') return compactText(fallback, 160);
  if (salary.text) return compactText(salary.text, 160);
  if (salary.salaryText) return compactText(salary.salaryText, 160);
  if (salary.max || salary.min) {
    const min = salary.min ? `$${salary.min}` : '';
    const max = salary.max ? `$${salary.max}` : '';
    return [min, max].filter(Boolean).join(' - ');
  }
  return compactText(fallback, 160);
}

function normalizeIndeedUrl(rawUrl, jobkey) {
  const key = normalizeIndeedJobKey(jobkey) || extractJobKeyFromUrl(rawUrl);
  if (key) return `https://www.indeed.com/viewjob?jk=${encodeURIComponent(key)}`;
  if (!rawUrl) return '';
  try { return new URL(String(rawUrl), 'https://www.indeed.com').href; } catch { return ''; }
}

function looksLikeIndeedJobRecord(record) {
  if (!record || typeof record !== 'object') return false;
  const job = record.job && typeof record.job === 'object' ? record.job : record;
  const title = job.title || job.displayTitle || job.normTitle || job.jobTitle || job.jobTitleText || job.name;
  if (!title) return false;
  const key = normalizeIndeedJobKey(job.jobkey || job.jobKey || job.key || job.jobId) ||
    extractJobKeyFromUrl(job.link || job.url || job.jobUrl || job.viewJobLink);
  const company = job.company || job.companyName || job.employer?.name || job.hiringOrganization?.name;
  const detailSignal = job.formattedLocation || job.location || job.locationName ||
    job.snippet || job.description || job.salarySnippet || job.formattedRelativeTime || job.pubDate;
  return !!key || (!!company && !!detailSignal);
}

function normalizeIndeedCandidate(record) {
  if (!looksLikeIndeedJobRecord(record)) return null;
  const job = record.job && typeof record.job === 'object' ? record.job : record;
  const rawUrl = job.link || job.url || job.jobUrl || job.viewJobLink || job.jobCardLink || '';
  const key = normalizeIndeedJobKey(job.jobkey || job.jobKey || job.key || job.jobId) ||
    extractJobKeyFromUrl(rawUrl);
  const title = firstText(job.title, job.displayTitle, job.normTitle, job.jobTitle, job.jobTitleText, job.name);
  if (!title) return null;

  return {
    title,
    company: firstText(job.company, job.companyName, job.employer?.name, job.hiringOrganization?.name),
    location: firstText(job.formattedLocation, job.location, job.locationName, job.jobLocation?.address?.addressLocality),
    salary: salaryText(job.salarySnippet || job.salaryInfo || job.extractedSalary || job.salary),
    snippet: firstText(job.snippet?.htmlSnippet, job.snippet?.text, job.snippet, job.description, job.jobDescription),
    url: normalizeIndeedUrl(rawUrl, key),
    jobkey: key,
    posted: firstText(job.formattedRelativeTime, job.relativeTime, job.pubDate, job.datePublished, job.postedDate),
    source: 'indeed',
  };
}

// Second, INDEPENDENT guard against the same phantom-record problem
// isPlaceholderIndeedJobKey targets, but on a structural signal instead of an
// id shape: a real listing's payload always carries SOME description text: a
// template/companion block does not. This still catches a future phantom
// whose id happens to look like a genuine hash and the id-shape guard would
// miss. Only collapses a group when at least one member has NO description at
// all — two genuinely distinct postings that merely share a title+company
// (different reqs, different cities) normally both carry their own
// description and are left untouched.
function collapseDescriptionlessIndeedDuplicates(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    // Title + company + LOCATION, not just title + company. One employer
    // legitimately posts the same role in several cities, and description
    // enrichment can genuinely fail on a real card (a click that timed out) —
    // grouping on title+company alone would let one such city's real posting
    // be discarded because a sibling city's row happened to enrich. Silently
    // losing a real job is far worse than letting a phantom through; the
    // placeholder-id predicate is the primary defence, this is the backstop.
    const key = jobTitleCompanyLocationKey(job);
    let group = groups.get(key);
    if (!group) { group = []; groups.set(key, group); }
    group.push(job);
  }

  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const described = group.filter(job => String(job.snippet || '').trim().length > 0);
    const undescribed = group.filter(job => !String(job.snippet || '').trim().length);
    if (described.length > 0 && undescribed.length > 0) {
      for (const job of undescribed) {
        logger.debug(`[Indeed/extract] Dropped description-less duplicate "${job.title}" @ "${job.company}" (${job.location || 'no location'}, jobkey=${job.jobkey || 'none'}) — a described row for the same title+company+location was kept`);
      }
      out.push(...described);
    } else {
      out.push(...group);
    }
  }
  return out;
}

function dedupeIndeedJobs(jobs) {
  const seen = new Set();
  const out = [];
  for (const job of jobs) {
    if (!job?.title) continue;
    const key = sourceJobKey(job);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(job);
  }
  return collapseDescriptionlessIndeedDuplicates(out);
}

function collectIndeedJobsFromObject(root) {
  const jobs = [];
  const seenObjects = new WeakSet();
  const stack = [root];
  let inspected = 0;
  // Placeholder-shaped candidates rejected during this walk (see
  // isPlaceholderIndeedJobKey) — exposed as .rejectedPlaceholderCount on the
  // returned array so a caller can report the drop instead of it silently
  // vanishing into a lower job count. Keyed by jobkey (like the accepted side's
  // own dedup) because the same wrapper object's `{ job: {...} }` shape and its
  // inner `job` value are each separate nodes the walk visits in turn — one
  // phantom record must not be double-counted as two rejections.
  const rejectedPlaceholderKeys = new Set();

  while (stack.length && inspected < 60000) {
    const node = stack.pop();
    inspected++;
    if (!node || typeof node !== 'object') continue;
    if (seenObjects.has(node)) continue;
    seenObjects.add(node);

    const normalized = normalizeIndeedCandidate(node);
    if (normalized) {
      if (isPlaceholderIndeedJobKey(normalized.jobkey)) {
        if (!rejectedPlaceholderKeys.has(normalized.jobkey)) {
          rejectedPlaceholderKeys.add(normalized.jobkey);
          logger.debug(`[Indeed/extract] Rejected placeholder-shaped jobkey "${normalized.jobkey}" title="${normalized.title}" — template/companion block, not a real listing`);
        }
      } else {
        jobs.push(normalized);
      }
    }

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
    } else {
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
  }

  const result = dedupeIndeedJobs(jobs);
  result.rejectedPlaceholderCount = rejectedPlaceholderKeys.size;
  return result;
}

function extractNextDataJobs(html) {
  const match = String(html || '').match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  const data = parseJsonSafely(match?.[1]);
  if (!data) return [];

  const knownResultPaths = [
    ['props', 'pageProps', 'initialData', 'jobSearchResults'],
    ['props', 'pageProps', 'searchResults', 'results'],
    ['props', 'pageProps', 'results'],
  ];
  const direct = [];
  for (const path of knownResultPaths) {
    const value = getNested(data, path);
    if (Array.isArray(value)) direct.push(...value);
  }
  const jobs = direct.length > 0 ? collectIndeedJobsFromObject(direct) : [];
  return jobs.length > 0 ? jobs : collectIndeedJobsFromObject(data);
}

function extractMosaicJobs(html) {
  const text = String(html || '');
  const marker = 'mosaic-provider-jobcards';
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return [];
  const objectStart = text.indexOf('{', markerIndex);
  if (objectStart < 0) return [];
  const rawJson = readBalancedJsonObject(text, objectStart);
  const data = parseJsonSafely(rawJson);
  if (!data) return [];
  // Try known result paths before falling back to full traversal.
  const knownPaths = [
    ['metaData', 'mosaicProviderJobCardsModel', 'results'],
    ['jobCards'],
    ['results'],
  ];
  for (const p of knownPaths) {
    const val = getNested(data, p);
    if (Array.isArray(val) && val.length > 0) return collectIndeedJobsFromObject(val);
  }
  return collectIndeedJobsFromObject(data);
}

function extractDomJobs(html) {
  let document;
  try {
    document = new JSDOM(String(html || '')).window.document;
  } catch {
    return [];
  }

  const cards = document.querySelectorAll('.job_seen_beacon, [data-testid="job-card-container"], [data-jk]');
  const jobs = [];
  cards.forEach(node => {
    try {
      const card = node.matches?.('a[data-jk]')
        ? (node.closest('.job_seen_beacon, [data-testid="job-card-container"], li, article') || node)
        : node;
      // Skip Indeed recommendation panels ("Similar to jobs you explored", "Jobs for
      // you", …) that render alongside the real results. They're off-search cards —
      // sponsored, frequently the wrong location/role (one leaked into a Denver search
      // as a Temple TX nursing job). Primary signal: the `recommendation-section` class
      // on the card outline; secondary (survives a class rename): the panel's section
      // header text. These cards do NOT come through the mosaic/NEXT_DATA paths (those
      // read only the main jobcards provider), so this DOM filter is the lone gate.
      if (card.closest?.('.recommendation-section')) return;
      const sectionHeaderText = card.closest?.('li')?.parentElement
        ?.querySelector?.('.jobSection-header-text')?.textContent || '';
      if (/you explored|jobs for you|similar to jobs|recommended/i.test(sectionHeaderText)) return;
      const titleEl = card.matches?.('a') ? card : card.querySelector(
        '[data-testid="jobTitle"] a, [data-testid="job-title"], .jobTitle a, h2 a, h3 a, a[data-jk]'
      );
      const title = compactText(titleEl?.textContent, 220);
      if (!title) return;
      const rawUrl = titleEl?.getAttribute('href') || '';
      const key = normalizeIndeedJobKey(card.getAttribute?.('data-jk')) ||
        normalizeIndeedJobKey(titleEl?.getAttribute?.('data-jk')) ||
        extractJobKeyFromUrl(rawUrl);
      // DOM cards can carry the same synthetic `data-jk` filler as embedded
      // payloads. Keep key-less cards (they may be real), but never let a
      // positively identified placeholder through this independent path.
      if (key && isPlaceholderIndeedJobKey(key)) {
        logger.debug(`[Indeed/extract] Rejected placeholder-shaped DOM jobkey "${key}" title="${title}" — template/companion card, not a real listing`);
        return;
      }
      jobs.push({
        title,
        company: compactText(card.querySelector('[data-testid="company-name"], .companyName')?.textContent, 180),
        location: compactText(card.querySelector('[data-testid="text-location"], .companyLocation')?.textContent, 180),
        salary: compactText(card.querySelector('.salary-snippet-container, [data-testid="desktopSalaryOnlySnippet"], .salary-snippet')?.textContent, 160),
        snippet: compactText(card.querySelector('[data-testid="job-snippet"], .summary')?.textContent, 300),
        url: normalizeIndeedUrl(rawUrl, key),
        jobkey: key,
        posted: compactText(card.querySelector('[data-testid="job-age"], .date, [class*="jobAge"], [class*="datePosted"]')?.textContent, 120),
        source: 'indeed',
        _extractPath: 'dom',
      });
    } catch { /* skip malformed card */ }
  });

  return dedupeIndeedJobs(jobs);
}

// Embedded JSON is valuable because Indeed sometimes hydrates more results
// than are visible as cards, so it must remain the primary extraction path.
// The exception is a record with *no* description at all: that is the shape
// of the template/companion phantoms we have observed.  Such a weak JSON
// record gets one extra, intentionally narrow, corroboration requirement: a
// card with the same source-stable identity must be present in this response's
// DOM.  Described JSON records are never gated here; they can legitimately be
// JSON-only when the page only renders its above-the-fold cards.
function anchorDescriptionlessIndeedJsonJobs(jsonJobs, domJobs) {
  const domKeys = new Set((domJobs || []).map(sourceJobKey));
  const kept = [];
  let rejectedUnanchoredDescriptionlessCount = 0;
  for (const job of jsonJobs || []) {
    if (String(job?.snippet || '').trim().length > 0 || domKeys.has(sourceJobKey(job))) {
      kept.push(job);
    } else {
      rejectedUnanchoredDescriptionlessCount++;
      logger.debug(`[Indeed/extract] Rejected description-less JSON-only record "${job.title}" @ "${job.company || 'unknown company'}" (${job.location || 'no location'}, jobkey=${job.jobkey || 'none'}) — no matching DOM card`);
    }
  }
  kept.rejectedPlaceholderCount = jsonJobs?.rejectedPlaceholderCount || 0;
  kept.rejectedUnanchoredDescriptionlessCount = rejectedUnanchoredDescriptionlessCount;
  return kept;
}

// windowMosaicResults: pre-extracted array from window.mosaic.providerData
// ['mosaic-provider-jobcards'].metaData.mosaicProviderJobCardsModel.results
// passed in by the Puppeteer scraper via page.evaluate(). When provided it
// replaces the broken HTML marker approach (which hits a CSS URL, not data).
export function extractIndeedJobsFromHtml(html, windowMosaicResults = null) {
  const tagExtractPath = (jobs, path) => {
    const tagged = (Array.isArray(jobs) ? jobs : []).map(job => ({ ...job, _extractPath: path }));
    tagged.rejectedPlaceholderCount = jobs?.rejectedPlaceholderCount || 0;
    return tagged;
  };
  const nextDataRaw = tagExtractPath(extractNextDataJobs(html), 'nextData');
  const mosaicRaw = tagExtractPath(windowMosaicResults
    ? collectIndeedJobsFromObject(windowMosaicResults)
    : extractMosaicJobs(html), 'mosaic');
  const dom      = extractDomJobs(html);
  const nextData = anchorDescriptionlessIndeedJsonJobs(nextDataRaw, dom);
  const mosaic = anchorDescriptionlessIndeedJsonJobs(mosaicRaw, dom);
  // nextData/mosaic each carry a .rejectedPlaceholderCount from the JSON-walk
  // guard (collectIndeedJobsFromObject). DOM applies the same key-shape guard
  // directly while walking cards, but does not currently aggregate that count.
  const rejectedPlaceholders = (nextData.rejectedPlaceholderCount || 0) + (mosaic.rejectedPlaceholderCount || 0);
  const rejectedUnanchoredDescriptionless = (nextData.rejectedUnanchoredDescriptionlessCount || 0) + (mosaic.rejectedUnanchoredDescriptionlessCount || 0);
  logger.info(`[Indeed/extract] __NEXT_DATA__: ${nextData.length}, mosaic: ${mosaic.length}, dom: ${dom.length}${rejectedPlaceholders > 0 ? `, rejected-placeholder: ${rejectedPlaceholders}` : ''}${rejectedUnanchoredDescriptionless > 0 ? `, rejected-descriptionless-json-only: ${rejectedUnanchoredDescriptionless}` : ''}`);
  const merged = dedupeIndeedJobs([...nextData, ...mosaic, ...dom]);
  merged.rejectedPlaceholderCount = rejectedPlaceholders;
  merged.rejectedUnanchoredDescriptionlessCount = rejectedUnanchoredDescriptionless;
  return merged;
}

/**
 * Fetch job listings from Dice via their public API (Tier 1).
 * @param {string} query — job search query
 * @param {string} [location] — optional location filter
 * @param {number} [maxAgeDays] — keep only postings within this window (server-side
 *   when it matches a Dice bucket, else client-side — see dicePostedBucket)
 * @returns {Promise<Array>} — standardized job objects
 */
// Dice exposes a SERVER-SIDE date filter (`filters.postedDate`) but only in coarse
// 1/3/7-day buckets. Verified against the live API: the accepted enum is the
// uppercase words ONE/THREE/SEVEN (SEVEN bounds to ≤6d, i.e. a 7-day window);
// SEVEN_DAYS / numeric / un-prefixed values are SILENTLY IGNORED (return the
// unfiltered feed, not a 400 — so a miss degrades to client-side filtering, never
// a lost source). Returns the bucket string when the configured window EXACTLY
// equals one of Dice's buckets, else null (no server-side filter possible — e.g.
// the 21-day default). Exported for unit testing.
export function dicePostedBucket(maxAgeDays) {
  const n = Number.isFinite(maxAgeDays) ? Math.floor(maxAgeDays) : null;
  return { 1: 'ONE', 3: 'THREE', 7: 'SEVEN' }[n] || null;
}
const DICE_MAX_RETRIES = 3;
const DICE_RETRY_DELAYS_MS = [1000, 2000, 4000];

// Once we observe that a bundle scan returns the same key that was already
// stored, we know the 500s are transient server errors (not key rotation).
// Skip the expensive bundle scan on subsequent 500s this session and use a
// plain backoff instead. Resets to false on app restart (safe — worst case
// we do one unnecessary scan before confirming stability again).
let _diceKeyIsStable = false;

export async function fetchDiceListings(query, location = '', signal = null, maxAgeDays = null) {
  // When the window matches a Dice date bucket, filter SERVER-SIDE and pull a
  // smaller page; otherwise keep the wide over-pull and filter client-side.
  const bucket = dicePostedBucket(maxAgeDays);
  const params = new URLSearchParams({
    q: query,
    countryCode2: 'US',
    radius: '30',
    radiusUnit: 'mi',
    page: '1',
    // Why the page size differs:
    //  • No bucket → relevance sort interleaves stale postings and the in-window
    //    fraction is small (probed: ~3-4% at 1 day, ~32% at 7 days), so we over-pull
    //    a WIDE relevance-ranked page and keep only the in-window slice below —
    //    volume is what guarantees a full cap of in-window matches.
    //  • Bucket active → `filters.postedDate` (added below) makes the response
    //    ~100% in-window, so the relevance ranking is already over in-window jobs.
    //    400 all-in-window rows meet/exceed what the old 1000-row mixed page yielded
    //    in-window (1000×0.32≈320 at the widest 7-day bucket) at ~2.5x less data —
    //    no coverage regression in any mode (FAST caps to 10 downstream regardless;
    //    FULL keeps everything, and 400 ≥ 320). pageSize is honored past this.
    sortBy: 'relevance', // explicit (= Dice's default) so an API default change can't silently flip us off relevance
    pageSize: bucket ? '400' : '1000',
    ...(location ? { location } : {}),
    // Dice EXCLUDES remote postings by default (`meta.includeRemote` comes back
    // false, and flipping this took a live "Systems Architect" probe from 422 to
    // 468). When we send no location we are not geo-filtering at all — which is
    // exactly the remote-only / nationwide case — so excluding remote jobs there
    // drops the very postings the search wants. A LOCATED search keeps the
    // default so a city filter is not quietly widened, which would undo the
    // location-adherence work.
    ...(location ? {} : { includeRemote: 'true' }),
  });
  // Coarse server-side date bound — only when the window exactly matches a bucket.
  // The client-side filterJobsByAge below still runs (a no-op when the bucket already
  // bounds, but it enforces the exact cutoff and stays correct for the non-bucket path).
  if (bucket) params.append('filters.postedDate', bucket);

  const url = `https://job-search-api.svc.dhigroupinc.com/v1/dice/jobs/search?${params}`;
  let r;
  for (let attempt = 0; attempt <= DICE_MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');
    if (attempt > 0) {
      const delay = DICE_RETRY_DELAYS_MS[attempt - 1] ?? 4000;
      logger.info(`[Dice API] Retry ${attempt}/${DICE_MAX_RETRIES} in ${delay}ms (last status: ${r?.status ?? '?'})`);
      await new Promise(res => setTimeout(res, delay));
      if (signal?.aborted) throw new Error('Aborted');
    }
    r = await safeApiFetch(url, {
      headers: {
        'User-Agent': getRandomUA(),
        'x-api-key': getDiceApiKey(),
        'Accept': 'application/json',
      },
      signal: createTimeoutSignal(signal, apiTimeout('dice-api')),
    }, 'dice');
    if (r.ok) break;
    // When the key is confirmed stable, 500s are transient server errors —
    // retrying with the same key won't help. Break immediately and let the
    // stable-backoff handler below wait 3s, saving 7s of pointless retry delay.
    if (r.status >= 500 && _diceKeyIsStable) break;
    if (r.status >= 500 && attempt < DICE_MAX_RETRIES) continue; // retry on server errors
    break; // non-5xx or retries exhausted — fall through to error handling
  }

  if (!r.ok) {
    if (r.status >= 500) {
      let retryKey;
      if (_diceKeyIsStable) {
        // Key has been confirmed unchanged this session — 500s are transient.
        // Skip the bundle scan and just wait out the transient error.
        logger.info('[Dice API] Key stable — skipping bundle scan, using 3s backoff for transient 500');
        await new Promise(res => setTimeout(res, 3000));
        retryKey = getDiceApiKey();
      } else {
        // First time (or key genuinely rotated): do the full bundle scan.
        const oldKey = getDiceApiKey();
        retryKey = await refreshDiceApiKey(signal);
        if (retryKey) {
          if (retryKey === oldKey) {
            _diceKeyIsStable = true;
            logger.info('[Dice API] Key unchanged after refresh — 500s are transient (not key rotation). Future 500s will skip bundle scan.');
          } else {
            logger.info('[Dice API] Key rotated — retrying with new key');
          }
        }
      }
      if (retryKey) {
        logger.info('[Dice API] Retrying with refreshed key');
        const retryR = await safeApiFetch(url, {
          headers: {
            'User-Agent': getRandomUA(),
            'x-api-key': retryKey,
            'Accept': 'application/json',
          },
          signal: createTimeoutSignal(signal, apiTimeout('dice-api')),
        }, 'dice');
        if (retryR.ok) {
          r = retryR; // use the successful retry response going forward
        } else {
          const evidence = `Dice API unavailable — returned HTTP ${r.status} after ${DICE_MAX_RETRIES + 1} attempts + 1 key-refresh retry.`;
          logger.warn(`[Dice API] ${evidence}`);
          return { items: [], warning: { code: 'task-failed', severity: 'block', evidence } };
        }
      } else {
        const evidence = `Dice API unavailable — returned HTTP ${r.status} after ${DICE_MAX_RETRIES + 1} attempt(s). Key refresh also failed — try again later.`;
        logger.warn(`[Dice API] ${evidence}`);
        return { items: [], warning: { code: 'task-failed', severity: 'block', evidence } };
      }
    } else {
      if (r.warning) logger.warn(`[Dice API] ${r.warning.code}: ${r.warning.evidence}`);
      else logger.warn(`[Dice API] Returned ${r.status}`);
      return { items: [], warning: r.warning };
    }
  }

  const data = r.json;
  const jobs = data?.data || [];

  // Log the applied date bound so a bug report can confirm the server-side filter
  // actually fired (HTTP-source request URLs aren't otherwise surfaced anywhere).
  logger.info(`[Dice API] Found ${jobs.length} jobs for "${query}" (${bucket ? `filters.postedDate=${bucket}, pageSize=400` : 'no date bucket → pageSize=1000 + client-side filter'})`);

  // Dice's `salary` field is free text — often non-monetary prose like "Depends
  // on Experience", "Competitive", or "Compensation information provided in the
  // description". Keep only values that actually look like money (contain a
  // digit) and aren't one of those known non-monetary phrases, so the renderer's
  // salary parsing/buckets don't ingest garbage. Anything dropped renders as
  // "Unspecified", which is correct.
  const cleanDiceSalary = (raw) => {
    const s = String(raw || '').trim();
    if (!s || !/\d/.test(s)) return '';
    if (/compensation information|depends on|provided in the desc|commensurate|competitive/i.test(s)) return '';
    return s;
  };
  const mapped = jobs.map(job => {
    // List API returns `summary` (short blurb) but rarely `description` (full HTML).
    // Use summary as a placeholder — a second enrichment pass fetches full descriptions
    // per-job via the detail endpoint after all queries are merged and deduped.
    const descFromHtml = job.description
      ? job.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    const descText = descFromHtml || (job.summary || '').trim();
    const snippetText = descText;
    return {
      title: job.title || '',
      company: job.companyName || '',
      location: job.jobLocation?.displayName || '',
      salary: cleanDiceSalary(job.salary),
      snippet: snippetText,
      description: descText,
      url: job.detailsPageUrl || `https://www.dice.com/job-detail/${job.guid || job.id}`,
      posted: job.postedDate || '',
      source: 'dice',
      remote: job.workFromHomeAvailability === 'TRUE',
      employmentType: job.employmentType || '',
      easyApply: job.easyApply || false,
      // Internal field — used by enrichDiceDescriptions(), stripped before returning
      _diceId: job.guid || job.id || '',
    };
  });
  const withDesc = mapped.filter(j => j.description).length;
  logger.info(`[Dice API] ${mapped.length} jobs for "${query}", ${withDesc}/${mapped.length} have descriptions (pre-enrichment)`);
  // Date-filter the wide relevance pull before central collection limiting so
  // the returned rows are the most-relevant in-window jobs. The global pass is
  // a no-op here, not a second policy; `gathered` remains the pre-limit count.
  const inWindow = maxAgeDays ? filterJobsByAge(mapped, maxAgeDays) : mapped;
  // Dice has already searched and ranked these rows for `query`; preserve the
  // complete in-window result set even when its title uses adjacent wording.
  const items = inWindow;
  return {
    items,
    warning: r.warning,
    gathered: inWindow.length,
    providerGathered: inWindow.length,
    relevanceDropped: 0,
    relevanceRejected: [],
    relevanceTrace: [],
  };
}

/**
 * Pre-warm the Dice API key before kicking off the query fan-out, so the key
 * is fresh for all queries and we don't hit 500 → retry → refresh mid-run.
 * Fails silently — the reactive 500-triggered refresh is still the fallback.
 */
export async function warmDiceApiKey(signal = null) {
  try {
    const key = await refreshDiceApiKey(signal);
    if (key) {
      logger.info('[Dice API] API key pre-warmed successfully');
    } else {
      logger.warn('[Dice API] API key pre-warm failed — will fall back to reactive refresh on 500');
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    logger.warn('[Dice API] API key pre-warm error:', err?.message || String(err));
  }
}

/**
 * Walk every JSON-LD `<script>` block in a page's HTML looking for
 * `JobPosting` nodes (handles `@graph` wrappers and array `@type`), calling
 * `visit(node)` for each one found. The first call whose return value is not
 * `undefined` short-circuits the walk and becomes the return value. Never
 * throws on malformed JSON-LD — a bad block is just skipped.
 *
 * Shared by extractJobPostingDescription (harvests `.description`) and
 * extractJobPostingBaseSalary (harvests `.baseSalary`) so the traversal
 * itself — the actual source of truth for "how do we find a JobPosting node
 * in this page" — lives in exactly one place.
 * @param {string} html
 * @param {(node: object) => any} visit
 * @returns {any} — visit's first non-undefined return, or undefined
 */
function walkJsonLdJobPostings(html, visit) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = [data];
    while (stack.length) {
      const node = stack.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) { stack.push(...node); continue; }
      const type = node['@type'];
      const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (isJob) {
        const result = visit(node);
        if (result !== undefined) return result;
      }
      if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
    }
  }
  return undefined;
}

/**
 * Extract JobPosting.description from a page's JSON-LD (handles @graph wrappers
 * and array `@type`). Node-side analogue of the browser scrapers' JSON-LD
 * harvest. Returns '' when no JobPosting description is present, and never throws
 * on malformed JSON-LD. Exported for unit testing.
 * @param {string} html — raw page HTML
 * @returns {string} — the description HTML (caller strips tags), or ''
 */
export function extractJobPostingDescription(html) {
  const desc = walkJsonLdJobPostings(html, (node) => {
    if (typeof node.description === 'string' && node.description.trim()) return node.description;
    return undefined;
  });
  return desc || '';
}

/**
 * Extract JobPosting.baseSalary from a page's JSON-LD (same @graph / array
 * `@type` walk as extractJobPostingDescription — see walkJsonLdJobPostings).
 * `baseSalary` is a schema.org MonetaryAmount: `{ currency, value: {
 * minValue, maxValue, value, unitText } }`, `unitText` being one of
 * HOUR/DAY/WEEK/MONTH/YEAR. Returns the raw object as-is (unformatted) so
 * callers/tests can inspect it directly, or `null` when absent/malformed.
 * Never throws. Exported for unit testing.
 * @param {string} html — raw page HTML
 * @returns {object|null}
 */
export function extractJobPostingBaseSalary(html) {
  const bs = walkJsonLdJobPostings(html, (node) => {
    if (node.baseSalary && typeof node.baseSalary === 'object') return node.baseSalary;
    return undefined;
  });
  return bs || null;
}

// unitText → a cadence suffix parseSalaryToNumeric (src/nodes/jobsearch/
// buildJobTree.js) already recognizes. Deliberately re-implemented locally
// (rather than importing the browser-side formatJsonLdSalary from
// electron/ipc/browser/manualScraper.js) so this HTTP-only extractor file —
// which exists specifically to bypass Puppeteer — doesn't pull in that
// Puppeteer-based module as a dependency.
const JSONLD_SALARY_UNIT_SUFFIX = { YEAR: '/yr', HOUR: '/hr', MONTH: '/mo', WEEK: '/wk', DAY: '/day' };

/**
 * Format a schema.org JobPosting.baseSalary object (see
 * extractJobPostingBaseSalary) into a display string the shared annualizer
 * can read, e.g. "$90,000 - $125,000/yr" or "$24/hr". Returns '' for
 * anything with no recognized `unitText` or no numeric value — an unrecognized
 * unit could be hourly or annual and guessing wrong is worse than leaving the
 * existing (possibly cadence-less) salary text alone. Exported for unit
 * testing.
 * @param {object|null} baseSalary
 * @returns {string}
 */
export function formatDiceBaseSalary(baseSalary) {
  if (!baseSalary || typeof baseSalary !== 'object') return '';
  const v = baseSalary.value && typeof baseSalary.value === 'object' ? baseSalary.value : baseSalary;
  const suffix = JSONLD_SALARY_UNIT_SUFFIX[String(v.unitText || '').toUpperCase()] || '';
  if (!suffix) return '';
  const cur = String(baseSalary.currency || baseSalary.salaryCurrency || '').toUpperCase();
  const sym = (cur === '' || cur === 'USD') ? '$' : `${cur} `;
  const num = (x) => (x == null || Number.isNaN(Number(x))) ? null : Number(x).toLocaleString('en-US');
  const min = num(v.minValue), max = num(v.maxValue), val = num(v.value);
  if (min != null && max != null) return `${sym}${min} - ${sym}${max}${suffix}`;
  if (val != null) return `${sym}${val}${suffix}`;
  // schema.org allows a QuantitativeValue with only one bound, and open-ended
  // postings ("From $19/hr", "Up to $24/hr") do use it. Returning '' here would
  // throw away a cadence we came to recover, leaving the job Unspecified for
  // want of a bound we never needed — the annualizer reads the first number.
  if (min != null) return `From ${sym}${min}${suffix}`;
  if (max != null) return `Up to ${sym}${max}${suffix}`;
  return '';
}

/**
 * Dice's job-detail page renders the posting's OWN pay as a short badge right
 * next to its <h1> title — e.g. "$16 - $16/hr" — even when the very same
 * page's JSON-LD baseSalary carries no unitText to say so. Checked live
 * against 9 real job-detail pages (CONTRACTOR and FULL_TIME, ranged and
 * single-value): baseSalary was always a bare `{currency, minValue,
 * maxValue}` / `{currency, value}` MonetaryAmount with no cadence field
 * anywhere — formatDiceBaseSalary's unitText branch is not wrong, Dice just
 * never populates it, so that path alone recovers zero Dice salaries in
 * practice. The badge is the same real cadence a human visitor sees, not a
 * guess.
 *
 * The same page also lists OTHER jobs' salaries further down (a "Related
 * jobs" rail, worded "$X.XX - $Y.YY per hour"), which must never be
 * attributed to this job. Rather than scan the whole page, the search is
 * bounded to a window right after the FIRST <h1> — the primary job's own
 * title, always followed immediately by its info-badge row and always far
 * ahead of any other job's content (verified against live pages: the
 * primary badge sits ~1.2–1.6k chars after <h1>; the nearest unrelated
 * salary is 20k+ chars further on).
 *
 * Returns '' when no badge is present in that window (e.g. "Depends on
 * Experience" has no cadence to show) — never guesses. Exported for unit
 * testing.
 * @param {string} html — raw detail-page HTML
 * @returns {string} — e.g. "$16 - $16/hr", or ''
 */
export function extractDiceSalaryBadge(html) {
  const h1 = /<h1[^>]*>/i.exec(html || '');
  if (!h1) return '';
  const window = html.slice(h1.index, h1.index + 4000);
  const m = /\$\s*[\d,.]+(?:\s*-\s*\$?\s*[\d,.]+)?\s*\/\s*(?:hr|hour|yr|year|mo|month|wk|week|day)\b/i.exec(window);
  return m ? m[0].replace(/\s+/g, ' ').trim() : '';
}

/**
 * Second-pass enrichment: fetch full job descriptions for each job in the
 * already-deduped Dice list.
 *
 * The list search API only returns a ~500-char `summary`. Dice's per-job detail
 * API route (/v1/dice/jobs/{id}) does NOT exist — it 404s with API-Gateway's
 * "Missing Authentication Token" — so we fetch the public job-detail PAGE
 * (www.dice.com/job-detail/{guid}, plain HTTP 200) and harvest the full JD from
 * its JSON-LD JobPosting.description, the same structured field the browser
 * scrapers read. Runs after all queries are merged and deduped so we only fetch
 * for unique jobs, not per-query duplicates.
 *
 * Batched at 10 concurrent requests. Fails gracefully per job — keeps the list
 * summary as fallback if the detail fetch or JSON-LD harvest fails.
 *
 * @param {Array}       jobs   — deduped job objects (each has `url` / `_diceId`)
 * @param {AbortSignal} signal — propagated abort signal
 * @returns {Promise<Array>}   — same jobs with `description` + `snippet` enriched
 */
export async function enrichDiceDescriptions(jobs, signal) {
  if (!jobs?.length) return jobs;

  const BATCH = 10;
  const enriched = [];
  // Telemetry: did the detail endpoint actually return a FULLER description than
  // the list `summary`, or are we silently falling back to Dice's ~500-char
  // summary? The old "N/N have descriptions" (>300 chars) log hid this — the
  // uniform ~500-char Dice snippets seen in bug reports trace straight to here.
  let lengthened = 0;
  // Telemetry: how many salaries were upgraded from cadence-less Dice text
  // (e.g. "25", "$20 - $24" — see cleanDiceSalary above) to a real cadenced
  // value recovered from the detail page (JSON-LD baseSalary, or — the path
  // that actually fires for Dice — the page's own salary badge; see
  // extractDiceSalaryBadge).
  let salaryUpgraded = 0;
  const fallbackReasons = {}; // reason -> count
  let sampleFail = '';
  const note = (reason, ref) => {
    fallbackReasons[reason] = (fallbackReasons[reason] || 0) + 1;
    if (!sampleFail) sampleFail = `${reason} @ ${ref || '?'}`;
  };

  for (let i = 0; i < jobs.length; i += BATCH) {
    if (signal?.aborted) break;
    const batch = jobs.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (job) => {
      const summaryLen = (job.snippet || '').length;
      // Fetch the public job-detail PAGE and harvest JSON-LD JobPosting.description
      // (the API has no per-job detail route — see function doc). `job.url` is the
      // detailsPageUrl; fall back to constructing it from the guid.
      const url = job.url || (job._diceId ? `https://www.dice.com/job-detail/${job._diceId}` : '');
      if (!url) { note('no-url', job.url); return job; }
      try {
        const r = await safeApiFetch(url, {
          headers: {
            'User-Agent': getRandomUA(),
            'Accept': 'text/html,application/xhtml+xml',
          },
          signal: createTimeoutSignal(signal, apiTimeout('dice-api')),
        }, 'dice-detail');
        if (!r.ok) { note(`http-${r.status}`, url); return job; }
        const html = r.text || '';
        // Salary cadence recovery: Dice's free-text `salary` field sometimes
        // loses its cadence in cleanup ("25", "$20 - $24") and annualizes to
        // 0/Unspecified even though the job has real pay. Reuse the SAME
        // page HTML already fetched above (no extra request) and try two
        // structured sources, in order: the JSON-LD baseSalary's unitText
        // (schema.org-correct; kept in case Dice ever populates it — see
        // formatDiceBaseSalary), then the page's own salary badge next to
        // the job title, which is what Dice's real markup actually carries
        // the cadence in (see extractDiceSalaryBadge). Either way this only
        // UPGRADES a salary the shared annualizer can't already read; Dice's
        // own text stays authoritative whenever it already parses to a real
        // number.
        let salaryPatch = null;
        if (parseSalaryToNumeric(job.salary) === 0) {
          const formatted = formatDiceBaseSalary(extractJobPostingBaseSalary(html)) || extractDiceSalaryBadge(html);
          if (formatted) { salaryPatch = formatted; salaryUpgraded += 1; }
        }
        const descHtml = extractJobPostingDescription(html);
        if (!descHtml) {
          note('no-jsonld-desc', url);
          return salaryPatch ? { ...job, salary: salaryPatch } : job;
        }
        const descText = descHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!descText) {
          note('empty-after-strip', url);
          return salaryPatch ? { ...job, salary: salaryPatch } : job;
        }
        const rest = { ...job };
        delete rest._diceId;
        if (salaryPatch) rest.salary = salaryPatch;
        // Keep whichever is longer — guards against a stub JSON-LD shorter than
        // the list summary we already had.
        if (descText.length > summaryLen) {
          lengthened += 1;
          return { ...rest, description: descText, snippet: descText };
        }
        note('not-longer-than-summary', url);
        const best = (rest.snippet && rest.snippet.length >= descText.length) ? rest.snippet : descText;
        return { ...rest, description: best, snippet: best };
      } catch {
        note('fetch-error', url);
        return job; // keep summary on error
      }
    }));
    enriched.push(...results);
  }

  // Strip _diceId from any jobs not enriched above (e.g. aborted mid-run)
  const cleaned = enriched.map((job) => {
    const rest = { ...job };
    delete rest._diceId;
    return rest;
  });

  const reasonStr = Object.entries(fallbackReasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ');
  const fellBack = cleaned.length - lengthened;
  logger.info(`[Dice API] Enriched ${cleaned.length} jobs — ${lengthened} genuinely lengthened from detail endpoint, ${salaryUpgraded} salaries cadence-upgraded from the detail page${fellBack > 0 ? `; ${fellBack} kept list summary [${reasonStr}${sampleFail ? ` — e.g. ${sampleFail}` : ''}]` : ''}`);
  return cleaned;
}
