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
let browserExecutablePath = null;
// Set while closeStealthBrowser() is tearing down the shared instance (e.g.
// handing the profile off to a captcha/login window). getStealthBrowser()
// awaits this before touching browserInstance so it can't reuse/relaunch on
// top of a close that's still in progress — the same dedup discipline
// browserLaunchPromise already gives launches, now given to closes.
let browserClosePromise = null;

let sharedProfileReservation = null;

// ── Singleton activity snapshot ─────────────────────────────────────────────
// What made the profile-lock incident hard to diagnose after the fact wasn't
// that the singleton was alive (getStealthBrowserInfo already reported that) —
// it's that "alive" doesn't say whether it's doing anything. A cookie check
// that opens a page, reads cookies, and closes it again leaves the singleton
// holding the OS lock for as long as it stays cached, with nothing else ever
// touching it. Surfacing live-page activity makes that self-evident.
//
// A page counts as "live" the same way getBrowserSessionResetBlocker already
// defines it below: open, not closed, and not sitting on about:blank (a
// browser.newPage() default that never navigated anywhere isn't activity).
async function collectLivePages(browser) {
  const pages = await browser.pages();
  return pages
    .filter(page => !page.isClosed?.())
    .map(page => page.url?.() || '')
    .filter(url => url && url !== 'about:blank');
}

// host+path only, bounded — enough to identify what's open without the report
// growing unboundedly on a long query string.
const ACTIVITY_URL_MAX = 90;
function truncateActivityUrl(rawUrl) {
  let hostPath;
  try {
    const u = new URL(rawUrl);
    hostPath = `${u.host}${u.pathname}${u.search || ''}`;
  } catch {
    hostPath = String(rawUrl || '');
  }
  return hostPath.length > ACTIVITY_URL_MAX ? `${hostPath.slice(0, ACTIVITY_URL_MAX - 1)}…` : hostPath;
}

// getStealthBrowserInfo() is called from a SYNCHRONOUS bug-report path (see
// getBrowserProfileDiagnostics's doc comment) while browser.pages() is
// inherently async — so it cannot query live activity itself. This cache is
// the bridge: refreshed at the few points below where an extra pages() call
// is already cheap (right after the singleton launches, and whenever
// getBrowserSessionResetBlocker already does this exact inspection), and read
// back synchronously by getStealthBrowserInfo(). `pages: null` means never
// observed this generation — reported as "not observed", never guessed.
// `generation` lets a snapshot from an already-replaced browser process be
// told apart from the current one instead of being shown as current.
let _lastActivitySnapshot = { observedAt: null, generation: null, pages: null };

async function refreshActivitySnapshot(browser) {
  try {
    const pages = await collectLivePages(browser);
    _lastActivitySnapshot = {
      observedAt: Date.now(),
      generation: browserGeneration,
      pages: pages.map(truncateActivityUrl),
    };
    return pages;
  } catch {
    // An inspection failure is not evidence of zero pages — leave whatever
    // was last honestly observed in place rather than overwrite it with a
    // guess. Returning null (vs. an empty array) is what lets a caller like
    // getBrowserSessionResetBlocker distinguish "inspected, found nothing" from
    // "could not inspect".
    return null;
  }
}

// A session reset must never race a launch/teardown or an interactive login/
// captcha window.  The shared profile is intentionally used by several
// platforms, so the reset code below is deliberately conservative about when
// it may take ownership of it.
export async function getBrowserSessionResetBlocker() {
  if (isShuttingDown) return 'The browser is shutting down.';
  if (sharedProfileReservation) {
    return `Close the ${sharedProfileReservation.reason} browser window before resetting a session.`;
  }
  if (browserLaunchPromise) return 'The browser is starting. Wait for it to finish, then try again.';
  if (browserClosePromise) return 'The browser is closing. Wait for it to finish, then try again.';
  // The singleton itself may be an idle, blank Chromium left over after an
  // earlier request. It is safe to close that process for maintenance, but a
  // navigated live page means another operation is actively using the profile
  // and must finish rather than being detached by a reset. This inspection is
  // also the activity snapshot the bug report reads back later (see
  // refreshActivitySnapshot above) — one shape, not a second copy of it.
  if (browserInstance?.connected) {
    const livePages = await refreshActivitySnapshot(browserInstance);
    if (livePages === null) return 'Browser activity could not be inspected safely. Wait a moment, then try again.';
    if (livePages.length > 0) return 'A browser operation is still running. Wait for it to finish, then try again.';
  }
  return null;
}

export function reserveSharedProfile(reason = 'visible-window') {
  // Only one visible window can hold the shared userDataDir at a time (OS-level
  // profile lock), so a second reservation while one is already held must not
  // silently overwrite it — the earlier holder (e.g. a job-side captcha-resolve
  // window) is still open, and when the SECOND caller later releases, its release
  // closure would null out sharedProfileReservation out from under the first
  // window, letting assertSharedProfileAvailable wave through a headless launch
  // that races the still-open visible Chrome. Refuse up front instead, so the
  // caller gets this function's own orderly error rather than a launch that
  // collides on the OS lock and fails ~11s later with a cryptic one.
  if (sharedProfileReservation) {
    throw new Error(
      `Shared browser profile is already reserved for ${sharedProfileReservation.reason}; ` +
      `cannot also reserve it for ${reason} until that window closes.`
    );
  }
  const token = Symbol(reason);
  sharedProfileReservation = {
    token,
    reason,
    since: Date.now(),
  };
  logger.info(`[StealthBrowser] Shared profile reserved for ${reason}`);
  return () => {
    if (sharedProfileReservation?.token !== token) return;
    const heldMs = Date.now() - sharedProfileReservation.since;
    logger.info(`[StealthBrowser] Shared profile reservation released for ${reason} (${heldMs}ms)`);
    sharedProfileReservation = null;
  };
}

export function getSharedProfileReservationInfo() {
  if (!sharedProfileReservation) return null;
  return {
    reason: sharedProfileReservation.reason,
    since: sharedProfileReservation.since,
  };
}

function assertSharedProfileAvailable(context) {
  if (!sharedProfileReservation) return;
  throw new Error(
    `Shared browser profile is reserved for ${sharedProfileReservation.reason}; ` +
    `${context} cannot start until that visible browser closes.`
  );
}

// Identity of the current stealth-browser process. generation increments each
// launch; launchedAt is the epoch ms of that launch (0 if never launched).
//
// `activity` answers "what is it doing", not just "is it alive": an idle
// singleton holding the shared profile (0 live pages) reads very differently
// from one mid-scrape. Read from the cache _lastActivitySnapshot populates
// (see above) — synchronous by necessity, since this function is called from
// the synchronous bug-report path. `livePageCount`/`livePageUrls` are null
// when there is no honest observation for the CURRENT browser generation yet
// (never launched, or launched but not yet refreshed, or the browser isn't
// running) — callers must render that as "not observed", never as zero.
export function getStealthBrowserInfo() {
  const connected = !!browserInstance?.connected;
  const hasCurrentSnapshot = connected
    && _lastActivitySnapshot.generation === browserGeneration
    && _lastActivitySnapshot.pages !== null;
  return {
    generation: browserGeneration,
    launchedAt: browserLaunchedAt,
    connected,
    executablePath: browserExecutablePath,
    activity: {
      observedAt: hasCurrentSnapshot ? _lastActivitySnapshot.observedAt : null,
      livePageCount: hasCurrentSnapshot ? _lastActivitySnapshot.pages.length : null,
      livePageUrls: hasCurrentSnapshot ? _lastActivitySnapshot.pages : null,
    },
  };
}

function browserProcessExited(proc) {
  return !proc || proc.exitCode != null || proc.signalCode != null;
}

function waitForOwnedBrowserExit(proc, timeoutMs) {
  if (browserProcessExited(proc)) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const done = () => {
      if (timer) clearTimeout(timer);
      proc.removeListener?.('exit', done);
      resolve(true);
    };
    proc.once('exit', done);
    if (browserProcessExited(proc)) return done();
    timer = setTimeout(() => {
      proc.removeListener?.('exit', done);
      resolve(browserProcessExited(proc));
    }, timeoutMs);
  });
}

/**
 * Read-only, value-free snapshot of the persistent Chrome profile. This is
 * deliberately synchronous so bug-report generation stays synchronous. Cookie
 * values are never opened or exported; file identity/mtime is enough to tell
 * whether a successful login ever checkpointed the profile before restart.
 */
export function getBrowserProfileDiagnostics() {
  const userDataDir = _userDataDir
    || path.join(app?.getPath?.('userData') || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.infinite-canvas'), 'browser-data');
  const snapshotFile = (filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return { exists: true, bytes: stat.size, mtime: stat.mtime.toISOString() };
    } catch {
      return { exists: false, bytes: 0, mtime: null };
    }
  };
  return {
    userDataDir,
    profile: snapshotFile(userDataDir),
    cookies: snapshotFile(path.join(userDataDir, 'Default', 'Cookies')),
    cookiesJournal: snapshotFile(path.join(userDataDir, 'Default', 'Cookies-journal')),
    cookiesWal: snapshotFile(path.join(userDataDir, 'Default', 'Cookies-wal')),
    localState: snapshotFile(path.join(userDataDir, 'Local State')),
    preferences: snapshotFile(path.join(userDataDir, 'Default', 'Preferences')),
    browser: getStealthBrowserInfo(),
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

// The `context` string getStealthBrowser() passes when it launches the
// retained singleton THROUGH this very helper (see ~line 419 below). That
// launch must never trigger the singleton-yield logic a few lines down —
// closing "the singleton" while it is itself mid-launch would mean
// closeStealthBrowser() tearing down the browser instance this same call is
// trying to produce, which can only end in a wedge or a use-after-close.
const HEADLESS_SCRAPE_LAUNCH_CONTEXT = 'headless-scrape';

export async function launchWithProfileLockRetry(launchOpts, context, url = null) {
  let lastErr;
  // Ask the retained singleton to yield the shared profile at most once per
  // call — it only needs to step aside once, and asking again on every
  // subsequent retry would spam the log and fight whatever relaunched it
  // (getStealthBrowser() relaunches on demand for its own next caller).
  let askedSingletonToYield = false;
  for (let attempt = 0; attempt <= PROFILE_LOCK_RETRY_DELAYS.length; attempt++) {
    try {
      const browser = await puppeteer.launch(launchOpts);
      if (attempt > 0) {
        recordLaunchCollision({ context, url, attempts: attempt + 1, recovered: true, error: lastErr, ts: Date.now(), askedSingletonToYield });
        logger.info(`[StealthBrowser] ${context} launch recovered after ${attempt} retry(ies) — shared profile freed`);
      }
      return browser;
    } catch (err) {
      lastErr = err;
      if (!isProfileLockCollision(err)) throw err;

      // The retained singleton is an app-owned, relaunch-on-demand cache — not
      // a visible window a person is using. openLoginWindow and
      // resetPlatformSession already make it yield by hand (an explicit
      // closeStealthBrowser() before their own launch); scrape launchers had
      // no equivalent, so any path that left the singleton alive (e.g. a
      // post-login cookie check that happens to touch it) hard-failed the
      // next browser scrape for the full retry ladder. Do this ONLY on an
      // actual collision, never preemptively: pure-HTTP sources (LinkedIn
      // guest enrichment, etc.) run concurrently with browser scrapes and use
      // the singleton via fetchHtmlClean, so closing it unconditionally here
      // would abort in-flight fetches that were never blocking anything. Once
      // we've genuinely collided, the alternative is failing this whole
      // source, so making the singleton yield is strictly better. Guard
      // against HEADLESS_SCRAPE_LAUNCH_CONTEXT — see its definition above.
      if (!askedSingletonToYield && context !== HEADLESS_SCRAPE_LAUNCH_CONTEXT && getStealthBrowserInfo().connected) {
        askedSingletonToYield = true;
        logger.info(`[StealthBrowser] ${context} launch collided with the shared profile — closing the retained idle singleton so it yields the profile`);
        // Never let a failed close replace the profile-lock error we are in the
        // middle of handling: that error names the real problem and carries the
        // retry ladder, while a close failure here is only the recovery attempt
        // not working. Fall through and keep retrying.
        try {
          await closeStealthBrowser(false);
        } catch (closeErr) {
          logger.warn(`[StealthBrowser] Retained singleton did not close cleanly while yielding to ${context}: ${closeErr?.message || closeErr}`);
        }
      }

      if (attempt < PROFILE_LOCK_RETRY_DELAYS.length) {
        const delay = PROFILE_LOCK_RETRY_DELAYS[attempt];
        logger.warn(`[StealthBrowser] ${context} launch hit the shared-profile lock (another Chrome window/scrape holds it) — retrying in ${delay}ms (attempt ${attempt + 1}/${PROFILE_LOCK_RETRY_DELAYS.length + 1})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      // Retries exhausted: record + throw a message that names the real cause
      // (the bare puppeteer "Code: 0" is undebuggable). Also state — as an
      // observation, not a cause — whether this call itself asked the
      // retained singleton to yield, so a bug report can tell "our own idle
      // browser held it (and was asked to close)" apart from "something else
      // (a visible captcha/login window, another process) held it the whole
      // time and never yielded".
      recordLaunchCollision({ context, url, attempts: attempt + 1, recovered: false, error: err, ts: Date.now(), askedSingletonToYield });
      throw new Error(
        `Chrome launch blocked by the shared browser profile lock after ${attempt + 1} attempts — ` +
        `another window or scrape is holding it. Close any open captcha/login window and retry. ` +
        `(retained singleton yield ${askedSingletonToYield ? 'was requested during this call' : 'was not requested this call'}) ` +
        `(${err?.message || String(err)})`
      );
    }
  }
  throw lastErr; // unreachable — loop either returns or throws
}

export async function getStealthBrowser() {
  if (isShuttingDown) throw new Error('[StealthBrowser] Cannot get browser during shutdown');
  assertSharedProfileAvailable('headless stealth browser');

  // A close is currently tearing down the shared instance (e.g. handing the
  // profile off to a captcha/login window, see closeStealthBrowser). Without
  // this wait, browserInstance.connected reads a moment before close()
  // actually severs the CDP connection could still return true — handing this
  // caller a browser mid-teardown — or, if it already reads false, this
  // caller would redundantly SIGTERM/null the SAME instance closeStealthBrowser
  // is already closing and race it into a fresh launch while the old Chrome
  // process (and its userDataDir OS lock) may not have exited yet.
  if (browserClosePromise) {
    await browserClosePromise.catch(() => {});
    if (isShuttingDown) throw new Error('[StealthBrowser] Cannot get browser during shutdown');
    assertSharedProfileAvailable('headless stealth browser');
  }

  if (browserInstance?.connected) {
    // Best-effort background refresh, deliberately NOT awaited — this is the
    // hot path every caller goes through, and blocking it on an extra pages()
    // round-trip would add latency to every scrape for a diagnostic-only
    // signal. refreshActivitySnapshot swallows its own errors, so there is no
    // unhandled-rejection risk in firing it and moving on.
    refreshActivitySnapshot(browserInstance);
    return browserInstance;
  }

  // Clear a dead/crashed instance. Killing the orphaned Chrome process releases
  // the userDataDir lock — without this, the next puppeteer.launch() fails with
  // "The browser is already running for [userDataDir]."
  if (browserInstance) {
    logger.warn('[StealthBrowser] Browser connection lost (crashed?) — killing orphaned process before relaunch');
    const deadInstance = browserInstance;
    browserInstance = null;
    // Register this teardown as the shared close-in-flight guard (same variable
    // closeStealthBrowser() dedups on). Without this, a closeStealthBrowser()
    // call landing in this window sees browserInstance already null and
    // returns immediately, thinking there's nothing to close — while the
    // SIGTERM'd process may not have exited yet. clearBrowserSession() in
    // particular deletes the userDataDir right after closeStealthBrowser()
    // resolves, which would then race an OS lock the dying process still
    // holds. Setting browserClosePromise makes a concurrent close piggyback
    // on (i.e. actually wait for) this kill instead of racing past it.
    browserClosePromise = (async () => {
      try { deadInstance.process()?.kill('SIGTERM'); } catch { /* already dead */ }
      // Give the OS a moment to release the profile lock.
      await new Promise(r => setTimeout(r, 500));
    })();
    try {
      await browserClosePromise;
    } finally {
      browserClosePromise = null;
    }
    // A concurrent caller may have already relaunched (and even fully
    // connected) while we were waiting — re-check before starting a SECOND,
    // redundant launch on top of one that already finished and cleared
    // browserLaunchPromise (the check below would otherwise miss it).
    if (browserInstance?.connected) return browserInstance;
  }

  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = (async () => {
    assertSharedProfileAvailable('headless stealth browser launch');
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
      }, HEADLESS_SCRAPE_LAUNCH_CONTEXT);

      browserGeneration += 1;
      browserLaunchedAt = Date.now();
      browserExecutablePath = executablePath;
      logger.info(`[StealthBrowser] Browser launched successfully (generation #${browserGeneration})`);
      // Awaited (unlike the hot-path refresh above): this runs once per
      // generation, not once per caller, and establishes the first honest
      // snapshot for the new generation before anyone can observe it —
      // without this, getStealthBrowserInfo() would report "not observed"
      // for however long the singleton sits idle before its next use.
      await refreshActivitySnapshot(browserInstance);
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

// Bound page.content() and retry once past a destroyed execution context. When an
// anti-bot challenge (e.g. Cloudflare) keeps the page in a reload loop, content()
// blocks indefinitely waiting for a stable execution context — sailing past the
// navigation timeout the caller set. Without this race a wedged page hangs the
// caller forever; this is what stalled the startup login verify on Glassdoor (the
// whole "checking connections" step never returned). On timeout the caller's own
// catch falls through to { ok:false } and its finally still closes the page.
//
// A client-side (SPA) redirect firing AFTER page.goto's wait condition already
// resolved — e.g. an auth wall bouncing an unauthenticated hub URL to a /login
// route — can destroy the execution context mid-read, throwing Puppeteer's
// "Execution context was destroyed, most likely because of a navigation."
// manualScraper.js's runExtractor treats this exact error class as a transient
// race (not a terminal failure) and retries; mirror that here with a single
// bounded retry once the new page settles, instead of surfacing a bare "Fetch
// failed" for a page that a moment later reads fine (and classifies normally —
// e.g. as needs-login instead of an opaque error). Shared by fetchHtmlAuthed and
// fetchHtmlClean so this fragile Puppeteer workaround has only one copy to fix.
async function readPageHtmlBounded(page, timeoutMs, finalUrl) {
  const readContent = () => Promise.race([
    page.content(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('page.content() timed out — page may be stuck in an anti-bot reload loop')),
      Math.max(3000, Math.min(8000, timeoutMs - 2000)))),
  ]);
  try {
    const html = await readContent();
    return { html, finalUrl };
  } catch (err) {
    if (!/Execution context was destroyed/i.test(err?.message || '')) throw err;
    await new Promise((r) => setTimeout(r, 500));
    finalUrl = page.url() || finalUrl;
    const html = await readContent();
    return { html, finalUrl };
  }
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

    const status = response?.status() ?? 0;
    const { html, finalUrl } = await readPageHtmlBounded(page, timeoutMs, page.url() || url);
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
export async function fetchHtmlClean(url, { timeoutMs = 25000, signal, waitForRenderMs = 0 } = {}) {
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

    // Bounded client-render settle for SPA verify pages (opt-in via waitForRenderMs).
    // Under 'domcontentloaded' the content() below captures only the SSR shell; some
    // marketplaces (Mercari) client-render their LOGIN FORM over a generic shell, so
    // the body sign-in sniff races the render and misses → a logged-out user gets
    // mis-verified as connected. Give the client a capped window to paint, kept
    // INSIDE the content() budget so a wedged page still falls through to the
    // content() timeout → { ok:false } (inconclusive), never a false logged-in.
    if (waitForRenderMs > 0) {
      await new Promise(r => setTimeout(r, Math.max(0, Math.min(waitForRenderMs, timeoutMs - 4000))));
      if (signal?.aborted) throw new Error('Aborted');
    }

    const status = response?.status() ?? 0;
    const { html, finalUrl } = await readPageHtmlBounded(page, timeoutMs, page.url() || url);
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

  // Dedup: if a close is already in flight (e.g. a captcha handoff and a
  // status-check hub scan both decided to release the profile around the
  // same time), piggyback on that single close instead of two callers racing
  // browserInstance.close()/kill() against the same process.
  if (browserClosePromise) return browserClosePromise;

  browserClosePromise = (async () => {
    const pendingLaunch = browserLaunchPromise;
    if (pendingLaunch) {
      logger.info('[StealthBrowser] Waiting for in-flight browser launch before closing shared profile');
      try {
        const launchedBrowser = await pendingLaunch;
        if (launchedBrowser?.connected) browserInstance = launchedBrowser;
      } catch (err) {
        logger.warn(`[StealthBrowser] In-flight browser launch settled before close with error: ${err?.message || String(err)}`);
      }
    }
    browserLaunchPromise = null; // Prevent anyone from waiting on a completed/failed launch
    if (browserInstance) {
      const proc = browserInstance.process();
      // Subscribe before close() so a normal process exit that occurs while the
      // CDP close promise is settling cannot be missed.
      const processExit = waitForOwnedBrowserExit(proc, forShutdown ? 12_000 : 5_000);
      try {
        await browserInstance.close();
      } catch { /* already closed */ }
      browserInstance = null;
      // Wait for the Chrome process to fully exit and release the userDataDir
      // lock. Browser.close() only sends the exit signal — the process takes
      // a moment to die. Without this wait, the next puppeteer.launch() on the
      // same profile races the dying process and Chrome falls back to a temp
      // empty profile, causing page.goto() to silently land on about:blank.
      const exited = await processExit;
      if (!exited) logger.warn('[StealthBrowser] Shared browser process did not report exit before the profile-release deadline');
    }
  })();

  try {
    await browserClosePromise;
  } finally {
    browserClosePromise = null;
  }
}

export async function clearBrowserSession() {
  const blocker = await getBrowserSessionResetBlocker();
  if (blocker) {
    const error = new Error(blocker);
    error.code = 'browser-busy';
    throw error;
  }
  const releaseProfileReservation = reserveSharedProfile('clear-browser-session');
  try {
    await closeStealthBrowser(false);
    const dir = await getUserDataDir();
    await fs.promises.rm(dir, { recursive: true, force: true });
    _userDataDir = null; // reset cache so next launch recreates the dir
  } finally {
    releaseProfileReservation();
  }
}

// Keep this list intentionally small and explicit. These are the hosts the
// Indeed login/search flow can use today; accepting origins from renderer data
// here would turn a platform-scoped reset into an arbitrary-origin clearer.
const INDEED_SESSION_RESET_HOSTS = [
  'www.indeed.com',
  'secure.indeed.com',
  'ca.indeed.com',
  'uk.indeed.com',
  'au.indeed.com',
  'nz.indeed.com',
  'ie.indeed.com',
  'de.indeed.com',
  'fr.indeed.com',
  'in.indeed.com',
  'sg.indeed.com',
];

/** Pure, strict domain ownership check used by the targeted session reset. */
export function isIndeedCookieDomain(domain) {
  const normalized = String(domain || '').trim().toLowerCase().replace(/^\.+/, '');
  return normalized === 'indeed.com' || normalized.endsWith('.indeed.com');
}

/** Fixed origins whose non-cookie website storage is safe to clear for Indeed. */
export function getIndeedSessionResetOrigins() {
  return INDEED_SESSION_RESET_HOSTS.map(host => `https://${host}`);
}

async function closeOwnedSessionResetBrowser(browser) {
  if (!browser) return;
  const proc = browser.process?.();
  const processExit = waitForOwnedBrowserExit(proc, 5000);
  await browser.close().catch(() => {});
  if (!await processExit) logger.warn('[StealthBrowser] Session-reset browser did not report exit before profile release');
}

/**
 * Clear the saved session for Indeed alone, without deleting the shared Chrome
 * profile. This is intentionally not generic: its caller must not be able to
 * supply an arbitrary domain or a path to erase.
 */
export async function resetPlatformSession(platformId) {
  if (platformId !== 'indeed') {
    return { success: false, code: 'unsupported-platform', reason: 'Only the Indeed session can be reset here.' };
  }
  const blocker = await getBrowserSessionResetBlocker();
  if (blocker) return { success: false, code: 'browser-busy', reason: blocker };

  let browser = null;
  let page = null;
  let cdp = null;
  const releaseProfileReservation = reserveSharedProfile('platform-session-reset:indeed');
  try {
    // A retained singleton is normally idle between requests. Close it before
    // this controlled maintenance launch so Chrome flushes the cookie database
    // and no second process competes for the profile. The reservation prevents
    // normal shared-profile callers from launching during this handoff.
    await closeStealthBrowser(false);
    // Indeed login/scraping deliberately uses system Chrome because Chromium
    // cookie encryption is keyed to the browser app identity on macOS. Using
    // Playwright's Chrome-for-Testing here could open the same directory but be
    // unable to read/delete the session that system Chrome wrote.
    const executablePath = process.env.CHROME_PATH || await findSystemChromePath() || await findChromePath();
    browser = await launchWithProfileLockRetry({
      headless: 'new',
      executablePath,
      userDataDir: await getUserDataDir(),
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
      ignoreHTTPSErrors: true,
    }, 'platform-session-reset', 'https://www.indeed.com/');
    page = await browser.newPage();
    cdp = await page.createCDPSession();

    const cookieResponse = await cdp.send('Network.getAllCookies');
    const ownedCookies = (Array.isArray(cookieResponse?.cookies) ? cookieResponse.cookies : [])
      .filter(cookie => isIndeedCookieDomain(cookie?.domain));
    for (const cookie of ownedCookies) {
      const params = { name: cookie.name, domain: cookie.domain, path: cookie.path || '/' };
      // Partitioned cookies are uncommon for Indeed, but preserving the key
      // makes the deletion exact when Chromium reports one.
      if (cookie.partitionKey) params.partitionKey = cookie.partitionKey;
      await cdp.send('Network.deleteCookies', params);
    }

    // Do not use `all` or include `cookies`: cookie deletion above is exact,
    // while these origin-scoped stores remove stale workers/cache/local state
    // that can keep serving an old challenge shell.
    const storageTypes = 'service_workers,cache_storage,local_storage,indexeddb,websql,file_systems';
    for (const origin of getIndeedSessionResetOrigins()) {
      await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes });
    }

    logger.info(`[StealthBrowser] Reset Indeed session data (${ownedCookies.length} Indeed cookie(s), ${getIndeedSessionResetOrigins().length} origins)`);
    return {
      success: true,
      platformId: 'indeed',
      removedCookies: ownedCookies.length,
      clearedOrigins: getIndeedSessionResetOrigins().length,
      reason: 'Indeed cookies and saved website data were cleared. Other platform sessions were left untouched.',
    };
  } catch (error) {
    const reason = error?.message || String(error);
    logger.error(`[StealthBrowser] Indeed session reset failed: ${reason}`);
    return { success: false, code: 'reset-failed', reason };
  } finally {
    if (cdp) await cdp.detach().catch(() => {});
    if (page) await page.close().catch(() => {});
    await closeOwnedSessionResetBrowser(browser);
    releaseProfileReservation();
  }
}

// Forward exports from extracted modules for backwards compatibility with other files
export { humanMouseMove, humanScroll, dismissCookieBanner } from './browser/humanEmulation.js';
export {
  openLoginWindow,
  getSessionStatus,
  getLoginAutoCloseWaitReason,
  hasPlatformAuthCookie,
  readPlatformAuthCookieState,
  isNativeLoginSuccess,
  closeAllAuthWindows,
} from './browser/authWindows.js';
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
  // dominates the whole startup "checking connections" wall). This is NOT the nav
  // budget: fetchHtmlClean navigates with timeoutMs - 5000, so this value must be
  // the intended nav budget + 5s. 17000 ⇒ a 12s navigation — the value the earlier
  // 12000 was reasoning about, which actually cut the nav off at 7s and truncated a
  // real (469KB, redirect-heavy) member-page load into a status-less partial read.
  glassdoor:    {
    name: 'Glassdoor',
    verifyUrl: 'https://www.glassdoor.com/member/home/index.htm',
    verifyTimeoutMs: 17000,
    bodySignals: [
      'sign in to glassdoor',
      'create a free glassdoor account',
      'join glassdoor for free',
      'log in to glassdoor',
      // Current anonymous /member/home redirect: the public /Job/index.htm page
      // keeps a generic "Sign In" nav item, so use the adjacent anonymous-only
      // resume/CV CTA as a high-signal phrase instead of matching bare "sign in".
      // The Canadian shell inserts its search-nav copy between "Sign in" and
      // this CTA (and localizes resume as CV), so the old contiguous signal
      // falsely marked that anonymous page connected.
      'sign in upload your resume - let employers find you',
      'upload your resume - let employers find you',
      'upload your cv - let employers find you',
    ],
  },
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

function awaitPromiseOrAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

async function settleWithin(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function refreshDiceApiKey(signal = null) {
  if (_diceRefreshInFlight) return awaitPromiseOrAbort(_diceRefreshInFlight, signal);

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

  return awaitPromiseOrAbort(_diceRefreshInFlight, signal);
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
      const html = await settleWithin(page.content(), 5000, 'Dice key-refresh page.content');
      const match = html.match(DICE_API_KEY_RE);
      if (match?.[1]) resolveIfKey(match[1]);
    } catch (error) {
      logger.warn(`[Dice API] Browser HTML scan skipped: ${error?.message || error}`);
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
    if (browser) {
      try {
        await settleWithin(browser.close(), 5000, 'Dice key-refresh browser.close');
      } catch (error) {
        logger.warn(`[Dice API] Browser close did not settle cleanly: ${error?.message || error}`);
        try { browser.process()?.kill?.('SIGKILL'); } catch { /* process already exited */ }
      }
    }
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
  depop:     {
    name: 'Depop',
    sellerUrl: 'https://www.depop.com/products/create/',
    verifyUrl: 'https://www.depop.com/products/create/',
    connectedFinalUrlMustContain: 'depop.com/products/create',
    bodySignals: [
      'sign up or log in',
      'log in to depop',
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
    // Mercari serves its login form CLIENT-rendered over a generic SSR shell at the
    // auth-gated /mypage URL (HTTP 200, no /login redirect). Without a render settle,
    // fetchHtmlClean captures only the ~19KB shell (generic SEO <title>, no form),
    // the bodySignals above never match, and a logged-OUT user falls through to a
    // false connected:true. This bounded wait lets the form paint so the existing
    // sign-in sniff catches it. Kept inside the verify timeout budget.
    verifyRenderWaitMs: 2000,
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
  aptdeco:   {
    name: 'AptDeco',
    // AptDeco has no /login or /account route (both 404); the create-listing page
    // IS its auth gate — anonymous users see the listing intro plus an "Already
    // have an account? Sign in" prompt (verified live), which vanishes once logged
    // in. Same create-page-as-verify pattern as Depop. No connectedFinalUrlMustContain
    // (the logged-in redirect target is unverified) — the body sniff is the guard.
    sellerUrl: 'https://www.aptdeco.com/sell/new',
    verifyUrl: 'https://www.aptdeco.com/sell/new',
    // AptDeco's logged-in content is CLIENT-rendered, so the body-text sniff races
    // the auth swap and false-reads a logged-in user as logged out. Verify via the
    // `token` auth cookie (PLATFORM_AUTH_COOKIES.aptdeco) FIRST — render-safe. The
    // bodySignals below remain the fallback for the cookie-absent (logged-out) case.
    verifyViaCookie: true,
    bodySignals: [
      'already have an account? sign in',
      'already have an account',
    ],
    bodyScanChars: 800,
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
