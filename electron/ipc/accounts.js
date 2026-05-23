/**
 * Accounts IPC handlers — platform login, session management.
 * Opens visible browser windows for login and checks cookie health.
 */
import electronPkg from 'electron';
const { app } = electronPkg;
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

// Timeout for a session-verify page fetch. Not a freshness/density signal —
// it's an auth-check network bound (fixed, like STALE_SESSION_TTL_MS below).
const SESSION_VERIFY_TIMEOUT_MS = 25000;

// ── Session status disk cache ─────────────────────────────────────────────────────────
// Avoids launching Chrome just to display status on panel open.
// In-memory copy is the single source of truth during the process lifetime;
// disk is the persistence layer between sessions.
let _statusCache = null;

// Resolved lazily on first access (after app is ready and getPath is available).
let _statusCachePath = null;
function getStatusCachePath() {
  if (!_statusCachePath) _statusCachePath = path.join(app.getPath('userData'), 'session-status-cache.json');
  return _statusCachePath;
}
export async function readStatusCache() {
  if (_statusCache) return _statusCache;
  try {
    const p = getStatusCachePath();
    const data = await fs.promises.readFile(p, 'utf8').catch(() => null);
    if (!data) { _statusCache = {}; return _statusCache; }
    _statusCache = JSON.parse(data);
    return _statusCache;
  } catch { _statusCache = {}; return _statusCache; }
}
/**
 * After the login window closes, verify the user actually completed login
 * by hitting the platform's seller URL with the same persistent userDataDir
 * cookies. If the response 4xxs or redirects to /login etc., we know the
 * user closed the window without finishing — and we should NOT cache
 * connected:true.
 *
 * Returns { connected, reason } so callers can surface a meaningful message
 * ("redirected to login" vs "server error vs verifying") rather than just a
 * bare boolean.
 */
/**
 * Returns { connected, reason, trace } where trace is a diagnostic record
 * the cache persists (target URL, final URL, status, body-sniff result).
 * The trace is what the bug report surfaces when "I just logged in but the
 * pill still says Log in" — without it the verifier is a black box.
 */
export async function verifySellMonitorLogin(platformId) {
  // Outer try/catch so any unforeseen exception (Chrome failed to launch,
  // module import error, network stack panic) becomes a verdict instead
  // of bubbling up. Without this, the open-login-window handler's catch
  // returns `{ success: false }` and writeStatusCache is never called,
  // leaving a stale cache entry and an opaque renderer toast.
  try {
    const config = getSellMonitorConfig(platformId) || getJobLoginConfig(platformId);
    // Prefer verifyUrl (universal logged-in page like /my/account) over
    // sellerUrl (seller-specific, may redirect non-seller accounts through
    // signin.* hosts that trip our login-redirect regex). Falls back to
    // sellerUrl when verifyUrl isn't set for backward compat.
    const target = config?.verifyUrl || config?.sellerUrl;
    if (!target) {
      return { connected: false, reason: 'No verify URL configured for this platform.', trace: { target: null } };
    }
    logger.info(`[Accounts] Verifying ${platformId} login via ${target}`);
    let r;
    try {
      // fetchHtmlClean (not fetchHtmlAuthed) — the latter installs request
      // interception that aborts every image, which marketplaces' anti-bot
      // systems flag and respond to with a login wall even for fully-
      // authenticated sessions. The clean path uses the same persistent
      // cookies but loads images normally so eBay/etc don't fingerprint us
      // as a bot.
      r = await fetchHtmlClean(target, { timeoutMs: SESSION_VERIFY_TIMEOUT_MS });
    } catch (e) {
      const trace = { target, error: e?.message || String(e) };
      return { connected: false, reason: `Verification fetch failed: ${e?.message || String(e)}`, trace };
    }
    if (!r.ok) {
      const trace = { target, error: r.error };
      return { connected: false, reason: `Verification fetch error: ${r.error}`, trace };
    }

    const trace = {
      target,
      finalUrl: r.finalUrl,
      status: r.status,
      htmlBytes: r.html?.length || 0,
      bodyHead: stripTags(r.html || '').slice(0, 300),
    };

    if (r.status === 401 || r.status === 403) {
      return { connected: false, reason: `Auth wall (HTTP ${r.status}) — not logged in.`, trace };
    }
    // 404 on a "logged-in-only" page gives no signal — the URL may have been
    // renamed/removed on the platform's side, making it return 404 for everyone
    // (both logged-in and anonymous). Accepting it as "connected" would mask
    // expired cookies permanently. Treat as unverifiable rather than connected.
    if (r.status === 404) {
      return { connected: false, reason: `Verify URL returned 404 — the URL may have changed on the platform's side. Update verifyUrl in JOB_LOGIN_PLATFORMS / SELL_MONITOR_PLATFORMS.`, trace };
    }
    const finalUrlLower = String(r.finalUrl || '').toLowerCase();
    if (/\/(login|signin|sign-in|account\/login|auth)/i.test(finalUrlLower)) {
      return { connected: false, reason: `Redirected to ${r.finalUrl} — login not completed.`, trace };
    }

    // Platform-specific redirect guard: some platforms redirect anonymous users
    // to a public page (200 OK, no /login in URL) rather than to a login URL.
    // connectedFinalUrlMustContain lets the platform config specify a path
    // fragment that the final URL must contain; absence means not logged in.
    if (config?.connectedFinalUrlMustContain) {
      const mustContain = config.connectedFinalUrlMustContain.toLowerCase();
      if (!finalUrlLower.includes(mustContain)) {
        return { connected: false, reason: `Redirected to ${r.finalUrl} — expected URL to contain "${config.connectedFinalUrlMustContain}" for a logged-in session.`, trace };
      }
    }

    // Body-content sniff — catches "soft" login walls where the response is
    // 200 OK with the original URL but the body is actually a sign-in form
    // (eBay does this when anti-bot kicks in). Looks for high-signal phrases
    // in the first chunk of stripped text, scoped to avoid false positives
    // from a stray "Sign in" link in nav chrome.
    const head = trace.bodyHead.toLowerCase();
    const softWallSignals = [
      'sign in to your account',
      'sign in to ebay',
      'sign in to continue',
      'please sign in',
      'log in to your account',
      'log in to continue',
      'enter your email or username',
      'enter your password',
      // Platform-specific signals merged from platform config
      ...(config?.bodySignals || []),
    ];
    const matched = softWallSignals.find(s => head.includes(s));
    if (matched) {
      trace.softWallMatch = matched;
      return { connected: false, reason: `Page body looks like a sign-in form ("${matched}") despite URL ${r.finalUrl} — likely anti-bot challenge.`, trace };
    }

    return { connected: true, reason: `Reached ${r.finalUrl} (HTTP ${r.status}) without auth redirect or sign-in body.`, trace };
  } catch (e) {
    logger.error(`[Accounts] verifySellMonitorLogin unexpected error for ${platformId}:`, e);
    return {
      connected: false,
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

export async function writeStatusCache(platformId, connected, extras = {}) {
  try {
    const cache = await readStatusCache(); // returns the in-memory object
    cache[platformId] = { connected, ts: Date.now(), ...extras };
    // Atomic write: write to a .tmp sibling then rename, so a crash during
    // the write never leaves a partially-written (corrupt) JSON file.
    const finalPath = getStatusCachePath();
    const tmpPath   = finalPath + '.tmp';
    await fs.promises.writeFile(tmpPath, JSON.stringify(cache));
    await fs.promises.rename(tmpPath, finalPath);
  } catch (e) {
    logger.warn('[Accounts] Cache write failed:', e?.message || String(e));
  }
}

// ── Background revalidation ─────────────────────────────────────────────────
// On app start, walk the cache and re-verify any `connected: true` entries
// older than the TTL. Catches platforms whose cookies expired since last open
// so the user doesn't see a stale "Logged in" pill that then fails at scrape
// time. Runs sequentially in the background; transient errors (Chrome busy,
// stealth browser torn down by an unrelated user click) DO NOT downgrade the
// cache — only a real verdict from the verifier overwrites a cached value.
const STALE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function revalidateStaleSessions({ maxAgeMs = STALE_SESSION_TTL_MS } = {}) {
  try {
    const cache = await readStatusCache();
    const now = Date.now();
    const stale = Object.entries(cache)
      .filter(([, v]) => v?.connected && (now - (v.ts || 0) > maxAgeMs))
      .map(([platformId]) => platformId);
    if (!stale.length) {
      logger.info('[Accounts] Background revalidate: no stale connected sessions');
      return;
    }
    logger.info(`[Accounts] Background revalidate: ${stale.length} stale connected entries (${stale.join(', ')})`);
    for (const platformId of stale) {
      // Skip platforms with an active login flow — the user is already
      // interacting with them, and our verify would race their window's
      // close/verify cycle on the shared userDataDir.
      if (activeLoginFlows.has(platformId)) {
        logger.info(`[Accounts] Background revalidate skipping ${platformId} — login flow in flight`);
        continue;
      }
      try {
        const verdict = await verifySellMonitorLogin(platformId);
        if (verdict.trace?.error) {
          // Transient (network blip, browser torn down mid-fetch). Don't
          // overwrite — wait for the next app open or a real user click.
          logger.info(`[Accounts] Background revalidate ${platformId} transient error — keeping cached value: ${verdict.reason}`);
          continue;
        }
        await writeStatusCache(platformId, verdict.connected, { lastReason: verdict.reason, lastTrace: verdict.trace });
        logger.info(`[Accounts] Background revalidate ${platformId}: ${verdict.connected ? 'still logged in' : 'session expired'}`);
      } catch (e) {
        logger.warn(`[Accounts] Background revalidate ${platformId} threw:`, e?.message || String(e));
      }
    }
  } catch (e) {
    logger.warn('[Accounts] Background revalidate setup failed:', e?.message || String(e));
  }
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
    // Cache shortcut: when the user clicks "Logged in · refresh," they want
    // to re-verify the cached session, not pop another window. If the disk
    // cache already says connected, skip openLoginWindow entirely and just
    // re-run verifySellMonitorLogin against the persisted cookies. If verify
    // comes back negative, the cache is updated to false and the next click
    // falls through to the normal launch-window path.
    const cache = await readStatusCache();
    if (cache[platformId]?.connected) {
      logger.info(`[Accounts] ${platformId} cached as connected — re-verifying without opening window`);
      const verdict = await verifySellMonitorLogin(platformId);
      await writeStatusCache(platformId, verdict.connected, { lastReason: verdict.reason, lastTrace: verdict.trace });
      return { connected: verdict.connected, reason: verdict.reason, skippedWindow: true };
    }

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
        const verdict = await verifySellMonitorLogin(platformId);
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
      name: config.name,
    };
  });
}
