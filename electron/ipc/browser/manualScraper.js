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

import {
  closeOwnedBrowserProcess, closeStealthBrowser, getUserDataDir, findChromePath, launchWithProfileLockRetry,
} from '../stealthBrowser.js';
import { logger } from '../../logger.js';
import { POSTED_DATE_PATTERN } from '../jobDateFilter.js';
import { buildOverlayScript, updateOverlay as paintOverlay } from './scraperOverlay.js';
import { prepareBackgroundScrapeLaunchOptions, createBackgroundScrapePage } from './backgroundScrapeBrowser.js';
import { isProfileLockCollision } from '../browserLaunchTelemetry.js';
import { humanCooldown, humanDelay } from '../../utils/humanDelay.js';
import { getGlassdoorLocId, saveGlassdoorLocId } from '../settings.js';
import { CA_PROVINCES, normalizeLocationInput, pickGlassdoorLocation, US_STATES } from '../../../src/utils/jobLocation.js';
import { sourceJobKey } from '../../../src/utils/jobIdentity.js';
import { normalizeJobCollectionLimits, resolveBrowserPageBudgets, resolveJobsPerPlatform, resolvePageCeiling } from '../../../src/utils/jobCollectionLimits.js';
import { parseSalaryToNumeric } from '../../../src/nodes/jobsearch/buildJobTree.js';
import { decodeHtmlEntities, repairMojibake, stripHtmlToText } from '../../../src/utils/textEncoding.js';
import { markManualSolveRequired } from '../scrapeVerification.js';
import { isBackgroundE2E, backgroundE2EDisabledError } from '../../utils/backgroundE2e.js';

// ── Timing ────────────────────────────────────────────────────────────────────
const NAV_SETTLE_MS          = 2000;          // settle after navigation before first action
const CONTENT_POLL_MS        = 600;           // poll interval while waiting for content/challenge
const CONTENT_TIMEOUT_MS     = 20_000;        // max wait for content before proceeding anyway
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
const CHALLENGE_ACTIVITY_BEAT_MS = 30_000;
const CHALLENGE_STABLE_MS    = 1_500;         // page must be challenge-free for this long before resuming — guards against re-serves
// Cloudflare can remove a solved Turnstile iframe before it either redirects or
// re-renders the challenge. Do not mistake that short DOM transition for a final
// terminal block: keep the visible browser open long enough for a human to see
// what happened and for the widget to return.
const CHALLENGE_TERMINAL_TRANSITION_GRACE_MS = 10_000;
// Anti-bot interstitials REPLACE the document with a few hundred characters of
// copy (a headline, one sentence, a Ray ID). A job board's results or detail
// page is thousands. That size difference is the only source-agnostic way to
// tell "this page IS the challenge" from "this page merely CONTAINS words a
// challenge also uses" — the latter is ordinary posting prose, e.g. a Canadian
// role that requires passing a "security check". Measured, not selector-based,
// so it holds for every board without per-site markup knowledge.
export const CHALLENGE_INTERSTITIAL_MAX_CHARS = 2_000;
const DESC_CHANGE_POLL_MS    = 200;           // poll interval waiting for description panel update
const DESC_CHANGE_TIMEOUT_MS = 3_000;         // max wait for description to change after a card click
const DESC_RETRY_PAUSE_MS    = 900;           // pause before re-clicking when the first attempt's panel never updated (catches transient anti-bot 403s)
const DESC_CLICK_DELAY_MS    = 600;           // pause between card clicks (natural pacing)
const SITE_CHANGED_ABORT_THRESHOLD = 3;
const DESC_STALE_THRESHOLD   = 3;             // consecutive click/panel failures before flagging stale selectors
const DETAIL_DESCRIPTION_WAIT_MS = 6000;      // bounded client-hydration recovery for navigation detail pages
// Cloudflare can append its challenge iframe/Turnstile container just after
// DOMContentLoaded. Do not decide a fresh detail page is terminal before that
// injection window has passed.
const DETAIL_CHALLENGE_SETTLE_MS = 2_500;
// A text-only terminal detail page is normally a genuine stop, but it must be
// shown briefly before we close it: that makes the outcome legible to the user
// and catches a late Turnstile/iframe injection that the first settle missed.
const DETAIL_TERMINAL_PRESENT_MS = 5_000;
// ZipRecruiter will serve a plain HTTP 429 page after sustained detail-page
// navigation. These bounds deliberately slow only detail enrichment (not list
// collection), retry once, then stop the detail pass rather than hammering a
// rate-limited session for every remaining card.
const ZIPRECRUITER_DETAIL_GAP_MS = 2500;
const ZIPRECRUITER_429_FALLBACK_WAIT_MS = 45_000;
const ZIPRECRUITER_429_MAX_WAIT_MS = 60_000;
const ZIPRECRUITER_429_RETRIES = 1;
// A source-wide detail block (panel 429 / repeated panel HTTP errors) used to
// last for the whole remaining source: one throttle on page 11 meant pages
// 12-30 were walked with zero descriptions and every row deferred unscored.
// Give the throttle a bounded cooldown, then let ONE normal expansion attempt
// act as the probe — expandDescriptions already stops at its first blocked
// panel, so a still-throttled retry costs a single card, never a page-wide
// hammer (the per-listing no-retry rule in descriptionPanelRetryAllowed stays
// intact). The re-probe cap bounds a long walk that keeps re-arming.
const DETAIL_BLOCK_COOLDOWN_MS = 120_000;
const DETAIL_BLOCK_MAX_REPROBES = 3;
// Cards a cooldown re-probe may touch. MUST stay below DESC_STALE_THRESHOLD:
// a silent throttle surfaces as panel timeouts, and that many in a row trips
// abortWithError, which would turn an external rate limit into a bogus
// "stale selectors" error and end the source walk.
const DETAIL_BLOCK_PROBE_CARDS = 2;
// Appcast can intermittently block a ZipRecruiter outbound detail redirect
// while the original ZipRecruiter result page remains usable. Recover once by
// discarding that detail tab, backing off, refreshing the known-good list page,
// then retrying the same detail navigation. This is intentionally small: a
// persistent restriction must be left for the user to retry after a network/IP
// change, never turned into a navigation loop.
const ZIPRECRUITER_APPCAST_RESTRICTED_RECOVERY_RETRIES = 1;
const ZIPRECRUITER_APPCAST_RESTRICTED_BACKOFF_MS = 6_000;
const ZIPRECRUITER_APPCAST_RESTRICTED_MAX_BACKOFF_MS = 15_000;
// ZipRecruiter sometimes serves its own error shell ("We encountered an error
// while loading this job." + a "Reload the Job" button) for a listing that is
// perfectly fine on the next request. It is not a challenge, not a 404 and not
// a throttle, so none of the existing probes classify it — the row fell through
// to the description carriers, came back empty, and was dropped by the
// evidence gate as if the posting had no description. Retry the navigation a
// couple of times (which is what the page's own Reload button does) before
// accepting the miss. Deliberately small: a listing that is genuinely broken
// must not become a navigation loop.
const ZIPRECRUITER_DETAIL_ERROR_SHELL_RETRIES = 2;
const ZIPRECRUITER_DETAIL_ERROR_SHELL_BACKOFF_MS = 1_500;
const ZIPRECRUITER_DETAIL_ERROR_SHELL_MAX_BACKOFF_MS = 6_000;
// A source warning must stay compact enough for the renderer and diagnostics,
// but a first-only title made repeated, independently retained description
// misses look like a single affected listing. Keep a small title-only sample;
// URLs and page text remain in the private scraper telemetry rather than the
// source warning payload.
const DESCRIPTION_DETAIL_MISS_SAMPLE_LIMIT = 3;

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

function boundedDescriptionMissTitles(values) {
  const unique = [];
  for (const value of Array.isArray(values) ? values : []) {
    const title = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title || unique.includes(title)) continue;
    unique.push(title);
    if (unique.length >= DESCRIPTION_DETAIL_MISS_SAMPLE_LIMIT) break;
  }
  return unique;
}

/**
 * Preserve the existing first warning's code/severity/evidence while making
 * repeated non-blocking navigation-detail misses visible as one bounded
 * source-level warning. This intentionally aggregates only this precise
 * warning code: a later partial miss must never overwrite a higher-priority
 * block, navigation, or selector warning.
 */
export function mergeDescriptionDetailMissWarning(existing, incoming) {
  const isMiss = warning => warning?.code === 'description-detail-miss';
  if (!existing) return incoming || null;
  if (!incoming || !isMiss(existing) || !isMiss(incoming)) return existing;
  const existingCount = Math.max(1, Math.floor(Number(existing.affectedCount) || 1));
  const incomingCount = Math.max(1, Math.floor(Number(incoming.affectedCount) || 1));
  return {
    ...existing,
    affectedCount: existingCount + incomingCount,
    affectedTitles: boundedDescriptionMissTitles([
      ...(Array.isArray(existing.affectedTitles) ? existing.affectedTitles : []),
      ...(Array.isArray(incoming.affectedTitles) ? incoming.affectedTitles : []),
    ]),
  };
}

function descriptionDetailMissWarning(sourceName, title) {
  const sampleTitle = String(title || 'an untitled listing').replace(/\s+/g, ' ').trim().slice(0, 120)
    || 'an untitled listing';
  return {
    code: 'description-detail-miss', severity: 'warn',
    evidence: `${sourceName} could not recover a full description for "${sampleTitle}" after its bounded detail-page wait. The listing was retained with its available list fields.`,
    suggestion: `Retry ${sourceName} later or open the listing directly; the board may have delayed or restricted the detail page.`,
    affectedCount: 1,
    affectedTitles: [sampleTitle],
  };
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
  // The phase ring is a 30-slot RECENCY window, so on a long walk the rows that
  // establish what this run even is — source-start, query-start, the location
  // resolution/redirect trail — are evicted by per-job anomaly chatter before a
  // reader ever opens the report. These are emitted at most once per source, so
  // retaining them separately costs almost nothing and keeps a report readable.
  origins: [],
  // Last observed sign of life from the scrape loop, refreshed by every overlay
  // paint (see updateOverlay below). Distinct from `active`, which only moves on
  // telemetry PHASES — and Glassdoor's per-card description walk emits no phase
  // on its success path, so `active` legitimately sits on `page-extract` for
  // minutes while the walk is healthy. Without this, a healthy walk and a wedged
  // renderer are the same observation: silence.
  beat: null,
  // What the scrape loop is awaiting right now, and since when. A bug report
  // written mid-walk otherwise names the last COMPLETED phase and leaves the
  // in-flight operation — the one that is actually slow — unnamed.
  inFlight: null,
  // The Chrome the manual scraper launched for itself. scrapeManualSources
  // closes the shared stealthBrowser singleton and spawns its own process, so
  // the singleton-derived "scrape browser" line in a bug report reads "not
  // running" while this one is very much running on the same profile.
  browser: null,
};

// Renderer sink for mid-walk progress, installed per run by scrapeManualSources.
// The module never imports Electron or reaches for a webContents itself — the
// orchestrator owns which node the events belong to.
let activitySink = null;
let lastSinkEmitAt = 0;
let lastSinkEmitKey = null;
// Overlay paints are cheap and frequent (every scroll tick in preloadContent);
// renderer IPC should not be. One second is far below the ~5-7s Glassdoor card
// cadence, so no real progress step is ever coalesced away.
const ACTIVITY_SINK_MIN_INTERVAL_MS = 1000;
// How long a single awaited scrape step may run before it is worth a log line.
// Well under puppeteer-core's 180s CDP protocolTimeout so a wedged renderer is
// NAMED long before the protocol gives up on it and the retry loop restarts it.
const IN_FLIGHT_WARN_MS = 30_000;

// Rows that establish the identity and setup of a source's walk. Each is emitted
// at most once per source, so they are the first casualties of the 30-slot
// recency ring on a long run — and the last thing a reader can afford to lose,
// since they carry the query, the requested location, and any host redirect.
const ORIGIN_PHASES = new Set([
  'source-start', 'query-start', 'source-finished', 'reveal-finished',
  'location-nation-tier-unenforced', 'location-resolution-failed',
  'location-not-applied', 'location-proof-unavailable', 'location-host-redirected',
]);

// Browser job boards routinely emit failed ad/analytics requests and CSP/ORB
// console errors that have no bearing on whether the listing scraper worked.
// These buffers are deliberately small, so allowing a burst of that traffic to
// consume them can evict the first-party failure that actually explains a bad
// scrape. Keep the allowlist URL-shaped and narrow: unfamiliar third parties and
// every ordinary first-party URL remain reportable.
/** Sleep that returns early if the run is cancelled. Never rejects. */
function sleepUnlessAborted(ms, signal) {
  const wait = Math.max(0, Math.round(Number(ms) || 0));
  if (wait === 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve(); };
    const timer = setTimeout(done, wait);
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/** Lowercased hostname, or '' for anything unparseable. Never throws. */
function safeUrlHost(rawUrl) {
  try { return new URL(String(rawUrl || '')).hostname.toLowerCase(); } catch { return ''; }
}

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
    // Glassdoor embeds Indeed company-spotlight pixels. Chromium rejects these
    // cross-origin images/fetches on every card transition, producing duplicate
    // requestfailed + console entries even though the job-details request and
    // panel both succeed. Keep the allowlist path-exact so real Indeed job/API
    // failures remain visible.
    if (hostIs('indeed.com') && pathname === '/rc/gd/png') return true;
    if (host === 'itad.indeed.com' && pathname === '/ita/v1/publisher') return true;

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

// A stuck single-card retry loop can emit dozens of byte-identical card-walk
// batch summaries in a row — same source/strategy/attempted/expanded/timeout
// counts, same failureSamples keys+reasons, nothing different except the
// timestamp. Left alone, the plain oldest-first `events` ring treats each
// retry as new history, so ~13 identical retries evicted 13 DISTINCT earlier
// batches before anyone read the report ("5 earlier card-walk batch
// summary(s) omitted"). Compare everything except the bookkeeping fields
// (`ts`, `repeatCount`, `firstTs`, `lastTs`) — a JSON-identical match is
// deliberately conservative: any real difference (even one more failed card)
// serializes differently and is never folded.
function cardWalkFingerprint(entry) {
  // `_`-prefixed to match the repo's destructure-to-omit convention (the lint
  // config's varsIgnorePattern allows it); these four are dropped, never read.
  const { ts: _ts, repeatCount: _repeatCount, firstTs: _firstTs, lastTs: _lastTs, ...rest } = entry;
  try {
    return JSON.stringify(rest);
  } catch {
    return null; // circular/unserializable — never collapse, never crash
  }
}

/**
 * Folds `entry` into the previous ring slot IN PLACE when it is a
 * byte-identical repeat of the last card-walk event, returning true. Returns
 * false (no mutation) for the first occurrence of a batch, for any batch that
 * differs from the previous one, or when the previous slot isn't a card-walk
 * event at all — so the caller can push normally in every one of those cases.
 */
function collapseRepeatedCardWalk(events, entry) {
  if (entry.phase !== 'card-walk') return false;
  const prev = events[events.length - 1];
  if (!prev || prev.phase !== 'card-walk') return false;
  const prevKey = cardWalkFingerprint(prev);
  const nextKey = cardWalkFingerprint(entry);
  if (prevKey === null || nextKey === null || prevKey !== nextKey) return false;
  prev.repeatCount = (prev.repeatCount || 1) + 1;
  prev.firstTs = prev.firstTs || prev.ts;
  prev.lastTs = entry.ts;
  // Re-anchor `ts` to the latest occurrence so the report's age ("-Ns ago")
  // reflects when the loop last repeated, not when it first started — a
  // repeat that is STILL happening must not read as old.
  prev.ts = entry.ts;
  return true;
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
  if (!collapseRepeatedCardWalk(manualScraperTelemetry.events, entry)) {
    manualScraperTelemetry.events.push(entry);
    if (manualScraperTelemetry.events.length > 30) manualScraperTelemetry.events.shift();
  }
  // Sources run strictly sequentially, so the last phase to name a source names
  // the source every subsequent overlay paint belongs to. This is what lets the
  // beat below carry a sourceId without threading one through ~30 call sites.
  if (entry.sourceId) manualScraperTelemetry.currentSourceId = entry.sourceId;
  if (ORIGIN_PHASES.has(entry.phase)) {
    manualScraperTelemetry.origins.push(entry);
    if (manualScraperTelemetry.origins.length > 24) manualScraperTelemetry.origins.shift();
  }
  // The 30-slot `events` ring is a recency window: after a source-wide detail
  // block, every later page emits two rows, so 18 pages of skip chatter evicted
  // the single `detail-panel-rate-limit` event that explained the whole run.
  // The rate-limit / panel-HTTP phases are the CAUSE rows — keep them in the
  // longer-lived anomaly ring so a report written an hour later still has them.
  if (['desc-miss', 'date-miss', 'detail-unavailable', 'detail-challenge', 'detail-navigation-abort', 'detail-appcast-restriction', 'detail-panel-rate-limit', 'detail-panel-http-error', 'detail-block-reprobe', 'detail-block-reprobe-failed', 'detail-block-cleared', 'challenge-text-suppressed'].includes(entry.phase)) {
    manualScraperTelemetry.fieldAnomalies.push(entry);
    if (manualScraperTelemetry.fieldAnomalies.length > 20) manualScraperTelemetry.fieldAnomalies.shift();
  }
  if (!updateActive) return;
  // A source/query/page boundary is a new diagnostic context, not an update to
  // the prior listing. Replacing at those boundaries prevents a Glassdoor
  // detail key/reason/evidence from being reported as the current Google item
  // after the next source starts. Fine-grained phases within one context still
  // merge so browser/challenge metadata can accumulate while it is current.
  // 'recovery-start' is the same kind of boundary for a post-completion
  // recovery pass (Solve/Continue re-opening a stalled source): every per-card
  // phase inside that pass passes updateActive:false by design (see
  // expandDescriptions), so without a reset here `active` stays pinned to
  // whatever the main run last recorded — naming the WRONG source while a
  // different one silently recovers.
  const resetsContext = new Set(['source-start', 'query-start', 'page-extract', 'source-finished', 'recovery-start']);
  manualScraperTelemetry.active = resetsContext.has(entry.phase)
    ? entry
    : { ...(manualScraperTelemetry.active || {}), ...entry };
}

/** Record a query only when Chrome accepted the location-assignment command. */
export function recordIssuedManualQuery(executedQueries, entry, navigationIssued) {
  if (navigationIssued && Array.isArray(executedQueries)) executedQueries.push(entry);
  return executedQueries;
}

// A terminal phase (finished/idle/aborted) must not keep vouching for the
// PRIOR active entry's source/count/URL/reason as though it were still
// current. That is exactly what let a bug report read "Current: phase
// finished · source Glassdoor · count 722" hours after Glassdoor's own run
// had ended, while a DIFFERENT source's post-completion recovery was the
// thing actually running — the reader had no way to tell the number was
// inherited rather than live. `ts` already tells a reader this is over; keep
// only phase + ts and drop every field that names a specific source's
// in-progress state.
function clearManualScraperTelemetry(status = 'idle') {
  manualScraperTelemetry.active = manualScraperTelemetry.active
    ? { phase: status, ts: Date.now() }
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
  detailEnrichmentFailed = false,
  hitPerSourceCap = false,
  hitPageCap = false,
  hitEmptyPage = false,
  hitPageTurnStalled = false,
  hitUnhandledPagination = false,
  hitChallengeRecoveryLoop = false,
  hitProviderResultWindow = false,
  hitProviderTotalShortfall = false,
  dataStopReason = null,
} = {}) {
  if (sourceSkipped) return 'blocked';
  if (aborted) return 'aborted';
  // A detail-card failure is an internal scraper failure, not a user action.
  // `earlyExit` remains the legacy umbrella for several exits, but reporting
  // this one as `user-done` hid the actual cause in both the source trail and
  // the bug report.
  if (detailEnrichmentFailed) return 'detail-enrichment-failed';
  // `earlyExit` has historically meant a user-done / source-local stop, not
  // necessarily an AbortSignal. Keep that public result enum stable; callers
  // pass `aborted` only for an actual cancelled signal.
  if (earlyExit) return 'user-done';
  if (hitPerSourceCap) return 'per-source-cap';
  // An enabled next control with no successful action is proof that this run
  // stopped before the board's end. Keep it distinct from a normal completion
  // and from a user-configured page cap so the report states the real cause.
  if (hitUnhandledPagination) return 'pagination-unhandled';
  // A challenge that bounced the walk back to page 1 twice ends it with the
  // pages past the challenge never read. Ranked ABOVE the data-driven stops
  // because age-window / no-new-jobs / end-of-results all read as clean,
  // complete finishes and would hide a walk that gave up.
  if (hitChallengeRecoveryLoop) return 'challenge-recovery-loop';
  // The board stopped linking later pages and a direct continuation request
  // was redirected/clamped somewhere else. This is a provider result-window
  // boundary, not proof that the advertised corpus was exhausted.
  if (hitProviderResultWindow) return 'provider-result-window';
  // ZipRecruiter's query-string result header is the one browser-board total we
  // have verified against a full walk. An empty page before that total is an
  // observation about this pager, not proof that every advertised candidate was
  // reached. Keep it distinct from `empty-page`, which downstream correctly
  // treats as a lossless terminal condition when no contrary total exists.
  if (hitProviderTotalShortfall) return 'provider-total-shortfall';
  // A data-driven stop (age-window / no-new-jobs, from makeJobPageStop via
  // task.options.onPageScraped) means the walk ended because the DATA said
  // stop, not because it was cut short by the hub's page ceiling — surface it
  // under its own reason so bug reports never read a complete, data-driven
  // finish as the `page-cap` "this source may have additional in-window jobs"
  // warning (see bugReport/jobsSnapshot.js's stopReason flagging).
  if (dataStopReason) return dataStopReason;
  if (hitPageCap) return 'page-cap';
  // A page turn that never landed is NOT the end of the results. Reporting it
  // as `empty-page` would assert the board ran out when all we established is
  // that our own click did not navigate — and `empty-page` is treated
  // downstream as a clean, terminal, lossless finish. Ranked above empty-page
  // so the specific observation wins over the generic one.
  if (hitPageTurnStalled) return 'page-turn-stalled';
  if (hitEmptyPage) return 'empty-page';
  return 'completed';
}

// The manual scraper returns one aggregate result per source, while its tasks
// are one per generated query.  Preserve the *sum* of Auto's allocated query
// budgets as the source cap, not a misleading single-query 10-page value.
// Explicit Pages intentionally remains a per-query setting and is reported as
// that configured value.  This is a pure seam because a headed browser test is
// neither necessary nor reliable for verifying receipt metadata.
export function manualPageCapForTasks(sourceTasks, collectionLimits) {
  const limits = normalizeJobCollectionLimits(collectionLimits);
  if (limits.pagesPerPlatform != null) {
    return { type: 'pages-per-platform', limit: limits.pagesPerPlatform };
  }
  const taskCount = Array.isArray(sourceTasks) ? sourceTasks.length : 0;
  const allocated = resolveBrowserPageBudgets(limits, taskCount)
    .reduce((sum, pages) => sum + pages, 0);
  return allocated > 0 ? { type: 'auto-pages-per-platform', limit: allocated } : null;
}

/**
 * A cooldown re-probe proves the previous detail throttle has lifted only when
 * it produced an actual terminal outcome: either an expanded description or a
 * listing conclusively retired as unavailable. An ordinary zero-description
 * probe is ambiguous and must keep the block armed.
 */
export function didDetailBlockReprobeRecover(result = {}) {
  const expanded = Math.max(0, Number(result.expandedCount) || 0);
  const unavailable = Math.max(0, Number(result.unavailableDetailDropped) || 0);
  const reBlocked = ['description-rate-limited', 'description-panel-http-error']
    .includes(result.descWarning?.code);
  return (expanded > 0 || unavailable > 0) && !result.descError && !reBlocked;
}

/**
 * Preserve every safe aggregate while joining the small cooldown probe with
 * the rest of its page. The unsuccessful branch intentionally leaves the
 * untouched rows deferred, but never drops listings the probe conclusively
 * retired as unavailable.
 */
export function composeDetailBlockReprobeResult(probeResult = {}, restResult = null, restJobs = [], reprobeOfCode = null) {
  const probeJobs = Array.isArray(probeResult.jobs) ? probeResult.jobs : [];
  const probeExpanded = Math.max(0, Number(probeResult.expandedCount) || 0);
  const probeUnavailable = Math.max(0, Number(probeResult.unavailableDetailDropped) || 0);
  if (didDetailBlockReprobeRecover(probeResult)) {
    const rest = restResult || {};
    return {
      jobs: [...probeJobs, ...(Array.isArray(rest.jobs) ? rest.jobs : [])],
      descError: rest.descError || null,
      descWarning: rest.descWarning || probeResult.descWarning || null,
      expandedCount: probeExpanded + Math.max(0, Number(rest.expandedCount) || 0),
      unavailableDetailDropped: probeUnavailable + Math.max(0, Number(rest.unavailableDetailDropped) || 0),
    };
  }
  return {
    jobs: [
      ...probeJobs,
      ...(Array.isArray(restJobs) ? restJobs : []).map(job => ({
        ...job,
        descriptionDeferredReason: reprobeOfCode,
      })),
    ],
    descError: null,
    descWarning: probeResult.descWarning || probeResult.descError || null,
    expandedCount: probeExpanded,
    unavailableDetailDropped: probeUnavailable,
  };
}

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

export function getManualScraperTelemetry() {
  return {
    active: manualScraperTelemetry.active ? { ...manualScraperTelemetry.active } : null,
    events: manualScraperTelemetry.events.map(e => ({ ...e })),
    origins: manualScraperTelemetry.origins.map(e => ({ ...e })),
    fieldAnomalies: manualScraperTelemetry.fieldAnomalies.map(e => ({ ...e })),
    consoleLogs: manualScraperTelemetry.consoleLogs.map(e => ({ ...e })),
    networkErrors: manualScraperTelemetry.networkErrors.map(e => ({ ...e })),
    // `paused` was tracked on every ~500ms waitIfPaused poll but dropped here,
    // so a scrape a user had deliberately paused reported as a hang — with the
    // pause button, and the reason for the silence, invisible in a FULL report.
    paused: manualScraperTelemetry.paused,
    beat: manualScraperTelemetry.beat ? { ...manualScraperTelemetry.beat } : null,
    inFlight: manualScraperTelemetry.inFlight ? { ...manualScraperTelemetry.inFlight } : null,
    browser: manualScraperTelemetry.browser ? { ...manualScraperTelemetry.browser } : null,
  };
}

// ── Anti-bot challenge diagnostics ──────────────────────────────────────────
// Gathered when a challenge first fires so a bug report can rank the cause
// (IP reputation vs automation fingerprint vs behavior) WITHOUT reading source
// or relying on a pasted screenshot. All best-effort + fail-soft — diagnostics
// must never break a scrape or delay it beyond the few seconds before we sit and
// wait minutes for the user to solve the challenge anyway.

// Static description of how the manual-scrape browser is launched. Keep in sync
// with the launchWithProfileLockRetry() call in scrapeManualSources(). The point: a reader
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
  // Glassdoor has no pager: its Next.js rewrite replaced it with an in-page
  // "Show more jobs" append, and its `?p=N` param is ignored. The old
  // `button[data-test="pagination-next"]` here matched nothing, and a
  // no-control result was indistinguishable from a finished board — so every
  // Glassdoor search silently ended after its first ~30 rows and reported
  // `completed`. Its advance control now comes from the task's
  // `loadMoreSelector` (set in jobs.js) and runs through clickLoadMore.
  glassdoor:    null,
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
    // Detail panels are separate network requests. At the old generic 600ms
    // cadence Google reliably returned HTTP 429 near the end of a 30–40 card
    // page. Use a minimum human-scale gap and periodically let the rolling
    // request window drain; list extraction remains fast and is never retried.
    clickDelayMs: 3000,
    panelCooldownEvery: 8,
    panelCooldownMs: 15000,
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
    // Keep enrichment on the successful search document. Direct navigation to
    // an otherwise-valid www.glassdoor.ca detail URL can itself trigger
    // Glassdoor's Turnstile → terminal "Humans only" sequence. Clicking the
    // list card asks the site's own SPA to populate its right-side panel without
    // opening a fresh detail document. This was the app's original Glassdoor
    // strategy and avoids turning one empty list snippet into a session block.
    panelSelector: '[data-brandviews*="joblisting-description"], [class*="JobDetails_jobDescription"]',
    panelMulti:    false,
    closeSelector: null,
    // The panel request is network-backed. The 2026-08-25 diagnostic showed
    // 10 successful requests in roughly 20 seconds followed by an HTTP 429;
    // 1.5s was still a burst, not human reading cadence. Space requests well
    // apart and let the endpoint's rolling window recover before request nine.
    clickDelayMs: 4500,
    panelCooldownEvery: 8,
    panelCooldownMs: 12000,
  },
};

/**
 * Decide whether a source is permitted to open an individual posting while
 * enriching descriptions. This is deliberately separate from ordinary search,
 * location-lookup, and user-facing Solve navigation: those actions keep their
 * existing Glassdoor URLs and are not detail enrichment.
 *
 * Glassdoor has one safe enrichment shape: stay on the already-loaded result
 * document and let its own card click populate the side panel. A direct detail
 * document request, even to the same first-party host, has repeatedly caused a
 * Turnstile → text-only "Humans only" escalation. Keep this source-level so a
 * future config edit cannot silently turn an empty panel into a `goto()` loop.
 */
export function descriptionNavigationDecision(sourceId, rawUrl) {
  if (sourceId === 'glassdoor') {
    return {
      allowed: false,
      reason: 'glassdoor-list-card-panel-only',
      url: String(rawUrl || '').trim(),
    };
  }
  if (sourceId !== 'ziprecruiter') {
    return { allowed: true, reason: 'source-has-no-detail-navigation-restriction', url: String(rawUrl || '').trim() };
  }
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const allowed = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    return {
      allowed,
      reason: allowed ? 'http-detail-url' : 'unsupported-detail-scheme',
      url: parsed.toString(),
    };
  } catch {
    return { allowed: false, reason: 'malformed-detail-url', url: String(rawUrl || '').trim() };
  }
}

/** The network shape used to recover a source's full job descriptions. */
export function descriptionExpansionStrategy(sourceId) {
  const cfg = DESC_CONFIGS[sourceId];
  if (!cfg) return 'none';
  // This is an intentional hard guard, not merely the current config shape.
  // If someone later restores `expandViaNavigation`/`navUrlField` while trying
  // to repair a selector, Glassdoor still remains on the successful list page.
  if (sourceId === 'glassdoor') return cfg.panelSelector ? 'list-card-panel' : 'none';
  if (cfg.expandViaNavigation && (cfg.navUrlTemplate || cfg.navUrlField)) return 'detail-navigation';
  return cfg.panelSelector ? 'list-card-panel' : 'none';
}

/**
 * Deterministic per-source pacing for list-card panel requests.
 *
 * `requestsIssued` counts actual mouse clicks which may cause the board's
 * detail API to run (including a bounded retry), rather than list rows. This
 * lets a configured source cool down before the next request after every small
 * burst, while unconfigured sources preserve their existing walk cadence.
 */
export function descriptionPanelPacing(sourceId, requestsIssued = 0) {
  const cfg = DESC_CONFIGS[sourceId] || {};
  const requestDelayMs = Math.max(0, Number(cfg.clickDelayMs) || DESC_CLICK_DELAY_MS);
  const every = Math.max(0, Number(cfg.panelCooldownEvery) || 0);
  const checkpointDue = every > 0
    && Number(requestsIssued) > 0
    && Number(requestsIssued) % every === 0;
  const checkpointCooldownMs = Math.max(0, Number(cfg.panelCooldownMs) || 0);
  return {
    requestDelayMs,
    checkpointDue,
    // Keep configured pacing visible in card-walk telemetry even before the
    // first checkpoint is due. The executor gates the actual wait on
    // `checkpointDue`; diagnostic output must not incorrectly imply that the
    // checkpoint policy was absent just because this batch stopped early.
    checkpointCooldownMs,
    checkpointEvery: every || null,
  };
}

/**
 * Attribute an asynchronous panel failure to the last request that could have
 * caused it. `startIndex` is zero-based, matching the enrichment loop and the
 * deferred-row slice. A fallback keeps the helper safe before the first click.
 */
export function descriptionPanelFailureAttribution(lastRequest, {
  startIndex = 0,
  key = '',
  title = '',
} = {}) {
  const fallback = {
    startIndex: Math.max(0, Math.trunc(Number(startIndex) || 0)),
    key: String(key || ''),
    title: String(title || ''),
  };
  if (!lastRequest || !Number.isFinite(Number(lastRequest.startIndex))) return fallback;
  return {
    startIndex: Math.max(0, Math.trunc(Number(lastRequest.startIndex))),
    key: String(lastRequest.key || fallback.key),
    title: String(lastRequest.title || fallback.title),
  };
}

/** Glassdoor panel enrichment is intentionally single-request per listing. */
export function descriptionPanelRetryAllowed(sourceId) {
  return sourceId !== 'glassdoor';
}

function normalizedApplySource(value) {
  return String(value || '')
    .replace(/^apply on\s+/i, '')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

/**
 * Pick the direct posting link from Google's active Jobs detail panel.
 * Google can offer several mirrors; prefer the provider named by the list
 * card's "via …" label, then fall back to the first safe non-Google target.
 */
export function selectGoogleApplyUrl(candidates, preferredSource = '') {
  const valid = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const label = String(candidate?.label || '').replace(/\s+/g, ' ').trim();
    if (!/^apply on\b/i.test(label)) continue;
    try {
      const url = new URL(String(candidate?.href || ''));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      if (/(^|\.)google\.[a-z.]+$/.test(host)) continue;
      for (const key of ['utm_campaign', 'utm_source', 'utm_medium']) url.searchParams.delete(key);
      valid.push({
        url: url.href,
        source: normalizedApplySource(label),
      });
    } catch { /* ignore malformed provider hrefs */ }
  }
  if (valid.length === 0) return '';
  const preferred = normalizedApplySource(preferredSource);
  return (preferred && valid.find(item => item.source === preferred)?.url) || valid[0].url;
}

/**
 * Read the visible Apply-on anchors from Google's active detail document.
 *
 * Kept as a self-contained exported function so Puppeteer can serialize it
 * into the page and fixture tests can exercise the shipped DOM contract. The
 * accessible name matters: some Google builds put "Apply on …" only in
 * aria-label while leaving both title and visible anchor text empty.
 */
export function extractGoogleApplyCandidatesFromDocument(root = globalThis.document) {
  return Array.from(root?.querySelectorAll?.('a[href]') || [])
    .filter(anchor => !anchor.hidden)
    .filter(anchor => !anchor.closest('[aria-hidden="true"]'))
    .filter(anchor => !anchor.closest('[data-share-url]'))
    .filter(anchor => !!(anchor.offsetWidth || anchor.offsetHeight || anchor.getClientRects().length))
    .map(anchor => ({
      href: anchor.href || '',
      label: (
        anchor.getAttribute('aria-label')
        || anchor.getAttribute('title')
        || anchor.textContent
        || ''
      ).replace(/\s+/g, ' ').trim(),
    }))
    .filter(candidate => /^Apply on\b/i.test(candidate.label));
}

async function waitForGoogleApplyDestination(page, preferredSource, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  let candidates = [];
  while (true) {
    candidates = await page.evaluate(extractGoogleApplyCandidatesFromDocument).catch(() => []);
    const url = selectGoogleApplyUrl(candidates, preferredSource);
    if (url || Date.now() >= deadline) return { url, candidates };
    // The description often paints before the detail panel's outbound controls.
    // Poll only rows that still lack a usable destination, keeping the normal
    // happy path free of any extra delay.
    await new Promise(resolve => setTimeout(resolve, 120));
  }
}

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
    const identityUrl = sourceId === 'google' ? (job?.googleCardUrl || job?.url) : job?.url;
    const rawKey = (cfg.keyField && job?.[cfg.keyField])
      ? job[cfg.keyField]
      : cfg.keyRegex
        ? identityUrl?.match(new RegExp(cfg.keyRegex))?.[1]
        : identityUrl?.match(new RegExp(`[?&]${cfg.keyParam}=([^&]+)`))?.[1];
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
  // Resolve preparation normalizes/tag-copies rows before selecting the
  // persisted deferred subset. Prefer stable provider identity so those copies
  // retain their original DOM ordinal instead of clicking selected index N as
  // physical card N after age/history/recovery filtering.
  const ordinalsByKey = new Map();
  extracted.forEach((job, index) => {
    const key = sourceJobKey(job);
    if (key && !ordinalsByKey.has(key)) ordinalsByKey.set(key, index + 1);
  });
  const ordinalsByReference = new Map(extracted.map((job, index) => [job, index + 1]));
  return {
    physicalTotal: extracted.length,
    physicalIndexes: selected.map((job) => {
      const key = sourceJobKey(job);
      return (key ? ordinalsByKey.get(key) : null) ?? ordinalsByReference.get(job) ?? null;
    }),
  };
}

// The two sides of a detail-selection check are produced by different DOM
// mechanisms, and that asymmetry is what makes decoding here mandatory rather
// than cosmetic. Entity decoding is a property of HTML *parsing*, not of the
// textContent/innerText read APIs:
//   - the expected title is read off a server-rendered list card, so the
//     browser's parser already turned `&#8211;` in the markup into `–`;
//   - the observed title is read off a detail panel Google populates
//     programmatically from a JSON blob. Assigning a text node never runs an
//     entity decode, so a title double-escaped upstream stays the literal
//     characters `&#8211;`.
// Comparing the parsed `–` against the literal `&#8211;` declared a mismatch
// between a job and ITSELF, which threw away a correctly-read description
// panel as "another job's text" and left the row unresolvable — no number of
// retries can fix a check that rejects the right answer.
//
// Decoding repeats (bounded) because decodeHtmlEntities makes a single
// `String.replace` pass and does not re-scan its own output: one pass turns
// `&amp;#8211;` into `&#8211;`, which still is not the character the expected
// side carries. Mojibake is repaired alongside it so a source that serves
// UTF-8-as-Latin-1 compares equal to its repaired counterpart. This
// normalization is comparison-only — no stored field is rewritten by it.
const DETAIL_TITLE_DECODE_PASSES = 3;

function normalizedDetailTitle(title) {
  let text = String(title || '');
  for (let pass = 0; pass < DETAIL_TITLE_DECODE_PASSES; pass++) {
    const decoded = decodeHtmlEntities(repairMojibake(text));
    if (decoded === text) break;
    text = decoded;
  }
  return text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
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

/**
 * Decide whether a list-panel read belongs to the card that was just clicked.
 *
 * Most boards replace the description text on every card transition. Glassdoor
 * can legitimately serve the exact same employer-authored description for two
 * separate listings (for example the same role in different cities). Text-only
 * change detection would call the second one a timeout even after its right
 * panel loaded. We accept an unchanged Glassdoor body only when the active
 * detail heading independently confirms the requested title; an unverified
 * unchanged body remains a miss so stale content is never copied forward.
 */
export function assessDescriptionPanelUpdate({
  sourceId = '',
  previousText = '',
  currentText = '',
  expectedTitle = '',
  selectedTitle = '',
} = {}) {
  const previous = String(previousText || '').trim();
  const current = String(currentText || '').trim();
  if (!current) return { accepted: false, reason: 'empty-panel' };
  if (current !== previous) return { accepted: true, reason: 'text-changed' };
  if (sourceId !== 'glassdoor') return { accepted: false, reason: 'text-unchanged' };
  const selection = assessDetailSelection(expectedTitle, selectedTitle);
  return selection.selectionVerified
    ? { accepted: true, reason: 'text-unchanged-title-verified', selection }
    : { accepted: false, reason: 'text-unchanged-unverified', selection };
}

/**
 * A panel fetch is a first-party Glassdoor SPA request, not a DOM-selector
 * failure. Keep this predicate pure so the response listener and fixture tests
 * share the exact boundary: we only stop for the job-details endpoint's 429,
 * never for a third-party image or an unrelated Glassdoor API response.
 */
export function glassdoorPanelResponseIdentity({ sourceId = '', status = null, url = '' } = {}) {
  if (sourceId !== 'glassdoor' || !Number.isFinite(Number(status))) return null;
  try {
    const parsed = new URL(String(url || ''));
    if (!GLASSDOOR_FIRST_PARTY_HOST.test(parsed.hostname)
      || !/^\/job-listing\/api\/job-details\/?$/i.test(parsed.pathname)) return null;
    const key = String(parsed.searchParams.get('jobListingId') || '').trim();
    return key ? { key, status: Number(status), url: parsed.toString() } : null;
  } catch {
    return null;
  }
}

export function isGlassdoorPanelRateLimitResponse(input = {}) {
  return glassdoorPanelResponseIdentity(input)?.status === 429;
}

/**
 * Google Jobs loads selected cards through an async callback. Google redirects
 * an exhausted session to /sorry/ with HTTP 429; that is a source throttle,
 * not evidence that the result-card selector became stale.
 */
export function isGoogleDescriptionPanelRateLimitResponse({ sourceId = '', status = null, url = '' } = {}) {
  if (sourceId !== 'google' || Number(status) !== 429) return false;
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase();
    if (host !== 'google.com' && !host.endsWith('.google.com')) return false;
    return /^\/async\/callback\/?$/i.test(parsed.pathname) || /^\/sorry\//i.test(parsed.pathname);
  } catch {
    return false;
  }
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
  const active = Array.from(root.querySelectorAll(panelSelector))
    .find(el => !el.closest?.('[aria-hidden="true"]'));
  return active?.innerText?.trim() || active?.textContent?.trim() || '';
}

/**
 * Resolve the stable identity carried by a rendered description-card element.
 * `elementFromPoint()` normally returns a descendant, so generic attribute
 * sources such as Glassdoor must walk to the owning `[data-jobid]` card before
 * comparing it with the planned `jl` key.
 */
export function readDescriptionCardDomKey(element, {
  cardAttr = null,
  cardDataUrlParam = null,
  expectedKey = '',
} = {}) {
  if (!element) return '';
  if (cardAttr) {
    const owner = element.matches?.(`[${cardAttr}]`)
      ? element
      : element.closest?.(`[${cardAttr}]`);
    const value = owner?.getAttribute?.(cardAttr);
    if (value) return String(value);
  }
  const resultCard = element.matches?.('[data-share-url]')
    ? element
    : element.closest?.('[data-share-url]');
  if (resultCard && cardDataUrlParam) {
    try {
      return new URL(resultCard.getAttribute('data-share-url') || '', 'https://example.invalid')
        .searchParams.get(cardDataUrlParam) || '';
    } catch { /* fall through to the legacy id */ }
  }
  return element.id === expectedKey ? expectedKey : '';
}

// This is deliberately narrower than a generic "close every dialog" helper.
// Glassdoor can legitimately show saved-job and application dialogs; closing one
// of those behind a user's back would change the visible result state. The job
// alert interstitial in the 2026-08-25 report is instead a non-essential prompt
// that blocks the result cards after a normal list-card click, so its distinctive
// copy gives us a safe, source-specific fingerprint.
const GLASSDOOR_OPPORTUNITY_MODAL_MARKERS = [
  'never miss an opportunity',
  'create a job alert',
  'continue with google',
];
const GLASSDOOR_OPPORTUNITY_MODAL_SELECTOR = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  'dialog',
  '[data-test*="modal" i]',
  '[data-testid*="modal" i]',
  '[class*="modal" i]',
].join(', ');
const GLASSDOOR_OPPORTUNITY_CLOSE_SELECTOR = [
  'button[aria-label*="close" i]',
  '[role="button"][aria-label*="close" i]',
  'button[title*="close" i]',
  '[role="button"][title*="close" i]',
  'button[data-test*="close" i]',
  '[role="button"][data-test*="close" i]',
  'button[data-testid*="close" i]',
  '[role="button"][data-testid*="close" i]',
].join(', ');

function normalizedModalText(element) {
  return String(element?.textContent || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function isGlassdoorOpportunityModal(element) {
  const text = normalizedModalText(element);
  return GLASSDOOR_OPPORTUNITY_MODAL_MARKERS.every(marker => text.includes(marker));
}

function isCloseControl(element) {
  if (!element) return false;
  const label = [
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'),
    element.getAttribute?.('data-test'),
    element.getAttribute?.('data-testid'),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  const text = normalizedModalText(element);
  // The actual prompt's close control can be an icon-only X, depending on the
  // currently served Glassdoor experiment. An empty SVG button is accepted only
  // inside this exact, positively fingerprinted prompt.
  return label.includes('close') || text === 'x' || text === '×'
    || (!text && !!element.querySelector?.('svg'));
}

/**
 * Inspect the specific Glassdoor job-alert interstitial without clicking it.
 * Keeping its signature DOM-root based makes the live safety rule testable: an
 * ordinary dialog or an unrelated close icon must never qualify.
 */
export function inspectGlassdoorOpportunityModal(root) {
  if (!root?.querySelectorAll) return { detected: false, reason: 'no-dom-root' };
  const modal = Array.from(root.querySelectorAll(GLASSDOOR_OPPORTUNITY_MODAL_SELECTOR))
    .find(element => !element.closest?.('[aria-hidden="true"]') && isGlassdoorOpportunityModal(element));
  if (!modal) return { detected: false, reason: 'not-present' };
  const close = Array.from(modal.querySelectorAll(GLASSDOOR_OPPORTUNITY_CLOSE_SELECTOR))
    .find(isCloseControl)
    || Array.from(modal.querySelectorAll('button, [role="button"]')).find(isCloseControl)
    || null;
  return {
    detected: true,
    reason: close ? 'close-control-found' : 'close-control-missing',
    modal,
    close,
  };
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

const GLASSDOOR_FIRST_PARTY_HOST = /^(?:[a-z0-9-]+\.)*glassdoor\.(?:com|ca|co\.uk|ie|de|fr|es|it|nl|pt|com\.au|co\.nz|co\.in|co\.jp|com\.mx|com\.br|co\.za|com\.sg|com\.hk)$/i;

/**
 * Keep a Glassdoor detail request on the exact first-party host whose list page
 * loaded successfully. Cloudflare clearance and behavioural state are host-bound:
 * a working www.glassdoor.ca search is not evidence that www.glassdoor.com will
 * accept a burst of detail navigations from the same controlled session.
 *
 * Only sibling Glassdoor hosts are rewritten. An employer/ATS URL, malformed URL,
 * non-HTTP scheme, or non-Glassdoor list page is returned unchanged.
 */
export function pinGlassdoorDetailUrlToListHost(rawDetailUrl, rawListUrl) {
  const input = String(rawDetailUrl || '').trim();
  if (!input) return input;
  try {
    const detail = new URL(input);
    const list = new URL(String(rawListUrl || '').trim());
    if (!['http:', 'https:'].includes(detail.protocol)
      || !['http:', 'https:'].includes(list.protocol)
      || !GLASSDOOR_FIRST_PARTY_HOST.test(detail.hostname)
      || !GLASSDOOR_FIRST_PARTY_HOST.test(list.hostname)) {
      return input;
    }
    detail.hostname = list.hostname;
    return detail.toString();
  } catch {
    return input;
  }
}

/** A detached Puppeteer main frame cannot recover by navigating the next row. */
export function isDetachedDetailFrameError(error) {
  return /detached\s+frame|frame\s+was\s+detached|navigating\s+frame\s+was\s+detached/i
    .test(String(error?.message || error || ''));
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
  return descriptionNavigationDecision(sourceId, rawUrl).allowed;
}

/**
 * ZipRecruiter redirects a closed posting to its authenticated jobseeker home
 * page instead of returning a 404. Keep this URL-only so the live page probe
 * and deterministic regression tests share the same narrow classification.
 */
export function isZipRecruiterClosedDetailRedirect(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    const host = parsed.hostname.toLowerCase();
    const closed = String(parsed.searchParams.get('closed_job_redirect') || '').trim().toLowerCase();
    return (host === 'ziprecruiter.com' || host.endsWith('.ziprecruiter.com'))
      && parsed.pathname.replace(/\/+$/, '') === '/jobseeker/home'
      && ['1', 'true', 'yes'].includes(closed);
  } catch {
    return false;
  }
}

/**
 * Decide whether a detail page is conclusively unavailable rather than merely
 * slow or selector-incompatible. Workday returns HTTP 200 for a closed posting
 * and exposes that state in its bootstrap object, so status alone is not enough.
 */
export function isUnavailableDetailPage({
  isNotFound = false,
  workdayPostingAvailable,
  zipRecruiterClosedJobRedirect = false,
} = {}) {
  return Boolean(isNotFound) || workdayPostingAvailable === false || zipRecruiterClosedJobRedirect;
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

/**
 * Appcast's terminal page is distinct from a generic job-board hard block: it
 * is an outbound click.appcast.io redirect reached from a still-working
 * ZipRecruiter results page. Require both the host and its visible copy so an
 * ordinary Appcast job page or another site's generic wording cannot trigger
 * the recovery.
 */
export function isAppcastTemporaryRestriction({ url = '', visibleText = '' } = {}) {
  let isAppcastClick = false;
  try {
    const parsed = new URL(String(url || '').trim());
    isAppcastClick = parsed.hostname.toLowerCase() === 'click.appcast.io';
  } catch {
    return false;
  }
  if (!isAppcastClick) return false;
  const text = String(visibleText || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return text.includes('access is temporarily restricted')
    && text.includes('unusual activity from your device or network');
}

export function zipRecruiterAppcastRestrictionBackoffMs(attempt) {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(
    ZIPRECRUITER_APPCAST_RESTRICTED_MAX_BACKOFF_MS,
    ZIPRECRUITER_APPCAST_RESTRICTED_BACKOFF_MS * (2 ** (safeAttempt - 1)),
  );
}

/**
 * ZipRecruiter's own detail-page error shell. Require BOTH the host and its
 * exact visible copy, the same false-positive-proof shape as
 * isAppcastTemporaryRestriction: an ordinary posting that happens to discuss
 * errors cannot trigger a re-navigation. Text + URL only so the live page probe
 * and deterministic regression tests share one classification. `status` is
 * carried for telemetry but deliberately NOT gated on — the shell is served
 * with HTTP 200.
 */
export function isZipRecruiterDetailErrorShell({ url = '', visibleText = '' } = {}) {
  let isZipRecruiterHost = false;
  try {
    const parsed = new URL(String(url || '').trim());
    const host = parsed.hostname.toLowerCase();
    isZipRecruiterHost = host === 'ziprecruiter.com' || host.endsWith('.ziprecruiter.com');
  } catch {
    return false;
  }
  if (!isZipRecruiterHost) return false;
  const text = String(visibleText || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return text.includes('we encountered an error while loading this job');
}

export function zipRecruiterDetailErrorShellBackoffMs(attempt) {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(
    ZIPRECRUITER_DETAIL_ERROR_SHELL_MAX_BACKOFF_MS,
    ZIPRECRUITER_DETAIL_ERROR_SHELL_BACKOFF_MS * (2 ** (safeAttempt - 1)),
  );
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

const GLASSDOOR_RESPONSE_DESCRIPTION_MIN_CHARS = 400;

function compactGlassdoorResponseText(value) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw) return '';
  return stripHtmlToText(raw).replace(/\s+/g, ' ').trim();
}

function glassdoorResponsePathToken(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function glassdoorStructuredSalary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const firstFrom = (source, ...keys) => keys.map(key => source?.[key]).find(item => item != null && item !== '');
  const nested = firstFrom(value, 'salaryRange', 'range', 'baseSalary', 'value');
  const amountSource = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : value;
  const first = (...keys) => firstFrom(amountSource, ...keys) ?? firstFrom(value, ...keys);
  const rawUnit = String(firstFrom(value, 'unitText', 'payPeriod', 'salaryType', 'period', 'cadence')
    ?? firstFrom(amountSource, 'unitText', 'payPeriod', 'salaryType', 'period', 'cadence')
    ?? '').toUpperCase();
  const unitAliases = {
    ANNUAL: 'YEAR', ANNUALLY: 'YEAR', YEARLY: 'YEAR', HOURLY: 'HOUR',
    MONTHLY: 'MONTH', WEEKLY: 'WEEK', DAILY: 'DAY',
  };
  const unitText = unitAliases[rawUnit] || rawUnit;
  return formatJsonLdSalary({
    currency: firstFrom(value, 'currency', 'currencyCode', 'salaryCurrency')
      ?? firstFrom(amountSource, 'currency', 'currencyCode', 'salaryCurrency'),
    value: {
      minValue: first('minValue', 'min', 'minimum', 'lowerBound'),
      maxValue: first('maxValue', 'max', 'maximum', 'upperBound'),
      value: first('value', 'amount'),
      unitText,
    },
  });
}

/**
 * Extract conservative enrichment fields from the JSON body already returned
 * by Glassdoor's card-panel request. This function never performs I/O. The
 * caller separately binds the response URL's jobListingId to the clicked card,
 * while this bounded walk tolerates minor response-schema changes.
 */
export function extractGlassdoorPanelResponseDetail(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const descriptionCandidates = [];
  const salaryCandidates = [];
  const postedCandidates = [];
  const companyCandidates = [];
  const queue = [{ value: payload, path: [] }];
  const seen = new Set();
  let visited = 0;

  while (queue.length && visited < 800) {
    const current = queue.shift();
    const node = current?.value;
    if (!node || typeof node !== 'object' || seen.has(node) || current.path.length > 10) continue;
    seen.add(node);
    visited++;
    const entries = Array.isArray(node) ? node.entries() : Object.entries(node);
    for (const [rawKey, value] of entries) {
      const key = glassdoorResponsePathToken(rawKey);
      const path = [...current.path, key];
      const pathText = path.join('.');
      const jobScoped = /job|listing|posting|position|detail/.test(pathText);
      const employerScoped = /employer|company|organization/.test(pathText);

      if (typeof value === 'string') {
        const text = compactGlassdoorResponseText(value);
        const strongDescription = /^(?:job)?description(?:text|html)?$/.test(key) && key !== 'description';
        const genericJobDescription = key === 'description' && jobScoped && !employerScoped;
        if (((strongDescription && !employerScoped) || genericJobDescription)
          && text.length >= GLASSDOOR_RESPONSE_DESCRIPTION_MIN_CHARS) {
          descriptionCandidates.push({
            value: text,
            score: (strongDescription ? 120 : 80) + Math.min(20, Math.floor(text.length / 1000)),
          });
        }

        if (/salary|pay|compensation/.test(key) && text.length <= 160 && parseSalaryToNumeric(text) > 0) {
          salaryCandidates.push({ value: text, score: /display|text|range/.test(key) ? 100 : 80 });
        }
        if (/^(?:dateposted|posteddate|postingdate|listingage|age)$/.test(key) && text.length <= 120) {
          postedCandidates.push({ value: text, score: /dateposted|posteddate/.test(key) ? 100 : 70 });
        }
        if (/^(?:employername|companyname|hiringorganizationname)$/.test(key) && text.length <= 240) {
          companyCandidates.push({ value: text, score: 100 });
        } else if (key === 'name' && employerScoped && text.length <= 240) {
          companyCandidates.push({ value: text, score: 80 });
        }
      } else if (typeof value === 'number' && /^(?:ageindays|listingageindays|daysago)$/.test(key)
        && value >= 0 && value <= 3650) {
        postedCandidates.push({ value: `${value}d`, score: 70 });
      }

      if (value && typeof value === 'object') {
        if (/salary|pay|compensation/.test(key)) {
          const salary = glassdoorStructuredSalary(value);
          if (salary && parseSalaryToNumeric(salary) > 0) salaryCandidates.push({ value: salary, score: 110 });
        }
        queue.push({ value, path });
      }
    }
  }

  const best = candidates => candidates.sort((a, b) => b.score - a.score || b.value.length - a.value.length)[0]?.value || '';
  const detail = {
    description: best(descriptionCandidates),
    salary: best(salaryCandidates),
    posted: best(postedCandidates),
    company: best(companyCandidates),
  };
  return Object.values(detail).some(Boolean) ? detail : null;
}

/** Merge one exact card response with its visible panel read, without clobbering list fields. */
export function mergeGlassdoorPanelDetail(job, { domText = '', responseDetail = null } = {}) {
  const panelText = String(domText || '').trim();
  const responseText = String(responseDetail?.description || '').trim();
  const responseDescriptionUsable = responseText.length >= GLASSDOOR_RESPONSE_DESCRIPTION_MIN_CHARS;
  const description = panelText || (responseDescriptionUsable ? responseText : '');
  const existingSalaryUsable = parseSalaryToNumeric(job?.salary) > 0;
  const responseSalary = String(responseDetail?.salary || '').trim();
  const salaryRecovered = !existingSalaryUsable && parseSalaryToNumeric(responseSalary) > 0;
  const postedRecovered = !String(job?.posted || '').trim() && !!String(responseDetail?.posted || '').trim();
  const companyRecovered = !String(job?.company || '').trim() && !!String(responseDetail?.company || '').trim();
  const recoveredFields = [
    salaryRecovered ? 'salary' : '',
    postedRecovered ? 'posted' : '',
    companyRecovered ? 'company' : '',
  ].filter(Boolean);
  const mergedJob = {
    ...job,
    ...(description ? { snippet: description, descriptionCapture: panelText ? 'glassdoor-panel-dom' : 'glassdoor-panel-response-json' } : {}),
    ...(salaryRecovered ? { salary: responseSalary } : {}),
    ...(postedRecovered ? { posted: String(responseDetail.posted).trim() } : {}),
    ...(companyRecovered ? { company: String(responseDetail.company).trim() } : {}),
  };
  // Recovery may receive a row staged after an earlier 429. A verified panel or
  // exact response description makes it score-safe again; remove the explicit
  // deferral marker from the copied object without mutating recovery storage.
  if (description) delete mergedJob.descriptionDeferredReason;
  return {
    job: mergedJob,
    descriptionSource: panelText ? 'dom' : responseDescriptionUsable ? 'json' : '',
    recoveredFields,
  };
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
  const hasDescriptionText = !!String(text || '').trim();
  const mergedJob = {
    ...job,
    ...(hasDescriptionText ? { snippet: text } : {}),
    ...(hasDescriptionText && descriptionCapture ? { descriptionCapture } : {}),
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
  // A navigation detail page can recover a row that was explicitly deferred by
  // an earlier source-wide block. Keep the marker for a blank detail page, but
  // do not let it make a later verified description permanently ineligible for
  // the shared scoring-evidence gate.
  if (hasDescriptionText) delete mergedJob.descriptionDeferredReason;
  return mergedJob;
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
    || signals.hasDataDomeFrame
    || signals.hasDataDomeScript
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

async function getChallengeSignals(page) {
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
  }));
  return classifyManualChallengeSignals(evaluated);
}

function formatChallengeEvidence(signals, key = null) {
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
    signals.evaluationError ? `evaluateError=${JSON.stringify(signals.evaluationError)}` : null,
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
const OVERLAY_SCRIPT = buildOverlayScript({ withPause: true });

/**
 * Paint the in-page overlay AND record that the scrape is alive.
 *
 * Every progress signal a user needs already existed at exactly the right
 * granularity — "Opening result card 4/30", "Extracting page 3…", "Loading more
 * jobs…" — but it was written only into the scraper's own Chrome window and
 * never left it. The app, the main-process log, and the bug report were all
 * blind to work happening on screen, so a healthy multi-minute Glassdoor
 * description walk (whose per-card loop emits telemetry ONLY on failure) was
 * indistinguishable from a wedged renderer. That ambiguity is what "processing
 * stuck" reports look like.
 *
 * Wrapping the imported painter rather than editing ~30 call sites means every
 * existing paint — present and future — becomes a heartbeat for free, and the
 * beat can never drift out of sync with what the window shows.
 */
async function updateOverlay(page, state) {
  recordActivityBeat(state);
  return paintOverlay(page, state);
}

/**
 * Record one liveness beat and forward it to the renderer sink.
 *
 * Split out of updateOverlay so the throttle/emit contract is unit-testable
 * without a live page. Exported for tests only.
 */
export function recordActivityBeat(state) {
  const beat = {
    ts:         Date.now(),
    sourceId:   manualScraperTelemetry.currentSourceId || null,
    srcName:    state?.srcName ?? null,
    status:     state?.status ?? null,
    // By default every different overlay message is a meaningful progress
    // step. Tight loops can provide one stable key while their copy/count
    // changes, so the renderer limiter remains effective.
    activityKey: state?.activityKey ?? state?.activityKind ?? state?.status ?? null,
    count:      Number.isFinite(state?.count) ? state.count : null,
    queryIndex: state?.queryIndex ?? null,
    queryTotal: state?.queryTotal ?? null,
    pageNum:    state?.pageNum ?? null,
  };
  manualScraperTelemetry.beat = beat;
  // Throttled so a scroll loop cannot flood the renderer, but ordinary callers
  // still emit a changed status immediately because the fallback key is status.
  // Tight loops opt into a stable key when their changing count is not a new
  // semantic step.
  if (!activitySink) return beat;
  const changed = beat.activityKey !== lastSinkEmitKey;
  if (changed || Date.now() - lastSinkEmitAt >= ACTIVITY_SINK_MIN_INTERVAL_MS) {
    lastSinkEmitAt = Date.now();
    lastSinkEmitKey = beat.activityKey;
    try { activitySink(beat); } catch { /* a reporting sink must never break a scrape */ }
  }
  return beat;
}

/** Install the renderer activity sink. Exported for tests; runs set it via scrapeManualSources. */
export function setActivitySink(sink) {
  activitySink = typeof sink === 'function' ? sink : null;
  lastSinkEmitAt = 0;
  lastSinkEmitKey = null;
}

/**
 * Run one awaited scrape step with its identity recorded while it is in flight.
 *
 * A report written mid-walk otherwise names only the last COMPLETED phase, so
 * the operation that is actually slow is the one thing it cannot name. Records
 * a bounded marker, logs once if the step outlives IN_FLIGHT_WARN_MS, and always
 * clears — including on throw, so a failure cannot leave a phantom marker that
 * makes the next report claim a step is still running.
 */
async function withInFlight(label, detail, run) {
  const started = Date.now();
  manualScraperTelemetry.inFlight = { label, detail: detail || null, since: started };
  const warn = setTimeout(() => {
    logger.warn(`[BrowserScraper] still awaiting ${label}${detail ? ` (${detail})` : ''} after ${Math.round(IN_FLIGHT_WARN_MS / 1000)}s — the page may be unresponsive; puppeteer gives up on a wedged evaluate at 180s and this step is then retried`);
  }, IN_FLIGHT_WARN_MS);
  try {
    return await run();
  } finally {
    clearTimeout(warn);
    manualScraperTelemetry.inFlight = null;
  }
}

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
async function waitForReady(page, sourceId, overlayBase, signal, resumeUrl = null, {
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

  while (true) {
    if (signal?.aborted) return 'abort';

    const signals     = await getChallengeSignals(page);
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
          },
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
        lastChallengeBeatAt = Date.now();
        challengeHeartbeats = 0;
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
          },
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
      const challengeElapsedMs = Date.now() - challengeStartedAt;
      const formatChallengeElapsed = (ms) => {
        const sec = Math.floor(ms / 1000);
        return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
      };
      if (Date.now() - lastChallengeBeatAt >= CHALLENGE_ACTIVITY_BEAT_MS) {
        lastChallengeBeatAt = Date.now();
        recordActivityBeat({
          ...overlayBase,
          status: `⚠️ Complete the challenge above to continue (${formatChallengeElapsed(challengeElapsedMs)} waiting)`,
          challenge: true,
        });
      }
      if (Date.now() - lastChallengeHeartbeat >= challengeHeartbeatIntervalMs(challengeHeartbeats)) {
        lastChallengeHeartbeat = Date.now();
        challengeHeartbeats++;
        logger.info(`[BrowserScraper] ${overlayBase.srcName}: still waiting for the user to solve the challenge (${formatChallengeElapsed(challengeElapsedMs)} elapsed)`);
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

/**
 * Close only Glassdoor's identified job-alert prompt with a physical click.
 * A list-card click is intentionally a real mouse action; retain that property
 * for the close control too, while refusing a click when some other overlay has
 * already covered it. The returned bounded fingerprint is retained on the
 * card-walk event so FULL can distinguish a popup from selector drift.
 */
async function dismissGlassdoorOpportunityModal(page) {
  const target = await page.evaluate((modalSelector, closeSelector, markers) => {
    const normalizedText = (element) => String(element?.textContent || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const visible = (element) => {
      if (!element || element.hidden || element.closest?.('[aria-hidden="true"]')) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const describe = (element) => element ? {
      tag: String(element.tagName || '').toLowerCase(),
      id: String(element.id || '').slice(0, 80),
      role: String(element.getAttribute?.('role') || '').slice(0, 80),
      ariaLabel: String(element.getAttribute?.('aria-label') || '').slice(0, 120),
      testId: String(element.getAttribute?.('data-testid') || element.getAttribute?.('data-test') || '').slice(0, 120),
      classes: String(element.className || '').replace(/\s+/g, ' ').slice(0, 160),
      text: String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    } : null;
    const isClose = (element) => {
      const label = [
        element?.getAttribute?.('aria-label'), element?.getAttribute?.('title'),
        element?.getAttribute?.('data-test'), element?.getAttribute?.('data-testid'),
      ].filter(Boolean).join(' ').toLocaleLowerCase();
      const text = normalizedText(element);
      return label.includes('close') || text === 'x' || text === '×'
        || (!text && !!element?.querySelector?.('svg'));
    };
    const modal = Array.from(document.querySelectorAll(modalSelector))
      .find(element => visible(element) && markers.every(marker => normalizedText(element).includes(marker)));
    if (!modal) return { detected: false, action: 'none', reason: 'not-present' };
    const close = Array.from(modal.querySelectorAll(closeSelector)).find(isClose)
      || Array.from(modal.querySelectorAll('button, [role="button"]')).find(isClose)
      || null;
    if (!close || !visible(close)) {
      return { detected: true, action: 'failed', reason: 'close-control-missing', modal: describe(modal), dismiss: describe(close) };
    }
    const rect = close.getBoundingClientRect();
    const x = rect.left + (rect.width / 2);
    const y = rect.top + (rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || (!close.contains(hit) && !hit.contains(close))) {
      return { detected: true, action: 'failed', reason: 'close-control-covered', modal: describe(modal), dismiss: describe(close) };
    }
    return { detected: true, action: 'ready', reason: 'close-control-found', x, y, modal: describe(modal), dismiss: describe(close) };
  }, GLASSDOOR_OPPORTUNITY_MODAL_SELECTOR, GLASSDOOR_OPPORTUNITY_CLOSE_SELECTOR, GLASSDOOR_OPPORTUNITY_MODAL_MARKERS)
    .catch(() => ({ detected: false, action: 'none', reason: 'page-evaluate-failed' }));
  if (!target?.detected || target.action !== 'ready') return target;

  await page.mouse.move(target.x, target.y).catch(() => {});
  await page.mouse.click(target.x, target.y, { delay: humanDelay(70) }).catch(() => {});
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(resolve => setTimeout(resolve, humanDelay(140)));
    const remains = await page.evaluate((modalSelector, markers) => {
      const text = (element) => String(element?.textContent || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
      return Array.from(document.querySelectorAll(modalSelector)).some(element => {
        if (element.hidden || element.closest?.('[aria-hidden="true"]')) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
          && rect.width > 0 && rect.height > 0 && markers.every(marker => text(element).includes(marker));
      });
    }, GLASSDOOR_OPPORTUNITY_MODAL_SELECTOR, GLASSDOOR_OPPORTUNITY_MODAL_MARKERS).catch(() => false);
    if (!remains) return { ...target, action: 'dismissed', reason: 'close-control-clicked' };
  }
  return { ...target, action: 'failed', reason: 'close-control-still-visible' };
}

// ── Description expansion ─────────────────────────────────────────────────────
// Clicks each job card and captures the full description from the side panel.
// Only runs when DESC_CONFIGS[sourceId] is defined.
//
// Returns { jobs, descError, descWarning, unavailableDetailDropped } where descError is non-null when card or panel
// selectors appear stale (≥ DESC_STALE_THRESHOLD consecutive failures of the same
// type). A non-null descError is an abort signal — the caller must set earlyExit
// and surface the error just like a SITE_CHANGED extraction failure.
async function expandDescriptions(page, jobs, sourceId, overlayBase, totalSoFar, signal = null, walkPlan = null) {
  const cfg = DESC_CONFIGS[sourceId];
  if (!cfg || jobs.length === 0) {
    return {
      jobs,
      descError: null,
      descWarning: null,
      expandedCount: 0,
      // This is deliberately distinct from a description miss: a confirmed
      // closed/not-found posting is removed from the returned usable rows.
      unavailableDetailDropped: 0,
    };
  }

  const enhanced  = [...jobs];
  const cardTargets = buildDescriptionCardTargets(enhanced, sourceId);
  const physicalTotal = Number.isFinite(Number(walkPlan?.physicalTotal))
    ? Number(walkPlan.physicalTotal)
    : enhanced.length;
  const physicalIndexes = Array.isArray(walkPlan?.physicalIndexes) ? walkPlan.physicalIndexes : [];
  // Jobs collected before this batch starts — used to increment the overlay counter
  // one-by-one (baseCount + i + 1) rather than jumping to totalSoFar immediately.
  const baseCount = totalSoFar - jobs.length;
  let descWarning = null;
  // The caller retains upstream candidate identities separately. Keep the
  // subset retired after a confirmed unavailable detail page here, so reporting
  // can say what was traversed versus what remained usable.
  let unavailableDetailDropped = 0;

  // Navigation-based expansion: navigate to each job's individual page and extract
  // the description there. Used for ZipRecruiter where the extractor
  // reads jobs from JSON (all upfront) but React's virtual list may never render
  // the corresponding card DOM elements — making card-click expansion unreliable.
  if (descriptionExpansionStrategy(sourceId) === 'detail-navigation') {
    const listUrl = page.url();

    // Open a dedicated background page for detail fetches so the main list page
    // stays put — eliminates the visual ping-pong between search results and
    // individual job pages. Falls back to the main page if newPage() fails.
    let detailPage = null;
    const createDetailPage = async () => {
      const nextPage = await createBackgroundScrapePage(page.browser(), { width: 1280, height: 900 });
      await nextPage.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver',           { get: () => false });
        Object.defineProperty(navigator, 'platform',            { get: () => 'MacIntel' });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8 });
        Object.defineProperty(navigator, 'maxTouchPoints',      { get: () => 0 });
      }).catch(() => {});
      const ua = await page.evaluate(() => navigator.userAgent).catch(() => null);
      if (ua) await nextPage.setUserAgent(ua).catch(() => {});
      const vp = page.viewport();
      if (vp) await nextPage.setViewport(vp).catch(() => {});
      return nextPage;
    };
    try {
      detailPage = await createDetailPage();
    } catch {
      detailPage = null;
    }
    let fetchPage = detailPage ?? page;

    // Fire the desc/date "miss" diagnostics on the FIRST failure ANYWHERE in the
    // batch — not just i===0. A source can enrich job 0 fine but fail later ones
    // (e.g. Glassdoor serving fr.glassdoor.ca pages that soft-authwall the JD on a
    // regional domain we're not logged into), and the old i===0 gate captured zero
    // page context in exactly that case — so a "7/14 descriptions empty" report
    // had no evidence for WHY. Latches so we log one rich sample per batch.
    let descMissDiagDone = false;
    let dateMissDiagDone = false;
    let expandedCount = 0;
    let lastDetailNavigationAt = 0;
    let zipRecruiter429Retries = 0;
    let zipRecruiterAppcastRestrictionRetries = 0;
    // `i--; continue;` re-enters the loop body, so a budget counter declared
    // INSIDE the loop is reset on every retry and can never be exhausted. Keep
    // both outside and re-arm them when the row index actually changes.
    let errorShellRetryIndex = -1;
    let errorShellRetries = 0;
    try {
      for (let i = 0; i < enhanced.length; i++) {
        const job = enhanced[i];
        // Per-row flag: safe to re-initialise here because a retry of the same
        // row legitimately re-derives it.
        let detailErrorShellSeen = false;
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

        // Keep Glassdoor detail navigation on the exact country host whose list
        // page loaded successfully. Only the navigation target is rewritten.
        //
        // NOTE: no DESC_CONFIGS entry currently sets `pinToListHost`, so this
        // branch is unreachable in production today — host pinning is NOT
        // active, even though pinGlassdoorDetailUrlToListHost is unit-tested and
        // reads as though it were. It is kept (rather than deleted) because
        // Glassdoor's country redirect is a known, recurring failure mode and
        // this is the ready mitigation; enable it by setting the flag on the
        // glassdoor entry once a run actually shows cross-host detail failures.
        // Don't infer from this code that a mixed .com/.ca walk is being
        // corrected — it isn't.
        if (cfg.pinToListHost) {
          viewUrl = pinGlassdoorDetailUrlToListHost(viewUrl, listUrl);
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

        const detailGapMs = sourceId === 'ziprecruiter'
          ? ZIPRECRUITER_DETAIL_GAP_MS
          : 0;
        if (detailGapMs > 0 && lastDetailNavigationAt) {
          const waitMs = detailGapMs - (Date.now() - lastDetailNavigationAt);
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
            if (detailGapMs > 0) lastDetailNavigationAt = Date.now();
            navigationResponse = await fetchPage.goto(viewUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
          } catch (error) {
            navigationError = error;
          }
          const finalUrl = fetchPage.url();
          const navigationMoved = finalUrl && finalUrl !== previousUrl && finalUrl !== 'about:blank';
          if (navigationError && !navigationMoved) {
            const reason = String(navigationError?.message || navigationError).replace(/\s+/g, ' ').slice(0, 180);
            if (isDetachedDetailFrameError(navigationError)) {
              const unexpandedCount = enhanced.length - i;
              const samples = enhanced.slice(i, i + 3)
                .map(row => (row?.title || row?.url || '?').slice(0, 65))
                .join(', ');
              logger.warn(`[BrowserScraper] ${overlayBase.srcName} detail frame detached while opening "${job.title || job.url || '?'}" — stopping ${unexpandedCount} remaining detail request(s)`);
              recordManualScraperTelemetry({
                phase: 'detail-navigation-abort', srcName: overlayBase.srcName,
                key: `${unexpandedCount} unexpanded after detached frame | ${samples || 'none'}`,
                reason: 'detached-frame', error: reason,
                expectedUrl: viewUrl.slice(0, 240), finalUrl: finalUrl.slice(0, 240),
              }, { updateActive: false });
              descWarning = {
                code: 'description-detail-session-reset', severity: 'warn',
                evidence: `${overlayBase.srcName}'s detail tab was replaced or detached while opening "${job.title || 'an untitled listing'}". The scraper stopped ${unexpandedCount} remaining detail request(s) instead of repeatedly navigating a dead frame.`,
                suggestion: `Wait before retrying ${overlayBase.srcName}; if the site shows a verification or hard-block page in normal Chrome, let that restriction cool down before another run.`,
              };
              break;
            }
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

          // Probe normal detail pages immediately. Only a terminal/challenge
          // candidate gets an additional injection window: Cloudflare commonly
          // appends its iframe/Turnstile just after DOMContentLoaded, but adding a
          // fixed delay to every healthy row would needlessly slow the detail pass.
          let challengeSignals = await getChallengeSignals(fetchPage);
          if (challengeSignals?.suppressedReason) {
            // Same policy as the list page. A detail page has no source-shaped
            // content selector here, so before this gate a posting that merely
            // mentioned verification wording hard-blocked the entire pass.
            recordManualScraperTelemetry({
              phase: 'challenge-text-suppressed',
              sourceId,
              srcName: overlayBase.srcName,
              key: (job.title || job.url || '?').slice(0, 65),
              reason: challengeSignals.suppressedReason,
              title: challengeSignals.title,
              bodyHead: challengeSignals.bodyHead,
              url: challengeSignals.url,
              bodyTextLength: challengeSignals.bodyTextLength,
              interstitialMaxChars: CHALLENGE_INTERSTITIAL_MAX_CHARS,
              matchedVerificationMarkers: challengeSignals.matchedVerificationMarkers || [],
            }, { updateActive: false });
          }
          let detailSawInteractiveChallenge = !!challengeSignals?.interactive;
          let detailTerminalSince = null;
          if (challengeSignals?.isChallenge) {
            if (!await waitForAbortableDelay(DETAIL_CHALLENGE_SETTLE_MS, signal)) break;
            challengeSignals = await getChallengeSignals(fetchPage);
          }
          let detailChallengeDecision = resolveManualDetailChallengeDisposition({
            signals: challengeSignals,
            sawInteractiveChallenge: detailSawInteractiveChallenge,
            terminalSince: detailTerminalSince,
          });
          detailSawInteractiveChallenge = detailChallengeDecision.sawInteractiveChallenge;
          detailTerminalSince = detailChallengeDecision.terminalSince;
          let detailChallengeAction = detailChallengeDecision.disposition;
          // Detect expired listings separately from challenge redirects.
          const rawPageInfo = await fetchPage.evaluate(() => {
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
            return {
              isNotFound,
              isRateLimited,
              workdayPostingAvailable,
              finalUrl: location.href,
              visibleText: document.body?.innerText || '',
            };
          }).catch(() => ({
            isNotFound: false,
            isRateLimited: false,
            workdayPostingAvailable: null,
            finalUrl: '',
            visibleText: '',
          }));
          // A removed ZipRecruiter posting redirects an authenticated visitor to
          // its otherwise-valid jobseeker home page. It contains no 404 or
          // "expired" text, so treating it as a description-hydration miss would
          // retain a closed listing and show a misleading retry warning.
          const pageInfo = {
            ...rawPageInfo,
            zipRecruiterClosedJobRedirect: isZipRecruiterClosedDetailRedirect(rawPageInfo.finalUrl),
          };

          const appcastTemporarilyRestricted = sourceId === 'ziprecruiter'
            && isAppcastTemporaryRestriction({
              url: rawPageInfo.finalUrl || fetchPage.url(),
              visibleText: rawPageInfo.visibleText,
            });
          if (appcastTemporarilyRestricted) {
            const title = (job.title || job.url || '?').slice(0, 65);
            const retryNumber = zipRecruiterAppcastRestrictionRetries + 1;
            const recoveryAllowed = retryNumber <= ZIPRECRUITER_APPCAST_RESTRICTED_RECOVERY_RETRIES
              && !signal?.aborted;
            recordManualScraperTelemetry({
              phase: 'detail-appcast-restriction',
              sourceId,
              srcName: overlayBase.srcName,
              key: `${title} | Appcast temporarily restricted`,
              reason: recoveryAllowed ? 'recovery-attempt' : 'recovery-exhausted',
              attempt: retryNumber,
              maxAttempts: ZIPRECRUITER_APPCAST_RESTRICTED_RECOVERY_RETRIES,
              status: navigationStatus,
              expectedUrl: viewUrl.slice(0, 240),
              finalUrl: fetchPage.url().slice(0, 240),
            }, { updateActive: false });

            if (recoveryAllowed) {
              zipRecruiterAppcastRestrictionRetries = retryNumber;
              const waitMs = zipRecruiterAppcastRestrictionBackoffMs(retryNumber);
              logger.warn(`[BrowserScraper] ZipRecruiter detail redirect reached Appcast's temporary restriction for "${title}"; closing the detail tab, waiting ${Math.ceil(waitMs / 1000)}s, reloading results, then retrying once`);
              await updateOverlay(page, {
                ...overlayBase,
                count: baseCount + i + 1,
                status: `Appcast temporarily restricted — retrying in ${Math.ceil(waitMs / 1000)}s…`,
                challenge: true,
              }).catch(() => {});
              if (detailPage) {
                await detailPage.close().catch(() => {});
                detailPage = null;
                fetchPage = page;
              }
              if (!await waitForAbortableDelay(waitMs, signal)) break;
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 12_000 }).catch(() => {});
              await injectOverlay(page).catch(() => {});
              const resultsReady = await waitForReady(page, sourceId, overlayBase, signal, listUrl);
              if (!['ok', 'recovered'].includes(resultsReady)) break;
              try {
                detailPage = await createDetailPage();
                fetchPage = detailPage;
              } catch {
                detailPage = null;
                fetchPage = page;
              }
              i--; // retry the exact outbound detail navigation after list-page refresh
              continue;
            }

            logger.warn(`[BrowserScraper] ZipRecruiter Appcast restriction persisted after the bounded recovery; stopping detail enrichment for this source`);
            descWarning = {
              code: 'description-appcast-temporary-restriction',
              severity: 'block',
              shortLabel: 'Switch IP, then retry',
              actionLabel: 'Retry after IP change',
              actionTitle: 'After changing to a working VPN/network IP, retry this ZipRecruiter source from its saved results page',
              evidence: `Appcast temporarily restricted the ZipRecruiter outbound detail redirect for "${job.title || 'an untitled listing'}" after one safe recovery (close detail tab, wait, reload results, retry). Detail requests stopped to avoid escalating the restriction.`,
              suggestion: 'Wait before retrying, or switch ProtonVPN to a new working location. Then click Retry after IP change to reopen the saved ZipRecruiter results page and retry the detail pass. The app will not control your VPN or attempt to bypass the restriction.',
            };
            break;
          }

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

          if (detailChallengeAction !== 'none') {
            let detailChallengeResolved = false;
            let detailWaitResult = null;
            if (detailPage) {
              let evidence = formatChallengeEvidence(challengeSignals, job.title || job.url);
              const detailPageState = {
                interactive: !!challengeSignals?.interactive,
                normalContent: !!challengeSignals?.hasNormalContent,
                challengeShell: !!challengeSignals?.hasChallengeShell,
                perimeterX: !!challengeSignals?.hasPerimeterXBlock,
                verificationText: !!challengeSignals?.hasVerificationText,
                terminalHardBlockText: !!challengeSignals?.hasTerminalHardBlockText,
                cfFrame: !!challengeSignals?.hasCloudflareChallengeFrame,
                turnstileWidget: !!challengeSignals?.hasCloudflareTurnstileWidget,
                recaptchaFrames: Number(challengeSignals?.visibleRecaptchaFrames) || 0,
                hcaptchaFrames: Number(challengeSignals?.visibleHCaptchaFrames) || 0,
                dataDomeFrame: !!challengeSignals?.hasDataDomeFrame,
                dataDomeScript: !!challengeSignals?.hasDataDomeScript,
              };
              recordManualScraperTelemetry({
                phase: 'detail-challenge', srcName: overlayBase.srcName,
                key: (job.title || job.url || '?').slice(0, 80),
                reason: challengeSignals?.reason, title: challengeSignals?.title,
                hardBlock: !!challengeSignals?.isHardBlock,
                // The discriminator between "this page IS the challenge" and
                // "this page mentions a challenge's words". Reported so a
                // hard-block verdict can be checked, not just trusted.
                bodyTextLength: challengeSignals?.bodyTextLength ?? null,
                interstitialMaxChars: CHALLENGE_INTERSTITIAL_MAX_CHARS,
                matchedVerificationMarkers: challengeSignals?.matchedVerificationMarkers || [],
                disposition: detailChallengeAction === 'terminal-stop' ? 'terminal-hard-block' : 'interactive-presented',
                navigationStatus,
                finalUrl: String(challengeSignals?.url || fetchPage.url()).slice(0, 240),
                bodyHead: String(challengeSignals?.bodyHead || '').slice(0, 240),
                pageState: detailPageState,
              }, { updateActive: false });

              // Never hide a terminal-looking detail challenge in a background
              // tab. Keep it foregrounded for a bounded confirmation window: a
              // delayed widget becomes the ordinary foreground solve path; a
              // stable terminal page is then stopped with visible evidence.
              if (detailChallengeAction === 'terminal-stop') {
                await detailPage.bringToFront().catch(() => {});
                const terminalPresentedAt = Date.now();
                const terminalDeadline = terminalPresentedAt + DETAIL_TERMINAL_PRESENT_MS;
                let terminalPresentationAborted = false;
                while (Date.now() < terminalDeadline) {
                  const remainingMs = terminalDeadline - Date.now();
                  if (!await waitForAbortableDelay(Math.min(CONTENT_POLL_MS, remainingMs), signal)) {
                    terminalPresentationAborted = true;
                    break;
                  }
                  challengeSignals = await getChallengeSignals(fetchPage);
                  detailChallengeDecision = resolveManualDetailChallengeDisposition({
                    signals: challengeSignals,
                    sawInteractiveChallenge: detailSawInteractiveChallenge,
                    terminalSince: detailTerminalSince,
                  });
                  detailSawInteractiveChallenge = detailChallengeDecision.sawInteractiveChallenge;
                  detailTerminalSince = detailChallengeDecision.terminalSince;
                  detailChallengeAction = detailChallengeDecision.disposition;
                  if (detailChallengeAction !== 'terminal-stop') break;
                }
                const terminalVisibleMs = Date.now() - terminalPresentedAt;
                recordManualScraperTelemetry({
                  phase: 'detail-challenge', srcName: overlayBase.srcName,
                  key: (job.title || job.url || '?').slice(0, 80),
                  reason: challengeSignals?.reason,
                  title: challengeSignals?.title,
                  disposition: 'terminal-presented',
                  terminalVisibleMs,
                  terminalPresentationOutcome: terminalPresentationAborted
                    ? 'aborted'
                    : detailChallengeAction === 'foreground-wait'
                      ? 'interactive-returned'
                      : detailChallengeAction === 'none'
                        ? 'cleared'
                        : 'remained-terminal',
                  finalUrl: fetchPage.url().slice(0, 240),
                  pageState: {
                    interactive: !!challengeSignals?.interactive,
                    normalContent: !!challengeSignals?.hasNormalContent,
                    terminalHardBlockText: !!challengeSignals?.hasTerminalHardBlockText,
                    cfFrame: !!challengeSignals?.hasCloudflareChallengeFrame,
                    turnstileWidget: !!challengeSignals?.hasCloudflareTurnstileWidget,
                  },
                }, { updateActive: false });
                if (terminalPresentationAborted) {
                  await page.bringToFront().catch(() => {});
                  await injectOverlay(page).catch(() => {});
                  break;
                }
                if (detailChallengeAction === 'none') {
                  detailChallengeResolved = true;
                  await page.bringToFront().catch(() => {});
                  await injectOverlay(page).catch(() => {});
                  await updateOverlay(page, {
                    ...overlayBase,
                    count: baseCount + i + 1,
                    status: `Fetching descriptions… ${i + 1}/${enhanced.length}`,
                  }).catch(() => {});
                } else if (detailChallengeAction === 'terminal-stop') {
                  evidence = formatChallengeEvidence(challengeSignals, job.title || job.url);
                  await page.bringToFront().catch(() => {});
                  await injectOverlay(page).catch(() => {});
                }
              }

              // An interactive challenge in a background detail tab is still
              // solvable. Present that exact tab to the user, use the same stable
              // challenge gate as list navigation, then return to the list. Keep
              // extracting from the now-unlocked detail document rather than
              // navigating it again and needlessly provoking Cloudflare.
              if (detailChallengeAction === 'foreground-wait') {
                await detailPage.bringToFront().catch(() => {});
                detailWaitResult = await waitForReady(
                  detailPage,
                  sourceId,
                  overlayBase,
                  signal,
                  viewUrl,
                  {
                    challengeOnly: true,
                    initialChallengeState: {
                      sawInteractiveChallenge: detailSawInteractiveChallenge,
                      terminalSince: detailTerminalSince,
                    },
                  },
                );
                const postWaitSignals = await getChallengeSignals(fetchPage);
                await page.bringToFront().catch(() => {});
                await injectOverlay(page).catch(() => {});

                recordManualScraperTelemetry({
                  phase: 'detail-challenge', srcName: overlayBase.srcName,
                  key: (job.title || job.url || '?').slice(0, 80),
                  reason: postWaitSignals?.reason || challengeSignals?.reason,
                  title: postWaitSignals?.title || challengeSignals?.title,
                  disposition: detailWaitResult === 'ok' || detailWaitResult === 'recovered'
                    ? 'interactive-resolved'
                    : detailWaitResult === 'hard-block'
                      ? 'terminal-hard-block-after-wait'
                      : detailWaitResult === 'skip'
                        ? 'session-blocked-after-wait'
                        : 'aborted-during-wait',
                  waitResult: detailWaitResult,
                  navigationStatus,
                  finalUrl: fetchPage.url().slice(0, 240),
                  pageState: {
                    ...detailPageState,
                    postWaitInteractive: !!postWaitSignals?.interactive,
                    postWaitHardBlock: !!postWaitSignals?.isHardBlock,
                    postWaitCfFrame: !!postWaitSignals?.hasCloudflareChallengeFrame,
                    postWaitTurnstileWidget: !!postWaitSignals?.hasCloudflareTurnstileWidget,
                  },
                }, { updateActive: false });

                if (detailWaitResult === 'ok' || detailWaitResult === 'recovered') {
                  detailChallengeResolved = true;
                  logger.info(`[BrowserScraper] ${overlayBase.srcName}: detail verification resolved; returning to the list and continuing "${job.title || job.url || '?'}"`);
                  await updateOverlay(page, {
                    ...overlayBase,
                    count: baseCount + i + 1,
                    status: `Fetching descriptions… ${i + 1}/${enhanced.length}`,
                  }).catch(() => {});
                }
                if (detailWaitResult === 'abort') break;
                if (detailWaitResult !== 'ok' && detailWaitResult !== 'recovered') {
                  evidence = formatChallengeEvidence(postWaitSignals, job.title || job.url);
                }
              }

              if (!detailChallengeResolved) {
                const hardBlock = detailChallengeAction === 'terminal-stop' || detailWaitResult === 'hard-block';
                logger.warn(`[BrowserScraper] ${overlayBase.srcName}: detail enrichment ${hardBlock ? 'hard-blocked' : 'remained session-blocked'}; retaining list rows and stopping detail pass (${evidence})`);
                recordManualScraperTelemetry({
                  phase: 'desc-miss', srcName: overlayBase.srcName,
                  key: `${(job.title || job.url || '?').slice(0, 65)} | detail challenge`,
                }, { updateActive: false });
                descWarning ||= {
                  code: hardBlock ? 'description-detail-hard-block' : 'description-detail-challenge',
                  severity: hardBlock ? 'block' : 'warn',
                  ...(hardBlock ? { action: 'none', shortLabel: 'Wait, then rerun' } : {}),
                  evidence: hardBlock
                    ? `${overlayBase.srcName} returned a non-interactive human-verification hard block while fetching "${job.title || 'an untitled listing'}" (${challengeSignals?.title || 'untitled page'} at ${challengeSignals?.url || fetchPage.url()}). Detail requests stopped immediately.`
                    : `${overlayBase.srcName} re-served a verification challenge while fetching "${job.title || 'an untitled listing'}" after the detail tab was presented for solving. Relevant listing rows were retained, but this and later rows may lack full descriptions.`,
                  suggestion: hardBlock
                    ? `Do not keep retrying ${overlayBase.srcName}: wait for the IP/session restriction to cool down, confirm the site opens normally in Chrome, then rerun the search.`
                    : `Complete the site verification in normal Chrome, then rerun ${overlayBase.srcName} for full descriptions.`,
                };
                // A terminal/session-level stop must remain visible for every
                // later row whose list-time description stays empty.
                const unexpandedCount = enhanced.length - i;
                const unexpandedSample = enhanced
                  .slice(i, i + 3)
                  .map(j => (j?.title || j?.url || '?').slice(0, 65))
                  .join(', ');
                recordManualScraperTelemetry({
                  phase: 'desc-miss', srcName: overlayBase.srcName,
                  key: `${unexpandedCount} unexpanded after abort | ${unexpandedSample || 'none'}`,
                }, { updateActive: false });
                break;
              }
            }
            if (!detailPage) {
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
            let descHeartbeats = 0;
            let descBeatAt = Date.now();
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
              const descElapsedSec = Math.floor((Date.now() - descChallengeStart) / 1000);
              const descElapsedLabel = descElapsedSec < 60
                ? `${descElapsedSec}s`
                : `${Math.floor(descElapsedSec / 60)}m${descElapsedSec % 60}s`;
              // Same split as the list-page wait: the beat stays on a fixed
              // cadence so this wait is never reported as a hang, while the log
              // line backs off so it cannot evict the main-process ring.
              if (Date.now() - descBeatAt >= CHALLENGE_ACTIVITY_BEAT_MS) {
                descBeatAt = Date.now();
                recordActivityBeat({
                  ...overlayBase,
                  count: baseCount + i + 1,
                  status: `⚠️ Complete the verification to continue (${descElapsedLabel} waiting)`,
                  challenge: true,
                });
              }
              if (Date.now() - descHeartbeatAt >= challengeHeartbeatIntervalMs(descHeartbeats)) {
                descHeartbeatAt = Date.now();
                descHeartbeats++;
                logger.info(`[BrowserScraper] ${overlayBase.srcName}: still waiting for description-expansion challenge solve (${descElapsedLabel} elapsed)`);
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
          }

          // ZipRecruiter's transient error shell. This MUST sit before the
          // unavailable check: if ZR ever adds one of the not-found strings to
          // that shell, classifying it first would drop a live listing for good.
          // It sits after the challenge branch so a shell carrying a
          // late-injected Turnstile still reaches the solve path.
          const detailErrorShell = sourceId === 'ziprecruiter'
            && isZipRecruiterDetailErrorShell({
              url: rawPageInfo.finalUrl || fetchPage.url(),
              visibleText: rawPageInfo.visibleText,
            });
          if (detailErrorShell) {
            if (i !== errorShellRetryIndex) {
              errorShellRetryIndex = i;
              errorShellRetries = 0;
            }
            const title = (job.title || job.url || '?').slice(0, 65);
            const retryNumber = errorShellRetries + 1;
            const budgetLeft = retryNumber <= ZIPRECRUITER_DETAIL_ERROR_SHELL_RETRIES;
            const aborted = !!signal?.aborted;
            if (budgetLeft && !aborted) {
              // Intermediate retries go to the log only. The anomaly ring holds
              // ~20 slots and feeds the report's affected-title sample; one row
              // per attempt would let a shell storm flush every other source's
              // evidence out of it.
              errorShellRetries = retryNumber;
              const waitMs = zipRecruiterDetailErrorShellBackoffMs(retryNumber);
              logger.warn(`[BrowserScraper] ZipRecruiter served its "we encountered an error while loading this job" shell for "${title}"; re-navigating (attempt ${retryNumber}/${ZIPRECRUITER_DETAIL_ERROR_SHELL_RETRIES}) after ${Math.ceil(waitMs / 1000)}s`);
              await updateOverlay(page, {
                ...overlayBase,
                count: baseCount + i + 1,
                status: `Retrying a failed job page… ${i + 1}/${enhanced.length}`,
              });
              if (!await waitForAbortableDelay(waitMs, signal)) break;
              i--; // retry this job — the same thing the page's Reload button does
              continue;
            }
            // One terminal row per shelled row, and it must not claim retries
            // that never ran: an abort can land before the budget is spent.
            recordManualScraperTelemetry({
              phase: 'desc-miss', srcName: overlayBase.srcName,
              key: `${title} | ZipRecruiter detail error shell`,
              reason: aborted
                ? 'ziprecruiter-detail-error-shell-aborted'
                : 'ziprecruiter-detail-error-shell-exhausted',
              attempts: errorShellRetries,
              maxAttempts: ZIPRECRUITER_DETAIL_ERROR_SHELL_RETRIES,
              status: navigationStatus,
              expectedUrl: viewUrl.slice(0, 240),
              finalUrl: fetchPage.url().slice(0, 240),
            }, { updateActive: false });
            if (aborted) break;
            // Budget spent. Fall through to the description carriers exactly as
            // before and let the normal empty-description handling run; the only
            // change is that the miss is now attributed to the shell rather than
            // reported as "no description carrier matched".
            detailErrorShellSeen = true;
            logger.warn(`[BrowserScraper] ZipRecruiter detail error shell persisted for "${title}" after ${errorShellRetries} retr${errorShellRetries === 1 ? 'y' : 'ies'}; continuing without its description`);
          }

          if (isUnavailableDetailPage(pageInfo)) {
            const reason = pageInfo.zipRecruiterClosedJobRedirect
              ? 'ziprecruiter-closed-job-redirect'
              : pageInfo.workdayPostingAvailable === false
                ? 'workday-posting-unavailable'
                : 'detail-page-not-found';
            logger.info(`[BrowserScraper] ${overlayBase.srcName} dropped unavailable detail listing "${job.title || job.url || '?'}" (${reason})`);
            recordManualScraperTelemetry({
              phase: 'detail-unavailable', srcName: overlayBase.srcName,
              key: `${(job.title || job.url || '?').slice(0, 65)} | unavailable listing`,
              reason, status: navigationStatus,
              expectedUrl: viewUrl.slice(0, 240), finalUrl: fetchPage.url().slice(0, 240),
            }, { updateActive: false });
            if (enhanced[i] != null) unavailableDetailDropped += 1;
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
                  const parsed = new DOMParser().parseFromString(String(d[field]), 'text/html');
                  desc = parsed.body?.innerText?.trim() || '';
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
                const parsed = new DOMParser().parseFromString(node, 'text/html');
                return parsed.body?.innerText?.trim() || '';
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
                const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
                return parsed.body?.innerText?.trim() || '';
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
              reason: detailErrorShellSeen
                ? 'ziprecruiter-detail-error-shell'
                : 'all-description-carriers-empty',
              ...(detailErrorShellSeen ? { attempts: errorShellRetries } : {}),
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
          if (!text) {
            // The listing remains useful/relevant, but the scoring input is
            // incomplete. Report this explicitly instead of treating the source as
            // clean merely because list extraction succeeded. Multiple misses can
            // occur across both this page and later pages; retain only a bounded
            // title sample while counting every miss for the source warning.
            descWarning = mergeDescriptionDetailMissWarning(
              descWarning,
              descriptionDetailMissWarning(overlayBase.srcName, job.title),
            );
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
    return {
      jobs: enhanced.filter(Boolean),
      descError: null,
      descWarning,
      expandedCount,
      unavailableDetailDropped,
    };
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
  let panelRateLimitCount = 0;
  let panelHttpFailureCount = 0;
  let panelRequestsIssued = 0;
  // Network response events do not necessarily arrive before the next card's
  // pacing wait. Keep the issuing card so a late failure never gets assigned
  // to the card that was merely about to be opened.
  let lastPanelRequest = null;
  const panelRequestContexts = new Map();
  let proactivePanelCooldowns = 0;
  let panelJsonResponses = 0;
  let panelJsonPayloads = 0;
  let panelJsonDescriptionFallbacks = 0;
  const panelJsonFieldRecoveries = { salary: 0, posted: 0, company: 0 };
  let selectionMismatchCount = 0;
  let blockingModalsDismissed = 0;
  let blockingModalFailures = 0;
  let googleApplyLinksCaptured = 0;
  let googleApplyLinksMissing = 0;
  const googleApplyLinkMissSamples = [];
  const failureSamples = [];
  const modalSamples = [];
  const firstTransitionSamples = [];
  const lastTransitionSamples = [];
  const mismatchTransitionSamples = [];
  const selectionMismatchSamples = [];
  let interruptedAt = null;
  // Glassdoor emits the job-details API response on the same page whose panel
  // we are polling. A 429 here is conclusive: waiting for a DOM change and then
  // clicking the same card again only creates another rate-limited request. Do
  // not let that external throttle masquerade as stale selectors.
  let glassdoorPanelRateLimit = null;
  let glassdoorPanelHttpFailure = null;
  let googlePanelRateLimit = null;
  const pendingGlassdoorPanelKeys = new Set();
  const glassdoorPanelResponseDetails = new Map();
  const glassdoorPanelResponseListener = (response) => {
    if (sourceId !== 'glassdoor') return;
    try {
      const status = response.status();
      const url = response.url();
      const identity = glassdoorPanelResponseIdentity({ sourceId, status, url });
      if (!identity || !pendingGlassdoorPanelKeys.has(identity.key)) return;
      if (identity.status === 429) {
        if (!glassdoorPanelRateLimit) {
          glassdoorPanelRateLimit = {
            status,
            url: url.slice(0, 240),
            key: identity.key,
            observedAt: Date.now(),
          };
        }
        return;
      }
      if (identity.status >= 400) {
        glassdoorPanelHttpFailure = {
          status: identity.status,
          url: url.slice(0, 240),
          key: identity.key,
          observedAt: Date.now(),
        };
        return;
      }
      if (identity.status < 200 || identity.status >= 300) return;
      panelJsonResponses++;
      glassdoorPanelResponseDetails.set(identity.key, Promise.resolve()
        .then(() => response.json())
        .then(extractGlassdoorPanelResponseDetail)
        .catch(() => null));
    } catch { /* response/frame can disappear during a teardown */ }
  };
  if (sourceId === 'glassdoor') page.on('response', glassdoorPanelResponseListener);
  const googlePanelResponseListener = (response) => {
    if (sourceId !== 'google' || googlePanelRateLimit) return;
    try {
      const status = response.status();
      const url = response.url();
      if (isGoogleDescriptionPanelRateLimitResponse({ sourceId, status, url })) {
        googlePanelRateLimit = { status, url: url.slice(0, 240), observedAt: Date.now() };
      }
    } catch { /* response/frame can disappear during a teardown */ }
  };
  if (sourceId === 'google') page.on('response', googlePanelResponseListener);
  try {
  const stopForGooglePanelRateLimit = async (startIndex, key = '') => {
    if (!googlePanelRateLimit) return false;
    panelRateLimitCount++;
    const rateLimit = googlePanelRateLimit;
    rememberCardWalkFailure(startIndex + 1, key, 'panel-http-429');
    recordManualScraperTelemetry({
      phase: 'detail-panel-rate-limit', sourceId, srcName: overlayBase.srcName,
      itemIndex: startIndex + 1, itemTotal: enhanced.length,
      key: String(key).slice(0, 80), reason: 'http-429', status: rateLimit.status,
      url: rateLimit.url,
    }, { updateActive: false });
    for (let unresolvedIndex = startIndex; unresolvedIndex < enhanced.length; unresolvedIndex++) {
      enhanced[unresolvedIndex] = {
        ...enhanced[unresolvedIndex],
        descriptionDeferredReason: 'description-rate-limited',
      };
    }
    descWarning ||= {
      code: 'description-rate-limited', severity: 'block',
      evidence: `Google returned HTTP 429 while loading a job detail panel after ${expandedCount} of ${enhanced.length} listing(s) were expanded. The scraper stopped detail clicks to avoid extending the throttle.`,
      suggestion: 'Wait a few minutes, then click Solve to retry the unresolved descriptions. The collected list rows were retained, and only rows with full descriptions will be scored.',
    };
    await updateOverlay(page, {
      ...overlayBase,
      count: totalSoFar,
      status: 'Google rate-limited detail loading — keeping list results and stopping card clicks.',
    }).catch(() => {});
    return true;
  };
  const panelFailureContext = (startIndex, key = '', title = '', responseKey = '') => {
    const responseContext = responseKey ? panelRequestContexts.get(String(responseKey)) : null;
    return descriptionPanelFailureAttribution(responseContext || lastPanelRequest, {
      startIndex,
      key,
      title,
    });
  };
  // Response events can land after the bounded DOM poll, including while a
  // proactive cooldown runs.  Centralize Glassdoor's terminal handling so the
  // pre-click guard keeps the same rows, warning, and telemetry as post-poll.
  const stopForGlassdoorPanelFailure = async (startIndex, key = '', title = '') => {
    if (glassdoorPanelRateLimit) {
      const context = panelFailureContext(startIndex, key, title, glassdoorPanelRateLimit.key);
      startIndex = context.startIndex;
      key = context.key;
      title = context.title;
      panelRateLimitCount++;
      const rateLimit = glassdoorPanelRateLimit;
      const rateLimitKey = String(rateLimit.key || key);
      // Clean up by the response identity, not merely the attribution
      // fallback. The map normally resolves both to the same request, but a
      // late event must never leave an old pending key behind.
      pendingGlassdoorPanelKeys.delete(rateLimitKey);
      glassdoorPanelResponseDetails.delete(rateLimitKey);
      rememberCardWalkFailure(startIndex + 1, rateLimitKey, 'panel-http-429');
      recordManualScraperTelemetry({
        phase: 'detail-panel-rate-limit', sourceId, srcName: overlayBase.srcName,
        itemIndex: startIndex + 1, itemTotal: enhanced.length,
        key: rateLimitKey.slice(0, 80), reason: 'http-429', status: rateLimit.status,
        url: rateLimit.url,
      }, { updateActive: false });
      logger.warn(`[BrowserScraper] ${sourceId}: Glassdoor rate-limited the list-panel request for key=${rateLimitKey}; stopping card enrichment without retrying`);
      descWarning ||= {
        code: 'description-rate-limited', severity: 'block',
        evidence: `Glassdoor returned HTTP 429 while loading the right-side panel for "${title || 'an untitled listing'}". The scraper stopped panel enrichment immediately instead of retrying more cards and extending the throttle. List rows were kept, but this and later listings carry no description and are held back from scoring.`,
        suggestion: 'Wait a few minutes, then click Solve to retry the unresolved descriptions. List results were retained; deferred listings are not recorded as seen, so a later run can still collect them.',
      };
      for (let unresolvedIndex = startIndex; unresolvedIndex < enhanced.length; unresolvedIndex++) {
        enhanced[unresolvedIndex] = {
          ...enhanced[unresolvedIndex],
          descriptionDeferredReason: 'description-rate-limited',
        };
      }
      await updateOverlay(page, {
        ...overlayBase,
        count: totalSoFar,
        status: 'Glassdoor rate-limited panel loading — keeping list results and stopping description clicks.',
      }).catch(() => {});
      return true;
    }
    if (!glassdoorPanelHttpFailure) return false;
    const context = panelFailureContext(startIndex, key, title, glassdoorPanelHttpFailure.key);
    startIndex = context.startIndex;
    key = context.key;
    title = context.title;
    panelHttpFailureCount++;
    const failure = glassdoorPanelHttpFailure;
    const failureKey = String(failure.key || key);
    rememberCardWalkFailure(startIndex + 1, failureKey, `panel-http-${failure.status}`);
    recordManualScraperTelemetry({
      phase: 'detail-panel-http-error', sourceId, srcName: overlayBase.srcName,
      itemIndex: startIndex + 1, itemTotal: enhanced.length,
      key: failureKey.slice(0, 80), reason: `http-${failure.status}`,
      status: failure.status, url: failure.url,
    }, { updateActive: false });
    logger.warn(`[BrowserScraper] ${sourceId}: Glassdoor denied the list-panel request with HTTP ${failure.status} for key=${failureKey}; stopping without another request`);
    descWarning ||= {
      code: 'description-panel-http-error', severity: 'warn',
      evidence: `Glassdoor returned HTTP ${failure.status} from its right-side panel endpoint for "${title || 'an untitled listing'}". This is a source response failure, not a panel-selector timeout; the scraper stopped before issuing another request.`,
      suggestion: 'Retry Glassdoor later. List results were retained; this and later unresolved rows remain eligible for a future run.',
    };
    for (let unresolvedIndex = startIndex; unresolvedIndex < enhanced.length; unresolvedIndex++) {
      enhanced[unresolvedIndex] = {
        ...enhanced[unresolvedIndex],
        descriptionDeferredReason: 'description-panel-http-error',
      };
    }
    await updateOverlay(page, {
      ...overlayBase,
      count: totalSoFar,
      status: `Glassdoor panel request failed (HTTP ${failure.status}) — keeping list results and stopping description clicks.`,
    }).catch(() => {});
    return true;
  };
  const stopForLatePanelFailure = async (startIndex, key = '', title = '') => {
    const context = panelFailureContext(startIndex, key, title);
    if (await stopForGooglePanelRateLimit(context.startIndex, context.key)) return true;
    return stopForGlassdoorPanelFailure(context.startIndex, context.key, context.title);
  };
  const takeGlassdoorPanelResponseDetail = async (key, waitMs = 900) => {
    if (sourceId !== 'glassdoor') return null;
    const deadline = Date.now() + waitMs;
    while (!glassdoorPanelResponseDetails.has(key)
      && !glassdoorPanelRateLimit
      && !glassdoorPanelHttpFailure
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const detailPromise = glassdoorPanelResponseDetails.get(key);
    let detail = null;
    if (detailPromise) {
      detail = await Promise.race([
        detailPromise,
        new Promise(resolve => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))),
      ]);
    }
    pendingGlassdoorPanelKeys.delete(key);
    glassdoorPanelResponseDetails.delete(key);
    if (detail) panelJsonPayloads++;
    return detail;
  };
  const waitForPanelPacing = async () => {
    const pacing = descriptionPanelPacing(sourceId, panelRequestsIssued);
    if (!pacing.checkpointDue || pacing.checkpointCooldownMs <= 0) return pacing;
    proactivePanelCooldowns++;
    await updateOverlay(page, {
      ...overlayBase,
      count: totalSoFar,
      status: `Pausing ${Math.ceil(pacing.checkpointCooldownMs / 1000)}s to keep ${overlayBase.srcName} panel requests below its throttle…`,
    }).catch(() => {});
    await sleepUnlessAborted(humanCooldown(pacing.checkpointCooldownMs), signal);
    return pacing;
  };
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

  const dismissBlockingGlassdoorModal = async (itemIndex, physicalIndex, stage) => {
    if (sourceId !== 'glassdoor') return { detected: false, action: 'none', reason: 'not-glassdoor' };
    const result = await dismissGlassdoorOpportunityModal(page);
    if (!result?.detected) return result;
    if (result.action === 'dismissed') blockingModalsDismissed++;
    else if (result.action === 'failed') blockingModalFailures++;
    if (modalSamples.length < 6) {
      const control = result.dismiss
        ? [result.dismiss.ariaLabel, result.dismiss.testId, result.dismiss.tag]
          .filter(Boolean).join(' · ').slice(0, 160)
        : 'none';
      modalSamples.push({
        itemIndex,
        physicalIndex,
        stage,
        signature: 'glassdoor-job-alert',
        control,
        outcome: result.action === 'dismissed' ? 'dismissed' : String(result.reason || 'failed').slice(0, 120),
        action: result.action === 'dismissed' ? 'dismissed' : 'failed',
        reason: String(result.reason || 'unknown').slice(0, 120),
        modal: result.modal || null,
        dismiss: result.dismiss || null,
      });
    }
    return result;
  };

  const abortWithError = async (evidence, suggestion, code = 'stale-desc-selectors') => {
    logger.warn(`[BrowserScraper] ${sourceId}: ${evidence}`);
    await updateOverlay(page, {
      ...overlayBase,
      count:  totalSoFar,
      status: code === 'glassdoor-job-alert-modal'
        ? 'Glassdoor job-alert prompt blocked the card walk — retry after it is closed.'
        : 'Desc selector broken — fix selector code and restart.',
      error:  true,
    }).catch(() => {});
    await new Promise(r => setTimeout(r, humanDelay(3000)));
    descError = {
      code,
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
    if (await stopForLatePanelFailure(i, cardTargets[i]?.key, job.title)) break;
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

    const preClickModal = await dismissBlockingGlassdoorModal(i + 1, physicalIndex, 'before-card');
    if (preClickModal?.detected && preClickModal.action === 'failed') {
      missingCount++;
      rememberCardWalkFailure(i + 1, key, `blocking-modal-${preClickModal.reason || 'unresolved'}`);
      await abortWithError(
        `Glassdoor's “Never Miss an Opportunity” job-alert prompt blocked result card ${i + 1}/${enhanced.length} and could not be closed (${preClickModal.reason || 'unknown'}).`,
        'The Glassdoor job-alert prompt prevented the list-card panel from opening. Retry the source after closing the prompt, and include the CARDWALK modal sample if it repeats.',
        'glassdoor-job-alert-modal',
      );
      break;
    }

    try {
      // Scroll card into view and get coordinates for a real mouse click.
      // Real mouse events are reliably intercepted by the SPA's React event handlers;
      // untrusted DOM .click() may not be and can follow the raw href instead.
      const clickTarget = await page.evaluate(async (cardAttr, cardIdPrefix, cardHrefKey, cardDataUrlParam, clickSel, k, expectedTitle) => {
        const cardKey = (el) => {
          if (!el) return '';
          if (cardAttr) {
            const attrNode = el.matches?.(`[${cardAttr}]`)
              ? el
              : el.closest?.(`[${cardAttr}]`);
            const attrValue = attrNode?.getAttribute?.(cardAttr);
            if (attrValue) return String(attrValue);
          }
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
          if (sourceId === 'google') {
            // Google retains extracted rows after its virtualized list has
            // unmounted their cards. Those rows are still valid search results;
            // stop only this enrichment pass and leave a retry-later warning,
            // rather than misreporting a source abort as user-done.
            for (let unresolvedIndex = i; unresolvedIndex < enhanced.length; unresolvedIndex++) {
              enhanced[unresolvedIndex] = {
                ...enhanced[unresolvedIndex],
                descriptionDeferredReason: 'description-card-unavailable',
              };
            }
            descWarning ||= {
              code: 'description-card-unavailable', severity: 'block',
              evidence: `Google Jobs virtualized result cards before their detail panels could be opened. ${expandedCount} of ${enhanced.length} listing(s) received full descriptions; the remaining cards were retained but deferred.`,
              suggestion: 'Click Solve after the Google list has settled to retry the unresolved descriptions. No selector change is indicated by this virtualized-list miss.',
            };
            break;
          }
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

      await waitForPanelPacing();
      // sleepUnlessAborted intentionally resolves (rather than rejecting) so
      // cancellation can unwind the scrape cleanly.  Do not mistake that
      // successful resolution for permission to issue the next panel request.
      // In particular, a Reset during a 15s checkpoint used to wake this wait
      // and immediately click a card anyway.
      if (signal?.aborted) interruptedAt ??= i + 1;
      if (signal?.aborted) break;
      if (page.isClosed()) break;
      // A panel response can arrive after pollPanel's bounded observation
      // window, including while this checkpoint is draining.  Re-check before
      // the next click so a late Google 429 never buys one extra request.
      if (await stopForLatePanelFailure(i, key, job.title)) break;
      if (sourceId === 'glassdoor') {
        glassdoorPanelHttpFailure = null;
        glassdoorPanelResponseDetails.delete(key);
        pendingGlassdoorPanelKeys.add(key);
      }
      await page.mouse.move(clickTarget.x, clickTarget.y).catch(() => {});
      await page.mouse.click(clickTarget.x, clickTarget.y, { delay: humanDelay(80) }).catch(() => {});
      panelRequestsIssued++;
      lastPanelRequest = { startIndex: i, key, title: job.title };
      panelRequestContexts.set(key, lastPanelRequest);
      // Glassdoor can show this signup prompt only after the click that would
      // normally hydrate the side panel. Give its animation a moment, then
      // dismiss it before treating an unchanged panel as selector drift.
      await new Promise(r => setTimeout(r, humanDelay(240)));
      const postClickModal = await dismissBlockingGlassdoorModal(i + 1, physicalIndex, 'after-card-click');
      if (postClickModal?.detected && postClickModal.action === 'failed') {
        missingCount++;
        rememberCardWalkFailure(i + 1, key, `blocking-modal-${postClickModal.reason || 'unresolved'}`);
        await abortWithError(
          `Glassdoor's “Never Miss an Opportunity” job-alert prompt blocked result card ${i + 1}/${enhanced.length} after its click and could not be closed (${postClickModal.reason || 'unknown'}).`,
          'The Glassdoor job-alert prompt prevented the list-card panel from opening. Retry the source after closing the prompt, and include the CARDWALK modal sample if it repeats.',
          'glassdoor-job-alert-modal',
        );
        break;
      }

      let panelModalFailure = null;
      const pollPanel = async () => {
        const dl = Date.now() + DESC_CHANGE_TIMEOUT_MS;
        while (Date.now() < dl) {
          await new Promise(r => setTimeout(r, DESC_CHANGE_POLL_MS));
          if (glassdoorPanelRateLimit) return null;
          if (googlePanelRateLimit) return null;
          // A delayed prompt should not turn into a misleading panel timeout.
          const pendingModal = await dismissBlockingGlassdoorModal(i + 1, physicalIndex, 'await-panel');
          if (pendingModal?.detected && pendingModal.action === 'failed') {
            panelModalFailure = pendingModal;
            return null;
          }
          const panel = await page.evaluate((panelSel, panelMulti, panelSourceId, expectedTitle) => {
            if (panelMulti) {
              const text = Array.from(document.querySelectorAll(panelSel))
                // Google leaves old/preloaded panels mounted. CSS-hidden .ejCXj
                // continuations in the active aria-hidden=false panel remain
                // valid, but nothing below an aria-hidden=true panel may count.
                .filter(e => e.matches('span') && !e.closest('[aria-hidden="true"]'))
                .map(e => e.textContent?.trim()).filter(Boolean).join('\n\n').trim();
              return { text, selectedTitle: '' };
            }
            const active = Array.from(document.querySelectorAll(panelSel))
              .find(el => !el.closest('[aria-hidden="true"]'));
            const text = active?.innerText?.trim() || active?.textContent?.trim() || '';
            // The list cards carry data-jobid. Limit the title probe to the
            // active description's own ancestor chain so a matching title on
            // the left list cannot validate a stale right panel.
            let selectedTitle = '';
            if (panelSourceId === 'glassdoor' && active && expectedTitle) {
              // Decode before comparing, for the same reason the Google heading
              // probe does: a heading written into the DOM programmatically can
              // still read `&#8211;` where the parsed list card reads `–`. Here
              // the failure is quieter than Google's — no match simply leaves
              // selectedTitle empty, which marks the panel UNVERIFIED — but an
              // unverified title is exactly what stops a legitimately repeated
              // Glassdoor description from being accepted, turning a correct
              // panel read into a false timeout.
              const decodeEntities = (raw) => {
                let out = String(raw || '');
                for (let pass = 0; pass < 3; pass++) {
                  const next = new DOMParser().parseFromString(out, 'text/html').documentElement.textContent || '';
                  if (next === out) break;
                  out = next;
                }
                return out;
              };
              const expected = decodeEntities(expectedTitle).replace(/\s+/g, ' ').trim().toLocaleLowerCase();
              const equivalent = (value) => {
                const title = String(value || '').replace(/\s+/g, ' ').trim();
                const normalized = decodeEntities(title).toLocaleLowerCase();
                return title && (normalized === expected || normalized.includes(expected) || expected.includes(normalized));
              };
              let scope = active.parentElement;
              for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
                const matching = Array.from(scope.querySelectorAll('[data-test*="job-title" i], [data-testid*="job-title" i], h1, h2, h3, [role="heading"]'))
                  .filter(el => !el.closest?.('[aria-hidden="true"]') && !el.closest?.('[data-jobid]'))
                  .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
                  .find(equivalent);
                if (matching) {
                  selectedTitle = matching;
                  break;
                }
              }
            }
            return { text, selectedTitle };
          }, cfg.panelSelector, cfg.panelMulti || false, sourceId, String(job.title || '')).catch(() => ({ text: '', selectedTitle: '' }));
          const decision = assessDescriptionPanelUpdate({
            sourceId,
            previousText: prevPanelText,
            currentText: panel.text,
            expectedTitle: job.title,
            selectedTitle: panel.selectedTitle,
          });
          if (decision.accepted) return panel.text;
        }
        return null;
      };

      let panelText = await pollPanel();
      if (panelModalFailure) {
        missingCount++;
        rememberCardWalkFailure(i + 1, key, `blocking-modal-${panelModalFailure.reason || 'unresolved'}`);
        await abortWithError(
          `Glassdoor's “Never Miss an Opportunity” job-alert prompt blocked result card ${i + 1}/${enhanced.length} while its panel was loading and could not be closed (${panelModalFailure.reason || 'unknown'}).`,
          'The Glassdoor job-alert prompt prevented the list-card panel from opening. Retry the source after closing the prompt, and include the CARDWALK modal sample if it repeats.',
          'glassdoor-job-alert-modal',
        );
        break;
      }
      const glassdoorResponseDetail = sourceId === 'glassdoor'
        ? await takeGlassdoorPanelResponseDetail(key)
        : null;
      if (await stopForGooglePanelRateLimit(i, key)) break;
      if (await stopForGlassdoorPanelFailure(i, key, job.title)) break;
      if (!panelText && descriptionPanelRetryAllowed(sourceId)) {
        // Transient panel-data fetch failures (for example a temporary 403)
        // leave the right panel stuck on the previous card so the change-poll
        // times out. A brief cool-off then one fresh click catches most of
        // these without slowing the happy path. Glassdoor deliberately does
        // not retry: its same-request JSON capture is the only fallback, so one
        // unresolved listing cannot double the panel request rate.
        const retryCheckpoint = await waitForPanelPacing();
        const retryPacing = descriptionPanelPacing(sourceId, panelRequestsIssued);
        const retryWait = Math.max(DESC_RETRY_PAUSE_MS, retryPacing.requestDelayMs);
        // The checkpoint is itself a longer-than-normal inter-request pause
        // for the configured sources.  Do not stack the ordinary retry gap on
        // top of it; that made every eighth retry wait twice without adding
        // throttle protection.  Keep a gap for any future config whose
        // cooldown is shorter than its required request cadence.
        const checkpointCoversRetryGap = retryCheckpoint.checkpointDue
          && retryCheckpoint.checkpointCooldownMs >= retryWait;
        if (!checkpointCoversRetryGap) {
          await sleepUnlessAborted(
            retryPacing.checkpointEvery
              ? humanCooldown(retryWait)
              : humanDelay(retryWait),
            signal,
          );
        }
        if (signal?.aborted) break;
        if (page.isClosed()) break;
        // The initial poll checks this too, but a callback can be delivered
        // while the retry pause is in progress.  This immediate check matters
        // for a one-card batch: there may be no next loop iteration to notice
        // the throttle.
        if (await stopForGooglePanelRateLimit(i, key)) break;
        await page.mouse.click(clickTarget.x, clickTarget.y, { delay: humanDelay(80) }).catch(() => {});
        panelRequestsIssued++;
        lastPanelRequest = { startIndex: i, key, title: job.title };
        panelRequestContexts.set(key, lastPanelRequest);
        panelText = await pollPanel();
        // A retry is a real panel request and can be the one that receives the
        // 429.  Stop and mark the current/later rows before continuing with
        // title extraction; otherwise a final-card 429 is silently lost.
        if (await stopForGooglePanelRateLimit(i, key)) break;
        if (panelModalFailure) {
          missingCount++;
          rememberCardWalkFailure(i + 1, key, `blocking-modal-${panelModalFailure.reason || 'unresolved'}`);
          await abortWithError(
            `Glassdoor's “Never Miss an Opportunity” job-alert prompt blocked result card ${i + 1}/${enhanced.length} on its retry and could not be closed (${panelModalFailure.reason || 'unknown'}).`,
            'The Glassdoor job-alert prompt prevented the list-card panel from opening. Retry the source after closing the prompt, and include the CARDWALK modal sample if it repeats.',
            'glassdoor-job-alert-modal',
          );
          break;
        }
      }

      // The list-card htidocid check above proves where the click landed. Google
      // can still lag its detail panel, so validate the active panel heading as
      // a second independent identity before accepting text into this job. A
      // missing heading is tolerated (markup varies); an explicit different
      // heading is not.
      const readSelectedGoogleTitle = () => page.evaluate((expectedTitle) => {
        // Same asymmetry as `normalizedDetailTitle` in this module: the expected
        // title arrives entity-decoded from the pipeline while a heading's
        // textContent can still read `&#8211;` when Google double-encodes it.
        // Left unhandled, the correct heading fails this match and the picker
        // falls through to `headings[0]` — handing the verdict a heading that
        // belongs to a different job. A detached <textarea> is the standard
        // in-page decoder and never executes scripts; the bounded repeat
        // unwraps `&amp;#8211;`, which one pass leaves as `&#8211;`.
        const decodeEntities = (raw) => {
          let out = String(raw || '');
          for (let pass = 0; pass < 3; pass++) {
            const next = new DOMParser().parseFromString(out, 'text/html').documentElement.textContent || '';
            if (next === out) break;
            out = next;
          }
          return out;
        };
        const normalize = (raw) => decodeEntities(raw).replace(/\s+/g, ' ').trim().toLocaleLowerCase();
        const headings = Array.from(document.querySelectorAll('[aria-hidden="false"]'))
          .flatMap(region => Array.from(region.querySelectorAll('h1, h2, h3, [role="heading"]')))
          .filter(el => !el.closest('[aria-hidden="true"]'))
          .filter(el => !el.closest('[data-share-url]'))
          .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const expected = normalize(expectedTitle);
        return headings.find((heading) => {
          const value = normalize(heading);
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

      // Google's list-card URL is only an internal htidocid carrier. Once the
      // verified detail panel is active, capture the real employer/aggregator
      // destination exposed by its "Apply on …" controls. This becomes the
      // user-facing job.url while googleCardUrl remains the click/dedup key.
      if (sourceId === 'google' && !selectionAssessment.selectionMismatch) {
        const applyResult = await waitForGoogleApplyDestination(page, job.applySource);
        if (applyResult.url) {
          enhanced[i] = { ...enhanced[i], url: applyResult.url };
          googleApplyLinksCaptured++;
        } else {
          googleApplyLinksMissing++;
          if (googleApplyLinkMissSamples.length < 4) {
            googleApplyLinkMissSamples.push({
              itemIndex: i + 1,
              title: String(job.title || '(untitled)').replace(/\s+/g, ' ').trim().slice(0, 100),
              preferredSource: String(job.applySource || '').replace(/\s+/g, ' ').trim().slice(0, 80),
              candidateLabels: [...new Set((applyResult.candidates || [])
                .map(candidate => String(candidate?.label || '').replace(/\s+/g, ' ').trim().slice(0, 80))
                .filter(Boolean))].slice(0, 3),
            });
          }
        }
      }

      let gotDescription = false;
      if (sourceId === 'glassdoor') {
        const merged = mergeGlassdoorPanelDetail(job, {
          domText: panelText,
          responseDetail: glassdoorResponseDetail,
        });
        enhanced[i] = merged.job;
        if (merged.descriptionSource === 'dom') prevPanelText = panelText;
        if (merged.descriptionSource === 'json') panelJsonDescriptionFallbacks++;
        for (const field of merged.recoveredFields) panelJsonFieldRecoveries[field]++;
        gotDescription = !!merged.descriptionSource;
        if (gotDescription) expandedCount++;
      } else if (panelText) {
        // This row may have entered the recovery pool with an explicit
        // deferral marker from an earlier rate-limit/card miss. A verified
        // detail panel is the evidence that resolves that condition. Leaving
        // the old marker on the otherwise-full row makes downstream admission
        // (correctly) reject it forever, so every later Solve reopens the same
        // card and falsely reports fresh progress.
        enhanced[i] = { ...enhanced[i], snippet: panelText };
        delete enhanced[i].descriptionDeferredReason;
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
    const nextPanelPacing = descriptionPanelPacing(sourceId, panelRequestsIssued);
    // Pacing is strictly between panel requests.  The final card has no next
    // request, and a due checkpoint will already provide a longer pre-click
    // pause on the next iteration.  Skipping both avoids needless completion
    // latency and the former gap+checkpoint double wait at requests 8, 16….
    const hasNextCard = i + 1 < enhanced.length;
    const checkpointCoversNextGap = nextPanelPacing.checkpointDue
      && nextPanelPacing.checkpointCooldownMs >= nextPanelPacing.requestDelayMs;
    if (hasNextCard && !checkpointCoversNextGap) {
      await sleepUnlessAborted(
        nextPanelPacing.checkpointEvery
          ? humanCooldown(nextPanelPacing.requestDelayMs)
          : humanDelay(nextPanelPacing.requestDelayMs),
        signal,
      );
      if (signal?.aborted) {
        interruptedAt ??= i + 2;
        break;
      }
    }
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
    panelRateLimits: panelRateLimitCount,
    panelHttpFailures: panelHttpFailureCount,
    panelRequestsIssued,
    proactivePanelCooldowns,
    panelJsonResponses,
    panelJsonPayloads,
    panelJsonDescriptionFallbacks,
    panelJsonFieldRecoveries,
    panelPacing: descriptionPanelPacing(sourceId, 0),
    selectionMismatches: selectionMismatchCount,
    selectionMismatchSamples,
    blockingModalsDismissed,
    blockingModalFailures,
    googleApplyLinksCaptured,
    googleApplyLinksMissing,
    googleApplyLinkMissSamples,
    modalSamples,
    failureSamples,
    transitionSamples: [...transitionSamplesByIndex.values()].sort((a, b) => a.itemIndex - b.itemIndex),
    aborted,
    interruptedAt,
    abortReason: aborted ? 'user-cancelled' : null,
    physicalTotal,
    strategy: 'list-card-panel',
    panelSelector: cfg.panelSelector,
  }, { updateActive: false });

  return {
    jobs: enhanced,
    descError,
    descWarning,
    expandedCount,
    attemptedCount,
    missingCount,
    panelTimeoutCount,
    panelRateLimitCount,
    panelHttpFailureCount,
    selectionMismatchCount,
    unavailableDetailDropped,
  };
  } finally {
    if (sourceId === 'glassdoor') page.off('response', glassdoorPanelResponseListener);
    if (sourceId === 'google') page.off('response', googlePanelResponseListener);
  }
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
export async function enrichResolvedJobDescriptions(page, jobs, sourceId, signal = null, walkPlan = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const srcName = SOURCE_LABELS[sourceId] || sourceId || 'Job source';
  const overlayBase = {
    srcLabel: 'Resolved source',
    srcName,
    qLabel: 'Recovered results',
    qText: '',
  };
  // This pass runs AFTER the main multi-source run's own completion, so
  // `active` may still be pinned to a stale/unrelated source (or a `finished`
  // state — see clearManualScraperTelemetry). Every per-card phase inside
  // expandDescriptions passes updateActive:false by design (a card's outcome
  // must never overwrite the run's current context), so without one reset
  // here nothing would ever re-point `active` at the source actually
  // recovering — a report opened mid-pass would keep naming whatever ran
  // before it, however many hours ago that was.
  recordManualScraperTelemetry({ phase: 'recovery-start', sourceId, srcName, count: list.length });
  try {
    return await expandDescriptions(page, list, sourceId, overlayBase, list.length, signal, walkPlan);
  } finally {
    // Settle the slot the same way an ordinary run's completion does, so a
    // report opened after this pass ends sees it as over — not as a recovery
    // that has been silently "in progress" ever since.
    clearManualScraperTelemetry('finished');
  }
}

// ── Next-page clicker ─────────────────────────────────────────────────────────
// Inspect a conventional next-page control independently of each source's
// configured selector. This is deliberately narrow: a visible, enabled control
// whose accessible text/title says "next page" is strong evidence that stopping
// here would silently truncate a paginated search. It lets us surface selector
// drift as an actionable warning instead of treating page 1 as a clean finish.
// Which label family counts as "there is more to fetch" depends on how the
// source advances. A board that appends in place ("Show more jobs") is just as
// much proof of an unfinished walk as a conventional pager, but a
// `next page`-only pattern cannot see one — so a load-more source whose
// configured selector had gone stale ended at page 1 and was reported as a
// clean `completed`.
//
// The two families stay SEPARATE rather than merging into one pattern: a pager
// source that has genuinely reached its last page often still shows an
// end-of-results "More jobs like this" link, and matching that would turn every
// completed pager walk into a false blocking warning.
//
// Held as pattern SOURCE strings, not RegExp literals, because the matching runs
// inside page.evaluate — which is serialized into the browser and cannot close
// over anything here. Passing the source across keeps one testable definition
// instead of a copy in the page context that could silently drift.
export const ADVANCE_CONTROL_LABEL_PATTERNS = Object.freeze({
  pager:    String.raw`\bnext\s+page\b`,
  loadMore: String.raw`\b(show|load|view|see)\s+(\d+\s+)?more\s+jobs?\b`,
});

async function inspectNextPageControl(page, { loadMore = false } = {}) {
  const labelPattern = loadMore
    ? ADVANCE_CONTROL_LABEL_PATTERNS.loadMore
    : ADVANCE_CONTROL_LABEL_PATTERNS.pager;
  try {
    return await page.evaluate((patternSource) => {
      const normalized = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const ADVANCE_LABEL = new RegExp(patternSource);
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
          ADVANCE_LABEL.test(label);
      });
      if (!candidate) return null;
      return {
        label: String(candidate.getAttribute('aria-label') || candidate.getAttribute('title') || candidate.textContent || 'Next page').replace(/\s+/g, ' ').trim(),
        href: candidate instanceof HTMLAnchorElement ? candidate.href : null,
      };
    }, labelPattern);
  } catch {
    return null;
  }
}

// Returns the click result plus any enabled next-page control that remains
// unhandled. Callers must never collapse the latter into a normal completion.
async function clickNextPage(page, sourceId) {
  const sel = NEXT_PAGE_SELECTORS[sourceId];
  // A SCROLL source has no pager by construction, so probing for one can only
  // produce a false alarm — and the probe raises a BLOCK-severity warning.
  // It matches on the TEXT of every <a>/<button>, and on a job board that text
  // is job-title-derived: a posting titled "Next Page Media — Engineer" would
  // trip it. Measured on Google: zero real controls among 846 anchors and 1125
  // buttons, plus four near-misses in card aria-labels ("…Next-Generation
  // Network Management Platform…") that only escaped because they are
  // role="button" divs. Skip the probe rather than wait for one to land.
  if (!sel && SCROLL_SOURCES.has(sourceId)) return { clicked: false, unhandled: null };
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

// ── Load-more ("Show more jobs") advance ──────────────────────────────────────
// Some boards replaced their pager with an in-page append: one URL load, then a
// button that grows the SAME list. Glassdoor did exactly that (see the
// `loadMoreSelector` note on its entry in jobs.js) — its `?p=N` param is
// ignored, so a URL/pager walk re-serves page 1 forever and a next-page click
// finds nothing. The selector is supplied by the task rather than inferred here,
// so this stays a wiring path and not a guess about any site's markup.
//
// Same contract as clickNextPage: never collapse an unhandled-but-present
// control into a normal completion, or a stale selector reads as an exhausted
// board.
async function clickLoadMore(page, sel) {
  try {
    const clicked = await page.evaluate((s) => {
      const btn = document.querySelector(s);
      if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
      const style = window.getComputedStyle(btn);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    }, sel);
    return { clicked, unhandled: clicked ? null : await inspectNextPageControl(page, { loadMore: true }) };
  } catch {
    return { clicked: false, unhandled: await inspectNextPageControl(page, { loadMore: true }) };
  }
}

// Wait for an in-page append to actually add rows. Unlike a pager there is no
// navigation to await, and the click resolves long before the XHR lands. A
// count that never grows means the board had nothing more to give — a real
// end-of-results, not a failure.
//
// Measures the RAW row count, deliberately not countDistinctJobs: the caller's
// baseline is `extracted.length`, and that same raw length is what its
// `extracted.slice(prevCount)` index is expressed in. Mixing a de-duplicated
// count against a raw-length baseline would under-report growth on a list
// carrying duplicate DOM rows and end the walk early. Duplicates are already
// absorbed downstream by the providerSeen/seen key sets.
/**
 * page.url() that cannot throw. A page torn down mid-walk (navigation, crash,
 * abort) makes url() throw, and a page-turn assertion must never be the thing
 * that kills a scrape.
 */
function safePageUrl(page) {
  try { return page.url() || null; } catch { return null; }
}

/**
 * Wait for a URL-paginated source to actually land on a new URL after a
 * next-page click. Returns true once the URL differs from `beforeUrl`, false if
 * it never changes within CONTENT_TIMEOUT_MS.
 *
 * This is the missing assertion behind the "no-new-jobs" false stop: the click
 * itself resolves immediately, so without waiting for the URL to change the
 * extractor can read the previous page's document.
 */
async function waitForUrlChange(page, beforeUrl, signal, timeoutMs = CONTENT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    const current = safePageUrl(page);
    if (current && current !== beforeUrl) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function waitForListGrowth(page, extractorJS, previousCount, signal, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return previousCount;
    const raw = await page.evaluate(extractorJS).catch(() => []);
    const count = Array.isArray(raw) ? raw.length : 0;
    if (count > previousCount) return count;
    await new Promise(r => setTimeout(r, 500));
  }
  return previousCount;
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
/**
 * Read a board's own advertised result total, where that number is known to be
 * trustworthy.
 *
 * Only ZipRecruiter qualifies, and only on its query-string SERP: walked to the
 * end, its header matched the reachable count exactly (520 reachable against a
 * 520 header). Its /jobs-search/N path form instead shows a capped "1000+" that
 * is not a count at all. Every other board measured is unusable for this —
 * Glassdoor UNDER-reports and its number drifts upward while paginating,
 * LinkedIn buckets to "1,000+" over a corpus that stops at 1,000, and Google
 * publishes no total.
 *
 * Returns null when no trustworthy number is present. Never throws.
 *
 * @returns {Promise<number|null>}
 */
async function readClaimedResultTotal(page, sourceId) {
  if (sourceId !== 'ziprecruiter') return null;
  try {
    // Our own overlay is a real DOM node inside the page, so document.innerText
    // INCLUDES its status line ("Loading jobs… 141"). Reading the whole body
    // could therefore report the scraper's own number as the board-advertised
    // total. Hide the panel for the read (innerText skips display:none), prefer
    // the results heading, and restore the panel immediately.
    const text = await page.evaluate(() => {
      const overlay = document.getElementById('__ic-panel');
      const prev = overlay ? overlay.style.display : null;
      if (overlay) overlay.style.display = 'none';
      try {
        const heading = document.querySelector('h1')?.innerText || '';
        return heading.trim() || document.body?.innerText || '';
      } finally {
        if (overlay) overlay.style.display = prev || '';
      }
    });
    return parseClaimedResultTotal(text);
  } catch {
    return null;
  }
}

/**
 * Pull a board's advertised result total out of its page text.
 *
 * Split from readClaimedResultTotal so the parsing is unit-testable without a
 * browser. Rejects the two shapes that are NOT totals:
 *   - a capped "1000+ jobs", which is a ceiling the path-form SERP shows; and
 *   - a "Showing results 501-520" range, which is a window, not a count.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseClaimedResultTotal(text) {
  const body = String(text == null ? '' : text);
  if (/\b1000\+/.test(body)) return null;
  const match = body.match(/([\d,]{1,9})\s+(?:[\w-]+\s+){0,4}?jobs?\b/i);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Return the 1-based page encoded by ZipRecruiter's /jobs-search[/N] route. */
export function zipRecruiterSearchPageNumber(value) {
  try {
    const pathname = new URL(String(value || '')).pathname.replace(/\/+$/, '');
    if (pathname === '/jobs-search') return 1;
    const match = pathname.match(/^\/jobs-search\/(\d+)$/);
    const page = match ? Number(match[1]) : NaN;
    return Number.isInteger(page) && page >= 1 ? page : null;
  } catch {
    return null;
  }
}

/**
 * ZipRecruiter can stop rendering its Next link after page 20 even while a
 * direct /jobs-search/21 request serves new rows. Probe that hidden tail only
 * when the board itself says more results exist and the hub's page limit still
 * permits another page. Other sources must retain their verified controls.
 */
export function shouldTryZipRecruiterDirectContinuation({
  sourceId,
  claimedTotal,
  collected,
  pageNum,
  maxPages,
  hasNextUrl,
} = {}) {
  return sourceId === 'ziprecruiter'
    && Number.isFinite(Number(claimedTotal))
    && Number(claimedTotal) > Number(collected || 0)
    && Number.isInteger(pageNum)
    && Number.isInteger(maxPages)
    && pageNum < maxPages
    && hasNextUrl === true;
}

/**
 * Decide whether one verified direct reload is warranted after ZipRecruiter's
 * normal pager successfully lands on an empty page below its trustworthy
 * advertised total. This is deliberately narrower than the hidden-tail
 * continuation above: the direct URL must identify the page we just reached,
 * and a retry is never repeated. A headline total is only a shortfall signal,
 * never proof that every advertised listing is reachable.
 */
export function zipRecruiterProviderShortfallRecoveryOutcome({
  sourceId,
  claimedTotal,
  providerGathered,
  pageNum,
  maxPages,
  hasNextUrl,
  pageIdentityValid,
  retryAttempted = false,
  documentReloaded = false,
  extractedRows = 0,
} = {}) {
  const shortfall = sourceId === 'ziprecruiter'
    && Number.isFinite(Number(claimedTotal))
    && Number(claimedTotal) > Number(providerGathered || 0)
    && Number.isInteger(pageNum)
    && Number.isInteger(maxPages)
    && pageNum >= 1
    && pageNum <= maxPages;
  if (!shortfall) return 'not-applicable';
  if (retryAttempted) {
    return pageIdentityValid && documentReloaded && Number(extractedRows) > 0 ? 'recovered' : 'shortfall';
  }
  return hasNextUrl === true && pageIdentityValid ? 'retry' : 'shortfall';
}

/**
 * Keep the retry provenance safe to carry through jobs.js's terminal-source
 * receipt. In particular, the direct URL used for the reload is browser-only:
 * its query can carry provider search and tracking values and must never enter
 * a durable result/report field.
 */
export function providerTotalShortfallRecoveryReceipt(recovery) {
  if (!recovery || typeof recovery !== 'object') return null;
  const boundedInteger = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  const status = typeof recovery.status === 'string'
    ? recovery.status.replace(/[^a-z0-9-]/gi, '').slice(0, 80)
    : '';
  if (!status) return null;
  const receipt = {
    pageNum: boundedInteger(recovery.pageNum),
    attempts: boundedInteger(recovery.attempts),
    status,
    rawRows: boundedInteger(recovery.rawRows),
    newProviderRows: boundedInteger(recovery.newProviderRows),
    shortfall: boundedInteger(recovery.shortfall),
  };
  const terminalPageNum = boundedInteger(recovery.terminalPageNum);
  if (terminalPageNum != null) receipt.terminalPageNum = terminalPageNum;
  return receipt;
}

// A persistent shortfall must remain a usable completed source: the rows we
// did collect are valid, and a drifting provider headline is not a target we
// can hold the whole pipeline hostage to. It is nevertheless actionable, so
// carry a compact non-gating warning to the completed Job Search UI rather
// than leaving this fact visible only in a later bug report/terminal receipt.
export function zipRecruiterProviderTotalShortfallWarning({
  claimedTotal,
  providerGathered,
  retryStatus = '',
} = {}) {
  const total = Number.isSafeInteger(Number(claimedTotal)) && Number(claimedTotal) > 0
    ? Number(claimedTotal)
    : null;
  const gathered = Number.isSafeInteger(Number(providerGathered)) && Number(providerGathered) >= 0
    ? Number(providerGathered)
    : null;
  if (total == null || gathered == null || gathered >= total) return null;
  const retry = typeof retryStatus === 'string' && retryStatus
    ? ` The one verified page reload ended ${retryStatus.replace(/[^a-z0-9-]/gi, '').slice(0, 80) || 'without additional coverage'}.`
    : '';
  return {
    code: 'provider-total-shortfall',
    severity: 'warn',
    shortLabel: 'Partial result coverage',
    evidence: `ZipRecruiter returned an empty page after ${gathered} of ~${total} advertised candidate identities were traversed.${retry}`,
    suggestion: 'Partial rows were kept. Rerun this source later to try its pager again; the advertised total can drift and is not treated as an exhaustive target.',
  };
}

/**
 * Scroll a lazy list with TRUSTED wheel input.
 *
 * Puppeteer's page.mouse.wheel dispatches through CDP Input.dispatchMouseEvent,
 * so the page sees `isTrusted: true` — the difference that decides whether
 * Google's batch loader runs at all. The mouse is parked over a real card first,
 * because a wheel event scrolls whatever sits under the cursor: without the
 * move, the wheel lands on the document instead of the inner results container
 * and the list never advances.
 *
 * Fails soft. This is a reveal optimisation, not a correctness gate — a
 * detached frame or a card that never rendered must not end the scrape.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} cardSelector Any card in the list, used to aim the cursor.
 * @param {number} steps Wheel ticks to send.
 */
async function revealByTrustedWheel(page, cardSelector, steps = 12) {
  try {
    // Aim at a card that is actually ON SCREEN. querySelector returns the FIRST
    // card, which scrolls above the viewport after the first pass — its rect
    // goes negative, and a wheel dispatched at negative coordinates lands
    // outside the results container and reveals nothing. Pick the first card
    // intersecting the viewport instead, and fall back to the viewport centre so
    // a pass is never skipped just because no card rect was usable.
    const box = await page.evaluate((sel) => {
      const vh = window.innerHeight || 800;
      const vw = window.innerWidth || 1200;
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.bottom <= 0 || r.top >= vh) continue;      // fully off-screen
        const y = Math.min(Math.max(r.top + Math.min(r.height / 2, 80), 8), vh - 8);
        const x = Math.min(Math.max(r.left + r.width / 2, 8), vw - 8);
        return { x, y };
      }
      return { x: Math.floor(vw / 2), y: Math.floor(vh / 2) };
    }, cardSelector);
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return false;
    await page.mouse.move(box.x, box.y);
    const viewport = page.viewport?.() || { height: 800 };
    for (let i = 0; i < steps; i++) {
      const height = Number(viewport?.height) > 0 ? Number(viewport.height) : 800;
      const delta = Math.floor(height * (0.55 + Math.random() * 0.3));
      await page.mouse.wheel({ deltaY: delta });
      await new Promise(r => setTimeout(r, 90 + Math.random() * 120));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Consecutive no-growth reveal passes required before calling a scroll list
 * finished. Must exceed the longest observed stall INSIDE a still-growing list
 * (one pass, at each ten-card batch boundary on Google) with margin for a slow
 * network, while staying far below the iteration ceiling.
 */
export const REVEAL_STABLE_PASSES = 5;

/**
 * Board-published "no more results" markers, checked during the reveal loop.
 *
 * Google keeps this node present on a ZERO-result page with empty text, so the
 * predicate must read the text, never just the element. Anchored on `jsname`,
 * which held stable across every page observed; the sibling class names are
 * obfuscated build output and churn.
 */
const REVEAL_END_OF_LIST_SELECTORS = { google: '[jsname="OR4M9d"]' };

async function revealEndOfListReached(page, sourceId) {
  const selector = REVEAL_END_OF_LIST_SELECTORS[sourceId];
  if (!selector) return false;
  try {
    return await page.evaluate(
      (sel) => !!document.querySelector(sel)?.textContent?.trim(),
      selector,
    );
  } catch {
    // Diagnostics-grade signal only — a detached frame must never end a walk.
    return false;
  }
}

async function preloadContent(page, sourceId, extractorJS, overlayBase, signal, { maxPages, jobsPerPlatform, existingJobs = 0 }) {
  const isScroll = SCROLL_SOURCES.has(sourceId);
  if (!isScroll) return null;

  let prevCount = -1;
  let iterations = 0;
  let count = 0;
  let stableStreak = 0;
  // How the reveal loop ended, so a run that stopped early stops being
  // indistinguishable from one that revealed the whole list. Without this the
  // scroll loop emitted NO telemetry at all and a reveal that plateaued at 30 of
  // ~96 cards was reported downstream as a clean `completed`.
  let exit = 'plateau';
  while (true) {
    if (signal?.aborted) { exit = 'aborted'; break; }
    // Ceiling on top of the "count stopped increasing" exit below. A source
    // that trickles in one marginally-new item per reveal action forever would
    // otherwise never plateau exactly.
    if (++iterations > maxPages) {
      logger.info(`[BrowserScraper] preloadContent(${sourceId}) hit the ${maxPages}-iteration ceiling — stopping reveal actions`);
      exit = 'iteration-ceiling';
      break;
    }
    const raw   = await page.evaluate(extractorJS).catch(() => []);
    count = countDistinctJobs(raw);
    const target = Number.isFinite(jobsPerPlatform) ? Math.max(0, jobsPerPlatform - existingJobs) : null;
    await updateOverlay(page, {
      ...overlayBase,
      // Both paints in this hot loop describe the same reveal operation. Keep
      // the visible count fresh in Chrome, but coalesce their renderer beats.
      activityKey: 'google-preload',
      status: `Loading jobs… ${count}${target == null ? '' : `/${target}`}`,
    });
    if (target != null && count >= target) { exit = 'target-reached'; break; }

    // The board's OWN end-of-list marker is definitive — stop immediately rather
    // than spending the whole no-growth streak proving what the page already
    // says. Measured on Google: the node exists on a zero-result page too, but
    // with EMPTY text, so presence alone would read "reached the end" on a page
    // that never had a list. Test the text.
    if (await revealEndOfListReached(page, sourceId)) { exit = 'end-of-list'; break; }

    // A SINGLE no-growth pass is not the end of the list. Measured on Google:
    // cards arrive in batches of ten and the count stalls for one full pass at
    // every batch boundary (…40, 40, 50… / …70, 70, 80…), while a complete
    // reveal takes 18-47 passes. Breaking on the first plateau therefore stopped
    // at a batch boundary and silently under-collected — which from the outside
    // looks exactly like the list virtualizing (it does not; the DOM accumulates
    // monotonically, verified across 29 passes with zero decreases).
    if (count === prevCount) {
      stableStreak++;
      if (stableStreak >= REVEAL_STABLE_PASSES) { exit = 'plateau'; break; }
    } else {
      stableStreak = 0;
      prevCount = count;
    }
    if (isScroll) {
      if (sourceId === 'google') {
        // Google for Jobs renders cards in its own scrollable container inside the page.
        // Walk up from the first card to find that container and scroll it; also
        // scroll document.body so either trigger path gets hit.
        await updateOverlay(page, {
          ...overlayBase,
          activityKey: 'google-preload',
          status: `Loading the full Google list — not selecting cards yet… ${count}`,
        });
        // TRUSTED wheel events are REQUIRED here. Google's batch loader ignores
        // programmatic scrolling entirely: `window.scrollTo`/`scrollBy` and
        // `el.scrollTop` move the viewport to the page floor and load NOTHING —
        // measured sitting at exactly 20 cards across 14 passes, with no
        // end-of-list sentinel. That is indistinguishable from a genuine small
        // result set, so the failure is silent. Synthetic `WheelEvent` dispatch
        // and `End` keypresses are equally ignored (both are untrusted).
        // page.mouse.wheel goes through CDP Input.dispatchMouseEvent, which the
        // page receives as a real user wheel.
        await revealByTrustedWheel(page, '.EimVGf, [jscontroller="b11o3b"]');
        // Keep a programmatic nudge AFTER the wheel pass. It cannot trigger the
        // loader, but it costs nothing and still helps any lazy <img>/observer
        // work that keys off scroll position rather than input trust.
        await page.evaluate(async () => {
          const step = Math.floor(window.innerHeight * (0.55 + Math.random() * 0.3));
          let steps = 0;
          while (window.scrollY + window.innerHeight < document.body.scrollHeight - 10 && steps < 6) {
            window.scrollBy(0, step);
            await new Promise(r => setTimeout(r, 55 + Math.random() * 90));
            steps++;
          }
        }).catch(() => {});
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
  // Observation only — never a stop rule, a filter, or a retry trigger. `exit`
  // says WHY revealing stopped; `count` is what was actually on the page when it
  // did. A `plateau` well below a source's known list length is the signature of
  // a reveal that stalled, which previously looked identical to success.
  // updateActive:false — this is an OUTCOME, not the scraper's current phase.
  // Extraction runs immediately after this returns, so advancing `active` here
  // would pin "reveal-finished" onto every later render of the phase field.
  recordManualScraperTelemetry({
    phase: 'reveal-finished',
    sourceId,
    srcName: SOURCE_LABELS[sourceId] || sourceId,
    iterations,
    count,
    // 'end-of-list' means the board said so; 'plateau' means we inferred it from
    // a no-growth streak. Only the first is proof the list was fully revealed.
    exit,
  }, { updateActive: false });
  return { exit, iterations, count };
}

/**
 * Load the complete scroll-backed provider list inside an already-open Solve
 * window. The generic captcha poll sees only Google's initially mounted ten
 * cards; the ordinary source preloader must run before recovery decides which
 * persisted deferred identities still need their detail panel opened.
 */
export async function preloadResolvedJobList(page, sourceId, extractorJS, signal = null) {
  const srcName = SOURCE_LABELS[sourceId] || sourceId || 'Job source';
  const overlayBase = {
    srcLabel: 'Resolved source', srcName,
    qLabel: 'Recovery', qText: 'Loading the full result list',
  };
  await preloadContent(page, sourceId, extractorJS, overlayBase, signal, {
    maxPages: resolvePageCeiling(null),
    // Scroll until the provider count plateaus. The recovery pool intentionally
    // omits age/history rows whose physical positions may be anywhere in the
    // larger list, so its own size cannot be used as the reveal target.
    jobsPerPlatform: Infinity,
    existingJobs: 0,
  });
  if (signal?.aborted) return [];
  const rows = await page.evaluate(extractorJS);
  return Array.isArray(rows) ? rows : [];
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
    // Glassdoor encodes the applied location by TYPE: _IN nation, _IS state,
    // _IC city — all three verified live. Recognizing only _IN meant every city-
    // or state-scoped search resolved correctly, navigated correctly, and was
    // then discarded as "location not applied".
    //
    // The alphabet is now fully measured: N nation, S state/province, C city,
    // M metro. Canadian provinces use S — there is no separate non-US
    // subdivision letter. The metro tier is NOT additive (`_IM615` and
    // `_IC1132348` return the same top listings; M labels merely append the
    // country), so there is nothing to gain by targeting it — do not add a
    // metro lookup expecting extra reach.
    //
    // The class stays OPEN anyway, because the safety property is the numeric
    // id and not the type letter: we require the exact locId WE resolved to
    // appear in the landed path. A tier Glassdoor adds later would otherwise
    // read as "location not applied" and skip the whole source, the expensive
    // failure. An unknown letter beside the right id cannot admit a DIFFERENT
    // location.
    //
    // The .com -> .ca redirect is slug-safe: the path is preserved byte-for-byte
    // and only the host changes (plus a countryRedirect param), so this proof
    // survives it.
    return new RegExp(`_I[A-Z]{1,2}${id}(?:_|[.-]|$)`, 'i').test(decodeURIComponent(parsed.pathname));
  } catch {
    return false;
  }
}

/**
 * Is this a canonical Glassdoor results slug (the route that carries the
 * `_I{type}{id}` location marker at all)?
 *
 * Glassdoor only rewrites a query it can normalize into a slug. A query it
 * declines to slugify stays on `/Job/jobs.htm`, where no location marker is
 * ever present — so on that shape the marker's ABSENCE proves nothing.
 */
export function isGlassdoorCanonicalResultsUrl(url) {
  try {
    return /SRCH/i.test(decodeURIComponent(new URL(url).pathname));
  } catch {
    return false;
  }
}

/**
 * Three-way verdict on whether Glassdoor applied the location we resolved.
 *
 *   'applied'     — the canonical slug carries the matching _I{N|S|C}{id}.
 *   'missing'     — canonical slug, but a different location (or none). A real
 *                   failure: extracting would yield unscoped results.
 *   'unavailable' — non-canonical route (`/Job/jobs.htm`), where the marker
 *                   cannot appear. Says nothing either way.
 *
 * The third case used to be indistinguishable from the second, and its handler
 * skipped the WHOLE SOURCE — discarding every remaining Glassdoor query in the
 * run — because Glassdoor declined to slugify one query.
 *
 * @returns {'applied'|'missing'|'unavailable'}
 */
export function glassdoorLocationProof(url, locId) {
  if (glassdoorUrlHasLocationId(url, locId)) return 'applied';
  return isGlassdoorCanonicalResultsUrl(url) ? 'missing' : 'unavailable';
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
  const browser = await launchWithProfileLockRetry(prepareBackgroundScrapeLaunchOptions({
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
    // Do not let a Chromium launch wait forever while holding the FIFO. This is
    // Puppeteer's normal default made explicit so the bound is reviewable.
    timeout: 30_000,
  }), 'manual-browser-scrape');

  // Everything below, up to the overlay injection, runs against the browser we
  // just launched. The caller's `platform` bundle isn't assigned until this
  // function returns, so a throw here (protocol error, hung renderer right
  // after launch) would otherwise leave nothing holding a reference to close
  // it — the just-spawned Chrome leaks and keeps the shared userDataDir's
  // SingletonLock held for every source after this one.
  let page;
  const navStatusRef = { last: null };
  try {
    page = await createBackgroundScrapePage(browser, { width: 1280, height: 900 });
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
  } catch (err) {
    await closeOwnedBrowserProcess(browser, { label: 'Manual browser setup', gracefulMs: 3_500 });
    throw err;
  }

  let closed = false;
  let intentional = false;
  // A bug report's "Scrape/stealth browser" line is derived from the
  // stealthBrowser singleton — which scrapeManualSources deliberately closes
  // before spawning THIS process on the same shared profile. Recording it here
  // is what stops a report from stating "not running (profile lock free)" while
  // a visible scrape Chrome holds that very profile.
  manualScraperTelemetry.browser = {
    running: true,
    launchedAt: Date.now(),
    executablePath: executablePath || null,
    profileDir: userDataDir || null,
    pid: browser.process()?.pid ?? null,
  };
  browser.on('disconnected', () => {
    closed = true;
    if (manualScraperTelemetry.browser) {
      manualScraperTelemetry.browser = { ...manualScraperTelemetry.browser, running: false, closedAt: Date.now() };
    }
    if (!intentional) onCrash?.();
  });

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
      // `disconnected` only means the CDP socket dropped; Chrome can still own
      // SingletonLock. Always run the owned-process close/wait path even if the
      // event handler already set `closed`.
      const closeResult = await closeOwnedBrowserProcess(browser, {
        label: 'Manual browser teardown', gracefulMs: 3_500,
      });
      closed = true;
      // Set here as well as in the 'disconnected' handler. The report claims the
      // shared profile lock is HELD while this reads running, so it must not
      // depend on an event that a failed/forced close might not deliver —
      // over-reporting a live browser would send a reader after a phantom lock.
      if (manualScraperTelemetry.browser) {
        manualScraperTelemetry.browser = {
          ...manualScraperTelemetry.browser,
          running: false,
          closedAt: Date.now(),
          processExitObserved: closeResult.exited,
          forcedTermination: closeResult.disposition === 'sigterm-exit' ? 'SIGTERM'
            : closeResult.disposition === 'sigkill-fallback' ? 'SIGKILL' : null,
        };
      }
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
  manualScraperTelemetry.origins = [];
  manualScraperTelemetry.paused = false;
  manualScraperTelemetry.beat = null;
  manualScraperTelemetry.inFlight = null;
  manualScraperTelemetry.currentSourceId = null;
  // Cleared at the RUN boundary, not at teardown: a report written after a run
  // finishes should still show which Chrome that run used and that it closed,
  // but a NEW run must not display the previous run's process as its own.
  manualScraperTelemetry.browser = null;
  resetManualScraperDiagnostics();
}

// `opts`: { resetDiagnostics=true, sourceIndexBase=0, sourceTotal=null, onActivity=null }
// — for per-source dispatch the orchestrator passes resetDiagnostics:false (it
// cleared once up front) and the real index/total so the "Starting X/Y" log stays
// correct. `onActivity` receives the mid-walk liveness beat (see updateOverlay);
// it is the ONLY channel this module has to the renderer, and it is optional so
// direct callers and tests need not supply one.
export async function scrapeManualSources(tasks, onResult, signal, onPageJobs = null, opts = {}) {
  if (isBackgroundE2E()) {
    clearManualScraperTelemetry('disabled');
    throw backgroundE2EDisabledError('Manual browser scraping');
  }
  const { resetDiagnostics = true, sourceIndexBase = 0, sourceTotal = null, onActivity = null } = opts;
  setActivitySink(onActivity);
  // Direct callers start a complete browser-scrape run here. The jobs
  // orchestrator dispatches one source at a time and has already performed the
  // equivalent reset at its overall run boundary, so it passes false to retain
  // the preceding sibling sources' evidence.
  if (resetDiagnostics) resetManualScraperTelemetry();

  if (!Array.isArray(tasks) || tasks.length === 0) {
    clearManualScraperTelemetry('idle');
    // This branch returns before the normal finally block. Do not let a
    // callback supplied for an empty probe survive into a later run.
    setActivitySink(null);
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
  let detailEnrichmentFailed = false;
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
      // Distinct listing identities observed in source search rows. This count
      // intentionally precedes confirmed unavailable-detail retirement; it is
      // not synonymous with usable rows returned in `data`.
      const providerSeen = new Set();
      let sourceUnavailableDetailDropped = 0;
      // Every task for a source is built from the same persisted hub limits.
      // Keep the aggregate job limit at source scope so several role queries
      // cannot each consume a separate allowance.
      const collectionLimits = sourceTasks[0]?.options?.collectionLimits || { jobsPerPlatform: null, pagesPerPlatform: null };
      const jobsPerPlatform = resolveJobsPerPlatform(collectionLimits);
      let sourceSiteChangedWarning = null;
      let sourcePagesWalked        = 0;
      let sourceSkipped            = false; // set true when challenge times out — skips remaining queries for this source
      let hitPerSourceCap          = false;
      let hitPageCap               = false;
      let hitEmptyPage             = false;
      let hitPageTurnStalled       = false;
      // Set when a challenge bounced the walk back to page 1 twice and the walk
      // gave up rather than loop. Source-scoped because `paginationRecoveries`
      // is declared per-query and cannot be read at the resolve site.
      let hitChallengeRecoveryLoop = false;
      let hitProviderResultWindow  = false;
      let hitProviderTotalShortfall = false;
      // Queries skipped because Glassdoor's non-canonical route cannot carry the
      // location marker. Counted so a run where EVERY query was skipped cannot
      // report a clean `completed` with zero jobs and no stated reason.
      let locationProofUnavailableQueries = 0;
      // Latches once a SOFT (country-only) locId lookup fails, so the remaining
      // queries of this source do not each repeat the same failing lookup.
      let softScopeLookupFailed = false;
      // One nation-tier caveat per source, not one per query.
      let nationTierCaveatRecorded = false;
      // Board-advertised result total for this source's first query, when the
      // board publishes a trustworthy one. Reported, never acted on.
      let sourceClaimedTotal = null;
      let claimedTotalRecorded = false;
      let directContinuationFromPage = null;
      let directContinuationPages = 0;
      let directContinuationStop = null;
      // A visible pager can successfully land on a blank ZipRecruiter page
      // below the query header's verified total. Keep the one permitted direct
      // reload receipt separate from the hidden-tail continuation above: this
      // retries the page we just reached, never speculates about another one.
      let providerTotalShortfallRecovery = null;
      let hitUnhandledPagination   = false;
      let sourceDetailBlockCode    = null;
      let sourceDetailBlockAt      = 0;    // ms epoch the block was (re)armed — drives the cooldown re-probe
      let sourceDetailBlockPage    = null; // first page whose descriptions were skipped, for the report
      let sourceDetailBlockCount   = 0;    // times the block armed (1 = never recovered)
      let sourceDetailReprobes     = 0;    // cooldown re-probes attempted
      let sourceDetailRecovered    = 0;    // re-probes that restored enrichment
      let sourceDetailSkippedCards = 0;    // cards that never had a panel request issued
      // `skippedCards` only counts pages ENTERED under an already-armed block, so
      // the page that TRIGGERS one — the page that stops mid-walk and defers every
      // remaining card — contributes zero. A 30-page run that lost 21 rows on page
      // 29 and recovered on page 30 therefore reported `skippedCards: 0` and read
      // "enrichment resumed", i.e. no loss at all. These three survive recovery so
      // the report can state what the episode actually cost.
      let sourceDetailUnenriched   = 0;    // rows that ended the walk with no description
      let sourceDetailReprobeTotal = 0;    // re-probes attempted (NOT reset on recovery)
      let sourceDetailFirstBlockPg = null; // first page ever blocked (NOT cleared on recovery)
      let sourceDetailFirstBlockQuery = null; // query that first armed detail recovery
      let sourceDetailFirstBlockQueryIndex = null;
      // The funnel's "Found (raw)" is computed from what this scraper RETURNS, so
      // it is already net of this per-source sourceJobKey dedup. A 30-page walk
      // over ~900 physical cards that returned 782 rows reported "after dedup:
      // 782 (0 dropped)" — true of the later cross-source title+company stage,
      // but it hid an entire earlier layer. Count it so the drop is attributable
      // instead of only inferable by subtracting overlay card indices by hand.
      let sourcePhysicalCards      = 0;    // distinct physical cards the walk actually scanned
      let redirectHostRecorded     = false; // geo-redirect noted once per source, not per page
      let dataStopReason           = null; // set by task.options.onPageScraped (age-window / no-new-jobs) — see jobPageStop.js
      // Exact requests that reached the navigation step. The task list is only
      // a plan: a source can hit its useful-result cap at q1/12.
      const executedQueries        = [];
      // Scroll-backed sources (currently Google) have a source-owned terminal
      // signal that is more precise than the generic `completed` stop reason.
      // Keep one bounded outcome per executed query so the durable receipt can
      // later distinguish a real end marker from a no-growth plateau.
      const revealOutcomes         = [];

      const displayIndex = sourceIndexBase + si + 1;
      const displayTotal = sourceTotal || sourceList.length;
      // Fresh, fully-isolated Chrome for THIS platform (torn down before the
      // next). A shared-profile collision is a source-level, retryable block,
      // not a reason to discard already-collected sibling sources or abort the
      // entire Job Search pipeline with Puppeteer's raw Code: 0 text.
      try {
        platform = await launchScrapePlatformBrowser({
          userDataDir, executablePath, sandboxArgs,
          onCrash: () => { earlyExit = true; },
        });
      } catch (error) {
        const evidence = String(error?.message || error);
        const profileLocked = isProfileLockCollision(error)
          || /shared browser profile lock|Opening in existing browser session|browser is already running for/i.test(evidence);
        logger.warn(`[BrowserScraper] ${srcName} Chrome launch failed; marking this source retryable and continuing: ${evidence}`);
        const result = {
          id: `${sourceId}-0`, sourceId, success: false,
          data: [], pagesWalked: 0, stopReason: 'browser-launch-failed',
          warning: {
            code: profileLocked ? 'browser-profile-locked' : 'browser-launch-failed', severity: 'block',
            evidence: evidence.slice(0, 500),
            actionTitle: profileLocked
              ? `Retry ${srcName} after the shared Chrome profile is free`
              : `${srcName} browser could not start`,
            suggestion: profileLocked
              ? 'Close any open login or verification window, then click Solve to retry this source.'
              : 'Check that Chrome can open normally and any macOS permission prompt is resolved, then click Solve to retry this source.',
          },
        };
        results.push(result);
        onResult?.(result);
        recordManualScraperTelemetry({
          phase: 'source-launch-failed', sourceId, srcName,
          sourceIndex: displayIndex, sourceTotal: displayTotal,
          stopReason: result.stopReason, error: evidence.slice(0, 300),
        });
        continue;
      }
      const { page, navStatusRef } = platform;

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

        // Auto allocates one finite browser-page pool across all generated
        // queries. A zero allocation is an intentional no-op, not permission
        // to navigate its first page (or spend the normal inter-query pace)
        // before the pagination loop notices `pageNum > maxPages`.
        const taskPageBudget = task.options?.maxPages ?? resolvePageCeiling(null);
        if (taskPageBudget <= 0) {
          hitPageCap = true;
          logger.info(`[BrowserScraper] ${srcName} q${qi + 1}/${sourceTasks.length} has no remaining allocated browser pages — skipping without navigation`);
          recordManualScraperTelemetry({
            phase: 'query-skipped-page-budget',
            sourceId,
            srcName,
            queryIndex: qi + 1,
            queryTotal: sourceTasks.length,
            pageBudget: taskPageBudget,
          }, { updateActive: false });
          continue;
        }

        const overlayBase = {
          srcLabel: `Source ${displayIndex} of ${displayTotal}`,
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
        // `_locResolved` is per TASK and there is one task per query, so a
        // FAILING lookup used to be retried for every query — each attempt
        // carrying the full multi-second autocomplete budget. Once a soft scope
        // has failed for this source, skip straight to the unscoped walk.
        if (sourceId === 'glassdoor' && task.resolveGlassdoorLocation && !task._locResolved
            && !(task.glassdoorLocationSoftScope && softScopeLookupFailed)) {
          task._locResolved = true;
          // Snapshot so a soft-scope failure can restore, not clobber, a warning
          // an earlier query of this same source already raised.
          const warningBeforeLocationLookup = sourceSiteChangedWarning;
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
            task._glassdoorLocT = String(picked.locT || 'C').toUpperCase();
            logger.info(`[BrowserScraper] Glassdoor "${task.resolveGlassdoorLocation}" → locId ${picked.locId}/${picked.locT}`);
            // The NATION tier is accepted by Glassdoor and echoed in the header,
            // but it does not filter: `_IN1` ("United States") returned Ontario
            // listings titled "United States jobs", `_IN1` and `_IN3` returned
            // identical counts, and one province out-counted all of Canada.
            // State/city/metro tiers ARE honoured cross-border. Say so once per
            // source — silence here would let a country-labelled page pass for a
            // country-filtered one, which is exactly what the header check does.
            if (task._glassdoorLocT === 'N' && !nationTierCaveatRecorded) {
              nationTierCaveatRecorded = true;
              const evidence = `${srcName} accepted the country scope "${task.resolveGlassdoorLocation}" (locId ${picked.locId}, nation tier) — but Glassdoor does not enforce nation-tier scopes: the results reflect this machine's browsing region, while the page header still names the requested country. Treat these rows as region-unverified; the location adherence summary is the authority, not the header.`;
              logger.warn(`[BrowserScraper] ${evidence}`);
              recordManualScraperTelemetry({
                phase: 'location-nation-tier-unenforced',
                sourceId, srcName,
                queryIndex: qi + 1, queryTotal: sourceTasks.length,
                location: task.resolveGlassdoorLocation,
                locId: String(picked.locId), locT: task._glassdoorLocT,
              }, { updateActive: false });
              // Deliberately NOT a source warning. `sourceSiteChangedWarning`
              // is a single per-source slot that every later site fills only
              // `if (!sourceSiteChangedWarning)` — so claiming it here, before
              // the first navigation, would permanently mask a real Cloudflare
              // block found later. Worse, jobs.js maps ANY info-severity warning
              // to terminal status 'skipped' BEFORE it checks for a block, so a
              // fully successful Glassdoor run carrying this caveat would report
              // as skipped with its jobs hidden. The telemetry event above is
              // the carrier; the bug report renders it from there.
            }
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
            // A SOFT scope (a bare country attached to a remote-only search, so
            // the market is pinned without narrowing) must not be enforced as a
            // boundary. Nationwide is already the correct answer for that search,
            // so proceed unscoped — exactly what this source did before a country
            // scope was attached at all. `_glassdoorLocId` stays unset, which
            // leaves the applied-location proof correctly inert.
            if (task.glassdoorLocationSoftScope) {
              softScopeLookupFailed = true;
              logger.warn(`[BrowserScraper] Glassdoor country scope "${task.resolveGlassdoorLocation}" could not be verified (${failure}); continuing unscoped for the rest of this source — a remote search is nationwide anyway.`);
              // Restore whatever warning state existed BEFORE this branch rather
              // than clearing it: `sourceSiteChangedWarning` is per-SOURCE, so an
              // earlier query's real warning (a challenge, a stale-selector throw)
              // must survive. Assigning null here erased it.
              sourceSiteChangedWarning = warningBeforeLocationLookup;
              await updateOverlay(page, {
                ...overlayBase,
                count: allJobs.length,
                status: 'Country scope unverified — continuing with a nationwide search.',
              }).catch(() => {});
            } else {
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
              action:     'none',
              shortLabel: 'Wait, then rerun',
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
        if (sourceId === 'glassdoor' && task._glassdoorLocId) {
          const proof = glassdoorLocationProof(page.url(), task._glassdoorLocId);
          if (proof === 'missing') {
            sourceSiteChangedWarning = {
              code: 'location-not-applied',
              severity: 'info',
              evidence: `Glassdoor resolved location ID ${task._glassdoorLocId}, but its canonical results URL did not carry the matching location marker (expected _IN/_IS/_IC${task._glassdoorLocId}; landed on ${page.url()}). The source was skipped without extracting unscoped results.`,
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
          if (proof === 'unavailable') {
            // Glassdoor declined to slugify THIS query, so it stayed on
            // /Job/jobs.htm where the location marker cannot appear. The marker
            // being absent is not evidence the location was ignored, and it is
            // certainly not evidence about the run's other queries — which is
            // what the old shared `break` threw away. Skip only this query.
            // updateActive:false — the run CONTINUES to the next query after
            // this, so advancing the active phase would pin one query's
            // outcome onto everything the scraper does afterwards.
            recordManualScraperTelemetry({
              phase: 'location-proof-unavailable',
              sourceId,
              srcName,
              queryIndex: qi + 1,
              queryTotal: sourceTasks.length,
              url: page.url(),
              expectedLocId: task._glassdoorLocId,
            }, { updateActive: false });
            logger.warn(`[BrowserScraper] ${srcName} q${qi + 1}: results stayed on the non-canonical /Job/jobs.htm route, where the _I*${task._glassdoorLocId} location marker cannot appear — skipping this query only, without asserting the location was ignored.`);
            locationProofUnavailableQueries++;
            continue;
          }
        }

        // Record — never correct — a geo-redirect away from the host the task
        // was built for (a Toronto IP lands a www.glassdoor.com request on
        // www.glassdoor.ca). This is OBSERVATIONAL: the session that cleared
        // Cloudflare lives on the landed host, and re-navigating to force the
        // intended one re-triggers the redirect and risks escalation. Without
        // this line the report showed a .ca URL for a United States search with
        // nothing recording that .com had been requested and reassigned.
        if (!redirectHostRecorded) {
          const intendedHost = safeUrlHost(task.url);
          const landedHost = safeUrlHost(page.url());
          if (intendedHost && landedHost && intendedHost !== landedHost) {
            redirectHostRecorded = true;
            recordManualScraperTelemetry({
              phase: 'location-host-redirected',
              sourceId,
              srcName,
              queryIndex: qi + 1,
              queryTotal: sourceTasks.length,
              intendedHost,
              landedHost,
              url: page.url(),
            });
            logger.info(`[BrowserScraper] ${srcName}: requested ${intendedHost} but the session landed on ${landedHost} (geo-redirect) — continuing on the landed host, which holds the cleared session`);
          }
        }

        await injectOverlay(page); // re-inject after challenge resolution may have navigated
        await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Extracting jobs…' });

        // For scroll sources, pre-load content up to the per-query target
        // before running the extractor. Paginated sources skip this.
        if (SCROLL_SOURCES.has(sourceId)) {
          const revealOutcome = await preloadContent(page, sourceId, task.extractorJS, overlayBase, signal, {
            // `??` not `||` — task.options.maxPages is already the resolved,
            // always-finite ceiling (resolvePageCeiling), but fall back to the
            // same backstop if a task was ever built without it so this never
            // silently reinstates the retired 10-page default.
            maxPages: task.options?.maxPages ?? resolvePageCeiling(null),
            jobsPerPlatform,
            existingJobs: allJobs.length,
          });
          if (revealOutcome) {
            revealOutcomes.push({
              queryIndex: qi + 1,
              queryTotal: sourceTasks.length,
              ...revealOutcome,
            });
          }
          if (signal?.aborted) { earlyExit = true; break; }
          await injectOverlay(page);
          await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Extracting jobs…' });
        }

        // ── Per-query extraction + pagination loop ──────────────────────────
        // startPageNum > 1 on a resume: task.url was built at that page, so the
        // counter (+ the staging ledger) continue from there for URL-paginated sources.
        let pageNum              = task.options?.startPageNum || 1;
        // Sources that append in place instead of paging (see clickLoadMore).
        // Their extractor re-reads the SAME growing list every iteration, so the
        // rows are cumulative running totals rather than a fresh page.
        const loadMoreSelector   = task.options?.loadMoreSelector || null;
        // Set in jobs.js for sources whose page number is part of the URL.
        const urlPaginated       = !!task.options?.urlPaginated;
        let loadMorePrevCount    = 0; // rows already evaluated on a load-more list
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
          const maxPages = task.options?.maxPages ?? resolvePageCeiling(null);
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

          // `page-extract` above announces that extraction is ABOUT to start and
          // carries the pre-extraction cumulative count, so on its own it cannot
          // distinguish "extractor still running" from "extractor returned 0".
          // Naming the await makes a stalled evaluate visible while it stalls,
          // and the outcome row below closes the pair.
          const { jobs: extracted, siteChangedError, evalError } = await withInFlight(
            'extractor evaluate',
            `${srcName} q${qi + 1} p${pageNum}`,
            () => runExtractor(page, task.extractorJS),
          );
          recordManualScraperTelemetry({
            phase: 'page-extracted',
            sourceId,
            srcName,
            queryIndex: qi + 1,
            queryTotal: sourceTasks.length,
            pageNum,
            extracted: extracted.length,
            outcome: evalError ? 'eval-error' : siteChangedError ? 'site-changed' : 'ok',
          }, { updateActive: false });

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

          // Read the board's advertised total BEFORE the empty-page break below.
          // A zero-row page 1 is exactly when a completeness oracle matters most
          // — "the board says 520, we collected 0" is the finding — and reading
          // it after that break left the oracle silent in precisely that case.
          //
          // Single-query sources ONLY: the advertised total belongs to ONE
          // query, while the report's per-source count is summed across every
          // query and then cross-source deduped, so comparing them on a
          // multi-query run yields nonsense like "900 of ~520". A pinned target
          // role issues exactly one query, which is where this applies.
          if (pageNum === 1 && !claimedTotalRecorded && sourceTasks.length === 1) {
            claimedTotalRecorded = true;
            const claimed = await readClaimedResultTotal(page, sourceId);
            if (claimed != null) {
              sourceClaimedTotal = claimed;
              recordManualScraperTelemetry({
                phase: 'claimed-total', sourceId, srcName,
                queryIndex: qi + 1, queryTotal: sourceTasks.length,
                claimedTotal: claimed,
              }, { updateActive: false });
              logger.info(`[BrowserScraper] ${srcName} advertises ~${claimed} result(s) for this query`);
            }
          }

          // No jobs on this page despite a clean extraction usually ends this
          // query. ZipRecruiter's query-string header is a verified exception:
          // when it still advertises identities we have not traversed, this
          // empty page is a pager shortfall, not evidence that the source is
          // exhausted. Preserve all partial rows, but carry an explicit
          // truncated terminal fact rather than green-lighting the source.
          if (extracted.length === 0) {
            if (sourceId === 'ziprecruiter'
              && Number.isFinite(Number(sourceClaimedTotal))
              && providerSeen.size < Number(sourceClaimedTotal)) {
              const shortfall = Number(sourceClaimedTotal) - providerSeen.size;
              const currentPage = zipRecruiterSearchPageNumber(safePageUrl(page));
              const retryOutcome = zipRecruiterProviderShortfallRecoveryOutcome({
                sourceId,
                claimedTotal: sourceClaimedTotal,
                providerGathered: providerSeen.size,
                pageNum,
                maxPages,
                hasNextUrl: typeof task.options?.nextUrl === 'function',
                pageIdentityValid: currentPage === pageNum,
                retryAttempted: providerTotalShortfallRecovery?.attempts > 0,
                extractedRows: extracted.length,
              });
              if (retryOutcome === 'retry') {
                let directUrl = null;
                try { directUrl = task.options.nextUrl(pageNum - 1); }
                catch { /* invalid task wiring falls through to the shortfall receipt */ }
                const directPage = zipRecruiterSearchPageNumber(directUrl);
                if (directPage === pageNum) {
                  providerTotalShortfallRecovery = {
                    pageNum,
                    attempts: 1,
                    status: 'reload-issued',
                    rawRows: 0,
                    newProviderRows: 0,
                    shortfall,
                  };
                  logger.info(`[BrowserScraper] ${srcName} page ${pageNum} loaded empty after ${providerSeen.size}/${sourceClaimedTotal} advertised candidate identities — reloading that verified direct page once before recording incomplete coverage`);
                  recordManualScraperTelemetry({
                    phase: 'provider-total-shortfall-retry', sourceId, srcName,
                    queryIndex: qi + 1, queryTotal: sourceTasks.length,
                    pageNum, count: allJobs.length, claimedTotal: sourceClaimedTotal,
                    providerGathered: providerSeen.size, shortfall, url: directUrl,
                  }, { updateActive: false });
                  await updateOverlay(page, {
                    ...overlayBase,
                    count: allJobs.length,
                    status: `Retrying verified page ${pageNum}…`,
                  }).catch(() => {});
                  // ZipRecruiter has no reliable ready selector. A fixed settle
                  // delay plus waitForReady can therefore still inspect the old
                  // blank document (CONTENT_SELECTORS.ziprecruiter is null).
                  // Leave an in-memory marker on that document and require it
                  // to disappear after the reload; the marker is never retained
                  // in telemetry or a result/receipt.
                  const reloadMarker = `ic-zip-shortfall-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                  const issued = await page.evaluate(({ url, marker }) => {
                    window.__infiniteCanvasZipShortfallReloadMarker = marker;
                    window.location.href = url;
                  }, { url: directUrl, marker: reloadMarker })
                    .then(() => true)
                    .catch(() => false);
                  if (issued) {
                    await sleepUnlessAborted(humanDelay(NAV_SETTLE_MS), signal);
                    if (signal?.aborted) { earlyExit = true; break; }
                    await injectOverlay(page);
                    const retryReady = await waitForReady(page, sourceId, overlayBase, signal, task.url);
                    if (retryReady === 'abort' || signal?.aborted) { earlyExit = true; break; }
                    const landedPage = zipRecruiterSearchPageNumber(safePageUrl(page));
                    const reloadReplacedDocument = await page.evaluate(marker => (
                      window.__infiniteCanvasZipShortfallReloadMarker !== marker
                    ), reloadMarker).catch(() => false);
                    if ((retryReady === 'ok' || retryReady === 'recovered')
                      && landedPage === pageNum && reloadReplacedDocument) {
                      providerTotalShortfallRecovery.status = 'reload-landed';
                      recordManualScraperTelemetry({
                        phase: 'provider-total-shortfall-retry-landed', sourceId, srcName,
                        queryIndex: qi + 1, queryTotal: sourceTasks.length,
                        pageNum, count: allJobs.length, url: safePageUrl(page),
                      }, { updateActive: false });
                      continue;
                    }
                    if (retryReady === 'hard-block' || retryReady === 'skip') {
                      // Match the ordinary page-turn gate: a retry that reaches
                      // a challenge terminal must not be relabelled as an
                      // ordinary provider-total shortfall with no Solve/retry
                      // guidance. The compact retry receipt still records that
                      // this happened while checking the blank page.
                      if (!sourceSiteChangedWarning || sourceSiteChangedWarning.severity !== 'block') {
                        sourceSiteChangedWarning = retryReady === 'hard-block'
                          ? {
                            code: 'cloudflare-hard-block', severity: 'block',
                            action: 'none', shortLabel: 'Wait, then rerun',
                            evidence: `${srcName} was hard-blocked by Cloudflare while reloading page ${pageNum} after a blank result page.`,
                            suggestion: `Open ${srcName} in a normal Chrome tab and ensure you are fully logged in, then retry.`,
                          }
                          : {
                            code: 'session-blocked', severity: 'block',
                            evidence: `${srcName} re-served a bot challenge while reloading page ${pageNum} after verification, so the session is blocked.`,
                            suggestion: `Open ${srcName} in a normal Chrome tab, ensure you are logged in and unblocked, then run the search again.`,
                          };
                      }
                      sourceSkipped = true;
                    }
                    providerTotalShortfallRecovery.status = retryReady === 'hard-block' || retryReady === 'skip'
                      ? 'reload-blocked'
                      : !reloadReplacedDocument ? 'reload-not-confirmed'
                      : landedPage == null ? 'reload-redirected-off-results' : `reload-landed-page-${landedPage}`;
                    recordManualScraperTelemetry({
                      phase: 'provider-total-shortfall-retry-rejected', sourceId, srcName,
                      queryIndex: qi + 1, queryTotal: sourceTasks.length,
                      pageNum, landedPage, count: allJobs.length,
                      reason: providerTotalShortfallRecovery.status, url: safePageUrl(page),
                    }, { updateActive: false });
                  } else {
                    providerTotalShortfallRecovery.status = 'reload-navigation-failed';
                    recordManualScraperTelemetry({
                      phase: 'provider-total-shortfall-retry-rejected', sourceId, srcName,
                      queryIndex: qi + 1, queryTotal: sourceTasks.length,
                      pageNum, count: allJobs.length, reason: providerTotalShortfallRecovery.status,
                    }, { updateActive: false });
                  }
                }
              }
              hitProviderTotalShortfall = true;
              if (providerTotalShortfallRecovery?.status === 'reload-landed') {
                providerTotalShortfallRecovery.status = 'blank-after-reload';
              } else if (['rows-recovered', 'rows-reloaded-no-new-identities'].includes(providerTotalShortfallRecovery?.status)
                && providerTotalShortfallRecovery.pageNum !== pageNum) {
                // One successful reload must not make a later, un-retried blank
                // page look as though the prior recovery failed. Preserve its
                // row counts but name the terminal page honestly.
                providerTotalShortfallRecovery.status = 'later-blank-after-one-retry';
                providerTotalShortfallRecovery.terminalPageNum = pageNum;
              }
              logger.warn(`[BrowserScraper] ${srcName} page ${pageNum} extracted no jobs after ${providerSeen.size}/${sourceClaimedTotal} advertised candidate identities — preserving ${shortfall} candidate identity shortfall as incomplete coverage`);
              recordManualScraperTelemetry({
                phase: 'provider-total-shortfall', sourceId, srcName,
                queryIndex: qi + 1, queryTotal: sourceTasks.length,
                pageNum, count: allJobs.length,
                claimedTotal: sourceClaimedTotal,
                providerGathered: providerSeen.size,
                shortfall,
                recovery: providerTotalShortfallRecovery?.status || 'not-attempted',
              }, { updateActive: false });
            }
            hitEmptyPage = true;
            break;
          }
          pagesExtracted++;   // this page's selectors worked — see the SITE_CHANGED branch above

          // Trust the platform's ranked/fuzzy search results. Every distinct row
          // returned for the issued query is eligible for detail expansion; the
          // app must not impose a second exact-ish title admission policy.
          // Physical cards this iteration actually put in front of us. On a
          // load-more source `extracted` is the WHOLE accumulated list and is
          // re-scanned from row 0 every iteration, so counting a duplicate per
          // re-encounter measures re-scanning, not shed cards — over 30 pages it
          // would have reported ~13,000 instead of the real 118. `loadMorePrevCount`
          // still holds the previous iteration's total here (it is advanced later,
          // at the pageRows slice), so this delta is exactly the new cards.
          sourcePhysicalCards += loadMoreSelector
            ? Math.max(0, extracted.length - loadMorePrevCount)
            : extracted.length;
          const newJobs = [];
          let newProviderRows = 0;
          for (const job of extracted) {
            // One listing can surface in two role queries. Google embeds that
            // query in `q`/the fragment, so raw URL equality misses an exact
            // duplicate; sourceJobKey preserves its stable htidocid instead.
            const key = sourceJobKey(job);
            if (providerSeen.has(key)) continue;
            providerSeen.add(key);
            newProviderRows++;
            if (!seen.has(key)) { seen.add(key); newJobs.push(job); }
          }
          if (providerTotalShortfallRecovery?.status === 'reload-landed'
            && providerTotalShortfallRecovery.pageNum === pageNum) {
            const recoveryOutcome = zipRecruiterProviderShortfallRecoveryOutcome({
              sourceId,
              claimedTotal: sourceClaimedTotal,
              providerGathered: providerSeen.size - newProviderRows,
              pageNum,
              maxPages,
              hasNextUrl: typeof task.options?.nextUrl === 'function',
              pageIdentityValid: zipRecruiterSearchPageNumber(safePageUrl(page)) === pageNum,
              retryAttempted: true,
              documentReloaded: true,
              extractedRows: extracted.length,
            });
            if (recoveryOutcome === 'recovered') {
              providerTotalShortfallRecovery.status = newProviderRows > 0
                ? 'rows-recovered'
                : 'rows-reloaded-no-new-identities';
              providerTotalShortfallRecovery.rawRows = extracted.length;
              providerTotalShortfallRecovery.newProviderRows = newProviderRows;
              recordManualScraperTelemetry({
                phase: 'provider-total-shortfall-retry-recovered', sourceId, srcName,
                queryIndex: qi + 1, queryTotal: sourceTasks.length,
                pageNum, count: allJobs.length,
                rawRows: extracted.length, newProviderRows,
                providerGathered: providerSeen.size, claimedTotal: sourceClaimedTotal,
              }, { updateActive: false });
              logger.info(`[BrowserScraper] ${srcName} verified page ${pageNum} reload yielded ${extracted.length} row(s) (${newProviderRows} new provider identity/identities) — continuing pagination without inferring exhaustive coverage from the advertised total`);
            }
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
          // A source-wide block is no longer permanent. Once the cooldown has
          // elapsed, take ONE ordinary expansion attempt: expandDescriptions
          // stops at its own first blocked panel, so a still-throttled source
          // costs exactly one card, while a recovered one enriches the whole
          // page. Without this, a single 429 stranded every later page's rows
          // as `descriptionDeferredReason` and the run reported `completed`.
          // Walking while blocked is CHEAP — no panel requests are issued — so a
          // 19-page remainder can finish in ~40s and never reach the cooldown,
          // leaving the re-probe below dead code. Spend that time waiting
          // instead: every page walked while blocked yields rows the scoring
          // evidence gate will discard anyway, so pausing to let the throttle
          // clear strictly beats racing to the end with nothing to score.
          // Bounded by DETAIL_BLOCK_MAX_REPROBES, and each failed re-probe
          // re-arms the clock, so this can never busy-wait per page.
          if (sourceDetailBlockCode && sourceDetailBlockAt > 0
            && sourceDetailReprobes < DETAIL_BLOCK_MAX_REPROBES
            && jobsToExpand.length > 0 && !signal?.aborted) {
            const cooldownRemainingMs = DETAIL_BLOCK_COOLDOWN_MS - (Date.now() - sourceDetailBlockAt);
            if (cooldownRemainingMs > 0) {
              logger.info(`[BrowserScraper] ${srcName}: descriptions blocked by ${sourceDetailBlockCode}; waiting ${Math.ceil(cooldownRemainingMs / 1000)}s on page ${pageNum} before re-probing rather than walking on with unusable rows`);
              await updateOverlay(page, {
                ...overlayBase,
                pageNum,
                count: allJobs.length,
                status: `Waiting ${Math.ceil(cooldownRemainingMs / 1000)}s for the description throttle to clear…`,
              }).catch(() => {});
              await sleepUnlessAborted(cooldownRemainingMs, signal);
            }
          }
          const detailBlockReprobeDue = Boolean(sourceDetailBlockCode)
            && sourceDetailBlockAt > 0
            && (Date.now() - sourceDetailBlockAt) >= DETAIL_BLOCK_COOLDOWN_MS
            && sourceDetailReprobes < DETAIL_BLOCK_MAX_REPROBES
            && jobsToExpand.length > 0
            && !signal?.aborted;
          const detailSkippedForBlock = Boolean(sourceDetailBlockCode) && !detailBlockReprobeDue;
          // Set when a re-probe did not restore enrichment. The descWarning
          // latch below re-arms the block for the codes it knows; this covers
          // the rest (notably a demoted descError) so a failed re-probe can
          // never leave the source unblocked and hammering every later page.
          let reprobeFailedThisPage = false;
          let detailResult;
          if (detailSkippedForBlock) {
            sourceDetailSkippedCards += jobsToExpand.length;
            recordManualScraperTelemetry({
              phase: 'detail-skipped-source-response', sourceId, srcName,
              queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
              count: allJobs.length, skipped: jobsToExpand.length,
              reason: sourceDetailBlockCode,
              blockedSincePage: sourceDetailBlockPage,
              blockedForMs: sourceDetailBlockAt > 0 ? Date.now() - sourceDetailBlockAt : null,
            });
            detailResult = {
              jobs: jobsToExpand.map(job => ({
                ...job,
                descriptionDeferredReason: sourceDetailBlockCode,
              })),
              descError: null,
              descWarning: null,
              expandedCount: 0,
            };
          } else {
            const reprobeOfCode = detailBlockReprobeDue ? sourceDetailBlockCode : null;
            const reprobeWaitedMs = detailBlockReprobeDue ? Date.now() - sourceDetailBlockAt : 0;
            if (detailBlockReprobeDue) {
              sourceDetailReprobes += 1;
              sourceDetailReprobeTotal += 1;
              logger.info(`[BrowserScraper] ${srcName}: re-probing detail enrichment on page ${pageNum} after ${Math.round(reprobeWaitedMs / 1000)}s blocked by ${reprobeOfCode} (attempt ${sourceDetailReprobes}/${DETAIL_BLOCK_MAX_REPROBES})`);
              recordManualScraperTelemetry({
                phase: 'detail-block-reprobe', sourceId, srcName,
                queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
                reason: reprobeOfCode, waitedMs: reprobeWaitedMs,
                attempt: sourceDetailReprobes, maxAttempts: DETAIL_BLOCK_MAX_REPROBES,
              });
              // Clear before the attempt so a successful pass falls straight
              // through; the descWarning latch below re-arms it on failure.
              sourceDetailBlockCode = null;
            }
            if (detailBlockReprobeDue) {
              // Probe with a COUPLE of cards, never the whole page. A throttle
              // does not always surface as a matched 429 — a suppressed XHR
              // just times out — and DESC_STALE_THRESHOLD (3) consecutive
              // timeouts trip abortWithError, so a full-page probe would both
              // issue more requests against a throttled endpoint (the exact
              // hammering the immediate-stop policy exists to prevent) and
              // manufacture a bogus 'stale selectors' error out of an external
              // rate limit. Staying under the threshold makes that impossible.
              const probeJobs = jobsToExpand.slice(0, DETAIL_BLOCK_PROBE_CARDS);
              const restJobs = jobsToExpand.slice(probeJobs.length);
              const probeResult = await expandDescriptions(
                page, probeJobs, sourceId, { ...overlayBase, pageNum }, allJobs.length + probeJobs.length, signal,
                buildPhysicalCardWalkPlan(extracted, probeJobs),
              );
              if (didDetailBlockReprobeRecover(probeResult)) {
                // The throttle lifted — finish the page normally. A confirmed
                // unavailable listing is terminal evidence too: it proves the
                // request reached the detail endpoint without mistaking an
                // ordinary zero-description miss for recovery.
                const restResult = restJobs.length > 0
                  ? await expandDescriptions(
                    page, restJobs, sourceId, { ...overlayBase, pageNum }, allJobs.length + jobsToExpand.length, signal,
                    buildPhysicalCardWalkPlan(extracted, restJobs),
                  )
                  : {
                    jobs: [],
                    descError: null,
                    descWarning: null,
                    expandedCount: 0,
                    unavailableDetailDropped: 0,
                  };
                detailResult = composeDetailBlockReprobeResult(probeResult, restResult);
              } else {
                // Still blocked. Leave the untouched remainder deferred rather
                // than walking it — that is what the block means.
                detailResult = composeDetailBlockReprobeResult(probeResult, null, restJobs, reprobeOfCode);
                sourceDetailSkippedCards += restJobs.length;
              }
            } else {
              detailResult = await expandDescriptions(
                page, jobsToExpand, sourceId, { ...overlayBase, pageNum }, allJobs.length + jobsToExpand.length, signal, walkPlan,
              );
            }
            if (detailBlockReprobeDue) {
              // "Recovered" must mean the throttle actually lifted: rows came
              // back AND nothing re-blocked on the same page. Counting a
              // partially-expanded page that immediately re-blocked would make
              // the report claim a recovery that did not happen.
              if (didDetailBlockReprobeRecover(detailResult)) {
                sourceDetailRecovered += 1;
                // Give a LATER block its own full budget. Leaving the counter
                // at its high-water mark meant one successful recovery early in
                // a walk made a second, unrelated block permanent.
                sourceDetailReprobes = 0;
                // Stop asserting a block that has provably lapsed — the skip log
                // and the report both quote this page number.
                sourceDetailBlockPage = null;
                const retiredUnavailable = Math.max(0, Number(detailResult.unavailableDetailDropped) || 0);
                logger.info(`[BrowserScraper] ${srcName}: detail enrichment recovered on page ${pageNum} — ${detailResult.expandedCount}/${jobsToExpand.length} expanded${retiredUnavailable > 0 ? `; ${retiredUnavailable} confirmed unavailable` : ''} after ${Math.round(reprobeWaitedMs / 1000)}s blocked by ${reprobeOfCode}`);
                recordManualScraperTelemetry({
                  phase: 'detail-block-cleared', sourceId, srcName,
                  queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
                  reason: reprobeOfCode, waitedMs: reprobeWaitedMs,
                  expanded: detailResult.expandedCount,
                  unavailableDetailDropped: retiredUnavailable,
                  attempted: jobsToExpand.length,
                });
              } else {
                reprobeFailedThisPage = true;
                // An opportunistic re-probe must never leave the run WORSE than
                // the skip it replaced. A descError sets earlyExit below and
                // ends the whole source walk — escalating a recoverable
                // throttle into a truncated source. Demote it to a warning so
                // the evidence still reaches the report while the walk
                // continues (and keeps skipping) exactly as it would have.
                if (detailResult.descError) {
                  logger.warn(`[BrowserScraper] ${srcName}: re-probe on page ${pageNum} failed with ${detailResult.descError.code || 'an error'} — keeping the source block instead of ending the walk`);
                  detailResult = {
                    ...detailResult,
                    descWarning: detailResult.descWarning || detailResult.descError,
                    descError: null,
                  };
                }
                // The source-level warning slot is already occupied by the
                // original block warning, so a failed re-probe's evidence would
                // otherwise be lost entirely. Record it as its own anomaly row.
                recordManualScraperTelemetry({
                  phase: 'detail-block-reprobe-failed', sourceId, srcName,
                  queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
                  reason: detailResult.descWarning?.code || reprobeOfCode,
                  waitedMs: reprobeWaitedMs,
                  attempt: sourceDetailReprobes, maxAttempts: DETAIL_BLOCK_MAX_REPROBES,
                  expanded: detailResult.expandedCount, attempted: DETAIL_BLOCK_PROBE_CARDS,
                });
              }
            }
          }
          const {
            jobs: enhanced,
            descError,
            descWarning,
            expandedCount,
            unavailableDetailDropped = 0,
          } = detailResult;
          sourceUnavailableDetailDropped += Math.max(0, Number(unavailableDetailDropped) || 0);
          // Exactly the rows the scoring-evidence gate will drop — no inference
          // about which branch deferred them, and it stays correct on the
          // triggering page where only a suffix of the cards was deferred.
          sourceDetailUnenriched += enhanced.filter(j => j?.descriptionDeferredReason).length;

          const descCfg = DESC_CONFIGS[sourceId];
          if (descCfg?.panelSelector || descCfg?.expandViaNavigation) {
            if (detailSkippedForBlock) {
              // State what happened, not what a zero could imply. The old line
              // printed "0/N expanded (sel: …)" on this branch too, which is
              // the exact signature of extractor drift — 19 consecutive pages
              // of it pointed the next investigation at the CSS selector when
              // no panel request had been issued at all.
              logger.info(`[BrowserScraper] ${srcName} q${qi + 1} descriptions: enrichment skipped for ${jobsToExpand.length} card(s) — source blocked by ${sourceDetailBlockCode} since page ${sourceDetailBlockPage ?? '?'}; no panel request issued`);
            } else {
              const strategy = [
                descCfg?.jsonLdType    && `jsonLd(${descCfg.jsonLdType})`,
                descCfg?.nextDataField && `nd(${descCfg.nextDataField.split('.').slice(-1)[0]})`,
                'sel',
              ].filter(Boolean).join('+');
              logger.info(`[BrowserScraper] ${srcName} q${qi + 1} descriptions: ${expandedCount}/${jobsToExpand.length} expanded (${strategy}: ${descCfg?.panelSelector?.slice(0, 40) ?? 'none'})`);
            }
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
            detailEnrichmentFailed = true;
            earlyExit = true;
            break;
          }
          // A partial detail page is actionable but does not invalidate a relevant
          // list row. Preserve the row, continue the source, and surface this as a
          // warning in the result rather than converting it into a clean finish.
          if (descWarning) {
            // The miss-aggregating merge is first-wins for every pair that is not
            // (miss, miss), so a later page's block-severity detail warning would
            // be dropped and the source would finish 'done' with no Solve action.
            // Same rule the pagination/challenge writers below use: a block may
            // replace a non-block, never the reverse.
            sourceSiteChangedWarning = descWarning.severity === 'block'
              && (!sourceSiteChangedWarning || sourceSiteChangedWarning.severity !== 'block')
              ? descWarning
              : mergeDescriptionDetailMissWarning(sourceSiteChangedWarning, descWarning);
          }
          if (['description-rate-limited', 'description-panel-http-error'].includes(descWarning?.code)) {
            // Stamping the clock on every arm is what re-arms a failed
            // cooldown re-probe: the probe clears the code before attempting,
            // so landing back here restarts the wait instead of retrying every
            // subsequent page.
            if (sourceDetailBlockPage == null) sourceDetailBlockPage = pageNum;
            if (sourceDetailFirstBlockPg == null) sourceDetailFirstBlockPg = pageNum;
            if (sourceDetailFirstBlockQuery == null) sourceDetailFirstBlockQuery = task.query || null;
            if (sourceDetailFirstBlockQueryIndex == null) sourceDetailFirstBlockQueryIndex = qi;
            sourceDetailBlockCode = descWarning.code;
            sourceDetailBlockAt = Date.now();
            sourceDetailBlockCount += 1;
          } else if (reprobeFailedThisPage && !sourceDetailBlockCode) {
            // The re-probe cleared the code before attempting and came back
            // with something the latch above does not recognise. Re-arm anyway
            // or the next page would attempt a full enrichment pass against a
            // source we just watched fail.
            if (sourceDetailBlockPage == null) sourceDetailBlockPage = pageNum;
            if (sourceDetailFirstBlockQuery == null) sourceDetailFirstBlockQuery = task.query || null;
            if (sourceDetailFirstBlockQueryIndex == null) sourceDetailFirstBlockQueryIndex = qi;
            sourceDetailBlockCode = descWarning?.code || 'description-rate-limited';
            sourceDetailBlockAt = Date.now();
            sourceDetailBlockCount += 1;
          }

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
          //
          // On a load-more source `extracted` is the whole accumulated list, so
          // it must be sliced down to THIS iteration's new rows first. Feeding
          // the running total would permanently disable the age-window rule —
          // page 1's in-window rows ride along in every later evaluation, so
          // "not one row on this page is in-window" could never become true.
          let stopDecision = null;
          const pageRows = loadMoreSelector ? extracted.slice(loadMorePrevCount) : extracted;
          if (loadMoreSelector) loadMorePrevCount = extracted.length;
          try {
            stopDecision = await task.options?.onPageScraped?.({ items: pageRows, pageIndex: pageNum - 1 });
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

          // Captured BEFORE the click so a URL-paginated source can prove the
          // page actually turned (see the wait after the settle below).
          const beforeUrl = urlPaginated ? safePageUrl(page) : null;
          let nextPage = loadMoreSelector
            ? await clickLoadMore(page, loadMoreSelector)
            : await clickNextPage(page, sourceId);
          let directAdvance = null;
          if (!nextPage.clicked && !nextPage.unhandled && shouldTryZipRecruiterDirectContinuation({
            sourceId,
            claimedTotal: sourceClaimedTotal,
            collected: allJobs.length,
            pageNum,
            maxPages,
            hasNextUrl: typeof task.options?.nextUrl === 'function',
          })) {
            const expectedPage = pageNum + 1;
            let directUrl = null;
            try { directUrl = task.options.nextUrl(pageNum); }
            catch { /* invalid task wiring falls through to the normal stop */ }
            if (directUrl) {
              directContinuationFromPage ??= expectedPage;
              logger.info(`[BrowserScraper] ${srcName} page ${pageNum} exposed no Next link with ${allJobs.length}/${sourceClaimedTotal} advertised rows collected — probing direct page ${expectedPage}`);
              recordManualScraperTelemetry({
                phase: 'direct-page-probe', sourceId, srcName,
                queryIndex: qi + 1, queryTotal: sourceTasks.length,
                pageNum: expectedPage, count: allJobs.length, url: directUrl,
              });
              await updateOverlay(page, {
                ...overlayBase,
                count: allJobs.length,
                status: `Checking unlinked page ${expectedPage}…`,
              }).catch(() => {});
              const issued = await page.evaluate(u => { window.location.href = u; }, directUrl)
                .then(() => true)
                .catch(() => false);
              if (issued) {
                directAdvance = { expectedPage, url: directUrl };
                nextPage = { clicked: true, unhandled: null };
              } else {
                directContinuationStop = 'navigation-failed';
                hitPageTurnStalled = true;
              }
            }
          }
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
                  // Name the selector the reader must actually go and fix. A
                  // load-more source has no next-page selector to update — its
                  // control comes from the task's `loadMoreSelector` (jobs.js) —
                  // so a generic "next-page selector" instruction would send
                  // them to the wrong map.
                  suggestion: `The ${srcName} pagination control changed or failed to respond. Update its ${loadMoreSelector ? 'loadMoreSelector (jobs.js)' : 'next-page selector'}, then rerun this source so later results are collected.`,
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
          await updateOverlay(page, {
            ...overlayBase,
            count:  allJobs.length,
            status: loadMoreSelector ? 'Loading more jobs…' : `Loading page ${pageNum}…`,
          });

          // A load-more click appends to the current document — there is no
          // navigation to wait on, and no challenge/readiness cycle to run. Wait
          // for the list to actually grow instead: a click that adds nothing
          // means the board is out of results.
          if (loadMoreSelector) {
            const grown = await waitForListGrowth(page, task.extractorJS, loadMorePrevCount, signal);
            if (signal?.aborted) { earlyExit = true; break; }
            if (grown <= loadMorePrevCount) {
              logger.info(`[BrowserScraper] ${srcName} q${qi + 1}: "show more" added no further jobs after ${loadMorePrevCount} — end of results`);
              hitEmptyPage = true;
              break;
            }
            continue;
          }

          // Prove the page turned before extracting anything.
          //
          // clickNextPage is a bare in-page click with no navigation wait, and
          // waitForReady returns `ok` on its first poll for a source whose
          // CONTENT_SELECTORS entry is null. A slow page load therefore meant
          // the extractor re-read the PREVIOUS page: every row deduped away,
          // two such pages in a row produced {stop:true, reason:'no-new-jobs'},
          // and the walk ended early while blaming the board. On ZipRecruiter
          // the pages lost that way are its best ones — measured on-target rate
          // rises with depth there (35% on page 1, ~100% by page 25).
          if (urlPaginated && beforeUrl) {
            const turned = await waitForUrlChange(page, beforeUrl, signal);
            if (signal?.aborted) { earlyExit = true; break; }
            if (!turned) {
              // Do NOT extract the same document twice. Fall through to the
              // existing stall reporting with an honest reason.
              logger.warn(`[BrowserScraper] ${srcName} q${qi + 1}: next-page click did not change the URL within ${CONTENT_TIMEOUT_MS}ms (still ${beforeUrl}) — stopping rather than re-reading page ${pageNum - 1}`);
              recordManualScraperTelemetry({
                phase: 'page-turn-stalled', sourceId, srcName,
                queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
                count: allJobs.length, url: beforeUrl,
              });
              hitPageTurnStalled = true;
              if (directAdvance) {
                directContinuationStop = 'navigation-stalled';
              }
              pageNum -= 1; // attempted page was never reached — the click never navigated
              break;
            }
          }

          // Wait for new content to appear on the paginated page
          const pagedReady = await waitForReady(page, sourceId, overlayBase, signal, task.url);
          if (pagedReady === 'abort' || signal?.aborted) { earlyExit = true; break; }
          if (pagedReady === 'hard-block' || pagedReady === 'skip') {
            // A block must be able to replace a non-block warning: this slot is
            // per-source and every writer used to bail on ANY existing value, so
            // one early info-severity note could permanently hide a real
            // Cloudflare block.
            if (!sourceSiteChangedWarning || sourceSiteChangedWarning.severity !== 'block') {
              sourceSiteChangedWarning = pagedReady === 'hard-block'
                  ? {
                    code:       'cloudflare-hard-block',
                    severity:   'block',
                    action:     'none',
                    shortLabel: 'Wait, then rerun',
                    evidence:   `${srcName} was hard-blocked by Cloudflare on page ${pageNum} — no interactive challenge to solve.`,
                    suggestion: `Open ${srcName} in a normal Chrome tab and ensure you are fully logged in, then retry.`,
                  }
                : {
                    code:       'session-blocked',
                    severity:   'block',
                    evidence:   `${srcName} re-served a bot challenge immediately after verification while moving to page ${pageNum}, so the session is blocked and the source was skipped.`,
                    suggestion: `Open ${srcName} in a normal Chrome tab, ensure you are logged in and unblocked, then run the search again.`,
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
            if (paginationRecoveries >= 2) {
              // Two bounces back to page 1 = the walk gave up; the pages past
              // the challenge were never read. Without this flag the break fell
              // through to `completed` and reported as a clean finish.
              hitChallengeRecoveryLoop = true;
              logger.warn(`[BrowserScraper] ${srcName} q${qi + 1}: anti-bot recovery returned to page 1 twice — abandoning this query's walk at page ${pageNum}`);
              recordManualScraperTelemetry({
                phase: 'challenge-recovery-loop', sourceId, srcName,
                queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
                count: allJobs.length,
              });
              break;
            }
            if (directAdvance) directContinuationStop = 'challenge-recovery';
            pageNum = 1;
          }
          // Validate only after readiness settles. The URL can briefly expose
          // /jobs-search/21 before a provider redirect finishes; checking at the
          // first URL change would accept that transient route and then extract
          // the redirected page 1 as if it were page 21.
          if (directAdvance && pagedReady !== 'recovered') {
            const landedPage = zipRecruiterSearchPageNumber(safePageUrl(page));
            if (landedPage !== directAdvance.expectedPage) {
              directContinuationStop = landedPage == null ? 'redirected-off-results' : `clamped-to-page-${landedPage}`;
              hitProviderResultWindow = true;
              logger.info(`[BrowserScraper] ${srcName} direct page ${directAdvance.expectedPage} landed on ${landedPage == null ? safePageUrl(page) || 'an unknown route' : `page ${landedPage}`} — provider result window reached`);
              recordManualScraperTelemetry({
                phase: 'direct-page-rejected', sourceId, srcName,
                queryIndex: qi + 1, queryTotal: sourceTasks.length,
                pageNum: directAdvance.expectedPage, landedPage,
                count: allJobs.length, reason: directContinuationStop, url: safePageUrl(page),
              });
              pageNum -= 1; // keep pagesWalked at the deepest page actually served
              break;
            }
            directContinuationStop = null;
            directContinuationPages += 1;
            recordManualScraperTelemetry({
              phase: 'direct-page-landed', sourceId, srcName,
              queryIndex: qi + 1, queryTotal: sourceTasks.length,
              pageNum: landedPage, count: allJobs.length, url: safePageUrl(page),
            });
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

      // Every query skipped for an unverifiable location proof is a source that
      // contributed nothing for a stated reason — without this it reported a
      // clean `completed` with zero jobs, which reads as "the board had nothing".
      if (locationProofUnavailableQueries > 0 && allJobs.length === 0 && !sourceSiteChangedWarning) {
        sourceSiteChangedWarning = {
          code: 'location-proof-unavailable',
          severity: 'info',
          evidence: `${srcName} returned results on its non-canonical /Job/jobs.htm route for all ${locationProofUnavailableQueries} quer${locationProofUnavailableQueries === 1 ? 'y' : 'ies'}, where the applied-location marker cannot appear. The rows were not extracted because the requested location could not be confirmed — this is not evidence that the location was ignored, only that it could not be proven.`,
          suggestion: 'Retry this source. If it keeps landing on /Job/jobs.htm, the query wording may be one Glassdoor declines to normalize into its canonical results route.',
        };
        logger.warn(`[BrowserScraper] ${sourceSiteChangedWarning.evidence}`);
      }

      const stopReason = resolveManualSourceStopReason({
        earlyExit,
        aborted: !!signal?.aborted,
        sourceSkipped,
        detailEnrichmentFailed,
        hitPerSourceCap,
        hitPageCap,
        hitEmptyPage,
        hitPageTurnStalled,
        hitUnhandledPagination,
        hitChallengeRecoveryLoop,
        hitProviderResultWindow,
        hitProviderTotalShortfall,
        dataStopReason,
      });
      const shortfallRetry = providerTotalShortfallRecoveryReceipt(providerTotalShortfallRecovery);
      const providerTotalShortfallWarning = hitProviderTotalShortfall
        ? zipRecruiterProviderTotalShortfallWarning({
          claimedTotal: sourceClaimedTotal,
          providerGathered: providerSeen.size,
          retryStatus: shortfallRetry?.status,
        })
        : null;
      const retryLanded = ['reload-landed', 'rows-recovered', 'rows-reloaded-no-new-identities', 'blank-after-reload', 'later-blank-after-one-retry']
        .includes(shortfallRetry?.status);
      // jobs.js already persists `directContinuation` into the terminal
      // source receipt. Carry the compact retry receipt there too, rather than
      // relying on a new result field that its aggregation would discard.
      const directContinuation = directContinuationFromPage != null
        ? {
          fromPage: directContinuationFromPage,
          pages: directContinuationPages,
          lastPage: directContinuationPages > 0
            ? directContinuationFromPage + directContinuationPages - 1
            : null,
          stop: directContinuationStop || dataStopReason || stopReason,
          ...(shortfallRetry ? { shortfallRetry } : {}),
        }
        : shortfallRetry
          ? {
            fromPage: shortfallRetry.pageNum,
            pages: retryLanded ? 1 : 0,
            lastPage: retryLanded ? shortfallRetry.pageNum : null,
            stop: `provider-total-shortfall-retry:${shortfallRetry.status}`,
            shortfallRetry,
          }
          : null;
      const result = {
        id:          `${sourceId}-0`,
        sourceId,
        success:     true,
        data:        allJobs,
        pagesWalked: sourcePagesWalked,
        stopReason,
        // Board-advertised total for this source, when it publishes a
        // trustworthy one (ZipRecruiter only — see readClaimedResultTotal).
        // Also gates only ZipRecruiter's bounded direct-page continuation when
        // its visible pager disappears. It never filters rows or asserts that
        // the drifting headline is an exact completion target.
        claimedTotal: sourceClaimedTotal,
        directContinuation,
        // A separate receipt for the one direct reload allowed after a normal
        // ZipRecruiter page turn lands blank below its trusted query total.
        // Unlike `directContinuation`, this is a retry of the same numbered
        // page and must not be reported as evidence that an unlinked tail was
        // exhaustively traversed.
        providerTotalShortfallRecovery: shortfallRetry,
        // A persistent provider-total shortfall is non-gating: it must not
        // strand otherwise usable rows in sources-ready, but it must remain
        // visible/actionable after source cards are reaped. A concrete block
        // warning from the retry still wins this informational outcome.
        warning:     sourceSiteChangedWarning || providerTotalShortfallWarning || null,
        // A detail block does not stop the walk, so `stopReason` legitimately
        // stays `completed` — but the rows it produced carry no description and
        // are dropped by the scoring-evidence gate. Report it as its own fact
        // instead of leaving the run to look clean. `null` = enrichment ran for
        // every page.
        detailBlock: sourceDetailBlockCode || sourceDetailBlockCount > 0 || sourceDetailUnenriched > 0
          ? {
            code: sourceDetailBlockCode,          // null once a re-probe recovered
            active: Boolean(sourceDetailBlockCode),
            firstPage: sourceDetailBlockPage,
            // Survives recovery — `firstPage`/`reprobes` above are reset when a
            // re-probe succeeds, which erased the episode from the report.
            everBlockedPage: sourceDetailFirstBlockPg,
            firstQuery: sourceDetailFirstBlockQuery,
            firstQueryIndex: sourceDetailFirstBlockQueryIndex,
            arms: sourceDetailBlockCount,
            reprobes: sourceDetailReprobes,
            reprobesTotal: sourceDetailReprobeTotal,
            recovered: sourceDetailRecovered,
            skippedCards: sourceDetailSkippedCards,
            unenrichedRows: sourceDetailUnenriched,
          }
          : null,
        executedQueries,
        // Candidate identities are recorded before confirmed unavailable detail
        // pages are removed from `data`; preserve both figures for an honest
        // candidate-traversed → usable-row report.
        providerGathered: providerSeen.size,
        unavailableDetailDropped: sourceUnavailableDetailDropped,
        providerDuplicatesDropped: Math.max(0, sourcePhysicalCards - providerSeen.size),
        // A ZipRecruiter empty page below its verified advertised total is not
        // a clean end-of-results. Keep the partial result usable while making
        // the coverage qualification durable through jobs.js and the receipt.
        // Reaching the allocated page budget is a deliberately bounded,
        // non-exhaustive walk just like a verified provider-total shortfall.
        // Keep it durable so a later receipt/report cannot call the collected
        // subset lossless merely because the manual scraper returned rows.
        truncated: hitProviderTotalShortfall || hitPageCap,
        ...(hitPageCap ? { cap: manualPageCapForTasks(sourceTasks, collectionLimits) } : {}),
        relevanceDropped: 0,
        preCapRelevanceDropped: 0,
        relevanceRejected: [],
        revealOutcomes: revealOutcomes.slice(0, 20),
        // Glassdoor accepts a nation-tier locId while leaving rows scoped to
        // browser egress. Keep this safe source-level fact independent from the
        // warning slot, which must remain available for genuine scrape errors.
        locationScopeUnenforced: nationTierCaveatRecorded,
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
    // Drop the renderer sink with the run that installed it. A later direct
    // caller (or a test) that passes no sink must not keep emitting into the
    // previous run's node, and an in-flight marker must never outlive the
    // await it described.
    activitySink = null;
    manualScraperTelemetry.inFlight = null;
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
