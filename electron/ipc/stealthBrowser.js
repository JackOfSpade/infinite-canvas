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

import { getSessionProfile } from './browser/antiDetectProfiles.js';

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
export async function findChromePath() {
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

  // No suitable Chrome/Chromium found. Electron's own executable cannot be used
  // as a puppeteer-core target (it spawns a renderer, not a standalone browser).
  // Set CHROME_PATH env var or install Google Chrome to resolve this.
  throw new Error(
    'No Chrome/Chromium installation found. Install Google Chrome or set CHROME_PATH env var.'
  );
}

// ── Singleton Browser Instance ──────────────────────────────────────────────
let browserInstance = null;
let browserLaunchPromise = null;

export async function getStealthBrowser() {
  if (browserInstance?.isConnected?.()) return browserInstance;

  // Clear a dead/crashed instance so it can be garbage collected.
  if (browserInstance) browserInstance = null;

  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = (async () => {
    const executablePath = process.env.CHROME_PATH || await findChromePath();
    console.log('[StealthBrowser] Launching with:', path.basename(executablePath));

    try {
      browserInstance = await puppeteer.launch({
        headless: 'new',
        executablePath,
        userDataDir: await getUserDataDir(),
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

      console.log('[StealthBrowser] Browser launched successfully');
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

export async function closeStealthBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch { /* already closed */ }
    browserInstance = null;
  }
}

// Forward exports from extracted modules for backwards compatibility with other files
export { humanMouseMove, humanScroll, dismissCookieBanner } from './browser/humanEmulation.js';
export { openLoginWindow, getSessionStatus, getAllSessionStatuses, getSupportedPlatforms } from './browser/authWindows.js';
export { getRandomUA } from './browser/antiDetectProfiles.js';

// ── Sell Monitor Platform Registry ──────────────────────────────────────────
// Centralized config for platforms that require login for sell monitoring.
// Previously duplicated in marketplace.js — now single source of truth.

const SELL_MONITOR_PLATFORMS = {
  ebay:      { name: 'eBay',       sellerUrl: 'https://www.ebay.com/sh/lst/active' },
  poshmark:  { name: 'Poshmark',   sellerUrl: 'https://poshmark.com/closet' },
  mercari:   { name: 'Mercari',    sellerUrl: 'https://www.mercari.com/mypage/listings/' },
  swappa:    { name: 'Swappa',     sellerUrl: 'https://swappa.com/user/listings' },
  facebook:  { name: 'Facebook',   sellerUrl: 'https://www.facebook.com/marketplace/you/selling' },
};

/**
 * Get list of platforms that require login for sell monitoring.
 */
export function getSellMonitorPlatforms() {
  return Object.entries(SELL_MONITOR_PLATFORMS).map(([id, config]) => ({
    id,
    name: config.name,
    sellerUrl: config.sellerUrl,
  }));
}

/**
 * Get sell monitor config for a specific platform.
 */
export function getSellMonitorConfig(platformId) {
  return SELL_MONITOR_PLATFORMS[platformId] || null;
}
