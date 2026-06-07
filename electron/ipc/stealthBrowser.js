/**
 * Stealth Browser Manager — singleton puppeteer-extra browser with stealth plugin.
 *
 * 2026 Hardening (per deep research audit):
 *   - Full Client Hints via setUserAgent() native object (not setExtraHTTPHeaders)
 *   - Screen API coherence (window.screen matches viewport)
 *   - Cooperative Intercept Mode (priority 0) to avoid TTFB anomalies
 *   - Never block CSS/fonts/scripts (Cloudflare Sequence ML detection)
 *   - Bézier mouse movement + momentum scrolling
 *   - Single coherent fingerprint per session (no rotation)
 *
 * Uses puppeteer-core (no bundled Chromium) pointing at system Chrome for native JA4 TLS.
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import electronPkg from 'electron';
const { app } = electronPkg;
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../logger.js';

import { getRandomUA, getSessionProfile } from './browser/antiDetectProfiles.js';
import { saveDiceApiKey } from './settings.js';
import { isProfileLockCollision, recordLaunchCollision } from './browserLaunchTelemetry.js';

// Apply stealth evasions
puppeteer.use(StealthPlugin());

// ── Tracker-URL patterns for the image request filter ───────────────────────
// Only tracking pixels / beacons are allowed through; all other images are
// blocked to reduce bandwidth during scraping. Defined at module level so the
// array is not reallocated on every page creation.
const IMAGE_TRACKER_PATTERNS = ['pixel', 'tracker', 'beacon', '1x1'];

// ── Persistent Session Directory ────────────────────────────────────────────
let _userDataDir = null;
export async function getUserDataDir() {
  if (_userDataDir) return _userDataDir;
  const base = app?.getPath?.('userData') || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.infinite-canvas');
  const dir = path.join(base, 'browser-data');
  try {
    await fs.promises.access(dir);
  } catch {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  _userDataDir = dir;
  return _userDataDir;
}


// ── Chrome Executable Discovery ─────────────────────────────────────────────
// Preference order:
//   1. CHROME_PATH env var (explicit override).
//   2. Playwright's bundled Chromium under ~/Library/Caches/ms-playwright/...
//      Lives outside /Applications/, so macOS Sequoia's App Management gate
//      does NOT prompt the user with "infinite-canvas was prevented from
//      modifying apps on your Mac" on first launch. This is the path that
//      avoids the prompt entirely.
//   3. System Chrome/Chromium/Brave in /Applications/ — works but triggers
//      the App Management prompt once per app install on Sequoia (15+).
//
// Returning the first existing path means a user who has installed Playwright
// browsers (already a dep, just needs `npx playwright install chromium` once)
// gets prompt-free scraping. Without it we still work, just with the one-time
// macOS approval.

async function findPlaywrightChromiumPath() {
  try {
    const pw = await import('playwright');
    const p = pw?.chromium?.executablePath?.();
    if (!p) return null;
    await fs.promises.access(p);
    return p;
  } catch {
    return null;
  }
}

export async function findSystemChromePath() {
  const platform = process.platform;
  const candidates = platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ]
    : platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
        ];

  for (const p of candidates) {
    try {
      await fs.promises.access(p);
      return p;
    } catch {
      // Ignored
    }
  }
  return null;
}

export async function findChromePath() {
  const playwrightPath = await findPlaywrightChromiumPath();
  if (playwrightPath) return playwrightPath;

  const systemChromePath = await findSystemChromePath();
  if (systemChromePath) return systemChromePath;

  // Electron's own executable can't be used as a puppeteer-core target (it
  // spawns a renderer, not a standalone browser). Either install Playwright's
  // chromium (`npx playwright install chromium`) — recommended, avoids the
  // macOS App Management prompt — or install Google Chrome.
  throw new Error(
    'No Chrome/Chromium installation found. Run `npx playwright install chromium` (no permission prompts) or install Google Chrome.'
  );
}

// ── Singleton Browser Instance ──────────────────────────────────────────────
let browserInstance = null;
let browserLaunchPromise = null;
let isShuttingDown = false;
// Monotonic generation, bumped on every successful launch (so a relaunch after
// crash / clearBrowserSession / shutdown is a NEW generation). Lets callers tell
// whether two operations ran on the SAME browser process — the discriminator for
// "is a limit browser/session-based (resets on relaunch) or IP-based?".
let browserGeneration = 0;
let browserLaunchedAt = 0;

// Identity of the current stealth-browser process. generation increments each
// launch; launchedAt is the epoch ms of that launch (0 if never launched).
export function getStealthBrowserInfo() {
  return {
    generation: browserGeneration,
    launchedAt: browserLaunchedAt,
    connected: !!browserInstance?.isConnected?.(),
  };
}

// Retry a puppeteer.launch() that fails with a shared-profile lock collision.
// The ONE shared userDataDir is OS-locked to a single Chrome process; a VISIBLE
// captcha-resolve window (held open for its grace/solve period) or a sibling
// scrape can still own it for a few seconds when the next launch fires. The OS
// releases the lock only after the holding Chrome fully exits, which lags a
// window/scrape close. Rather than bubble up the cryptic "browser is already
// running" / "Opening in existing browser session" error (the user saw this as a
// source falsely "task-failed", needing a manual re-Solve), we wait through that
// lag and retry. A NON-collision launch error throws on the first attempt — we
// never mask a real failure (missing Chrome, permission denial, crash). Every
// collision is recorded in browserLaunchTelemetry so the bug report can surface
// it long after the log ring buffer scrolls away. See sharedProfileLock.js for
// the complementary serialization of the job-scrape launchers.
const PROFILE_LOCK_RETRY_DELAYS = [700, 1200, 2000, 3000, 4500]; // ms; ~11.4s total

export async function launchWithProfileLockRetry(launchOpts, context, url = null) {
  let lastErr;
  for (let attempt = 0; attempt <= PROFILE_LOCK_RETRY_DELAYS.length; attempt++) {
    try {
      const browser = await puppeteer.launch(launchOpts);
      if (attempt > 0) {
        recordLaunchCollision({ context, url, attempts: attempt + 1, recovered: true, error: lastErr, ts: Date.now() });
        logger.info(`[StealthBrowser] ${context} launch recovered after ${attempt} retry(ies) — shared profile freed`);
      }
      return browser;
    } catch (err) {
      lastErr = err;
      if (!isProfileLockCollision(err)) throw err;
      if (attempt < PROFILE_LOCK_RETRY_DELAYS.length) {
        const delay = PROFILE_LOCK_RETRY_DELAYS[attempt];
        logger.warn(`[StealthBrowser] ${context} launch hit the shared-profile lock (another Chrome window/scrape holds it) — retrying in ${delay}ms (attempt ${attempt + 1}/${PROFILE_LOCK_RETRY_DELAYS.length + 1})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      // Retries exhausted: record + throw a message that names the real cause
      // (the bare puppeteer "Code: 0" is undebuggable).
      recordLaunchCollision({ context, url, attempts: attempt + 1, recovered: false, error: err, ts: Date.now() });
      throw new Error(`Chrome launch blocked by the shared browser profile lock after ${attempt + 1} attempts — another window or scrape is holding it. Close any open captcha/login window and retry. (${err?.message || String(err)})`);
    }
  }
  throw lastErr; // unreachable — loop either returns or throws
}

export async function getStealthBrowser() {
  if (isShuttingDown) throw new Error('[StealthBrowser] Cannot get browser during shutdown');
  if (browserInstance?.isConnected?.()) return browserInstance;

  // Clear a dead/crashed instance. Killing the orphaned Chrome process releases
  // the userDataDir lock — without this, the next puppeteer.launch() fails with
  // "The browser is already running for [userDataDir]."
  if (browserInstance) {
    logger.warn('[StealthBrowser] Browser connection lost (crashed?) — killing orphaned process before relaunch');
    try { browserInstance.process()?.kill('SIGTERM'); } catch { /* already dead */ }
    browserInstance = null;
    // Give the OS a moment to release the profile lock.
    await new Promise(r => setTimeout(r, 500));
  }

  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = (async () => {
    const executablePath = process.env.CHROME_PATH || await findChromePath();
    // Include whether this is the prompt-free Playwright path so the log line
    // is enough to diagnose "why am I getting the macOS App Management prompt?"
    const usingPlaywright = executablePath.includes('/ms-playwright/');
    logger.info(
      `[StealthBrowser] Launching with: ${path.basename(executablePath)} ` +
      `(${usingPlaywright ? 'Playwright bundle, no Sequoia prompt' : 'system Chrome — first launch may prompt'})`
    );

    try {
      browserInstance = await launchWithProfileLockRetry({
        headless: 'new',
        executablePath,
        userDataDir: await getUserDataDir(),
        // Strip --enable-automation (Puppeteer adds it by default) — same as
        // the captcha-resolve visible browser. Combined with
        // --disable-blink-features=AutomationControlled below, this removes
        // two of the most-checked automation signals.
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--window-size=1920,1080',
          '--disable-dev-shm-usage',
          '--lang=en-US,en',
        ],
        defaultViewport: {
          width: 1920,
          height: 1080,
          deviceScaleFactor: 1,
        },
        ignoreHTTPSErrors: true,
      }, 'headless-scrape');

      browserGeneration += 1;
      browserLaunchedAt = Date.now();
      logger.info(`[StealthBrowser] Browser launched successfully (generation #${browserGeneration})`);
      return browserInstance;
    } finally {
      // Always release the mutex so the next call can retry on failure.
      browserLaunchPromise = null;
    }
  })();

  return browserLaunchPromise;
}

export async function createStealthPage() {
  const browser = await getStealthBrowser();
  const page = await browser.newPage();
  const profile = getSessionProfile();

  await page.setUserAgent(profile.ua, profile.clientHints);

  await page.setViewport({
    ...profile.viewport,
    deviceScaleFactor: 2,
  });

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });

  const vp = profile.viewport;
  await page.evaluateOnNewDocument((p, vpW, vpH) => {
    Object.defineProperty(navigator, 'platform', { get: () => p === 'macOS' ? 'MacIntel' : 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    Object.defineProperty(window.screen, 'width', { get: () => vpW });
    Object.defineProperty(window.screen, 'height', { get: () => vpH });
    Object.defineProperty(window.screen, 'availWidth', { get: () => vpW });
    Object.defineProperty(window.screen, 'availHeight', { get: () => vpH - 25 });
    Object.defineProperty(window.screen, 'colorDepth', { get: () => 30 });
    Object.defineProperty(window.screen, 'pixelDepth', { get: () => 30 });

    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
      Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 });
      Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
    }
  }, profile.platform, vp.width, vp.height);

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled?.()) return;

    const type = req.resourceType();

    if (type === 'media') {
      req.abort('aborted', 0);
    } else if (type === 'image') {
      // Allow tracking pixels/beacons (blocking them can change server-side behaviour);
      // block all other images to cut bandwidth while scraping text content.
      const url = req.url();
      const isTracker = url.endsWith('.gif') || IMAGE_TRACKER_PATTERNS.some(p => url.includes(p));
      if (isTracker) {
        req.continue({}, 0);
      } else {
        req.abort('aborted', 0);
      }
    } else {
      req.continue({}, 0);
    }
  });

  return page;
}

/**
 * Fetch a page's fully-rendered HTML through the persistent stealth browser.
 * Because the browser uses `userDataDir`, cookies from a prior `openLoginWindow`
 * are reused — this is how authenticated dashboards / notification feeds work
 * without re-prompting for login.
 *
 * Returns the same shape as a plain fetch so the check engine can swap
 * fetchers transparently: { ok, status, finalUrl, html } on success,
 * { ok: false, error } on failure.
 */
export async function fetchHtmlAuthed(url, { timeoutMs = 25000, signal } = {}) {
  let page = null;
  try {
    page = await createStealthPage();
    if (signal?.aborted) throw new Error('Aborted');
    page.setDefaultNavigationTimeout(timeoutMs - 2000);

    let response = null;
    try {
      response = await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs - 5000 });
    } catch (e) {
      // Tolerate the network-idle timeout — many marketplace dashboards keep
      // background polls open. As long as the document loaded we can still
      // read it.
      if (!/timeout|ERR_ABORTED|net::ERR_/i.test(e?.message || '')) throw e;
    }
    if (signal?.aborted) throw new Error('Aborted');

    const status   = response?.status() ?? 0;
    const finalUrl = page.url() || url;
    // Bound page.content(). When an anti-bot challenge (e.g. Cloudflare) keeps the
    // page in a reload loop, content() blocks indefinitely waiting for a stable
    // execution context — sailing past the navigation timeout above. Without this
    // race a wedged page hangs the caller forever; this is what stalled the startup
    // login verify on Glassdoor (the whole "checking connections" step never
    // returned). On timeout we fall through to the catch → { ok:false } and the
    // finally still closes the page.
    const html     = await Promise.race([
      page.content(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('page.content() timed out — page may be stuck in an anti-bot reload loop')),
        Math.max(3000, Math.min(8000, timeoutMs - 2000)))),
    ]);
    return { ok: true, status, finalUrl, html };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Like fetchHtmlAuthed, but skips the aggressive image/media request
 * interception that createStealthPage installs. Used by verifySellMonitorLogin
 * specifically — eBay's anti-bot returns a CAPTCHA / login wall when image
 * requests are systematically aborted, which made every verify attempt
 * spuriously return "not logged in" even for fully-authenticated sessions.
 * The scraper path keeps the blocking because it saves real bandwidth at
 * scale; one-off verify calls don't need it.
 */
export async function fetchHtmlClean(url, { timeoutMs = 25000, signal } = {}) {
  let page = null;
  try {
    const browser = await getStealthBrowser();
    page = await browser.newPage();
    // Match createStealthPage's headers so cookies + UA are consistent; just
    // skip request interception entirely.
    const profile = getSessionProfile();
    await page.setUserAgent(profile.ua, profile.clientHints);
    await page.setViewport({ ...profile.viewport, deviceScaleFactor: 2 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    if (signal?.aborted) throw new Error('Aborted');
    page.setDefaultNavigationTimeout(timeoutMs - 2000);

    let response = null;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs - 5000 });
    } catch (e) {
      if (!/timeout|ERR_ABORTED|net::ERR_/i.test(e?.message || '')) throw e;
    }
    if (signal?.aborted) throw new Error('Aborted');

    const status   = response?.status() ?? 0;
    const finalUrl = page.url() || url;
    // Bound page.content(). When an anti-bot challenge (e.g. Cloudflare) keeps the
    // page in a reload loop, content() blocks indefinitely waiting for a stable
    // execution context — sailing past the navigation timeout above. Without this
    // race a wedged page hangs the caller forever; this is what stalled the startup
    // login verify on Glassdoor (the whole "checking connections" step never
    // returned). On timeout we fall through to the catch → { ok:false } and the
    // finally still closes the page.
    const html     = await Promise.race([
      page.content(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('page.content() timed out — page may be stuck in an anti-bot reload loop')),
        Math.max(3000, Math.min(8000, timeoutMs - 2000)))),
    ]);
    return { ok: true, status, finalUrl, html };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

export async function closeStealthBrowser(forShutdown = false) {
  if (forShutdown) {
    isShuttingDown = true;
  }
  browserLaunchPromise = null; // Prevent anyone from waiting on a pending launch
  if (browserInstance) {
    const proc = browserInstance.process();
    try {
      await browserInstance.close();
    } catch { /* already closed */ }
    browserInstance = null;
    // Wait for the Chrome process to fully exit and release the userDataDir
    // lock. Browser.close() only sends the exit signal — the process takes
    // a moment to die. Without this wait, the next puppeteer.launch() on the
    // same profile races the dying process and Chrome falls back to a temp
    // empty profile, causing page.goto() to silently land on about:blank.
    if (proc && !proc.killed) {
      await new Promise(resolve => {
        const done = () => resolve();
        proc.once('exit', done);
        setTimeout(() => { proc.removeListener('exit', done); resolve(); }, 2000);
      });
    }
  }
}

export async function clearBrowserSession() {
  await closeStealthBrowser(false);
  const dir = await getUserDataDir();
  await fs.promises.rm(dir, { recursive: true, force: true });
  _userDataDir = null; // reset cache so next launch recreates the dir
}

// Forward exports from extracted modules for backwards compatibility with other files
export { humanMouseMove, humanScroll, dismissCookieBanner } from './browser/humanEmulation.js';
export { openLoginWindow, getSessionStatus, getAllSessionStatuses, getSupportedPlatforms } from './browser/authWindows.js';
export { getRandomUA };

// ── Job Platform Login Registry ──────────────────────────────────────────────
// Platforms that require browser login to serve multi-page results.
// verifyUrl: a logged-in-only page that redirects to /login when anonymous.
const JOB_LOGIN_PLATFORMS = {
  // LinkedIn — session required for browser-based description enrichment.
  // Logged-in users stay on /feed; anonymous users redirect to /authwall or /login.
  // Uses the li_at session cookie (NATIVE_LOGIN_COOKIE_NAMES) as the primary
  // post-login signal; the feed URL check is the startup-verify fallback.
  linkedin: {
    name: 'LinkedIn',
    verifyUrl: 'https://www.linkedin.com/feed',
    connectedFinalUrlMustContain: 'linkedin.com/feed',
  },
  // Google for Jobs — login is optional (scraper works without it) but a session
  // reduces bot-detection risk and may improve result quality.
  google: {
    name: 'Google for Jobs',
    verifyUrl: 'https://myaccount.google.com/',
    // Logged-in users stay on myaccount.google.com; not-logged-in users are
    // redirected to accounts.google.com/signin/... so the hostname check is sufficient.
    connectedFinalUrlMustContain: 'myaccount.google.com',
  },
  indeed:       {
    name: 'Indeed',
    verifyUrls: [
      'https://secure.indeed.com/settings/account',
    ],
    bodySignals: [
      'upload your resume sign in',
      'sign in employers / post job',
      'sign in to indeed',
    ],
    bodyScanChars: 1200,
  },
  // Glassdoor changed URL structure: logged-in users who hit /member/home/
  // now redirect to /Job/index.htm (same as anonymous), so the old
  // connectedFinalUrlMustContain: '/member/' check was firing for valid
  // sessions. Anonymous users on /Job/index.htm are caught by body signals
  // (login CTAs that don't appear once logged in).
  // verifyTimeoutMs: Glassdoor's member page is frequently Cloudflare-challenged for
  // the headless verify (a successful verify lands in ~1.5–3.7s; a challenged one
  // otherwise burns the full 25s budget before degrading to "not connected", which
  // dominates the whole startup "checking connections" wall). A 12s cap can't cut
  // off a real success but bounds the blocked case to ~13s.
  glassdoor:    { name: 'Glassdoor',    verifyUrl: 'https://www.glassdoor.com/member/home/index.htm',  verifyTimeoutMs: 12000, bodySignals: ['sign in to glassdoor', 'create a free glassdoor account', 'join glassdoor for free', 'log in to glassdoor'] },
  // /jobseeker/home is the post-login landing page — authenticated sessions stay
  // there; anonymous requests redirect to /user/login (connectedFinalUrlMustContain
  // catches the redirect). Avoids /profile which Cloudflare challenges on new
  // browser sessions (HTTP 403, not a real auth failure) and caused false
  // "not logged in" verdicts on every app restart after cf_clearance expired.
  ziprecruiter: { name: 'ZipRecruiter', verifyUrl: 'https://www.ziprecruiter.com/jobseeker/home', connectedFinalUrlMustContain: 'ziprecruiter.com/jobseeker', bodySignals: ['log in to ziprecruiter', 'sign in to ziprecruiter'] },
};

export function getJobLoginPlatforms() {
  return Object.entries(JOB_LOGIN_PLATFORMS).map(([id, cfg]) => ({ id, ...cfg }));
}

export function getJobLoginConfig(platformId) {
  return JOB_LOGIN_PLATFORMS[platformId] || null;
}

// ── Dice API Key Auto-Refresh ─────────────────────────────────────────────────
// Dice's public search API requires an x-api-key that is embedded in their
// frontend JS and rotates periodically. When fetchDiceListings detects a 500,
// it calls refreshDiceApiKey() which:
//   1. Launches a throwaway headless browser (separate userDataDir — no conflict
//      with the main stealth browser or the visible manual-scraper browser)
//   2. Navigates dice.com/jobs, which triggers the React app to call dhigroupinc.com
//   3. Intercepts the outgoing XHR and reads the x-api-key header
//   4. Saves the fresh key to persistent settings
//   5. Returns the key so fetchDiceListings can retry immediately
//
// The singleton promise prevents concurrent 500s from launching multiple browsers.

let _diceRefreshInFlight = null;
// Matches the Dice API key in two forms:
//   Legacy (Pages Router): "x-api-key":"<key>"
//   App Router / NEXT_PUBLIC env: NEXT_PUBLIC_JOB_SEARCH_API_KEY:"<key>"
const DICE_API_KEY_RE = /(?:['"]x-api-key['"]\s*[,:{]\s*['"]|NEXT_PUBLIC_JOB_SEARCH_API_KEY['":\s,{]+)([A-Za-z0-9]{25,80})/i;

export async function refreshDiceApiKey() {
  if (_diceRefreshInFlight) return _diceRefreshInFlight;

  _diceRefreshInFlight = (async () => {
    logger.info('[Dice API] HTTP 500 detected — attempting key extraction');
    try {
      // Primary: extract key from dice.com JS bundle via plain HTTP fetch.
      // No browser launched, no Sift fingerprinting — avoids the
      // fresh-userDataDir / no-cookies signal that blocked the XHR approach.
      const bundleKey = await _fetchDiceKeyFromBundle();
      if (bundleKey) return bundleKey;

      // Fallback: browser to intercept the search XHR header, in case Dice
      // moves the key to a runtime config not embedded in the JS bundle.
      return await _browserRefreshDiceApiKey();
    } finally {
      _diceRefreshInFlight = null;
    }
  })();

  return _diceRefreshInFlight;
}

async function _fetchDiceKeyFromBundle() {
  const ua = getRandomUA();
  const baseHeaders = { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9' };

  let html;
  try {
    const pageRes = await fetch(
      'https://www.dice.com/jobs?q=software+engineer&countryCode2=US&radius=30&radiusUnit=mi&page=1&pageSize=20&language=en',
      {
        headers: { ...baseHeaders, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Referer': 'https://www.google.com/' },
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!pageRes.ok) {
      logger.warn(`[Dice API] Bundle fetch: page load returned ${pageRes.status}`);
      return null;
    }
    html = await pageRes.text();
  } catch (err) {
    logger.warn(`[Dice API] Bundle fetch: page fetch threw: ${err.message}`);
    return null;
  }

  // First scan the HTML itself. Dice now ships large Next.js hydration blobs
  // inline; if the key ever moves there we can avoid the extra bundle fetches.
  const inlineMatch = html.match(DICE_API_KEY_RE);
  if (inlineMatch?.[1]) {
    saveDiceApiKey(inlineMatch[1]);
    logger.info('[Dice API] API key extracted from page HTML');
    return inlineMatch[1];
  }

  // Extract Next.js JS bundle URLs — prioritise config/api/app/main chunks first
  const allBundleUrls = [...html.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g)]
    .map(m => m[1].startsWith('http') ? m[1] : `https://www.dice.com${m[1]}`)
    .filter(u => u.includes('_next') || u.includes('/static/'));
  const bundleUrls = [...allBundleUrls].sort((a, b) => {
    const hi = s => /config|api|app|main|index/i.test(s) ? 0 : 1;
    return hi(a) - hi(b);
  }).slice(0, 35);

  logger.info(`[Dice API] Searching ${bundleUrls.length} JS bundles for API key (parallel)`);

  // Fetch in parallel batches of 5 to avoid the 20×10s=200s sequential worst case
  for (let i = 0; i < bundleUrls.length; i += 5) {
    const batch = bundleUrls.slice(i, i + 5);
    const keys = await Promise.all(batch.map(async bundleUrl => {
      try {
        const r = await fetch(bundleUrl, {
          headers: { ...baseHeaders, 'Accept': '*/*', 'Referer': 'https://www.dice.com/' },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return null;
        const code = await r.text();
        const m = code.match(DICE_API_KEY_RE);
        return m ? m[1] : null;
      } catch { return null; }
    }));
    const found = keys.find(k => k);
    if (found) {
      saveDiceApiKey(found);
      logger.info('[Dice API] API key extracted from JS bundle');
      return found;
    }
  }

  logger.warn('[Dice API] API key not found in JS bundles — falling back to browser');
  return null;
}

async function _browserRefreshDiceApiKey() {
  const tmpDir = path.join(os.tmpdir(), `ic-dice-refresh-${Date.now()}`);
  let browser;
  try {
    const executablePath = process.env.CHROME_PATH || await findChromePath();

    logger.info('[Dice API] Launching key-refresh browser (bundle fetch yielded nothing)');

    browser = await puppeteer.launch({
      headless: false,
      executablePath,
      userDataDir: tmpDir,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        // Match JS-patched outerWidth/outerHeight so the fingerprint is coherent.
        '--window-size=1280,900',
      ],
      defaultViewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    const profile = getSessionProfile();
    await page.setUserAgent(profile.ua, profile.clientHints);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window,    'outerWidth',          { get: () => 1280 });
      Object.defineProperty(window,    'outerHeight',         { get: () => 900  });
      Object.defineProperty(window,    'screenX',             { get: () => 0    });
      Object.defineProperty(window,    'screenY',             { get: () => 0    });
      Object.defineProperty(navigator, 'platform',            { get: () => 'MacIntel' });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
      Object.defineProperty(navigator, 'maxTouchPoints',      { get: () => 0 });
      Object.defineProperty(navigator, 'webdriver',           { get: () => false });
    });

    let settled = false;
    let resolveKey;
    const resolveIfKey = (value) => {
      if (!settled && value) {
        settled = true;
        resolveKey(value);
      }
    };
    const keyPromise = new Promise(resolve => { resolveKey = resolve; });

    const seenDomains = new Set();
    page.on('request', req => {
      try {
        const url = new URL(req.url());
        if (url.hostname !== 'www.dice.com') seenDomains.add(url.hostname);
        const key = req.headers()['x-api-key'];
        if (key) resolveIfKey(key);
      } catch { /* malformed URL — ignore */ }
    });
    page.on('response', async (res) => {
      try {
        const url = res.url();
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        if (!/javascript|json|html/.test(ct) && !/\.js(\?|$)/i.test(url)) return;
        const text = await res.text();
        const match = text.match(DICE_API_KEY_RE);
        if (match?.[1]) resolveIfKey(match[1]);
      } catch {
        // Best-effort only; some responses are binary/streamed and unreadable.
      }
    });

    await page.goto(
      'https://www.dice.com/jobs?q=software+engineer&countryCode2=US&radius=30&radiusUnit=mi&page=1&pageSize=20&language=en',
      { waitUntil: 'domcontentloaded', timeout: 15000 },
    ).catch(() => {});

    // Best-effort consent accept. Dice's CMP is rendered in a shadow root, so
    // the button is not reachable via a plain document querySelector.
    await page.evaluate(() => {
      const host = document.querySelector('#cmpwrapper');
      const root = host?.shadowRoot;
      const btn =
        root?.querySelector('#cmpwelcomebtnyes a, #cmpwelcomebtnyes [role="button"], .cmpboxbtnyes') ||
        null;
      btn?.click?.();
    }).catch(() => {});

    // If Dice inlines everything server-side, there may be no client XHR at
    // all. Scan the final HTML once too so the browser fallback can still win.
    try {
      const html = await page.content();
      const match = html.match(DICE_API_KEY_RE);
      if (match?.[1]) resolveIfKey(match[1]);
    } catch {
      // Best-effort only.
    }

    const newKey = await Promise.race([
      keyPromise,
      new Promise(r => setTimeout(() => r(null), 20000)),
    ]);

    if (newKey) {
      saveDiceApiKey(newKey);
      logger.info('[Dice API] API key captured via browser XHR interception');
    } else {
      const domains = seenDomains.size > 0 ? [...seenDomains].join(', ') : '(none)';
      logger.warn(`[Dice API] Key refresh failed — no x-api-key header seen in 20s. External domains: ${domains}`);
    }

    return newKey;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
}

// ── Sell Monitor Platform Registry ──────────────────────────────────────────
// Centralized config for platforms that require login for sell monitoring.
// Previously duplicated in marketplace.js — now single source of truth.

// sellerUrl: the page used to monitor active listings (seller-only access)
// verifyUrl: the page used by verifySellMonitorLogin to confirm a login
//   completed. Distinct because seller pages often redirect non-seller
//   accounts to onboarding flows (eBay /sh/lst/active → /sh/landing or
//   even /signin if the redirect chain passes through signin.ebay.com),
//   producing a false "not logged in" verdict for users who genuinely
//   completed login but don't have a seller subscription. The verify URL
//   is a universal account/profile page that any logged-in user can reach.
const SELL_MONITOR_PLATFORMS = {
  ebay:      {
    name: 'eBay',
    sellerUrl: 'https://www.ebay.com/sh/lst/active',
    verifyUrl: 'https://www.ebay.com/mye/myebay/summary',
    connectedFinalUrlMustContain: 'ebay.com/mye/myebay/summary',
  },
  poshmark:  {
    name: 'Poshmark',
    sellerUrl: 'https://poshmark.com/closet',
    verifyUrl: 'https://poshmark.com/feed',
    connectedFinalUrlMustContain: 'poshmark.com/feed',
    bodySignals: [
      'log in to poshmark',
      'login - poshmark',
      'sign up to buy and sell',
    ],
    bodyScanChars: 1200,
  },
  mercari:   {
    name: 'Mercari',
    sellerUrl: 'https://www.mercari.com/mypage/listings/',
    verifyUrl: 'https://www.mercari.com/mypage/listings/',
    connectedFinalUrlMustContain: 'mercari.com/mypage',
    bodySignals: [
      'log in to mercari',
      'sign up for mercari',
      'email address password log in',
    ],
    bodyScanChars: 2000,
  },
  swappa:    {
    name: 'Swappa',
    sellerUrl: 'https://swappa.com/user/listings',
    verifyUrl: 'https://swappa.com/my/swappa',
    connectedFinalUrlMustContain: 'swappa.com/my/swappa',
    bodySignals: [
      'log in to swappa',
      'login to swappa',
      'sign in to swappa',
    ],
    bodyScanChars: 1200,
  },
  facebook:  {
    name: 'Facebook',
    sellerUrl: 'https://www.facebook.com/marketplace/you/selling',
    verifyUrl: 'https://www.facebook.com/me',
    bodySignals: [
      'log into facebook',
      'email or mobile number password',
      'forgot password? create new account',
    ],
    bodyScanChars: 1200,
  },
  reverb:    {
    name: 'Reverb',
    sellerUrl: 'https://reverb.com/my/selling/listings',
    verifyUrl: 'https://reverb.com/my/selling/listings',
    connectedFinalUrlMustContain: 'reverb.com/my/selling/listings',
    bodySignals: [
      'log in to reverb',
      'sign in to reverb',
    ],
    bodyScanChars: 1200,
  },
};

/**
 * Get list of platforms that require login for sell monitoring.
 */
export function getSellMonitorPlatforms() {
  return Object.entries(SELL_MONITOR_PLATFORMS).map(([id, config]) => ({
    id,
    name: config.name,
    sellerUrl: config.sellerUrl,
    verifyUrl: config.verifyUrl || config.sellerUrl,
  }));
}

/**
 * Get sell monitor config for a specific platform.
 */
export function getSellMonitorConfig(platformId) {
  return SELL_MONITOR_PLATFORMS[platformId] || null;
}
