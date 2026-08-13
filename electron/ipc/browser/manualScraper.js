/**
 * Automated browser scraper for job sources.
 *
 * Opens ONE visible Puppeteer browser window and cycles through all browser-scraped
 * sources sequentially. Navigates programmatically, extracts automatically, and
 * paginates without user input.
 *
 * Only pauses if a bot challenge (CAPTCHA, Cloudflare, PerimeterX) is detected —
 * the overlay turns amber and prompts the user to solve it. Once real content
 * appears, automation resumes immediately.
 *
 * For browser-backed sources, the scraper auto-clicks each job card to expand the full
 * description from the side panel (or modal, for Wellfound).
 *
 * Return shape mirrors scrapeMultiple:
 *   Array<{ id, sourceId, success, data, pagesWalked, stopReason, warning }>
 */

import puppeteer from 'puppeteer-extra';
import {
  closeStealthBrowser, getUserDataDir, findChromePath,
} from '../stealthBrowser.js';
import { logger } from '../../logger.js';
import { JOB_PER_PAGE_CAP, JOB_PER_SOURCE_CAP, JOB_MAX_PAGES } from '../resultCaps.js';
import { POSTED_DATE_PATTERN } from '../jobDateFilter.js';
import { buildOverlayScript, updateOverlay } from './scraperOverlay.js';
import { humanDelay } from '../../utils/humanDelay.js';
import { getGlassdoorLocId, saveGlassdoorLocId } from '../settings.js';
import { pickGlassdoorLocation } from '../../../src/utils/jobLocation.js';
import { markManualSolveRequired } from '../scrapeVerification.js';

// ── Timing ────────────────────────────────────────────────────────────────────
const NAV_SETTLE_MS          = 2000;          // settle after navigation before first action
const CONTENT_POLL_MS        = 600;           // poll interval while waiting for content/challenge
const CONTENT_TIMEOUT_MS     = 20_000;        // max wait for content before proceeding anyway
// We wait INDEFINITELY for the user to solve a real (solvable) challenge — never
// skip a source out from under someone mid-solve. The escape hatches are an abort
// (Reset / hub close) and a hard block (nothing to solve, skipped immediately).
// This is just the cadence for a "still waiting" heartbeat log during that wait.
const CHALLENGE_HEARTBEAT_MS = 30_000;
const CHALLENGE_STABLE_MS    = 1_500;         // page must be challenge-free for this long before resuming — guards against re-serves
const DESC_CHANGE_POLL_MS    = 200;           // poll interval waiting for description panel update
const DESC_CHANGE_TIMEOUT_MS = 3_000;         // max wait for description to change after a card click
const DESC_RETRY_PAUSE_MS    = 900;           // pause before re-clicking when the first attempt's panel never updated (catches transient anti-bot 403s)
const DESC_CLICK_DELAY_MS    = 600;           // pause between card clicks (natural pacing)
const SITE_CHANGED_ABORT_THRESHOLD = 3;
const DESC_STALE_THRESHOLD   = 3;             // consecutive click/panel failures before flagging stale selectors

// Cooldown BETWEEN queries (not before the first). Firing N back-to-back
// full-page navigations to different search URLs is a velocity signal that
// anti-bot systems flag — a human-scale pause between them lowers that signal.
// All values are anchors fed through humanDelay() at the call site, so the
// actual wait is organically spread (never a fixed cadence).
const DEFAULT_INTER_QUERY_COOLDOWN_MS = 2500;
// JOB_PER_PAGE_CAP (from resultCaps) is the unified per-page/per-query depth for all browser scrapers.


function countDistinctJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return 0;
  const seen = new Set();
  let count = 0;
  for (const job of jobs) {
    const key = `${job?.title || ''}|${job?.company || ''}|${job?.url || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    count++;
  }
  return count;
}

// ── Per-source configs ────────────────────────────────────────────────────────
const SOURCE_LABELS = {
  google:       'Google for Jobs',
  ziprecruiter: 'ZipRecruiter',
  glassdoor:    'Glassdoor',
};

const manualScraperTelemetry = {
  active: null,
  events: [],
  paused: false,  // survives page navigations — source of truth is Node.js, not the page
  consoleLogs: [],   // last 60 browser-side console errors/warnings from the stealth page
  networkErrors: [], // last 30 network failures / 4xx-5xx responses from the stealth page
};

function recordManualScraperTelemetry(event) {
  const entry = {
    ts: Date.now(),
    ...event,
  };
  manualScraperTelemetry.events.push(entry);
  if (manualScraperTelemetry.events.length > 30) manualScraperTelemetry.events.shift();
  manualScraperTelemetry.active = {
    ...(manualScraperTelemetry.active || {}),
    ...entry,
  };
}

function clearManualScraperTelemetry(status = 'idle') {
  manualScraperTelemetry.active = manualScraperTelemetry.active
    ? { ...manualScraperTelemetry.active, ts: Date.now(), phase: status }
    : null;
}

export function getManualScraperTelemetry() {
  return {
    active: manualScraperTelemetry.active ? { ...manualScraperTelemetry.active } : null,
    events: manualScraperTelemetry.events.map(e => ({ ...e })),
    consoleLogs: manualScraperTelemetry.consoleLogs.map(e => ({ ...e })),
    networkErrors: manualScraperTelemetry.networkErrors.map(e => ({ ...e })),
  };
}

// ── Anti-bot challenge diagnostics ──────────────────────────────────────────
// Gathered when a challenge first fires so a bug report can rank the cause
// (IP reputation vs automation fingerprint vs behavior) WITHOUT reading source
// or relying on a pasted screenshot. All best-effort + fail-soft — diagnostics
// must never break a scrape or delay it beyond the few seconds before we sit and
// wait minutes for the user to solve the challenge anyway.

// Static description of how the manual-scrape browser is launched. Keep in sync
// with the puppeteer.launch() call in scrapeManualSources(). The point: a reader
// instantly sees we're already headful with the standard evasions, so the block
// is NOT "we forgot to run headful".
const BROWSER_LAUNCH_PROFILE =
  'headful system-Chrome · webdriver masked · AutomationControlled disabled · --enable-automation stripped · no CDP pause bridge';

// Egress (public) IP + best-effort datacenter/residential classification. ipify
// gives the IP (same source the LinkedIn egress trail uses); ip-api adds org +
// a `hosting` flag so a reader can tell a datacenter/VPN exit (the dominant
// DataDome trigger) from a residential IP. Returns nulls on any failure.
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

// Selector confirming real page content is present (vs bot-challenge page).
// null = no reliable selector; skip content check, rely solely on challenge detection.
const CONTENT_SELECTORS = {
  // Jobs widget selectors first; plain SERP selectors (#rcnt, #search, .srp) are fallbacks
  // so a loaded page with no jobs panel is treated as "ready" immediately instead of
  // burning the full CONTENT_TIMEOUT_MS (20s) before proceeding with 0 results.
  google:       '.EimVGf, [jscontroller="b11o3b"], #rcnt, #search, .srp',
  ziprecruiter: null,   // JSON-LD tag exists on challenge pages too; extractor validates
  glassdoor:    '[data-test="jobListing"], .JobCard_jobCardWrapper',
};

// Selector for the "Next page" control (null = no auto-pagination for this source).
// These need validation in-browser — flag any that don't work.
const NEXT_PAGE_SELECTORS = {
  google:       null,
  ziprecruiter: null,
  glassdoor:    'button[data-test="pagination-next"]',
};

// Sources that load more jobs by scrolling to the bottom (infinite scroll).
// Google for Jobs (ibp=htl;jobs mode) lazy-loads more cards as you scroll — initial
// render is ~10 cards; scrolling reveals the rest before we run the extractor.
const SCROLL_SOURCES = new Set(['ziprecruiter', 'google']);

// Per-source config for clicking cards to expand full job descriptions.
// null = source doesn't support card-click description expansion.
//
//   keyParam      — URL query param holding the job's unique key (mutually exclusive with keyRegex/keyField)
//   keyRegex      — regex string (1 capture group) to extract key from URL path instead of a param
//   keyField      — if set, read key directly from job[keyField] (bypasses URL parsing entirely)
//   keyDecode     — whether to decodeURIComponent the extracted key
//   cardAttr      — if set, find card via [cardAttr="{key}"] querySelector
//   cardIdPrefix  — if set (cardAttr/cardHrefKey null), find card via getElementById(prefix + key)
//   cardHrefKey   — if set (others null), find card via a[href*="{cardHrefKey}{key}-"]
//   clickSelector — element to click within the found card; null = click card itself
//   panelSelector — CSS selector for the description panel that updates after each click
//   panelMulti    — if true, querySelectorAll + join textContent (for split-element panels)
//   closeSelector — if set, click this after reading to close a modal before the next card
const DESC_CONFIGS = {
  google: {
    keyParam:      'htidocid',
    keyRegex:      null,
    keyDecode:     true,
    cardAttr:      null,
    cardIdPrefix:  '',           // getElementById(key) = the [role="button"] clickable element
    cardHrefKey:   null,
    clickSelector: null,
    panelSelector: '.OOyDTc, .ejCXj',
    panelMulti:    true,         // description split across visible + hidden spans
    closeSelector: null,
  },
  ziprecruiter: {
    keyParam:      'jid',
    keyRegex:      null,
    keyDecode:     false,
    cardAttr:      null,
    cardIdPrefix:  null,
    cardHrefKey:   null,
    clickSelector: null,
    // ItemList JSON-LD gives us the individual job page URL directly, so navigate
    // there instead of card-clicking on the virtualized list page.
    // JSON-LD JobPosting.description (server-rendered) is tried first; panelSelector
    // is a CSS fallback in case the ld+json block is absent.
    // ZipRecruiter uses Tailwind CSS — no semantic class names. The description container
    // uniquely carries the `whitespace-pre-line` utility token; fallbacks are legacy selectors.
    panelSelector: '[class~="whitespace-pre-line"], .jobDescriptionSection, [data-testid="jobDescriptionSection"], #job-description-container, [class*="jobDescription"], .job_description, #job_desc',
    panelMulti:    false,
    closeSelector: null,
    expandViaNavigation: true,
    navUrlField:         'url',  // job.url is already the individual job page
    jsonLdType:          'JobPosting',
    jsonLdField:         'description',
    // ZR pay is a client-rendered "Estimated pay" chip — not in the ItemList or
    // JSON-LD — so read it from the live DOM by money-text pattern during enrichment.
    salaryFromDom:       true,
    // __NEXT_DATA__ fallback — path will be confirmed/corrected from desc-miss diag log.
    nextDataField:       'props.pageProps.job.description',
  },
  glassdoor: {
    keyParam:      'jl',
    keyRegex:      null,
    keyDecode:     false,
    cardAttr:      'data-jobid',
    cardIdPrefix:  null,
    cardHrefKey:   null,
    clickSelector: null,
    // Navigate to each job page in a background tab — individual job pages carry a
    // JSON-LD JobPosting with description (primary) and [class*="JobDetails_jobDescription"]
    // as DOM fallback. [data-brandviews*="joblisting-description"] only exists on search
    // results pages, not on individual job-listing pages.
    expandViaNavigation: true,
    navUrlField:         'url',
    jsonLdType:          'JobPosting',
    jsonLdField:         'description',
    panelSelector: '[class*="JobDetails_jobDescription"]',
    panelMulti:    false,
    closeSelector: null,
    // Glassdoor embeds REGIONAL-domain hrefs in its search cards (e.g.
    // fr.glassdoor.ca for an Ontario search). We log in + earn cf_clearance on
    // www.glassdoor.com only, so navigating to the regional host serves an
    // anti-bot "Security" wall (French "Aidez-nous à protéger Glassdoor…", no
    // JSON-LD, no __NEXT_DATA__) and the JD comes back empty — confirmed via the
    // desc-miss diag (url=fr.glassdoor.ca → title "Security | Glassdoor"). The
    // job-listing path is global, so pin enrichment navigation to the session
    // domain. Only the nav URL is rewritten; job.url (the user-facing apply link)
    // keeps its regional host so the human still lands on their locale.
    pinHost: 'www.glassdoor.com',
  },
};

// Format a schema.org JobPosting.baseSalary object into a compact display string
// ("$80,000 - $120,000/yr", "$55/hr"). Returns '' for anything unrecognizable so a
// malformed block never poisons the salary field. Shared by the enrichment path
// (ZipRecruiter/Glassdoor) — backfills salary the list extractor couldn't get.
function formatJsonLdSalary(bs) {
  if (!bs || typeof bs !== 'object') return '';
  const cur = String(bs.currency || bs.salaryCurrency || '').toUpperCase();
  const sym = (cur === 'USD' || cur === 'CAD' || cur === 'AUD' || cur === '') ? '$' : `${cur} `;
  const v = bs.value && typeof bs.value === 'object' ? bs.value : bs;
  const unitMap = { YEAR: '/yr', HOUR: '/hr', MONTH: '/mo', WEEK: '/wk', DAY: '/day' };
  const unit = unitMap[String(v.unitText || '').toUpperCase()] || '';
  const num = (x) => (x == null || isNaN(Number(x))) ? null : Number(x).toLocaleString('en-US');
  const min = num(v.minValue), max = num(v.maxValue), val = num(v.value);
  if (min != null && max != null) return `${sym}${min} - ${sym}${max}${unit}`;
  if (val != null) return `${sym}${val}${unit}`;
  return '';
}

// ── Challenge detection ───────────────────────────────────────────────────────
async function getChallengeSignals(page) {
  return page.evaluate(() => {
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
    const hasVerificationText =
      hasVerificationSuccessful ||
      bodyText.includes('verify you are human') ||
      bodyText.includes('let us know you') ||
      bodyText.includes('security check') ||
      bodyText.includes('your ray id for this request') ||
      bodyText.includes('additional verification required') ||
      bodyText.includes('i am not a robot');
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

    // Hard block: a verification wall is present but there is NO interactive widget
    // to solve (no Cloudflare turnstile, no reCAPTCHA, no hCaptcha). Covers both the
    // CF "Additional Verification Required" Ray-ID page AND a Google /sorry page that
    // serves no reCAPTCHA (a pure rate-limit block). Since a solvable challenge is
    // now waited on INDEFINITELY, distinguishing this is essential: callers must skip
    // a hard block immediately so it can't hang the run on an interaction that can't happen.
    const isHardBlock = (reason === 'verification-text' || reason === 'google-sorry-recaptcha') &&
                        !hasCloudflareChallengeFrame &&
                        !hasCloudflareTurnstileWidget &&
                        visibleRecaptchaFrames === 0 &&
                        visibleHCaptchaFrames === 0 &&
                        !hasNormalContent;
    if (isHardBlock) reason = 'hard-block';

    return {
      isChallenge: reason !== 'none',
      isHardBlock,
      verificationCompleted: hasVerificationSuccessful,
      reason,
      url: window.location.href,
      title: titleRaw.slice(0, 120),
      bodyHead: bodyTextRaw.replace(/\s+/g, ' ').trim().slice(0, 240),
      hasChallengeShell,
      hasPerimeterXBlock,
      hasVerificationText,
      hasNormalContent,
      visibleRecaptchaFrames,
      visibleHCaptchaFrames,
      hasCloudflareChallengeFrame,
      hasCloudflareTurnstileWidget,
      hasIndeedCloudflareMarker,
      hasDataDomeFrame,
      hasDataDomeScript,
    };
  }).catch(() => ({
    isChallenge: false,
    isHardBlock: false,
    verificationCompleted: false,
    reason: 'evaluate-failed',
    url: page.url(),
    title: '',
    bodyHead: '',
    hasChallengeShell: false,
    hasPerimeterXBlock: false,
    hasVerificationText: false,
    hasNormalContent: false,
    visibleRecaptchaFrames: 0,
    visibleHCaptchaFrames: 0,
    hasCloudflareChallengeFrame: false,
    hasCloudflareTurnstileWidget: false,
    hasIndeedCloudflareMarker: false,
    hasDataDomeFrame: false,
    hasDataDomeScript: false,
  }));
}

function formatChallengeEvidence(signals, key = null) {
  if (!signals) return 'challenge signals unavailable';
  const bits = [
    key ? `key=${key}` : null,
    signals.reason ? `reason=${signals.reason}` : null,
    signals.url ? `url=${signals.url}` : null,
    signals.title ? `title=${JSON.stringify(signals.title)}` : null,
    `normalContent=${signals.hasNormalContent ? 'yes' : 'no'}`,
    signals.hasChallengeShell ? 'challengeShell=yes' : null,
    signals.hasPerimeterXBlock ? 'perimeterX=yes' : null,
    signals.hasVerificationText ? 'verificationText=yes' : null,
    signals.visibleRecaptchaFrames ? `recaptchaFrames=${signals.visibleRecaptchaFrames}` : null,
    signals.visibleHCaptchaFrames ? `hcaptchaFrames=${signals.visibleHCaptchaFrames}` : null,
    signals.hasCloudflareChallengeFrame ? 'cfFrame=yes' : null,
    signals.hasCloudflareTurnstileWidget ? 'turnstileWidget=yes' : null,
    signals.hasIndeedCloudflareMarker ? 'indeedCfMarker=yes' : null,
    signals.hasDataDomeFrame ? 'dataDomeFrame=yes' : null,
    signals.hasDataDomeScript ? 'dataDomeScript=yes' : null,
    signals.bodyHead ? `bodyHead=${JSON.stringify(signals.bodyHead)}` : null,
  ].filter(Boolean);
  return bits.join(' | ').slice(0, 700);
}

async function detectChallengePage(page) {
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

async function recoverFromChallengeHomeLanding(page, overlayBase, signal, resumeUrl, count = null) {
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
const OVERLAY_SCRIPT = buildOverlayScript({ withPause: true, cdpBridge: false });

async function injectOverlay(page) {
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
async function waitIfPaused(page, signal) {
  while (true) {
    if (signal?.aborted) return 'abort';
    let paused = false;
    try { paused = await page.evaluate(() => !!window.__icPaused); } catch { /* page mid-navigation */ }
    manualScraperTelemetry.paused = paused;
    if (!paused) return 'ok';
    await new Promise(r => setTimeout(r, humanDelay(500)));
  }
}

// ── waitForReady ──────────────────────────────────────────────────────────────
// Waits for real page content to appear, handling challenge pages.
// Returns 'ok' | 'skip' (challenge timed out) | 'abort' (signal aborted).
async function waitForReady(page, sourceId, overlayBase, signal, resumeUrl = null) {
  const contentSel    = CONTENT_SELECTORS[sourceId];
  const contentDL     = Date.now() + CONTENT_TIMEOUT_MS;
  let inChallenge              = false;
  let challengeStartedAt       = 0; // when the current challenge wait began (for the heartbeat)
  let lastChallengeHeartbeat   = 0;
  let cleanSince               = null; // tracks when page first went challenge-free
  let shownVerifiedOverlay     = false;
  let didHomeLandingRecover    = false; // true if recoverFromChallengeHomeLanding fired
  let justRecovered            = false; // true on the iteration immediately after a home-landing recovery

  while (true) {
    if (signal?.aborted) return 'abort';

    const signals     = await getChallengeSignals(page);
    const isChallenge = !!signals?.isChallenge;
    const hasContent  = !contentSel || await page.evaluate(
      s => !!document.querySelector(s), contentSel
    ).catch(() => false);

    if (isChallenge) {
      cleanSince = null; // challenge present or re-served — reset stable timer
      if (justRecovered) {
        // Challenge appeared immediately after navigating back to the resume URL —
        // that URL is itself blocked. Skip now; no checkbox-solve will unblock it.
        logger.warn(`[BrowserScraper] ${overlayBase.srcName}: resume URL immediately challenged after recovery — session fully blocked, skipping source`);
        return 'skip';
      }
      // Hard block: no interactive widget present, nothing for the user to solve.
      // "Additional Verification Required" shows only a Ray ID + "Return home" —
      // since a solvable challenge now waits indefinitely, a hard block MUST skip
      // here or it would hang the run forever. Surface a clear, actionable error.
      if (signals?.isHardBlock) {
        const evidence = formatChallengeEvidence(signals);
        logger.warn(`[BrowserScraper] ${overlayBase.srcName}: hard block — no solvable challenge widget (${evidence})`);
        recordManualScraperTelemetry({
          phase:     'challenge-hard-block',
          srcName:   overlayBase.srcName,
          reason:    signals.reason,
          title:     signals.title,
          bodyHead:  signals.bodyHead,
          url:       signals.url,
        });
        await updateOverlay(page, {
          ...overlayBase,
          status: `🚫 ${overlayBase.srcName} hard-blocked this session — open it in Chrome, log in, then retry`,
          error:  true,
        }).catch(() => {});
        await new Promise(r => setTimeout(r, humanDelay(2000)));
        return 'hard-block';
      }
      if (!inChallenge) {
        inChallenge = true;
        challengeStartedAt = Date.now();
        lastChallengeHeartbeat = Date.now();
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
        // user-solve wait. Best-effort; nulls if a lookup fails.
        const egress = await lookupEgress();
        const blockId = await extractBlockId(page);
        recordManualScraperTelemetry({
          phase:    'challenge-detected',
          srcName:  overlayBase.srcName,
          reason:   signals?.reason,
          title:    signals?.title,
          bodyHead: signals?.bodyHead,
          url:      signals?.url,
          cfFrame:  signals?.hasCloudflareChallengeFrame,
          recaptcha: signals?.visibleRecaptchaFrames,
          browserProfile: BROWSER_LAUNCH_PROFILE,
          egressIp:       egress.ip,
          egressIsp:      egress.isp,
          egressOrg:      egress.org,
          egressHosting:  egress.hosting,
          blockId,
        });
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
      if (Date.now() - lastChallengeHeartbeat >= CHALLENGE_HEARTBEAT_MS) {
        lastChallengeHeartbeat = Date.now();
        logger.info(`[BrowserScraper] ${overlayBase.srcName}: still waiting for the user to solve the challenge (${Math.round((Date.now() - challengeStartedAt) / 60000)} min elapsed)`);
      }
      await new Promise(r => setTimeout(r, CONTENT_POLL_MS));
      continue;
    }

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
      await updateOverlay(page, { ...overlayBase, status: 'Extracting jobs…' });
      logger.info(`[BrowserScraper] ${overlayBase.srcName}: challenge resolved — resuming`);
      // 'recovered' signals that a home-landing recovery fired — caller is on the
      // base search URL (page 1), not the paginated URL that triggered the challenge.
      // Pagination callers should break rather than re-navigating to the same page.
      return didHomeLandingRecover ? 'recovered' : 'ok';
    }

    if (hasContent || Date.now() > contentDL) return 'ok';

    await new Promise(r => setTimeout(r, CONTENT_POLL_MS));
  }
}

// ── Extractor runner ──────────────────────────────────────────────────────────
// Returns { jobs: Array, siteChangedError: Error|null, evalError: Error|null }.
// evalError is any OTHER thrown error (not SITE_CHANGED) — usually a genuine
// transient (context destroyed by a mid-evaluate navigation) that resolves on
// its own next tick, but a real bug in the extractor throws the exact same
// shape. Without surfacing it distinctly, a persistently-failing extractor is
// indistinguishable from "the page briefly navigated" and silently degrades
// to "0 jobs, done" with no diagnostic trail. The caller tracks a consecutive
// streak (mirroring siteChangedStreak) and only warns once it persists.
async function runExtractor(page, extractorJS) {
  try {
    const raw = await page.evaluate(extractorJS);
    return { jobs: Array.isArray(raw) ? raw : [], siteChangedError: null, evalError: null };
  } catch (err) {
    if (/SITE_CHANGED/i.test(err?.message)) return { jobs: [], siteChangedError: err, evalError: null };
    return { jobs: [], siteChangedError: null, evalError: err }; // context destroyed / transient — retry next tick, unless it persists
  }
}

// ── Description expansion ─────────────────────────────────────────────────────
// Clicks each job card and captures the full description from the side panel.
// Only runs when DESC_CONFIGS[sourceId] is defined.
//
// Returns { jobs, descError } where descError is non-null when card or panel
// selectors appear stale (≥ DESC_STALE_THRESHOLD consecutive failures of the same
// type). A non-null descError is an abort signal — the caller must set earlyExit
// and surface the error just like a SITE_CHANGED extraction failure.
async function expandDescriptions(page, jobs, sourceId, overlayBase, totalSoFar, signal = null) {
  const cfg = DESC_CONFIGS[sourceId];
  if (!cfg || jobs.length === 0) return { jobs, descError: null };

  const enhanced  = [...jobs];
  // Jobs collected before this batch starts — used to increment the overlay counter
  // one-by-one (baseCount + i + 1) rather than jumping to totalSoFar immediately.
  const baseCount = totalSoFar - jobs.length;

  // Navigation-based expansion: navigate to each job's individual page and extract
  // the description there. Used for ZipRecruiter where the extractor
  // reads jobs from JSON (all upfront) but React's virtual list may never render
  // the corresponding card DOM elements — making card-click expansion unreliable.
  if (cfg.expandViaNavigation && (cfg.navUrlTemplate || cfg.navUrlField)) {
    const listUrl = page.url();

    // Open a dedicated background page for detail fetches so the main list page
    // stays put — eliminates the visual ping-pong between search results and
    // individual job pages. Falls back to the main page if newPage() fails.
    let detailPage = null;
    try {
      detailPage = await page.browser().newPage();
      await detailPage.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver',           { get: () => false });
        Object.defineProperty(navigator, 'platform',            { get: () => 'MacIntel' });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
        Object.defineProperty(navigator, 'maxTouchPoints',      { get: () => 0 });
      }).catch(() => {});
      const ua = await page.evaluate(() => navigator.userAgent).catch(() => null);
      if (ua) await detailPage.setUserAgent(ua).catch(() => {});
      const vp = page.viewport();
      if (vp) await detailPage.setViewport(vp).catch(() => {});
    } catch {
      detailPage = null;
    }
    const fetchPage = detailPage ?? page;

    // Fire the desc/date "miss" diagnostics on the FIRST failure ANYWHERE in the
    // batch — not just i===0. A source can enrich job 0 fine but fail later ones
    // (e.g. Glassdoor serving fr.glassdoor.ca pages that soft-authwall the JD on a
    // regional domain we're not logged into), and the old i===0 gate captured zero
    // page context in exactly that case — so a "7/14 descriptions empty" report
    // had no evidence for WHY. Latches so we log one rich sample per batch.
    let descMissDiagDone = false;
    let dateMissDiagDone = false;
    try {
      for (let i = 0; i < enhanced.length; i++) {
        const job = enhanced[i];
        let viewUrl;
        if (cfg.navUrlField) {
          viewUrl = job[cfg.navUrlField] || '';
        } else {
          const rawKey = (cfg.keyField && job[cfg.keyField])
            ? job[cfg.keyField]
            : cfg.keyRegex
              ? job.url?.match(new RegExp(cfg.keyRegex))?.[1]
              : job.url?.match(new RegExp(`[?&]${cfg.keyParam}=([^&]+)`))?.[1];
          if (!rawKey) continue;
          const key = cfg.keyDecode ? decodeURIComponent(rawKey) : rawKey;
          viewUrl = cfg.navUrlTemplate.replace('{key}', key);
        }
        if (!viewUrl) continue;

        // Pin enrichment to the session domain when configured (Glassdoor serves
        // regional-domain job hrefs that wall us — see DESC_CONFIGS.glassdoor.pinHost).
        // Rewrites any sibling host sharing pinHost's second-level label
        // (fr.glassdoor.ca / www.glassdoor.com → pinHost). Host-only: path + query
        // preserved; an unrelated host (no shared SLD) is left untouched.
        if (cfg.pinHost) {
          const sld = cfg.pinHost.split('.').at(-2); // 'www.glassdoor.com' → 'glassdoor'
          if (sld) {
            viewUrl = viewUrl.replace(
              new RegExp(`^(https?://)[^/]*\\b${sld}\\.[^/]+`, 'i'),
              `$1${cfg.pinHost}`,
            );
          }
        }

        const navPause = await waitIfPaused(page, signal);
        if (navPause === 'abort') break;

        await updateOverlay(page, {
          ...overlayBase,
          count:  baseCount + i + 1,
          status: `Fetching descriptions… ${i + 1}/${enhanced.length}`,
        });

        try {
          // goto() + domcontentloaded: JSON-LD is server-rendered so it's ready
          // immediately; no need for networkidle which ZipRecruiter's analytics
          // would delay indefinitely.
          await fetchPage.goto(viewUrl, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});

          const isChallenge = await detectChallengePage(fetchPage);
          // Detect expired listings separately from challenge redirects.
          const pageInfo = await fetchPage.evaluate(() => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const title    = (document.title || '').toLowerCase();
            const isNotFound =
              bodyText.includes('page not found') ||
              bodyText.includes("we can't find this page") ||
              bodyText.includes('no longer available') ||
              bodyText.includes('this job has expired') ||
              title.includes('404');
            return { isNotFound };
          }).catch(() => ({ isNotFound: false }));

          if (isChallenge) {
            if (detailPage) {
              // Challenge appeared on the background tab — the user can't see it
              // to solve it, so drop this job's description and keep moving.
              enhanced[i] = null;
              continue;
            }
            // Fallback path: main page is being used, challenge is visible.
            await updateOverlay(page, {
              ...overlayBase,
              count:     baseCount + i + 1,
              status:    '⚠️ Complete the verification to continue',
              challenge: true,
            });
            logger.info(`[BrowserScraper] ${overlayBase.srcName}: human verification detected during description expansion — waiting for user (no timeout; Reset to cancel)`);
            let solved = false;
            let descHeartbeatAt = Date.now();
            const descChallengeStart = Date.now();
            // Wait INDEFINITELY for the user to solve. The only exits are abort
            // (Reset / hub close) or the user closing the window — never a timer.
            while (true) {
              if (signal?.aborted || page.isClosed()) break;
              await new Promise(r => setTimeout(r, humanDelay(1500)));
              if (await recoverFromChallengeHomeLanding(page, overlayBase, signal, viewUrl, baseCount + i + 1)) {
                continue;
              }
              const stillChallenge = await detectChallengePage(page);
              if (!stillChallenge) { solved = true; break; }
              if (Date.now() - descHeartbeatAt >= CHALLENGE_HEARTBEAT_MS) {
                descHeartbeatAt = Date.now();
                logger.info(`[BrowserScraper] ${overlayBase.srcName}: still waiting for description-expansion challenge solve (${Math.round((Date.now() - descChallengeStart) / 60000)} min elapsed)`);
              }
            }
            if (!solved) break;
            await updateOverlay(page, {
              ...overlayBase,
              count:  baseCount + i + 1,
              status: `Fetching descriptions… ${i + 1}/${enhanced.length}`,
            });
            i--; // retry this job now that the challenge is solved
            continue;
          }

          if (pageInfo.isNotFound) { enhanced[i] = null; continue; } // expired listing — drop it

          // Try JSON-LD JobPosting.description first (server-rendered, selector-free).
          // Fall back to __NEXT_DATA__ pageProps probe, then CSS panelSelector.
          // Also harvest `datePosted` from the same JobPosting block — some list
          // extractors (e.g. ZipRecruiter's ItemList) carry no date, so the
          // per-job posting page is the only place to recover it.
          let text = '';
          let jsonLdDate = '';
          let jsonLdSalary = ''; // formatted pay from JobPosting.baseSalary (if present)
          if (cfg.jsonLdType) {
            const ld = await fetchPage.evaluate((type, field, datePattern) => {
              let desc = '';
              let datePosted = '';
              let baseSalary = null; // schema.org JobPosting.baseSalary (employer-stated pay)
              // Robust JSON-LD harvest: a block may be a single object, an ARRAY of
              // objects, or wrap nodes in an `@graph`; and `@type` may be a string
              // OR an array (["JobPosting"]). The old strict `d['@type'] !== type`
              // missed the array/@graph cases — so a JobPosting nested in an
              // @graph (common on ZipRecruiter) was skipped, the description fell
              // through to the panel selector, and `datePosted` was never captured.
              // Flatten everything, then match leniently. Additive — finds MORE
              // JobPosting nodes, never fewer, so it can't regress a working source.
              const matchesType = (t) => Array.isArray(t) ? t.includes(type) : t === type;
              const candidates = [];
              for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
                try {
                  const parsed = JSON.parse(s.textContent);
                  for (const node of (Array.isArray(parsed) ? parsed : [parsed])) {
                    if (!node || typeof node !== 'object') continue;
                    candidates.push(node);
                    if (Array.isArray(node['@graph'])) candidates.push(...node['@graph']);
                  }
                } catch {
                  // Ignore malformed JSON-LD blocks and keep probing fallbacks.
                }
              }
              for (const d of candidates) {
                if (!d || !matchesType(d['@type'])) continue;
                if (!desc && d[field]) {
                  const tmp = document.createElement('div');
                  tmp.innerHTML = d[field];
                  desc = tmp.innerText?.trim() || '';
                }
                // schema.org JobPosting standardizes on `datePosted`; some feeds
                // emit `datePublished` — accept either.
                if (!datePosted && (d.datePosted || d.datePublished)) {
                  datePosted = String(d.datePosted || d.datePublished);
                }
                // Some employer-stated postings carry structured pay here even when
                // the list extractor had none (ZipRecruiter ItemList = name+url only).
                if (!baseSalary && d.baseSalary && typeof d.baseSalary === 'object') {
                  baseSalary = d.baseSalary;
                }
              }
              // DOM fallback for the date: some detail pages carry NO structured
              // date at all — verified on ZipRecruiter's new /jobs/{co}/{slug}
              // pages (no JSON-LD, no __NEXT_DATA__, no <time>), where the only
              // signal is a visible "Posted 28 days ago" label in a utility-classed
              // <p>. Match by TEXT PATTERN (robust to ZR's churning Tailwind class
              // names), taking the first short text leaf that reads like a relative
              // date. Returns the clean phrase ("28 days ago") for parsePostedDate.
              if (!datePosted) {
                const re = new RegExp(datePattern, 'i');
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                let node;
                while ((node = walker.nextNode())) {
                  const txt = (node.textContent || '').trim();
                  if (!txt || txt.length > 60) continue; // the date is a short label, not a paragraph
                  const m = txt.match(re);
                  if (m) { datePosted = m[0]; break; }
                }
              }
              return { desc, datePosted, baseSalary };
            }, cfg.jsonLdType, cfg.jsonLdField, POSTED_DATE_PATTERN).catch(() => ({ desc: '', datePosted: '', baseSalary: null }));
            text = ld.desc;
            jsonLdDate = ld.datePosted;
            jsonLdSalary = formatJsonLdSalary(ld.baseSalary);
          }
          // __NEXT_DATA__ fallback: walk a dot-separated field path into pageProps.
          if (!text && cfg.nextDataField) {
            text = await fetchPage.evaluate(fieldPath => {
              try {
                const nd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null');
                if (!nd) return '';
                const parts = fieldPath.split('.');
                let node = nd;
                for (const p of parts) {
                  if (node == null || typeof node !== 'object') return '';
                  node = node[p];
                }
                if (!node || typeof node !== 'string') return '';
                const tmp = document.createElement('div');
                tmp.innerHTML = node;
                return tmp.innerText?.trim() || '';
              } catch { return ''; }
            }, cfg.nextDataField).catch(() => '');
          }
          if (!text) {
            text = await fetchPage.evaluate(sel => {
              return document.querySelector(sel)?.innerText?.trim() || '';
            }, cfg.panelSelector).catch(() => '');
          }
          if (!text) {
            // Structural fallback: find "Job description" heading and grab next sibling.
            text = await fetchPage.evaluate(() => {
              for (const h of document.querySelectorAll('h2, h3')) {
                if (h.textContent?.trim() === 'Job description') {
                  return h.nextElementSibling?.innerText?.trim() || '';
                }
              }
              return '';
            }).catch(() => '');
          }
          // DOM salary fallback (ZipRecruiter): pay is rendered CLIENT-SIDE as an
          // "Estimated pay" chip — not in JSON-LD, not in the search ItemList — so it
          // can only be read from the live DOM. Match by money TEXT pattern (robust
          // to ZR's churning Tailwind classes). Bounded wait: resolves instantly once
          // the chip hydrates (the common case, since ZR estimates ~every job); only
          // a genuinely pay-less page pays the full timeout.
          if (cfg.salaryFromDom && !jsonLdSalary) {
            const MONEY_SRC = String.raw`\$\s?\d[\d.,]*\s?[KkMm]?(?:\s?(?:[-–—]|to)\s?\$?\s?\d[\d.,]*\s?[KkMm]?)?(?:\s?\/\s?(?:yr|year|hr|hour|mo|month|wk|week))?`;
            await fetchPage.waitForFunction((src) => {
              const re = new RegExp(src);
              return [...document.querySelectorAll('p')].some(p => re.test(p.textContent || ''));
            }, { timeout: 1500 }, MONEY_SRC).catch(() => {});
            jsonLdSalary = await fetchPage.evaluate((src) => {
              const re = new RegExp(src);
              for (const p of document.querySelectorAll('p')) {
                const t = (p.textContent || '').trim();
                if (t.length <= 40 && re.test(t)) { const m = t.match(re); return (m && m[0].trim()) || ''; }
              }
              return '';
            }, MONEY_SRC).catch(() => '');
          }
          // Diagnostic: first miss per batch — log page context for next bug report.
          if (!text && !descMissDiagDone) {
            descMissDiagDone = true;
            const diag = await fetchPage.evaluate(() => {
              const ldTypes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
                .map(s => { try { return JSON.parse(s.textContent)['@type']; } catch { return '?'; } });
              let ndKeys = '';
              try {
                const nd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null');
                ndKeys = Object.keys(nd?.props?.pageProps || {}).slice(0, 8).join(',');
              } catch {
                // Diagnostic-only probe; missing/invalid Next data is expected.
              }
              return {
                url:       location.href.slice(0, 120),
                title:     document.title?.slice(0, 80),
                ldTypes,
                hasNextData: !!document.getElementById('__NEXT_DATA__'),
                ndPagePropKeys: ndKeys,
                bodyHead:  (document.body?.innerText || '').slice(0, 200).replace(/\s+/g, ' '),
              };
            }).catch(() => null);
            if (diag) {
              logger.info(`[BrowserScraper] ${overlayBase.srcName} desc-miss diag (job ${i + 1}/${enhanced.length}): url="${diag.url}" title="${diag.title}" ldTypes=[${diag.ldTypes.join(',')}] nextData=${diag.hasNextData} ndKeys="${diag.ndPagePropKeys}" body="${diag.bodyHead}"`);
            }
          }
          if (text || jsonLdSalary) {
            // Backfill description, posted date, and salary — each only when the list
            // extractor didn't already capture it (don't clobber a good relative date
            // like "3 days ago" with an ISO timestamp, or a stated salary with an
            // estimate). Salary alone is enough to write the job (a pay-less list row
            // that gained an estimate still wins), so the guard is `text || salary`.
            enhanced[i] = {
              ...job,
              ...(text ? { snippet: text } : {}),
              ...(jsonLdDate && !job.posted ? { posted: jsonLdDate } : {}),
              ...(jsonLdSalary && !job.salary ? { salary: jsonLdSalary } : {}),
            };
          }
          // Date-miss diagnostic (once per batch): a description was recovered but
          // NO posted date — not from the list extractor, the JobPosting JSON-LD,
          // OR the visible "Posted X ago" DOM fallback. Capture the JSON-LD @types
          // + any date-like fields present so the next bug report pinpoints WHERE
          // this source's date lives (vs. a bare "posted: ALL empty" with no cause).
          if (text && !jsonLdDate && !job.posted && !dateMissDiagDone) {
            dateMissDiagDone = true;
            const dateDiag = await fetchPage.evaluate(() => {
              const ldTypes = [];
              const dateFields = [];
              for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
                try {
                  const parsed = JSON.parse(s.textContent);
                  for (const node of (Array.isArray(parsed) ? parsed : [parsed])) {
                    const nodes = [node, ...(Array.isArray(node && node['@graph']) ? node['@graph'] : [])];
                    for (const n of nodes) {
                      if (!n || typeof n !== 'object') continue;
                      ldTypes.push(Array.isArray(n['@type']) ? n['@type'].join('|') : (n['@type'] || '?'));
                      for (const k of Object.keys(n)) {
                        if (/date|posted|publish/i.test(k)) dateFields.push(`${k}=${String(n[k]).slice(0, 32)}`);
                      }
                    }
                  }
                } catch { /* ignore malformed JSON-LD */ }
              }
              return { ldTypes: ldTypes.slice(0, 12), dateFields: dateFields.slice(0, 12) };
            }).catch(() => null);
            if (dateDiag) {
              logger.info(`[BrowserScraper] ${overlayBase.srcName} date-miss diag: ldTypes=[${dateDiag.ldTypes.join(',')}] dateFields=[${dateDiag.dateFields.join(', ')}]`);
            }
          }
        } catch {
          // Per-listing navigation errors are non-fatal; keep the batch moving.
        }
      }
    } finally {
      await detailPage?.close().catch(() => {});
    }

    // If the main page was used as fallback, return it to the list URL.
    // If detailPage was used, the main page never navigated — just re-inject overlay.
    if (!detailPage) {
      try {
        await page.evaluate(u => { window.location.href = u; }, listUrl).catch(() => {});
        await new Promise(r => setTimeout(r, humanDelay(2000)));
      } catch {
        // Best-effort return to the list; the caller can still continue or stop cleanly.
      }
    }
    try { await injectOverlay(page); } catch {
      // Overlay reinjection is best-effort after detail navigation.
    }
    return { jobs: enhanced.filter(Boolean), descError: null };
  }

  // Start from empty so the first card's already-visible description is captured
  // on the first click rather than mistaken for "no change" and skipped.
  let prevPanelText = '';
  let consecutiveClickFails    = 0;
  let consecutivePanelTimeouts = 0;
  let descError = null;

  const abortWithError = async (evidence, suggestion) => {
    logger.warn(`[BrowserScraper] ${sourceId}: ${evidence}`);
    await updateOverlay(page, {
      ...overlayBase,
      count:  totalSoFar,
      status: 'Desc selector broken — fix selector code and restart.',
      error:  true,
    }).catch(() => {});
    await new Promise(r => setTimeout(r, humanDelay(3000)));
    descError = {
      code:       'stale-desc-selectors',
      severity:   'block',
      evidence,
      suggestion,
    };
  };

  // ── Reveal pass ───────────────────────────────────────────────────────────────
  // Scroll through all job cards once to ensure they're loaded into the DOM, then
  // reset to the top of the list. This mirrors Google's preloadContent pattern:
  // we know the full count N before clicking begins, giving stable
  // "Reading job X/N" progress rather than a blind scroll-per-card approach.
  {
    let revealedCount = 0;
    for (let ri = 0; ri < enhanced.length; ri++) {
      if (signal?.aborted || page.isClosed()) break;
      const job = enhanced[ri];
      const rawKey = (cfg.keyField && job[cfg.keyField])
        ? job[cfg.keyField]
        : cfg.keyRegex
          ? job.url?.match(new RegExp(cfg.keyRegex))?.[1]
          : job.url?.match(new RegExp(`[?&]${cfg.keyParam}=([^&]+)`))?.[1];
      if (!rawKey) continue;
      const key = cfg.keyDecode ? decodeURIComponent(rawKey) : rawKey;

      const found = await page.evaluate(async (cardAttr, cardIdPrefix, cardHrefKey, k) => {
        let card;
        if (cardAttr) {
          card = document.querySelector(`[${cardAttr}="${k}"]`) || document.querySelector(`a[href*="${k}"]`);
        } else if (cardHrefKey != null) {
          card = document.querySelector(`a[href*="${cardHrefKey}${k}-"]`);
        } else {
          card = document.getElementById((cardIdPrefix || '') + k);
        }
        if (!card) return false;
        const rect = card.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
          const dest = window.scrollY + rect.top - window.innerHeight * 0.35;
          const start = window.scrollY;
          const delta = dest - start;
          const steps = 4 + Math.floor(Math.random() * 4);
          for (let s = 1; s <= steps; s++) {
            window.scrollTo(0, start + delta * s / steps);
            await new Promise(r => setTimeout(r, 25 + Math.random() * 45));
          }
        }
        return true;
      }, cfg.cardAttr ?? null, cfg.cardIdPrefix ?? null, cfg.cardHrefKey ?? null, key).catch(() => false);

      if (found) revealedCount++;
      await updateOverlay(page, {
        ...overlayBase,
        count:  baseCount,
        status: `Revealing cards… ${ri + 1}/${enhanced.length}`,
      }).catch(() => {});
      await new Promise(r => setTimeout(r, humanDelay(50)));
    }
    await page.evaluate(async () => {
      const start = window.scrollY;
      const steps = 4 + Math.floor(Math.random() * 4);
      for (let s = 1; s <= steps; s++) {
        window.scrollTo(0, start * (1 - s / steps));
        await new Promise(r => setTimeout(r, 25 + Math.random() * 55));
      }
    }).catch(() => {});
    await new Promise(r => setTimeout(r, humanDelay(200)));
    logger.info(`[BrowserScraper] expandDescriptions(${sourceId}): reveal pass found ${revealedCount}/${enhanced.length} cards — starting click pass`);
  }

  for (let i = 0; i < enhanced.length; i++) {
    const clickPause = await waitIfPaused(page, signal);
    if (clickPause === 'abort') break;

    const job = enhanced[i];

    const rawKey = (cfg.keyField && job[cfg.keyField])
      ? job[cfg.keyField]
      : cfg.keyRegex
        ? job.url?.match(new RegExp(cfg.keyRegex))?.[1]
        : job.url?.match(new RegExp(`[?&]${cfg.keyParam}=([^&]+)`))?.[1];
    if (!rawKey) continue;
    const key = cfg.keyDecode ? decodeURIComponent(rawKey) : rawKey;

    await updateOverlay(page, {
      ...overlayBase,
      count:  baseCount + i + 1,
      status: `Reading job ${i + 1}/${enhanced.length}…`,
    });

    try {
      // Scroll card into view and get coordinates for a real mouse click.
      // Real mouse events are reliably intercepted by the SPA's React event handlers;
      // untrusted DOM .click() may not be and can follow the raw href instead.
      const clickTarget = await page.evaluate(async (cardAttr, cardIdPrefix, cardHrefKey, clickSel, k) => {
        let card;
        if (cardAttr) {
          card = document.querySelector(`[${cardAttr}="${k}"]`) || document.querySelector(`a[href*="${k}"]`);
        } else if (cardHrefKey != null) {
          card = document.querySelector(`a[href*="${cardHrefKey}${k}-"]`);
        } else {
          card = document.getElementById((cardIdPrefix || '') + k);
        }
        if (!card) return { ok: false };
        const target = clickSel ? card.querySelector(clickSel) : card;
        if (!target) return { ok: false };
        const rect0 = target.getBoundingClientRect();
        if (rect0.top < 0 || rect0.bottom > window.innerHeight) {
          const dest = window.scrollY + rect0.top - window.innerHeight * 0.3;
          const start = window.scrollY;
          const delta = dest - start;
          const steps = 4 + Math.floor(Math.random() * 4);
          for (let s = 1; s <= steps; s++) {
            window.scrollTo(0, start + delta * s / steps);
            await new Promise(r => setTimeout(r, 25 + Math.random() * 45));
          }
        }
        const rect = target.getBoundingClientRect();
        if (!rect.width || !rect.height) return { ok: false };
        return {
          ok: true,
          x: rect.left + Math.min(rect.width - 1, Math.max(1, rect.width * 0.35)),
          y: rect.top + Math.min(rect.height - 1, Math.max(1, rect.height * 0.5)),
        };
      }, cfg.cardAttr ?? null, cfg.cardIdPrefix ?? null, cfg.cardHrefKey ?? null, cfg.clickSelector ?? null, key)
        .catch(() => ({ ok: false }));

      if (!clickTarget.ok) {
        consecutiveClickFails++;
        consecutivePanelTimeouts = 0;
        if (consecutiveClickFails >= DESC_STALE_THRESHOLD) {
          await abortWithError(
            `${consecutiveClickFails} consecutive card-click failures for ${sourceId} — card element not found in DOM (key="${key}")`,
            `The card selector for ${sourceId} description expansion may have changed. Check DESC_CONFIGS['${sourceId}'] cardAttr/cardIdPrefix/cardHrefKey in electron/ipc/browser/manualScraper.js.`,
          );
          break;
        }
        continue;
      }
      consecutiveClickFails = 0;

      await page.mouse.move(clickTarget.x, clickTarget.y).catch(() => {});
      await page.mouse.click(clickTarget.x, clickTarget.y, { delay: humanDelay(80) }).catch(() => {});

      const pollPanel = async () => {
        const dl = Date.now() + DESC_CHANGE_TIMEOUT_MS;
        while (Date.now() < dl) {
          await new Promise(r => setTimeout(r, DESC_CHANGE_POLL_MS));
          const text = await page.evaluate((panelSel, panelMulti) => {
            if (panelMulti) {
              return Array.from(document.querySelectorAll(panelSel))
                .map(e => e.textContent?.trim()).filter(Boolean).join('\n\n').trim();
            }
            return document.querySelector(panelSel)?.innerText?.trim() || '';
          }, cfg.panelSelector, cfg.panelMulti || false).catch(() => '');
          if (text && text !== prevPanelText) return text;
        }
        return null;
      };

      let panelText = await pollPanel();
      if (!panelText) {
        // Transient panel-data fetch failures (e.g. Glassdoor /graph 403s)
        // leave the right panel stuck on the previous card so the change-poll
        // times out. A brief cool-off then one fresh click catches most of
        // these without slowing the happy path.
        await new Promise(r => setTimeout(r, humanDelay(DESC_RETRY_PAUSE_MS)));
        await page.mouse.click(clickTarget.x, clickTarget.y, { delay: humanDelay(80) }).catch(() => {});
        panelText = await pollPanel();
      }

      let gotDescription = false;
      if (panelText) {
        enhanced[i] = { ...job, snippet: panelText };
        prevPanelText = panelText;
        gotDescription = true;
      }

      if (gotDescription) {
        consecutivePanelTimeouts = 0;
      } else {
        consecutivePanelTimeouts++;
        if (consecutivePanelTimeouts >= DESC_STALE_THRESHOLD) {
          // Try to close any open modal before aborting so the page is left clean
          if (cfg.closeSelector) {
            await page.evaluate(sel => { document.querySelector(sel)?.click(); }, cfg.closeSelector).catch(() => {});
            await new Promise(r => setTimeout(r, humanDelay(400)));
          }
          await abortWithError(
            `${consecutivePanelTimeouts} consecutive panel-read timeouts for ${sourceId} — panel selector matched nothing or click no longer triggers panel update`,
            `Check DESC_CONFIGS['${sourceId}'] panelSelector (and clickSelector) in electron/ipc/browser/manualScraper.js.`,
          );
          break;
        }
      }

      // Close modal if source uses one (e.g. Wellfound), then reset so next card captures fresh
      if (cfg.closeSelector) {
        await page.evaluate((sel) => {
          document.querySelector(sel)?.click();
        }, cfg.closeSelector).catch(() => {});
        await new Promise(r => setTimeout(r, humanDelay(400)));
        prevPanelText = '';
      }
    } catch { /* page context destroyed or other transient error — not a stale-selector signal */ }

    if (page.isClosed()) break;
    await new Promise(r => setTimeout(r, humanDelay(DESC_CLICK_DELAY_MS)));
  }

  return { jobs: enhanced, descError };
}

// ── Next-page clicker ─────────────────────────────────────────────────────────
// Returns true if next page was clicked and navigation started, false otherwise.
async function clickNextPage(page, sourceId) {
  const sel = NEXT_PAGE_SELECTORS[sourceId];
  if (!sel) return false;
  try {
    const clicked = await page.evaluate((s) => {
      const btn = document.querySelector(s);
      if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
      btn.click();
      return true;
    }, sel);
    return clicked;
  } catch {
    return false;
  }
}

// ── Pre-loader for scroll sources ─────────────────────────────────────────────
// Scrolls until JOB_PER_PAGE_CAP jobs are visible on the page — used for
// sources without traditional pagination. Must be called BEFORE runExtractor
// so extraction sees the full loaded set in one pass.
// Breaks as soon as a reveal action stops increasing the extractor-visible job
// count; otherwise keeps going until the per-query target is reached.
//
// A parallel "click a Load More button" strategy existed here as dead code:
// it was gated on a LOAD_MORE_SELECTORS map that was always `{}` (no source
// was ever configured), meaning any source actually needing that strategy
// silently got NO preload at all rather than a working fallback — worse than
// having no such feature, since it looked supported. Removed rather than
// guessing a selector for a source we can't verify; add it back with a real,
// verified selector if a specific source needs it.
async function preloadContent(page, sourceId, extractorJS, overlayBase, signal) {
  const isScroll = SCROLL_SOURCES.has(sourceId);
  if (!isScroll) return;

  let prevCount = -1;
  let iterations = 0;
  while (true) {
    if (signal?.aborted) break;
    // Ceiling on top of the "count stopped increasing" exit below — mirrors
    // click-pagination's JOB_MAX_PAGES guard (added there for the identical
    // reason: "a source whose 'next' re-serves content could loop
    // unbounded"). A source that trickles in one marginally-new item per
    // reveal action forever would otherwise never plateau exactly and never
    // hit JOB_PER_PAGE_CAP either.
    if (++iterations > JOB_MAX_PAGES) {
      logger.info(`[BrowserScraper] preloadContent(${sourceId}) hit the ${JOB_MAX_PAGES}-iteration ceiling — stopping reveal actions`);
      break;
    }
    const raw   = await page.evaluate(extractorJS).catch(() => []);
    const count = countDistinctJobs(raw);
    await updateOverlay(page, { ...overlayBase, status: `Loading jobs… ${count}/${JOB_PER_PAGE_CAP}` });
    if (count >= JOB_PER_PAGE_CAP) break;
    if (count === prevCount) break;  // no new content after last action
    prevCount = count;
    if (isScroll) {
      if (sourceId === 'google') {
        // Google for Jobs renders cards in its own scrollable container inside the page.
        // Walk up from the first card to find that container and scroll it; also
        // scroll document.body so either trigger path gets hit.
        await page.evaluate(async () => {
          const card = document.querySelector('.EimVGf, [jscontroller="b11o3b"]');
          if (card) {
            let el = card.parentElement;
            while (el && el !== document.body) {
              const s = getComputedStyle(el);
              if (s.overflowY === 'auto' || s.overflowY === 'scroll') {
                const step = Math.floor(el.clientHeight * (0.55 + Math.random() * 0.3));
                let innerSteps = 0;
                while (el.scrollTop + el.clientHeight < el.scrollHeight - 10 && innerSteps < 20) {
                  el.scrollTop += step;
                  await new Promise(r => setTimeout(r, 55 + Math.random() * 90));
                  innerSteps++;
                }
                break;
              }
              el = el.parentElement;
            }
          }
          const step = Math.floor(window.innerHeight * (0.55 + Math.random() * 0.3));
          let steps = 0;
          while (window.scrollY + window.innerHeight < document.body.scrollHeight - 10 && steps < 20) {
            window.scrollBy(0, step);
            await new Promise(r => setTimeout(r, 55 + Math.random() * 90));
            steps++;
          }
        });
      } else {
        // Cap scroll steps to prevent an infinite loop on true infinite-scroll pages
        // (e.g. ZipRecruiter "Director of Brand Marketing") where scrollHeight grows
        // as you scroll — without a cap the evaluate() runs until Puppeteer's 3-min
        // CDP protocol timeout kills the whole scrape. The outer preloadContent loop
        // re-runs after each evaluate() and stops when job count stops increasing, so
        // 20 steps per call is plenty to reveal new content while staying bounded.
        await page.evaluate(async () => {
          const step = Math.floor(window.innerHeight * (0.55 + Math.random() * 0.3));
          let steps = 0;
          while (window.scrollY + window.innerHeight < document.body.scrollHeight - 10 && steps < 20) {
            window.scrollBy(0, step);
            await new Promise(r => setTimeout(r, 55 + Math.random() * 90));
            steps++;
          }
        });
      }
    }
    await new Promise(r => setTimeout(r, humanDelay(NAV_SETTLE_MS)));
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Replace scrapeMultiple for the browser-scraped sources with a fully
 * automated visible-browser session. Takes the same flat task array and
 * onResult callback; returns the same result array shape.
 *
 * @param {Array<{id, sourceId, url, extractorJS, query}>} tasks
 * @param {function} onResult  — called with {id, sourceId, success, data, ...} per source
 * @param {AbortSignal|null}   signal
 * @returns {Promise<Array>}
 */
/**
 * Resolve a Glassdoor location string to its numeric `locId`. Glassdoor's search
 * location FILTER is keyed by locId (the `locKeyword` text alone is silently
 * ignored — verified empirically), and the location-autocomplete endpoint is
 * Cloudflare-gated, so the lookup MUST run from the glassdoor.com origin inside
 * this already-CF-cleared browser (a plain server-side fetch 403s). The result is
 * cached persistently (a locId is a stable platform id), so this costs an extra
 * navigation only on the first-ever use of a given location. Returns { locId,
 * locT } or null (→ caller falls back to an unbounded, nationwide search).
 */
async function resolveGlassdoorLocId(page, location, signal) {
  const key = String(location || '').trim().toLowerCase();
  if (!key) return null;
  const cached = getGlassdoorLocId(key);
  if (cached) return cached;
  if (signal?.aborted) return null;
  // Same-origin fetch needs the page on glassdoor.com (carries cf_clearance).
  if (!/glassdoor\.com/i.test(page.url() || '')) {
    await page.evaluate(() => { window.location.href = 'https://www.glassdoor.com/Job/index.htm'; }).catch(() => {});
    await new Promise(r => setTimeout(r, humanDelay(NAV_SETTLE_MS)));
  }
  if (signal?.aborted) return null;
  const term = (location.split(',')[0] || location).trim(); // city for the typeahead
  const res = await page.evaluate(async (t) => {
    try {
      const r = await fetch(`/findPopularLocationAjax.htm?term=${encodeURIComponent(t)}&maxLocationsToReturn=10`, {
        headers: { 'Accept': 'application/json, text/plain, */*' },
        credentials: 'include',
      });
      if (!r.ok) return { error: r.status };
      const text = await r.text();
      try { return { data: JSON.parse(text) }; } catch { return { error: 'non-json' }; }
    } catch (e) { return { error: String((e && e.message) || e) }; }
  }, term).catch(() => ({ error: 'evaluate-failed' }));
  if (!res || res.error || !Array.isArray(res.data)) {
    logger.warn(`[BrowserScraper] Glassdoor locId lookup failed for "${location}" (${res?.error ?? 'no data'})`);
    return null;
  }
  const picked = pickGlassdoorLocation(res.data, location);
  if (picked?.locId) {
    saveGlassdoorLocId(key, picked);
    return picked;
  }
  return null;
}

// Stealth navigator/screen masking applied on every document of a page (main
// frame + iframes + post-navigation). Mirrors createStealthPage() in
// stealthBrowser.js — keeps the fingerprint coherent across the session.
async function applyStealthMask(page) {
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
async function launchScrapePlatformBrowser({ userDataDir, executablePath, sandboxArgs, onCrash }) {
  const browser = await puppeteer.launch({
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
  });

  const page = await browser.newPage();
  await applyStealthMask(page);

  // Capture browser-side console errors/warnings for the bug report. Fires for all
  // frames (challenge-page + Turnstile frames included). error/warning only.
  page.on('console', msg => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const loc = msg.location();
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
    if (/t\.indeed\.com\/signals|googletagmanager|\.analytics\.|sift\.com|intercom\.io|clarity\.ms|bat\.bing|munchkin\.marketo|cdn\.branch\.io|cloudflareinsights\.com\/cdn-cgi\/rum/.test(url)) return;
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
  const navStatusRef = { last: null };
  page.on('response', res => {
    const status = res.status();
    try {
      if (res.request().resourceType() === 'document' && res.frame() === page.mainFrame()) {
        navStatusRef.last = status;
      }
    } catch { /* frame may be detached on rapid navigations — skip */ }
    if (status < 400) return;
    const url = res.url();
    if (/t\.indeed\.com\/signals|googletagmanager|\.analytics\.|sift\.com|intercom\.io|clarity\.ms|bat\.bing|munchkin\.marketo|cdn\.branch\.io/.test(url)) return;
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

  let closed = false;
  let intentional = false;
  browser.on('disconnected', () => { closed = true; if (!intentional) onCrash?.(); });

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
      if (!closed) await browser.close().catch(() => {});
      closed = true;
      // Let Chrome release the shared-profile SingletonLock before the next launch.
      await new Promise(r => setTimeout(r, 600));
    },
  };
}

// Clears the per-run browser diagnostic buffers (console/network) so a bug report
// shows only THIS run. Exposed so the orchestrator can reset ONCE when it calls
// scrapeManualSources per-source (data-driven order) — otherwise each per-source
// call would wipe the earlier sources' diagnostics.
export function resetManualScraperDiagnostics() {
  manualScraperTelemetry.consoleLogs = [];
  manualScraperTelemetry.networkErrors = [];
}

// `opts`: { resetDiagnostics=true, sourceIndexBase=0, sourceTotal=null } — for
// per-source dispatch the orchestrator passes resetDiagnostics:false (it cleared
// once up front) and the real index/total so the "Starting X/Y" log stays correct.
export async function scrapeManualSources(tasks, onResult, signal, onPageJobs = null, opts = {}) {
  const { resetDiagnostics = true, sourceIndexBase = 0, sourceTotal = null } = opts;
  // Clear per-run browser diagnostic buffers so the bug report only shows
  // what happened in THIS run, not leftovers from a previous one.
  if (resetDiagnostics) resetManualScraperDiagnostics();

  if (!Array.isArray(tasks) || tasks.length === 0) {
    clearManualScraperTelemetry('idle');
    return [];
  }

  // Group flat task list by sourceId, preserving declaration order
  const bySource = new Map();
  for (const task of tasks) {
    if (!bySource.has(task.sourceId)) bySource.set(task.sourceId, []);
    bySource.get(task.sourceId).push(task);
  }

  const results       = [];

  await closeStealthBrowser();

  // ── Per-platform fresh browser ──────────────────────────────────────────────
  // Each browser-based source gets its OWN Chrome process, launched at the top of
  // its iteration and fully closed before the next (launchScrapePlatformBrowser +
  // teardownCurrent). No single long-lived session carries accumulated automation /
  // anti-bot signal across platforms — e.g. Google, scraped last, no longer inherits
  // the "warmth" of indeed→ziprecruiter→glassdoor. The persistent userDataDir is
  // shared, so logins persist; only the process/session resets.
  const userDataDir    = await getUserDataDir();
  const executablePath = process.env.CHROME_PATH || await findChromePath();
  const sandboxArgs    = process.platform === 'darwin'
    ? []
    : ['--no-sandbox', '--disable-setuid-sandbox'];

  manualScraperTelemetry.paused = false;

  let earlyExit = false;
  let platform  = null; // current per-platform browser bundle (see teardownCurrent)
  const teardownCurrent = async () => {
    if (platform) { await platform.teardown(); platform = null; }
  };

  const sourceList = [...bySource.entries()];

  try {
    for (let si = 0; si < sourceList.length; si++) {
      if (earlyExit || signal?.aborted) break;

      const [sourceId, sourceTasks] = sourceList[si];
      const srcName  = SOURCE_LABELS[sourceId] || sourceId;
      const allJobs  = [];
      const seen     = new Set();
      let sourceSiteChangedWarning = null;
      let sourcePagesWalked        = 0;
      let sourceSkipped            = false; // set true when challenge times out — skips remaining queries for this source

      // Fresh, fully-isolated Chrome for THIS platform (torn down before the next).
      platform = await launchScrapePlatformBrowser({
        userDataDir, executablePath, sandboxArgs,
        onCrash: () => { earlyExit = true; },
      });
      const { page, navStatusRef } = platform;

      const displayIndex = sourceIndexBase + si + 1;
      const displayTotal = sourceTotal || sourceList.length;
      logger.info(`[BrowserScraper] Starting ${displayIndex}/${displayTotal}: ${srcName} (${sourceTasks.length} queries) — fresh isolated browser launched`);
      recordManualScraperTelemetry({
        phase: 'source-start',
        sourceId,
        srcName,
        sourceIndex: displayIndex,
        sourceTotal: displayTotal,
        queryTotal: sourceTasks.length,
      });

      for (let qi = 0; qi < sourceTasks.length; qi++) {
        if (earlyExit || sourceSkipped || signal?.aborted) break;

        const task = sourceTasks[qi];

        const overlayBase = {
          srcLabel: `Source ${si + 1} of ${sourceList.length}`,
          srcName,
          qLabel:   `Query ${qi + 1} of ${sourceTasks.length}`,
          qText:    task.query || '',
        };

        // Human-scale cooldown between queries (not before the first) — see
        // DEFAULT_INTER_QUERY_COOLDOWN_MS. Honors pause/abort while waiting.
        if (qi > 0) {
          const cooldownAnchor = DEFAULT_INTER_QUERY_COOLDOWN_MS;
          await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Pacing before next query…' }).catch(() => {});
          if (await waitIfPaused(page, signal) === 'abort' || signal?.aborted) { earlyExit = true; break; }
          await new Promise(r => setTimeout(r, humanDelay(cooldownAnchor)));
        }

        // Glassdoor: resolve the location text → numeric locId and append it so the
        // search is actually geo-bounded (locKeyword text alone is ignored). Done
        // in-browser (CF-gated endpoint) + cached; on any failure we leave the URL
        // unbounded (nationwide) rather than block the scrape. MUST run before the
        // query-start log + telemetry below so the recorded URL reflects the
        // geo-bounded URL we actually navigate to — otherwise the bug report shows a
        // locKeyword-only URL and Glassdoor looks unscoped when it isn't.
        if (sourceId === 'glassdoor' && task.resolveGlassdoorLocation && !task._locResolved) {
          task._locResolved = true;
          const picked = await resolveGlassdoorLocId(page, task.resolveGlassdoorLocation, signal).catch(() => null);
          if (picked?.locId && !/[?&]locId=/.test(task.url)) {
            task.url += `&locId=${encodeURIComponent(picked.locId)}&locT=${encodeURIComponent(picked.locT || 'C')}`;
            logger.info(`[BrowserScraper] Glassdoor "${task.resolveGlassdoorLocation}" → locId ${picked.locId}/${picked.locT}`);
          } else {
            logger.warn(`[BrowserScraper] Glassdoor location "${task.resolveGlassdoorLocation}" not resolved — searching nationwide (location not applied)`);
          }
        }

        logger.info(`[BrowserScraper] ${srcName} query ${qi + 1}/${sourceTasks.length}: ${task.url}`);
        recordManualScraperTelemetry({
          phase: 'query-start',
          sourceId,
          srcName,
          queryIndex: qi + 1,
          queryTotal: sourceTasks.length,
          url: task.url,
        });

        // Navigate via window.location.href — avoids CDP Page.navigate fingerprint
        navStatusRef.last = null;
        await page.evaluate(u => { window.location.href = u; }, task.url).catch(() => {});
        await new Promise(r => setTimeout(r, humanDelay(NAV_SETTLE_MS)));

        await injectOverlay(page);
        await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Loading…' });

        // Wait for real content — handles challenge pages
        const readyState = await waitForReady(page, sourceId, overlayBase, signal, task.url);
        if (readyState === 'abort' || signal?.aborted) { earlyExit = true; break; }
        if (readyState === 'hard-block') {
          // Cloudflare "Additional Verification Required" — no interactive widget,
          // nothing the user can solve. Skip all remaining queries for this source.
          if (!sourceSiteChangedWarning) {
            sourceSiteChangedWarning = {
              code:       'cloudflare-hard-block',
              severity:   'block',
              evidence:   `${srcName} was hard-blocked by Cloudflare ("Additional Verification Required") — no interactive challenge to solve.`,
              suggestion: `Open ${srcName} in a normal Chrome tab and ensure you are fully logged in, then retry. If the block persists your IP/session may be flagged — try again in a few hours.`,
            };
          }
          sourceSkipped = true;
          break;
        }
        if (readyState === 'skip') {
          // Reached only when the session is fully blocked (the resume URL re-serves
          // a challenge the instant we return to it — solving can't unblock it), NOT
          // a timeout: a solvable challenge is now waited on indefinitely.
          logger.warn(`[BrowserScraper] ${srcName}: session blocked (resume URL re-challenged) — skipping to next source`);
          if (!sourceSiteChangedWarning) {
            sourceSiteChangedWarning = {
              code:       'session-blocked',
              severity:   'block',
              evidence:   `${srcName} re-served a bot challenge the moment we returned to the results URL, so the session is blocked and the source was skipped.`,
              suggestion: `Open ${srcName} in a normal Chrome tab, ensure you are logged in and unblocked, then run the search again.`,
            };
          }
          sourceSkipped = true;
          break;
        }

        await injectOverlay(page); // re-inject after challenge resolution may have navigated
        await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Extracting jobs…' });

        // For scroll sources, pre-load content up to the per-query target
        // before running the extractor. Paginated sources skip this.
        if (SCROLL_SOURCES.has(sourceId)) {
          await preloadContent(page, sourceId, task.extractorJS, overlayBase, signal);
          if (signal?.aborted) { earlyExit = true; break; }
          await injectOverlay(page);
          await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Extracting jobs…' });
        }

        // ── Per-query extraction + pagination loop ──────────────────────────
        // startPageNum > 1 on a resume: task.url was built at that page, so the
        // counter (+ the staging ledger) continue from there for URL-paginated sources.
        let pageNum              = task.options?.startPageNum || 1;
        let siteChangedStreak    = 0;
        let siteChangedWarning   = null;
        let paginationRecoveries = 0; // times recoverFromChallengeHomeLanding fired on a paginated page
        let evalErrStreak        = 0; // consecutive non-SITE_CHANGED runExtractor throws — see runExtractor's doc comment

        while (!earlyExit && !sourceSkipped && !signal?.aborted) {
          const pauseResult = await waitIfPaused(page, signal);
          if (pauseResult === 'abort' || signal?.aborted) { earlyExit = true; break; }

          // Hard page ceiling. The per-query walk otherwise only stops on an empty
          // extraction or a failed clickNextPage — so a source whose "next" re-serves
          // content or a stale pager could loop unbounded. JOB_MAX_PAGES bounds it.
          if (pageNum > JOB_MAX_PAGES) {
            logger.info(`[BrowserScraper] ${srcName} q${qi + 1} hit JOB_MAX_PAGES (${JOB_MAX_PAGES}) — stopping pagination`);
            break;
          }

          await updateOverlay(page, {
            ...overlayBase,
            count:  allJobs.length,
            status: pageNum > 1 ? `Extracting page ${pageNum}…` : 'Extracting jobs…',
          });
          recordManualScraperTelemetry({
            phase: 'page-extract',
            sourceId,
            srcName,
            queryIndex: qi + 1,
            queryTotal: sourceTasks.length,
            pageNum,
            count: allJobs.length,
            url: page.url(),
          });

          const { jobs: extracted, siteChangedError, evalError } = await runExtractor(page, task.extractorJS);

          // A non-SITE_CHANGED throw (e.g. "context destroyed" from a
          // mid-evaluate navigation) is usually transient and should retry,
          // exactly like runExtractor's doc comment says — but extracted is
          // always [] in this case, so without this check the code below
          // (`if (extracted.length === 0) break`) silently treated ANY
          // eval hiccup as "genuinely reached end of results" and ended the
          // source's pagination outright, contradicting that comment. Mirror
          // siteChangedError's bounded-retry pattern so a real transient
          // gets a retry, and a persistently-throwing extractor (a real bug)
          // still stops instead of looping forever, with a log trail either way.
          if (evalError) {
            evalErrStreak++;
            logger.warn(`[BrowserScraper] ${srcName} extractor threw (non-SITE_CHANGED, ${evalErrStreak}/${SITE_CHANGED_ABORT_THRESHOLD}): ${evalError.message}`);
            if (evalErrStreak >= SITE_CHANGED_ABORT_THRESHOLD) {
              logger.warn(`[BrowserScraper] ${srcName} extractor threw ${evalErrStreak}x in a row (non-SITE_CHANGED) — stopping this source's pagination rather than retrying indefinitely.`);
              // Mirror siteChangedError's give-up path below: surface this to the
              // caller instead of silently ending pagination. Without a warning +
              // earlyExit, this source's result looked identical to a clean
              // "reached the end of results" (stopReason: 'completed', warning:
              // null) even though it stopped early because the extractor is
              // persistently broken — the user had no signal their job count for
              // this source is incomplete.
              if (!sourceSiteChangedWarning) {
                sourceSiteChangedWarning = {
                  code:       'extractor-error',
                  severity:   'block',
                  evidence:   `${srcName} extractor threw ${evalErrStreak} times in a row on page ${pageNum}: ${evalError.message.slice(0, 280)}`,
                  suggestion: `The ${srcName} extractor kept failing while reading this page, so results for this source stopped early and may be incomplete. Try running the search again — if it keeps happening, the extractor may need updating.`,
                };
              }
              earlyExit = true;
              break;
            }
            await new Promise(r => setTimeout(r, humanDelay(1000)));
            continue;
          }
          evalErrStreak = 0;

          if (siteChangedError) {
            siteChangedStreak++;
            logger.warn(`[BrowserScraper] ${srcName} SITE_CHANGED (${siteChangedStreak}/${SITE_CHANGED_ABORT_THRESHOLD}): ${siteChangedError.message}`);

            if (siteChangedStreak >= SITE_CHANGED_ABORT_THRESHOLD) {
              // If the main-frame nav itself 4xx/5xx'd, the extractor ran against
              // a block/error page — selectors aren't stale, the page never loaded.
              // Steer the user toward re-login/IP cool-off instead of the extractor.
              const navStatus = navStatusRef.last;
              if (navStatus != null && navStatus >= 400) {
                siteChangedWarning = {
                  code:       'anti-bot-block',
                  severity:   'block',
                  evidence:   `${srcName} returned HTTP ${navStatus} on the main-frame navigation to ${task.url} — the body our extractor ran against was an anti-bot/error page, not job listings.`,
                  suggestion: `${srcName} is showing a captcha or bot-detection wall. Re-run the search — if a captcha appears in the browser window, solve it to continue. If the block repeats without a solvable captcha, your IP/session may be flagged — try again in a few hours or change network.`,
                };
              } else {
                siteChangedWarning = {
                  code:       'stale-selectors',
                  severity:   'block',
                  evidence:   siteChangedError.message.slice(0, 280),
                  suggestion: `The ${srcName} extractor failed ${SITE_CHANGED_ABORT_THRESHOLD} times in a row — the site structure likely changed. Update the extractor in electron/extractors/jobs.js, rebuild, and try again.`,
                };
              }
              await updateOverlay(page, {
                ...overlayBase,
                count:  allJobs.length,
                status: siteChangedWarning.code === 'anti-bot-block'
                  ? `Anti-bot block (HTTP ${navStatusRef.last}) — re-login to ${srcName} and retry.`
                  : 'Extractor broken — site structure changed. Fix selector code and restart.',
                error:  true,
              }).catch(() => {});
              await new Promise(r => setTimeout(r, humanDelay(3000)));
              earlyExit = true;
              break;
            }
            // Below threshold — might be mid-load; don't paginate, retry next iteration
            await new Promise(r => setTimeout(r, humanDelay(1000)));
            continue;
          }

          siteChangedStreak = 0;

          // No jobs on this page despite a clean extraction → end of results
          if (extracted.length === 0) break;

          // Deduplicate and accumulate page results
          const newJobs = [];
          for (const job of extracted) {
            const key = `${job.title}|${job.company}|${job.url || ''}`;
            if (!seen.has(key)) { seen.add(key); newJobs.push(job); }
          }

          // Expand descriptions for up to JOB_PER_PAGE_CAP jobs; drop any beyond
          // the cap rather than keeping them without descriptions (a job with no
          // description is less useful than not having the job at all).
          const remainingSourceSlots = Number.isFinite(JOB_PER_SOURCE_CAP)
            ? Math.max(0, JOB_PER_SOURCE_CAP - allJobs.length)
            : Infinity;
          const jobsToExpand = newJobs.slice(0, Math.min(JOB_PER_PAGE_CAP, remainingSourceSlots));
          const { jobs: enhanced, descError } = await expandDescriptions(page, jobsToExpand, sourceId, overlayBase, allJobs.length + newJobs.length, signal);

          const withSnippet = enhanced.filter(j => j.snippet?.length > 0).length;
          const descCfg = DESC_CONFIGS[sourceId];
          if (descCfg?.panelSelector || descCfg?.expandViaNavigation) {
            const strategy = [
              descCfg?.jsonLdType    && `jsonLd(${descCfg.jsonLdType})`,
              descCfg?.nextDataField && `nd(${descCfg.nextDataField.split('.').slice(-1)[0]})`,
              'sel',
            ].filter(Boolean).join('+');
            logger.info(`[BrowserScraper] ${srcName} q${qi + 1} descriptions: ${withSnippet}/${jobsToExpand.length} expanded (${strategy}: ${descCfg?.panelSelector?.slice(0, 40) ?? 'none'})`);
          }

          allJobs.push(...enhanced);

          // Per-page recovery flush (crash/quit checkpoint) — staged before the
          // next page turn so a crash keeps everything gathered so far. Best-effort:
          // never let staging I/O interfere with the scrape.
          if (onPageJobs && enhanced.length > 0) {
            try { await onPageJobs({ sourceId, query: task.query || '', page: pageNum, jobs: enhanced }); }
            catch (e) { logger.warn(`[BrowserScraper] onPageJobs failed (non-fatal): ${e?.message || e}`); }
          }

          if (descError) {
            if (!sourceSiteChangedWarning) sourceSiteChangedWarning = descError;
            earlyExit = true;
            break;
          }

          await updateOverlay(page, {
            ...overlayBase,
            count:  allJobs.length,
            status: 'Looking for next page…',
          });

          logger.info(`[BrowserScraper] ${srcName} page ${pageNum}: ${enhanced.length} new jobs (${allJobs.length} total)`);

          if (allJobs.length >= JOB_PER_SOURCE_CAP) {
            logger.info(`[BrowserScraper] ${srcName} hit JOB_PER_SOURCE_CAP (${JOB_PER_SOURCE_CAP}) — stopping source`);
            break;
          }

          const didPage = await clickNextPage(page, sourceId);
          if (!didPage) break;

          pageNum++;
          await new Promise(r => setTimeout(r, humanDelay(NAV_SETTLE_MS)));
          await injectOverlay(page);
          await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: `Loading page ${pageNum}…` });

          // Wait for new content to appear on the paginated page
          const pagedReady = await waitForReady(page, sourceId, overlayBase, signal, task.url);
          if (pagedReady === 'abort' || signal?.aborted) { earlyExit = true; break; }
          if (pagedReady === 'hard-block' || pagedReady === 'skip') {
            if (!sourceSiteChangedWarning) {
              sourceSiteChangedWarning = pagedReady === 'hard-block'
                ? {
                    code:       'cloudflare-hard-block',
                    severity:   'block',
                    evidence:   `${srcName} was hard-blocked by Cloudflare on page ${pageNum} — no interactive challenge to solve.`,
                    suggestion: `Open ${srcName} in a normal Chrome tab and ensure you are fully logged in, then retry.`,
                  }
                : {
                    code:       'challenge-timeout',
                    severity:   'block',
                    evidence:   `${srcName} stayed behind a bot challenge or login wall after moving to page ${pageNum}, so the source was skipped.`,
                    suggestion: 'Complete the visible login/challenge window, then run the search again.',
                  };
            }
            sourceSkipped = true;
            break;
          }
          if (pagedReady === 'recovered') {
            // Challenge fired on page 2+; recovery navigated back to page 1.
            // Re-extract page 1 (all deduped, 0 net new) then click Next naturally —
            // CF clearance is now set and a DOM-click navigation may avoid the 403
            // that a direct URL jump to start=N triggered. Give up after 1 retry.
            paginationRecoveries++;
            if (paginationRecoveries >= 2) break;
            pageNum = 1;
          }
        }

        if (siteChangedWarning && !sourceSiteChangedWarning) {
          sourceSiteChangedWarning = siteChangedWarning;
        }
        sourcePagesWalked = Math.max(sourcePagesWalked, pageNum);
        if (allJobs.length >= JOB_PER_SOURCE_CAP) break;
      }

      const result = {
        id:          `${sourceId}-0`,
        sourceId,
        success:     true,
        data:        allJobs,
        pagesWalked: sourcePagesWalked,
        stopReason:  earlyExit ? 'user-done' : 'completed',
        warning:     sourceSiteChangedWarning || null,
      };
      results.push(result);
      onResult?.(result);

      logger.info(`[BrowserScraper] ${srcName} done: ${allJobs.length} jobs`);

      // Close this platform's browser completely before the next launches, so each
      // platform starts from a fresh process with no carried-over session signal.
      await teardownCurrent();
    }
  } finally {
    await teardownCurrent();
    clearManualScraperTelemetry(signal?.aborted ? 'aborted' : 'finished');
  }

  // Emit empty results for sources we never reached
  for (const [sourceId] of bySource) {
    if (!results.some(r => r.sourceId === sourceId)) {
      const result = {
        id: `${sourceId}-0`, sourceId, success: true,
        data: [], pagesWalked: 0, stopReason: 'skipped', warning: null,
      };
      results.push(result);
      onResult?.(result);
    }
  }

  return results;
}
