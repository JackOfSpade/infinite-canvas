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
import { JOB_MAX_PAGES, JOB_RESULT_CAP, JOB_PER_PAGE_CAP } from '../ipc/resultCaps.js';
import { filterJobsByAge } from '../ipc/jobDateFilter.js';
import { buildOverlayScript, updateOverlay } from '../ipc/browser/scraperOverlay.js';
import { humanCooldown } from '../utils/humanDelay.js';
import { jobTitleCompanyKey } from '../../src/utils/jobIdentity.js';

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
 * Fetch Indeed job listings using a real Chrome session with a persistent
 * auth'd profile. Replaces the Scrapfly-based fetchIndeedListings().
 *
 * @param {string[]} queries
 * @param {AbortSignal|null} signal
 * @param {number|null} maxAgeDays
 * @param {string} [profileDir] — override for the Puppeteer userDataDir
 * @returns {Promise<{ items: object[], warning: object|null, gathered: number }>}
 */
export async function fetchIndeedListingsBrowser(queries, signal = null, maxAgeDays = null, profileDir = null, onProgress = null, startPage = 0) {
  const userDataDir  = profileDir || await getUserDataDir().catch(() => getProfileDir());
  const queryList    = Array.isArray(queries) ? queries.filter(Boolean) : [queries].filter(Boolean);
  const days         = maxAgeDays ? Math.max(1, Math.floor(maxAgeDays)) : 21;
  const resultCap    = Number.isFinite(JOB_RESULT_CAP) ? JOB_RESULT_CAP : Infinity;
  const maxPages     = JOB_MAX_PAGES;

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
    await page.goto('https://www.indeed.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    const landedUrl = page.url();
    await injectOverlay(page);
    await updateOverlay(page, { srcName: 'Indeed', srcLabel: 'Checking session…', count: 0, status: 'Verifying login…' });
    await new Promise(r => setTimeout(r, 1200 + Math.round(Math.random() * 600)));
    const cookies = await page.cookies('https://www.indeed.com', 'https://secure.indeed.com').catch(() => []);
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

    logger.info(`[Indeed/Browser] Authenticated. ${queryList.length} queries × up to ${maxPages} pages`);

    // ── Escalation table ────────────────────────────────────────────────────
    // Cooldown after the Nth failure before the (N+1)th attempt. Other queries
    // run during this window, so actual elapsed time may be longer.
    // Index = retryCount of the entry that just failed.
    // retryCount ≥ CF_ESCALATION_MS.length → all retries exhausted, give up.
    const CF_ESCALATION_MS = [5_000, 30_000, 60_000, 0];

    const allJobs = [];
    const seenKeys = new Set();
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
        const url   = `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&fromage=${days}${start > 0 ? `&start=${start}` : ''}`;

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
          const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
          const loginDeadline = Date.now() + LOGIN_TIMEOUT_MS;
          let loggedIn = false;

          while (Date.now() < loginDeadline) {
            if (signal?.aborted) break;
            await new Promise(r => setTimeout(r, LOGIN_POLL_MS));
            if (signal?.aborted) break;
            const currentUrl = page.url();
            const isAuthPage = /secure\.indeed\.com\/(auth|login)|indeed\.com\/(auth|login|signin)/i.test(currentUrl);
            if (currentUrl.includes('indeed.com') && !isAuthPage) {
              loggedIn = true;
              logger.info(`[Indeed/Browser] Login complete — resuming q=${qi + 1} p=${p + 1}`);
              break;
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
        const pageJobs   = rawPageJobs.slice(0, JOB_PER_PAGE_CAP);

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

        logger.info(`[Indeed/Browser] q="${q}" p=${p + 1}: ${pageJobs.length} jobs (${htmlKB}KB${hasNextPage === false ? ', last page' : ''})`);
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

        for (let i = 0; i < pageJobs.length; i++) {
          const job = pageJobs[i];
          const dk = job.jobkey || job.url || jobTitleCompanyKey(job);
          if (seenKeys.has(dk)) continue;
          seenKeys.add(dk);
          allJobs.push(job);
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
        const jobUrl = job.url || (job.jobkey ? `https://www.indeed.com/viewjob?jk=${job.jobkey}` : null);
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

    return { items, warning, gathered: inWindow.length };

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
