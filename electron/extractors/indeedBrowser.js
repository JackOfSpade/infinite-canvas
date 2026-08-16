/**
 * Browser-based Indeed extractor — real Chrome (non-headless Puppeteer) with a
 * persistent auth'd profile so Indeed serves page 2+ without a login wall.
 *
 * Replaces fetchIndeedListings (Scrapfly, ~$21/run).
 * Profile lives in the shared browser-data userDataDir used by Settings login.
 * First-time setup: open Settings → Job Sources → Connect Indeed and log in.
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { execFile } from 'node:child_process';
import electronPkg from 'electron';
import { logger } from '../logger.js';
import { findChromePath, findSystemChromePath, getUserDataDir } from '../ipc/stealthBrowser.js';
import { extractIndeedJobsFromHtml } from './apiExtractors.js';
import { normalizeJobCollectionLimits, resolvePageCeiling, isUnlimitedPages, describeJobCollectionLimits } from '../../src/utils/jobCollectionLimits.js';
import { makeJobPageStop } from '../ipc/jobPageStop.js';
import { filterJobsByAge } from '../ipc/jobDateFilter.js';
import { buildOverlayScript, updateOverlay } from '../ipc/browser/scraperOverlay.js';
import { humanCooldown } from '../utils/humanDelay.js';
import { sourceJobKey } from '../../src/utils/jobIdentity.js';
import { normalizeCountry } from '../../src/utils/jobLocation.js';

// Indeed runs a SEPARATE site per country and each one only returns that
// country's postings — `l=` is a place filter WITHIN a site, not a country
// switch. So the target country picks the host. Keyed by the canonical country
// name normalizeCountry() produces; anything unmapped (including the US and any
// country we don't list) stays on www, which is Indeed's global default and the
// previous behavior. Exported for the unit test.
const INDEED_COUNTRY_HOSTS = {
  'Canada': 'ca.indeed.com',
  'United Kingdom': 'uk.indeed.com',
  'Australia': 'au.indeed.com',
  'New Zealand': 'nz.indeed.com',
  'Ireland': 'ie.indeed.com',
  'Germany': 'de.indeed.com',
  'France': 'fr.indeed.com',
  'India': 'in.indeed.com',
  'Singapore': 'sg.indeed.com',
};

/**
 * Host to run an Indeed search on, from the board-ready location string
 * ("Whitby, Ontario, Canada" / "Canada" / "Denver, CO"). deriveLocationParam
 * appends the country for every NON-US place, so the country is the last
 * comma-segment when there is one; a bare "Denver, CO" has no country segment
 * and correctly falls through to www. Pure + testable.
 */
export function indeedHostForLocation(location) {
  const segs = String(location || '').split(',').map(s => s.trim()).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const host = INDEED_COUNTRY_HOSTS[normalizeCountry(segs[i])];
    if (host) return host;
  }
  return 'www.indeed.com';
}

// Display-only overlay — no pause button or exposeFunction CDP bindings (Cloudflare fingerprint risk).
const OVERLAY_SCRIPT = buildOverlayScript({ withPause: false });
const injectOverlay  = (page) => page.evaluate(OVERLAY_SCRIPT).catch(() => {});

const { app } = electronPkg;

puppeteer.use(StealthPlugin());

function getProfileDir() {
  try {
    return path.join(app.getPath('userData'), 'browser-data');
  } catch {
    // Not in Electron context (test/probe) — caller must pass profileDir explicitly
    return path.join(process.cwd(), 'scripts', 'probe-data');
  }
}

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--window-size=1400,900',
  '--window-position=60,60',
  '--lang=en-US,en',
];

// Waits for `ms` milliseconds, calling onTick(secondsRemaining) every second.
async function waitWithCountdown(ms, onTick) {
  const deadline = Date.now() + ms;
  while (true) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) break;
    onTick(remaining);
    await new Promise(r => setTimeout(r, Math.min(1000, deadline - Date.now())));
  }
}

// Clears CF bot-score cookie, closes the browser, waits out the backoff, then launches
// a fresh browser and returns the new { browser, page }.
async function restartBrowserForCF(page, browser, backoffMs, { userDataDir, launchOpts, onProgress }) {
  await page.deleteCookie({ name: '__cf_bm', domain: 'indeed.com' }, { name: '__cf_bm', domain: '.indeed.com' }).catch(() => {});
  await browser.close().catch(() => {});
  await killChromeHoldingProfile(userDataDir);
  await waitWithCountdown(backoffMs, (s) => onProgress?.(`CF cooldown ${s}s…`));
  const newBrowser = await puppeteer.launch(launchOpts);
  const newPage    = await newBrowser.newPage();
  await newPage.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await newPage.evaluateOnNewDocument(OVERLAY_SCRIPT);
  return { browser: newBrowser, page: newPage };
}

// Kill any Chrome process holding the given userDataDir (zombie cleanup after a crash).
// Uses pkill -f on macOS/Linux; silently no-ops on failure or unsupported platforms.
function killChromeHoldingProfile(dir) {
  return new Promise(resolve => {
    execFile('pkill', ['-f', dir], () => resolve());
  });
}

// Page and query delays mirror the probe script step 7 (7.9s/page avg achieved).
const PAGE_DELAY_MS  = [1500, 3000];
const QUERY_DELAY_MS = [3000, 5000];

const CARD_SELECTOR  = '[data-testid="jobTitle"] a, .jobTitle a, h2.jobTitle a, a[data-jk]';
const PANEL_SELECTOR = '#jobsearch-ViewjobPaneWrapper, .jobsearch-RightPane, [data-testid="jobPanel"], #vjs-container';
const DESC_SELECTOR  = '#jobDescriptionText, .jobsearch-jobDescriptionText, [data-testid="job-description"]';

// An expired detail URL is neither a missing description nor a bot wall.  In
// particular, retrying it cannot recover score evidence, so keep this narrow
// and require Indeed's own unavailable-page wording rather than matching a
// phrase that could appear in a legitimate job description.
export function classifyIndeedUnavailablePage({ title = '', body = '' } = {}) {
  const text = `${title}\n${body}`.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return null;
  if (
    text.includes("we can't find this page") &&
    (text.includes("this page doesn't exist") || text.includes("isn't available right now"))
  ) return 'page-unavailable';
  if (text.includes('this job is no longer available') || text.includes('job is no longer available')) {
    return 'job-unavailable';
  }
  return null;
}

async function getIndeedUnavailableReason(page) {
  try {
    const pageText = await page.evaluate(() => ({
      title: document.title || '',
      body: document.body?.innerText || '',
    }));
    return classifyIndeedUnavailablePage(pageText);
  } catch {
    return null;
  }
}

// Scroll card into view + real mouse move + click — mirrors the probe step 5/6 approach
// that generated the mouse-event sequence Cloudflare behavioral scoring expects.
async function humanClick(page, selector, idx) {
  const box = await page.evaluate((sel, i) => {
    const el = document.querySelectorAll(sel)[i];
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector, idx);
  if (!box) return false;
  await page.mouse.move(
    box.x + (Math.random() * 8 - 4),
    box.y + (Math.random() * 8 - 4),
    { steps: 8 + Math.round(Math.random() * 8) },
  );
  await new Promise(r => setTimeout(r, 60 + Math.round(Math.random() * 100)));
  await page.mouse.click(box.x, box.y);
  return true;
}

// Click each job card on the current search results page and read the full
// description from the right panel that updates in place. Matches descriptions
// back to jobs via the vjk= URL param that Indeed sets on each card click.
async function enrichWithDescriptions(page, pageJobs, signal, overlayBase = null, totalSoFar = 0) {
  await page.waitForSelector(CARD_SELECTOR, { timeout: 5000 }).catch(() => {});
  const cardCount = await page.evaluate(
    (sel) => document.querySelectorAll(sel).length, CARD_SELECTOR
  ).catch(() => 0);
  if (!cardCount) return { enriched: 0, cfBlankAt: null };

  const keyToJob = new Map();
  for (const job of pageJobs) { if (job.jobkey) keyToJob.set(job.jobkey, job); }

  const limit = Math.min(cardCount, pageJobs.length);
  let enriched = 0;

  for (let i = 0; i < limit; i++) {
    if (signal?.aborted) break;
    if (overlayBase) {
      await updateOverlay(page, {
        ...overlayBase,
        count: totalSoFar + i + 1,
        status: `Enriching ${limit} jobs…`,
        progressText: `${i + 1}/${limit}`,
      }).catch(() => {});
    }

    const panelBefore = await page.$eval(PANEL_SELECTOR, el => el.textContent?.slice(0, 80) || '').catch(() => '');

    if (!await humanClick(page, CARD_SELECTOR, i)) continue;

    // Wait up to 4s for panel to update; detect full-page navigation as a glitch.
    let navigatedAway = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const url = page.url();
      if (!url.includes('/jobs') && url.includes('/viewjob')) { navigatedAway = true; break; }
      const panelNow = await page.$eval(PANEL_SELECTOR, el => el.textContent?.slice(0, 80) || '').catch(() => '');
      if (panelNow && panelNow !== panelBefore) break;
    }

    if (navigatedAway) {
      const awayUrl = page.url();
      logger.warn(`[Indeed/Browser] Card click navigated away → ${awayUrl}`);
      // Already on the full job page — grab the description before going back.
      const awayVjk = await page.evaluate(() => {
        try { return new URL(location.href).searchParams.get('vjk') || ''; } catch { return ''; }
      }).catch(() => '');
      const awayDesc = await page.$eval(DESC_SELECTOR, el => el.textContent?.trim() || '').catch(() => '');
      if (awayDesc) {
        const job = keyToJob.get(awayVjk) || pageJobs[i];
        if (job) { job.description = awayDesc; job.snippet = awayDesc; enriched++; }
      } else {
        const sigs = await getChallengeSignals(page);
        if (sigs.isChallenge) {
          logger.warn(`[Indeed/Browser] CF signal on navigated-away page at card ${i + 1}/${limit} (${sigs.reason})`);
          return { enriched, cfBlankAt: i };
        }
      }
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 800 + Math.round(Math.random() * 400)));
      continue;
    }

    await new Promise(r => setTimeout(r, 200 + Math.round(Math.random() * 200)));

    const vjk = await page.evaluate(() => {
      try { return new URL(location.href).searchParams.get('vjk') || ''; } catch { return ''; }
    }).catch(() => '');

    const description = await page.$eval(DESC_SELECTOR, el => el.textContent?.trim() || '').catch(() => '');
    if (description) {
      const job = keyToJob.get(vjk) || pageJobs[i];
      if (job) { job.description = description; job.snippet = description; enriched++; }
    } else {
      // Blank panel — may be early CF interference before the full challenge page appears.
      const sigs = await getChallengeSignals(page);
      if (sigs.isChallenge) {
        logger.warn(`[Indeed/Browser] CF signal during enrichment at card ${i + 1}/${limit} (${sigs.reason})`);
        return { enriched, cfBlankAt: i };
      }
    }

    if (i < limit - 1) await new Promise(r => setTimeout(r, 800 + Math.round(Math.random() * 600)));
  }

  if (enriched > 0) logger.info(`[Indeed/Browser] Enriched ${enriched}/${limit} jobs with full descriptions`);
  return { enriched, cfBlankAt: null };
}

async function getChallengeSignals(page) {
  const url = page.url();
  if (url.includes('secure.indeed.com/auth') || url.includes('/auth?co=')) {
    return { isChallenge: true, reason: 'indeed-login-wall' };
  }
  try {
    return await page.evaluate(() => {
      const body = (document.body?.innerText || '').toLowerCase().slice(0, 3000);
      const loginWall = body.includes('to see more than one page of jobs') ||
        (body.includes('create an account or sign in') && body.includes('indeed'));
      const challengeShell = !!document.querySelector('#challenge-form, #cf-challenge-running');
      const cfFrame = !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
      const cfText  = (body.includes('verify you are human') || body.includes('additional verification required')) && body.includes('cloudflare');
      const normalContent = !!document.querySelector('.jobsearch-ResultsList, [data-testid="job-title"], .job_seen_beacon, #mosaic-provider-jobcards, #job-search-results');
      let reason = null;
      if (loginWall) reason = 'indeed-login-wall';
      else if (challengeShell) reason = 'challenge-shell';
      else if (cfFrame)  reason = 'cloudflare-challenge-frame';
      else if (cfText)   reason = 'cf-verify-text';
      return {
        isChallenge: !!(reason || (!normalContent && (challengeShell || cfFrame))),
        reason,
      };
    });
  } catch {
    return { isChallenge: false, reason: null };
  }
}

/**
 * Retry the exact Indeed detail pages that survived the search funnel without
 * enough description text for scoring. This deliberately does not repeat the
 * search query: it is both slower and less precise, and older builds may already
 * have written these rows to seen-history before the review decision. Direct
 * detail retries replace the low-evidence pending rows regardless of history.
 */
export async function retryIndeedJobDescriptions(jobs, signal = null, profileDir = null) {
  const rows = (Array.isArray(jobs) ? jobs : []).map(job => ({ ...job, source: 'indeed' }));
  const targets = rows.filter(job =>
    String(job?.snippet || job?.description || '').replace(/\s+/g, ' ').trim().length < 400
  );
  if (targets.length === 0) {
    return { jobs: rows, attempted: 0, recovered: 0, remaining: 0, unavailable: [], challengeReason: null };
  }

  const userDataDir = profileDir || await getUserDataDir().catch(() => getProfileDir());
  const executablePath = await findSystemChromePath() || await findChromePath();
  const launchOpts = {
    headless: false,
    executablePath,
    userDataDir,
    ignoreDefaultArgs: ['--enable-automation'],
    args: LAUNCH_ARGS,
    defaultViewport: { width: 1400, height: 900 },
    ignoreHTTPSErrors: true,
  };

  let browser;
  let recovered = 0;
  let challengeReason = null;
  const unavailable = [];
  try {
    try {
      browser = await puppeteer.launch(launchOpts);
    } catch (launchErr) {
      if (!/browser is already running/i.test(launchErr.message)) throw launchErr;
      logger.warn('[Indeed/Browser] Description retry found a Chrome zombie — killing it and retrying launch');
      await killChromeHoldingProfile(userDataDir);
      await new Promise(resolve => setTimeout(resolve, 1500));
      browser = await puppeteer.launch(launchOpts);
    }

    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.evaluateOnNewDocument(OVERLAY_SCRIPT);
    logger.info(`[Indeed/Browser] Retrying ${targets.length} exact low-evidence description(s)`);

    for (let index = 0; index < targets.length; index++) {
      if (signal?.aborted) break;
      const job = targets[index];
      const host = indeedHostForLocation(job.location || '');
      let safeJobUrl = null;
      if (job.url) {
        try {
          const parsed = new URL(job.url);
          if (parsed.protocol === 'https:' && (parsed.hostname === 'indeed.com' || parsed.hostname.endsWith('.indeed.com'))) {
            safeJobUrl = parsed.toString();
          }
        } catch {
          // Fall through to the source-native key below.
        }
      }
      const safeJobKey = /^[a-z0-9_-]+$/i.test(String(job.jobkey || '')) ? String(job.jobkey) : '';
      const jobUrl = safeJobUrl || (safeJobKey ? `https://${host}/viewjob?jk=${encodeURIComponent(safeJobKey)}` : null);
      if (!jobUrl) continue;
      try {
        await page.goto(jobUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await injectOverlay(page);
        await updateOverlay(page, {
          srcName: 'Indeed',
          srcLabel: 'Retrying descriptions…',
          count: index + 1,
          status: `${index + 1}/${targets.length}`,
        }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 3000 + Math.round(Math.random() * 1000)));
        const signals = await getChallengeSignals(page);
        if (signals.isChallenge) {
          challengeReason = signals.reason || 'challenge';
          logger.warn(`[Indeed/Browser] Description retry blocked (${challengeReason}) after ${index}/${targets.length} listing(s)`);
          break;
        }
        const unavailableReason = await getIndeedUnavailableReason(page);
        if (unavailableReason) {
          unavailable.push({
            key: sourceJobKey(job),
            title: String(job.title || '(untitled)').replace(/\s+/g, ' ').slice(0, 140),
            url: jobUrl,
            reason: unavailableReason,
          });
          logger.info(`[Indeed/Browser] Description retry retired unavailable listing (${unavailableReason}): ${job.jobkey || jobUrl}`);
          continue;
        }
        const description = await page.$eval(DESC_SELECTOR, el => el.textContent?.trim() || '').catch(() => '');
        if (description.length >= 400) {
          job.description = description;
          job.snippet = description;
          recovered++;
        }
        if (index < targets.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500 + Math.round(Math.random() * 1000)));
        }
      } catch (error) {
        logger.warn(`[Indeed/Browser] Description retry failed (${job.jobkey || job.url || 'no-key'}): ${error.message}`);
      }
    }

    const unavailableKeys = new Set(unavailable.map(item => item.key));
    const activeRows = rows.filter(job => !unavailableKeys.has(sourceJobKey(job)));
    const remaining = activeRows.filter(job =>
      String(job?.snippet || job?.description || '').replace(/\s+/g, ' ').trim().length < 400
    ).length;
    logger.info(`[Indeed/Browser] Exact description retry complete: ${recovered}/${targets.length} recovered, ${unavailable.length} unavailable, ${remaining} still incomplete`);
    return { jobs: activeRows, attempted: targets.length, recovered, remaining, unavailable, challengeReason };
  } finally {
    if (browser) {
      await browser.close().catch(error => logger.warn(`[Indeed/Browser] retry browser.close() failed: ${error.message}`));
      await killChromeHoldingProfile(userDataDir);
    }
  }
}

/**
 * Fetch Indeed job listings using a real Chrome session with a persistent
 * auth'd profile. Replaces the Scrapfly-based fetchIndeedListings().
 *
 * @param {string[]} queries
 * @param {AbortSignal|null} signal
 * @param {number|null} maxAgeDays
 * @param {string} [profileDir] — override for the Puppeteer userDataDir
 * @returns {Promise<{ items: object[], warning: object|null, gathered: number }>}
 */
export async function fetchIndeedListingsBrowser(queries, signal = null, maxAgeDays = null, profileDir = null, onProgress = null, startPage = 0, onPageJobs = null, location = '', collectionLimits = null) {
  const userDataDir  = profileDir || await getUserDataDir().catch(() => getProfileDir());
  const queryList    = Array.isArray(queries) ? queries.filter(Boolean) : [queries].filter(Boolean);
  const days         = maxAgeDays ? Math.max(1, Math.floor(maxAgeDays)) : 21;
  // Board-ready target location → Indeed's `&l=` filter. Empty → omitted
  // (nationwide). Without this a location-free query searched the whole US.
  const locParam     = String(location || '').trim() ? `&l=${encodeURIComponent(String(location).trim())}` : '';
  // …and `l=` alone is NOT enough. Indeed runs one site per country and each only
  // searches its own: a Canada search on www.indeed.com came back with jobs in
  // Haysi VA, Honaker VA and Williamson WV — all 3 of the run's Indeed results
  // were US, because `l=Canada` on the US site is just an unmatched place name.
  const host         = indeedHostForLocation(location);
  const limits       = normalizeJobCollectionLimits(collectionLimits);
  const resultCap    = limits.jobsPerPlatform == null ? Infinity : limits.jobsPerPlatform;
  // resolvePageCeiling ALWAYS returns a finite number (the JOB_COLLECTION_PAGE_CEILING
  // backstop when the hub's page setting is "All") — the page-walk loops below key
  // off this directly (`p < maxPages`), so it must never be null.
  const maxPages     = resolvePageCeiling(limits);
  const unlimitedPages = isUnlimitedPages(limits);

  let executablePath;
  try { executablePath = await findSystemChromePath() || await findChromePath(); } catch (e) {
    return {
      items: [],
      warning: {
        code: 'chrome-not-found',
        severity: 'block',
        evidence: e.message,
        suggestion: 'Install Google Chrome or run `npx playwright install chromium`.',
      },
      gathered: 0,
    };
  }

  const launchOpts = {
    headless: false,
    executablePath,
    userDataDir,
    ignoreDefaultArgs: ['--enable-automation'],
    args: LAUNCH_ARGS,
    defaultViewport: { width: 1400, height: 900 },
    ignoreHTTPSErrors: true,
  };

  let browser;
  try {
    try {
      browser = await puppeteer.launch(launchOpts);
    } catch (launchErr) {
      if (/browser is already running/i.test(launchErr.message)) {
        // A Chrome zombie from a previous crashed session is holding the profile lock.
        // Kill it and retry once.
        logger.warn('[Indeed/Browser] Chrome zombie detected — killing stale process and retrying launch');
        await killChromeHoldingProfile(userDataDir);
        await new Promise(r => setTimeout(r, 1500));
        browser = await puppeteer.launch(launchOpts);
      } else {
        throw launchErr;
      }
    }

    let page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.evaluateOnNewDocument(OVERLAY_SCRIPT);

    // Verify auth state before running any queries.
    await page.goto(`https://${host}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    const landedUrl = page.url();
    await injectOverlay(page);
    await updateOverlay(page, { srcName: 'Indeed', srcLabel: 'Checking session…', count: 0, status: 'Verifying login…' });
    await new Promise(r => setTimeout(r, 1200 + Math.round(Math.random() * 600)));
    const cookies = await page.cookies(`https://${host}`, 'https://www.indeed.com', 'https://secure.indeed.com').catch(() => []);
    const hasPPID        = cookies.some(c => c.name === 'PPID' && c.domain?.includes('indeed.com'));
    const hasCfClearance = cookies.some(c => c.name === 'cf_clearance');
    const hasCfBm        = cookies.some(c => c.name === '__cf_bm');
    const allCookieNames = cookies.map(c => c.name).join(', ') || '(none)';
    // PPID may be absent from the CDP cookie store even when authenticated: Chrome's
    // --app mode can keep session cookies only in the session-restore DB (not the
    // persistent Cookies SQLite file that CDP reads). Fall back to the landing URL —
    // a sign-in redirect is definitive proof of no session; staying on indeed.com is not.
    const redirectedToSignIn = /\/(auth|login|signin)(\?|$)/i.test(landedUrl);
    const sessionOk = hasPPID || (!redirectedToSignIn && landedUrl.includes('indeed.com'));
    logger.info(`[Indeed/Browser] Session check — PPID:${hasPPID} cf_clearance:${hasCfClearance} __cf_bm:${hasCfBm} | all cookies: ${allCookieNames} | landedUrl: ${landedUrl} | ok: ${sessionOk}`);

    if (!sessionOk) {
      logger.warn('[Indeed/Browser] Not logged in — PPID missing and page redirected to sign-in');
      return {
        items: [],
        warning: {
          code: 'needs-login',
          severity: 'block',
          evidence: 'Indeed session not authenticated — page redirected to sign-in.',
          suggestion: 'Open Settings → Job Sources → Connect Indeed and log into your Indeed account.',
        },
        gathered: 0,
      };
    }
    if (!hasPPID) {
      logger.warn('[Indeed/Browser] PPID not in persistent cookie store — proceeding based on landing URL (session cookies from native Chrome --app mode may not appear in CDP store)');
    }

    // Say "All" explicitly (with its backstop) rather than just printing the
    // resolved ceiling number — otherwise a user who chose "All" sees a plain
    // "up to 1000 pages" log line that reads like a deliberate 1000-page setting.
    logger.info(`[Indeed/Browser] Authenticated. ${queryList.length} queries × up to ${describeJobCollectionLimits(limits).pages} pages`);

    // ── Escalation table ────────────────────────────────────────────────────
    // Cooldown after the Nth failure before the (N+1)th attempt. Other queries
    // run during this window, so actual elapsed time may be longer.
    // Index = retryCount of the entry that just failed.
    // retryCount ≥ CF_ESCALATION_MS.length → all retries exhausted, give up.
    // No trailing 0: a zero-cooldown entry here would fire one immediate
    // retry right before giving up, into a still-active block — the
    // opposite of escalation, and likely to harden it further.
    const CF_ESCALATION_MS = [5_000, 30_000, 60_000];

    const allJobs = [];
    const seenKeys = new Set();
    const providerSeenKeys = new Set();
    let totalChallenges = 0;
    let gaveUpCount = 0;
    const gaveUpPages = []; // { q, p } for each page that exhausted all retries
    let loginWallHit = false;
    let challengedQi = -1;
    let challengedPage = 0;
    // Per-query CF telemetry — logged as compact summaries at run end so the
    // full picture fits in the 60-line ring buffer regardless of run length.
    const perQueryChallenges = {}; // qi → challenge count
    const perQueryGaveUp     = {}; // qi → give-up page count

    // workList drives all work: initial queries plus deferred retries pushed by
    // the CF escalation logic. retryCount=0 means first attempt; availableAt=0
    // means ready immediately. Multiple entries can have independent cooldowns
    // running simultaneously — the outer loop always picks the soonest-ready one.
    const workList = queryList.map((q, qi) => ({
      q, qi,
      startPage: qi === 0 ? startPage : 0,
      retryCount: 0,
      availableAt: 0,
    }));

    // Data-driven per-page stop, one instance PER QUERY (indexed by qi, not per
    // workList entry): a deferred CF retry or an opportunistic next-page advance
    // (below) is still the SAME logical query resuming, and its age-window /
    // no-new-jobs streak state must accumulate across that query's own pages —
    // sharing an instance across two different queries would let one query's
    // stale streak wrongly end another's walk. Declared fresh on every call to
    // this function, so a resume-job-source re-entry (which passes its own
    // `startPage`) always starts with clean streak state, never state left over
    // from before the crash/interrupt.
    const queryPageStops = queryList.map(() =>
      makeJobPageStop({ maxAgeDays: days, unlimited: unlimitedPages, sourceLabel: 'Indeed' })
    );

    // nextPageAdvanced tracks which (qi, startPage) pairs have already been
    // injected as opportunistic next-page entries so the same advance isn't
    // created twice during a single cooldown window (Bug: without this guard,
    // a completed next-page entry returns to a still-cooling original, finds
    // the same candidate again, and re-creates the identical entry).
    const nextPageAdvanced = new Set();

    // Defined once here (not inside the loop) — only needs workList,
    // totalChallenges, gaveUpCount, and CF_ESCALATION_MS from this scope.
    // q/qi/hitCount are passed explicitly so the function isn't tied to
    // whichever entry happens to be current when it's called.
    //
    // hitCount = entry.retryCount + any inline restarts already done this pass.
    // Returns:
    //   'restart-inline' — caller must await restartBrowserForCF(backoff=CF_ESCALATION_MS[0]),
    //                       increment hitCount, p--, continue (no other queries run during wait)
    //   'deferred'       — entry pushed to workList; caller should break inner loop
    //   'give-up'        — all escalation levels exhausted; caller should break inner loop
    const handleCFHit = (q, qi, hitCount, trigger, p) => {
      totalChallenges++;
      perQueryChallenges[qi] = (perQueryChallenges[qi] || 0) + 1;
      if (hitCount === 0) {
        // First hit on a fresh entry — restart inline so no other queries run during the 5s wait.
        logger.info(`[Indeed/Browser] ${trigger} q="${q}" p=${p + 1} — restarting browser (${CF_ESCALATION_MS[0] / 1000}s inline backoff)`);
        return 'restart-inline';
      }
      if (hitCount >= CF_ESCALATION_MS.length) {
        logger.warn(`[Indeed/Browser] ${trigger} q="${q}" p=${p + 1} — all retries exhausted, giving up on this page`);
        gaveUpCount++;
        gaveUpPages.push({ q, p: p + 1 });
        perQueryGaveUp[qi] = (perQueryGaveUp[qi] || 0) + 1;
        return 'give-up';
      }
      const cooldownMs = humanCooldown(CF_ESCALATION_MS[hitCount]);
      const nextRetry = hitCount + 1;
      logger.warn(`[Indeed/Browser] ${trigger} q="${q}" p=${p + 1} — defer retry ${nextRetry}/${CF_ESCALATION_MS.length} (cooldown ${(cooldownMs / 1000).toFixed(1)}s)`);
      workList.push({ q, qi, startPage: p, retryCount: nextRetry, availableAt: Date.now() + cooldownMs });
      return 'deferred';
    };

    let wi = 0;
    outer:
    while (wi < workList.length) {
      if (signal?.aborted) break;

      const entry = workList[wi];

      // ── Ready check: skip entries still in their cooldown window ──────────
      if (entry.availableAt > Date.now()) {
        // Find the next already-ready entry later in the list and bring it forward.
        const readyIdx = workList.findIndex((e, i) => i > wi && e.availableAt <= Date.now());
        if (readyIdx !== -1) {
          workList.splice(wi, 0, workList.splice(readyIdx, 1)[0]);
          continue; // re-evaluate workList[wi] (the newly moved entry) without advancing wi
        }

        // All remaining entries are still cooling down.
        // Before idle-waiting, try advancing a deferred query to its next page —
        // a different URL is less likely to hit the same CF sliding-window block.
        const nextPageCandidate = workList.slice(wi).find(e => {
          const nextPage = e.startPage + 1;
          return nextPage < maxPages && !nextPageAdvanced.has(`${e.qi}:${nextPage}`);
        });
        if (nextPageCandidate) {
          const nextPage = nextPageCandidate.startPage + 1;
          nextPageAdvanced.add(`${nextPageCandidate.qi}:${nextPage}`);
          workList.splice(wi, 0, {
            q: nextPageCandidate.q, qi: nextPageCandidate.qi,
            startPage: nextPage,
            retryCount: 0, availableAt: 0,
          });
          continue; // process the fresh next-page entry immediately
        }

        // No next pages available — idle-wait until the soonest entry is ready.
        const soonestAt = Math.min(...workList.slice(wi).map(e => e.availableAt));
        const waitMs = Math.max(0, soonestAt - Date.now());
        if (waitMs > 0) {
          logger.info(`[Indeed/Browser] All pending entries cooling down — idle ${Math.ceil(waitMs / 1000)}s`);
          await waitWithCountdown(waitMs, (s) => onProgress?.(`CF idle cooldown ${s}s…`));
        }
        continue; // don't advance wi
      }

      // ── Liveness check ────────────────────────────────────────────────────
      // Cloudflare challenge pages can detach the Puppeteer frame mid-navigation.
      // If the frame is dead, no further queries can succeed — stop cleanly.
      if (wi > 0 || entry.retryCount > 0) {
        const alive = await page.evaluate(() => true).catch(() => false);
        if (!alive) {
          logger.warn('[Indeed/Browser] Page frame detached after challenge — skipping remaining queries');
          break;
        }
      }

      // ── Browser restart for deferred entries ──────────────────────────────
      // The cooldown already elapsed while other queries were running, so
      // backoffMs=0 — we still need a fresh fingerprint (close + reopen, clear __cf_bm).
      if (entry.retryCount > 0) {
        logger.info(`[Indeed/Browser] Resuming deferred q="${entry.q}" p=${entry.startPage + 1} (retry ${entry.retryCount}/${CF_ESCALATION_MS.length})`);
        ({ browser, page } = await restartBrowserForCF(page, browser, 0, { userDataDir, launchOpts, onProgress }));
      }

      const { q, qi, retryCount } = entry;
      // hitCount starts at entry.retryCount and increments for each inline restart done
      // this pass, so the escalation level stays correct if a retry also hits CF inline.
      let hitCount = retryCount;

      const overlayBase = {
        srcName:  'Indeed',
        srcLabel: retryCount > 0
          ? `Retry ${retryCount}/${CF_ESCALATION_MS.length} q${qi + 1}/${queryList.length}`
          : `Query ${qi + 1} of ${queryList.length}`,
        qLabel:   'Searching',
        qText:    q,
      };

      for (let p = entry.startPage; p < maxPages; p++) {
        // Each page beyond the originally-deferred startPage is a fresh page —
        // reset hitCount so it gets its own full escalation budget rather than
        // inheriting the exhausted retryCount from the entry that was deferred.
        if (p > entry.startPage) hitCount = 0;

        if (signal?.aborted) break outer;
        if (allJobs.length >= resultCap) break outer;

        const start = p * 10;
        const url   = `https://${host}/jobs?q=${encodeURIComponent(q)}${locParam}&fromage=${days}${start > 0 ? `&start=${start}` : ''}`;

        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
          if (signal?.aborted) break outer;
          if (/timeout/i.test(e.message)) {
            // Timeout — try to read page anyway
          } else {
            logger.warn(`[Indeed/Browser] Nav error q="${q}" p=${p + 1}: ${e.message}`);
            break;
          }
        }

        await injectOverlay(page);
        await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: `Loading page ${p + 1}…`, progressText: '0/0' });
        await new Promise(r => setTimeout(r, 2000 + Math.round(Math.random() * 1000)));
        if (signal?.aborted) break outer;

        const signals = await getChallengeSignals(page);
        if (signals.isChallenge) {
          const rayId = await page.evaluate(() => {
            const m = (document.body?.innerHTML || '').match(/Ray ID[^:]*:\s*([0-9a-f]+)/i);
            return m ? m[1] : null;
          }).catch(() => null);
          logger.warn(`[Indeed/Browser] Challenge (${signals.reason}) q="${q}" p=${p + 1}${rayId ? ` Ray=${rayId}` : ''}`);
          await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: `⚠️ ${signals.reason}`, challenge: true });

          if (signals.reason !== 'indeed-login-wall') {
            const cfAction = handleCFHit(q, qi, hitCount, `cf-challenge (${signals.reason})`, p);
            if (cfAction === 'restart-inline') {
              hitCount++;
              ({ browser, page } = await restartBrowserForCF(page, browser, humanCooldown(CF_ESCALATION_MS[0]), { userDataDir, launchOpts, onProgress }));
              p--;
              continue;
            }
            break;
          }

          // Login wall — keep the CDP window open and let the user log in directly.
          // Disable overlay so it doesn't block the login form.
          await page.evaluate(() => {
            const panel = document.getElementById('__ic-panel');
            if (panel) panel.style.pointerEvents = 'none';
          }).catch(() => {});
          await updateOverlay(page, {
            ...overlayBase,
            count: allJobs.length,
            status: 'Sign in to Indeed to continue — waiting…',
            challenge: true,
          });

          const LOGIN_POLL_MS = 2000;
          const LOGIN_HEARTBEAT_MS = 30_000;
          let loggedIn = false;
          const loginWaitStart = Date.now();
          let loginHeartbeatAt = Date.now();

          // Wait INDEFINITELY for the user to sign in — never skip on a timer. The
          // escape hatches are an abort (Reset / hub close) or the user closing the
          // window; a heartbeat keeps an unattended wait visible in the logs.
          while (true) {
            if (signal?.aborted || page.isClosed()) break;
            await new Promise(r => setTimeout(r, LOGIN_POLL_MS));
            if (signal?.aborted || page.isClosed()) break;
            const currentUrl = page.url();
            const isAuthPage = /secure\.indeed\.com\/(auth|login)|indeed\.com\/(auth|login|signin)/i.test(currentUrl);
            if (currentUrl.includes('indeed.com') && !isAuthPage) {
              loggedIn = true;
              logger.info(`[Indeed/Browser] Login complete — resuming q=${qi + 1} p=${p + 1}`);
              break;
            }
            if (Date.now() - loginHeartbeatAt >= LOGIN_HEARTBEAT_MS) {
              loginHeartbeatAt = Date.now();
              logger.info(`[Indeed/Browser] still waiting for Indeed sign-in (${Math.round((Date.now() - loginWaitStart) / 60000)} min elapsed)`);
            }
          }

          if (!loggedIn || signal?.aborted) {
            challengedQi = qi; challengedPage = p; loginWallHit = true; break outer;
          }

          // Re-enable overlay and retry this page (p-- makes the loop revisit same index)
          await page.evaluate(() => {
            const panel = document.getElementById('__ic-panel');
            if (panel) panel.style.pointerEvents = 'auto';
          }).catch(() => {});
          p--;
          continue;
        }

        let html;
        try {
          html = await page.content();
        } catch (e) {
          logger.warn(`[Indeed/Browser] page.content() error q="${q}" p=${p + 1}: ${e.message}`);
          break outer;
        }
        const htmlKB = Math.round(html.length / 1024);
        // Extract structured job data (salary, dates) from window.mosaic at runtime —
        // the HTML-based mosaic marker hits a CSS URL in browser-rendered pages, not data.
        const windowMosaicResults = await page.evaluate(() => {
          try {
            return window.mosaic?.providerData?.['mosaic-provider-jobcards']
              ?.metaData?.mosaicProviderJobCardsModel?.results ?? null;
          } catch { return null; }
        }).catch(() => null);
        const rawPageJobs = extractIndeedJobsFromHtml(html, windowMosaicResults);
        // Indeed already ranks and fuzzily matches this page for the issued
        // search query. Keep every distinct returned row instead of applying a
        // second local title gate that can discard legitimate adjacent titles.
        const newProviderCandidates = [];
        const pageProviderKeys = new Set();
        for (const job of rawPageJobs) {
          const key = sourceJobKey(job);
          if (providerSeenKeys.has(key) || pageProviderKeys.has(key)) continue;
          pageProviderKeys.add(key);
          newProviderCandidates.push({ key, job });
        }
        const pageJobs = newProviderCandidates
          .map(candidate => candidate.job)
          .slice(0, Math.max(0, resultCap - allJobs.length));

        // Soft block: Indeed returns a tiny near-empty page instead of a hard challenge.
        // Normal search pages are ~1500KB; anything under 150KB with 0 jobs is suspect.
        if (html.length < 150_000 && rawPageJobs.length === 0) {
          logger.warn(`[Indeed/Browser] Soft block suspected — ${htmlKB}KB, 0 jobs q="${q}" p=${p + 1}`);
          const cfAction = handleCFHit(q, qi, hitCount, 'soft-block', p);
          if (cfAction === 'restart-inline') {
            hitCount++;
            ({ browser, page } = await restartBrowserForCF(page, browser, humanCooldown(CF_ESCALATION_MS[0]), { userDataDir, launchOpts, onProgress }));
            p--;
            continue;
          }
          break;
        }

        // Check for a next-page link as a more reliable last-page signal than result count.
        const hasNextPage = await page.evaluate(() =>
          !!(document.querySelector('[aria-label="Next Page"], [data-testid="pagination-page-next"]') ||
             document.querySelector('a[href*="&start="]'))
        ).catch(() => null);

        logger.info(`[Indeed/Browser] q="${q}" p=${p + 1}: ${pageJobs.length} platform-returned job(s) from ${rawPageJobs.length} candidate(s) (${htmlKB}KB${hasNextPage === false ? ', last page' : ''})`);
        onProgress?.(`q${qi + 1}/${queryList.length} · p${p + 1}${retryCount > 0 ? ` (retry ${retryCount})` : ''}`);

        if (rawPageJobs.length === 0) break;

        // Click each card on this page to load full descriptions from the right panel.
        await updateOverlay(page, {
          ...overlayBase,
          count: allJobs.length,
          status: `Enriching ${pageJobs.length} jobs…`,
          progressText: `0/${pageJobs.length}`,
        });
        let enrichResult;
        try {
          enrichResult = await enrichWithDescriptions(page, pageJobs, signal, overlayBase, allJobs.length);
        } catch (e) {
          logger.warn(`[Indeed/Browser] Description enrichment failed p=${p + 1}: ${e.message}`);
          enrichResult = { enriched: 0, cfBlankAt: null };
        }

        if (enrichResult.cfBlankAt != null) {
          logger.warn(`[Indeed/Browser] CF blank at card ${enrichResult.cfBlankAt + 1} q=${qi + 1} p=${p + 1}`);
          await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: '⚠️ cf-blank-enrichment', challenge: true });
          const cfAction = handleCFHit(q, qi, hitCount, 'cf-blank-enrichment', p);
          if (cfAction === 'restart-inline') {
            hitCount++;
            ({ browser, page } = await restartBrowserForCF(page, browser, humanCooldown(CF_ESCALATION_MS[0]), { userDataDir, launchOpts, onProgress }));
            p--;
            continue;
          }
          break;
        }

        if (signal?.aborted) break outer;

        // Commit provider accounting only after enrichment succeeds.
        // A CF-blank page is retried; committing before that retry would make
        // every card look like a duplicate and silently skip its second attempt.
        for (const { key } of newProviderCandidates) {
          providerSeenKeys.add(key);
        }

        const pageAdded = [];
        for (let i = 0; i < pageJobs.length; i++) {
          const job = pageJobs[i];
          const dk = sourceJobKey(job);
          if (seenKeys.has(dk)) continue;
          seenKeys.add(dk);
          allJobs.push(job);
          pageAdded.push(job);
          await updateOverlay(page, {
            ...overlayBase,
            count: allJobs.length,
            status: `Collected ${allJobs.length} jobs…`,
            progressText: `${i + 1}/${pageJobs.length}`,
          });
          if (allJobs.length >= resultCap) break;
        }
        await updateOverlay(page, {
          ...overlayBase,
          count: allJobs.length,
          status: `Page ${p + 1} done`,
          progressText: `${pageJobs.length}/${pageJobs.length}`,
        });

        // Per-page recovery flush (crash/quit checkpoint). `p` is 0-based here;
        // record 1-based to match the manual scraper's pageNum. Best-effort.
        if (onPageJobs && pageAdded.length > 0) {
          try { await onPageJobs({ sourceId: 'indeed', query: q, page: p + 1, jobs: pageAdded }); }
          catch (e) { logger.warn(`[Indeed/Browser] onPageJobs failed (non-fatal): ${e?.message || e}`); }
        }

        // Data-driven stop (age-window / no-new-jobs) — an ADDITIONAL, possibly
        // EARLIER-terminating signal than the "hasNextPage" heuristic just below,
        // needed now that pages defaults to "All" rather than a fixed ceiling.
        // Reached only on a genuinely successful extraction: every failure path
        // above (challenge, soft-block, nav error, page.content() error) `break`s
        // or `continue`s before this point, so a failed page is never fed to the
        // callback as if it were a real (empty) one. Fed rawPageJobs — the FULL
        // page of candidates, not the relevance-filtered/capped pageJobs — since
        // the age/staleness rules are pager signals, independent of title
        // relevance (a page of only off-target titles can still be genuinely
        // in-window and freshly-paged).
        let stopDecision = null;
        try {
          stopDecision = await queryPageStops[qi]({ items: rawPageJobs, pageIndex: p });
        } catch (e) {
          logger.warn(`[Indeed/Browser] onPageScraped threw (non-fatal): ${e?.message || e}`);
        }
        if (stopDecision?.stop) {
          logger.info(`[Indeed/Browser] q="${q}" p=${p + 1}: ${stopDecision.detail || stopDecision.reason}`);
          break;
        }

        if (rawPageJobs.length < 10 || hasNextPage === false) break;

        if (p < maxPages - 1) {
          const delay = PAGE_DELAY_MS[0] + Math.round(Math.random() * (PAGE_DELAY_MS[1] - PAGE_DELAY_MS[0]));
          await new Promise(r => setTimeout(r, delay));
        }
      }

      // Query delay only for fresh (non-retry) entries to avoid double-penalizing retries.
      if (retryCount === 0 && !signal?.aborted) {
        const delay = QUERY_DELAY_MS[0] + Math.round(Math.random() * (QUERY_DELAY_MS[1] - QUERY_DELAY_MS[0]));
        await new Promise(r => setTimeout(r, delay));
      }

      wi++;
    }

    // ── Post-run re-enrichment pass ─────────────────────────────────────────────
    // Jobs with empty descriptions after the main pass may be silent CF blanks —
    // the panel loaded empty without triggering a visible challenge page.
    // One retry navigating directly to each job URL reveals the truth:
    // genuine empties stay empty; CF-blanked ones populate.
    //
    // If the run was CF-heavy, wait for the sliding window to cool before
    // navigating to job URLs — starting immediately after 90 challenges means
    // CF is still active and the re-enrichment gets blocked on the first request.
    // Heuristic: 30s per 10 challenges, capped at 120s.
    const missingDescJobs = allJobs.filter(j => !j.description || j.description.trim() === '');
    let reEnriched = 0;
    if (missingDescJobs.length > 0 && !signal?.aborted) {
      if (totalChallenges > 0) {
        const cooldownMs = Math.min(120_000, Math.ceil(totalChallenges / 10) * 30_000);
        logger.info(`[Indeed/Browser] Re-enrich: waiting ${cooldownMs / 1000}s CF cooldown before re-enrichment (${totalChallenges} challenges this run)`);
        await waitWithCountdown(cooldownMs, (s) => onProgress?.(`Re-enrich CF cooldown ${s}s…`));
      }
      logger.info(`[Indeed/Browser] Re-enriching ${missingDescJobs.length} jobs with missing descriptions`);
      for (let ri = 0; ri < missingDescJobs.length; ri++) {
        if (signal?.aborted) break;
        const job = missingDescJobs[ri];
        const jobUrl = job.url || (job.jobkey ? `https://${host}/viewjob?jk=${job.jobkey}` : null);
        if (!jobUrl) continue;
        try {
          await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await new Promise(r => setTimeout(r, 1200 + Math.round(Math.random() * 800)));
          const sigs = await getChallengeSignals(page);
          if (sigs.isChallenge) {
            logger.warn(`[Indeed/Browser] Re-enrich: CF active (${sigs.reason}) — skipping remaining ${missingDescJobs.length - ri}, CF window still hot`);
            break;
          }
          const desc = await page.$eval(DESC_SELECTOR, el => el.textContent?.trim() || '').catch(() => '');
          if (desc) { job.description = desc; job.snippet = desc; reEnriched++; }
          if (ri < missingDescJobs.length - 1) {
            await new Promise(r => setTimeout(r, 800 + Math.round(Math.random() * 600)));
          }
        } catch (e) {
          logger.warn(`[Indeed/Browser] Re-enrich failed (${job.jobkey || 'no-key'}): ${e.message}`);
        }
      }
      logger.info(`[Indeed/Browser] Re-enrich complete: ${reEnriched}/${missingDescJobs.length} recovered`);

      // A second, deliberately slower pass gives transiently blank detail panes
      // one clean chance to settle before the caller has to ask the user whether
      // low-evidence rows should be scored. Keep it bounded to the residual set:
      // it is a recovery attempt, not another crawl of every result.
      const residualDescJobs = missingDescJobs.filter(job => !job.description || job.description.trim() === '');
      if (residualDescJobs.length > 0 && !signal?.aborted) {
        logger.info(`[Indeed/Browser] Slow re-enriching ${residualDescJobs.length} residual job(s)`);
        let slowRecovered = 0;
        for (let ri = 0; ri < residualDescJobs.length; ri++) {
          if (signal?.aborted) break;
          const job = residualDescJobs[ri];
          const jobUrl = job.url || (job.jobkey ? `https://${host}/viewjob?jk=${job.jobkey}` : null);
          if (!jobUrl) continue;
          try {
            await page.goto(jobUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 3000 + Math.round(Math.random() * 1000)));
            const sigs = await getChallengeSignals(page);
            if (sigs.isChallenge) {
              logger.warn(`[Indeed/Browser] Slow re-enrich: CF active (${sigs.reason}) — skipping remaining ${residualDescJobs.length - ri}, CF window still hot`);
              break;
            }
            const desc = await page.$eval(DESC_SELECTOR, el => el.textContent?.trim() || '').catch(() => '');
            if (desc) { job.description = desc; job.snippet = desc; slowRecovered++; }
            if (ri < residualDescJobs.length - 1) {
              await new Promise(r => setTimeout(r, 1500 + Math.round(Math.random() * 1000)));
            }
          } catch (e) {
            logger.warn(`[Indeed/Browser] Slow re-enrich failed (${job.jobkey || 'no-key'}): ${e.message}`);
          }
        }
        reEnriched += slowRecovered;
        logger.info(`[Indeed/Browser] Slow re-enrich complete: ${slowRecovered}/${residualDescJobs.length} recovered`);
      }
    }

    // Compact per-query summary — 1 line per query so the full run picture fits
    // within the 60-line ring buffer regardless of how long the scrape ran.
    for (let i = 0; i < queryList.length; i++) {
      const cf      = perQueryChallenges[i] || 0;
      const skipped = perQueryGaveUp[i]     || 0;
      const cfNote      = cf      ? ` ${cf} CF`            : ' clean';
      const skippedNote = skipped ? ` ⚠️ ${skipped} skipped` : '';
      logger.info(`[Indeed/Browser] q${i + 1} "${queryList[i]}":${cfNote}${skippedNote}`);
    }
    logger.info(`[Indeed/Browser] ${allJobs.length} unique jobs, ${totalChallenges} challenges, ${queryList.length} queries${reEnriched > 0 ? `, ${reEnriched} re-enriched` : ''}`);

    const inWindow = maxAgeDays ? filterJobsByAge(allJobs, maxAgeDays) : allJobs;
    const items    = inWindow.slice(0, resultCap);

    let warning = null;
    if (loginWallHit) {
      warning = {
        code: 'needs-login',
        severity: 'block',
        evidence: 'Indeed session expired — login wall hit during pagination.',
        suggestion: 'Open Settings → Job Sources → Connect Indeed to refresh your login, then click Continue on the source card.',
        resumeState: {
          remainingQueries: queryList.slice(challengedQi),
          startPage: challengedPage,
        },
      };
    } else if (totalChallenges > 0 && items.length === 0) {
      warning = {
        code: 'scrape-failed',
        severity: 'block',
        evidence: `${totalChallenges} Cloudflare challenge(s) — no jobs extracted.`,
        suggestion: 'Try again in a few minutes.',
      };
    } else if (gaveUpCount > 0) {
      warning = {
        code: 'scrape-partial',
        severity: 'warn',
        evidence: `${gaveUpCount} page(s) skipped after persistent Cloudflare challenges — some results may be missing.${gaveUpPages.length ? ` Skipped: ${gaveUpPages.map(({ q, p }) => `"${q}" p${p}`).join(', ')}.` : ''}`,
        suggestion: null,
      };
    }

    return {
      items,
      warning,
      gathered: inWindow.length,
      providerGathered: providerSeenKeys.size,
      relevanceDropped: 0,
      preCapRelevanceDropped: 0,
      relevanceRejected: [],
    };

  } finally {
    if (browser) {
      await browser.close().catch(e => logger.warn(`[Indeed/Browser] browser.close() failed: ${e.message}`));
      // Kill by profile path rather than Puppeteer's process reference — CDP disconnect
      // can null out browser._process before we reach here, making kill() a no-op and
      // leaving Chrome alive to hold the SingletonLock for the next launch.
      await killChromeHoldingProfile(userDataDir);
    }
  }
}
