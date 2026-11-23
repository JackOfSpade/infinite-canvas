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

import { manualScraperTelemetry, activitySinkState } from './manualScraper/scrapeState.js';
import { measurementPacingOff } from './scrapeMeasurement.js';
import {
  resetScrapePace,
  notePaceListPage,
  notePaceDescriptionRoute,
  recordManualScraperTelemetry,
  recordIssuedManualQuery,
  clearManualScraperTelemetry,
  setActivitySink,
  withInFlight,
  resetManualScraperTelemetry,
  isIgnorableManualBrowserTelemetry,
} from './manualScraper/scrapeTelemetry.js';
export {
  resetScrapePace,
  notePaceListPage,
  notePaceChallengeStart,
  notePaceChallengeEnd,
  notePaceChallengeProgress,
  notePacePanelInterrupt,
  formatScrapePaceLine,
  isIgnorableManualBrowserTelemetry,
  recordManualScraperTelemetry,
  recordChallengeDetectedTelemetry,
  recordIssuedManualQuery,
  getManualScraperTelemetry,
  setActivitySink,
  resetManualScraperDiagnostics,
  resetManualScraperTelemetry,
  notePaceDetailOpened,
  notePaceSpacingWait,
  recordActivityBeat,
} from './manualScraper/scrapeTelemetry.js';
import {
  NAV_SETTLE_MS,
  CONTENT_TIMEOUT_MS,
  UNLIMITED_PAGE_BACKSTOP,
  UNLIMITED_JOB_BACKSTOP,
  DESC_CHANGE_POLL_MS,
  DESC_CHANGE_TIMEOUT_MS,
  DESC_RETRY_PAUSE_MS,
  DESC_CLICK_DELAY_MS,
  SITE_CHANGED_ABORT_THRESHOLD,
  DESC_STALE_THRESHOLD,
  DETAIL_BLOCK_COOLDOWNS_MS,
  detailBlockCooldownMs,
  DETAIL_BLOCK_MAX_REPROBES,
  DETAIL_BLOCK_WARNING_CODES,
  DETAIL_BLOCK_MAX_TOTAL_REPROBES,
  DETAIL_BLOCK_PROBE_CARDS,
  DEFAULT_INTER_QUERY_COOLDOWN_MS,
  SOURCE_LABELS,
  sleepUnlessAborted,
  browserClosedWarning,
  pageUnreadableWarning,
  resolveManualSourceStopReason,
  manualPageCapForTasks,
  selectManualSourcePageJobs,
  partitionAlreadyReadJobs,
  didDetailBlockReprobeRecover,
  composeDetailBlockReprobeResult,
  CONTENT_SELECTORS,
  NEXT_PAGE_SELECTORS,
  HARD_NAVIGATION_PAGER_SOURCES,
  SCROLL_SOURCES,
  DESC_CONFIGS,
  descriptionExpansionStrategy,
  zipRecruiterSearchPageNumber,
  shouldTryZipRecruiterDirectContinuation,
  zipRecruiterProviderShortfallRecoveryOutcome,
  providerTotalShortfallRecoveryReceipt,
  zipRecruiterProviderTotalShortfallWarning,
  WALK_GUARD_MAX,
  WALK_GUARD_DETAIL_MAX_CHARS,
  WALK_GUARD_KINDS,
  appendWalkGuard,
} from './manualScraper/walkRules.js';
export {
  detailBlockCooldownMs,
  DETAIL_BLOCK_MAX_TOTAL_REPROBES,
  browserClosedWarning,
  pageUnreadableWarning,
  resolveManualSourceStopReason,
  manualPageCapForTasks,
  selectManualSourcePageJobs,
  partitionAlreadyReadJobs,
  withoutAlreadyReadJobs,
  didDetailBlockReprobeRecover,
  composeDetailBlockReprobeResult,
  panelWindowWaitMs,
  descriptionNavigationDecision,
  descriptionExpansionStrategy,
  descriptionPanelPacing,
  descriptionPanelFailureAttribution,
  descriptionPanelRetryAllowed,
  parseClaimedResultTotal,
  zipRecruiterSearchPageNumber,
  shouldTryZipRecruiterDirectContinuation,
  zipRecruiterProviderShortfallRecoveryOutcome,
  providerTotalShortfallRecoveryReceipt,
  zipRecruiterProviderTotalShortfallWarning,
  WALK_GUARD_MAX,
  WALK_GUARD_KINDS,
  appendWalkGuard,
} from './manualScraper/walkRules.js';
import {
  mergeDescriptionDetailMissWarning,
} from './manualScraper/detailParsing.js';
export {
  mergeDescriptionDetailMissWarning,
  assessDetailSelection,
  assessDescriptionPanelUpdate,
  glassdoorPanelResponseIdentity,
  isGlassdoorPanelRateLimitResponse,
  isGoogleDescriptionPanelRateLimitResponse,
  extractGlassdoorPanelResponseDetail,
  mergeGlassdoorPanelDetail,
  extractZipRecruiterDomSalaryText,
  zipRecruiterDetailGapMs,
  normalizeDetailNavigationUrl,
  pinGlassdoorDetailUrlToListHost,
  isDetachedDetailFrameError,
  shouldNavigateForDescription,
  isZipRecruiterClosedDetailRedirect,
  isUnavailableDetailPage,
  unavailableDetailDisposition,
  captureZipRecruiterListingLiveness,
  zipRecruiterRetryAfterMs,
  isAppcastTemporaryRestriction,
  zipRecruiterAppcastRestrictionBackoffMs,
  isZipRecruiterDetailErrorShell,
  zipRecruiterDetailErrorShellBackoffMs,
  formatJsonLdSalary,
  reconcileZipRecruiterDomSalary,
  mergeExpandedJobDetail,
} from './manualScraper/detailParsing.js';
import {
  buildPhysicalCardWalkPlan,
} from './manualScraper/descriptionDom.js';
export {
  buildDescriptionCardTargets,
  buildPhysicalCardWalkPlan,
  readActiveGoogleDetailTitle,
  readDescriptionPanelText,
  readDescriptionCardDomKey,
  inspectGlassdoorOpportunityModal,
  inspectDescriptionCardTargetAvailability,
} from './manualScraper/descriptionDom.js';
import {
  updateOverlay,
  injectOverlay,
  waitIfPaused,
  safePageUrl,
  launchScrapePlatformBrowser,
  scrapeFingerprintPolicy,
  applyStealthMask,
  OVERLAY_SCRIPT,
} from './manualScraper/scrapeBrowser.js';
import { createBackgroundScrapePage } from './backgroundScrapeBrowser.js';
import {
  CHALLENGE_LOOP_MEMORY_MS,
  describeRefusedChecks,
  resetChallengeLoopMemory,
  sourceRefusedSolvedChecks,
  waitForReady,
} from './manualScraper/pageReadiness.js';
export {
  CHALLENGE_ESCALATE_MS,
  CHALLENGE_INTERSTITIAL_MAX_CHARS,
  hasManualVerificationText,
  hasManualHardBlockText,
  classifyManualChallengeSignals,
  resolveManualChallengeTransition,
  getChallengeSignals,
  waitForReady,
  challengeHeartbeatIntervalMs,
  resolveManualDetailChallengeDisposition,
  CHALLENGE_LOOP_MAX_ATTEMPTS,
  CHALLENGE_SELF_RELOAD_MAX,
  resetChallengeLoopMemory,
  sourceRefusedSolvedChecks,
} from './manualScraper/pageReadiness.js';
import {
} from './manualScraper/googleApply.js';
export {
  selectGoogleApplyUrl,
  normalizeGoogleApplyOptions,
  extractGoogleApplyCandidatesFromDocument,
  readGoogleApplyCaptureCounts,
  addGoogleApplyCapture,
  isGoogleApplyRedirect,
  createGoogleApplyRedirectResolver,
  GOOGLE_APPLY_LINKS_RATE_LIMITED_CODE,
  buildPendingGoogleApplyRedirects,
  googleApplyLinksRateLimitedWarning,
  followGoogleApplyRedirects,
} from './manualScraper/googleApply.js';
import {
  resolveGlassdoorLocId,
  describeGlassdoorLocationFailure,
  glassdoorDateFilterReapplyUrl,
  glassdoorLocationProof,
  isGlassdoorCanonicalResultsUrl,
} from './manualScraper/glassdoorLocation.js';
export {
  glassdoorRequestedCountry,
  validateGlassdoorLocationPick,
  glassdoorUrlHasLocationId,
  isGlassdoorCanonicalResultsUrl,
  glassdoorDateFilterReapplyUrl,
  glassdoorLocationProof,
  glassdoorLookupAttemptIsTransient,
  summarizeGlassdoorLookupAttempts,
  glassdoorCachedLocationUsable,
  upgradeGlassdoorCountryRootCache,
  classifyGlassdoorLookupFailure,
  describeGlassdoorLocationFailure,
} from './manualScraper/glassdoorLocation.js';
import {
  runExtractor,
  clickNextPage,
  clickLoadMore,
  waitForUrlChange,
  waitForListGrowth,
  readClaimedResultTotal,
  preloadContent,
} from './manualScraper/listWalk.js';
export {
  REVEAL_STABLE_PASSES,
  revealLowGrowthStop,
  clickNextPage,
  clickLoadMore,
  ADVANCE_CONTROL_LABEL_PATTERNS,
  preloadResolvedJobList,
} from './manualScraper/listWalk.js';
import { expandDescriptionsByNavigation } from './manualScraper/expandByNavigation.js';
import { expandDescriptionsByPanel } from './manualScraper/expandByPanel.js';
import {
  expandGlassdoorDescriptions,
  glassdoorPanelBlockIsSourceWide,
  takeGlassdoorPanelBlockForSource,
  withoutGlassdoorJobPageUrl,
} from './manualScraper/glassdoorJobPage.js';
export {
  GLASSDOOR_JOB_PAGE_GAP_MS,
  GLASSDOOR_JOB_PAGE_RATE_LIMITED_GAP_MS,
  GLASSDOOR_JOB_PAGE_SETTLE_MS,
  GLASSDOOR_JOB_PAGE_STOP_REASONS,
  expandGlassdoorDescriptions,
  glassdoorJobPageNeedsReprobe,
  glassdoorJobPageSalary,
  glassdoorJobPageTarget,
  withoutGlassdoorJobPageUrl,
  glassdoorPanelBlockIsSourceWide,
  takeGlassdoorPanelBlockForSource,
  isGlassdoorSecurityTitle,
  noteGlassdoorJobPageUnreadable,
  glassdoorJobPageEligible,
  glassdoorJobPageGapMs,
  glassdoorJobPageState,
  glassdoorJobPageVerdict,
  noteGlassdoorJobPageChallenge,
  noteGlassdoorJobPageRateLimit,
} from './manualScraper/glassdoorJobPage.js';
import {
  closeStealthBrowser, getUserDataDir, findChromePath,
} from '../stealthBrowser.js';
import { logger } from '../../logger.js';
import { partitionByPageTitleScreen } from '../jobs/pageTitleScreen.js';
import { GOOGLE_POSTED_TEXT_PATTERN } from './googlePostedDate.js';
import { isProfileLockCollision } from '../browserLaunchTelemetry.js';
import { humanDelay } from '../../utils/humanDelay.js';
import { CA_PROVINCES, US_STATES } from '../../../src/utils/jobLocation.js';
import { sourceJobKey } from '../../../src/utils/jobIdentity.js';
import { HARD_BLOCK_RETRY_WAIT_MS } from '../../../src/utils/jobSourceWarningPolicy.js';
import { JOB_COLLECTION_AUTO_LIMITS, resolveJobsPerPlatform, resolvePageCeiling } from '../../../src/utils/jobCollectionLimits.js';
import { isBackgroundE2E, backgroundE2EDisabledError } from '../../utils/backgroundE2e.js';
import { LISTING_LIVENESS_RULES } from '../listingLiveness.js';




















/** Lowercased hostname, or '' for anything unparseable. Never throws. */
function safeUrlHost(rawUrl) {
  try { return new URL(String(rawUrl || '')).hostname.toLowerCase(); } catch { return ''; }
}




























// ── Description expansion ─────────────────────────────────────────────────────
// Clicks each job card and captures the full description from the side panel.
// Only runs when DESC_CONFIGS[sourceId] is defined.
//
// Returns { jobs, descError, descWarning, unavailableDetailDropped } where descError is non-null when card or panel
// selectors appear stale (≥ DESC_STALE_THRESHOLD consecutive failures of the same
// type). A non-null descError is an abort signal — the caller must set earlyExit
// and surface the error just like a SITE_CHANGED extraction failure.
async function expandDescriptions(page, jobs, sourceId, overlayBase, totalSoFar, signal = null, walkPlan = null, runtime = null) {
  const cfg = DESC_CONFIGS[sourceId];
  if (!cfg || jobs.length === 0) {
    return {
      jobs,
      descError: null,
      descWarning: null,
      expandedCount: 0,
      attemptedCount: 0,
      // This is deliberately distinct from a description miss: a confirmed
      // closed/not-found posting is removed from the returned usable rows.
      unavailableDetailDropped: 0,
      boardClosedDetailKept: 0,
    };
  }

  const strategy = descriptionExpansionStrategy(sourceId);
  if (strategy === 'detail-navigation') {
    return expandDescriptionsByNavigation(page, jobs, sourceId, overlayBase, totalSoFar, signal, walkPlan, runtime, cfg);
  }
  if (strategy === 'job-page-then-list-card-panel') {
    // Glassdoor: each row's own /job-listing/ page first (separate background
    // tab, so the list page stays loaded), then the list-card panel on the
    // still-loaded list page for whatever the job page did not settle.
    return expandGlassdoorDescriptions(page, jobs, sourceId, overlayBase, totalSoFar, signal, walkPlan, runtime, cfg, {
      byNavigation: expandDescriptionsByNavigation,
      byPanel: expandDescriptionsByPanel,
      record: route => recordManualScraperTelemetry({
        phase: 'card-walk',
        sourceId,
        srcName: overlayBase.srcName,
        queryIndex: overlayBase.queryIndex ?? null,
        queryTotal: overlayBase.queryTotal ?? null,
        pageNum: overlayBase.pageNum ?? null,
        total: jobs.length,
        itemTotal: jobs.length,
        attempted: route.jobPageOpened,
        expanded: route.fromJobPage,
        strategy: 'job-page-then-list-card-panel',
        descriptionRoute: route,
      }, { updateActive: false }),
      notePace: summary => notePaceDescriptionRoute(sourceId, { srcName: overlayBase.srcName, ...summary }),
    });
  }

  return expandDescriptionsByPanel(page, jobs, sourceId, overlayBase, totalSoFar, signal, walkPlan, runtime, cfg);
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
export async function enrichResolvedJobDescriptions(page, jobs, sourceId, signal = null, walkPlan = {}, runtime = null) {
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
    return await expandDescriptions(page, list, sourceId, overlayBase, list.length, signal, walkPlan, runtime);
  } finally {
    // Settle the slot the same way an ordinary run's completion does, so a
    // report opened after this pass ends sees it as over — not as a recovery
    // that has been silently "in progress" ever since.
    clearManualScraperTelemetry('finished');
  }
}


















// ── Detached list page recovery ──────────────────────────────────────────────
/**
 * Open a second scrape tab in the SAME platform browser, set up exactly as
 * launchScrapePlatformBrowser sets up its first page: same background-page
 * creation, the stealth mask unless this source runs plain, the console /
 * network-failure telemetry, the main-frame status feed into the shared
 * `navStatusRef`, and the overlay on every new document. Used only when the
 * walk's page object can no longer be read (Puppeteer "Attempted to use
 * detached Frame"). Keep in step with launchScrapePlatformBrowser.
 */
async function openReplacementScrapePage(platform) {
  const { browser, navStatusRef } = platform;
  const replacement = await createBackgroundScrapePage(browser, { width: 1280, height: 900 });
  try {
    if (platform.fingerprint?.plain !== true) await applyStealthMask(replacement);
    replacement.on('console', (msg) => {
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
    replacement.on('requestfailed', (req) => {
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
    replacement.on('response', (res) => {
      const status = res.status();
      try {
        if (res.request().resourceType() === 'document' && res.frame() === replacement.mainFrame()) {
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
    await replacement.evaluateOnNewDocument(OVERLAY_SCRIPT);
  } catch (error) {
    await replacement.close().catch(() => {});
    throw error;
  }
  return replacement;
}

/**
 * The URL a recovered list page should reopen, or null when the walk's
 * position cannot be reproduced from a URL. Scroll-revealed lists, load-more
 * lists past their first batch, and click pagers past their first page would
 * reopen at the top and silently re-read or skip rows, so those are not
 * recovered here (the walk keeps its rows and stays retryable instead).
 */
export function detachedListRecoveryUrl({
  deadPageUrl = '',
  taskUrl = '',
  scrollSource = false,
  urlPaginated = false,
  loadMoreRowsRead = 0,
  onFirstPage = true,
} = {}) {
  if (scrollSource) return null;
  if (loadMoreRowsRead > 0) return null;
  const isUrl = value => /^https?:\/\//i.test(String(value || ''));
  // First page: the query's own list URL. Right after a check the dead page's
  // last URL can be the check's own route, which would reopen the check.
  if (onFirstPage) return isUrl(taskUrl) ? taskUrl : (isUrl(deadPageUrl) ? deadPageUrl : null);
  // Past the first page only a URL pager can be reopened at the same page.
  if (!urlPaginated) return null;
  return isUrl(deadPageUrl) ? deadPageUrl : null;
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
 *
 * `opts`: { resetDiagnostics=true, sourceIndexBase=0, sourceTotal=null, onActivity=null }
 * — for per-source dispatch the orchestrator passes resetDiagnostics:false (it
 * cleared once up front) and the real index/total so the "Starting X/Y" log stays
 * correct. `onActivity` receives the mid-walk liveness beat (see updateOverlay);
 * it is the ONLY channel this module has to the renderer, and it is optional so
 * direct callers and tests need not supply one.
 */
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
      let sourceBoardClosedDetailKept = 0;
      // Cards this source's pages dropped only because their posted date fell
      // before the collection window. They still HAD a date.
      const sourceWindowDropStats = { windowDropped: 0 };
      // Cards left unopened because an earlier run already read or showed them.
      let sourceAlreadyReadSkipped = 0;
      // The part of that count an earlier blocked run of this platform read.
      let sourceReadEarlierSkipped = 0;
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
      const sourceDetailPacing = {};
      let sourceDetailBlockCode    = null;
      let sourceDetailBlockAt      = 0;    // ms epoch the block was (re)armed — drives the cooldown re-probe
      let sourceDetailBlockPage    = null; // first page whose descriptions were skipped, for the report
      let sourceDetailBlockCount   = 0;    // times the block armed (1 = never recovered)
      let sourceDetailReprobes     = 0;    // cooldown re-probes attempted
      let sourceDetailPartialCycles = 0;   // bounded partial recoveries; do not consume failed-attempt budget
      let sourceDetailPartialCycleTotal = 0;
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
      // Why this source stopped early despite a walk that looked healthy: a
      // backstop, a trickle pager, a stalled reveal, an exhausted retry budget.
      // Fixed shape, counts only — jobs.js turns these into a visible warning.
      const walkGuards             = [];
      // Set when THIS source's Chrome disconnects without our own teardown.
      let browserClosedUnexpectedly = false;
      // Set when the walk's page object could no longer be read (Puppeteer
      // "Attempted to use detached Frame") and its one recovery for that query
      // did not produce a usable page. Reported through the browser-closed
      // path: rows kept, unread queries named, retryable — never as an
      // extractor fault, because nothing about the extractor was observed.
      let pageDetachedUnrecovered = null;

      const displayIndex = sourceIndexBase + si + 1;
      const displayTotal = sourceTotal || sourceList.length;
      // Fresh, fully-isolated Chrome for THIS platform (torn down before the
      // next). A shared-profile collision is a source-level, retryable block,
      // not a reason to discard already-collected sibling sources or abort the
      // entire Job Search pipeline with Puppeteer's raw Code: 0 text.
      try {
        platform = await launchScrapePlatformBrowser({
          userDataDir, executablePath, sandboxArgs,
          fingerprint: scrapeFingerprintPolicy(sourceId),
          onCrash: () => { earlyExit = true; browserClosedUnexpectedly = true; },
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
      // `let`: a detached list page is replaced once per query (see
      // recoverDetachedListPage). Every use below reads this binding, so the
      // walk and its helpers follow the replacement.
      let { page } = platform;
      const { navStatusRef } = platform;

      // One recovery per query for a page object that can no longer be read:
      // open a fresh tab in this same platform browser (set up like the first),
      // close the dead one, reopen the query's list URL there, and run the
      // normal readiness/challenge wait so any new check is handed to the user,
      // never bypassed. Returns the wait's outcome, or 'page-detached' when no
      // live page could be obtained. The caller decides what each outcome means.
      const recoverDetachedListPage = async ({ url, overlayBase, qi, pageNum, cause }) => {
        const deadPage = page;
        const attempt = {
          phase: 'page-detached-recovery', sourceId, srcName,
          queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
          cause, url: String(url || '').slice(0, 300),
        };
        if (!url) {
          recordManualScraperTelemetry({ ...attempt, outcome: 'position-not-reproducible' }, { updateActive: false });
          return 'page-detached';
        }
        if (platform.isClosed?.()) {
          recordManualScraperTelemetry({ ...attempt, outcome: 'browser-closed' }, { updateActive: false });
          return 'page-detached';
        }
        let replacement;
        try {
          replacement = await openReplacementScrapePage(platform);
        } catch (error) {
          const reason = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200);
          logger.warn(`[BrowserScraper] ${srcName} q${qi + 1}: could not open a replacement page after the list page detached: ${reason}`);
          recordManualScraperTelemetry({ ...attempt, outcome: 'replacement-failed', error: reason }, { updateActive: false });
          return 'page-detached';
        }
        page = replacement;
        platform.page = replacement;
        const deadClosed = await deadPage.close().then(() => true).catch(() => false);
        // A dead tab left open would hide the replacement, and with it any new
        // check the user has to solve there.
        if (!deadClosed) await replacement.bringToFront().catch(() => {});
        logger.warn(`[BrowserScraper] ${srcName} q${qi + 1} p${pageNum}: list page detached (${cause}) — reopened ${url} in a fresh tab (one recovery per query)`);
        navStatusRef.last = null;
        const issued = await page.evaluate(u => { window.location.href = u; }, url)
          .then(() => true)
          .catch(() => false);
        if (!issued) {
          recordManualScraperTelemetry({ ...attempt, outcome: 'navigation-failed' }, { updateActive: false });
          return 'page-detached';
        }
        await sleepUnlessAborted(humanDelay(NAV_SETTLE_MS), signal);
        if (signal?.aborted) return 'abort';
        await injectOverlay(page);
        await updateOverlay(page, { ...overlayBase, count: allJobs.length, status: 'Reopened the results page — loading…' }).catch(() => {});
        const recoveredState = await waitForReady(page, sourceId, overlayBase, signal, url);
        recordManualScraperTelemetry({ ...attempt, outcome: recoveredState, landedUrl: safePageUrl(page) }, { updateActive: false });
        return recoveredState;
      };
      const noteDetachedUnrecovered = ({ qi, pageNum, cause, recoveryState }) => {
        pageDetachedUnrecovered = { queryIndex: qi + 1, pageNum, cause, recoveryState };
        logger.warn(`[BrowserScraper] ${srcName} q${qi + 1} p${pageNum}: list page could not be read (${cause}; recovery: ${recoveryState}) — keeping ${allJobs.length} row(s) and stopping this source; it stays retryable`);
        recordManualScraperTelemetry({
          phase: 'page-detached-unrecovered', sourceId, srcName,
          queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
          cause, recoveryState, count: allJobs.length,
        });
        earlyExit = true;
      };

      logger.info(`[BrowserScraper] Starting ${displayIndex}/${displayTotal}: ${srcName} (${sourceTasks.length} queries) — fresh isolated browser launched`);
      recordManualScraperTelemetry({
        phase: 'source-start',
        sourceId,
        srcName,
        sourceIndex: displayIndex,
        sourceTotal: displayTotal,
        queryTotal: sourceTasks.length,
      });
      // A new run of this source may show its checks to the person again.
      resetChallengeLoopMemory(sourceId);
      // Fresh pace record for THIS source run (diagnostics only, fail-soft).
      resetScrapePace(sourceId, {
        srcName,
        queryIndex: 1,
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
        if (qi > 0 && !measurementPacingOff(sourceId)) {
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

        // One detached-page recovery per query (recoverDetachedListPage).
        let pageRecoveryUsed = false;
        // A 'page-detached' wait means the page object is dead — nothing was
        // observed about the site. Recover once, re-running the full readiness
        // wait on the fresh page; otherwise stop through the browser-closed path.
        const settleDetachedReadiness = async (state, url) => {
          if (state !== 'page-detached') return state;
          if (pageRecoveryUsed) return 'page-detached';
          pageRecoveryUsed = true;
          const recovered = await recoverDetachedListPage({
            url, overlayBase, qi, pageNum: task.options?.startPageNum || 1, cause: 'readiness-probe',
          });
          if (recovered !== 'page-detached' && recovered !== 'abort' && !navigationIssued) {
            // The dead page never took this query's navigation; the fresh one did.
            recordIssuedManualQuery(executedQueries, { query: task.query || '', url: task.url }, true);
          }
          return recovered;
        };

        // Wait for real content — handles challenge pages
        let readyState = await waitForReady(page, sourceId, overlayBase, signal, task.url);
        readyState = await settleDetachedReadiness(readyState, task.url);

        // Glassdoor's canonical redirect drops the posting-date filter: the
        // request carried `fromAge=14` and the landed SRCH route carried none,
        // so the page answered with unfiltered cards (15d-30d+ old for a 13-day
        // window). Appending fromAge to the LANDED route is honored, so
        // re-navigate there ONCE and let the unchanged ready-state handling
        // below judge the second landing (abort, hard block and skip included).
        if (sourceId === 'glassdoor' && (readyState === 'ok' || readyState === 'recovered')) {
          const reapplyUrl = glassdoorDateFilterReapplyUrl(page.url(), task.url);
          if (reapplyUrl) {
            logger.info(`[BrowserScraper] ${srcName} q${qi + 1}: Glassdoor dropped fromAge — re-navigating once with the posting-date filter reapplied (${reapplyUrl})`);
            recordManualScraperTelemetry({
              phase: 'date-filter-reapplied',
              sourceId,
              srcName,
              queryIndex: qi + 1,
              queryTotal: sourceTasks.length,
              url: reapplyUrl,
            }, { updateActive: false });
            navStatusRef.last = null;
            await page.evaluate(u => { window.location.href = u; }, reapplyUrl)
              .then(() => true)
              .catch(() => false);
            await new Promise(r => setTimeout(r, humanDelay(NAV_SETTLE_MS)));
            readyState = await waitForReady(page, sourceId, overlayBase, signal, reapplyUrl);
            readyState = await settleDetachedReadiness(readyState, reapplyUrl);
          }
        }
        if (readyState === 'abort' || signal?.aborted) { earlyExit = true; break; }
        if (readyState === 'page-detached') {
          noteDetachedUnrecovered({
            qi, pageNum: task.options?.startPageNum || 1, cause: 'readiness-probe',
            recoveryState: pageRecoveryUsed ? 'failed' : 'not-attempted',
          });
          break;
        }
        if (readyState !== 'ok' && readyState !== 'recovered' && readyState !== 'hard-block' && readyState !== 'skip') {
          // An outcome this walk does not know is never read as a usable page.
          logger.warn(`[BrowserScraper] ${srcName} q${qi + 1}: unexpected readiness outcome "${readyState}" — not extracting from an unconfirmed page`);
          noteDetachedUnrecovered({ qi, pageNum: task.options?.startPageNum || 1, cause: `readiness-${readyState}`, recoveryState: 'not-attempted' });
          break;
        }
        if (readyState === 'hard-block') {
          // Cloudflare "Additional Verification Required" — no interactive widget,
          // nothing the user can solve. Skip all remaining queries for this
          // source, but keep a real Retry on the card: the block clears with
          // time, so stamp that wait instead of hiding the retry forever.
          if (!sourceSiteChangedWarning) {
            sourceSiteChangedWarning = {
              code:        'cloudflare-hard-block',
              severity:    'block',
              action:      'none',
              shortLabel:  'Wait, then retry',
              retryAfterAt: Date.now() + HARD_BLOCK_RETRY_WAIT_MS,
              // The resolver IPC requires a URL; this query's search page is
              // what a retry re-opens, and the per-source warning slot carries
              // no other card URL.
              url:         task.url,
              evidence:    `${srcName} was hard-blocked by Cloudflare ("Additional Verification Required") — no interactive challenge to solve.`,
              suggestion:  `Retry unlocks after the wait. Let the IP/session restriction cool down, confirm ${srcName} opens normally in a normal Chrome tab, then choose Retry. Skip continues without these listings.`,
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

        // The re-navigation above is a request, not a guarantee: Glassdoor can
        // drop fromAge again on the second landing. The client-side date filter
        // still runs later as the backstop, so record the gap and keep
        // extracting — but never let an unfiltered page pass silently as the
        // 13-day window the user asked for.
        if (sourceId === 'glassdoor' && isGlassdoorCanonicalResultsUrl(page.url())) {
          const stillUnfiltered = glassdoorDateFilterReapplyUrl(page.url(), task.url);
          if (stillUnfiltered) {
            let requestedFromAge = '';
            try { requestedFromAge = new URL(task.url).searchParams.get('fromAge') || ''; } catch { requestedFromAge = ''; }
            recordManualScraperTelemetry({
              phase: 'date-filter-not-applied',
              sourceId,
              srcName,
              queryIndex: qi + 1,
              queryTotal: sourceTasks.length,
              url: page.url(),
              requestedFromAge,
            }, { updateActive: false });
            logger.warn(`[BrowserScraper] ${srcName} q${qi + 1}: the canonical results URL still carried no fromAge=${requestedFromAge} after one re-navigation (${page.url()}) — extracting anyway; the client-side date filter is the backstop.`);
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
          const revealCeiling = task.options?.maxPages ?? resolvePageCeiling(null);
          const revealOutcome = await preloadContent(page, sourceId, task.extractorJS, overlayBase, signal, {
            // `??` not `||` — task.options.maxPages is already the resolved,
            // always-finite ceiling (resolvePageCeiling), but fall back to the
            // same backstop if a task was ever built without it so this never
            // silently reinstates the retired 10-page default.
            maxPages: revealCeiling,
            jobsPerPlatform,
            existingJobs: allJobs.length,
          });
          if (revealOutcome) {
            revealOutcomes.push({
              queryIndex: qi + 1,
              queryTotal: sourceTasks.length,
              ...revealOutcome,
            });
            // A reveal that stalled, or that only ended because our own pass
            // ceiling ran out, leaves cards on the page: file a guard so the run
            // cannot read as a complete list.
            if (revealOutcome.exit === 'reveal-stalled') {
              const stalledDetail = `Reveal stalled at ${revealOutcome.count} cards after ${revealOutcome.iterations} passes (under 5% growth over the last 10)`;
              logger.warn(`[BrowserScraper] ${srcName} q${qi + 1}: ${stalledDetail}`);
              appendWalkGuard(walkGuards, {
                kind: 'reveal-stalled', source: sourceId, query: qi + 1,
                page: null, pages: revealCeiling, newRows: revealOutcome.count, detail: stalledDetail,
              });
            } else if (revealOutcome.exit === 'iteration-ceiling' && revealCeiling >= UNLIMITED_PAGE_BACKSTOP) {
              const revealBackstopDetail = `Reveal stopped at the ${revealCeiling}-pass backstop with ${revealOutcome.count} cards revealed`;
              logger.warn(`[BrowserScraper] ${srcName} q${qi + 1}: ${revealBackstopDetail}`);
              appendWalkGuard(walkGuards, {
                kind: 'reveal-backstop', source: sourceId, query: qi + 1,
                page: null, pages: revealCeiling, newRows: revealOutcome.count, detail: revealBackstopDetail,
              });
            }
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
            // At or above the Auto ceiling the limit is our own safety net, not
            // a page count the user typed: reaching it is a give-up worth a
            // warning. An explicit user limit finishes quietly, as it always did.
            if (maxPages >= UNLIMITED_PAGE_BACKSTOP) {
              const backstopDetail = `Stopped at the ${maxPages}-page browser backstop (Auto) with ${allJobs.length} rows`;
              logger.warn(`[BrowserScraper] ${srcName} q${qi + 1} ${backstopDetail}`);
              appendWalkGuard(walkGuards, {
                kind: 'page-backstop', source: sourceId, query: qi + 1,
                page: Math.max(1, pageNum - 1), pages: maxPages, newRows: allJobs.length, detail: backstopDetail,
              });
            } else {
              logger.info(`[BrowserScraper] ${srcName} q${qi + 1} hit browser pages/query (${maxPages}) — stopping pagination`);
            }
            hitPageCap = true;
            if (onPageJobs) await onPageJobs({ sourceId, query: task.query || '', queryIndex: task.queryIndex ?? qi, page: Math.max(1, pageNum - 1), jobs: [], terminal: true });
            break;
          }

          await updateOverlay(page, {
            ...overlayBase,
            count:  allJobs.length,
            status: pageNum > 1 ? `Extracting page ${pageNum}…` : 'Extracting jobs…',
          });
          // Pace telemetry (diagnostics only): one list/extraction page walk.
          notePaceListPage(sourceId, {
            srcName, queryIndex: qi + 1, queryTotal: sourceTasks.length,
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
          const { jobs: extracted, siteChangedError, evalError, detachedError } = await withInFlight(
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
            outcome: detachedError ? 'page-detached' : evalError ? 'eval-error' : siteChangedError ? 'site-changed' : 'ok',
          }, { updateActive: false });

          // The page object is dead ("Attempted to use detached Frame"):
          // retrying evaluate on it can only throw again, and it says nothing
          // about the extractor. Recover a live page ONCE for this query and
          // re-extract the same page; otherwise stop via the browser-closed path.
          if (detachedError) {
            const startPage = task.options?.startPageNum || 1;
            const recoveryUrl = pageRecoveryUsed ? null : detachedListRecoveryUrl({
              deadPageUrl: safePageUrl(page),
              taskUrl: task.url,
              scrollSource: SCROLL_SOURCES.has(sourceId),
              urlPaginated,
              loadMoreRowsRead: loadMorePrevCount,
              onFirstPage: pageNum === startPage,
            });
            let recoveryState = pageRecoveryUsed ? 'already-used' : 'position-not-reproducible';
            if (recoveryUrl) {
              pageRecoveryUsed = true;
              recoveryState = await recoverDetachedListPage({
                url: recoveryUrl, overlayBase, qi, pageNum, cause: 'extractor-evaluate',
              });
            }
            if (recoveryState === 'abort' || signal?.aborted) { earlyExit = true; break; }
            // 'recovered' means the readiness wait sent the page back to the URL
            // it was given (recoveryUrl, this same list position) after a check,
            // so re-extracting it is valid on any page.
            if (recoveryState === 'ok' || recoveryState === 'recovered') {
              evalErrStreak = 0;
              continue;
            }
            if (recoveryState === 'hard-block' || recoveryState === 'skip') {
              if (!sourceSiteChangedWarning || sourceSiteChangedWarning.severity !== 'block') {
                sourceSiteChangedWarning = recoveryState === 'hard-block'
                  ? {
                    code:       'cloudflare-hard-block',
                    severity:   'block',
                    action:     'none',
                    shortLabel: 'Wait, then retry',
                    retryAfterAt: Date.now() + HARD_BLOCK_RETRY_WAIT_MS,
                    url:        task.url,
                    evidence:   `${srcName} was hard-blocked by Cloudflare when its results page ${pageNum} was reopened — no interactive challenge to solve.`,
                    suggestion: `Retry unlocks after the wait. Let the IP/session restriction cool down, confirm ${srcName} opens normally in a normal Chrome tab, then choose Retry. Skip continues without these listings.`,
                  }
                  : {
                    code:       'session-blocked',
                    severity:   'block',
                    evidence:   `${srcName} re-served a bot challenge immediately after verification when its results page ${pageNum} was reopened, so the session is blocked and the source was skipped.`,
                    suggestion: `Open ${srcName} in a normal Chrome tab, ensure you are logged in and unblocked, then run the search again.`,
                  };
              }
              sourceSkipped = true;
              break;
            }
            noteDetachedUnrecovered({ qi, pageNum, cause: 'extractor-evaluate', recoveryState });
            break;
          }

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
            const incompleteZipShortfall = sourceId === 'ziprecruiter'
              && Number.isFinite(Number(sourceClaimedTotal))
              && providerSeen.size < Number(sourceClaimedTotal);
            // A clean empty page is a successful durable page checkpoint even
            // though it yielded no rows. Do not checkpoint ZipRecruiter's
            // advertised-total shortfall as complete coverage: that path below
            // remains retryable/unfinished by design.
            if (!incompleteZipShortfall && onPageJobs) {
              await onPageJobs({ sourceId, query: task.query || '', queryIndex: task.queryIndex ?? qi, page: pageNum, jobs: [], terminal: true });
            }
            if (incompleteZipShortfall) {
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
                            action: 'none', shortLabel: 'Wait, then retry',
                            // A hard block clears with time, not with another
                            // instant open; the card counts this wait down.
                            retryAfterAt: Date.now() + HARD_BLOCK_RETRY_WAIT_MS,
                            // The resolver IPC needs a URL; the search page for
                            // this query is what a retry re-opens.
                            url: task.url || safePageUrl(page),
                            evidence: `${srcName} was hard-blocked by Cloudflare while reloading page ${pageNum} after a blank result page.`,
                            suggestion: `Retry unlocks after the wait. Let the IP/session restriction cool down, confirm ${srcName} opens normally in a normal Chrome tab, then choose Retry. Skip continues without these listings.`,
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

          // Every distinct row returned for the issued query is a candidate.
          // Before its detail is opened, the AI page title screen
          // (pageTitleScreen.js, task.options.screenTitles) may skip rows that
          // are clearly a different kind of job; it replaced the old rule of
          // opening every card and screening titles only after the gather.
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
          // This is the fetch-side complement to jobs.js's final platform-cap
          // boundary.  A browser walker must not stop after N raw cards when
          // early cards are outside the exact saved window: those rows will be
          // rejected later and would otherwise leave usable later cards
          // unreachable.  Unknown dates are retained by filterJobsByPostedSince
          // exactly as they are by the central admission pass.
          const selectedPageJobs = selectManualSourcePageJobs(
            newJobs,
            allJobs,
            jobsPerPlatform,
            task.options?.collectionStartTimestamp,
            sourceWindowDropStats,
            task.options?.isOwed,
          );
          // A listing an earlier run already read, or already showed, is not
          // opened again. It is left out of this run's rows altogether: the
          // history step would drop a shown one, and a read one was already
          // judged by the run that read it.
          const alreadyRead = partitionAlreadyReadJobs(selectedPageJobs, task.options?.isAlreadyRead);
          let jobsToExpand = alreadyRead.open;
          // AI title screen before any detail is opened (pageTitleScreen.js).
          // Rows it removes are never opened and never staged; it fails open.
          if (typeof task.options?.screenTitles === 'function' && jobsToExpand.length > 0 && !signal?.aborted) {
            const titleScreen = task.options.screenTitles(jobsToExpand, { query: task.query || '', queryIndex: task.queryIndex ?? qi, page: pageNum });
            if (titleScreen.waitMs > 0) {
              await updateOverlay(page, {
                ...overlayBase,
                pageNum,
                count: allJobs.length,
                status: `Checking ${jobsToExpand.length} titles before opening them…`,
              }).catch(() => {});
              await titleScreen.wait(titleScreen.waitMs);
            }
            const screened = partitionByPageTitleScreen(jobsToExpand, titleScreen);
            if (screened.skipped.length > 0) {
              logger.info(`[BrowserScraper] ${srcName} q${qi + 1} p${pageNum}: title screen skipped ${screened.skipped.length} of ${jobsToExpand.length} card(s) before opening them`);
            }
            jobsToExpand = screened.open;
          }
          sourceAlreadyReadSkipped += alreadyRead.readEarlier + alreadyRead.shownEarlier;
          sourceReadEarlierSkipped += alreadyRead.readEarlier;
          const walkPlan = buildPhysicalCardWalkPlan(extracted, jobsToExpand);
          walkPlan.detailPacing = sourceDetailPacing;
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
            && sourceDetailPartialCycles < DETAIL_BLOCK_MAX_REPROBES
            && sourceDetailReprobeTotal < DETAIL_BLOCK_MAX_TOTAL_REPROBES
            && jobsToExpand.length > 0 && !signal?.aborted) {
            const cooldownRemainingMs = detailBlockCooldownMs(Math.max(sourceDetailReprobes, sourceDetailPartialCycles)) - (Date.now() - sourceDetailBlockAt);
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
            && (Date.now() - sourceDetailBlockAt) >= detailBlockCooldownMs(Math.max(sourceDetailReprobes, sourceDetailPartialCycles))
            && sourceDetailReprobes < DETAIL_BLOCK_MAX_REPROBES
            && sourceDetailPartialCycles < DETAIL_BLOCK_MAX_REPROBES
            && sourceDetailReprobeTotal < DETAIL_BLOCK_MAX_TOTAL_REPROBES
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
                // Never requested: the block's cooldown skipped it.
                descriptionDeferredBy: 'block-cooldown',
              })),
              descError: null,
              descWarning: null,
              expandedCount: 0,
            };
          } else {
            const reprobeOfCode = detailBlockReprobeDue ? sourceDetailBlockCode : null;
            const reprobeWaitedMs = detailBlockReprobeDue ? Date.now() - sourceDetailBlockAt : 0;
            if (detailBlockReprobeDue) {
              // Clear during the bounded probe. Count it only after the scraper
              // confirms that it issued at least one detail attempt; aborting
              // during browser setup/cooldown must not consume a retry.
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
                { ...buildPhysicalCardWalkPlan(extracted, probeJobs), detailPacing: sourceDetailPacing },
              );
              const probeAttempted = Math.max(0, Number(probeResult.attemptedCount) || 0);
              const probePartialProgress = Math.max(0, Number(probeResult.expandedCount) || 0) > 0
                || Math.max(0, Number(probeResult.unavailableDetailDropped) || 0) > 0
                || Math.max(0, Number(probeResult.boardClosedDetailKept) || 0) > 0;
              if (probeAttempted > 0) {
                sourceDetailReprobeTotal += 1;
                if (probePartialProgress) {
                  sourceDetailPartialCycles += 1;
                  sourceDetailPartialCycleTotal += 1;
                } else sourceDetailReprobes += 1;
                logger.info(`[BrowserScraper] ${srcName}: re-probing detail enrichment on page ${pageNum} after ${Math.round(reprobeWaitedMs / 1000)}s blocked by ${reprobeOfCode} (probe ${sourceDetailReprobeTotal}; ${probeAttempted} card attempts; ${probePartialProgress ? `partial cycle ${sourceDetailPartialCycles}/${DETAIL_BLOCK_MAX_REPROBES}` : `no-progress ${sourceDetailReprobes}/${DETAIL_BLOCK_MAX_REPROBES}`})`);
                recordManualScraperTelemetry({
                  phase: 'detail-block-reprobe', sourceId, srcName,
                  queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
                  reason: reprobeOfCode, waitedMs: reprobeWaitedMs,
                  attempt: sourceDetailReprobeTotal, noProgressAttempts: sourceDetailReprobes,
                  partialCycle: probePartialProgress ? sourceDetailPartialCycles : null,
                  maxAttempts: DETAIL_BLOCK_MAX_REPROBES,
                  attempted: probeAttempted,
                });
              } else {
                // No card was tried, so nothing was learned. Charge the wait so
                // the 120s cooldown stays capped on a page with no usable card.
                sourceDetailReprobes += 1;
                logger.info(`[BrowserScraper] ${srcName}: re-probe on page ${pageNum} attempted no cards (no-progress ${sourceDetailReprobes}/${DETAIL_BLOCK_MAX_REPROBES})`);
              }
              if (didDetailBlockReprobeRecover(probeResult)) {
                // The throttle lifted — finish the page normally. A confirmed
                // unavailable listing is terminal evidence too: it proves the
                // request reached the detail endpoint without mistaking an
                // ordinary zero-description miss for recovery.
                const restResult = restJobs.length > 0
                  ? await expandDescriptions(
                    page, restJobs, sourceId, { ...overlayBase, pageNum }, allJobs.length + jobsToExpand.length, signal,
                    { ...buildPhysicalCardWalkPlan(extracted, restJobs), detailPacing: sourceDetailPacing },
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
                sourceDetailPartialCycles = 0;
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
                  attempted: detailResult.attemptedCount,
                });
              } else {
                reprobeFailedThisPage = true;
                if (Math.max(0, Number(detailResult.attemptedCount) || 0) === 0) {
                  sourceDetailBlockCode = reprobeOfCode;
                  sourceDetailBlockAt = Date.now();
                }
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
                const partialRecovery = Math.max(0, Number(detailResult.expandedCount) || 0) > 0
                  || Math.max(0, Number(detailResult.unavailableDetailDropped) || 0) > 0
                  || Math.max(0, Number(detailResult.boardClosedDetailKept) || 0) > 0;
                recordManualScraperTelemetry({
                  phase: partialRecovery ? 'detail-block-reprobe-partial' : 'detail-block-reprobe-failed', sourceId, srcName,
                  queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
                  reason: detailResult.descWarning?.code || reprobeOfCode,
                  waitedMs: reprobeWaitedMs,
                  attempt: sourceDetailReprobeTotal, noProgressAttempts: sourceDetailReprobes,
                  partialCycles: sourceDetailPartialCycles, partialCyclesTotal: sourceDetailPartialCycleTotal,
                  maxAttempts: DETAIL_BLOCK_MAX_REPROBES,
                  expanded: detailResult.expandedCount,
                  unavailableDetailDropped: detailResult.unavailableDetailDropped,
                  boardClosedDetailKept: detailResult.boardClosedDetailKept,
                  attempted: detailResult.attemptedCount,
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
            boardClosedDetailKept = 0,
          } = detailResult;
          sourceUnavailableDetailDropped += Math.max(0, Number(unavailableDetailDropped) || 0);
          sourceBoardClosedDetailKept += Math.max(0, Number(boardClosedDetailKept) || 0);
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

          // Glassdoor's as-linked job-page address only serves this scrape's
          // description route; rows leave the scraper without it.
          const savedPageRows = sourceId === 'glassdoor' ? enhanced.map(withoutGlassdoorJobPageUrl) : enhanced;
          allJobs.push(...savedPageRows);

          // Per-page recovery flush is a durability boundary: checkpoint even
          // a duplicate-only page, and fail this source if it cannot be saved.
          if (onPageJobs) await onPageJobs({ sourceId, query: task.query || '', queryIndex: task.queryIndex ?? qi, page: pageNum, jobs: savedPageRows });

          if (descError) {
            if (!sourceSiteChangedWarning) sourceSiteChangedWarning = descError;
            detailEnrichmentFailed = true;
            earlyExit = true;
            break;
          }
          // The site kept serving its check again after solved attempts while
          // listings were being opened. Walking on would open no further
          // listing (each new check is skipped for the rest of this run), yet
          // would finish the platform as complete: 24-hour cooldown, the
          // remaining queries never searched. End the platform as blocked
          // instead. This page's rows are already saved above; the platform
          // stays due and its unfinished queries are resumed by the next run.
          if (sourceRefusedSolvedChecks(sourceId)) {
            if (!sourceSiteChangedWarning || sourceSiteChangedWarning.severity !== 'block') {
              sourceSiteChangedWarning = {
                code:       'session-blocked',
                severity:   'block',
                url:        task.url,
                evidence:   `${srcName} kept serving its verification check while listings were being opened.`,
                suggestion: `Run ${srcName} again later.`,
              };
            }
            sourceSkipped = true;
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
          // Glassdoor: a block from its PANEL fallback stops only the panel part
          // while its job-page route is still on AND reading rows
          // (glassdoorJobPage.js keeps that panel-only block and its
          // cooldown/re-probe). The source-wide block below, which waits out
          // the cooldown, is armed once the job page is off or read nothing in
          // this batch (glassdoorPanelBlockIsSourceWide).
          const glassdoorPanelOnlyBlock = Boolean(detailResult?.descriptionRoute)
            && DETAIL_BLOCK_WARNING_CODES.includes(descWarning?.code)
            && !glassdoorPanelBlockIsSourceWide(sourceDetailPacing);
          if (glassdoorPanelOnlyBlock) {
            if (sourceDetailFirstBlockPg == null) sourceDetailFirstBlockPg = pageNum;
            if (sourceDetailFirstBlockQuery == null) sourceDetailFirstBlockQuery = task.query || null;
            if (sourceDetailFirstBlockQueryIndex == null) sourceDetailFirstBlockQueryIndex = qi;
            sourceDetailBlockCount += 1;
            recordManualScraperTelemetry({
              phase: 'detail-panel-block-only', sourceId, srcName,
              queryIndex: qi + 1, queryTotal: sourceTasks.length, pageNum,
              reason: descWarning.code,
            }, { updateActive: false });
          } else if (DETAIL_BLOCK_WARNING_CODES.includes(descWarning?.code)) {
            // The panel-only copy (if any) is superseded by the source block.
            if (detailResult?.descriptionRoute) takeGlassdoorPanelBlockForSource(sourceDetailPacing);
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
          // Glassdoor's job-page route turned off, or read nothing, while its
          // panel was already blocked: no route is reading, so the panel-only
          // block becomes the source-wide one (keeping its original clock).
          if (detailResult?.descriptionRoute && !sourceDetailBlockCode) {
            const handover = takeGlassdoorPanelBlockForSource(sourceDetailPacing);
            if (handover) {
              if (sourceDetailBlockPage == null) sourceDetailBlockPage = pageNum;
              sourceDetailBlockCode = handover.code;
              sourceDetailBlockAt = handover.at;
            }
          }

          await updateOverlay(page, {
            ...overlayBase,
            count:  allJobs.length,
            status: 'Looking for next page…',
          });

          logger.info(`[BrowserScraper] ${srcName} page ${pageNum}: ${enhanced.length} new jobs (${allJobs.length} total)`);

          if (allJobs.length >= jobsPerPlatform) {
            // Same rule as the page backstop: at the Auto ceiling this is our
            // own cap, so it warns and files a guard instead of ending silently.
            if (jobsPerPlatform >= UNLIMITED_JOB_BACKSTOP) {
              const jobBackstopDetail = `Stopped at the ${jobsPerPlatform}-job backstop (Auto) on page ${pageNum} with ${allJobs.length} rows`;
              logger.warn(`[BrowserScraper] ${srcName} ${jobBackstopDetail}`);
              appendWalkGuard(walkGuards, {
                kind: 'job-backstop', source: sourceId, query: qi + 1,
                page: pageNum, pages: maxPages, newRows: allJobs.length, detail: jobBackstopDetail,
              });
            } else {
              logger.info(`[BrowserScraper] ${srcName} hit jobsPerPlatform (${jobsPerPlatform}) — stopping source`);
            }
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
            const stopGuard = stopDecision.guard && typeof stopDecision.guard === 'object' && !Array.isArray(stopDecision.guard)
              ? stopDecision.guard
              : null;
            if (stopGuard) {
              // A stop the pager decided for us (makeJobPageStop's trickle
              // guard) ends the walk early on purpose, so it is a warning with a
              // guard, not another info line lost among the page log.
              appendWalkGuard(walkGuards, {
                ...stopGuard,
                kind: stopGuard.kind || 'pager-trickle',
                source: sourceId,
                query: qi + 1,
                page: stopGuard.page ?? pageNum,
                pages: stopGuard.pages ?? maxPages,
                newRows: stopGuard.newRows ?? allJobs.length,
              });
              logger.warn(`[BrowserScraper] ${srcName} q${qi + 1}: ${stopGuard.detail || stopDecision.detail || stopDecision.reason}`);
            } else {
              logger.info(`[BrowserScraper] ${srcName} q${qi + 1}: ${stopDecision.detail || stopDecision.reason}`);
            }
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
            if (onPageJobs) await onPageJobs({ sourceId, query: task.query || '', queryIndex: task.queryIndex ?? qi, page: pageNum, jobs: [], terminal: true });
            break;
          }

          if (signal?.aborted) break;
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
            // No pagination control is a verified natural end. An unhandled
            // enabled control remains incomplete and must be replayed.
            if (!nextPage.unhandled && !directAdvance && !hitProviderTotalShortfall && !hitPageTurnStalled && onPageJobs) {
              await onPageJobs({ sourceId, query: task.query || '', queryIndex: task.queryIndex ?? qi, page: pageNum, jobs: [], terminal: true });
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
              if (onPageJobs) await onPageJobs({ sourceId, query: task.query || '', queryIndex: task.queryIndex ?? qi, page: pageNum, jobs: [], terminal: true });
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
            // A followed pager link replaces the document. The URL commits
            // before the new HTML has finished parsing, so wait for parsing to
            // finish before readiness and extraction read its server-rendered data.
            if (HARD_NAVIGATION_PAGER_SOURCES.has(sourceId)) {
              await page.waitForFunction(() => document.readyState !== 'loading', { timeout: CONTENT_TIMEOUT_MS }).catch(() => {});
            }
          }

          // Wait for new content to appear on the paginated page
          let pagedReady = await waitForReady(page, sourceId, overlayBase, signal, task.url);
          if (pagedReady === 'abort' || signal?.aborted) { earlyExit = true; break; }
          // The page object died during the page turn. Reading its URL or
          // extracting from it would only report stale facts (a ZipRecruiter
          // direct-page check would call it the provider's result window), so
          // reopen it once for this query, or stop this source honestly.
          if (pagedReady === 'page-detached') {
            const recoveryUrl = pageRecoveryUsed ? null : detachedListRecoveryUrl({
              deadPageUrl: safePageUrl(page),
              taskUrl: task.url,
              scrollSource: SCROLL_SOURCES.has(sourceId),
              urlPaginated,
              loadMoreRowsRead: loadMorePrevCount,
              onFirstPage: false,
            });
            let recoveryState = pageRecoveryUsed ? 'already-used' : 'position-not-reproducible';
            if (recoveryUrl) {
              pageRecoveryUsed = true;
              recoveryState = await recoverDetachedListPage({
                url: recoveryUrl, overlayBase, qi, pageNum, cause: 'page-turn-readiness',
              });
            }
            if (recoveryState === 'abort' || signal?.aborted) { earlyExit = true; break; }
            if (!['ok', 'recovered', 'hard-block', 'skip'].includes(recoveryState)) {
              noteDetachedUnrecovered({ qi, pageNum, cause: 'page-turn-readiness', recoveryState });
              break;
            }
            // 'recovered' here returned the fresh page to recoveryUrl (this page),
            // not to page 1, so it must not take the back-to-page-1 branch below.
            pagedReady = recoveryState === 'recovered' ? 'ok' : recoveryState;
          }
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
                    shortLabel: 'Wait, then retry',
                    // Instant retries re-open the same blocked page; the card
                    // counts this wait down and then offers a real Retry.
                    retryAfterAt: Date.now() + HARD_BLOCK_RETRY_WAIT_MS,
                    // The resolver IPC needs a URL to re-open; this query's
                    // search page is the retry target.
                    url:        task.url,
                    evidence:   `${srcName} was hard-blocked by Cloudflare on page ${pageNum} — no interactive challenge to solve.`,
                    suggestion: `Retry unlocks after the wait. Let the IP/session restriction cool down, confirm ${srcName} opens normally in a normal Chrome tab, then choose Retry. Skip continues without these listings.`,
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

      // The browser going away used to end the source with no warning and the
      // generic early-exit reason, so a walk that lost most of its queries was
      // recorded as a clean finish and its date bookmark advanced. Make it a
      // blocking warning: the rows gathered so far are kept, and the source
      // stays unfinished until it is run again or skipped.
      // A list page whose object could no longer be read, and could not be
      // replaced, takes the same path: rows kept, unread queries named, the
      // source left retryable. Its evidence says what was observed — the page
      // stopped responding — not that the window closed.
      const pageUnreadable = !!pageDetachedUnrecovered && !browserClosedUnexpectedly && !signal?.aborted;
      const browserClosed = browserClosedUnexpectedly && !signal?.aborted;
      if ((browserClosed || pageUnreadable) && !sourceSiteChangedWarning) {
        const unreadQueries = Math.max(0, sourceTasks.length - executedQueries.length);
        sourceSiteChangedWarning = pageUnreadable
          ? pageUnreadableWarning({
            srcName, unreadQueries, queryTotal: sourceTasks.length,
            queryIndex: pageDetachedUnrecovered.queryIndex, pageNum: pageDetachedUnrecovered.pageNum,
          })
          : browserClosedWarning({ srcName, unreadQueries, queryTotal: sourceTasks.length });
        logger.warn(`[BrowserScraper] ${sourceSiteChangedWarning.evidence}`);
      }

      const stopReason = resolveManualSourceStopReason({
        earlyExit,
        aborted: !!signal?.aborted,
        browserClosed,
        pageUnreadable,
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
      // The source-wide description retry budget is spent: re-probing stops for
      // the rest of this source, later rows keep exactly the deferred marking
      // the per-episode cap gives them, and the run says so once.
      // Only when the block was still on at the end: a sixth probe that
      // recovered did not give up on anything.
      if (sourceDetailReprobeTotal >= DETAIL_BLOCK_MAX_TOTAL_REPROBES && sourceDetailBlockCode) {
        const keptDescriptionless = Math.max(0, sourceDetailUnenriched || 0);
        const retryCapDetail = keptDescriptionless > 0
          ? `Description retries gave up after ${DETAIL_BLOCK_MAX_TOTAL_REPROBES} tries; ${keptDescriptionless} rows kept without descriptions`
          : `Description retries gave up after ${DETAIL_BLOCK_MAX_TOTAL_REPROBES} tries`;
        logger.warn(`[BrowserScraper] ${srcName}: ${retryCapDetail}`);
        appendWalkGuard(walkGuards, {
          kind: 'detail-retry-cap', source: sourceId, query: null,
          page: null, pages: null, newRows: keptDescriptionless || null, detail: retryCapDetail,
        });
      }
      const result = {
        id:          `${sourceId}-0`,
        sourceId,
        success:     true,
        data:        allJobs,
        pagesWalked: sourcePagesWalked,
        stopReason,
        // Fixed-shape records of the stops this walker chose for itself (page /
        // job backstops, a trickle pager, a stalled reveal, an exhausted retry
        // budget). jobs.js turns them into a visible warning; counts only.
        walkGuards:  walkGuards.slice(0, WALK_GUARD_MAX),
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
        // Every list caller files a wait that ended as 'skip' under
        // 'session-blocked'. When the wait ended because the site kept serving
        // its check again after solved attempts, say that and when to retry.
        warning:     (sourceSiteChangedWarning?.code === 'session-blocked' && sourceRefusedSolvedChecks(sourceId)
          ? {
            ...sourceSiteChangedWarning,
            evidence: `${srcName} ${describeRefusedChecks(sourceId)}, so it could not be passed from the scraper's browser. Every listing collected before that was kept and the rest of this source was skipped.`,
            suggestion: `The site's refusal usually clears within about an hour of the last attempt. Retry unlocks after that wait; Skip continues now with the listings already collected, and the next search resumes ${srcName} at its unfinished queries.`,
            // An earlier retry is refused again and renews the site's refusal,
            // so the card counts this wait down before it offers Retry.
            refusedSolvedChecks: true,
            shortLabel: 'Wait, then retry',
            retryAfterAt: Date.now() + CHALLENGE_LOOP_MEMORY_MS,
          }
          : sourceSiteChangedWarning) || providerTotalShortfallWarning || null,
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
            partialCycles: sourceDetailPartialCycles,
            partialCyclesTotal: sourceDetailPartialCycleTotal,
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
        // Dated cards this source's page selection dropped because they were
        // outside the collection window. jobs.js feeds this to the health check
        // as rows that HAD a posted date.
        windowDropped: Math.max(0, Number(sourceWindowDropStats.windowDropped) || 0),
        alreadyReadSkipped: sourceAlreadyReadSkipped,
        readEarlierSkipped: sourceReadEarlierSkipped,
        unavailableDetailDropped: sourceUnavailableDetailDropped,
        // Rows an aggregator board reported closed but that stay in `data`, flagged
        // for the official-posting resolver. NOT part of unavailableDetailDropped.
        boardClosedDetailKept: sourceBoardClosedDetailKept,
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
        ...(sourceId === 'google' && manualScraperTelemetry.googleApplyCapture ? { googleApplyCapture: { ...manualScraperTelemetry.googleApplyCapture } } : {}),
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
      // Each source runs in its own Chrome, so one that died (or whose results
      // page stopped responding) says nothing about the next. Clear the stop it
      // raised; a cancel still ends the run.
      if (browserClosed || pageUnreadable) earlyExit = false;
    }
  } finally {
    await teardownCurrent();
    clearManualScraperTelemetry(signal?.aborted ? 'aborted' : 'finished');
    // Drop the renderer sink with the run that installed it. A later direct
    // caller (or a test) that passes no sink must not keep emitting into the
    // previous run's node, and an in-flight marker must never outlive the
    // await it described.
    activitySinkState.sink = null;
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
