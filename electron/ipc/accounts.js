/**
 * Accounts IPC handlers — platform login, session management.
 * Opens visible browser windows for login and checks cookie health.
 */
import fs from 'fs';
import path from 'path';
import { handleSafe } from './ipcUtils.js';
import { logger } from '../logger.js';
import {
  openLoginWindow,
  getSessionStatus,
  getAllSessionStatuses,
  getSupportedPlatforms,
  getSellMonitorPlatforms,
  getSellMonitorConfig,
  getJobLoginPlatforms,
  getJobLoginConfig,
  fetchHtmlClean,
} from './stealthBrowser.js';
import { detectAntiBotSignal } from './antiBotDetector.js';

// Timeout for a session-verify page fetch. Not a freshness/density signal —
// it's an auth-check network bound (fixed).
const SESSION_VERIFY_TIMEOUT_MS = 25000;
const DEFAULT_SOFT_WALL_SIGNALS = [
  'sign in to your account',
  'sign in to ebay',
  'sign in to continue',
  'please sign in',
  'log in to your account',
  'log in to continue',
  'enter your email or username',
  'enter your password',
];

// ── Session status in-memory cache ───────────────────────────────────────────
// Pure in-memory: starts empty each launch, populated by verifyAllPlatforms on
// startup and by writeStatusCache after each login flow. No disk persistence —
// every startup does a fresh verify so a stale file would only add noise.
let _statusCache = {};

export async function readStatusCache() {
  return _statusCache;
}

export function getStatusCacheSync() {
  return _statusCache;
}

/** True only when a verifier positively established that the session is out. */
export function isConfirmedDisconnectedVerdict(verdict) {
  return verdict?.connected === false && verdict?.inconclusive !== true;
}

/**
 * Returns { connected, reason, trace } where trace is a diagnostic record
 * the cache persists (target URL, final URL, status, body-sniff result).
 * The trace is what the bug report surfaces when "I just logged in but the
 * pill still says Log in" — without it the verifier is a black box.
 * Inconclusive transport failures are explicitly not confirmed disconnects;
 * callers should use isConfirmedDisconnectedVerdict before gating work.
 */
export async function verifySellMonitorLogin(platformId) {
  // Outer try/catch so any unforeseen exception (Chrome failed to launch,
  // module import error, network stack panic) becomes a verdict instead
  // of bubbling up. Without this, the open-login-window handler's catch
  // returns `{ success: false }` and writeStatusCache is never called,
  // leaving a stale cache entry and an opaque renderer toast.
  try {
    const config = getSellMonitorConfig(platformId) || getJobLoginConfig(platformId);
    // Prefer verifyUrls / verifyUrl (universal logged-in pages like /my/account)
    // over sellerUrl. Some job boards split auth by host, so a profile URL can
    // look connected while the job-search host is logged out.
    const targets = Array.isArray(config?.verifyUrls) && config.verifyUrls.length > 0
      ? config.verifyUrls
      : [config?.verifyUrl || config?.sellerUrl].filter(Boolean);
    if (targets.length === 0) {
      return { connected: false, reason: 'No verify URL configured for this platform.', trace: { target: null } };
    }
    const traces = [];

    for (const target of targets) {
      logger.info(`[Accounts] Verifying ${platformId} login via ${target}`);
      let r;
      try {
        // fetchHtmlClean (not fetchHtmlAuthed) — the latter installs request
        // interception that aborts every image, which marketplaces' anti-bot
        // systems flag and respond to with a login wall even for fully-
        // authenticated sessions. The clean path uses the same persistent
        // cookies but loads images normally so eBay/etc don't fingerprint us
        // as a bot.
        r = await fetchHtmlClean(target, { timeoutMs: config?.verifyTimeoutMs || SESSION_VERIFY_TIMEOUT_MS });
      } catch (e) {
        // We never got a readable page (the fetch threw — e.g. a `page.content()
        // timed out` anti-bot reload loop). That is NOT proof of logout, so mark
        // the verdict `inconclusive`: callers must keep the prior session status
        // and not flip the pill / card to "needs login" off a transient failure.
        const trace = { target, error: e?.message || String(e) };
        return { connected: false, inconclusive: true, reason: `Verification fetch failed: ${e?.message || String(e)}`, trace: { target, checks: [...traces, trace] } };
      }
      if (!r.ok) {
        // Fetcher returned an error shape rather than a page — same transient,
        // inconclusive class as the thrown case above (see comment there).
        const trace = { target, error: r.error };
        return { connected: false, inconclusive: true, reason: `Verification fetch error: ${r.error}`, trace: { target, checks: [...traces, trace] } };
      }

      const visibleText = stripTags(r.html || '');
      const trace = {
        target,
        finalUrl: r.finalUrl,
        status: r.status,
        htmlBytes: r.html?.length || 0,
        bodyHead: visibleText.slice(0, 300),
      };
      traces.push(trace);
      const finalUrlLower = String(r.finalUrl || '').toLowerCase();
      const antiBot = detectAntiBotSignal({
        status: r.status,
        finalUrl: r.finalUrl,
        html: r.html,
        sourceLabel: config?.name || platformId,
      });

      if (r.status === 401 || r.status === 403) {
        // Record anti-bot signal in the trace for diagnostics, but do NOT
        // use cookie presence to override a 401/403 as "connected". A CF/bot
        // challenge on the verify URL means we cannot confirm the session is
        // live — stale cookies satisfy session?.connected just as well as fresh
        // ones. Return not-connected; the caller will open a fresh login window.
        if (antiBot) {
          const session = await getSessionStatus(platformId).catch(() => ({ connected: false, cookieCount: 0 }));
          trace.antiBot = antiBot.code;
          trace.sessionCookieHeuristic = !!session?.connected;
          trace.sessionCookieCount = session?.cookieCount || 0;
        }
        return { connected: false, reason: `Auth wall at ${target} (HTTP ${r.status}) — not logged in.`, trace: { target, checks: traces } };
      }
      // 404 on a "logged-in-only" page gives no signal — the URL may have been
      // renamed/removed on the platform's side, making it return 404 for everyone
      // (both logged-in and anonymous). Accepting it as "connected" would mask
      // expired cookies permanently. Treat as unverifiable rather than connected.
      if (r.status === 404) {
        return { connected: false, reason: `Verify URL returned 404 at ${target} — the URL may have changed on the platform's side. Update verifyUrl in JOB_LOGIN_PLATFORMS / SELL_MONITOR_PLATFORMS.`, trace: { target, checks: traces } };
      }
      if (/\/(login|signin|sign-in|account\/login|auth)/i.test(finalUrlLower)) {
        return { connected: false, reason: `Redirected to ${r.finalUrl} — login not completed.`, trace: { target, checks: traces } };
      }

      // Platform-specific redirect guard: some platforms redirect anonymous users
      // to a public page (200 OK, no /login in URL) rather than to a login URL.
      // connectedFinalUrlMustContain lets the platform config specify a path
      // fragment that the final URL must contain; absence means not logged in.
      if (config?.connectedFinalUrlMustContain) {
        const mustContain = config.connectedFinalUrlMustContain.toLowerCase();
        if (!finalUrlLower.includes(mustContain)) {
          return { connected: false, reason: `Redirected to ${r.finalUrl} — expected URL to contain "${config.connectedFinalUrlMustContain}" for a logged-in session.`, trace: { target, checks: traces } };
        }
      }

      const matched = getSoftLoginWallMatch(visibleText, config);
      if (matched) {
        trace.softWallMatch = matched;
        return { connected: false, reason: `Page body looks logged out at ${target} ("${matched}") despite URL ${r.finalUrl}.`, trace: { target, checks: traces } };
      }
    }

    const lastTrace = traces[traces.length - 1];
    return {
      connected: true,
      reason: `Reached ${targets.length} verify URL(s); last ${lastTrace.finalUrl} (HTTP ${lastTrace.status}) without auth redirect or sign-in body.`,
      trace: { target: targets[0], checks: traces, finalUrl: lastTrace.finalUrl, status: lastTrace.status, htmlBytes: lastTrace.htmlBytes, bodyHead: lastTrace.bodyHead },
    };
  } catch (e) {
    logger.error(`[Accounts] verifySellMonitorLogin unexpected error for ${platformId}:`, e);
    return {
      connected: false,
      inconclusive: true, // an unforeseen throw is not evidence of logout — keep prior status
      reason: `Unexpected verifier error: ${e?.message || String(e)}`,
      trace: { error: e?.message || String(e), stack: e?.stack?.slice(0, 600) },
    };
  }
}

// Cheap tag stripper for the body sniff. Not a full HTML parser — we only
// need the first few hundred chars of visible text for the sign-in regex.
function stripTags(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getSoftLoginWallMatch(visibleText, config = {}) {
  // Body-content sniff — catches "soft" login walls where the response is
  // 200 OK with the original URL but the body is actually a sign-in form.
  // Looks for high-signal phrases in a configurable visible-text prefix,
  // scoped to avoid false positives from nav chrome unless the platform opts in.
  const scanChars = config?.bodyScanChars || 300;
  const head = String(visibleText || '').slice(0, scanChars).toLowerCase();
  const softWallSignals = [
    ...DEFAULT_SOFT_WALL_SIGNALS,
    ...(config?.bodySignals || []),
  ].map(s => String(s || '').toLowerCase());
  return softWallSignals.find(s => s && head.includes(s)) || null;
}

export async function writeStatusCache(platformId, connected, extras = {}) {
  _statusCache[platformId] = { connected, ts: Date.now(), ...extras };
}

function isTrustedNativeLoginResult(platformId, result) {
  const currentUrl = String(result?.currentUrl || '').toLowerCase();
  if (!result?.nativeChrome || result?.result !== 'auto-detected') return false;
  if (platformId !== 'indeed') return false;
  return currentUrl.includes('https://www.indeed.com/jobs');
}

function buildTrustedNativeLoginVerdict(platformId, result) {
  return {
    connected: true,
    reason: `Native Chrome reached logged-in ${platformId} job-search page at ${result.currentUrl}.`,
    trace: {
      target: result.currentUrl,
      nativeChrome: true,
      // Lift finalUrl + status to the top level so the bug-report session table
      // (renderSessionRows reads lastTrace.status / .finalUrl) sees the
      // auto-detected marker and suppresses the bogus "redirected to undefined"
      // mismatch — mirrors the HTTP-verify trace shape (see verifySession).
      finalUrl: result.currentUrl,
      status: 'auto-detected',
      checks: [{
        target: 'native-chrome-login-window',
        finalUrl: result.currentUrl,
        title: result.title || '',
        status: 'auto-detected',
      }],
    },
  };
}

// Puppeteer login window confirmed login via DOM/cookie/auth-gated-URL signal.
// Skip the HTTP re-verify — Cloudflare challenges the verify URL on new browser
// sessions even when the session is genuinely live, causing false "not connected"
// verdicts immediately after a successful login.
function isTrustedPuppeteerLoginResult(result) {
  return result?.loginDetected === true && !!result?.loginUrl;
}

function buildTrustedPuppeteerLoginVerdict(platformId, result) {
  return {
    connected: true,
    reason: `Auto-detected logged-in state for ${platformId} at ${result.loginUrl} (DOM/cookie/auth-gated signal) — HTTP re-verify skipped.`,
    trace: {
      target: result.loginUrl,
      // Top-level finalUrl + status so the bug-report session table sees the
      // auto-detected marker (see buildTrustedNativeLoginVerdict for why).
      finalUrl: result.loginUrl,
      status: 'auto-detected',
      checks: [{
        target: 'puppeteer-login-window',
        finalUrl: result.loginUrl,
        status: 'auto-detected',
      }],
    },
  };
}

// ── Startup verification ──────────────────────────────────────────────────────
// Verifies ALL known platforms on every launch. Cache starts empty, so there's
// nothing to trust — every startup is a clean check. Pushes progress events to
// the renderer via the notify callback so hub nodes can block drops until their
// relevant platforms are confirmed.
//
// Runs with a bounded-concurrency pool, NOT sequentially. The earlier sequential
// loop existed to "avoid racing Chrome instances on the shared userDataDir" — but
// that hazard doesn't apply here: verifySellMonitorLogin → fetchHtmlClean opens a
// TAB in the one shared stealth browser (browser.newPage()), not a new Chrome
// process, so there's no second process to race the profile lock. And every
// platform is a DISTINCT domain, so concurrency never makes a single site see two
// simultaneous hits — the per-site anti-bot concern is nil. Concurrency therefore
// only costs local CPU/RAM/network, which the pool size below bounds. This cuts a
// ~10-platform startup verify from ~66s (sum of per-platform nav times) to roughly
// the slowest-few-in-a-lane wall time (~15-20s).
const VERIFY_CONCURRENCY = 4;
// Hard per-platform backstop for the startup verify. A normal verify is already
// bounded by SESSION_VERIFY_TIMEOUT_MS inside fetchHtmlClean, but if anything in
// that chain wedges below the navigation timeout (a Cloudflare reload-loop that
// hangs page.content(), a stuck newPage, etc.) the worker would never settle and
// Promise.all(workers) would hang forever — leaving the UI stuck on "checking
// connections." This race guarantees every platform resolves so the pool drains.
const VERIFY_HARD_TIMEOUT_MS = SESSION_VERIFY_TIMEOUT_MS + 10000; // 35s
let _verifyingPlatforms = new Set();

// One record per startup verify run, surfaced by the bug report so "why is login
// verification slow?" is answerable from explicit per-platform durations instead
// of by hand-subtracting interleaved main-process log timestamps (which the
// concurrent pool above makes unreadable anyway).
let _lastVerifyRun = null;
export function getVerifyTimingSummary() {
  return _lastVerifyRun;
}

export async function verifyAllPlatforms({ notify = () => {} } = {}) {
  const sellIds = getSellMonitorPlatforms().map(p => p.id);
  const jobIds  = getJobLoginPlatforms().map(p => p.id);
  const allIds  = [...sellIds, ...jobIds];

  _verifyingPlatforms = new Set(allIds);
  notify('accounts:verify-start', { platformIds: allIds });
  logger.info(`[Accounts] Startup verify: ${allIds.length} platforms (${allIds.join(', ')}), concurrency ${VERIFY_CONCURRENCY}`);

  const runStartedAt = Date.now();
  const durations = [];

  const verifyOne = async (platformId) => {
    if (activeLoginFlows.has(platformId)) {
      logger.info(`[Accounts] Startup verify skipping ${platformId} — login flow in flight`);
      _verifyingPlatforms.delete(platformId);
      notify('accounts:verify-update', { platformId, connected: _statusCache[platformId]?.connected ?? false });
      durations.push({ platformId, ms: 0, connected: _statusCache[platformId]?.connected ?? false, skipped: true });
      return;
    }
    const startedAt = Date.now();
    try {
      // Wrap in a hard timeout so one wedged platform can't stall the whole verify
      // (see VERIFY_HARD_TIMEOUT_MS). On timeout this rejects → the catch below
      // records it as not-connected and the worker moves on.
      let hardTimer;
      const verdict = await Promise.race([
        verifySellMonitorLogin(platformId),
        new Promise((_, reject) => { hardTimer = setTimeout(
          () => reject(new Error(`verify exceeded ${VERIFY_HARD_TIMEOUT_MS}ms hard timeout — a page navigation likely wedged (anti-bot reload loop)`)),
          VERIFY_HARD_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(hardTimer));
      const ms = Date.now() - startedAt;
      // Don't cache a not-connected verdict that's really a browser TEARDOWN: if the
      // user opens a login/captcha window mid-verify, closeStealthBrowser() kills
      // this verify tab and verifySellMonitorLogin returns connected:false with a
      // "target/session closed" reason. Caching that flashes a false "not connected";
      // skip the write so the prior status stands and the next verify re-checks.
      const closedRe = /target closed|session closed|connection closed|browser (?:has )?disconnected|protocol error/i;
      const browserKilled = !verdict.connected &&
        (closedRe.test(verdict.reason || '') || closedRe.test(verdict.trace?.error || ''));
      // An inconclusive verdict (the verify fetch timed out / errored before we
      // could read the page — e.g. an anti-bot reload loop) is, like a browser
      // teardown, NOT proof of logout. Keep the prior cached status instead of
      // caching a spurious not-connected that flips the pill to "Log in" and the
      // listing cards to needs-login.
      const keepPrior = browserKilled || (!verdict.connected && verdict.inconclusive);
      if (keepPrior) {
        const cause = browserKilled ? 'interrupted by browser teardown' : 'verify inconclusive (transient fetch failure)';
        logger.warn(`[Accounts] Startup verify ${platformId} ${cause} — keeping prior status, not caching spurious not-connected`);
      } else {
        await writeStatusCache(platformId, verdict.connected, { lastReason: verdict.reason, lastTrace: verdict.trace, verifyMs: ms });
      }
      durations.push({ platformId, ms, connected: keepPrior ? (_statusCache[platformId]?.connected ?? false) : verdict.connected });
      logger.info(`[Accounts] Startup verify ${platformId}: ${keepPrior ? 'kept prior status' : (verdict.connected ? 'connected' : 'not connected')} (${ms}ms)`);
    } catch (e) {
      const ms = Date.now() - startedAt;
      durations.push({ platformId, ms, connected: false, error: e?.message || String(e) });
      logger.warn(`[Accounts] Startup verify ${platformId} threw (${ms}ms):`, e?.message || String(e));
    }
    _verifyingPlatforms.delete(platformId);
    notify('accounts:verify-update', { platformId, connected: _statusCache[platformId]?.connected ?? false });
  };

  // Bounded-concurrency pool: a fixed number of workers drain a shared queue.
  // queue.shift() is atomic relative to the length check (no await between them),
  // so no platform is processed twice and none is dropped.
  const queue = [...allIds];
  const workers = Array.from({ length: Math.min(VERIFY_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      await verifyOne(queue.shift());
    }
  });
  await Promise.all(workers);

  const finishedAt = Date.now();
  _lastVerifyRun = {
    startedAt: runStartedAt,
    finishedAt,
    totalMs: finishedAt - runStartedAt,
    concurrency: VERIFY_CONCURRENCY,
    platformCount: allIds.length,
    durations: durations.sort((a, b) => b.ms - a.ms),
  };

  notify('accounts:verify-done', {});
  logger.info(`[Accounts] Startup verify complete (${_lastVerifyRun.totalMs}ms wall, concurrency ${VERIFY_CONCURRENCY})`);
}

// ── Single-flight login dedup ────────────────────────────────────────────────
// Rapid Log-in clicks (or a Log-in click while a prior verify is still
// running) used to spawn a second puppeteer process on the same userDataDir
// → Chrome's single-process profile lock → "browser is already running"
// error AND a "Target closed" race that killed the in-flight verify's page.
//
// Fix: dedupe by platformId. If a login flow (window + verify) is already
// in flight, subsequent IPC calls await the same promise instead of
// starting a new one. New flows only start once the prior one fully
// settles (window closed + verify cached).
const activeLoginFlows = new Map(); // platformId → Promise<verdict>

/**
 * Register all Accounts IPC handlers.
 */
export function registerAccountsHandlers() {
  // Current verification state — renderer calls this on mount to sync with
  // whatever state the startup verify has already reached before the window loaded.
  handleSafe('get-verify-state', async () => {
    return {
      verifying: [..._verifyingPlatforms],
      statuses: Object.fromEntries(
        Object.entries(_statusCache).map(([id, v]) => [id, { connected: v.connected }])
      ),
    };
  });

  // Get CACHED session statuses — instant, no Chrome launch.
  // Use this for panel display. The full (Chrome-based) check is get-session-statuses.
  handleSafe('get-cached-session-statuses', async () => {
    const cache = await readStatusCache();
    const statuses = Object.entries(cache).map(([platform, v]) => ({
      platform, connected: v.connected,
    }));
    return { statuses };
  });

  // Get system config status (Gemini, USAJobs, etc)
  handleSafe('get-system-config-status', async () => {
    let hasGemini = !!process.env.GEMINI_API_KEY;
    if (!hasGemini) {
      try {
        const content = await fs.promises.readFile(path.join(process.cwd(), '.env'), 'utf8');
        // Use a start-of-line anchor so commented-out lines (e.g. #GEMINI_API_KEY=) aren't matched.
        hasGemini = /^GEMINI_API_KEY=/m.test(content);
      } catch { /* env file absent */ }
    }

    let hasServiceAccount = false;
    try {
      await fs.promises.stat(path.join(process.cwd(), 'service-account.json'));
      hasServiceAccount = true;
    } catch { /* stat fails if absent */ }

    return {
      config: {
        gemini:         { connected: hasGemini,          name: 'Gemini AI API' },
        serviceAccount: { connected: hasServiceAccount,  name: 'Google Cloud Service Account' },
      }
    };
  });

  // Get list of supported platforms
  handleSafe('get-platforms', async () => {
    return { platforms: getSupportedPlatforms() };
  });

  // Get connection status for all platforms
  handleSafe('get-session-statuses', async () => {
    try {
      const statuses = await getAllSessionStatuses();
      return { statuses };
    } catch (error) {
      logger.error('[Accounts] Failed to check sessions:', error?.message || String(error));
      return { statuses: [] };
    }
  });

  // Check session for a SINGLE platform (fast — no login prompt)
  handleSafe('check-platform-session', async (_event, { platformId }) => {
    try {
      return await getSessionStatus(platformId);
    } catch (error) {
      logger.error(`[Accounts] Session check failed for ${platformId}:`, error?.message || String(error));
      return { platform: platformId, connected: false };
    }
  });

  // Open a visible login window for a specific platform.
  //
  // After the window closes, navigate to the platform's seller URL in the
  // same persistent session and confirm we land somewhere that isn't a
  // login wall. Only then do we cache connected:true. The previous flow
  // optimistically cached on window-close regardless of whether the user
  // actually completed login — closing without signing in still got
  // marked as connected.
  handleSafe('open-login-window', async (_event, { platformId }) => {
    // Always open the login window — even when the cache says connected.
    // The cache-shortcut (re-verify silently, skip window) was removed because
    // stale cookies can make verifySellMonitorLogin return a false positive,
    // leaving the user with no way to force a fresh browser login from the UI.

    // Single-flight: if a login flow for this platform is already in flight
    // (window open OR verify running), return the same promise. Rapid double-
    // clicks no longer launch a second puppeteer process on the same
    // userDataDir, and a click during verify no longer races closeStealthBrowser
    // against the verify's in-flight page.goto.
    const existing = activeLoginFlows.get(platformId);
    if (existing) {
      logger.info(`[Accounts] Login flow already in flight for ${platformId} — deduping click`);
      return await existing;
    }

    const flow = (async () => {
      try {
        const result = await openLoginWindow(platformId, _event.sender);
        if (isTrustedNativeLoginResult(platformId, result)) {
          const verdict = buildTrustedNativeLoginVerdict(platformId, result);
          await writeStatusCache(platformId, true, { lastReason: verdict.reason, lastTrace: verdict.trace });
          logger.info(`[Accounts] ${platformId} native login verified: ${verdict.reason}`);
          return { ...(result || {}), connected: true, reason: verdict.reason };
        }
        if (isTrustedPuppeteerLoginResult(result)) {
          const verdict = buildTrustedPuppeteerLoginVerdict(platformId, result);
          await writeStatusCache(platformId, true, { lastReason: verdict.reason, lastTrace: verdict.trace });
          logger.info(`[Accounts] ${platformId} login auto-detected: ${verdict.reason}`);
          return { ...(result || {}), connected: true, reason: verdict.reason };
        }

        const verdict = await verifySellMonitorLogin(platformId);
        // An inconclusive verify (timed out / errored before reading the page)
        // right after the window closed is NOT proof the login failed — caching
        // not-connected here would bounce a just-logged-in user straight back to
        // "Log in". Keep the prior cached status instead (same rule as startup
        // verify) rather than overwriting a good session with a transient false.
        if (!verdict.connected && verdict.inconclusive) {
          const prior = _statusCache[platformId]?.connected ?? false;
          logger.warn(`[Accounts] ${platformId} post-login verify inconclusive (${verdict.reason}) — keeping prior status (${prior ? 'connected' : 'not connected'})`);
          return { ...(result || {}), connected: prior, reason: verdict.reason, inconclusive: true };
        }
        await writeStatusCache(platformId, verdict.connected, { lastReason: verdict.reason, lastTrace: verdict.trace });
        if (!verdict.connected) {
          logger.info(`[Accounts] ${platformId} login window closed without successful login: ${verdict.reason}`);
        } else {
          logger.info(`[Accounts] ${platformId} login verified: ${verdict.reason}`);
        }
        return { ...(result || {}), connected: verdict.connected, reason: verdict.reason };
      } catch (error) {
        // Catch path: openLoginWindow itself blew up (Chrome failed to launch,
        // platform unknown, etc.). Persist the failure into the cache and
        // return a structured verdict so the renderer's toast surfaces the
        // real error instead of the generic "closed without sign-in" fallback.
        // verifySellMonitorLogin is now defensive enough that we shouldn't
        // land here for verify-side issues — only loginBrowser launch issues.
        const msg = error?.message || String(error);
        logger.error(`[Accounts] Login window failed for ${platformId}:`, msg);
        const trace = { error: msg, stack: error?.stack?.slice(0, 600), stage: 'openLoginWindow' };
        await writeStatusCache(platformId, false, { lastReason: msg, lastTrace: trace });
        return { connected: false, reason: msg, error: msg };
      }
    })();

    activeLoginFlows.set(platformId, flow);
    try {
      return await flow;
    } finally {
      // Always clear so the next genuine click (after this flow fully settles
      // — window closed AND verify resolved) starts a fresh flow.
      activeLoginFlows.delete(platformId);
    }
  });

  // Check-and-login flow: check session → if not logged in, open login → verify
  // Returns { connected: boolean, platform: string, loginOpened: boolean }
  //
  // Both pre- and post-login checks use the disk cache + verifySellMonitorLogin
  // path — never the broken getSessionStatus cookie heuristic, which false-
  // positives on anonymous tracking cookies (see note on `check-sell-monitor-auth`).
  handleSafe('check-and-login', async (_event, { platformId }) => {
    // Step 1: Quick cache lookup. If we already have a positive verdict
    // from a prior verified login, trust it and skip Chrome entirely.
    const cache = await readStatusCache();
    if (cache[platformId]?.connected) {
      return { platform: platformId, connected: true, loginOpened: false };
    }

    // Share the dedup with open-login-window — if either handler has a flow
    // in flight for this platform, this call awaits it instead of starting
    // a parallel login + verify that would race on userDataDir.
    const existing = activeLoginFlows.get(platformId);
    if (existing) {
      logger.info(`[Accounts] check-and-login deduping to in-flight login for ${platformId}`);
      const result = await existing;
      return { platform: platformId, connected: !!result?.connected, loginOpened: true, reason: result?.reason };
    }

    const flow = (async () => {
    try {
      // Step 2: Not in cache — open login window (blocks until user closes it).
      logger.info(`[Accounts] ${platformId} not in verified-login cache — opening login window`);
      await openLoginWindow(platformId, _event.sender);

      // Step 3: Verify by hitting the seller URL via the same persistent
      // session. Cache the verdict either way so the next call short-circuits.
      const verdict = await verifySellMonitorLogin(platformId);
      await writeStatusCache(platformId, verdict.connected, { lastReason: verdict.reason, lastTrace: verdict.trace });

      if (_event.sender.isDestroyed()) {
        return { platform: platformId, connected: verdict.connected, loginOpened: true };
      }
      return { platform: platformId, connected: verdict.connected, loginOpened: true, reason: verdict.reason };
    } catch (error) {
      logger.error(`[Accounts] Check-and-login failed for ${platformId}:`, error?.message || String(error));
      return { platform: platformId, connected: false, loginOpened: false, error: error?.message || String(error) };
    }
    })();  // close the flow IIFE

    activeLoginFlows.set(platformId, flow);
    try {
      return await flow;
    } finally {
      activeLoginFlows.delete(platformId);
    }
  });

  // ── Sell Monitor Auth (moved from marketplace.js — these are auth concerns) ──

  // Returns which platforms need login for sell monitoring
  handleSafe('get-sell-platforms', async () => {
    return { platforms: getSellMonitorPlatforms() };
  });

  // Before sell monitoring: check if the user is logged into the platform.
  // Returns { platform, connected, name, sellerUrl }
  //
  // Truth source is the disk cache, populated only by a successful
  // openLoginWindow flow. The previous implementation called
  // getSessionStatus(), which matched any cookie whose name contains
  // 'session' / 'token' / 'auth' — that returned true on first visit for
  // most marketplaces because Mercari / eBay / etc. drop anonymous
  // tracking cookies with exactly those names. Users who'd never logged
  // in were shown as "Logged in." Now we only trust events the app
  // actually witnessed.
  handleSafe('check-sell-monitor-auth', async (_event, { platformId }) => {
    const config = getSellMonitorConfig(platformId);
    if (!config) {
      return { platform: platformId, connected: false, error: 'Unknown platform' };
    }
    const cache = await readStatusCache();
    const cached = cache[platformId];
    return {
      platform: platformId,
      connected: !!cached?.connected,
      lastConfirmedAt: cached?.ts || null,
      lastReason: cached?.lastReason || null,
      name: config.name,
      sellerUrl: config.sellerUrl,
    };
  });

  // ── Job Platform Auth ──────────────────────────────────────────────────────

  handleSafe('get-job-platforms', async () => {
    return { platforms: getJobLoginPlatforms() };
  });

  // Check whether the user is logged into a job platform.
  // Truth source is the disk cache (same as sell monitor auth).
  handleSafe('check-job-platform-auth', async (_event, { platformId }) => {
    const config = getJobLoginConfig(platformId);
    if (!config) return { platform: platformId, connected: false, error: 'Unknown platform' };
    const cache = await readStatusCache();
    const cached = cache[platformId];
    return {
      platform: platformId,
      connected: !!cached?.connected,
      lastConfirmedAt: cached?.ts || null,
      lastReason: cached?.lastReason || null,
      name: config.name,
    };
  });
}
