import { JOB_SCORING_CONTRACT } from '../../src/utils/jobScoringContract.js';
import { MAX_JOB_ANALYSIS_ARTIFACT_BYTES } from './jobAnalysisArtifactLimits.js';
/**
 * Jobs IPC handlers — resume parsing, multi-source job search, AI scoring.
 * 9 Sources: Google, Indeed, LinkedIn, RemoteOK, WeWorkRemotely,
 *            ZipRecruiter, Glassdoor, Dice, USAJobs
 */

import { callLLMText } from './llm.js';
import { NON_API_AI_TRANSPORT, recallRunMigration, rememberRunMigration } from './nonApiAi.js';
import { compileAuditedCareerSnapshot, CAREER_TRANSCRIPTION_POLICY_DIGEST } from './careerSnapshot.js';
import {
  JOB_GAP_REVIEW_BATCH_SIZE, JOB_GAP_REVIEW_SCHEMA, JOB_GAP_REVIEW_TASK,
} from './jobGapReview.js';
export { planRoleFamilyResearchBatches, planRoleFamilyAssessmentBatches, packCompensationAssessmentBatches, packCompensationResearchBatches } from './jobCompensationPlanning.js';

import { JOB_SCORING_SCHEMA, JOB_COMPENSATION_EVIDENCE_BATCH_SCHEMA, ROLE_FAMILY_EXPERIENCE_BANDS_BATCH_SCHEMA, JOB_QUERY_GENERATION_SCHEMA, JOB_LOCATION_RESOLUTION_SCHEMA } from './aiSchemas.js';
import { runBoundedJobTaxonomy } from './jobTaxonomy.js';
import electronPkg from 'electron';
import { getCurrentIpcRequestContext, handleSafe as registerIpcHandler, nodeCancellationError } from './ipcUtils.js';
import { followGoogleApplyRedirects, GOOGLE_APPLY_LINKS_RATE_LIMITED_CODE } from './browser/manualScraper.js';


import { JOB_SCORE_CAP, RESEARCH_MIN_FIT_SCORE, MAX_COMPENSATION_ROWS_PER_ASSESSMENT_COHORT } from './resultCaps.js';
import { logger } from '../logger.js';
import { JOB_BOARD_TELEMETRY_CAP, RECENT_INDEED_LOGIN_MS } from './jobs/state.js';
export { linkedInSameIpRetryDecision, __resetJobsTelemetryForTests } from './jobs/state.js';
import { registerCoreHandlers } from './jobs/coreHandlers.js';
import { registerBoardHandlers } from './jobs/boardHandlers.js';
import { registerSearchHandlers } from './jobs/searchHandlers.js';
import { registerRecoveryHandlers } from './jobs/recoveryHandlers.js';
export { applyGoogleApplyLinkRetryResults } from './jobs/recoveryHandlers.js';
export { __boardHistoryAuthorityForTests } from './jobs/boardHandlers.js';
import { resolveCompensationCareerInputs } from './jobs/compensationResearch.js';
export { COMPENSATION_SECTION_FORMAT_SUFFIX, ROLE_FAMILY_LADDER_SUFFIX, COHORT_PROVENANCE_SUFFIX, buildRoleFamilyBatchResearchPrompt, compensationContextForSalary, compensationResearchFingerprint, compensationAssessmentCacheMatchesResearch, compensationPersonalizationSignature, buildCompensationAssessmentListings, resolveCompensationCareerInput, resolveCompensationCareerInputs, buildCompensationPersonalSalaryEvidence, researchCompensationAssessments, parseCompensationResearchSections, validateRoleFamilyExperienceBandsSubmission, validateCompensationEvidenceSubmission, validateCompensationEvidenceBatchSubmission, validateRoleFamilyExperienceBandsBatchSubmission, COMPENSATION_RESEARCH_PROMPT_VERSION, compensationResearchCacheKey, buildCompensationResearchPrompt, compensationCohortResearchIds, compensationRoleFamilyResearchIds } from './jobs/compensationResearch.js';
import { WALK_GUARD_WARNING_CODE, JOB_DESCRIPTION_EVIDENCE_MIN_CHARS, hasResolvedJobDescription, ALL_SOURCE_IDS, ACTIVE_SOURCE_IDS, ACTIVE_SOURCE_ID_SET, EXACT_RESUME_PROVIDER_ONLY_SOURCE_IDS, BACKGROUND_PROVIDER_ONLY_SOURCE_IDS, JOB_SOURCE_DISPLAY_NAMES, BROWSER_SCRAPE_ORDER } from './jobs/sourceRules.js';
export { WALK_GUARD_WARNING_CODE, sanitizeWalkGuards, walkGuardWarning, JOB_DESCRIPTION_EVIDENCE_MIN_CHARS, canRecoverGatheredRunDirectly, __consumeRecoveryBlockedUrlForTests, extractExecutedGoogleQueryStrings, reconcileTitleRelevanceFunnel, mergeRoleScreenedJobs, applyFinalJobTitleRelevanceGate, listingReadProgress, resolveSourceLabel, buildResolvedDescriptionWarning, summarizeScoringInputQuality, filterJobsByDescriptionEvidence, retiredListingKeys, snapshotDescriptionRecoveryJobs, mergeDescriptionRecoverySourceJobs, reconcileResolvedDescriptionRecovery, mergeResolvedDescriptionRecoveryCandidate, partitionResolvedDescriptionRecoveryCandidates, nextDescriptionRecoveryGuidance, linkedInBrowserUnavailableWarning, jobSourceAuthPreflightScope, getJobSourceResolveConfig, jobSourceRecoveryDisposition, mergeJobSourceCollectionCap, refreshManualSourceUrlIndex, orderedBlockedManualSourceUrls, filterAndDedupJobsByPostedSince, capPlatformJobsAfterWindow } from './jobs/sourceRules.js';
import { MAX_SCORING_CAREER_DATA_CHARS, PINNED_SCORING_EVIDENCE_MARKER, resolvePinnedScoringInput, resolveRequiredPinnedCareerInput, pruneStaleCareerInputStages } from './jobs/careerInput.js';
export { configureCareerSnapshotDataRoot, __resolvePinnedScoringInputForTests, registerCareerConvertedInputRoot, __isWithinCareerConvertedInputRootForTests, __careerCompileResumeStatusForTests, __bindCareerCompileRunForTests, __stageCareerInputFilesForTests, __assertOwnedStagedCareerAttachmentForTests, __readOwnedStagedCareerAttachmentForTests, __pruneStaleCareerInputStagesForTests, __assertCareerInputDescriptorsStillMatchForTests, careerInputFingerprint, careerProfileFingerprint, __extractCareerFileSectionsForTests } from './jobs/careerInput.js';
import { fetchHttpSources } from './jobs/collection.js';
export { __fetchHttpSourcesForTests, __queryFanOutForTests, __withLockedLinkedInEnrichmentForTests, authoritativeFreshJobSearchWindow, buildJobTasks, completedJobSourceIds, effectiveJobSearchWindow, freshJobSearchWindow, glassdoorPostedBucket, legacyJobSearchWindow, listWalkStoppedByProviderBlock, manualAiPreSearchRecoveryWindow, narrowJobSearchSourceWindows, selectIndeedResumePlan, withFreshManualScraperTelemetry } from './jobs/collection.js';
import {
  ZIPRECRUITER_EXTRACTOR, ZIPRECRUITER_CONFIG,
  GLASSDOOR_EXTRACTOR, GLASSDOOR_CONFIG,
  GOOGLE_JOBS_EXTRACTOR, GOOGLE_JOBS_CONFIG,
} from '../extractors/jobs.js';

import { SOURCE_HEALTH_WARNING_CODE } from './jobSourceHealth.js';




import { retryIndeedJobDescriptions } from '../extractors/indeedBrowser.js';









import { JOB_SEARCH_TEST_MODE } from '../../src/utils/jobSourceScope.js';










import { } from './jobPageStop.js';

import { PERSONAL_SALARY_GUIDANCE_PROMPT, PERSONAL_SALARY_METHODOLOGY_VERSION } from './personalSalaryRecommendation.js';
import { getOfficialPostingView, mergeOfficialPostingTelemetry } from './officialPostingService.js';
import { listingStateRank, officialPostingLookupStatus } from './officialPostingFields.js';
import { bumpListingLivenessCount, listingLivenessTelemetryBlock, mergeListingLivenessTelemetry } from './listingLivenessTelemetry.js';
import { listingEvidenceKey, readListingEvidence } from './listingLivenessStore.js';
import { holdNotFoundBursts } from './listingLivenessHealth.js';
import { RESEARCH_ELIGIBILITY } from './researchGate.js';
import { carryListingAlternates, collectListingAlternates, restoreListingAlternates } from './listingLivenessAlternates.js';
import { getListingLivenessCalibrationStore } from './listingLivenessCalibration.js';
import { boardClosedTelemetryBlock, officialPostingOutranksClosedPage, settleBoardClosedRows } from './officialPostingBoardClosed.js';



import { HANDOFF_CONCURRENCY } from '../../src/utils/handoffScheduler.js';

const { ipcMain: electronIpcMain } = electronPkg;
import { REANALYZE_SAVED_JOBS_RECOVERY_MODE, JobOperationSupersededError, JOB_ANALYSIS_SNAPSHOT_VERSION, pruneStaleUnsavedAnalysisArtifacts, CANCEL_CAUSE_LABELS, CHECKPOINT_PRESERVING_ABORT_CAUSES } from './jobs/analysisStore.js';
export { claimExactJobRunExecution, __analysisPathsForCurrentRequestForTests, getCurrentRequestJobAnalysisPaths, collectionEvidenceForSnapshot, __discardJobAnalysisSnapshotForTests, __discardCancelledBoardRunArtifactsForTests, __saveJobAnalysisSnapshotForTests, __getJobAnalysisRetirementStateForTests, listDescriptionRecoveryCheckpointsSync, __saveDescriptionRecoverySnapshotIfCurrentForTests, __createDescriptionRecoveryCheckpointForTests, __removeDescriptionRecoveryCheckpointForTests, __pruneSupersededDescriptionRecoveryCheckpointsForTests, __loadDescriptionRecoveryCheckpointForTests, __listDescriptionRecoveryCheckpointsForTests, __discardOwnedJobRunForTests, __loadJobAnalysisSnapshotForTests, assessDescriptionRecoverySnapshotOwnership, isLiveDescriptionRecoveryRun, createDescriptionRecoveryMutex, __formatJobAnalysisPromptForTests, __prepareJobAnalysisSnapshotForWriteForTests, shouldDiscardJobRunAfterAbort } from './jobs/analysisStore.js';

export { getJobsTelemetry, getJobsTelemetryForReport, __getJobsTelemetryForReportForTests, getJobsBoardTelemetryForReport, getJobsSourceRunHistoryForReport, CAREER_CONVERGENCE_CATEGORIES, sanitizeCareerConvergenceRound, appendCareerConvergenceRound, getJobsCareerCompilationForReport, getJobsTelemetryHubCountForReport, getJobsResumeAttributionForReport, buildJobRunCompletionReceipt, __recordJobSourceDispatchForTests, recordJobSourceProgress, __canWriteJobResolveTelemetryForTests, __recordJobSourceResolvePassForTests, recordRunCompletedWithUnfinishedSources, __recordJobSourceResumeAttemptForTests, __restoreJobsTelemetryIfCurrentRunForTests, __canPerformJobSourceActionForTests, __jobSourceActionAuthorizationForTests, recordLinkedinResolveAttempt, recordResolveMergeOutcome, __recordResumeAttemptForTests, nativeChallengeTerminalDisposition, indeedWarningRequiresManualVerification, authenticatedIndeedScrapeStatus, recordJobsSourceScope, recordJobsBoardScope } from './jobs/telemetry.js';
import { UNSCORED_FALLBACK_SCORE, SCORING_HEARTBEAT_MS, JOB_BOARD_GENERATION_CAPABILITY } from './jobs/scoring.js';
export { SCORING_CORRECTION_TEMPLATES, UNSCORED_FALLBACK_SCORE, validateExactResumeRun, chunkScoringBatches, scoringPromptFitsEnvelope, officialPostingConsumerJobs, restoreOfficialPostingConsumerIdentity, prepareLiveScoringResults, planPartialScoreRecovery, mergeRecoveredScoreRows, reconcileSearchFunnel, buildJobAnalysisSnapshot, validateJobBoardRoleTaxonomy, normalizeJobBoardRoleByIndex, inspectJobBoardRoleByIndex, explainScoreRow, calibratedScoreForJob, validateJobScoringSubmission, scoreRowsOnCareerRecord as __scoreRowsOnCareerRecordForReplay } from './jobs/scoring.js';























































































































































































































































































































































































/**
 * Register all Jobs IPC handlers.
 */
export function registerJobsHandlers() {
  return registerJobsHandlersWithDependencies();
}

// Registration is the only test seam. Nothing supplied here is reachable from
// preload IPC, and production always receives the native implementations.
// Keeping the pause points at operation boundaries lets race regressions avoid
// module-loader monkey patches and, importantly, exercise the real authority
// ledger and durable staging code.
export function __registerJobsHandlersForTests(dependencies = {}) {
  return registerJobsHandlersWithDependencies(dependencies);
}


function registerJobsHandlersWithDependencies(dependencies = {}) {
  const handleSafe = registerIpcHandler;
  const ipcMain = electronIpcMain;
  const compileCareerSnapshot = dependencies.compileCareerSnapshot || compileAuditedCareerSnapshot;
  const resolvePinnedScoringInputForHandler = dependencies.resolvePinnedScoringInput || resolvePinnedScoringInput;
  const resolveRequiredPinnedCareerInputForHandler = dependencies.resolveRequiredPinnedCareerInput || resolveRequiredPinnedCareerInput;
  const beforeScoreSideEffect = dependencies.beforeScoreSideEffect || (async () => {});
  const runScoreBatch = dependencies.runScoreBatch || callLLMText;
  // Per-job score reuse for resumed runs. Production reads and writes the same
  // durable run migrations every other durable scoring step already uses.
  const reuseStoreDeps = dependencies.jobScoreReuseStore
    || { recall: recallRunMigration, remember: rememberRunMigration };

  const runGapReview = dependencies.runGapReview || callLLMText;
  const runBoardTaxonomy = dependencies.runBoardTaxonomy || runBoundedJobTaxonomy;
  const resolveBoardCompensationCareerInputs = dependencies.resolveCompensationCareerInputs || resolveCompensationCareerInputs;
  const runHttpSources = dependencies.fetchHttpSources || fetchHttpSources;
  const beforeSearchStageWrite = dependencies.beforeSearchStageWrite || (async () => {});
  const afterSearchProviderResult = dependencies.afterSearchProviderResult || (async () => {});
  const readOfficialPostingView = dependencies.getOfficialPostingView || getOfficialPostingView;
  const callListingLiveness = dependencies.callListingLiveness || callLLMText;
  const listingLivenessCalibrationStore = dependencies.listingLivenessCalibrationStore || getListingLivenessCalibrationStore();
  const retryIndeedDescriptions = dependencies.retryIndeedJobDescriptions || retryIndeedJobDescriptions;
  // Google's apply-link Retry must follow only the parked /goto links, so this is
  // injectable: tests drive the branch with a fake reader, and production uses
  // the shared-profile background reader from manualScraper.
  const retryGoogleApplyLinks = dependencies.retryGoogleApplyLinks || followGoogleApplyRedirects;
  const settleBoardClosedRowsForHandler = dependencies.settleBoardClosedRowsForTests || settleBoardClosedRows;
  // Before scoring: keep or retire every row an aggregator board reported
  // closed. A failure of this step is contained to the conservative rule: a
  // board-closed row without a score-safe description leaves, everything else stays.
  const settleBoardClosed = async (rows, signal, expiryCandidatesConfirmedClosed = null) => {
    const setAsideKeys = getCurrentIpcRequestContext()?.listingSetAsideKeys
      || new Set((Array.isArray(rows) ? rows : []).filter(row => listingStateRank(row) >= 3 && !hasResolvedJobDescription(row)).map(listingEvidenceKey));
    try {
      return await settleBoardClosedRowsForHandler(rows, { scoreSafe: hasResolvedJobDescription,
        requireSemantic: true, researchDeferred: true,
        getView: row => readOfficialPostingView(row, { store: dependencies.officialPostingStore, signal }),
        minChars: JOB_DESCRIPTION_EVIDENCE_MIN_CHARS, setAsideKeys, expiryCandidatesConfirmedClosed });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      logger.warn(`[OfficialPosting] Board-closed settlement failed: ${error?.code || error?.name || 'Error'}`);
      return settleBoardClosedRows(rows, { scoreSafe: hasResolvedJobDescription,
        requireSemantic: true, researchDeferred: true, getView: () => null,
        minChars: JOB_DESCRIPTION_EVIDENCE_MIN_CHARS, setAsideKeys, expiryCandidatesConfirmedClosed });
    }
  };
  // Every provider and recovery path crosses this boundary after its existing
  // evidence gate. It spends no AI or web call: research waits until a job has
  // a real fit score (settle-board-research and the Board's official stage).
  // Board-closed rows the evidence gate dropped arrive here too (see
  // scoreSafeRowsWithBoardClosed) and are kept or removed by what is known now.
  const settleScrapedRowsForScoring = async (incomingRows, { signal, alternateReceipts = null } = {}) => {
    // A burst of 404s on one board looks like a broken route, so those closes are undone before anything drops a row.
    const notFoundHold = holdNotFoundBursts(incomingRows);
    for (const [board, count] of Object.entries(notFoundHold.held)) logger.error(`[ListingLiveness] Kept ${count} ${board} listing(s) pending: most of that board's pages returned 404 at once`);
    const rows = notFoundHold.rows;
    const context = getCurrentIpcRequestContext();
    if (context) context.listingSetAsideKeys = new Set((Array.isArray(rows) ? rows : [])
      .filter(row => listingStateRank(row) >= 3 && !hasResolvedJobDescription(row)).map(listingEvidenceKey));
    let kept = Array.isArray(rows) ? rows : [];
    const alternatesByKey = alternateReceipts
      ? collectListingAlternates({ ...alternateReceipts, officialDrops: [], finalKept: kept }) : null;
    let alternateRestored = [];
    try {
      if (alternatesByKey instanceof Map && alternatesByKey.size > 0) {
        const alternateResult = await restoreListingAlternates(kept, {
          alternatesByKey, scoreSafe: hasResolvedJobDescription,
          shouldTryWinner: async winner => {
            const preliminary = await settleBoardClosedRows([winner], {
              requireSemantic: true,
              researchDeferred: true,
              scoreSafe: hasResolvedJobDescription,
              getView: row => readOfficialPostingView(row, { store: dependencies.officialPostingStore, signal }),
              minChars: JOB_DESCRIPTION_EVIDENCE_MIN_CHARS,
              setAsideKeys: context?.listingSetAsideKeys || null,
            });
            return preliminary.dispositions.get(winner) !== 'kept-official';
          },
          signal,
        });
        kept = alternateResult.rows;
        alternateRestored = alternateResult.restored;
      }
      if (alternatesByKey instanceof Map) kept = carryListingAlternates(kept, { alternatesByKey, restored: alternateRestored });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      logger.warn(`[ListingLiveness] Alternate restoration failed: ${error?.code || error?.name || 'Error'}`);
    }
    if (signal?.aborted) throw signal.reason || nodeCancellationError();
    // A resumed older row can already hold an AI-confirmed close from an ATS page.
    const officialClosedDrops = [];
    kept = kept.filter(row => {
      const evidence = readListingEvidence(row);
      if (row?.listingLiveness?.verdict !== 'closed' || row.listingLiveness.basis !== 'ai'
        || evidence?.finalHostClass !== 'ats' || officialPostingOutranksClosedPage(row, evidence?.finalUrl)) return true;
      officialClosedDrops.push({ kept: null, dropped: row, reason: 'dropped-official-closed',
        stage: 'board-closed', retire: true });
      return false;
    });
    const settled = await settleBoardClosed(kept, signal);
    const restoredCounts = {};
    for (const { row } of alternateRestored) {
      const board = row?.listingLiveness?.board || row?.source;
      if (board) bumpListingLivenessCount(restoredCounts, board, 'alternateRestored');
    }
    const listingLiveness = mergeListingLivenessTelemetry(
      listingLivenessTelemetryBlock({ input: rows, settled, officialClosedDrops }), restoredCounts);
    return { jobs: settled.kept,
      officialPosting: { ...mergeOfficialPostingTelemetry({ boardClosed: boardClosedTelemetryBlock({ input: rows, settled }), listingLiveness }),
        officialLookupsIncomplete: settled.kept.filter(row => row?.officialPosting && officialPostingLookupStatus(row.officialPosting).retryable).length },
      officialDedupDropped: 0, officialDedupDrops: [],
      boardClosedDropped: settled.dropped.length + officialClosedDrops.length,
      boardClosedDrops: [...officialClosedDrops, ...settled.dropped.map(entry => ({ kept: null, dropped: entry.row,
        reason: entry.disposition, stage: 'board-closed', retire: entry.disposition !== 'deferred-unchecked' }))] };
  };
  void pruneStaleUnsavedAnalysisArtifacts();
  void pruneStaleCareerInputStages();
  const ctx = { handleSafe, ipcMain, resolveRequiredPinnedCareerInputForHandler, runHttpSources, beforeSearchStageWrite, afterSearchProviderResult, retryIndeedDescriptions, retryGoogleApplyLinks, settleScrapedRowsForScoring, compileCareerSnapshot, dependencies, resolvePinnedScoringInputForHandler, beforeScoreSideEffect, runScoreBatch, reuseStoreDeps, runGapReview, runBoardTaxonomy, resolveBoardCompensationCareerInputs, callListingLiveness, listingLivenessCalibrationStore, settleBoardClosedRowsForHandler };
  registerCoreHandlers(ctx);
  registerBoardHandlers(ctx);

  registerSearchHandlers(ctx);


  registerRecoveryHandlers(ctx);

}









