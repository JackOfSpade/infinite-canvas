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
import electronPkg from 'electron';
import { logger } from '../logger.js';
import { findChromePath, findSystemChromePath, getUserDataDir } from '../ipc/stealthBrowser.js';
import { extractIndeedJobsFromHtml } from './apiExtractors.js';
import { JOB_MAX_PAGES, JOB_RESULT_CAP, JOB_PER_PAGE_CAP } from '../ipc/resultCaps.js';
import { filterJobsByAge } from '../ipc/jobDateFilter.js';
import { buildOverlayScript, updateOverlay } from '../ipc/browser/scraperOverlay.js';

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
async function enrichWithDescriptions(page, pageJobs, signal) {
  await page.waitForSelector(CARD_SELECTOR, { timeout: 5000 }).catch(() => {});
  const cardCount = await page.evaluate(
    (sel) => document.querySelectorAll(sel).length, CARD_SELECTOR
  ).catch(() => 0);
  if (!cardCount) return;

  const keyToJob = new Map();
  for (const job of pageJobs) { if (job.jobkey) keyToJob.set(job.jobkey, job); }

  const limit = Math.min(cardCount, pageJobs.length);
  let enriched = 0;

  for (let i = 0; i < limit; i++) {
    if (signal?.aborted) break;

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
      logger.warn('[Indeed/Browser] Card click navigated away — recovering');
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
      if (job) { job.description = description; enriched++; }
    }

    if (i < limit - 1) await new Promise(r => setTimeout(r, 800 + Math.round(Math.random() * 600)));
  }

  if (enriched > 0) logger.info(`[Indeed/Browser] Enriched ${enriched}/${limit} jobs with full descriptions`);
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
export async function fetchIndeedListingsBrowser(queries, signal = null, maxAgeDays = null, profileDir = null, onProgress = null) {
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

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      executablePath,
      userDataDir,
      ignoreDefaultArgs: ['--enable-automation'],
      args: LAUNCH_ARGS,
      defaultViewport: { width: 1400, height: 900 },
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
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

    const allJobs = [];
    const seenKeys = new Set();
    let totalChallenges = 0;
    let loginWallHit = false;

    outer:
    for (let qi = 0; qi < queryList.length; qi++) {
      const q = queryList[qi];
      if (signal?.aborted) break;

      for (let p = 0; p < maxPages; p++) {
        if (signal?.aborted) break outer;
        if (allJobs.length >= resultCap) break outer;

        const start = p * 10;
        const url   = `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&fromage=${days}${start > 0 ? `&start=${start}` : ''}`;

        const overlayBase = {
          srcName:  'Indeed',
          srcLabel: `Query ${qi + 1} of ${queryList.length}`,
          qLabel:   'Searching',
          qText:    q,
        };

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
        await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: `Loading page ${p + 1}…` });
        await new Promise(r => setTimeout(r, 2000 + Math.round(Math.random() * 1000)));
        if (signal?.aborted) break outer;

        const signals = await getChallengeSignals(page);
        if (signals.isChallenge) {
          totalChallenges++;
          const rayId = await page.evaluate(() => {
            const m = (document.body?.innerHTML || '').match(/Ray ID[^:]*:\s*([0-9a-f]+)/i);
            return m ? m[1] : null;
          }).catch(() => null);
          logger.warn(`[Indeed/Browser] Challenge (${signals.reason}) q="${q}" p=${p + 1}${rayId ? ` Ray=${rayId}` : ''}`);
          await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: `⚠️ ${signals.reason}`, challenge: true });
          if (signals.reason === 'indeed-login-wall') { loginWallHit = true; break outer; }
          break;
        }

        const html       = await page.content();
        const htmlKB     = Math.round(html.length / 1024);
        const rawPageJobs = extractIndeedJobsFromHtml(html);
        const pageJobs   = rawPageJobs.slice(0, JOB_PER_PAGE_CAP);

        // Soft block: Indeed returns a tiny near-empty page instead of a hard challenge.
        // Normal search pages are ~1500KB; anything under 150KB with 0 jobs is suspect.
        if (html.length < 150_000 && rawPageJobs.length === 0) {
          logger.warn(`[Indeed/Browser] Soft block suspected — ${htmlKB}KB, 0 jobs q="${q}" p=${p + 1}`);
          break;
        }

        // Check for a next-page link as a more reliable last-page signal than result count.
        const hasNextPage = await page.evaluate(() =>
          !!(document.querySelector('[aria-label="Next Page"], [data-testid="pagination-page-next"]') ||
             document.querySelector('a[href*="&start="]'))
        ).catch(() => null);

        logger.info(`[Indeed/Browser] q="${q}" p=${p + 1}: ${pageJobs.length} jobs (${htmlKB}KB${hasNextPage === false ? ', last page' : ''})`);
        onProgress?.(`q${qi + 1}/${queryList.length} · p${p + 1}`);

        if (rawPageJobs.length === 0) break;

        // Click each card on this page to load full descriptions from the right panel.
        await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: `Enriching ${pageJobs.length} jobs…` });
        await enrichWithDescriptions(page, pageJobs, signal).catch(e => {
          logger.warn(`[Indeed/Browser] Description enrichment failed p=${p + 1}: ${e.message}`);
        });
        if (signal?.aborted) break outer;

        for (const job of pageJobs) {
          const dk = job.jobkey || job.url || `${(job.title || '').toLowerCase()}|${(job.company || '').toLowerCase()}`;
          if (seenKeys.has(dk)) continue;
          seenKeys.add(dk);
          allJobs.push(job);
          if (allJobs.length >= resultCap) break;
        }
        await updateOverlay(page, { count: allJobs.length, status: `Page ${p + 1} done` });

        if (rawPageJobs.length < 10 || hasNextPage === false) break;

        if (p < maxPages - 1) {
          const delay = PAGE_DELAY_MS[0] + Math.round(Math.random() * (PAGE_DELAY_MS[1] - PAGE_DELAY_MS[0]));
          await new Promise(r => setTimeout(r, delay));
        }
      }

      if (qi < queryList.length - 1 && !signal?.aborted) {
        const delay = QUERY_DELAY_MS[0] + Math.round(Math.random() * (QUERY_DELAY_MS[1] - QUERY_DELAY_MS[0]));
        await new Promise(r => setTimeout(r, delay));
      }
    }

    logger.info(`[Indeed/Browser] ${allJobs.length} unique jobs, ${totalChallenges} challenges, ${queryList.length} queries`);

    const inWindow = maxAgeDays ? filterJobsByAge(allJobs, maxAgeDays) : allJobs;
    const items    = inWindow.slice(0, resultCap);

    let warning = null;
    if (loginWallHit) {
      warning = {
        code: 'needs-login',
        severity: 'block',
        evidence: 'Indeed session expired — login wall hit during pagination.',
        suggestion: 'Open Settings → Job Sources → Connect Indeed to refresh your login.',
      };
    } else if (totalChallenges > 0 && items.length === 0) {
      warning = {
        code: 'scrape-failed',
        severity: 'block',
        evidence: `${totalChallenges} Cloudflare challenge(s) — no jobs extracted.`,
        suggestion: 'Try again in a few minutes.',
      };
    } else if (totalChallenges > 0) {
      warning = {
        code: 'scrape-partial',
        severity: 'warn',
        evidence: `${totalChallenges} Cloudflare challenge(s) — some queries may be incomplete.`,
        suggestion: null,
      };
    }

    return { items, warning, gathered: inWindow.length };

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
