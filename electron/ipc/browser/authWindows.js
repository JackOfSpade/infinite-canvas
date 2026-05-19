import { logger } from '../../logger.js';
import puppeteer from 'puppeteer-extra';
import { getStealthBrowser, closeStealthBrowser, getUserDataDir, findChromePath } from '../stealthBrowser.js';

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

  // Launch a SEPARATE visible browser for login (now has exclusive access to userDataDir)
  const loginBrowser = await puppeteer.launch({
    headless: false,
    executablePath,
    userDataDir: await getUserDataDir(),
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

  const pages = await loginBrowser.pages();
  const page = pages[0] || await loginBrowser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

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
    const AUTO_CLOSE_AFTER_MS = 5 * 60 * 1000;
    const POLL_INTERVAL_MS = 500;

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
        if (now - lastHeartbeatLog > 10000) {
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
export async function openCaptchaResolveWindow(url, sender = null, signal = null, inlineExtractorJS = null) {
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
  // Safe because the probe below gates extract on textLength > 1500, which
  // is its own "page has real content" check.
  await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch(() => {});

  return new Promise((resolve) => {
    let isTerminated = false;
    let autoClosePoll = null;
    let autoCloseTimeout = null;
    let resolved = false; // true = challenge auto-detected as cleared

    // 400ms gives sub-second detection after a user solve without hammering
    // the page — page.evaluate is cheap but not free.
    const POLL_INTERVAL_MS = 400;
    const AUTO_CLOSE_AFTER_MS = 5 * 60 * 1000;
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
    let lastHeartbeatLog = 0;
    let firstProbeLogged = false;
    let extractedItems = null;

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

        const probe = await page.evaluate((selectors) => {
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
          const textLength = (document.body?.innerText || '').length;
          return { hits, textLength };
        }, CHALLENGE_SELECTORS).catch(() => null);

        if (!probe) return;

        // Log the FIRST probe so bug reports can tell "user solved fast"
        // from "captcha never appeared in this session." With only the 10s
        // heartbeat, a sub-10s resolve left zero diagnostic trail.
        if (!firstProbeLogged) {
          firstProbeLogged = true;
          const initial = probe.hits.length > 0
            ? `initial probe found visible challenge widgets: [${probe.hits.join(', ')}]`
            : `initial probe found NO challenge widgets (textLen=${probe.textLength}) — page may never have shown a captcha to this visible session even though headless scrape was blocked`;
          logger.info(`[StealthBrowser] Captcha wait: host=${currentHost} — ${initial}`);
        }

        // Resolved when no challenge widgets are visible AND the page has
        // substantive content (rules out a blank interstitial that strips
        // its widgets pre-content-load).
        const seemsResolved = probe.hits.length === 0 && probe.textLength > 1500;
        if (seemsResolved) {
          // Run the inline extractor (if provided) in this same browser
          // session BEFORE closing. This is the whole point of the inline
          // path: the visible session passed the anti-bot check, so it can
          // see the real content; a headless re-scrape after close would
          // re-trigger the same wall. Items returned ride alongside the
          // `resolved` flag and skip the rescrape on the renderer side.
          if (inlineExtractorJS) {
            try {
              const items = await page.evaluate(inlineExtractorJS);
              if (Array.isArray(items)) {
                extractedItems = items;
                logger.info(`[StealthBrowser] Inline extract on ${currentHost} → ${items.length} item(s) (skipping headless rescrape)`);
              } else {
                logger.warn(`[StealthBrowser] Inline extract returned non-array (${typeof items}); falling back to rescrape`);
              }
            } catch (e) {
              logger.warn(`[StealthBrowser] Inline extract failed (${e?.message || e}); falling back to rescrape`);
            }
          }
          logger.info(`[StealthBrowser] Captcha auto-detected as cleared on ${currentHost} (no visible challenge widgets, textLen=${probe.textLength}) — closing window`);
          resolved = true;
          if (autoClosePoll) { clearInterval(autoClosePoll); autoClosePoll = null; }
          if (autoCloseTimeout) { clearTimeout(autoCloseTimeout); autoCloseTimeout = null; }
          await captchaBrowser.close().catch(() => {});
          return;
        }

        const now = Date.now();
        if (now - lastHeartbeatLog > 10000) {
          lastHeartbeatLog = now;
          // Include which widgets are matching so future bug reports show
          // the exact false-positive cause instead of just "stillBlocked".
          const reason = probe.hits.length > 0
            ? `visible challenge widgets: [${probe.hits.join(', ')}]`
            : `no widgets but textLen=${probe.textLength} below 1500 threshold`;
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
      resolve({ success: true, resolved, items: extractedItems, closedByApp: sender?.isDestroyed?.() });
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
