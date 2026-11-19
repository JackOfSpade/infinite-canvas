import { updateOverlay, injectOverlay } from './scrapeBrowser.js';
import {
  recordManualScraperTelemetry,
  recordChallengeDetectedTelemetry,
  recordActivityBeat,
  notePaceChallengeStart,
  notePaceChallengeEnd,
  formatWaitDuration,
} from './scrapeTelemetry.js';
import { NAV_SETTLE_MS, CONTENT_POLL_MS, CONTENT_TIMEOUT_MS, CONTENT_SELECTORS } from './walkRules.js';
import { challengeInputVerdict, createChallengeInputProbe, describeChallengeInput } from '../challengeInputProbe.js';
import { markManualSolveRequired } from '../../scrapeVerification.js';
import { logger } from '../../../logger.js';
import { humanDelay } from '../../../utils/humanDelay.js';
import { overlayTabLayout } from '../scraperOverlay.js';

// We wait INDEFINITELY for the user to solve a real (solvable) challenge — never
// skip a source out from under someone mid-solve. The escape hatches are an abort
// (Reset / hub close) and a hard block (nothing to solve, skipped immediately).
// This is just the cadence for a "still waiting" heartbeat log during that wait.
// It BACKS OFF: the main-process ring buffer that a bug report reads holds 200
// lines total, so a fixed 30s beat evicts every other main-process line after
// ~100 minutes of waiting — erasing exactly the history needed to explain why
// the wait started. Doubling to a 10-minute ceiling keeps an unattended wait
// visibly alive while costing the ring ~8 lines an hour instead of ~120.
const CHALLENGE_HEARTBEAT_BASE_MS = 30_000;

const CHALLENGE_HEARTBEAT_MAX_MS  = 600_000;

// The liveness beat is deliberately NOT backed off with the log line above. It
// costs the log ring nothing (it updates one in-memory slot and a throttled
// renderer sink), and letting it go stale makes the bug report assert
// "⚠️ possibly hung" over a wait that is doing exactly what it was designed to
// do — wait for a human. It also keeps the elapsed time moving on the source
// card, which is the only place the user can see the wait is still theirs.
export const CHALLENGE_ACTIVITY_BEAT_MS = 30_000;

// An unsolved wait past these marks gets an explicit, source-named warning and
// the same line on the overlay. The heartbeat alone is invisible in the report:
// it says "still waiting", not "nothing has happened for half an hour".
export const CHALLENGE_ESCALATE_MS = [15 * 60_000, 30 * 60_000];

export const CHALLENGE_STABLE_MS    = 1_500;

// page must be challenge-free for this long before resuming — guards against re-serves
// Cloudflare can remove a solved Turnstile iframe before it either redirects or
// re-renders the challenge. Do not mistake that short DOM transition for a final
// terminal block: keep the visible browser open long enough for a human to see
// what happened and for the widget to return.
export const CHALLENGE_TERMINAL_TRANSITION_GRACE_MS = 10_000;

// Anti-bot interstitials REPLACE the document with a few hundred characters of
// copy (a headline, one sentence, a Ray ID). A job board's results or detail
// page is thousands. That size difference is the only source-agnostic way to
// tell "this page IS the challenge" from "this page merely CONTAINS words a
// challenge also uses" — the latter is ordinary posting prose, e.g. a Canadian
// role that requires passing a "security check". Measured, not selector-based,
// so it holds for every board without per-site markup knowledge.
export const CHALLENGE_INTERSTITIAL_MAX_CHARS = 2_000;

/**
 * Cadence for the "still waiting for the user" beat, by how many beats have
 * already been emitted for this wait. Exported so the backoff is asserted
 * directly rather than inferred from wall-clock log spacing.
 */
export function challengeHeartbeatIntervalMs(beatsEmitted = 0) {
  const beats = Math.max(0, Math.floor(Number(beatsEmitted) || 0));
  // Cap the exponent before it overflows into Infinity on a very long wait.
  const doublings = Math.min(beats, 32);
  return Math.min(CHALLENGE_HEARTBEAT_BASE_MS * (2 ** doublings), CHALLENGE_HEARTBEAT_MAX_MS);
}

// Static description of how the manual-scrape browser is launched. Keep in sync
// with the launchWithProfileLockRetry() call in scrapeManualSources(). The point: a reader
// instantly sees we're already headful with the standard evasions, so the block
// is NOT "we forgot to run headful".
const BROWSER_LAUNCH_PROFILE =
  'headful system-Chrome · webdriver masked · AutomationControlled disabled · --enable-automation stripped · no CDP pause bridge';

// Egress (public) IP + best-effort datacenter/residential classification. ipify
// gives the IP (same source the LinkedIn egress trail uses); ip-api adds org +
// a `hosting` flag so a reader can tell a datacenter/VPN exit (the dominant
// DataDome trigger) from a residential IP. Returns nulls on any failure. ip-api's
// free endpoint is HTTP only (HTTPS needs its paid key), so that call stays plain
// HTTP and only reports the public IP it was already given by the HTTPS ipify call.
async function lookupEgress() {
  const out = { ip: null, isp: null, org: null, hosting: null };
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 4000);
    const r = await fetch('https://api.ipify.org?format=json', { signal: c.signal }).finally(() => clearTimeout(t));
    if (r.ok) { const d = await r.json(); if (typeof d?.ip === 'string') out.ip = d.ip; }
  } catch { /* fail-soft */ }
  if (out.ip) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 4000);
      const r = await fetch(`http://ip-api.com/json/${out.ip}?fields=status,isp,org,as,hosting`, { signal: c.signal }).finally(() => clearTimeout(t));
      if (r.ok) {
        const d = await r.json();
        if (d?.status === 'success') {
          out.isp = d.isp || null;
          out.org = d.org || d.as || null;
          // ip-api's `hosting` flag misses many VPNs (ProtonVPN returns false), so
          // it's a positive signal only: true ⇒ datacenter, false ⇒ unknown (the
          // isp/org is the real tell). Never infer "residential" from it.
          out.hosting = d.hosting === true ? true : null;
        }
      }
    } catch { /* fail-soft */ }
  }
  return out;
}

// DataDome (and most vendors) render a human-facing incident ID on the block page
// ("ID: xxxxxxxx-…"). Extract it best-effort so a report can be cross-referenced
// against the vendor / a support ticket.
async function extractBlockId(page) {
  try {
    return await page.evaluate(() => {
      const m = (document.body?.innerText || '').match(/\bID:\s*([0-9a-f]{6,}[0-9a-f-]*)/i);
      return m ? m[1] : null;
    });
  } catch { return null; }
}

// ── Challenge detection ───────────────────────────────────────────────────────
const MANUAL_VERIFICATION_TEXT_MARKERS = Object.freeze([
  'verify you are human',
  'let us know you',
  'security check',
  'your ray id for this request',
  'additional verification required',
  'i am not a robot',
  // Glassdoor's current terminal Cloudflare block has no challenge widget and
  // does not use the older "your ray id for this request" wording.
  'humans only',
  'glassdoor has been built on the contributions of real employees and job seekers',
  'if you have been mistakenly blocked from accessing our site',
]);

const MANUAL_HARD_BLOCK_TEXT_MARKERS = Object.freeze([
  'humans only',
  'if you have been mistakenly blocked from accessing our site',
]);

/** Text-only seam shared by the browser probe and deterministic regressions. */
export function hasManualVerificationText(value) {
  const bodyText = String(value || '').toLowerCase();
  return MANUAL_VERIFICATION_TEXT_MARKERS.some(marker => bodyText.includes(marker));
}

export function hasManualHardBlockText(value) {
  const bodyText = String(value || '').toLowerCase();
  return MANUAL_HARD_BLOCK_TEXT_MARKERS.some(marker => bodyText.includes(marker));
}

/**
 * Finalize the DOM probe's challenge verdict outside page.evaluate so the
 * exact policy is unit-testable. Provider copy is not enough to call a page
 * terminal: Glassdoor can render its "Humans only" text alongside a live
 * Turnstile widget. In that state the user must be allowed to solve, and a
 * challenge that is served again must remain in the wait loop.
 */
export function classifyManualChallengeSignals(signals = {}) {
  const interactive = !!(
    signals.hasChallengeShell
    || signals.hasPerimeterXBlock
    || signals.hasCloudflareChallengeFrame
    || signals.hasCloudflareTurnstileWidget
    || Number(signals.visibleRecaptchaFrames) > 0
    || Number(signals.visibleHCaptchaFrames) > 0
    // DataDome's block view has no captcha to solve, so it must not count
    // as something a person can clear.
    || ((signals.hasDataDomeFrame || signals.hasDataDomeScript) && !signals.hasDataDomeBlockFrame)
  );
  // `verification-text` is the ONLY verdict derived from free page prose, so it
  // is the only one an ordinary listing can trip by itself. Left uncorroborated
  // it is the most expensive false positive this module can produce: on a list
  // page it parks the run on an indefinite human-solve wait, and on a detail
  // page it hard-blocks the whole enrichment pass — both while the real content
  // is sitting right there on screen. Require corroboration before honouring
  // it: a widget the user could actually solve, a document small enough to BE
  // an interstitial, or the specific post-solve "verification successful"
  // transient (a real challenge state that must not be read as clean).
  const bodyTextLength = Number(signals.bodyTextLength);
  // An unmeasured length (legacy caller, failed probe) keeps the prior
  // behaviour rather than silently widening what counts as a challenge.
  const interstitialSized = Number.isFinite(bodyTextLength)
    ? bodyTextLength <= CHALLENGE_INTERSTITIAL_MAX_CHARS
    : true;
  const textOnlyUncorroborated = signals.reason === 'verification-text'
    && !interactive
    && !interstitialSized
    && !signals.verificationCompleted;
  const hardBlockCandidate = (!!signals.hasTerminalHardBlockText
    || !!signals.hasDataDomeBlockFrame
    || signals.reason === 'verification-text'
    || signals.reason === 'google-sorry-recaptcha')
    && !textOnlyUncorroborated;
  const isHardBlock = hardBlockCandidate && !interactive && !signals.hasNormalContent;
  return {
    ...signals,
    interactive,
    isHardBlock,
    isChallenge: !textOnlyUncorroborated && (isHardBlock || !!signals.isChallenge),
    reason: textOnlyUncorroborated
      ? 'none'
      : (isHardBlock ? 'hard-block' : (signals.reason || 'none')),
    // Retained so a report can state what was observed and what was done with
    // it, rather than showing a silently clean page.
    suppressedReason: textOnlyUncorroborated ? 'verification-text-in-page-content' : null,
    bodyTextLength: Number.isFinite(bodyTextLength) ? bodyTextLength : null,
  };
}

/**
 * Decide whether a terminal-looking challenge page is stable enough to close.
 *
 * A Turnstile/Cloudflare page can briefly lose its iframe while it moves from a
 * user solve to either a redirect or a re-served widget. Once this wait has
 * observed an interactive challenge, a no-widget hard-block must remain stable
 * for a human-visible grace period before it is terminal. Kept pure so the
 * transition policy can be regression-tested without Puppeteer timing.
 */
export function resolveManualChallengeTransition({
  signals = {},
  sawInteractiveChallenge = false,
  terminalSince = null,
  now = Date.now(),
  graceMs = CHALLENGE_TERMINAL_TRANSITION_GRACE_MS,
} = {}) {
  if (signals.interactive) {
    return {
      disposition: terminalSince === null ? 'interactive' : 'interactive-returned',
      sawInteractiveChallenge: true,
      terminalSince: null,
      terminalElapsedMs: 0,
    };
  }
  if (!signals.isHardBlock) {
    return {
      disposition: 'none',
      sawInteractiveChallenge,
      terminalSince: null,
      terminalElapsedMs: 0,
    };
  }
  if (!sawInteractiveChallenge) {
    return {
      disposition: 'hard-block',
      sawInteractiveChallenge: false,
      terminalSince: null,
      terminalElapsedMs: 0,
    };
  }

  const stableSince = Number.isFinite(terminalSince) ? terminalSince : now;
  const terminalElapsedMs = Math.max(0, now - stableSince);
  return {
    disposition: terminalElapsedMs < Math.max(0, graceMs) ? 'terminal-settling' : 'hard-block',
    sawInteractiveChallenge: true,
    terminalSince: stableSince,
    terminalElapsedMs,
  };
}

/**
 * Detail tabs share the main-page transition policy. A background tab with a
 * live widget—or one settling immediately after that widget vanished—must be
 * brought forward for the user. A terminal page that was never interactive, or
 * stayed terminal through the grace window, stops enrichment without opening a
 * futile solve flow.
 */
export function resolveManualDetailChallengeDisposition({
  signals = {},
  sawInteractiveChallenge = false,
  terminalSince = null,
  now = Date.now(),
  graceMs = CHALLENGE_TERMINAL_TRANSITION_GRACE_MS,
} = {}) {
  const transition = resolveManualChallengeTransition({
    signals,
    sawInteractiveChallenge,
    terminalSince,
    now,
    graceMs,
  });
  if (!signals.isChallenge) return { ...transition, disposition: 'none' };
  return {
    ...transition,
    disposition: transition.disposition === 'hard-block' ? 'terminal-stop' : 'foreground-wait',
  };
}

export async function getChallengeSignals(page) {
  const evaluated = await page.evaluate((verificationTextMarkers, hardBlockTextMarkers) => {
    const bodyTextRaw = document.body?.innerText || '';
    const bodyText = bodyTextRaw.toLowerCase();
    const titleRaw = document.title || '';
    const title = titleRaw.toLowerCase();
    const hasChallengeShell = !!document.querySelector('#challenge-form, #cf-challenge-running, [data-testid="challenge"]');
    const hasPerimeterXBlock = !!document.querySelector('#px-captcha, #px-block-page-container');
    // After the checkbox is solved Cloudflare shows "Verification successful.
    // Waiting for www.indeed.com to respond" (in #ijUz0) before auto-redirecting.
    // Treat this as still-challenge so cleanSince only starts after the redirect.
    const hasVerificationSuccessful =
      bodyText.includes('verification successful') ||
      (bodyText.includes('waiting for') && bodyText.includes('indeed.com to respond'));
    // Keep the markers that actually matched. `reason=verification-text` alone
    // cannot be checked: it never says WHICH phrase fired, so a false positive
    // caused by ordinary posting copy (a role requiring a "security check") is
    // indistinguishable in a report from a genuine anti-bot wall.
    const matchedVerificationMarkers = verificationTextMarkers.filter(marker => bodyText.includes(marker));
    const hasVerificationText =
      hasVerificationSuccessful ||
      matchedVerificationMarkers.length > 0;
    const hasTerminalHardBlockText = hardBlockTextMarkers.some(marker => bodyText.includes(marker));
    const hasNormalContent = !!document.querySelector(
      'main [data-jk], main a[href*="/viewjob"], main [data-testid="jobDescriptionSection"], main #jobDescriptionSection, main h1'
    );
    const visibleRecaptchaFrames = [...document.querySelectorAll('iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"]')]
      .filter(fr => { const r = fr.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
    const visibleHCaptchaFrames = [...document.querySelectorAll('iframe[src*="hcaptcha.com"]')]
      .filter(fr => { const r = fr.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
    const hasCloudflareChallengeFrame = !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    // Turnstile widget container — present as soon as the CF Turnstile JS injects
    // its DOM node, even before the inner iframe has its src attribute populated.
    // Catches the checkbox challenge that ZipRecruiter triggers mid-session.
    // Using CF-specific selectors only (.cf-turnstile, cf-chl-widget-* IDs) to
    // avoid false-positive matches on reCAPTCHA/hCaptcha [data-sitekey] elements.
    const hasCloudflareTurnstileWidget = !!document.querySelector('[id*="cf-chl-widget"], .cf-turnstile');
    const hasIndeedCloudflareMarker = typeof window.INDEED_CLOUDFLARE_STATIC_PAGE !== 'undefined';
    // DataDome (Wellfound, and an increasing share of other sites) renders a slider
    // captcha inside a cross-origin sandboxed iframe — so document.body.innerText is
    // empty and the user-visible "Verification Required" / "Slide right to secure
    // your access" strings live in a different origin we can't read. Detect via the
    // outer-frame DOM: a captcha-delivery.com iframe or the inline `var dd={...}`
    // script that DataDome injects on every challenge page.
    const hasDataDomeFrame  = !!document.querySelector('iframe[src*="captcha-delivery.com"], iframe[title*="DataDome"]');
    const hasDataDomeScript = !!document.querySelector('script[src*="captcha-delivery.com"]');
    // The frame's own address says which view DataDome served: `t=fe` is a
    // captcha a person can solve, `t=bv` is the block view ("Access is
    // temporarily restricted") with nothing to solve. Its text is in another
    // origin, so this parameter is the only readable difference between them.
    const hasDataDomeBlockFrame = [...document.querySelectorAll('iframe[src*="captcha-delivery.com"]')]
      .some((frame) => {
        try { return new URL(frame.src).searchParams.get('t') === 'bv'; } catch { return false; }
      });

    // Google's "unusual traffic" interstitial (google.com/sorry/index) — a reCAPTCHA
    // "I'm not a robot" wall served when Google flags the session/IP. The reCAPTCHA
    // iframe alone isn't a reliable signal (it can lag), so also key off the /sorry
    // URL and the Google-specific body string (low false-positive). This makes the
    // scrape treat it as a SOLVABLE challenge and wait for the user — like every
    // other platform — instead of silently extracting 0 jobs and moving on.
    // Both signals live on the TOP document (the reCAPTCHA checkbox + its "I'm not a
    // robot" label are inside a cross-origin iframe we can't read, so don't rely on
    // them). The /sorry URL and the Google-specific banner are unambiguous and won't
    // false-positive on a normal results page — important, since a false positive
    // here would make the scrape wait forever for a solve that isn't needed.
    const isGoogleSorryPage =
      /\/sorry\/(index|captcha)/.test(window.location.href) ||
      bodyText.includes('unusual traffic from your computer network');

    let reason = 'none';
    if (hasChallengeShell || hasPerimeterXBlock) reason = 'challenge-shell';
    else if (title.startsWith('just a moment')) reason = 'just-a-moment-title';
    else if (isGoogleSorryPage) reason = 'google-sorry-recaptcha';
    else if (hasVerificationText) reason = 'verification-text';
    else if (hasDataDomeFrame || hasDataDomeScript) reason = 'datadome-captcha';
    else if (visibleRecaptchaFrames > 0 && !hasNormalContent) reason = 'visible-recaptcha-without-content';
    else if (visibleHCaptchaFrames > 0 && !hasNormalContent) reason = 'visible-hcaptcha-without-content';
    else if (hasCloudflareChallengeFrame || hasCloudflareTurnstileWidget) reason = 'cloudflare-challenge-frame';
    else if (hasIndeedCloudflareMarker && !hasNormalContent) reason = 'indeed-cloudflare-static-without-content';

    return {
      isChallenge: reason !== 'none',
      isHardBlock: false,
      verificationCompleted: hasVerificationSuccessful,
      reason,
      url: window.location.href,
      title: titleRaw.slice(0, 120),
      bodyHead: bodyTextRaw.replace(/\s+/g, ' ').trim().slice(0, 240),
      // Whitespace-collapsed so an indentation-heavy document is measured by
      // the prose a reader would actually see, not by its markup formatting.
      bodyTextLength: bodyTextRaw.replace(/\s+/g, ' ').trim().length,
      matchedVerificationMarkers: matchedVerificationMarkers.slice(0, 4),
      hasChallengeShell,
      hasPerimeterXBlock,
      hasVerificationText,
      hasTerminalHardBlockText,
      hasNormalContent,
      visibleRecaptchaFrames,
      visibleHCaptchaFrames,
      hasCloudflareChallengeFrame,
      hasCloudflareTurnstileWidget,
      hasIndeedCloudflareMarker,
      hasDataDomeFrame,
      hasDataDomeScript,
      hasDataDomeBlockFrame,
    };
  }, MANUAL_VERIFICATION_TEXT_MARKERS, MANUAL_HARD_BLOCK_TEXT_MARKERS).catch((error) => ({
    isChallenge: false,
    isHardBlock: false,
    verificationCompleted: false,
    reason: 'evaluate-failed',
    evaluationError: String(error?.message || error || '').replace(/\s+/g, ' ').slice(0, 180),
    url: page.url(),
    title: '',
    bodyHead: '',
    // null, not 0: the document was never measured. Reporting it as an empty
    // body would assert an observation this probe did not make.
    bodyTextLength: null,
    matchedVerificationMarkers: [],
    hasChallengeShell: false,
    hasPerimeterXBlock: false,
    hasVerificationText: false,
    hasTerminalHardBlockText: false,
    hasNormalContent: false,
    visibleRecaptchaFrames: 0,
    visibleHCaptchaFrames: 0,
    hasCloudflareChallengeFrame: false,
    hasCloudflareTurnstileWidget: false,
    hasIndeedCloudflareMarker: false,
    hasDataDomeFrame: false,
    hasDataDomeScript: false,
    hasDataDomeBlockFrame: false,
  }));
  return classifyManualChallengeSignals(evaluated);
}

export function formatChallengeEvidence(signals, key = null) {
  if (!signals) return 'challenge signals unavailable';
  const bits = [
    key ? `key=${key}` : null,
    signals.reason ? `reason=${signals.reason}` : null,
    signals.url ? `url=${signals.url}` : null,
    signals.title ? `title=${JSON.stringify(signals.title)}` : null,
    `normalContent=${signals.hasNormalContent ? 'yes' : 'no'}`,
    Number.isFinite(signals.bodyTextLength) ? `bodyChars=${signals.bodyTextLength}` : null,
    signals.matchedVerificationMarkers?.length
      ? `matchedText=${JSON.stringify(signals.matchedVerificationMarkers.join(' | '))}`
      : null,
    signals.hasChallengeShell ? 'challengeShell=yes' : null,
    signals.hasPerimeterXBlock ? 'perimeterX=yes' : null,
    signals.hasVerificationText ? 'verificationText=yes' : null,
    signals.hasTerminalHardBlockText ? 'terminalHardBlockText=yes' : null,
    signals.visibleRecaptchaFrames ? `recaptchaFrames=${signals.visibleRecaptchaFrames}` : null,
    signals.visibleHCaptchaFrames ? `hcaptchaFrames=${signals.visibleHCaptchaFrames}` : null,
    signals.hasCloudflareChallengeFrame ? 'cfFrame=yes' : null,
    signals.hasCloudflareTurnstileWidget ? 'turnstileWidget=yes' : null,
    signals.hasIndeedCloudflareMarker ? 'indeedCfMarker=yes' : null,
    signals.hasDataDomeFrame ? 'dataDomeFrame=yes' : null,
    signals.hasDataDomeScript ? 'dataDomeScript=yes' : null,
    signals.hasDataDomeBlockFrame ? 'dataDomeBlockFrame=yes' : null,
    signals.evaluationError ? `evaluateError=${JSON.stringify(signals.evaluationError)}` : null,
    signals.bodyHead ? `bodyHead=${JSON.stringify(signals.bodyHead)}` : null,
  ].filter(Boolean);
  return bits.join(' | ').slice(0, 700);
}

export async function detectChallengePage(page) {
  const signals = await getChallengeSignals(page);
  return !!signals?.isChallenge;
}

async function getChallengeRecoverySignals(page) {
  return page.evaluate(() => {
    const href = window.location.href || '';
    let url;
    try { url = new URL(href); } catch { url = null; }
    const host = url?.host || '';
    const pathname = url?.pathname || '';
    const bodyTextRaw = document.body?.innerText || '';
    const bodyText = bodyTextRaw.toLowerCase();
    const hasSearchForm =
      !!document.querySelector('form[action*="/jobs"], input[name="q"], #text-input-what, [data-testid="searchForm"]');
    const hasHomeHero =
      bodyText.includes('find jobs') ||
      bodyText.includes('what') && bodyText.includes('where');
    const isIndeedHome =
      /(^|\.)indeed\.com$/i.test(host) &&
      (pathname === '/' || pathname === '/m/' || pathname === '/m');
    return {
      url: href,
      host,
      pathname,
      isIndeedHomeLanding: isIndeedHome && (hasSearchForm || hasHomeHero),
    };
  }).catch(() => ({
    url: page.url(),
    host: '',
    pathname: '',
    isIndeedHomeLanding: false,
  }));
}

export async function recoverFromChallengeHomeLanding(page, overlayBase, signal, resumeUrl, count = null) {
  if (!resumeUrl || signal?.aborted || page.isClosed()) return false;
  const recovery = await getChallengeRecoverySignals(page);
  if (!recovery.isIndeedHomeLanding) return false;

  logger.info(
    `[BrowserScraper] ${overlayBase?.srcName || 'source'}: landed on Indeed home after verification — returning to ${resumeUrl}`,
  );
  await updateOverlay(page, {
    ...overlayBase,
    ...(count === null ? {} : { count }),
    status: 'Verification complete — returning to the previous page…',
    challenge: true,
  }).catch(() => {});
  await page.evaluate(u => { window.location.href = u; }, resumeUrl).catch(() => {});
  await new Promise(r => setTimeout(r, humanDelay(NAV_SETTLE_MS)));
  await injectOverlay(page).catch(() => {});
  return true;
}

// ── waitForReady ──────────────────────────────────────────────────────────────
// Waits for real page content to appear, handling challenge pages.
// Returns 'ok' | 'skip' (challenge timed out) | 'abort' (signal aborted).
export async function waitForReady(page, sourceId, overlayBase, signal, resumeUrl = null, {
  challengeOnly = false,
  initialChallengeState = null,
} = {}) {
  // Location autocomplete runs from Glassdoor's origin landing page, before a
  // results page exists. In that phase there cannot be a job-card selector to
  // wait for; we only need this function's challenge gate. The origin navigation
  // has already had NAV_SETTLE_MS to render before this check.
  const contentSel    = challengeOnly ? null : CONTENT_SELECTORS[sourceId];
  const contentDL     = Date.now() + CONTENT_TIMEOUT_MS;
  let inChallenge              = false;
  let challengeStartedAt       = 0; // when the current challenge wait began (for the heartbeat)
  let lastChallengeHeartbeat   = 0;
  let challengeHeartbeats      = 0; // log lines emitted for the current wait (drives the backoff)
  let challengeEscalations     = 0; // CHALLENGE_ESCALATE_MS marks already announced for the current wait
  let lastChallengeBeatAt      = 0; // liveness beat, on its own un-backed-off cadence
  let cleanSince               = null; // tracks when page first went challenge-free
  let shownVerifiedOverlay     = false;
  let didHomeLandingRecover    = false; // true if recoverFromChallengeHomeLanding fired
  let justRecovered            = false; // true on the iteration immediately after a home-landing recovery
  let repeatedChallengeCount   = 0;
  let sawInteractiveChallenge  = !!initialChallengeState?.sawInteractiveChallenge;
  let terminalSince            = Number.isFinite(initialChallengeState?.terminalSince)
    ? initialChallengeState.terminalSince
    : null;
  let terminalTransitionCount  = 0;
  let recordedTextSuppression  = false;
  let inputProbe               = null; // mouse/key input seen while a check is open (diagnostics only)
  // A check that was counted as open must be closed on every way out of the wait, or the pace record keeps it open.
  const closeOpenChallenge = () => {
    if (!inChallenge) return;
    inChallenge = false;
    notePaceChallengeEnd(sourceId, { srcName: overlayBase.srcName, input: challengeInputVerdict(inputProbe?.summary() || null) });
  };

  while (true) {
    if (signal?.aborted) { closeOpenChallenge(); return 'abort'; }

    const signals     = await getChallengeSignals(page);
    if (inputProbe) await inputProbe.poll();
    const isChallenge = !!signals?.isChallenge;
    if (signals?.suppressedReason && !recordedTextSuppression) {
      // Say what was seen and what was done with it. Without this the report
      // shows an ordinary page and no trace of the words that used to stop it,
      // so a later regression here would be invisible.
      recordedTextSuppression = true;
      recordManualScraperTelemetry({
        phase: 'challenge-text-suppressed',
        srcName: overlayBase.srcName,
        reason: signals.suppressedReason,
        title: signals.title,
        bodyHead: signals.bodyHead,
        url: signals.url,
        bodyTextLength: signals.bodyTextLength,
        interstitialMaxChars: CHALLENGE_INTERSTITIAL_MAX_CHARS,
        matchedVerificationMarkers: signals.matchedVerificationMarkers || [],
        pageState: {
          interactive: false,
          normalContent: !!signals.hasNormalContent,
          terminalHardBlockText: !!signals.hasTerminalHardBlockText,
        },
      }, { updateActive: false });
      logger.info(`[BrowserScraper] ${overlayBase.srcName}: verification wording found inside a ${signals.bodyTextLength}-char content page (interstitials are ≤${CHALLENGE_INTERSTITIAL_MAX_CHARS}) — treating it as page text, not a challenge`);
    }
    const hasContent  = challengeOnly || !contentSel || await page.evaluate(
      s => !!document.querySelector(s), contentSel
    ).catch(() => false);

    if (isChallenge) {
      cleanSince = null; // challenge present or re-served — reset stable timer
      const priorTerminalSince = terminalSince;
      const transition = resolveManualChallengeTransition({
        signals,
        sawInteractiveChallenge,
        terminalSince,
      });
      sawInteractiveChallenge = transition.sawInteractiveChallenge;
      terminalSince = transition.terminalSince;

      if (transition.disposition === 'interactive-returned') {
        repeatedChallengeCount++;
        shownVerifiedOverlay = false;
        await updateOverlay(page, {
          ...overlayBase,
          status: '⚠️ Verification returned — complete the challenge to continue',
          challenge: true,
        }).catch(() => {});
        recordManualScraperTelemetry({
          phase: 'challenge-transition-reverted',
          srcName: overlayBase.srcName,
          reason: signals.reason,
          title: signals.title,
          bodyHead: signals.bodyHead,
          url: signals.url,
          repeatCount: repeatedChallengeCount,
          terminalTransitionCount,
          pageState: {
            interactive: true,
            cfFrame: !!signals.hasCloudflareChallengeFrame,
            turnstileWidget: !!signals.hasCloudflareTurnstileWidget,
            recaptchaFrames: Number(signals.visibleRecaptchaFrames) || 0,
            hcaptchaFrames: Number(signals.visibleHCaptchaFrames) || 0,
          },
        });
        logger.warn(`[BrowserScraper] ${overlayBase.srcName}: interactive challenge returned during terminal transition (repeat ${repeatedChallengeCount}) — continuing to wait`);
      }
      if (transition.disposition === 'terminal-settling') {
        if (priorTerminalSince === null) {
          terminalTransitionCount++;
          await updateOverlay(page, {
            ...overlayBase,
            status: '⏳ Verification is changing — keeping this page open while it settles…',
            challenge: true,
          }).catch(() => {});
          recordManualScraperTelemetry({
            phase: 'challenge-terminal-settling',
            srcName: overlayBase.srcName,
            reason: signals.reason,
            title: signals.title,
            bodyHead: signals.bodyHead,
            url: signals.url,
            terminalTransitionCount,
            terminalGraceMs: CHALLENGE_TERMINAL_TRANSITION_GRACE_MS,
            pageState: {
              interactive: false,
              normalContent: !!signals.hasNormalContent,
              cfFrame: !!signals.hasCloudflareChallengeFrame,
              turnstileWidget: !!signals.hasCloudflareTurnstileWidget,
              terminalHardBlockText: !!signals.hasTerminalHardBlockText,
            },
          });
          logger.warn(`[BrowserScraper] ${overlayBase.srcName}: challenge widget disappeared into a terminal-looking page — waiting ${CHALLENGE_TERMINAL_TRANSITION_GRACE_MS}ms before closing`);
        }
        await new Promise(r => setTimeout(r, CONTENT_POLL_MS));
        continue;
      }

      if (justRecovered
        && transition.disposition !== 'interactive-returned'
        && !(sawInteractiveChallenge && signals.isHardBlock)) {
        // Challenge appeared immediately after navigating back to the resume URL —
        // that URL is itself blocked. Skip now; no checkbox-solve will unblock it.
        logger.warn(`[BrowserScraper] ${overlayBase.srcName}: resume URL immediately challenged after recovery — session fully blocked, skipping source`);
        closeOpenChallenge();
        return 'skip';
      }
      // Hard block: no interactive widget present, nothing for the user to solve.
      // "Additional Verification Required" shows only a Ray ID + "Return home" —
      // since a solvable challenge now waits indefinitely, a hard block MUST skip
      // here or it would hang the run forever. Surface a clear, actionable error.
      if (transition.disposition === 'hard-block') {
        const evidence = formatChallengeEvidence(signals);
        logger.warn(`[BrowserScraper] ${overlayBase.srcName}: hard block — no solvable challenge widget (${evidence})`);
        recordManualScraperTelemetry({
          phase:     'challenge-hard-block',
          srcName:   overlayBase.srcName,
          reason:    signals.reason,
          title:     signals.title,
          bodyHead:  signals.bodyHead,
          url:       signals.url,
          ...(sawInteractiveChallenge ? {
            terminalTransitionCount,
            terminalStableMs: transition.terminalElapsedMs,
            terminalGraceMs: CHALLENGE_TERMINAL_TRANSITION_GRACE_MS,
            closeCause: 'stable-terminal-after-interactive-challenge',
          } : { closeCause: 'initial-terminal-hard-block' }),
          matchedVerificationMarkers: signals.matchedVerificationMarkers || [],
          bodyTextLength: signals.bodyTextLength ?? null,
          interstitialMaxChars: CHALLENGE_INTERSTITIAL_MAX_CHARS,
          pageState: {
            interactive: !!signals.interactive,
            normalContent: !!signals.hasNormalContent,
            challengeShell: !!signals.hasChallengeShell,
            perimeterX: !!signals.hasPerimeterXBlock,
            cfFrame: !!signals.hasCloudflareChallengeFrame,
            turnstileWidget: !!signals.hasCloudflareTurnstileWidget,
            recaptchaFrames: Number(signals.visibleRecaptchaFrames) || 0,
            hcaptchaFrames: Number(signals.visibleHCaptchaFrames) || 0,
            dataDomeFrame: !!signals.hasDataDomeFrame,
            dataDomeScript: !!signals.hasDataDomeScript,
            dataDomeBlockFrame: !!signals.hasDataDomeBlockFrame,
          },
        });
        await updateOverlay(page, {
          ...overlayBase,
          status: `🚫 ${overlayBase.srcName} hard-blocked this session — open it in Chrome, log in, then retry`,
          error:  true,
        }).catch(() => {});
        await new Promise(r => setTimeout(r, humanDelay(2000)));
        closeOpenChallenge();
        return 'hard-block';
      }
      if (!inChallenge) {
        inChallenge = true;
        challengeStartedAt = Date.now();
        inputProbe = createChallengeInputProbe(page);
        await inputProbe.poll();
        // Pace telemetry (diagnostics only): counts the check, files how many
        // detail pages opened since the previous one, and opens the ongoing
        // window. challengeOnly is the detail-page gate vs list navigation.
        notePaceChallengeStart(sourceId, {
          srcName: overlayBase.srcName,
          challengeOnly,
          now: challengeStartedAt,
        });
        lastChallengeHeartbeat = Date.now();
        lastChallengeBeatAt = Date.now();
        challengeHeartbeats = 0;
        challengeEscalations = 0;
        // This source made the user manually solve something this run — feeds the
        // "manual-verification-first" scrape ordering (scrapeVerification.js). The
        // orchestrator records the outcome per source; we only flag it here.
        markManualSolveRequired(sourceId);
        await updateOverlay(page, {
          ...overlayBase,
          status:    '⚠️ Complete the challenge above to continue',
          challenge: true,
        });
        logger.info(`[BrowserScraper] ${overlayBase.srcName}: bot challenge detected — waiting for user (no timeout; Reset to cancel)`);
        // Gather anti-bot diagnostics once, before the (potentially minutes-long)
        // user-solve wait. Best-effort; nulls if a lookup fails. The egress
        // lookup runs in the background and fills its fields in when it settles.
        const egressLookup = lookupEgress();
        const blockId = await extractBlockId(page);
        recordChallengeDetectedTelemetry({
          phase:    'challenge-detected',
          srcName:  overlayBase.srcName,
          reason:   signals?.reason,
          title:    signals?.title,
          bodyHead: signals?.bodyHead,
          url:      signals?.url,
          cfFrame:  signals?.hasCloudflareChallengeFrame,
          recaptcha: signals?.visibleRecaptchaFrames,
          matchedVerificationMarkers: signals?.matchedVerificationMarkers || [],
          bodyTextLength: signals?.bodyTextLength ?? null,
          interstitialMaxChars: CHALLENGE_INTERSTITIAL_MAX_CHARS,
          pageState: {
            interactive: !!signals?.interactive,
            normalContent: !!signals?.hasNormalContent,
            challengeShell: !!signals?.hasChallengeShell,
            perimeterX: !!signals?.hasPerimeterXBlock,
            cfFrame: !!signals?.hasCloudflareChallengeFrame,
            turnstileWidget: !!signals?.hasCloudflareTurnstileWidget,
            recaptchaFrames: Number(signals?.visibleRecaptchaFrames) || 0,
            hcaptchaFrames: Number(signals?.visibleHCaptchaFrames) || 0,
            dataDomeFrame: !!signals?.hasDataDomeFrame,
            dataDomeScript: !!signals?.hasDataDomeScript,
            dataDomeBlockFrame: !!signals?.hasDataDomeBlockFrame,
          },
          browserProfile: BROWSER_LAUNCH_PROFILE,
          blockId,
        }, egressLookup);
      }
      if (!shownVerifiedOverlay && signals?.verificationCompleted) {
        shownVerifiedOverlay = true;
        await updateOverlay(page, {
          ...overlayBase,
          status:    'Verification complete — waiting for the site to redirect…',
          challenge: true,
        });
        logger.info(`[BrowserScraper] ${overlayBase.srcName}: verification successful — waiting for Cloudflare redirect`);
      }
      // Wait INDEFINITELY for the user to solve — never skip a solvable challenge
      // on a timer. The escape hatches are the abort check at the top of the loop
      // (Reset / hub close) and the hard-block return above (nothing to solve). A
      // periodic heartbeat keeps an unattended wait visible in the logs.
      const challengeElapsedMs = Date.now() - challengeStartedAt;
      const formatChallengeElapsed = (ms) => {
        const sec = Math.floor(ms / 1000);
        return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
      };
      if (Date.now() - lastChallengeBeatAt >= CHALLENGE_ACTIVITY_BEAT_MS) {
        lastChallengeBeatAt = Date.now();
        recordActivityBeat({
          ...overlayBase, tabLayout: overlayTabLayout(page),
          status: `⚠️ Complete the challenge above to continue (${formatChallengeElapsed(challengeElapsedMs)} waiting)`,
          challenge: true,
        });
      }
      if (Date.now() - lastChallengeHeartbeat >= challengeHeartbeatIntervalMs(challengeHeartbeats)) {
        lastChallengeHeartbeat = Date.now();
        challengeHeartbeats++;
        logger.info(`[BrowserScraper] ${overlayBase.srcName}: still waiting for the user to solve the challenge (${formatChallengeElapsed(challengeElapsedMs)} elapsed)`);
      }
      // No timeout — but past 15 and 30 minutes the wait says out loud that it
      // is still holding the walk, on the source card as well as in the log.
      while (challengeEscalations < CHALLENGE_ESCALATE_MS.length
        && challengeElapsedMs >= CHALLENGE_ESCALATE_MS[challengeEscalations]) {
        const escalateMinutes = Math.round(CHALLENGE_ESCALATE_MS[challengeEscalations] / 60_000);
        challengeEscalations++;
        const escalation = `still waiting ${escalateMinutes}m for a human check on ${overlayBase.srcName} — complete it or press Reset`;
        logger.warn(`[BrowserScraper] ${escalation}`);
        await updateOverlay(page, {
          ...overlayBase,
          status: escalation,
          challenge: true,
        }).catch(() => {});
      }
      await new Promise(r => setTimeout(r, CONTENT_POLL_MS));
      continue;
    }

    // A clean poll proves the earlier terminal DOM did not remain stable. Keep
    // the fact that this challenge was interactive, but never carry its old
    // terminal timestamp through a redirect/clean settle into a later block.
    terminalSince = null;

    if (inChallenge) {
      if (await recoverFromChallengeHomeLanding(page, overlayBase, signal, resumeUrl)) {
        justRecovered = true;
        cleanSince = null;
        shownVerifiedOverlay = false;
        didHomeLandingRecover = true;
        await new Promise(r => setTimeout(r, CONTENT_POLL_MS));
        continue;
      }
      justRecovered = false;
      // Page is currently clean — start or advance the stable-clean timer.
      // If Cloudflare re-serves the challenge, the isChallenge branch above
      // resets cleanSince, so the full CHALLENGE_STABLE_MS must elapse again.
      if (cleanSince === null) cleanSince = Date.now();
      if (Date.now() - cleanSince < CHALLENGE_STABLE_MS) {
        await new Promise(r => setTimeout(r, CONTENT_POLL_MS));
        continue;
      }
      // Longer post-challenge settle — after solving, Cloudflare's session score is
      // degraded and the next navigation can immediately re-trigger a challenge.
      // A 3-5s human-like pause reduces the chance of an instant re-challenge.
      await new Promise(r => setTimeout(r, humanDelay(4000)));
      const postSettleSignals = await getChallengeSignals(page);
      if (postSettleSignals?.isChallenge) {
        repeatedChallengeCount++;
        cleanSince = null;
        shownVerifiedOverlay = false;
        await updateOverlay(page, {
          ...overlayBase,
          status: '⚠️ Verification returned — complete the challenge to continue',
          challenge: true,
        }).catch(() => {});
        recordManualScraperTelemetry({
          phase: 'challenge-reappeared',
          srcName: overlayBase.srcName,
          reason: postSettleSignals.reason,
          title: postSettleSignals.title,
          bodyHead: postSettleSignals.bodyHead,
          url: postSettleSignals.url,
          repeatCount: repeatedChallengeCount,
          pageState: {
            interactive: !!postSettleSignals.interactive,
            normalContent: !!postSettleSignals.hasNormalContent,
            cfFrame: !!postSettleSignals.hasCloudflareChallengeFrame,
            turnstileWidget: !!postSettleSignals.hasCloudflareTurnstileWidget,
            recaptchaFrames: Number(postSettleSignals.visibleRecaptchaFrames) || 0,
            hcaptchaFrames: Number(postSettleSignals.visibleHCaptchaFrames) || 0,
          },
        });
        logger.warn(`[BrowserScraper] ${overlayBase.srcName}: challenge reappeared during post-solve settle (repeat ${repeatedChallengeCount}) — continuing to wait`);
        continue;
      }
      await updateOverlay(page, { ...overlayBase, status: 'Extracting jobs…' });
      // Pace telemetry (diagnostics only): closes the ongoing check window and
      // emits the one-line summary. Fail-soft.
      const inputSummary = inputProbe?.summary() || null;
      const clearedAfter = formatWaitDuration(Date.now() - challengeStartedAt);
      recordManualScraperTelemetry({
        phase: 'challenge-resolved', srcName: overlayBase.srcName,
        clearedAfter, input: challengeInputVerdict(inputSummary), inputCounts: inputSummary,
      });
      notePaceChallengeEnd(sourceId, { srcName: overlayBase.srcName, input: challengeInputVerdict(inputSummary) });
      logger.info(`[BrowserScraper] ${overlayBase.srcName}: challenge resolved after ${clearedAfter} — resuming; ${describeChallengeInput(inputSummary)}`);
      // 'recovered' signals that a home-landing recovery fired — caller is on the
      // base search URL (page 1), not the paginated URL that triggered the challenge.
      // Pagination callers should break rather than re-navigating to the same page.
      return didHomeLandingRecover ? 'recovered' : 'ok';
    }

    if (hasContent || Date.now() > contentDL) return 'ok';

    await new Promise(r => setTimeout(r, CONTENT_POLL_MS));
  }
}
