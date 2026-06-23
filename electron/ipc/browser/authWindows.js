import { logger } from '../../logger.js';
import { getStealthBrowser, closeStealthBrowser, getUserDataDir, findChromePath, findSystemChromePath, launchWithProfileLockRetry, reserveSharedProfile } from '../stealthBrowser.js';
import { pauseBrowserPool } from '../browserPool.js';
import { READINESS } from '../scrapeBudget.js';
import { matchesNoResultsSentinel } from '../antiBotDetector.js';
import { execFile as execFileCb, spawn } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';

// ── Auth-window cadence ───────────────────────────────────────────────────────
// Timing for the human-in-the-loop auth/captcha windows: how responsively we
// detect a completed login, how long to keep a hidden window open waiting for
// the user, and the diagnostic heartbeat cadence. These are interaction bounds
// with no page baseline to learn from, so they're named constants (not adaptive).
// (The captcha window's extractor-poll cadence is READINESS.CAPTCHA_POLL_MS.)
const LOGIN_POLL_INTERVAL_MS    = 500;           // login-window auto-close poll cadence
const AUTH_WINDOW_AUTO_CLOSE_MS = 5 * 60 * 1000; // max time a hidden auth/captcha window stays open
const AUTH_HEARTBEAT_LOG_MS     = 10_000;        // "still waiting" diagnostic heartbeat interval
const NATIVE_LOGIN_COOKIE_FLUSH_MS = 2_500;      // let OAuth/session cookies reach disk before verify
const execFile = promisify(execFileCb);

// ── Shared-browser handoff watermark ───────────────────────────────────────────
// A visible captcha-resolve window takes over the shared Chrome profile, which
// requires first CLOSING the headless stealth browser (one userDataDir = one
// browser). That close detaches any scrape pages in flight on the stealth
// browser. The sell-side price-check pipeline can't observe that close directly,
// so we stamp a watermark here; the marketplace scrape compares it before/after
// its run to tell whether a handoff (e.g. a JOB-side captcha-resolve, which the
// sell-side browser lock does NOT gate) detached its pages mid-scrape — turning
// an otherwise-cryptic "Navigating frame was detached" into an explained
// "browser contention" line in the bug report.
let _lastCaptchaHandoffAt = 0;

/**
 * Epoch-ms of the last time a captcha-resolve window closed the shared stealth
 * browser to take the profile (0 if none this session). Read it to detect a
 * browser-close that landed during another operation's scrape window.
 * @returns {number}
 */
export function getLastCaptchaHandoffAt() {
  return _lastCaptchaHandoffAt;
}

// Human-verification / challenge / signup interstitials are NOT a logged-in state —
// the user is still mid-flow. These slip past AUTH_LOGIN_URL_PATTERN in the auto-close
// poll (eBay's captcha splash is /splashui/captcha, and the /signin in its `ru=`
// query is URL-encoded so the login pattern misses it), and such a splash page
// carries enough nav chrome ("Sign out") to false-trip the DOM logged-in heuristic
// — which auto-closed the window WHILE the user was still solving the captcha
// (the reported bug). The poll keeps WAITING while this matches, auto-closing only
// once the URL settles on a real post-auth page. Tokens are chosen to never match a
// logged-in home (ebay.com, /feed, /mypage, /jobseeker/home, …) — see test-runner.
const AUTH_CHALLENGE_URL_PATTERN = /captcha|splashui|\/challenge|checkpoint|__cf_chl|cf_chl_|cf-chl|\/signup|verif(y|ication)|two[-_]?step|two[-_]?factor|\/2fa|\/otp/i;
export function isAuthChallengeUrl(url) {
  return AUTH_CHALLENGE_URL_PATTERN.test(String(url || ''));
}

// Post-login confirmation interstitials — the user IS already authenticated, but
// the platform is showing a one-time security prompt that needs a click before
// it settles on the real destination. eBay's "Trust this device?" page
// (accounts.ebay.com/acctsec/trust-a-device?...&ru=<dest>) is the reported case:
// it carries full logged-in nav chrome ("Sign out"), so the DOM logged-in
// heuristic fires and the window auto-closed before the user could click "Trust"
// — leaving the device permanently untrusted, so eBay re-prompts the 2FA/trust
// step on every future login (the reported hassle). Keep WAITING here (like a
// challenge) so the user can complete the prompt; once they click through, eBay
// redirects to its `ru=` target and the normal auto-close fires on the settled
// page. Closing the window manually still confirms login via the post-close
// verify, so this never traps the user — declining the trust step still leaves
// them logged in. Tokens are chosen to never match a logged-in home.
const AUTH_POST_LOGIN_INTERSTITIAL_PATTERN = /trust-a-device|trust[-_]?(?:this[-_]?)?device|trusted[-_]?device/i;
export function isPostLoginInterstitialUrl(url) {
  return AUTH_POST_LOGIN_INTERSTITIAL_PATTERN.test(String(url || ''));
}

// A URL whose PATH is a login / sign-in / auth screen — i.e. a logged-out bounce.
// `auth(?!or)` matches /auth but not /author; `account/login` covers nested login
// routes. This is the SINGLE source of login-URL detection, shared by the login-
// window auto-close (below), the HTTP verify (accounts.js), the native hub read
// (nativeChromeReader.js), and the hub-scan auth-wall (listingStatusCheck.js) — they
// had drifted into 5 near-copies (one even used bare `auth`, matching /author). PURE.
const AUTH_LOGIN_URL_PATTERN = /\/(signin|sign-in|login|log-in|authenticate|account\/login|auth(?!or))/i;
export function isLoginUrlPath(url) {
  return AUTH_LOGIN_URL_PATTERN.test(String(url || ''));
}
const AUTH_COOKIE_LOGIN_URL_BYPASS_PLATFORMS = new Set(['glassdoor']);

export function canAuthCookieBypassLoginUrl(platformId) {
  return AUTH_COOKIE_LOGIN_URL_BYPASS_PLATFORMS.has(String(platformId || '').toLowerCase());
}

export function getLoginAutoCloseWaitReason({
  platformId,
  currentUrl,
  cookieSignal = false,
  challengeDomSignal = false,
} = {}) {
  const url = String(currentUrl || '');
  if (!url || url === 'about:blank') return 'blank-url';
  if (isAuthChallengeUrl(url)) return 'challenge-url';
  if (challengeDomSignal) return 'challenge-dom';
  if (isPostLoginInterstitialUrl(url)) return 'post-login-interstitial';
  if (isLoginUrlPath(url) && !(cookieSignal && canAuthCookieBypassLoginUrl(platformId))) {
    return cookieSignal ? 'login-url-cookie-not-trusted' : 'login-url';
  }
  return null;
}

async function detectAuthChallengeDomSignal(page) {
  return await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el?.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 2 || rect.height <= 2) return false;
      const style = window.getComputedStyle?.(el);
      return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0');
    };
    const challengeSelectors = [
      '#challenge-form',
      '#challenge-running',
      '#cf-challenge-running',
      '[data-testid="challenge"]',
      '.cf-browser-verification',
      '.cf-turnstile',
      '[id*="cf-chl-widget"]',
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="recaptcha/api2/anchor"]',
      'iframe[src*="recaptcha/api2/bframe"]',
      'iframe[src*="recaptcha/enterprise"]',
      'iframe[src*="hcaptcha.com"]',
      '#datadome-captcha-container',
      'iframe[src*="captcha-delivery.com"]',
      '#px-captcha',
      '[id*="px-captcha"]',
      'iframe[src*="perimeterx"]',
    ];
    if (challengeSelectors.some(selector =>
      Array.from(document.querySelectorAll(selector)).some(isVisible)
    )) {
      return true;
    }
    const text = (document.body?.innerText || document.body?.textContent || '').toLowerCase();
    return (
      text.includes('verify you are human') ||
      text.includes('human verification') ||
      text.includes('checking if the site connection is secure') ||
      text.includes('review the security of your connection') ||
      text.includes('additional verification required') ||
      text.includes('please verify you are a human') ||
      text.includes('press & hold') ||
      text.includes('i am not a robot') ||
      text.includes('complete the captcha')
    );
  }).catch(() => false);
}

export function unwrapInlineExtractorItems(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && Array.isArray(result.items)) return result.items;
  return null;
}

// Platforms whose login must run in a plain, hand-operated Chrome process — NO
// Puppeteer/CDP attached. Two distinct reasons:
//   • Google rejects CDP-controlled Chrome for sign-in. The platform delegates to
//     Google SSO, so under CDP the Google page bounces straight back to the
//     platform's own login screen — an endless loop the user can't escape. Indeed
//     hits this; Mercari does too (its "Continue with Google" callback lands on
//     mercari.com/account/googleauth then re-renders the login page — the reported
//     "keeps redirecting google login back to mercari login page" bug). Mercari is
//     ALSO a native-READ platform (NATIVE_READ_PLATFORMS), so its pages already
//     need real Chrome — login belongs on the same path.
//   • Cloudflare Turnstile rejects the challenge completion under CDP: the
//     `interactiveEnd` postMessage is dropped as coming from an "unexpected source"
//     (the CDP/pptr:evaluate context doesn't match the window Turnstile registered),
//     so no clearance token is ever minted and the "Verify you are human" widget
//     re-spawns forever. Swappa added Turnstile to its login page (it "worked
//     before" under CDP); the only fix is a real, non-automated browser.
export const NATIVE_LOGIN_PLATFORMS = new Set(['indeed', 'swappa', 'mercari']);
const NATIVE_LOGIN_SUCCESS_URLS = {
  indeed: [
    'www.indeed.com/jobs',
  ],
  // Login URL carries ?next=/my/swappa, so a completed login lands on the seller
  // hub — a precise, logged-in-only marker the osascript tab poll can detect.
  swappa: [
    'swappa.com/my/swappa',
  ],
  // Login URL is Mercari's dedicated /login/ page carrying login_callback=/mypage/
  // listings/active/ (PLATFORM_LOGIN_URLS.mercari), so a completed login returns to
  // /mypage — the same marker mercari's verifyUrl checks (connectedFinalUrlMustContain:
  // 'mercari.com/mypage'). While still ON /login/ isNativeLoginSuccess returns false
  // (the URL carries /login), so the poll waits for the human; the Google-OAuth
  // callback (mercari.com/account/googleauth) is also explicitly rejected so the poll
  // doesn't false-succeed mid-redirect.
  mercari: [
    'mercari.com/mypage',
  ],
};

// Per-platform substrings that appear in the page <title> ONLY when logged OUT —
// even though the URL still carries the success marker. Mercari serves its
// login form INLINE at the auth-gated hub (HTTP 200, NO redirect to /login),
// client-rendered over an SSR shell whose <title> is the generic marketing SEO
// string. So a logged-out load of mercari.com/mypage/listings/ has the success
// marker in the URL but this generic title — without this gate isNativeLoginSuccess
// false-succeeds and the window is killed (NATIVE_LOGIN_COOKIE_FLUSH_MS) before
// the user can sign in (the reported "keeps refreshing / can't complete human
// verification" symptom). A real logged-in /mypage renders a "My Listings"-style
// title, so this rejects the logged-out shell without blocking a real login.
const NATIVE_LOGIN_LOGGED_OUT_TITLE_MARKERS = {
  mercari: [
    'go-to marketplace',          // "Your Go-to Marketplace for Deals on Used & Secondhand Items | Mercari"
    'deals on used',
    'log in to mercari',          // the inline form's own heading, if it reaches the title
  ],
};

// Generic <title>s that mean logged-OUT / mid-challenge on ANY platform — a login
// screen ("Sign in", "Log in to …", "Sign up") or a Cloudflare interstitial / human
// verification ("Just a moment…", "Verify you are human", the Swappa challenge the
// user hit at swappa.com/my/swappa). Kept whole-phrase so a logged-in hub title
// can't match. Restores login-shaped title / "just a moment" rejection without a
// bare "sign in" substring that would catch logged-in account/security pages, AND
// gives the native hub-READ classifier a TOGGLE-FREE challenge signal (Swappa's CF
// page reads 'logged-out' → WAIT for the human to solve it, instead of thrashing
// the tab through the hub URLs).
const GENERIC_LOGGED_OUT_TITLE_MARKERS = [
  'just a moment',          // Cloudflare interstitial / Turnstile (Swappa human verification)
  'verify you are human',
  'checking your browser',
  'sign in to',
  'sign in -',
  'sign in |',
  'sign in:',
  'log in to',
  'log in -',
  'log in |',
  'log in:',
  'login |',
  'login:',
  'sign up',
];
const GENERIC_LOGGED_OUT_TITLE_EXACT = new Set(['sign in', 'log in', 'login', 'sign up']);

// True when a page <title> is one a platform serves ONLY when logged OUT at an
// auth-gated URL that still carries the success/host marker (Mercari's inline,
// client-rendered login form over a generic SSR shell) OR a generic login/challenge
// shell on any platform. The SINGLE source of that judgment, shared by both the
// native LOGIN success check (isNativeLoginSuccess) and the native hub-READ
// login-state classifier (nativeChromeReader's nativeReadLoginState) so the two can
// never drift. Empty/absent title → false (no signal; never override the URL/host
// logic). PURE for tests.
export function isLoggedOutTitleForPlatform(platformId, title) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  if (GENERIC_LOGGED_OUT_TITLE_EXACT.has(t.trim())) return true;
  if (GENERIC_LOGGED_OUT_TITLE_MARKERS.some(marker => t.includes(marker))) return true;
  return (NATIVE_LOGIN_LOGGED_OUT_TITLE_MARKERS[platformId] || []).some(marker => t.includes(marker));
}

// Platforms that serve their LOGIN FORM inline at the SAME URL as their post-login
// success marker (Mercari: /mypage/listings/ shows the login form when logged out —
// HTTP 200, no /login redirect). For these the native URL marker is ambiguous, so
// native auto-detect must require a SETTLED, non-empty title (an empty/loading title
// at the marker URL must NOT auto-succeed and close the window mid-login — the
// reported "Mercari lands on login page / keeps refreshing"), AND the result is
// re-confirmed by the HTTP verify (render-wait) before caching connected — see
// isTrustedNativeLoginResult in accounts.js.
const NATIVE_LOGIN_INLINE_PLATFORMS = new Set(['mercari']);
export function isInlineLoginPlatform(platformId) {
  return NATIVE_LOGIN_INLINE_PLATFORMS.has(platformId);
}

const activeAuthWindows = new Map();
let lastAuthWindowDiagnostic = null;
// Ring of COMPLETED login/captcha windows (most recent last). Unlike the single
// `last` pointer and the main-log ring buffer (which scrolls a verbose login flow
// out in seconds), this survives the session so a bug report can answer "I just
// logged into X but it says logged out" — by showing whether X's login window
// actually confirmed success (result=auto-detected) or never did (closed/timeout).
const AUTH_HISTORY_CAP = 16;
const authWindowHistory = [];

/**
 * Compact, render-safe record of one completed login window — the fields that
 * discriminate "login confirmed" from "login never completed". PURE for tests.
 */
export function buildAuthAttemptRecord(diag = {}) {
  const title = String(diag.title || '').replace(/\|/g, '\\|').replace(/`/g, "'").slice(0, 120);
  return {
    platformId: diag.platformId || null,
    result: diag.result || null, // auto-detected | closed | timeout | launch-error | …
    loginSignal: diag.loginSignal || diag.autoDetectedLoginSignal || null, // auth-cookie | dom | auth-gated-url | native-url
    loginDetected: diag.loginDetected ?? (diag.result === 'auto-detected'),
    mode: diag.mode || null, // puppeteer-visible | native-chrome
    url: (String(diag.currentUrl || diag.loginUrl || '').replace(/`/g, "'").slice(0, 180)) || null,
    title: title || null,
    finishedAt: diag.finishedAt || new Date().toISOString(),
  };
}

function updateAuthWindowDiagnostic(platformId, patch = {}) {
  const previous = activeAuthWindows.get(platformId) || {};
  const next = {
    platformId,
    startedAt: previous.startedAt || new Date().toISOString(),
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  activeAuthWindows.set(platformId, next);
  lastAuthWindowDiagnostic = next;
  return next;
}

function finishAuthWindowDiagnostic(platformId, patch = {}) {
  const next = updateAuthWindowDiagnostic(platformId, {
    ...patch,
    finishedAt: new Date().toISOString(),
  });
  authWindowHistory.push(buildAuthAttemptRecord(next));
  if (authWindowHistory.length > AUTH_HISTORY_CAP) {
    authWindowHistory.splice(0, authWindowHistory.length - AUTH_HISTORY_CAP);
  }
  activeAuthWindows.delete(platformId);
  lastAuthWindowDiagnostic = next;
}

export function getAuthWindowDiagnostics() {
  return {
    active: Array.from(activeAuthWindows.values()),
    last: lastAuthWindowDiagnostic,
    history: authWindowHistory.slice(),
  };
}

export async function findGoogleSafeChromePath(fallbackPath) {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : ['/usr/bin/google-chrome'];

  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate);
      return candidate;
    } catch { /* try next */ }
  }
  return fallbackPath;
}

async function getNativeChromeTabs() {
  if (process.platform !== 'darwin') return [];
  const script = `
tell application "Google Chrome"
  set output to ""
  repeat with w in windows
    repeat with t in tabs of w
      set output to output & (URL of t as string) & "||" & (title of t as string) & linefeed
    end repeat
  end repeat
  return output
end tell`;
  try {
    const { stdout } = await execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 });
    return String(stdout || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [url = '', title = ''] = line.split('||');
        return { url, title };
      });
  } catch (error) {
    return [{ url: '', title: '', error: error?.message || String(error) }];
  }
}

// Domains whose native-Chrome tabs belong to this platform's login flow: the
// platform's own site (from PLATFORM_COOKIE_DOMAINS) + Google (SSO delegation).
// Used to pick the right tab out of the user's other open tabs during native login.
function nativeLoginTabDomains(platformId) {
  const own = (PLATFORM_COOKIE_DOMAINS[platformId] || []).map(d => d.replace(/^\./, ''));
  return [...own, 'accounts.google.com'];
}

export function isNativeLoginSuccess(platformId, url, title = '') {
  const lower = String(url || '').toLowerCase();
  const titleLower = String(title || '').toLowerCase();
  if (/\/account\/googleauth\b/i.test(lower)) return false;
  if (!lower || /accounts\.google\.com|\/auth\b|\/login\b|\/signin\b|sign-in/i.test(lower)) return false;
  // Reject the logged-out inline login form that some platforms (Mercari) serve
  // AT the auth-gated success URL with HTTP 200 and no redirect: the URL marker
  // matches but the <title> is the generic marketing/SEO string (or the login
  // heading), not a logged-in page. Without this, clicking Login while logged
  // out auto-"succeeds" and the window is killed before the user can sign in.
  if (isLoggedOutTitleForPlatform(platformId, titleLower)) return false;
  // Inline-login platforms: the success URL ALSO serves the login form, so an empty/
  // loading title at that URL must NOT count as success — otherwise the very first
  // poll (before the page's <title> settles) auto-closes the window before the user
  // can sign in. A real logged-in hub renders a non-empty title; the logged-out shell
  // renders a generic title already rejected above. (accounts.js additionally
  // re-confirms inline-login auto-detects via the HTTP verify.)
  if (isInlineLoginPlatform(platformId) && !titleLower.trim()) return false;
  return (NATIVE_LOGIN_SUCCESS_URLS[platformId] || []).some(marker => lower.includes(marker));
}

/** Known platform login URLs */
export const PLATFORM_LOGIN_URLS = {
  // Job platforms
  // Navigate to myaccount directly — unauthenticated users are redirected to
  // accounts.google.com/signin?continue=myaccount; after login Google redirects
  // to google.com/account/about/ (PLATFORM_AUTH_GATED_URLS fires → auto-closes).
  google:        'https://myaccount.google.com/',
  linkedin:      'https://www.linkedin.com/login',
  indeed:        'https://secure.indeed.com/auth?continue=https%3A%2F%2Fwww.indeed.com%2Fjobs%3Fq%3Dsoftware%2520engineer%26fromage%3D1',
  glassdoor:     'https://www.glassdoor.com/profile/login_input.htm',
  ziprecruiter:  'https://www.ziprecruiter.com/login',
  dice:          'https://www.dice.com/dashboard/login',
  // Marketplace — selling destinations
  ebay:          'https://signin.ebay.com/ws/eBayISAPI.dll?SignIn',
  facebook:      'https://www.facebook.com/login',
  // Mercari is a NATIVE_LOGIN_PLATFORMS member (Google SSO loops under CDP). Point at
  // Mercari's OWN dedicated login page (the exact URL it redirects a logged-out
  // /mypage/listings/ request to) rather than the auth-gated hub: in a raw `--app`
  // window the hub's client-side bounce / inline form-render leaves a BLANK grey
  // screen the user can't sign into (the reported "mercari log in is grey screen" —
  // observed landing on chrome://newtab with an empty <title>), whereas the dedicated
  // /login/ page server-renders the form reliably. This mirrors the WORKING swappa
  // config (dedicated /login with a return param), the one native-login URL that has
  // never gone grey in the same `--app` window. login_callback returns to
  // /mypage/listings/active/ post-login, so the precise mercari.com/mypage success
  // marker (NATIVE_LOGIN_SUCCESS_URLS.mercari) still fires; an already-logged-in user
  // is redirected straight through to /mypage and auto-confirms immediately.
  mercari:       'https://www.mercari.com/login/?login_callback=%2Fmypage%2Flistings%2Factive%2F',
  poshmark:      'https://poshmark.com/login',
  depop:         'https://www.depop.com/login/',
  // ?next=%2Fmy%2Fswappa so a completed login redirects to the seller hub — a precise
  // logged-in marker for native auto-close (NATIVE_LOGIN_SUCCESS_URLS.swappa). The
  // next path is URL-encoded to match how Swappa's own login flow emits it (seen in
  // the CF redirect: /login?next=%2Fmy%2Fswappa). The post-login URL is decoded
  // (/my/swappa), so the success marker is unaffected by this encoding.
  swappa:        'https://swappa.com/login?next=%2Fmy%2Fswappa',
  reverb:        'https://reverb.com/login',
  // AptDeco has NO server login route (/login, /signin, /users/sign_in all 404) —
  // sign-in is a client-side modal. Open the create-listing page, which shows an
  // "Already have an account? Sign in" entry to that modal AND is the verifyUrl,
  // so it renders the logged-in seller form on success. The auto-close poller
  // won't fire (this MinimalLayout page has no sign-out link in the DOM), so login
  // is confirmed when the user closes the window → checkAndLogin re-runs
  // verifySellMonitorLogin (its body-signal check is verified for both states).
  aptdeco:       'https://www.aptdeco.com/sell/new',
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
  glassdoor:   ['at'],              // access token (HttpOnly, ~1yr expiry); written only after a successful login.
                                    // Confirmed by profile diff: present in a logged-in profile, absent in an anonymous
                                    // one. gdId / gdsid / cass / GSESSIONID appear in BOTH states, so they are NOT
                                    // login-only and would false-trip — do not add them here.
  reverb:      ['user_credentials'], // persistent signed credentials; `has_logged_in` is only historical and survives logout.
  aptdeco:     ['token'],            // JWT session credential, set only when logged in (confirmed via cookieStore on a live
                                     // logged-in session; NOT HttpOnly so the poller can read it). Deliberately NOT
                                     // `aptdecofrontend` — that's a Rack/Rails server session that also exists for anonymous
                                     // visitors, so it would false-trip. AptDeco's logged-in DOM is client-rendered, so this
                                     // cookie is the ONLY render-safe login signal (the body-text sniff races the auth swap).
  // Others fall through to DOM signal — add here as we confirm them.
};

/**
 * Auth-gated URL substrings per platform. When the browser lands on a URL
 * containing this string (and it's not a login/auth URL itself), the user MUST
 * be logged in — the site's own redirect would have sent them to /login first if
 * not. Close immediately without any cookie or DOM check.
 *
 * Only add entries here for pages that are genuinely auth-required (return a
 * login redirect for anonymous users, not just empty content).
 */
export const PLATFORM_AUTH_GATED_URLS = {
  google:       'google.com/account/about',  // logged-in: myaccount.google.com → google.com/account/about/?hl=…; anonymous → accounts.google.com/signin
  ziprecruiter: '/jobseeker/',               // post-login landing /jobseeker/home; anonymous → redirected to /user/login
};

/** Cookie domains to check per platform */
export const PLATFORM_COOKIE_DOMAINS = {
  // Job platforms
  google:        ['.google.com'],
  linkedin:      ['.linkedin.com'],
  indeed:        ['.indeed.com'],
  glassdoor:     ['.glassdoor.com'],
  ziprecruiter:  ['.ziprecruiter.com'],
  dice:          ['.dice.com'],
  // Marketplace — selling + pricing
  ebay:          ['.ebay.com'],
  facebook:      ['.facebook.com'],
  mercari:       ['.mercari.com'],
  poshmark:      ['.poshmark.com'],
  depop:         ['.depop.com'],
  swappa:        ['.swappa.com'],
  reverb:        ['.reverb.com'],
  aptdeco:       ['.aptdeco.com'],
  stockx:        ['.stockx.com'],
};

// True if any of `names` is present in `cookies` with a non-empty, non-"0" value.
// The single source of the "is this auth cookie set?" rule — shared by the
// login-window auto-close poller and the cookie-first login verify. PURE for tests.
export function cookieListHasAuth(cookies, names) {
  const want = new Set(Array.isArray(names) ? names : []);
  return (Array.isArray(cookies) ? cookies : []).some(c => want.has(c?.name) && c?.value && c.value !== '0');
}

// Read the live profile cookies and report whether this platform's configured
// auth cookie (PLATFORM_AUTH_COOKIES) is set. Used as a render-safe PRIMARY login
// signal for SPA platforms (AptDeco) whose logged-in DOM is client-rendered, so a
// body-text verify races the client auth swap. Returns false on any error — never
// a false "logged in".
export async function hasPlatformAuthCookie(platformId) {
  const names = PLATFORM_AUTH_COOKIES[platformId];
  const domains = PLATFORM_COOKIE_DOMAINS[platformId];
  if (!names?.length || !domains?.length) return false;
  let page;
  try {
    const browser = await getStealthBrowser();
    page = await browser.newPage();
    const urls = domains.map(d => `https://${d.replace(/^\./, '')}`);
    const cookies = await page.cookies(...urls);
    return cookieListHasAuth(cookies, names);
  } catch {
    return false;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Close a visible login browser robustly. Two failure modes this guards against,
 * both reported as "the browser goes into the wheel of death and won't close
 * after login" (depop, eBay):
 *
 *   1. beforeunload prompts — OAuth/signup/SPA login pages often register a
 *      "Leave site? Changes may not be saved" handler. A programmatic close then
 *      pops a NATIVE modal that blocks the window from closing and beachballs it.
 *      We best-effort null out window.onbeforeunload on every page first.
 *   2. silent hangs — browser.close() resolves when the CDP socket drops, but the
 *      OS Chrome process can linger (the stuck window the user sees). We wait for
 *      the process to actually exit and, if it doesn't within the timeout, LOG it
 *      (so a stuck close is visible in the bug report instead of looking clean)
 *      and SIGKILL it so the window can never linger forever.
 */
async function closeLoginBrowserSafely(browser, label) {
  const proc = browser.process?.();
  try {
    const pages = await browser.pages().catch(() => []);
    await Promise.all(pages.map(p =>
      p.evaluate(() => { window.onbeforeunload = null; }).catch(() => {})
    ));
  } catch { /* best effort — page may be navigating/closed */ }
  await browser.close().catch(() => {});
  if (proc && !proc.killed) {
    const exited = await new Promise((res) => {
      const done = () => res(true);
      proc.once('exit', done);
      setTimeout(() => { proc.removeListener('exit', done); res(false); }, 3000);
    });
    if (!exited) {
      logger.warn(`[StealthBrowser] ${label} login window did NOT terminate within 3s of close() — visible Chrome was likely stuck on a beforeunload prompt or hung renderer (the "wheel of death"); force-killing so it can't linger.`);
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
}

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
  const releaseProfileReservation = reserveSharedProfile(`login-window:${platformId}`);

  try {
    // For native-login platforms (e.g. Indeed) the login window and the scraper
    // MUST use the same Chrome executable. On macOS, Chrome derives its cookie
    // encryption key from the app's bundle ID via the system Keychain. Playwright's
    // "Google Chrome for Testing" (com.google.Chrome.for.Testing) and system Google
    // Chrome (com.google.Chrome) have different bundle IDs → different Keychain
    // entries → cookies written by one cannot be decrypted by the other. Always
    // use system Chrome for native-login platforms so the encryption key matches
    // the scraper (which uses findSystemChromePath). Fall back to findChromePath
    // for Puppeteer-login platforms where both login and scraper share the same
    // executable through the normal path.
    const executablePath = process.env.CHROME_PATH ||
      (NATIVE_LOGIN_PLATFORMS.has(platformId)
        ? (await findSystemChromePath() ?? await findChromePath())
        : await findChromePath());
    logger.info(`[StealthBrowser] Opening login window for ${platformId} (executable: ${executablePath})`);

    // Close the headless scraping browser FIRST. Chrome locks userDataDir per
    // process — if the singleton is still running when we try to launch the
    // login window on the same dir, the login window's launch either races,
    // silently uses an empty profile, or fails outright. The previous order
    // (launch login → then close singleton) produced a window that looked
    // logged-out even after a successful prior login, and post-login cookies
    // didn't always reach disk in time for verifySellMonitorLogin.
    await closeStealthBrowser();

    if (NATIVE_LOGIN_PLATFORMS.has(platformId)) {
      return await openNativeLoginWindow({ platformId, url, executablePath, sender });
    }

  // Launch a SEPARATE visible browser for login (now has exclusive access to userDataDir).
  // ignoreDefaultArgs removes --enable-automation which puppeteer adds by default —
  // it's what triggers the "Chrome is being controlled by automated test software"
  // banner AND the window.cdc_... properties that sites like Glassdoor use to detect
  // puppeteer and return a blank page. --disable-blink-features=AutomationControlled
  // already removes navigator.webdriver; stripping --enable-automation makes the
  // login window indistinguishable from a regular Chrome session.
  const loginBrowser = await launchWithProfileLockRetry({
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
  }, 'login-window', url);

  const pages = await loginBrowser.pages();
  const page = pages[0] || await loginBrowser.newPage();
  updateAuthWindowDiagnostic(platformId, {
    mode: 'puppeteer-visible',
    loginUrl: url,
    currentUrl: page.url(),
    executable: executablePath,
    userDataDir: await getUserDataDir(),
  });

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
  return await new Promise((resolve) => {
    let isTerminated = false;
    let autoClosePoll = null;
    let autoCloseTimeout = null;

    // ── Auto-close polling ──────────────────────────────────────────────────
    // After every ~0.5s, check whether the page looks "logged in." Challenge
    // URLs/DOM and plain login URLs keep the window open. Auth-gated URLs,
    // trusted auth cookies, or sign-out/logout DOM can auto-close after those
    // guards pass.
    //
    // Catches both fresh logins (user types creds → site redirects → poll
    // sees the new URL + sign-out link) AND "already logged in" cases where
    // visiting the login URL bounces straight to the home page.
    //
    // Capped at 5 minutes so a tab the user walked away from doesn't poll
    // forever. User-initiated close still works the same way it always did.
    const AUTO_CLOSE_AFTER_MS = AUTH_WINDOW_AUTO_CLOSE_MS;
    const POLL_INTERVAL_MS = LOGIN_POLL_INTERVAL_MS;

    // Diagnostic state for the poll — log URL transitions once and emit a
    // "still waiting" heartbeat every ~10s so the bug report's main-process
    // log buffer reveals WHY auto-close didn't fire (vs. silent failure).
    let lastNonLoginUrl = null;
    let lastHeartbeatLog = 0;
    // Set by any auto-detection path — carried through cleanup() → resolve()
    // so the caller can skip the HTTP re-verify when we already confirmed login.
    let autoDetectedLoginUrl = null;
    let autoDetectedLoginSignal = null;
    let loginBrowserCloseRequested = false;
    let loginBrowserClosePromise = null;

    const requestLoginBrowserClose = async () => {
      loginBrowserCloseRequested = true;
      if (!loginBrowserClosePromise) {
        loginBrowserClosePromise = closeLoginBrowserSafely(loginBrowser, platformId);
      }
      await loginBrowserClosePromise;
    };

    autoClosePoll = setInterval(async () => {
      if (isTerminated) return;
      try {
        if (page.isClosed?.()) return;
        const currentUrl = page.url();
        if (!currentUrl || currentUrl === 'about:blank') return;
        updateAuthWindowDiagnostic(platformId, {
          mode: 'puppeteer-visible',
          currentUrl,
          title: await page.title().catch(() => ''),
        });
        // Cookie signal — a definitive per-platform auth cookie (PLATFORM_AUTH_COOKIES)
        // is the most reliable logged-in indicator, and HttpOnly cookies ARE visible via
        // CDP (c_user / li_at / glassdoor `at`, …). Computed BEFORE the login-URL guard:
        // some SPAs suppress the post-auth redirect and re-render the login form, leaving
        // the window stuck on a login URL even though the session cookie is already
        // written (Glassdoor's "exiting post-authentication flow, suppressing redirect"
        // path). The old guard returned on every such tick, so the window looped forever
        // and never auto-closed — even though the separate post-close HTTP verify saw the
        // cookie and marked the platform connected. Preferred for SPAs (Facebook etc.)
        // where the account menu is lazy-rendered and "Log out" text isn't in the DOM.
        let cookieSignal = false;
        const expectedCookies = PLATFORM_AUTH_COOKIES[platformId];
        if (expectedCookies?.length) {
          try {
            cookieSignal = cookieListHasAuth(await page.cookies(), expectedCookies);
          } catch { /* page may be navigating */ }
        }

        const challengeDomSignal = await detectAuthChallengeDomSignal(page);
        const waitReason = getLoginAutoCloseWaitReason({
          platformId,
          currentUrl,
          cookieSignal,
          challengeDomSignal,
        });
        if (waitReason) {
          const now = Date.now();
          if (now - lastHeartbeatLog > AUTH_HEARTBEAT_LOG_MS) {
            lastHeartbeatLog = now;
            const cookieNote = cookieSignal
              ? `auth cookie present, but ${waitReason === 'login-url-cookie-not-trusted' ? 'this platform must leave the login page before auto-close' : 'a challenge/login guard is still active'}`
              : expectedCookies?.length
                ? `expected cookies ${expectedCookies.join(',')} not set`
                : 'no auth-cookie config; DOM scrape only';
            logger.info(`[StealthBrowser] ${platformId} auto-close waiting: URL ${currentUrl} — ${waitReason}; ${cookieNote}`);
          }
          return;
        }

        if (lastNonLoginUrl !== currentUrl) {
          if (!lastNonLoginUrl) logger.info(`[StealthBrowser] ${platformId} URL transitioned past login: ${currentUrl}`);
          lastNonLoginUrl = currentUrl;
        }

        // Auth-gated URL fast-path — the URL itself proves logged-in state.
        // If the platform has a known auth-gated path and the browser landed
        // there, the site's own redirect already handled the auth check; no
        // cookie or DOM signal needed. Fires before the cookie/DOM checks so
        // SPAs that lazy-render their nav (Wellfound) don't block auto-close.
        const authGatedPath = PLATFORM_AUTH_GATED_URLS[platformId];
        if (authGatedPath && currentUrl.includes(authGatedPath)) {
          logger.info(`[StealthBrowser] Auto-detected logged-in state for ${platformId} via auth-gated URL ${currentUrl} — closing window`);
          autoDetectedLoginUrl = currentUrl;
          autoDetectedLoginSignal = 'auth-gated-url';
          if (autoClosePoll) { clearInterval(autoClosePoll); autoClosePoll = null; }
          if (autoCloseTimeout) { clearTimeout(autoCloseTimeout); autoCloseTimeout = null; }
          await requestLoginBrowserClose();
          return;
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
          autoDetectedLoginUrl = currentUrl;
          autoDetectedLoginSignal = cookieSignal ? 'auth-cookie' : 'dom';
          if (autoClosePoll) { clearInterval(autoClosePoll); autoClosePoll = null; }
          if (autoCloseTimeout) { clearTimeout(autoCloseTimeout); autoCloseTimeout = null; }
          // Programmatic close fires the 'disconnected' event → cleanup
          // below → resolves the promise → caller's verify runs and the
          // cache + Settings pill update with the success result.
          await requestLoginBrowserClose();
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
      if (loginBrowserCloseRequested) return;
      try {
        const remaining = await loginBrowser.pages();
        if (remaining.length === 0) {
          logger.info(`[StealthBrowser] ${platformId} last page closed by user — closing browser`);
          await requestLoginBrowserClose();
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
        await requestLoginBrowserClose();
      } catch { /* ignored */ }
      // Chrome's `disconnected` event fires when the CDP WebSocket drops, but
      // SQLite cookie writes may still be in flight. Without this pause the verify
      // browser launches on the same userDataDir, reads a stale cookie store, and
      // returns 403 even for a successful login (observed: 1ms gap between
      // "last page closed" and "Verifying... Launching Chrome"). 800ms is enough
      // for Chrome's cookie flush on the slowest test machines while still feeling
      // instantaneous to the user.
      await new Promise(r => setTimeout(r, 800));
      // Record whether THIS window confirmed login (cookie/DOM/auth-gated URL) vs
      // just closed without detection — the discriminator for "I logged in but it
      // says logged out" in the bug report's login-attempt history.
      finishAuthWindowDiagnostic(platformId, {
        result: autoDetectedLoginUrl ? 'auto-detected' : 'closed',
        loginDetected: !!autoDetectedLoginUrl,
        loginSignal: autoDetectedLoginSignal,
        currentUrl: autoDetectedLoginUrl || undefined,
      });
      resolve({ success: true, platform: platformId, closedByApp: sender?.isDestroyed?.(), loginDetected: !!autoDetectedLoginUrl, loginUrl: autoDetectedLoginUrl, loginSignal: autoDetectedLoginSignal });
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
  } finally {
    releaseProfileReservation();
  }
}

async function openNativeLoginWindow({ platformId, url, executablePath, sender = null }) {
  const userDataDir = await getUserDataDir();
  const nativeExecutablePath = await findGoogleSafeChromePath(executablePath);
  logger.info(`[StealthBrowser] Opening native Chrome login window for ${platformId} (no CDP automation)`);
  updateAuthWindowDiagnostic(platformId, {
    mode: 'native-chrome',
    loginUrl: url,
    currentUrl: url,
    executable: nativeExecutablePath,
    userDataDir,
  });

  const chromeArgs = [
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1100,800',
    '--lang=en-US,en',
    `--app=${url}`,
  ];
  updateAuthWindowDiagnostic(platformId, { chromeArgs });

  const child = spawn(nativeExecutablePath, chromeArgs, {
    stdio: 'ignore',
    detached: false,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    let poll = null;
    let closeAfterSuccessTimer = null;
    let pendingSuccessResult = null;
    let lastSeenUrl = '';
    let lastHeartbeatLog = 0;

    const settle = async (result) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (timeout) clearTimeout(timeout);
      if (closeAfterSuccessTimer) clearTimeout(closeAfterSuccessTimer);
      if (sender) sender.removeListener('destroyed', onSenderDestroyed);
      await new Promise(r => setTimeout(r, 800));
      finishAuthWindowDiagnostic(platformId, result);
      resolve({
        success: true,
        platform: platformId,
        nativeChrome: true,
        closedByApp: result.closedByApp,
        result: result.result,
        currentUrl: result.currentUrl,
        title: result.title,
      });
    };

    const onSenderDestroyed = () => {
      try { child.kill('SIGTERM'); } catch { /* already closed */ }
      settle({ result: 'app-window-destroyed', closedByApp: true });
    };

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (sender) sender.removeListener('destroyed', onSenderDestroyed);
      finishAuthWindowDiagnostic(platformId, { result: 'launch-error', error: error?.message || String(error) });
      reject(error);
    });

    child.once('exit', (code, signal) => {
      logger.info(`[StealthBrowser] Native Chrome login window for ${platformId} exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      settle(pendingSuccessResult || { result: 'closed', exitCode: code, signal });
    });

    poll = setInterval(async () => {
      if (settled) return;
      const tabs = await getNativeChromeTabs();
      // Match the tab for THIS platform's flow by domain — the platform's own
      // site plus Google (flows that delegate to Google SSO). Was hardcoded to
      // indeed/google; derived now so each native platform (swappa, …) finds its tab.
      const domains = nativeLoginTabDomains(platformId);
      const matchingTab = tabs.find(t => {
        const u = String(t.url || '').toLowerCase();
        return domains.some(d => u.includes(d));
      }) || tabs[0];

      if (!matchingTab) return;
      updateAuthWindowDiagnostic(platformId, {
        mode: 'native-chrome',
        currentUrl: matchingTab.url || '',
        title: matchingTab.title || '',
        nativePollError: matchingTab.error || null,
      });

      if (matchingTab.url && matchingTab.url !== lastSeenUrl) {
        lastSeenUrl = matchingTab.url;
        logger.info(`[StealthBrowser] Native ${platformId} login URL now ${matchingTab.url}`);
      }

      if (isNativeLoginSuccess(platformId, matchingTab.url, matchingTab.title)) {
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
        pendingSuccessResult = { result: 'auto-detected', currentUrl: matchingTab.url, title: matchingTab.title };
        updateAuthWindowDiagnostic(platformId, {
          result: 'auto-detected',
          currentUrl: matchingTab.url,
          title: matchingTab.title,
        });
        logger.info(`[StealthBrowser] Auto-detected logged-in state for ${platformId} via native URL ${matchingTab.url} — waiting ${NATIVE_LOGIN_COOKIE_FLUSH_MS}ms before closing window`);
        closeAfterSuccessTimer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch { /* already closed */ }
          settle(pendingSuccessResult);
        }, NATIVE_LOGIN_COOKIE_FLUSH_MS);
        return;
      }

      const now = Date.now();
      if (now - lastHeartbeatLog > AUTH_HEARTBEAT_LOG_MS) {
        lastHeartbeatLog = now;
        logger.info(`[StealthBrowser] Native ${platformId} auto-close waiting: URL ${matchingTab.url || 'unknown'}; title=${matchingTab.title || 'unknown'}`);
      }
    }, LOGIN_POLL_INTERVAL_MS * 2);

    timeout = setTimeout(() => {
      logger.info(`[StealthBrowser] Native Chrome login window for ${platformId} timed out — closing process`);
      try { child.kill('SIGTERM'); } catch { /* already closed */ }
      settle({ result: 'timeout', timedOut: true });
    }, AUTH_WINDOW_AUTO_CLOSE_MS);

    if (sender) {
      if (sender.isDestroyed()) {
        onSenderDestroyed();
        return;
      }
      sender.once('destroyed', onSenderDestroyed);
    }
  });
}

/**
 * Launch a VISIBLE Chrome window with a hard timeout + lifecycle logging.
 *
 * A bare `puppeteer.launch()` can hang INDEFINITELY when the shared userDataDir
 * is still locked by an active scrape browser, or when macOS is blocking on a
 * first-launch permission prompt the user never sees. Symptom: the user clicks
 * Solve, nothing happens, the IPC task stays registered, and the bug report
 * shows "Opening …" as the last line with no outcome — impossible to debug.
 *
 * The timeout converts that silent hang into a surfaced, LOGGED error; the
 * success/failure logs make the window-open outcome visible in every bug report.
 */
async function launchVisibleWindow(label, url, launchOpts) {
  const LAUNCH_TIMEOUT_MS = 30000;
  // launchWithProfileLockRetry transparently rides out a shared-profile lock
  // collision (e.g. another captcha-resolve window still owns the userDataDir
  // for its grace/solve window) by waiting + retrying, instead of failing with
  // the cryptic "Opening in existing browser session" that forced the user to
  // click Solve a second time. Its ~11s retry budget fits inside LAUNCH_TIMEOUT_MS.
  const context = label === 'Captcha-resolve window' ? 'captcha-resolve-window' : 'visible-window';
  const launchP = launchWithProfileLockRetry(launchOpts, context, url);
  let timer = null;
  let timedOut = false;
  // If the launch resolves AFTER we've given up, close the orphan so a slow
  // Chrome doesn't leak a process the caller no longer holds a handle to.
  launchP.then((b) => { if (timedOut) b.close().catch(() => {}); }, () => {});
  try {
    const browser = await Promise.race([
      launchP,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`${label} launch did not complete within ${LAUNCH_TIMEOUT_MS / 1000}s — Chrome may be blocked on a macOS permission prompt, or the userDataDir is still locked by an active scrape browser (url: ${url})`));
        }, LAUNCH_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    logger.info(`[StealthBrowser] ${label} Chrome launched (url: ${url})`);
    return browser;
  } catch (err) {
    clearTimeout(timer);
    logger.error(`[StealthBrowser] ${label} launch FAILED: ${err?.message || String(err)}`);
    throw err;
  }
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
  logger.info(`[StealthBrowser] Opening captcha-resolve window for ${url} (executable: ${executablePath})`);

  // Register with the auth-window diagnostic tracker BEFORE the launch so a hung
  // launch is captured as an in-flight entry in the bug report (it was previously
  // invisible — only login windows registered, so "window not opening" had no
  // trace). Keyed by host so it doesn't collide with platform login entries.
  const diagKey = `captcha:${(() => { try { return new URL(url).host; } catch { return 'unknown'; } })()}`;
  updateAuthWindowDiagnostic(diagKey, { mode: 'captcha-resolve', loginUrl: url, currentUrl: url, title: '', result: 'launching' });
  const releaseProfileReservation = reserveSharedProfile(`captcha-resolve:${diagKey}`);

  // Same userDataDir-lock dance as openLoginWindow — Chrome won't let the
  // visible browser launch on a dir the headless scraper still holds. Bracketed
  // with logs so a hang HERE (waiting on the scrape browser to exit) is
  // distinguishable in the bug report from a hang in the launch below.
  const releaseBrowserPoolPause = pauseBrowserPool(`captcha-resolve:${diagKey}`);
  let captchaBrowser;
  try {
    logger.info('[StealthBrowser] Captcha window: closing stealth browser to release the profile lock…');
    // Stamp the handoff BEFORE the close so a concurrent scrape that loses its
    // pages to this close can attribute the detach (see getLastCaptchaHandoffAt).
    _lastCaptchaHandoffAt = Date.now();
    await closeStealthBrowser();
    logger.info('[StealthBrowser] Captcha window: stealth browser closed — launching visible window');

    captchaBrowser = await launchVisibleWindow('Captcha-resolve window', url, {
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
  } catch (err) {
    releaseProfileReservation();
    releaseBrowserPoolPause();
    finishAuthWindowDiagnostic(diagKey, { result: 'launch-error', error: err?.message || String(err) });
    throw err;
  }
  updateAuthWindowDiagnostic(diagKey, { result: 'open' });

  let page;
  let originalHost;
  try {
    const pages = await captchaBrowser.pages();
    page = pages[0] || await captchaBrowser.newPage();
    // Capture the original host so a user wandering off to another site doesn't
    // false-positive the "challenge gone" check on an unrelated page.
    originalHost = (() => { try { return new URL(url).host; } catch { return null; } })();
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
  } catch (err) {
    releaseProfileReservation();
    releaseBrowserPoolPause();
    finishAuthWindowDiagnostic(diagKey, { result: 'setup-error', error: err?.message || String(err) });
    try { await captchaBrowser?.close(); } catch { /* ignored */ }
    throw err;
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
    let siteChangedHandled = false; // de-dupe guard for the SITE_CHANGED branch — must NOT be `isTerminated`, see below
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
          const innerText = document.body?.innerText || '';
          // bodyText (bounded) lets the poll loop test a definitive "0 results"
          // empty-state sentinel — a genuinely-empty page (e.g. Swappa for a
          // non-electronics query) has nothing for the user to clear, so we
          // conclude immediately instead of holding the full empty grace.
          return { hits, textLength: innerText.length, consentVisible, bodyText: innerText.slice(0, 20000) };
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
          if (resolved || isTerminated) return;
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
              items = unwrapInlineExtractorItems(result);
              if (!items) {
                extractOutcome = 'non-array';
                logger.warn(`[StealthBrowser] Inline extract returned non-array (${typeof result}); falling back to rescrape`);
              }
            } catch (e) {
              extractOutcome = 'threw';
              const isSC = /SITE_CHANGED/i.test(e?.message || '');
              logger.warn(`[StealthBrowser] Inline extract failed (${e?.message || e}); ${isSC ? 'code fix needed — not triggering auto-rescrape' : 'falling back to rescrape'}`);
              if (isSC) {
                // Guard against concurrent probe calls (multiple evaluates in-flight
                // when the page finishes loading) both hitting this handler. The
                // second one's warn/close would be a harmless duplicate, but it
                // produces a confusing double WARN in the log.
                //
                // CRITICAL: this guard must NOT reuse `isTerminated`. That flag is
                // cleanup()'s idempotency latch — setting it here makes the
                // `disconnected` → cleanup() handler bail at its own `if
                // (isTerminated) return`, so resolve() and finishAuthWindowDiagnostic()
                // never fire. The Chrome window closes, but the awaiting
                // resolve-job-source IPC never returns: the node's task stays
                // registered and the source card spins on "resolving" forever
                // (observed as "Glassdoor stuck" with a dangling Active IPC Task and
                // an Auth Window stuck at result=open). Use a dedicated flag and let
                // `close()` → cleanup() do the real teardown + resolve.
                if (siteChangedHandled) return;
                siteChangedHandled = true;
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
            } else if (matchesNoResultsSentinel(probe.bodyText)) {
              // 0 items, no challenge, no consent wall, AND the page shows the
              // site's OWN definitive "0 results" empty-state (e.g. Swappa "No
              // products match this criteria" — Swappa sells only electronics, so
              // a guitar query is genuinely empty). There is nothing for the user
              // to clear, so conclude immediately rather than holding the full 30s
              // human-scale grace (the "stuck on Swappa" report). The anti-bot
              // detector now suppresses the Solve button for this case upstream, so
              // this window normally won't even open — this is defense-in-depth for
              // any resolve window that lands on a genuinely-empty page.
              extractOutcome = 'matched 0 (no-results sentinel)';
              logger.info(`[StealthBrowser] ${currentHost} shows a definitive "0 results" empty-state — concluding empty immediately (no captcha/consent, no grace wait)`);
              await finishCleared(items, 'empty-noresults'); // items === []
              return;
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
      // Compute the resolve "why" up front. `resolved` distinguishes
      // "auto-detected cleared" from "user closed manually." `diag` carries the
      // close reason + what the extractor saw + page state so a 0-extract isn't an
      // unexplained dead end.
      const closeReason = resolved ? (autoCloseReason || 'cleared')
        : siteChangedError ? 'site-changed-auto-close'
        : signal?.aborted ? 'aborted'
        : sender?.isDestroyed?.() ? 'app-closed'
        : pollTimedOut ? 'user-closed-after-timeout'
        : 'user-closed';
      const diag = {
        closeReason,
        extractOutcome: extractOutcome || (inlineExtractorJS ? 'never-extracted' : 'no-extractor'),
        finalHost: lastHost,
        sawChallenge: everSawChallenge,
        sawConsent: everSawConsent,
        textLen: lastTextLen,
        siteChangedError: siteChangedError || null,
      };
      // Persist the diag ONTO the auth-window record (not just the resolve return
      // value). The bug report renders these fields, so a hung/odd resolve is
      // self-explaining without the 60-line main-log ring buffer — which is where
      // the SITE_CHANGED close reason lived in the "Glassdoor stuck" report, one
      // long-running window away from scrolling out entirely.
      finishAuthWindowDiagnostic(diagKey, { result: resolved ? 'cleared' : 'closed', ...diag });
      if (autoClosePoll) { clearInterval(autoClosePoll); autoClosePoll = null; }
      if (autoCloseTimeout) { clearTimeout(autoCloseTimeout); autoCloseTimeout = null; }
      if (signal) signal.removeEventListener?.('abort', onAbort);
      if (sender) sender.removeListener('destroyed', cleanup);
      try { await captchaBrowser.close(); } catch { /* ignored */ }
      releaseProfileReservation();
      releaseBrowserPoolPause();
      // `items` is the inline-extracted comp data captured from the visible
      // session before close — when present, caller skips the headless rescrape
      // (which would re-trigger the same bot wall).
      resolve({
        success: true, resolved, items: extractedItems,
        siteChangedError: siteChangedError || null,
        closedByApp: sender?.isDestroyed?.(),
        diag,
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
