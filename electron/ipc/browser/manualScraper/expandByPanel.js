/**
 * Side-panel / card-click description walk (Google, Glassdoor and other panel sources).
 */
import { manualScraperTelemetry } from './scrapeState.js';
import {
  DESC_CHANGE_POLL_MS,
  DESC_CHANGE_TIMEOUT_MS,
  DESC_CONFIGS,
  DESC_RETRY_PAUSE_MS,
  DESC_STALE_THRESHOLD,
  descriptionPanelFailureAttribution,
  descriptionPanelPacing,
  descriptionPanelRetryAllowed,
  panelWindowWaitMs,
  sleepUnlessAborted,
} from './walkRules.js';
import {
  assessDescriptionPanelUpdate,
  assessDetailSelection,
  extractGlassdoorPanelResponseDetail,
  glassdoorPanelResponseIdentity,
  isGoogleDescriptionPanelRateLimitResponse,
  matchingDetailTitle,
  mergeGlassdoorPanelDetail,
} from './detailParsing.js';
import { buildDescriptionCardTargets, dismissGlassdoorOpportunityModal } from './descriptionDom.js';
import {
  addGoogleApplyCapture,
  buildPendingGoogleApplyRedirects,
  createGoogleApplyRedirectResolver,
  googleApplyLinksRateLimitedWarning,
  normalizeGoogleApplyOptions,
  readGoogleApplyCaptureCounts,
  selectGoogleApplyUrl,
  waitForGoogleApplyDestination,
} from './googleApply.js';
import { getChallengeSignals } from './pageReadiness.js';
import { updateOverlay, waitIfPaused } from './scrapeBrowser.js';
import { notePacePanelInterrupt, notePacePanelWindowWait, recordManualScraperTelemetry } from './scrapeTelemetry.js';
import { classifyPanelWalkInterrupt, describePanelWalkInterrupt, readPanelWalkCover } from '../panelWalkInterrupt.js';
import { GOOGLE_POSTED_TEXT_PATTERN, readGooglePanelPostedDate } from '../googlePostedDate.js';
import { createBackgroundScrapePage } from '../backgroundScrapeBrowser.js';
import { humanCooldown, humanDelay } from '../../../utils/humanDelay.js';
import { logger } from '../../../logger.js';
import { isAggregatorHost } from '../../officialSourceHosts.js';

// Marks every row from startIndex on as not yet described, with the reason the walk stopped.
// The row at startIndex is the one that failed; the rows after it were never
// requested, which `descriptionDeferredBy: 'walk-stopped'` records so a report
// can say "1 failed, N not requested" instead of N+1 failures.
function deferRowsFrom(rows, startIndex, reason, failedRowExtra = null) {
  for (let index = startIndex; index < rows.length; index++) {
    rows[index] = index === startIndex
      ? { ...rows[index], descriptionDeferredReason: reason, ...(failedRowExtra || {}) }
      : { ...rows[index], descriptionDeferredReason: reason, descriptionDeferredBy: 'walk-stopped' };
  }
}

// eslint-disable-next-line no-unused-vars -- kept so the signature matches expandDescriptionsByNavigation
export async function expandDescriptionsByPanel(page, jobs, sourceId, overlayBase, totalSoFar, signal = null, walkPlan = null, _runtime = null, cfg = DESC_CONFIGS[sourceId]) {
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
  // Aggregator-board "gone" verdicts are NOT retired here: the row is kept with a
  // boardClosed marker so the official-posting resolver can look for the
  // employer's own posting. Counted apart so unavailableDetailDropped stays the
  // number of rows actually removed.
  let boardClosedDetailKept = 0;

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
  let panelWindowWaits = 0;
  let panelWindowWaitedMs = 0;
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
  const googleApplyRedirects = createGoogleApplyRedirectResolver(() => createBackgroundScrapePage(page.browser()));
  // The search URL this reader was throttled on, captured before the detail walk
  // leaves the results page: the rate-limit warning's Retry needs it.
  const googleApplySourceUrl = sourceId === 'google' ? String(page.url() || '').slice(0, 240) : '';
  let googleApplyLinksCaptured = 0;
  let googleApplyLinksMissing = 0;
  // Rows (and their still-unread redirects) left without an employer link because
  // Google stopped the reader. Counted so the source report can say what is left.
  let googleApplyLinkPendingRows = 0;
  let googleApplyLinkPendingRedirects = 0;
  let googleApplyOptionsNonAggregator = 0;
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
    deferRowsFrom(enhanced, startIndex, 'description-rate-limited');
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
      deferRowsFrom(enhanced, startIndex, 'description-rate-limited');
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
    // The status is otherwise only in the in-memory telemetry ring; keeping it
    // on the saved row lets a run without a bug report still say what failed.
    deferRowsFrom(enhanced, startIndex, 'description-panel-http-error',
      Number.isFinite(Number(failure.status)) ? { descriptionDeferredStatus: Number(failure.status) } : null);
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
      && !signal?.aborted
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const detailPromise = glassdoorPanelResponseDetails.get(key);
    let detail = null;
    if (detailPromise) {
      let raceTimer = null;
      try {
        detail = await Promise.race([
          detailPromise,
          new Promise(resolve => { raceTimer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); }),
        ]);
      } finally {
        clearTimeout(raceTimer);
      }
    }
    pendingGlassdoorPanelKeys.delete(key);
    glassdoorPanelResponseDetails.delete(key);
    if (detail) panelJsonPayloads++;
    return detail;
  };
  // Kept on the source's pacing object, so the budget spans every page and
  // query of this source, not just this batch.
  const panelWindowTimes = walkPlan?.detailPacing
    ? (walkPlan.detailPacing.panelRequestTimes ||= [])
    : [];
  const waitForPanelWindow = async () => {
    const waitMs = panelWindowWaitMs(sourceId, panelWindowTimes);
    if (waitMs <= 0) return;
    panelWindowWaits++;
    panelWindowWaitedMs += waitMs;
    // Also on the source's pace record, so the report's pace line shows these
    // waits even after this batch's summary has aged out of the event ring.
    notePacePanelWindowWait(sourceId, { srcName: overlayBase.srcName, waitMs });
    await updateOverlay(page, {
      ...overlayBase,
      count: totalSoFar,
      status: `Pausing ${Math.ceil(waitMs / 1000)}s to keep ${overlayBase.srcName} panel requests under its 5-minute limit…`,
    }).catch(() => {});
    await sleepUnlessAborted(waitMs + humanDelay(1500), signal);
  };
  const recordPanelRequest = () => { panelWindowTimes.push(Date.now()); };
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

  // Diagnostics only: when a failure streak starts (or stops a walk) look at
  // what is actually on screen. A check or an unexpected popup leaves the panel
  // unchanged, so a timeout streak alone cannot tell a covered page from a
  // changed selector — and today's stop message blamed the selector either way.
  // Nothing here waits, retries, clicks or dismisses: it reads and records.
  let panelWalkInterrupts = 0;
  const inspectPanelWalkInterrupt = async (stage, failure, itemIndex) => {
    // The cap bounds report noise from many short streaks; the look at a stop
    // always runs, because it is the one that names why the walk ended.
    if (panelWalkInterrupts >= 6 && stage !== 'stop') return null;
    panelWalkInterrupts++;
    let signals = null;
    let cover = null;
    try {
      signals = await getChallengeSignals(page);
    } catch {
      signals = null;
    }
    try {
      cover = await page.evaluate(readPanelWalkCover);
    } catch {
      cover = null;
    }
    const verdict = classifyPanelWalkInterrupt({ signals, cover });
    recordManualScraperTelemetry({
      phase:           'panel-walk-interrupt',
      sourceId,
      srcName:         overlayBase.srcName,
      itemIndex:       itemIndex + 1,
      itemTotal:       enhanced.length,
      failure,
      stage,
      verdict,
      challengeReason: signals?.reason || null,
      title:           signals?.title || null,
      dialogText:      cover?.dialogText || null,
      dialogLabel:     cover?.dialogLabel || null,
      checkFrames:     cover?.checkFrames ?? null,
      cover:           cover?.cover || null,
      coverPosition:   cover?.position || null,
    }, { updateActive: false });
    if (stage === 'first') notePacePanelInterrupt(sourceId, { srcName: overlayBase.srcName, verdict });
    const described = describePanelWalkInterrupt(verdict, { signals, cover });
    logger.info(`[BrowserScraper] ${overlayBase.srcName} ${failure === 'click' ? 'card click' : 'panel read'} failure ${panelWalkInterrupts} for card ${itemIndex + 1}/${enhanced.length} (${stage === 'stop' ? 'stopping the walk' : 'first of a streak'}): ${described}`);
    return { verdict, signals, cover, described };
  };

  // A 'check' or 'popup' verdict means the walk stopped because the page was
  // covered, not because the selector broke. Say so in the stop message and the
  // overlay; the error code (and therefore cards, warnings and resolvers) is
  // unchanged.
  const interruptStopText = (inspection, count, failure) => {
    if (!inspection || (inspection.verdict !== 'check' && inspection.verdict !== 'popup')) return null;
    return {
      evidence: `${count} consecutive card ${failure === 'click' ? 'clicks' : 'panel reads'} failed for ${sourceId} while ${inspection.described}`,
      suggestion: 'This is not a selector failure: solve the check or close the popup in the browser, then retry the source.',
      status: inspection.verdict === 'check'
        ? 'Verification check interrupted the card walk'
        : 'A popup interrupted the card walk',
    };
  };

  const abortWithError = async (evidence, suggestion, code = 'stale-desc-selectors', status = null) => {
    logger.warn(`[BrowserScraper] ${sourceId}: ${evidence}`);
    await updateOverlay(page, {
      ...overlayBase,
      count:  totalSoFar,
      status: status || (code === 'glassdoor-job-alert-modal'
        ? 'Glassdoor job-alert prompt blocked the card walk — retry after it is closed.'
        : 'Desc selector broken — fix selector code and restart.'),
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
      status: `Opening job ${i + 1} of ${enhanced.length} to read · list position ${physicalIndex} of ${physicalTotal}`,
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
        // Look at the page when the streak starts and when it stops the walk —
        // and nowhere else, so a covered page cannot flood the report.
        const clickFailureStage = consecutiveClickFails === 1
          ? 'first'
          : consecutiveClickFails === DESC_STALE_THRESHOLD ? 'stop' : null;
        const clickInspection = clickFailureStage
          ? await inspectPanelWalkInterrupt(clickFailureStage, 'click', i)
          : null;
        if (consecutiveClickFails >= DESC_STALE_THRESHOLD) {
          if (sourceId === 'google') {
            // Google retains extracted rows after its virtualized list has
            // unmounted their cards. Those rows are still valid search results;
            // stop only this enrichment pass and leave a retry-later warning,
            // rather than misreporting a source abort as user-done.
            deferRowsFrom(enhanced, i, 'description-card-unavailable');
            descWarning ||= {
              code: 'description-card-unavailable', severity: 'block',
              evidence: `Google Jobs virtualized result cards before their detail panels could be opened. ${expandedCount} of ${enhanced.length} listing(s) received full descriptions; the remaining cards were retained but deferred.`,
              suggestion: 'Click Solve after the Google list has settled to retry the unresolved descriptions. No selector change is indicated by this virtualized-list miss.',
            };
            break;
          }
          const clickInterrupt = interruptStopText(clickInspection, consecutiveClickFails, 'click');
          await abortWithError(
            clickInterrupt?.evidence
              ?? `${consecutiveClickFails} consecutive card-click failures for ${sourceId} — card element not found in DOM (key="${key}")`,
            clickInterrupt?.suggestion
              ?? `The card selector for ${sourceId} description expansion may have changed. Check DESC_CONFIGS['${sourceId}'] cardAttr/cardIdPrefix/cardHrefKey in electron/ipc/browser/manualScraper/walkRules.js.`,
            'stale-desc-selectors',
            clickInterrupt?.status ?? null,
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
      await waitForPanelWindow();
      if (signal?.aborted) { interruptedAt ??= i + 1; break; }
      if (page.isClosed()) break;
      if (sourceId === 'glassdoor') {
        glassdoorPanelHttpFailure = null;
        glassdoorPanelResponseDetails.delete(key);
        pendingGlassdoorPanelKeys.add(key);
      }
      await page.mouse.move(clickTarget.x, clickTarget.y).catch(() => {});
      await page.mouse.click(clickTarget.x, clickTarget.y, { delay: humanDelay(80) }).catch(() => {});
      recordPanelRequest();
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
          const panel = await page.evaluate((panelSel, panelMulti, panelSourceId) => {
            if (panelMulti) {
              const text = Array.from(document.querySelectorAll(panelSel))
                // Google leaves old/preloaded panels mounted. CSS-hidden .ejCXj
                // continuations in the active aria-hidden=false panel remain
                // valid, but nothing below an aria-hidden=true panel may count.
                .filter(e => e.matches('span') && !e.closest('[aria-hidden="true"]'))
                .map(e => e.textContent?.trim()).filter(Boolean).join('\n\n').trim();
              return { text, selectedTitleCandidates: [] };
            }
            const active = Array.from(document.querySelectorAll(panelSel))
              .find(el => !el.closest('[aria-hidden="true"]'));
            const text = active?.innerText?.trim() || active?.textContent?.trim() || '';
            // The list cards carry data-jobid. Limit the title probe to the
            // active description's own ancestor chain so a matching title on
            // the left list cannot validate a stale right panel.
            const selectedTitleCandidates = [];
            if (panelSourceId === 'glassdoor' && active) {
              // Capture candidate text only. The main process applies bounded
              // entity decoding before comparison: a programmatically-written
              // heading can still read `&#8211;` where the parsed list card read
              // `–`. No provider text is parsed as page HTML here.
              let scope = active.parentElement;
              for (let depth = 0; scope && depth < 6; depth++, scope = scope.parentElement) {
                selectedTitleCandidates.push(...Array.from(scope.querySelectorAll('[data-test*="job-title" i], [data-testid*="job-title" i], h1, h2, h3, [role="heading"]'))
                  .filter(el => !el.closest?.('[aria-hidden="true"]') && !el.closest?.('[data-jobid]'))
                  .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
                  .filter(Boolean));
              }
            }
            return { text, selectedTitleCandidates };
          }, cfg.panelSelector, cfg.panelMulti || false, sourceId).catch(() => ({ text: '', selectedTitleCandidates: [] }));
          const decision = assessDescriptionPanelUpdate({
            sourceId,
            previousText: prevPanelText,
            currentText: panel.text,
            expectedTitle: job.title,
            selectedTitle: matchingDetailTitle(job.title, panel.selectedTitleCandidates),
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
        await waitForPanelWindow();
        if (signal?.aborted || page.isClosed()) break;
        await page.mouse.click(clickTarget.x, clickTarget.y, { delay: humanDelay(80) }).catch(() => {});
        recordPanelRequest();
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
      const readSelectedGoogleTitles = () => page.evaluate(() => {
        // Same asymmetry as `normalizedDetailTitle` in this module: the expected
        // title arrives entity-decoded from the pipeline while a heading's
        // textContent can still read `&#8211;` when Google double-encodes it.
        // Return only visible text. The main process does the bounded entity
        // decoding without ever reparsing provider-owned text as HTML.
        const headings = Array.from(document.querySelectorAll('[aria-hidden="false"]'))
          .flatMap(region => Array.from(region.querySelectorAll('h1, h2, h3, [role="heading"]')))
          .filter(el => !el.closest('[aria-hidden="true"]'))
          .filter(el => !el.closest('[data-share-url]'))
          .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        return headings;
      }).catch(() => []);
      const selectedGoogleTitle = async () => {
        const headings = await readSelectedGoogleTitles();
        return matchingDetailTitle(job.title, headings) || headings[0] || '';
      };
      let selectedTitle = sourceId === 'google' ? await selectedGoogleTitle() : '';
      let selectionAssessment = assessDetailSelection(job.title, selectedTitle);
      // Google can paint the new description before replacing the old detail
      // heading. An explicit mismatch is meaningful only after a short settle
      // window; an absent heading is intentionally unverified and accepted.
      if (sourceId === 'google' && selectionAssessment.selectionMismatch) {
        const selectionDeadline = Date.now() + 1000;
        while (Date.now() < selectionDeadline) {
          await new Promise(r => setTimeout(r, 160));
          selectedTitle = await selectedGoogleTitle();
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
        const applyPanel = await waitForGoogleApplyDestination(page, job.applySource);
        const applyCandidates = await googleApplyRedirects.resolve(applyPanel.candidates);
        const applyResult = { ...applyPanel, candidates: applyCandidates, url: selectGoogleApplyUrl(applyCandidates, job.applySource) };
        const applyOptions = normalizeGoogleApplyOptions(applyCandidates);
        manualScraperTelemetry.googleApplyCapture = addGoogleApplyCapture(manualScraperTelemetry.googleApplyCapture, {
          ...applyResult, counts: applyResult.url ? null : await page.evaluate(readGoogleApplyCaptureCounts).catch(() => null) });
        // Google stopped the reader, so this row keeps only its Google card URL.
        // Park the redirects it never got to read on the row: Retry follows those
        // exact links instead of re-scraping the source, and Skip simply keeps the
        // Google links it has.
        const pendingApplyRedirects = applyResult.url || !googleApplyRedirects.rateLimited
          ? []
          : buildPendingGoogleApplyRedirects(applyCandidates);
        enhanced[i] = { ...enhanced[i], ...(applyResult.url ? { url: applyResult.url } : {}), applyOptions, salaryProvenance: 'unknown' };
        if (pendingApplyRedirects.length > 0) {
          enhanced[i].pendingApplyRedirects = pendingApplyRedirects;
          googleApplyLinkPendingRows++;
          googleApplyLinkPendingRedirects += pendingApplyRedirects.length;
        }
        // Google only sometimes renders the posting age on the LIST card (a
        // whole class of cards ships no date at all), which is what tripped the
        // scrape-health "posted date missing" alarm. The verified panel header
        // always carries it: fill a BLANK list date, and never overwrite a date
        // the list card already supplied.
        if (!String(enhanced[i]?.posted ?? '').trim()) {
          const panelPosted = await page.evaluate(
            readGooglePanelPostedDate, cfg.panelSelector, GOOGLE_POSTED_TEXT_PATTERN,
          ).catch(() => '');
          if (panelPosted) enhanced[i] = { ...enhanced[i], posted: panelPosted };
        }
        if (applyOptions.some(option => !isAggregatorHost(new URL(option.href).hostname))) googleApplyOptionsNonAggregator++;
        if (applyResult.url) {
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
        // Shared across this platform's pages: proof the panel selectors work
        // in this walk, read by the timeout streak below.
        if (walkPlan?.detailPacing) {
          walkPlan.detailPacing.panelReads = (walkPlan.detailPacing.panelReads || 0) + 1;
        }
      } else {
        panelTimeoutCount++;
        rememberCardWalkFailure(i + 1, key, selectionAssessment.selectionMismatch ? 'detail-title-mismatch' : 'panel-timeout');
        consecutivePanelTimeouts++;
        // Look at the page when the streak starts and when it stops the walk.
        // The inspection runs BEFORE the closeSelector click below so it sees
        // what actually covers the panel, not the cleaned-up page.
        const panelFailureStage = consecutivePanelTimeouts === 1
          ? 'first'
          : consecutivePanelTimeouts === DESC_STALE_THRESHOLD ? 'stop' : null;
        const panelInspection = panelFailureStage
          ? await inspectPanelWalkInterrupt(panelFailureStage, 'panel-timeout', i)
          : null;
        if (consecutivePanelTimeouts >= DESC_STALE_THRESHOLD) {
          // Try to close any open modal before aborting so the page is left clean
          if (cfg.closeSelector) {
            await page.evaluate(sel => { document.querySelector(sel)?.click(); }, cfg.closeSelector).catch(() => {});
            await new Promise(r => setTimeout(r, humanDelay(400)));
          }
          const panelInterrupt = interruptStopText(panelInspection, consecutivePanelTimeouts, 'panel-timeout');
          // Broken selectors never read a single panel. When this walk has
          // already read panels with the same selectors, a run of timeouts is
          // the board no longer answering (a throttle often shows as a panel
          // that never loads, with no 429 to match), not a code fault. Ending
          // the platform here threw away every remaining query; defer the
          // unread rows instead, so the list walk continues and the detail
          // cooldown re-probes later.
          const panelProvenThisWalk = expandedCount > 0 || (walkPlan?.detailPacing?.panelReads || 0) > 0;
          if (!panelInterrupt && panelProvenThisWalk) {
            const firstUnread = Math.max(0, i - (consecutivePanelTimeouts - 1));
            deferRowsFrom(enhanced, firstUnread, 'description-panel-unresponsive');
            logger.warn(`[BrowserScraper] ${sourceId}: ${consecutivePanelTimeouts} consecutive panel-read timeouts after panels were read earlier in this walk — deferring ${enhanced.length - firstUnread} row(s) and continuing the list walk`);
            descWarning ||= {
              code: 'description-panel-unresponsive', severity: 'block',
              evidence: `${consecutivePanelTimeouts} job detail panels in a row did not load for ${sourceId}, after panels loaded normally earlier in this walk. The scraper stopped opening panels and kept the list rows.`,
              suggestion: 'Wait a few minutes, then click Solve to retry the unread descriptions. Deferred listings are not recorded as seen, so a later run can still collect them.',
            };
            await updateOverlay(page, {
              ...overlayBase,
              count: totalSoFar,
              status: 'Detail panels stopped loading — keeping list results and pausing description clicks.',
            }).catch(() => {});
            break;
          }
          await abortWithError(
            panelInterrupt?.evidence
              ?? `${consecutivePanelTimeouts} consecutive panel-read timeouts for ${sourceId} — panel selector matched nothing or click no longer triggers panel update`,
            panelInterrupt?.suggestion
              ?? `Check DESC_CONFIGS['${sourceId}'] panelSelector (and clickSelector) in electron/ipc/browser/manualScraper/walkRules.js.`,
            'stale-desc-selectors',
            panelInterrupt?.status ?? null,
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
    panelWindowWaits,
    panelWindowWaitedMs,
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
    googleApplyOptionsNonAggregator,
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

  // Google's apply-link reader gives up for the rest of the run once it hits a
  // /sorry hop or an HTTP 429. Every later row then keeps only its Google card
  // URL and would reach scoring as "no employer link" with no stated reason, so
  // the stop is always recorded (telemetry + log) and, when listings were
  // actually left unresolved, surfaced as the same wait-then-retry choice as a
  // hard block. Nothing retries on its own: the click does.
  if (sourceId === 'google' && googleApplyRedirects.rateLimited) {
    const rateLimitedAt = googleApplyRedirects.rateLimitedAt || null;
    recordManualScraperTelemetry({
      phase: 'google-apply-links-rate-limited',
      sourceId,
      srcName: overlayBase.srcName,
      queryIndex: overlayBase.queryIndex ?? null,
      queryTotal: overlayBase.queryTotal ?? null,
      pageNum: overlayBase.pageNum ?? null,
      read: googleApplyRedirects.followed,
      captured: googleApplyLinksCaptured,
      rowsLeft: googleApplyLinkPendingRows,
      redirectsLeft: googleApplyLinkPendingRedirects,
      rateLimitedAt,
      reason: googleApplyRedirects.rateLimitedCause || null,
      sinceRateLimitMs: rateLimitedAt ? Math.max(0, Date.now() - rateLimitedAt) : null,
    }, { updateActive: false });
    logger.warn(`[BrowserScraper] ${overlayBase.srcName} apply-link reader rate-limited (${googleApplyRedirects.rateLimitedCause || 'unknown cause'})${rateLimitedAt ? ` at ${new Date(rateLimitedAt).toISOString()}` : ''}: followed ${googleApplyRedirects.followed} redirect(s), captured ${googleApplyLinksCaptured} employer link(s), ${googleApplyLinkPendingRows} listing(s) left without one`);
    // A same-batch block outranks this: a block may replace a non-block, never
    // the reverse (see mergeDescriptionDetailMissWarning).
    if (googleApplyLinkPendingRows > 0 && descWarning?.severity !== 'block') {
      descWarning = googleApplyLinksRateLimitedWarning({
        url: googleApplySourceUrl,
        readLinks: googleApplyRedirects.followed,
        capturedLinks: googleApplyLinksCaptured,
        pendingRows: googleApplyLinkPendingRows,
        now: rateLimitedAt || Date.now(),
      });
    }
  }

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
    boardClosedDetailKept,
  };
  } finally {
    if (sourceId === 'glassdoor') page.off('response', glassdoorPanelResponseListener);
    if (sourceId === 'google') page.off('response', googlePanelResponseListener);
    await googleApplyRedirects.close();
  }
}
