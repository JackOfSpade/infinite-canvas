/**
 * Accounts IPC handlers — platform login, session management.
 * Opens visible browser windows for login and checks cookie health.
 */
import { handleSafe } from './ipcUtils.js';
import { logger } from '../logger.js';
import {
  openLoginWindow,
  getSessionStatus,
  getSellMonitorPlatforms,
  getSellMonitorConfig,
  getJobLoginPlatforms,
  getJobLoginConfig,
  fetchHtmlClean,
  getLoginAutoCloseWaitReason,
  hasPlatformAuthCookie,
  isNativeLoginSuccess,
} from './stealthBrowser.js';
import { detectAntiBotSignal } from './antiBotDetector.js';
import { PLATFORM_AUTH_COOKIES, isInlineLoginPlatform, NATIVE_LOGIN_PLATFORMS, isLoginUrlPath } from './browser/authWindows.js';
import { shouldUseNativeRead } from './browser/nativeChromeReader.js';
import { tryGetStore } from './settings.js';

// Timeout for a session-verify page fetch. Not a freshness/density signal —
// it's an auth-check network bound (fixed).
const SESSION_VERIFY_TIMEOUT_MS = 25000;

// Visible-text tokens that appear only once a seller is logged in. Used PURELY to
// FLAG (never gate) a connected verdict that may actually be a client-rendered SSR
// shell — see the ambiguousShell diagnostic at the connected return below.
const LOGGED_IN_BODY_TOKENS = ['sign out', 'log out', 'my listings', 'your listings', 'selling dashboard', 'seller hub', 'account settings'];
const AMBIGUOUS_SHELL_MAX_BYTES = 30000;
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

// ── Session status cache (in-memory, disk-backed for last-known-good) ─────────
// In-memory during a run, populated by verifyAllPlatforms on startup and by
// writeStatusCache after each login flow. The LAST-KNOWN-CONNECTED status is also
// persisted to disk and restored at startup — see loadPersistedStatusCache. WHY:
// the startup verify already KEEPS PRIOR status on an inconclusive (anti-bot)
// verdict (verifyAllPlatforms `keepPrior`), but with a purely in-memory cache the
// "prior" was empty every launch, so any platform whose verify got intermittently
// anti-bot-walled (eBay captcha, Mercari reload-loop, Swappa CF) showed up as
// "needs login" on EVERY restart even though the session was alive — forcing
// constant re-logins (the reported pain). Restoring the prior connected status
// lets the existing inconclusive-preserve logic survive restarts. A DEFINITIVE
// not-connected verify still overwrites it (real logouts are caught); only an
// inconclusive verify preserves the restored value, and it expires after
// STATUS_CACHE_MAX_AGE_MS so a long-dead session can't linger forever.
let _statusCache = {};

const STATUS_CACHE_STORE_KEY = 'marketplaceSessionCache';
const STATUS_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
let _statusCacheLoaded = false;

// Pure restore policy (unit-tested): from a persisted blob, keep ONLY recent
// `connected: true` entries. A stale or not-connected prior must never mask a
// fresh verify, and an old connected is likely dead. A fresh verify overwrites
// whatever we restore — restored values only survive an INCONCLUSIVE (anti-bot)
// verify, which is exactly when we want to keep believing the user is logged in.
export function selectRestorableStatuses(stored, now = Date.now(), maxAgeMs = STATUS_CACHE_MAX_AGE_MS) {
  const out = {};
  if (!stored || typeof stored !== 'object') return out;
  for (const [id, v] of Object.entries(stored)) {
    if (!v || typeof v !== 'object' || v.connected !== true) continue;
    const ts = Number(v.ts) || 0;
    if (!ts || (now - ts) >= maxAgeMs) continue;
    out[id] = { connected: true, ts, lastReason: typeof v.lastReason === 'string' ? v.lastReason : undefined, restoredFromDisk: true };
  }
  return out;
}

// Restore last session's connected statuses from disk (once per process).
export function loadPersistedStatusCache() {
  if (_statusCacheLoaded) return;
  _statusCacheLoaded = true;
  try {
    const restorable = selectRestorableStatuses(tryGetStore()?.get(STATUS_CACHE_STORE_KEY));
    for (const [id, v] of Object.entries(restorable)) _statusCache[id] = v;
    const restored = Object.keys(restorable).length;
    if (restored > 0) logger.info(`[Accounts] Restored ${restored} prior connected session status(es) from disk (anti-bot-resilient across restarts)`);
  } catch (e) {
    logger.warn('[Accounts] Could not load persisted session cache:', e?.message || String(e));
  }
}

function persistStatusCache() {
  try {
    const store = tryGetStore();
    if (!store) return;
    const compact = {};
    for (const [id, v] of Object.entries(_statusCache)) {
      if (!v) continue;
      compact[id] = {
        connected: !!v.connected,
        ts: Number(v.ts) || Date.now(),
        ...(typeof v.lastReason === 'string' ? { lastReason: v.lastReason.slice(0, 300) } : {}),
      };
    }
    store.set(STATUS_CACHE_STORE_KEY, compact);
  } catch (e) {
    logger.warn('[Accounts] Could not persist session cache:', e?.message || String(e));
  }
}

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

    // Cookie-first verification (opt-in via config.verifyViaCookie). For SPA
    // platforms whose logged-in content is CLIENT-rendered (AptDeco: /sell/new's
    // SSR shell shows "Already have an account? Sign in" and only swaps in the
    // account UI after an async client auth check), the body-text sniff below
    // races that swap and false-reads a logged-in user as logged out. A non-empty
    // auth cookie (PLATFORM_AUTH_COOKIES) is an immediate, render-safe signal:
    // present → connected; absent → fall through to the normal body/URL verify,
    // which correctly confirms the logged-out shell.
    if (config?.verifyViaCookie && await hasPlatformAuthCookie(platformId)) {
      logger.info(`[Accounts] ${platformId} verified via auth cookie (SPA client-render-safe; body verify skipped)`);
      return {
        connected: true,
        reason: `Auth cookie present for ${platformId} — logged in (body/URL verify skipped; SPA client-render-safe).`,
        trace: { target: targets[0], finalUrl: targets[0], status: 'auth-cookie', loginSignal: 'auth-cookie', checks: [{ target: 'profile-cookie', status: 'auth-cookie', loginSignal: 'auth-cookie' }] },
      };
    }

    const traces = [];
    let lastVisibleText = ''; // visible text of the last target — fuels the ambiguousShell flag

    // When a cookie-configured platform reads logged-out, record whether its auth
    // cookie actually survived on disk — the discriminator the bug reports kept
    // missing for "I just logged in but it says logged out / session expires too
    // fast": cookie ABSENT ⇒ the login didn't persist locally (our problem to fix);
    // cookie PRESENT but the page reads logged-out ⇒ the platform invalidated the
    // session server-side (anti-automation expiry, e.g. Facebook's repeat-2FA),
    // which we can't fix locally. Only runs on a logged-out verdict for platforms
    // with a known auth cookie; the note lands in the cache's "Last reason".
    const annotateCookieSurvival = async (result) => {
      const names = PLATFORM_AUTH_COOKIES[platformId];
      if (!names?.length) return result;
      let present = null;
      try { present = await hasPlatformAuthCookie(platformId); } catch { /* leave unknown */ }
      if (present === null) return result;
      result.trace = { ...(result.trace || {}), authCookiePresent: present, authCookieNames: names };
      result.reason += present
        ? ` Auth cookie ${names.join(',')} IS present on disk → session invalidated server-side (not a local persistence loss).`
        : ` Auth cookie ${names.join(',')} ABSENT on disk → login did not persist locally.`;
      return result;
    };

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
        r = await fetchHtmlClean(target, { timeoutMs: config?.verifyTimeoutMs || SESSION_VERIFY_TIMEOUT_MS, waitForRenderMs: config?.verifyRenderWaitMs || 0 });
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
      lastVisibleText = visibleText;
      // Capture the raw <title> (the smoking gun for SPA shells: a logged-out Mercari
      // /mypage serves the generic SEO title). Extracted before stripTags, bounded.
      const pageTitle = (String(r.html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
        .replace(/\s+/g, ' ').trim().slice(0, 160);
      const trace = {
        target,
        finalUrl: r.finalUrl,
        status: r.status,
        htmlBytes: r.html?.length || 0,
        bodyHead: visibleText.slice(0, 300),
        ...(pageTitle ? { pageTitle } : {}),
      };
      traces.push(trace);
      const finalUrlLower = String(r.finalUrl || '').toLowerCase();
      const antiBot = detectAntiBotSignal({
        status: r.status,
        finalUrl: r.finalUrl,
        html: r.html,
        title: pageTitle,
        sourceLabel: config?.name || platformId,
      });

      // An ANTI-BOT challenge (Cloudflare/Turnstile/captcha/etc.) on the verify URL
      // is NOT proof of logout — it means the bot wall blocked our HEADLESS request,
      // which it does intermittently even for a genuinely live session (confirmed on
      // Swappa: the same session that 403s here scrapes its hub fine minutes later).
      // Checked at ANY status, not just 401/403: eBay 200-REDIRECTS the verify to
      // /splashui/captcha ("Security Measure — please verify yourself"), which the old
      // 401/403-only guard missed → it fell through to the "expected URL" check and
      // HARD-flipped a logged-in user to needs-login, trapping them in a re-login loop
      // (the reported bug). Treat as INCONCLUSIVE so a transient wall can't flip a
      // logged-in platform to "needs login"; the caller keeps prior status. We still
      // do NOT assert connected off stale cookies — inconclusive only PRESERVES, never
      // upgrades. A plain 401/403 with NO challenge signal is still a genuine auth wall.
      if (antiBot) {
        const session = await getSessionStatus(platformId).catch(() => ({ connected: false, cookieCount: 0 }));
        trace.antiBot = antiBot.code;
        trace.sessionCookieHeuristic = !!session?.connected;
        trace.sessionCookieCount = session?.cookieCount || 0;
        return { connected: false, inconclusive: true, reason: `Anti-bot wall (${antiBot.code}) at ${target} (HTTP ${r.status}${r.finalUrl ? ` → ${r.finalUrl}` : ''}) — cannot confirm session; keeping prior status.`, trace: { target, checks: traces } };
      }
      if (r.status === 401 || r.status === 403) {
        // A plain 401/403 with no bot-challenge signal is a genuine auth wall.
        return { connected: false, reason: `Auth wall at ${target} (HTTP ${r.status}) — not logged in.`, trace: { target, checks: traces } };
      }
      // 404 on a "logged-in-only" page gives no signal — the URL may have been
      // renamed/removed on the platform's side, making it return 404 for everyone
      // (both logged-in and anonymous). Accepting it as "connected" would mask
      // expired cookies permanently. Treat as unverifiable rather than connected.
      if (r.status === 404) {
        return { connected: false, reason: `Verify URL returned 404 at ${target} — the URL may have changed on the platform's side. Update verifyUrl in JOB_LOGIN_PLATFORMS / SELL_MONITOR_PLATFORMS.`, trace: { target, checks: traces } };
      }
      // Any OTHER ≥400 (401/403/404 handled above) is NOT a confirmable logged-in
      // response — e.g. AptDeco serves its "Human Verification" anti-bot wall as HTTP
      // 405. Without this, a 405 falls through to the connected:true DEFAULT below
      // (the reported false positive). Treat as INCONCLUSIVE (keep prior) so a
      // transient wall / error response can't flip a live session, and never assert
      // connected off an error page. (A recognized bot wall already returned above.)
      if (r.status >= 400) {
        return { connected: false, inconclusive: true, reason: `Verify URL returned HTTP ${r.status} at ${target} — not a confirmable logged-in response (often an anti-bot wall, e.g. "${pageTitle || 'no title'}"); keeping prior status.`, trace: { target, checks: traces } };
      }
      if (isLoginUrlPath(finalUrlLower)) {
        return await annotateCookieSurvival({ connected: false, reason: `Redirected to ${r.finalUrl} — login not completed.`, trace: { target, checks: traces } });
      }

      // Platform-specific redirect guard: some platforms redirect anonymous users
      // to a public page (200 OK, no /login in URL) rather than to a login URL.
      // connectedFinalUrlMustContain lets the platform config specify a path
      // fragment that the final URL must contain; absence means not logged in.
      if (config?.connectedFinalUrlMustContain) {
        const mustContain = config.connectedFinalUrlMustContain.toLowerCase();
        if (!finalUrlLower.includes(mustContain)) {
          return await annotateCookieSurvival({ connected: false, reason: `Redirected to ${r.finalUrl} — expected URL to contain "${config.connectedFinalUrlMustContain}" for a logged-in session.`, trace: { target, checks: traces } });
        }
      }

      const matched = getSoftLoginWallMatch(visibleText, config);
      if (matched) {
        trace.softWallMatch = matched;
        return await annotateCookieSurvival({ connected: false, reason: `Page body looks logged out at ${target} ("${matched}") despite URL ${r.finalUrl}.`, trace: { target, checks: traces } });
      }
    }

    const lastTrace = traces[traces.length - 1];
    // The verdict below is a DEFAULT — no positive logged-in evidence, only the
    // absence of negative signals. Those negative checks (login-URL redirect +
    // the body sniff) are trustworthy only off a COMPLETED page read.
    // fetchHtmlClean returns `response?.status() ?? 0` and response is null
    // exactly when page.goto's timeout/ERR_ABORTED was swallowed: the main-frame
    // navigation produced no response and page.content() read a partially built
    // DOM, so a login form that had not painted yet cannot be sniffed. An
    // unobserved status must therefore never UPGRADE to a fresh `connected` —
    // same non-confirmable class as the >=400 guard above. Negative verdicts are
    // unaffected: a status-0 read that DID redirect to /login or DID show a
    // sign-in body already returned connected:false above, so a genuine logout
    // is still caught definitively.
    const unobserved = traces.find(t => !(t.status >= 200 && t.status < 400));
    if (unobserved) {
      return {
        connected: false,
        inconclusive: true,
        reason: `No HTTP status observed at ${unobserved.finalUrl || unobserved.target} — the navigation produced no main-frame response (timed out or was aborted) and only ${unobserved.htmlBytes} bytes of a possibly partial DOM were read; cannot confirm the session, keeping prior status.`,
        trace: {
          target: targets[0], checks: traces, finalUrl: unobserved.finalUrl,
          status: unobserved.status, htmlBytes: unobserved.htmlBytes, bodyHead: unobserved.bodyHead,
          ...(unobserved.pageTitle ? { pageTitle: unobserved.pageTitle } : {}),
          unobservedStatus: true,
        },
      };
    }
    // Diagnostic-only (NEVER gates the verdict): connected here is a DEFAULT reached
    // because no negative check matched. For an SPA that client-renders its login form
    // over a generic SSR shell (Mercari at /mypage), the login bodySignal can race the
    // render and miss while the URL stays on-host — so we default to connected with NO
    // positive logged-in evidence. Flag when the body shows no logged-in marker and the
    // HTML is shell-sized, so the bug report surfaces a possible false-positive
    // 'connected' (with the smoking-gun <title>) instead of it reading as confirmed.
    const hasLoggedInMarker = LOGGED_IN_BODY_TOKENS.some(s => lastVisibleText.toLowerCase().includes(s));
    const ambiguousShell = !hasLoggedInMarker && (lastTrace.htmlBytes || 0) < AMBIGUOUS_SHELL_MAX_BYTES;
    return {
      connected: true,
      reason: `Reached ${targets.length} verify URL(s); last ${lastTrace.finalUrl} (HTTP ${lastTrace.status}) without auth redirect or sign-in body.`,
      trace: {
        target: targets[0], checks: traces, finalUrl: lastTrace.finalUrl, status: lastTrace.status,
        htmlBytes: lastTrace.htmlBytes, bodyHead: lastTrace.bodyHead,
        ...(lastTrace.pageTitle ? { pageTitle: lastTrace.pageTitle } : {}),
        ...(ambiguousShell ? { ambiguousShell: true, ambiguousReason: `Reached the host but the body has no logged-in marker and the HTML is only ${lastTrace.htmlBytes} bytes — likely an unrendered SPA shell or inline login form; the connected verdict is a DEFAULT, not a positive confirmation${lastTrace.pageTitle ? ` (title: "${lastTrace.pageTitle}")` : ''}.` } : {}),
      },
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
  // Persist so the next launch can restore last-known-connected and survive an
  // intermittent anti-bot verify without forcing a re-login (see loadPersistedStatusCache).
  persistStatusCache();
}

export function isTrustedNativeLoginResult(platformId, result) {
  if (!result?.nativeChrome || result?.result !== 'auto-detected') return false;
  // Inline-login platforms (mercari) serve the login FORM at the same URL as the
  // success marker, so historically a native auto-detect couldn't be trusted (a
  // title-render race could fire 'auto-detected' on the logged-out inline form) and we
  // routed to the HTTP verify. That no longer holds for a CDP-WALLED platform:
  //   (a) the login window now opens at the DEDICATED /login/ page (not the auth-gated
  //       hub), so auto-detect fires only AFTER a real post-login redirect to /mypage
  //       with a SETTLED, non-logged-out title — which isNativeLoginSuccess re-confirms
  //       below (it rejects an empty/loading title and any logged-out title), and
  //   (b) the HTTP verify WEDGES in mercari's anti-bot reload loop (page.content() times
  //       out) → inconclusive → "keep prior (not connected)", so a user who JUST
  //       completed Google-SSO + 2FA and landed on /mypage is told they're still logged
  //       out (the reported "mercari shows not logged in even after logging in").
  // So trust the title-validated native result when the HTTP verify can't help
  // (shouldUseNativeRead = CDP-walled); a hypothetical inline-login platform whose CDP
  // verify actually works still routes to it. The native READ during Check All is the
  // backstop that catches any rare false-positive (it waits at a login screen).
  if (isInlineLoginPlatform(platformId) && !shouldUseNativeRead(platformId)) return false;
  // Re-validate the landed URL against the platform's success markers (generic —
  // was hardcoded to indeed). `auto-detected` is only emitted after the native
  // poll already matched isNativeLoginSuccess, so this is a belt-and-suspenders
  // confirmation that also covers any new native platform (swappa → /my/swappa).
  return isNativeLoginSuccess(platformId, result.currentUrl, result.title);
}

function buildTrustedNativeLoginVerdict(platformId, result) {
  const pageKind = getSellMonitorConfig(platformId) ? 'marketplace account page' : 'job-search page';
  return {
    connected: true,
    reason: `Native Chrome reached logged-in ${platformId} ${pageKind} at ${result.currentUrl}.`,
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

async function verifySellMonitorLoginWithPostLoginRetry(platformId, { nativeResult = null } = {}) {
  let verdict = await verifySellMonitorLogin(platformId);
  const shouldRetry = isInlineLoginPlatform(platformId)
    && nativeResult?.nativeChrome
    && nativeResult?.result === 'auto-detected'
    && !verdict.connected
    && verdict.inconclusive;
  if (!shouldRetry) return verdict;

  logger.warn(`[Accounts] ${platformId} post-login verify inconclusive after native auto-detect (${verdict.reason}) — retrying once after cookies/render settle`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const retry = await verifySellMonitorLogin(platformId);
  retry.trace = {
    ...(retry.trace || {}),
    postLoginRetry: true,
    firstAttempt: {
      connected: verdict.connected,
      inconclusive: verdict.inconclusive,
      reason: verdict.reason,
      trace: verdict.trace,
    },
  };
  return retry;
}

async function completeLoginWindowVerification(platformId, result) {
  if (isTrustedNativeLoginResult(platformId, result)) {
    const verdict = buildTrustedNativeLoginVerdict(platformId, result);
    await writeStatusCache(platformId, true, { lastReason: verdict.reason, lastTrace: verdict.trace });
    logger.info(`[Accounts] ${platformId} native login verified: ${verdict.reason}`);
    return { ...(result || {}), connected: true, reason: verdict.reason };
  }
  if (isTrustedPuppeteerLoginResult(platformId, result)) {
    const verdict = buildTrustedPuppeteerLoginVerdict(platformId, result);
    await writeStatusCache(platformId, true, { lastReason: verdict.reason, lastTrace: verdict.trace });
    logger.info(`[Accounts] ${platformId} login auto-detected: ${verdict.reason}`);
    return { ...(result || {}), connected: true, reason: verdict.reason };
  }

  const verdict = await verifySellMonitorLoginWithPostLoginRetry(platformId, { nativeResult: result });
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
}

// Puppeteer login window confirmed login via DOM/cookie/auth-gated-URL signal.
// Skip the HTTP re-verify — Cloudflare challenges the verify URL on new browser
// sessions even when the session is genuinely live, causing false "not connected"
// verdicts immediately after a successful login.
function isTrustedPuppeteerLoginResult(platformId, result) {
  if (result?.loginDetected !== true || !result?.loginUrl) return false;
  const waitReason = getLoginAutoCloseWaitReason({
    platformId,
    currentUrl: result.loginUrl,
    cookieSignal: result.loginSignal === 'auth-cookie',
  });
  if (waitReason) {
    logger.warn(`[Accounts] ${platformId} login auto-detect not trusted (${result.loginSignal || 'unknown'} at ${result.loginUrl}; ${waitReason}) — running HTTP re-verify`);
    return false;
  }
  return true;
}

function buildTrustedPuppeteerLoginVerdict(platformId, result) {
  const signal = result.loginSignal || 'DOM/cookie/auth-gated';
  return {
    connected: true,
    reason: `Auto-detected logged-in state for ${platformId} at ${result.loginUrl} (${signal} signal) — HTTP re-verify skipped.`,
    trace: {
      target: result.loginUrl,
      // Top-level finalUrl + status so the bug-report session table sees the
      // auto-detected marker (see buildTrustedNativeLoginVerdict for why).
      finalUrl: result.loginUrl,
      status: 'auto-detected',
      loginSignal: signal,
      checks: [{
        target: 'puppeteer-login-window',
        finalUrl: result.loginUrl,
        status: 'auto-detected',
        loginSignal: signal,
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
// Runs with a bounded-concurrency pool. verifySellMonitorLogin opens tabs in the
// one shared stealth browser, so verifier workers can run concurrently with each
// other. A visible login flow is different: it must close the headless browser and
// take exclusive ownership of the shared userDataDir, so queued verifier workers
// skip while any login flow is active.
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
  // Seed the cache with last session's connected statuses BEFORE verifying, so the
  // keepPrior (inconclusive / anti-bot) branch below has a prior to preserve
  // across restarts instead of an empty cache → false "needs login" every launch.
  loadPersistedStatusCache();

  const sellIds = getSellMonitorPlatforms().map(p => p.id);
  const jobIds  = getJobLoginPlatforms().map(p => p.id);
  const allIds  = [...sellIds, ...jobIds];

  _verifyingPlatforms = new Set(allIds);
  notify('accounts:verify-start', { platformIds: allIds });
  logger.info(`[Accounts] Startup verify: ${allIds.length} platforms (${allIds.join(', ')}), concurrency ${VERIFY_CONCURRENCY}`);

  const runStartedAt = Date.now();
  const durations = [];

  const verifyOne = async (platformId) => {
    if (activeLoginFlows.size > 0) {
      const activePlatforms = [...activeLoginFlows.keys()];
      const connected = _statusCache[platformId]?.connected ?? false;
      logger.info(`[Accounts] Startup verify skipping ${platformId} — login flow in flight for ${activePlatforms.join(', ')}`);
      _verifyingPlatforms.delete(platformId);
      notify('accounts:verify-update', { platformId, connected });
      durations.push({
        platformId, ms: 0, connected, skipped: true,
        outcome: 'skipped-login-flow',
        reason: `login flow in flight (${activePlatforms.join(', ')})`,
      });
      return;
    }
    // CDP-walled on BOTH axes (native LOGIN + native READ) = swappa, mercari: their
    // login delegates to Google SSO / CF Turnstile (loops under CDP) AND their hub
    // reads 403/wedge under CDP. A CDP startup verify can therefore only WEDGE (the
    // reported mercari 35s anti-bot reload-loop that made startup verify the long pole
    // and stalled the first Check All) or return an unreliable verdict — it tells us
    // nothing the native read won't establish authoritatively during Check All. Skip it
    // and keep the prior disk-cached status (loadPersistedStatusCache already restored
    // last session's connected state). Gated on shouldUseNativeRead (darwin) so a
    // non-macOS host — where there is no native read to own login state — still verifies.
    // eBay is deliberately NOT skipped: it is native-READ but its login verify works
    // (auto-detects via DOM signal, doesn't wedge), so its startup verify stays useful.
    if (NATIVE_LOGIN_PLATFORMS.has(platformId) && shouldUseNativeRead(platformId)) {
      const connected = _statusCache[platformId]?.connected ?? false;
      logger.info(`[Accounts] Startup verify skipping ${platformId} — CDP-walled native-login+native-read platform; native read owns login state during Check All (kept prior: ${connected ? 'connected' : 'not connected'})`);
      _verifyingPlatforms.delete(platformId);
      notify('accounts:verify-update', { platformId, connected });
      durations.push({
        platformId, ms: 0, connected, skipped: true,
        outcome: 'skipped-native',
        reason: 'native read owns login state',
      });
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
      durations.push({
        platformId,
        ms,
        connected: keepPrior ? (_statusCache[platformId]?.connected ?? false) : verdict.connected,
        // `connected` alone is not a verifier result when an anti-bot fetch was
        // inconclusive: it is merely the last cached state we deliberately kept.
        // Preserve that distinction for the timing/report diagnostic instead of
        // presenting a retained cache entry as a fresh successful verification.
        outcome: keepPrior ? 'retained-prior' : 'verified',
        reason: verdict.reason || null,
        inconclusive: !!verdict.inconclusive,
        // The two facts that discriminate "login never persisted locally" from
        // "platform invalidated the session server-side" / "we never reached the
        // logged-in host". Computed by the verifier, so carry them onto the timing
        // record instead of making the report re-derive them from prose.
        authCookiePresent: verdict.trace?.authCookiePresent ?? null,
        finalUrl: verdict.trace?.finalUrl ?? null,
      });
      logger.info(`[Accounts] Startup verify ${platformId}: ${keepPrior ? 'kept prior status' : (verdict.connected ? 'connected' : 'not connected')} (${ms}ms)`);
    } catch (e) {
      const ms = Date.now() - startedAt;
      durations.push({
        platformId, ms, connected: false,
        outcome: 'error',
        reason: e?.message || String(e),
        error: e?.message || String(e),
      });
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
  // Seed the disk-backed cache now, not just inside verifyAllPlatforms (which
  // main.js delays by 2.5s so the renderer can mount first). Any handler below
  // can be hit before that timer fires — without this, an early price check or
  // job search would read an empty in-memory cache and treat a real prior
  // session as logged out. Idempotent (_statusCacheLoaded guard).
  loadPersistedStatusCache();

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
        return await completeLoginWindowVerification(platformId, result);
      } catch (error) {
        // Catch path: openLoginWindow itself blew up BEFORE any verification ran
        // (Chrome failed to launch, profile-lock contention, unknown platform,
        // etc.) — a tooling/launch failure, not evidence that the user's EXISTING
        // session is invalid. This handler intentionally opens the window even
        // when the cache already says connected (see the comment above — it's
        // how a user forces a fresh login), so unconditionally caching
        // connected:false here used to flip an already-logged-in platform to
        // "needs login" purely because Chrome hiccuped on THIS attempt — which
        // then trips the hard login preflight and blocks price checks on every
        // in-scope marketplace, not just this one. Mirror the file's own
        // inconclusive-preserve rule (see verifyAllPlatforms' browser-teardown
        // handling): keep the prior cached connected value, only refreshing the
        // diagnostic trace, and report the verdict as inconclusive so the
        // renderer's toast still surfaces the real error.
        const msg = error?.message || String(error);
        logger.error(`[Accounts] Login window failed for ${platformId}:`, msg);
        const trace = { error: msg, stack: error?.stack?.slice(0, 600), stage: 'openLoginWindow' };
        const prior = _statusCache[platformId]?.connected ?? false;
        await writeStatusCache(platformId, prior, { lastReason: msg, lastTrace: trace });
        return { connected: prior, reason: msg, error: msg, inconclusive: true };
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
      const loginResult = await openLoginWindow(platformId, _event.sender);
      const verified = await completeLoginWindowVerification(platformId, loginResult);

      if (_event.sender.isDestroyed()) {
        return { platform: platformId, connected: !!verified.connected, loginOpened: true };
      }
      return { platform: platformId, connected: !!verified.connected, loginOpened: true, reason: verified.reason, ...(verified.inconclusive ? { inconclusive: true } : {}) };
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
