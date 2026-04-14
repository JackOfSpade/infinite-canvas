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
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

// Apply stealth evasions (WebGL, navigator.webdriver, chrome.runtime, iframe, etc.)
// NOTE: The report recommends migrating to rebrowser-puppeteer-core to fix the
// Runtime.enable CDP leak. Deferred to a separate session due to complexity.
puppeteer.use(StealthPlugin());

// ── Persistent Session Directory ────────────────────────────────────────────
// All cookies, localStorage, and sessions persist here across app restarts.
function getUserDataDir() {
  const base = app?.getPath?.('userData') || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.infinite-canvas');
  const dir = path.join(base, 'browser-data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Coherent Fingerprint Profiles ───────────────────────────────────────────
// Each profile is internally consistent: UA, client hints, platform, viewport,
// and screen dimensions all match. We pick ONE profile per session and NEVER
// rotate — switching fingerprints on a persistent session is a top detection vector.
const FINGERPRINT_PROFILES = [
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'macOS',
    viewport: { width: 1920, height: 1080 },
    clientHints: {
      architecture: 'arm',
      bitness: '64',
      brands: [
        { brand: 'Google Chrome', version: '131' },
        { brand: 'Chromium', version: '131' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: '131.0.6778.204' },
        { brand: 'Chromium', version: '131.0.6778.204' },
      ],
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: '14.5.0',
    },
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    platform: 'macOS',
    viewport: { width: 1440, height: 900 },
    clientHints: {
      architecture: 'arm',
      bitness: '64',
      brands: [
        { brand: 'Google Chrome', version: '130' },
        { brand: 'Chromium', version: '130' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: '130.0.6723.116' },
        { brand: 'Chromium', version: '130.0.6723.116' },
      ],
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: '14.5.0',
    },
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'macOS',
    viewport: { width: 1680, height: 1050 },
    clientHints: {
      architecture: 'arm',
      bitness: '64',
      brands: [
        { brand: 'Google Chrome', version: '131' },
        { brand: 'Chromium', version: '131' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: '131.0.6778.204' },
        { brand: 'Chromium', version: '131.0.6778.204' },
      ],
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: '14.5.0',
    },
  },
];

// Pick one profile per app session (not per page — switching mid-session is suspicious)
let sessionProfile = null;
function getSessionProfile() {
  if (!sessionProfile) {
    sessionProfile = FINGERPRINT_PROFILES[Math.floor(Math.random() * FINGERPRINT_PROFILES.length)];
  }
  return sessionProfile;
}

export function getRandomUA() {
  return getSessionProfile().ua;
}

// ── Chrome Executable Discovery ─────────────────────────────────────────────
function findChromePath() {
  /* global process */
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
    if (fs.existsSync(p)) return p;
  }

  const electronPath = app?.getPath?.('exe');
  if (electronPath && fs.existsSync(electronPath)) return electronPath;

  throw new Error(
    'No Chrome/Chromium installation found. Install Google Chrome or set CHROME_PATH env var.'
  );
}

// ── Singleton Browser Instance ──────────────────────────────────────────────
let browserInstance = null;
let browserLaunchPromise = null;

/**
 * Get or launch the shared stealth browser.
 * Thread-safe: concurrent calls during startup share the same launch promise.
 */
export async function getStealthBrowser() {
  if (browserInstance?.isConnected?.()) return browserInstance;

  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = (async () => {
    const executablePath = process.env.CHROME_PATH || findChromePath();
    console.log('[StealthBrowser] Launching with:', path.basename(executablePath));

    browserInstance = await puppeteer.launch({
      headless: 'new',
      executablePath,
      userDataDir: getUserDataDir(),
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
    browserLaunchPromise = null;
    return browserInstance;
  })();

  return browserLaunchPromise;
}

/**
 * Create a new stealth page with coherent fingerprint.
 *
 * 2026 hardening:
 *   - Full Client Hints via setUserAgent() (not setExtraHTTPHeaders)
 *   - Screen API coherence
 *   - Cooperative Intercept Mode (priority 0)
 *   - Never block CSS/fonts/scripts (Cloudflare Sequence ML)
 *   - Allow tracking pixels (behavioral asset expectations)
 */
export async function createStealthPage() {
  const browser = await getStealthBrowser();
  const page = await browser.newPage();
  const profile = getSessionProfile();

  // Set coherent user agent WITH full client hints object.
  // This replaces manual Sec-Ch-Ua headers, which disrupt HTTP/2 frame ordering.
  await page.setUserAgent(profile.ua, profile.clientHints);

  // Set matching viewport
  await page.setViewport({
    ...profile.viewport,
    deviceScaleFactor: 2, // Retina — matches real Mac
  });

  // Minimal extra headers — ONLY things the browser wouldn't send natively.
  // CRITICAL: Do NOT override Accept, Sec-Fetch-*, Sec-Ch-Ua headers manually.
  // Chrome sends these natively; overriding disrupts HTTP/2 pseudo-header ordering.
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });

  // Patch fingerprint leaks via evaluateOnNewDocument
  const vp = profile.viewport;
  await page.evaluateOnNewDocument((p, vpW, vpH) => {
    // Navigator coherence — must match UA
    Object.defineProperty(navigator, 'platform', { get: () => p === 'macOS' ? 'MacIntel' : 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Screen API coherence — must match viewport exactly.
    // Headless Chrome returns default screen dims; we align them.
    Object.defineProperty(window.screen, 'width', { get: () => vpW });
    Object.defineProperty(window.screen, 'height', { get: () => vpH });
    Object.defineProperty(window.screen, 'availWidth', { get: () => vpW });
    Object.defineProperty(window.screen, 'availHeight', { get: () => vpH - 25 }); // macOS menu bar
    Object.defineProperty(window.screen, 'colorDepth', { get: () => 30 }); // Mac P3 display
    Object.defineProperty(window.screen, 'pixelDepth', { get: () => 30 });

    // Connection info
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
      Object.defineProperty(navigator.connection, 'downlink', { get: () => 10 });
      Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
    }
  }, profile.platform, vp.width, vp.height);

  // Resource interception — Cooperative Intercept Mode (priority 0)
  //
  // CRITICAL 2026 rules:
  //   - NEVER block CSS (Cloudflare Sequence ML flags missing stylesheets)
  //   - NEVER block fonts (font-probe heuristics need real font loading)
  //   - NEVER block scripts (breaks Turnstile/DataDome challenges)
  //   - ONLY block heavy media + non-tracking images
  //   - Use priority 0 on all continue/abort to minimize TTFB anomalies
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled?.()) return;

    const type = req.resourceType();
    const url = req.url();

    if (type === 'media') {
      req.abort('aborted', 0);
    } else if (type === 'image') {
      // Allow tracking pixels and small images; block large hero/product images
      if (url.endsWith('.gif') || url.includes('pixel') || url.includes('tracker') || url.includes('beacon') || url.includes('1x1')) {
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
 * Gracefully close the stealth browser. Call on app quit.
 */
export async function closeStealthBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch { /* already closed */ }
    browserInstance = null;
  }
}

// ── Site-Specific Helpers ───────────────────────────────────────────────────

/**
 * Dismiss common cookie consent / privacy banners.
 * Tries multiple known selectors and clicks the first match.
 */
export async function dismissCookieBanner(page) {
  const selectors = [
    // Generic GDPR / cookie consent buttons
    'button[id*="accept"]',
    'button[id*="consent"]',
    'button[class*="accept"]',
    'button[class*="consent"]',
    '[data-testid="gdpr-banner-accept"]',
    '#onetrust-accept-btn-handler',
    '.fc-cta-consent',
    // eBay specific
    '#gdpr-banner-accept',
    // Indeed specific
    '#onetrust-accept-btn-handler',
    // Google consent
    'button[aria-label="Accept all"]',
    'form[action*="consent"] button',
  ];

  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await new Promise(r => setTimeout(r, 500));
        return true;
      }
    } catch { /* selector not found, continue */ }
  }
  return false;
}

/**
 * Simulate human-like mouse movement using quadratic Bézier curves.
 * Moves from a random start point to a random end point with natural acceleration.
 */
export async function humanMouseMove(page) {
  const vp = getSessionProfile().viewport;
  const startX = 100 + Math.random() * (vp.width / 2);
  const startY = 100 + Math.random() * (vp.height / 3);
  const endX = startX + (Math.random() - 0.5) * 400;
  const endY = startY + 200 + Math.random() * 300;
  const cpX = (startX + endX) / 2 + (Math.random() - 0.5) * 200;
  const cpY = (startY + endY) / 2 + (Math.random() - 0.5) * 100;

  const steps = 15 + Math.floor(Math.random() * 10);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round((1 - t) ** 2 * startX + 2 * (1 - t) * t * cpX + t ** 2 * endX);
    const y = Math.round((1 - t) ** 2 * startY + 2 * (1 - t) * t * cpY + t ** 2 * endY);
    await page.mouse.move(x, y);
    const delay = 10 + Math.random() * 20 * (1 + Math.sin(Math.PI * t));
    await new Promise(r => setTimeout(r, delay));
  }
}

/**
 * Simulate human-like scrolling with momentum, variable distances, and pauses.
 */
export async function humanScroll(page, scrolls = 3) {
  await humanMouseMove(page);

  for (let i = 0; i < scrolls; i++) {
    const distance = 200 + Math.floor(Math.random() * 400);
    const steps = 3 + Math.floor(Math.random() * 3);
    for (let s = 0; s < steps; s++) {
      const fraction = distance / steps * (1 - s / (steps * 2));
      await page.evaluate((d) => window.scrollBy(0, d), Math.round(fraction));
      await new Promise(r => setTimeout(r, 30 + Math.random() * 60));
    }

    const pauseMs = i === 0
      ? 800 + Math.random() * 600
      : 300 + Math.random() * 500;
    await new Promise(r => setTimeout(r, pauseMs));
  }
}

// ── Login Window (visible, user-interactive) ────────────────────────────────

/** Known platform login URLs */
const PLATFORM_LOGIN_URLS = {
  // Job platforms
  linkedin:      'https://www.linkedin.com/login',
  indeed:        'https://secure.indeed.com/auth',
  glassdoor:     'https://www.glassdoor.com/profile/login_input.htm',
  ziprecruiter:  'https://www.ziprecruiter.com/login',
  dice:          'https://www.dice.com/dashboard/login',
  wellfound:     'https://wellfound.com/login',
  // Marketplace — selling destinations
  ebay:          'https://signin.ebay.com/ws/eBayISAPI.dll?SignIn',
  facebook:      'https://www.facebook.com/login',
  mercari:       'https://www.mercari.com/login/',
  poshmark:      'https://poshmark.com/login',
  depop:         'https://www.depop.com/login/',
  swappa:        'https://swappa.com/login',
  reverb:        'https://reverb.com/login',
  whatnot:       'https://www.whatnot.com/login',
  // Marketplace — pricing data only
  stockx:        'https://stockx.com/login',
};

/** Cookie domains to check per platform */
const PLATFORM_COOKIE_DOMAINS = {
  // Job platforms
  linkedin:      ['.linkedin.com'],
  indeed:        ['.indeed.com'],
  glassdoor:     ['.glassdoor.com'],
  ziprecruiter:  ['.ziprecruiter.com'],
  dice:          ['.dice.com'],
  wellfound:     ['.wellfound.com'],
  // Marketplace — selling + pricing
  ebay:          ['.ebay.com'],
  facebook:      ['.facebook.com'],
  mercari:       ['.mercari.com'],
  poshmark:      ['.poshmark.com'],
  depop:         ['.depop.com'],
  swappa:        ['.swappa.com'],
  reverb:        ['.reverb.com'],
  whatnot:       ['.whatnot.com'],
  stockx:        ['.stockx.com'],
};

/**
 * Open a VISIBLE browser window for the user to log into a platform.
 * Uses the same persistent userDataDir so cookies are shared with scraping.
 * Returns when the user closes the window.
 */
export async function openLoginWindow(platformId) {
  const url = PLATFORM_LOGIN_URLS[platformId];
  if (!url) throw new Error(`Unknown platform: ${platformId}`);

  const executablePath = process.env.CHROME_PATH || findChromePath();
  console.log(`[StealthBrowser] Opening login window for ${platformId}`);

  // Launch a SEPARATE visible browser for login (shares the same userDataDir)
  const loginBrowser = await puppeteer.launch({
    headless: false,
    executablePath,
    userDataDir: getUserDataDir(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1100,800',
      '--lang=en-US,en',
    ],
    defaultViewport: null, // Use the window size as viewport
    ignoreHTTPSErrors: true,
  });

  // Close the headless scraping browser — can't share userDataDir simultaneously
  await closeStealthBrowser();

  const pages = await loginBrowser.pages();
  const page = pages[0] || await loginBrowser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

  // Wait for the user to close the browser window
  return new Promise((resolve) => {
    loginBrowser.on('disconnected', () => {
      console.log(`[StealthBrowser] Login window closed for ${platformId}`);
      resolve({ success: true, platform: platformId });
    });
  });
}

/**
 * Check if we have active session cookies for a given platform.
 * Launches a quick headless page, navigates to the site, and checks for auth indicators.
 */
export async function getSessionStatus(platformId) {
  const domains = PLATFORM_COOKIE_DOMAINS[platformId];
  if (!domains) return { platform: platformId, connected: false };

  try {
    const browser = await getStealthBrowser();
    const page = await browser.newPage();

    // Check cookies for this domain
    const cookies = await page.cookies(...domains.map(d => `https://${d.replace(/^\./, '')}`));
    await page.close();

    // Simple heuristic: if there are session/auth cookies, we're logged in
    const hasSession = cookies.some(c =>
      c.name.toLowerCase().includes('session') ||
      c.name.toLowerCase().includes('token') ||
      c.name.toLowerCase().includes('auth') ||
      c.name.toLowerCase().includes('li_at') ||      // LinkedIn
      c.name.toLowerCase().includes('jses') ||        // Indeed  
      c.name.toLowerCase().includes('dp1') ||          // eBay
      c.name.toLowerCase().includes('session-id')      // Amazon
    );

    return {
      platform: platformId,
      connected: hasSession,
      cookieCount: cookies.length,
    };
  } catch {
    return { platform: platformId, connected: false };
  }
}

/**
 * Get connection status for all known platforms.
 */
export async function getAllSessionStatuses() {
  const platforms = Object.keys(PLATFORM_LOGIN_URLS);
  const results = await Promise.all(platforms.map(p => getSessionStatus(p)));
  return results;
}

/**
 * Get the list of supported platforms.
 */
export function getSupportedPlatforms() {
  return Object.keys(PLATFORM_LOGIN_URLS).map(id => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    loginUrl: PLATFORM_LOGIN_URLS[id],
  }));
}

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
