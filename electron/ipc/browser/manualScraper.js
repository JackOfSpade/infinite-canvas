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
 * For all 5 sources, the scraper auto-clicks each job card to expand the full
 * description from the side panel (or modal, for Wellfound).
 *
 * Return shape mirrors scrapeMultiple:
 *   Array<{ id, sourceId, success, data, pagesWalked, stopReason, warning }>
 */

import puppeteer from 'puppeteer-extra';
import { closeStealthBrowser, getUserDataDir, findChromePath } from '../stealthBrowser.js';
import { logger } from '../../logger.js';
import { TEST_MODE } from '../resultCaps.js';

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
const JOB_QUERY_TARGET        = TEST_MODE ? 5 : 150; // per-query depth target for scroll / load-more sources

// Returns ms scaled by a random factor in [0.75, 1.40] — human timing is never metronome-regular.
const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.65));

const DEAD_LISTING_PHRASES = [
  'job no longer available',
  'this job has expired',
  'page not found',
  "we can't find this page",
  'no longer accepting applications',
];

const hasDeadListingText = (text = '') => {
  const lower = text.toLowerCase();
  return DEAD_LISTING_PHRASES.some(phrase => lower.includes(phrase));
};

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
  google:       'Google Jobs',
  indeed:       'Indeed',
  ziprecruiter: 'ZipRecruiter',
  glassdoor:    'Glassdoor',
  wellfound:    'Wellfound',
};

const manualScraperTelemetry = {
  active: null,
  events: [],
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
  };
}

// Selector confirming real page content is present (vs bot-challenge page).
// null = no reliable selector; skip content check, rely solely on challenge detection.
const CONTENT_SELECTORS = {
  // Jobs widget selectors first; plain SERP selectors (#rcnt, #search, .srp) are fallbacks
  // so a loaded page with no jobs panel is treated as "ready" immediately instead of
  // burning the full CONTENT_TIMEOUT_MS (20s) before proceeding with 0 results.
  google:       '.EimVGf, [jscontroller="b11o3b"], #rcnt, #search, .srp',
  indeed:       '.job_seen_beacon, .resultContent',
  ziprecruiter: null,   // JSON-LD tag exists on challenge pages too; extractor validates
  glassdoor:    '[data-test="jobListing"], .JobCard_jobCardWrapper',
  wellfound:    '[data-testid="job-listing-list"]',
};

// Selector for the "Next page" control (null = no auto-pagination for this source).
// These need validation in-browser — flag any that don't work.
const NEXT_PAGE_SELECTORS = {
  google:       null,
  indeed:       'a[data-testid="pagination-page-next"]',
  ziprecruiter: null,
  glassdoor:    'button[data-test="pagination-next"]',
  wellfound:    null,
};

// Sources that load more jobs by scrolling to the bottom (infinite scroll).
// Google Jobs (ibp=htl;jobs mode) lazy-loads more cards as you scroll — initial
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
  indeed: {
    keyParam:      'jk',
    keyField:      'jobkey',    // prefer job.jobkey (canonical DB key) — avoids pagead URL mismatch
    keyRegex:      null,
    keyDecode:     false,
    cardAttr:      'data-jk',
    cardIdPrefix:  null,
    cardHrefKey:   null,
    clickSelector: null,
    panelSelector: '#jobDescriptionText',
    panelMulti:    false,
    closeSelector: null,
    // walkCards: instead of bulk-extracting all keys from __NEXT_DATA__ upfront
    // (which only captures the initially-rendered ~10 cards), scroll the virtual
    // list incrementally and record each job as it's clicked — count climbs
    // one by one and all 15 cards per page are naturally surfaced.
    walkCards:     true,
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
    // there instead of card-clicking on the list page (same virtual-list issue as Indeed).
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

    return {
      isChallenge: reason !== 'none',
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
const OVERLAY_SCRIPT = `(function(){
  if(document.getElementById('__ic-panel')) return;
  window.__icPaused = false;
  const sty = document.createElement('style');
  sty.textContent = [
    '@keyframes ic-blink{0%,100%{opacity:1}50%{opacity:.35}}',
    '@keyframes ic-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
    '#__ic-panel button:hover:not(:disabled){filter:brightness(1.2)}',
    '#__ic-panel button:disabled{opacity:.4;cursor:default}',
  ].join('');
  (document.head||document.documentElement).appendChild(sty);

  const el = document.createElement('div');
  el.id = '__ic-panel';
  el.style.cssText = [
    'position:fixed;bottom:20px;right:20px;z-index:2147483647',
    'background:#0f172a;color:#e2e8f0;border-radius:14px',
    'padding:18px 20px;width:272px',
    'font:13px/1.5 system-ui,-apple-system,sans-serif',
    'box-shadow:0 16px 48px rgba(0,0,0,.8);border:1px solid rgba(255,255,255,.1)',
    'pointer-events:auto',
  ].join(';');

  el.innerHTML = [
    '<div style="display:flex;align-items:center;gap:7px;margin-bottom:9px">',
      '<div id="ic-dot" style="width:9px;height:9px;border-radius:50%;background:#4ade80;',
        'animation:ic-blink 1.4s ease-in-out infinite;flex-shrink:0"></div>',
      '<b style="font-size:13px;letter-spacing:-.2px">Job Collector</b>',
    '</div>',
    '<div id="ic-src-label" style="font-size:11px;color:#475569;margin-bottom:1px"></div>',
    '<div id="ic-src-name" style="font-weight:700;font-size:16px;margin-bottom:3px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>',
    '<div id="ic-q-label" style="font-size:11px;color:#64748b;margin-bottom:2px"></div>',
    '<div id="ic-q-text" style="font-size:12px;color:#94a3b8;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;margin-bottom:11px"></div>',
    '<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px">',
      '<span id="ic-count" style="font-size:32px;font-weight:800;line-height:1;color:#f8fafc">0</span>',
      '<span style="font-size:12px;color:#64748b">jobs collected</span>',
    '</div>',
    '<div id="ic-status" style="font-size:11px;color:#64748b;margin-bottom:14px;min-height:16px;',
      'line-height:1.55"></div>',
    '<button id="ic-pause" style="width:100%;padding:7px 10px;background:rgba(255,255,255,.06);',
      'color:#64748b;border:1px solid rgba(255,255,255,.09);border-radius:7px;',
      'cursor:pointer;font:500 12px system-ui;transition:filter .15s">⏸ Pause</button>',
  ].join('');

  el.querySelector('#ic-pause').addEventListener('click', function(){
    if(this.disabled) return;
    window.__icPaused = !window.__icPaused;
    this.textContent = window.__icPaused ? '▶ Resume' : '⏸ Pause';
    const dot = document.getElementById('ic-dot');
    if(dot){
      if(window.__icPaused){
        dot.style.background = '#eab308';
        dot.style.animation  = 'none';
      } else {
        dot.style.background = '#4ade80';
        dot.style.animation  = 'ic-blink 1.4s ease-in-out infinite';
      }
    }
  });

  const attach = () => {
    if(document.body && !document.getElementById('__ic-panel')) document.body.appendChild(el);
  };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})()`;

async function injectOverlay(page) {
  await page.evaluate(OVERLAY_SCRIPT).catch(() => {});
}

async function updateOverlay(page, state) {
  await page.evaluate((s) => {
    const p = document.getElementById('__ic-panel');
    if (!p) return;
    const g   = id => p.querySelector('#' + id);
    const set = (id, v) => { const e = g(id); if (e && v != null) e.textContent = v; };

    set('ic-src-label', s.srcLabel);
    set('ic-src-name',  s.srcName);
    set('ic-q-label',   s.qLabel);
    set('ic-q-text',    s.qText);
    if (s.count != null) set('ic-count', s.count);
    set('ic-status',    s.status ?? '');

    const dot = g('ic-dot');
    if (dot) {
      if (s.error) {
        dot.style.background = '#ef4444';
        dot.style.animation  = 'none';
      } else if (s.challenge) {
        dot.style.background = '#f59e0b';
        dot.style.animation  = 'ic-pulse 1s ease-in-out infinite';
      } else {
        dot.style.background = '#4ade80';
        dot.style.animation  = 'ic-blink 1.4s ease-in-out infinite';
      }
    }

  }, state).catch(() => {});
}

// Blocks until the user clicks Resume or the signal is aborted.
// Returns 'ok' | 'abort'.
async function waitIfPaused(page, signal) {
  while (true) {
    if (signal?.aborted) return 'abort';
    const paused = await page.evaluate(() => !!window.__icPaused).catch(() => false);
    if (!paused) return 'ok';
    await new Promise(r => setTimeout(r, 500));
  }
}

// ── waitForReady ──────────────────────────────────────────────────────────────
// Waits for real page content to appear, handling challenge pages.
// Returns 'ok' | 'skip' (challenge timed out) | 'abort' (signal aborted).
async function waitForReady(page, sourceId, overlayBase, signal) {
  const contentSel    = CONTENT_SELECTORS[sourceId];
  const contentDL     = Date.now() + CONTENT_TIMEOUT_MS;
  let inChallenge              = false;
  let challengeDL              = 0;
  let cleanSince               = null; // tracks when page first went challenge-free
  let shownVerifiedOverlay     = false;

  while (true) {
    if (signal?.aborted) return 'abort';

    const signals     = await getChallengeSignals(page);
    const isChallenge = !!signals?.isChallenge;
    const hasContent  = !contentSel || await page.evaluate(
      s => !!document.querySelector(s), contentSel
    ).catch(() => false);

    if (isChallenge && !hasContent) {
      cleanSince = null; // challenge present or re-served — reset stable timer
      if (!inChallenge) {
        inChallenge = true;
        challengeDL = Date.now() + CHALLENGE_TIMEOUT_MS;
        await updateOverlay(page, {
          ...overlayBase,
          status:    '⚠️ Complete the challenge above to continue',
          challenge: true,
        });
        logger.info(`[BrowserScraper] ${overlayBase.srcName}: bot challenge detected — waiting for user`);
      }
      if (!shownVerifiedOverlay && signals?.verificationCompleted) {
        shownVerifiedOverlay = true;
        await updateOverlay(page, {
          ...overlayBase,
          status:    'Verification complete — waiting for Indeed to redirect…',
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
      // Page is currently clean — start or advance the stable-clean timer.
      // If Cloudflare re-serves the challenge, the isChallenge branch above
      // resets cleanSince, so the full CHALLENGE_STABLE_MS must elapse again.
      if (cleanSince === null) cleanSince = Date.now();
      if (Date.now() - cleanSince < CHALLENGE_STABLE_MS) {
        await new Promise(r => setTimeout(r, CONTENT_POLL_MS));
        continue;
      }
      await new Promise(r => setTimeout(r, jitter(1000)));
      await updateOverlay(page, { ...overlayBase, status: 'Extracting jobs…' });
      logger.info(`[BrowserScraper] ${overlayBase.srcName}: challenge resolved — resuming`);
      return 'ok';
    }

    if (hasContent || Date.now() > contentDL) return 'ok';

    await new Promise(r => setTimeout(r, CONTENT_POLL_MS));
  }
}

async function waitForMidCardChallenge(page, overlayBase, count, key, signal) {
  const initialSignals = await getChallengeSignals(page);
  if (!initialSignals?.isChallenge) return { status: 'none', evidence: null };
  const initialEvidence = formatChallengeEvidence(initialSignals, key);
  recordManualScraperTelemetry({
    phase: 'mid-card-challenge',
    srcName: overlayBase?.srcName || null,
    key,
    evidence: initialEvidence,
    url: initialSignals?.url || page.url(),
  });

  await updateOverlay(page, {
    ...overlayBase,
    count,
    status:    '⚠️ Complete the challenge above to retry this job',
    challenge: true,
  });
  logger.info(`[BrowserScraper] ${overlayBase.srcName}: bot challenge detected after card click (key="${key}") — waiting before retry. Evidence: ${initialEvidence}`);

  // Track when the page first went challenge-free. Only declare resolved
  // once it stays clean for CHALLENGE_STABLE_MS — if Cloudflare/Indeed
  // re-serves the challenge (any number of times), cleanSince resets and
  // the user must solve again before the timer restarts.
  let cleanSince = null;
  let shownVerifiedOverlay = false;
  const challengeDeadline = Date.now() + CHALLENGE_TIMEOUT_MS;
  while (Date.now() < challengeDeadline) {
    if (signal?.aborted || page.isClosed()) return { status: 'abort', evidence: initialEvidence };
    await new Promise(r => setTimeout(r, CONTENT_POLL_MS));
    const signals = await getChallengeSignals(page);
    if (signals?.isChallenge) {
      cleanSince = null; // re-served or still present — reset stable timer
      // Show "waiting for redirect" overlay once Cloudflare confirms the checkbox
      // was solved — the page still counts as a challenge until it redirects, so
      // the user would otherwise keep seeing "Complete the challenge" even though
      // they already did.
      if (!shownVerifiedOverlay && signals.verificationCompleted) {
        shownVerifiedOverlay = true;
        await updateOverlay(page, {
          ...overlayBase,
          count,
          status: 'Verification complete — waiting for Indeed to redirect…',
          challenge: true,
        });
        logger.info(`[BrowserScraper] ${overlayBase.srcName}: verification successful (key="${key}") — waiting for Cloudflare redirect`);
      }
    } else {
      if (cleanSince === null) cleanSince = Date.now();
      if (Date.now() - cleanSince >= CHALLENGE_STABLE_MS) {
        await new Promise(r => setTimeout(r, jitter(1000)));
        await injectOverlay(page);
        await updateOverlay(page, {
          ...overlayBase,
          count,
          status: 'Challenge resolved — retrying this job…',
        });
        logger.info(`[BrowserScraper] ${overlayBase.srcName}: challenge resolved after card click (key="${key}") — retrying same card. Initial evidence: ${initialEvidence}`);
        recordManualScraperTelemetry({
          phase: 'mid-card-challenge-resolved',
          srcName: overlayBase?.srcName || null,
          key,
          evidence: initialEvidence,
          url: page.url(),
        });
        return { status: 'resolved', evidence: initialEvidence };
      }
    }
  }

  const timeoutSignals = await getChallengeSignals(page);
  const timeoutEvidence = formatChallengeEvidence(timeoutSignals, key);
  logger.warn(`[BrowserScraper] ${overlayBase.srcName}: challenge after card click not solved within ${CHALLENGE_TIMEOUT_MS / 60000} min (key="${key}"). Evidence: ${timeoutEvidence}`);
  recordManualScraperTelemetry({
    phase: 'mid-card-challenge-timeout',
    srcName: overlayBase?.srcName || null,
    key,
    evidence: timeoutEvidence || initialEvidence,
    url: timeoutSignals?.url || page.url(),
  });
  return { status: 'timeout', evidence: timeoutEvidence || initialEvidence };
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
  // the description there. Used for Indeed and ZipRecruiter where the extractor
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
        await new Promise(r => setTimeout(r, jitter(2000)));

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
      await new Promise(r => setTimeout(r, jitter(2000)));
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
  // reset to the top of the list. Mirrors walkDomCards' reveal pass and Google's
  // preloadContent: we know the full count N before clicking begins, giving stable
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

      const found = await page.evaluate((cardAttr, cardIdPrefix, cardHrefKey, k) => {
        let card;
        if (cardAttr) {
          card = document.querySelector(`[${cardAttr}="${k}"]`) || document.querySelector(`a[href*="${k}"]`);
        } else if (cardHrefKey != null) {
          card = document.querySelector(`a[href*="${cardHrefKey}${k}-"]`);
        } else {
          card = document.getElementById((cardIdPrefix || '') + k);
        }
        if (!card) return false;
        card.scrollIntoView({ block: 'center', behavior: 'instant' });
        return true;
      }, cfg.cardAttr ?? null, cfg.cardIdPrefix ?? null, cfg.cardHrefKey ?? null, key).catch(() => false);

      if (found) revealedCount++;
      await updateOverlay(page, {
        ...overlayBase,
        count:  baseCount,
        status: `Revealing cards… ${ri + 1}/${enhanced.length}`,
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 50));
    }
    await page.evaluate(() => { window.scrollTo(0, 0); }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
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
      const clickTarget = await page.evaluate((cardAttr, cardIdPrefix, cardHrefKey, clickSel, k) => {
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
        target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
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
      await page.mouse.click(clickTarget.x, clickTarget.y, { delay: jitter(80) }).catch(() => {});

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
            await new Promise(r => setTimeout(r, jitter(400)));
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
        await new Promise(r => setTimeout(r, 400));
        prevPanelText = '';
      }
    } catch { /* page context destroyed or other transient error — not a stale-selector signal */ }

    if (page.isClosed()) break;
    await new Promise(r => setTimeout(r, jitter(DESC_CLICK_DELAY_MS)));
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

async function restoreSearchPageAfterDeadListing(page, sourceId, listUrl, overlayBase, count, signal) {
  if (signal?.aborted || page.isClosed()) return;
  await updateOverlay(page, {
    ...overlayBase,
    count,
    status: 'Returning to search results…',
  }).catch(() => {});
  try {
    await page.evaluate(u => { window.location.href = u; }, listUrl).catch(() => {});
    await new Promise(r => setTimeout(r, jitter(NAV_SETTLE_MS)));
    await injectOverlay(page);
    await waitForReady(page, sourceId, overlayBase, signal);
  } catch {
    // Best-effort restore; the next walker loop will re-check page state.
  }
}

async function resetWalkCardListToTop(page, cardAttr) {
  await page.evaluate((attr) => {
    const cards = document.querySelectorAll(`[${attr}]`);
    const first = cards[0];
    if (first) first.scrollIntoView({ block: 'start', behavior: 'instant' });
    window.scrollTo(0, 0);
  }, cardAttr).catch(() => {});
}

async function getWalkResultsState(page, cardAttr) {
  return page.evaluate((attr) => {
    const cards = Array.from(document.querySelectorAll(`[${attr}]`));
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      url: window.location.href,
      title: document.title || '',
      cardCount: cards.length,
      hasResultsShell: !!document.querySelector('.job_seen_beacon, .resultContent, [data-testid="job-card-container"]') || cards.length > 0,
      bodyHead: bodyText.slice(0, 220),
    };
  }, cardAttr).catch(() => ({
    url: page.url(),
    title: '',
    cardCount: 0,
    hasResultsShell: false,
    bodyHead: '',
  }));
}

async function ensureWalkCardVisible(page, cardAttr, key, options = {}) {
  const {
    signal = null,
    resetToTop = false,
    maxScrolls = 16,
  } = options;

  if (resetToTop) {
    await resetWalkCardListToTop(page, cardAttr);
    await new Promise(r => setTimeout(r, 150));
  }

  for (let attempt = 0; attempt < maxScrolls; attempt++) {
    if (signal?.aborted || page.isClosed()) return false;

    const cardFound = await page.evaluate((attr, k) => {
      const el = document.querySelector(`[${attr}="${k}"]`);
      if (!el) return false;
      const card = (el.tagName === 'A')
        ? (el.closest('.job_seen_beacon, [data-testid="job-card-container"], li, article') || el)
        : el;
      card.scrollIntoView({ block: 'center', behavior: 'instant' });
      return true;
    }, cardAttr, key).catch(() => false);
    if (cardFound) return true;

    await page.evaluate((attr) => {
      const cards = document.querySelectorAll(`[${attr}]`);
      const last = cards[cards.length - 1];
      if (last) last.scrollIntoView({ block: 'end', behavior: 'instant' });
      else window.scrollBy(0, 400);
    }, cardAttr).catch(() => {});

    const pollDeadline = Date.now() + 1000;
    while (Date.now() < pollDeadline) {
      if (signal?.aborted || page.isClosed()) return false;
      await new Promise(r => setTimeout(r, 100));
      const cardVisible = await page.evaluate((attr, k) =>
        !!document.querySelector(`[${attr}="${k}"]`),
      cardAttr, key).catch(() => false);
      if (cardVisible) break;
    }
  }

  return false;
}

async function revealWalkCardKeys(page, cardAttr, overlayBase, count, signal) {
  const revealedKeys = [];
  const revealedSet = new Set();
  let noNewCardScrolls = 0;
  const MAX_EMPTY_SCROLLS = 6; // 6 × 400 px = 2 400 px past last card

  while (true) {
    if (signal?.aborted || page.isClosed()) break;

    const cardKeys = await page.evaluate((attr) =>
      [...new Set(
        Array.from(document.querySelectorAll(`[${attr}]`))
          .map(el => el.getAttribute(attr))
          .filter(Boolean),
      )],
    cardAttr).catch(() => []);

    let added = 0;
    for (const key of cardKeys) {
      if (revealedSet.has(key)) continue;
      revealedSet.add(key);
      revealedKeys.push(key);
      added++;
    }

    await updateOverlay(page, {
      ...overlayBase,
      count,
      status: `Revealing jobs… ${revealedKeys.length}`,
    }).catch(() => {});

    if (added === 0) {
      if (noNewCardScrolls++ >= MAX_EMPTY_SCROLLS) break;
    } else {
      noNewCardScrolls = 0;
    }

    await page.evaluate((attr) => {
      const cards = document.querySelectorAll(`[${attr}]`);
      const last = cards[cards.length - 1];
      if (last) last.scrollIntoView({ block: 'end', behavior: 'instant' });
      else window.scrollBy(0, 400);
    }, cardAttr).catch(() => {});

    const pollDeadline = Date.now() + 1000;
    while (Date.now() < pollDeadline) {
      if (signal?.aborted || page.isClosed()) break;
      await new Promise(r => setTimeout(r, 100));
      const polledKeys = await page.evaluate(
        (attr) => [...new Set(
          Array.from(document.querySelectorAll(`[${attr}]`))
            .map(el => el.getAttribute(attr)).filter(Boolean),
        )],
        cardAttr,
      ).catch(() => []);
      if (polledKeys.some(k => !revealedSet.has(k))) break;
    }
  }

  return revealedKeys;
}

async function restoreSearchPageAndRefindCard(page, sourceId, listUrl, overlayBase, count, signal, cardAttr, key) {
  if (signal?.aborted || page.isClosed()) return false;

  await updateOverlay(page, {
    ...overlayBase,
    count,
    status: 'Returning to search results…',
  }).catch(() => {});

  try {
    await page.evaluate(u => { window.location.href = u; }, listUrl).catch(() => {});
    await new Promise(r => setTimeout(r, jitter(NAV_SETTLE_MS)));
    await injectOverlay(page);
    const ready = await waitForReady(page, sourceId, overlayBase, signal);
    if (ready !== 'ok') return false;

    await updateOverlay(page, {
      ...overlayBase,
      count,
      status: 'Finding the interrupted job…',
    }).catch(() => {});
    return await ensureWalkCardVisible(page, cardAttr, key, { signal, resetToTop: true, maxScrolls: 16 });
  } catch {
    // Best-effort restore; caller will surface the failure.
  }

  return false;
}

// ── Pre-loader for scroll / load-more sources ─────────────────────────────────
// Scrolls or clicks "load more" until JOB_QUERY_TARGET jobs are visible on the
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
    await updateOverlay(page, { ...overlayBase, status: `Loading jobs… ${count}/${JOB_QUERY_TARGET}` });
    if (count >= JOB_QUERY_TARGET) break;
    if (count === prevCount) break;  // no new content after last action
    prevCount = count;
    if (isScroll) {
      if (sourceId === 'google') {
        // Google Jobs renders cards in its own scrollable container inside the page.
        // Walk up from the first card to find that container and scroll it; also
        // scroll document.body so either trigger path gets hit.
        await page.evaluate(() => {
          const card = document.querySelector('.EimVGf, [jscontroller="b11o3b"]');
          if (card) {
            let el = card.parentElement;
            while (el && el !== document.body) {
              const s = getComputedStyle(el);
              if (s.overflowY === 'auto' || s.overflowY === 'scroll') {
                el.scrollTop = el.scrollHeight;
                break;
              }
              el = el.parentElement;
            }
          }
          window.scrollTo(0, document.body.scrollHeight);
        });
      } else {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      }
    } else {
      const clicked = await page.evaluate(sel => {
        const btn = document.querySelector(sel);
        if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
        btn.scrollIntoView({ block: 'nearest' });
        btn.click();
        return true;
      }, loadMoreSel);
      if (!clicked) break;
    }
    await new Promise(r => setTimeout(r, jitter(NAV_SETTLE_MS)));
  }
}

// ── DOM-walk card recorder ────────────────────────────────────────────────────
// For sources with React virtual lists (Indeed) — walks down the card list
// incrementally, clicking each new card as it appears in the DOM, reading the
// description panel, and pushing to allJobs immediately so the overlay count
// climbs one by one.
//
// Scrolls 400 px at a time (one React render tick budget); after MAX_EMPTY_SCROLLS
// consecutive scrolls with no new cards we've reached the bottom of the virtual
// list and return.
//
// Mutates `allJobs` and `seen` directly. Returns { jobsFound, descError }.
async function walkDomCards(page, sourceId, overlayBase, allJobs, seen, signal) {
  const cfg = DESC_CONFIGS[sourceId];
  if (!cfg?.walkCards) return { jobsFound: 0, descError: null };

  const listUrl                  = page.url();
  let   skippedDeadListings      = 0;
  let   prevPanelText            = '';
  let   consecutiveClickFails    = 0;
  let   consecutivePanelTimeouts = 0;
  let   consecutiveNullJobData   = 0;  // increments when card DOM extraction returns null
  let   descError                = null;
  let   consecutiveRevealMisses  = 0;
  let   cardsWalked              = 0;
  // Indeed puts sponsored/featured cards at the top of results; these have a
  // different DOM structure than organic cards and return null jobData. The
  // threshold must be large enough to absorb a full sponsored block before
  // organic results scroll into view. 5 was too tight — query pages with 5+
  // sponsored cards at the top aborted before any organic card was reached.
  const NULL_DATA_THRESHOLD      = 10; // 10 consecutive null-data cards = selectors broken

  const abortWithError = async (evidence, suggestion, options = {}) => {
    logger.warn(`[BrowserScraper] ${sourceId}: ${evidence}`);
    await updateOverlay(page, {
      ...overlayBase,
      count:  allJobs.length,
      status: options.status || 'Desc selector broken — fix selector code and restart.',
      error:  true,
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));
    descError = { code: options.code || 'stale-desc-selectors', severity: 'block', evidence, suggestion };
  };

  const revealedKeys = await revealWalkCardKeys(page, cfg.cardAttr, overlayBase, allJobs.length, signal);
  if (signal?.aborted || page.isClosed()) return { jobsFound: 0, descError };
  if (revealedKeys.length === 0) return { jobsFound: 0, descError };

  await resetWalkCardListToTop(page, cfg.cardAttr);
  await new Promise(r => setTimeout(r, 200));

  outer: for (let keyIndex = 0; keyIndex < revealedKeys.length; keyIndex++) {
      const key = revealedKeys[keyIndex];
      if (signal?.aborted || page.isClosed()) break outer;

      const pr2 = await waitIfPaused(page, signal);
      if (pr2 === 'abort' || signal?.aborted) break outer;

      let cardVisible = false;
      const pageState = await getWalkResultsState(page, cfg.cardAttr);
      if (!pageState.hasResultsShell) {
        logger.warn(
          `[BrowserScraper] walkDomCards(${sourceId}): page drifted away from search results before key="${key}" — restoring list. State: ${JSON.stringify(pageState)}`,
        );
        recordManualScraperTelemetry({
          phase: 'restore-search-results',
          sourceId,
          key,
          pageState,
          reason: 'missing-results-shell-before-card',
        });
        cardVisible = await restoreSearchPageAndRefindCard(
          page,
          sourceId,
          listUrl,
          overlayBase,
          allJobs.length,
          signal,
          cfg.cardAttr,
          key,
        );
      } else {
        cardVisible = await ensureWalkCardVisible(page, cfg.cardAttr, key, { signal, maxScrolls: 8 });
      }
      if (!cardVisible) {
        logger.warn(`[BrowserScraper] walkDomCards(${sourceId}): key="${key}" could not be re-shown after reveal pass — skipping`);
        recordManualScraperTelemetry({
          phase: 'reveal-key-missing',
          sourceId,
          key,
          missed: consecutiveRevealMisses + 1,
          revealed: revealedKeys.length,
          url: page.url(),
        });
        consecutiveRevealMisses++;
        if (consecutiveRevealMisses >= 3) {
          logger.warn(
            `[BrowserScraper] walkDomCards(${sourceId}): ${consecutiveRevealMisses} consecutive reveal-pass misses — abandoning remaining keys on this page to avoid a long virtual-list stall`,
          );
          break outer;
        }
        continue;
      }
      consecutiveRevealMisses = 0;
      cardsWalked++;
      await new Promise(r => setTimeout(r, jitter(100)));

      // Extract job metadata from the card DOM element.
      //
      // Indeed's current DOM puts data-jk on the <a> title link, NOT on the card
      // wrapper <li>. document.querySelector('[data-jk]') therefore returns the <a>,
      // and all child selectors (h2 a, .jobTitle a, etc.) search inside the link and
      // find nothing — HTML doesn't allow block elements inside <a>. The fix: when
      // the found element is an <a>, walk up to the enclosing li/article (the real
      // card wrapper) before running any child queries.
      //
      // If no ancestor card is found (rare fallback), the <a> element itself IS the
      // title — use it directly with tagName === 'A' guard below.
      //
      // innerText is empty for off-screen virtual-list cards; textContent is the fallback.
      // Returns the job metadata object on success, or a diagnostic sentinel
      // object { __diag, elTag, cardTag, cardClass, elText } when title extraction
      // fails — gives enough DOM context to diagnose WHY without having to guess.
      const jobData = await page.evaluate((attr, k) => {
        const el = document.querySelector(`[${attr}="${k}"]`);
        if (!el) return { __diag: 'el-not-found' };

        // Resolve the card container — walk up if data-jk landed on the <a> link.
        const card = (el.tagName === 'A')
          ? (el.closest('.job_seen_beacon, [data-testid="job-card-container"], li, article') || el)
          : el;

        // Title: if card is still the <a> (no ancestor found), it IS the title element.
        const titleEl = (card.tagName === 'A') ? card : card.querySelector(
          '[data-testid="jobTitle"] a, h2 > a[data-testid], a[data-testid="job-title"], ' +
          '.jobTitle a, h2 a, h3 a',
        );
        const title = (titleEl?.innerText?.trim() || titleEl?.textContent?.trim() || '');
        if (!title) return {
          __diag:    'title-empty',
          elTag:     el.tagName,
          cardTag:   card.tagName,
          cardClass: (card.className || '').slice(0, 80),
          elText:    (el.innerText || el.textContent || '').slice(0, 60),
        };

        const company  = (() => {
          const e = card.querySelector('[data-testid="company-name"], .companyName');
          return (e?.innerText?.trim() || e?.textContent?.trim() || '');
        })();
        const location = (() => {
          const e = card.querySelector('[data-testid="text-location"], .companyLocation');
          return (e?.innerText?.trim() || e?.textContent?.trim() || '');
        })();
        const salary = (() => {
          const e = card.querySelector(
            '[data-testid="attribute_snippet_testid"], .salary-snippet, [data-testid="desktopSalaryOnlySnippet"]',
          );
          return (e?.innerText?.trim() || e?.textContent?.trim() || '');
        })();
        const posted = (() => {
          const e = card.querySelector('[data-testid="myJobsStateDate"], .date');
          return (e?.innerText?.trim() || e?.textContent?.trim() || '');
        })();
        return { title, company, location, salary, posted,
                 jobkey: k, url: 'https://www.indeed.com/viewjob?jk=' + k, source: 'indeed' };
      }, cfg.cardAttr, key).catch(() => null);

      if (!jobData || jobData.__diag) {
        if (jobData?.__diag === 'el-not-found') {
          logger.warn(`[BrowserScraper] walkDomCards(${sourceId}): key="${key}" dropped out of DOM before metadata read — skipping`);
          continue;
        }
        // 'title-empty' or evaluate-threw → genuine selector failure, count toward threshold.
        const diagStr = !jobData
          ? '[evaluate-threw]'
          : `[el:${jobData.elTag} card:${jobData.cardTag} class:"${jobData.cardClass}" elText:"${jobData.elText}"]`;
        logger.warn(`[BrowserScraper] walkDomCards(${sourceId}): null jobData for key="${key}" ${diagStr} (${++consecutiveNullJobData}/${NULL_DATA_THRESHOLD})`);
        if (consecutiveNullJobData >= NULL_DATA_THRESHOLD) {
          await abortWithError(
            `${consecutiveNullJobData} consecutive null-jobData for ${sourceId} — title/card selector returned no text (key="${key}")`,
            `Check the title selector in walkDomCards (manualScraper.js). Indeed may have changed its card DOM structure — update the querySelector list inside the jobData page.evaluate call.`,
          );
          break outer;
        }
        continue;
      }
      consecutiveNullJobData = 0;

      // Deduplicate against already-collected jobs
      const dedupeKey = `${jobData.title}|${jobData.company}|${jobData.url}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // Click the card and poll for the description panel to change.
      // Use a real mouse click instead of DOM element.click(): Indeed can let
      // untrusted DOM clicks follow the raw anchor href, while a user-like click
      // is intercepted by the SPA and opens the side panel.
      //
      // snippet: undefined = click never registered (skip push); '' = no description; string = valid
      let snippet;
      let restoredAfterDeadListing = false;
      let driftedOffSearchPage = false;
      const recoverAfterChallenge = async () => {
        const recovered = await restoreSearchPageAndRefindCard(
          page,
          sourceId,
          listUrl,
          overlayBase,
          allJobs.length,
          signal,
          cfg.cardAttr,
          key,
        );
        if (recovered) return true;
        await abortWithError(
          `Challenge resolved but ${sourceId} could not restore the interrupted results card (key="${key}")`,
          `Verification passed, but the scraper could not navigate back to the saved ${sourceId} results and refind the interrupted card. Restart the search so ${sourceId} can reopen a fresh results page and continue cleanly.`,
          {
            code: 'challenge-resume-card-missing',
            shortLabel: 'Resume failed after verify',
            status: 'Verification passed, but the interrupted job could not be restored — restart the search.',
          },
        );
        return false;
      };

      for (let attempt = 0; attempt <= 1; attempt++) {

        // ── Click ──────────────────────────────────────────────────────────────
        // Click whichever element the cardAttr selector points to — for Indeed that's
        // the <a> title link (data-jk is on <a>, not the <li>). In Indeed's React SPA,
        // React Router intercepts <a> link clicks at the document level, calls
        // e.preventDefault(), and loads the job description in the side panel — no
        // full-page navigation occurs. Do NOT walk up to the <li> ancestor: DOM events
        // only bubble UP (child → parent), so clicking <li> never fires onClick
        // handlers registered on descendant elements.
        const clickTarget = await page.evaluate((attr, clickSel, k) => {
          const el = document.querySelector(`[${attr}="${k}"]`);
          if (!el) return { ok: false, reason: 'missing-card' };
          const target = clickSel
            ? (el.closest('.job_seen_beacon, [data-testid="job-card-container"], li, article') || el).querySelector(clickSel)
            : el;
          if (!target) return { ok: false, reason: 'missing-target' };
          target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
          const rect = target.getBoundingClientRect();
          if (!rect.width || !rect.height) return { ok: false, reason: 'empty-rect' };
          return {
            ok: true,
            x: rect.left + Math.min(rect.width - 1, Math.max(1, rect.width * 0.35)),
            y: rect.top + Math.min(rect.height - 1, Math.max(1, rect.height * 0.5)),
            href: target.href || target.getAttribute('href') || '',
            tag: target.tagName || '',
          };
        }, cfg.cardAttr, cfg.clickSelector, key).catch(() => ({ ok: false, reason: 'evaluate-threw' }));

        const clicked = !!clickTarget?.ok;

        // Sponsored cards use an rc/clk tracking URL as their href. React Router
        // does NOT intercept those clicks — the browser follows the href directly,
        // Cloudflare sees an automated request and serves a challenge. Skip the
        // mouse-click entirely and navigate to viewjob?jk=KEY instead, which is a
        // clean URL that loads the same description without the tracking redirect.
        if (clicked && clickTarget.href?.includes('/rc/clk')) {
          logger.info(
            `[BrowserScraper] walkDomCards(${sourceId}): key="${key}" is a sponsored card (rc/clk href) — navigating to viewjob to avoid Cloudflare`,
          );
          const viewjobUrl = `https://www.indeed.com/viewjob?jk=${key}`;
          let navDescription = '';
          try {
            await page.evaluate(u => { window.location.href = u; }, viewjobUrl).catch(() => {});
            // Poll for the description selector directly — don't use waitForReady here.
            // waitForReady's indeed contentSel (.job_seen_beacon) is a search-results
            // selector that never exists on individual viewjob pages; it would burn the
            // full 20s CONTENT_TIMEOUT before giving up, costing ~25s per sponsored card.
            let descDL = Date.now() + 8_000;
            let viewjobChallengeRetries = 0;
            while (Date.now() < descDL) {
              if (signal?.aborted || page.isClosed()) break;
              await new Promise(r => setTimeout(r, 300));
              // Cloudflare can challenge the viewjob page or the redirect it issues.
              // Without this check the poll silently times out and the challenge is
              // never surfaced to the user.
              if (await detectChallengePage(page)) {
                const challengeRes = await waitForMidCardChallenge(page, overlayBase, allJobs.length, key, signal);
                if (challengeRes.status === 'abort') break outer;
                if (challengeRes.status === 'timeout') break; // give up on this card
                // Resolved — re-navigate to viewjob. Reset the deadline: solving can
                // take >8s and if descDL already expired the while exits immediately
                // without ever polling, leaving navDescription empty despite success.
                // Cap retries: some viewjob URLs get re-challenged on every navigation
                // (Cloudflare bot-manages the page itself). After 2 solves with no
                // description, give up rather than looping indefinitely.
                if (++viewjobChallengeRetries > 2) {
                  logger.warn(`[BrowserScraper] walkDomCards(${sourceId}): key="${key}" re-challenged ${viewjobChallengeRetries} times without description — skipping card`);
                  break;
                }
                descDL = Date.now() + 8_000;
                await page.evaluate(u => { window.location.href = u; }, viewjobUrl).catch(() => {});
                continue;
              }
              navDescription = await page.evaluate(
                sel => document.querySelector(sel)?.innerText?.trim() || '',
                cfg.panelSelector,
              ).catch(() => '');
              if (navDescription) break;
            }
          } catch { /* best-effort */ }
          await restoreSearchPageAfterDeadListing(page, sourceId, listUrl, overlayBase, allJobs.length, signal);
          consecutivePanelTimeouts = 0;
          snippet = navDescription || '';
          break;
        }

        if (clicked) {
          await page.mouse.move(clickTarget.x, clickTarget.y).catch(() => {});
          await page.mouse.click(clickTarget.x, clickTarget.y, { delay: jitter(80) }).catch(() => {});
        }

        if (!clicked) {
          if (++consecutiveClickFails >= DESC_STALE_THRESHOLD) {
            await abortWithError(
              `${consecutiveClickFails} consecutive card-click failures (${sourceId}, key="${key}", reason="${clickTarget?.reason || 'unknown'}")`,
              `Check DESC_CONFIGS['${sourceId}'].cardAttr in electron/ipc/browser/manualScraper.js`,
            );
            break outer;
          }
          break; // click failed — snippet stays undefined, skip push
        }
        consecutiveClickFails = 0;

        const challengeAfterClick = await waitForMidCardChallenge(page, overlayBase, allJobs.length, key, signal);
        if (challengeAfterClick.status === 'abort') break outer;
        if (challengeAfterClick.status === 'timeout') {
          await abortWithError(
            `Challenge after card click timed out (${sourceId}, key="${key}"). ${challengeAfterClick.evidence || ''}`.trim(),
            `The browser scraper stopped because ${sourceId} required human verification while opening a job card and it was not solved in time.`,
            {
              code: 'challenge-timeout',
              status: 'Challenge timed out — restart the search when ready.',
            },
          );
          break outer;
        }
        if (challengeAfterClick.status === 'resolved') {
          if (!(await recoverAfterChallenge())) break outer;
          attempt--;
          continue;
        }

        // ── Poll ───────────────────────────────────────────────────────────────
        // prevPanelText is intentionally NOT updated until we confirm a valid
        // description below — dead-panel error strings must not become the new
        // baseline (if they did, the next identical error looks like "no change"
        // → full timeout → consecutivePanelTimeouts++ → eventual abortWithError).
        let description = '';
        let pageLevelDeadListing = null;
        let retrySameCardAfterChallenge = false;
        driftedOffSearchPage = false;
        const dl = Date.now() + DESC_CHANGE_TIMEOUT_MS;
        while (Date.now() < dl) {
          await new Promise(r => setTimeout(r, DESC_CHANGE_POLL_MS));

          const challengeDuringPoll = await waitForMidCardChallenge(page, overlayBase, allJobs.length, key, signal);
          if (challengeDuringPoll.status === 'abort') break outer;
          if (challengeDuringPoll.status === 'timeout') {
            await abortWithError(
              `Challenge during panel read timed out (${sourceId}, key="${key}"). ${challengeDuringPoll.evidence || ''}`.trim(),
              `The browser scraper stopped because ${sourceId} required human verification while reading a job card and it was not solved in time.`,
              {
                code: 'challenge-timeout',
                status: 'Challenge timed out — restart the search when ready.',
              },
            );
            break outer;
          }
          if (challengeDuringPoll.status === 'resolved') {
            if (!(await recoverAfterChallenge())) break outer;
            retrySameCardAfterChallenge = true;
            break;
          }

          const state = await page.evaluate((panelSel) => {
            const panelText = document.querySelector(panelSel)?.innerText?.trim() || '';
            const bodyText  = (document.body?.innerText || '').trim();
            const lowerBody = bodyText.toLowerCase();
            const hasResultsShell = !!document.querySelector('.job_seen_beacon, .resultContent, [data-testid="job-card-container"]');
            const isDeadPage =
              !hasResultsShell &&
              (
                lowerBody.includes('page not found') ||
                lowerBody.includes("we can't find this page") ||
                lowerBody.includes('job no longer available') ||
                lowerBody.includes('this job has expired') ||
                lowerBody.includes('no longer accepting applications') ||
                (document.title || '').toLowerCase().includes('404')
              );
            return {
              panelText,
              isDeadPage,
              pageUrl: window.location.href,
              title: document.title || '',
              bodyHead: bodyText.slice(0, 300),
              hasResultsShell,
            };
          }, cfg.panelSelector).catch(() => null);

          if (!state) continue;

          if (state.isDeadPage) {
            pageLevelDeadListing = state;
            description = state.panelText || state.bodyHead || 'page not found';
            break;
          }

          const text = state.panelText;
          if (text && text !== prevPanelText) {
            description = text;
            // Dead-panel strings may appear transiently while the SPA navigates.
            // Keep polling so the content can settle into a real description.
            // Only break early on genuine job content.
            if (!hasDeadListingText(text)) {
              // If the search results shell is gone the click caused a full-page
              // navigation to viewjob instead of loading the side panel. The
              // description is still valid — record the drift so we restore the
              // search page before moving to the next card.
              if (!state.hasResultsShell) driftedOffSearchPage = true;
              break;
            }
          }
        }

        if (retrySameCardAfterChallenge) {
          attempt--;
          continue;
        }

        // ── Analyze ────────────────────────────────────────────────────────────
        if (!description) {
          if (++consecutivePanelTimeouts >= DESC_STALE_THRESHOLD) {
            await abortWithError(
              `${consecutivePanelTimeouts} consecutive panel-read timeouts (${sourceId})`,
              `Check DESC_CONFIGS['${sourceId}'].panelSelector in electron/ipc/browser/manualScraper.js`,
            );
            break outer;
          }
          snippet = ''; // timeout but below abort threshold — collect without description
          break;
        }

        const isDeadPanel = hasDeadListingText(description);

        if (isDeadPanel) {
          if (pageLevelDeadListing) {
            logger.warn(
              `[BrowserScraper] walkDomCards(${sourceId}): key="${key}" opened page-level not-found after automation click — restoring list. Diag: ${JSON.stringify(pageLevelDeadListing)}`,
            );
            consecutivePanelTimeouts = 0;
            await restoreSearchPageAfterDeadListing(page, sourceId, listUrl, overlayBase, allJobs.length, signal);
            if (attempt === 0) continue;
            skippedDeadListings++;
            restoredAfterDeadListing = true;
            snippet = undefined;
            break;
          }

          if (attempt === 0) {
            // Capture deep diagnostics to understand why the panel is erroring —
            // is the page URL intact? did the click land correctly? what does the
            // panel HTML actually contain? Then retry after a brief wait.
            const diag = await page.evaluate((panelSel, attr, k) => {
              const panel = document.querySelector(panelSel);
              const card  = document.querySelector(`[${attr}="${k}"]`);
              return {
                pageUrl:          window.location.href,
                panelText:        (panel?.innerText || '').slice(0, 300),
                panelOuterHtml:   (panel?.outerHTML  || '').slice(0, 500),
                panelParentClass: (panel?.parentElement?.className || '').slice(0, 120),
                cardHref:         card?.href || card?.getAttribute('href') || '(missing)',
                cardInDom:        !!card,
                cardText:         (card?.innerText || card?.textContent || '').slice(0, 80),
                iframeCount:      document.querySelectorAll('iframe').length,
              };
            }, cfg.panelSelector, cfg.cardAttr, key).catch(e => ({ diagError: e.message }));
            logger.warn(
              `[BrowserScraper] walkDomCards(${sourceId}): key="${key}" dead-panel on attempt 1 — retrying after 600 ms. Diag: ${JSON.stringify(diag)}`,
            );
            await new Promise(r => setTimeout(r, 600));
            continue; // retry the click
          }
          // Second attempt also returned a dead-panel. The listing is stale; skip it.
          logger.warn(
            `[BrowserScraper] walkDomCards(${sourceId}): key="${key}" dead-panel persists after retry — skipping stale listing`,
          );
          skippedDeadListings++;
          consecutivePanelTimeouts = 0;
          snippet = undefined;
          break;
        }

        // Valid description — advance baseline and collect.
        prevPanelText = description;
        consecutivePanelTimeouts = 0;
        snippet = description;
        break;
      }

      if (restoredAfterDeadListing) {
        await new Promise(r => setTimeout(r, jitter(DESC_CLICK_DELAY_MS)));
        continue outer;
      }

      if (snippet !== undefined) {
        allJobs.push({ ...jobData, snippet });
        await updateOverlay(page, {
          ...overlayBase,
          count:  allJobs.length,
          status: `Reading job ${keyIndex + 1}/${revealedKeys.length}…`,
        }).catch(() => {});
      }

      // Non-sponsored card click drifted to a full viewjob page instead of
      // loading the side panel. Description was captured above — navigate back
      // to the search results, then scroll to ensure the next card is in the DOM
      // before the loop tries to click it (page restores to top, so cards below
      // the fold may not be rendered yet).
      if (driftedOffSearchPage) {
        logger.info(`[BrowserScraper] walkDomCards(${sourceId}): non-sponsored click navigated to full viewjob page (key="${key}") — restoring search results`);
        await restoreSearchPageAfterDeadListing(page, sourceId, listUrl, overlayBase, allJobs.length, signal);
        const nextKey = revealedKeys[keyIndex + 1];
        if (nextKey) {
          await ensureWalkCardVisible(page, cfg.cardAttr, nextKey, { signal, resetToTop: false, maxScrolls: 16 });
        }
        driftedOffSearchPage = false;
      }

      await new Promise(r => setTimeout(r, jitter(DESC_CLICK_DELAY_MS)));
  }

  if (skippedDeadListings > 0) {
    logger.info(`[BrowserScraper] walkDomCards(${sourceId}): skipped ${skippedDeadListings} stale/dead listing(s)`);
  }

  return { jobsFound: cardsWalked, descError };
}
// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Replace scrapeMultiple for the 5 browser-scraped sources with a fully
 * automated visible-browser session. Takes the same flat task array and
 * onResult callback; returns the same result array shape.
 *
 * @param {Array<{id, sourceId, url, extractorJS, query}>} tasks
 * @param {function} onResult  — called with {id, sourceId, success, data, ...} per source
 * @param {AbortSignal|null}   signal
 * @returns {Promise<Array>}
 */
export async function scrapeManualSources(tasks, onResult, signal) {
  // Group flat task list by sourceId, preserving declaration order
  const bySource = new Map();
  for (const task of tasks) {
    if (!bySource.has(task.sourceId)) bySource.set(task.sourceId, []);
    bySource.get(task.sourceId).push(task);
  }

  const results       = [];
  const executablePath = process.env.CHROME_PATH || await findChromePath();

  await closeStealthBrowser();

  const browser = await puppeteer.launch({
    headless: false,
    executablePath,
    userDataDir: await getUserDataDir(),
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,900',
      '--lang=en-US,en',
    ],
    defaultViewport: null,
    ignoreHTTPSErrors: true,
  });

  const pages = await browser.pages();
  const page  = pages[0] || await browser.newPage();

  // Inject overlay on every new document so it survives navigations
  await page.evaluateOnNewDocument(OVERLAY_SCRIPT);

  let earlyExit    = false;
  let browserClosed = false;
  browser.on('disconnected', () => { browserClosed = true; earlyExit = true; });

  // Re-inject overlay after any page navigation that kills it (Cloudflare blocks,
  // redirects, etc.). OVERLAY_SCRIPT is a no-op when the panel is already present.
  const overlayKeepAlive = setInterval(() => {
    if (browserClosed) return;
    page.evaluate(() => !!document.getElementById('__ic-panel'))
      .then(exists => { if (!exists) page.evaluate(OVERLAY_SCRIPT).catch(() => {}); })
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
        await new Promise(r => setTimeout(r, jitter(NAV_SETTLE_MS)));

        await injectOverlay(page);
        await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Loading…' });

        // Wait for real content — handles challenge pages
        const readyState = await waitForReady(page, sourceId, overlayBase, signal);
        if (readyState === 'abort' || signal?.aborted) { earlyExit = true; break; }
        if (readyState === 'skip') {
          logger.warn(`[BrowserScraper] ${srcName}: challenge timed out — skipping to next source`);
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
        let pageNum          = 1;
        let siteChangedStreak = 0;
        let siteChangedWarning = null;

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

          // ── Walk-cards path (e.g. Indeed): scroll DOM, click each card, record
          //    immediately — replaces bulk runExtractor + expandDescriptions for
          //    virtual-list sources.  Count climbs one by one as each card is read.
          if (DESC_CONFIGS[sourceId]?.walkCards) {
            const { jobsFound, descError: walkDescError } = await walkDomCards(
              page, sourceId, overlayBase, allJobs, seen, signal,
            );

            if (walkDescError) {
              if (!sourceSiteChangedWarning) sourceSiteChangedWarning = walkDescError;
              earlyExit = true;
              break;
            }

            if (jobsFound === 0) break; // no cards on this page → end of results

            logger.info(`[BrowserScraper] ${srcName} page ${pageNum}: ${jobsFound} cards walked (${allJobs.length} total)`);
            await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Looking for next page…' });

            const didPageWalk = await clickNextPage(page, sourceId);
            if (!didPageWalk) break;

            pageNum++;
            await new Promise(r => setTimeout(r, jitter(NAV_SETTLE_MS)));
            await injectOverlay(page);
            await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: `Loading page ${pageNum}…` });

            const pagedReadyWalk = await waitForReady(page, sourceId, overlayBase, signal);
            if (pagedReadyWalk === 'abort' || signal?.aborted) { earlyExit = true; break; }
            if (pagedReadyWalk === 'skip') { sourceSkipped = true; break; }

            continue; // next page iteration — skip the standard path below
          }

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
            await new Promise(r => setTimeout(r, 1000));
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

          // Expand descriptions for this page's new jobs (all 5 sources)
          const jobsToExpand = newJobs.slice(0, JOB_QUERY_TARGET);
          const { jobs: enhanced, descError } = await expandDescriptions(page, jobsToExpand, sourceId, overlayBase, allJobs.length + jobsToExpand.length, signal);
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

          logger.info(`[BrowserScraper] ${srcName} page ${pageNum}: ${newJobs.length} new jobs (${allJobs.length} total)`);

          const didPage = await clickNextPage(page, sourceId);
          if (!didPage) break;

          pageNum++;
          await new Promise(r => setTimeout(r, jitter(NAV_SETTLE_MS)));
          await injectOverlay(page);
          await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: `Loading page ${pageNum}…` });

          // Wait for new content to appear on the paginated page
          const pagedReady = await waitForReady(page, sourceId, overlayBase, signal);
          if (pagedReady === 'abort' || signal?.aborted) { earlyExit = true; break; }
          if (pagedReady === 'skip') { sourceSkipped = true; break; }
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
    if (!browserClosed) await browser.close().catch(() => {});
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
