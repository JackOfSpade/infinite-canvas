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
import { JOB_RESULT_CAP } from '../ipc/resultCaps.js';
import { filterJobsByAge } from '../ipc/jobDateFilter.js';
import { sourceJobKey } from '../../src/utils/jobIdentity.js';
import { isPriceChartingApplicable, isAptDecoApplicable } from '../../src/utils/compSourceScope.js';
import { parseSalaryToNumeric } from '../../src/nodes/jobsearch/buildJobTree.js';

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
// Public endpoint: linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
// Returns HTML snippets of job cards — no auth, no page rendering needed.
// Paginates in increments of 25 via the `start` parameter.

/**
 * Fetch jobs from LinkedIn's public API endpoint (no login needed).
 * Accepts a single query string or an array of up to 3 query strings.
 * Multiple queries are walked sequentially with an inter-query jitter pause
 * and deduplicated by job URL so the same posting isn't returned twice.
 */
export async function fetchLinkedInJobs(queries, signal = null, maxAgeDays = null, location = '') {
  const locParam = String(location || '').trim();
  const queryList = Array.isArray(queries) ? queries : [queries];
  const seenUrls = new Set();
  const allJobs = [];
  let warning = null;

  for (let qi = 0; qi < queryList.length; qi++) {
    if (signal?.aborted) break;
    // Stop querying if a previous query was blocked — subsequent ones will be too.
    if (warning) break;
    // Inter-query pause (not before the first query). humanDelay gives a
    // log-normal spread around the anchor so a multi-query walk doesn't look
    // like a fixed drumbeat (anchor ≈ the old 3–6s uniform window's midpoint).
    if (qi > 0) await new Promise(res => setTimeout(res, humanDelay(4500)));

    const query = queryList[qi];
    // Walk up to 150 results (6 pages × 25). LinkedIn's guest API is heavily
    // anti-bot, so depth is PACED, not blitzed:
    //   • a humanDelay log-normal gap (~6s anchor) before each page after the first
    //     (a fixed 2s drumbeat is a tell — an organically-spread cadence is the
    //     main signal we control),
    //   • an early-exit the moment a page adds no new cards (below), so a low-volume
    //     query never walks all 6 pages — we only go deep when results justify it,
    //   • bail on the first block/non-OK (below), returning whatever we gathered so
    //     far rather than hammering through and turning a soft throttle into a 0.
    const LINKEDIN_MAX_RESULTS = 150;
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
        break;
      }

      const html = r.text;
      if (!html || html.trim().length < 50) break;

      // Parse HTML snippets with regex — LinkedIn returns <li> cards
      // Each card has: title in <h3>, company in <h4>, location, link, datetime
      const cardPattern = /<li[\s\S]*?<\/li>/gi;
      const cards = html.match(cardPattern) || [];

      let pageUrlMisses = 0;
      const before = allJobs.length;
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

          let rawUrl = linkMatch?.[1]?.split('?')[0] || '';
          // Normalize relative /jobs/view/ paths to absolute URLs
          if (rawUrl.startsWith('/')) rawUrl = `https://www.linkedin.com${rawUrl}`;
          const url = rawUrl;
          if (!url) pageUrlMisses++;
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

      // Page added nothing new → results exhausted (or a soft block served an empty
      // shell). Stop instead of spending more requests walking empty pages.
      if (allJobs.length === before) break;
    }
  }

  // `gathered` = pre-cap match count. When it exceeds the surfaced item count the
  // slice silently dropped in-window jobs (the API analogue of the browser walk's
  // `ceiling` stop); the bug-report funnel flags that so it isn't a silent miss.
  return { items: allJobs.slice(0, JOB_RESULT_CAP), warning, gathered: allJobs.length };
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

export async function enrichLinkedInDescriptionsBrowser(jobs, signal) {
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
    return linkedInBrowserUnavailableResult(jobs, err);
  }
  // Browser-process identity for this pass. Returned to the caller so the bug
  // report's egress-IP trail can show whether consecutive passes ran on the SAME
  // browser instance — the discriminator for "browser/session-based limit vs
  // per-IP": if the IP changes but the limit doesn't recover within one browser
  // generation, it's the browser; if a relaunch (new generation) on the same IP
  // recovers it, it's the browser too — not the IP.
  const browserInfo = getStealthBrowserInfo();

  // Enrichment runs in an isolated context with NO cookies.
  // When the shared browser context is used (browser.newPage()), the new tab
  // inherits the LinkedIn login cookies → LinkedIn serves the React SPA version
  // of job detail pages, which has zero JSON-LD and no server-rendered description
  // (probe-confirmed 2026-05-28). An isolated context is anonymous → it serves the
  // guest/SEO version, which server-renders a full JobPosting JSON-LD block at
  // DOMContentLoaded. Stealth flags (UA, WebGL, etc.) still apply.
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
  let page = null;
  let contextRotations = 0;
  let jobsThisContext = 0; // completed (non-walling) navigations on the current context
  const rotateContext = async () => {
    await isolatedCtx?.close().catch(() => {});
    isolatedCtx = await browser.createBrowserContext();
    page = await isolatedCtx.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    jobsThisContext = 0;
  };
  try {
    await rotateContext(); // initial context (contextRotations stays 0 — see below)
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

      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 15000 });

        const finalUrl = page.url();
        consecutiveNavErrors = 0; // a navigation completed → the uplink is alive

        // HTTP-redirect login wall: LinkedIn changed the URL to an auth page.
        if (LOGIN_WALL_RE.test(finalUrl)) {
          if (await handleWall(finalUrl, i)) break;
          i--; continue; // retry this job on the fresh context
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
          // JS-redirect login wall: LinkedIn redirected mid-evaluate.
          if (LOGIN_WALL_RE.test(result.postEvalUrl || '')) {
            if (await handleWall(result.postEvalUrl, i)) break;
            i--; continue; // retry this job on the fresh context
          }
          // N consecutive eval errors without a URL-matchable redirect → still
          // treat as a systematic wall; rotate-and-retry (handleWall stops if a
          // fresh context fails too).
          if (consecutiveEvalErrors >= JS_REDIRECT_WALL_THRESHOLD) {
            if (await handleWall(result.postEvalUrl || page.url(), i - (consecutiveEvalErrors - 1))) break;
            i--; continue; // retry on the fresh context
          }
        } else {
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
      jobsThisContext++;

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
  }

  const attempted = loginWallAt !== null
    ? loginWallAt
    : (stoppedNoInternetAt !== null ? stoppedNoInternetAt : enriched.length);
  const failParts = [];
  if (navErrors > 0) failParts.push(`${navErrors} nav-err`);
  if (evalErrors > 0) failParts.push(`${evalErrors} eval-err`);
  if (noDesc > 0) failParts.push(`${noDesc} no-desc [${noDescSoftBlock} soft-block, ${noDescGenuine} genuine]`);
  const failSuffix = failParts.length ? ` (${failParts.join(', ')})` : '';
  const wallSuffix = loginWallAt !== null ? ` — login wall at job ${loginWallAt + 1}, ${enriched.length - loginWallAt - 1} skipped` : '';
  const offlineSuffix = noInternet ? ` — STOPPED: egress offline at job ${(stoppedNoInternetAt ?? 0) + 1}, ${enriched.length - (stoppedNoInternetAt ?? enriched.length) - 1} unattempted` : '';
  const rotateSuffix = contextRotations > 0 ? ` — ${contextRotations} context rotation(s)` : '';
  const firstFailSuffix = firstFailNote !== null ? ` — first fail: ${firstFailNote}` : '';
  logger.info(`[LinkedIn/Browser] ${successCount}/${attempted} descriptions enriched${failSuffix}${rotateSuffix}${wallSuffix}${offlineSuffix}${firstFailSuffix}`);
  return {
    jobs: enriched, loginWall: loginWallAt !== null, loginWallUrl, successCount, attempted, contextRotations, noInternet,
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
  // Common title abbreviations/near-equivalents. These remain safe because a
  // multi-concept query still needs local corroboration: "Maintenance Tech" and
  // "Maintenance Worker" match Maintenance Technician, while "Field Service
  // Technician" still lacks the maintenance concept and is rejected.
  ['technician', [['tech'], ['worker']]],
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
 * Compact evidence for a keyword-less remote-feed match. This is kept out of
 * the job object itself: it is report telemetry, not prompt/card payload.
 */
export function jobRelevanceEvidence(roleText, query, geoTerms = EMPTY_GEO) {
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
  if (useTerms.length === 0) return null;
  // Match whole words, never substrings: "service" must not match the
  // unrelated company name "Professional Services". Tokenizing also makes
  // punctuation variants such as "Customer-Service Coordinator" equivalent
  // to the query's separate words.
  const roleTokenList = text.match(/[a-z0-9]+/g) || [];
  const roleTokens = new Set(roleTokenList);
  const queryTokens = new Set(terms.map(norm).filter(Boolean));
  const matchConcept = (term) => {
    if (roleTokens.has(term)) return {
      queryTerm: term, matched: term, matchedTokens: [term], kind: 'exact',
    };
    for (const alias of JOB_ROLE_CONCEPT_ALIASES.get(term) || []) {
      if (alias.every(token => roleTokens.has(token))) {
        return {
          queryTerm: term, matched: alias.join(' '), matchedTokens: alias, kind: 'synonym',
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
  if (hasConflictingAmbiguousDomain) return null;
  // A query with two or more actual role/skill nouns has enough signal to
  // require corroboration. Two-of-three intentionally keeps close variants
  // such as "Customer Service Representative" for a "Customer Service
  // Coordinator" search, while excluding a job that only happens to mention
  // "customer" or "service" in a tag. Do not tighten a single-noun query or
  // the all-generic fallback; those have no second role signal to require.
  const minMatches = meaningful.length >= 2 ? 2 : 1;
  if (matchedConcepts.length < minMatches) return null;
  // Matching two disconnected words is not corroboration. In particular,
  // USAJobs' broad Keyword endpoint returned "TRANSPORTATION ASSISTANT
  // (PERSONAL PROPERTY)" for "Property Management Assistant": `assistant`
  // and `property` satisfied the old two-of-three rule despite describing an
  // unrelated transportation job. Require a multi-concept match to occur as
  // one local title phrase. This retains genuine word-order variants such as
  // "Assistant Property Manager" (assistant/property are adjacent) and
  // "Housing Management Assistant" (management/assistant are adjacent), but
  // does not allow distant ambient terms to assemble a false role match.
  const spansFor = (phrase) => {
    const words = Array.isArray(phrase) ? phrase : [];
    const spans = [];
    for (let start = 0; start <= roleTokenList.length - words.length; start++) {
      if (words.every((word, offset) => roleTokenList[start + offset] === word)) {
        spans.push({ start, end: start + words.length - 1 });
      }
    }
    return spans;
  };
  if (minMatches > 1) {
    const locallyCorroborated = matchedConcepts.some((left, i) =>
      matchedConcepts.slice(i + 1).some(right =>
        spansFor(left.matchedTokens).some(a => spansFor(right.matchedTokens).some(b =>
          a.start <= b.end + 1 && b.start <= a.end + 1,
        )),
      ),
    );
    if (!locallyCorroborated) return null;
  }
  return {
    query: String(query || '').slice(0, 120),
    terms: useTerms.map(norm).slice(0, 12),
    // `matchedTerms` is kept for compact/backward-compatible report output;
    // `matchedConcepts` records exact versus synonym evidence for diagnosis.
    matchedTerms: matchedConcepts.map(match => match.queryTerm).slice(0, 12),
    matchedConcepts: matchedConcepts.map(match => ({
      queryTerm: match.queryTerm, matched: match.matched, kind: match.kind,
    })).slice(0, 12),
    requiredMatches: minMatches,
    fallbackTerms: meaningful.length === 0,
  };
}

export function jobRelevanceMatch(roleText, query, geoTerms = EMPTY_GEO) {
  return !!jobRelevanceEvidence(roleText, query, geoTerms);
}

/** USAJobs Keyword searches the whole announcement; the app needs role-title relevance. */
export function filterUSAJobsByTitleRelevance(jobs, query) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) =>
    jobRelevanceEvidence(job?.title, query),
  );
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
export async function fetchUSAJobs(query, apiKey, email, signal = null, maxAgeDays = 30, location = '') {
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

  const requestedAgeDays = Math.max(1, Math.floor(maxAgeDays || 30));
  const params = new URLSearchParams({
    Keyword: query,
    ResultsPerPage: '150', // uncapped breadth; USAJobs DatePosted below already keeps these in-window
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
    return { items: [], warning: r.warning };
  }

  const data = r.json;
  const resultItems = data?.SearchResult?.SearchResultItems || [];

  const mapped = resultItems.map(item => {
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
  // Keyword searches look throughout the full announcement and include
  // synonyms, which let a single generic word (e.g. "Assistant") admit an
  // unrelated title. The app is searching for roles, so require the returned
  // position title to carry the same conservative relevance evidence used for
  // remote feeds. This mirrors USAJobs' documented PositionTitle semantics
  // without issuing a second request or silently inventing phrase syntax.
  const relevant = filterUSAJobsByTitleRelevance(mapped, query);
  const items = relevant.slice(0, JOB_RESULT_CAP);
  // A bounded sample of what the gate THREW AWAY. The count alone ("rejected 53
  // rows") can't distinguish a gate doing its job from one that over-rejects and
  // silently starves the source — the titles are the only way to tell, and they
  // are unrecoverable after this function returns. Kept tiny and title-only so it
  // can never pollute cards, scoring prompts, snapshots or history rows.
  // `filterUSAJobsByTitleRelevance` returns the original mapped objects, so
  // identity is the exact kept/rejected discriminator. URL membership is not:
  // a malformed row can have no URL, and duplicate URLs would make an unrelated
  // row look kept merely because another row with that URL passed the gate.
  const relevantRows = new Set(relevant);
  const relevanceRejected = mapped
    .filter(job => !relevantRows.has(job))
    .map(job => job.title)
    .filter(Boolean)
    .slice(0, 8);
  return {
    items,
    warning: r.warning,
    gathered: relevant.length,
    providerGathered: resultItems.length,
    relevanceDropped: resultItems.length - relevant.length,
    relevanceRejected,
  }; // gathered: relevant pre-cap matches (see fetchLinkedInJobs)
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
 * Fetch jobs from RemoteOK's open JSON API (bypasses Puppeteer entirely).
 */
export async function fetchRemoteOKJobs(queries, signal = null, geoTerms = EMPTY_GEO) {
  const r = await safeApiFetch('https://remoteok.com/api', {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: createTimeoutSignal(signal, apiTimeout('remoteok-api')),
  }, 'remoteok');

  if (!r.ok) {
    if (r.warning) logger.warn(`[RemoteOK API] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.warn(`[RemoteOK API] Returned ${r.status}`);
    return { items: [], warning: r.warning };
  }

  const data = r.json;
  // First element is metadata, rest are jobs
  const jobs = Array.isArray(data) ? data.slice(1) : [];

  // Filter: job matches if relevant to ANY query (OR logic across all queries),
  // after dropping RemoteOK's sponsored placements. Those are product ads sold
  // into the same /api feed, not postings: `company` is the literal pseudo-
  // employer "AI Supermarket", `position` holds a PRODUCT name, and the
  // description is ~14k chars of boilerplate ad copy repeated verbatim across
  // every placement. They carry a 25-tag scattershot tag list that matches
  // almost any query, so they sail through relevance — a live run surfaced six
  // of them ("Apify", "Beehiiv", "Meshy"…) as 6 of RemoteOK's 10 results, all
  // scored and shown to the user as if they were jobs.
  const qs = Array.isArray(queries) ? queries : [queries];
  const sponsored = [];
  const matched = jobs.flatMap(job => {
    if (isRemoteOkSponsoredPlacement(job)) {
      sponsored.push(String(job.position || '?'));
      return [];
    }
    // RemoteOK tags are broad, user-supplied metadata rather than the job's
    // actual role (a coffee-roaster row can carry customer-service tags). Keep
    // whole-feed relevance anchored to the position; company names are likewise
    // not role evidence (e.g. "Professional Services").
    const evidence = qs.map(q => jobRelevanceEvidence(job.position, q, geoTerms)).filter(Boolean);
    return evidence.length > 0 ? [{ job, evidence }] : [];
  });
  if (sponsored.length > 0) {
    logger.info(`[RemoteOK API] dropped ${sponsored.length} sponsored ad placement(s): ${sponsored.slice(0, 6).join(', ')}`);
  }

  const relevanceTrace = [];
  const items = matched.slice(0, JOB_RESULT_CAP).map(({ job, evidence }) => {
    // RemoteOK's API returns description as raw HTML — strip tags to plain text.
    const descText = job.description ? job.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const tags = (job.tags || []).join(', ');
    const url = job.url ? (String(job.url).startsWith('http') ? job.url : `https://remoteok.com${job.url}`) : '';
    relevanceTrace.push({
      url,
      title: String(job.position || '').slice(0, 160),
      company: String(job.company || '').slice(0, 120),
      matched: evidence,
      // Included specifically to prove they were NOT relevance evidence: the
      // matcher intentionally reads the position only.
      tags: Array.isArray(job.tags) ? job.tags.map(t => String(t).slice(0, 50)).slice(0, 20) : [],
    });
    return {
      title: job.position || '',
      company: job.company || '',
      location: job.location || 'Remote',
      salary: job.salary || (job.salary_min ? `$${job.salary_min} - $${job.salary_max}` : ''),
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
    };
  });
  const withDesc = items.filter(j => j.description).length;
  logger.info(`[RemoteOK API] ${items.length} jobs matched, ${withDesc}/${items.length} have descriptions`);
  return { items, warning: r.warning, gathered: matched.length, relevanceTrace }; // gathered: pre-cap matches (see fetchLinkedInJobs)
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
export async function fetchWeWorkRemotelyJobs(queries, signal = null, geoTerms = EMPTY_GEO) {
  const r = await safeApiFetch('https://weworkremotely.com/remote-jobs.rss', {
    headers: {
      'Accept': 'application/rss+xml, application/xml, text/xml',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: createTimeoutSignal(signal, apiTimeout('wwr-api')),
  }, 'weworkremotely');

  if (!r.ok) {
    if (r.warning) logger.warn(`[WWR RSS] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.warn(`[WWR RSS] Returned ${r.status}`);
    return { items: [], warning: r.warning };
  }

  const xml = r.text;
  const qs = Array.isArray(queries) ? queries : [queries];

  // Parse RSS items with regex (no XML parser dependency needed)
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  const rssItems = xml.match(itemPattern) || [];
  const jobs = [];
  const relevanceTrace = [];

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

    // Filter: job matches if relevant to ANY query (OR logic across all queries).
    // RSS titles are "Company: Job title". A company such as "Customer.io" or
    // "Professional Services" must not make an unrelated vacancy relevant, so
    // match only the parsed job-title portion.
    const evidence = qs.map(q => jobRelevanceEvidence(jobTitle, q, geoTerms)).filter(Boolean);
    if (evidence.length === 0) continue;

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
      posted: pubDateMatch?.[1] ? new Date(pubDateMatch[1]).toLocaleDateString() : '',
      source: 'weworkremotely',
    });
    relevanceTrace.push({
      url,
      title: String(jobTitle).slice(0, 160),
      company: String(company).slice(0, 120),
      matched: evidence,
      tags: [],
    });
  }

  const withDesc = jobs.filter(j => j.description).length;
  logger.info(`[WWR RSS] ${jobs.length} jobs matched, ${withDesc}/${jobs.length} have descriptions`);

  const items = jobs.slice(0, JOB_RESULT_CAP);
  const returnedUrls = new Set(items.map(job => job.url));
  return { items, warning: r.warning, gathered: jobs.length, relevanceTrace: relevanceTrace.filter(row => returnedUrls.has(row.url)) }; // gathered: pre-cap matches (see fetchLinkedInJobs)
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
  return out;
}

function collectIndeedJobsFromObject(root) {
  const jobs = [];
  const seenObjects = new WeakSet();
  const stack = [root];
  let inspected = 0;

  while (stack.length && inspected < 60000) {
    const node = stack.pop();
    inspected++;
    if (!node || typeof node !== 'object') continue;
    if (seenObjects.has(node)) continue;
    seenObjects.add(node);

    const normalized = normalizeIndeedCandidate(node);
    if (normalized) jobs.push(normalized);

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
    } else {
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
  }

  return dedupeIndeedJobs(jobs);
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
      });
    } catch { /* skip malformed card */ }
  });

  return dedupeIndeedJobs(jobs);
}

// windowMosaicResults: pre-extracted array from window.mosaic.providerData
// ['mosaic-provider-jobcards'].metaData.mosaicProviderJobCardsModel.results
// passed in by the Puppeteer scraper via page.evaluate(). When provided it
// replaces the broken HTML marker approach (which hits a CSS URL, not data).
export function extractIndeedJobsFromHtml(html, windowMosaicResults = null) {
  const nextData = extractNextDataJobs(html);
  const mosaic   = windowMosaicResults
    ? collectIndeedJobsFromObject(windowMosaicResults)
    : extractMosaicJobs(html);
  const dom      = extractDomJobs(html);
  logger.info(`[Indeed/extract] __NEXT_DATA__: ${nextData.length}, mosaic: ${mosaic.length}, dom: ${dom.length}`);
  return dedupeIndeedJobs([...nextData, ...mosaic, ...dom]);
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
        retryKey = await refreshDiceApiKey();
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
  // Date-filter the wide relevance pull, THEN cap — so the kept JOB_RESULT_CAP are
  // the most-relevant IN-WINDOW jobs (reuses the shared age filter; same cutoff the
  // global pass applies, so this is a no-op there, not a second policy). `gathered`
  // = in-window matches before the cap, so the funnel flags when there were more.
  const inWindow = maxAgeDays ? filterJobsByAge(mapped, maxAgeDays) : mapped;
  // Dice's search endpoint is deliberately broad: a query for "Housekeeping
  // Supervisor" can return generic Maintenance/Production/Shift Supervisor
  // roles. Score relevance on the position title before result caps so those
  // rows do not consume the source budget or AI scoring slots. Keep both sides
  // of the decision in bounded diagnostics; queryFanOut merges this telemetry.
  const admitted = [];
  const relevanceRejected = [];
  const relevanceTrace = [];
  for (const job of inWindow) {
    const evidence = jobRelevanceEvidence(job.title, query);
    if (!evidence) {
      if (relevanceRejected.length < 8) relevanceRejected.push(job.title);
      continue;
    }
    admitted.push(job);
    if (relevanceTrace.length < 20) {
      relevanceTrace.push({
        url: job.url,
        title: job.title,
        company: job.company,
        matched: [evidence],
      });
    }
  }
  const items = admitted.slice(0, JOB_RESULT_CAP);
  return {
    items,
    warning: r.warning,
    gathered: admitted.length,
    providerGathered: inWindow.length,
    relevanceDropped: inWindow.length - admitted.length,
    relevanceRejected,
    relevanceTrace,
  };
}

/**
 * Pre-warm the Dice API key before kicking off the query fan-out, so the key
 * is fresh for all queries and we don't hit 500 → retry → refresh mid-run.
 * Fails silently — the reactive 500-triggered refresh is still the fallback.
 */
export async function warmDiceApiKey() {
  try {
    const key = await refreshDiceApiKey();
    if (key) {
      logger.info('[Dice API] API key pre-warmed successfully');
    } else {
      logger.warn('[Dice API] API key pre-warm failed — will fall back to reactive refresh on 500');
    }
  } catch (err) {
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
