/**
 * Browser-based Indeed extractor — real Chrome (non-headless Puppeteer) with a
 * persistent auth'd profile so Indeed serves page 2+ without a login wall.
 *
 * Replaces fetchIndeedListings (Scrapfly, ~$21/run).
 * Profile lives in the shared browser-data userDataDir used by Settings login.
 * First-time setup: open Settings → Job Platform Logins → Indeed and log in.
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import electronPkg from 'electron';
import { logger } from '../logger.js';
import { findChromePath, findSystemChromePath, getUserDataDir, getSharedProfileReservationInfo, launchWithProfileLockRetry, reserveSharedProfile } from '../ipc/stealthBrowser.js';
import { extractIndeedJobsFromHtml } from './apiExtractors.js';
import { normalizeJobCollectionLimits, resolvePageCeiling, isUnlimitedPages, describeJobCollectionLimits } from '../../src/utils/jobCollectionLimits.js';
import { makeJobPageStop } from '../ipc/jobPageStop.js';
import { filterJobsByAge } from '../ipc/jobDateFilter.js';
import { buildOverlayScript, updateOverlay } from '../ipc/browser/scraperOverlay.js';
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

// Kept as a pure decision seam for the resume flow and its tests. A native
// Chrome handoff is needed because the reported challenge loop persisted even
// after the user completed it inside the Puppeteer-controlled window.
export function shouldHandoffIndeedChallengeToNative(reason) {
  // Text-only CF walls cannot be completed in the controlled page, but they
  // are precisely the cases worth one real-Chrome attempt. This is a handoff
  // decision, not a decision to wait in the automation process.
  return [
    'cloudflare-challenge-url',
    'challenge-shell',
    'cloudflare-challenge-frame',
    'cf-verify-text',
  ].includes(String(reason || ''));
}

export function classifyIndeedSessionPreflight({ hasPPID = false, authenticatedUrl = false, landedUrl = '', challengeReason = null } = {}) {
  const url = String(landedUrl || '');
  if (!url || url === 'about:blank') return { status: 'unreachable' };
  // This must precede every auth inference for REAL challenges. A CF URL can
  // still be an indeed.com URL, but it says nothing about either account
  // authentication or clearance. "indeed-login-wall" is deliberately excluded
  // here: this preflight navigates to an auth-gated URL
  // (secure.indeed.com/settings/account) on purpose, so a redirect to Indeed's
  // OWN sign-in page is the ORDINARY logged-out signal, not a bot wall — routing
  // it through "challenge" told a logged-out user to wait and retry while hiding
  // the actual login path.
  if (challengeReason && challengeReason !== 'indeed-login-wall') return { status: 'challenge', reason: challengeReason };
  if (hasPPID || authenticatedUrl) return { status: 'authenticated', proof: hasPPID ? 'PPID' : 'authenticated-url' };
  if (challengeReason === 'indeed-login-wall' || /\/(auth|login|signin)(\?|$)/i.test(url)) {
    return { status: 'needs-login', reason: 'redirected-to-sign-in' };
  }
  // Public Indeed pages are intentionally NOT an authentication signal.
  return { status: 'needs-login', reason: 'auth-cookie-missing' };
}

function ownedProcessExited(proc) {
  return !proc || proc.exitCode != null || proc.signalCode != null;
}

function waitForOwnedProcessExit(proc, timeoutMs) {
  if (ownedProcessExited(proc)) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const done = () => {
      if (timer) clearTimeout(timer);
      proc.removeListener?.('exit', done);
      resolve(true);
    };
    proc.once('exit', done);
    if (ownedProcessExited(proc)) return done();
    timer = setTimeout(() => {
      proc.removeListener?.('exit', done);
      resolve(ownedProcessExited(proc));
    }, timeoutMs);
  });
}

// Close only the Chrome process this extractor launched. The retired `pkill -f
// <userDataDir>` cleanup matched every login/scrape window sharing the profile
// and could terminate a live login while it was checkpointing auth cookies.
async function closeOwnedIndeedBrowser(browser, label) {
  if (!browser) return;
  const proc = browser.process?.();
  const gracefulExit = waitForOwnedProcessExit(proc, 10_000);
  await browser.close().catch(error => logger.warn(`[Indeed/Browser] ${label} browser.close() failed: ${error.message}`));
  if (await gracefulExit) return;
  logger.warn(`[Indeed/Browser] ${label} Chrome did not exit gracefully — terminating the owned process only`);
  try { if (!ownedProcessExited(proc)) proc.kill('SIGTERM'); } catch { /* already gone */ }
  if (await waitForOwnedProcessExit(proc, 3_000)) return;
  try { if (!ownedProcessExited(proc)) proc.kill('SIGKILL'); } catch { /* already gone */ }
  await waitForOwnedProcessExit(proc, 2_000);
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
  const challengeUrl = /__cf_chl|cf_chl|cf-chl/i.test(url);
  if (url.includes('secure.indeed.com/auth') || url.includes('/auth?co=')) {
    return { isChallenge: true, reason: 'indeed-login-wall', interactive: false, autoProgressing: false };
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
      return { bodyChallenge: !!(reason || (!normalContent && (challengeShell || cfFrame))), reason, interactive: challengeShell || cfFrame };
    }).then(({ bodyChallenge, reason, interactive }) => {
      const finalReason = reason || (challengeUrl ? 'cloudflare-challenge-url' : null);
      // URL-only CF hops can complete automatically; a text-only CF hard wall
      // cannot. `cf-verify-text` is deliberately not auto-progressing.
      return {
        isChallenge: !!(bodyChallenge || challengeUrl),
        reason: finalReason,
        interactive,
        autoProgressing: challengeUrl && !reason,
      };
    });
  } catch {
    return challengeUrl
      ? { isChallenge: true, reason: 'cloudflare-challenge-url', interactive: false, autoProgressing: true }
      : { isChallenge: false, reason: null, interactive: false, autoProgressing: false };
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

  const existingReservation = getSharedProfileReservationInfo();
  if (existingReservation) {
    logger.warn(`[Indeed/Browser] Description retry deferred — shared profile is reserved for ${existingReservation.reason}`);
    return { jobs: rows, attempted: 0, recovered: 0, remaining: targets.length, unavailable: [], challengeReason: 'shared-profile-reserved' };
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

  let releaseProfileReservation;
  try {
    releaseProfileReservation = reserveSharedProfile('indeed-description-retry');
  } catch (error) {
    logger.warn(`[Indeed/Browser] Description retry could not reserve shared profile: ${error?.message || error}`);
    return { jobs: rows, attempted: 0, recovered: 0, remaining: targets.length, unavailable: [], challengeReason: 'shared-profile-reserved' };
  }

  let browser;
  let recovered = 0;
  let challengeReason = null;
  const unavailable = [];
  try {
    browser = await launchWithProfileLockRetry(launchOpts, 'indeed-description-retry');

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
    await closeOwnedIndeedBrowser(browser, 'description retry');
    releaseProfileReservation?.();
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
  const reservation = getSharedProfileReservationInfo();
  if (reservation) {
    return {
      items: [],
      warning: {
        code: 'scrape-failed',
        severity: 'block',
        evidence: `Indeed could not start because the shared browser profile is reserved for ${reservation.reason}.`,
        actionTitle: 'Retries the Indeed scrape — this failure was a busy browser profile, not your Indeed login',
        suggestion: 'Close the open login or verification window, then click Continue to resume Indeed.',
        resumeState: { remainingQueries: Array.isArray(queries) ? queries.filter(Boolean) : [queries].filter(Boolean), startPage },
      },
      gathered: 0,
    };
  }
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

  let releaseProfileReservation;
  try {
    releaseProfileReservation = reserveSharedProfile('indeed-browser-scrape');
  } catch (error) {
    return {
      items: [],
      warning: {
        code: 'scrape-failed', severity: 'block',
        evidence: error?.message || 'Indeed could not reserve the shared browser profile.',
        actionTitle: 'Retries the Indeed scrape — this failure was a busy browser profile, not your Indeed login',
        suggestion: 'Close the open login or verification window, then click Continue to resume Indeed.',
        resumeState: { remainingQueries: queryList, startPage },
      },
      gathered: 0,
    };
  }

  let browser;
  try {
    try {
      browser = await launchWithProfileLockRetry(launchOpts, 'indeed-browser-scrape');
    } catch (launchError) {
      // Indeed is dispatched from inside fetchApiSources, whose generic catch
      // labels ANY throw `api-failed` with "API call failed. Check logs for the
      // full response." Indeed has no API — it is a browser scraper — so a
      // Chrome launch failure surfaced to the user as an API error and sent them
      // looking for a response that never existed. Return the same structured,
      // resumable shape the profile-RESERVATION conflict above already returns,
      // so the card names the real cause and offers Continue instead of dead-
      // ending. Rethrow nothing: the finally below still releases the reservation.
      logger.warn(`[Indeed/Browser] Chrome launch failed: ${launchError?.message || launchError}`);
      return {
        items: [],
        warning: {
          code: 'scrape-failed', severity: 'block',
          evidence: `Indeed's Chrome could not start: ${String(launchError?.message || launchError).slice(0, 400)}`,
          actionTitle: 'Retries the Indeed scrape — this failure was a browser that could not start, not your Indeed login',
          suggestion: 'Close any open login or verification window, then click Continue to resume Indeed.',
          resumeState: { remainingQueries: queryList, startPage },
        },
        gathered: 0,
      };
    }

    let page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.evaluateOnNewDocument(OVERLAY_SCRIPT);

    // Verify auth state before running any queries.
    let navError = null;
    const accountVerifyUrl = 'https://secure.indeed.com/settings/account';
    await page.goto(accountVerifyUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => { navError = e; });
    const landedUrl = page.url();
    await injectOverlay(page);
    await updateOverlay(page, { srcName: 'Indeed', srcLabel: 'Checking session…', count: 0, status: 'Verifying login…' });
    await new Promise(r => setTimeout(r, 1200 + Math.round(Math.random() * 600)));
    let cookies = await page.cookies(`https://${host}`, 'https://www.indeed.com', 'https://secure.indeed.com').catch(() => []);
    let hasPPID = cookies.some(c => c.name === 'PPID' && c.domain?.includes('indeed.com'));
    let hasCfClearance = cookies.some(c => c.name === 'cf_clearance');
    let hasCfBm = cookies.some(c => c.name === '__cf_bm');
    let cookieNameList = cookies.map(c => c.name);
    let allCookieNames = cookieNameList.join(', ') || '(none)';
    let preflightSignals = await getChallengeSignals(page);
    let preflight = classifyIndeedSessionPreflight({
      hasPPID,
      authenticatedUrl: /^https:\/\/secure\.indeed\.com\/settings\/account(?:[/?#]|$)/i.test(landedUrl),
      landedUrl,
      challengeReason: preflightSignals.isChallenge ? preflightSignals.reason : null,
    });
    // Observed-state snapshot, attached to every return from this point on so a
    // bug report can always show what the scrape actually saw (landed URL,
    // cookie names, PPID) rather than only the classified outcome. Built once,
    // right after the preflight classification — nothing below changes these
    // values.
    const sessionDiagnostics = {
      landedUrl,
      preflightStatus: preflight.status,
      preflightReason: preflight.reason || null,
      hasPPID,
      cookieNames: cookieNameList,
      executablePath,
      userDataDir,
      host,
    };
    // Emitted before every early return below (not after) so a run that never
    // reaches the query loop still leaves this diagnostic line for a bug report.
    logger.info(`[Indeed/Browser] Session check — PPID:${hasPPID} cf_clearance:${hasCfClearance} __cf_bm:${hasCfBm} | all cookies: ${allCookieNames} | landedUrl: ${landedUrl} | preflight:${preflight.status}${preflight.reason ? ` (${preflight.reason})` : ''}`);

    // A challenge solved in this Puppeteer-controlled window can still be rejected
    // by CF. Return an explicit native-Chrome handoff instead of retrying here;
    // the caller closes this controlled browser, opens real Chrome on this exact
    // URL, and resumes only after the native page is stably clean.
    if (preflight.status === 'challenge') {
      return {
        items: [],
        warning: {
          code: 'scrape-failed', severity: 'block',
          evidence: `Indeed initial ${preflight.reason || 'Cloudflare'} challenge requires a native Chrome verification handoff; the controlled browser will not be retried.`,
          suggestion: shouldHandoffIndeedChallengeToNative(preflight.reason)
            ? 'Click Continue and complete the check in the real Chrome window that opens.'
            : 'Indeed returned a non-interactive block. Wait before retrying, or use a different network/session.',
          resumeState: {
            mode: shouldHandoffIndeedChallengeToNative(preflight.reason) ? 'native-challenge' : 'retry-later',
            challengeUrl: page.url(), remainingQueries: queryList, startPage,
          },
        },
        gathered: 0,
        sessionDiagnostics,
      };
    }

    // The navigation never landed anywhere (no internet, DNS failure, dead VPN):
    // the page is still about:blank, so nothing was observed about the session.
    // Reporting that as 'needs-login' would assert a cause the run never saw —
    // say what was actually observed instead. A timeout that still landed keeps
    // the sign-in-redirect check below, and a PPID cookie still proves the
    // session regardless of a transient nav failure.
    if (preflight.status === 'unreachable') {
      logger.warn(`[Indeed/Browser] Landing navigation never completed — session state unknown${navError ? ` (${navError.message})` : ''}`);
      return {
        items: [],
        warning: {
          code: 'scrape-failed',
          severity: 'block',
          evidence: `Could not reach Indeed account verification${navError ? ` — ${String(navError.message || navError).slice(0, 200)}` : ''}. Session state unknown.`,
          suggestion: 'Check your internet connection (or VPN) and retry.',
        },
        gathered: 0,
        sessionDiagnostics,
      };
    }

    if (preflight.status !== 'authenticated') {
      logger.warn(`[Indeed/Browser] Not authenticated — PPID missing (${preflight.reason || 'no authenticated session proof'})`);
      return {
        items: [],
        warning: {
          code: 'needs-login',
          severity: 'block',
          actionLabel: 'Log in',
          actionTitle: 'Opens a real Chrome window to sign in to Indeed, then resumes this search automatically',
          evidence: `Indeed session check landed at ${landedUrl}. Cookies observed: ${allCookieNames}. PPID — the session proof — was absent.`,
          suggestion: 'Click "Log in" on this card to sign in to Indeed in a real Chrome window — the search resumes automatically afterward.',
          resumeState: { mode: 'native-login', remainingQueries: queryList, startPage },
        },
        gathered: 0,
        sessionDiagnostics,
      };
    }
    // Say "All" explicitly (with its backstop) rather than just printing the
    // resolved ceiling number — otherwise a user who chose "All" sees a plain
    // "up to 1000 pages" log line that reads like a deliberate 1000-page setting.
    logger.info(`[Indeed/Browser] Authenticated. ${queryList.length} queries × up to ${describeJobCollectionLimits(limits).pages} pages`);

    const allJobs = [];
    const seenKeys = new Set();
    const providerSeenKeys = new Set();
    let totalChallenges = 0;
    let loginWallHit = false;
    let challengedQi = -1;
    let challengedPage = 0;
    let manualChallenge = null; // actionable return state when the visible solve did not clear
    // Per-query CF telemetry — logged as compact summaries at run end so the
    // full picture fits in the 60-line ring buffer regardless of run length.
    const perQueryChallenges = {}; // qi → challenge count

    const stopForIndeedChallenge = async ({ q, qi, p, reason, label }) => {
      totalChallenges++;
      perQueryChallenges[qi] = (perQueryChallenges[qi] || 0) + 1;
      const challengeUrl = page.url();
      const nativeHandoff = shouldHandoffIndeedChallengeToNative(reason);
      manualChallenge = { q, qi, p, reason: reason || 'challenge', status: nativeHandoff ? 'native-handoff-required' : 'hard-block', challengeUrl, nativeHandoff };
      logger.warn(`[Indeed/Browser] ${label} requires ${nativeHandoff ? 'native Chrome handoff' : 'a later retry'}; preserving the profile and stopping this controlled-browser run.`);
      return false;
    };

    // One pass per requested query. A CF hit stops this controlled browser and
    // returns a native-Chrome handoff state; it never resets cookies or retries
    // inside Puppeteer.
    const workList = queryList.map((q, qi) => ({
      q, qi,
      startPage: qi === 0 ? startPage : 0,
      retryCount: 0,
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

    let wi = 0;
    outer:
    while (wi < workList.length) {
      if (signal?.aborted) break;

      const entry = workList[wi];

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

      const { q, qi, retryCount } = entry;

      const overlayBase = {
        srcName:  'Indeed',
        srcLabel: `Query ${qi + 1} of ${queryList.length}`,
        qLabel:   'Searching',
        qText:    q,
      };

      for (let p = entry.startPage; p < maxPages; p++) {
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

          if (signals.reason === 'indeed-login-wall') {
            // Never allow Google/Indeed SSO inside the Puppeteer-controlled
            // scrape window. Close it through finally and direct the user to
            // the native Settings login flow, which owns the real Chrome profile.
            challengedQi = qi;
            challengedPage = p;
            loginWallHit = true;
            logger.warn(`[Indeed/Browser] Indeed login wall q="${q}" p=${p + 1} — refusing CDP login; use native Settings login instead.`);
            break outer;
          }

          await stopForIndeedChallenge({
            q, qi, p, reason: signals.reason, label: `Cloudflare challenge q="${q}" p=${p + 1}`,
          });
          break outer;
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
          totalChallenges++;
          perQueryChallenges[qi] = (perQueryChallenges[qi] || 0) + 1;
          manualChallenge = { q, qi, p, reason: 'soft-block', status: 'hard-block' };
          break outer;
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
          const blankSignals = await getChallengeSignals(page);
          if (blankSignals.isChallenge) {
            const cleared = await stopForIndeedChallenge({
              q, qi, p, reason: blankSignals.reason || 'cf-blank-enrichment', label: `Cloudflare description challenge q="${q}" p=${p + 1}`,
            });
            if (cleared) {
              p--;
              continue;
            }
          } else {
            totalChallenges++;
            perQueryChallenges[qi] = (perQueryChallenges[qi] || 0) + 1;
            manualChallenge = { q, qi, p, reason: 'cf-blank-enrichment', status: 'hard-block' };
          }
          if (manualChallenge) {
            break outer;
          }
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
    if (missingDescJobs.length > 0 && !signal?.aborted && !manualChallenge) {
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
      const cfNote      = cf      ? ` ${cf} CF`            : ' clean';
      logger.info(`[Indeed/Browser] q${i + 1} "${queryList[i]}":${cfNote}`);
    }
    logger.info(`[Indeed/Browser] ${allJobs.length} unique jobs, ${totalChallenges} challenges, ${queryList.length} queries${reEnriched > 0 ? `, ${reEnriched} re-enriched` : ''}`);

    const inWindow = maxAgeDays ? filterJobsByAge(allJobs, maxAgeDays) : allJobs;
    const items    = inWindow.slice(0, resultCap);

    let warning = null;
    if (manualChallenge) {
      warning = {
        code: 'scrape-failed',
        severity: 'block',
        evidence: `Indeed ${manualChallenge.reason} at "${manualChallenge.q}" page ${manualChallenge.p + 1} did not clear (${manualChallenge.status}). The browser profile and Cloudflare cookies were preserved.`,
        suggestion: manualChallenge.status === 'hard-block'
          ? 'Indeed returned a non-interactive block. Wait before retrying, or use a different network/session.'
          : 'Click Continue, then complete the check in the real Chrome window that opens.',
        resumeState: {
          mode: manualChallenge.nativeHandoff ? 'native-challenge' : 'retry-later',
          challengeUrl: manualChallenge.challengeUrl,
          remainingQueries: queryList.slice(manualChallenge.qi),
          startPage: manualChallenge.p,
        },
      };
    } else if (loginWallHit) {
      warning = {
        code: 'needs-login',
        severity: 'block',
        actionLabel: 'Log in',
        actionTitle: 'Opens a real Chrome window to sign in to Indeed, then resumes this search automatically',
        evidence: `Indeed redirected to its sign-in page mid-pagination at "${queryList[challengedQi]}" page ${challengedPage + 1}.`,
        suggestion: 'Click "Log in" on this card to sign in to Indeed in a real Chrome window — the search resumes automatically afterward.',
        resumeState: {
          mode: 'native-login',
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
    }

    return {
      items,
      warning,
      gathered: inWindow.length,
      providerGathered: providerSeenKeys.size,
      relevanceDropped: 0,
      preCapRelevanceDropped: 0,
      relevanceRejected: [],
      sessionDiagnostics,
    };

  } finally {
    await closeOwnedIndeedBrowser(browser, 'listing scrape');
    releaseProfileReservation?.();
  }
}
