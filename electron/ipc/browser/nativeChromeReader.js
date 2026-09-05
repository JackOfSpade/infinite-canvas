import { execFile as execFileCb, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { logger } from '../../logger.js';
import { closeStealthBrowser, getUserDataDir, findSystemChromePath, findChromePath, reserveSharedProfile } from '../stealthBrowser.js';
import { pauseBrowserPool } from '../browserPool.js';
import { withMarketplaceBrowserLock } from '../marketplaceBrowserLock.js';
import { findGoogleSafeChromePath, isLoggedOutTitleForPlatform, isLoginUrlPath, PUPPETEER_OSCRYPT_PARITY_ARGS } from './authWindows.js';

const execFile = promisify(execFileCb);

// ── Why this module exists ───────────────────────────────────────────────────
// A few marketplaces gate their seller hubs behind anti-bot that detects the
// Chrome DevTools Protocol itself (Cloudflare Turnstile on Swappa → HTTP 403;
// Mercari → a reload-loop that wedges the navigation), so EVERY Puppeteer/
// headless read fails — 403 or a bounce to /login — even with a fully live
// session and the cf_clearance cookie on disk. The only thing that reads past
// that is a REAL GUI Chrome that is NOT driven over CDP. We already spawn such a
// Chrome for native LOGIN (see authWindows.js NATIVE_LOGIN_PLATFORMS); this
// extends the same plain-`spawn` Chrome to READING the hub pages.
//
// Mechanism (macOS-only): spawn system Chrome on the shared userDataDir (so the
// logged-in cookies + cf_clearance are present), drive it via AppleScript. The
// AppleScript *dictionary* (`set URL`, `loading`) needs no special permission;
// pulling the rendered HTML needs `execute … javascript`, which requires the
// user's one-time Chrome toggle: View → Developer → "Allow JavaScript from Apple
// Events". When that toggle is off, osascript errors and we surface a precise
// instruction (isAppleEventsJsDisabledError) instead of a cryptic failure.
//
// See memory: project_marketplace_login_status_reading, project_swappa_turnstile_native_login.

// Platforms whose hub reads must go through native (non-CDP) Chrome. Keep this
// tight — a visible/off-screen Chrome spawn is heavier than a headless fetch, so
// only platforms that genuinely 403/wedge under CDP belong here. eBay serves the
// headless/CDP browser an anti-bot /splashui/captcha wall (bounced toward signin)
// EVEN WITH valid logged-in cookies — the user's own Chrome on the same machine/IP
// sees no wall, so it is the automation fingerprint, not the account or the IP (user
// confirmed via screenshot; reported "ebay still unknown" repeatedly). Facebook/Reverb
// still read fine headless and must NOT be added.
export const NATIVE_READ_PLATFORMS = new Set(['swappa', 'mercari', 'ebay']);

export function shouldUseNativeRead(platformId) {
  return process.platform === 'darwin' && NATIVE_READ_PLATFORMS.has(platformId);
}

// AppleScript result separator between the settled finalUrl and the page HTML.
// Long + improbable so it can't collide with real page text.
const NR_SEP = '###NRSEP_8f3a2c###';
const NR_ERR_NOWINDOW = 'NRERR:NOWINDOW';
// osascript can return a multi-MB hub page; the default 1MB execFile buffer would
// truncate it (and reject). Bound generously instead.
const OSA_MAX_BUFFER = 64 * 1024 * 1024;
// How long to wait for the spawned window to FIRST appear before giving up (spawn
// handoff / osascript can't see it). Once it appears, the login wait is INDEFINITE
// (a human is present during a user-triggered Check All) — the only escapes are
// signing in, CLOSING the window (to skip that platform), or aborting Check All.
// Mirrors the captcha-wait pattern (wait forever for a solvable human step). For
// Swappa/Mercari this window IS the only login that works (non-CDP, passes the
// Turnstile/anti-bot the headless/CDP login can't).
const NATIVE_WINDOW_APPEAR_MS = 20000;
// How long a visible window may sit in 'unknown' (title never settles on a login
// screen or a real hub) before waitForHubLogin gives up and reports 'stuck'. Module
// scope so readHubUrlsViaNativeChrome's stuck-window error message can reference it
// instead of duplicating the literal.
const UNKNOWN_SETTLE_MS = 30000;

/**
 * True when an osascript failure is the "Allow JavaScript from Apple Events"
 * Chrome toggle being OFF (the one manual prerequisite for this whole path).
 * Detected so the bug report can tell the user exactly what to flip instead of
 * showing an opaque AppleScript error.
 */
export function isAppleEventsJsDisabledError(msg) {
  const s = String(msg || '');
  return /JavaScript through AppleScript is turned off/i.test(s)
    || /Allow JavaScript from Apple Events/i.test(s)
    || /Executing JavaScript through AppleScript/i.test(s);
}

/**
 * A page that, even via native Chrome on a logged-in profile, is actually the
 * platform's client-rendered LOGIN FORM served inline at an auth-gated, on-host URL
 * (HTTP 200, no /login redirect) — i.e. the session is logged OUT. Mercari does
 * this: /mypage/listings/ returns 200 and renders "Log in to Mercari" over a
 * generic SSR shell, so the URL/host check alone reads it as a hub. Detected so the
 * read surfaces a precise "logged out" instead of mis-scanning login HTML as hub
 * content, AND so the caller STOPS driving the tab (each reload resets the form's
 * reCAPTCHA). Primary markers are unambiguous Mercari login headings; the secondary
 * AND-combination guards a generic login form without false-tripping a logged-in
 * page that merely contains one of the words. PURE for tests.
 */
export function nativeReadLooksLoggedOut(html) {
  const s = String(html || '').toLowerCase();
  if (s.includes('log in to mercari') || s.includes('continue with apple')) return true;
  return s.includes('recaptcha') && s.includes('password') && s.includes('email address') && s.includes('log in');
}

/** A page that, even via native Chrome, is still an anti-bot challenge wall. */
export function nativeReadLooksChallenged(html) {
  const s = String(html || '').toLowerCase();
  return s.includes('just a moment')
    || s.includes('verify you are human')
    || s.includes('checking if the site connection is secure')
    || s.includes('cf-challenge')
    || s.includes('challenge-platform')
    || s.includes('/cdn-cgi/challenge-platform');
}

/** Split the osascript stdout into { finalUrl, html }. */
export function parseNativeReadOutput(stdout) {
  const raw = String(stdout ?? '');
  const idx = raw.indexOf(NR_SEP);
  if (idx === -1) {
    // No separator — either the NOWINDOW sentinel or an unexpected shape.
    return { finalUrl: '', html: '', sentinel: raw.trim() || null };
  }
  const rest = raw.slice(idx + NR_SEP.length);
  const idx2 = rest.indexOf(NR_SEP);
  if (idx2 !== -1) {
    const htmlOrError = rest.slice(idx2 + NR_SEP.length);
    const jsErrorPrefix = 'NRERR:JS:';
    return {
      finalUrl: raw.slice(0, idx).trim(),
      title: rest.slice(0, idx2).trim(),
      html: htmlOrError.startsWith(jsErrorPrefix) ? '' : htmlOrError,
      error: htmlOrError.startsWith(jsErrorPrefix) ? htmlOrError.slice(jsErrorPrefix.length).trim() : null,
      sentinel: null,
    };
  }
  return {
    finalUrl: raw.slice(0, idx).trim(),
    title: '',
    html: rest,
    error: null,
    sentinel: null,
  };
}

/**
 * Map one native read into the { ok, status, finalUrl, html } shape that
 * scanSellerHubPages's fetcher contract expects — classifying the blocked cases
 * (toggle off / login bounce / challenge / empty) as terminal `ok:false` with a
 * precise message, so they surface in the bug report's "Blocked / unreadable hub
 * sources" section WITHOUT triggering scanSellerHubPages's headless disambiguate
 * (which would relaunch the very CDP browser this path exists to avoid).
 */
export function nativeReadToFetchResult({ requestedUrl, finalUrl, title, html, error, sentinel } = {}) {
  const base = {
    ...(finalUrl ? { finalUrl } : {}),
    ...(title ? { title: String(title).slice(0, 160) } : {}),
  };
  if (error) {
    if (isAppleEventsJsDisabledError(error)) {
      return { ...base, ok: false, appleEventsDisabled: true, error: 'Native read needs Chrome → View → Developer → “Allow JavaScript from Apple Events” (it is currently OFF).' };
    }
    return { ...base, ok: false, error: `Native Chrome read failed: ${error}` };
  }
  if (sentinel === NR_ERR_NOWINDOW) {
    return { ...base, ok: false, error: 'Native Chrome window never appeared (spawn failed or was closed).' };
  }
  const landed = String(finalUrl || requestedUrl || '');
  const landedLower = landed.toLowerCase();
  // eBay's anti-bot splash/captcha (/splashui/…) is served ON-host (ebay.com), so it
  // would otherwise slip past the login-bounce + CF-content checks and get scanned as
  // hub content. Treat it as a challenge (blocked source, not scanned): this window
  // closes (readNativeChromeHubs's finally always SIGTERMs it, so the NEXT platform's
  // spawn gets a free profile) — the user solves it in the fresh window the next
  // Check All run opens.
  if (/\/splashui\b/.test(landedLower)) {
    return { ...base, ok: false, challenged: true, error: `Native Chrome hit eBay's anti-bot splash/captcha at ${landed} — this window will close; re-run Check All and solve it in the fresh window that opens.` };
  }
  if (isLoginUrlPath(landedLower)) {
    return { ...base, ok: false, loginBounce: true, error: `Native Chrome was redirected to a login page (${landed}) — even without CDP the session is logged out or anti-bot bounced it; log in via Settings → Marketplace Login.` };
  }
  if (nativeReadLooksChallenged(html)) {
    return { ...base, ok: false, challenged: true, error: `Native Chrome still hit an anti-bot challenge at ${landed} — this window will close; re-run Check All and solve it in the fresh window that opens.` };
  }
  if (nativeReadLooksLoggedOut(html)) {
    return { ...base, ok: false, loggedOut: true, error: `Native Chrome landed on ${landed} (HTTP 200) but the page is a client-rendered LOGIN FORM — logged out despite the auth-gated hub URL; this window will close, sign in when Check All reopens a fresh one.` };
  }
  if (!html || html.length < 200) {
    return { ...base, ok: false, error: `Native Chrome returned an empty page (${html ? html.length : 0} bytes) at ${landed}.` };
  }
  return { ...base, ok: true, status: 200, finalUrl: landed, html };
}

// ── AppleScript: find OUR window by URL and drive its tab ──────────────────────
// We locate the spawned window by its tab URL — the SAME proven mechanism the
// native LOGIN flow uses (getNativeChromeTabs in authWindows.js), which reliably
// finds the spawned window where the window-`id` approach did NOT (live: the id
// was captured but never matched at read time). `matchHost` is the platform host;
// we ALSO match accounts.google.com so the window is still found after a logged-out
// hub bounces it to Google OAuth (Swappa). Navigation + load-wait use the
// permission-free dictionary; only the final `execute … javascript` needs the
// Apple-Events toggle.

// Return OUR window's active-tab URL AND title (matched by host), or the no-window
// sentinel. Used to POLL login state without navigating — so we can WAIT at a login
// screen for the human to sign in instead of instantly failing. The title is read
// via the plain AppleScript dictionary (`title of active tab`), which needs NO
// "Allow JavaScript from Apple Events" toggle — so it is the only signal that can
// discriminate an inline login form (on-host URL, generic SEO <title>) from a real
// hub when the toggle is OFF.
function buildPollTabUrlScript() {
  return `on run argv
  set matchHost to item 1 of argv
  tell application "Google Chrome"
    repeat with w in windows
      try
        set u to (URL of active tab of w) as string
        set t to (title of active tab of w) as string
        if (u contains matchHost) or (u contains "accounts.google.com") then return u & "${NR_SEP}" & t
      end try
    end repeat
  end tell
  return "${NR_ERR_NOWINDOW}"
end run`;
}

// Navigate OUR window's tab (matched by host) to a URL, wait for load, read HTML.
// Used AFTER login is confirmed, so the window is settled on the platform host.
function buildNavigateReadScript() {
  return `on run argv
  set targetUrl to item 1 of argv
  set matchHost to item 2 of argv
  tell application "Google Chrome"
    set theWin to missing value
    repeat with w in windows
      try
        if (URL of active tab of w) contains matchHost then
          set theWin to w
          exit repeat
        end if
      end try
    end repeat
    if theWin is missing value then return "${NR_ERR_NOWINDOW}"
    set theTab to active tab of theWin
    set URL of theTab to targetUrl
    repeat 100 times
      delay 0.25
      try
        if (loading of theTab) is false then exit repeat
      end try
    end repeat
    delay 0.7
    set finalUrl to (URL of theTab) as string
    set pageTitle to (title of theTab) as string
    -- Strip the field separator from the title so a page that titles itself with the
    -- (private, random) NR_SEP token can't corrupt the finalUrl<SEP>title<SEP>html
    -- split. finalUrl is a URL (sep-free); html is the greedy remainder (sep-safe).
    set oldDelims to AppleScript's text item delimiters
    set AppleScript's text item delimiters to "${NR_SEP}"
    set pageTitle to text items of pageTitle
    set AppleScript's text item delimiters to " "
    set pageTitle to pageTitle as text
    set AppleScript's text item delimiters to oldDelims
    try
      set theHtml to (execute theTab javascript "document.documentElement.outerHTML")
    on error errMsg
      return finalUrl & "${NR_SEP}" & pageTitle & "${NR_SEP}" & "NRERR:JS:" & errMsg
    end try
    if theHtml is missing value then set theHtml to ""
    return finalUrl & "${NR_SEP}" & pageTitle & "${NR_SEP}" & theHtml
  end tell
end run`;
}

/**
 * Classify the read window's current tab URL into a login state. PURE for tests.
 *   'no-window'  — osascript couldn't find OUR window (sentinel / empty / about:blank)
 *   'logged-out' — a login / sign-in / Google-OAuth / 2FA screen (WAIT for the human)
 *   'logged-in'  — settled on the platform host, not a login screen (read now)
 *   'unknown'    — somewhere else (transient redirect); keep polling
 */
export function nativeReadLoginState(url, platformHost, title = '', platformId = '') {
  const u = String(url || '').toLowerCase();
  const host = String(platformHost || '').toLowerCase();
  const titleText = String(title || '').trim();
  const titleLower = titleText.toLowerCase();
  if (!u || u === NR_ERR_NOWINDOW.toLowerCase() || u === 'about:blank') return 'no-window';
  // Login / SSO / 2FA screens, AND eBay's /splashui anti-bot captcha wall (served
  // on-host and bounced toward signin) — all are "WAIT for the human to clear it in
  // the visible window" (same treatment as Swappa's CF "Just a moment" interstitial).
  if (/accounts\.google\.com|\/login|\/signin|\/sign-in|\/auth\b|two_step_verification|\/challenge|\/splashui\b/.test(u)) return 'logged-out';
  // Inline login form served AT the auth-gated URL (HTTP 200, no redirect): the URL
  // is on-host but the <title> is the generic marketing/login shell. Read toggle-free
  // from the dictionary, the title is the ONLY discriminator in that case → classify
  // 'logged-out' (WAIT for the human to sign in) instead of a false 'logged-in' that
  // would drive the tab through the hub URLs and thrash the form's reCAPTCHA.
  if (isLoggedOutTitleForPlatform(platformId, title)) return 'logged-out';
  if (host && u.includes(host)) {
    // On-host, but an empty/loading title (or a transient URL-as-title) is NOT
    // positive evidence of a real hub: the page may still be painting a login form
    // (Mercari's inline /mypage form) or a Cloudflare "Performing security
    // verification" challenge (Swappa) whose <title> hasn't settled. Returning
    // 'logged-in' on that first poll drove the tab through every hub URL before the
    // challenge could load — the reported "refreshing / going to same url repeatedly
    // without giving time for human verification to load" thrash. Keep polling until
    // the title settles to a real hub title (→ logged-in) or a logged-out/challenge
    // marker (→ logged-out, caught above). Toggle-FREE (title via the AppleScript
    // dictionary), so it works with Apple-Events JavaScript OFF. Applies to ALL
    // native-read platforms (was mercari-only and left swappa exposed).
    if (!titleLower || /^https?:\/\//.test(titleLower) || titleLower === u) return 'unknown';
    return 'logged-in';
  }
  return 'unknown';
}

// Diagnostic for the "window did not open" failure: dump EVERY Chrome window's
// active-tab URL (and any osascript error) so a bug report tells us whether
// osascript saw NO windows (Automation permission / wrong Chrome instance), saw
// the user's windows but not ours (two-process targeting), or saw ours on a
// restore/challenge URL (profile lock / anti-bot) — instead of guessing.
async function describeAllChromeWindows() {
  const script = `tell application "Google Chrome"
  set out to ""
  set k to 0
  repeat with w in windows
    set k to k + 1
    try
      set out to out & k & ":" & (URL of active tab of w) & "  "
    on error errMsg
      set out to out & k & ":<" & errMsg & ">  "
    end try
  end repeat
  if k is 0 then return "no-windows"
  return out
end tell`;
  try {
    const { stdout } = await execFile('/usr/bin/osascript', ['-e', script], { timeout: 4000, maxBuffer: 1024 * 1024 });
    return String(stdout).trim().slice(0, 400) || '(empty)';
  } catch (e) {
    return `osascript error: ${(e?.stderr || e?.message || String(e)).slice(0, 200)}`;
  }
}

/**
 * Wait until no Chrome holds this profile, by polling for the absence of Chrome's
 * `SingletonLock` (created in userDataDir while any Chrome runs on it, removed on
 * clean exit). Chrome is one-process-per-userDataDir: spawning while a sibling
 * still holds the lock makes our process HAND OFF the URL and exit immediately, so
 * we must wait for it to clear first. Best-effort: returns false on timeout (a
 * stale lock from a crashed Chrome) and the caller spawns anyway — Chrome itself
 * recovers a stale lock on launch.
 */
async function waitForProfileUnlocked(userDataDir, timeoutMs = 5000) {
  const lock = path.join(userDataDir, 'SingletonLock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.promises.lstat(lock); // exists (even as a dangling symlink) → still locked
    } catch {
      return true; // ENOENT → profile is free
    }
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, 150));
  }
}

/**
 * PURE decision for ensureAppleEventsJsEnabled — given the parsed Preferences value
 * (or `undefined` for a missing file), return the object to WRITE, or `null` to
 * leave the file untouched. Returns null when: already enabled (no-op), or the value
 * is an unexpected shape (array / non-object / null) we must not clobber. Preserves
 * every other key + a pre-existing `browser` sub-object. Exported for tests.
 */
export function withAppleEventsJsEnabled(prefs) {
  if (prefs === undefined) prefs = {}; // missing file (ENOENT) → safe to seed
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return null;
  if (prefs.browser && typeof prefs.browser === 'object' && !Array.isArray(prefs.browser)
      && prefs.browser.allow_javascript_apple_events === true) return null; // already on
  const browser = (prefs.browser && typeof prefs.browser === 'object' && !Array.isArray(prefs.browser)) ? prefs.browser : {};
  return { ...prefs, browser: { ...browser, allow_javascript_apple_events: true } };
}

/**
 * Pre-enable Chrome's "Allow JavaScript from Apple Events" on OUR app-managed
 * profile so the native read's `execute … javascript` works WITHOUT the user
 * flipping View → Developer → "Allow JavaScript from Apple Events" every session
 * (the recurring "logged in but still error" complaint — the menu toggle is macOS-
 * only, OFF by default, and an in-session menu flip isn't reliably persisted because
 * we kill the read window before Chrome flushes it).
 *
 * The toggle maps to the boolean pref `browser.allow_javascript_apple_events` in
 * <profile>/Default/Preferences. Verified UNPROTECTED — it is NOT in Secure
 * Preferences' `protection.macs` index, so Chrome honours an externally-written
 * value instead of resetting it. We only ever touch OUR OWN browser-data profile.
 *
 * SAFETY: a malformed Preferences makes Chrome reset the whole profile (lost
 * logins), so this is strictly best-effort and ABORTS on any parse/shape problem —
 * it only writes a clean merge, atomically (temp + rename), and never overwrites an
 * unreadable/corrupt file. On any failure the native read just falls back to the
 * existing precise toggle-off message. Call ONLY while the profile is unlocked
 * (after closeStealthBrowser + waitForProfileUnlocked), before the native spawn.
 */
export async function ensureAppleEventsJsEnabled(userDataDir) {
  if (process.platform !== 'darwin') return;
  const prefsPath = path.join(userDataDir, 'Default', 'Preferences');
  let tmp = null;
  try {
    let parsed;
    try {
      parsed = JSON.parse(await fs.promises.readFile(prefsPath, 'utf8'));
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        // Unreadable / corrupt → do NOT overwrite (a malformed Preferences makes
        // Chrome reset the profile → lost logins). Log it so a "toggle keeps showing
        // off" report points at the real cause instead of looking like the toggle.
        logger.warn(`[NativeRead] Preferences unreadable at ${prefsPath} (${e?.message || String(e)}) — leaving it untouched; native read falls back to the manual toggle.`);
        return;
      }
      parsed = undefined; // fresh profile (ENOENT) → safe to seed
    }
    const next = withAppleEventsJsEnabled(parsed);
    if (!next) return; // already on, or an unexpected shape we won't touch
    await fs.promises.mkdir(path.dirname(prefsPath), { recursive: true });
    tmp = `${prefsPath}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, JSON.stringify(next), 'utf8');
    await fs.promises.rename(tmp, prefsPath);
    tmp = null; // renamed away — nothing left to clean up
    logger.info('[NativeRead] Pre-enabled "Allow JavaScript from Apple Events" on the app Chrome profile (no manual toggle needed).');
  } catch (e) {
    logger.warn(`[NativeRead] Could not pre-enable the Apple-Events JS pref (${e?.message || String(e)}); native read falls back to the manual toggle.`);
  } finally {
    if (tmp) await fs.promises.unlink(tmp).catch(() => {}); // clean an orphaned temp if the rename failed
  }
}

/** Resolve once the spawned Chrome process has fully exited (or after timeout). */
function waitForChildExit(child, timeoutMs = 3000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once('exit', done);
    setTimeout(() => { child.removeListener('exit', done); resolve(); }, timeoutMs);
  });
}

async function pollMatchedTabUrl(matchHost) {
  try {
    const { stdout } = await execFile('/usr/bin/osascript', ['-e', buildPollTabUrlScript(), matchHost], { timeout: 4000 });
    const raw = String(stdout).trim();
    if (!raw || raw === NR_ERR_NOWINDOW) return { url: raw, title: '' };
    const idx = raw.indexOf(NR_SEP); // split on the FIRST sep only — title is free text
    if (idx === -1) return { url: raw, title: '' };
    return { url: raw.slice(0, idx).trim(), title: raw.slice(idx + NR_SEP.length).trim() };
  } catch {
    return { url: '', title: '' };
  }
}

/**
 * Wait for OUR spawned window to reach a LOGGED-IN state on the platform host.
 * Two phases:
 *   1. BOUNDED (NATIVE_WINDOW_APPEAR_MS) wait for the window to first appear — if it
 *      never does (spawn handoff / osascript can't see it) → 'no-window'.
 *   2. Once visible, INDEFINITE wait for sign-in (the human is present during Check
 *      All). The only escapes are: signing in → 'logged-in'; CLOSING the window →
 *      'window-closed' (skip this platform); aborting Check All → 'aborted'.
 * A transient osascript miss / brief off-host login redirect is debounced (3
 * consecutive no-window reads) so it isn't mistaken for the user closing the window
 * mid-login; a real close that quits Chrome is caught instantly by getBailed. Returns:
 *   'logged-in' | 'window-closed' | 'no-window' | 'aborted' | 'stuck'
 */
async function waitForHubLogin(matchHost, platformId, signal, getBailed) {
  const appearDeadline = Date.now() + NATIVE_WINDOW_APPEAR_MS;
  let seen = false;
  let announced = false;
  let misses = 0;
  // Once the window is visible, a page that resolves to NEITHER a login/challenge
  // screen NOR a real hub — its title never settles (wedged load / unreadable
  // title), or it sits on a transient off-host redirect — now yields 'unknown'
  // (an empty/loading title is no longer trusted as 'logged-in'). Bound continuous
  // 'unknown' time so such a page surfaces as a stuck error instead of polling
  // forever. A 'logged-out' (login/challenge = human present) RESETS this deadline,
  // so the indefinite human-wait invariant is preserved. (UNKNOWN_SETTLE_MS is
  // module-scoped — see above — so the stuck-window error message below can cite it.)
  let unknownDeadline = 0;
  for (;;) {
    if (signal?.aborted) return 'aborted';
    // getBailed = spawn error OR the Chrome process exited. Before the window is
    // seen that's a spawn handoff/failure (→ no-window); after, it's the user
    // closing the window and Chrome quitting (→ window-closed/skip).
    if (getBailed?.()) return seen ? 'window-closed' : 'no-window';

    const { url: tabUrl, title: tabTitle } = await pollMatchedTabUrl(matchHost);
    const state = nativeReadLoginState(tabUrl, matchHost, tabTitle, platformId);
    if (state === 'logged-in') return 'logged-in';

    if (state === 'no-window') {
      if (!seen) {
        if (Date.now() >= appearDeadline) return 'no-window'; // never appeared
      } else if (++misses >= 3) {
        return 'window-closed'; // was open, now gone (3 consecutive) = user closed it
      }
    } else {
      seen = true;
      misses = 0;
      if (state === 'logged-out') {
        unknownDeadline = 0; // human-actionable screen → wait indefinitely
        if (!announced) {
          announced = true;
          logger.info(`[NativeRead] ${platformId} is at a login or human-verification screen — waiting (indefinitely) for you to sign in / solve it; CLOSE the window to skip this platform.`);
        }
      } else {
        // 'unknown' — title not settled / off-host transient. Bound it.
        if (!unknownDeadline) unknownDeadline = Date.now() + UNKNOWN_SETTLE_MS;
        else if (Date.now() >= unknownDeadline) return 'stuck';
      }
    }
    await new Promise(r => setTimeout(r, seen ? 1500 : 500));
  }
}

async function navigateAndRead(targetUrl, matchHost) {
  try {
    const { stdout } = await execFile(
      '/usr/bin/osascript',
      ['-e', buildNavigateReadScript(), targetUrl, matchHost],
      { timeout: 40000, maxBuffer: OSA_MAX_BUFFER },
    );
    const { finalUrl, title, html, error, sentinel } = parseNativeReadOutput(stdout);
    return nativeReadToFetchResult({ requestedUrl: targetUrl, finalUrl, title, html, error, sentinel });
  } catch (err) {
    // osascript exits non-zero on AppleScript errors (incl. the Apple-Events
    // toggle being off) — the message is on stderr/err.message.
    const msg = err?.stderr ? String(err.stderr) : (err?.message || String(err));
    return nativeReadToFetchResult({ requestedUrl: targetUrl, error: msg });
  }
}

/**
 * Read a platform's hub watch URLs through a non-CDP native Chrome and return a
 * Map<url, { ok, status, finalUrl, html } | { ok:false, error }> — the exact
 * fetcher-result shape scanSellerHubPages consumes, so the caller can feed these
 * straight into the normal hub-scan analysis.
 *
 * Lifecycle: closes the headless stealth browser (one Chrome per userDataDir) and
 * pauses the scrape pool so the native Chrome has exclusive profile access, then
 * spawns ONE VISIBLE app window, waits for it to reach a logged-in state (the human
 * signs in IN the window if the hub bounced to a login screen), drives it through
 * the URLs sequentially, and kills exactly the process it spawned. macOS-only;
 * returns per-URL errors on any other platform.
 */
export async function readHubUrlsViaNativeChrome(watchUrls, { platformId, signal } = {}) {
  const urls = Array.isArray(watchUrls) ? watchUrls.filter(Boolean) : [];
  const results = new Map();
  const fillAll = (error) => { for (const u of urls) results.set(u, { ok: false, error }); return results; };

  if (process.platform !== 'darwin') return fillAll('Native (non-CDP) read is macOS-only.');
  if (urls.length === 0) return results;

  // Resolve to system GOOGLE Chrome specifically — the same binary native LOGIN
  // uses (findGoogleSafeChromePath). The login cookies (incl. cf_clearance) are
  // encrypted with that bundle ID's Keychain key, so a different binary
  // (Chromium/Brave, or Puppeteer's Chrome-for-Testing that findChromePath
  // prefers) would read them as a LOGGED-OUT session → endless /login bounce.
  let fallbackPath = process.env.CHROME_PATH || (await findSystemChromePath());
  if (!fallbackPath) { try { fallbackPath = await findChromePath(); } catch { /* none found */ } }
  const chromePath = await findGoogleSafeChromePath(fallbackPath || null);
  if (!chromePath) return fillAll('System Google Chrome not found for native read.');

  const userDataDir = await getUserDataDir();

  // Serialize against ALL other sell-side browser ops (price-check scrapes,
  // rescrapes, captcha-resolve windows) via the SAME marketplaceBrowserLock they
  // use: this path closeStealthBrowser()s + spawns a second Chrome on the one
  // shared profile, which needs EXCLUSIVE access — without the lock a concurrent
  // price-check's in-flight pages get detached ("Navigating frame was detached")
  // and mis-reported as anti-bot blocks. Nesting is statusCheckLock (Check All) →
  // marketplaceBrowserLock, which is deadlock-free (no sell-side op acquires
  // statusCheckLock). The lock bails at the queue head if `signal` is aborted.
  return withMarketplaceBrowserLock(async () => {
    // Exclusive profile access: the headless stealth browser locks userDataDir, so
    // it must be closed before a second Chrome can open the same profile (mirrors
    // openLoginWindow). Pause the scrape pool so it can't relaunch mid-read. Both
    // are set up INSIDE the try so a throw still releases the pause + kills Chrome.
    //
    // The pool pause only gates the pool's OWN queue — job-side code calls
    // getStealthBrowser() directly (LinkedIn description enrichment), and a
    // JobSearch run can overlap a Check All because neither takes the other's
    // lease. Reserve the shared profile like every other visible spawn
    // (openLoginWindow / captcha-resolve / indeed) so a concurrent headless launch
    // fails fast with a named reason instead of stealing the userDataDir this read
    // is about to take. A reservation already held by a job-side window throws
    // here and surfaces through the fillAll() catch below.
    const releaseProfileReservation = reserveSharedProfile(`native-read:${platformId || 'hub'}`);
    const releasePool = pauseBrowserPool(`native-read:${platformId || 'hub'}`);
    let child = null;
    let childExited = false;
    try {
      await closeStealthBrowser();
      // Chrome is one-process-per-userDataDir. If the just-closed stealth browser
      // is still dying, or the PREVIOUS platform's native Chrome hasn't released
      // the profile yet, our spawn HANDS OFF the URL to that process and exits
      // immediately ("Opening in existing browser session") — its window flickers
      // then dies, surfacing as "window never appeared" / "Application isn't
      // running (-600)". Wait for the SingletonLock to clear so we get a real,
      // surviving process. (closeStealthBrowser already waits ~2s for puppeteer's
      // OWN exit; this also covers a sibling native read's Chrome.)
      const profileFree = await waitForProfileUnlocked(userDataDir);
      // Profile confirmed free — write the Apple-Events-JS pref BEFORE launch so
      // Chrome reads it as enabled and the user never has to flip the menu toggle.
      // Only when the lock is actually gone: the atomic write can't corrupt the file,
      // but a still-running Chrome could overwrite our value, so skip rather than
      // race; the read self-heals on the next clean run. (We still spawn either way,
      // matching the existing stale-lock behavior.)
      if (profileFree) await ensureAppleEventsJsEnabled(userDataDir);
      logger.info(`[NativeRead] Spawning non-CDP Chrome for ${platformId} (${urls.length} hub URL(s))`);
      // Args identical to the PROVEN native LOGIN spawn (openNativeLoginWindow).
      // The window is VISIBLE and stays open: if the hub is logged out it bounces
      // to a login screen the human signs into IN this window (the only login that
      // works for Swappa/Mercari's anti-bot — non-CDP).
      child = spawn(chromePath, [
        `--user-data-dir=${userDataDir}`,
        '--profile-directory=Default',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1100,800',
        '--lang=en-US,en',
        // See PUPPETEER_OSCRYPT_PARITY_ARGS in authWindows.js: without these, this
        // raw-spawned Chrome derives its cookie OSCrypt key from the real macOS
        // Keychain, while every Puppeteer-launched Chrome on this same userDataDir
        // uses Chromium's static mock-keychain key — a login done IN this window
        // would write cookies invisible to every later headless scrape/read.
        ...PUPPETEER_OSCRYPT_PARITY_ARGS,
        `--app=${urls[0]}`,
      ], { stdio: 'ignore', detached: false });

      let spawnError = null;
      child.once('error', (e) => { spawnError = e?.message || String(e); });
      // A real Chrome that grabbed the profile stays alive; a handoff process exits
      // within ~1s. Track it so the login-wait bails fast on a handoff/launch fail.
      child.once('exit', () => { childExited = true; });

      // Find OUR window by tab URL (proven login-flow mechanism) and WAIT for it to
      // reach a logged-in state — giving the human time to sign in at the login
      // screen the hub bounced to, instead of instantly reporting an error.
      // Strip a leading `www.` so the substring host-match (and the logged-in
      // detector) survive a www↔non-www redirect post-login — otherwise the hub
      // would read 'unknown' forever and falsely time out despite being logged in.
      const matchHost = (() => { try { return new URL(urls[0]).host.replace(/^www\./, ''); } catch { return ''; } })();
      const loginState = await waitForHubLogin(matchHost, platformId, signal, () => spawnError || childExited);
      if (loginState !== 'logged-in') {
        // Capture what osascript actually sees so the bug report distinguishes the
        // real root causes (no windows / wrong instance / window closed).
        const seen = await describeAllChromeWindows();
        let error;
        if (spawnError) {
          error = `Native Chrome failed to launch: ${spawnError}`;
        } else if (loginState === 'aborted') {
          error = 'Aborted.';
        } else if (loginState === 'window-closed') {
          error = `Native Chrome window was closed before ${platformId} sign-in completed — skipped. Re-run Check All and sign in (or stay logged in) to read this hub.`;
        } else if (loginState === 'stuck') {
          error = `Native Chrome window for ${platformId} never settled on a hub or a login/verification screen within ${Math.round(UNKNOWN_SETTLE_MS / 1000)}s (page may be wedged or its title unreadable). osascript sees: ${seen}`;
        } else if (childExited) {
          error = `Native Chrome exited right after spawn — it handed off to another Chrome already holding the profile (profile not free). osascript sees: ${seen}`;
        } else {
          error = `Native Chrome window never became visible to osascript within ${Math.round(NATIVE_WINDOW_APPEAR_MS / 1000)}s. osascript sees: ${seen}`;
        }
        return fillAll(error);
      }
      logger.info(`[NativeRead] ${platformId} logged in — reading ${urls.length} hub URL(s)`);

      for (const url of urls) {
        if (signal?.aborted) {
          results.set(url, { ok: false, error: 'Aborted.' });
          continue;
        }
        const r = await navigateAndRead(url, matchHost);
        results.set(url, r);
        const ok = r.ok ? `ok (${r.html?.length || 0} bytes)` : `blocked — ${r.error}`;
        logger.info(`[NativeRead] ${platformId} ${url} → ${ok}`);
        // STOP driving the tab the moment the hub REJECTS the session mid-read — a
        // /login bounce (loginBounce), a CF / anti-bot challenge (challenged), an
        // inline login form (loggedOut), or the Apple-Events toggle OFF
        // (appleEventsDisabled). Each further navigateAndRead just reloads the same
        // wall and resets its challenge/reCAPTCHA (the reported "going to same url
        // repeatedly without giving time for human verification to load"). Mark the
        // rest and stop — this window still closes (the finally below always
        // SIGTERMs it so the NEXT platform's spawn gets a free profile), so the
        // user signs in / solves it in the FRESH window the next Check All run
        // opens, not this one. (waitForHubLogin's title guard normally catches a
        // logged-out/challenge state first; this stops a session that drops mid-read.)
        if (r.loggedOut || r.appleEventsDisabled || r.challenged || r.loginBounce) {
          const restFlags = r.loggedOut ? { loggedOut: true } : r.appleEventsDisabled ? { appleEventsDisabled: true } : r.challenged ? { challenged: true } : { loginBounce: true };
          for (const rest of urls) if (!results.has(rest)) results.set(rest, { ok: false, ...restFlags, error: r.error, ...(r.finalUrl ? { finalUrl: r.finalUrl } : {}), ...(r.title ? { title: r.title } : {}) });
          logger.info(`[NativeRead] ${platformId} stopping read — ${r.loggedOut ? 'inline login form (logged out); sign in on next run\'s window' : r.appleEventsDisabled ? 'Apple Events JavaScript is disabled; remaining URLs would fail the same way' : r.challenged ? 'anti-bot challenge is showing; remaining URLs would keep refreshing it' : 'session bounced to a login page; remaining URLs would keep refreshing it — sign in on next run\'s window'}`);
          break;
        }
      }
      return results;
    } finally {
      if (child?.pid && !childExited) {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
      // Wait for OUR Chrome to fully exit (release the SingletonLock) BEFORE
      // releasing the marketplace lock, so the NEXT platform's native read spawns
      // into a FREE profile instead of handing off to this dying process — the
      // mercari→swappa "Application isn't running (-600)" race. Mirrors
      // closeStealthBrowser's own post-close wait.
      await waitForChildExit(child);
      releasePool();
      releaseProfileReservation();
    }
  }, signal).catch((err) => {
    // The lock rejects with AbortError if we were cancelled while queued behind
    // another sell-side op — surface it as per-URL results, never throw (the
    // caller treats a throw as a whole-platform scan failure).
    return fillAll(`Native read did not run: ${err?.message || String(err)}`);
  });
}
