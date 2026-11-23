/**
 * Detail-navigation description walk (ZipRecruiter, and Glassdoor's job-page
 * route — see glassdoorJobPage.js for its pacing, 429 ladder and challenge rule).
 */
import { CONTENT_POLL_MS, waitForAbortableDelay } from './walkRules.js';
import {
  ZIPRECRUITER_APPCAST_RESTRICTED_RECOVERY_RETRIES,
  ZIPRECRUITER_429_RETRIES,
  ZIPRECRUITER_RATE_LIMITED_GAP_MS,
  ZIPRECRUITER_DETAIL_ERROR_SHELL_RETRIES,
  ZIPRECRUITER_MONEY_SRC,
  captureZipRecruiterListingLiveness,
  descriptionDetailMissWarning,
  formatJsonLdSalary,
  inertDescriptionText,
  isAppcastTemporaryRestriction,
  isDetachedDetailFrameError,
  isOffSiteZipRecruiterDetail,
  isUnavailableDetailPage,
  isZipRecruiterClosedDetailRedirect,
  isZipRecruiterDetailErrorShell,
  mergeDescriptionDetailMissWarning,
  mergeExpandedJobDetail,
  normalizeDetailNavigationUrl,
  pinGlassdoorDetailUrlToListHost,
  reconcileZipRecruiterDomSalary,
  shouldNavigateForDescription,
  unavailableDetailDisposition,
  zipRecruiterAppcastRestrictionBackoffMs,
  zipRecruiterDetailErrorShellBackoffMs,
  zipRecruiterDetailGapMs,
  zipRecruiterRetryAfterMs,
} from './detailParsing.js';
import { OVERLAY_SCRIPT, applyStealthMask, injectOverlay, updateOverlay, waitIfPaused, safePageUrl, scrapeFingerprintPolicy } from './scrapeBrowser.js';
import { measurementPacingOff } from '../scrapeMeasurement.js';
import {
  GLASSDOOR_JOB_PAGE_RATE_LIMITED_GAP_MS,
  GLASSDOOR_JOB_PAGE_SETTLE_MS,
  glassdoorJobPageGapMs,
  glassdoorJobPageNeedsReprobe,
  glassdoorJobPageSalary,
  glassdoorJobPageSignalCodes,
  formatGlassdoorJobPageSignalCodes,
  glassdoorJobPageState,
  glassdoorJobPageVerdict,
  noteGlassdoorJobPageUnreadable,
  noteGlassdoorJobPageChallenge,
  noteGlassdoorJobPageRateLimit,
} from './glassdoorJobPage.js';
import {
  formatWaitDuration,
  notePaceDetailOpened,
  notePaceSpacingWait,
  recordActivityBeat,
  recordManualScraperTelemetry,
} from './scrapeTelemetry.js';
import {
  CHALLENGE_ACTIVITY_BEAT_MS,
  CHALLENGE_ESCALATE_MS,
  CHALLENGE_INTERSTITIAL_MAX_CHARS,
  challengeHeartbeatIntervalMs,
  detectChallengePage,
  formatChallengeEvidence,
  getChallengeSignals,
  recoverFromChallengeHomeLanding,
  resolveManualDetailChallengeDisposition,
  waitForReady,
} from './pageReadiness.js';
import { challengeInputVerdict, createChallengeInputProbe, describeChallengeInput } from '../challengeInputProbe.js';
import { logger } from '../../../logger.js';
import { POSTED_DATE_PATTERN } from '../../jobDateFilter.js';
import { linkDetailOverlayPages, overlayTabLayout } from '../scraperOverlay.js';
import { createBackgroundScrapePage } from '../backgroundScrapeBrowser.js';
import { humanDelay } from '../../../utils/humanDelay.js';
import { HARD_BLOCK_RETRY_WAIT_MS } from '../../../../src/utils/jobSourceWarningPolicy.js';
import { finalizeListingEvidence } from '../../listingLiveness.js';
import { recordListingEvidence } from '../../listingLivenessStore.js';

        const DETAIL_DESCRIPTION_WAIT_MS = 6000;      // bounded client-hydration recovery for navigation detail pages
// Cloudflare can append its challenge iframe/Turnstile container just after
// DOMContentLoaded. Do not decide a fresh detail page is terminal before that
// injection window has passed.
const DETAIL_CHALLENGE_SETTLE_MS = 2_500;
// A text-only terminal detail page is normally a genuine stop, but it must be
// shown briefly before we close it: that makes the outcome legible to the user
// and catches a late Turnstile/iframe injection that the first settle missed.
const DETAIL_TERMINAL_PRESENT_MS = 5_000;

// Navigation-based expansion: navigate to each job's individual page and extract
// the description there. Used for ZipRecruiter where the extractor
// reads jobs from JSON (all upfront) but React's virtual list may never render
// the corresponding card DOM elements — making card-click expansion unreliable.
export async function expandDescriptionsByNavigation(page, jobs, sourceId, overlayBase, totalSoFar, signal = null, walkPlan = null, runtime = null, cfg) {
  const enhanced = [...jobs];
  // Jobs collected before this batch starts — used to increment the overlay counter
  // one-by-one (baseCount + i + 1) rather than jumping to totalSoFar immediately.
  const baseCount = totalSoFar - jobs.length;
  let descWarning = null;
  // The caller retains upstream candidate identities separately. Keep the
  // subset retired after a confirmed unavailable detail page here, so reporting
  // can say what was traversed versus what remained usable.
  let unavailableDetailDropped = 0;
  // Aggregator-board "gone" verdicts are NOT retired here: the row is kept with a
  // boardClosed marker so the official-posting resolver can look for the
  // employer's own posting. Counted apart so unavailableDetailDropped stays the
  // number of rows actually removed.
  let boardClosedDetailKept = 0;
  const listUrl = page.url();
  // Glassdoor's job-page route (glassdoorJobPage.js). Every row the job page
  // does not settle stays 'pending' and goes to the list-card panel fallback;
  // 'expanded' = description read here, 'closed' = closed-listing rules applied.
  const glassdoorJobPage = sourceId === 'glassdoor';
  const rowOutcomes = new Array(enhanced.length).fill('pending');
  // `silentMisses`: rows whose navigation/extraction failed and that went to the
  // panel without a 'desc-miss' anomaly (the panel may still recover them).
  const jobPageRoute = { stopReason: 'none', opened: 0, silentMisses: 0 };
  const glassdoorRouteState = glassdoorJobPage ? glassdoorJobPageState(walkPlan?.detailPacing) : null;

  // Open a dedicated background page for detail fetches so the main list page
  // stays put — eliminates the visual ping-pong between search results and
  // individual job pages. Falls back to the main page if newPage() fails.
  let detailPage = null;
  let unlinkDetailOverlays = () => {};
  const createDetailPage = async () => {
    // runtime.createBackgroundPage is a fake-page test seam; production passes no runtime.
    const nextPage = await (runtime?.createBackgroundPage || createBackgroundScrapePage)(page.browser(), { width: 1280, height: 900 });
    // Same fingerprint as the list tab it came from: masked only when the
    // source's policy masks its list tab (scrapeFingerprintPolicy).
    if (!scrapeFingerprintPolicy(sourceId).plain) await applyStealthMask(nextPage).catch(() => {});
    // Never copy the list tab's user agent onto this tab. The detail tab is in
    // the same browser, so it already has that UA — and setUserAgent() with a
    // string alone drops User-Agent Client Hints (no sec-ch-ua headers, empty
    // navigator.userAgentData.brands), which real Chrome never does. That made
    // every detail page look like a bot; on ZipRecruiter 27 of 30 checks in one
    // run hit this tab, not the list tab.
    const vp = page.viewport();
    if (vp) await nextPage.setViewport(vp).catch(() => {});
    await nextPage.evaluateOnNewDocument(OVERLAY_SCRIPT).catch(() => {});
    await injectOverlay(nextPage);
    unlinkDetailOverlays();
    unlinkDetailOverlays = linkDetailOverlayPages(page, nextPage);
    await updateOverlay(page, {
      ...overlayBase, count: baseCount,
      status: `Fetching descriptions… 0/${enhanced.length}`,
    });
    return nextPage;
  };
  try {
    detailPage = await createDetailPage();
  } catch {
    detailPage = null;
  }
  // Glassdoor's panel fallback needs the list page intact, so its job pages
  // are only ever opened in the separate detail tab — never on the list page.
  if (glassdoorJobPage && !detailPage) {
    // Recorded so a route that never opens a page says why (see 'no-reads').
    jobPageRoute.detailTabFailed = true;
    logger.info(`[BrowserScraper] ${overlayBase.srcName}: could not open the job-page tab; this batch goes to the panel`);
    return {
      jobs: enhanced, rows: enhanced, rowOutcomes, jobPageRoute,
      descError: null, descWarning: null, expandedCount: 0,
      unavailableDetailDropped: 0, boardClosedDetailKept: 0,
    };
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
  const detailPacing = walkPlan?.detailPacing || {};
  let lastDetailNavigationAt = detailPacing.lastNavigationAt || 0;
  let solvedDetailChallenges = detailPacing.solvedChallenges || 0;
  // Raised for the rest of this source's walk after its first 429.
  let rateLimitedGapMs = detailPacing.rateLimitedGapMs || 0;
  let keepDetailForeground = false;
  let zipRecruiter429Retries = 0;
  let zipRecruiterAppcastRestrictionRetries = 0;
  // `i--; continue;` re-enters the loop body, so a budget counter declared
  // INSIDE the loop is reset on every retry and can never be exhausted. Keep
  // both outside and re-arm them when the row index actually changes.
  let errorShellRetryIndex = -1;
  let errorShellRetries = 0;
  // Set once the walk's first Glassdoor job page was opened: only that page may
  // be a warm-up 403 (see the warm-up rule below).
  let glassdoorWarmupUsed = false;
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
      // page loaded successfully. Only the navigation target is rewritten;
      // the row keeps its own URL. DESC_CONFIGS.glassdoor sets this flag, and
      // descriptionNavigationDecision then refuses anything not on that host.
      // Glassdoor: open the job page exactly as Glassdoor linked it when the
      // extractor kept that address (often fr.glassdoor.ca), never pinned.
      const glassdoorAsLinked = glassdoorJobPage && typeof job.glassdoorJobPageUrl === 'string'
        ? job.glassdoorJobPageUrl.trim() : '';
      if (glassdoorAsLinked) {
        viewUrl = glassdoorAsLinked;
      } else if (cfg.pinToListHost) {
        viewUrl = pinGlassdoorDetailUrlToListHost(viewUrl, listUrl);
      }
      viewUrl = normalizeDetailNavigationUrl(viewUrl);

      if (!shouldNavigateForDescription(sourceId, viewUrl, { listUrl })) {
        const title = (job.title || job.url || '?').slice(0, 65);
        logger.info(`[BrowserScraper] ${overlayBase.srcName} skipped unsupported detail URL while enriching "${title}"`);
        // Glassdoor: the row goes to the panel, which may still recover it.
        if (glassdoorJobPage) {
          jobPageRoute.silentMisses += 1;
          continue;
        }
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

      const interactionPage = keepDetailForeground ? fetchPage : page;
      const navPause = await waitIfPaused(interactionPage, signal);
      if (navPause === 'abort') break;

      const detailGapMs = sourceId === 'ziprecruiter' && !measurementPacingOff(sourceId)
        ? Math.max(zipRecruiterDetailGapMs(solvedDetailChallenges), rateLimitedGapMs)
        : glassdoorJobPage ? glassdoorJobPageGapMs(rateLimitedGapMs) : 0;
      // Pace telemetry (diagnostics only): the deliberate spacing wait is one of
      // the three places a slow run's wall time hides. This is a timestamp only;
      // the wait below is untouched.
      const spacingWaitStartedAt = Date.now();
      if (detailGapMs > 0 && lastDetailNavigationAt) {
        const waitMs = detailGapMs - (Date.now() - lastDetailNavigationAt);
        if (waitMs > 0 && !(await (runtime?.delay || waitForAbortableDelay)(waitMs, signal))) break;
      }

      await updateOverlay(interactionPage, {
        ...overlayBase,
        count:  baseCount + i + 1,
        status: `Fetching descriptions… ${i + 1}/${enhanced.length}`,
      });
      // Measured from the timestamp taken before the wait; recorded here (after
      // the overlay paint) so no telemetry call sits between the wait and the
      // navigation. Fail-soft, and an aborted wait breaks out above uncounted.
      notePaceSpacingWait(sourceId, {
        srcName: overlayBase.srcName,
        waitMs: Date.now() - spacingWaitStartedAt,
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
        const detailOpenStartedAt = Date.now();
        try {
          if (detailGapMs > 0) lastDetailNavigationAt = Date.now();
          // Glassdoor's job pages were measured with the list page as Referer.
          navigationResponse = await fetchPage.goto(viewUrl, {
            waitUntil: 'domcontentloaded', timeout: 12000,
            ...(glassdoorJobPage ? { referer: listUrl } : {}),
          });
        } catch (error) {
          navigationError = error;
        }
        // Pace telemetry (diagnostics only): counts the detail page opened and
        // adds its load time — a failed goto still consumed that time, so it is
        // recorded here rather than only on success. Fail-soft.
        if (glassdoorJobPage) jobPageRoute.opened += 1;
        notePaceDetailOpened(sourceId, {
          srcName: overlayBase.srcName,
          queryIndex: overlayBase?.queryIndex,
          queryTotal: overlayBase?.queryTotal,
          loadMs: Date.now() - detailOpenStartedAt,
        });
        if (keepDetailForeground) {
          await injectOverlay(fetchPage).catch(() => {});
          await updateOverlay(fetchPage, {
            ...overlayBase, count: baseCount + i + 1,
            status: `Fetching descriptions… ${i + 1}/${enhanced.length}`,
          }).catch(() => {});
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
          if (glassdoorJobPage) {
            jobPageRoute.silentMisses += 1;
            continue;
          }
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
        // Glassdoor never waits on a challenge: its verdict below acts at once.
        if (challengeSignals?.isChallenge && !glassdoorJobPage) {
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
          return {
            isRateLimited,
            workdayPostingAvailable,
            finalUrl: location.href,
            visibleText: document.body?.innerText || '',
          };
        }).catch(() => ({
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
          httpStatus: navigationStatus,
          zipRecruiterClosedJobRedirect: isZipRecruiterClosedDetailRedirect(rawPageInfo.finalUrl),
        };

        // Glassdoor job page: a 429, an unreadable page or any challenge ends
        // this route here, with no retry, no wait for a person and no
        // foreground. The rows from this one on stay 'pending' for the panel;
        // the detail tab closes in finally. A 429/Security page, an unreadable
        // probe or a page with no JobPosting description is probed ONCE more
        // after a short settle, because Cloudflare can inject its widget after
        // DOMContentLoaded; the verdict is taken from that second read.
        if (glassdoorJobPage) {
          const readJobPostingDescription = () => fetchPage.evaluate(() => {
            const isPosting = (t) => (Array.isArray(t) ? t.includes('JobPosting') : t === 'JobPosting');
            for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
              try {
                const parsed = JSON.parse(script.textContent);
                for (const root of (Array.isArray(parsed) ? parsed : [parsed])) {
                  const nodes = [root, ...(Array.isArray(root?.['@graph']) ? root['@graph'] : [])];
                  if (nodes.some(node => node && isPosting(node['@type']) && String(node.description || '').trim())) return true;
                }
              } catch { /* malformed JSON-LD */ }
            }
            return false;
          }).catch(() => null);
          let hasJobPostingDescription = await readJobPostingDescription();
          let verdict = glassdoorJobPageVerdict({ httpStatus: navigationStatus, signals: challengeSignals, hasJobPostingDescription });
          if (verdict !== 'challenge'
            && (glassdoorJobPageNeedsReprobe({ httpStatus: navigationStatus, signals: challengeSignals }) || hasJobPostingDescription !== true)) {
            if (!await (runtime?.delay || waitForAbortableDelay)(GLASSDOOR_JOB_PAGE_SETTLE_MS, signal)) break;
            challengeSignals = await getChallengeSignals(fetchPage);
            hasJobPostingDescription = await readJobPostingDescription();
            verdict = glassdoorJobPageVerdict({ httpStatus: navigationStatus, signals: challengeSignals, hasJobPostingDescription });
          }
          // A page this route reads as 'ok' never enters the generic detail
          // challenge branch below (its foreground solve wait is not for
          // Glassdoor): the posting is read, or the row goes to the panel.
          if (verdict === 'ok') detailChallengeAction = 'none';
          // The first job page a browser session opens comes back HTTP 403
          // (empty, or a "Security | Glassdoor" page) and the next ones load
          // normally — a first-visit handshake, not a block. Measured live
          // 2026-11-20/21 on every fresh session: 403, then 200 with full
          // JSON-LD. Treating that 403 as a challenge switched job pages off
          // on page one of every run. So the first 403 of this walk is a
          // warm-up: retry the same row once and keep the route on. A real
          // Cloudflare challenge (Turnstile, its frame or shell, "Just a
          // moment") is never a warm-up.
          const strictCloudflareCheck = !!(challengeSignals?.hasCloudflareTurnstileWidget
            || challengeSignals?.hasCloudflareChallengeFrame
            || challengeSignals?.hasChallengeShell
            || /^just a moment/i.test(String(challengeSignals?.title || '')));
          const isFirstJobPageOfWalk = !glassdoorWarmupUsed;
          glassdoorWarmupUsed = true;
          if ((verdict !== 'ok' || hasJobPostingDescription !== true) && isFirstJobPageOfWalk && navigationStatus === 403 && !strictCloudflareCheck) {
            logger.info(`[BrowserScraper] ${overlayBase.srcName} first job page of this walk answered 403 (warm-up); retrying it once with job pages still on`);
            recordManualScraperTelemetry({
              phase: 'detail-job-page-warmup', sourceId, srcName: overlayBase.srcName,
              status: navigationStatus, verdict, itemIndex: i + 1, itemTotal: enhanced.length,
            }, { updateActive: false });
            i--;
            continue;
          }
          if (verdict !== 'ok') {
            const signalCodes = glassdoorJobPageSignalCodes({ httpStatus: navigationStatus, signals: challengeSignals, hasJobPostingDescription });
            logger.info(`[BrowserScraper] ${overlayBase.srcName} job-page stop signals: verdict=${verdict} ${formatGlassdoorJobPageSignalCodes(signalCodes)}`);
            const ladder = verdict === 'rate-limited'
              ? noteGlassdoorJobPageRateLimit(glassdoorRouteState)
              : verdict === 'unreadable'
                ? noteGlassdoorJobPageUnreadable(glassdoorRouteState)
                : noteGlassdoorJobPageChallenge(glassdoorRouteState);
            if (verdict === 'rate-limited') {
              rateLimitedGapMs = Math.max(rateLimitedGapMs, GLASSDOOR_JOB_PAGE_RATE_LIMITED_GAP_MS);
            }
            jobPageRoute.stopReason = ladder.stopReason;
            const handedToPanel = enhanced.length - i;
            logger.warn(`[BrowserScraper] ${overlayBase.srcName} job page ${verdict === 'rate-limited' ? 'rate-limited' : verdict === 'unreadable' ? 'could not be read twice' : 'showed a check'} (${ladder.stopReason}); ${handedToPanel} row(s) go to the list-card panel${glassdoorRouteState.off ? '; job pages off for the rest of this source run' : `; later batches wait ${Math.round(glassdoorJobPageGapMs(rateLimitedGapMs) / 1000)}s between job pages`}`);
            recordManualScraperTelemetry({
              phase: 'detail-job-page-route-stop', sourceId, srcName: overlayBase.srcName,
              reason: ladder.stopReason, status: navigationStatus,
              challengeReason: verdict === 'challenge' ? (challengeSignals?.reason || null) : null,
              itemIndex: i + 1, itemTotal: enhanced.length, handedToPanel,
              routeOff: !!glassdoorRouteState.off,
              verdict, signals: signalCodes,
            }, { updateActive: false });
            break;
          }
        }

        // Appcast shows its restriction either as page text or inside
        // DataDome's block frame. The frame can arrive after the first probe,
        // so this is asked again after a foreground wait ends in a hard block.
        const isAppcastRestricted = (signals) => sourceId === 'ziprecruiter'
          && isAppcastTemporaryRestriction({
            url: signals?.url || rawPageInfo.finalUrl || fetchPage.url(),
            visibleText: rawPageInfo.visibleText,
            dataDomeBlocked: !!signals?.hasDataDomeBlockFrame,
          });
        // 'retry' re-opens this row after the list page reloaded; 'stop' ends
        // the detail pass.
        const recoverFromAppcastRestriction = async () => {
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
              unlinkDetailOverlays();
              await detailPage.close().catch(() => {});
              detailPage = null;
              fetchPage = page;
            }
            if (!await waitForAbortableDelay(waitMs, signal)) return 'stop';
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 12_000 }).catch(() => {});
            await injectOverlay(page).catch(() => {});
            const resultsReady = await waitForReady(page, sourceId, overlayBase, signal, listUrl);
            if (!['ok', 'recovered'].includes(resultsReady)) return 'stop';
            try {
              detailPage = await createDetailPage();
              fetchPage = detailPage;
            } catch {
              detailPage = null;
              fetchPage = page;
            }
            return 'retry';
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
          return 'stop';
        };
        if (isAppcastRestricted(challengeSignals)) {
          if (await recoverFromAppcastRestriction() === 'retry') {
            i--; // retry the exact outbound detail navigation after list-page refresh
            continue;
          }
          break;
        }

        // Another site's rate limit after a redirect is not ZipRecruiter's: it
        // must not slow or stop this pass (the row is simply left as listed).
        if (sourceId === 'ziprecruiter' && (navigationStatus === 429 || pageInfo.isRateLimited)
          && isOffSiteZipRecruiterDetail(sourceId, rawPageInfo.finalUrl || fetchPage.url())) {
          recordManualScraperTelemetry({
            phase: 'desc-miss', srcName: overlayBase.srcName,
            key: `${(job.title || job.url || '?').slice(0, 65)} | off-site rate limit`,
            reason: 'offsite-rate-limit', status: navigationStatus,
            expectedUrl: viewUrl.slice(0, 240), finalUrl: String(rawPageInfo.finalUrl || fetchPage.url()).slice(0, 240),
          }, { updateActive: false });
          continue;
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
            rateLimitedGapMs = Math.max(rateLimitedGapMs, ZIPRECRUITER_RATE_LIMITED_GAP_MS);
            logger.warn(`[BrowserScraper] ${overlayBase.srcName} detail fetch rate-limited for "${title}" — waiting ${Math.ceil(waitMs / 1000)}s, then continuing with a ${Math.ceil(rateLimitedGapMs / 1000)}s gap (retry ${zipRecruiter429Retries}/${ZIPRECRUITER_429_RETRIES})`);
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
            evidence: `${overlayBase.srcName} returned HTTP 429 while fetching "${job.title || 'an untitled listing'}". The scraper waited and retried ${ZIPRECRUITER_429_RETRIES} times with a slower gap, then stopped further detail fetches to avoid extending the rate limit.`,
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

        // Another site's check after a ZipRecruiter redirect is never shown
        // to the person and never stops the pass: keep this row's list fields
        // and go on to the next row.
        const offSiteChallengeUrl = String(challengeSignals?.url || rawPageInfo.finalUrl || fetchPage.url() || '');
        if (detailChallengeAction !== 'none' && isOffSiteZipRecruiterDetail(sourceId, offSiteChallengeUrl)) {
          let offSiteHost = '';
          try { offSiteHost = new URL(offSiteChallengeUrl).hostname; } catch { /* unparseable */ }
          logger.info(`[BrowserScraper] ${overlayBase.srcName} redirected "${job.title || job.url || '?'}" to ${offSiteHost || 'another site'}, which showed a check; keeping the listing without its description`);
          recordManualScraperTelemetry({
            phase: 'detail-offsite-challenge', sourceId, srcName: overlayBase.srcName,
            key: (job.title || job.url || '?').slice(0, 80),
            reason: challengeSignals?.reason, title: challengeSignals?.title,
            disposition: detailChallengeAction,
            navigationStatus,
            expectedUrl: viewUrl.slice(0, 240),
            finalUrl: offSiteChallengeUrl.slice(0, 240),
          }, { updateActive: false });
          continue;
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
              dataDomeBlockFrame: !!challengeSignals?.hasDataDomeBlockFrame,
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
              if (sourceId === 'ziprecruiter' && ['ok', 'recovered'].includes(detailWaitResult)) {
                solvedDetailChallenges += 1;
                lastDetailNavigationAt = Date.now();
                keepDetailForeground = true;
                recordManualScraperTelemetry({
                  phase: 'detail-challenge', sourceId, srcName: overlayBase.srcName,
                  disposition: 'paced-after-solve',
                  reason: `foreground; next detail waits ${zipRecruiterDetailGapMs(solvedDetailChallenges)}ms`,
                }, { updateActive: false });
              } else {
                await page.bringToFront().catch(() => {});
              }
              await injectOverlay(keepDetailForeground ? fetchPage : page).catch(() => {});

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
                      : detailWaitResult === 'page-detached'
                        ? 'detail-page-detached'
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

              if (detailWaitResult === 'hard-block' && isAppcastRestricted(postWaitSignals)) {
                if (await recoverFromAppcastRestriction() === 'retry') {
                  i--;
                  continue;
                }
                break;
              }
              if (detailWaitResult === 'ok' || detailWaitResult === 'recovered') {
                detailChallengeResolved = true;
                logger.info(`[BrowserScraper] ${overlayBase.srcName}: detail verification resolved; continuing "${job.title || job.url || '?'}"`);
                await updateOverlay(keepDetailForeground ? fetchPage : page, {
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
              const detailTabDetached = detailWaitResult === 'page-detached';
              logger.warn(`[BrowserScraper] ${overlayBase.srcName}: detail enrichment ${hardBlock ? 'hard-blocked' : detailTabDetached ? 'stopped: the detail tab stopped responding during the check wait' : 'remained session-blocked'}; retaining list rows and stopping detail pass (${evidence})`);
              recordManualScraperTelemetry({
                phase: 'desc-miss', srcName: overlayBase.srcName,
                key: `${(job.title || job.url || '?').slice(0, 65)} | detail challenge`,
              }, { updateActive: false });
              descWarning ||= {
                code: hardBlock ? 'description-detail-hard-block' : 'description-detail-challenge',
                severity: hardBlock ? 'block' : 'warn',
                ...(hardBlock ? {
                  action: 'none',
                  shortLabel: 'Wait, then retry',
                  // Instant retries re-open the same blocked pages and loop;
                  // the card counts this wait down before offering Retry.
                  retryAfterAt: Date.now() + HARD_BLOCK_RETRY_WAIT_MS,
                  // The resolver re-opens a results page and re-walks this
                  // source's detail pass from it, so the page whose details
                  // were blocked is the retry target the IPC needs.
                  url: safePageUrl(page) || job.url || null,
                } : {}),
                evidence: hardBlock
                  ? `${overlayBase.srcName} returned a non-interactive human-verification hard block while fetching "${job.title || 'an untitled listing'}" (${challengeSignals?.title || 'untitled page'} at ${challengeSignals?.url || fetchPage.url()}). Detail requests stopped immediately.`
                  : detailTabDetached
                    ? `The ${overlayBase.srcName} detail tab stopped responding to the scraper while it waited on a check for "${job.title || 'an untitled listing'}". Relevant listing rows were retained, but this and later rows may lack full descriptions.`
                    : `${overlayBase.srcName} re-served a verification challenge while fetching "${job.title || 'an untitled listing'}" after the detail tab was presented for solving. Relevant listing rows were retained, but this and later rows may lack full descriptions.`,
                suggestion: hardBlock
                  ? `Retry unlocks after the wait. Let the IP/session restriction on ${overlayBase.srcName} cool down, confirm the site opens normally in Chrome, then choose Retry. Skip continues without these listings.`
                  : detailTabDetached
                    ? `Rerun ${overlayBase.srcName} for full descriptions.`
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
          let descEscalations = 0;
          const descChallengeStart = Date.now();
          const descInputProbe = createChallengeInputProbe(page);
          await descInputProbe.poll();
          // Wait INDEFINITELY for the user to solve. The only exits are abort
          // (Reset / hub close) or the user closing the window — never a timer.
          while (true) {
            if (signal?.aborted || page.isClosed()) break;
            await new Promise(r => setTimeout(r, humanDelay(1500)));
            if (await recoverFromChallengeHomeLanding(page, overlayBase, signal, viewUrl, baseCount + i + 1)) {
              continue;
            }
            await descInputProbe.poll();
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
                ...overlayBase, tabLayout: overlayTabLayout(page),
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
            // Same escalation as the list-page wait: no timeout, but a wait
            // this old is announced once per mark, in the log and on the card.
            const descElapsedMs = Date.now() - descChallengeStart;
            while (descEscalations < CHALLENGE_ESCALATE_MS.length
              && descElapsedMs >= CHALLENGE_ESCALATE_MS[descEscalations]) {
              const escalateMinutes = Math.round(CHALLENGE_ESCALATE_MS[descEscalations] / 60_000);
              descEscalations++;
              const escalation = `still waiting ${escalateMinutes}m for a human check on ${overlayBase.srcName} — complete it or press Reset`;
              logger.warn(`[BrowserScraper] ${escalation}`);
              await updateOverlay(page, {
                ...overlayBase,
                count: baseCount + i + 1,
                status: escalation,
                challenge: true,
              }).catch(() => {});
            }
          }
          if (!solved) break;
          {
            const descInput = descInputProbe.summary();
            const descClearedAfter = formatWaitDuration(Date.now() - descChallengeStart);
            recordManualScraperTelemetry({
              phase: 'challenge-resolved', srcName: overlayBase.srcName, context: 'description-expansion',
              clearedAfter: descClearedAfter, input: challengeInputVerdict(descInput), inputCounts: descInput,
            });
            logger.info(`[BrowserScraper] ${overlayBase.srcName}: description-expansion check cleared after ${descClearedAfter}; ${describeChallengeInput(descInput)}`);
          }
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
            if (!await (runtime?.delay || waitForAbortableDelay)(waitMs, signal)) break;
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

        const detailFinalHostClass = finalizeListingEvidence({}, {
          requestedUrl: viewUrl, finalUrl: rawPageInfo.finalUrl || fetchPage.url(),
        }).finalHostClass;
        const otherHostNotFound = [404, 410].includes(Number(navigationStatus))
          && detailFinalHostClass === 'other'
          && pageInfo.workdayPostingAvailable !== false && !pageInfo.zipRecruiterClosedJobRedirect;
        // The persistent error shell is a wall even if its response happens
        // to carry a not-found status; it cannot establish posting closure.
        if (isUnavailableDetailPage(pageInfo) && !otherHostNotFound && !detailErrorShellSeen) {
          if (sourceId === 'ziprecruiter') {
            recordListingEvidence(enhanced[i], finalizeListingEvidence({}, {
              board: 'ziprecruiter', ruleKey: 'ziprecruiter', requestedUrl: viewUrl,
              finalUrl: rawPageInfo.finalUrl || fetchPage.url(), httpStatus: navigationStatus,
              expectedTitle: enhanced[i]?.title, expectedCompany: enhanced[i]?.company,
              expectedLocation: enhanced[i]?.location,
              workdayPostingAvailable: pageInfo.workdayPostingAvailable,
            }));
          }
          const { reason, row: boardClosedRow } = unavailableDetailDisposition({
            pageInfo, job: enhanced[i], sourceId, expectedUrl: viewUrl, finalUrl: rawPageInfo.finalUrl || fetchPage.url(),
          });
          const keptBoardClosed = boardClosedRow != null;
          rowOutcomes[i] = 'closed';
          logger.info(`[BrowserScraper] ${overlayBase.srcName} ${keptBoardClosed ? 'kept board-closed' : 'dropped unavailable'} detail listing "${job.title || job.url || '?'}" (${reason})`);
          recordManualScraperTelemetry({
            phase: 'detail-unavailable', srcName: overlayBase.srcName,
            key: `${(job.title || job.url || '?').slice(0, 65)} | ${keptBoardClosed ? 'board-closed listing kept' : 'unavailable listing'}`,
            reason, status: navigationStatus, disposition: keptBoardClosed ? 'kept-board-closed' : 'dropped',
            expectedUrl: viewUrl.slice(0, 240), finalUrl: fetchPage.url().slice(0, 240),
          }, { updateActive: false });
          if (keptBoardClosed) {
            boardClosedDetailKept += 1;
            enhanced[i] = boardClosedRow;
            continue;
          }
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
        let jsonLdSalaryProvenance = 'unknown';
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
          const ld = await fetchPage.evaluate((type, field, datePattern, domDateFallback = true) => {
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
                // Return the raw string across CDP. The main process strips
                // markup with its inert, pure normalizer rather than parsing
                // untrusted listing text into a detached browser document.
                desc = String(d[field]);
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
            if (!datePosted && domDateFallback) {
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
            // Glassdoor's page chrome can be French: only its JSON-LD is read.
          }, cfg.jsonLdType, cfg.jsonLdField, POSTED_DATE_PATTERN, !glassdoorJobPage).catch(() => ({ desc: '', datePosted: '', baseSalary: null, company: '' }));
          text = inertDescriptionText(ld.desc);
          if (text) descriptionCapture = glassdoorJobPage ? 'glassdoor-job-page-json-ld' : 'json-ld-job-description';
          jsonLdDate = ld.datePosted;
          // Glassdoor writes the currency the way its own list chips do.
          jsonLdSalary = glassdoorJobPage ? glassdoorJobPageSalary(ld.baseSalary, listUrl) : formatJsonLdSalary(ld.baseSalary);
          if (jsonLdSalary) jsonLdSalaryProvenance = sourceId === 'google' ? 'unknown' : 'posted';
          jsonLdCompany = ld.company;
        }
        // __NEXT_DATA__ fallback: walk a dot-separated field path into pageProps.
        if (!text && cfg.nextDataField && !isExternalZipDetail && !glassdoorJobPage) {
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
              // Do not parse provider-owned text as HTML in the page. It is
              // normalized after this evaluate call in the main process.
              return node;
            } catch { return ''; }
          }, cfg.nextDataField).catch(() => '');
          text = inertDescriptionText(text);
          if (text) descriptionCapture = 'next-data-job-description';
        }
        if (!text && !isExternalZipDetail && !glassdoorJobPage) {
          text = await fetchPage.evaluate(sel => {
            return document.querySelector(sel)?.innerText?.trim() || '';
          }, cfg.panelSelector).catch(() => '');
          if (text) descriptionCapture = 'detail-page-description';
        }
        if (!text && !isExternalZipDetail && !glassdoorJobPage) {
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
        if (!text && !isExternalZipDetail && !glassdoorJobPage) {
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
                        const value = typeof node[jsonLdField] === 'string' ? node[jsonLdField] : '';
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
                const value = typeof node === 'string' ? node : '';
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
          text = ['json-ld', 'next-data'].includes(delayed.source)
            ? inertDescriptionText(delayed.text)
            : delayed.text;
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
          if (jsonLdSalary) jsonLdSalaryProvenance = 'estimated';
        }
        // Glassdoor: no JobPosting JSON-LD description is a miss for the
        // fallback, not an error. The row is left exactly as the list gave it
        // ('pending') and the panel walk reads it; nothing is reported here, so
        // a row the panel recovers never shows up as a miss.
        if (glassdoorJobPage && !text) {
          logger.info(`[BrowserScraper] ${overlayBase.srcName} job page ${i + 1}/${enhanced.length} had no JobPosting description (HTTP ${navigationStatus ?? '?'}); left for the list-card panel`);
          continue;
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
          jsonLdSalaryProvenance,
          salaryChanged,
          reconciledSalary,
          jsonLdCompany,
        });
        if (sourceId === 'ziprecruiter') {
          const stamped = await captureZipRecruiterListingLiveness(fetchPage, enhanced[i], {
            requestedUrl: viewUrl, httpStatus: navigationStatus, descriptionText: text,
            descriptionCapture, workdayPostingAvailable: pageInfo.workdayPostingAvailable,
            wall: detailErrorShellSeen ? 'ziprecruiter-error-shell' : null,
          });
          if (stamped === null) {
            if (enhanced[i] != null) unavailableDetailDropped += 1;
            enhanced[i] = null;
            continue;
          }
          enhanced[i] = stamped;
        }
        if (text) expandedCount++;
        if (text) rowOutcomes[i] = 'expanded';
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
        if (glassdoorJobPage) {
          // Row stays 'pending' for the panel; only a panel miss is reported.
          jobPageRoute.silentMisses += 1;
          continue;
        }
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
    detailPacing.lastNavigationAt = lastDetailNavigationAt;
    detailPacing.solvedChallenges = solvedDetailChallenges;
    detailPacing.rateLimitedGapMs = rateLimitedGapMs;
    unlinkDetailOverlays();
    await detailPage?.close().catch(() => {});
    if (keepDetailForeground) await page.bringToFront().catch(() => {});
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
  await updateOverlay(page, {
    ...overlayBase, count: totalSoFar,
    status: signal?.aborted ? 'Stopping…' : 'Returning to search results…',
  });
  return {
    jobs: enhanced.filter(Boolean),
    // Aligned with the input (a retired row is null), for the Glassdoor merge.
    rows: enhanced,
    rowOutcomes,
    jobPageRoute,
    descError: null,
    descWarning,
    expandedCount,
    unavailableDetailDropped,
    boardClosedDetailKept,
  };
}
