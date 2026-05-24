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

import { getSessionProfile } from './browser/antiDetectProfiles.js';
import { saveDiceApiKey } from './settings.js';

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

export async function findChromePath() {
  const playwrightPath = await findPlaywrightChromiumPath();
  if (playwrightPath) return playwrightPath;

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

export async function getStealthBrowser() {
  if (isShuttingDown) throw new Error('[StealthBrowser] Cannot get browser during shutdown');
  if (browserInstance?.isConnected?.()) return browserInstance;

  // Clear a dead/crashed instance. Killing the orphaned Chrome process releases
  // the userDataDir lock — without this, the next puppeteer.launch() fails with
  // "The browser is already running for [userDataDir]."
  if (browserInstance) {
    logger.warn('[StealthBrowser] Browser connection lost (crashed?) — killing orphaned process before relaunch');
    try { browserInstance.process()?.kill('SIGTERM'); } catch {}
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
      browserInstance = await puppeteer.launch({
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
      });

      logger.info('[StealthBrowser] Browser launched successfully');
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
    const html     = await page.content();
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
    const { getSessionProfile } = await import('./browser/antiDetectProfiles.js');
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
    const html     = await page.content();
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

// Forward exports from extracted modules for backwards compatibility with other files
export { humanMouseMove, humanScroll, dismissCookieBanner } from './browser/humanEmulation.js';
export { openLoginWindow, getSessionStatus, getAllSessionStatuses, getSupportedPlatforms } from './browser/authWindows.js';
export { getRandomUA } from './browser/antiDetectProfiles.js';

// ── Job Platform Login Registry ──────────────────────────────────────────────
// Platforms that require browser login to serve multi-page results.
// verifyUrl: a logged-in-only page that redirects to /login when anonymous.
const JOB_LOGIN_PLATFORMS = {
  indeed:       { name: 'Indeed',       verifyUrl: 'https://my.indeed.com/' },
  // Glassdoor changed URL structure: logged-in users who hit /member/home/
  // now redirect to /Job/index.htm (same as anonymous), so the old
  // connectedFinalUrlMustContain: '/member/' check was firing for valid
  // sessions. Anonymous users on /Job/index.htm are caught by body signals
  // (login CTAs that don't appear once logged in).
  glassdoor:    { name: 'Glassdoor',    verifyUrl: 'https://www.glassdoor.com/member/home/index.htm',  bodySignals: ['sign in to glassdoor', 'create a free glassdoor account', 'join glassdoor for free', 'log in to glassdoor'] },
  // bodySignals: ZipRecruiter's /profile shows an inline login form without
  // redirecting (finalUrl stays at /profile, status 200). The form heading
  // "Log in to ZipRecruiter" distinguishes it from an authenticated profile.
  ziprecruiter: { name: 'ZipRecruiter', verifyUrl: 'https://www.ziprecruiter.com/profile',              bodySignals: ['log in to ziprecruiter', 'sign in to ziprecruiter'] },
  wellfound:    { name: 'Wellfound',    verifyUrl: 'https://wellfound.com/settings' },
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

export async function refreshDiceApiKey() {
  if (_diceRefreshInFlight) return _diceRefreshInFlight;

  _diceRefreshInFlight = (async () => {
    const tmpDir = path.join(os.tmpdir(), `ic-dice-refresh-${Date.now()}`);
    let browser;
    try {
      const executablePath = process.env.CHROME_PATH || await findChromePath();

      logger.info('[Dice API] HTTP 500 detected — launching key-refresh browser');

      // Must be non-headless: dice.com runs Sift bot detection which suppresses
      // the search API XHR in headless sessions, so the key never fires.
      browser = await puppeteer.launch({
        headless: false,
        executablePath,
        userDataDir: tmpDir,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1,1',
          '--window-position=9999,9999',
        ],
        defaultViewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
      });

      const page = await browser.newPage();
      let resolveKey;
      const keyPromise = new Promise(resolve => { resolveKey = resolve; });

      // Intercept outgoing requests from the dice.com page and grab x-api-key from
      // any request that carries it — intentionally NOT filtering to dhigroupinc.com
      // so a domain change on Dice's side doesn't silently break the refresh.
      // Also log all external domains seen so a future failure gives us a clear trail.
      const seenDomains = new Set();
      page.on('request', req => {
        try {
          const url = new URL(req.url());
          if (url.hostname !== 'www.dice.com') seenDomains.add(url.hostname);
          const key = req.headers()['x-api-key'];
          if (key) resolveKey(key);
        } catch { /* malformed URL — ignore */ }
      });

      // Navigate to a Dice search. The React app's mount triggers the search API
      // XHR automatically. domcontentloaded is enough to kick off the JS; the key
      // race below waits up to 20s for the XHR to fire.
      await page.goto(
        'https://www.dice.com/jobs?q=software+engineer&countryCode2=US&radius=30&radiusUnit=mi&page=1&pageSize=20&language=en',
        { waitUntil: 'domcontentloaded', timeout: 15000 },
      ).catch(() => {}); // navigation timeout is fine — XHR may still fire

      const newKey = await Promise.race([
        keyPromise,
        new Promise(r => setTimeout(() => r(null), 20000)),
      ]);

      if (newKey) {
        saveDiceApiKey(newKey);
        logger.info('[Dice API] API key auto-refreshed successfully');
      } else {
        const domains = seenDomains.size > 0 ? [...seenDomains].join(', ') : '(none)';
        logger.warn(`[Dice API] Key refresh failed — no x-api-key header seen in 20s. External domains called: ${domains}`);
      }

      return newKey;
    } finally {
      _diceRefreshInFlight = null;
      if (browser) await browser.close().catch(() => {});
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  })();

  return _diceRefreshInFlight;
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
  ebay:      { name: 'eBay',       sellerUrl: 'https://www.ebay.com/sh/lst/active',                 verifyUrl: 'https://www.ebay.com/mye/myebay/summary' },
  poshmark:  { name: 'Poshmark',   sellerUrl: 'https://poshmark.com/closet',                         verifyUrl: 'https://poshmark.com/feed' },
  mercari:   { name: 'Mercari',    sellerUrl: 'https://www.mercari.com/mypage/listings/',            verifyUrl: 'https://www.mercari.com/mypage/' },
  swappa:    { name: 'Swappa',     sellerUrl: 'https://swappa.com/user/listings',                    verifyUrl: 'https://swappa.com/my/swappa' },
  facebook:  { name: 'Facebook',   sellerUrl: 'https://www.facebook.com/marketplace/you/selling',    verifyUrl: 'https://www.facebook.com/me' },
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
