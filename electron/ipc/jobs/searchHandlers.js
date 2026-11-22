import path from 'path';
import { filterAppliedListings } from '../../../src/utils/applicationBundleIdentity.js';
import { describeJobCollectionLimits, normalizeJobCollectionLimits, resolveJobsPerPlatform } from '../../../src/utils/jobCollectionLimits.js';
import { collectionScopeCaveatsFromCompletedManifestSources, collectionScopeCaveatsFromSourceResults, hydrateCollectionScopeCaveatsIntoSourceResults } from '../../../src/utils/jobCollectionScopeCaveats.js';
import { sourceJobKey } from '../../../src/utils/jobIdentity.js';
import { filterNonEnglishJobs, summarizeJobLanguages } from '../../../src/utils/jobLanguage.js';
import { describeLocationTreatment, filterProvablyOutsideCountryScope, normalizeLocationInput, summarizeLocationAdherence } from '../../../src/utils/jobLocation.js';
import { getEnabledJobSourceIds, getRunnableJobSourceIds } from '../../../src/utils/jobPlatformSelection.js';
import { reconcileGlassdoorSalaryFromDescription } from '../../../src/utils/jobSalaryReconciliation.js';
import { normalizeJobSearchInitialLookbackDays } from '../../../src/utils/jobSearchDateWindow.js';
import { getJobSourceCountryPolicy, summarizeJobSourceCountryPolicies } from '../../../src/utils/jobSourceCountryScope.js';
import { JOB_SEARCH_TEST_MODE } from '../../../src/utils/jobSourceScope.js';
import { normalizeJobsMarkup, repairJobsMojibake } from '../../../src/utils/textEncoding.js';
import { dicePostedBucket, enrichDiceDescriptions, fetchUSAJobs, jobRelevanceEvidence } from '../../extractors/apiExtractors.js';
import { fetchIndeedListingsBrowser } from '../../extractors/indeedBrowser.js';
import { logger } from '../../logger.js';
import { readStatusCache, waitForPendingPlatformVerification } from '../accounts.js';
import { resetManualScraperDiagnostics, scrapeManualSources } from '../browser/manualScraper.js';
import { acquireCanvasRecoveryRead } from '../canvasRecoveryPaths.js';
import { currentJobAnalysisOperationAuthority, jobAnalysisOperationAuthorityReceipt, withCurrentJobAnalysisOperationAuthority } from '../jobAnalysisOperationAuthorityStore.js';
import { validateJobBoardRunExecution } from '../jobBoardRunLease.js';
import { parsePostedDate } from '../jobDateFilter.js';
import { normalizeJobPreferencePlan, screenJobRolesByTitle } from '../jobPreferences.js';
import { getJobRoleScreenVerdictStore } from '../jobRoleScreenVerdicts.js';
import { activateRunForResume, clearRunWithResult, collectionCompletedAtForManifest, computeResumeStartPagesByQuery, finishRunWithSavedListings, isJobRunAutomaticRecoveryEligible, isRunCollectionFinishedWithSavedListings, markProviderGathered, markSourceStatus, normalizeJobRunProfileFingerprint, pauseRunForManualResume, readRunState, rebindRunOperationAuthority, recordSourcePage, setStage as setJobRunStage, startRun as startJobRun } from '../jobRunStaging.js';
import { SOURCE_HEALTH_WARNING_CODE, assessSourceHealth, descriptionsNotFetchedWarning, sourceHealthWarning } from '../jobSourceHealth.js';
import { createSeenListingMatcher, dedupAgainstHistory, finalizeDisplayedJobsHistory, historyPathForCanvas, loadJobsHistory } from '../jobsHistory.js';
import { callLLMText } from '../llm.js';
import { loadAppliedListingKeys } from '../localAiApplication.js';
import { boardClosedSetAside, preferOpenRows, scoreSafeRowsWithBoardClosed } from '../officialPostingBoardClosed.js';
import { getVerificationSnapshot, markManualSolveRequired, orderBrowserSources, recordVerificationOutcome, resetManualSolveTracking, wasManualSolveRequired } from '../scrapeVerification.js';
import { getJobsSettings } from '../settings.js';
import { CANCEL_CAUSE_LABELS, CHECKPOINT_PRESERVING_ABORT_CAUSES, JobOperationSupersededError, admitContinuationProviderWork, checkpointContinuationBeforeReply, claimExactJobRunExecution, isJobOperationSupersededError, normalizeCareerSnapshotIdentifier, requireSavedJobRecoveryCanvas, shouldDiscardJobRunAfterAbort } from './analysisStore.js';
import { abortableDelay, authoritativeFreshJobSearchWindow, buildJobTasks, completedJobSourceIds, effectiveJobSearchWindow, enrichLinkedInDescriptionsLocked, getEgressIp, glassdoorPostedBucket, listWalkStoppedByProviderBlock, manualAiPreSearchRecoveryWindow, narrowJobSearchSourceWindows, runCooldownProbe, selectIndeedResumePlan, withFreshManualScraperTelemetry } from './collection.js';
import { reconcileSearchFunnel, validateExactResumeRun } from './scoring.js';
import { ACTIVE_SOURCE_IDS, ACTIVE_SOURCE_ID_SET, BACKGROUND_PROVIDER_ONLY_SOURCE_IDS, BROWSER_SCRAPE_ORDER, EXACT_RESUME_PROVIDER_ONLY_SOURCE_IDS, JOB_SOURCE_DISPLAY_NAMES, WALK_GUARD_WARNING_CODE, acceptProviderSearchResults, boundedDedupProvenance, boundedRecoveryBlockedUrls, canRecoverGatheredRunDirectly, capPlatformJobsAfterWindow, dedupByTitleCompany, extractExecutedGoogleQueryStrings, filterAndDedupJobsByPostedSince, filterJobsByDescriptionEvidence, getCompletedQueriesFromDetail, getEffectiveSourceWarning, getQueryProgressTotal, hasResolvedJobDescription, jobSourceAuthPreflightScope, jobSourceRecoveryDisposition, linkedInBrowserUnavailableWarning, linkedInShortDescriptionWarning, linkedInWalkComplete, listingReadProgress, listingsReadElsewhere, mergeJobSourceCollectionCap, mergeRoleScreenedJobs, orderedBlockedManualSourceUrls, reconcileTitleRelevanceFunnel, refreshManualSourceUrlIndex, sanitizeWalkGuards, synthScrapeWarning, walkGuardWarning } from './sourceRules.js';
import { clearLinkedInCeiling, jobsTelemetry, linkedinCeiling, rememberLinkedInCeiling } from './state.js';
import { canWriteJobResolveTelemetry, indeedPreflightObservationNote, indeedWarningRequiresManualVerification, recordHistoryWrite, recordJobSourceDispatch, recordJobSourceProgress, recordJobsSourceScope, recordLinkedinEnrichPass, restoreJobsTelemetryIfCurrentRun, syncIndeedSessionStatusFromScrape } from './telemetry.js';
import electronPkg from 'electron';

const { shell } = electronPkg;

export function registerSearchHandlers(ctx) {
  const { handleSafe, resolveRequiredPinnedCareerInputForHandler, runHttpSources, beforeSearchStageWrite, afterSearchProviderResult, settleScrapedRowsForScoring } = ctx;
  // ── Search Jobs (Multi-Source Phase 2) ────────────────────────────────────
  handleSafe('search-jobs', async (event, { queries: rawQueries, nodeId, careerSnapshotId, operationAuthority = null, lastCompletedRunAt = null, initialLookbackDays = null, searchWindow: requestedSearchWindow = null, sourceSearchWindows = null, canvasFilePath, preferredLocation, rawLocation, collectionLimits, enabledSourceIds, jobPreferences = '', jobPreferencePlan = null, jobPreferencesInterpretation = null, countryScope = '', resume = false, resumeRunId = null, finishWithStaged = false, providerPhaseOnly: requestedProviderPhaseOnly = false, boardRecoveryClaim = null, profileFingerprint = null, manualAiPreSearchRecovery = null, sourceFinishedQueries = null, sourceReadKeys = null, sourceOwedKeys = null, runOrigin, profileInputMode }, signal) => {
    // Provider collection deliberately has no raw profile argument.  Still
    // validate the pinned approved snapshot at this final admission boundary:
    // a deleted/replaced snapshot cannot keep an old query bundle running.
    // Every state-changing provider admission, including Resume, must carry
    // an approved v5 snapshot. Legacy sidecars remain readable for migration
    // diagnostics but cannot be resumed or replaced through preload IPC.
    requireSavedJobRecoveryCanvas(canvasFilePath);
    const authorityReceipt = jobAnalysisOperationAuthorityReceipt(operationAuthority);
    if (!authorityReceipt || authorityReceipt.semanticBase.careerSnapshotId !== careerSnapshotId
      || !await currentJobAnalysisOperationAuthority({ canvasFilePath, hubId: nodeId, ...authorityReceipt })) {
      return { success: false, operationSuperseded: true, jobs: [] };
    }
    // The career read is deliberately after the first receipt admission. A
    // stale caller must not even start snapshot I/O, and a replacement while
    // reading the pin is rechecked before diagnostics or staging are touched.
    await resolveRequiredPinnedCareerInputForHandler({ careerSnapshotId });
    let searchSuperseded = false;
    const searchIsCurrent = async () => currentJobAnalysisOperationAuthority({
      canvasFilePath,
      hubId: nodeId,
      ...authorityReceipt,
    });
    const assertSearchCurrent = async () => {
      if (await searchIsCurrent()) return;
      searchSuperseded = true;
      throw new JobOperationSupersededError();
    };
    const searchSupersededResult = () => ({ success: false, operationSuperseded: true, jobs: [] });
    if (!await searchIsCurrent()) return searchSupersededResult();
    const recoveryLease = await acquireCanvasRecoveryRead(canvasFilePath);
    canvasFilePath = recoveryLease.canvasFilePath || canvasFilePath;
    const backgroundBoardProviderOperation = ['hidden-provider', 'board-orchestration']
      .includes(boardRecoveryClaim?.operation)
      ? boardRecoveryClaim.operation
      : null;
    const backgroundBoardProviderBootstrap = requestedProviderPhaseOnly === true
      && resume !== true
      && !!backgroundBoardProviderOperation
      && validateJobBoardRunExecution({
        canvasFilePath,
        nodeId: boardRecoveryClaim?.nodeId,
        boardRunId: boardRecoveryClaim?.boardRunId,
        claimToken: boardRecoveryClaim?.claimToken,
        operation: backgroundBoardProviderOperation,
      }, { sender: event.sender });
    const exactExecution = resume === true && typeof resumeRunId === 'string' && resumeRunId
      ? claimExactJobRunExecution(canvasFilePath, nodeId, resumeRunId)
      : null;
    if (exactExecution && exactExecution.ok !== true) {
      recoveryLease.release();
      return {
        success: false,
        recoveryInProgress: true,
        error: 'This exact saved Job Search is already resuming in another window.',
      };
    }
    try {
    if (!await searchIsCurrent()) return searchSupersededResult();
    if (ACTIVE_SOURCE_IDS.length === 0) {
      return { success: false, error: 'No active job sources configured for job search test mode.' };
    }
    const queries = (Array.isArray(rawQueries) ? rawQueries : [])
      .filter(q => typeof q === 'string' && q.trim());
    // A zero-length bundle is never a runnable search, and failing here is the
    // only place that catches it for every source at once. The whole-feed
    // sources (RemoteOK, WeWorkRemotely) are not keyword-queried server-side —
    // they fetch the entire feed and admit rows by matching them against these
    // queries — so with no queries their admission guard is false for every row
    // and ~190 arbitrary postings would flow into dedup, seen-history and LLM
    // scoring. The browser sources would meanwhile scrape a blank query. The
    // permissive default inside the feed filter is correct for its other
    // callers, so the boundary is fixed here rather than there.
    if (queries.length === 0) {
      const error = 'No search queries were produced for this run. Set a target role, or re-run query generation, then search again.';
      return { success: false, noQueries: true, error };
    }
    // Avoid repainting global diagnostics for any unfinished run. `startRun`
    // below remains the authoritative, locked check; this is only a read-only
    // fast path. A same-hub checkpoint is just as protected as a foreign one:
    // a fresh scan would otherwise truncate its staged ledger and make Resume
    // indistinguishable from a restart.
    const recoveredPreSearchWindow = runOrigin === 'manual-ai-resume'
      ? manualAiPreSearchRecoveryWindow(manualAiPreSearchRecovery, requestedSearchWindow)
      : null;
    if (runOrigin === 'manual-ai-resume' && !recoveredPreSearchWindow) {
      return {
        success: false,
        manualAiRecoveryInvalid: true,
        error: 'This saved job-search recovery could not verify its original search window. It was kept; use Clear career data before choosing a new window.',
      };
    }
    if (!resume && canvasFilePath) {
      const existing = await readRunState(canvasFilePath, Date.now(), { nodeId });
      if (existing?.incomplete) {
        const ownerNodeId = existing.manifest?.inputs?.nodeId || null;
        const ownerLabel = ownerNodeId
          ? `Job Search hub ${ownerNodeId}`
          : 'an older Job Search run with an unknown owner';
        const sameHub = ownerNodeId === nodeId;
        const error = sameHub
          ? 'This Job Search has an unfinished saved checkpoint. Resume it or finish with its saved listings; use Clear career data only if you intentionally want to remove it.'
          : `${ownerLabel} has unfinished recovery data. Resume it from its owning card before starting another search here.`;
        logger.warn(`[Jobs][${nodeId}] ${error}`);
        return {
          success: false,
          stagingConflict: true,
          ...(recoveredPreSearchWindow ? { manualAiRecoveryConflict: true } : {}),
          sameHub,
          ownerNodeId,
          ownerUnknown: !ownerNodeId,
          error,
        };
      }
    }
    // Fresh searches validate the renderer-frozen boundary against the same
    // server-side policy. Keeping the prior local day's exact result handles a
    // run whose preparation crossed midnight without accepting an arbitrary
    // widened window. stale maxAgeDays remains legacy-resume compatibility.
    const normalizedInitialLookbackDays = normalizeJobSearchInitialLookbackDays(initialLookbackDays);
    let activeSearchWindow = recoveredPreSearchWindow
      || (backgroundBoardProviderBootstrap
        // The Board froze this child window in its durable plan before its lane
        // began. It may be older than the normal today/yesterday fresh-request
        // allowance after a long interruption; retain the exact boundary and
        // broaden only the provider horizon at this admitted recovery turn.
        ? effectiveJobSearchWindow(requestedSearchWindow, null, null, new Date())
        : authoritativeFreshJobSearchWindow(
          lastCompletedRunAt,
          normalizedInitialLookbackDays,
          requestedSearchWindow,
        ));
    const appliedInitialLookbackDays = !resume
      && !recoveredPreSearchWindow
      && activeSearchWindow.completionTimestamp == null
      ? normalizedInitialLookbackDays
      : null;
    let ageDays = activeSearchWindow.providerLookbackDays;
    // Per-platform windows may only NARROW the run window, and they belong to the
    // renderer's fresh selection: recoveries and the Board bootstrap keep the run
    // window for every platform exactly as before.
    let activeSourceSearchWindows = (recoveredPreSearchWindow || backgroundBoardProviderBootstrap)
      ? {}
      : narrowJobSearchSourceWindows(sourceSearchWindows, activeSearchWindow);
    const sourceWindowFor = (sourceId) => (
      activeSourceSearchWindows && Object.hasOwn(activeSourceSearchWindows, sourceId)
        ? activeSourceSearchWindows[sourceId]
        : activeSearchWindow
    );
    const ageDaysFor = (sourceId) => {
      const sourceDays = Number(sourceWindowFor(sourceId)?.providerLookbackDays);
      return Number.isFinite(sourceDays) && sourceDays > 0 ? sourceDays : activeSearchWindow.providerLookbackDays;
    };
    const postedSinceFor = (sourceId) => {
      const boundary = Number(sourceWindowFor(sourceId)?.startTimestamp);
      return Number.isFinite(boundary) ? boundary : activeSearchWindow.startTimestamp;
    };
    // Plain-object maps for the per-platform option builders (empty when the run
    // has no per-source windows, which restores the historic single window).
    const ageDaysBySource = () => Object.fromEntries(
      Object.entries(activeSourceSearchWindows || {}).map(([id, window]) => [id, window.providerLookbackDays]),
    );
    const postedSinceBySource = () => Object.fromEntries(
      Object.entries(activeSourceSearchWindows || {}).map(([id, window]) => [id, window.startTimestamp]),
    );
    let activeJobPreferences = typeof jobPreferences === 'string' ? jobPreferences.slice(0, 4000) : '';
    let activeJobPreferencePlan = normalizeJobPreferencePlan(jobPreferencePlan || jobPreferencesInterpretation);
    const normalizedRunOrigin = resume
      ? 'crash-resume'
      : (['initial', 'rerun-button', 'job-board-scan', 'manual-ai-resume'].includes(runOrigin) ? runOrigin : 'unknown');
    const normalizedProfileInputMode = ['fresh-files', 'stored-profile'].includes(profileInputMode)
      ? profileInputMode
      : 'unknown';
    const normalizedProfileFingerprint = normalizeJobRunProfileFingerprint(profileFingerprint);
    let normalizedCollectionLimits = normalizeJobCollectionLimits(collectionLimits);
    // Hub-level source selection is an allow-list. Intersect it with the
    // environment's test scope; server-side normalization makes a renderer
    // bypass unable to query a platform the user disabled. Unsafe platforms
    // remain persisted as a preference but are excluded until their settings
    // become safe again.
    // Do not derive the current UI's source breadth until an explicit recovery
    // token has been checked below. Its manifest owns the only legal breadth;
    // a missing token must return before the fresh-selection path is even
    // considered.
    let activeSourceIds = null;
    const location = String(preferredLocation || '').trim();
    // A fresh request can still lose the durable-manifest ownership race below.
    // Keep the incumbent telemetry intact until that claim succeeds: otherwise
    // a rejected hub B would make a still-valid hub A's Solve look stale.
    const priorJobsTelemetry = { ...jobsTelemetry };
    recordJobsSourceScope(nodeId, event.sender?.id ?? null);
    // Reset per-run state at search START, not at search end — a paste or captcha
    // resolve can arrive mid-run (before the search result returns), and resetting
    // at the end would wipe those records before the bug report reads them.
    // Search/scoring are process-global too. Leaving their prior values in place
    // until the new run reaches those stages lets a mid-run report combine the
    // current pipeline token with the previous funnel, and a terminal zero run
    // never reaches scoring to overwrite the old record at all.
    jobsTelemetry.search = null;
    jobsTelemetry.searchIntent = null; // re-stamped below once this run's inputs are resolved
    jobsTelemetry.scoring = null;
    jobsTelemetry.preferences = null; // scoped to this run, same reasoning as resolves below
    jobsTelemetry.scoringHeartbeat = null;
    jobsTelemetry.resolves = {};
    jobsTelemetry.resumeAttempts = {}; // scoped to this run, same reasoning as resolves above
    jobsTelemetry.compensation = null; // scoped to this run, same reasoning as resolves above
    jobsTelemetry.sourceBlockedUrls = {}; // sourceId → [url, ...] for blocked-source solve
    // Fresh per-source event trail for this run (survives source-card deletion).
    jobsTelemetry.sourceEvents = {};
    jobsTelemetry.sourceEventsT0 = Date.now();
    // Allocate a correlation token before any preflight can emit progress. A
    // crash-resume replaces this with its durable manifest token below.
    const initialRunStartedAt = Date.now();
    let activeRunId = `${nodeId || 'job'}-${initialRunStartedAt}`;
    jobsTelemetry.pipeline = {
      phase: 'preparing-sources',
      startedAt: jobsTelemetry.sourceEventsT0,
      ts: jobsTelemetry.sourceEventsT0,
      active: true,
      pendingSources: [],
      lastSource: null,
      runOrigin: normalizedRunOrigin,
      profileInputMode: normalizedProfileInputMode,
      runId: activeRunId,
    };
    jobsTelemetry.linkedinEnrich = []; // fresh egress-IP trail per run (see definition)
    jobsTelemetry.linkedinCooldown = null; // fresh cooldown-probe result per run
    jobsTelemetry.history = null;
    // The stamp above marks a run live from its first instruction, so every exit
    // that happens BEFORE the gather's own catch (line ~2321) has to retire it —
    // otherwise a bug report taken afterwards renders a phantom '🔄 active'
    // preparing-sources stage for a search that never ran. `reason` is the
    // verbatim message handed back to the renderer (an observation, not a cause).
    const retirePipeline = (phase, reason) => {
      jobsTelemetry.pipeline = {
        ...(jobsTelemetry.pipeline || {}),
        phase,
        ts: Date.now(),
        active: false,
        pendingSources: [],
        error: String(reason ?? '').slice(0, 240),
      };
    };
    // Preflight I/O runs before the gather's guarded block; a throw here would
    // otherwise escape through handleSafe with the pipeline still marked active.
    const preflight = async (label, fn) => {
      try {
        return await fn();
      } catch (error) {
        retirePipeline('preflight-failed', `${label}: ${error?.message || error}`);
        throw error;
      }
    };
    // Record every job-source-progress we send, then send it. The trail is what
    // lets the bug report explain a "blocked source lost its resolve card" — it
    // shows whether the source ever emitted a clean 'done' (which auto-dismisses
    // the card) vs. only 'error', and how long after a failure the block warning
    // actually landed (the window the card spent failed-but-unflagged).
    const emitProgress = (payload) => {
      if (searchSuperseded) return;
      const correlatedPayload = activeRunId && payload?.nodeId === nodeId && !payload.jobRunId
        ? { ...payload, jobRunId: activeRunId }
        : payload;
      recordJobSourceProgress(correlatedPayload);
      if (!event.sender.isDestroyed()) event.sender.send('job-source-progress', correlatedPayload);
    };

    // ── Resume mode ─────────────────────────────────────────────────────────
    // Re-scrape ONLY the sources that didn't finish, each from its last completed
    // page, and seed the gathered set with the staged jobs from already-'done'
    // sources (so finished work isn't re-scraped). A fully gathered run is the
    // one exception: it has no remaining scrape work, so it resumes directly
    // from staging into the normal finalization/scoring path. Falls back to a
    // normal fresh search if there's no incomplete prior run.
    let resumeScope = null;       // Set<sourceId> to re-scrape (null = all = fresh run)
    let resumeStartPages = null;  // { [sourceId]: [{ startPage, durable }] }, aligned with exact queries
    let recoveredStaged = [];     // jobs recovered from the prior (crashed) run's staging
    let priorRunStartedAt = null; // crashed run's start — scopes the history exemption below
    // Durable, trusted source facts from providers that have already completed
    // and therefore must not be fetched again during this recovery.
    let resumedCollectionScopeCaveats = [];
    let resumedPageShapeFailures = {};
    let resumedWindowDropped = {};
    // compare-and-clear token returned to the renderer (allocated above so
    // preflight source progress remains correlated).
    let resumeSourceIds = null;   // persisted source breadth; never take it from a changed UI selection
    // A crash after gathering but before/during renderer-driven manual scoring
    // has no remaining scrape work. Do not make already-staged jobs depend on
    // a fresh browser/login preflight at restart: that can fail even though the
    // gather is complete and a network retry would only re-find seen listings.
    // This is deliberately narrower than general resume: any incomplete or
    // blocked source stays on the ordinary re-scrape recovery path below.
    let resumeGatheredOnly = false;
    // An explicit Finish action has the same downstream local processing as a
    // clean gathered recovery, but it preserves the truthful unfinished source
    // states and never advances full-coverage history.
    let skipProviderCollection = false;
    let collectionDisposition = null;
    let intentionallyUnfinishedSourceIds = [];
    // A gathered-only recovery must report the original provider-settled
    // boundary, not the later time at which staged rows are resumed/scored.
    // Otherwise a midnight-crossing resume could advance the next scan past
    // jobs posted after the original gather.
    let resumedCollectionCompletedAt = null;
    const hasExactResumeToken = resume === true
      && typeof resumeRunId === 'string'
      && resumeRunId.length > 0;
    const finishSavedRecoveryRequested = finishWithStaged === true;
    // Re-read the durable manifest at every ownership boundary. `setStage` and
    // the page writers already compare their expected token, but their boolean
    // result alone cannot protect a provider call that happens after another
    // run has replaced the sidecar. This helper is intentionally local to the
    // explicit-token path: legacy `resume: true` callers retain their historical
    // fallback semantics.
    const inspectExactResumeOwnership = async () => {
      if (!hasExactResumeToken) return null;
      const current = await preflight('verify exact recovery ownership', () => (
        readRunState(canvasFilePath, Date.now(), { nodeId })
      ));
      const failure = validateExactResumeRun(
        current,
        resumeRunId,
        normalizedProfileFingerprint,
        careerSnapshotId,
      );
      if (failure) return failure;
      if (current?.manifest?.inputs?.nodeId !== nodeId) {
        return {
          resumeRunMismatch: true,
          error: 'This recovery request belongs to a different Job Search card. Reload the recovery banner before continuing.',
        };
      }
      return null;
    };
    const exactResumeStageFailure = async () => {
      const observed = await inspectExactResumeOwnership();
      return observed || {
        resumeRunMismatch: true,
        error: 'This recovery checkpoint could not confirm ownership of the saved run. Reload the recovery banner before continuing.',
      };
    };
    const throwIfExactResumeSuperseded = async () => {
      const failure = await inspectExactResumeOwnership();
      if (!failure) return;
      const error = new Error(failure.error);
      Object.assign(error, failure, { exactResumeOwnershipFailure: true });
      throw error;
    };
    if (finishSavedRecoveryRequested && !hasExactResumeToken) {
      const error = 'Finishing with saved listings requires the exact saved Job Search checkpoint. Reload the Job Search card and try again.';
      retirePipeline('preflight-rejected', error);
      return { success: false, finishWithStagedInvalid: true, error };
    }
    const providerPhaseOnly = requestedProviderPhaseOnly === true;
    if (resume) {
      const prior = await preflight('read prior run state', () => readRunState(canvasFilePath, Date.now(), { nodeId }));
      // A token-bearing recovery must never degrade into a fresh search if its
      // manifest disappeared after the renderer peeked it.  Reject before
      // source derivation, durable staging, or any provider preflight; only
      // legacy resume callers with no explicit token retain the old fallback.
      const exactResumeFailure = validateExactResumeRun(
        prior,
        resumeRunId,
        normalizedProfileFingerprint,
        careerSnapshotId,
      );
      if (exactResumeFailure) {
        retirePipeline('preflight-rejected', exactResumeFailure.error);
        return { success: false, ...exactResumeFailure };
      }
      if (prior?.incomplete) {
        if (providerPhaseOnly && !isJobRunAutomaticRecoveryEligible(prior.manifest)) {
          const error = 'Background provider-only recovery requires an auto-resume-eligible saved run; manual or human-required sources stay paused.';
          retirePipeline('preflight-rejected', error);
          return { success: false, providerPhaseOnlyRejected: true, error };
        }
        const priorInputs = prior.manifest?.inputs || {};
        // A resume reuses staged provider rows, so it must be bound to the
        // same approved immutable corpus as the manifest that created them.
        // Do this before deriving sources, marking a partial finish, or any
        // provider preflight.  In particular, an old/legacy manifest with no
        // pin must not be revived under a newer renderer snapshot.
        const suppliedResumeCareerSnapshotId = normalizeCareerSnapshotIdentifier(careerSnapshotId);
        const manifestResumeCareerSnapshotId = normalizeCareerSnapshotIdentifier(priorInputs.careerSnapshotId);
        if (!suppliedResumeCareerSnapshotId
          || !manifestResumeCareerSnapshotId
          || suppliedResumeCareerSnapshotId !== manifestResumeCareerSnapshotId) {
          const error = 'This saved search belongs to a different or legacy career snapshot. Its checkpoint was kept; start a new search only after deliberately clearing it.';
          retirePipeline('preflight-rejected', error);
          return { success: false, resumeCareerSnapshotMismatch: true, error };
        }
        // A recovery owns the exact inclusive boundary captured when it began.
        // Legacy manifests predate `searchWindow`; upgrade their old rolling
        // setting once from the original run date rather than silently adopting
        // the current hub's newly-derived completion boundary.
        activeSearchWindow = effectiveJobSearchWindow(
          priorInputs.searchWindow,
          priorInputs.maxAgeDays,
          prior.manifest?.startedAt,
        );
        ageDays = activeSearchWindow.providerLookbackDays;
        // Restore the per-platform boundaries this run persisted. They were
        // already narrowed before being written, but narrow again against the
        // restored run window so a tampered/legacy manifest cannot widen it.
        activeSourceSearchWindows = narrowJobSearchSourceWindows(
          priorInputs.sourceSearchWindows,
          activeSearchWindow,
        );
        // A recovery continues the exact preferences that governed the
        // interrupted search. Editing the hub does not silently reinterpret
        // staged rows; the next explicit search uses the edit.
        if (Object.hasOwn(priorInputs, 'jobPreferences')) activeJobPreferences = String(priorInputs.jobPreferences || '').slice(0, 4000);
        if (Object.hasOwn(priorInputs, 'jobPreferencePlan')) activeJobPreferencePlan = normalizeJobPreferencePlan(priorInputs.jobPreferencePlan);
        const priorRunId = prior.manifest?.runId || null;
        if (!priorInputs.nodeId || priorInputs.nodeId !== nodeId) {
          const error = 'This unfinished search belongs to a different Job Search card. Recover it from its owning card, or use Clear career data there before intentionally starting a new search.';
          retirePipeline('preflight-rejected', error);
          return { success: false, resumeNodeMismatch: true, error };
        }
        // `rebindRunOperationAuthority` owns the authority -> checkpoint ->
        // manifest transaction. Do not acquire this lock here: re-entering the
        // same per-hub lock would deadlock the durable S1->S2 adoption.
        await assertSearchCurrent();
        const rebindAdmission = await rebindRunOperationAuthority(canvasFilePath, {
          expectedRunId: prior.manifest.runId,
          expectedNodeId: nodeId,
          careerSnapshotId: suppliedResumeCareerSnapshotId,
          currentAuthority: authorityReceipt,
        });
        if (rebindAdmission?.ok !== true) {
          const error = 'This saved search cannot be adopted by the current resume operation. Its checkpoint was kept.';
          retirePipeline('preflight-rejected', error);
          return { success: false, resumeOperationAuthorityMismatch: true, error };
        }
        const hasRecordedLocation = Object.hasOwn(priorInputs, 'canonicalLocation');
        const priorLocation = normalizeLocationInput(priorInputs.canonicalLocation).boardReady;
        const currentLocation = normalizeLocationInput(location).boardReady;
        if (!hasRecordedLocation || priorLocation !== currentLocation) {
          const error = hasRecordedLocation
            ? `This unfinished search targeted "${priorLocation || 'no location'}", but the hub now targets "${currentLocation || 'no location'}". Its checkpoint was kept; use Clear career data before deliberately starting a new location search.`
            : 'This unfinished search predates location-safe resume metadata. Its checkpoint was kept; use Clear career data before deliberately starting a new location search.';
          retirePipeline('preflight-rejected', error);
          return { success: false, resumeLocationMismatch: true, error };
        }
        if (JSON.stringify(priorInputs.queries || []) !== JSON.stringify(queries)) {
          const error = 'This unfinished search used different queries. Its checkpoint was kept; use Clear career data before deliberately starting with changed queries.';
          retirePipeline('preflight-rejected', error);
          return { success: false, resumeQueryMismatch: true, error };
        }
        // The interrupted run owns both breadth and collection limits. Current
        // platform toggles must never add/remove sources from a recovery, and a
        // saved null is meaningful (unlimited under the then-current policy).
        if (Object.hasOwn(priorInputs, 'collectionLimits')) {
          normalizedCollectionLimits = normalizeJobCollectionLimits(prior.manifest.inputs.collectionLimits);
        }
        const priorSources = prior.manifest.sources || {};
        resumedCollectionScopeCaveats = collectionScopeCaveatsFromCompletedManifestSources(priorSources);
        // A finished source isn't fetched again, so its unreadable-page count comes from the manifest.
        resumedPageShapeFailures = Object.fromEntries(Object.entries(priorSources)
          .filter(([sid, source]) => ACTIVE_SOURCE_ID_SET.has(sid) && source?.status === 'done' && Number.isSafeInteger(source.pageShapeFailures) && source.pageShapeFailures > 0)
          .map(([sid, source]) => [sid, source.pageShapeFailures]));
        // A finished source's window-dropped dated cards also come from the
        // manifest: they keep the posted-date check's denominator honest.
        resumedWindowDropped = Object.fromEntries(Object.entries(priorSources)
          .filter(([sid, source]) => ACTIVE_SOURCE_ID_SET.has(sid) && source?.status === 'done' && Number.isSafeInteger(source.windowDropped) && source.windowDropped > 0)
          .map(([sid, source]) => [sid, source.windowDropped]));
        resumeSourceIds = Object.keys(priorSources).filter(sourceId => ACTIVE_SOURCE_ID_SET.has(sourceId));
        recoveredStaged = prior.stagedJobs.map(s => ({ ...s.job, source: s.sourceId }));
        if (finishSavedRecoveryRequested && recoveredStaged.length === 0) {
          const error = 'There are no saved listings to finish. Resume the remaining sources instead.';
          retirePipeline('preflight-rejected', error);
          return { success: false, noSavedListings: true, error };
        }
        // Finish is allowed to score a durable ledger even when every original
        // provider has since been removed from this app version. It dispatches
        // no providers and retains the exact staged rows; ordinary Resume still
        // needs at least one supported source to continue collection.
        if (resumeSourceIds.length === 0 && !finishSavedRecoveryRequested) {
          const error = 'None of this unfinished search’s original job platforms are available in this app version. The checkpoint was kept; use Clear career data before deliberately using the current platform selection.';
          retirePipeline('preflight-rejected', error);
          return { success: false, noResumablePlatforms: true, error };
        }
        activeSourceIds = resumeSourceIds;
        activeRunId = priorRunId;
        jobsTelemetry.pipeline = { ...(jobsTelemetry.pipeline || {}), runId: activeRunId, ts: Date.now() };
        priorRunStartedAt = prior.manifest.startedAt ?? null;
        const alreadyFinishedWithSavedListings = isRunCollectionFinishedWithSavedListings(prior.manifest);
        if (finishSavedRecoveryRequested) {
          // Persist the voluntary early-finish decision BEFORE any role screen,
          // preference evaluation, or renderer-side scoring. A crash after this
          // point therefore resumes the same saved listings without re-opening
          // a provider, and leaves pending/blocked source status truthful.
          await assertSearchCurrent();
          const finishReceipt = await preflight('mark saved-listing finish', () => (
            finishRunWithSavedListings(canvasFilePath, {
              expectedRunId: activeRunId,
              nodeId,
              expectedOperationAuthority: authorityReceipt,
              now: Date.now(),
            })
          ));
          if (finishReceipt?.ok !== true) {
            const error = finishReceipt?.tokenMismatch
              ? 'This saved checkpoint changed before it could be finished. Reload the Job Search card and try again.'
              : 'Could not safely mark this saved checkpoint as finished. No provider was contacted.';
            retirePipeline('preflight-rejected', error);
            return {
              success: false,
              ...(finishReceipt?.tokenMismatch ? { resumeRunMismatch: true } : {}),
              finishWithStagedFailed: true,
              error,
            };
          }
          collectionDisposition = finishReceipt.collectionDisposition || null;
          resumedCollectionCompletedAt = finishReceipt.collectionCompletedAt ?? null;
          intentionallyUnfinishedSourceIds = Array.isArray(finishReceipt.unfinishedSourceIds)
            ? finishReceipt.unfinishedSourceIds
            : [];
        } else if (alreadyFinishedWithSavedListings) {
          collectionDisposition = prior.manifest.collectionDisposition;
          resumedCollectionCompletedAt = collectionCompletedAtForManifest(prior.manifest);
          intentionallyUnfinishedSourceIds = Object.entries(priorSources)
            .filter(([, source]) => source?.status !== 'done' && source?.status !== 'skipped')
            .map(([sourceId]) => sourceId);
        }
        // Keep this narrowly tied to a naturally clean gathered checkpoint.
        // Forced partial finish uses the same local/no-network branch below,
        // but still appends its score-safe final rows to the durable ledger.
        resumeGatheredOnly = !finishSavedRecoveryRequested
          && canRecoverGatheredRunDirectly(prior.manifest, queries);
        skipProviderCollection = finishSavedRecoveryRequested || resumeGatheredOnly;
        if (resumeGatheredOnly && resumedCollectionCompletedAt == null) {
          resumedCollectionCompletedAt = collectionCompletedAtForManifest(prior.manifest);
        }
        resumeScope = new Set();
        resumeStartPages = {};
        if (!skipProviderCollection) {
          for (const sid of activeSourceIds) {
            if (priorSources[sid]?.status === 'done' || priorSources[sid]?.status === 'skipped') continue; // complete — reuse its staged jobs
            resumeScope.add(sid);
            // Each query resumes from its own durable cursor. Only the exact
            // query without a cursor falls back to page 1.
            resumeStartPages[sid] = computeResumeStartPagesByQuery(priorSources[sid], queries);
          }
        }
        const recoveryPlan = finishSavedRecoveryRequested
          ? 'finish with saved listings without network'
          : resumeGatheredOnly
            ? 'recover gathered jobs without network'
            : `re-scrape [${[...resumeScope].join(',') || 'none'}] from ${JSON.stringify(resumeStartPages)}`;
        logger.info(`[Jobs][${nodeId}] Resume: ${recoveryPlan}; recovered ${recoveredStaged.length} staged job(s)`);
      } else {
        logger.info(`[Jobs][${nodeId}] Resume requested but no incomplete prior run — running a fresh search.`);
      }
    }

    if (hasExactResumeToken && resumeScope !== null) {
      // Resume itself is the user's/automatic recovery claim. Re-arm this
      // exact manifest before any login wait, provider dispatch, or gathered-
      // only scoring work so a second crash continues automatically too. A
      // manually paused checkpoint reaches here only after its explicit Resume
      // action supplied the exact token.
      await assertSearchCurrent();
      const activation = await preflight('activate exact recovery', () => (
        activateRunForResume(canvasFilePath, {
          expectedRunId: activeRunId,
          nodeId,
          expectedOperationAuthority: authorityReceipt,
          now: Date.now(),
        })
      ));
      if (activation?.ok !== true || activation?.activated !== true) {
        const failure = await exactResumeStageFailure();
        retirePipeline('recovery-superseded', failure.error);
        return { success: false, ...failure };
      }
    }

    // Evaluate platform safety only after resume has restored its saved breadth.
    // This is also the main-process enforcement boundary for renderer bypasses.
    activeSourceIds = resumeSourceIds || getRunnableJobSourceIds(
      getEnabledJobSourceIds(enabledSourceIds, ACTIVE_SOURCE_IDS),
      ACTIVE_SOURCE_IDS,
      normalizedCollectionLimits,
    );
    const providerPhaseSourceIds = backgroundBoardProviderBootstrap
      ? new Set(activeSourceIds)
      : resumeScope;
    const providerPhaseAllowedSourceIds = backgroundBoardProviderBootstrap
      ? BACKGROUND_PROVIDER_ONLY_SOURCE_IDS
      : EXACT_RESUME_PROVIDER_ONLY_SOURCE_IDS;
    if (providerPhaseOnly && (
      (!hasExactResumeToken && !backgroundBoardProviderBootstrap)
      || finishSavedRecoveryRequested
      || !(providerPhaseSourceIds instanceof Set)
      || providerPhaseSourceIds.size === 0
      || [...providerPhaseSourceIds].some(sourceId => !providerPhaseAllowedSourceIds.has(sourceId))
    )) {
      const error = 'Background provider-only recovery requires an exact saved run whose unfinished sources are supported for that recovery mode.';
      retirePipeline('preflight-rejected', error);
      return { success: false, providerPhaseOnlyRejected: true, error };
    }
    if (activeSourceIds.length === 0 && !(skipProviderCollection && recoveredStaged.length > 0)) {
      const error = 'Select at least one enabled job platform before running the search.';
      retirePipeline('preflight-rejected', error);
      return { success: false, noPlatformsSelected: true, error };
    }
    const sourceCountryPolicies = summarizeJobSourceCountryPolicies(activeSourceIds, location);
    const sourceCountryPolicyById = Object.fromEntries(sourceCountryPolicies.map(policy => [policy.sourceId, policy]));
    // A saved-ledger-only continuation does not contact providers, so present
    // country/app-version policy must not discard rows that were validly
    // collected under this run's original, already-verified location.
    const countryApplicableSourceIds = skipProviderCollection
      ? new Set(activeSourceIds)
      : new Set(sourceCountryPolicies.filter(policy => policy.include).map(policy => policy.sourceId));
    // A non-empty selection is not necessarily a runnable search. For example,
    // Dice is a valid enabled platform but this integration is intentionally
    // excluded from Canada-scoped hubs. Letting an all-inapplicable selection
    // continue produces zero tasks, marks the source "done", and returns a
    // successful empty run — the renderer then replaces a prior populated board
    // and last-good snapshot even though no query was attempted. Reject before
    // login checks, run staging, or snapshot work, while still giving every
    // selected source a visible skipped card with the exact policy reason.
    if (!skipProviderCollection && countryApplicableSourceIds.size === 0) {
      for (const policy of sourceCountryPolicies) {
        const warning = {
          code: 'country-source-skipped',
          severity: 'info',
          evidence: policy.reason,
          suggestion: `Choose a platform that supports ${policy.location.boardReady || policy.location.country || 'this target'}, or run a separate United States hub for U.S.-only sources.`,
        };
        emitProgress({
          nodeId,
          sourceId: policy.sourceId,
          status: 'skipped',
          count: 0,
          warning,
          completed: 1,
          total: 1,
        });
      }
      const selected = sourceCountryPolicies.map(policy => policy.sourceId).join(', ');
      const target = sourceCountryPolicies[0]?.location?.boardReady || location || 'the selected location';
      const error = `None of the selected job platforms (${selected}) can run for ${target}. Choose at least one location-compatible platform; no prior results were changed.`;
      retirePipeline('preflight-rejected', error);
      return {
        success: false,
        noCountryApplicablePlatforms: true,
        sourcePolicies: sourceCountryPolicies,
        error,
      };
    }
    const browserJobPlatforms = activeSourceIds
      .filter(sourceId => ['indeed', 'glassdoor', 'ziprecruiter'].includes(sourceId))
      .filter(sourceId => countryApplicableSourceIds.has(sourceId));
    // Completed sources are recovered from the ledger and are never contacted
    // by this resume. Their current login state must not manufacture a new
    // block or prevent another unfinished provider from continuing.
    const authPreflightSourceIds = jobSourceAuthPreflightScope(browserJobPlatforms, resumeScope);
    // A gathered-only recovery has no browser/API work left. In particular, do
    // not turn a stale startup verifier result into an auth gate for data that
    // is already durably staged and about to be scored locally/manual-AI.
    if (!skipProviderCollection) {
      await preflight('await pending startup session verification', () => (
        waitForPendingPlatformVerification(authPreflightSourceIds)
      ));
    }
    const cache = skipProviderCollection ? {} : await preflight('read session status cache', () => readStatusCache());
    // LinkedIn's public listing feed is still guest-accessible, but description
    // enrichment can use a positively verified profile session. Pass this as a
    // preference rather than an assumption: the extractor falls back to the
    // guest SEO representation if the cached session no longer renders a JD.
    const preferLinkedInAuthenticated = cache.linkedin?.connected === true;
    const notLoggedIn = authPreflightSourceIds.filter(sourceId => !cache[sourceId]?.connected);
    // A fresh search intentionally remains all-or-nothing at this boundary: it
    // has no durable work yet, and beginning a new collection while one of its
    // required authenticated providers is unavailable would make its coverage
    // ambiguous. A crash-resume is different. It already owns a checkpoint and
    // may have thousands of staged rows plus other unfinished sources that can
    // safely continue. Treat each missing login as that source's durable block,
    // rather than rejecting the whole recovery before it can reuse any work.
    const loginBlockedSourceIds = new Set(
      !skipProviderCollection && resumeScope !== null ? notLoggedIn : [],
    );
    if (!skipProviderCollection && notLoggedIn.length > 0 && loginBlockedSourceIds.size === 0) {
      const error = `Not logged in to: ${notLoggedIn.join(', ')}. ${indeedPreflightObservationNote(notLoggedIn)}Open Settings → Job Platforms to connect.`;
      retirePipeline('preflight-rejected', error);
      return { success: false, notLoggedIn, error };
    }
    if (loginBlockedSourceIds.size > 0) {
      logger.info(`[Jobs][${nodeId}] Resume continuing without logged-out source(s): ${[...loginBlockedSourceIds].join(', ')}`);
    }
    const limitsDescription = describeJobCollectionLimits(normalizedCollectionLimits);
    logger.info(`[Jobs][${nodeId}] Searching with`, queries.length, `queries across ${activeSourceIds.length} selected source(s) (origin=${normalizedRunOrigin}, careerInput=${normalizedProfileInputMode}, windowStart=${new Date(activeSearchWindow.startTimestamp).toISOString()}, providerLookback=${ageDays}d, jobs/platform=${limitsDescription.jobs}, browser pages/query=${limitsDescription.pages}, location=${location || 'none'})`);
    // `jobsTelemetry.search` is only stamped once the funnel finishes, so an
    // aborted or crashed gather left the report saying "no search recorded this
    // session" for a run whose own log proves it launched — the exact case
    // where the inputs matter most. Record the INTENT under its own key: it
    // must not be `search`, because that key means "the funnel produced these
    // counts" and is a run-correlation token everywhere downstream.
    jobsTelemetry.searchIntent = {
      ts: Date.now(),
      runId: activeRunId,
      nodeId,
      runOrigin: normalizedRunOrigin,
      profileInputMode: normalizedProfileInputMode,
      queries: queries.length,
      queryStrings: Array.isArray(queries) ? queries.slice(0, 12) : [],
      selectedSourceIds: activeSourceIds.slice(0, 25),
      searchWindow: activeSearchWindow,
      sourceSearchWindows: activeSourceSearchWindows,
      appliedInitialLookbackDays,
      maxAgeDays: ageDays,
      collectionLimits: normalizedCollectionLimits,
      location: location || '',
      ...(collectionDisposition ? { collectionDisposition } : {}),
    };

    // Country applicability is enforced before any source request. On resume,
    // intersect it with the unfinished-source scope so an older staged run cannot
    // reintroduce a now-inapplicable source (for example Dice on a Canada hub).
    const requestedSourceScope = resumeScope || new Set(activeSourceIds);
    const requestedRunnableSourceScope = new Set(
      [...requestedSourceScope].filter(sourceId => countryApplicableSourceIds.has(sourceId)),
    );
    // This is the actual dispatch scope. Keep the broader requested scope
    // above solely to retain a first URL for each login-blocked source card.
    const runnableSourceScope = new Set(
      [...requestedRunnableSourceScope].filter(sourceId => !loginBlockedSourceIds.has(sourceId)),
    );
    // Keep the blocked source's first provider URL even though it receives no
    // task. Its card can then offer a privacy-safe "Open sign-in page" action
    // without guessing an account URL or retaining any session detail.
    // Queries a platform already finished in an earlier run that was blocked
    // part-way (the card sends them only while that platform's date has not
    // moved). A fresh run leaves them out and starts at the first query that
    // never finished, so a block on query 1 cannot keep the later queries from
    // ever running. Crash recovery has its own exact per-page ledger instead.
    const carriedQueriesBySource = {};
    let carriedQueryPlans = null;
    if (!resume && !resumeStartPages && !recoveredPreSearchWindow && !backgroundBoardProviderBootstrap
      && !skipProviderCollection && sourceFinishedQueries && typeof sourceFinishedQueries === 'object') {
      for (const sourceId of activeSourceIds) {
        if (sourceId !== 'linkedin' && !BROWSER_SCRAPE_ORDER.includes(sourceId)) continue;
        if (!Object.hasOwn(sourceFinishedQueries, sourceId) || !Array.isArray(sourceFinishedQueries[sourceId])) continue;
        const finished = new Set(sourceFinishedQueries[sourceId].filter(query => typeof query === 'string' && query));
        const remaining = queries.filter(query => !finished.has(query));
        // Nothing to skip, or nothing left to run: walk every query as usual.
        if (remaining.length === 0 || remaining.length === queries.length) continue;
        if (sourceId === 'linkedin') carriedQueriesBySource.linkedin = remaining;
        else {
          (carriedQueryPlans ||= {})[sourceId] = queries.map(query => ({
            startPage: 1, durable: false, terminal: finished.has(query),
          }));
        }
        logger.info(`[Jobs][${nodeId}] ${sourceId}: skipping ${queries.length - remaining.length} of ${queries.length} queries an earlier blocked run already finished`);
      }
    }
    const queryPlans = resumeStartPages || carriedQueryPlans;
    // Listings the browser platforms need not open again: the ones already
    // shown on an earlier run (the history step drops those in any case) and
    // the ones an earlier blocked run of the same platform already read. The
    // read list is honoured under the same conditions as the finished queries
    // above; the shown list applies to every run.
    const alreadyReadBySource = {};
    if (!skipProviderCollection) {
      let seenListing = null;
      if (canvasFilePath) {
        try {
          seenListing = createSeenListingMatcher(await loadJobsHistory(canvasFilePath));
        } catch (error) {
          logger.warn(`[Jobs][${nodeId}] Seen-listing lookup unavailable; every listing will be opened: ${error?.message || error}`);
        }
        await assertSearchCurrent();
      }
      const readKeysAllowed = !resume && !resumeStartPages && !recoveredPreSearchWindow
        && !backgroundBoardProviderBootstrap && sourceReadKeys && typeof sourceReadKeys === 'object';
      for (const sourceId of activeSourceIds) {
        if (!BROWSER_SCRAPE_ORDER.includes(sourceId)) continue;
        const readKeys = readKeysAllowed && Object.hasOwn(sourceReadKeys, sourceId) && Array.isArray(sourceReadKeys[sourceId])
          ? new Set(sourceReadKeys[sourceId].filter(key => typeof key === 'string' && key))
          : null;
        if (!seenListing && !(readKeys?.size > 0)) continue;
        // A card read off the page carries no platform name yet, and both
        // lookups key on it, so name the platform before asking.
        alreadyReadBySource[sourceId] = (job) => {
          const card = job?.source ? job : { ...job, source: sourceId };
          if (readKeys?.has(sourceJobKey(card)) === true) return 'read';
          return seenListing?.(card) === true ? 'shown' : false;
        };
        if (readKeys?.size > 0) {
          logger.info(`[Jobs][${nodeId}] ${sourceId}: ${readKeys.size} listing(s) an earlier blocked run already read will not be opened again`);
        }
      }
    }
    // Listings a platform still owes from before its date moved (see
    // applySourceSkipToPendingCoverage). Their cards are opened whatever their
    // date, so a card that turns up again is not lost to the window.
    const owedBySource = {};
    if (!skipProviderCollection && sourceOwedKeys && typeof sourceOwedKeys === 'object') {
      for (const sourceId of activeSourceIds) {
        if (!BROWSER_SCRAPE_ORDER.includes(sourceId) || !Object.hasOwn(sourceOwedKeys, sourceId)) continue;
        const owedKeys = new Set((Array.isArray(sourceOwedKeys[sourceId]) ? sourceOwedKeys[sourceId] : [])
          .filter(key => typeof key === 'string' && key));
        if (owedKeys.size === 0) continue;
        owedBySource[sourceId] = job => owedKeys.has(sourceJobKey(job?.source ? job : { ...job, source: sourceId }));
        logger.info(`[Jobs][${nodeId}] ${sourceId}: ${owedKeys.size} listing(s) still owed from an earlier scan will be opened if they turn up`);
      }
    }
    const candidateTasks = buildJobTasks(queries, ageDays, {
      onlySources: requestedRunnableSourceScope,
      alreadyReadBySource,
      owedBySource,
      ...(queryPlans ? { startPageBySourceQuery: queryPlans } : {}),
      collectionStartTimestamp: activeSearchWindow.startTimestamp,
      maxAgeDaysBySource: ageDaysBySource(),
      collectionStartTimestampBySource: postedSinceBySource(),
    }, location, normalizedCollectionLimits, countryScope);
    const tasks = candidateTasks.filter(task => runnableSourceScope.has(task.sourceId));

    // Group tasks by source for per-source progress tracking
    const sourceTaskIds = {};
    // First scrape URL per source — sent on completion events so the source
    // card's Solve button has a target to open in the cookie-sharing browser
    // (mirrors marketplace's CompSourceCardNode `progress.url` flow).
    const sourceFirstUrl = {};
    const sourceBlockedUrls = {}; // sourceId → [url, ...] in task order
    const taskUrlById = {};       // task id → its scrape URL (for sequential solve)
    for (const t of candidateTasks) {
      if (!sourceFirstUrl[t.sourceId]) sourceFirstUrl[t.sourceId] = t.url;
    }
    for (const t of tasks) {
      if (!sourceTaskIds[t.sourceId]) sourceTaskIds[t.sourceId] = [];
      sourceTaskIds[t.sourceId].push(t.id);
      taskUrlById[t.id] = t.url;
    }

    // Notify frontend that sources are starting. Include `url` from the
    // first task per source so the JobSourceCardNode's `progress.url` is
    // populated from event #1 — without this, a captcha that hits mid-scrape
    // delivers its warning event BEFORE the per-source completion loop fires
    // (which is the only path that previously carried url), so the card's
    // Solve button stayed hidden until every other source had finished.
    for (const sourceId of Object.keys(sourceTaskIds)) {
      emitProgress({
        nodeId, sourceId, status: 'searching', count: 0,
        completed: 0,
        total: sourceTaskIds[sourceId]?.length || 1,
        url: sourceFirstUrl[sourceId] || null,
      });
    }

    const allJobs = [];
    const sourceResults = {};
    for (const sourceId of loginBlockedSourceIds) {
      const sourceName = JOB_SOURCE_DISPLAY_NAMES[sourceId] || sourceId;
      const warning = {
        code: 'login-required',
        severity: 'block',
        // Do not expose cache values, cookies, account identifiers, or the
        // verifier's raw failure. The actionable fact is enough for recovery.
        evidence: `${sourceName} is not connected in Job Platform Logins.`,
        suggestion: `Log in to ${sourceName} in Settings → Job Platform Logins, then retry the remaining saved sources. Other staged and eligible-source results were kept.`,
        action: 'login-platform',
        platformId: sourceId,
        actionLabel: 'Log in',
        actionTitle: `Open ${sourceName}'s verified Job Platform Login window. After it confirms sign-in, retry this saved search.`,
      };
      // Match every other resumable source-results entry: recovered staged
      // rows may be appended below, then flow through the normal page/stop
      // merge without a special login-only shape.
      sourceResults[sourceId] = {
        jobs: [], errors: 0, warnings: [warning], pagesWalked: 0, stopReasons: new Set(),
      };
      emitProgress({
        nodeId,
        sourceId,
        status: 'error',
        count: 0,
        completed: 0,
        total: getQueryProgressTotal(queries),
        url: sourceFirstUrl[sourceId] || null,
        warning,
      });
    }
    for (const policy of sourceCountryPolicies) {
      if (policy.include || skipProviderCollection) continue;
      sourceResults[policy.sourceId] = {
        jobs: [],
        errors: 0,
        warnings: [{
          code: 'country-source-skipped',
          severity: 'info',
          evidence: policy.reason,
          suggestion: `This source is intentionally not queried for ${policy.location.boardReady || policy.location.country || 'this target'}. Run a separate United States hub to include U.S.-only sources.`,
        }],
      };
    }
    hydrateCollectionScopeCaveatsIntoSourceResults(sourceResults, resumedCollectionScopeCaveats);
    for (const [sid, pages] of Object.entries(resumedPageShapeFailures)) {
      const result = sourceResults[sid] || (sourceResults[sid] = { jobs: [], errors: 0, warnings: [], pagesWalked: 0, stopReasons: new Set() });
      result.pageShapeFailures = (result.pageShapeFailures || 0) + pages;
    }
    for (const [sid, dropped] of Object.entries(resumedWindowDropped)) {
      const result = sourceResults[sid] || (sourceResults[sid] = { jobs: [], errors: 0, warnings: [], pagesWalked: 0, stopReasons: new Set() });
      result.windowDropped = (result.windowDropped || 0) + dropped;
    }

    // Resume: seed the gathered set with jobs recovered from the prior run's
    // staging so 'done' sources aren't re-scraped and incomplete sources keep the
    // pages already captured before the interruption (re-scraping only adds deeper pages).
    // The staging file is append-only chronological, so when the same job appears
    // twice the LAST copy wins — post-enrichment re-stages (LinkedIn descriptions)
    // append after the bare gather-time rows, and the enriched copy is the one
    // worth recovering. First-seen order is preserved (Map insertion semantics).
    const recoveredByKey = new Map();
    for (const j of recoveredStaged) {
      if (!skipProviderCollection && !countryApplicableSourceIds.has(j.source)) continue;
      // Google now replaces its brittle internal card route with the chosen
      // Apply-on URL after enrichment.  That public URL is intentionally free
      // to change between provider mirrors; sourceJobKey retains Google’s
      // htidocid so a resumed run still replaces the older staged copy instead
      // of reintroducing the same listing as a second job.
      recoveredByKey.set(`${j.source || '?'}|${sourceJobKey(j)}`, j);
    }
    for (const j of recoveredByKey.values()) {
      const sid = j.source || '?';
      // Seed the full shape the manual-result loop below assumes: a resumed
      // source is re-scraped, so its entry reaches the pagesWalked/stopReasons
      // merge and must already carry both fields.
      if (!sourceResults[sid]) sourceResults[sid] = { jobs: [], errors: 0, warnings: [], pagesWalked: 0, stopReasons: new Set() };
      sourceResults[sid].jobs.push(j);
      allJobs.push(j);
    }

    // ── Crash/quit recovery staging ───────────────────────────────────────────
    // A FRESH run writes a new manifest + truncates staging; a RESUME keeps the
    // existing manifest/staging and appends the newly-scraped pages. All calls
    // no-op without a canvas path. stageOnPage flushes each page as it completes;
    // HTTP sources are flushed per-source after they finish (below).
    const runStartedAt = initialRunStartedAt;
    let stagingStarted = false;
    if (resumeScope) {
      // Keep the recovered manifest/staging and its original run token intact.
      // A gathered-only recovery has no page work to record; changing its stage
      // or starting a fresh run here would truncate the very rows it must score.
      if (!skipProviderCollection) {
        // `setJobRunStage` owns the single authority→manifest transaction.
        // Wrapping it here would queue a second non-reentrant authority lock.
        await assertSearchCurrent();
        const stageAdvanced = await setJobRunStage(canvasFilePath, 'searching', runStartedAt, {
          expectedRunId: activeRunId, nodeId, expectedOperationAuthority: authorityReceipt,
        });
        // Do not ignore a failed compare-and-set. If the manifest vanished or
        // was replaced between the renderer peek and this checkpoint, a
        // recovery must stop here rather than dispatching a provider under an
        // old token.
        if (stageAdvanced !== true) {
          if (!await searchIsCurrent()) return searchSupersededResult();
          if (!hasExactResumeToken) return searchSupersededResult();
          const failure = await exactResumeStageFailure();
          retirePipeline('recovery-superseded', failure.error);
          return { success: false, ...failure };
        }
      }
      // A resume reached this branch only after readRunState found its manifest.
      stagingStarted = !!canvasFilePath;
    } else {
      // Manifest creation is a durable provider admission. Keep it inside the
      // same host authority transaction as the exact receipt check; S2 cannot
      // acknowledge between S1 validation and the manifest rename.
      const manifestAdmission = await withCurrentJobAnalysisOperationAuthority({
        canvasFilePath, hubId: nodeId, ...authorityReceipt,
      }, () => startJobRun(canvasFilePath, {
        runId: activeRunId,
        startedAt: runStartedAt,
        queries,
        careerSnapshotId: careerSnapshotId || null,
        profileFingerprint: normalizedProfileFingerprint || null,
        jobPreferences: activeJobPreferences,
        jobPreferencePlan: activeJobPreferencePlan,
        searchWindow: activeSearchWindow,
        sourceSearchWindows: activeSourceSearchWindows,
        // Compatibility for app versions that can read this manifest but do
        // not yet understand its exact searchWindow object.
        maxAgeDays: ageDays,
        canonicalLocation: location,
        collectionLimits: normalizedCollectionLimits,
        nodeId,
        sourceIds: activeSourceIds,
        requireCareerSnapshot: true,
        operationAuthority: authorityReceipt,
      }));
      const startedRun = manifestAdmission.admitted
        ? manifestAdmission.value
        : { rejected: true, operationSuperseded: true };
      stagingStarted = startedRun?.runId === activeRunId;
      // A saved canvas must have a durable manifest before any source request.
      // Continuing after a failed start used to allow an un-recoverable search to
      // paint a terminal zero and replace prior board results with no forensic
      // record. Unsaved canvases intentionally retain the no-sidecar behavior.
      if (startedRun?.conflict) {
        const ownerLabel = startedRun.ownerNodeId
          ? `Job Search hub ${startedRun.ownerNodeId}`
          : 'an older Job Search run with an unknown owner';
        const error = `${ownerLabel} has unfinished recovery data. Resume it or finish with its saved listings; use Clear career data only if you intentionally want to remove it.`;
        // `startRun` rejected this request under the manifest lock. Restore the
        // previous process-global owner rather than publishing B's short-lived
        // preparing token over A's valid Solve/recovery diagnostics.
        restoreJobsTelemetryIfCurrentRun(nodeId, activeRunId, priorJobsTelemetry);
        logger.warn(`[Jobs][${nodeId}] ${error}`);
        return {
          success: false,
          stagingConflict: true,
          ownerNodeId: startedRun.ownerNodeId || null,
          ownerUnknown: startedRun.ownerUnknown === true,
          error,
        };
      }
      if (startedRun?.rejected === true) {
        const error = 'An approved immutable career snapshot is required before a Job Search recovery manifest can be created.';
        restoreJobsTelemetryIfCurrentRun(nodeId, activeRunId, priorJobsTelemetry);
        logger.warn(`[Jobs][${nodeId}] ${error}`);
        return { success: false, careerSnapshotMissing: true, error };
      }
      if (canvasFilePath && !startedRun) {
        const error = 'Could not initialize durable job-run recovery for this saved canvas. No job sources were queried and existing results were left unchanged.';
        restoreJobsTelemetryIfCurrentRun(nodeId, activeRunId, priorJobsTelemetry);
        logger.warn(`[Jobs][${nodeId}] ${error}`);
        return { success: false, stagingStartFailed: true, error };
      }
      // The run ID is also the correlation token for the in-memory funnel and
      // saved analysis snapshot. It deliberately survives a missing/failed
      // crash-recovery manifest: diagnostics still need to distinguish this
      // search from the prior one even when staging is unavailable.
    }
    // A fresh provider run closes the previous displayed generation. Resume
    // can retry a failed boundary write, but never marks its own displayed
    // rows seen. Re-scoring/combining saved jobs never enters this path.
    const historyAdmission = await withCurrentJobAnalysisOperationAuthority({
      canvasFilePath, hubId: nodeId, ...authorityReceipt,
    }, () => finalizeDisplayedJobsHistory(canvasFilePath, nodeId, { excludeRunId: activeRunId }));
    if (!historyAdmission.admitted) return searchSupersededResult();
    jobsTelemetry.pipeline = {
      ...(jobsTelemetry.pipeline || {}),
      runId: activeRunId,
      stagingStarted,
      ts: Date.now(),
    };
    // The process-global manual-browser telemetry is reset only when this run
    // owns the shared-profile lock below. Resetting here would let a second hub
    // wipe the first hub's in-flight diagnostics while it waits in the FIFO.
    // Rows a query returned without a readable description. Such a query has
    // been walked but not fully read, so it is not reported as finished.
    const unreadRowsByQuery = {};
    const stageOnPage = async ({ sourceId, query, queryIndex = null, page, jobs, terminal = false }) => {
      if (Number.isSafeInteger(queryIndex) && Array.isArray(jobs)) {
        const unread = jobs.filter(job => job?.descriptionDeferredReason || !hasResolvedJobDescription(job)).length;
        if (unread > 0) {
          const key = `${sourceId}#${queryIndex}`;
          unreadRowsByQuery[key] = (unreadRowsByQuery[key] || 0) + unread;
        }
      }
      await assertSearchCurrent();
      await beforeSearchStageWrite({ phase: 'before-page-stage', sourceId, nodeId, runId: activeRunId });
      await assertSearchCurrent();
      const saved = await recordSourcePage(canvasFilePath, {
        sourceId, query, queryIndex, page, jobs, terminal, now: Date.now(), expectedRunId: activeRunId, nodeId,
        expectedOperationAuthority: authorityReceipt,
      });
      await assertSearchCurrent();
      // Unsaved canvases deliberately have no sidecar, so recordSourcePage is
      // a no-op there. A saved canvas must never continue past a failed write.
      if (canvasFilePath && saved !== true) throw new Error(`Could not durably checkpoint ${sourceId} query page ${page}.`);
    };

    // Close the interval after the searching-stage compare-and-set and before
    // either browser or HTTP work is scheduled. Individual source dispatches
    // repeat this fence because a browser can wait behind the shared profile
    // lock while another run changes the durable manifest.
    if (hasExactResumeToken) {
      const failure = await inspectExactResumeOwnership();
      if (failure) {
        retirePipeline('recovery-superseded', failure.error);
        return { success: false, ...failure };
      }
    }

    // 1. Run browser collection (manual) and API sources concurrently.
    // Individual API source failures (e.g. Dice 500) are source-level errors —
    // they return 0 jobs with a warning and do NOT abort the pipeline.
    // The internal signal stops/drains the sibling branch when a fatal shared
    // durability failure occurs. It also guarantees a real AbortSignal when
    // the caller did not provide one.
    const pipelineAbort = new AbortController();
    const combinedSignal = AbortSignal.any([pipelineAbort.signal, signal].filter(s => s instanceof AbortSignal));
    const throwIfSearchAborted = async () => {
      if (!combinedSignal.aborted) return;
      const reason = combinedSignal.reason instanceof Error
        ? combinedSignal.reason
        : Object.assign(new Error('Search aborted'), { name: 'AbortError' });
      // Reset or hub deletion uses the explicit "Node deleted" sentinel. Those
      // are intentional abandonment and remove only this run's sidecars. A
      // user-stopped run is different: it deliberately retains its checkpoint
      // for Resume, while a destroyed renderer/window also keeps crash
      // recovery available on the next launch.
      const checkpointPausedByUser = reason?.message === 'Node deleted'
        && CHECKPOINT_PRESERVING_ABORT_CAUSES.has(reason?.cancelCause);
      if (checkpointPausedByUser && activeRunId) {
        // Commit the user's Stop before the acknowledged cancellation can
        // settle. Otherwise closing/reopening in that small window would look
        // indistinguishable from a crash and the new startup auto-resumer
        // would immediately restart work the user explicitly paused.
        await pauseRunForManualResume(canvasFilePath, {
          expectedRunId: activeRunId,
          nodeId,
          expectedOperationAuthority: authorityReceipt,
          now: Date.now(),
        });
      } else if (shouldDiscardJobRunAfterAbort(reason) && activeRunId) {
        const abortCleanup = await clearRunWithResult(canvasFilePath, {
          trashItem: (p) => shell.trashItem(p),
          expectedRunId: activeRunId,
          expectedNodeId: nodeId,
        });
        if (abortCleanup?.ok !== true || (
          abortCleanup.cleared !== true
          && abortCleanup.absent !== true
        )) {
          throw new Error('The cancelled Job Search recovery files could not be removed safely.');
        }
      }
      jobsTelemetry.pipeline = {
        ...(jobsTelemetry.pipeline || {}),
        phase: 'aborted', ts: Date.now(), active: false, pendingSources: [],
        // Prefer the renderer's stated cause. The sentinel's message is
        // "Node deleted" for EVERY node-scoped cancel, so reporting it verbatim
        // told a user who clicked Reset that their hub had been deleted.
        error: CANCEL_CAUSE_LABELS[reason?.cancelCause] || String(reason.message || reason).slice(0, 240),
      };
      throw reason;
    };

    // ── Browser sources: ONE-AT-A-TIME in BROWSER_SCRAPE_ORDER ──────────────────
    // Indeed first, then the manual trio (ZipRecruiter → Glassdoor → Google), all
    // inside a SINGLE shared-profile lock acquisition. We must NOT nest
    // withSharedProfileLock (neither Indeed nor scrapeManualSources self-acquires
    // anymore) — a nested acquire would deadlock waiting on the outer hold. The
    // pure-HTTP sources run fully concurrently via fetchHttpSources.
    const queryTotal = getQueryProgressTotal(queries);

    // Data-driven scrape order: sources that recently forced the user to manually
    // solve a challenge (captcha / login wall) run FIRST, so the user clears them
    // up front and can walk away while the rest finish unattended. No source is
    // pinned — Indeed auto-handles its CF (never waits for the user) so it sinks
    // unless its history says otherwise; Google/Glassdoor, which DO wait via
    // waitForReady, rise. First run / clean history = the default order.
    const activeBrowserSources = BROWSER_SCRAPE_ORDER.filter(
      sid => ACTIVE_SOURCE_ID_SET.has(sid) && runnableSourceScope.has(sid),
    );
    const browserOrder = orderBrowserSources(activeBrowserSources);
    if (browserOrder.length) {
      logger.info(`[Jobs] Browser scrape order (manual-verification-first): ${browserOrder.join(' → ')}`);
    }

    // Indeed runs via its OWN driver (separate from the manual trio's
    // scrapeManualSources), so the loop dispatches per source. Indeed launches +
    // closes its own Chrome on the shared userDataDir, exactly like each trio
    // source, so interleaving is safe (all sequential inside the one profile lock).
    const runIndeed = async () => {
      await assertSearchCurrent();
      const indeedPlan = selectIndeedResumePlan(queries, queryPlans?.indeed, normalizedCollectionLimits);
      const activeIndeedIndexes = indeedPlan.indexes;
      // An interrupted source can contain only already-terminal query slots.
      // Do not acquire/launch Chrome just to rediscover them.
      if (activeIndeedIndexes.length === 0) {
        return { sourceId: 'indeed', jobs: [], gathered: 0, terminalQueriesSkipped: true };
      }
      emitProgress({ nodeId, sourceId: 'indeed', status: 'searching', count: 0, completed: 0, total: queryTotal });
      let indeedResult;
      try {
        const r = await fetchIndeedListingsBrowser(indeedPlan.queries, combinedSignal, ageDaysFor('indeed'), null, (detail) => {
          emitProgress({ nodeId, sourceId: 'indeed', status: 'searching', count: 0, detail, completed: getCompletedQueriesFromDetail(detail, queryTotal), total: queryTotal });
        }, indeedPlan.startPages, stageOnPage, location, normalizedCollectionLimits, indeedPlan.pageBudgets, true, activeIndeedIndexes, postedSinceFor('indeed'), alreadyReadBySource.indeed || null,
          // Listings still owed from before Indeed's date moved are opened whatever their date.
          owedBySource.indeed || null);
        await afterSearchProviderResult('indeed', r);
        await assertSearchCurrent();
        // Observation of the session the scrape actually ran with — survives
        // regardless of whether the scrape found any jobs (see BUG 3/4).
        await syncIndeedSessionStatusFromScrape(r?.sessionDiagnostics, r?.warning);
        const rawJobs = Array.isArray(r?.items) ? r.items : [];
        const gathered = r?.gathered ?? rawJobs.length;
        // Do not reapply a pre-window aggregate slice here.  The source-wide
        // admission cap below is deliberately after exact date/source-identity
        // filtering, so eligible later rows can fill slots occupied above by
        // stale or duplicate cards.
        const jobs = rawJobs;
        indeedResult = {
          sourceId: 'indeed', jobs, warning: r?.warning || null, gathered,
          providerGathered: r?.providerGathered,
          relevanceDropped: r?.relevanceDropped,
          preCapRelevanceDropped: r?.preCapRelevanceDropped,
          relevanceRejected: r?.relevanceRejected,
          enrichment: r?.enrichment || null,
          pagesFetched: r?.pagesFetched,
          stopReasons: r?.stopReasons,
          truncated: r?.truncated === true,
          cap: r?.cap || null,
          ...(Number.isSafeInteger(r?.pageShapeFailures) && r.pageShapeFailures > 0 ? { pageShapeFailures: r.pageShapeFailures } : {}),
          ...(Number(r?.alreadyReadSkipped) > 0 ? { alreadyReadSkipped: r.alreadyReadSkipped, readEarlierSkipped: r.readEarlierSkipped || 0 } : {}),
        };
      } catch (error) {
        if (isJobOperationSupersededError(error)) throw error;
        indeedResult = { sourceId: 'indeed', jobs: [], error: error?.message || String(error) };
      }
      emitProgress({
        nodeId, sourceId: 'indeed',
        status: (indeedResult.error || indeedResult.warning?.severity === 'block') ? 'error' : 'done',
        count: indeedResult.jobs.length,
        warning: indeedResult.warning || null,
        completed: queryTotal, total: queryTotal,
      });
      return indeedResult;
    };

    // A source result is terminal from the renderer's perspective. Normally
    // manualScraper emits no overlay paints after onResult, but keep that
    // ordering invariant at the IPC boundary too: a future teardown/retry paint
    // must never turn a finished source card back into "Searching…".
    const terminalManualSourceIds = new Set();
    const onManualResult = (res) => {
      const sourceId = res.id.replace(/-\d+$/, '');
      const count = Array.isArray(res.data) ? res.data.length : 0;
      const total = sourceTaskIds[sourceId]?.length || 1;
      const blocked = res.warning?.severity === 'block';
      // manualScraper resolves Glassdoor's textual location in-browser and
      // mutates task.url to append locId/locT immediately before navigation.
      // sourceFirstUrl/taskUrlById were initially copied before that mutation,
      // so a later Solve reopened the locKeyword-only (effectively nationwide)
      // URL rather than the exact page that was scraped. Refresh this small
      // telemetry/index from the live task objects before emitting the warning.
      refreshManualSourceUrlIndex(tasks, sourceId, sourceFirstUrl, taskUrlById, res.id);
      if (blocked) {
        const blockedUrls = orderedBlockedManualSourceUrls(
          tasks, sourceId, res.executedQueries, res.detailBlock?.firstQuery, res.detailBlock?.firstQueryIndex,
        );
        // The source card must open the actual blocked q2/q3 route, not q1.
        if (blockedUrls[0]) sourceFirstUrl[sourceId] = blockedUrls[0];
        sourceBlockedUrls[sourceId] = blockedUrls;
      }
      emitProgress({
        nodeId, sourceId,
        status: blocked ? 'error' : 'done',
        count, completed: total, total,
        warning: res.warning || null,
        url: sourceFirstUrl[sourceId] || null,
      });
      terminalManualSourceIds.add(sourceId);
    };

    // Record a browser source's terminal status the MOMENT it finishes, instead
    // of waiting for the post-gather loop far below. Browser sources run
    // strictly one at a time and a single one can hold the phase for a very long
    // time (a challenge wait is unbounded by design), so a run that dies during
    // the gather used to leave every already-finished source at 'pending' — and
    // resume re-scrapes anything not marked 'done', discarding rows that are
    // already staged on disk. A clean completion is terminal even when it found
    // zero rows; cancellation, abort, and block-severity outcomes stay retryable.
    const markGatheredSourceTerminal = async (sourceId, results) => {
      if (!canvasFilePath) return;
      const rows = Array.isArray(results) ? results : [];
      // A returned partial envelope after cancellation is not a completion.
      // Keep this source pending so startup recovery retries its unfinished
      // provider work; only a clean, non-interrupted zero is terminal.
      if (combinedSignal.aborted || rows.some(row => row?.cancelled === true || row?.stopReason === 'aborted')) return;
      // manualScraper results carry `data`; the Indeed driver carries `jobs`.
      // A source that yielded some rows but then throttled (for example
      // RemoteOK's base feed succeeded while a bounded tag feed failed) is
      // recoverable partial work, not a clean staged completion. Preserve its
      // rows, but keep the manifest retryable so resume does not silently
      // declare the missing provider scope complete.
      const blocked = rows.some(r => ['block', 'throttle'].includes(r?.warning?.severity) || r?.error || r?.retryablePartial === true);
      // A clean provider completion with zero matching rows is still terminal.
      // Leaving it pending made a later app restart re-dispatch an already
      // completed source merely because it had nothing to stage.
      const terminalWarnings = rows.map(row => row?.warning).filter(Boolean);
      await assertSearchCurrent();
      await beforeSearchStageWrite({ phase: 'before-source-status', sourceId, nodeId, runId: activeRunId });
      await assertSearchCurrent();
      const marked = await markSourceStatus(
        canvasFilePath,
        sourceId,
        blocked ? 'blocked' : 'done',
        Date.now(),
        {
          expectedRunId: activeRunId,
          nodeId,
          expectedOperationAuthority: authorityReceipt,
          recoveryDisposition: blocked
            ? jobSourceRecoveryDisposition(sourceId, terminalWarnings)
            : null,
          collectionScopeCaveats: collectionScopeCaveatsFromSourceResults({
            [sourceId]: { locationScopeUnenforced: rows.some(row => row?.locationScopeUnenforced === true) },
          }),
          pageShapeFailures: rows.reduce((sum, row) => sum + (Number.isSafeInteger(row?.pageShapeFailures) && row.pageShapeFailures > 0 ? row.pageShapeFailures : 0), 0),
        },
      );
      await assertSearchCurrent();
      if (marked !== true) throw new Error(`Could not durably record ${sourceId} completion.`);
    };

    const runBrowserSourcesInOrder = async () => {
      let indeedResult = null;
      const manualResults = [];
      resetManualSolveTracking();          // fresh per-run manual-solve flags
      resetManualScraperDiagnostics();     // clear console/network ONCE for the whole phase
      for (let i = 0; i < browserOrder.length; i++) {
        if (combinedSignal.aborted) break;
        const sid = browserOrder[i];
        if (sid === 'indeed') {
          await assertSearchCurrent();
          await throwIfExactResumeSuperseded();
          // Keep the dispatch ledger truthful too: an all-terminal Indeed
          // recovery has no provider work and must not look like it launched.
          const allIndeedQueriesTerminal = queries.length > 0
            && queries.every((_query, index) => queryPlans?.indeed?.[index]?.terminal === true);
          if (!allIndeedQueriesTerminal) recordJobSourceDispatch(sid, activeRunId);
          indeedResult = await runIndeed();
          await assertSearchCurrent();
          await markGatheredSourceTerminal('indeed', indeedResult ? [indeedResult] : []);
        } else {
          const sourceTasks = tasks.filter(t => t.sourceId === sid);
          if (!sourceTasks.length) continue;
          await assertSearchCurrent();
          await throwIfExactResumeSuperseded();
          recordJobSourceDispatch(sid, activeRunId);
          const r = await scrapeManualSources(sourceTasks, onManualResult, combinedSignal, stageOnPage, {
            resetDiagnostics: false, sourceIndexBase: i, sourceTotal: browserOrder.length,
            // The manual browser sources were the only ones with no mid-flight
            // progress channel: onManualResult fires once per finished task and
            // stageOnPage only writes the crash-recovery sidecar, so a
            // multi-minute Glassdoor walk delivered exactly one 'searching'
            // event and then nothing. Indeed and LinkedIn already report this
            // way; this closes the gap for the rest, and because emitProgress
            // also restamps jobsTelemetry.pipeline.ts, it is what keeps the
            // report's liveness clock ticking during a browser walk.
            onActivity: (beat) => {
              const activitySourceId = beat.sourceId || sid;
              if (terminalManualSourceIds.has(activitySourceId)) return;
              emitProgress({
                nodeId,
                sourceId: activitySourceId,
                status: 'searching',
                // Omitted (not zeroed) when the beat carries no total, so
                // mergeSourceProgress keeps the last known count instead of
                // blanking a card that already showed one.
                ...(beat.count != null ? { count: beat.count } : {}),
                detail: beat.status || null,
                url: sourceFirstUrl[activitySourceId] || null,
              });
            },
          });
          await afterSearchProviderResult(sid, r);
          await assertSearchCurrent();
          manualResults.push(...r);
          await markGatheredSourceTerminal(sid, r);
        }
        // Record this source's outcome for the NEXT run's order: did it require
        // user-operated verification? Manual drivers mark while waiting. Indeed
        // returns its native challenge for a later Continue click, so mark that
        // required handoff here before the one per-run sample is persisted.
        if (sid === 'indeed' && indeedWarningRequiresManualVerification(indeedResult?.warning)) {
          markManualSolveRequired(sid);
        }
        recordVerificationOutcome(sid, wasManualSolveRequired(sid));
      }
      return { manualResults, indeedResult };
    };

    // Pure-HTTP sources stage themselves per-source the moment each finishes
    // (they don't paginate through the page hook); browser sources stage
    // per-page via stageOnPage. So a crash anywhere in the long browser phase
    // already has every finished HTTP source's jobs on disk.
    const stageHttpSource = async ({ sourceId, jobs, warning = null, retryablePartial = false }) => {
      await assertSearchCurrent();
      await beforeSearchStageWrite({ phase: 'before-http-stage', sourceId, nodeId, runId: activeRunId });
      await assertSearchCurrent();
      const saved = await recordSourcePage(canvasFilePath, {
        sourceId, query: '', page: 0, jobs, now: Date.now(), expectedRunId: activeRunId, nodeId,
        expectedOperationAuthority: authorityReceipt,
      });
      await assertSearchCurrent();
      if (canvasFilePath && saved !== true) throw new Error(`Could not durably checkpoint ${sourceId}.`);
      // Same durability gap as the browser sources: an HTTP source finishes
      // early and then waits out the whole browser phase before the post-gather
      // loop records that it is done. Mark it here so a run that never reaches
      // that loop can still resume without re-fetching it.
      await markGatheredSourceTerminal(sourceId, [{ jobs, warning, retryablePartial }]);
    };

    jobsTelemetry.pipeline = {
      ...(jobsTelemetry.pipeline || {}),
      phase: 'gathering-sources',
      ts: Date.now(),
      active: true,
      pendingSources: [...runnableSourceScope],
    };
    let browserOut;
    let httpResults;
    let gatherBranches = null;
    try {
      // This branch deliberately does no browser work and does not acquire the
      // profile lock merely to reset diagnostics: a gathered recovery must
      // remain independent of an unrelated hub's browser lifetime.
      if (skipProviderCollection) {
        [browserOut, httpResults] = [{ manualResults: [], indeedResult: null }, []];
      } else {
        gatherBranches = [
          withFreshManualScraperTelemetry(runBrowserSourcesInOrder, combinedSignal),
          runHttpSources(queries, event.sender, combinedSignal, nodeId, ageDays, location, runnableSourceScope, emitProgress, stageHttpSource, normalizedCollectionLimits, async () => {
            await assertSearchCurrent();
            await throwIfExactResumeSuperseded();
            await assertSearchCurrent();
          }, async (sourceId, result) => {
            await afterSearchProviderResult(sourceId, result);
            await assertSearchCurrent();
          }, ageDaysBySource(), carriedQueriesBySource, {
            // LinkedIn checkpoints each finished query through the browser
            // sources' page ledger, and a resume skips the ones already terminal.
            queryPlansBySource: resumeStartPages,
            stageQuery: stageOnPage,
          }),
        ];
        [browserOut, httpResults] = await Promise.all(gatherBranches);
      }
      await throwIfSearchAborted();
      await assertSearchCurrent();
    } catch (error) {
      // Promise.all rejects on the first fatal branch error. Abort the other
      // branch and wait for both to settle before exposing the failure, so no
      // provider keeps scraping or staging after this IPC has returned. A
      // caller abort already owns its signal/reason; do not overwrite it.
      if (!signal?.aborted && !pipelineAbort.signal.aborted) pipelineAbort.abort(error);
      if (gatherBranches) await Promise.allSettled(gatherBranches);
      if (isJobOperationSupersededError(error)) {
        return searchSupersededResult();
      }
      if (error?.exactResumeOwnershipFailure) {
        const failure = {
          ...(error.resumeRunMissing ? { resumeRunMissing: true } : {}),
          ...(error.resumeRunMismatch ? { resumeRunMismatch: true } : {}),
          error: error.message,
        };
        retirePipeline('recovery-superseded', failure.error);
        return { success: false, ...failure };
      }
      jobsTelemetry.pipeline = {
        ...(jobsTelemetry.pipeline || {}),
        phase: combinedSignal.aborted ? 'aborted' : 'source-gather-failed',
        ts: Date.now(),
        active: false,
        pendingSources: [],
        error: String(error?.message || error).slice(0, 240),
      };
      throw error;
    }
    await assertSearchCurrent();
    jobsTelemetry.pipeline = {
      ...(jobsTelemetry.pipeline || {}),
      phase: 'processing-source-results',
      ts: Date.now(),
      active: true,
      pendingSources: [],
    };
    const results = browserOut.manualResults;
    // Indeed (browser) is appended to the API-shaped results so all downstream
    // processing (per-source funnel, gathered/warning handling) stays unchanged.
    const apiResults = browserOut.indeedResult ? [...httpResults, browserOut.indeedResult] : [...httpResults];

    // Process Scraper Results
    for (const result of results) {
      const sourceId = result.id.replace(/-\d+$/, '');
      if (!sourceResults[sourceId]) sourceResults[sourceId] = { jobs: [], errors: 0, warnings: [], pagesWalked: 0, stopReasons: new Set() };

      // Capture anti-bot warning per source even on success — a "success
      // with 0 items" usually means a soft block returned a skeleton page.
      if (result.warning) {
        sourceResults[sourceId].warnings.push(result.warning);
      }
      // Manual browser walkers report one aggregate source result after their
      // per-query tasks finish. Preserve the same whitelisted cap envelope as
      // API sources before the result is reduced into telemetry/receipt data;
      // otherwise an Auto page-budget stop became a bare `page-cap` and looked
      // like an unqualified, possibly exhaustive walk after restart.
      mergeJobSourceCollectionCap(sourceResults[sourceId], result.cap);
      // A detail-enrichment block does not stop the walk, so it never reaches
      // stopReason. Carry it separately (merged across a source's query
      // variants) or the run reports `completed` while most of its rows were
      // gathered with no description and dropped by the evidence gate.
      if (result.detailBlock) {
        const prior = sourceResults[sourceId].detailBlock;
        sourceResults[sourceId].detailBlock = prior
          ? {
            code: result.detailBlock.code || prior.code,
            active: Boolean(prior.active || result.detailBlock.active),
            firstPage: prior.firstPage ?? result.detailBlock.firstPage,
            arms: (prior.arms || 0) + (result.detailBlock.arms || 0),
            reprobes: (prior.reprobes || 0) + (result.detailBlock.reprobes || 0),
            recovered: (prior.recovered || 0) + (result.detailBlock.recovered || 0),
            skippedCards: (prior.skippedCards || 0) + (result.detailBlock.skippedCards || 0),
            // Recovery-surviving fields: the scraper resets firstPage/reprobes
            // when a re-probe succeeds, and skippedCards never counted the page
            // that TRIGGERED the block, so without these a recovered episode
            // reported zero cost.
            everBlockedPage: prior.everBlockedPage ?? result.detailBlock.everBlockedPage,
            reprobesTotal: (prior.reprobesTotal || 0) + (result.detailBlock.reprobesTotal || 0),
            unenrichedRows: (prior.unenrichedRows || 0) + (result.detailBlock.unenrichedRows || 0),
          }
          : { ...result.detailBlock };
      }
      // Physical cards this source dropped as same-source duplicates BEFORE the
      // funnel's "Found (raw)" was computed from what it returned.
      if (result.providerDuplicatesDropped != null) {
        sourceResults[sourceId].providerDuplicatesDropped =
          (sourceResults[sourceId].providerDuplicatesDropped || 0) + Number(result.providerDuplicatesDropped || 0);
      }
      // `providerGathered` is the number of distinct source-card identities
      // traversed. A detail page can subsequently prove an identity unavailable
      // and remove it from result.data, so preserve that bounded difference
      // rather than relabelling the candidate count as returned usable rows.
      if (result.unavailableDetailDropped != null) {
        sourceResults[sourceId].unavailableDetailDropped =
          (sourceResults[sourceId].unavailableDetailDropped || 0) + Math.max(0, Number(result.unavailableDetailDropped) || 0);
      }
      // Rows an aggregator board reported closed stay in `jobs`, flagged for the
      // official-posting resolver; they are NOT part of unavailableDetailDropped.
      if (result.boardClosedDetailKept > 0) {
        sourceResults[sourceId].boardClosedDetailKept =
          (sourceResults[sourceId].boardClosedDetailKept || 0) + Math.max(0, Number(result.boardClosedDetailKept) || 0);
      }
      // A nation-tier Glassdoor location can be accepted and echoed without
      // actually filtering rows. It is a source-level scope fact, not a source
      // warning: warning severity drives card state and must not hide real
      // scraper failures that occur later in the walk.
      if (result.locationScopeUnenforced === true) {
        sourceResults[sourceId].locationScopeUnenforced = true;
      }
      if (result.success && Array.isArray(result.data)) {
        const tagged = result.data.map(j => ({ ...j, source: sourceId }));
        sourceResults[sourceId].jobs.push(...tagged);
        allJobs.push(...tagged);
        // How deep the same-session walk went, and why it stopped (paginating
        // sources only; one-shot sources leave pagesWalked at 0). Aggregated
        // across a source's query variants: deepest walk + the set of reasons.
        // Board-advertised total, where the board publishes a trustworthy one.
        // It makes under-collection legible ("141 of ~587 advertised"). The
        // manual scraper may also use it for ZipRecruiter's bounded hidden-page
        // continuation; it never filters rows or drives another source.
        if (result.claimedTotal != null && sourceResults[sourceId].claimedTotal == null) {
          sourceResults[sourceId].claimedTotal = result.claimedTotal;
        }
        if (result.directContinuation) {
          sourceResults[sourceId].directContinuation = { ...result.directContinuation };
        }
        if (result.pagesWalked != null) {
          sourceResults[sourceId].pagesWalked = Math.max(sourceResults[sourceId].pagesWalked, result.pagesWalked);
          if (result.stopReason) sourceResults[sourceId].stopReasons.add(result.stopReason);
        }
        if (Array.isArray(result.executedQueries)) {
          sourceResults[sourceId].executedQueries = result.executedQueries.slice(0, 20);
        }
        if (Array.isArray(result.revealOutcomes)) {
          sourceResults[sourceId].revealOutcomes = result.revealOutcomes.slice(0, 20);
        }
        if (Array.isArray(result.walkGuards)) {
          sourceResults[sourceId].walkGuards = sanitizeWalkGuards([
            ...(sourceResults[sourceId].walkGuards || []),
            ...result.walkGuards,
          ], 20);
        }
        if (result.googleApplyCapture) sourceResults[sourceId].googleApplyCapture = result.googleApplyCapture;
        if (result.pageShapeFailures > 0) sourceResults[sourceId].pageShapeFailures = (sourceResults[sourceId].pageShapeFailures || 0) + result.pageShapeFailures;
        if (result.providerGathered != null) sourceResults[sourceId].providerGathered = result.providerGathered;
        // Dated cards the walker dropped for being outside the collection
        // window. They had a posted date, so the health check counts them.
        if (result.windowDropped != null) {
          sourceResults[sourceId].windowDropped =
            (sourceResults[sourceId].windowDropped || 0) + Math.max(0, Number(result.windowDropped) || 0);
        }
        if (Number(result.alreadyReadSkipped) > 0) {
          sourceResults[sourceId].alreadyReadSkipped =
            (sourceResults[sourceId].alreadyReadSkipped || 0) + Math.floor(Number(result.alreadyReadSkipped));
          sourceResults[sourceId].readEarlierSkipped =
            (sourceResults[sourceId].readEarlierSkipped || 0) + Math.max(0, Math.floor(Number(result.readEarlierSkipped) || 0));
          logger.info(`[Jobs][${nodeId}] ${sourceId}: left ${Math.floor(Number(result.alreadyReadSkipped))} listing(s) unopened because an earlier run already read or showed them`);
        }
        if (result.truncated === true) sourceResults[sourceId].truncated = true;
        if (result.relevanceDropped != null) {
          sourceResults[sourceId].relevanceDropped = result.relevanceDropped;
          sourceResults[sourceId].admissionRelevanceDropped = result.relevanceDropped;
        }
        if (result.preCapRelevanceDropped != null) {
          sourceResults[sourceId].preCapRelevanceDropped = result.preCapRelevanceDropped;
        }
        if (Array.isArray(result.relevanceRejected) && result.relevanceRejected.length > 0) {
          sourceResults[sourceId].relevanceRejected = result.relevanceRejected.slice(0, 8);
        }
      } else {
        sourceResults[sourceId].errors++;
        logger.warn(`[Jobs] Source ${result.id} failed:`, result.error);
        // Synthesize a warning from the error message so the source card can
        // render a reason instead of a bare "Failed" (same warning the per-task
        // progress event now sends live).
        sourceResults[sourceId].warnings.push(synthScrapeWarning(result.error));
      }
    }

    // Glassdoor behavioral contribution-gate detection. The body-text soft gate in
    // antiBotDetector.js already has the right pattern, but Glassdoor's 775KB HTML
    // buries "To restore your access" far past the HTML_SCAN_CHARS=5000 window, so
    // it never fires during the headless scrape. Behavioral signal is more reliable:
    // a logged-in session that extracts ≤10 jobs then hits an empty "Show more" is
    // almost certainly gated (Glassdoor caps free-account results at ~5), not sparse.
    // Inject a block-severity warning so the card shows a Solve button — the user
    // opens the two-tab resolve window, submits a review/salary in Tab 2, then
    // Tab 1 auto-extracts the full ungated result set.
    //
    // Limit-aware: a deliberately small per-platform job allowance must not look
    // like Glassdoor's contribution gate. A finite allowance of ten or fewer
    // can legitimately produce this small result; otherwise it is suspicious.
    const gdData = sourceResults.glassdoor;
    const gdLimitCanExplainResult = normalizedCollectionLimits.jobsPerPlatform != null
      && normalizedCollectionLimits.jobsPerPlatform <= 10;
    if (gdData && gdData.jobs.length > 0 && gdData.jobs.length <= 10 &&
        !gdLimitCanExplainResult &&
        gdData.pagesWalked <= 1 &&
        !gdData.warnings.some(w => w?.severity === 'block')) {
      gdData.warnings.push({
        code: 'glassdoor-review-gate',
        severity: 'block',
        evidence: `Glassdoor returned only ${gdData.jobs.length} job(s) before its first reveal/page ended — consistent with the contribution gate.`,
        openSecondTab: true,
        suggestion: 'Glassdoor limited the automated fetch. Click Solve — a browser opens on the Glassdoor results and USUALLY loads the full list on its own, then closes; you don\'t need to do anything. ONLY if you see a "write a review / add a salary to continue" wall, use Tab 2 to satisfy it, then switch to Tab 1 and refresh.',
      });
    }

    // Persist blocked URLs for the resolve handler to use post-search.
    jobsTelemetry.sourceBlockedUrls = sourceBlockedUrls;

    // Process API Results
    for (const res of apiResults) {
      if (!sourceResults[res.sourceId]) sourceResults[res.sourceId] = { jobs: [], errors: 0, warnings: [] };
      // Pre-cap match count (one fetch per API source). > jobs gathered = the
      // The collected/source result is already bounded by the persisted limit.
      if (res.gathered != null) sourceResults[res.sourceId].gathered = res.gathered;
      if (res.providerGathered != null) sourceResults[res.sourceId].providerGathered = res.providerGathered;
      if (res.relevanceDropped != null) sourceResults[res.sourceId].relevanceDropped = res.relevanceDropped;
      if (res.relevanceDropped != null) sourceResults[res.sourceId].admissionRelevanceDropped = res.relevanceDropped;
      if (res.sponsoredDropped != null) sourceResults[res.sourceId].sponsoredDropped = res.sponsoredDropped;
      if (res.preCapRelevanceDropped != null) sourceResults[res.sourceId].preCapRelevanceDropped = res.preCapRelevanceDropped;
      // Truncation evidence for API sources. `providerTotal` is the provider's
      // OWN count for the query, so "gathered 150 of 973" becomes legible where
      // previously a truncated walk and a genuinely small corpus were identical.
      if (res.providerTotal != null) sourceResults[res.sourceId].providerTotal = res.providerTotal;
      if (res.capDropped != null) sourceResults[res.sourceId].capDropped = res.capDropped;
      if (res.crossQueryDuplicates) sourceResults[res.sourceId].crossQueryDuplicates = res.crossQueryDuplicates;
      if (Array.isArray(res.walkGuards)) {
        sourceResults[res.sourceId].walkGuards = sanitizeWalkGuards([
          ...(sourceResults[res.sourceId].walkGuards || []),
          ...res.walkGuards,
        ], 20);
      }
      if (res.truncated) sourceResults[res.sourceId].truncated = true;
      if (res.pageShapeFailures > 0) sourceResults[res.sourceId].pageShapeFailures = (sourceResults[res.sourceId].pageShapeFailures || 0) + res.pageShapeFailures;
      if (Number(res.alreadyReadSkipped) > 0) {
        sourceResults[res.sourceId].alreadyReadSkipped =
          (sourceResults[res.sourceId].alreadyReadSkipped || 0) + Math.floor(Number(res.alreadyReadSkipped));
        sourceResults[res.sourceId].readEarlierSkipped =
          (sourceResults[res.sourceId].readEarlierSkipped || 0) + Math.max(0, Math.floor(Number(res.readEarlierSkipped) || 0));
        logger.info(`[Jobs][${nodeId}] ${res.sourceId}: left ${Math.floor(Number(res.alreadyReadSkipped))} listing(s) unopened because an earlier run already read or showed them`);
      }
      if (Array.isArray(res.stopReasons) && res.stopReasons.length > 0) {
        // Manual walkers keep this as a Set; API fan-out returns an array.
        // Merge rather than replace so a recovery/second API pass cannot erase
        // an already observed stop condition.
        if (!(sourceResults[res.sourceId].stopReasons instanceof Set)) {
          sourceResults[res.sourceId].stopReasons = new Set(sourceResults[res.sourceId].stopReasons || []);
        }
        for (const stopReason of res.stopReasons) sourceResults[res.sourceId].stopReasons.add(stopReason);
      }
      // An internal per-source ceiling (LinkedIn's offset budget) is a real cap
      // and must not be reported as an exhausted source.
      if (res.sourceCap && !sourceResults[res.sourceId].cap) {
        sourceResults[res.sourceId].cap = res.sourceCap;
      }
      if (Array.isArray(res.sourceCaps) && res.sourceCaps.length > 0) {
        if (!Array.isArray(sourceResults[res.sourceId].caps)) sourceResults[res.sourceId].caps = [];
        for (const cap of res.sourceCaps) {
          if (!['jobs-per-platform', 'pages-per-platform', 'auto-jobs-per-platform', 'auto-pages-per-platform'].includes(cap?.type)
              || !Number.isSafeInteger(cap.limit) || cap.limit <= 0
              || sourceResults[res.sourceId].caps.some(existing => existing.type === cap.type && existing.limit === cap.limit)) continue;
          sourceResults[res.sourceId].caps.push({ type: cap.type, limit: cap.limit });
        }
      }
      if (res.enrichment) sourceResults[res.sourceId].enrichment = res.enrichment;
      if (res.pagesFetched != null) {
        sourceResults[res.sourceId].pagesWalked = Math.max(
          Number(sourceResults[res.sourceId].pagesWalked) || 0,
          Math.max(0, Number(res.pagesFetched) || 0),
        );
      }
      if (Array.isArray(res.relevanceRejected) && res.relevanceRejected.length > 0) {
        sourceResults[res.sourceId].relevanceRejected = res.relevanceRejected;
      }
      if (Array.isArray(res.remoteFeedProvenance) && res.remoteFeedProvenance.length > 0) {
        sourceResults[res.sourceId].remoteFeedProvenance = res.remoteFeedProvenance;
      }
      if (Array.isArray(res.relevanceTrace) && res.relevanceTrace.length > 0) {
        sourceResults[res.sourceId].relevanceTrace = res.relevanceTrace;
      }
      // Each API fetcher now returns { items, warning }; the wrapper above
      // also passes warning through. Capture it so blocks/throttles on
      // API-based sources surface in the same UI panel as scraped sources.
      if (res.warning) {
        sourceResults[res.sourceId].warnings.push(res.warning);
      }
      if (res.jobs.length > 0) {
        const tagged = res.jobs.map(j => ({ ...j, source: res.sourceId }));
        sourceResults[res.sourceId].jobs.push(...tagged);
        allJobs.push(...tagged);
      } else if (res.error) {
        sourceResults[res.sourceId].errors++;
        // Same as scrape path: turn the raw error into a visible warning.
        sourceResults[res.sourceId].warnings.push({
          code: 'api-failed',
          // Not every source dispatched from here has an API — Indeed is a
          // BROWSER scraper that happens to live in this group, so a Chrome
          // launch failure used to be reported as "API call failed. Check logs
          // for the full response" and sent the user hunting for a response
          // that never existed. Indeed now returns its own structured warning
          // instead of throwing (see indeedBrowser.js), but this generic
          // fallback must still not assert a transport it cannot know.
          severity: 'block',
          evidence: String(res.error).slice(0, 240),
          suggestion: 'The source failed before returning any results — see the evidence above and the main-process log for the full error.',
        });
      }
    }

    // Preserve provider-ranked search results except for a conservative
    // country-level backstop: never score a listing that affirmatively names a
    // different country. Ambiguous, remote, and city/province-target rows stay.
    const finalAdmission = acceptProviderSearchResults(allJobs);
    const countryScopeAdmission = filterProvablyOutsideCountryScope(finalAdmission, location);
    const countryEligible = countryScopeAdmission.jobs;
    for (const [sourceId, count] of Object.entries(countryScopeAdmission.droppedBySource)) {
      if (sourceResults[sourceId]) sourceResults[sourceId].countryScopeDropped = count;
    }
    // Enforce the persisted *platform* allowance only after the exact client
    // date boundary and same-platform identity collapse.  The old per-walker
    // slices were not a platform boundary: 16 query tasks could each contribute
    // their own allowance, while old cards and repeated query rows spent slots
    // before the central date/dedup funnel ever saw them.
    const platformCap = capPlatformJobsAfterWindow(
      countryEligible,
      (sourceId) => postedSinceFor(sourceId),
      resolveJobsPerPlatform(normalizedCollectionLimits),
    );
    const autoJobsPerPlatform = normalizedCollectionLimits.jobsPerPlatform == null;
    const cappedJobsBySource = new Map();
    for (const job of platformCap.jobs) {
      const sourceId = String(job?.source || '?');
      const rows = cappedJobsBySource.get(sourceId) || [];
      rows.push(job);
      cappedJobsBySource.set(sourceId, rows);
    }
    for (const [sourceId, data] of Object.entries(sourceResults)) {
      data.jobs = cappedJobsBySource.get(sourceId) || [];
    }
    for (const [sourceId, stats] of Object.entries(platformCap.sourceStats)) {
      const data = sourceResults[sourceId];
      if (!data) continue;
      // From here forward the source result is the collection contract exposed
      // to cards, receipts and later pipeline stages; raw traversal counts stay
      // in providerGathered/gathered for coverage diagnostics.
      if (stats.duplicateDropped > 0) data.platformDuplicateDropped = stats.duplicateDropped;
      if (stats.ageDropped > 0) data.collectionAgeDropped = stats.ageDropped;
      if (stats.capDropped <= 0) continue;
      data.capDropped = Math.max(0, Number(data.capDropped) || 0) + stats.capDropped;
      if (!(data.stopReasons instanceof Set)) data.stopReasons = new Set(data.stopReasons || []);
      data.stopReasons.add(autoJobsPerPlatform ? 'auto-jobs-per-platform' : 'jobs-per-platform');
      const cap = {
        type: autoJobsPerPlatform ? 'auto-jobs-per-platform' : 'jobs-per-platform',
        limit: resolveJobsPerPlatform(normalizedCollectionLimits),
      };
      data.cap = cap;
      const caps = Array.isArray(data.caps) ? data.caps : [];
      if (!caps.some(existing => existing?.type === cap.type && existing?.limit === cap.limit)) caps.unshift(cap);
      data.caps = caps.slice(0, 3);
    }
    // Whole-feed admission filtering remains outside this funnel and can contain
    // cross-query counts; provider-ranked sources contribute zero title drops.
    const relevanceFunnel = reconcileTitleRelevanceFunnel(allJobs.length, finalAdmission.length, sourceResults);

    // Send per-source completion events — include the strongest warning for
    // that source so the card UI keeps showing it even after the final
    // event lands (otherwise the per-source completion event clobbers the
    // earlier scrape-progress event that carried the warning).
    //
    // Status semantics (was: "0 jobs + 0 errors → idle", which was wrong —
    // a source that ran and got 0 isn't idle, it's done with no results):
    //   - 'done'    → ran successfully (count may be 0)
    //   - 'skipped' → pre-skipped without running (config-missing info warning)
    //   - 'error'   → fetched but every attempt failed (errors > 0 OR every
    //                 attempt produced a block warning and no jobs)
    //   - 'idle'    → reserved for "never got a progress event" (renderer fallback)
    // A voluntary saved-listing finish leaves pending/blocked sources truthful
    // in the manifest. Do not synthesize "done" events/statuses merely because
    // no provider work was scheduled in this local-only continuation.
    if (collectionDisposition !== 'user-finished-partial') {
      for (const sourceId of activeSourceIds) {
        const data = sourceResults[sourceId] || { jobs: [], errors: 0, warnings: [] };
      const progressTotal = sourceTaskIds[sourceId]?.length || getQueryProgressTotal(queries);
      const effectiveWarnings = (data.warnings || []).map(w => getEffectiveSourceWarning(w, data.jobs.length));
      // Block > info > throttle > nothing. Block wins for visual urgency;
      // info wins over throttle so a config-missing reason isn't hidden by
      // a soft warning.
      const strongest =
        effectiveWarnings.find(w => w?.severity === 'block') ||
        effectiveWarnings.find(w => w?.severity === 'info')  ||
        effectiveWarnings[0] ||
        null;

      const hadBlock = effectiveWarnings.some(w => w?.severity === 'block');
      const hadInfoSkip = effectiveWarnings.some(w => w?.severity === 'info');
      const allFailed = data.errors > 0 && data.jobs.length === 0;
      // RemoteOK's base feed can be useful even when a later optional tag
      // scope is throttled. Keep the card non-fatal/done so those rows proceed,
      // but do not mark the recovery manifest clean: the provenance explicitly
      // says fan-out stopped and a future resume may fill the missing scope.
      // A list walk the provider cut short (LinkedIn's 429) is the same case.
      const retryablePartialProviderFailure = sourceId === 'remoteok'
        && Array.isArray(data.remoteFeedProvenance)
        && data.remoteFeedProvenance.some(entry => entry?.fanoutStopped === true)
        && effectiveWarnings.some(w => w?.severity === 'throttle')
        || listWalkStoppedByProviderBlock(data, effectiveWarnings);

      let status;
      if (hadInfoSkip)          status = 'skipped';
      else if (hadBlock)        status = 'error';
      else if (data.jobs.length > 0) status = 'done';
      else if (allFailed)       status = 'error';
      else                      status = 'done';   // ran cleanly, 0 results

      emitProgress({
        nodeId,
        sourceId,
        status,
        count: data.jobs.length,
        completed: progressTotal,
        total: progressTotal,
        warning: strongest,
        // Failed scrape URL (browser-pool sources only). Empty for API
        // sources — their Solve button won't render, which is correct
        // since opening a login URL doesn't help an extractor that
        // doesn't share cookies anyway.
        url: sourceFirstUrl[sourceId] || null,
      });
      // Record terminal status in the run manifest so resume knows which sources
      // completed vs. need re-running. 'skipped' counts as done (it ran its course).
        await assertSearchCurrent();
        await beforeSearchStageWrite({ phase: 'before-result-source-status', sourceId, nodeId, runId: activeRunId });
        await assertSearchCurrent();
        const marked = await markSourceStatus(
          canvasFilePath,
          sourceId,
          status === 'error' || retryablePartialProviderFailure ? 'blocked' : status,
          Date.now(),
          {
          expectedRunId: activeRunId,
          nodeId,
          expectedOperationAuthority: authorityReceipt,
            recoveryDisposition: status === 'error' || retryablePartialProviderFailure
              ? jobSourceRecoveryDisposition(sourceId, effectiveWarnings)
              : null,
            collectionScopeCaveats: collectionScopeCaveatsFromSourceResults({ [sourceId]: data }),
            pageShapeFailures: data?.pageShapeFailures || 0,
            windowDropped: data?.windowDropped || 0,
          },
        );
        await assertSearchCurrent();
        if (marked !== true) return searchSupersededResult();
      }
    }

    // Flat per-source warning list returned with the response so the Job Search Module
    // done state can render a copy-able "Scrape Warnings" panel. Carry each
    // source's scrape `url` so the block gate can re-seed a Solve target if the
    // blocked source's card was lost during the run (see ensureBlockedSourceCards).
    const scrapeWarnings = [];
    for (const [sourceId, data] of Object.entries(sourceResults)) {
      for (const w of data.warnings || []) {
        const effectiveWarning = getEffectiveSourceWarning(w, data.jobs.length) || w;
        scrapeWarnings.push({
          sourceId,
          url: sourceFirstUrl[sourceId] || null,
          ...effectiveWarning,
        });
      }
    }
    if (collectionDisposition === 'user-finished-partial') {
      for (const sourceId of intentionallyUnfinishedSourceIds) {
        scrapeWarnings.push({
          sourceId,
          url: null,
          code: 'collection-finished-with-saved-listings',
          severity: 'info',
          evidence: 'Provider collection was deliberately stopped; this source was not resumed.',
          suggestion: 'Run a later full Job Search to collect the remaining source coverage.',
        });
      }
    }

    // All provider tasks have now emitted a terminal status and their source
    // ledgers are committed. This is intentionally before the potentially long
    // renderer-side role-screen handoff. The marker admits a click to that
    // same shared lane, where it waits until the regular final checkpoint is
    // written. It is deliberately *not* a recovery snapshot: raw provider
    // rows have not yet crossed the deterministic age/history/preference
    // boundary and must never be fed to a strict description resolver.
    //
    // providerPhaseOnly has no renderer continuation holding that lane and no
    // post-filter checkpoint. Do not advertise its terminal provider ledger as
    // Solve-ready; its explicit Resume builds the normal gathered checkpoint.
    // Unsaved canvases likewise have no durable resolver path.
    if (canvasFilePath && !providerPhaseOnly) {
      await assertSearchCurrent();
      await beforeSearchStageWrite({ phase: 'before-provider-gathered', nodeId, runId: activeRunId });
      await assertSearchCurrent();
      const providerGathered = await markProviderGathered(canvasFilePath, Date.now(), {
        expectedRunId: activeRunId,
        nodeId,
        expectedOperationAuthority: authorityReceipt,
        requiredSourceIds: activeSourceIds,
      });
      await assertSearchCurrent();
      if (!providerGathered) {
        throw new Error('Could not commit the completed provider-gather boundary.');
      }
    }

    if (providerPhaseOnly) {
      // The durable page ledger and every source terminal disposition were
      // committed above. Stop before the semantic role screen: it may require
      // an AI handoff and therefore belongs to the mounted card, not a hidden
      // startup coordinator. Keeping the manifest at `searching`
      // makes the next exact Resume rebuild from staged rows without contacting
      // any now-done source.
      await throwIfSearchAborted();
      const ownershipFailure = await inspectExactResumeOwnership();
      if (ownershipFailure) {
        retirePipeline('recovery-superseded', ownershipFailure.error);
        return { success: false, ...ownershipFailure };
      }
      const providerState = await readRunState(canvasFilePath, Date.now(), { nodeId });
      if (
        providerState?.manifest?.runId !== activeRunId
        || providerState.manifest.inputs?.nodeId !== nodeId
      ) {
        const failure = await exactResumeStageFailure();
        retirePipeline('recovery-superseded', failure.error);
        return { success: false, ...failure };
      }
      const unfinishedSourceIds = Object.entries(providerState.manifest.sources || {})
        .filter(([, source]) => source?.status !== 'done' && source?.status !== 'skipped')
        .map(([sourceId]) => sourceId);
      jobsTelemetry.pipeline = {
        ...(jobsTelemetry.pipeline || {}),
        phase: 'awaiting-role-screen',
        ts: Date.now(),
        active: false,
        pendingSources: unfinishedSourceIds,
      };
      return {
        success: true,
        providerPhaseOnly: true,
        runId: activeRunId,
        gatheredCount: providerState.stagedJobs.length,
        scrapeWarnings,
        unfinishedSourceIds,
        hasUnfinishedSources: unfinishedSourceIds.length > 0,
      };
    }

    // Providers deliberately receive a broad whole-day lookback. Enforce the
    // exact inclusive local-calendar boundary BEFORE first-wins cross-source
    // dedup: an old mirror must not evict a newer in-window copy and then be
    // dropped itself. Unparseable dates remain visible.
    //
    // Cross-source de-dup provenance is bounded but durable in the funnel: a
    // count alone cannot tell a legitimate board copy from an over-broad
    // identity rule after the original cards have gone away.
    const dedupDrops = [];
    const windowEligible = platformCap.windowEligible;
    const ageDropped = platformCap.ageDropped;
    // Source quotas are independent.  Only after each platform has its
    // date-valid, source-unique allowance do we reconcile copies returned by
    // different providers.
    // A board-closed copy loses every first-wins tie to an open copy of the same
    // posting (preferOpenRows is the identity function when nothing is flagged).
    const deduped = dedupByTitleCompany(preferOpenRows(platformCap.jobs), {
      onDuplicate: (entry) => { dedupDrops.push(entry); },
    });
    // Per-source unique survivors of the dedup — lets the funnel tell a genuine
    // page-ceiling ("50 gathered, 50 unique → may be more") apart from a CLAMPING
    // source that re-served the same page across the walk ("50 gathered, 5 unique
    // → not more, the page param is repeating"). The removed duplicate-page stop
    // used to make this call implicitly; now the funnel shows the raw↔unique gap.
    const uniqueBySource = {};
    for (const j of deduped) { const s = j.source || '?'; uniqueBySource[s] = (uniqueBySource[s] || 0) + 1; }

    // Per-source age accounting for the bug report. The global `ageDropped`
    // above can't answer "did the N-day window actually bind platform X?" —
    // and filterJobsByPostedSince KEEPS any job whose `posted` is unparseable, so a
    // source with no server-side date param AND no parseable per-job date is
    // silently un-bounded by this pass (only its source-side query limits it).
    // Record, per source: how many it contributed to the drop, how many
    // survived, the oldest surviving posting (raw + parsed age), and how many
    // survivors had no parseable date (the client-side filter was blind to
    // them). The renderer turns this into a per-platform verdict; an oldest
    // survivor older than the window is a real leak (flagged 🔥).
    const ageBySource = {};
    const keptRefs = new Set(windowEligible);
    for (const j of countryEligible) {
      const sid = j.source || '?';
      const a = ageBySource[sid] || (ageBySource[sid] = { dropped: 0, kept: 0, oldestKeptDays: null, oldestKeptRaw: null, unparseableKept: 0 });
      if (!keptRefs.has(j)) { a.dropped++; continue; }
      a.kept++;
      const d = parsePostedDate(j.posted);
      if (d) {
        const days = Math.floor((Date.now() - d.getTime()) / 86400000);
        if (a.oldestKeptDays == null || days > a.oldestKeptDays) { a.oldestKeptDays = days; a.oldestKeptRaw = String(j.posted || '').trim() || null; }
      } else {
        a.unparseableKept++;
      }
    }

    // The deterministic pinned-title gate (word-match on job title vs. a
    // pinned title list) is gone, but its PIPELINE POSITION survives: it is
    // replaced by an AI role screen run right here, age-filtered and BEFORE
    // history dedup and before the expensive Dice/LinkedIn description
    // enrichment and the per-listing AI preference evaluation further down —
    // all of which is only affordable because irrelevant rows are pruned
    // here FIRST. Measured fixtures show this stage alone has pruned ~90%+ of
    // a raw pull (298/307, 300/400 rows); skipping that pruning would
    // multiply the app's most expensive human copy/paste handoff stage by
    // ~20x. The screen (screenJobRolesByTitle, jobPreferences.js) is a
    // semantic judgment over {index, title, company} — not a substring match
    // — and it FAILS OPEN: only an explicit 'mismatch' verdict drops a job,
    // 'unclear' keeps it. Run ONCE over the whole cross-source merged pool
    // (not per source) so a 9-source run spends one screening pass, not nine.
    // Skipped entirely (no AI call spent) when this run has no resolved
    // titles to screen against, matching the old gate's no-op behavior on an
    // exploratory (title-less) run.
    const roleScreenTitles = Array.isArray(activeJobPreferencePlan?.titles)
      ? activeJobPreferencePlan.titles.filter(t => typeof t === 'string' && t.trim())
      : [];
    let roleScreened = deduped;
    let roleDropped = 0;
    const roleDroppedBySource = {};
    let roleDroppedSamples = [];
    // Only rows this run has not already judged. On a RESUME, `deduped` is
    // seeded from the crashed attempt's staged rows, which already carry a
    // `roleScreen` stamp — re-sending them would spend an extra handoff on
    // every resume (including the "recover without any network" fast path) and,
    // because this is a non-deterministic semantic call, could flip a row the
    // interrupted run had accepted into a drop, silently changing the job set
    // for a reason the report never surfaces. Same rule the backstop in
    // evaluate-job-preferences uses; the funnel still balances because only
    // newly-judged rows can be removed here.
    const roleUnscreened = deduped.filter(job => !job?.roleScreen);
    if (roleScreenTitles.length > 0 && roleUnscreened.length > 0) {
      const roleScreenMeta = {};
      await assertSearchCurrent();
      const roleScreen = await screenJobRolesByTitle({
        jobs: roleUnscreened,
        titles: roleScreenTitles,
        signal: combinedSignal,
        callText: callLLMText,
        verdictStore: getJobRoleScreenVerdictStore(),
        meta: roleScreenMeta,
      });
      await assertSearchCurrent();
      const roleScreenDropped = Array.isArray(roleScreen?.droppedJobs) ? roleScreen.droppedJobs : [];
      // Rebuild from the FULL pool, preserving order: previously-screened rows
      // pass through untouched, freshly-judged rows consume verdicts in the
      // exact order they were sent. Provider-native ids are not globally
      // unique, so keying this merge can attach one source's verdict to
      // another source's listing.
      roleScreened = mergeRoleScreenedJobs(deduped, roleScreen);
      roleDropped = Number(roleScreen?.counts?.dropped) || roleScreenDropped.length;
      for (const job of roleScreenDropped) {
        const sid = job?.source || '?';
        roleDroppedBySource[sid] = (roleDroppedBySource[sid] || 0) + 1;
      }
      // Carry the model's OWN stated reason, not just the title. This is what
      // replaced `roleTokens` ("every title had to contain: [...]"): a semantic
      // screen has no token set, so the only checkable evidence for a drop is
      // the reason it gave for that specific listing.
      roleDroppedSamples = roleScreenDropped.slice(0, 8).map(job => ({ title: job?.title || '', source: job?.source || '?', reason: job?.roleScreen?.reason || '' }));
      const steps = roleScreen?.counts || {};
      const stepLog = `saved ${Number(steps.saved) || 0}, title-checked ${Number(steps.titleChecked) || 0}, snippet-checked ${Number(steps.snippetChecked) || 0} (snippet dropped ${Number(steps.snippetDropped) || 0}${steps.snippetFailed ? ', snippet step FAILED: unsure jobs kept' : ''})`;
      if (roleDropped > 0) {
        const bySourceLog = Object.entries(roleDroppedBySource).map(([sid, n]) => `${sid}:${n}`).join(', ');
        logger.info(`[Jobs][${nodeId}] AI role screen [${roleScreenTitles.join(' | ')}]: kept ${roleScreened.length}, dropped ${roleDropped} (${bySourceLog}); ${stepLog}`);
      } else {
        logger.info(`[Jobs][${nodeId}] AI role screen [${roleScreenTitles.join(' | ')}]: kept ${roleScreened.length}, dropped 0; ${stepLog}`);
      }
    }

    // Drop anything we've already shown the user on a previous run.
    let kept = roleScreened;
    let historyDropped = 0;
    let historyDropSamples = [];
    if (canvasFilePath) {
      await assertSearchCurrent();
      const history = await loadJobsHistory(canvasFilePath);
      await assertSearchCurrent();
      logger.info(`[Jobs][${nodeId}] History: ${history.length} entries loaded from ${path.basename(historyPathForCanvas(canvasFilePath) || canvasFilePath)}`);
      // Current-run display receipts never enter this CSV. Resume must retain
      // suppression from finalized earlier generations, even on the same day.
      const result = dedupAgainstHistory(roleScreened, history);
      kept = result.kept;
      historyDropped = result.removed;
      historyDropSamples = result.samples || [];
      try {
        const applied = filterAppliedListings(kept, await loadAppliedListingKeys(canvasFilePath));
        kept = applied.kept;
        if (applied.removed > 0) {
          historyDropped += applied.removed;
          logger.info(`[Jobs][${nodeId}] Applied-listing filter: dropped ${applied.removed} listing(s) already applied to`);
        }
      } catch (error) {
        logger.warn(`[Jobs][${nodeId}] Applied-listing filter unavailable: ${error?.message || error}`);
      }
    }

    // Enrich Dice jobs with full descriptions — runs after all filtering so we
    // only fetch detail pages for jobs that will actually be scored/shown.
    // This runs in EVERY run, including a local-only continuation
    // (finish-from-saved, or a resume of an already gathered checkpoint) that
    // sets skipProviderCollection: the detail fetch is a PUBLIC dice.com page
    // read — no API key, no login, no browser — not provider collection, and it
    // keeps the list summary on any failure. Skipping it there left Dice rows
    // scored on the list API's ~500-char `summary` (usually company boilerplate),
    // so the scorer had no real requirement to cite and the evidence validator
    // rejected the row in an endless correction loop.
    const diceKept = kept.filter(j => j.source === 'dice');
    if (diceKept.length > 0) {
      jobsTelemetry.pipeline = { ...(jobsTelemetry.pipeline || {}), phase: 'enriching-dice', ts: Date.now(), active: true, pendingSources: ['dice'] };
      // Longest text the row already carried (list summary/snippet), so the
      // re-stage below can tell a genuinely lengthened row from a fallback that
      // kept the teaser.
      const diceTextLength = job => Math.max(String(job?.description || '').length, String(job?.snippet || '').length);
      const diceTextLengthBefore = new Map(diceKept.map(j => [j.url, diceTextLength(j)]));
      await assertSearchCurrent();
      const enriched = await enrichDiceDescriptions(diceKept, combinedSignal);
      await assertSearchCurrent();
      const enrichedByUrl = new Map(enriched.map(j => [j.url, j]));
      // A Dice row confirmed closed on an ATS host is dropped, as LinkedIn does,
      // not restored from its unenriched copy.
      const diceClosedUrls = new Set(enriched.structurallyDroppedUrls || []);
      kept = kept
        .filter(j => !(j.source === 'dice' && diceClosedUrls.has(j.url)))
        .map(j => j.source === 'dice' && enrichedByUrl.has(j.url) ? enrichedByUrl.get(j.url) : j);

      // Re-stage the enriched Dice rows. The page-level rows staged at gather
      // time carry only the ~500-char list teaser, so a crash AFTER this point —
      // the long renderer-driven scoring/bucketing window — would resume and
      // score those teasers again (re-fetching every detail page, or worse,
      // failing the evidence validator with nothing to cite). The recovery seed
      // keeps the LAST staged copy per job, so these supersede the teaser rows.
      // Best-effort, like all staging.
      const diceEnrichedRows = filterJobsByDescriptionEvidence(kept.filter(j => j.source === 'dice'))
        .jobs.filter(job => (diceTextLengthBefore.get(job.url) ?? 0) < diceTextLength(job));
      // An unsaved canvas has no staging sidecar (recordSourcePage is a no-op
      // there and returns nothing), so only a saved canvas re-stages.
      if (canvasFilePath && diceEnrichedRows.length > 0) {
        await assertSearchCurrent();
        await beforeSearchStageWrite({ phase: 'before-dice-enrichment-stage', sourceId: 'dice', nodeId, runId: activeRunId });
        await assertSearchCurrent();
        const saved = await recordSourcePage(canvasFilePath, {
          sourceId: 'dice', query: '', page: 1, jobs: diceEnrichedRows,
          now: Date.now(), expectedRunId: activeRunId, nodeId, expectedOperationAuthority: authorityReceipt,
        });
        await assertSearchCurrent();
        if (saved !== true) return searchSupersededResult();
      }
    }

    // Enrich LinkedIn jobs with full descriptions via the shared stealth browser.
    // Plain fetch() returns HTTP 999; the browser bypasses that wall.
    // One tab is opened on the already-running browser, navigated through each
    // job URL sequentially, then closed. Stops early on a login wall.
    const linkedinKept = kept.filter(j => j.source === 'linkedin');
    if (!skipProviderCollection && linkedinKept.length > 0) {
      jobsTelemetry.pipeline = { ...(jobsTelemetry.pipeline || {}), phase: 'enriching-linkedin', ts: Date.now(), active: true, pendingSources: ['linkedin'] };
      // Re-enter 'searching' before browser enrichment so the source card stays
      // visible and its dismiss timer is cancelled. Without this, the card gets
      // its 'done' event when the API fetch finishes (10+ min ago), then the
      // 10 s grace fires and the card disappears while the hub is still running.
      emitProgress({
        nodeId,
        sourceId: 'linkedin',
        status: 'searching',
        count: linkedinKept.length,
        detail: 'enriching descriptions',
        // Provider collection already settled this source. These fields name
        // the distinct, post-gather description walk so the renderer does not
        // call it another source scan or overload the source/query counters.
        activity: 'description-enrichment',
        activityCompleted: 0,
        activityTotal: linkedinKept.length,
        completed: 0,
        total: 1,
      });

      if (JOB_SEARCH_TEST_MODE.enabled && !JOB_SEARCH_TEST_MODE.probeCooldown) {
        // Continuous enrichment: loop with 1m cooldown pauses until all jobs have descriptions.
        // Uses the measured cooldown from a prior probe run (same session) if available, else 1m default.
        const cooldownMs = jobsTelemetry.linkedinCooldown?.foundMs ?? 60_000;
        const cooldownMins = Math.round(cooldownMs / 60_000);
        const MAX_PASSES = 40;
        let lkPool = linkedinKept.slice();
        const lkStructuralDropped = new Set();
        // Consecutive zero-yield passes. A walled/soft-blocked pass that enriches
        // NOTHING even after a cooldown wait means the limit isn't clearing — stop
        // spinning rather than burn all MAX_PASSES on 0-yield retries.
        let noProgressStreak = 0;
        let lkBrowserUnavailableResult = null;

        for (let pass = 0; pass < MAX_PASSES; pass++) {
          const remaining = filterJobsByDescriptionEvidence(lkPool).dropped;
          if (remaining.length === 0) break;

          if (pass > 0) {
            emitProgress({ nodeId, sourceId: 'linkedin', status: 'searching', count: lkPool.length, detail: `enriching pass ${pass + 1}: ${remaining.length} remaining`, warning: null });
          }

          const passStartedAt = Date.now();
          await assertSearchCurrent();
          const { jobs: enriched, structuralDroppedKeys = [], loginWall, cancelled: lkCancelled = false, successCount = 0, attempted = remaining.length, contextRotations = 0, browserGen = null, browserAgeMs = null, noDesc = 0, noDescSoftBlock = 0, noDescGenuine = 0, evalErrors = 0, navErrors = 0, browserUnavailable = false, profileReserved = false, browserError = null, usedAuthenticated = false, authenticatedFallback = false } =
            await enrichLinkedInDescriptionsLocked(remaining, combinedSignal, { preferAuthenticated: preferLinkedInAuthenticated });
          await assertSearchCurrent();
          if (lkCancelled || combinedSignal.aborted) await throwIfSearchAborted();

          const byUrl = new Map(enriched.map(j => [j.url, j]));
          for (const key of structuralDroppedKeys) lkStructuralDropped.add(key);
          lkPool = lkPool.filter(j => !lkStructuralDropped.has(sourceJobKey(j)))
            .map(j => byUrl.has(j.url) ? byUrl.get(j.url) : j);
          const stillEmpty = filterJobsByDescriptionEvidence(lkPool).dropped.length;

          // The limit bites two ways: the URL-redirect wall (loginWall), and gutted
          // soft-block pages that come back as no-desc (title="" + 0 JSON-LD). The
          // latter does NOT trip the wall detector, but it's the same rate limit —
          // treat it as rate-limited so the loop waits and retries instead of
          // declaring a false "clean finish" and stranding recoverable jobs.
          const rateLimited = loginWall || noDescSoftBlock > 0;
          const ip = rateLimited ? await getEgressIp() : null;
          recordLinkedinEnrichPass({
            kind: 'search', ip, ipOk: rateLimited ? !!ip : null,
            walled: loginWall, browserUnavailable, attempted, remainingBefore: remaining.length, enriched: successCount, stillEmpty,
            noDesc, noDescSoftBlock, noDescGenuine, evalErrors, navErrors,
            contextRotations, browserGen, browserAgeMs, usedAuthenticated, authenticatedFallback, startedAt: passStartedAt,
          });

          if (browserUnavailable) {
            lkBrowserUnavailableResult = { profileReserved, browserError };
            logger.info(`[Jobs][${nodeId}] LinkedIn enrichment paused: shared browser unavailable (${browserError || 'unknown error'})`);
            break;
          }

          noProgressStreak = successCount > 0 ? 0 : noProgressStreak + 1;

          // Done when: nothing left; OR the residual is NOT recoverable (no wall and
          // no soft-blocks ⇒ only genuine no-desc / permanent failures remain); OR
          // repeated waits yield nothing (cooldown isn't clearing the limit).
          if (stillEmpty === 0 || !rateLimited || noProgressStreak >= 3) break;

          rememberLinkedInCeiling(ip);
          const reason = loginWall ? 'walled' : `${noDescSoftBlock} soft-block(s)`;
          logger.info(`[Jobs][${nodeId}] LinkedIn: ${reason} +${successCount}, ${stillEmpty} still empty — waiting ${cooldownMins}m`);
          emitProgress({ nodeId, sourceId: 'linkedin', status: 'searching', count: lkPool.length, detail: `rate-limited: waiting ${cooldownMins}m (${stillEmpty} still empty)`, warning: null });
          try {
            await abortableDelay(cooldownMs, combinedSignal);
          } catch {
            break; // signal fired during wait — exit loop cleanly
          }
        }

        const lkByUrl = new Map(lkPool.map(j => [j.url, j]));
        kept = kept.filter(j => !lkStructuralDropped.has(sourceJobKey(j)))
          .map(j => j.source === 'linkedin' ? (lkByUrl.get(j.url) || j) : j);
        clearLinkedInCeiling();
        if (lkBrowserUnavailableResult) {
          const warning = linkedInBrowserUnavailableWarning(lkBrowserUnavailableResult);
          emitProgress({ nodeId, sourceId: 'linkedin', count: lkPool.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning, completed: 1, total: 1 });
          scrapeWarnings.push({ sourceId: 'linkedin', url: 'https://www.linkedin.com/jobs', ...warning });
        } else {
          const shortWarning = linkedInShortDescriptionWarning(lkPool);
          emitProgress({ nodeId, sourceId: 'linkedin', count: lkPool.length, status: 'done', warning: shortWarning, completed: 1, total: 1 });
          if (shortWarning) scrapeWarnings.push({ sourceId: 'linkedin', url: null, ...shortWarning });
        }

      } else {
        // Single-pass enrichment. In probe mode: arms the cooldown probe on wall.
        // In production: emits a wait-or-switch warning and leaves Solve available.
        const lkPassStartedAt = Date.now();
        await assertSearchCurrent();
        const { jobs: enriched, structuralDroppedKeys = [], loginWall, cancelled: lkCancelled = false, successCount: lkSuccess = 0, attempted: lkAttempted = linkedinKept.length, contextRotations: lkRotations = 0, browserGen: lkBrowserGen = null, browserAgeMs: lkBrowserAgeMs = null, noDesc: lkNoDesc = 0, noDescSoftBlock: lkNoDescSoft = 0, noDescGenuine: lkNoDescGenuine = 0, evalErrors: lkEvalErrors = 0, navErrors: lkNavErrors = 0, noInternet: lkNoInternet = false, browserUnavailable: lkBrowserUnavailable = false, profileReserved: lkProfileReserved = false, browserError: lkBrowserError = null, usedAuthenticated: lkUsedAuthenticated = false, authenticatedFallback: lkAuthenticatedFallback = false } = await enrichLinkedInDescriptionsLocked(linkedinKept, combinedSignal, {
          preferAuthenticated: preferLinkedInAuthenticated,
          // Per-item beat so the card stops reading as a hang. Keep the
          // source/query counters at the one-source denominator stamped above;
          // `activityCompleted`/`activityTotal` are the truthful description
          // walk counters for the processing view.
          onProgress: ({ completed, total, detail }) => emitProgress({
            nodeId,
            sourceId: 'linkedin',
            status: 'searching',
            detail,
            activity: 'description-enrichment',
            activityCompleted: completed,
            activityTotal: total,
          }),
        });
        await assertSearchCurrent();
        if (lkCancelled || combinedSignal.aborted) await throwIfSearchAborted();
        const enrichedByUrl = new Map(enriched.map(j => [j.url, j]));
        const structurallyDropped = new Set(structuralDroppedKeys);
        kept = kept.filter(j => !structurallyDropped.has(sourceJobKey(j)))
          .map(j => j.source === 'linkedin' && enrichedByUrl.has(j.url) ? enrichedByUrl.get(j.url) : j);

        const lkStillEmpty = filterJobsByDescriptionEvidence(kept.filter(j => j.source === 'linkedin')).dropped.length;
        // The guest limit bites two ways: the hard URL-redirect wall (loginWall)
        // and gutted soft-block pages (noDescSoftBlock) that come back empty
        // without tripping the wall detector. Both signal the same guest-limit
        // condition, whose key may be IP, guest context, or fingerprint/session.
        // Either one, with descriptions STILL missing, gates the pipeline (the
        // user waits briefly or switches VPN, then Solve retries) rather than
        // scoring empties. (Mirrors the test-mode continuous loop above; a
        // soft-block-only pass used to fall through to a clean 'done' and score
        // the gutted residual.)
        if (lkBrowserUnavailable) {
          clearLinkedInCeiling();
          const browserWarning = linkedInBrowserUnavailableWarning({ profileReserved: lkProfileReserved, browserError: lkBrowserError });
          recordLinkedinEnrichPass({
            kind: 'search', ip: null, ipOk: null, walled: false, browserUnavailable: true,
            attempted: lkAttempted, remainingBefore: linkedinKept.length, enriched: lkSuccess, stillEmpty: lkStillEmpty, contextRotations: lkRotations,
            noDesc: lkNoDesc, noDescSoftBlock: lkNoDescSoft, noDescGenuine: lkNoDescGenuine, evalErrors: lkEvalErrors, navErrors: lkNavErrors,
            browserGen: lkBrowserGen, browserAgeMs: lkBrowserAgeMs, usedAuthenticated: lkUsedAuthenticated, authenticatedFallback: lkAuthenticatedFallback, startedAt: lkPassStartedAt,
          });
          emitProgress({ nodeId, sourceId: 'linkedin', count: linkedinKept.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: browserWarning, completed: 1, total: 1 });
          scrapeWarnings.push({ sourceId: 'linkedin', url: 'https://www.linkedin.com/jobs', ...browserWarning });
        } else if (lkNoInternet) {
          // Dead VPN egress during the initial search — descriptions failed at the
          // network layer (not a wall). Gate the pipeline with a "switch to a
          // working VPN server" prompt instead of scoring empty jobs. Reuses the
          // gating code so the Solve button + sources-ready pause behave the same;
          // NOT a rate-limit ceiling (the probe re-detects regardless of IP).
          clearLinkedInCeiling();
          const offlineIp = await getEgressIp();
          const offlineIpNote = offlineIp ? ` (IP ${offlineIp})` : '';
          recordLinkedinEnrichPass({
            kind: 'search', ip: offlineIp, ipOk: !!offlineIp, walled: false, noInternet: true,
            attempted: lkAttempted, remainingBefore: linkedinKept.length, enriched: lkSuccess, stillEmpty: lkStillEmpty, contextRotations: lkRotations,
            noDesc: lkNoDesc, noDescSoftBlock: lkNoDescSoft, noDescGenuine: lkNoDescGenuine, evalErrors: lkEvalErrors, navErrors: lkNavErrors,
            browserGen: lkBrowserGen, browserAgeMs: lkBrowserAgeMs, usedAuthenticated: lkUsedAuthenticated, authenticatedFallback: lkAuthenticatedFallback, startedAt: lkPassStartedAt,
          });
          const offlineWarning = {
            code: 'linkedin-rate-limited', severity: 'throttle', shortLabel: 'No internet',
            evidence: `This VPN IP has no working internet${offlineIpNote} — LinkedIn description fetches failed at the network layer${lkSuccess > 0 ? ` after +${lkSuccess}` : ''}. ${lkStillEmpty} job(s) still without one.`,
            suggestion: 'The VPN server you are on has no connection. Switch to a DIFFERENT VPN location (confirm a web page loads), then click Solve to continue.',
          };
          emitProgress({ nodeId, sourceId: 'linkedin', count: linkedinKept.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: offlineWarning, completed: 1, total: 1 });
          scrapeWarnings.push({ sourceId: 'linkedin', url: 'https://www.linkedin.com/jobs', ...offlineWarning });
        } else if ((loginWall || lkNoDescSoft > 0) && lkStillEmpty > 0) {
          rememberLinkedInCeiling(await getEgressIp());
          const ipNote = linkedinCeiling.ip ? ` (IP ${linkedinCeiling.ip})` : '';
          recordLinkedinEnrichPass({
            kind: 'search', ip: linkedinCeiling.ip, ipOk: !!linkedinCeiling.ip,
            walled: loginWall, attempted: lkAttempted, remainingBefore: linkedinKept.length, enriched: lkSuccess, stillEmpty: lkStillEmpty, contextRotations: lkRotations,
            noDesc: lkNoDesc, noDescSoftBlock: lkNoDescSoft, noDescGenuine: lkNoDescGenuine, evalErrors: lkEvalErrors, navErrors: lkNavErrors,
            browserGen: lkBrowserGen, browserAgeMs: lkBrowserAgeMs, usedAuthenticated: lkUsedAuthenticated, authenticatedFallback: lkAuthenticatedFallback, startedAt: lkPassStartedAt,
          });

          if (loginWall && JOB_SEARCH_TEST_MODE.probeCooldown) {
            // Probe mode: auto-run the cooldown measurement without a Solve click.
            const waitsMs = JOB_SEARCH_TEST_MODE.probeCooldownWaitsMin.map(m => Math.round(m * 60_000));
            const lkPool = kept.filter(j => j.source === 'linkedin');
            const { pool: probedPool, foundMs, attempt, browserUnavailable, profileReserved, browserError } =
              await runCooldownProbe(nodeId, waitsMs, lkPool, combinedSignal, emitProgress, null, {
                ownership: { nodeId, jobRunId: activeRunId },
                canWriteTelemetry: () => canWriteJobResolveTelemetry(nodeId, activeRunId),
                lockLinkedInEnrichment: true,
              });
            const probedByUrl = new Map(probedPool.map(j => [j.url, j]));
            kept = kept.map(j => j.source === 'linkedin' ? (probedByUrl.get(j.url) || j) : j);
            const probeStillEmpty = filterJobsByDescriptionEvidence(probedPool).dropped.length;
            if (browserUnavailable) {
              const browserWarning = linkedInBrowserUnavailableWarning({ profileReserved, browserError });
              emitProgress({ nodeId, sourceId: 'linkedin', count: probedPool.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: browserWarning, completed: 1, total: 1 });
              scrapeWarnings.push({ sourceId: 'linkedin', url: 'https://www.linkedin.com/jobs', ...browserWarning });
            } else if (foundMs != null && probeStillEmpty === 0) {
              clearLinkedInCeiling();
              emitProgress({ nodeId, sourceId: 'linkedin', count: probedPool.length, status: 'done', completed: 1, total: 1 });
            } else {
              const maxMin = foundMs != null
                ? Math.round(foundMs / 60000)
                : Math.round(Math.max(...waitsMs) / 60000);
              const probeWarning = foundMs != null
                ? {
                    code: 'linkedin-rate-limited', severity: 'throttle', shortLabel: 'Wait or switch VPN',
                    evidence: `Cooldown confirmed: ~${maxMin}m on this IP/browser. ${probeStillEmpty} job(s) still without description.`,
                    suggestion: `Wait ~${maxMin}m, then click Solve to resume enrichment. (Or switch VPN to a different working egress and retry.)`,
                  }
                : {
                    code: 'linkedin-rate-limited', severity: 'throttle', shortLabel: `Cooldown > ${maxMin}m`,
                    evidence: `Cooldown probe exhausted (${attempt} attempt(s), up to ${maxMin}m idle). ${probeStillEmpty} still without description.`,
                    suggestion: `The cooldown is longer than ${maxMin}m, or idle alone won't clear it. Extend JOB_SEARCH_PROBE_WAITS_MIN, Reset browser session, or try a residential IP.`,
                  };
              emitProgress({ nodeId, sourceId: 'linkedin', count: probedPool.length, status: 'error', url: 'https://www.linkedin.com/jobs', warning: probeWarning, completed: 1, total: 1 });
              scrapeWarnings.push({ sourceId: 'linkedin', url: null, ...probeWarning });
            }
          } else {
            // Normal: emit a wait-or-switch warning and leave Solve available.
            const reason = loginWall
              ? "LinkedIn temporarily limited description enrichment"
              : `LinkedIn served ${lkNoDescSoft} gutted (soft-blocked) page(s)`;
            const rateWarning = {
              code: 'linkedin-rate-limited',
              severity: 'throttle',
              shortLabel: 'Wait or switch VPN',
              evidence: `${reason} after ${lkSuccess} description(s)${ipNote} — ${lkStillEmpty} job(s) still without one.`,
              suggestion: 'Wait 1 minute, then click Solve to retry this IP; or switch VPN to a new working location and Solve now. A verified LinkedIn session is tried first when available.',
            };
            emitProgress({
              nodeId,
              sourceId: 'linkedin',
              count: linkedinKept.length,
              status: 'error',
              url: 'https://www.linkedin.com/jobs',
              warning: rateWarning,
              completed: 1,
              total: 1,
            });
            // Carry the Solve target on the persisted warning too (not just the
            // live progress event): the rate-limit now gates the pipeline in
            // 'sources-ready', and if the LinkedIn card was lost during the long
            // run, ensureBlockedSourceCards re-spawns it from this warning — it
            // needs the url to render the Solve button (else the user is stuck
            // with only Skip).
            scrapeWarnings.push({ sourceId: 'linkedin', url: 'https://www.linkedin.com/jobs', ...rateWarning });
          }
        } else {
          clearLinkedInCeiling();
          const finalLinkedIn = kept.filter(job => job.source === 'linkedin');
          const shortWarning = linkedInShortDescriptionWarning(finalLinkedIn);
          emitProgress({ nodeId, sourceId: 'linkedin', count: linkedinKept.length, status: 'done', warning: shortWarning, completed: 1, total: 1 });
          if (shortWarning) scrapeWarnings.push({ sourceId: 'linkedin', url: null, ...shortWarning });
          recordLinkedinEnrichPass({ kind: 'search', ip: null, ipOk: null, walled: false, attempted: lkAttempted, remainingBefore: linkedinKept.length, enriched: lkSuccess, stillEmpty: lkStillEmpty, contextRotations: lkRotations, noDesc: lkNoDesc, noDescSoftBlock: lkNoDescSoft, noDescGenuine: lkNoDescGenuine, evalErrors: lkEvalErrors, navErrors: lkNavErrors, browserGen: lkBrowserGen, browserAgeMs: lkBrowserAgeMs, usedAuthenticated: lkUsedAuthenticated, authenticatedFallback: lkAuthenticatedFallback, startedAt: lkPassStartedAt });
        }
      }

      // Re-stage the enriched LinkedIn rows. The page-level rows staged at
      // gather time have no descriptions, so a crash AFTER this point — the
      // long renderer-driven scoring/bucketing window, including a ≤24h pending
      // Batch run — would resume and re-burn the guest enrichment budget (the
      // pipeline's scarcest resource) on descriptions already fetched. The
      // recovery seed keeps the LAST staged copy per job, so these supersede
      // the bare gather-time rows. Best-effort, like all staging.
      const lkEnrichedRows = filterJobsByDescriptionEvidence(kept.filter(j => j.source === 'linkedin')).jobs;
      if (canvasFilePath && lkEnrichedRows.length > 0) {
        await assertSearchCurrent();
        await beforeSearchStageWrite({ phase: 'before-linkedin-enrichment-stage', sourceId: 'linkedin', nodeId, runId: activeRunId });
        await assertSearchCurrent();
        const saved = await recordSourcePage(canvasFilePath, {
          sourceId: 'linkedin', query: '', page: 1, jobs: lkEnrichedRows,
          now: Date.now(), expectedRunId: activeRunId, nodeId, expectedOperationAuthority: authorityReceipt,
        });
        await assertSearchCurrent();
        if (saved !== true) return searchSupersededResult();
      }
    }

    // Newest posted first. Deep pagination gathers across many pages and several
    // sources, so order the pool by recency before it reaches the fair per-source
    // scoring cap (which preserves each source's order) — that way the best slice
    // we score/surface is the most-recent, per the run's intent. Unparseable
    // dates sort last (kept, not dropped); the sort is stable so same-date ties
    // keep gather order (≈ platform relevance).
    const postedMsCache = new WeakMap();
    const postedMs = (j) => {
      if (j && typeof j === 'object' && postedMsCache.has(j)) return postedMsCache.get(j);
      const d = parsePostedDate(j?.posted);
      const ms = d ? d.getTime() : -Infinity;
      if (j && typeof j === 'object') postedMsCache.set(j, ms);
      return ms;
    };
    kept.sort((a, b) => postedMs(b) - postedMs(a));

    // Repair mojibake (UTF-8 mis-decoded as Latin-1) BEFORE anything reads the
    // text — some sources (RemoteOK's API) serve already-corrupted descriptions
    // ("we’d" → "weâ\x80\x99d"). Done here, on the final kept set, so the cleaned
    // text flows into language detection, scoring, the saved snapshot, the cards,
    // and the generated résumé alike. No-op on clean text and real accents.
    repairJobsMojibake(kept);

    // Strip HTML markup / decode entities the non-DOM extraction paths leave in.
    // WeWorkRemotely (regex over raw RSS XML) and LinkedIn (raw `description`
    // HTML) shipped "<p> <strong>Headquarters:</strong> …" bodies and
    // "Customer Support &amp; Product Demo Specialist" titles straight into the
    // scoring prompt, the cards and the résumé generator. Runs right after the
    // mojibake repair and before language filtering/scoring for the same reason
    // that one does: one chokepoint on the final kept set, so every consumer
    // sees the cleaned text and a new source inherits the fix.
    normalizeJobsMarkup(kept);

    // Glassdoor's list badge can lose cadence even when the full description we
    // already recovered states a pay-labelled cadence. Reconcile only that
    // grounded same-job evidence before salary bucketing/scoring; the helper is
    // source-scoped and leaves blank or already-usable salaries untouched.
    kept = kept.map(reconcileGlassdoorSalaryFromDescription);

    // Do not score or display blank/list-card-only/abnormally brief listings.
    // Crucially, this runs before the renderer receives `jobs`, so the Job Board
    // never writes these rows to durable seen history. They remain eligible to
    // return when a later scrape sees the employer's completed posting.
    // Preserve the post-admission source universe before the scoring-evidence
    // gate. In particular, LinkedIn Solve must be able to revisit rows stranded
    // by a guest wall; `jobs` below intentionally contains only score-safe rows.
    // Measured here because the gate below is exactly what hides a broken site: blank rows just vanish.
    // A site that already reported a wall, rate limit or sign-in problem has its own loud warning and Solve path, and no
    // fresh collection means an empty site is a choice the person made, not silence.
    const sourceHealthKnownStopped = sid => (sourceResults[sid]?.warnings || []).some(item => ['block', 'paste', 'throttle'].includes(item?.severity) || item?.code === 'linkedin-rate-limited');
    const sourceHealthFailures = assessSourceHealth(kept, {
      // A site whose every card was left unopened (already read or shown on an
      // earlier run) returned rows; it is not silent.
      silentlyEmptySourceIds: skipProviderCollection ? [] : activeSourceIds.filter(sid => countryApplicableSourceIds.has(sid)
        && !(sourceResults[sid]?.jobs?.length) && !(sourceResults[sid]?.warnings?.length)
        && !(Number(sourceResults[sid]?.alreadyReadSkipped) > 0)),
      // Cards an earlier blocked run of the same platform read. They passed
      // this check then, so they still count as measured rows; without them a
      // re-walk would be judged on the few cards it had to open, which are the
      // ones most likely to be incomplete.
      measuredEarlierBySource: Object.fromEntries(Object.keys(sourceResults).map(sid => [sid,
        Math.max(0, Number(sourceResults[sid]?.readEarlierSkipped) || 0)])),
      pageShapeFailures: Object.fromEntries(Object.entries(sourceResults).map(([sid, data]) => [sid, data?.pageShapeFailures || 0])),
      // Both the walker's window drop and the central age filter kept rows with
      // no parseable date and dropped dated ones, so the survivors skew undated.
      datedOutsideWindowBySource: Object.fromEntries(Object.keys(sourceResults).map(sid => [sid,
        Math.max(0, Number(sourceResults[sid]?.windowDropped) || 0) + Math.max(0, Number(ageBySource[sid]?.dropped) || 0)])),
      // A local-only continuation never runs the LinkedIn browser description
      // walk below, so LinkedIn rows carry no description by design and a
      // missing description there is not evidence the site changed. Dice is
      // absent on purpose: its detail enrichment is a public page read (not
      // provider collection) and still runs in a continuation, so a
      // description-less Dice row is real evidence again.
      descriptionNotFetchedSourceIds: skipProviderCollection ? ['linkedin'] : [],
    }).filter(item => !sourceHealthKnownStopped(item.source));
    for (const sid of new Set(sourceHealthFailures.map(item => item.source))) {
      const warning = sourceHealthWarning(sid, sourceHealthFailures);
      logger.error(`[Jobs][${nodeId}] Scrape health failed for ${sid}: ${warning.evidence}`);
      const result = sourceResults[sid] || (sourceResults[sid] = { jobs: [], warnings: [], errors: 0, pagesWalked: 0, stopReasons: new Set() });
      result.warnings = [...(result.warnings || []), warning];
      result.healthFailures = sourceHealthFailures.filter(item => item.source === sid).map(({ field, rows, missing }) => ({ field, rows, missing }));
      scrapeWarnings.push({ sourceId: sid, url: sourceFirstUrl[sid] || null, ...warning });
      emitProgress({ nodeId, sourceId: sid, status: 'done', count: result.jobs?.length || 0, warning, completed: 1, total: 1 });
    }
    // A local-only continuation ("Finish with saved listings", or a resume of an
    // already gathered/finished checkpoint) deliberately skips the scraped
    // collection and, with it, the LinkedIn browser description walk, so every
    // un-enriched LinkedIn row is description-less by design. That is not a site
    // change: those rows were deferred by the description gate and stay
    // recoverable by Solve, so this gets a calm notice on the scrape warnings
    // only — no source warning, no progress event and no error log that would
    // read as a broken site. Dice is NOT covered here: its detail enrichment is
    // a public page read, not provider collection, and still runs in a
    // continuation, so a description-less Dice row is real evidence again.
    if (skipProviderCollection) {
      const warning = descriptionsNotFetchedWarning('linkedin', kept);
      if (warning) {
        logger.info(`[Jobs][${nodeId}] linkedin: ${warning.evidence}`);
        scrapeWarnings.push({ sourceId: 'linkedin', url: sourceFirstUrl.linkedin || null, ...warning });
      }
    }
    // A walk guard means a walker stopped a walk for lack of real progress or
    // at a safety backstop. Surface it per source as a non-gating 'warn' so
    // scoring of the rows already gathered continues. Never change the source
    // manifest status here.
    for (const sid of Object.keys(sourceResults)) {
      const result = sourceResults[sid];
      const warning = walkGuardWarning(sid, result?.walkGuards);
      if (!warning) continue;
      logger.error(`[Jobs][${nodeId}] Scrape walk stopped early for ${sid}: ${warning.evidence}`);
      result.warnings = [...(result.warnings || []), warning];
      scrapeWarnings.push({ sourceId: sid, url: sourceFirstUrl[sid] || null, ...warning });
      emitProgress({ nodeId, sourceId: sid, status: 'done', count: result.jobs?.length || 0, warning, completed: 1, total: 1 });
    }
    const descriptionRecoveryJobs = kept.slice();
    const descriptionEvidence = filterJobsByDescriptionEvidence(kept);
    kept = descriptionEvidence.jobs;
    if (descriptionEvidence.dropped.length > 0) {
      logger.info(`[Jobs] Deferred ${descriptionEvidence.dropped.length} description-incomplete listing(s) (explicit=${descriptionEvidence.quality.deferred}, empty=${descriptionEvidence.quality.empty}, short=${descriptionEvidence.quality.short}; threshold=400 chars) — not scored or marked seen`);
    }
    // A job board reporting a listing closed is not the last word: the employer's
    // own posting may still be live. Board-closed rows this gate dropped are set
    // aside (they stay in descriptionEvidence.dropped for every existing
    // bookkeeping use) and rejoin the final dedup and the official-posting
    // resolver; the keep/drop rule runs after resolution.
    const boardClosedAside = boardClosedSetAside(descriptionEvidence);

    // Descriptions obtained during enrichment can turn two formerly
    // incomparable board cards into an exact cross-source match. Run the same
    // conservative identity rule one final time on score-safe rows so the
    // scorer, staging checkpoint, cards, and seen-history writer share one
    // duplicate-free universe. This is deliberately AFTER the evidence gate:
    // an incomplete listing remains recoverable instead of being hidden merely
    // because a better-described board copy happened to arrive first.
    const finalDedupDrops = [];
    // Set-aside board-closed rows join the dedup. preferOpenRows: first-wins dedup
    // must never let a closed copy beat an open copy of the same posting.
    const livenessOrderInput = [...kept, ...boardClosedAside];
    const preferredLivenessOrder = preferOpenRows(livenessOrderInput);
    const livenessReordered = preferredLivenessOrder !== livenessOrderInput;
    kept = preferredLivenessOrder;
    const finalDeduped = dedupByTitleCompany(kept, {
      onDuplicate: (entry) => { finalDedupDrops.push(entry); },
    });
    const finalDedupDropped = finalDedupDrops.length;
    if (finalDedupDropped > 0) {
      logger.info(`[Jobs] Final enrichment-ready dedup removed ${finalDedupDropped} duplicate score-safe listing(s)`);
    }
    kept = finalDeduped;
    await assertSearchCurrent();
    const officialResolution = await settleScrapedRowsForScoring(kept, {
      signal: combinedSignal,
      alternateReceipts: { admissionDrops: dedupDrops, finalDrops: finalDedupDrops },
    });
    await assertSearchCurrent();
    kept = officialResolution.jobs;
    const officialDedupDropped = officialResolution.officialDedupDropped;
    const boardClosedDropped = Math.max(0, Number(officialResolution.boardClosedDropped) || 0);
    const officialResolutionChanged = officialDedupDropped > 0 || boardClosedDropped > 0 || kept.some((job, index) =>
      JSON.stringify([job?.source, job?.url, job?.googleCardUrl, job?.jobkey,
        job?.postedBy, job?.officialPosting, job?.boardClosed, job?.listingLiveness])
        !== JSON.stringify([finalDeduped[index]?.source, finalDeduped[index]?.url,
          finalDeduped[index]?.googleCardUrl, finalDeduped[index]?.jobkey,
          finalDeduped[index]?.postedBy, finalDeduped[index]?.officialPosting,
          finalDeduped[index]?.boardClosed, finalDeduped[index]?.listingLiveness]));
    // preferOpenRows moved board-closed rows behind the open ones for dedup; put
    // the survivors back in recency order.
    if (livenessReordered) kept.sort((a, b) => postedMs(b) - postedMs(a));
    // Keep bounded provenance for BOTH passes. The final-pass count is also a
    // first-class funnel stage below, so it cannot silently look like an AI or
    // renderer loss.
    const dedupProvenance = boundedDedupProvenance([
      ...dedupDrops.map(entry => ({ ...entry, stage: 'admission' })),
      ...finalDedupDrops.map(entry => ({ ...entry, stage: 'final-enrichment' })),
      ...officialResolution.officialDedupDrops.map(entry => ({ ...entry, stage: 'official-posting' })),
    ]);

    // Filter by the English share of the scraped description. Keep English-majority bilingual jobs; dropped rows never reach
    // scoring or seen-history. Tally the pre-filter list after the helper tags
    // only the dropped rows, so diagnostics retain their languages and samples.
    const languageFilter = filterNonEnglishJobs(kept);
    const languageTelemetry = summarizeJobLanguages(kept);
    kept = languageFilter.jobs;
    if (languageFilter.dropped.length > 0) {
      logger.info(`[Jobs] Dropped ${languageFilter.dropped.length} listing(s) whose descriptions are not primarily English — not scored or marked seen`);
    }

    // Do NOT write even the eligible rows to seen-history yet. The Job Board is
    // the single authoritative writer after it displays cards; leaving the
    // low-evidence and non-English rows out of this telemetry confirms a future
    // run cannot hide them merely because this scrape encountered them first.
    recordHistoryWrite('preScoring', kept, {
      written: 0,
      pruned: 0,
      skipped: canvasFilePath ? 'deferred until results are visible' : 'no-canvas-path',
    });

    logger.info(
      `[Jobs] ${kept.length} new jobs (raw=${relevanceFunnel.raw}, relevanceDropped=${relevanceFunnel.relevanceDropped}, windowEligible=${windowEligible.length}, ageDropped=${ageDropped}, afterDedup=${deduped.length}, dedupDropped=${Math.max(0, windowEligible.length - deduped.length)}, roleDropped=${roleDropped}, historyDropped=${historyDropped}, finalDedupDropped=${finalDedupDropped}, languageDropped=${languageFilter.dropped.length})`
    );
    // Per-source raw gathered counts (+ strongest warning), for active sources so a
    // 0 is visible — answers "was this source silently not gathered?" the way the
    // marketplace funnel does. A 0 WITH a warning is a real miss to investigate; a
    // clean 0 is genuinely-empty / off-category (e.g. a cinematographer on USAJobs).
    const bySource = {};
    for (const sid of activeSourceIds) {
      const data = sourceResults[sid] || { jobs: [], warnings: [] };
      const w = (data.warnings || []).find(x => x?.severity === 'block')
        || (data.warnings || []).find(x => x?.code === SOURCE_HEALTH_WARNING_CODE)
        || (data.warnings || []).find(x => x?.code === WALK_GUARD_WARNING_CODE)
        || (data.warnings || []).find(x => x?.severity === 'info')
        || (data.warnings || [])[0] || null;
      bySource[sid] = {
        count: data.jobs.length,
        unique: uniqueBySource[sid] || 0,
        ...(data.enrichment ? { enrichment: data.enrichment } : {}),
        warning: w ? {
          code: w.code,
          severity: w.severity,
          evidence: w.evidence ? String(w.evidence).slice(0, 700) : null,
        } : null,
      };
      // How deep the date-bounded walk went + why it stopped — only for the
      // paginating browser sources (one-shot / API sources leave it unset).
      if (data.claimedTotal != null) bySource[sid].claimedTotal = data.claimedTotal;
      if (data.directContinuation) bySource[sid].directContinuation = data.directContinuation;
      if (Array.isArray(data.revealOutcomes) && data.revealOutcomes.length > 0) {
        bySource[sid].revealOutcomes = data.revealOutcomes.slice(0, 20);
      }
      if (data.googleApplyCapture) bySource[sid].googleApplyCapture = data.googleApplyCapture;
      // Dated cards this source's page selection dropped for being outside the
      // collection window, and what the health check flagged. Fixed contract:
      // the bug report reads these names.
      if (Number(data.windowDropped) > 0) {
        bySource[sid].windowDropped = Math.max(0, Math.floor(Number(data.windowDropped)));
      }
      if (Number(data.alreadyReadSkipped) > 0) {
        bySource[sid].alreadyReadSkipped = Math.max(0, Math.floor(Number(data.alreadyReadSkipped)));
      }
      if (Array.isArray(data.healthFailures) && data.healthFailures.length > 0) {
        bySource[sid].healthFailures = data.healthFailures
          .slice(0, 8)
          .map(({ field, rows, missing }) => ({ field, rows, missing }));
      }
      if (data.pagesWalked > 0) {
        bySource[sid].pagesWalked = data.pagesWalked;
      }
      if (Array.isArray(data.walkGuards) && data.walkGuards.length > 0) {
        bySource[sid].walkGuards = sanitizeWalkGuards(data.walkGuards, 8)
          .map(({ kind, query, page, pages, newRows, detail }) => ({ kind, query, page, pages, newRows, detail }));
      }
      // API walkers can hit their finite request limit exactly, so their outer
      // merge has no post-fetch cap overflow to expose. Preserve the walker's
      // own compact cap fact before a restart loses in-memory sourceResults.
      // 'source-internal' is the source's OWN result ceiling (LinkedIn stops at
      // 150), not a user setting. It was excluded here, so a run that stopped at
      // that ceiling reported the bare stop reason `result-ceiling` with no
      // number — leaving a reader unable to tell whether 150 or 1000 rows were
      // left behind. Persist it; the report labels it distinctly from the
      // user-configured caps and it is still rejected as configured-cap PROOF.
      if (data.cap && typeof data.cap === 'object'
          && ['per-platform', 'jobs-per-platform', 'pages-per-platform', 'auto-jobs-per-platform', 'auto-pages-per-platform', 'source-internal'].includes(data.cap.type)
          && data.cap.limit != null && data.cap.limit !== ''
          && Number.isFinite(Number(data.cap.limit)) && Number(data.cap.limit) > 0) {
        bySource[sid].cap = { type: data.cap.type, limit: Math.floor(Number(data.cap.limit)) };
      }
      if (Array.isArray(data.caps)) {
        const caps = data.caps
          .filter(cap => ['per-platform', 'jobs-per-platform', 'pages-per-platform', 'auto-jobs-per-platform', 'auto-pages-per-platform', 'source-internal'].includes(cap?.type)
            && Number.isSafeInteger(cap.limit) && cap.limit > 0)
          .filter((cap, index, values) => values.findIndex(other => other.type === cap.type && other.limit === cap.limit) === index)
          .slice(0, 3)
          .map(cap => ({ type: cap.type, limit: cap.limit }));
        if (caps.length > 0) bySource[sid].caps = caps;
      }
      // Manual walkers use a Set while API fan-out now returns an array. The
      // normalized Set lets either source surface its stop reason, including
      // one-shot/API sources that have no pagesWalked counter.
      const stopReasons = data.stopReasons instanceof Set
        ? data.stopReasons
        : new Set(data.stopReasons || []);
      if (stopReasons.size > 0) {
        bySource[sid].stopReason = [...stopReasons]
          .map(r => (typeof r === 'string' ? r : r?.stopReason))
          .filter(Boolean)
          .join('/') || null;
        if (stopReasons.has('per-source-cap')) {
          // Browser sources cannot know how many additional matches exist without
          // issuing more pages. Preserve the actual enforced aggregate cap so the
          // report never calls this a clean/exhausted search.
          bySource[sid].cap = {
            type: normalizedCollectionLimits.jobsPerPlatform == null ? 'auto-jobs-per-platform' : 'per-platform',
            limit: resolveJobsPerPlatform(normalizedCollectionLimits),
          };
        }
      }
      // Pre-limit match count for API sources — surface an explicit user-set
      // platform limit rather than silently hiding extra in-window matches.
      if (data.gathered != null) {
        bySource[sid].gathered = data.gathered;
        // Prefer the measured cap drop; fall back to the old derivation only for
        // a source that did not report one, and keep the two distinguishable.
        const capOverflow = Number.isFinite(Number(data.capDropped))
          ? Math.max(0, Number(data.capDropped))
          : Math.max(0, Number(data.gathered) - data.jobs.length);
        bySource[sid].capOverflow = capOverflow;
        if (data.crossQueryDuplicates > 0) bySource[sid].crossQueryDuplicates = data.crossQueryDuplicates;
        // Anything the measured cap and the measured dedup together cannot
        // account for stays explicitly UNATTRIBUTED rather than being folded
        // into whichever bucket happens to be adjacent.
        const unattributed = Math.max(
          0,
          Number(data.gathered) - data.jobs.length - capOverflow
            - Number(data.crossQueryDuplicates || 0)
            - Number(data.collectionAgeDropped || 0)
            - Number(data.platformDuplicateDropped || 0)
            // Listings that name another country are removed before the
            // platform allowance, so they are missing from `data.jobs` too.
            - Number(data.countryScopeDropped || 0),
        );
        if (unattributed > 0) bySource[sid].unattributedShortfall = unattributed;
        if (capOverflow > 0) {
          // HTTP fan-out applies the user-facing aggregate Jobs-per-platform
          // limit only after individual query walks are merged. This outer
          // slice is the fact that bounded the source result delivered to the
          // board, so preserve the SAME public cap type and stop token. The
          // diagnostic contract deliberately rejects a structured cap without
          // evidence that its corresponding limit actually fired.
          if (!(data.stopReasons instanceof Set)) {
            data.stopReasons = new Set(data.stopReasons || []);
          }
          const autoJobs = normalizedCollectionLimits.jobsPerPlatform == null;
          data.stopReasons.add(autoJobs ? 'auto-jobs-per-platform' : 'jobs-per-platform');
          bySource[sid].cap = {
            type: autoJobs ? 'auto-jobs-per-platform' : 'jobs-per-platform',
            limit: resolveJobsPerPlatform(normalizedCollectionLimits),
          };
          if (bySource[sid].cap) {
            const caps = Array.isArray(bySource[sid].caps) ? bySource[sid].caps : [];
            if (!caps.some(cap => cap.type === bySource[sid].cap.type && cap.limit === bySource[sid].cap.limit)) {
              caps.unshift(bySource[sid].cap);
            }
            bySource[sid].caps = caps.slice(0, 3);
          }
          // `bySource.stopReason` was serialized above, before the aggregate
          // overflow was measurable. Re-serialize it here so the durable
          // receipt and live completion assessment see the same evidence.
          bySource[sid].stopReason = [...data.stopReasons]
            .map(r => (typeof r === 'string' ? r : r?.stopReason))
            .filter(Boolean)
            .join('/') || null;
        }
      }
      if (data.detailBlock) bySource[sid].detailBlock = data.detailBlock;
      if (data.providerDuplicatesDropped) bySource[sid].providerDuplicatesDropped = data.providerDuplicatesDropped;
      if (data.platformDuplicateDropped) bySource[sid].platformDuplicateDropped = data.platformDuplicateDropped;
      if (data.collectionAgeDropped) bySource[sid].collectionAgeDropped = data.collectionAgeDropped;
      if (data.unavailableDetailDropped) bySource[sid].unavailableDetailDropped = data.unavailableDetailDropped;
      if (data.boardClosedDetailKept) bySource[sid].boardClosedDetailKept = data.boardClosedDetailKept;
      if (data.locationScopeUnenforced === true) bySource[sid].locationScopeUnenforced = true;
      if (data.providerGathered != null) bySource[sid].providerGathered = data.providerGathered;
      // The API-side twin of `claimedTotal` above. Without it a source that
      // walked 44 of 973 and one whose whole corpus IS 44 render identically —
      // the extractors compute this precisely so those two cannot be confused,
      // and dropping it here was where that distinction died.
      if (data.providerTotal != null) bySource[sid].providerTotal = data.providerTotal;
      if (data.truncated) bySource[sid].truncated = true;
      if (data.relevanceDropped > 0) bySource[sid].relevanceDropped = data.relevanceDropped;
      if (data.sponsoredDropped > 0) bySource[sid].sponsoredDropped = data.sponsoredDropped;
      if (data.admissionRelevanceDropped > 0) bySource[sid].admissionRelevanceDropped = data.admissionRelevanceDropped;
      if (data.countryScopeDropped > 0) bySource[sid].countryScopeDropped = data.countryScopeDropped;
      if (Array.isArray(data.remoteFeedProvenance) && data.remoteFeedProvenance.length > 0) {
        bySource[sid].remoteFeedProvenance = data.remoteFeedProvenance;
      }
      if (Array.isArray(data.relevanceRejected) && data.relevanceRejected.length > 0) {
        bySource[sid].relevanceRejected = data.relevanceRejected;
      }
    }
    // Per-source date-bound truth. Bucketed APIs round up rather than silently
    // narrowing the requested window; sources without a usable server filter
    // say so explicitly. The merged client filter remains the final backstop.
    const diceBucket = dicePostedBucket(ageDays);
    const glassdoorBucket = glassdoorPostedBucket(ageDays);
    // Dice sizes every API request to a finite Jobs-per-platform setting. The
    // date-bound diagnostic must show that effective request size rather than
    // its usual 400/1000 default, or a bounded run falsely looks like it
    // over-pulled a full page.
    const dateBounds = Object.fromEntries(activeSourceIds.map((id) => {
      // Each platform reports the horizon/boundary IT was dispatched with; a
      // source without its own window is byte-identical to the run-level text.
      const sourceAgeDays = ageDaysFor(id);
      const sourceDateBoundary = new Date(postedSinceFor(id)).toISOString();
      const sourceDiceBucket = sourceAgeDays === ageDays ? diceBucket : dicePostedBucket(sourceAgeDays);
      const sourceGlassdoorBucket = sourceAgeDays === ageDays
        ? glassdoorBucket
        : glassdoorPostedBucket(sourceAgeDays);
      const sourceDiceEffectivePageSize = sourceDiceBucket ? 400 : 1000;
      const sourceDicePageSizeFact = `pageSize ${normalizedCollectionLimits.jobsPerPlatform == null
        ? sourceDiceEffectivePageSize
        : Math.min(sourceDiceEffectivePageSize, normalizedCollectionLimits.jobsPerPlatform)}${normalizedCollectionLimits.jobsPerPlatform != null ? ' (limited by Jobs per platform)' : ''}`;
      let detail = `client exact ≥ ${sourceDateBoundary}`;
      if (id === 'dice') detail = sourceDiceBucket
        ? `filters.postedDate=${sourceDiceBucket} (server-side; ${sourceDicePageSizeFact}); client exact ≥ ${sourceDateBoundary}`
        : `client exact ≥ ${sourceDateBoundary} (${sourceAgeDays}d provider request ∉ Dice's 1/3/7-day buckets; ${sourceDicePageSizeFact})`;
      else if (id === 'glassdoor') detail = sourceGlassdoorBucket
        ? `fromAge=${sourceGlassdoorBucket} (server bucket rounded up); client exact ≥ ${sourceDateBoundary}`
        : `client exact ≥ ${sourceDateBoundary} (${sourceAgeDays}d provider request exceeds Glassdoor's 30-day server bucket)`;
      else if (id === 'ziprecruiter') detail = `days=${sourceAgeDays}; client exact ≥ ${sourceDateBoundary}`;
      else if (id === 'indeed') detail = `fromage=${sourceAgeDays}; client exact ≥ ${sourceDateBoundary}`;
      else if (id === 'linkedin') detail = `f_TPR=r${sourceAgeDays * 86400}; client exact ≥ ${sourceDateBoundary}`;
      else if (id === 'usajobs') detail = sourceAgeDays <= 60
        ? `DatePosted=${sourceAgeDays}; client exact ≥ ${sourceDateBoundary}`
        : `client exact ≥ ${sourceDateBoundary} (${sourceAgeDays}d provider request exceeds USAJobs' 60-day DatePosted limit)`;
      return [id, detail];
    }));
    // Location observability: the raw user input ("denvr"), the corrected param
    // actually sent ("Denver, CO"), how each active source applied it, and an
    // adherence tally over the KEPT jobs — so "did the typo get corrected?" and
    // "was location adhered to per platform?" are answerable from the report.
    const locationTelemetry = {
      rawInput: String(rawLocation || '').trim() || null,
      canonical: location || null,
      corrected: !!(rawLocation && location && String(rawLocation).trim().toLowerCase() !== location.toLowerCase()),
      inferredFromCareerData: !String(rawLocation || '').trim() && !!location,
      target: normalizeLocationInput(location),
      perSource: Object.fromEntries(activeSourceIds.map((id) => {
        const policy = sourceCountryPolicyById[id] || getJobSourceCountryPolicy(id, location);
        if (!policy.include) return [id, `Skipped — ${policy.reason}`];
        const mechanism = describeLocationTreatment(id, location, countryScope);
        if (policy.filterStrength === 'global-remote') return [id, `${policy.label} — no country filter; eligibility remains listing-specific`];
        if (policy.filterStrength === 'best-effort') return [id, `${policy.label} — ${mechanism}`];
        if (policy.requiresResolvedLocation) return [id, `${policy.label} — ${mechanism}; skipped unless exact resolution succeeds`];
        return [id, `${policy.label} — ${mechanism}`];
      })),
      adherence: summarizeLocationAdherence(kept, location),
    };
    // Compact all-source relevance audit over the final kept set. Exact source
    // admission evidence is retained for keyword-less feeds. For provider-ranked
    // searches, the post-hoc title audit is diagnostic only: no local title
    // mismatch is allowed to remove a platform-approved result.
    const relevanceAudit = {};
    // This retrospective audit uses the keyword-less feed matcher (exact/synonym
    // vocabulary against the search queries actually sent). There is no more
    // pinned-title evidence to merge in alongside it: the deterministic gate
    // that used to supply it is gone, and role fit is now judged semantically
    // (not by substring) later in the pipeline by the AI role screen — see
    // jobPreferences.js.
    for (const sourceId of activeSourceIds) {
      const trace = sourceResults[sourceId]?.relevanceTrace;
      const keptUrls = new Set(kept.filter(job => job.source === sourceId).map(job => job.url).filter(Boolean));
      const exactRows = Array.isArray(trace)
        ? trace.filter(row => !row?.url || keptUrls.has(row.url)).slice(0, 20)
        : [];
      if (exactRows.length > 0) {
        relevanceAudit[sourceId] = { mode: 'admission', rows: exactRows };
        continue;
      }
      const sourceJobs = kept.filter(job => job.source === sourceId).slice(0, 20);
      if (sourceJobs.length === 0) continue;
      relevanceAudit[sourceId] = {
        mode: 'post-hoc-title-audit',
        rows: sourceJobs.map(job => {
          const matched = (Array.isArray(queries) ? queries : [])
            .map(query => jobRelevanceEvidence(job.title, query))
            .filter(Boolean);
          return {
            url: job.url,
            title: job.title,
            company: job.company,
            matched,
            // A provider-ranked source can legitimately return a row without
            // local keyword-matcher evidence — that is expected, not a leak,
            // when the search trusts the board's own ranking.
            providerAcceptedWithoutLocalTitleMatch: matched.length === 0,
          };
        }),
      };
    }
    jobsTelemetry.pipeline = { ...(jobsTelemetry.pipeline || {}), phase: 'finalizing-search', ts: Date.now(), active: true, pendingSources: [] };
    jobsTelemetry.search = {
      ts: Date.now(),
      runId: activeRunId,
      runOrigin: normalizedRunOrigin,
      profileInputMode: normalizedProfileInputMode,
      queries: queries.length,
      // Role queries are shared raw input for every source. Google has no location
      // param, so its actual keyword query may append the canonical location; keep
      // that expanded form separately so a bug report never claims the raw string
      // was sent unchanged to Google.
      queryStrings: Array.isArray(queries) ? queries.slice(0, 12) : [],
      googleQueryStrings: extractExecutedGoogleQueryStrings(sourceResults),
      raw: relevanceFunnel.raw,
      relevanceDropped: relevanceFunnel.relevanceDropped,
      countryScopeDropped: countryScopeAdmission.dropped,
      countryScopeDroppedBySource: countryScopeAdmission.droppedBySource,
      // New-order marker: exact-window eligibility precedes first-wins dedup so
      // an old duplicate can never evict a valid newer row. Receipts without
      // this field use the historical dedup→age funnel interpretation.
      windowEligible: windowEligible.length,
      // The explicit cap stage makes the conservation equation truthful: the
      // old report called every post-window loss a cross-platform dedup even
      // when a configured platform allowance was what removed the rows.
      platformDuplicateDropped: Object.values(platformCap.sourceStats)
        .reduce((sum, stats) => sum + Math.max(0, Number(stats?.duplicateDropped) || 0), 0),
      platformCapDropped: Object.values(platformCap.sourceStats)
        .reduce((sum, stats) => sum + Math.max(0, Number(stats?.capDropped) || 0), 0),
      platformUnique: windowEligible.length - Object.values(platformCap.sourceStats)
        .reduce((sum, stats) => sum + Math.max(0, Number(stats?.duplicateDropped) || 0), 0),
      platformCapped: platformCap.jobs.length,
      deduped: deduped.length,
      dedupProvenance,
      searchWindow: activeSearchWindow,
      appliedInitialLookbackDays,
      // Backward-compatible diagnostic alias for the intentionally broad
      // provider request, not a user-configured date-window setting.
      maxAgeDays: ageDays,
      collectionLimits: normalizedCollectionLimits,
      ageDropped,
      ageBySource, // per-source: { dropped, kept, oldestKeptDays, oldestKeptRaw, unparseableKept }
      dateBounds,
      // AI role screen (0 on a run with no resolved titles). `roleDroppedSamples`
      // carries the actual dropped job {title, source} pairs so the report shows
      // what the screen did rather than asserting why a board returned them.
      // No `roleTokens` field: this is a semantic AI judgment against the full
      // resolved title list, not a word-match, so there is no token set to show.
      roleDropped,
      roleDroppedBySource,
      roleDroppedSamples,
      historyDropped,
      historyDropSamples,
      kept: kept.length,
      finalDedupDropped,
      officialDedupDropped,
      // Funnel stages for board-closed rows: rescued from the evidence gate for the
      // official-posting pass, and removed by it when no official source kept them.
      ...(boardClosedAside.length > 0 || boardClosedDropped > 0
        ? { boardClosedSetAside: boardClosedAside.length, boardClosedDropped } : {}),
      officialPosting: officialResolution.officialPosting,
      descriptionEvidenceDropped: {
        total: descriptionEvidence.dropped.length,
        deferred: descriptionEvidence.quality.deferred,
        empty: descriptionEvidence.quality.empty,
        short: descriptionEvidence.quality.short,
        bySource: descriptionEvidence.quality.bySource,
        samples: descriptionEvidence.quality.samples,
      },
      bySource,
      location: locationTelemetry,
      languages: languageTelemetry,
      languageDropped: languageFilter.dropped.length,
      relevanceAudit,
      // Data-driven browser-scrape order this run + the per-source manual-solve
      // history that produced it — so "why did Google scrape first?" is answerable.
      browserOrder,
      verification: getVerificationSnapshot(),
    };
    const funnelReconciliation = reconcileSearchFunnel(jobsTelemetry.search);
    jobsTelemetry.search.reconciliation = funnelReconciliation;
    if (funnelReconciliation && !funnelReconciliation.reconciled) {
      const warning = {
        sourceId: 'search-pipeline',
        url: null,
        code: 'job-funnel-accounting-mismatch',
        severity: 'warn',
        evidence: `Search accounting did not reconcile: expected ${funnelReconciliation.expectedKept} kept job(s), observed ${funnelReconciliation.kept} (delta ${funnelReconciliation.unexplainedDelta}).`,
        suggestion: 'Do not treat this run as complete until the FULL/JOBS report identifies the unaccounted stage.',
      };
      scrapeWarnings.push(warning);
      logger.warn(`[Jobs][${nodeId}] ${warning.evidence}`);
    }
    // Search (gather) phase done — mark the manifest so a crash during the
    // RENDERER-driven scoring/bucketing that follows resumes from scoring (the
    // gathered jobs are recovered from staging) rather than re-scraping.
    await throwIfSearchAborted();
    await assertSearchCurrent();
    // Per-source terminal states were first recorded immediately after the
    // scrape. Description enrichment runs later and can introduce a renderer
    // gating warning (notably LinkedIn's throttle), so repair the manifest
    // before allowing gathered-only recovery to trust its all-done predicate.
    // Keep this aligned with isJobSourceWarningGating without importing a
    // renderer utility into the main process.
    const finalGatingSourceIds = new Set(
      scrapeWarnings
        .filter(warning => activeSourceIds.includes(warning?.sourceId)
          && (warning?.severity === 'block'
            || warning?.severity === 'paste'
            || warning?.code === 'linkedin-rate-limited'))
        .map(warning => warning.sourceId),
    );
    for (const sourceId of finalGatingSourceIds) {
      const sourceWarnings = scrapeWarnings.filter(warning => warning?.sourceId === sourceId);
      await beforeSearchStageWrite({ phase: 'before-final-source-status', sourceId, nodeId, runId: activeRunId });
      await assertSearchCurrent();
      const marked = await markSourceStatus(canvasFilePath, sourceId, 'blocked', Date.now(), {
        expectedRunId: activeRunId,
        nodeId,
        expectedOperationAuthority: authorityReceipt,
        recoveryDisposition: jobSourceRecoveryDisposition(sourceId, sourceWarnings),
      });
      await assertSearchCurrent();
      if (marked !== true) return searchSupersededResult();
    }
    // The page-level ledger is raw collection data. Before declaring the gather
    // complete, append the final score-safe universe too: Dice detail
    // enrichment, text repair, markup normalization, salary reconciliation, and
    // the evidence gate all happen after the original page flushes. Recovery is
    // last-wins per source/job, so these rows make a gathered-only restart
    // reproduce the same eligible inputs without re-opening any network path.
    // A gathered-only recovery needs another checkpoint only when old staged
    // rows acquired resolution metadata or the official dedup changed its set.
    if (!resumeGatheredOnly || officialResolutionChanged) {
      const finalScoreSafeBySource = new Map();
      for (const job of kept) {
        const sourceId = String(job?.source || '').trim();
        if (!sourceId) continue;
        const rows = finalScoreSafeBySource.get(sourceId) || [];
        rows.push(job);
        finalScoreSafeBySource.set(sourceId, rows);
      }
      for (const [sourceId, jobs] of finalScoreSafeBySource) {
        await beforeSearchStageWrite({ phase: 'before-final-stage', sourceId, nodeId, runId: activeRunId });
        await assertSearchCurrent();
        const saved = await recordSourcePage(canvasFilePath, {
          sourceId, query: '', page: 0, jobs,
          now: Date.now(), expectedRunId: activeRunId, nodeId, expectedOperationAuthority: authorityReceipt,
        });
        await assertSearchCurrent();
        if (saved !== true) return searchSupersededResult();
      }
    }
    // This is the exact collection boundary: every selected platform has
    // settled and its score-safe rows are checkpointed. Downstream scoring and
    // taxonomy work happen in the renderer after this response, so they must
    // never alter the Job Search module's "Last scraped" timestamp.
    // The final checkpoint above is asynchronous. Check again immediately
    // before advancing the manifest so a Reset cannot label an abandoned run
    // as gathered after it has cleared its token-scoped sidecars.
    await throwIfSearchAborted();
    await assertSearchCurrent();
    const gatheredStageUpdatedAt = Date.now();
    const collectionCompletedAt = collectionDisposition === 'user-finished-partial'
      ? (resumedCollectionCompletedAt ?? gatheredStageUpdatedAt)
      : resumeGatheredOnly
      ? (resumedCollectionCompletedAt ?? gatheredStageUpdatedAt)
      : gatheredStageUpdatedAt;
    // The next successful scan uses this run's original start as its
    // conservative coverage watermark. A partial recovery can reuse providers
    // that finished before midnight; anchoring on the later overall completion
    // would otherwise skip their unobserved remainder of the prior day.
    const persistedRunStartedAt = Number(priorRunStartedAt);
    const collectionStartedAt = Number.isSafeInteger(persistedRunStartedAt)
      && persistedRunStartedAt > 0
      ? persistedRunStartedAt
      : (resumeScope ? activeSearchWindow.startTimestamp : runStartedAt);
    // Platforms whose collection genuinely finished, read from THIS run's
    // manifest so a "done" that only ever reached disk still counts. A missing or
    // mismatched manifest yields no completions — the next run then keeps the run
    // window for every platform rather than trusting an unproven boundary.
    let completedSourceIds = [];
    // For a platform that did NOT finish: the queries it did finish, so the
    // next run can skip them. Only a run that walked its providers in this
    // process knows which queries were fully read.
    const sourceQueryProgress = {};
    // Every listing each card-reading platform read this run, finished or not,
    // for the lasting read list.
    const sourceReadKeysReported = {};
    // Unfinished platforms whose every result list was walked to its end, so
    // all they are missing is the descriptions of known listings.
    const sourceWalkCompleteIds = [];
    if (canvasFilePath) {
      try {
        const finalState = await readRunState(canvasFilePath, Date.now(), { nodeId });
        if (finalState?.manifest?.runId === activeRunId) {
          const sourceStatuses = {};
          for (const [id, source] of Object.entries(finalState.manifest.sources || {})) {
            sourceStatuses[id] = source?.status || 'pending';
          }
          completedSourceIds = completedJobSourceIds({
            activeSourceIds,
            sourceStatuses,
            gatingSourceIds: finalGatingSourceIds,
            intentionallyUnfinishedSourceIds,
            loginBlockedSourceIds,
            countryApplicableSourceIds,
          });
          if (!resume && !skipProviderCollection) {
            const jobsBySource = Object.fromEntries(Object.entries(sourceResults || {})
              .map(([sourceId, result]) => [sourceId, result?.jobs]));
            for (const sourceId of activeSourceIds) {
              // LinkedIn's result lists carry no descriptions: its listings are
              // read one by one afterwards, and only the rows that reached that
              // step need reading, so its read and unread listings come from
              // that pool rather than from the raw result rows.
              const isLinkedIn = sourceId === 'linkedin';
              const readsCards = isLinkedIn || sourceId === 'indeed' || tasks.some(task => task?.sourceId === sourceId);
              const cardRows = isLinkedIn
                ? descriptionRecoveryJobs.filter(job => job?.source === 'linkedin')
                : sourceResults[sourceId]?.jobs;
              // Unread here but read on another platform this scan: not owed.
              const readElsewhere = readsCards && !isLinkedIn ? listingsReadElsewhere(sourceId, jobsBySource) : null;
              if (readElsewhere?.size > 0) logger.info(`[Jobs][${sourceId}] ${readElsewhere.size} unread listing(s) were read on another platform this scan and count as read`);
              if (readsCards) {
                const readKeys = listingReadProgress(cardRows, readElsewhere).readKeys;
                if (readKeys.length > 0) sourceReadKeysReported[sourceId] = readKeys;
              }
              if (completedSourceIds.includes(sourceId)) continue;
              const linkedIn = isLinkedIn
                ? (Array.isArray(httpResults) ? httpResults : []).find(result => result?.sourceId === 'linkedin')
                : null;
              if (isLinkedIn) {
                if (linkedInWalkComplete(queries, linkedIn?.finishedQueries, carriedQueriesBySource.linkedin)) {
                  sourceWalkCompleteIds.push(sourceId);
                }
              } else if (readsCards) {
                const ledger = finalState.manifest.sources?.[sourceId]?.queries || {};
                const walked = queries.every((_query, index) => ledger[`#${index}`]?.terminal === true
                  || carriedQueryPlans?.[sourceId]?.[index]?.terminal === true);
                if (queries.length > 0 && walked) sourceWalkCompleteIds.push(sourceId);
              }
              let finished = [];
              if (isLinkedIn) {
                finished = Array.isArray(linkedIn?.finishedQueries) ? linkedIn.finishedQueries : [];
              } else if (BROWSER_SCRAPE_ORDER.includes(sourceId)) {
                const ledger = finalState.manifest.sources?.[sourceId]?.queries || {};
                finished = queries.filter((_query, index) => ledger[`#${index}`]?.terminal === true
                  && !(unreadRowsByQuery[`${sourceId}#${index}`] > 0));
              }
              finished = finished.filter(query => typeof query === 'string' && query);
              // Listing-level progress for a platform read card by card: what
              // this run read (not opened again next time) and what came back
              // unread (the work still owed).
              const listingProgress = readsCards ? listingReadProgress(cardRows, readElsewhere) : null;
              if (finished.length > 0 || listingProgress?.unreadListings.length > 0) {
                sourceQueryProgress[sourceId] = {
                  finishedQueries: finished,
                  ...(listingProgress?.unreadListings.length > 0 ? { unreadListings: listingProgress.unreadListings } : {}),
                };
              }
            }
          }
        }
      } catch {
        completedSourceIds = [];
        for (const sourceId of Object.keys(sourceQueryProgress)) delete sourceQueryProgress[sourceId];
        for (const sourceId of Object.keys(sourceReadKeysReported)) delete sourceReadKeysReported[sourceId];
        sourceWalkCompleteIds.length = 0;
      }
    }
    // `setJobRunStage` owns the exact authority→manifest transaction.
    await beforeSearchStageWrite({ phase: 'before-gathered-stage', nodeId, runId: activeRunId });
    await assertSearchCurrent();
    const gatheredStageAdvanced = await setJobRunStage(canvasFilePath, 'gathered', gatheredStageUpdatedAt, {
      expectedRunId: activeRunId,
      nodeId,
      expectedOperationAuthority: authorityReceipt,
      collectionCompletedAt,
      collectionDiagnostics: {
        disposition: collectionDisposition === 'user-finished-partial'
          ? 'user-finished-partial'
          : finalGatingSourceIds.size > 0 ? 'unfinished-sources' : 'full',
        startedAt: collectionStartedAt,
        completedAt: collectionCompletedAt,
        unfinishedSourceCount: finalGatingSourceIds.size,
        // Durable per-platform completion: the saved scrape copies this, so a
        // run whose card never recorded its completion can still move each
        // finished platform's date when its rows are shown.
        completedSourceIds,
      },
    });
    await assertSearchCurrent();
    if (gatheredStageAdvanced !== true) return searchSupersededResult();
    // The user may have started a fresh run while this recovered result was
    // being finalized. Re-check the manifest token immediately before returning
    // so old staged jobs can never be painted onto its successor.
    if (hasExactResumeToken) {
      const failure = await inspectExactResumeOwnership();
      if (failure) {
        retirePipeline('recovery-superseded', failure.error);
        return { success: false, ...failure };
      }
    }
    await assertSearchCurrent();
    const completedAt = Date.now();
    const pausedSourceIds = [...finalGatingSourceIds];
    jobsTelemetry.pipeline = {
      ...(jobsTelemetry.pipeline || {}),
      // A source-level gate is a settled partial gather, not a completed
      // pipeline. Keep the report honest while the renderer waits at
      // sources-ready for a Login/Solve/Skip decision.
      phase: pausedSourceIds.length > 0 ? 'sources-blocked' : 'completed',
      ts: completedAt,
      active: false,
      pendingSources: pausedSourceIds,
      durationMs: Math.max(0, completedAt - (Number(jobsTelemetry.pipeline?.startedAt) || runStartedAt)),
    };

    // `rawCount` is diagnostics-only provider volume, including rows rejected at
    // whole-feed title admission. `gatheredCount` is the sum of the source-card
    // counts before cross-source dedup/age/history filtering, so the renderer's
    // visible "N scraped" total reconciles with the platform cards.
    const descriptionRecoveryState = Object.fromEntries(
      Object.entries(sourceBlockedUrls)
        .map(([sourceId, urls]) => [sourceId, { blockedUrls: boundedRecoveryBlockedUrls(urls) }])
        .filter(([, state]) => state.blockedUrls.length > 0),
    );
    if (!await searchIsCurrent()) {
      searchSuperseded = true;
      return searchSupersededResult();
    }
    return { jobs: kept,
      descriptionRecoveryJobs,
      descriptionRecoveryState,
      rawCount: relevanceFunnel.raw,
      gatheredCount: allJobs.length,
      sourceResults,
      // Unlike scrapeWarnings, this remains non-gating: retained rows are still
      // useful, but the result UI must not imply a country boundary Glassdoor
      // cannot enforce at its nation-tier location level.
      collectionScopeCaveats: collectionScopeCaveatsFromSourceResults(sourceResults),
      scrapeWarnings,
      runId: activeRunId,
      searchWindow: activeSearchWindow,
      collectionStartedAt,
      collectionCompletedAt,
      collectionDisposition,
      // A paused source gate is a partial collection even when it was caused
      // by a captcha/verification wall rather than the resume auth preflight.
      // The renderer may subsequently let the person score the listings now;
      // that explicit partial choice must never advance the next scan's
      // full-coverage watermark past the source that was not proven complete.
      // `finalGatingSourceIds` is assembled after every post-search recovery
      // pass (including description enrichment), making it the authoritative
      // set rather than the narrower loginBlockedSourceIds preflight subset.
      hasUnfinishedSources: finalGatingSourceIds.size > 0,
      intentionallyUnfinishedSourceIds,
      sourceSearchWindows: activeSourceSearchWindows,
      completedSourceIds,
      sourceQueryProgress,
      sourceReadKeysReported,
      sourceWalkCompleteIds,
    };
    } catch (error) {
      if (isJobOperationSupersededError(error)) return searchSupersededResult();
      throw error;
    } finally {
      exactExecution?.release?.();
      recoveryLease.release();
    }
  }, { captureListingLiveness: true });


  handleSafe('search-jobs-single-source', async (event, { query, sourceId, searchWindow, maxAgeDays, canvasFilePath, nodeId, jobRunId = null, preferredLocation, collectionLimits, enabledSourceIds, continuationIntentId = null, continuationLeaseToken = null, careerSnapshotId = null, operationAuthority = null, parentArtifactFingerprint = null }, signal) => {
    requireSavedJobRecoveryCanvas(canvasFilePath);
    const continuationAdmission = await admitContinuationProviderWork(event, {
      canvasFilePath, nodeId, jobRunId, continuationIntentId, continuationLeaseToken,
      careerSnapshotId, operationAuthority, parentArtifactFingerprint,
    }, 'search-jobs-single-source');
    if (!continuationAdmission.ok) {
      return {
        success: false,
        operationSuperseded: true,
        jobs: [],
        error: 'This background source continuation was superseded before provider work started.',
      };
    }
    logger.info(`[Jobs] Background single-source search for ${sourceId} with query "${query}"`);
    const emitSingleSourceProgress = (payload) => {
      if (!nodeId) return;
      const correlatedPayload = jobRunId ? { ...payload, jobRunId } : payload;
      recordJobSourceProgress(correlatedPayload, { updatePipeline: false, expectedNodeId: nodeId });
      if (!event.sender.isDestroyed()) event.sender.send('job-source-progress', correlatedPayload);
    };
    if (!ACTIVE_SOURCE_ID_SET.has(sourceId)) {
      return {
        success: false,
        disabled: true,
        error: `Job source "${sourceId}" is disabled by the current job search test-mode scope.`,
      };
    }

    const activeSearchWindow = effectiveJobSearchWindow(searchWindow, maxAgeDays);
    const ageDays = activeSearchWindow.providerLookbackDays;
    const normalizedCollectionLimits = normalizeJobCollectionLimits(collectionLimits);
    const enabledIds = getEnabledJobSourceIds(enabledSourceIds, ACTIVE_SOURCE_IDS);
    if (!getRunnableJobSourceIds(enabledIds, ACTIVE_SOURCE_IDS, normalizedCollectionLimits).includes(sourceId)) {
      return {
        success: false,
        disabled: true,
        error: `Job source "${sourceId}" is disabled for this Job Search hub.`,
      };
    }
    const location = String(preferredLocation || '').trim();
    const sourceCountryPolicy = getJobSourceCountryPolicy(sourceId, location);

    if (!sourceCountryPolicy.include) {
      const locationWarning = {
        code: 'country-source-skipped',
        severity: 'info',
        evidence: sourceCountryPolicy.reason,
        suggestion: `This source is intentionally not queried for ${sourceCountryPolicy.location.boardReady || sourceCountryPolicy.location.country || 'this target'}. Run a separate United States hub to use U.S.-only sources.`,
      };
      if (nodeId) {
        emitSingleSourceProgress({
          nodeId,
          sourceId,
          status: 'skipped',
          count: 0,
          warning: locationWarning,
          completed: 1,
          total: 1,
        });
      }
      return { success: true, jobs: [], warning: locationWarning };
    }

    let jobs = [];
    let warning = null;

    if (nodeId) {
      emitSingleSourceProgress({
        nodeId,
        sourceId,
        status: 'searching',
        count: 0,
        warning: null,
        completed: 0,
        total: 1,
      });
    }

    if (sourceId === 'usajobs') {
      const { usajobsApiKey: apiKey, usajobsEmail: email } = getJobsSettings();
      if (!apiKey || !email) {
        const synthesizedWarning = {
          code: 'config-missing',
          severity: 'info',
          evidence: 'USAJobs API key + email not set',
          suggestion: 'Get a free key at developer.usajobs.gov, then open Settings → Job Sources and paste the API key + your email to enable this source.',
        };
        if (nodeId) {
          emitSingleSourceProgress({
            nodeId,
            sourceId,
            status: 'skipped',
            count: 0,
            warning: synthesizedWarning,
            completed: 1,
            total: 1,
          });
        }
        return {
          success: false,
          warning: synthesizedWarning,
        };
      }

      try {
        // This late USAJobs refresh is a real provider request too. Its
        // progress shares the completed search's run token, so record the
        // dispatch here rather than reporting the earlier UI announcement as
        // execution time.
        recordJobSourceDispatch(sourceId, jobRunId);
        const result = await fetchUSAJobs(query, apiKey, email, signal, ageDays, location);
        if (continuationAdmission.continuation && !(await admitContinuationProviderWork(event, {
          canvasFilePath, nodeId, jobRunId, continuationIntentId, continuationLeaseToken,
          careerSnapshotId, operationAuthority, parentArtifactFingerprint,
        }, 'search-jobs-single-source')).ok) {
          return { success: false, operationSuperseded: true, jobs: [] };
        }
        jobs = Array.isArray(result) ? result : (result?.items || []);
        warning = Array.isArray(result) ? null : (result?.warning || null);
      } catch (err) {
        logger.error(`[USAJobs] Background fetch failed:`, err);
        const synthWarning = {
          code: 'api-failed',
          severity: 'block',
          evidence: String(err?.message || err),
          suggestion: 'API call failed. Check logs for the full response.',
        };
        if (nodeId) {
          emitSingleSourceProgress({
            nodeId,
            sourceId,
            status: 'error',
            count: 0,
            warning: synthWarning,
            completed: 1,
            total: 1,
          });
        }
        return {
          success: false,
          error: err?.message || String(err),
          warning: synthWarning,
        };
      }
    } else {
      return { success: false, error: `Unsupported single source: ${sourceId}` };
    }

    const tagged = jobs.map(j => ({ ...j, source: sourceId }));
    const { deduped } = filterAndDedupJobsByPostedSince(
      tagged,
      activeSearchWindow.startTimestamp,
    );
    const capped = normalizedCollectionLimits.jobsPerPlatform != null
      ? deduped.slice(0, normalizedCollectionLimits.jobsPerPlatform)
      : deduped;
    // The deterministic pinned-title gate is gone; window-filtered, deduped rows flow
    // straight into history dedup, matching the main search path.
    let kept = capped;
    if (canvasFilePath) {
      const history = await loadJobsHistory(canvasFilePath);
      const result = dedupAgainstHistory(capped, history);
      kept = result.kept;
      try {
        const applied = filterAppliedListings(kept, await loadAppliedListingKeys(canvasFilePath));
        kept = applied.kept;
        if (applied.removed > 0) {
          logger.info(`[Jobs][${sourceId}] Applied-listing filter: dropped ${applied.removed} listing(s) already applied to`);
        }
      } catch (error) {
        logger.warn(`[Jobs][${sourceId}] Applied-listing filter unavailable: ${error?.message || error}`);
      }
    }
    // Same final-set chokepoints, in the same order, as the main gather path
    // (see the commentary at the repairJobsMojibake call there): a job reaching
    // the renderer from this path must be cleaned, evidence-filtered and
    // filtered for majority English identically, or a background single-source
    // refresh would ship rows the main search would have dropped. Runs BEFORE
    // the progress send below so its `count` matches the rows actually returned.
    repairJobsMojibake(kept);
    normalizeJobsMarkup(kept);
    kept = kept.map(reconcileGlassdoorSalaryFromDescription);
    const descriptionEvidence = filterJobsByDescriptionEvidence(kept);
    // Board-closed rows without a score-safe description are settled next.
    kept = scoreSafeRowsWithBoardClosed(descriptionEvidence);
    if (descriptionEvidence.dropped.length > 0) {
      logger.info(`[Jobs][${sourceId}] Deferred ${descriptionEvidence.dropped.length} description-incomplete listing(s) (explicit=${descriptionEvidence.quality.deferred}, empty=${descriptionEvidence.quality.empty}, short=${descriptionEvidence.quality.short}; threshold=400 chars) — not returned or marked seen`);
    }
    const officialResolution = await settleScrapedRowsForScoring(kept, { signal });
    kept = officialResolution.jobs;
    const languageFilter = filterNonEnglishJobs(kept);
    kept = languageFilter.jobs;
    if (languageFilter.dropped.length > 0) {
      logger.info(`[Jobs][${sourceId}] Dropped ${languageFilter.dropped.length} listing(s) whose descriptions are not primarily English — not returned or marked seen`);
    }

    let status = 'done';
    if (warning && warning.severity === 'block') status = 'error';
    else if (warning && warning.severity === 'info') status = 'skipped';

    if (nodeId) {
      emitSingleSourceProgress({
        nodeId,
        sourceId,
        status,
        count: kept.length,
        warning,
        completed: 1,
        total: 1,
      });
    }

    return {
      success: true,
      jobs: kept,
      officialPosting: officialResolution.officialPosting,
      officialDedupDropped: officialResolution.officialDedupDropped,
      languageDropped: languageFilter.dropped.length,
      warning,
    };
  }, { beforeReply: checkpointContinuationBeforeReply('search-jobs-single-source'), captureListingLiveness: true });
}
