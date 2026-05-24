import { logger } from '../../logger.js';
import puppeteer from 'puppeteer-extra';
import { getStealthBrowser, closeStealthBrowser, getUserDataDir, findChromePath } from '../stealthBrowser.js';
import { READINESS } from '../scrapeBudget.js';

// ── Auth-window cadence ───────────────────────────────────────────────────────
// Timing for the human-in-the-loop auth/captcha windows: how responsively we
// detect a completed login, how long to keep a hidden window open waiting for
// the user, and the diagnostic heartbeat cadence. These are interaction bounds
// with no page baseline to learn from, so they're named constants (not adaptive).
// (The captcha window's extractor-poll cadence is READINESS.CAPTCHA_POLL_MS.)
const LOGIN_POLL_INTERVAL_MS    = 500;           // login-window auto-close poll cadence
const AUTH_WINDOW_AUTO_CLOSE_MS = 5 * 60 * 1000; // max time a hidden auth/captcha window stays open
const AUTH_HEARTBEAT_LOG_MS     = 10_000;        // "still waiting" diagnostic heartbeat interval

/** Known platform login URLs */
export const PLATFORM_LOGIN_URLS = {
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

/**
 * Per-platform auth cookies — names of cookies that are set *only when
 * logged in* and not present (or empty) when anonymous. Used by the
 * auto-close poller as a more reliable signal than DOM scraping for SPAs
 * (Facebook etc.) that lazy-render their account menu, so "Log out" isn't
 * in the initial DOM and HTML-text scraping fails.
 *
 * Cookie names are stable platform contracts — Facebook's `c_user` has
 * held for years. Missing entries here fall back to DOM-signal detection.
 * HttpOnly cookies are visible to puppeteer's `page.cookies()` via CDP.
 */
export const PLATFORM_AUTH_COOKIES = {
  facebook:    ['c_user'],          // numeric user id; absent or "0" when logged out
  linkedin:    ['li_at'],           // long-lived session token
  // Others fall through to DOM signal — add here as we confirm them.
};

/** Cookie domains to check per platform */
export const PLATFORM_COOKIE_DOMAINS = {
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
 * 
 * Hardening: Monitors the IPC sender; if the sender is destroyed (e.g. window closed),
 * the login browser is closed immediately to prevent process leaks.
 */
export async function openLoginWindow(platformId, sender = null) {
  const url = PLATFORM_LOGIN_URLS[platformId];
  if (!url) throw new Error(`Unknown platform: ${platformId}`);

  const executablePath = process.env.CHROME_PATH || await findChromePath();
  logger.info(`[StealthBrowser] Opening login window for ${platformId}`);

  // Close the headless scraping browser FIRST. Chrome locks userDataDir per
  // process — if the singleton is still running when we try to launch the
  // login window on the same dir, the login window's launch either races,
  // silently uses an empty profile, or fails outright. The previous order
  // (launch login → then close singleton) produced a window that looked
  // logged-out even after a successful prior login, and post-login cookies
  // didn't always reach disk in time for verifySellMonitorLogin.
  await closeStealthBrowser();

  // Launch a SEPARATE visible browser for login (now has exclusive access to userDataDir).
  // ignoreDefaultArgs removes --enable-automation which puppeteer adds by default —
  // it's what triggers the "Chrome is being controlled by automated test software"
  // banner AND the window.cdc_... properties that sites like Glassdoor use to detect
  // puppeteer and return a blank page. --disable-blink-features=AutomationControlled
  // already removes navigator.webdriver; stripping --enable-automation makes the
  // login window indistinguishable from a regular Chrome session.
  const loginBrowser = await puppeteer.launch({
    headless: false,
    executablePath,
    userDataDir: await getUserDataDir(),
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1100,800',
      '--lang=en-US,en',
    ],
    defaultViewport: null,
    ignoreHTTPSErrors: true,
  });

  const pages = await loginBrowser.pages();
  const page = pages[0] || await loginBrowser.newPage();

  // Clear stale service worker registrations AND cache storage for the login
  // origin via CDP. SWs are origin-scoped and can only be unregistered from
  // within that origin — so page.evaluate() from about:blank does nothing.
  // CDP's Storage.clearDataForOrigin bypasses that restriction and works from
  // any page context. This matters for Glassdoor: the headless scraping browser
  // visits glassdoor.com during startup verification, which activates and
  // caches Glassdoor's SW in the shared userDataDir. When the login window
  // opens on the same profile, that stale SW intercepts the navigation and
  // serves a cached SPA shell that never renders — resulting in about:blank.
  // cache_storage is included so a stale SW cache can't re-serve the shell.
  // Cookies are intentionally excluded so login state isn't lost.
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Storage.clearDataForOrigin', {
      origin: new URL(url).origin,
      storageTypes: 'service_workers,cache_storage',
    });
    await cdp.detach();
  } catch { /* CDP unavailable or URL unparseable — proceed anyway */ }

  // Navigate via window.location.href rather than page.goto().
  //
  // page.goto() uses CDP's Page.navigate command under the hood. Cloudflare's
  // bot-mitigation layer detects the CDP navigation timing signature and
  // silently hangs the TCP connection — it never sends an HTTP response —
  // so domcontentloaded never fires and the page stays at about:blank until
  // the 30 s timeout fires (by which point the user has been staring at a
  // blank window for half a minute).
  //
  // Assigning window.location.href from within the page's JS context triggers
  // a native browser navigation that is indistinguishable from a user typing
  // the URL into the address bar. Chrome handles the request through its
  // normal network stack without any CDP Page.navigate fingerprint, and
  // Cloudflare serves the page normally. The evaluate() resolves as soon as
  // the assignment executes; page-context destruction mid-navigate is expected
  // and caught below.
  await page.evaluate((targetUrl) => {
    window.location.href = targetUrl;
  }, url).catch((err) => {
    logger.warn(`[StealthBrowser] Login window navigate ${url} failed: ${err?.message || String(err)}`);
  });

  // Wait for the user to close the browser window or the app window to be destroyed
  return new Promise((resolve) => {
    let isTerminated = false;
    let autoClosePoll = null;
    let autoCloseTimeout = null;

    // ── Auto-close polling ──────────────────────────────────────────────────
    // After every ~0.5s, check whether the page looks "logged in." Two
    // signals must both match to trigger auto-close (false-positive guard):
    //   1. URL is no longer on a login/signin/auth path
    //   2. Page DOM contains a sign-out / logout link (universal indicator
    //      that the user is past authentication)
    //
    // Catches both fresh logins (user types creds → site redirects → poll
    // sees the new URL + sign-out link) AND "already logged in" cases where
    // visiting the login URL bounces straight to the home page.
    //
    // Capped at 5 minutes so a tab the user walked away from doesn't poll
    // forever. User-initiated close still works the same way it always did.
    const LOGIN_URL_PATTERN = /\/(signin|sign-in|login|log-in|authenticate|auth(?!or))/i;
    const AUTO_CLOSE_AFTER_MS = AUTH_WINDOW_AUTO_CLOSE_MS;
    const POLL_INTERVAL_MS = LOGIN_POLL_INTERVAL_MS;

    // Diagnostic state for the poll — log URL transitions once and emit a
    // "still waiting" heartbeat every ~10s so the bug report's main-process
    // log buffer reveals WHY auto-close didn't fire (vs. silent failure).
    let lastNonLoginUrl = null;
    let lastHeartbeatLog = 0;

    autoClosePoll = setInterval(async () => {
      if (isTerminated) return;
      try {
        if (page.isClosed?.()) return;
        const currentUrl = page.url();
        if (!currentUrl || currentUrl === 'about:blank') return;
        if (LOGIN_URL_PATTERN.test(currentUrl)) return; // still on a login page — wait

        if (lastNonLoginUrl !== currentUrl) {
          if (!lastNonLoginUrl) logger.info(`[StealthBrowser] ${platformId} URL transitioned past login: ${currentUrl}`);
          lastNonLoginUrl = currentUrl;
        }

        // Cookie signal — preferred for SPAs (Facebook etc.) where the
        // account menu is lazy-rendered and "Log out" text isn't in the
        // initial DOM. HttpOnly cookies ARE visible via CDP, so this works
        // for c_user / li_at etc.
        let cookieSignal = false;
        const expectedCookies = PLATFORM_AUTH_COOKIES[platformId];
        if (expectedCookies?.length) {
          try {
            const cookies = await page.cookies();
            cookieSignal = cookies.some(c =>
              expectedCookies.includes(c.name) && c.value && c.value !== '0'
            );
          } catch { /* page may be navigating */ }
        }

        // DOM signal — fallback for platforms without a known auth cookie.
        // Uses innerHTML (NOT innerText) so sign-out links hidden inside
        // collapsed account-menu dropdowns (eBay's "Hi Xiao!" menu, etc.)
        // still count — those are display:none until hover, and innerText
        // excludes display:none content. Still fails for SPAs that
        // lazy-render menu contents (Facebook) — hence the cookie path.
        const domSignal = cookieSignal || await page.evaluate(() => {
          const selectors = [
            'a[href*="signout" i]', 'a[href*="sign-out" i]', 'a[href*="logout" i]', 'a[href*="log-out" i]',
            'button[id*="signout" i]', 'button[id*="logout" i]',
            '[data-test*="signout" i]', '[data-test*="logout" i]',
            '[aria-label*="sign out" i]', '[aria-label*="log out" i]',
          ].join(', ');
          if (document.querySelector(selectors)) return true;
          const html = (document.body?.innerHTML || '').toLowerCase();
          return html.includes('sign out') || html.includes('log out') || html.includes('>signout<') || html.includes('>logout<');
        }).catch(() => false);

        if (cookieSignal || domSignal) {
          const via = cookieSignal ? 'auth cookie' : 'DOM signal';
          logger.info(`[StealthBrowser] Auto-detected logged-in state for ${platformId} via ${via} at ${currentUrl} — closing window`);
          if (autoClosePoll) { clearInterval(autoClosePoll); autoClosePoll = null; }
          if (autoCloseTimeout) { clearTimeout(autoCloseTimeout); autoCloseTimeout = null; }
          // Programmatic close fires the 'disconnected' event → cleanup
          // below → resolves the promise → caller's verify runs and the
          // cache + Settings pill update with the success result.
          await loginBrowser.close().catch(() => {});
          return;
        }

        const now = Date.now();
        if (now - lastHeartbeatLog > AUTH_HEARTBEAT_LOG_MS) {
          lastHeartbeatLog = now;
          const cookieNote = expectedCookies?.length
            ? `expected cookies ${expectedCookies.join(',')} not set`
            : 'no auth-cookie config; DOM scrape only';
          logger.info(`[StealthBrowser] ${platformId} auto-close waiting: URL ${currentUrl} — ${cookieNote}; no DOM signal yet`);
        }
      } catch {
        // Page navigation / context destruction during the evaluate — fine,
        // next poll tick will retry. Don't tear down the poll on transient
        // errors.
      }
    }, POLL_INTERVAL_MS);

    autoCloseTimeout = setTimeout(() => {
      if (autoClosePoll) { clearInterval(autoClosePoll); autoClosePoll = null; }
    }, AUTO_CLOSE_AFTER_MS);

    // macOS: clicking the red X on a Chromium window closes the *page* but
    // leaves the Chrome process alive in the dock — `disconnected` never
    // fires, so cleanup stalls until the user right-clicks → Quit. Listen
    // for page destruction and close the browser when no pages remain so
    // the user closing via X actually terminates the flow.
    loginBrowser.on('targetdestroyed', async (target) => {
      if (isTerminated) return;
      if (target.type?.() !== 'page') return;
      try {
        const remaining = await loginBrowser.pages();
        if (remaining.length === 0) {
          logger.info(`[StealthBrowser] ${platformId} last page closed by user — closing browser`);
          await loginBrowser.close().catch(() => {});
        }
      } catch { /* browser may already be tearing down */ }
    });

    const cleanup = async () => {
      if (isTerminated) return;
      isTerminated = true;
      if (autoClosePoll) { clearInterval(autoClosePoll); autoClosePoll = null; }
      if (autoCloseTimeout) { clearTimeout(autoCloseTimeout); autoCloseTimeout = null; }
      if (sender) sender.removeListener('destroyed', cleanup);
      try {
        await loginBrowser.close();
      } catch { /* ignored */ }
      resolve({ success: true, platform: platformId, closedByApp: sender?.isDestroyed?.() });
    };

    if (sender) {
      if (sender.isDestroyed()) {
        cleanup();
        return;
      }
      sender.once('destroyed', cleanup);
    }

    loginBrowser.on('disconnected', cleanup);
  });
}

/**
 * Open a VISIBLE browser window for the user to manually clear a captcha or
 * anti-bot challenge that blocked a scrape. Mirrors openLoginWindow's
 * lifecycle (same userDataDir so the cleared challenge cookies persist for
 * subsequent scrapes) but the auto-close signal is "challenge gone" rather
 * than "logged in."
 *
 * Resolves once the user clears the challenge (auto-detected) OR closes the
 * window manually. The caller is expected to retry the original scrape; this
 * function does not retry on its own.
 */
export async function openCaptchaResolveWindow(url, sender = null, signal = null, inlineExtractorJS = null, secondTabUrl = null) {
  if (!url) throw new Error('openCaptchaResolveWindow requires a url');

  const executablePath = process.env.CHROME_PATH || await findChromePath();
  logger.info(`[StealthBrowser] Opening captcha-resolve window for ${url}`);

  // Same userDataDir-lock dance as openLoginWindow — Chrome won't let the
  // visible browser launch on a dir the headless scraper still holds.
  await closeStealthBrowser();

  const captchaBrowser = await puppeteer.launch({
    headless: false,
    executablePath,
    userDataDir: await getUserDataDir(),
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1100,800',
      '--lang=en-US,en',
    ],
    defaultViewport: null,
    ignoreHTTPSErrors: true,
  });

  const pages = await captchaBrowser.pages();
  const page = pages[0] || await captchaBrowser.newPage();
  // Capture the original host so a user wandering off to another site doesn't
  // false-positive the "challenge gone" check on an unrelated page.
  const originalHost = (() => { try { return new URL(url).host; } catch { return null; } })();
  // 'load' closes the goto promise on DOM + critical-resource readiness,
  // skipping the 1-3s 'networkidle2' wait for analytics/tracking pixels.
  // Safe because the probe below gates extract on textLength > BODY_TEXT_GATE,
  // which is its own "page has real content" check.
  // Same window.location.href pattern as openLoginWindow — avoids the CDP
  // Page.navigate fingerprint that Cloudflare silently hangs. The evaluate()
  // resolves immediately after the assignment; the probe poll handles about:blank
  // gracefully by skipping it until the navigation completes.
  await page.evaluate((targetUrl) => {
    window.location.href = targetUrl;
  }, url).catch((err) => {
    logger.warn(`[StealthBrowser] Captcha window navigate ${url} failed: ${err?.message || String(err)}`);
  });

  // When the caller needs the user to act on a separate page (e.g. Glassdoor
  // review gate: Tab 1 stays on job results for polling; Tab 2 is where the
  // user writes their review). Tab 2 is opened last so it gets focus, keeping
  // Tab 1 untouched and ready for the extractor poll.
  //
  // Both tabs get a color-coded sticky banner injected via evaluateOnNewDocument
  // (persists across SPA navigations within the tab) + an immediate evaluate call
  // (catches the already-loaded initial page). The banners orient the user so they
  // don't accidentally write the review on the polling tab.
  if (secondTabUrl) {
    // Helper: inject once on every new document load in a tab.
    // evaluateOnNewDocument args are serialized, so text/bg must be primitives.
    const injectBanner = async (p, text, bg) => {
      await p.evaluateOnNewDocument((t, b) => {
        const inject = () => {
          if (document.getElementById('__ic-tab-banner__')) return;
          const el = document.createElement('div');
          el.id = '__ic-tab-banner__';
          el.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;background:${b};color:#fff;padding:9px 16px;font:500 13px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.35);pointer-events:none`;
          el.textContent = t;
          if (document.body) document.body.prepend(el);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
        else inject();
      }, text, bg).catch(() => {});
      // Also inject immediately into the already-loaded page.
      await p.evaluate((t, b) => {
        if (document.getElementById('__ic-tab-banner__')) return;
        const el = document.createElement('div');
        el.id = '__ic-tab-banner__';
        el.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;background:${b};color:#fff;padding:9px 16px;font:500 13px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.35);pointer-events:none`;
        el.textContent = t;
        if (document.body) document.body.prepend(el);
      }, text, bg).catch(() => {});
    };

    await injectBanner(
      page,
      '🔄  Tab 1 · Job Results — refresh this page after completing your task on Tab 2',
      '#16a34a',
    );
    const tab2 = await captchaBrowser.newPage();
    await injectBanner(
      tab2,
      '✏️  Tab 2 · Complete your review or salary entry here — then switch to Tab 1 and refresh it',
      '#2563eb',
    );
    await tab2.evaluate((u) => { window.location.href = u; }, secondTabUrl).catch(() => {});
  }

  return new Promise((resolve) => {
    let isTerminated = false;
    let autoClosePoll = null;
    let autoCloseTimeout = null;
    let resolved = false; // true = challenge auto-detected as cleared
    // ── Resolve diagnostics — answer "Solve opened, I saw the page, but the card
    // still failed: why?" The resolve telemetry otherwise records only a count, so
    // a 0 can't be told apart from a stale-selector miss, a thrown extractor, or a
    // genuinely empty page. Captured here and returned in `diag` so the bug
    // report's Captcha-resolve section can name the cause instead of guessing.
    let everSawChallenge = false; // a challenge widget was visible at some tick
    let everSawConsent = false;   // a cookie/consent wall was visible at some tick
    let lastTextLen = 0;          // body innerText length on the last probe
    let lastHost = null;          // host on the last probe (catches "wandered off")
    let extractOutcome = null;    // inline-extract result: 'matched N' / 'matched 0' / 'threw' / 'non-array' / 'no-extractor'
    let autoCloseReason = null;   // why finishCleared fired (set at each call site)
    let siteChangedError = null;  // non-null when inline extract threw SITE_CHANGED (code fix needed, not captcha)
    let pollTimedOut = false;     // auto-detect poll gave up before any resolve

    // Snappier cadence than the in-page loop for sub-second detection after a
    // user solve (page.evaluate is cheap but not free). Centralized so the two
    // readiness loops can't drift — see scrapeBudget.READINESS.
    const POLL_INTERVAL_MS = READINESS.CAPTCHA_POLL_MS;
    const AUTO_CLOSE_AFTER_MS = AUTH_WINDOW_AUTO_CLOSE_MS;
    // Visible challenge widgets — checking the DOM for these elements AND
    // their visibility is far more reliable than substring matching the
    // HTML source (which false-positives on script tags like
    // `recaptcha/api.js` that sites embed on every page, including the
    // post-solve search results). Each entry is { name, selector } where
    // selector matches the wrapper / iframe that's only present while the
    // challenge is on screen.
    const CHALLENGE_SELECTORS = [
      { name: 'recaptcha-anchor',  selector: 'iframe[src*="recaptcha/api2/anchor"]' },
      { name: 'recaptcha-bframe',  selector: 'iframe[src*="recaptcha/api2/bframe"]' },
      { name: 'recaptcha-widget',  selector: '.g-recaptcha[data-sitekey]' },
      { name: 'hcaptcha-iframe',   selector: 'iframe[src*="hcaptcha.com"]' },
      { name: 'cf-challenge-form', selector: '#challenge-form, #challenge-running, .cf-browser-verification' },
      { name: 'datadome',          selector: '#datadome-captcha-container, iframe[src*="captcha-delivery.com"]' },
      { name: 'perimeterx',        selector: '[id*="px-captcha"], iframe[src*="perimeterx"]' },
      { name: 'press-and-hold',    selector: 'div[id*="px-captcha"][style*="block"]' },
    ];
    // Cookie-consent overlays are NOT captchas, but they cover the page and
    // gate/hide results the same way — and the user is mid-interaction with one.
    // We must not declare the page "empty" and auto-close while one is up (that
    // closed the Swappa window out from under a user about to accept cookies,
    // reporting 0 results when results were rendered behind the panel). Named
    // CMP roots first, then prominent generic cookie/consent/gdpr containers.
    const CONSENT_SELECTOR_STRING = [
      '#onetrust-banner-sdk', '#CybotCookiebotDialog', '.osano-cm-window',
      '#usercentrics-root', '#truste-consent-track', '.qc-cmp2-container', '#didomi-host',
      '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
      '[id*="gdpr" i]', '[class*="gdpr" i]',
    ].join(', ');
    let lastHeartbeatLog = 0;
    let firstProbeLogged = false;
    let extractedItems = null;
    // ── Dynamic readiness (inline-extract path) ──────────────────────────────
    // Once the anti-bot gate is passed (no challenge widgets), we DON'T guess
    // "page loaded" from a fixed body-text length — that proxy fires before a
    // heavy results grid (e.g. eBay sold) finishes hydrating, yielding 0 items.
    // Instead we poll the extractor and wait for its item COUNT to stabilize:
    // a fast page settles in one tick; a lazily-loading grid waits exactly as
    // long as items keep arriving. The constants govern stability *detection*,
    // not content-guessing, and the ceiling is only a safety net.
    let antiBotClearedAt = null;   // ms when challenge widgets first disappeared
    let lastExtractCount = -1;     // item count from the previous poll
    let stableTicks = 0;           // consecutive polls with an unchanged (>0) count
    let emptySince = null;         // ms when the page first read 0 items with no overlay
    const STABLE_TICKS_REQUIRED = READINESS.STABLE_READS;  // unchanged count this many polls → settled
    const READINESS_CEILING_MS = READINESS.CEILING_MS;     // hard cap for a slowly-climbing positive count
    // CRITICAL: this is a HUMAN-DRIVEN window. A 0-item read usually means the
    // user is still clearing something — a cookie wall, captcha, or login — that
    // gates the results, NOT that the page is genuinely empty. The headless loop
    // accepts empty after ~2.4s (READINESS.MAX_ZERO_READS @ CAPTCHA_POLL_MS),
    // which is far too fast here: it closed the Swappa window out from under a
    // user mid cookie-accept. Give a human-scale grace instead. Detection of the
    // overlay is unreliable across sites (Swappa's panel slipped past the consent
    // selectors), so the grace — not detection — is what guarantees the user has
    // time. A detected consent overlay merely RESETS it; positive results settle
    // immediately (below); the 5-min window timeout is the absolute backstop.
    const RESOLVE_EMPTY_GRACE_MS = 30000;

    // Single probe tick — pulled out so we can run it immediately after
    // goto resolves AND on every setInterval. Without the immediate first
    // run there was a 0-400ms (worst-case full POLL_INTERVAL_MS) delay
    // between goto-completion and the first probe.
    const runProbe = async () => {
      if (isTerminated) return;
      try {
        if (page.isClosed?.()) return;
        const currentUrl = page.url();
        if (!currentUrl || currentUrl === 'about:blank') return;

        // Bail out of the auto-close check if the user wandered off the
        // original host (we can't infer "challenge cleared" from an
        // unrelated domain's content).
        let currentHost = null;
        try { currentHost = new URL(currentUrl).host; } catch { /* ignored */ }
        if (originalHost && currentHost && currentHost !== originalHost) return;

        const probe = await page.evaluate((selectors, consentSel) => {
          // Visibility check — an element exists in the DOM but is hidden
          // (display:none / detached) doesn't count as "challenge on
          // screen." offsetParent is null for display:none AND for fixed
          // elements (rare for challenges), so we also accept a non-zero
          // bounding rect as a sign of visibility.
          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return false;
            return el.offsetParent !== null || el.tagName === 'IFRAME';
          };
          const hits = [];
          for (const { name, selector } of selectors) {
            const els = document.querySelectorAll(selector);
            for (const el of els) {
              if (isVisible(el)) { hits.push(name); break; }
            }
          }
          // A cookie-consent overlay is "present" only when visible AND
          // prominent (a large box or a fixed/sticky bar) — so an incidental
          // hidden element whose class merely contains "cookie" can't wedge the
          // window open. Generous match is safe: it only blocks the empty/close
          // conclusion (positive results still settle below).
          let consentVisible = false;
          for (const el of document.querySelectorAll(consentSel)) {
            if (!isVisible(el)) continue;
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (r.width * r.height >= 4000 || style.position === 'fixed' || style.position === 'sticky') {
              consentVisible = true; break;
            }
          }
          const textLength = (document.body?.innerText || '').length;
          return { hits, textLength, consentVisible };
        }, CHALLENGE_SELECTORS, CONSENT_SELECTOR_STRING).catch(() => null);

        if (!probe) return;

        // Snapshot page state for the resolve diagnostics returned at close.
        lastTextLen = probe.textLength;
        lastHost = currentHost;
        if (probe.hits.length) everSawChallenge = true;
        if (probe.consentVisible) everSawConsent = true;

        // Log the FIRST probe so bug reports can tell "user solved fast"
        // from "captcha never appeared in this session." With only the 10s
        // heartbeat, a sub-10s resolve left zero diagnostic trail.
        if (!firstProbeLogged) {
          firstProbeLogged = true;
          const initial = probe.hits.length > 0
            ? `initial probe found visible challenge widgets: [${probe.hits.join(', ')}]`
            : probe.consentVisible
              ? `initial probe found a cookie-consent wall (no captcha) — holding the window open for the user to accept/dismiss rather than closing it as empty`
              : `initial probe found NO challenge widgets (textLen=${probe.textLength}) — page may never have shown a captcha to this visible session even though headless scrape was blocked`;
          logger.info(`[StealthBrowser] Captcha wait: host=${currentHost} — ${initial}`);
        }

        const noChallenge = probe.hits.length === 0;

        // Declare the challenge cleared, stash any extracted items, and close
        // (the window's `disconnected` → cleanup resolves with { resolved, items }).
        const finishCleared = async (items, reason) => {
          if (items) {
            extractedItems = items;
            logger.info(`[StealthBrowser] Inline extract on ${currentHost} → ${items.length} item(s) (skipping headless rescrape)`);
          }
          autoCloseReason = reason || 'cleared';
          logger.info(`[StealthBrowser] Captcha auto-detected as cleared on ${currentHost} (no visible challenge widgets, textLen=${probe.textLength}, reason=${autoCloseReason}) — closing window`);
          resolved = true;
          if (autoClosePoll) { clearInterval(autoClosePoll); autoClosePoll = null; }
          if (autoCloseTimeout) { clearTimeout(autoCloseTimeout); autoCloseTimeout = null; }
          await captchaBrowser.close().catch(() => {});
        };

        if (inlineExtractorJS) {
          // ── Inline-extract path: wait for the extractor's item count to settle.
          if (!noChallenge) {
            // Still showing a challenge — reset the tracker so a post-solve
            // render starts measuring fresh.
            antiBotClearedAt = null; lastExtractCount = -1; stableTicks = 0; emptySince = null;
          } else {
            // If the page body is empty, the navigation is still in flight or the
            // site is serving a blank page to this visible session. Running the
            // extractor now produces a spurious SITE_CHANGED (e.g. indeed
            // __NEXT_DATA__ missing on a blank page) that auto-closes the window
            // after only ~4 seconds — before the user can interact. Wait for real
            // content before attempting extraction.
            if (probe.textLength === 0) return;
            if (antiBotClearedAt == null) antiBotClearedAt = Date.now();
            let items = null;
            try {
              const result = await page.evaluate(inlineExtractorJS);
              if (Array.isArray(result)) items = result;
              else { extractOutcome = 'non-array'; logger.warn(`[StealthBrowser] Inline extract returned non-array (${typeof result}); falling back to rescrape`); }
            } catch (e) {
              extractOutcome = 'threw';
              const isSC = /SITE_CHANGED/i.test(e?.message || '');
              logger.warn(`[StealthBrowser] Inline extract failed (${e?.message || e}); ${isSC ? 'code fix needed — not triggering auto-rescrape' : 'falling back to rescrape'}`);
              if (isSC) {
                // Guard against concurrent probe calls (multiple evaluates in-flight
                // when the page finishes loading) both hitting this handler. The
                // second one's warn/close would be a harmless duplicate, but it
                // produces a confusing double WARN in the log.
                if (isTerminated) return;
                isTerminated = true;
                // The extractor is broken (not the captcha) — closing the window
                // and rescraping headless would just fail again. Surface as
                // stale-selectors via the resolve payload so marketplace.js can
                // emit the right warning to the source card (Retry, not Solve).
                siteChangedError = e?.message || String(e);
                if (autoClosePoll) { clearInterval(autoClosePoll); autoClosePoll = null; }
                if (autoCloseTimeout) { clearTimeout(autoCloseTimeout); autoCloseTimeout = null; }
                await captchaBrowser.close().catch(() => {});
                return;
              }
            }

            const ceilingHit = Date.now() - antiBotClearedAt >= READINESS_CEILING_MS;

            if (items == null) {
              // Extractor failed/non-array — no count to stabilize on. Treat the
              // page as cleared and close so the renderer's headless-rescrape
              // fallback runs (unchanged from the original behavior).
              await finishCleared(null, 'extractor-error');
              return;
            }

            const count = items.length;
            if (count > 0) {
              extractOutcome = `matched ${count}`; // latest positive read — survives an early close mid-hydration
              stableTicks = (count === lastExtractCount) ? stableTicks + 1 : 0;
              lastExtractCount = count;
              emptySince = null;
              if (stableTicks >= STABLE_TICKS_REQUIRED || ceilingHit) {
                logger.info(`[StealthBrowser] ${currentHost} results settled at ${count} item(s)${ceilingHit ? ' (readiness ceiling hit)' : ` after ${stableTicks} stable poll(s)`}`);
                await finishCleared(items, ceilingHit ? 'settled-ceiling' : 'settled');
                return;
              }
              // count still climbing — keep polling.
            } else if (probe.consentVisible) {
              // A cookie-consent wall is covering the page — the 0 is the wall
              // (or content gated behind it), NOT a genuinely-empty result, and
              // the user is mid-accept. Restart the empty grace so it only starts
              // counting once the wall is gone, and reset the hydration ceiling so
              // post-dismiss rendering is measured fresh.
              emptySince = null;
              antiBotClearedAt = null;
            } else {
              // 0 items and no overlay we recognize — but the user may still be
              // clearing one we don't (Swappa's cookie panel slipped past the
              // consent selectors). Give a HUMAN-scale grace before concluding
              // empty, instead of the headless ~2.4s cadence that raced the user.
              if (emptySince == null) emptySince = Date.now();
              const emptyMs = Date.now() - emptySince;
              if (emptyMs >= RESOLVE_EMPTY_GRACE_MS) {
                extractOutcome = 'matched 0';
                logger.info(`[StealthBrowser] ${currentHost} found 0 items after ${Math.round(emptyMs / 1000)}s with no captcha/consent detected — accepting empty result`);
                await finishCleared(items, 'empty-grace'); // items === []
                return;
              }
              // keep polling — give the user time to clear a cookie/login wall.
            }
          }
        } else if (noChallenge && !probe.consentVisible && probe.textLength > READINESS.BODY_TEXT_GATE) {
          // ── No extractor (login / API source): fall back to the body-text
          // heuristic — there's no item count to stabilize on. A consent wall
          // gates this too (don't auto-close a login window mid cookie-accept).
          extractOutcome = 'no-extractor';
          await finishCleared(null, 'body-text');
          return;
        }

        const now = Date.now();
        if (now - lastHeartbeatLog > AUTH_HEARTBEAT_LOG_MS) {
          lastHeartbeatLog = now;
          // Include the matching widgets / settle progress so future bug
          // reports show the exact cause instead of just "stillBlocked".
          const reason = probe.hits.length > 0
            ? `visible challenge widgets: [${probe.hits.join(', ')}]`
            : probe.consentVisible
              ? `cookie-consent wall up — waiting for the user to accept/dismiss (not closing as empty)`
              : (inlineExtractorJS
                  ? (lastExtractCount > 0
                      ? `no widgets; extractor at ${lastExtractCount} item(s), waiting for count to settle`
                      : `no widgets; 0 items so far — holding the window open up to ${RESOLVE_EMPTY_GRACE_MS / 1000}s for the user to clear a cookie/login wall before concluding empty`)
                  : `no widgets but textLen=${probe.textLength} below 1500 threshold`);
          logger.info(`[StealthBrowser] Captcha wait: host=${currentHost} — ${reason}`);
        }
      } catch {
        // Page navigation mid-evaluate is fine; next tick retries.
      }
    };

    // Fire one probe immediately so a captcha-free page is detected on the
    // first tick (saves up to POLL_INTERVAL_MS of perceived latency for the
    // common "page never had a captcha for this visible session" case).
    runProbe();
    autoClosePoll = setInterval(runProbe, POLL_INTERVAL_MS);

    autoCloseTimeout = setTimeout(() => {
      if (autoClosePoll) { clearInterval(autoClosePoll); autoClosePoll = null; }
      pollTimedOut = true;
      logger.info(`[StealthBrowser] Captcha resolve window hit ${AUTO_CLOSE_AFTER_MS / 1000}s timeout without auto-detect`);
    }, AUTO_CLOSE_AFTER_MS);

    // Mirror openLoginWindow's macOS X-button handling so closing the
    // last page actually tears down the Chrome process.
    captchaBrowser.on('targetdestroyed', async (target) => {
      if (isTerminated) return;
      if (target.type?.() !== 'page') return;
      try {
        const remaining = await captchaBrowser.pages();
        if (remaining.length === 0) {
          await captchaBrowser.close().catch(() => {});
        }
      } catch { /* tearing down */ }
    });

    // Honor an external abort signal — e.g. the hub's reset/cancel calls
    // cancelNodeTask(hubId), and abortNodeTasks() aborts the AbortController
    // tied to this IPC. Without this listener the puppeteer window kept
    // running until the user closed it manually, leaving an orphaned Chrome
    // process tied to no in-canvas state.
    const onAbort = () => {
      logger.info(`[StealthBrowser] Captcha resolve window aborted externally — closing`);
      captchaBrowser.close().catch(() => {});
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = async () => {
      if (isTerminated) return;
      isTerminated = true;
      if (autoClosePoll) { clearInterval(autoClosePoll); autoClosePoll = null; }
      if (autoCloseTimeout) { clearTimeout(autoCloseTimeout); autoCloseTimeout = null; }
      if (signal) signal.removeEventListener?.('abort', onAbort);
      if (sender) sender.removeListener('destroyed', cleanup);
      try { await captchaBrowser.close(); } catch { /* ignored */ }
      // `resolved` distinguishes "auto-detected cleared" from "user closed
      // manually." `items` is the inline-extracted comp data captured from
      // the visible session before close — when present, caller skips the
      // headless rescrape (which would re-trigger the same bot wall).
      // `diag` carries the "why" for the bug report's resolve section (how the
      // window closed, what the extractor saw, page state) so a 0-extract isn't
      // an unexplained dead end — see openCaptchaResolveWindow's diag vars.
      const closeReason = resolved ? (autoCloseReason || 'cleared')
        : siteChangedError ? 'site-changed-auto-close'
        : signal?.aborted ? 'aborted'
        : sender?.isDestroyed?.() ? 'app-closed'
        : pollTimedOut ? 'user-closed-after-timeout'
        : 'user-closed';
      resolve({
        success: true, resolved, items: extractedItems,
        siteChangedError: siteChangedError || null,
        closedByApp: sender?.isDestroyed?.(),
        diag: {
          closeReason,
          extractOutcome: extractOutcome || (inlineExtractorJS ? 'never-extracted' : 'no-extractor'),
          finalHost: lastHost,
          sawChallenge: everSawChallenge,
          sawConsent: everSawConsent,
          textLen: lastTextLen,
        },
      });
    };

    if (sender) {
      if (sender.isDestroyed()) { cleanup(); return; }
      sender.once('destroyed', cleanup);
    }

    captchaBrowser.on('disconnected', cleanup);
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

    try {
      // Check cookies for this domain
      const cookies = await page.cookies(...domains.map(d => `https://${d.replace(/^\./, '')}`));

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
    } finally {
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
    }
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
