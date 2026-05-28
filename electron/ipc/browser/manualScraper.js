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
import { JOB_PER_PAGE_CAP } from '../resultCaps.js';
import { buildOverlayScript, updateOverlay } from './scraperOverlay.js';
import { humanDelay } from '../../utils/humanDelay.js';

// ── Timing ────────────────────────────────────────────────────────────────────
const NAV_SETTLE_MS          = 2000;          // settle after navigation before first action
const CONTENT_POLL_MS        = 600;           // poll interval while waiting for content/challenge
const CONTENT_TIMEOUT_MS     = 20_000;        // max wait for content before proceeding anyway
const CHALLENGE_TIMEOUT_MS   = 5 * 60_000;   // 5 min for user to solve challenge
const CHALLENGE_STABLE_MS    = 1_500;         // page must be challenge-free for this long before resuming — guards against re-serves
const DESC_CHANGE_POLL_MS    = 200;           // poll interval waiting for description panel update
const DESC_CHANGE_TIMEOUT_MS = 3_000;         // max wait for description to change after a card click
const DESC_CLICK_DELAY_MS    = 600;           // pause between card clicks (natural pacing)
const SITE_CHANGED_ABORT_THRESHOLD = 3;
const DESC_STALE_THRESHOLD   = 3;             // consecutive click/panel failures before flagging stale selectors
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
  wellfound:    'Wellfound',
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

// Selector confirming real page content is present (vs bot-challenge page).
// null = no reliable selector; skip content check, rely solely on challenge detection.
const CONTENT_SELECTORS = {
  // Jobs widget selectors first; plain SERP selectors (#rcnt, #search, .srp) are fallbacks
  // so a loaded page with no jobs panel is treated as "ready" immediately instead of
  // burning the full CONTENT_TIMEOUT_MS (20s) before proceeding with 0 results.
  google:       '.EimVGf, [jscontroller="b11o3b"], #rcnt, #search, .srp',
  ziprecruiter: null,   // JSON-LD tag exists on challenge pages too; extractor validates
  glassdoor:    '[data-test="jobListing"], .JobCard_jobCardWrapper',
  wellfound:    '[data-testid="job-listing-list"]',
};

// Selector for the "Next page" control (null = no auto-pagination for this source).
// These need validation in-browser — flag any that don't work.
const NEXT_PAGE_SELECTORS = {
  google:       null,
  ziprecruiter: null,
  glassdoor:    'button[data-test="pagination-next"]',
  wellfound:    null,
};

// Sources that load more jobs by scrolling to the bottom (infinite scroll).
// Google for Jobs (ibp=htl;jobs mode) lazy-loads more cards as you scroll — initial
// render is ~10 cards; scrolling reveals the rest before we run the extractor.
const SCROLL_SOURCES = new Set(['ziprecruiter', 'google']);

// Sources that load more jobs via a "load more" button.
// ⚠️ Wellfound selector — verify in browser if this stops working.
const LOAD_MORE_SELECTORS = {
  wellfound: '[data-test="load-more-jobs"], [data-testid="load-more-jobs"], [data-testid="load-more"]',
};

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
    panelSelector: '.jobDescriptionSection, [data-testid="jobDescriptionSection"], #job-description-container, [class*="jobDescription"]',
    panelMulti:    false,
    closeSelector: null,
    expandViaNavigation: true,
    navUrlField:         'url',  // job.url is already the individual job page
  },
  glassdoor: {
    keyParam:      'jl',
    keyRegex:      null,
    keyDecode:     false,
    cardAttr:      'data-jobid',  // <li data-jobid="...">; jl param in URL matches this ID
    cardIdPrefix:  null,
    cardHrefKey:   null,
    clickSelector: null,          // click the <li> itself — React handler loads right panel
    panelSelector: '[data-brandviews*="joblisting-description"]',
    panelMulti:    false,
    closeSelector: null,
  },
  wellfound: {
    keyParam:      null,
    keyRegex:      '/jobs/(\\d+)-',  // job ID from path: /jobs/4238742-slug
    keyDecode:     false,
    cardAttr:      null,
    cardIdPrefix:  null,
    cardHrefKey:   '/jobs/',          // find: a[href*="/jobs/{key}-"]
    clickSelector: null,              // click the <a> job link directly (React intercepts → modal)
    panelSelector: '#job-description',
    panelMulti:    false,
    closeSelector: '[data-test="closeButton"]',
  },
};

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
    const hasIndeedCloudflareMarker = typeof window.INDEED_CLOUDFLARE_STATIC_PAGE !== 'undefined';

    let reason = 'none';
    if (hasChallengeShell || hasPerimeterXBlock) reason = 'challenge-shell';
    else if (title.startsWith('just a moment')) reason = 'just-a-moment-title';
    else if (hasVerificationText) reason = 'verification-text';
    else if (visibleRecaptchaFrames > 0 && !hasNormalContent) reason = 'visible-recaptcha-without-content';
    else if (visibleHCaptchaFrames > 0 && !hasNormalContent) reason = 'visible-hcaptcha-without-content';
    else if (hasCloudflareChallengeFrame) reason = 'cloudflare-challenge-frame';
    else if (hasIndeedCloudflareMarker && !hasNormalContent) reason = 'indeed-cloudflare-static-without-content';

    // Hard block: verification text is present but there is NO interactive widget
    // (no Cloudflare turnstile frame, no reCAPTCHA, no hCaptcha). This is the
    // "Additional Verification Required" page — a Ray-ID block page with only a
    // "Return home" button and nothing the user can actually solve. Waiting the
    // full CHALLENGE_TIMEOUT_MS for a user interaction that can never happen is
    // wasted time; callers should skip immediately when this is true.
    const isHardBlock = reason === 'verification-text' &&
                        !hasCloudflareChallengeFrame &&
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
      hasIndeedCloudflareMarker,
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
    hasIndeedCloudflareMarker: false,
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
    signals.hasIndeedCloudflareMarker ? 'indeedCfMarker=yes' : null,
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
const OVERLAY_SCRIPT = buildOverlayScript({ withPause: true });

async function injectOverlay(page) {
  await page.evaluate(OVERLAY_SCRIPT).catch(() => {});
}

// Blocks until the user clicks Resume or the signal is aborted.
// Reads manualScraperTelemetry.paused (Node.js side) so state survives page navigations.
// Returns 'ok' | 'abort'.
async function waitIfPaused(_page, signal) {
  while (true) {
    if (signal?.aborted) return 'abort';
    if (!manualScraperTelemetry.paused) return 'ok';
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── waitForReady ──────────────────────────────────────────────────────────────
// Waits for real page content to appear, handling challenge pages.
// Returns 'ok' | 'skip' (challenge timed out) | 'abort' (signal aborted).
async function waitForReady(page, sourceId, overlayBase, signal, resumeUrl = null) {
  const contentSel    = CONTENT_SELECTORS[sourceId];
  const contentDL     = Date.now() + CONTENT_TIMEOUT_MS;
  let inChallenge              = false;
  let challengeDL              = 0;
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

    if (isChallenge && !hasContent) {
      cleanSince = null; // challenge present or re-served — reset stable timer
      if (justRecovered) {
        // Challenge appeared immediately after navigating back to the resume URL —
        // that URL is itself blocked. Skip now; no checkbox-solve will unblock it.
        logger.warn(`[BrowserScraper] ${overlayBase.srcName}: resume URL immediately challenged after recovery — session fully blocked, skipping source`);
        return 'skip';
      }
      // Hard block: no interactive widget present, nothing for the user to solve.
      // "Additional Verification Required" shows only a Ray ID + "Return home" —
      // waiting the full CHALLENGE_TIMEOUT_MS accomplishes nothing. Skip now and
      // surface a clear, actionable error instead of a 5-min spinner.
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
        await new Promise(r => setTimeout(r, 2000));
        return 'hard-block';
      }
      if (!inChallenge) {
        inChallenge = true;
        challengeDL = Date.now() + CHALLENGE_TIMEOUT_MS;
        await updateOverlay(page, {
          ...overlayBase,
          status:    '⚠️ Complete the challenge above to continue',
          challenge: true,
        });
        logger.info(`[BrowserScraper] ${overlayBase.srcName}: bot challenge detected — waiting for user`);
        recordManualScraperTelemetry({
          phase:    'challenge-detected',
          srcName:  overlayBase.srcName,
          reason:   signals?.reason,
          title:    signals?.title,
          bodyHead: signals?.bodyHead,
          url:      signals?.url,
          cfFrame:  signals?.hasCloudflareChallengeFrame,
          recaptcha: signals?.visibleRecaptchaFrames,
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
      if (Date.now() > challengeDL) {
        logger.warn(`[BrowserScraper] ${overlayBase.srcName}: challenge not solved within ${CHALLENGE_TIMEOUT_MS / 60000} min — skipping source`);
        return 'skip';
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
// Returns { jobs: Array, siteChangedError: Error|null }.
async function runExtractor(page, extractorJS) {
  try {
    const raw = await page.evaluate(extractorJS);
    return { jobs: Array.isArray(raw) ? raw : [], siteChangedError: null };
  } catch (err) {
    if (/SITE_CHANGED/i.test(err?.message)) return { jobs: [], siteChangedError: err };
    return { jobs: [], siteChangedError: null }; // context destroyed / transient — retry next tick
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

      const navPause = await waitIfPaused(page, signal);
      if (navPause === 'abort') break;

      await updateOverlay(page, {
        ...overlayBase,
        count:  baseCount + i + 1,
        status: `Fetching descriptions… ${i + 1}/${enhanced.length}`,
      });

      try {
        await page.evaluate(u => { window.location.href = u; }, viewUrl).catch(() => {});
        await new Promise(r => setTimeout(r, humanDelay(2000)));

        const isChallenge = await detectChallengePage(page);
        // Detect expired listings separately from challenge redirects.
        const pageInfo = await page.evaluate(() => {
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
          await updateOverlay(page, {
            ...overlayBase,
            count:     baseCount + i + 1,
            status:    '⚠️ Complete the verification to continue',
            challenge: true,
          });
          logger.info(`[BrowserScraper] ${overlayBase.srcName}: human verification detected during description expansion`);
          // Poll until the challenge clears or the timeout expires.
          const challengeDeadline = Date.now() + CHALLENGE_TIMEOUT_MS;
          let solved = false;
          while (Date.now() < challengeDeadline) {
            await new Promise(r => setTimeout(r, 1500));
            if (await recoverFromChallengeHomeLanding(page, overlayBase, signal, viewUrl, baseCount + i + 1)) {
              continue;
            }
            const stillChallenge = await detectChallengePage(page);
            if (!stillChallenge) { solved = true; break; }
          }
          if (!solved) break; // skip/timeout — stop expanding and return what we have
          await updateOverlay(page, {
            ...overlayBase,
            count:  baseCount + i + 1,
            status: `Fetching descriptions… ${i + 1}/${enhanced.length}`,
          });
          i--; // retry this job now that the challenge is solved
          continue;
        }

        if (pageInfo.isNotFound) { enhanced[i] = null; continue; } // expired listing — drop it

        const text = await page.evaluate(sel => {
          return document.querySelector(sel)?.innerText?.trim() || '';
        }, cfg.panelSelector).catch(() => '');
        if (text) enhanced[i] = { ...job, snippet: text };
      } catch {
        // Per-listing navigation errors are non-fatal; keep the batch moving.
      }
    }
    // Navigate back to the list URL so the caller can continue pagination.
    try {
      await page.evaluate(u => { window.location.href = u; }, listUrl).catch(() => {});
      await new Promise(r => setTimeout(r, humanDelay(2000)));
      await injectOverlay(page);
    } catch {
      // Best-effort return to the list; the caller can still continue or stop cleanly.
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
    await new Promise(r => setTimeout(r, 3000));
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

      let gotDescription = false;
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
        if (text && text !== prevPanelText) {
          enhanced[i] = { ...job, snippet: text };
          prevPanelText = text;
          gotDescription = true;
          break;
        }
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

// ── Pre-loader for scroll / load-more sources ─────────────────────────────────
// Scrolls or clicks "load more" until JOB_PER_PAGE_CAP jobs are visible on the
// page — used for sources without traditional pagination. Must be called BEFORE
// runExtractor so extraction sees the full loaded set in one pass.
// Breaks as soon as a reveal action stops increasing the extractor-visible job
// count; otherwise keeps going until the per-query target is reached.
async function preloadContent(page, sourceId, extractorJS, overlayBase, signal) {
  const isScroll    = SCROLL_SOURCES.has(sourceId);
  const loadMoreSel = LOAD_MORE_SELECTORS[sourceId];
  if (!isScroll && !loadMoreSel) return;

  let prevCount = -1;
  while (true) {
    if (signal?.aborted) break;
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
                while (el.scrollTop + el.clientHeight < el.scrollHeight - 10) {
                  el.scrollTop += step;
                  await new Promise(r => setTimeout(r, 55 + Math.random() * 90));
                }
                break;
              }
              el = el.parentElement;
            }
          }
          const step = Math.floor(window.innerHeight * (0.55 + Math.random() * 0.3));
          while (window.scrollY + window.innerHeight < document.body.scrollHeight - 10) {
            window.scrollBy(0, step);
            await new Promise(r => setTimeout(r, 55 + Math.random() * 90));
          }
        });
      } else {
        await page.evaluate(async () => {
          const step = Math.floor(window.innerHeight * (0.55 + Math.random() * 0.3));
          while (window.scrollY + window.innerHeight < document.body.scrollHeight - 10) {
            window.scrollBy(0, step);
            await new Promise(r => setTimeout(r, 55 + Math.random() * 90));
          }
        });
      }
    } else {
      const clicked = await page.evaluate(async sel => {
        const btn = document.querySelector(sel);
        if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
        const rect = btn.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
          const dest = window.scrollY + rect.top - window.innerHeight * 0.35;
          const start = window.scrollY;
          const delta = dest - start;
          const steps = 3 + Math.floor(Math.random() * 3);
          for (let s = 1; s <= steps; s++) {
            window.scrollTo(0, start + delta * s / steps);
            await new Promise(r => setTimeout(r, 30 + Math.random() * 40));
          }
        }
        btn.click();
        return true;
      }, loadMoreSel);
      if (!clicked) break;
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
export async function scrapeManualSources(tasks, onResult, signal) {
  // Clear per-run browser diagnostic buffers so the bug report only shows
  // what happened in THIS run, not leftovers from a previous one.
  manualScraperTelemetry.consoleLogs = [];
  manualScraperTelemetry.networkErrors = [];

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

  // ── Browser launch ────────────────────────────────────────────────────────
  let browser;
  const userDataDir    = await getUserDataDir();
  const executablePath = process.env.CHROME_PATH || await findChromePath();
  const sandboxArgs    = process.platform === 'darwin'
    ? []
    : ['--no-sandbox', '--disable-setuid-sandbox'];

  browser = await puppeteer.launch({
    headless: false,
    executablePath,
    userDataDir,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      ...sandboxArgs,
      '--disable-infobars',
      '--window-size=1280,900',
      '--lang=en-US,en',
    ],
    defaultViewport: null,
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();

  // Expose pause state bridge — must be before evaluateOnNewDocument so
  // the overlay script can call __icGetPaused on init. Puppeteer re-registers
  // these CDP bindings on every new document, so they survive navigations.
  manualScraperTelemetry.paused = false;
  await page.exposeFunction('__icSetPaused', v => { manualScraperTelemetry.paused = !!v; });
  await page.exposeFunction('__icGetPaused', () => manualScraperTelemetry.paused);

  // Capture browser-side console errors/warnings for the bug report.
  // Fires for all frames (main page + iframes), so challenge-page and Turnstile
  // frame errors are included. Only error/warning to keep the ring buffer from
  // filling with routine log/info noise.
  page.on('console', msg => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const loc = msg.location();
    const entry = {
      ts: Date.now(),
      type,
      text: msg.text().slice(0, 300),
      url: (loc?.url || '').slice(0, 120),
      line: loc?.lineNumber ?? null,
    };
    manualScraperTelemetry.consoleLogs.push(entry);
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

  // Capture HTTP 4xx/5xx responses. Skip analytics/tracking that fail routinely
  // and add no debug value (t.indeed.com/signals, GTM, Sift, Intercom, etc.).
  page.on('response', res => {
    const status = res.status();
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

  let earlyExit    = false;
  let browserClosed = false;
  browser.on('disconnected', () => { browserClosed = true; earlyExit = true; });

  // Re-inject overlay after any page navigation that kills it (Cloudflare blocks,
  // redirects, etc.). OVERLAY_SCRIPT is a no-op when the panel is already present.
  // Skip challenge pages — injecting there causes DOM errors that interfere with
  // the Cloudflare widget (INDEED_CLOUDFLARE_STATIC_PAGE is set by the challenge page).
  const overlayKeepAlive = setInterval(() => {
    if (browserClosed) return;
    page.evaluate(() => {
      if (typeof window.INDEED_CLOUDFLARE_STATIC_PAGE !== 'undefined') return true;
      return !!document.getElementById('__ic-panel');
    }).then(exists => { if (!exists) page.evaluate(OVERLAY_SCRIPT).catch(() => {}); })
      .catch(() => {});
  }, 1500);

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

      logger.info(`[BrowserScraper] Starting ${si + 1}/${sourceList.length}: ${srcName} (${sourceTasks.length} queries)`);
      recordManualScraperTelemetry({
        phase: 'source-start',
        sourceId,
        srcName,
        sourceIndex: si + 1,
        sourceTotal: sourceList.length,
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
          logger.warn(`[BrowserScraper] ${srcName}: challenge timed out — skipping to next source`);
          if (!sourceSiteChangedWarning) {
            sourceSiteChangedWarning = {
              code:       'challenge-timeout',
              severity:   'block',
              evidence:   `${srcName} stayed behind a bot challenge or login wall for ${Math.round(CHALLENGE_TIMEOUT_MS / 60000)} min, so the source was skipped.`,
              suggestion: 'Complete the visible login/challenge window, then run the search again.',
            };
          }
          sourceSkipped = true;
          break;
        }

        await injectOverlay(page); // re-inject after challenge resolution may have navigated
        await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Extracting jobs…' });

        // For scroll / load-more sources, pre-load content up to the per-query
        // target before running the extractor. Paginated sources skip this.
        if (SCROLL_SOURCES.has(sourceId) || LOAD_MORE_SELECTORS[sourceId]) {
          await preloadContent(page, sourceId, task.extractorJS, overlayBase, signal);
          if (signal?.aborted) { earlyExit = true; break; }
          await injectOverlay(page);
          await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Extracting jobs…' });
        }

        // ── Per-query extraction + pagination loop ──────────────────────────
        let pageNum              = 1;
        let siteChangedStreak    = 0;
        let siteChangedWarning   = null;
        let paginationRecoveries = 0; // times recoverFromChallengeHomeLanding fired on a paginated page

        while (!earlyExit && !sourceSkipped && !signal?.aborted) {
          const pauseResult = await waitIfPaused(page, signal);
          if (pauseResult === 'abort' || signal?.aborted) { earlyExit = true; break; }

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

          const { jobs: extracted, siteChangedError } = await runExtractor(page, task.extractorJS);

          if (siteChangedError) {
            siteChangedStreak++;
            logger.warn(`[BrowserScraper] ${srcName} SITE_CHANGED (${siteChangedStreak}/${SITE_CHANGED_ABORT_THRESHOLD}): ${siteChangedError.message}`);

            if (siteChangedStreak >= SITE_CHANGED_ABORT_THRESHOLD) {
              siteChangedWarning = {
                code:       'stale-selectors',
                severity:   'block',
                evidence:   siteChangedError.message.slice(0, 280),
                suggestion: `The ${srcName} extractor failed ${SITE_CHANGED_ABORT_THRESHOLD} times in a row — the site structure likely changed. Update the extractor in electron/extractors/jobs.js, rebuild, and try again.`,
              };
              await updateOverlay(page, {
                ...overlayBase,
                count:  allJobs.length,
                status: 'Extractor broken — site structure changed. Fix selector code and restart.',
                error:  true,
              }).catch(() => {});
              await new Promise(r => setTimeout(r, 3000));
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
          const jobsToExpand = newJobs.slice(0, JOB_PER_PAGE_CAP);
          const { jobs: enhanced, descError } = await expandDescriptions(page, jobsToExpand, sourceId, overlayBase, allJobs.length + newJobs.length, signal);
          allJobs.push(...enhanced);

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
    }
  } finally {
    clearInterval(overlayKeepAlive);
    if (!browserClosed) {
      await browser.close().catch(() => {});
    }
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
