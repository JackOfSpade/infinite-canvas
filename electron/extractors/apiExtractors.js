/**
 * API-Based Job Extractors — Indeed/Scrapfly, LinkedIn, Greenhouse, Lever, USAJobs.
 *
 * These bypass Puppeteer entirely, using plain HTTP fetch() against
 * publicly accessible JSON APIs or hidden HTML endpoints.
 * Zero WAF risk, structured data, no auth needed.
 *
 * All functions return the standard job shape:
 *   { title, company, location, salary, snippet, url, posted, source }
 */
import { logger } from '../logger.js';
import { queueScrape } from '../ipc/browserPool.js';
import { getRandomUA, refreshDiceApiKey, getStealthBrowser } from '../ipc/stealthBrowser.js';
import { humanDelay } from '../utils/humanDelay.js';
import { getDiceApiKey, getJobsSettings } from '../ipc/settings.js';
import { htmlToText } from 'html-to-text';
import { JSDOM } from 'jsdom';
import { resolveBudget } from '../ipc/scrapeBudget.js';
import { JOB_RESULT_CAP } from '../ipc/resultCaps.js';
import { filterJobsByAge } from '../ipc/jobDateFilter.js';
import { jobTitleCompanyLocationKey } from '../../src/utils/jobIdentity.js';

// Per-source API fetch timeouts. These are SEEDS / ceilings, read through the
// shared scrapeBudget store so they live in one place and share the budget
// machinery used by the browser scrape path. NOTE: unlike the browser path
// these are single-shot fetches with no "time to stable" to learn from, so
// they're not actively learned yet — this indirection removes the scattered
// magic literals and leaves a single hook to switch on learning later.
const API_TIMEOUT_SEEDS = {
  'linkedin-api':   10000,
  'linkedin-detail': 15000,
  'greenhouse-api':  8000,
  'lever-api':       8000,
  'usajobs-api':    10000,
  'remoteok-api':   10000,
  'wwr-api':        10000,
  'reverb-api':     12000,
  'dice-api':       10000,
  'stockx-api':     10000,
  'scrapfly-api':  160000, // Scrapfly default read timeout is 155s; leave client overhead.
};

/** Resolve an API fetch timeout from its seed via the shared budget store. */
function apiTimeout(key) {
  return resolveBudget(key, API_TIMEOUT_SEEDS[key] ?? 10000).timeoutMs;
}


/**
 * Process a list of items concurrently in batches.
 * @param {Array} items - The items to process
 * @param {number} batchSize - Number of items to process concurrently
 * @param {Function} processFn - Async function to run on each item. Should return an array of results.
 * @returns {Array} - Flattened array of all successful results.
 */
async function processInBatches(items, batchSize, processFn, signal = null) {
  const allResults = [];
  for (let i = 0; i < items.length; i += batchSize) {
    if (signal?.aborted) break;
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(processFn));
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        allResults.push(...r.value);
      }
    }
  }
  return allResults;
}

/**
 * Combines an IPC abort signal (for window closes) with a hard timeout.
 * Prevents fetch requests from hanging forever if the backend drops connection.
 */
function createTimeoutSignal(baseSignal, timeoutMs) {
  if (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.any([baseSignal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);

  if (baseSignal) {
    if (baseSignal.aborted) {
      clearTimeout(timeoutId);
      controller.abort(baseSignal.reason);
      return controller.signal;
    }
    const abortHandler = () => {
      clearTimeout(timeoutId);
      controller.abort(baseSignal.reason);
    };
    baseSignal.addEventListener('abort', abortHandler, { once: true });
    
    // Cleanup if timeout triggers first
    controller.signal.addEventListener('abort', () => {
      if (controller.signal.reason?.message?.startsWith('Timeout')) {
        baseSignal.removeEventListener('abort', abortHandler);
      }
    }, { once: true });
  }

  return controller.signal;
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
export async function fetchLinkedInJobs(queries, signal = null, maxAgeDays = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const queryList = Array.isArray(queries) ? queries : [queries];
  const seenUrls = new Set();
  const allJobs = [];
  let warning = null;

  for (let qi = 0; qi < queryList.length; qi++) {
    if (signal?.aborted) break;
    // Stop querying if a previous query was blocked — subsequent ones will be too.
    if (warning) break;
    // Inter-query pause (not before the first query). Irregular cadence like the
    // inter-page jitter so a multi-query walk doesn't look like a fixed drumbeat.
    if (qi > 0) await new Promise(res => setTimeout(res, 3000 + Math.floor(Math.random() * 3000)));

    const query = queryList[qi];
    // Walk up to 150 results (6 pages × 25). LinkedIn's guest API is heavily
    // anti-bot, so depth is PACED, not blitzed:
    //   • a jittered 4–8s human-scale gap before each page after the first (a fixed
    //     2s drumbeat is a tell — irregular cadence is the main signal we control),
    //   • an early-exit the moment a page adds no new cards (below), so a low-volume
    //     query never walks all 6 pages — we only go deep when results justify it,
    //   • bail on the first block/non-OK (below), returning whatever we gathered so
    //     far rather than hammering through and turning a soft throttle into a 0.
    const LINKEDIN_MAX_RESULTS = 150;
    for (let start = 0; start < LINKEDIN_MAX_RESULTS; start += 25) {
      if (signal?.aborted) break;
      // Human-scale jittered pause before each subsequent page.
      if (start > 0) await new Promise(res => setTimeout(res, 4000 + Math.floor(Math.random() * 4000)));
      const params = new URLSearchParams({
        keywords: query,
        start: String(start),
        sortBy: 'R', // explicit relevance (= LinkedIn's default; the value its own UI sends, so anti-bot-neutral)
      });
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
 * Second-pass enrichment: fetch full job descriptions from LinkedIn public
 * job detail pages for each job in the already-deduped list.
 *
 * LinkedIn's guest search API (/jobs-guest/...) returns no description field.
 * Job detail pages (linkedin.com/jobs/view/{id}) theoretically server-render a
 * JobPosting JSON-LD schema with the full description, but LinkedIn returns
 * HTTP 999 to plain Node.js fetch() — a browser (Puppeteer) would be needed
 * to bypass this. This function is kept in place for future Puppeteer upgrade
 * and to surface the failure clearly in logs.
 *
 * Strategy: parse <script type="application/ld+json"> for a JobPosting entry
 * and strip its HTML description. Falls back to regex-extracting the
 * description container div if JSON-LD is absent or malformed.
 *
 * Batched at 5 concurrent. Logs failure reasons (status code, anti-bot warning)
 * so the ring buffer shows exactly why descriptions weren't fetched.
 *
 * @param {Array}       jobs   — deduped job objects from fetchLinkedInJobs
 * @param {AbortSignal} signal — propagated abort signal
 * @returns {Promise<Array>}   — same jobs with `description` + `snippet` enriched
 */
export async function enrichLinkedInDescriptions(jobs, signal) {
  if (!jobs?.length) return jobs;
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');

  const BATCH = 5;
  const enriched = [];
  let failNonOk = 0;
  let failNoText = 0;
  let failNoParse = 0;
  let firstFailStatus = null;
  let firstFailWarning = null;

  for (let i = 0; i < jobs.length; i += BATCH) {
    if (signal?.aborted) break;
    const batch = jobs.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (job) => {
      if (!job.url) return job;
      try {
        const r = await safeApiFetch(job.url, {
          headers: {
            'User-Agent': getRandomUA(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.linkedin.com/jobs/search/',
          },
          signal: createTimeoutSignal(signal, apiTimeout('linkedin-detail')),
        }, 'linkedin');
        if (!r.ok) {
          failNonOk++;
          if (firstFailStatus === null) firstFailStatus = r.status;
          if (firstFailWarning === null && r.warning) firstFailWarning = r.warning.code || r.warning;
          return job;
        }
        if (!r.text) { failNoText++; return job; }

        // Prefer JSON-LD JobPosting schema — stable across LinkedIn deploys.
        // LinkedIn includes this for SEO/Google Jobs indexing on all public pages.
        const ldMatches = [...r.text.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
        for (const match of ldMatches) {
          try {
            const ld = JSON.parse(match[1]);
            // May be a single object or an array
            const entries = Array.isArray(ld) ? ld : [ld];
            for (const entry of entries) {
              if (entry?.['@type'] !== 'JobPosting') continue;
              const descHtml = entry.description || '';
              if (!descHtml) continue;
              const descText = descHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              if (descText) return { ...job, description: descText, snippet: descText };
            }
          } catch {
            // Ignore malformed structured data and fall back to DOM extraction.
          }
        }

        // Fallback: extract from the description container div.
        // Class names rotate on deploys — try both known variants.
        const domMatch = r.text.match(
          /<div[^>]+class="[^"]*(?:description__text|show-more-less-html__markup)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        );
        if (domMatch) {
          const descText = domMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (descText) return { ...job, description: descText, snippet: descText };
        }

        // Page loaded but no description found — bot-wall or login redirect
        if (r.warning) {
          if (firstFailWarning === null) firstFailWarning = r.warning.code || r.warning;
        }
        failNoParse++;
        return job;
      } catch {
        return job; // keep existing snippet on error — don't drop the job
      }
    }));
    enriched.push(...results);
  }

  const withDesc = enriched.filter(j => j.description && j.description.length > 100).length;
  const failDetail = [
    failNonOk   > 0 ? `${failNonOk} non-OK (first status: ${firstFailStatus}${firstFailWarning ? `, warning: ${firstFailWarning}` : ''})` : null,
    failNoText  > 0 ? `${failNoText} empty-body` : null,
    failNoParse > 0 ? `${failNoParse} loaded-but-no-description${firstFailWarning && failNonOk === 0 ? ` (first warning: ${firstFailWarning})` : ''}` : null,
  ].filter(Boolean).join(', ');
  logger.info(`[LinkedIn] Enriched ${enriched.length} jobs — ${withDesc}/${enriched.length} have descriptions${failDetail ? ` — failures: ${failDetail}` : ''}`);
  return enriched;
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
export async function enrichLinkedInDescriptionsBrowser(jobs, signal) {
  if (!jobs?.length) return { jobs, loginWall: false, loginWallUrl: null };

  // Count jobs without URLs before touching the browser — these are silently
  // skipped in the loop and would otherwise make the success rate look wrong.
  const noUrlCount = jobs.filter(j => !j.url).length;
  if (noUrlCount > 0) {
    logger.warn(`[LinkedIn/Browser] ${noUrlCount}/${jobs.length} jobs have no URL — will be skipped in enrichment`);
  }

  let browser;
  try {
    browser = await getStealthBrowser();
  } catch (err) {
    logger.warn(`[LinkedIn/Browser] Cannot get shared browser for enrichment: ${err.message}`);
    return { jobs, loginWall: false, loginWallUrl: null };
  }

  // Open the enrichment tab in an isolated context with NO cookies.
  // When the shared browser context is used (browser.newPage()), the new tab
  // inherits the LinkedIn login cookies → LinkedIn serves the React SPA version
  // of job detail pages, which has zero JSON-LD and no server-rendered description.
  // An isolated context is anonymous to LinkedIn → it serves the guest/SEO version,
  // which server-renders a full JobPosting JSON-LD block at DOMContentLoaded.
  // The stealth-browser flags (UA, WebGL, etc.) still apply — the page looks like
  // a real Chrome tab, just not logged in to LinkedIn.
  let isolatedCtx;
  let page;
  try {
    isolatedCtx = await browser.createBrowserContext();
    page = await isolatedCtx.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  } catch (err) {
    logger.warn(`[LinkedIn/Browser] Cannot open tab for enrichment: ${err.message}`);
    await isolatedCtx?.close().catch(() => {});
    return { jobs, loginWall: false, loginWallUrl: null };
  }

  const enriched = [...jobs];
  let successCount = 0;
  let navErrors = 0;
  let noDesc = 0;
  let evalErrors = 0;
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

  try {
    for (let i = 0; i < enriched.length; i++) {
      if (signal?.aborted) break;
      const job = enriched[i];
      if (!job.url) continue;

      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 15000 });

        const finalUrl = page.url();

        // HTTP-redirect login wall: LinkedIn changed the URL to an auth page.
        if (LOGIN_WALL_RE.test(finalUrl)) {
          loginWallAt = i;
          loginWallUrl = finalUrl;
          logger.warn(`[LinkedIn/Browser] Login wall at job ${i + 1}/${enriched.length} — stopping enrichment (${finalUrl})`);
          break;
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
            loginWallAt = i;
            loginWallUrl = result.postEvalUrl;
            logger.warn(`[LinkedIn/Browser] JS-redirect login wall at job ${i + 1}/${enriched.length} — redirected to ${result.postEvalUrl}`);
            break;
          }
          // N consecutive eval errors without a URL-matchable redirect → still
          // treat as a systematic login wall and stop to avoid wasting time.
          if (consecutiveEvalErrors >= JS_REDIRECT_WALL_THRESHOLD) {
            loginWallAt = i - (consecutiveEvalErrors - 1);
            loginWallUrl = result.postEvalUrl || null;
            logger.warn(`[LinkedIn/Browser] ${consecutiveEvalErrors} consecutive eval errors — JS-redirect login wall presumed, stopping (last post-eval URL: ${result.postEvalUrl})`);
            break;
          }
        } else {
          noDesc++;
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
      }

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

  const attempted = loginWallAt !== null ? loginWallAt : enriched.length;
  const failParts = [];
  if (navErrors > 0) failParts.push(`${navErrors} nav-err`);
  if (evalErrors > 0) failParts.push(`${evalErrors} eval-err`);
  if (noDesc > 0) failParts.push(`${noDesc} no-desc`);
  const failSuffix = failParts.length ? ` (${failParts.join(', ')})` : '';
  const wallSuffix = loginWallAt !== null ? ` — login wall at job ${loginWallAt + 1}, ${enriched.length - loginWallAt - 1} skipped` : '';
  const firstFailSuffix = firstFailNote !== null ? ` — first fail: ${firstFailNote}` : '';
  logger.info(`[LinkedIn/Browser] ${successCount}/${attempted} descriptions enriched${failSuffix}${wallSuffix}${firstFailSuffix}`);
  return { jobs: enriched, loginWall: loginWallAt !== null, loginWallUrl };
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
// token can't pull in an off-target role. Falls back to any-term if the query is
// entirely generic, so a weird query is never over-filtered to zero.
const JOB_MATCH_STOPWORDS = new Set([
  'junior', 'senior', 'jr', 'sr', 'entry', 'mid', 'midlevel', 'principal', 'staff',
  'lead', 'associate', 'head', 'chief', 'director', 'manager', 'mgr', 'vp', 'svp',
  'intern', 'internship', 'remote', 'hybrid', 'onsite', 'remotefirst',
  'the', 'a', 'an', 'and', 'or', 'for', 'of', 'in', 'at', 'on', 'with', 'to',
  'jobs', 'job', 'position', 'role', 'opening', 'opportunity', 'careers',
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

export function jobRelevanceMatch(roleText, query, geoTerms = EMPTY_GEO) {
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
  //    jobs. Location is a filter, never a role-relevance signal — the dedicated
  //    scrapers (Indeed/Glassdoor/LinkedIn) already pass it as a search param.
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
  if (useTerms.length === 0) return false;
  return useTerms.some(t => text.includes(t));
}

// ── Greenhouse API ──────────────────────────────────────────────────────────
// Public JSON endpoint: boards-api.greenhouse.io/v1/boards/{token}/jobs
// Each company has a unique board token.

/** Curated list of top tech companies using Greenhouse ATS. */
const GREENHOUSE_BOARDS = [
  { token: 'figma', company: 'Figma' },
  { token: 'airbnb', company: 'Airbnb' },
  { token: 'stripe', company: 'Stripe' },
  { token: 'discord', company: 'Discord' },
  { token: 'notion', company: 'Notion' },
  { token: 'squarespace', company: 'Squarespace' },
  { token: 'datadog', company: 'Datadog' },
  { token: 'plaid', company: 'Plaid' },
  { token: 'brex', company: 'Brex' },
  { token: 'airtable', company: 'Airtable' },
  { token: 'gitlab', company: 'GitLab' },
  { token: 'hashicorp', company: 'HashiCorp' },
  { token: 'duolingo', company: 'Duolingo' },
  { token: 'cloudflare', company: 'Cloudflare' },
  { token: 'doordash', company: 'DoorDash' },
  { token: 'cockroachlabs', company: 'Cockroach Labs' },
  { token: 'benchling', company: 'Benchling' },
  { token: 'affirm', company: 'Affirm' },
  { token: 'gusto', company: 'Gusto' },
  { token: 'nerdwallet', company: 'NerdWallet' },
  { token: 'reddit', company: 'Reddit' },
  { token: 'robinhood', company: 'Robinhood' },
  { token: 'mongodb', company: 'MongoDB' },
  { token: 'twitch', company: 'Twitch' },
  { token: 'palantir', company: 'Palantir' },
  { token: 'lyft', company: 'Lyft' },
  { token: 'okta', company: 'Okta' },
  { token: 'asana', company: 'Asana' },
  { token: 'webflow', company: 'Webflow' },
  { token: 'vercel', company: 'Vercel' },
];

/**
 * Fetch jobs from Greenhouse boards matching the query.
 * Searches board titles client-side (the API doesn't support keyword search).
 */
export async function fetchGreenhouseJobs(queries, signal = null, geoTerms = EMPTY_GEO) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  // Greenhouse fans out across dozens of board tokens; collect warnings
  // per-call and pick the strongest at the end so a wave of blocks across
  // the whole platform shows up, not just an isolated 429 from one board.
  const warnings = [];
  let ghApiErrors = 0;
  let ghEmptyBoards = 0;
  const allJobs = await processInBatches(GREENHOUSE_BOARDS, 10, async ({ token, company }) => {
    const r = await safeApiFetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`, {
      headers: { 'Accept': 'application/json' },
      signal: createTimeoutSignal(signal, apiTimeout('greenhouse-api')),
    }, 'greenhouse');
    if (r.warning) warnings.push(r.warning);
    if (!r.ok) { ghApiErrors++; return []; }
    const data = r.json;
    const jobs = (data && data.jobs) || [];
    if (jobs.length === 0) ghEmptyBoards++;
    return jobs.map(job => ({ ...job, _company: company, _token: token }));
  }, signal);

  // Filter: job matches if relevant to ANY query (OR logic across all queries).
  const qs = Array.isArray(queries) ? queries : [queries];
  const matched = allJobs.filter(job =>
    qs.some(q => jobRelevanceMatch(`${job.title} ${job._company}`, q, geoTerms)));

  const items = matched.slice(0, JOB_RESULT_CAP).map(job => {
    const description = stripHtml(job.content || '');
    return {
      title: job.title || '',
      company: job._company || '',
      location: job.location?.name || '',
      salary: '',
      description,
      snippet: description.substring(0, 300),
      url: `https://boards.greenhouse.io/${job._token}/jobs/${job.id}`,
      posted: job.updated_at ? new Date(job.updated_at).toLocaleDateString() : '',
      source: 'greenhouse',
    };
  });
  const withDesc = items.filter(j => j.description).length;
  const boardsWithJobs = new Set(allJobs.map(j => j._company)).size;
  logger.info(`[Greenhouse API] ${allJobs.length} jobs fetched from ${boardsWithJobs}/${GREENHOUSE_BOARDS.length} boards (${ghApiErrors} API errors, ${ghEmptyBoards} empty boards) → ${matched.length} matched query → ${items.length} returned, ${withDesc}/${items.length} have descriptions`);
  const strongest = warnings.find(w => w.severity === 'block') || warnings[0] || null;
  return { items, warning: strongest, gathered: matched.length }; // gathered: pre-cap matches (see fetchLinkedInJobs)
}


// ── Lever API ───────────────────────────────────────────────────────────────
// Public JSON endpoint: api.lever.co/v0/postings/{company}?mode=json

/**
 * Curated list of companies using Lever ATS.
 * Slugs map to: api.lever.co/v0/postings/{slug}?mode=json
 *
 * When a slug is wrong or the company moved off Lever, the API returns a
 * non-2xx response — the extractor logs "(N API errors)" per run so stale
 * entries are immediately visible. Audit by checking jobs.lever.co/{slug}.
 *
 * Last audited: 2026-05-27 — removed confirmed non-Lever / dead entries:
 *   netflix  → custom ATS (jobs.netflix.com)
 *   openai   → Greenhouse (boards.greenhouse.io/openai)
 *   supabase → Ashby
 *   linear   → Ashby
 *   clearbit → acquired by HubSpot 2023; Lever board inactive
 *   loom     → acquired by Atlassian 2023; Lever board inactive
 *   resend   → unverified; likely Ashby
 * Also fixed slugs: grafana→grafanalabs, dbt-labs→dbtlabs
 */
const LEVER_COMPANIES = [
  { slug: 'anthropic', company: 'Anthropic' },
  { slug: 'samsara', company: 'Samsara' },
  { slug: 'snyk', company: 'Snyk' },
  { slug: 'retool', company: 'Retool' },
  { slug: 'zapier', company: 'Zapier' },
  { slug: 'mux', company: 'Mux' },
  { slug: 'twilio', company: 'Twilio' },
  { slug: 'netlify', company: 'Netlify' },
  { slug: 'postman', company: 'Postman' },
  { slug: 'coinbase', company: 'Coinbase' },
  { slug: 'grafanalabs', company: 'Grafana Labs' },
  { slug: 'dbtlabs', company: 'dbt Labs' },
  { slug: 'fly', company: 'Fly.io' },
];

/**
 * Fetch jobs from Lever career pages matching the query.
 */
export async function fetchLeverJobs(queries, signal = null, geoTerms = EMPTY_GEO) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const warnings = [];
  let leverApiErrors = 0;
  let leverEmptyBoards = 0;
  const allJobs = await processInBatches(LEVER_COMPANIES, 10, async ({ slug, company }) => {
    const r = await safeApiFetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, {
      headers: { 'Accept': 'application/json' },
      signal: createTimeoutSignal(signal, apiTimeout('lever-api')),
    }, 'lever');
    if (r.warning) warnings.push(r.warning);
    if (!r.ok) { leverApiErrors++; return []; }
    const data = r.json;
    const jobs = Array.isArray(data) ? data : [];
    if (jobs.length === 0) leverEmptyBoards++;
    return jobs.map(job => ({ ...job, _company: company }));
  }, signal);

  // Filter: job matches if relevant to ANY query (OR logic across all queries).
  const qs = Array.isArray(queries) ? queries : [queries];
  const matched = allJobs.filter(job => {
    const roleText = `${job.text} ${job._company} ${job.categories?.team || ''}`;
    return qs.some(q => jobRelevanceMatch(roleText, q, geoTerms));
  });

  const items = matched.slice(0, JOB_RESULT_CAP).map(job => {
    const description = stripHtml(job.descriptionPlain || job.description || '');
    return {
      title: job.text || '',
      company: job._company || '',
      location: job.categories?.location || '',
      salary: '',
      description,
      snippet: description.substring(0, 300),
      url: job.hostedUrl || job.applyUrl || '',
      posted: job.createdAt ? new Date(job.createdAt).toLocaleDateString() : '',
      source: 'lever',
    };
  });
  const withDesc = items.filter(j => j.description).length;
  const companiesWithJobs = new Set(allJobs.map(j => j._company)).size;
  logger.info(`[Lever API] ${allJobs.length} jobs fetched from ${companiesWithJobs}/${LEVER_COMPANIES.length} companies (${leverApiErrors} API errors, ${leverEmptyBoards} empty boards) → ${matched.length} matched query → ${items.length} returned, ${withDesc}/${items.length} have descriptions`);
  const strongest = warnings.find(w => w.severity === 'block') || warnings[0] || null;
  return { items, warning: strongest, gathered: matched.length }; // gathered: pre-cap matches (see fetchLinkedInJobs)
}


// ── USAJobs API ─────────────────────────────────────────────────────────────
// Official API: data.usajobs.gov/api/search
// Requires free API key from developer.usajobs.gov

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
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');

  const params = new URLSearchParams({
    Keyword: query,
    ResultsPerPage: '150', // uncapped breadth; USAJobs DatePosted below already keeps these in-window
    DatePosted: String(Math.max(1, Math.floor(maxAgeDays || 30))),
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

  const items = resultItems.slice(0, JOB_RESULT_CAP).map(item => {
    const pos = item.MatchedObjectDescriptor || {};
    const salary = pos.PositionRemuneration?.[0];
    const salaryStr = salary
      ? `$${salary.MinimumRange} - $${salary.MaximumRange} / ${salary.RateIntervalCode}`
      : '';

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
  return { items, warning: r.warning, gathered: resultItems.length }; // gathered: pre-cap matches (see fetchLinkedInJobs)
}


// ── Shared Utilities ────────────────────────────────────────────────────────


// ── RemoteOK Direct API ─────────────────────────────────────────────────────
// Open JSON endpoint: remoteok.com/api — no auth, no browser, no WAF.
// Returns a raw JSON array of job objects with salary, tags, and company.

/**
 * Fetch jobs from RemoteOK's open JSON API (bypasses Puppeteer entirely).
 */
export async function fetchRemoteOKJobs(queries, signal = null, geoTerms = EMPTY_GEO) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
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

  // Filter: job matches if relevant to ANY query (OR logic across all queries).
  const qs = Array.isArray(queries) ? queries : [queries];
  const matched = jobs.filter(job => {
    const roleText = `${job.position || ''} ${job.company || ''} ${(job.tags || []).join(' ')}`;
    return qs.some(q => jobRelevanceMatch(roleText, q, geoTerms));
  });

  const items = matched.slice(0, JOB_RESULT_CAP).map(job => ({
    title: job.position || '',
    company: job.company || '',
    location: job.location || 'Remote',
    salary: job.salary || (job.salary_min ? `$${job.salary_min} - $${job.salary_max}` : ''),
    snippet: (job.tags || []).join(', '),
    // RemoteOK's API returns description as raw HTML — strip tags to plain text.
    description: job.description ? job.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '',
    // RemoteOK's `url` is sometimes already absolute ("https://remoteOK.com/…")
    // and sometimes a relative path; only prefix the relative form, else we get
    // a doubled "https://remoteok.comhttps://remoteOK.com/…" broken link.
    url: job.url ? (String(job.url).startsWith('http') ? job.url : `https://remoteok.com${job.url}`) : '',
    posted: job.date || '',
    source: 'remoteok',
  }));
  const withDesc = items.filter(j => j.description).length;
  logger.info(`[RemoteOK API] ${items.length} jobs matched, ${withDesc}/${items.length} have descriptions`);
  return { items, warning: r.warning, gathered: matched.length }; // gathered: pre-cap matches (see fetchLinkedInJobs)
}


// ── WeWorkRemotely RSS Feed ─────────────────────────────────────────────────
// RSS/XML feed at weworkremotely.com — no browser, no rate limits, no WAF.

/**
 * Fetch jobs from WeWorkRemotely's RSS feed (bypasses Puppeteer entirely).
 */
export async function fetchWeWorkRemotelyJobs(queries, signal = null, geoTerms = EMPTY_GEO) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
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
    if (!qs.some(q => jobRelevanceMatch(title, q, geoTerms))) continue;

    // WWR RSS <description> CDATA is the full job HTML — strip tags to plain text.
    const descText = stripHtml(descMatch?.[1] || '').trim();

    jobs.push({
      title: jobTitle,
      company,
      location: regionMatch?.[1]?.trim() || 'Remote',
      salary: '',
      snippet: descText,
      description: descText,
      url: linkMatch?.[1]?.trim() || '',
      posted: pubDateMatch?.[1] ? new Date(pubDateMatch[1]).toLocaleDateString() : '',
      source: 'weworkremotely',
    });
  }

  const withDesc = jobs.filter(j => j.description).length;
  logger.info(`[WWR RSS] ${jobs.length} jobs matched, ${withDesc}/${jobs.length} have descriptions`);

  return { items: jobs.slice(0, JOB_RESULT_CAP), warning: r.warning, gathered: jobs.length }; // gathered: pre-cap matches (see fetchLinkedInJobs)
}


// ── Reverb Internal REST API ────────────────────────────────────────────────
// Internal endpoint: api.reverb.com/api/listings/all
// Requires Accept-Version: 3.0 and Accept: application/hal+json headers.
// Returns structured JSON with instrument pricing, condition, and seller data.

/**
 * Fetch marketplace listings from Reverb's internal REST API.
 * Returns the standard comp shape for pricing comparison.
 */
export async function fetchReverbListings(query, soldOnly = false, signal = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const params = new URLSearchParams({ query });
  if (soldOnly) params.set('state', 'ended');

  const r = await safeApiFetch(`https://api.reverb.com/api/listings/all?${params}`, {
    headers: {
      'Accept': 'application/hal+json',
      'Accept-Version': '3.0',
      'Content-Type': 'application/hal+json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: createTimeoutSignal(signal, apiTimeout('reverb-api')),
  }, 'reverb');

  if (!r.ok) {
    if (r.warning) logger.warn(`[Reverb API] ${r.warning.code}: ${r.warning.evidence}`);
    else logger.warn(`[Reverb API] Returned ${r.status}`);
    return { items: [], warning: r.warning };
  }

  const data = r.json;
  const listings = data?.listings || data?._embedded?.listings || [];

  const items = listings.slice(0, 25).map(listing => {
    const price = listing.price?.amount ? parseFloat(listing.price.amount) : 0;
    return {
      title: listing.title || listing.make_model || '',
      price,
      priceText: price > 0 ? `$${price.toFixed(2)}` : '',
      condition: listing.condition?.display_name || listing.condition?.slug || '',
      soldDate: listing.state === 'ended' ? (listing.sold_date || 'Sold') : '',
      seller: listing.seller?.feedback_percentage ? `${listing.seller.feedback_percentage}%` : '',
      url: listing._links?.web?.href || listing.web_url || '',
      source: 'reverb',
    };
  });
  return { items, warning: r.warning };
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

// ── Indeed (Scrapfly REST API) ───────────────────────────────────────────────
// Scrapfly is now the ONLY Indeed collection path. The old visible-browser /
// Puppeteer flow is intentionally bypassed because Indeed's challenge stack made
// local browser automation unreliable and expensive in user time.
//
// Cost strategy:
//   1. Start with raw HTML: asp=true, US geo, no render_js, datacenter default.
//      ASP may upgrade proxy/fingerprint only if Indeed actually requires it.
//   2. Use a short Scrapfly cache TTL so immediate re-runs during iteration do
//      not pay for the same query/page repeatedly.
//   3. Set a per-request cost_budget high enough for the observed raw-HTML path.
//      Live probe on 2026-05-25 succeeded at 80 credits for page 1; use 100 as
//      headroom so minor Scrapfly target-cost variance does not hard-fail.

const SCRAPFLY_SCRAPE_ENDPOINT = 'https://api.scrapfly.io/scrape';
const SCRAPFLY_INDEED_MAX_PAGES = 5;
const SCRAPFLY_INDEED_CACHE_TTL_SECONDS = 15 * 60;
const SCRAPFLY_INDEED_COST_BUDGET = 100;
const SCRAPFLY_PAGE_DELAY_MS = 600;

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
    const key = job.jobkey || job.url || jobTitleCompanyLocationKey(job);
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

function buildIndeedSearchUrl(query, days, page) {
  const params = new URLSearchParams({
    q: query,
    fromage: String(days),
  });
  if (page > 0) params.set('start', String(page * 10));
  return `https://www.indeed.com/jobs?${params}`;
}

function buildScrapflyIndeedUrl(apiKey, targetUrl, { proxyPool = null, cacheClear = false, correlationId = null } = {}) {
  const params = new URLSearchParams({
    key: apiKey,
    url: targetUrl,
    asp: 'true',
    country: 'us',
    lang: 'en-US,en',
    format: 'raw',
    retry: 'true',
    cache: 'true',
    cache_ttl: String(SCRAPFLY_INDEED_CACHE_TTL_SECONDS),
    cost_budget: String(SCRAPFLY_INDEED_COST_BUDGET),
  });
  if (proxyPool) params.set('proxy_pool', proxyPool);
  if (cacheClear) params.set('cache_clear', 'true');
  if (correlationId) params.set('correlation_id', correlationId);
  return `${SCRAPFLY_SCRAPE_ENDPOINT}?${params}`;
}

async function readScrapflyContent(result, apiKey, signal) {
  const content = result?.content;
  if (!content) return '';
  const format = String(result?.format || '').toLowerCase();
  if (format !== 'clob' && format !== 'blob') return String(content);

  const url = new URL(content);
  url.searchParams.set('key', apiKey);
  const response = await fetch(url, {
    signal: createTimeoutSignal(signal, apiTimeout('scrapfly-api')),
    headers: { Accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
  });
  if (!response.ok) throw new Error(`Scrapfly large-object download failed: HTTP ${response.status}`);
  return response.text();
}

function scrapflyErrorWarning(issue, totalJobs) {
  const code = issue?.code || '';
  const message = issue?.message || issue?.description || 'Scrapfly request failed';
  const severity = totalJobs > 0 ? 'warn' : 'block';
  let suggestion = 'Indeed is fetched through Scrapfly. Check the Scrapfly dashboard log for this request, then retry.';
  let warningCode = 'scrapfly-failed';

  if (/QUOTA|PAYMENT|CREDIT|BUDGET/i.test(code) || /quota|payment|credit|budget/i.test(message)) {
    warningCode = code.includes('COST_BUDGET') ? 'scrapfly-cost-budget' : 'scrapfly-quota';
    suggestion = code.includes('COST_BUDGET')
      ? `Scrapfly needed more than the per-request ${SCRAPFLY_INDEED_COST_BUDGET}-credit budget for Indeed. Raise the budget in code only if that spend is acceptable.`
      : 'Scrapfly quota or billing blocked the request. Add credits or update billing in Scrapfly, then retry.';
  } else if (/CONCURRENT|THROTTLE|429/i.test(code) || /concurrent|throttle|too many/i.test(message)) {
    warningCode = 'scrapfly-throttled';
    suggestion = 'Scrapfly throttled the request. Retry later or reduce concurrent job searches.';
  } else if (/CONFIG|401|403/i.test(code) || /api key|unauthorized|forbidden/i.test(message)) {
    warningCode = 'scrapfly-config';
    suggestion = 'Verify the Scrapfly API key in Settings → Job Sources.';
  }

  return {
    code: warningCode,
    severity,
    evidence: `${code ? `${code}: ` : ''}${message}`.slice(0, 500),
    suggestion,
  };
}

async function scrapeIndeedPageWithScrapfly(apiKey, targetUrl, signal, options = {}) {
  const scrapflyUrl = buildScrapflyIndeedUrl(apiKey, targetUrl, options);
  const startedAt = Date.now();
  const response = await fetch(scrapflyUrl, {
    signal: createTimeoutSignal(signal, apiTimeout('scrapfly-api')),
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
    },
  });

  let payload = null;
  let rawBody = '';
  try {
    rawBody = await response.text();
    payload = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    payload = null;
  }

  const cost = Number(response.headers.get('x-scrapfly-api-cost') || payload?.context?.cost?.total || 0) || 0;
  const remaining = response.headers.get('x-scrapfly-remaining-api-credit') || null;
  const logUuid = response.headers.get('x-scrapfly-log') || payload?.uuid || payload?.context?.log?.uuid || null;
  const headerCode = response.headers.get('x-scrapfly-reject-code') || '';
  const headerDocsUrl = response.headers.get('x-scrapfly-reject-description') || '';
  const headerRetryable = response.headers.get('x-scrapfly-reject-retryable') === 'true';

  if (!response.ok) {
    return {
      ok: false,
      cost,
      remaining,
      logUuid,
      retryable: headerRetryable || response.status >= 500 || response.status === 429,
      error: {
        http_code: response.status,
        code: headerCode || payload?.code || payload?.error?.code || `HTTP_${response.status}`,
        message: payload?.message || payload?.error?.message || rawBody.slice(0, 300),
        docsUrl: headerDocsUrl || undefined,
      },
    };
  }

  const result = payload?.result || {};
  const resultError = result?.error || payload?.error || null;
  if (resultError || result?.success === false) {
    return {
      ok: false,
      cost,
      remaining,
      logUuid,
      retryable: !!resultError?.retryable,
      error: resultError || {
        http_code: result?.status_code || 422,
        code: 'SCRAPFLY_RESULT_FAILED',
        message: result?.reason || 'Scrapfly returned an unsuccessful scrape result',
      },
    };
  }

  if (result?.status_code && result.status_code >= 400) {
    return {
      ok: false,
      cost,
      remaining,
      logUuid,
      retryable: result.status_code >= 500 || result.status_code === 429,
      error: {
        http_code: result.status_code,
        code: 'INDEED_UPSTREAM_ERROR',
        message: `Indeed returned HTTP ${result.status_code}`,
      },
    };
  }

  const content = await readScrapflyContent(result, apiKey, signal);
  return {
    ok: true,
    content,
    cost,
    remaining,
    logUuid,
    elapsedMs: Date.now() - startedAt,
    cacheState: payload?.context?.cache?.state || null,
  };
}

async function scrapeIndeedPageWithRetries(apiKey, targetUrl, signal, options) {
  let attempt = await scrapeIndeedPageWithScrapfly(apiKey, targetUrl, signal, options);
  if (attempt.ok) return attempt;

  const code = attempt.error?.code || '';
  if (code === 'ERR::PROXY::POOL_NOT_AVAILABLE_FOR_TARGET') {
    attempt = await scrapeIndeedPageWithScrapfly(apiKey, targetUrl, signal, {
      ...options,
      proxyPool: 'public_residential_pool',
    });
  } else if (attempt.retryable && !signal?.aborted) {
    await new Promise(r => setTimeout(r, 1000));
    attempt = await scrapeIndeedPageWithScrapfly(apiKey, targetUrl, signal, {
      ...options,
      cacheClear: true,
    });
  }

  return attempt;
}

/**
 * Fetch Indeed job listings via Scrapfly's ASP bypass.
 * @param {string[]} queries — array of job search queries
 * @param {AbortSignal|null} signal
 * @param {number|null} maxAgeDays
 * @returns {Promise<{ items: object[], warning: object|null, gathered: number }>}
 */
export async function fetchIndeedListings(queries, signal = null, maxAgeDays = null) {
  const { scrapflyApiKey } = getJobsSettings();
  const apiKey = String(scrapflyApiKey || '').trim();
  if (!apiKey) {
    return {
      items: [],
      warning: {
        code: 'config-missing',
        severity: 'info',
        evidence: 'Scrapfly API key not set',
        suggestion: 'Open Settings → Job Sources and paste a Scrapfly API key to enable Indeed.',
      },
      gathered: 0,
    };
  }

  const queryList = Array.isArray(queries) ? queries.filter(Boolean) : [queries].filter(Boolean);
  const days = maxAgeDays ? Math.max(1, Math.floor(maxAgeDays)) : 21;
  const resultCap = Number.isFinite(JOB_RESULT_CAP) ? JOB_RESULT_CAP : Infinity;
  const maxPages = Number.isFinite(resultCap)
    ? Math.max(1, Math.min(SCRAPFLY_INDEED_MAX_PAGES, Math.ceil(resultCap / 10)))
    : SCRAPFLY_INDEED_MAX_PAGES;
  const allJobs = [];
  const seenKeys = new Set();
  const issues = [];
  let totalCost = 0;
  let lastRemaining = null;

  outer:
  for (const query of queryList) {
    if (signal?.aborted) break;

    for (let page = 0; page < maxPages; page++) {
      if (signal?.aborted) break outer;
      if (allJobs.length >= resultCap) break outer;

      const indeedUrl = buildIndeedSearchUrl(query, days, page);
      const correlationId = `indeed-${Date.now()}-${page}`;
      let scrape;
      try {
        scrape = await scrapeIndeedPageWithRetries(apiKey, indeedUrl, signal, {
          correlationId,
        });
      } catch (err) {
        if (signal?.aborted) break outer;
        issues.push({ code: 'SCRAPFLY_FETCH_EXCEPTION', message: err?.message || String(err) });
        logger.warn(`[Indeed/Scrapfly] Fetch exception query="${query}" page=${page + 1}: ${err?.message || err}`);
        break;
      }

      totalCost += scrape.cost || 0;
      lastRemaining = scrape.remaining || lastRemaining;

      if (!scrape.ok) {
        issues.push(scrape.error);
        logger.warn(
          `[Indeed/Scrapfly] ${scrape.error?.code || 'error'} query="${query}" page=${page + 1}` +
          `${scrape.logUuid ? ` log=${scrape.logUuid}` : ''}: ${scrape.error?.message || ''}`
        );
        break;
      }

      const pageJobs = extractIndeedJobsFromHtml(scrape.content);

      logger.info(
        `[Indeed/Scrapfly] query="${query}" page=${page + 1} jobs=${pageJobs.length}` +
        ` cost=${scrape.cost || 0}${scrape.cacheState ? ` cache=${scrape.cacheState}` : ''}` +
        `${scrape.logUuid ? ` log=${scrape.logUuid}` : ''}`
      );

      if (pageJobs.length === 0) break;

      for (const job of pageJobs) {
        const dk = job.jobkey || job.url || jobTitleCompanyLocationKey(job);
        if (seenKeys.has(dk)) continue;
        seenKeys.add(dk);
        allJobs.push(job);
        if (allJobs.length >= resultCap) break;
      }

      if (pageJobs.length < 10) break;
      if (page < maxPages - 1) await new Promise(r => setTimeout(r, SCRAPFLY_PAGE_DELAY_MS));
    }
  }

  logger.info(
    `[Indeed/Scrapfly] Total: ${allJobs.length} unique jobs across ${queryList.length} quer(y|ies), ` +
    `cost=${totalCost}${lastRemaining ? `, remaining=${lastRemaining}` : ''}`
  );

  const inWindow = maxAgeDays ? filterJobsByAge(allJobs, maxAgeDays) : allJobs;
  const items = inWindow.slice(0, JOB_RESULT_CAP);
  const warning = issues.length > 0
    ? scrapflyErrorWarning(issues[issues.length - 1], items.length)
    : null;
  return { items, warning, gathered: inWindow.length };
}


/**
 * Fetch job listings from Dice via their public API (Tier 1).
 * @param {string} query — job search query
 * @param {string} [location] — optional location filter
 * @param {number} [maxAgeDays] — keep only postings within this window (client-side)
 * @returns {Promise<Array>} — standardized job objects
 */
const DICE_MAX_RETRIES = 3;
const DICE_RETRY_DELAYS_MS = [1000, 2000, 4000];

// Once we observe that a bundle scan returns the same key that was already
// stored, we know the 500s are transient server errors (not key rotation).
// Skip the expensive bundle scan on subsequent 500s this session and use a
// plain backoff instead. Resets to false on app restart (safe — worst case
// we do one unnecessary scan before confirming stability again).
let _diceKeyIsStable = false;

export async function fetchDiceListings(query, location = '', signal = null, maxAgeDays = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  const params = new URLSearchParams({
    q: query,
    countryCode2: 'US',
    radius: '30',
    radiusUnit: 'mi',
    page: '1',
    // Pull a WIDE relevance-ranked page, then keep only in-window jobs and take
    // the top JOB_RESULT_CAP of those (below) — so the cap holds the most-relevant
    // RECENT matches, not a relevance mix that's mostly age-dropped downstream.
    // We over-pull on purpose: relevance sort interleaves stale postings, and a
    // tight window has a small in-window fraction (probed: ~3-4% at 1 day, ~32% at
    // 7 days), so volume is what guarantees a full cap of in-window matches. Dice
    // has no date sort that helps and `filters.postedDate` only spans 1/3/7 days —
    // narrower than the 21-day default — so the window is enforced client-side.
    // pageSize is honored well past this (probed to 1000+); still one call, no paging.
    sortBy: 'relevance', // explicit (= Dice's default) so an API default change can't silently flip us off relevance
    pageSize: '1000',
    ...(location ? { location } : {}),
  });

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
          throw new Error(`Dice API unavailable — returned HTTP ${r.status} after ${DICE_MAX_RETRIES + 1} attempts + 1 key-refresh retry.`);
        }
      } else {
        throw new Error(`Dice API unavailable — returned HTTP ${r.status} after ${DICE_MAX_RETRIES + 1} attempt(s). Key refresh also failed — try again later.`);
      }
    } else {
      if (r.warning) logger.warn(`[Dice API] ${r.warning.code}: ${r.warning.evidence}`);
      else logger.warn(`[Dice API] Returned ${r.status}`);
      return { items: [], warning: r.warning };
    }
  }

  const data = r.json;
  const jobs = data?.data || [];

  logger.info(`[Dice API] Found ${jobs.length} jobs for "${query}"`);

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
      salary: job.salary || '',
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
  const items = inWindow.slice(0, JOB_RESULT_CAP);
  return { items, warning: r.warning, gathered: inWindow.length };
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
 * Second-pass enrichment: fetch full job descriptions from the Dice detail
 * endpoint for each job in the already-deduped list.
 *
 * The list search API only returns a short `summary`; the detail endpoint
 * returns the full HTML description. Runs after all queries are merged and
 * deduped so we only fetch for unique jobs, not per-query duplicates.
 *
 * Batched at 10 concurrent requests to avoid hammering the API.
 * Fails gracefully per job — keeps summary as fallback if detail fetch fails.
 *
 * @param {Array}       jobs   — deduped job objects (each must have `_diceId`)
 * @param {AbortSignal} signal — propagated abort signal
 * @returns {Promise<Array>}   — same jobs with `description` + `snippet` enriched
 */
export async function enrichDiceDescriptions(jobs, signal) {
  if (!jobs?.length) return jobs;
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');

  const BATCH = 10;
  const enriched = [];

  for (let i = 0; i < jobs.length; i += BATCH) {
    if (signal?.aborted) break;
    const batch = jobs.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (job) => {
      const id = job._diceId;
      if (!id) return job;
      try {
        const url = `https://job-search-api.svc.dhigroupinc.com/v1/dice/jobs/${id}`;
        const r = await safeApiFetch(url, {
          headers: {
            'User-Agent': getRandomUA(),
            'x-api-key': getDiceApiKey(),
            'Accept': 'application/json',
          },
          signal: createTimeoutSignal(signal, 10000),
        }, 'dice');
        if (!r.ok) return job;
        // Detail endpoint returns either a single object or { data: {...} }
        const detail = r.json?.data ?? r.json;
        const descHtml = detail?.description || '';
        if (!descHtml) return job;
        const descText = descHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!descText) return job;
        const rest = { ...job };
        delete rest._diceId;
        return { ...rest, description: descText, snippet: descText };
      } catch {
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

  const withFullDesc = cleaned.filter(j => j.description && j.description.length > 300).length;
  logger.info(`[Dice API] Enriched ${cleaned.length} jobs — ${withFullDesc}/${cleaned.length} have full descriptions`);
  return cleaned;
}


// ── StockX Algolia API Bypass ───────────────────────────────────────────────
// StockX outsources search to Algolia. We extract the API keys from the page
// HTML, then query Algolia directly — bypassing StockX's PerimeterX WAF.
// Keys rotate, so we extract them fresh each session.
//
// Known StockX Algolia Application ID — this is a public, client-facing value
// embedded in StockX's frontend JS. It's tied to their Algolia account and
// almost never changes (years). The search API key, however, may rotate.
const HARDCODED_STOCKX_APP_ID = '2FWOTDVM2O';

// Architecture: Try hardcoded App ID + cached API key first (Tier 1).
//               If keys expired → Puppeteer stealth bootstrap to extract fresh keys.
//               All data queries go directly to Algolia API (Tier 1).
// Plain fetch() WILL NOT WORK for key extraction — PerimeterX serves a JS
// challenge page that requires full browser rendering to solve.

let algoliaKeys = null; // Cache keys for the session
let lastStockXErrorTime = 0; // Cooldown for extraction failures

// Extractor JS that runs inside the Puppeteer page to grab Algolia keys.
// Searches all <script> tags and window properties for the key/appId pair.
const STOCKX_KEY_EXTRACTOR = `
(function() {
  // Strategy 1: Search inline scripts for Algolia config
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent || '';
    const appIdMatch = text.match(/x-algolia-application-id['":\\s]+([A-Z0-9]+)/i) ||
                       text.match(/algoliaApplicationId['":\\s]+['"]([A-Z0-9]+)['"]/i) ||
                       text.match(/"applicationId":\\s*"([A-Z0-9]+)"/i);
    const apiKeyMatch = text.match(/x-algolia-api-key['":\\s]+([a-f0-9]+)/i) ||
                        text.match(/algoliaApiKey['":\\s]+['"]([a-f0-9]+)['"]/i) ||
                        text.match(/"apiKey":\\s*"([a-f0-9]+)"/i);
    if (appIdMatch && apiKeyMatch) {
      return { appId: appIdMatch[1], apiKey: apiKeyMatch[1] };
    }
  }

  // Strategy 2: Check __NEXT_DATA__ for Algolia config
  try {
    const ndEl = document.getElementById('__NEXT_DATA__');
    if (ndEl) {
      const nd = JSON.parse(ndEl.textContent);
      const config = nd?.props?.pageProps?.algoliaConfig ||
                     nd?.runtimeConfig?.algolia ||
                     nd?.props?.pageProps?.searchConfig;
      if (config?.appId && config?.apiKey) {
        return { appId: config.appId, apiKey: config.apiKey };
      }
    }
  } catch {}

  // Strategy 3: Check global window properties
  try {
    if (window.__algoliaConfig) return window.__algoliaConfig;
    if (window.__STOCKX_CONFIG__?.algolia) return window.__STOCKX_CONFIG__.algolia;
  } catch {}

  return null;
})()
`;

/**
 * Fetch marketplace listings from StockX via Algolia API bypass.
 *
 * Tier escalation:
 *   1. Try cached Algolia keys (Tier 1 — pure API, zero browser)
 *   2. If keys missing/expired: extract via Puppeteer stealth (Tier 3 bootstrap, once per session)
 *   3. All data queries go to Algolia directly (Tier 1)
 */
export async function fetchStockXListings(query, signal = null) {
  const { safeApiFetch } = await import('../ipc/antiBotDetector.js');
  let bootstrapWarning = null;
  try {
    // Phase 1: Key Extraction Bootstrap (once per session)
    if (!algoliaKeys) {
      if (Date.now() - lastStockXErrorTime < 300000) {
        logger.warn('[StockX] Bootstrap cooldown active — skipping');
        return { items: [], warning: {
          code: 'stockx-bootstrap-cooldown',
          severity: 'block',
          evidence: '[stockx] Key extraction failed recently — 5 min cooldown active',
          suggestion: 'PerimeterX likely blocked the key-extraction page. Wait 5 minutes; if it persists, the stealth browser fingerprint may need rotation.',
        } };
      }

      logger.info('[StockX] No cached keys — extracting via stealth browser...');
      try {
        // queueScrape now returns { data, warning } — propagate either the
        // extracted keys or the anti-bot warning from the page fetch.
        const wrapped = await queueScrape(
          `https://stockx.com/search?s=${encodeURIComponent(query)}`,
          STOCKX_KEY_EXTRACTOR,
          {
            waitMs: 3000,
            timeoutMs: 35000,
            scrollFirst: false,
            dismissCookies: true,
            referer: 'https://www.google.com/',
            signal,
          }
        );
        const keys = wrapped?.data ?? null;
        // If the bootstrap fetch tripped PerimeterX, browserPool's detector
        // already flagged it. Save the warning so we surface it even if we
        // fall back to the hardcoded App ID and the Algolia query "works".
        if (wrapped?.warning) bootstrapWarning = wrapped.warning;

        if (keys?.appId && keys?.apiKey) {
          algoliaKeys = keys;
          logger.info(`[StockX] Algolia keys extracted: appId=${keys.appId.substring(0, 4)}...`);
        } else {
          lastStockXErrorTime = Date.now();
          algoliaKeys = { appId: HARDCODED_STOCKX_APP_ID, apiKey: '' };
          logger.warn('[StockX] Bootstrap failed — using hardcoded fallback. Cooldown active.');
        }
      } catch (err) {
        lastStockXErrorTime = Date.now();
        logger.error('[StockX] Extraction error:', err.message);
        return { items: [], warning: bootstrapWarning || {
          code: 'stockx-bootstrap-failed',
          severity: 'block',
          evidence: `[stockx] key extraction threw: ${err.message}`,
          suggestion: 'PerimeterX likely served a JS challenge that stealth couldn\'t solve. Manual session refresh or proxy may be required.',
        } };
      }
    }

    if (!algoliaKeys?.appId) return { items: [], warning: bootstrapWarning };

    // Phase 2: Query Algolia directly
    const r = await safeApiFetch(
      `https://${algoliaKeys.appId}-dsn.algolia.net/1/indexes/products/query`,
      {
        method: 'POST',
        headers: {
          'X-Algolia-Application-Id': algoliaKeys.appId,
          'X-Algolia-API-Key': algoliaKeys.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          hitsPerPage: 25,
        }),
        signal: createTimeoutSignal(signal, apiTimeout('stockx-api')),
      },
      'stockx-algolia'
    );

    if (!r.ok) {
      if (r.warning) logger.warn(`[StockX Algolia] ${r.warning.code}: ${r.warning.evidence}`);
      else logger.warn(`[StockX Algolia] Returned ${r.status}`);
      algoliaKeys = null;
      // Prefer the Algolia warning when present; fall back to the bootstrap
      // warning since the user wants to see ANY signal from this pipeline.
      return { items: [], warning: r.warning || bootstrapWarning };
    }

    const data = r.json;
    const hits = data?.hits || [];

    const items = hits.slice(0, 25).map(hit => {
      const lastSale = hit.last_sale || hit.market?.lastSale || 0;
      const lowestAsk = hit.lowest_ask || hit.market?.lowestAsk || 0;
      const price = lastSale || lowestAsk;

      return {
        title: hit.name || hit.title || '',
        price,
        priceText: price > 0 ? `$${price}` : '',
        lastSale: lastSale > 0 ? `$${lastSale}` : '',
        lowestAsk: lowestAsk > 0 ? `$${lowestAsk}` : '',
        condition: 'New / Deadstock',
        url: hit.url ? `https://stockx.com/${hit.url}` : '',
        source: 'stockx',
      };
    });
    // Surface bootstrapWarning even on a successful Algolia query — the user
    // should know if we fell back to hardcoded keys because StockX blocked
    // the key page, even if the search itself worked.
    return { items, warning: r.warning || bootstrapWarning };
  } catch (error) {
    logger.error('[StockX Algolia] Fetch failed:', error?.message || String(error));
    return { items: [], warning: bootstrapWarning };
  }
}
