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
import { POSTED_DATE_PATTERN } from '../jobDateFilter.js';
import { buildOverlayScript, updateOverlay } from './scraperOverlay.js';
import { humanDelay } from '../../utils/humanDelay.js';
import { getGlassdoorLocId, saveGlassdoorLocId } from '../settings.js';
import { CA_PROVINCES, normalizeLocationInput, pickGlassdoorLocation, US_STATES } from '../../../src/utils/jobLocation.js';
import { sourceJobKey } from '../../../src/utils/jobIdentity.js';
import { JOB_COLLECTION_PAGE_CEILING } from '../../../src/utils/jobCollectionLimits.js';
import { parseSalaryToNumeric } from '../../../src/nodes/jobsearch/buildJobTree.js';
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
const DETAIL_DESCRIPTION_WAIT_MS = 6000;      // bounded client-hydration recovery for navigation detail pages
// ZipRecruiter will serve a plain HTTP 429 page after sustained detail-page
// navigation. These bounds deliberately slow only detail enrichment (not list
// collection), retry once, then stop the detail pass rather than hammering a
// rate-limited session for every remaining card.
const ZIPRECRUITER_DETAIL_GAP_MS = 2500;
const ZIPRECRUITER_429_FALLBACK_WAIT_MS = 45_000;
const ZIPRECRUITER_429_MAX_WAIT_MS = 60_000;
const ZIPRECRUITER_429_RETRIES = 1;

// Cooldown BETWEEN queries (not before the first). Firing N back-to-back
// full-page navigations to different search URLs is a velocity signal that
// anti-bot systems flag — a human-scale pause between them lowers that signal.
// All values are anchors fed through humanDelay() at the call site, so the
// actual wait is organically spread (never a fixed cadence).
const DEFAULT_INTER_QUERY_COOLDOWN_MS = 2500;
// Collection breadth is supplied per task from the persisted hub setting. There
// are no process-global collection caps, so a saved hub re-runs with its own
// explicit breadth regardless of test/runtime environment.


function countDistinctJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return 0;
  const seen = new Set();
  let count = 0;
  for (const job of jobs) {
    const key = sourceJobKey(job);
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
  // Detail-recovery outcomes need a retention guarantee independent of normal
  // scrape progress. A busy later source can otherwise evict an early detail
  // miss or a provider-confirmed closed listing from the 30-event phase ring
  // before the user opens a FULL report.
  fieldAnomalies: [],
  paused: false,  // survives page navigations — source of truth is Node.js, not the page
  consoleLogs: [],   // last 60 browser-side console errors/warnings from the stealth page
  networkErrors: [], // last 30 network failures / 4xx-5xx responses from the stealth page
};

// Browser job boards routinely emit failed ad/analytics requests and CSP/ORB
// console errors that have no bearing on whether the listing scraper worked.
// These buffers are deliberately small, so allowing a burst of that traffic to
// consume them can evict the first-party failure that actually explains a bad
// scrape. Keep the allowlist URL-shaped and narrow: unfamiliar third parties and
// every ordinary first-party URL remain reportable.
function isKnownTelemetryNoiseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.replace(/[),.;:'"]+$/g, ''));
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const hostIs = domain => host === domain || host.endsWith(`.${domain}`);

    if (hostIs('siteintercept.qualtrics.com')) return true;
    if (hostIs('impactradius-event.com')) return true;
    if (hostIs('doubleclick.net')) return true;
    if (hostIs('googleadservices.com') || hostIs('googlesyndication.com')) return true;
    if (host === 'www.google.com' && (pathname.startsWith('/rmkt/') || pathname.startsWith('/ccm/collect'))) return true;
    if (host === 'csp.withgoogle.com' && pathname === '/csp/identityrotatecookieshttp') return true;

    // Preserve the pre-existing low-value telemetry exclusions in one shared
    // predicate so request failures and HTTP failures cannot drift apart.
    if (host === 't.indeed.com' && pathname.startsWith('/signals')) return true;
    if (hostIs('googletagmanager.com') || hostIs('google-analytics.com') || host.includes('.analytics.')) return true;
    if (hostIs('sift.com') || hostIs('intercom.io') || hostIs('clarity.ms')) return true;
    if (hostIs('bat.bing.com') || hostIs('munchkin.marketo.net') || hostIs('cdn.branch.io')) return true;
    if (hostIs('cloudflareinsights.com') && pathname.startsWith('/cdn-cgi/rum')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * True only when a browser console/network diagnostic targets a known
 * non-functional ad/tracker endpoint. Console CSP messages often originate in
 * a first-party bundle (`url`) while naming the blocked request in `text`, so we
 * inspect the first embedded URL as the target. We intentionally do not scan
 * every URL in the message: CSP directive text may list tracker domains after a
 * genuine first-party failure, and that failure must stay visible.
 *
 * Exported for deterministic regression tests.
 */
export function isIgnorableManualBrowserTelemetry({ url = '', text = '' } = {}) {
  if (isKnownTelemetryNoiseUrl(url)) return true;
  const target = String(text || '').match(/https?:\/\/[^\s'"<>]+/i)?.[0] || '';
  return isKnownTelemetryNoiseUrl(target);
}

// `updateActive: false` records an event into the trail WITHOUT advancing the
// "current phase". Per-job outcomes (desc-miss / date-miss / detail-unavailable)
// are not scrape phases: `active` is a merge that never deletes fields, so
// folding one in would leave its `key` pinned to every later render — reporting
// one job's outcome as though it belonged to whatever the scraper is doing at
// report time.
// Exported for unit testing.
export function recordManualScraperTelemetry(event, { updateActive = true } = {}) {
  const entry = {
    ts: Date.now(),
    ...event,
  };
  manualScraperTelemetry.events.push(entry);
  if (manualScraperTelemetry.events.length > 30) manualScraperTelemetry.events.shift();
  if (['desc-miss', 'date-miss', 'detail-unavailable'].includes(entry.phase)) {
    manualScraperTelemetry.fieldAnomalies.push(entry);
    if (manualScraperTelemetry.fieldAnomalies.length > 20) manualScraperTelemetry.fieldAnomalies.shift();
  }
  if (!updateActive) return;
  // A source/query/page boundary is a new diagnostic context, not an update to
  // the prior listing. Replacing at those boundaries prevents a Glassdoor
  // detail key/reason/evidence from being reported as the current Google item
  // after the next source starts. Fine-grained phases within one context still
  // merge so browser/challenge metadata can accumulate while it is current.
  const resetsContext = new Set(['source-start', 'query-start', 'page-extract', 'source-finished']);
  manualScraperTelemetry.active = resetsContext.has(entry.phase)
    ? entry
    : { ...(manualScraperTelemetry.active || {}), ...entry };
}

/** Record a query only when Chrome accepted the location-assignment command. */
export function recordIssuedManualQuery(executedQueries, entry, navigationIssued) {
  if (navigationIssued && Array.isArray(executedQueries)) executedQueries.push(entry);
  return executedQueries;
}

function clearManualScraperTelemetry(status = 'idle') {
  manualScraperTelemetry.active = manualScraperTelemetry.active
    ? { ...manualScraperTelemetry.active, ts: Date.now(), phase: status }
    : null;
}

// Keep terminal causes separate from the generic "completed" outcome.  In
// particular, FAST mode can intentionally stop a source after its aggregate
// result cap; reporting that as a normal completion makes a breadth-limited
// search indistinguishable from an exhausted one.
export function resolveManualSourceStopReason({
  earlyExit = false,
  aborted = false,
  sourceSkipped = false,
  hitPerSourceCap = false,
  hitPageCap = false,
  hitEmptyPage = false,
  hitUnhandledPagination = false,
  dataStopReason = null,
} = {}) {
  if (sourceSkipped) return 'blocked';
  if (aborted) return 'aborted';
  // `earlyExit` has historically meant a user-done / source-local stop, not
  // necessarily an AbortSignal. Keep that public result enum stable; callers
  // pass `aborted` only for an actual cancelled signal.
  if (earlyExit) return 'user-done';
  if (hitPerSourceCap) return 'per-source-cap';
  // An enabled next control with no successful action is proof that this run
  // stopped before the board's end. Keep it distinct from a normal completion
  // and from a user-configured page cap so the report states the real cause.
  if (hitUnhandledPagination) return 'pagination-unhandled';
  // A data-driven stop (age-window / no-new-jobs, from makeJobPageStop via
  // task.options.onPageScraped) means the walk ended because the DATA said
  // stop, not because it was cut short by the hub's page ceiling — surface it
  // under its own reason so bug reports never read a complete, data-driven
  // finish as the `page-cap` "this source may have additional in-window jobs"
  // warning (see bugReport/jobsSnapshot.js's stopReason flagging).
  if (dataStopReason) return dataStopReason;
  if (hitPageCap) return 'page-cap';
  if (hitEmptyPage) return 'empty-page';
  return 'completed';
}

export function getManualScraperTelemetry() {
  return {
    active: manualScraperTelemetry.active ? { ...manualScraperTelemetry.active } : null,
    events: manualScraperTelemetry.events.map(e => ({ ...e })),
    fieldAnomalies: manualScraperTelemetry.fieldAnomalies.map(e => ({ ...e })),
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
  // ZipRecruiter changed from scroll-loading results to a conventional pager.
  // The current control is an anchor (`<a title="Next Page">`), rather than a
  // button, so it must be clicked as part of the regular pagination loop.
  ziprecruiter: 'a[title="Next Page"]',
  glassdoor:    'button[data-test="pagination-next"]',
};

// Sources that load more jobs by scrolling to the bottom (infinite scroll).
// Google for Jobs (ibp=htl;jobs mode) lazy-loads more cards as you scroll — initial
// render is ~10 cards; scrolling reveals the rest before we run the extractor.
const SCROLL_SOURCES = new Set(['google']);

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
//   cardDataUrlParam — stable result-card identity carried in its data-share-url
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
    cardIdPrefix:  '',           // legacy fallback: getElementById(key) = the clickable element
    cardHrefKey:   null,
    // Google's virtualized list can replace the element ID while its surrounding
    // result card remains mounted. data-share-url carries the same stable key.
    cardDataUrlParam: 'htidocid',
    clickSelector: null,
    panelSelector: 'span.OOyDTc, span.ejCXj',
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
    // `.jobdesciption` is Trakstar Hire's live (misspelled) container. ZR can
    // send an external Trakstar apply URL whose visible application form hides
    // this node; normalizeDetailNavigationUrl() below switches only that ATS to
    // its ordinary detail view before these selectors run.
    panelSelector: '[class~="whitespace-pre-line"], .jobDescriptionSection, [data-testid="jobDescriptionSection"], #job-description-container, [class*="jobDescription"], .job_description, .jobdesciption, #job_desc',
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

/**
 * Produce the stable DOM target for each card-click description attempt.
 *
 * Keeping this derivation in one place matters for virtualized lists: every
 * on-demand click receives the extracted listing's opaque identity instead of
 * relying on a mutable visible-list position.
 */
export function buildDescriptionCardTargets(jobs, sourceId) {
  const cfg = DESC_CONFIGS[sourceId];
  if (!cfg) return [];
  return (Array.isArray(jobs) ? jobs : []).map((job, index) => {
    const rawKey = (cfg.keyField && job?.[cfg.keyField])
      ? job[cfg.keyField]
      : cfg.keyRegex
        ? job?.url?.match(new RegExp(cfg.keyRegex))?.[1]
        : job?.url?.match(new RegExp(`[?&]${cfg.keyParam}=([^&]+)`))?.[1];
    let key = rawKey || '';
    if (key && cfg.keyDecode) {
      try { key = decodeURIComponent(key); } catch { key = ''; }
    }
    return { index, key: String(key || '') };
  });
}

/**
 * Preserve where selected cards came from in a physical, DOM-ordered result
 * list. The normal walk now includes every provider row; retaining the ordinal
 * still proves that result caps and virtualized remounts did not change click
 * identity, without adding transient fields to persisted/scored job objects.
 */
export function buildPhysicalCardWalkPlan(extractedJobs, selectedJobs) {
  const extracted = Array.isArray(extractedJobs) ? extractedJobs : [];
  const selected = Array.isArray(selectedJobs) ? selectedJobs : [];
  const ordinals = new Map(extracted.map((job, index) => [job, index + 1]));
  return {
    physicalTotal: extracted.length,
    physicalIndexes: selected.map(job => ordinals.get(job) ?? null),
  };
}

function normalizedDetailTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/**
 * A missing detail heading is ordinary Google markup variation and must not
 * turn a good panel read into a false miss. When both titles are present,
 * however, a non-equivalent heading is positive evidence that the click
 * selected a different job and its description must not be attached.
 */
export function assessDetailSelection(expectedTitle, selectedTitle) {
  const expected = normalizedDetailTitle(expectedTitle);
  const selected = normalizedDetailTitle(selectedTitle);
  if (!expected || !selected) {
    return { selectedTitle: String(selectedTitle || '').trim(), selectionVerified: false, selectionMismatch: false };
  }
  const equivalent = expected === selected || expected.includes(selected) || selected.includes(expected);
  return {
    selectedTitle: String(selectedTitle || '').trim(),
    selectionVerified: equivalent,
    selectionMismatch: !equivalent,
  };
}

/** Read a heading from Google's active detail region, never a left-list card. */
export function readActiveGoogleDetailTitle(root) {
  if (!root?.querySelectorAll) return '';
  const candidates = Array.from(root.querySelectorAll('h1, h2, h3, [role="heading"]'))
    .filter(el => !el.closest?.('[aria-hidden="true"]'))
    .filter(el => !el.closest?.('[data-share-url]'))
    .filter(el => !!el.closest?.('[aria-hidden="false"]'))
    .map(el => el.textContent?.replace(/\s+/g, ' ').trim() || '')
    .filter(Boolean);
  return candidates[0] || '';
}

/**
 * Read the visible Google detail-panel text without accidentally accepting a
 * cached previous card or a preloaded next card. Google keeps those panels in
 * the DOM under aria-hidden="true" while the active panel can include a
 * CSS-hidden `.ejCXj` continuation under aria-hidden="false". The latter is
 * real description text and must stay; only the ARIA-hidden ancestor is a
 * reliable exclusion boundary.
 *
 * Kept DOM-root based and side-effect free so fixture tests exercise the same
 * selection policy that runs in the browser page.
 */
export function readDescriptionPanelText(root, panelSelector, panelMulti = false) {
  if (!root?.querySelectorAll || !panelSelector) return '';
  if (panelMulti) {
    return Array.from(root.querySelectorAll(panelSelector))
      .filter(el => el.matches?.('span') && !el.closest?.('[aria-hidden="true"]'))
      .map(el => el.textContent?.trim()).filter(Boolean).join('\n\n').trim();
  }
  return root.querySelector(panelSelector)?.innerText?.trim()
    || root.querySelector(panelSelector)?.textContent?.trim()
    || '';
}

/**
 * Deterministic virtual-list diagnostic: which planned click targets are still
 * present in the current DOM window. The live clicker reports these misses and
 * never treats a list-card snippet as a recovered full description.
 */
export function inspectDescriptionCardTargetAvailability(targets, availableKeys) {
  const available = new Set(Array.isArray(availableKeys) ? availableKeys : []);
  const planned = Array.isArray(targets) ? targets : [];
  const missing = planned.filter(target => target?.key && !available.has(target.key));
  return {
    planned: planned.filter(target => target?.key).length,
    available: planned.filter(target => target?.key && available.has(target.key)).length,
    missing,
  };
}

/**
 * Turn ATS application-mode links into read-only detail pages for enrichment,
 * without changing the user-facing job URL. Trakstar's `?apply=true` mode hides
 * its `.jobdesciption` body behind the application form, and some Trakstar
 * tenants also emit invalid JSON-LD (literal newlines inside `description`), so
 * leaving the query intact can make a fully populated posting look empty.
 *
 * Keep this host-specific: other boards may require an apply query to resolve
 * the posting at all.
 */
export function normalizeDetailNavigationUrl(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) return input;
  try {
    const parsed = new URL(input);
    if (parsed.hostname.toLowerCase().endsWith('.hire.trakstar.com')
      && /^\/jobs\/[^/]+\/?$/i.test(parsed.pathname)
      && parsed.searchParams.get('apply')?.toLowerCase() === 'true') {
      parsed.searchParams.delete('apply');
      return parsed.toString();
    }
  } catch {
    // Preserve malformed/source-relative links for the caller's normal error path.
  }
  return input;
}

/**
 * ZipRecruiter's ItemList occasionally supplies an employer's outbound
 * application endpoint (for example a Workday `/apply` URL) instead of its
 * own read-only detail page. We make a shallow, read-only visit to both its
 * current `/jobs/...`, legacy `/c/<company>/Job/...`, and employer-provided
 * external URLs: one navigation, text extraction, then immediately on to the
 * next listing. The scraper never clicks Apply, fills fields, logs in, or
 * submits anything on an external page.
 */
export function shouldNavigateForDescription(sourceId, rawUrl) {
  if (sourceId !== 'ziprecruiter') return true;
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Decide whether a detail page is conclusively unavailable rather than merely
 * slow or selector-incompatible. Workday returns HTTP 200 for a closed posting
 * and exposes that state in its bootstrap object, so status alone is not enough.
 */
export function isUnavailableDetailPage({ isNotFound = false, workdayPostingAvailable } = {}) {
  return Boolean(isNotFound) || workdayPostingAvailable === false;
}

/** Convert a Retry-After header to a safe, bounded wait for a single retry. */
export function zipRecruiterRetryAfterMs(value, now = Date.now()) {
  const raw = String(value || '').trim();
  let delay = raw ? Number(raw) * 1000 : NaN;
  if (!Number.isFinite(delay) || delay < 0) {
    const at = Date.parse(raw);
    delay = Number.isFinite(at) ? at - now : ZIPRECRUITER_429_FALLBACK_WAIT_MS;
  }
  return Math.max(1000, Math.min(ZIPRECRUITER_429_MAX_WAIT_MS, Math.round(delay)));
}

async function waitForAbortableDelay(ms, signal) {
  const deadline = Date.now() + Math.max(0, Number(ms) || 0);
  while (!signal?.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return true;
    await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 500)));
  }
  return false;
}

// Format a schema.org JobPosting.baseSalary object into a compact display string
// ("$80,000 - $120,000/yr", "$55/hr"). Returns '' for anything unrecognizable so a
// malformed block never poisons the salary field. Shared by the enrichment path
// (ZipRecruiter/Glassdoor) — backfills salary the list extractor couldn't get.
export function formatJsonLdSalary(bs) {
  if (!bs || typeof bs !== 'object') return '';
  const cur = String(bs.currency || bs.salaryCurrency || '').toUpperCase();
  const sym = (cur === 'USD' || cur === 'CAD' || cur === 'AUD' || cur === '') ? '$' : `${cur} `;
  const v = bs.value && typeof bs.value === 'object' ? bs.value : bs;
  const unitMap = { YEAR: '/yr', HOUR: '/hr', MONTH: '/mo', WEEK: '/wk', DAY: '/day' };
  const unit = unitMap[String(v.unitText || '').toUpperCase()] || '';
  const num = (x) => (x == null || isNaN(Number(x))) ? null : Number(x).toLocaleString('en-US');
  const min = num(v.minValue), max = num(v.maxValue), val = num(v.value);
  // With no recognized unitText we cannot tell an hourly rate from an annual
  // salary, and emitting the bare number anyway is worse than emitting nothing:
  // it is truthy, so the caller's DOM-chip fallback (which DOES carry a visible
  // cadence) never runs, and the wrong figure gets locked in. Keep the value only
  // when its magnitude can't be anything but annual.
  const annualOnly = (x) => Number(x) >= 10000;
  if (!unit) {
    if (v.minValue != null && v.maxValue != null && annualOnly(v.minValue)) return `${sym}${min} - ${sym}${max}`;
    if (v.value != null && annualOnly(v.value)) return `${sym}${val}`;
    return '';
  }
  if (min != null && max != null) return `${sym}${min} - ${sym}${max}${unit}`;
  if (val != null) return `${sym}${val}${unit}`;
  return '';
}

// A ZipRecruiter pay chip may prefix either endpoint with a compact currency
// marker ("CA$40 - CA$85/hr", "US$17.60 - US$22.00 Per hour"). Keep the
// prefix inside the match: starting at the first bare `$` used to stop at
// "$40" when the second endpoint began with `CA$`, losing both the range and
// its cadence. The prefix is tied to a currency symbol so prose immediately
// before an ordinary dollar amount cannot be swallowed.
const ZIPRECRUITER_MONEY_SRC = String.raw`(?:[A-Za-z]{1,3}(?=\$))?\$\s?\d[\d.,]*\s?(?:[KkMm](?![A-Za-z]))?(?:\s?(?:[-–—]|to)\s?(?:(?:[A-Za-z]{1,3}(?=\$))?\$)?\s?\d[\d.,]*\s?(?:[KkMm](?![A-Za-z]))?)?(?:\s?(?:\/\s?(?:yr|year|hr|hour|mo|month|wk|week)|(?:hour|year|month|week|annual|bi[-\s]?week)ly|an hour|a year|a month|a week|per (?:hour|year|month|week)))?`;

/** Extract one bounded ZipRecruiter pay-chip value from visible text. */
export function extractZipRecruiterDomSalaryText(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 60) return '';
  const match = value.match(new RegExp(ZIPRECRUITER_MONEY_SRC, 'i'));
  return match?.[0]?.trim() || '';
}

/**
 * ZipRecruiter's client-rendered estimate occasionally combines an annual K
 * amount with an hourly cadence (for example "$65K/hr"). Prefer an explicit,
 * pay-anchored annual amount from that listing's own description; if there is
 * no such correction, omit the corrupt chip rather than presenting false pay.
 * This deliberately has no dependency on renderer taxonomy helpers.
 */
export function reconcileZipRecruiterDomSalary(rawSalary, description) {
  const raw = String(rawSalary || '').trim();
  const body = String(description || '').replace(/\s+/g, ' ');

  // ZipRecruiter sometimes exposes a broken list/detail chip while the JD still
  // contains the authoritative pay block. Canadian postings in particular can
  // use a decimal comma without thousands separators ("$111308,33"), which the
  // generic money regex correctly refuses to guess at. Recover only from an
  // explicitly pay-labelled block and normalize it to the shared annualizer's
  // unambiguous display format.
  const localizedAmount = String.raw`(?:[A-Za-z]{1,3}(?=[$€£]))?[$€£]?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?|\d{4,}(?:[.,]\d{2})?|\d+(?:[.]\d{1,2})?)`;
  const labelledRange = new RegExp(
    String.raw`\b(annual\s+base\s+salary\s+range(?:\s+or\s+hourly\s+base\s+pay\s+range)?|base\s+salary(?:\s+range)?|salary\s+range|compensation(?:\s+range)?)\b[^$€£]{0,60}${localizedAmount}\s*(?:[-–—]|to)\s*${localizedAmount}`,
    'i',
  ).exec(body);
  const parseLocalized = (value) => {
    let s = String(value || '').replace(/\s+/g, '');
    const comma = s.lastIndexOf(',');
    const dot = s.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
      // The right-most separator is decimal; the other is grouping.
      s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (comma >= 0) {
      // A final two-digit comma after at least four integer digits is a locale
      // decimal separator. Otherwise commas are ordinary thousands grouping.
      s = /^\d{4,},\d{2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  let descriptionSalary = '';
  if (labelledRange) {
    const min = parseLocalized(labelledRange[2]);
    const max = parseLocalized(labelledRange[3]);
    const nearby = body.slice(labelledRange.index, labelledRange.index + labelledRange[0].length + 220);
    const explicitHourly = /compensation\s+type\s*:\s*hourly\b/i.test(nearby);
    const explicitSalary = /compensation\s+type\s*:\s*salary\b/i.test(nearby);
    const annualScale = min >= 10_000 && max >= 10_000;
    const hourlyScale = min > 0 && max > 0 && min < 1_000 && max < 1_000;
    const cadence = explicitHourly && hourlyScale ? 'hr'
      : (explicitSalary || annualScale || /^annual\b/i.test(labelledRange[1])) ? 'yr'
        : '';
    if (cadence && min > 0 && max >= min && max <= 10_000_000) {
      const format = (n) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
      descriptionSalary = `${format(min)} - ${format(max)}/${cadence}`;
    }
  }

  if (!raw) return descriptionSalary;
  if (parseSalaryToNumeric(raw) === 0 && descriptionSalary) return descriptionSalary;
  const amount = raw.match(/\$\s?(\d+(?:\.\d+)?)\s*([km])\b/i);
  const cadence = raw.match(/\b(?:bi[-\s]?weekly|week(?:ly)?|wk|month(?:ly)?|mo|day|daily|hour(?:ly)?|hr)\b|\/\s*(?:bi[-\s]?wk|wk|mo|day|hr)\b/i);
  if (!amount || !cadence) return raw;

  const base = Number(amount[1]) * (amount[2].toLowerCase() === 'm' ? 1_000_000 : 1_000);
  const token = cadence[0].toLowerCase();
  const multiplier = /bi[-\s]?(?:weekly|wk)/.test(token) ? 26
    : /week|wk/.test(token) ? 52
      : /month|mo/.test(token) ? 12
        : /day/.test(token) ? 260
          : 2080;
  if (!Number.isFinite(base) || base * multiplier <= 10_000_000) return raw;

  const money = String.raw`(?:[A-Za-z]{1,3}(?=\$))?\$\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s?(?:[-–—]|to)\s?(?:(?:[A-Za-z]{1,3}(?=\$))?\$)?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?)?`;
  const annual = String.raw`(?:\s*(?:USD|CAD|AUD|EUR|GBP)\b)?\s*(?:(?:per|a)\s+(?:year|annum)|\/\s*(?:yr|year)|annually|annual|yearly)`;
  const explicitPay = new RegExp(
    String.raw`\b(?:base\s+)?(?:salary|compensation|pay)\b[^$]{0,80}(${money}${annual})`,
    'i',
  ).exec(body);
  return descriptionSalary || explicitPay?.[1]?.trim() || '';
}

// Keep every list-card field when detail enrichment is partial. In particular,
// a description miss must not discard a date recovered from the same detail
// page: ZipRecruiter can expose datePosted even when its description is absent.
// This is deliberately field-by-field so existing list data remains authoritative.
export function mergeExpandedJobDetail(job, {
  text = '',
  descriptionCapture = '',
  jsonLdDate = '',
  jsonLdSalary = '',
  salaryChanged = false,
  reconciledSalary,
  jsonLdCompany = '',
} = {}) {
  const existingSalaryUsable = parseSalaryToNumeric(job?.salary) > 0;
  const existingCompanyUsable = !!String(job?.company || '').trim();
  const usableJsonLdCompany = String(jsonLdCompany || '').trim();
  return {
    ...job,
    ...(text ? { snippet: text } : {}),
    ...(text && descriptionCapture ? { descriptionCapture } : {}),
    ...(jsonLdDate && !job.posted ? { posted: jsonLdDate } : {}),
    ...(salaryChanged ? { salary: reconciledSalary } : {}),
    // Structured detail pay includes schema.org unitText. Let it repair a
    // present-but-unusable list chip (e.g. Glassdoor "US$19 - US$20 (Employer
    // provided)"), while leaving every already-parseable list salary untouched.
    ...(jsonLdSalary && !existingSalaryUsable && !salaryChanged ? { salary: jsonLdSalary } : {}),
    // ZipRecruiter's ItemList regex derives company from the listing URL
    // (/c/{Company}/Job/), which never matches externally-hosted postings
    // (ziprecruiter.com/job-redirect?match_token=…) — leaving company
    // permanently blank from list extraction alone. Backfill from the detail
    // page's own JobPosting.hiringOrganization, but only when the list
    // extractor found nothing; never clobber a company it already resolved.
    ...(usableJsonLdCompany && !existingCompanyUsable ? { company: usableJsonLdCompany } : {}),
  };
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
async function waitForReady(page, sourceId, overlayBase, signal, resumeUrl = null, { challengeOnly = false } = {}) {
  // Location autocomplete runs from Glassdoor's origin landing page, before a
  // results page exists. In that phase there cannot be a job-card selector to
  // wait for; we only need this function's challenge gate. The origin navigation
  // has already had NAV_SETTLE_MS to render before this check.
  const contentSel    = challengeOnly ? null : CONTENT_SELECTORS[sourceId];
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
    const hasContent  = challengeOnly || !contentSel || await page.evaluate(
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
        const elapsedSec = Math.floor((Date.now() - challengeStartedAt) / 1000);
        logger.info(`[BrowserScraper] ${overlayBase.srcName}: still waiting for the user to solve the challenge (${elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m${elapsedSec % 60}s`} elapsed)`);
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
// Returns { jobs, descError, descWarning } where descError is non-null when card or panel
// selectors appear stale (≥ DESC_STALE_THRESHOLD consecutive failures of the same
// type). A non-null descError is an abort signal — the caller must set earlyExit
// and surface the error just like a SITE_CHANGED extraction failure.
async function expandDescriptions(page, jobs, sourceId, overlayBase, totalSoFar, signal = null, walkPlan = null) {
  const cfg = DESC_CONFIGS[sourceId];
  if (!cfg || jobs.length === 0) return { jobs, descError: null, descWarning: null, expandedCount: 0 };

  const enhanced  = [...jobs];
  const cardTargets = buildDescriptionCardTargets(enhanced, sourceId);
  const physicalTotal = Number.isFinite(Number(walkPlan?.physicalTotal))
    ? Number(walkPlan.physicalTotal)
    : enhanced.length;
  const physicalIndexes = Array.isArray(walkPlan?.physicalIndexes) ? walkPlan.physicalIndexes : [];
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
    let descWarning = null;
    let expandedCount = 0;
    let lastZipRecruiterDetailAt = 0;
    let zipRecruiter429Retries = 0;
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
        viewUrl = normalizeDetailNavigationUrl(viewUrl);

        if (!shouldNavigateForDescription(sourceId, viewUrl)) {
          const title = (job.title || job.url || '?').slice(0, 65);
          logger.info(`[BrowserScraper] ${overlayBase.srcName} skipped unsupported detail URL while enriching "${title}"`);
          recordManualScraperTelemetry({
            phase: 'desc-miss', srcName: overlayBase.srcName,
            key: `${title} | unsupported detail URL skipped`,
            reason: 'unsupported-detail-url', expectedUrl: viewUrl.slice(0, 240),
          }, { updateActive: false });
          descWarning ||= {
            code: 'description-unsupported-url', severity: 'warn',
            evidence: `${overlayBase.srcName} supplied an unsupported detail URL for "${job.title || 'an untitled listing'}". The listing was retained without navigation.`,
            suggestion: 'Open the saved job URL yourself if needed, then retry the source later for a full description.',
          };
          continue;
        }

        const navPause = await waitIfPaused(page, signal);
        if (navPause === 'abort') break;

        if (sourceId === 'ziprecruiter' && lastZipRecruiterDetailAt) {
          const waitMs = ZIPRECRUITER_DETAIL_GAP_MS - (Date.now() - lastZipRecruiterDetailAt);
          if (waitMs > 0 && !(await waitForAbortableDelay(waitMs, signal))) break;
        }

        await updateOverlay(page, {
          ...overlayBase,
          count:  baseCount + i + 1,
          status: `Fetching descriptions… ${i + 1}/${enhanced.length}`,
        });

        recordManualScraperTelemetry({
          phase: 'detail-expand',
          sourceId,
          srcName: overlayBase.srcName,
          itemIndex: i + 1,
          itemTotal: enhanced.length,
          key: (job.title || job.url || '?').slice(0, 80),
          url: viewUrl.slice(0, 240),
        });

        try {
          // goto() + domcontentloaded: JSON-LD is server-rendered so it's ready
          // immediately; no need for networkidle which ZipRecruiter's analytics
          // would delay indefinitely.
          const previousUrl = fetchPage.url();
          let navigationResponse = null;
          let navigationError = null;
          try {
            if (sourceId === 'ziprecruiter') lastZipRecruiterDetailAt = Date.now();
            navigationResponse = await fetchPage.goto(viewUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
          } catch (error) {
            navigationError = error;
          }
          const finalUrl = fetchPage.url();
          const navigationMoved = finalUrl && finalUrl !== previousUrl && finalUrl !== 'about:blank';
          if (navigationError && !navigationMoved) {
            const reason = String(navigationError?.message || navigationError).replace(/\s+/g, ' ').slice(0, 180);
            logger.warn(`[BrowserScraper] ${overlayBase.srcName} detail navigation failed for "${job.title || job.url || '?'}": ${reason}`);
            recordManualScraperTelemetry({
              phase: 'desc-miss', srcName: overlayBase.srcName,
              key: `${(job.title || job.url || '?').slice(0, 65)} | navigation failed`,
              reason: 'navigation-error',
              error: reason,
              expectedUrl: viewUrl.slice(0, 240),
              finalUrl: finalUrl.slice(0, 240),
            }, { updateActive: false });
            descWarning ||= {
              code: 'description-detail-navigation', severity: 'warn',
              evidence: `${overlayBase.srcName} could not open the detail page for "${job.title || 'an untitled listing'}" within its bounded navigation wait. The listing was retained with its available list fields.`,
              suggestion: `Retry ${overlayBase.srcName} later or open the listing directly; the board or destination site may be temporarily unavailable.`,
            };
            continue;
          }
          const navigationStatus = navigationResponse?.status?.() ?? null;

          const challengeSignals = await getChallengeSignals(fetchPage);
          const isChallenge = !!challengeSignals?.isChallenge;
          // Detect expired listings separately from challenge redirects.
          const pageInfo = await fetchPage.evaluate(() => {
            const bodyText = (document.body?.innerText || '').toLowerCase();
            const title    = (document.title || '').toLowerCase();
            // Workday's external `/apply` endpoint responds with HTTP 200 even
            // after a posting closes. Its initial bootstrap object carries the
            // authoritative availability flag before its client app renders.
            const workdayPostingAvailable = typeof window.workday?.postingAvailable === 'boolean'
              ? window.workday.postingAvailable
              : null;
            const isRateLimited =
              title.includes('too many requests') ||
              bodyText.includes('too many requests') ||
              bodyText.includes('maximum number of requests allowed') ||
              bodyText.includes('rate limit exceeded');
            const isNotFound =
              bodyText.includes('page not found') ||
              bodyText.includes("we can't find this page") ||
              bodyText.includes('no longer available') ||
              bodyText.includes('this job has expired') ||
              title.includes('404');
            return { isNotFound, isRateLimited, workdayPostingAvailable };
          }).catch(() => ({ isNotFound: false, isRateLimited: false, workdayPostingAvailable: null }));

          if (sourceId === 'ziprecruiter' && (navigationStatus === 429 || pageInfo.isRateLimited)) {
            const retryAfter = navigationResponse?.headers?.()?.['retry-after'];
            const waitMs = zipRecruiterRetryAfterMs(retryAfter);
            const title = (job.title || job.url || '?').slice(0, 65);
            recordManualScraperTelemetry({
              phase: 'desc-miss', srcName: overlayBase.srcName,
              key: `${title} | ZipRecruiter rate limited`, reason: 'http-429',
              status: navigationStatus, retryAfter: retryAfter || null, retryWaitMs: waitMs,
              expectedUrl: viewUrl.slice(0, 240), finalUrl: fetchPage.url().slice(0, 240),
            }, { updateActive: false });
            if (zipRecruiter429Retries < ZIPRECRUITER_429_RETRIES && !signal?.aborted) {
              zipRecruiter429Retries++;
              logger.warn(`[BrowserScraper] ${overlayBase.srcName} detail fetch rate-limited for "${title}" — waiting ${Math.ceil(waitMs / 1000)}s before one retry`);
              await updateOverlay(page, {
                ...overlayBase, count: baseCount + i + 1,
                status: `ZipRecruiter rate-limited — retrying in ${Math.ceil(waitMs / 1000)}s…`,
              }).catch(() => {});
              if (!await waitForAbortableDelay(waitMs, signal)) break;
              i--; // retry this exact job once; do not advance to another detail page
              continue;
            }
            logger.warn(`[BrowserScraper] ${overlayBase.srcName} stayed rate-limited after its bounded retry — stopping detail enrichment`);
            descWarning = {
              code: 'description-rate-limited', severity: 'warn',
              evidence: `${overlayBase.srcName} returned HTTP 429 while fetching "${job.title || 'an untitled listing'}". The scraper waited and retried once, then stopped further detail fetches to avoid extending the rate limit.`,
              suggestion: `Wait a few minutes before rerunning ${overlayBase.srcName}; list results were retained, but this and later rows may lack full descriptions.`,
            };
            const unexpandedCount = enhanced.length - (i + 1);
            recordManualScraperTelemetry({
              phase: 'desc-miss', srcName: overlayBase.srcName,
              key: `${unexpandedCount} unexpanded after 429 | ${title}`,
              reason: 'rate-limit-detail-pass-stopped', status: navigationStatus,
            }, { updateActive: false });
            break;
          }

          if (isChallenge) {
            if (detailPage) {
              // A background tab cannot be solved by the user. Keep the relevant
              // list row (rather than silently dropping it), stop the remaining
              // detail requests so we do not intensify a session-level block, and
              // attach a source warning that makes the partial scoring input clear.
              const evidence = formatChallengeEvidence(challengeSignals, job.title || job.url);
              logger.warn(`[BrowserScraper] ${overlayBase.srcName}: detail enrichment challenged; retaining list rows and stopping detail pass (${evidence})`);
              recordManualScraperTelemetry({
                phase: 'detail-challenge', srcName: overlayBase.srcName,
                key: (job.title || job.url || '?').slice(0, 80),
                reason: challengeSignals?.reason, title: challengeSignals?.title,
              }, { updateActive: false });
              recordManualScraperTelemetry({
                phase: 'desc-miss', srcName: overlayBase.srcName,
                key: `${(job.title || job.url || '?').slice(0, 65)} | detail challenge`,
              }, { updateActive: false });
              descWarning ||= {
                code: 'description-detail-challenge', severity: 'warn',
                evidence: `${overlayBase.srcName} challenged the background detail fetch at "${job.title || 'an untitled listing'}". Relevant listing rows were retained, but this and later rows may lack full descriptions.`,
                suggestion: `Open ${overlayBase.srcName} in a normal Chrome tab, complete any verification, then run the search again for full descriptions.`,
              };
              // The break below is deliberate (see comment above) — it must stay so
              // we don't intensify a session-level block. But it is otherwise SILENT
              // about its blast radius: every job after this one keeps its list-time
              // empty snippet with no telemetry of its own, so a later empty-
              // description row at scoring time is unattributable to this abort. Log
              // the remaining count (from this loop's own position — not re-derived)
              // plus a few sample titles so that row can be traced back here.
              const unexpandedCount = enhanced.length - (i + 1);
              const unexpandedSample = enhanced
                .slice(i + 1, i + 1 + 3)
                .map(j => (j?.title || j?.url || '?').slice(0, 65))
                .join(', ');
              recordManualScraperTelemetry({
                phase: 'desc-miss', srcName: overlayBase.srcName,
                key: `${unexpandedCount} unexpanded after abort | ${unexpandedSample || 'none'}`,
              }, { updateActive: false });
              break;
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
                const elapsedSec = Math.floor((Date.now() - descChallengeStart) / 1000);
                logger.info(`[BrowserScraper] ${overlayBase.srcName}: still waiting for description-expansion challenge solve (${elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m${elapsedSec % 60}s`} elapsed)`);
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

          if (isUnavailableDetailPage(pageInfo)) {
            const reason = pageInfo.workdayPostingAvailable === false
              ? 'workday-posting-unavailable'
              : 'detail-page-not-found';
            logger.info(`[BrowserScraper] ${overlayBase.srcName} dropped unavailable detail listing "${job.title || job.url || '?'}" (${reason})`);
            recordManualScraperTelemetry({
              phase: 'detail-unavailable', srcName: overlayBase.srcName,
              key: `${(job.title || job.url || '?').slice(0, 65)} | unavailable listing`,
              reason, status: navigationStatus,
              expectedUrl: viewUrl.slice(0, 240), finalUrl: fetchPage.url().slice(0, 240),
            }, { updateActive: false });
            enhanced[i] = null;
            continue;
          }

          const isExternalZipDetail = sourceId === 'ziprecruiter' && await fetchPage.evaluate(() => {
            const host = location.hostname.toLowerCase();
            return host !== 'ziprecruiter.com' && !host.endsWith('.ziprecruiter.com');
          }).catch(() => false);

          // Try JSON-LD JobPosting.description first (server-rendered, selector-free).
          // Fall back to __NEXT_DATA__ pageProps probe, then CSS panelSelector.
          // Also harvest `datePosted` from the same JobPosting block — some list
          // extractors (e.g. ZipRecruiter's ItemList) carry no date, so the
          // per-job posting page is the only place to recover it.
          let text = '';
          let descriptionCapture = '';
          let jsonLdDate = '';
          let jsonLdSalary = ''; // formatted pay from JobPosting.baseSalary (if present)
          let jsonLdCompany = ''; // hiringOrganization.name backfill (if present)
          if (isExternalZipDetail) {
            // User-authorized shallow external enrichment: retain the complete
            // rendered page context for this exact URL, then immediately move
            // on. Do not inspect, click, fill, log in, or submit its form.
            text = await fetchPage.evaluate(() => (document.body?.innerText || '').trim()).catch(() => '');
            if (text) {
              descriptionCapture = 'external-page-full-text';
              recordManualScraperTelemetry({
                phase: 'detail-external-page-text', sourceId, srcName: overlayBase.srcName,
                itemIndex: i + 1, itemTotal: enhanced.length,
                key: (job.title || job.url || '?').slice(0, 80),
                url: fetchPage.url().slice(0, 240),
              }, { updateActive: false });
            }
          }
          if (cfg.jsonLdType && !isExternalZipDetail) {
            const ld = await fetchPage.evaluate((type, field, datePattern) => {
              let desc = '';
              let datePosted = '';
              let baseSalary = null; // schema.org JobPosting.baseSalary (employer-stated pay)
              let company = ''; // schema.org JobPosting.hiringOrganization (Organization or bare Text)
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
                // hiringOrganization is typed Organization|Text — some feeds emit the
                // bare company name as a string, most nest it under `.name`.
                if (!company && d.hiringOrganization) {
                  const org = d.hiringOrganization;
                  const name = typeof org === 'string' ? org : (org && typeof org === 'object' ? org.name : '');
                  if (name && String(name).trim()) company = String(name).trim();
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
              return { desc, datePosted, baseSalary, company };
            }, cfg.jsonLdType, cfg.jsonLdField, POSTED_DATE_PATTERN).catch(() => ({ desc: '', datePosted: '', baseSalary: null, company: '' }));
            text = ld.desc;
            if (text) descriptionCapture = 'json-ld-job-description';
            jsonLdDate = ld.datePosted;
            jsonLdSalary = formatJsonLdSalary(ld.baseSalary);
            jsonLdCompany = ld.company;
          }
          // __NEXT_DATA__ fallback: walk a dot-separated field path into pageProps.
          if (!text && cfg.nextDataField && !isExternalZipDetail) {
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
            if (text) descriptionCapture = 'next-data-job-description';
          }
          if (!text && !isExternalZipDetail) {
            text = await fetchPage.evaluate(sel => {
              return document.querySelector(sel)?.innerText?.trim() || '';
            }, cfg.panelSelector).catch(() => '');
            if (text) descriptionCapture = 'detail-page-description';
          }
          if (!text && !isExternalZipDetail) {
            // Structural fallback: find "Job description" heading and grab next sibling.
            text = await fetchPage.evaluate(() => {
              for (const h of document.querySelectorAll('h2, h3')) {
                if (h.textContent?.trim() === 'Job description') {
                  return h.nextElementSibling?.innerText?.trim() || '';
                }
              }
              return '';
            }).catch(() => '');
            if (text) descriptionCapture = 'detail-page-description';
          }
          if (!text && !isExternalZipDetail) {
            // Some detail pages hydrate their visible description shortly after
            // DOMContentLoaded. Wait for ANY supported carrier, not only the CSS
            // panel: React/Next pages can inject JSON-LD or __NEXT_DATA__ first.
            // The wait stays bounded and never reloads a rate-limited page.
            const descriptionReady = await fetchPage.waitForFunction((sel, jsonLdType, jsonLdField, nextDataField) => {
              const matchesType = (value) => Array.isArray(value) ? value.includes(jsonLdType) : value === jsonLdType;
              if (jsonLdType && jsonLdField) {
                for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
                  try {
                    const parsed = JSON.parse(script.textContent);
                    const roots = Array.isArray(parsed) ? parsed : [parsed];
                    for (const root of roots) {
                      const nodes = [root, ...(Array.isArray(root?.['@graph']) ? root['@graph'] : [])];
                      if (nodes.some(node => node && matchesType(node['@type']) && String(node[jsonLdField] || '').trim())) return true;
                    }
                  } catch { /* malformed JSON-LD; continue to visible carriers */ }
                }
              }
              if (nextDataField) {
                try {
                  let node = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null');
                  for (const part of nextDataField.split('.')) node = node?.[part];
                  if (typeof node === 'string' && node.trim()) return true;
                } catch { /* absent/partial Next hydration */ }
              }
              const panel = document.querySelector(sel);
              if ((panel?.innerText || '').trim()) return true;
              return [...document.querySelectorAll('h2, h3')].some(h =>
                /^job description$/i.test(h.textContent?.trim() || '')
                && (h.nextElementSibling?.innerText || '').trim());
            }, { timeout: DETAIL_DESCRIPTION_WAIT_MS }, cfg.panelSelector, cfg.jsonLdType || '', cfg.jsonLdField || '', cfg.nextDataField || '')
              .then(() => true)
              .catch(() => false);
            const delayed = await fetchPage.evaluate((sel, jsonLdType, jsonLdField, nextDataField) => {
              const asText = (html) => {
                const tmp = document.createElement('div');
                tmp.innerHTML = String(html || '');
                return tmp.innerText?.trim() || '';
              };
              const matchesType = (value) => Array.isArray(value) ? value.includes(jsonLdType) : value === jsonLdType;
              if (jsonLdType && jsonLdField) {
                for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
                  try {
                    const parsed = JSON.parse(script.textContent);
                    const roots = Array.isArray(parsed) ? parsed : [parsed];
                    for (const root of roots) {
                      const nodes = [root, ...(Array.isArray(root?.['@graph']) ? root['@graph'] : [])];
                      for (const node of nodes) {
                        if (node && matchesType(node['@type']) && node[jsonLdField]) {
                          const value = asText(node[jsonLdField]);
                          if (value) return { text: value, source: 'json-ld' };
                        }
                      }
                    }
                  } catch { /* malformed JSON-LD; continue to visible carriers */ }
                }
              }
              if (nextDataField) {
                try {
                  let node = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null');
                  for (const part of nextDataField.split('.')) node = node?.[part];
                  const value = typeof node === 'string' ? asText(node) : '';
                  if (value) return { text: value, source: 'next-data' };
                } catch { /* absent/partial Next hydration */ }
              }
              const panel = document.querySelector(sel);
              if (panel?.innerText?.trim()) return { text: panel.innerText.trim(), source: 'selector' };
              for (const h of document.querySelectorAll('h2, h3')) {
                if (/^job description$/i.test(h.textContent?.trim() || '')) {
                  const value = h.nextElementSibling?.innerText?.trim() || '';
                  if (value) return { text: value, source: 'heading' };
                }
              }
              return { text: '', source: '' };
            }, cfg.panelSelector, cfg.jsonLdType || '', cfg.jsonLdField || '', cfg.nextDataField || '')
              .catch(() => ({ text: '', source: '' }));
            text = delayed.text;
            if (text) {
              descriptionCapture = delayed.source === 'json-ld'
                ? 'json-ld-job-description'
                : delayed.source === 'next-data'
                  ? 'next-data-job-description'
                  : 'detail-page-description';
              recordManualScraperTelemetry({
                phase: 'detail-description-ready',
                sourceId,
                srcName: overlayBase.srcName,
                itemIndex: i + 1,
                itemTotal: enhanced.length,
                descriptionSource: delayed.source,
              });
            } else if (!descriptionReady) {
              recordManualScraperTelemetry({
                phase: 'detail-description-timeout',
                sourceId,
                srcName: overlayBase.srcName,
                itemIndex: i + 1,
                itemTotal: enhanced.length,
              });
            }
          }
          // DOM salary fallback (ZipRecruiter): pay is rendered CLIENT-SIDE as an
          // "Estimated pay" chip — not in JSON-LD, not in the search ItemList — so it
          // can only be read from the live DOM. Match by money TEXT pattern (robust
          // to ZR's churning Tailwind classes). Bounded wait: resolves instantly once
          // the chip hydrates (the common case, since ZR estimates ~every job); only
          // a genuinely pay-less page pays the full timeout.
          if (cfg.salaryFromDom && !jsonLdSalary && !isExternalZipDetail) {
            // The cadence must be captured, not just tolerated: ZipRecruiter's chip
            // renders it as a WORD ("$19 Hourly", "$71K Annually") at least as often
            // as a slash ("$36.29/hr"), and the old pattern only listed the slash
            // forms — so a live run recorded four ZR jobs as a bare "$19"/"$20"/
            // "$18.15"/"$1.0K" with no unit, which downstream reads as an annual
            // salary of nineteen dollars. Word forms are alternated in here; the
            // suffix stays optional so a genuinely unit-less chip still yields the
            // amount (parseSalaryToNumeric then refuses to annualize it).
            await fetchPage.waitForFunction((src) => {
              const re = new RegExp(src, 'i');
              return [...document.querySelectorAll('p')].some(p => re.test(p.textContent || ''));
            }, { timeout: 1500 }, ZIPRECRUITER_MONEY_SRC).catch(() => {});
            jsonLdSalary = await fetchPage.evaluate((src) => {
              const re = new RegExp(src, 'i');
              for (const p of document.querySelectorAll('p')) {
                const t = (p.textContent || '').trim();
                // Bound generous enough for "$17.60 - $22.00 Per hour" now that
                // word-form cadences are matched, still tight enough that a whole
                // paragraph mentioning a dollar figure can't qualify as the chip.
                if (t.length <= 60 && re.test(t)) { const m = t.match(re); return (m && m[0].trim()) || ''; }
              }
              return '';
            }, ZIPRECRUITER_MONEY_SRC).catch(() => '');
          }
          // Record every partial row in the dedicated anomaly ring. The rich page
          // context below remains first-only so one degraded batch cannot crowd out
          // all other telemetry, but this lightweight row preserves exact affected
          // titles even when later source phases push old events out of the tail.
          if (!text) {
            recordManualScraperTelemetry({
              phase: 'desc-miss', srcName: overlayBase.srcName,
              key: `${(job.title || job.url || '?').slice(0, 65)} | empty JD`,
              reason: 'all-description-carriers-empty',
              status: navigationStatus,
              expectedUrl: viewUrl.slice(0, 240),
              finalUrl: fetchPage.url().slice(0, 240),
            }, { updateActive: false });
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
          if (!text && !descWarning) {
            // The listing remains useful/relevant, but the scoring input is
            // incomplete. Report this explicitly instead of treating the source as
            // clean merely because list extraction succeeded.
            descWarning = {
              code: 'description-detail-miss', severity: 'warn',
              evidence: `${overlayBase.srcName} could not recover a full description for "${job.title || 'an untitled listing'}" after its bounded detail-page wait. The listing was retained with its available list fields.`,
              suggestion: `Retry ${overlayBase.srcName} later or open the listing directly; the board may have delayed or restricted the detail page.`,
            };
          }
          // A ZipRecruiter estimated-pay chip can be internally contradictory
          // ("$65K/hr") even when the detail JD states the actual annual base
          // salary. Reconcile that at the source boundary, before the raw value
          // reaches scoring/cards/taxonomy. Other sources keep their original
          // stated/list salary untouched.
          const sourceSalary = job.salary || jsonLdSalary;
          const reconciledSalary = cfg.salaryFromDom
            ? reconcileZipRecruiterDomSalary(sourceSalary, text)
            : sourceSalary;
          const salaryChanged = cfg.salaryFromDom && reconciledSalary !== sourceSalary;
          // Detail fields are independent. Always merge them so a description miss
          // cannot suppress a recovered posted date (the prior `text || salary`
          // guard caused exactly that ZipRecruiter loss).
          enhanced[i] = mergeExpandedJobDetail(job, {
            text,
            descriptionCapture,
            jsonLdDate,
            jsonLdSalary,
            salaryChanged,
            reconciledSalary,
            jsonLdCompany,
          });
          if (text) expandedCount++;
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
              // See the matching desc-miss comment above — structural record so this
              // survives the ring buffer, not just the console.
              recordManualScraperTelemetry({
                phase:   'date-miss',
                srcName: overlayBase.srcName,
                key:     `${(job.title || job.url || '?').slice(0, 50)} | ld=${dateDiag.ldTypes.length}`,
              }, { updateActive: false });
            }
          }
        } catch (error) {
          // Per-listing navigation errors are non-fatal; keep the batch moving.
          const reason = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 180);
          logger.warn(`[BrowserScraper] ${overlayBase.srcName} detail extraction failed for "${job.title || job.url || '?'}": ${reason}`);
          recordManualScraperTelemetry({
            phase: 'desc-miss', srcName: overlayBase.srcName,
            key: `${(job.title || job.url || '?').slice(0, 65)} | detail extraction error`,
            reason: 'detail-operation-error',
            error: reason,
            expectedUrl: viewUrl.slice(0, 240),
            finalUrl: fetchPage.url().slice(0, 240),
          }, { updateActive: false });
          descWarning ||= {
            code: 'description-detail-error', severity: 'warn',
            evidence: `${overlayBase.srcName} could not read the detail page for "${job.title || 'an untitled listing'}". The listing was retained with its available list fields.`,
            suggestion: `Retry ${overlayBase.srcName} later or open the listing directly; the detail page may have changed or failed while loading.`,
          };
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
    return { jobs: enhanced.filter(Boolean), descError: null, descWarning, expandedCount };
  }

  // Start from empty so the first card's already-visible description is captured
  // on the first click rather than mistaken for "no change" and skipped.
  let prevPanelText = '';
  let consecutiveClickFails    = 0;
  let consecutivePanelTimeouts = 0;
  let descError = null;
  let expandedCount = 0;
  let attemptedCount = 0;
  let missingCount = 0;
  let panelTimeoutCount = 0;
  let selectionMismatchCount = 0;
  const failureSamples = [];
  const firstTransitionSamples = [];
  const lastTransitionSamples = [];
  const mismatchTransitionSamples = [];
  const selectionMismatchSamples = [];
  let interruptedAt = null;
  const rememberCardWalkFailure = (itemIndex, key, reason) => {
    if (failureSamples.length < 6) {
      failureSamples.push({ itemIndex, key: String(key || '?').slice(0, 80), reason });
    }
  };
  // A full successful-card trace would make reports scale with result count.
  // Keep the opening, trailing, and suspicious transitions instead: together
  // they prove whether the browser started and ended on the intended card, and
  // preserve every observed wrong-card hit within a small cap.
  const rememberCardTransition = (sample) => {
    if (firstTransitionSamples.length < 3) firstTransitionSamples.push(sample);
    lastTransitionSamples.push(sample);
    if (lastTransitionSamples.length > 3) lastTransitionSamples.shift();
    if (sample.mismatch && mismatchTransitionSamples.length < 6) {
      mismatchTransitionSamples.push(sample);
    }
  };
  const rememberTransitionMismatch = (sample) => {
    if (mismatchTransitionSamples.length < 6
      && !mismatchTransitionSamples.some(current => current.itemIndex === sample.itemIndex)) {
      mismatchTransitionSamples.push(sample);
    }
  };
  const rememberSelectionMismatch = (sample) => {
    if (selectionMismatchSamples.length < 6) selectionMismatchSamples.push(sample);
  };

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

  // preloadContent already exposes the complete Google list before extraction.
  // A separate reveal walk duplicated the visible selection sequence, making it
  // look like cards were skipped even though the later click pass was ordered.
  // Target and scroll each card only when it is about to be clicked.
  for (let i = 0; i < enhanced.length; i++) {
    const clickPause = await waitIfPaused(page, signal);
    if (clickPause === 'abort') {
      interruptedAt = i + 1;
      break;
    }

    const job = enhanced[i];
    const physicalIndex = Number.isFinite(Number(physicalIndexes[i]))
      ? Number(physicalIndexes[i])
      : i + 1;

    const key = cardTargets[i]?.key;
    if (!key) {
      missingCount++;
      rememberCardWalkFailure(i + 1, job.title || job.url, 'missing-card-key');
      continue;
    }
    attemptedCount++;

    await updateOverlay(page, {
      ...overlayBase,
      count:  baseCount + i + 1,
      status: `Opening result card ${i + 1}/${enhanced.length} · result ${physicalIndex}/${physicalTotal}`,
    });

    try {
      // Scroll card into view and get coordinates for a real mouse click.
      // Real mouse events are reliably intercepted by the SPA's React event handlers;
      // untrusted DOM .click() may not be and can follow the raw href instead.
      const clickTarget = await page.evaluate(async (cardAttr, cardIdPrefix, cardHrefKey, cardDataUrlParam, clickSel, k, expectedTitle) => {
        const cardKey = (el) => {
          if (!el) return '';
          const resultCard = el.matches?.('[data-share-url]') ? el : el.closest?.('[data-share-url]');
          if (resultCard && cardDataUrlParam) {
            try {
              return new URL(resultCard.getAttribute('data-share-url') || '', location.href)
                .searchParams.get(cardDataUrlParam) || '';
            } catch { /* fall through to a matching id */ }
          }
          return el.id === k ? k : '';
        };
        const cardTitle = (el) => {
          const resultCard = el?.matches?.('[data-share-url]') ? el : el?.closest?.('[data-share-url]');
          return (resultCard?.querySelector('.tNxQIb, [role="heading"], h3')?.textContent || '').trim().slice(0, 120);
        };
        const empty = (extra = {}) => ({ ok: false, expectedKey: k, expectedTitle, resolvedKey: '', resolvedTitle: '', hitKey: '', hitTitle: '', mismatch: true, ...extra });
        let card = null;
        let resultCard = null;
        let lookup = 'primary';

        // Google virtualizes result rows. Its id can survive on a stale/recycled
        // element, so the immutable htidocid carried by the result-card URL is
        // the primary identity; id is only the compatibility fallback.
        if (cardDataUrlParam) {
          resultCard = Array.from(document.querySelectorAll('[data-share-url]')).find((el) => {
            try {
              return new URL(el.getAttribute('data-share-url') || '', location.href)
                .searchParams.get(cardDataUrlParam) === k;
            } catch { return false; }
          }) || null;
          if (resultCard) {
            const descendants = [resultCard, ...resultCard.querySelectorAll('[role="button"], [id]')];
            card = descendants.find(el => el.matches?.('[role="button"]') && el.id === k)
              || descendants.find(el => el.matches?.('[role="button"]'))
              || descendants.find(el => el.id === k)
              || resultCard;
            lookup = 'data-share-url';
          }
        }
        if (!card && cardAttr) {
          card = document.querySelector(`[${cardAttr}="${k}"]`) || document.querySelector(`a[href*="${k}"]`);
        } else if (!card && cardHrefKey != null) {
          card = document.querySelector(`a[href*="${cardHrefKey}${k}-"]`);
        } else if (!card) {
          card = document.getElementById((cardIdPrefix || '') + k);
          if (card) lookup = 'id-fallback';
        }
        if (!card) return empty({ lookup: 'missing' });
        const target = clickSel ? card.querySelector(clickSel) : card;
        if (!target) return empty({ lookup, resolvedKey: cardKey(card), resolvedTitle: cardTitle(card) });
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const rect = target.getBoundingClientRect();
        if (!rect.width || !rect.height) return empty({ lookup, resolvedKey: cardKey(card), resolvedTitle: cardTitle(card) });
        const x = rect.left + Math.min(rect.width - 1, Math.max(1, rect.width * 0.35));
        const y = rect.top + Math.min(rect.height - 1, Math.max(1, rect.height * 0.5));
        const hit = document.elementFromPoint(x, y);
        const resolvedKey = cardKey(card) || cardKey(resultCard);
        const hitKey = cardKey(hit);
        const resolvedTitle = cardTitle(card) || cardTitle(resultCard);
        const hitTitle = cardTitle(hit);
        const mismatch = resolvedKey !== k || hitKey !== k;
        return {
          ok: !mismatch,
          lookup,
          x,
          y,
          expectedKey: k,
          expectedTitle,
          resolvedKey,
          resolvedTitle,
          hitKey,
          hitTitle,
          mismatch,
        };
      }, cfg.cardAttr ?? null, cfg.cardIdPrefix ?? null, cfg.cardHrefKey ?? null, cfg.cardDataUrlParam ?? null, cfg.clickSelector ?? null, key, String(job.title || '').slice(0, 120))
        .catch(() => ({ ok: false }));

      const transitionSample = {
        itemIndex: i + 1,
        physicalIndex,
        physicalTotal,
        expectedKey: key.slice(0, 80),
        expectedTitle: String(clickTarget.expectedTitle || job.title || '').slice(0, 120),
        lookup: clickTarget.lookup || 'evaluation-error',
        resolvedKey: String(clickTarget.resolvedKey || '').slice(0, 80),
        resolvedTitle: String(clickTarget.resolvedTitle || '').slice(0, 120),
        hitKey: String(clickTarget.hitKey || '').slice(0, 80),
        hitTitle: String(clickTarget.hitTitle || '').slice(0, 120),
        mismatch: clickTarget.mismatch !== false,
        selectedTitle: '',
        selectionVerified: false,
        selectionMismatch: false,
      };
      rememberCardTransition(transitionSample);

      if (!clickTarget.ok) {
        missingCount++;
        const reason = clickTarget.mismatch ? 'card-hit-mismatch' : 'card-not-in-dom';
        rememberCardWalkFailure(i + 1, key, reason);
        recordManualScraperTelemetry({
          phase:     'detail-card-miss',
          sourceId,
          srcName:   overlayBase.srcName,
          itemIndex: i + 1,
          itemTotal: enhanced.length,
          key:       key.slice(0, 80),
          reason,
        }, { updateActive: false });
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
      if (clickTarget.lookup === 'id-fallback') {
        recordManualScraperTelemetry({
          phase:     'detail-card-recovered',
          sourceId,
          srcName:   overlayBase.srcName,
          itemIndex: i + 1,
          itemTotal: enhanced.length,
          key:       key.slice(0, 80),
          reason:    'id-fallback',
        }, { updateActive: false });
      }

      await page.mouse.move(clickTarget.x, clickTarget.y).catch(() => {});
      await page.mouse.click(clickTarget.x, clickTarget.y, { delay: humanDelay(80) }).catch(() => {});

      const pollPanel = async () => {
        const dl = Date.now() + DESC_CHANGE_TIMEOUT_MS;
        while (Date.now() < dl) {
          await new Promise(r => setTimeout(r, DESC_CHANGE_POLL_MS));
          const text = await page.evaluate((panelSel, panelMulti) => {
            if (panelMulti) {
              return Array.from(document.querySelectorAll(panelSel))
                // Google leaves old/preloaded panels mounted. CSS-hidden .ejCXj
                // continuations in the active aria-hidden=false panel remain
                // valid, but nothing below an aria-hidden=true panel may count.
                .filter(e => e.matches('span') && !e.closest('[aria-hidden="true"]'))
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

      // The list-card htidocid check above proves where the click landed. Google
      // can still lag its detail panel, so validate the active panel heading as
      // a second independent identity before accepting text into this job. A
      // missing heading is tolerated (markup varies); an explicit different
      // heading is not.
      const readSelectedGoogleTitle = () => page.evaluate((expectedTitle) => {
        const activeRoots = Array.from(document.querySelectorAll('[aria-hidden="false"]'));
        const headings = activeRoots.flatMap(region => Array.from(region.querySelectorAll('h1, h2, h3, [role="heading"]')))
          .filter(el => !el.closest('[aria-hidden="true"]'))
          .filter(el => !el.closest('[data-share-url]'))
          .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const expected = String(expectedTitle || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
        return headings.find((heading) => {
          const value = heading.toLocaleLowerCase();
          return expected && (value === expected || value.includes(expected) || expected.includes(value));
        }) || headings[0] || '';
      }, job.title).catch(() => '');
      let selectedTitle = sourceId === 'google' ? await readSelectedGoogleTitle() : '';
      let selectionAssessment = assessDetailSelection(job.title, selectedTitle);
      // Google can paint the new description before replacing the old detail
      // heading. An explicit mismatch is meaningful only after a short settle
      // window; an absent heading is intentionally unverified and accepted.
      if (sourceId === 'google' && selectionAssessment.selectionMismatch) {
        const selectionDeadline = Date.now() + 1000;
        while (Date.now() < selectionDeadline) {
          await new Promise(r => setTimeout(r, 160));
          selectedTitle = await readSelectedGoogleTitle();
          selectionAssessment = assessDetailSelection(job.title, selectedTitle);
          if (!selectionAssessment.selectionMismatch) break;
        }
      }
      transitionSample.selectedTitle = selectionAssessment.selectedTitle.slice(0, 120);
      transitionSample.selectionVerified = selectionAssessment.selectionVerified;
      transitionSample.selectionMismatch = selectionAssessment.selectionMismatch;
      if (selectionAssessment.selectionMismatch) {
        selectionMismatchCount++;
        // Selection identity failures are every bit as important as a wrong
        // list-card hit. Preserve the rich expected→hit transition even when
        // it occurs in the otherwise-unsampled middle of a long walk.
        rememberTransitionMismatch(transitionSample);
        rememberSelectionMismatch({
          itemIndex: i + 1,
          physicalIndex,
          physicalTotal,
          expectedTitle: String(job.title || '').slice(0, 120),
          selectedTitle: selectionAssessment.selectedTitle.slice(0, 120),
        });
        // The panel explicitly identifies another job, so it is unsafe to
        // merge this text even if it changed from the previous panel.
        panelText = null;
      }

      let gotDescription = false;
      if (panelText) {
        enhanced[i] = { ...job, snippet: panelText };
        prevPanelText = panelText;
        gotDescription = true;
        expandedCount++;
      }

      if (gotDescription) {
        consecutivePanelTimeouts = 0;
      } else {
        panelTimeoutCount++;
        rememberCardWalkFailure(i + 1, key, selectionAssessment.selectionMismatch ? 'detail-title-mismatch' : 'panel-timeout');
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

  // A single bounded batch summary is much more useful than the old
  // snippet-derived “N/N expanded” line: Google list rows already contain an
  // employment-type snippet, so they could look expanded even after card
  // targeting had failed. Keep it out of active telemetry so it cannot replace
  // the source terminal phase in diagnostics.
  const transitionSamplesByIndex = new Map();
  for (const sample of [
    ...firstTransitionSamples,
    ...mismatchTransitionSamples,
    ...lastTransitionSamples,
  ]) {
    const current = transitionSamplesByIndex.get(sample.itemIndex);
    // A mismatch is more useful than a duplicate success record for the same
    // target (and should retain the richer hit metadata if both exist).
    if (!current || sample.mismatch) transitionSamplesByIndex.set(sample.itemIndex, sample);
  }
  const aborted = Boolean(signal?.aborted);
  if (aborted && interruptedAt == null && attemptedCount < enhanced.length) {
    interruptedAt = attemptedCount + 1;
  }
  recordManualScraperTelemetry({
    phase:         'card-walk',
    sourceId,
    srcName:        overlayBase.srcName,
    queryIndex:     overlayBase.queryIndex ?? null,
    queryTotal:     overlayBase.queryTotal ?? null,
    pageNum:        overlayBase.pageNum ?? null,
    total:          enhanced.length,
    itemTotal:      enhanced.length,
    attempted:      attemptedCount,
    expanded:       expandedCount,
    missing:        missingCount,
    panelTimeouts:  panelTimeoutCount,
    selectionMismatches: selectionMismatchCount,
    selectionMismatchSamples,
    failureSamples,
    transitionSamples: [...transitionSamplesByIndex.values()].sort((a, b) => a.itemIndex - b.itemIndex),
    aborted,
    interruptedAt,
    abortReason: aborted ? 'user-cancelled' : null,
    physicalTotal,
  }, { updateActive: false });

  return {
    jobs: enhanced,
    descError,
    expandedCount,
    attemptedCount,
    missingCount,
    panelTimeoutCount,
    selectionMismatchCount,
  };
}

/**
 * Enrich jobs extracted inside a visible captcha-resolve window before that
 * browser is closed. The ordinary scrape path calls expandDescriptions after
 * every list-page extraction; resolve-job-source must do the same or a
 * Glassdoor DOM-list fallback (whose snippets are intentionally empty) reaches
 * scoring without any job descriptions.
 *
 * The resolve window already owns/pauses the shared browser pool. This helper
 * works directly with its Puppeteer page and therefore must not try to acquire
 * another browser or shared-profile lease.
 */
export async function enrichResolvedJobDescriptions(page, jobs, sourceId, signal = null) {
  const list = Array.isArray(jobs) ? jobs : [];
  const srcName = SOURCE_LABELS[sourceId] || sourceId || 'Job source';
  const overlayBase = {
    srcLabel: 'Resolved source',
    srcName,
    qLabel: 'Recovered results',
    qText: '',
  };
  return expandDescriptions(page, list, sourceId, overlayBase, list.length, signal);
}

// ── Next-page clicker ─────────────────────────────────────────────────────────
// Inspect a conventional next-page control independently of each source's
// configured selector. This is deliberately narrow: a visible, enabled control
// whose accessible text/title says "next page" is strong evidence that stopping
// here would silently truncate a paginated search. It lets us surface selector
// drift as an actionable warning instead of treating page 1 as a clean finish.
async function inspectNextPageControl(page) {
  try {
    return await page.evaluate(() => {
      const normalized = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const candidate = [...document.querySelectorAll('a, button')].find((el) => {
        const label = normalized([
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.textContent,
          el.querySelector('svg title, img[alt]')?.textContent || el.querySelector('img')?.getAttribute('alt'),
        ].filter(Boolean).join(' '));
        const style = window.getComputedStyle(el);
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
        return !disabled && style.display !== 'none' && style.visibility !== 'hidden' &&
          /\bnext\s+page\b/.test(label);
      });
      if (!candidate) return null;
      return {
        label: String(candidate.getAttribute('aria-label') || candidate.getAttribute('title') || candidate.textContent || 'Next page').replace(/\s+/g, ' ').trim(),
        href: candidate instanceof HTMLAnchorElement ? candidate.href : null,
      };
    });
  } catch {
    return null;
  }
}

// Returns the click result plus any enabled next-page control that remains
// unhandled. Callers must never collapse the latter into a normal completion.
async function clickNextPage(page, sourceId) {
  const sel = NEXT_PAGE_SELECTORS[sourceId];
  if (!sel) return { clicked: false, unhandled: await inspectNextPageControl(page) };
  try {
    const clicked = await page.evaluate((s) => {
      const btn = document.querySelector(s);
      if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
      btn.click();
      return true;
    }, sel);
    return { clicked, unhandled: clicked ? null : await inspectNextPageControl(page) };
  } catch {
    return { clicked: false, unhandled: await inspectNextPageControl(page) };
  }
}

// ── Pre-loader for scroll sources ─────────────────────────────────────────────
// Scrolls until the source reaches its remaining per-platform job allowance, or
// its configured reveal/page ceiling. Used for sources without traditional
// pagination and called before extraction sees the fully loaded set.
//
// A parallel "click a Load More button" strategy existed here as dead code:
// it was gated on a LOAD_MORE_SELECTORS map that was always `{}` (no source
// was ever configured), meaning any source actually needing that strategy
// silently got NO preload at all rather than a working fallback — worse than
// having no such feature, since it looked supported. Removed rather than
// guessing a selector for a source we can't verify; add it back with a real,
// verified selector if a specific source needs it.
async function preloadContent(page, sourceId, extractorJS, overlayBase, signal, { maxPages, jobsPerPlatform, existingJobs = 0 }) {
  const isScroll = SCROLL_SOURCES.has(sourceId);
  if (!isScroll) return;

  let prevCount = -1;
  let iterations = 0;
  while (true) {
    if (signal?.aborted) break;
    // Ceiling on top of the "count stopped increasing" exit below. A source
    // that trickles in one marginally-new item per reveal action forever would
    // otherwise never plateau exactly.
    if (++iterations > maxPages) {
      logger.info(`[BrowserScraper] preloadContent(${sourceId}) hit the ${maxPages}-iteration ceiling — stopping reveal actions`);
      break;
    }
    const raw   = await page.evaluate(extractorJS).catch(() => []);
    const count = countDistinctJobs(raw);
    const target = Number.isFinite(jobsPerPlatform) ? Math.max(0, jobsPerPlatform - existingJobs) : null;
    await updateOverlay(page, { ...overlayBase, status: `Loading jobs… ${count}${target == null ? '' : `/${target}`}` });
    if (target != null && count >= target) break;
    if (count === prevCount) break;  // no new content after last action
    prevCount = count;
    if (isScroll) {
      if (sourceId === 'google') {
        // Google for Jobs renders cards in its own scrollable container inside the page.
        // Walk up from the first card to find that container and scroll it; also
        // scroll document.body so either trigger path gets hit.
        await updateOverlay(page, {
          ...overlayBase,
          status: `Loading the full Google list — not selecting cards yet… ${count}`,
        });
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
 * navigation only on the first-ever use of a given location. A requested
 * location is a safety boundary: failure to resolve or verify it returns a
 * failure object and the caller SKIPS Glassdoor rather than navigating a
 * locKeyword-only (nationwide) URL.
 */
export function glassdoorRequestedCountry(location) {
  const normalized = normalizeLocationInput(location);
  return normalized.countryCode
    ? { iso: normalized.countryCode, countryOnly: normalized.scope === 'country' }
    : null;
}

function glassdoorCandidateLocId(candidate) {
  const rawId = candidate?.locationId ?? candidate?.realId
    ?? (typeof candidate?.id === 'string' ? candidate.id.replace(/^[A-Za-z]/, '') : candidate?.id);
  const locId = rawId != null ? String(rawId).trim() : '';
  return /^\d+$/.test(locId) && Number(locId) > 0 ? locId : null;
}

function glassdoorCandidateText(candidate) {
  return [
    candidate?.longName, candidate?.label, candidate?.name,
    candidate?.countryName, candidate?.country?.name,
  ].filter(Boolean).join(' ').toLowerCase();
}

function glassdoorCandidateCountryIso(candidate) {
  const raw = candidate?.country2LetterIso ?? candidate?.countryCode
    ?? candidate?.country?.country2LetterIso ?? candidate?.country?.code;
  if (typeof raw === 'string' && /^[a-z]{2}$/i.test(raw.trim())) return raw.trim().toUpperCase();
  // Glassdoor's verified autocomplete response uses countryId=3 for CA and 1
  // for US. Keep the label checks too: the legacy response exposes "(US)"
  // rather than country2LetterIso.
  if (Number(candidate?.countryId) === 3) return 'CA';
  if (Number(candidate?.countryId) === 1) return 'US';
  const text = glassdoorCandidateText(candidate);
  if (/\bcanada\b|\(\s*ca\s*\)/i.test(text)) return 'CA';
  if (/\bunited states(?: of america)?\b|\busa\b|\(\s*us\s*\)/i.test(text)) return 'US';
  return '';
}

function glassdoorTextHasScopeTerm(text, term) {
  const normalized = String(term || '').trim().toLowerCase();
  if (!normalized) return true;
  const esc = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${esc(normalized)}\\b`, 'i').test(text)) return true;
  // Autocomplete labels often abbreviate province/state names ("Toronto, ON")
  // even when the request is written out ("Toronto, Ontario, Canada").
  const subdivisions = { ...US_STATES, ...CA_PROVINCES };
  const compact = normalized.replace(/[^a-z]/g, '');
  const code = Object.hasOwn(subdivisions, compact)
    ? compact
    : Object.entries(subdivisions).find(([, name]) => name.replace(/\s/g, '') === compact)?.[0];
  if (!code) return false;
  const fullName = subdivisions[code];
  return new RegExp(`(?:\\b${esc(fullName)}\\b|(?:^|[,(/])\\s*${esc(code)}(?=$|[, )]))`, 'i').test(text);
}

export function validateGlassdoorLocationPick(picked, results, location) {
  if (!picked?.locId || !/^\d+$/.test(String(picked.locId))) return 'returned no positive numeric location ID';
  const candidate = results.find(item => glassdoorCandidateLocId(item) === String(picked.locId));
  if (!candidate) return 'returned a location ID that was not present in the autocomplete response';

  const requestedCountry = glassdoorRequestedCountry(location);
  const candidateCountry = glassdoorCandidateCountryIso(candidate);
  if (requestedCountry) {
    if (!candidateCountry) return `could not verify the selected result belongs to ${requestedCountry.iso}`;
    if (candidateCountry !== requestedCountry.iso) return `selected ${candidateCountry}, but the requested country is ${requestedCountry.iso}`;
    // Country-only searches must select the actual country object (Glassdoor's
    // current autocomplete identifies it as N), never a similarly-named city.
    if (requestedCountry.countryOnly && String(candidate.locationType || picked.locT || '').toUpperCase() !== 'N') {
      return 'selected a non-country autocomplete result for a country-only search';
    }
  }

  const normalizedLocation = normalizeLocationInput(location);
  const scopedTerms = [normalizedLocation.city, normalizedLocation.subdivision].filter(Boolean);
  const candidateText = glassdoorCandidateText(candidate);
  for (const term of scopedTerms) {
    if (!glassdoorTextHasScopeTerm(candidateText, term)) return `selected result does not match requested scope term "${term}"`;
  }
  return null;
}

export function glassdoorUrlHasLocationId(url, locId) {
  const id = String(locId || '').trim();
  if (!/^\d+$/.test(id)) return false;
  try {
    const parsed = new URL(url);
    return new RegExp(`_IN${id}(?:_|[.-]|$)`, 'i').test(decodeURIComponent(parsed.pathname));
  } catch {
    return false;
  }
}

function glassdoorAutocompleteRows(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['data', 'results', 'locations', 'suggestions']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

// Glassdoor's autocomplete answering with a server-side failure says nothing
// about whether the requested location exists — it is a transport outcome, not
// a verdict, so it is worth retrying and must never be reported as a spelling
// problem. A well-formed response that simply has no acceptable match IS a
// verdict: retrying it just burns the run's time budget.
const GLASSDOOR_LOOKUP_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524];
const GLASSDOOR_LOOKUP_MAX_ATTEMPTS = 2;   // per endpoint, per host
const GLASSDOOR_LOOKUP_BACKOFF_MS = 800;
const GLASSDOOR_LOOKUP_FETCH_TIMEOUT_MS = 8000;
// Whole-lookup ceiling. A gateway that times out on every attempt must not be
// able to stretch one source's location step past this before we give up.
const GLASSDOOR_LOOKUP_BUDGET_MS = 40_000;

/**
 * True when a recorded lookup attempt failed at the transport layer (server
 * error, refused connection, unparseable body) rather than answering the
 * question. An attempt with no `status` never got a response at all.
 */
export function glassdoorLookupAttemptIsTransient(attempt) {
  if (!attempt) return false;
  if (attempt.rows != null) return false;   // a parsed answer, however empty, is a verdict
  // Reaching here means nothing parseable came back: an unreachable origin, an
  // aborted request, or a 200 carrying something other than the JSON payload
  // (an anti-bot interstitial reads exactly like this).
  if (attempt.error) return true;
  if (!Number.isFinite(Number(attempt.status))) return true;
  return GLASSDOOR_LOOKUP_RETRY_STATUSES.includes(Number(attempt.status));
}

/**
 * Render the attempt trail as observations — "which endpoint returned what" —
 * with no claim about the cause. Repeated identical outcomes collapse to `×N`
 * so a retried lookup stays readable on a source card.
 */
export function summarizeGlassdoorLookupAttempts(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (list.length === 0) return 'no lookup attempt was recorded';
  const order = [];
  const counts = new Map();
  for (const attempt of list) {
    const endpoint = String(attempt?.path || '(unknown endpoint)').split('?')[0];
    const outcome = attempt?.error
      ? String(attempt.error)
      : attempt?.rows != null
        ? `HTTP ${attempt.status} with ${attempt.rows} location(s)`
        : `HTTP ${attempt?.status ?? '?'}`;
    const label = `${attempt?.host ? `${attempt.host}` : ''}${endpoint}→${outcome}`;
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return order.map(label => (counts.get(label) > 1 ? `${label} ×${counts.get(label)}` : label)).join(', ');
}

/**
 * Whether a persisted cache entry is enough proof to skip the live lookup.
 * A locId is a stable platform id, but on its own it is an opaque number: for a
 * country-scoped search it only counts once the entry records the country it
 * was validated against. Entries written before that field existed have no
 * `country` and are deliberately re-resolved unless the resolver can upgrade
 * one of the two exact, known country-root IDs below.
 */
export function glassdoorCachedLocationUsable(cached, location) {
  const locId = String(cached?.locId ?? '').trim();
  if (!/^\d+$/.test(locId) || Number(locId) <= 0) return false;
  const requestedCountry = glassdoorRequestedCountry(location);
  if (!requestedCountry) return true;
  if (cached.country !== requestedCountry.iso) return false;
  // Mirrors validateGlassdoorLocationPick: a country-only search must hold the
  // country object itself, never a similarly-named city inside that country.
  if (requestedCountry.countryOnly && String(cached.locT || '').toUpperCase() !== 'N') return false;
  return true;
}

/**
 * Add provenance to the two stable Glassdoor country-root IDs that the app
 * already knows how to validate from live autocomplete responses. This is
 * intentionally limited to country-only requests and N (nation) entries: a
 * legacy city/province ID remains opaque and must still be resolved live.
 */
export function upgradeGlassdoorCountryRootCache(cached, location) {
  if (!cached || cached.country) return cached;
  const requested = glassdoorRequestedCountry(location);
  if (!requested?.countryOnly || String(cached.locT || '').toUpperCase() !== 'N') return cached;
  const knownRoot = requested.iso === 'CA' ? '3' : requested.iso === 'US' ? '1' : null;
  if (!knownRoot || String(cached.locId || '').trim() !== knownRoot) return cached;
  return { ...cached, country: requested.iso };
}

/**
 * Classify the aggregate outcome separately from retry policy. HTTP 403 is
 * deliberately not retried, but it is still an access denial—not evidence that
 * a human-entered location failed to match.
 */
export function classifyGlassdoorLookupFailure(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (list.some(attempt => attempt?.rows != null)) return 'no-match';
  if (list.some(attempt => [401, 403].includes(Number(attempt?.status)))) return 'access-denied';
  if (list.length > 0 && list.every(attempt => glassdoorLookupAttemptIsTransient(attempt))) return 'transient';
  return 'no-match';
}

/**
 * Word the skip for what was actually observed. A transport failure and an
 * unrecognized location produce the same outcome (Glassdoor is skipped rather
 * than searched nationwide) but call for opposite user actions, and telling
 * someone to check their spelling because a gateway returned 504 sends them
 * hunting a bug that is not theirs.
 */
export function describeGlassdoorLocationFailure({ location, failure, failureKind }) {
  const evidence = `Glassdoor location "${location}" could not be verified: ${failure}. `
    + 'The source was skipped before navigating its locKeyword-only nationwide URL.';
  const suggestion = failureKind === 'transient'
    ? 'Those are Glassdoor-side transport results, not a rejection of the location text — retrying Glassdoor is the fix. '
      + 'Once any location verifies once it is cached with its country, so later runs skip this lookup entirely.'
    : failureKind === 'access-denied'
      ? 'Glassdoor denied the browser lookup before it could answer. This is an anti-bot/session result, not a rejection of the location text. '
        + 'Open Glassdoor in Chrome and clear any human verification, then retry the search.'
    : failureKind === 'rejected'
      ? 'Glassdoor answered, but no result matched the requested location closely enough to be safe to search. '
        + 'Check the preferred location spelling, or use a more specific form (e.g. "Toronto, Ontario, Canada").'
      : failureKind === 'cancelled'
        ? 'The search was stopped before this lookup finished — nothing to correct. Glassdoor will resolve the location on the next run.'
        : 'Check the preferred location spelling and retry Glassdoor. '
          + 'If its location autocomplete is unavailable, use the other country-scoped sources for this run.';
  return { evidence, suggestion };
}

/**
 * Park the page on `host` so the autocomplete fetch below is same-origin.
 * The landing host is CONFIRMED rather than assumed: Glassdoor country-redirects
 * (a .com request on a CA account lands on .ca — see the login verify trace), and
 * a relative fetch issued from the wrong origin would silently answer for the
 * wrong market. Settling is polled because one fixed wait races a slow redirect
 * chain, which would report a reachable origin as unreachable.
 */
async function ensureGlassdoorOrigin(page, host) {
  const currentHost = () => {
    try { return new URL(page.url()).hostname.toLowerCase(); } catch { return ''; }
  };
  if (currentHost() === host) return true;
  const originUrl = `https://${host}/Job/index.htm`;
  await page.evaluate(u => { window.location.href = u; }, originUrl).catch(() => {});
  let previous = '';
  for (let settle = 0; settle < 3; settle++) {
    await new Promise(r => setTimeout(r, humanDelay(NAV_SETTLE_MS)));
    const landed = currentHost();
    if (landed === host) return true;
    // Glassdoor country-redirects (a .com request on a CA account lands on .ca).
    // Once the URL has stopped moving somewhere else, more waiting cannot
    // change the answer — stop burning settle time on it.
    if (landed && landed === previous) return false;
    previous = landed;
  }
  return false;
}

async function resolveGlassdoorLocId(page, location, signal, runCache = null, overlayBase = null) {
  const key = String(location || '').trim().toLowerCase();
  if (!key) return { failure: 'no location was supplied', failureKind: 'no-location' };
  if (runCache?.has(key)) return runCache.get(key);
  let cached = getGlassdoorLocId(key);
  const upgradedCache = upgradeGlassdoorCountryRootCache(cached, location);
  if (upgradedCache !== cached) {
    cached = upgradedCache;
    saveGlassdoorLocId(key, cached);
    logger.info(`[BrowserScraper] Glassdoor upgraded known country-root locId ${cached.locId}/${cached.locT} for "${location}" with ${cached.country} provenance`);
  }
  if (glassdoorCachedLocationUsable(cached, location)) {
    runCache?.set(key, cached);
    return cached;
  }
  if (cached) {
    logger.info(`[BrowserScraper] Glassdoor cached locId ${cached.locId}/${cached.locT} for "${location}" lacks matching country provenance — re-resolving`);
  }
  if (signal?.aborted) return { failure: 'search was cancelled before location resolution', failureKind: 'cancelled' };
  // Same-origin fetch must use the country site whose autocomplete/search path
  // was verified. Canada uses .ca; United States and unclassified city targets
  // use .com. Crossing hosts here can change the default market despite locId —
  // which is why .com is only ever a LOOKUP fallback, tried after the country
  // host fails at the transport layer, and still subject to the same country
  // validation below. The search navigation itself never changes host.
  const desiredHost = normalizeLocationInput(location).countryCode === 'CA'
    ? 'www.glassdoor.ca'
    : 'www.glassdoor.com';
  const hosts = desiredHost === 'www.glassdoor.com' ? [desiredHost] : [desiredHost, 'www.glassdoor.com'];
  const normalizedRequest = normalizeLocationInput(location);
  const subdivisionName = normalizedRequest.subdivisionCode
    ? (US_STATES[normalizedRequest.subdivisionCode.toLowerCase()] || CA_PROVINCES[normalizedRequest.subdivisionCode.toLowerCase()] || normalizedRequest.subdivision)
    : normalizedRequest.subdivision;
  // Prefer the most specific human-readable label. A US board-ready state scope
  // is "CO", but Glassdoor's autocomplete is more reliable with "colorado".
  const term = normalizedRequest.city || subdivisionName || normalizedRequest.country || (location.split(',')[0] || location).trim();

  const deadline = Date.now() + GLASSDOOR_LOOKUP_BUDGET_MS;
  const attempts = [];
  let rows = [];
  for (const host of hosts) {
    if (signal?.aborted) return { failure: 'search was cancelled during location resolution', failureKind: 'cancelled', attempts };
    if (Date.now() >= deadline) {
      attempts.push({ host, path: '(budget)', error: `gave up after ${Math.round(GLASSDOOR_LOOKUP_BUDGET_MS / 1000)}s` });
      break;
    }
    if (!await ensureGlassdoorOrigin(page, host)) {
      attempts.push({ host, path: '(origin)', error: 'could not reach the Glassdoor origin to run the lookup' });
      continue;
    }
    // Location resolution happens before the normal results navigation, so it
    // must run the challenge gate itself. Previously a visible Cloudflare page
    // was left for the human to watch while both autocomplete calls returned
    // 403 and the source was incorrectly dismissed as a location no-match.
    if (overlayBase) {
      await injectOverlay(page).catch(() => {});
      await updateOverlay(page, {
        ...overlayBase,
        status: 'Checking Glassdoor location…',
      }).catch(() => {});
      const originReady = await waitForReady(
        page,
        'glassdoor',
        overlayBase,
        signal,
        `https://${host}/Job/index.htm`,
        { challengeOnly: true },
      );
      if (originReady === 'abort' || signal?.aborted) {
        return { failure: 'search was cancelled during location verification', failureKind: 'cancelled', attempts };
      }
      if (originReady === 'hard-block' || originReady === 'skip') {
        return {
          failure: originReady === 'hard-block'
            ? 'the Glassdoor origin showed a non-interactive human-verification block'
            : 'the Glassdoor origin re-served its human-verification challenge after recovery',
          failureKind: 'access-denied',
          attempts,
        };
      }
    }
    const res = await page.evaluate(async (t, cfg) => {
      // Runs inside the page: no imports are available here, so the row shapes
      // and the retry loop are inlined. Keep rowsOf in sync with
      // glassdoorAutocompleteRows.
      const rowsOf = (data) => {
        if (Array.isArray(data)) return data;
        for (const k of ['data', 'results', 'locations', 'suggestions']) {
          if (Array.isArray(data?.[k])) return data[k];
        }
        return [];
      };
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      // The first path is Glassdoor's current visible autocomplete; the second
      // is its older endpoint, kept as a compatibility fallback. BOTH answers
      // go through the same validation on the Node side.
      const paths = [
        `/autocomplete/location?locationTypeFilters=CITY,STATE,COUNTRY&caller=jobs&term=${encodeURIComponent(t)}`,
        `/findPopularLocationAjax.htm?term=${encodeURIComponent(t)}&maxLocationsToReturn=10`,
      ];
      const log = [];
      for (const path of paths) {
        for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
          if (Date.now() >= cfg.deadline) {
            log.push({ path, error: 'lookup budget exhausted' });
            return { attempts: log };
          }
          const record = { path };
          let parsed = null;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), cfg.fetchTimeoutMs);
          try {
            const r = await fetch(path, {
              headers: { 'Accept': 'application/json, text/plain, */*' },
              credentials: 'include',
              signal: controller.signal,
            });
            record.status = r.status;
            if (r.ok) {
              const text = await r.text();
              try { parsed = JSON.parse(text); record.rows = rowsOf(parsed).length; }
              catch { record.error = 'non-json response'; }
            }
          } catch (e) {
            record.error = controller.signal.aborted
              ? `no response within ${Math.round(cfg.fetchTimeoutMs / 1000)}s`
              : String((e && e.message) || e);
          } finally { clearTimeout(timer); }
          log.push(record);
          if (record.rows > 0) return { data: parsed, endpoint: path, attempts: log };
          // A parsed-but-empty answer is a verdict for this endpoint: move to
          // the next one rather than asking the same question again.
          if (record.rows != null) break;
          const retryable = !Number.isFinite(Number(record.status))
            || cfg.retryStatuses.includes(Number(record.status));
          if (!retryable || attempt === cfg.maxAttempts) break;
          await sleep(cfg.backoffMs * attempt);
        }
      }
      return { attempts: log };
    }, term, {
      maxAttempts: GLASSDOOR_LOOKUP_MAX_ATTEMPTS,
      backoffMs: GLASSDOOR_LOOKUP_BACKOFF_MS,
      fetchTimeoutMs: GLASSDOOR_LOOKUP_FETCH_TIMEOUT_MS,
      retryStatuses: GLASSDOOR_LOOKUP_RETRY_STATUSES,
      deadline,
    }).catch(e => ({ attempts: [{ path: '(evaluate)', error: String(e?.message || e) }] }));

    for (const attempt of res?.attempts || []) attempts.push({ host, ...attempt });
    rows = glassdoorAutocompleteRows(res?.data);
    if (rows.length > 0) break;
    // Only cross to the fallback host when this one never actually answered.
    // A real, empty answer would be just as empty over there.
    if (!(res?.attempts || []).every(attempt => glassdoorLookupAttemptIsTransient(attempt))) break;
  }

  if (rows.length === 0) {
    const trail = summarizeGlassdoorLookupAttempts(attempts);
    logger.warn(`[BrowserScraper] Glassdoor locId lookup failed for "${location}" — ${trail}`);
    return {
      failure: `autocomplete lookup failed (${trail})`,
      failureKind: classifyGlassdoorLookupFailure(attempts),
      attempts,
    };
  }
  const picked = pickGlassdoorLocation(rows, location);
  const validationFailure = validateGlassdoorLocationPick(picked, rows, location);
  if (!validationFailure) {
    // Record the country the pick was validated against so a later run can
    // trust the cached entry instead of re-running this outage-prone lookup.
    const candidate = rows.find(item => glassdoorCandidateLocId(item) === String(picked.locId));
    const country = glassdoorCandidateCountryIso(candidate);
    const verified = country ? { ...picked, country } : { ...picked };
    saveGlassdoorLocId(key, verified);
    runCache?.set(key, verified);
    return verified;
  }
  logger.warn(`[BrowserScraper] Glassdoor locId lookup rejected for "${location}": ${validationFailure}`);
  return {
    failure: validationFailure || 'autocomplete returned no usable location',
    failureKind: 'rejected',
    attempts,
  };
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
  manualScraperTelemetry.fieldAnomalies = [];
}

// Browser-scrape progress is run-scoped just like the console/network buffers.
// In particular, an API-only follow-up search never enters this module's normal
// browser loop, so leaving `active` or the phase ring intact would make a prior
// Google/Glassdoor scrape look like activity in that new LinkedIn-only run.
// Call this once at the beginning of every job-search run; per-source dispatch
// deliberately uses resetManualScraperDiagnostics() instead so sibling browser
// sources in the SAME run keep their shared diagnostic trail.
export function resetManualScraperTelemetry() {
  manualScraperTelemetry.active = null;
  manualScraperTelemetry.events = [];
  manualScraperTelemetry.paused = false;
  resetManualScraperDiagnostics();
}

// `opts`: { resetDiagnostics=true, sourceIndexBase=0, sourceTotal=null } — for
// per-source dispatch the orchestrator passes resetDiagnostics:false (it cleared
// once up front) and the real index/total so the "Starting X/Y" log stays correct.
export async function scrapeManualSources(tasks, onResult, signal, onPageJobs = null, opts = {}) {
  const { resetDiagnostics = true, sourceIndexBase = 0, sourceTotal = null } = opts;
  // Direct callers start a complete browser-scrape run here. The jobs
  // orchestrator dispatches one source at a time and has already performed the
  // equivalent reset at its overall run boundary, so it passes false to retain
  // the preceding sibling sources' evidence.
  if (resetDiagnostics) resetManualScraperTelemetry();

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
  // Reuse a live, verified selection for sibling role queries in one run. This
  // is deliberately separate from the persistent locId cache, whose legacy
  // entries have no country metadata to validate.
  const resolvedGlassdoorLocations = new Map();

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
      const providerSeen = new Set();
      // Every task for a source is built from the same persisted hub limits.
      // Keep the aggregate job limit at source scope so several role queries
      // cannot each consume a separate allowance.
      const collectionLimits = sourceTasks[0]?.options?.collectionLimits || { jobsPerPlatform: null, pagesPerPlatform: null };
      const jobsPerPlatform = Number.isFinite(collectionLimits.jobsPerPlatform)
        ? collectionLimits.jobsPerPlatform
        : Infinity;
      let sourceSiteChangedWarning = null;
      let sourcePagesWalked        = 0;
      let sourceSkipped            = false; // set true when challenge times out — skips remaining queries for this source
      let hitPerSourceCap          = false;
      let hitPageCap               = false;
      let hitEmptyPage             = false;
      let hitUnhandledPagination   = false;
      let sourceDetailRateLimited  = false;
      let dataStopReason           = null; // set by task.options.onPageScraped (age-window / no-new-jobs) — see jobPageStop.js
      // Exact requests that reached the navigation step. The task list is only
      // a plan: a source can hit its useful-result cap at q1/12.
      const executedQueries        = [];

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
        if (allJobs.length >= jobsPerPlatform) {
          hitPerSourceCap = true;
          break;
        }

        const task = sourceTasks[qi];

        const overlayBase = {
          srcLabel: `Source ${si + 1} of ${sourceList.length}`,
          srcName,
          qLabel:   `Query ${qi + 1} of ${sourceTasks.length}`,
          qText:    task.query || '',
          queryIndex: qi + 1,
          queryTotal: sourceTasks.length,
        };

        // Human-scale cooldown between queries (not before the first) — see
        // DEFAULT_INTER_QUERY_COOLDOWN_MS. Honors pause/abort while waiting.
        if (qi > 0) {
          const cooldownAnchor = DEFAULT_INTER_QUERY_COOLDOWN_MS;
          await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Pacing before next query…' }).catch(() => {});
          if (await waitIfPaused(page, signal) === 'abort' || signal?.aborted) { earlyExit = true; break; }
          await new Promise(r => setTimeout(r, humanDelay(cooldownAnchor)));
        }

        // Glassdoor: locKeyword text is ignored; without a verified numeric locId
        // this would be a nationwide search. Treat a requested location as a
        // safety boundary: resolution failure skips this source before navigation.
        if (sourceId === 'glassdoor' && task.resolveGlassdoorLocation && !task._locResolved) {
          task._locResolved = true;
          const picked = await resolveGlassdoorLocId(page, task.resolveGlassdoorLocation, signal, resolvedGlassdoorLocations, overlayBase)
            .catch(() => ({ failure: 'autocomplete request threw before a location could be verified', failureKind: 'transient' }));
          if (picked?.locId) {
            // Replace stale resume params as well as filling the normal
            // locKeyword-only task URL, ensuring the verified location is used.
            const resolvedUrl = new URL(task.url);
            resolvedUrl.searchParams.set('locId', String(picked.locId));
            resolvedUrl.searchParams.set('locT', String(picked.locT || 'C'));
            task.url = resolvedUrl.toString();
            task._glassdoorLocId = String(picked.locId);
            logger.info(`[BrowserScraper] Glassdoor "${task.resolveGlassdoorLocation}" → locId ${picked.locId}/${picked.locT}`);
          } else {
            const failure = picked?.failure || 'autocomplete returned no verified exact match';
            const failureKind = picked?.failureKind || 'unknown';
            sourceSiteChangedWarning = {
              code: failureKind === 'access-denied' ? 'location-lookup-blocked' : 'location-resolution-failed',
              severity: 'info',
              ...(failureKind === 'access-denied' ? { shortLabel: 'Location lookup blocked' } : {}),
              ...describeGlassdoorLocationFailure({ location: task.resolveGlassdoorLocation, failure, failureKind }),
            };
            logger.warn(`[BrowserScraper] ${sourceSiteChangedWarning.evidence}`);
            recordManualScraperTelemetry({
              phase: 'location-resolution-failed',
              sourceId,
              srcName,
              queryIndex: qi + 1,
              queryTotal: sourceTasks.length,
              url: task.url,
              location: task.resolveGlassdoorLocation,
              reason: failure,
              failureKind,
              attempts: Array.isArray(picked?.attempts) ? picked.attempts.length : 0,
            });
            await updateOverlay(page, {
              ...overlayBase,
              count: allJobs.length,
              status: 'Location could not be verified — skipping Glassdoor to avoid a nationwide search.',
              error: true,
            }).catch(() => {});
            sourceSkipped = true;
            break;
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
        const navigationIssued = await page.evaluate(u => { window.location.href = u; }, task.url)
          .then(() => true)
          .catch(() => false);
        recordIssuedManualQuery(executedQueries, { query: task.query || '', url: task.url }, navigationIssued);
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

        // Glassdoor's accepted selection is reflected in its canonical results
        // route as `_IN{id}`. Merely leaving locId in the input query is not proof
        // that the board applied it, so never extract from a page missing that
        // exact final-URL marker.
        if (sourceId === 'glassdoor' && task._glassdoorLocId && !glassdoorUrlHasLocationId(page.url(), task._glassdoorLocId)) {
          sourceSiteChangedWarning = {
            code: 'location-not-applied',
            severity: 'info',
            evidence: `Glassdoor resolved location ID ${task._glassdoorLocId}, but the final results URL did not contain the matching _IN${task._glassdoorLocId} segment. The source was skipped without extracting unscoped results.`,
            suggestion: 'Retry Glassdoor. If it continues to omit the resolved location from the final URL, use the other country-scoped sources for this run.',
          };
          recordManualScraperTelemetry({
            phase: 'location-not-applied',
            sourceId,
            srcName,
            queryIndex: qi + 1,
            queryTotal: sourceTasks.length,
            url: page.url(),
            expectedLocId: task._glassdoorLocId,
          });
          logger.warn(`[BrowserScraper] ${sourceSiteChangedWarning.evidence}`);
          sourceSkipped = true;
          break;
        }

        await injectOverlay(page); // re-inject after challenge resolution may have navigated
        await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Extracting jobs…' });

        // For scroll sources, pre-load content up to the per-query target
        // before running the extractor. Paginated sources skip this.
        if (SCROLL_SOURCES.has(sourceId)) {
          await preloadContent(page, sourceId, task.extractorJS, overlayBase, signal, {
            // `??` not `||` — task.options.maxPages is already the resolved,
            // always-finite ceiling (resolvePageCeiling), but fall back to the
            // same backstop if a task was ever built without it so this never
            // silently reinstates the retired 10-page default.
            maxPages: task.options?.maxPages ?? JOB_COLLECTION_PAGE_CEILING,
            jobsPerPlatform,
            existingJobs: allJobs.length,
          });
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
        // Pages in THIS query's walk that extracted jobs cleanly. Proof that the
        // extractor's selectors work against this session's markup — see the
        // end-of-results branch below.
        let pagesExtracted       = 0;
        let paginationRecoveries = 0; // times recoverFromChallengeHomeLanding fired on a paginated page
        let evalErrStreak        = 0; // consecutive non-SITE_CHANGED runExtractor throws — see runExtractor's doc comment

        while (!earlyExit && !sourceSkipped && !signal?.aborted) {
          const pauseResult = await waitIfPaused(page, signal);
          if (pauseResult === 'abort' || signal?.aborted) { earlyExit = true; break; }

          // Hard page ceiling selected on this hub. `??` not `||`: an
          // absent/undefined value falls back to the unlimited backstop, not
          // the retired 10-page default — task.options.maxPages is normally
          // already the resolved, always-finite ceiling (resolvePageCeiling).
          // The per-query walk otherwise only stops on the data-driven
          // onPageScraped signal below, an empty extraction, or a failed
          // next-page action, so this ceiling is purely the backstop against a
          // stale pager looping forever.
          const maxPages = task.options?.maxPages ?? JOB_COLLECTION_PAGE_CEILING;
          if (pageNum > maxPages) {
            logger.info(`[BrowserScraper] ${srcName} q${qi + 1} hit browser pages/query (${maxPages}) — stopping pagination`);
            hitPageCap = true;
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
            // Walking off the END of a result set is not a site change. Several
            // extractors throw SITE_CHANGED when they find zero cards (their
            // 0-result guard against silent selector rot), and a page past the
            // last result looks exactly like that: no cards, and none of the
            // narrow "0 results" sentinels either, because this is a beyond-the-
            // end page rather than a genuine no-matches page.
            //
            // If an EARLIER page in this same query walk extracted jobs, the
            // selectors demonstrably work against this session's markup, so the
            // stale-selector explanation is already disproven — the honest
            // reading is "we ran out of results". Before the page ceiling became
            // "All" this was mostly unreachable (few walks got deep enough);
            // now every exhausted source would otherwise end on a hard, false
            // "extractor broken — site structure changed" block. Under-alarming
            // on a genuine mid-walk markup flip is the better trade: the walk
            // still ends cleanly and keeps everything gathered so far, and the
            // underlying throw is logged rather than swallowed.
            if (pagesExtracted > 0) {
              logger.info(`[BrowserScraper] ${srcName} q${qi + 1} p${pageNum}: extractor found nothing after ${pagesExtracted} page(s) that extracted cleanly — treating as end of results, not a site change. Underlying: ${siteChangedError.message.slice(0, 200)}`);
              recordManualScraperTelemetry({
                phase: 'end-of-results',
                sourceId,
                srcName,
                queryIndex: qi + 1,
                queryTotal: sourceTasks.length,
                pageNum,
                count: allJobs.length,
                url: page.url(),
              });
              dataStopReason = 'end-of-results';
              break;
            }
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
          if (extracted.length === 0) {
            hitEmptyPage = true;
            break;
          }
          pagesExtracted++;   // this page's selectors worked — see the SITE_CHANGED branch above

          // Trust the platform's ranked/fuzzy search results. Every distinct row
          // returned for the issued query is eligible for detail expansion; the
          // app must not impose a second exact-ish title admission policy.
          const newJobs = [];
          for (const job of extracted) {
            // One listing can surface in two role queries. Google embeds that
            // query in `q`/the fragment, so raw URL equality misses an exact
            // duplicate; sourceJobKey preserves its stable htidocid instead.
            const key = sourceJobKey(job);
            if (providerSeen.has(key)) continue;
            providerSeen.add(key);
            if (!seen.has(key)) { seen.add(key); newJobs.push(job); }
          }

          // The user-selected aggregate source limit applies across all queries
          // and pages. Stop expanding as soon as its remaining allowance is full.
          const remainingSourceSlots = Math.max(0, jobsPerPlatform - allJobs.length);
          const jobsToExpand = newJobs.slice(0, remainingSourceSlots);
          const walkPlan = buildPhysicalCardWalkPlan(extracted, jobsToExpand);
          await updateOverlay(page, {
            ...overlayBase,
            pageNum,
            count: allJobs.length,
            status: `Opening all ${jobsToExpand.length} platform-returned cards`,
          }).catch(() => {});
          let detailResult;
          if (sourceDetailRateLimited) {
            recordManualScraperTelemetry({
              phase: 'detail-skipped-rate-limited', sourceId, srcName,
              queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
              count: allJobs.length, skipped: jobsToExpand.length,
            });
            detailResult = { jobs: jobsToExpand, descError: null, descWarning: null, expandedCount: 0 };
          } else {
            detailResult = await expandDescriptions(
              page, jobsToExpand, sourceId, { ...overlayBase, pageNum }, allJobs.length + newJobs.length, signal, walkPlan,
            );
          }
          const { jobs: enhanced, descError, descWarning, expandedCount } = detailResult;

          const descCfg = DESC_CONFIGS[sourceId];
          if (descCfg?.panelSelector || descCfg?.expandViaNavigation) {
            const strategy = [
              descCfg?.jsonLdType    && `jsonLd(${descCfg.jsonLdType})`,
              descCfg?.nextDataField && `nd(${descCfg.nextDataField.split('.').slice(-1)[0]})`,
              'sel',
            ].filter(Boolean).join('+');
            logger.info(`[BrowserScraper] ${srcName} q${qi + 1} descriptions: ${expandedCount}/${jobsToExpand.length} expanded (${strategy}: ${descCfg?.panelSelector?.slice(0, 40) ?? 'none'})`);
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
          // A partial detail page is actionable but does not invalidate a relevant
          // list row. Preserve the row, continue the source, and surface this as a
          // warning in the result rather than converting it into a clean finish.
          if (descWarning && !sourceSiteChangedWarning) sourceSiteChangedWarning = descWarning;
          if (descWarning?.code === 'description-rate-limited') sourceDetailRateLimited = true;

          await updateOverlay(page, {
            ...overlayBase,
            count:  allJobs.length,
            status: 'Looking for next page…',
          });

          logger.info(`[BrowserScraper] ${srcName} page ${pageNum}: ${enhanced.length} new jobs (${allJobs.length} total)`);

          if (allJobs.length >= jobsPerPlatform) {
            logger.info(`[BrowserScraper] ${srcName} hit jobsPerPlatform (${jobsPerPlatform}) — stopping source`);
            hitPerSourceCap = true;
            break;
          }

          // Data-driven stop (age-window / no-new-jobs from makeJobPageStop):
          // an ADDITIONAL, earlier-terminating signal on top of the empty-page
          // break below, needed now that pages defaults to "All" rather than a
          // fixed 10-page ceiling. Fed THIS page's raw extracted rows (not the
          // title-filtered/deduped `allJobs`) — the age/staleness rules are
          // relevance-agnostic pager signals and need the full page to judge.
          // Absent for tasks built without an onPageScraped instance (e.g. some
          // resume paths) — the empty-extraction break above remains the safety
          // net in that case. Mirrors browserPool.js's onPageScraped call: a
          // throw is non-fatal and never stops the walk.
          let stopDecision = null;
          try {
            stopDecision = await task.options?.onPageScraped?.({ items: extracted, pageIndex: pageNum - 1 });
          } catch (e) {
            logger.warn(`[BrowserScraper] ${srcName} onPageScraped threw (non-fatal): ${e?.message || e}`);
          }
          if (stopDecision?.stop) {
            logger.info(`[BrowserScraper] ${srcName} q${qi + 1}: ${stopDecision.detail || stopDecision.reason}`);
            dataStopReason = stopDecision.reason || 'data-stop';
            recordManualScraperTelemetry({
              phase: 'page-stop',
              sourceId,
              srcName,
              queryIndex: qi + 1,
              queryTotal: sourceTasks.length,
              pageNum,
              count: allJobs.length,
              reason: stopDecision.reason,
              detail: stopDecision.detail,
            });
            break;
          }

          const nextPage = await clickNextPage(page, sourceId);
          if (!nextPage.clicked) {
            if (nextPage.unhandled) {
              hitUnhandledPagination = true;
              const control = nextPage.unhandled;
              const hrefNote = control.href ? ` (${control.href})` : '';
              const evidence = `${srcName} page ${pageNum} exposed an enabled ${JSON.stringify(control.label || 'Next page')} control${hrefNote}, but the scraper had no working selector for it. Stopping here would omit later result pages.`;
              logger.warn(`[BrowserScraper] ${evidence}`);
              if (!sourceSiteChangedWarning || sourceSiteChangedWarning.severity !== 'block') {
                sourceSiteChangedWarning = {
                  code:       'pagination-unhandled',
                  severity:   'block',
                  evidence,
                  suggestion: `The ${srcName} pagination control changed or failed to respond. Update its next-page selector, then rerun this source so later pages are collected.`,
                };
              }
              recordManualScraperTelemetry({
                phase: 'pagination-unhandled', sourceId, srcName,
                queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
                count: allJobs.length, label: control.label || 'Next page', href: control.href || null,
              });
            }
            break;
          }

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
        if (allJobs.length >= jobsPerPlatform) {
          hitPerSourceCap = true;
          break;
        }
      }

      const stopReason = resolveManualSourceStopReason({
        earlyExit,
        aborted: !!signal?.aborted,
        sourceSkipped,
        hitPerSourceCap,
        hitPageCap,
        hitEmptyPage,
        hitUnhandledPagination,
        dataStopReason,
      });
      const result = {
        id:          `${sourceId}-0`,
        sourceId,
        success:     true,
        data:        allJobs,
        pagesWalked: sourcePagesWalked,
        stopReason,
        warning:     sourceSiteChangedWarning || null,
        executedQueries,
        providerGathered: providerSeen.size,
        relevanceDropped: 0,
        preCapRelevanceDropped: 0,
        relevanceRejected: [],
      };
      results.push(result);
      onResult?.(result);

      // This terminal event deliberately clears query/page fields inherited by
      // the merge-style telemetry recorder. Without it, a finished run reports
      // the pre-extraction count from its final page (often 0) as if it were
      // current, even when the source returned jobs.
      recordManualScraperTelemetry({
        phase: 'source-finished',
        sourceId,
        srcName,
        queryIndex: null,
        queryTotal: null,
        pageNum: null,
        count: allJobs.length,
        stopReason,
        url: page.url(),
      });

      logger.info(`[BrowserScraper] ${srcName} done: ${allJobs.length} jobs (${stopReason})`);

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
