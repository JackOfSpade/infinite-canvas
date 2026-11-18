import { manualScraperTelemetry } from './scrapeState.js';
import { recordActivityBeat, isIgnorableManualBrowserTelemetry } from './scrapeTelemetry.js';
import { buildOverlayScript, updateOverlay as paintOverlay, overlayControlPage, overlayTabLayout } from '../scraperOverlay.js';
import { closeOwnedBrowserProcess, launchWithProfileLockRetry } from '../../stealthBrowser.js';
import { prepareBackgroundScrapeLaunchOptions, createBackgroundScrapePage } from '../backgroundScrapeBrowser.js';
import { humanDelay } from '../../../utils/humanDelay.js';

// ── Overlay ───────────────────────────────────────────────────────────────────
// Injected via evaluateOnNewDocument (runs before site JS on every new document)
// AND via an immediate page.evaluate after each URL navigation.
//
// State fields (filled by updateOverlay):
//   srcLabel, srcName, qLabel, qText — source/query identity
//   count — job count (integer)
//   status — current action text
//   challenge — boolean, turns dot amber
//   error — boolean, turns dot red and disables skip
//
// Pause button ON, CDP bridge OFF. page.exposeFunction installs a CDP
// Runtime.addBinding that anti-bots (DataDome on Wellfound) fingerprint, so the
// button only toggles the page-local window.__icPaused; the Node side reads it by
// POLLING (waitIfPaused) and re-asserts it after navigations (injectOverlay).
export const OVERLAY_SCRIPT = buildOverlayScript({ withPause: true });

/**
 * Paint the in-page overlay AND record that the scrape is alive.
 *
 * Every progress signal a user needs already existed at exactly the right
 * granularity — "Opening job 4 of 30 to read", "Extracting page 3…", "Loading more
 * jobs…" — but it was written only into the scraper's own Chrome window and
 * never left it. The app, the main-process log, and the bug report were all
 * blind to work happening on screen, so a healthy multi-minute Glassdoor
 * description walk (whose per-card loop emits telemetry ONLY on failure) was
 * indistinguishable from a wedged renderer. That ambiguity is what "processing
 * stuck" reports look like.
 *
 * Wrapping the imported painter rather than editing ~30 call sites means every
 * existing paint — present and future — becomes a heartbeat for free, and the
 * beat can never drift out of sync with what the window shows.
 */
export async function updateOverlay(page, state) {
  recordActivityBeat({ ...state, tabLayout: overlayTabLayout(page) });
  return paintOverlay(page, state);
}

export async function injectOverlay(page) {
  await page.evaluate(OVERLAY_SCRIPT).catch(() => {});
  // Re-assert Node-side pause state into the freshly (re)injected overlay. The
  // page-local window.__icPaused resets to false on every navigation; with no
  // __icGetPaused CDP bridge to pull it back, we push it from the Node side here.
  if (manualScraperTelemetry.paused) {
    await page.evaluate(() => {
      window.__icPaused = true;
      const b = document.getElementById('ic-pause');
      if (b) b.textContent = '▶ Resume';
      const d = document.getElementById('ic-dot');
      if (d) { d.style.background = '#eab308'; d.style.animation = 'none'; }
    }).catch(() => {});
  }
}

// Blocks until the user clicks Resume or the signal is aborted.
// Source of truth is the page-local window.__icPaused (toggled by the overlay's
// Pause button). We POLL it rather than receive a CDP callback — page.exposeFunction
// installs a Runtime.addBinding that anti-bots fingerprint. manualScraperTelemetry
// mirrors it so the rest of the code keeps a Node-side view.
// Returns 'ok' | 'abort'.
export async function waitIfPaused(page, signal) {
  while (true) {
    if (signal?.aborted) return 'abort';
    let paused = false;
    try { paused = await overlayControlPage(page).evaluate(() => !!window.__icPaused); } catch { /* page mid-navigation */ }
    manualScraperTelemetry.paused = paused;
    if (!paused) return 'ok';
    await new Promise(r => setTimeout(r, humanDelay(500)));
  }
}

/**
 * page.url() that cannot throw. A page torn down mid-walk (navigation, crash,
 * abort) makes url() throw, and a page-turn assertion must never be the thing
 * that kills a scrape.
 */
export function safePageUrl(page) {
  try { return page.url() || null; } catch { return null; }
}

// Stealth navigator/screen masking applied on every document of a page (main
// frame + iframes + post-navigation). Mirrors createStealthPage() in
// stealthBrowser.js — keeps the fingerprint coherent across the session.
export async function applyStealthMask(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver',           { get: () => false });
    Object.defineProperty(navigator, 'platform',            { get: () => 'MacIntel' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints',      { get: () => 0 });
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'rtt',           { get: () => 50 });
      Object.defineProperty(navigator.connection, 'downlink',      { get: () => 10 });
      Object.defineProperty(navigator.connection, 'effectiveType', { get: () => '4g' });
    }
  });
}

/**
 * Launch a fresh Chrome dedicated to ONE platform scrape: its own process, a
 * stealth-masked page, and all the console/network/overlay instrumentation the
 * scrape loop relies on. Each browser-based source gets a brand-new browser
 * (closed via teardown() before the next launches) so no single long-lived session
 * carries accumulated automation/anti-bot signal across platforms — e.g. Google,
 * scraped last, no longer inherits the "warmth" of indeed→ziprecruiter→glassdoor.
 * The persistent userDataDir is shared, so logins persist; only the process resets.
 *
 * `onCrash` fires only if the browser disconnects UNEXPECTEDLY (a real crash) — our
 * own teardown() suppresses it so closing between platforms doesn't abort the run.
 *
 * @returns {{ browser:object, page:object, navStatusRef:{last:number|null}, isClosed:()=>boolean, teardown:()=>Promise<void> }}
 */
export async function launchScrapePlatformBrowser({ userDataDir, executablePath, sandboxArgs, onCrash }) {
  const browser = await launchWithProfileLockRetry(prepareBackgroundScrapeLaunchOptions({
    headless: false,
    executablePath,
    userDataDir,
    // Strip --enable-automation (Puppeteer default) and disable the blink
    // AutomationControlled feature flag — the two most-checked automation signals.
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      ...sandboxArgs,
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,900',
      '--lang=en-US,en',
    ],
    defaultViewport: null,
    ignoreHTTPSErrors: true,
    // Do not let a Chromium launch wait forever while holding the FIFO. This is
    // Puppeteer's normal default made explicit so the bound is reviewable.
    timeout: 30_000,
  }), 'manual-browser-scrape');

  // Everything below, up to the overlay injection, runs against the browser we
  // just launched. The caller's `platform` bundle isn't assigned until this
  // function returns, so a throw here (protocol error, hung renderer right
  // after launch) would otherwise leave nothing holding a reference to close
  // it — the just-spawned Chrome leaks and keeps the shared userDataDir's
  // SingletonLock held for every source after this one.
  let page;
  const navStatusRef = { last: null };
  try {
    page = await createBackgroundScrapePage(browser, { width: 1280, height: 900 });
    await applyStealthMask(page);

    // Capture browser-side console errors/warnings for the bug report. Fires for all
    // frames (challenge-page + Turnstile frames included). error/warning only.
    page.on('console', msg => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      const loc = msg.location();
      if (isIgnorableManualBrowserTelemetry({ url: loc?.url || '', text: msg.text() })) return;
      manualScraperTelemetry.consoleLogs.push({
        ts: Date.now(),
        type,
        text: msg.text().slice(0, 300),
        url: (loc?.url || '').slice(0, 120),
        line: loc?.lineNumber ?? null,
      });
      if (manualScraperTelemetry.consoleLogs.length > 60) manualScraperTelemetry.consoleLogs.shift();
    });

    // Capture hard network failures (DNS, TCP, TLS, COEP, etc.)
    page.on('requestfailed', req => {
      const url = req.url();
      if (isIgnorableManualBrowserTelemetry({ url })) return;
      manualScraperTelemetry.networkErrors.push({
        ts: Date.now(),
        method: req.method(),
        url: url.slice(0, 200),
        status: null,
        errorText: req.failure()?.errorText || 'unknown',
      });
      if (manualScraperTelemetry.networkErrors.length > 30) manualScraperTelemetry.networkErrors.shift();
    });

    // Tracks the status code of the most recent main-frame document response — lets
    // the SITE_CHANGED branch tell "200 but selectors stale" from "403 block page".
    page.on('response', res => {
      const status = res.status();
      try {
        if (res.request().resourceType() === 'document' && res.frame() === page.mainFrame()) {
          navStatusRef.last = status;
        }
      } catch { /* frame may be detached on rapid navigations — skip */ }
      if (status < 400) return;
      const url = res.url();
      if (isIgnorableManualBrowserTelemetry({ url })) return;
      manualScraperTelemetry.networkErrors.push({
        ts: Date.now(),
        method: res.request().method(),
        url: url.slice(0, 200),
        status,
        errorText: null,
      });
      if (manualScraperTelemetry.networkErrors.length > 30) manualScraperTelemetry.networkErrors.shift();
    });

    // Inject overlay on every new document so it survives navigations
    await page.evaluateOnNewDocument(OVERLAY_SCRIPT);
  } catch (err) {
    await closeOwnedBrowserProcess(browser, { label: 'Manual browser setup', gracefulMs: 3_500 });
    throw err;
  }

  let closed = false;
  let intentional = false;
  // A bug report's "Scrape/stealth browser" line is derived from the
  // stealthBrowser singleton — which scrapeManualSources deliberately closes
  // before spawning THIS process on the same shared profile. Recording it here
  // is what stops a report from stating "not running (profile lock free)" while
  // a visible scrape Chrome holds that very profile.
  manualScraperTelemetry.browser = {
    running: true,
    launchedAt: Date.now(),
    executablePath: executablePath || null,
    profileDir: userDataDir || null,
    pid: browser.process()?.pid ?? null,
  };
  browser.on('disconnected', () => {
    closed = true;
    // The keep-alive below is declared after this handler, and the handler only runs later.
    clearInterval(overlayKeepAlive);
    if (manualScraperTelemetry.browser) {
      manualScraperTelemetry.browser = { ...manualScraperTelemetry.browser, running: false, closedAt: Date.now() };
    }
    if (!intentional) onCrash?.();
  });

  // Re-inject overlay after any navigation that kills it (CF blocks, redirects).
  // OVERLAY_SCRIPT is a no-op when the panel is already present; skips challenge pages.
  const overlayKeepAlive = setInterval(() => {
    if (closed) return;
    page.evaluate(() => {
      if (typeof window.INDEED_CLOUDFLARE_STATIC_PAGE !== 'undefined') return true;
      return !!document.getElementById('__ic-panel');
    }).then(exists => { if (!exists) page.evaluate(OVERLAY_SCRIPT).catch(() => {}); })
      .catch(() => {});
  }, 1500);

  return {
    browser,
    page,
    navStatusRef,
    isClosed: () => closed,
    teardown: async () => {
      intentional = true; // suppress onCrash for our own close
      clearInterval(overlayKeepAlive);
      // `disconnected` only means the CDP socket dropped; Chrome can still own
      // SingletonLock. Always run the owned-process close/wait path even if the
      // event handler already set `closed`.
      const closeResult = await closeOwnedBrowserProcess(browser, {
        label: 'Manual browser teardown', gracefulMs: 3_500,
      });
      closed = true;
      // Set here as well as in the 'disconnected' handler. The report claims the
      // shared profile lock is HELD while this reads running, so it must not
      // depend on an event that a failed/forced close might not deliver —
      // over-reporting a live browser would send a reader after a phantom lock.
      if (manualScraperTelemetry.browser) {
        manualScraperTelemetry.browser = {
          ...manualScraperTelemetry.browser,
          running: false,
          closedAt: Date.now(),
          processExitObserved: closeResult.exited,
          forcedTermination: closeResult.disposition === 'sigterm-exit' ? 'SIGTERM'
            : closeResult.disposition === 'sigkill-fallback' ? 'SIGKILL' : null,
        };
      }
    },
  };
}
