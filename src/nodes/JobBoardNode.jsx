import { usePublishJobRunStatus } from '../hooks/usePublishJobRunStatus';
import { normalizeProgress } from './jobboard/jobBoardProgress';
import { pauseBoardCombine } from './jobboard/boardRecoveryNotice';
import { boardPauseRefusalMessage, boardPauseRestorePatch, classifyBoardPauseOutcome } from './jobboard/boardPauseRefusal';
import { settlePreFenceCanvasBatches } from '../utils/quitCommitSettle';
import { jobWorkflowNeedsQuitPause, savedWorkflowQuitPausePatch } from '../utils/quitWorkflowPause';
import { jobBoardHasSavedAiContinuation } from '../utils/jobBoardSavedAiContinuation';
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { boardCombinePerModule, describeBoardMergeInputs } from '../utils/jobBoardMergeSummary';
import { describeSourceHealthFailures, sourceHealthCaveats, sourceHealthSiteName } from '../utils/jobCollectionScopeCaveats';
import { useReactFlow, useStore } from '@xyflow/react';
import { LayoutGrid } from 'lucide-react';

import { HubContainer } from '../components/HubContainer';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { SessionStatusContext } from '../contexts/sessionStatusShared';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import { useJobSearchCoordinator } from '../contexts/useJobSearchCoordinator';
import { useToast } from '../components/ToastProvider';
import { useUnmountEffect } from '../hooks/useUnmountEffect';
import { useEpochCancellation } from '../hooks/useEpochCancellation';
import { useBoardOfficialPostingRefresh } from '../hooks/useBoardOfficialPostingRefresh';
import { useBoardStageRerun } from '../hooks/useBoardStageRerun';
import { RESEARCH_MIN_FIT_SCORE } from '../../electron/ipc/researchGate.js';
import { boardStageCards, compensationRowsFromCards, taxonomyRowsFromCards, rebuildRowFromCard, stageCardSnapshot, stageCardUnchanged,
  COMPENSATION_FIELDS, LISTING_FIELDS, compensationPatch, listingPatch, listingChangedGrouping, listingChangedSalaryInputs, finalSourceCountsOf } from './jobboard/boardStageRerun';
import { carryBoardOfficialPostingResults, countBoardOfficialRetries } from '../utils/jobBoardOfficialPostingRefresh';
import { carryBoardDeadSourceUrls } from '../utils/jobSourceLinks';
import { beginOfficialPostingPreparation, getOfficialPostingPreparation } from '../utils/officialPostingPreparation';
import { EventLogger } from '../utils/EventLogger';
import { JOB_COMPENSATION_METHOD_VERSION, jobBoardSalaryNeedsRefresh } from '../utils/jobCompensationVersion';
import { hubCardFilter, isLegacyUnscoredPlaceholder, isUnscoredPlaceholderCard, jobCardClosedAtMostOfficialSource } from '../utils/jobCardFilters';
import { buildJobTreeNodes, computeJobTreeView } from './jobsearch/buildJobTree';
import {
  createPrefixedManualAiRunId,
  normalizeManualAiCleanupReceipts,
  rememberBoundedRunId,
  removeManualAiCleanupReceipt,
  upsertManualAiCleanupReceipt,
  waitForRendererCommitFrame,
} from './jobsearch/manualAiRunReceipts';
import { deleteChildrenByHubId } from './_shared/hubChildCleanup';
import { boardDeletedJobKeys, splitBoardDeletedJobs } from '../utils/jobListingIdentity.js';
import { JobBoardStreamStatus } from './jobboard/JobBoardStreamStatus.jsx';
import { holdJobBoardIntake, jobBoardIntakeSnapshot, jobBoardIntakeVersion, setJobBoardIntakeState, subscribeJobBoardIntake } from '../utils/jobBoardIntakeCache.js';
import { approvedJobBoardCareerOverrideSnapshotId as boardOwnCareerSnapshotId } from '../utils/jobBoardCareerOverride.js';
import { JOB_BOARD_STREAM_RUN_PREFIX, describeJobBoardStreamStatus, isJobBoardStreamRunId, jobBoardRebuildDelayMs, jobBoardStreamRunId, nextJobBoardIntakeDelayMs } from '../utils/jobBoardStreamIntake.js';
import { ACTIVE_JOB_SEARCH_STATES, attachCompensationRemoteResidences, unionScoredJobs, moduleCombineFingerprint, combineSignature, normalizeJobMatchScore, staleReason, isLegacyCombineSignature, emptyReplacementIneligibilityReason, shouldKeepCompletedBoardSnapshotVisible } from './jobboard/mergeJobs';
import { runBoardResearchStage, removedLookupEntry, MAX_BOARD_REMOVED_LOOKUPS } from './jobboard/jobBoardResearchStage.js';
import { attachProtectedCards, consolidateJobLocations, isProtectedJobCard } from '../utils/jobLocationConsolidation';
// Shown only for a restored marker: 'Saved AI handoff ready. Choose Continue saved AI handoff…'
import { SAVED_HANDOFF_READY_MESSAGE, isLiveCombineOwnedMarker, combineCommitMismatchReason } from './jobboard/boardRecoveryNotice';
import { CONTINUE_SEARCH_ACTION_LABEL, SAVED_SEARCH_PAUSE_MESSAGE, isSavedPauseNotice, savedPauseMessageForPlan } from './jobboard/boardRecoveryNotice';
import { JobBoardDoneState } from './jobboard/JobBoardDoneState';
import { JobBoardSearchSelection } from './jobboard/JobBoardSearchSelection';
import { JobBoardCareerOverridePanel } from './jobboard/JobBoardCareerOverridePanel';
import { JobBoardPreferenceOverridePanel } from './jobboard/JobBoardPreferenceOverridePanel';
import { runBoardPreferenceOverrideStage } from './jobboard/jobBoardPreferenceOverrideStage';
import { activeJobBoardPreferenceOverride, applyJobBoardPreferenceBrief, jobBoardPreferenceOverrideView } from '../utils/jobBoardPreferenceOverride';
import { CareerCanvasFileImportDialog } from '../components/CareerCanvasFileImportDialog';
import { canvasCareerImportCandidates, reconcileCareerCanvasFileSelections, selectedCareerCanvasFiles, toggleCareerCanvasFileSelection } from '../utils/careerCanvasFileImport';
import { filesToDropPayloads } from '../utils/fileDropUtils';
import { CAREER_TEXT_ONLY_MESSAGE, isCareerTextFileName } from '../utils/careerTextFiles';
import {
  approveJobBoardCareerOverride,
  beginJobBoardCareerOverride,
  clearJobBoardCareerOverride,
  discardJobBoardCareerOverridePending,
  failJobBoardCareerOverride,
  jobBoardCareerOverrideView,
  markJobBoardCareerOverrideRunsRetired,
  queueJobBoardCareerOverrideRetire,
  isBoardIndependentManualAiRunId,
  isBoardCombineManualAiRunId,
  boardIndependentManualAiMarkerCleanup,
  resumeJobBoardCareerOverride,
  resolveSalaryCareerSnapshotId,
} from '../utils/jobBoardCareerOverride';
import { replaceBoardDisplayChildren } from './jobboard/replaceBoardDisplayChildren';
import { isJobBoardUserCancellation, isLegacyUnbucketedJobBoard, validateJobBoardTaxonomy } from '../utils/jobBoardAiProvider';
import { boundedCombinedSourceRuns, normalizeBoardResultCount } from '../utils/jobBoardProvenance';
import { findJobSearchBoardActiveRecoveryOwner, findJobSearchBoardRecoveryOwner, getConnectedJobSearchIds, getSelectedConnectedJobSearchIds, normalizeJobBoardAdmissionOrder, normalizeJobBoardRecoveryTimestamp, orderJobSearchIds } from '../utils/jobBoardSearchSelection';
import { hubHasAcceptedInitialDrop } from '../utils/hubDropEligibility';
import { jobSearchScrapeSetupProblem } from '../utils/jobSearchScrapeSetup';
import { getSearchLocation } from '../utils/jobSearchLocations';
import { exactInterruptedRecoveryAdmission } from '../utils/jobBoardRecoveryAdmission';
import { boardMayProbeInterruptedRun, finishedCardMayHideUnfinishedRun } from '../utils/jobBoardRecoveryAdmission';
import { cancelJobBoardChildrenSequentially, promoteJobBoardPausedSourceResolution } from '../utils/jobBoardChildFanout';
import { boardHistoryAuthorityAvailable, classifyJobBoardSourceAdmission, savedJobsRescoreFollowUp, combineSourceRunEntry, describeReceiptMismatch, isJobSearchRunShownOnOtherBoard, jobSearchOutcomeReceiptMatches, jobSearchShownRunPatch } from '../utils/jobBoardSourceAdmission';
import { jobSearchRescrapeAvailability } from '../utils/jobSearchSourceCoverage';
import { currentSavedJobsRescoreSkip } from '../utils/jobSearchSplitClear';
import { jobSearchCarriedResultsMarker } from '../utils/jobSearchCarriedResults';
import {
  getSavedAnalysisAvailability,
  getSavedAnalysisAvailabilityVersion,
  savedAnalysisResumeAdmission,
  subscribeSavedAnalysisAvailability,
} from '../utils/jobSavedAnalysisAvailability';
import { exactPausedSourceContinuation, isMergeableTerminalJobSearchOutcome, terminalJobSearchOutcome, awaitedSourceTerminalStatus, canRetryBoardRecoveryAfterError } from '../utils/jobBoardPausedSourceContinuation';
import {
  getJobWorkflowDeletionLifecycleRevision,
  isJobWorkflowDeletionPending,
  isJobWorkflowRelocationPending,
  subscribeJobWorkflowDeletionLifecycle,
} from '../utils/nodeDeletionLifecycle';

const ACTIVE_SEARCH_STATES = ACTIVE_JOB_SEARCH_STATES;
const SAVED_SCRAPE_MANUAL_AI_RECOVERY_MODES = new Set([
  'resume-saved-scrape',
  'append-scored-jobs',
]);

function createManualAiRunId(nodeId) {
  return createPrefixedManualAiRunId('job-board', nodeId);
}

function hasCancellationPendingManualAiCleanup(data) {
  return normalizeManualAiCleanupReceipts(data?.manualAiCleanupReceipts)
    .some(receipt => isBoardCombineManualAiRunId(receipt.runId) && receipt.cancellationPending === true);
}

function hasPendingManualAiRetirement(data) {
  return (isBoardCombineManualAiRunId(data?.manualAiResume?.runId)
    && data.manualAiResume.retirementPending === true)
    || hasCancellationPendingManualAiCleanup(data);
}

function waitForBoardRendererCommitFrame() {
  return waitForRendererCommitFrame();
}

async function waitForBoardPlanCommit({ getNode, nodeId, boardRunId, matches }) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await waitForBoardRendererCommitFrame();
    const plan = getNode(nodeId)?.data?.boardScanResume;
    if (!plan) continue;
    if (plan.boardRunId !== boardRunId) continue;
    if (typeof matches !== 'function' || matches(plan)) return true;
  }
  return false;
}

async function claimJobBoardProcessLease({
  canvasFilePath,
  nodeId,
  boardRunId,
  operation = 'board-orchestration',
  autoResume = false,
  waitForRelease = false,
}) {
  // Untitled canvases cannot be open as the same durable owner in two windows.
  // Keep their existing renderer-local queue behavior until the first Save.
  if (!canvasFilePath) return { localOnly: true };
  if (!window.electronAPI?.claimJobBoardRun) {
    return { error: 'This build cannot claim the saved Job Board recovery transaction.' };
  }
  const claimed = await window.electronAPI.claimJobBoardRun({
    canvasFilePath,
    nodeId,
    boardRunId,
    operation,
    autoResume,
    waitForRelease,
  });
  if (claimed?.success === true && claimed?.ok === true && claimed?.claimToken) return claimed;
  return {
    error: claimed?.error || claimed?.reason || 'The saved Job Board recovery transaction is already owned.',
    busy: claimed?.busy === true || claimed?.attempted === true,
  };
}

async function releaseJobBoardProcessLease(canvasFilePath, nodeId, boardRunId, claim) {
  if (!claim?.claimToken || !window.electronAPI?.releaseJobBoardRun) return;
  try {
    await window.electronAPI.releaseJobBoardRun({
      canvasFilePath,
      nodeId,
      boardRunId,
      claimToken: claim.claimToken,
      retryableDeferral: claim.retryableDeferral || null,
    });
  } catch {
    // Closing/reloading the renderer releases its sender-owned main lease.
  }
}

function isSavedScrapeManualAiResume(resume) {
  return resume?.task === 'job-scoring'
    || SAVED_SCRAPE_MANUAL_AI_RECOVERY_MODES.has(resume?.recoveryMode);
}


// Human label for a connected Job Search Module, from its search params.
// Phase B removed the standalone Target role box — the Search Brief (still
// `jobPreferences` on the wire) now carries whatever role signal exists.
// Prefer `resolvedRoles` — the DURABLE, once-locked title list (see ROLE
// LOCKING in JobSearchNode.jsx) — over `pinnedTitles`, which is a PER-RUN
// field reset to [] at the start of every run and only repopulated once that
// run reaches query construction. Reading pinnedTitles alone made a Board's
// label for a connected Search module go blank before the first run and
// after every reload; resolvedRoles survives both because it is written once
// and persisted. Fall back to pinnedTitles only for a hub that has never
// locked (fresh hub mid-run) or an unmigrated/legacy canvas that predates
// resolvedRoles entirely.
function moduleLabel(d) {
  const loc = String(d?.preferredLocation || d?.canonicalLocation || '').trim();
  const resolvedRoles = Array.isArray(d?.resolvedRoles) ? d.resolvedRoles : [];
  const pinnedTitles = Array.isArray(d?.pinnedTitles) ? d.pinnedTitles : [];
  const titles = resolvedRoles.length > 0 ? resolvedRoles : pinnedTitles;
  const role = typeof titles[0] === 'string' ? titles[0].trim() : '';
  return [role, loc].filter(Boolean).join(' · ') || 'Job Search';
}

function boardRecoveryTouchesPendingDeletion(boardId, plan = null, manualResume = null) {
  if (isJobWorkflowDeletionPending(boardId)) return true;
  const sourceIds = new Set([
    ...(Array.isArray(plan?.selectedSearchModuleIds) ? plan.selectedSearchModuleIds : []),
    plan?.activeSourceId,
    ...(Array.isArray(plan?.activeSourceIds) ? plan.activeSourceIds : []),
    plan?.cancellationCleanup?.sourceId,
    ...Object.keys(plan?.cancellationCleanupsBySource || {}),
    ...Object.keys(plan?.completedSourceRuns || {}),
    ...(Array.isArray(plan?.combineSourceRuns)
      ? plan.combineSourceRuns.map(entry => entry?.sourceId)
      : []),
    ...(Array.isArray(manualResume?.combineSourceRuns)
      ? manualResume.combineSourceRuns.map(entry => entry?.sourceId)
      : []),
  ].filter(Boolean));
  return [...sourceIds].some(sourceId => isJobWorkflowDeletionPending(sourceId));
}

function moduleSearchReadiness(node, verifyingPlatforms = null, {
  orchestratorNodeId = null,
  boardRunId = null,
  recoveryOwner = null,
  now = Date.now(),
} = {}) {
  const sourceData = node?.data || {};
  const hubState = sourceData.hubState || 'empty';
  if (isJobWorkflowDeletionPending(node?.id)) {
    return {
      ready: false,
      readinessReason: 'This module is being deleted.',
      statusLabel: 'Deletion pending',
    };
  }
  if (sourceData.locked) {
    return { ready: false, readinessReason: 'Unlock this module before scanning it.', statusLabel: 'Locked' };
  }
  if (hasCancellationPendingManualAiCleanup(sourceData)) {
    return {
      ready: false,
      readinessReason: 'Finish its older manual-AI cancellation cleanup before scanning it.',
      statusLabel: 'Cleanup pending',
    };
  }
  const exactBoardTerminalRetirement = sourceData.manualAiResume?.retirementPending
    && sourceData.hubState === 'done'
    && typeof sourceData.jobRunId === 'string'
    && !!sourceData.jobRunId
    && typeof sourceData.resultDisposition === 'string'
    && !!sourceData.resultDisposition
    && recoveryOwner
    && recoveryOwner.orchestratorNodeId === orchestratorNodeId
    && recoveryOwner.boardRunId === boardRunId;
  if (sourceData.manualAiResume?.retirementPending && !exactBoardTerminalRetirement) {
    return {
      ready: false,
      readinessReason: 'Retry its saved manual-AI cleanup before starting another scan.',
      statusLabel: 'Cleanup pending',
    };
  }
  if (ACTIVE_SEARCH_STATES.has(hubState)) {
    return { ready: false, readinessReason: 'This module is already processing.', statusLabel: 'Busy' };
  }
  if (recoveryOwner && (
    recoveryOwner.orchestratorNodeId !== orchestratorNodeId
    || !boardRunId
    || recoveryOwner.boardRunId !== boardRunId
  )) {
    return {
      ready: false,
      readinessReason: recoveryOwner.orchestratorNodeId === orchestratorNodeId
        ? 'This Board is resuming the interrupted search transaction.'
        : 'Its interrupted search belongs to another Job Board transaction.',
      statusLabel: recoveryOwner.orchestratorNodeId === orchestratorNodeId
        ? 'Resuming saved board'
        : 'Reserved by another board',
    };
  }
  if (sourceData.terminalFinalizationRecovery?.kind === 'terminal-finalization') {
    return { ready: true, readinessReason: '', statusLabel: 'Finish saved search' };
  }
  // A saved scoring replay owns its listings/profile/location snapshot and
  // does not refetch platforms. Let the Board reacquire this exact handoff even
  // if the current platform selection or paused source state has since changed.
  if (sourceData.manualAiResume?.runId && isSavedScrapeManualAiResume(sourceData.manualAiResume)) {
    return { ready: true, readinessReason: '', statusLabel: 'Resume pending search' };
  }
  // A terminal generation whose jobs no Board has shown yet is immutable
  // Board input: combine it, never scrape it again.  Keep this before
  // platform/location setup: reuse must not be disabled merely because a
  // completed Search's current controls were later edited.  A shown (or empty)
  // generation with a platform past its cooldown is re-scraped instead and so
  // falls through to the same setup checks a fresh search gets.
  const sourceAdmission = classifyJobBoardSourceAdmission(node, { now, boardId: orchestratorNodeId });
  if (sourceAdmission.kind === 'rescore-saved-jobs') {
    const count = Number.isFinite(sourceAdmission.savedJobCount) ? sourceAdmission.savedJobCount : 0;
    const jobsText = `${count} saved job${count === 1 ? '' : 's'}`;
    if (sourceAdmission.scoringOnly) {
      return {
        ready: true,
        boardAction: 'rescore',
        readinessReason: 'Scoring repair: re-score these saved jobs using the complete career evidence. The job selection and preferences are kept.',
        statusLabel: `${jobsText} · re-score`,
      };
    }
    // The same click re-scores and then searches the platforms past their
    // cooldown (JobSearchNode decides again from the re-scored card). The
    // search needs the same setup as any other scrape, so a missing platform
    // or location keeps the click to the re-score and says why.
    const followUp = savedJobsRescoreFollowUp(node, { now, boardId: orchestratorNodeId });
    const setupProblem = followUp.scrape ? jobSearchScrapeSetupProblem(node, { verifyingPlatforms }) : null;
    if (followUp.scrape && !setupProblem) {
      return {
        ready: true,
        boardAction: 'rescore',
        scrapesAfterRescore: true,
        readinessReason: followUp.addsToShown
          ? 'New career data: its saved jobs will be re-scored, then the platforms past their 24-hour cooldown are searched for new jobs, which are added to the ones this Board already shows.'
          : 'New career data: its saved jobs will be re-scored, then the platforms past their 24-hour cooldown are searched for new jobs, which replace the saved ones, then combined.',
        statusLabel: `${jobsText} · re-score, then search`,
      };
    }
    const noSearchReason = setupProblem
      ? setupProblem.readinessReason
      : followUp.afterKind === 'reuse-terminal' && !followUp.shown
        ? 'Its saved jobs have not been shown on a Job Board yet, so they are combined first; a later run searches for new jobs.'
        : followUp.afterKind === 'reuse-terminal' || followUp.afterKind === 'rescrape-cooldown'
          ? 'Every selected platform was searched in the last 24 hours.'
          : 'This Job Search cannot be searched again yet.';
    return {
      ready: true,
      boardAction: 'rescore',
      readinessReason: `New career data: its saved jobs will be re-scored, then combined. No new search runs: ${noSearchReason}`,
      statusLabel: `${jobsText} · re-score`,
    };
  }
  if (sourceAdmission.kind === 'career-cleared-awaiting-files') {
    return {
      ready: false,
      boardAction: 'career-cleared',
      readinessReason: sourceAdmission.reason,
      statusLabel: 'Needs career files',
    };
  }
  if (sourceAdmission.kind === 'reuse-terminal') {
    const count = Array.isArray(sourceData.scoredJobs) ? sourceData.scoredJobs.length : 0;
    return {
      ready: true,
      boardAction: 'reuse',
      readinessReason: count > 0
        ? 'Its completed scored jobs will be reused and combined without another scan.'
        : 'Its completed zero-result search will be reused when the Board combines saved inputs.',
      statusLabel: count > 0 ? `${count} saved job${count === 1 ? '' : 's'} · reuse` : 'Saved empty result · reuse',
    };
  }
  if (sourceAdmission.kind === 'rescrape-cooldown') {
    // Nothing new can be scraped yet. It is skipped (never blocks the other
    // selected searches) and, when another Board already showed these jobs,
    // left out of this Board's results.
    const when = Number.isFinite(sourceAdmission.nextEligibleAt)
      ? new Date(sourceAdmission.nextEligibleAt).toLocaleString()
      : null;
    return {
      ready: true,
      boardAction: 'cooldown',
      readinessReason: sourceAdmission.reason,
      statusLabel: when ? `Searched recently · next ${when}` : 'Searched recently',
    };
  }
  if (sourceAdmission.kind === 'terminal-requires-fresh-input') {
    return {
      ready: false,
      boardAction: 'terminal-blocked',
      readinessReason: sourceAdmission.reason,
      statusLabel: 'Re-import career data',
    };
  }
  if (sourceAdmission.kind === 'fresh-import-requires-clear') {
    // The card's scrape was cancelled, but the scored-ready saved snapshot the
    // Board itself produced may still be on disk. Resuming it re-scores those
    // saved jobs without scraping, so it is not a destructive Clear.
    const savedAnalysisResume = savedAnalysisResumeAdmission(
      node,
      getSavedAnalysisAvailability(node?.id),
    );
    if (savedAnalysisResume.ok) {
      const savedJobCount = savedAnalysisResume.jobCount;
      return {
        ready: true,
        boardAction: 'resume-saved',
        readinessReason: 'Its saved jobs will be scored again without scraping, then combined.',
        statusLabel: `${savedJobCount} saved job${savedJobCount === 1 ? '' : 's'} · resume scoring`,
      };
    }
    return {
      ready: false,
      boardAction: 'fresh-import-blocked',
      readinessReason: sourceAdmission.reason,
      statusLabel: 'Re-import career data',
    };
  }
  if (sourceAdmission.kind === 'career-import-paused') {
    return { ready: false, readinessReason: sourceAdmission.reason, statusLabel: 'Career compilation paused' };
  }
  if (sourceAdmission.kind === 'career-import-compiling') {
    return {
      ready: false,
      readinessReason: sourceAdmission.reason,
      statusLabel: 'Auditing career data',
    };
  }
  if (sourceAdmission.kind === 'career-import-failed'
    || sourceAdmission.kind === 'career-import-requires-approval') {
    return {
      ready: false,
      readinessReason: sourceAdmission.reason,
      statusLabel: 'Career compilation required',
    };
  }
  // A source-ready Search owns already-gathered rows and its exact source-card
  // continuation. Current platform toggles govern only a *fresh* scrape; they
  // must not relabel this intermediate generation as "Needs platform" or make
  // the Board discard/restart it after a user disables a source.
  if (sourceAdmission.kind === 'continue-existing') {
    return {
      ready: true,
      boardAction: 'continue',
      readinessReason: 'Continue this paused search from its existing gathered results. Resolve or skip its blocked sources; the Board will finish and combine it automatically.',
      statusLabel: 'Continue paused search',
    };
  }
  if (sourceAdmission.kind === 'continuation-requires-run-token') {
    return {
      ready: false,
      boardAction: 'continue-blocked',
      readinessReason: sourceAdmission.reason,
      statusLabel: 'Paused run needs attention',
    };
  }
  const setupProblem = jobSearchScrapeSetupProblem(node, { verifyingPlatforms });
  if (setupProblem) return setupProblem;
  if (sourceAdmission.kind === 'rescrape-terminal') {
    const count = Array.isArray(sourceData.scoredJobs) ? sourceData.scoredJobs.length : 0;
    // Same rule as jobSearchCarriedResultsMarker: the Board that still shows
    // these jobs keeps them and adds the new ones; any other Board replaces.
    const addsToShown = jobSearchCarriedResultsMarker(sourceData, { orchestratorNodeId }) !== null;
    return {
      ready: true,
      boardAction: 'scan',
      readinessReason: addsToShown
        ? 'The platforms past their 24-hour cooldown will be searched for new jobs, which are added to the ones this Board already shows.'
        : count > 0
          ? 'Its jobs were already shown on another Job Board. The platforms past their 24-hour cooldown will be searched for new jobs, which replace the saved ones, then combined.'
          : 'The platforms past their 24-hour cooldown will be searched for new jobs, then combined.',
      statusLabel: 'Ready to search for new jobs',
    };
  }
  return {
    ready: true,
    boardAction: sourceAdmission.kind === 'fresh-imported-input' ? 'scan' : 'continue',
    readinessReason: sourceAdmission.kind === 'fresh-imported-input'
      ? 'Freshly imported career data will be searched, then combined.'
      : '',
    statusLabel: sourceAdmission.kind === 'fresh-imported-input'
      ? 'Fresh career data · ready'
      : 'Ready to search',
  };
}

// This is deliberately only a preflight hint. The child re-reads this exact
// run id before changing Search state, so a stale peek can never authorize a
// fresh scan or a different recovery manifest.
async function inspectExactResumableJobRun(canvasFilePath, nodeId, sourceData, {
  platformsVerifying = false,
  allowAged = false,
  // A finished card is probed for a DIFFERENT, unfinished run. The finished
  // run its saved jobs came from (it has a result on the card) is never one
  // to continue.
  excludeSavedRun = false,
} = {}) {
  if (!canvasFilePath || !nodeId || !window.electronAPI?.peekJobRun) return null;
  try {
    const info = await window.electronAPI.peekJobRun({ canvasFilePath, nodeId });
    const admission = exactInterruptedRecoveryAdmission({
      info,
      nodeId,
      sourceData,
      platformsVerifying,
      allowAged,
    });
    if (!admission.ok) return null;
    if (
      excludeSavedRun
      && sourceData?.hubState === 'done'
      && !!sourceData?.resultDisposition
      && admission.runId === sourceData?.jobRunId
    ) return null;
    return admission.runId;
  } catch {
    return null;
  }
}

// A probe result is valid only for the input shape it inspected. Keep this
// compact signature separate from the manifest token so an old async response
// can never make a Search look resumable after its profile or location changes.
function interruptedRecoveryProbeSignature(sourceData) {
  const resumeFingerprint = typeof sourceData?.resumeFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(sourceData.resumeFingerprint.trim())
    ? sourceData.resumeFingerprint.trim()
    : '';
  return JSON.stringify({
    canonicalLocation: sourceData?.canonicalLocation || '',
    preferredLocation: sourceData?.preferredLocation || '',
    resumeFingerprint,
    hasResumeProfile: !!(sourceData?.resumeProfile && typeof sourceData.resumeProfile === 'object'
      && !Array.isArray(sourceData.resumeProfile)),
  });
}

function hasActivePlatformVerification(verifyingPlatforms) {
  return verifyingPlatforms instanceof Set
    ? verifyingPlatforms.size > 0
    : !!verifyingPlatforms;
}

// Recovery ownership is computed from several persisted source-id collections.
// Keep every collection distinct in the reactive signature below: a source can
// move from selected → active → completed without leaving the transaction, but
// that transition changes which Board is allowed to adopt its continuation.
function normalizeBoardRecoverySourceIds(sourceIds) {
  return [...new Set(
    (Array.isArray(sourceIds) ? sourceIds : [])
      .filter(sourceId => typeof sourceId === 'string' && sourceId),
  )].sort();
}

function boardScanRecoverySourceIdGroups(plan) {
  const cancellationCleanups = plan?.cancellationCleanupsBySource;
  const completedSourceRuns = plan?.completedSourceRuns;
  return {
    selectedSearchModuleIds: normalizeBoardRecoverySourceIds(plan?.selectedSearchModuleIds),
    activeSourceIds: normalizeBoardRecoverySourceIds([
      plan?.activeSourceId,
      ...(Array.isArray(plan?.activeSourceIds) ? plan.activeSourceIds : []),
    ]),
    completedSourceRunIds: normalizeBoardRecoverySourceIds(
      completedSourceRuns && typeof completedSourceRuns === 'object' && !Array.isArray(completedSourceRuns)
        ? Object.keys(completedSourceRuns)
        : [],
    ),
    combineSourceRunIds: normalizeBoardRecoverySourceIds(
      (Array.isArray(plan?.combineSourceRuns) ? plan.combineSourceRuns : [])
        .map(entry => entry?.sourceId),
    ),
    cancellationCleanupSourceIds: normalizeBoardRecoverySourceIds([
      plan?.cancellationCleanup?.sourceId,
      ...(cancellationCleanups && typeof cancellationCleanups === 'object' && !Array.isArray(cancellationCleanups)
        ? Object.keys(cancellationCleanups)
        : []),
    ]),
  };
}

function boardCancellationRecoverySourceIds(cancellation) {
  return normalizeBoardRecoverySourceIds([
    cancellation?.sourceId,
    ...(Array.isArray(cancellation?.sourceIds) ? cancellation.sourceIds : []),
  ]);
}

function canInspectInterruptedRecovery(readiness, sourceData, options) {
  // The rule lives in jobBoardRecoveryAdmission (boardMayProbeInterruptedRun).
  return boardMayProbeInterruptedRun(readiness, sourceData, options);
}

function isQueueableSearchContention(readiness) {
  return readiness?.statusLabel === 'Busy'
    || readiness?.statusLabel === 'Reserved by another board';
}

// A recovery plan's `updatedAt` is a write-progress timestamp, not an
// authorization boundary.  In particular, a recovered scan refreshes it when
// it first persists its in-memory copy of the plan.  Including that timestamp
// in the one-shot latch lets a Board re-admit itself after its own write.
//
// Connected Search state is deliberately part of this key: resolving a paused
// source, completing a manual handoff, changing source configuration, or
// finishing platform verification must still wake the exact durable plan.
function jobBoardSearchRecoveryKey(
  plan,
  connectedSignature,
  verificationSignature,
) {
  // connectedSignature includes JSON derived from user-editable job data, so
  // delimiter joining is ambiguous (`a|b` + `c` versus `a` + `b|c`). JSON
  // frames every component and keeps the recovery latch collision-free.
  return JSON.stringify([
    plan?.boardRunId || '',
    plan?.phase || 'searches',
    connectedSignature || '',
    verificationSignature || '',
  ]);
}

function clearExactBoardScanResume(updateGlobal, boardId, boardRunId) {
  if (!boardRunId) return;
  updateGlobal(boardId, (node) => {
    if (node?.data?.boardScanResume?.boardRunId !== boardRunId) return null;
    return { boardScanResume: null };
  });
}

// React can render an effect from the commit that *observed* a plan while the
// event that retired it is already in the live store. A Board run id and phase
// are the durable recovery identity; never let that stale render re-admit a
// plan which was cleared or advanced to Combine in the meantime.
function isCurrentBoardScanResume(livePlan, expectedPlan) {
  if (
    livePlan?.version !== 1
    || expectedPlan?.version !== 1
    || !livePlan.boardRunId
    || livePlan.boardRunId !== expectedPlan.boardRunId
  ) return false;
  return (livePlan.phase || 'searches') === (expectedPlan.phase || 'searches');
}

// A collection-only/test run deliberately finishes in the normal `done` state
// with no `scoredJobs`: it has gathered listings but did not produce mergeable
// hiring-fit results. It must never masquerade as a truthful scored-empty re-run
// and authorize replacement of an existing board cascade.
function isExplicitlyUnscoredModule(data) {
  return !!(data?.aiSkipped || data?.collectionOnly || data?.testMode);
}

function nonMergeableSearchMessage(sourceData) {
  if (
    sourceData?.resultDisposition === 'collection-only'
    || isExplicitlyUnscoredModule(sourceData)
  ) {
    return 'It completed without hiring-fit scoring, so its results cannot be combined. Turn off Test Mode if enabled, then search it again from this Board.';
  }
  return 'It completed without mergeable hiring-fit results. Search it again from this Board.';
}

// Capture the mergeable terminal inputs from the live canvas. A Combine can
// wait behind another Job Search run, then spend minutes in manual AI; render-
// time closures are not authority at either boundary.
// A Search whose saved jobs are waiting on replacement career data is not
// Combine input: its rows are still scored against the old snapshot, and a
// career-cleared hub has no snapshot to pin its cards to at all.
const SAVED_JOBS_CAREER_REPLACEMENT_ADMISSIONS = new Set([
  'career-cleared-awaiting-files',
  'rescore-saved-jobs',
  'career-import-paused',
  'career-import-compiling',
  'career-import-failed',
  'career-import-requires-approval',
]);

function liveCombineInputs(boardId, nodes, edges) {
  const connected = new Set(getConnectedJobSearchIds(boardId, nodes, edges));
  // The Board's rows come from the listing streams it reads (already judged
  // and scored on the Board side), never from a Job Search card's own result.
  const intake = jobBoardIntakeSnapshot(boardId);
  const all = (Array.isArray(nodes) ? nodes : [])
    .filter(node => connected.has(node?.id) && node?.type === 'jobhub')
    .map(node => {
      const data = node.data || {};
      const scoredJobs = intake.rowsByStream.get(node.id) || [];
      const preferenceCandidatePool = intake.filteredByStream.get(node.id) || [];
      const careerSnapshotId = typeof data.careerSnapshotId === 'string' ? data.careerSnapshotId.trim() : '';
      const remoteResidences = data.locationSnapshot?.remoteResidences || data.remoteResidences || {};
      const count = scoredJobs.length;
      return {
        id: node.id,
        runId: jobBoardStreamRunId(node.id),
        careerSnapshotId,
        operationAuthority: null,
        resultDisposition: 'scored',
        legacyPositiveResult: false,
        label: moduleLabel(data),
        count,
        fingerprint: moduleCombineFingerprint(scoredJobs, remoteResidences),
        scoredJobs,
        preferenceCandidatePool,
        jobPreferences: data.jobPreferences || '',
        searchBriefPlan: data.searchBriefPlan || null,
        remoteResidences,
        // The country this Search is for; the pay check reads a bare "$" by it.
        searchCountryCode: String((data.locationSnapshot?.searchLocation || getSearchLocation(data))?.countryCode || '').toUpperCase(),
        hubState: 'done',
        include: count > 0 || preferenceCandidatePool.length > 0,
        settledElsewhere: false,
      };
    });
  const completed = all.filter(module => module.include);
  const settled = all.filter(module => module.include || module.settledElsewhere);
  // Board preferences can pass a saved job the Search's own rules filtered out.
  const overrideActive = !!activeJobBoardPreferenceOverride((Array.isArray(nodes) ? nodes : []).find(node => node?.id === boardId)?.data);
  return { all, completed, settled, ready: completed.filter(module => module.count > 0 || (overrideActive && module.preferenceCandidatePool.length > 0)) };
}

function boardInputSignature(completedModules, connectedModules) {
  const completedById = new Map(
    (Array.isArray(completedModules) ? completedModules : []).map(module => [module.id, module]),
  );
  return combineSignature((Array.isArray(connectedModules) ? connectedModules : []).map((module) => {
    const completed = completedById.get(module.id);
    return completed || {
      id: module.id,
      // Nonterminal/unmergeable modules contribute no jobs, but their connected
      // topology and state are still part of the immutable Combine transaction.
      fingerprint: `state:${module.hubState || 'empty'}`,
    };
  }));
}

function combineInputsMatchExpected(modules, expectedSourceRuns) {
  if (!Array.isArray(expectedSourceRuns) || expectedSourceRuns.length === 0) return false;
  const currentById = new Map((Array.isArray(modules) ? modules : []).map(module => [module.id, module]));
  if (currentById.size !== expectedSourceRuns.length) return false;
  return expectedSourceRuns.every((expected) => {
    const current = currentById.get(expected?.sourceId);
    return !!current
      && typeof expected?.fingerprint === 'string'
      && !!expected.fingerprint
      && jobSearchOutcomeReceiptMatches(current, expected);
  });
}

function hasExactCombineRecoveryProof(signature, sourceRuns) {
  return typeof signature === 'string'
    && !!signature
    && Array.isArray(sourceRuns)
    && sourceRuns.length > 0
    && sourceRuns.every(entry => (
      typeof entry?.sourceId === 'string'
      && !!entry.sourceId
      && typeof entry?.fingerprint === 'string'
      && !!entry.fingerprint
    ));
}

function selectedRunsMatchExpected(modules, expectedSourceRuns) {
  if (!expectedSourceRuns || typeof expectedSourceRuns !== 'object') return true;
  const currentById = new Map((Array.isArray(modules) ? modules : []).map(module => [module.id, module]));
  return Object.entries(expectedSourceRuns).every(([sourceId, expected]) => {
    const current = currentById.get(sourceId);
    if (!current) return false;
    if (expected?.fingerprint) return jobSearchOutcomeReceiptMatches(current, expected);
    return (current.runId || null) === (expected?.runId || null)
      && (current.resultDisposition || null) === (expected?.resultDisposition || null);
  });
}

// Request for compiling career data from dropped, picked or canvas files: each
// file is { path, name? }, and a file without a name is shown by its path's last segment.
function careerFileRequest(files) {
  return {
    filePaths: files.map(file => file.path),
    fileNames: files.map(file => file.name || file.path.split(/[\\/]/u).pop() || file.path),
  };
}

/**
 * Job Board Module — orchestrator for the connected job-search pipeline. It
 * owns scan selection and queue admission, asks each selected Job Search module
 * to execute source-scoped workers (fresh independent children fan out;
 * recovery preserves source order), then unions every completed
 * connected module's stored `scoredJobs`. Finally it re-runs taxonomy over the
 * union and spawns the band→salary→role→cards cascade. Backend work remains
 * keyed to each source hub so recovery/progress ownership is preserved.
 */
export const JobBoardNode = React.memo(function JobBoardNode({ id, data }) {
  const { updateNodeData, setNodes, getNode, getNodes, getEdges, addNodes, addEdges, deleteElements, fitView } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const { verifying: verifyingPlatforms } = useContext(SessionStatusContext);
  // Queue turns can begin long after the click-time render. Keep the latest
  // verification set available to the in-flight coordinator so its per-child
  // admission check cannot use a stale closure after waiting for the lane.
  const verifyingPlatformsRef = useRef(verifyingPlatforms);
  verifyingPlatformsRef.current = verifyingPlatforms;
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const addElementsGlobally = nav?.addElementsGlobally;
  const canvasFilePath = nav?.currentFile || null;
  const { addToast } = useToast();
  const moduleRunQueue = useModuleRunQueue();
  const jobSearchCoordinator = useJobSearchCoordinator();
  const epoch = useEpochCancellation();
  const deletionLifecycleRevision = useSyncExternalStore(
    subscribeJobWorkflowDeletionLifecycle,
    getJobWorkflowDeletionLifecycleRevision,
    getJobWorkflowDeletionLifecycleRevision,
  );
  // A Job Search card publishes its resumable saved analysis outside node data
  // (see src/utils/jobSavedAnalysisAvailability.js). Subscribe here so this
  // Board re-renders its connected-module readiness when that entry changes.
  const savedAnalysisAvailabilityVersion = useSyncExternalStore(
    subscribeSavedAnalysisAvailability,
    getSavedAnalysisAvailabilityVersion,
    getSavedAnalysisAvailabilityVersion,
  );

  const hubState = data.hubState || 'empty';
  // This Board's copy of the listings it has taken from its streams.
  const intakeVersion = useSyncExternalStore(
    subscribeJobBoardIntake,
    () => jobBoardIntakeVersion(id),
    () => jobBoardIntakeVersion(id),
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const intakeSnapshot = useMemo(() => jobBoardIntakeSnapshot(id), [id, intakeVersion]);
  const [combining, setCombining] = useState(false);
  // Board career override: live run id of this renderer's compile, if any.
  const careerOverrideRunRef = useRef(null);
  const careerOverrideMountRetiredRef = useRef(false);
  const [careerOverrideLocalRunId, setCareerOverrideLocalRunId] = useState(null);
  const [careerOverrideBusy, setCareerOverrideBusy] = useState(false);
  const [careerCanvasOpen, setCareerCanvasOpen] = useState(false);
  const [careerCanvasSelections, setCareerCanvasSelections] = useState([]);
  const [careerCanvasError, setCareerCanvasError] = useState(null);
  // Once the replacement cascade and Board metadata are committed, Cancel can
  // no longer truthfully promise to keep the previous Board. Durable manual-AI
  // retirement may still take a few frames, so keep that short finalization
  // boundary distinct from the cancellable Combine phase in both the imperative
  // handler and the rendered controls.
  const [finalizingCommittedCombine, setFinalizingCommittedCombine] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(null);
  const [pauseSaving, setPauseSaving] = useState(false);
  const [recoveryError, setRecoveryError] = useState(null);
  // Kept out of persistent Board data: this is a renderer-only observation of
  // the selector's real action predicate and measured layout at report time.
  const selectorRuntimeSnapshot = null;
  const selectorEligibilityEventRef = useRef(null);
  // The selector is synchronous but manifest inspection is disk-backed. Cache
  // only a fenced, exact admission result so the UI can enable a valid recovery
  // without ever claiming that every disabled-platform Search is runnable.
  const [interruptedRecoveryProbes, setInterruptedRecoveryProbes] = useState({});
  const interruptedRecoveryProbeGenerationRef = useRef(0);
  const scanRunRef = useRef(null);
  // Recovery inspection awaits disk IPC before the normal scan token exists.
  // Reserve that short window so a double click cannot start two probes and
  // then two independent Board transactions.
  const scanPreflightRef = useRef(null);
  // Counts Board pause attempts, so a refused attempt takes back only the
  // paused marks that no later attempt has claimed.
  const boardPauseAttemptRef = useRef(0);
  // The text of the last "pause not confirmed" statement. While the Board's
  // recovery message is still exactly this text, the recovery effects leave it
  // alone: they neither replace it with a saved-pause notice nor re-enter the
  // run. Retry (or any newer message) ends the hold.
  const pauseRefusalMessageRef = useRef(null);
  const scanLaneLeaseOwnerRef = useRef(null);
  const activeSearchModuleIdRef = useRef(null);
  // A Board normally advances its children in source order.  A fresh-file
  // child can, however, stop at the first local-AI prompt for an arbitrary
  // amount of time.  Keep the complete live set separately from the legacy
  // singular ref so cancellation can still reach every child that was started
  // before the first prompt was answered.
  const activeSearchModuleIdsRef = useRef(new Set());
  // A child dialog emits its cancellation after its IPC work has settled; the
  // Search may already have cleared manualAiResume by then. Capture the exact
  // source/run pair at its pending boundary so the Board can still cancel the
  // matching fan-out generation without trusting the source id by itself.
  const activeSearchManualAiRunIdsRef = useRef(new Map());
  const activeBoardRunIdRef = useRef(null);
  const cancellationInFlightRef = useRef(null);
  const disconnectCancellationRef = useRef(null);
  // `setCombining(true)` is not synchronous. A rapid double click (or an
  // imperative duplicate call before React has rendered) would otherwise let
  // two combines start from the same stale closure, race their LLM work, and
  // let the later settlement replace the other cascade. Keep the active run
  // token in a ref so the admission check takes effect within this call stack.
  const combineRunRef = useRef(null);
  const refreshNodes = nav?.enumerateAllNodes || getNodes;
  const refreshEdges = nav?.enumerateAllEdges || getEdges;
  const refreshNode = nodeId => refreshNodes().find(node => node.id === nodeId);
  const { runRef: officialPostingRefreshRunRef, refreshing: officialPostingRefreshing,
    progress: officialPostingProgress, start: refreshOfficialPostings, retryIncomplete: retryIncompleteOfficialPostings,
    cancel: cancelOfficialPostingRefresh } = useBoardOfficialPostingRefresh({
    nodeId: id, canvasFilePath, getNode: refreshNode, getNodes: refreshNodes,
    getCurrentFile: nav?.getCurrentFile, updateGlobal, moduleRunQueue, addToast,
    canStart: () => {
      const live = refreshNode(id)?.data;
      return !!live && live.hubState === 'done' && !live.locked && !live.boardCancellation
        && !hasPendingManualAiRetirement(live) && !combineRunRef.current && !scanRunRef.current
        && !scanPreflightRef.current && !cancellationInFlightRef.current && !combineRecoveryTokenClaimRef.current
        && !live.boardScanResume && !isBoardCombineManualAiRunId(live.manualAiResume?.runId);
    },
    getScopeKey: () => {
      const inputs = liveCombineInputs(id, refreshNodes(), refreshEdges());
      return JSON.stringify([refreshNode(id)?.data?.combineSignature, boardInputSignature(inputs.completed, inputs.all),
        inputs.completed.map(combineSourceRunEntry)]);
    },
  });
  // A phase=combine retry with a retired token must first publish its replacement
  // token to the canvas. Reserve that short commit window too: the plan update
  // re-renders this component before the original await resumes, and its recovery
  // effect must not start a second Combine with the newly visible token.
  const combineRecoveryTokenClaimRef = useRef(null);
  const committedCombineRef = useRef(null);
  // Progress events need a request-level identity too. Node ids alone cannot
  // distinguish a newly started Combine from an older cancelled IPC call that
  // is still unwinding and emitting its final progress events.
  const compensationRequestIdRef = useRef(null);
  const compensationRequestSequenceRef = useRef(0);
  // The persisted manualAiResume marker is published asynchronously. Retain
  // the exact active combine token/run synchronously too, so Cancel in that
  // commit gap can still retire the durable handoff without touching a newer
  // combine that reused this Board node.
  const activeCombineManualAiRunRef = useRef(null);
  const combineInputSignaturesRef = useRef(new Map());
  const combineSourceRunsRef = useRef(new Map());
  const pendingCombineManualAiRunIdsRef = useRef(new Set());
  // A Combine run crosses an irreversible boundary when its new cascade and
  // Board metadata are published. Keep that run id as a mount-local tombstone
  // even after the short finalization await ends: a main-process pending/cancel
  // event can already be queued and arrive after the active token is cleared.
  // Such an event may retry exact cleanup, but it must never cancel/roll back a
  // Board result that is already visible.
  const committedCombineManualAiRunIdsRef = useRef(new Set());
  // Pending notifications are delivered asynchronously from the main process.
  // Remember every retired run so a notification already queued before
  // Cancel/Clear cannot recreate manualAiResume and restart the combine.
  const retiredCombineManualAiRunIdsRef = useRef(new Set());
  // One durable manual-AI run is replayed at most once. A replay whose inputs
  // disappeared is explicitly retired below rather than leaving this latch
  // stuck forever on a marker that can no longer be safely resumed.
  const autoResumedManualAiRunRef = useRef(null);
  const autoResumedBoardScanRef = useRef(null);
  // Keep a search-recovery error's external-state identity separate from the
  // auto-resume latch. The latter also holds `cleanup:` and `combine:` tokens,
  // which are not evidence that a Search result changed.
  const searchRecoveryErrorRef = useRef(null);
  // The awaited-source classification the recovery effect last computed, so the
  // selector runtime snapshot can report why a recovery error was (or was not)
  // cleared without the selector child knowing anything about recovery.
  const boardRecoveryDiagnosticsRef = useRef({ recoveryErrorLatch: 'none', awaitedSource: 'none' });
  // An untitled canvas has no sidecar to recover after a reload, but a Search
  // can still pause for source-card input during this mounted renderer session.
  // A real component unmount cancels the Board transaction, so never extend
  // this receipt beyond the live component instance.
  const inMemoryUntitledBoardRunIdsRef = useRef(new Set());
  const autoRetriedBoardCancellationRef = useRef(null);
  const attemptedSupersededCleanupRunIdsRef = useRef(new Set());
  const foreignRecoveryWaitSigRef = useRef(null);
  const visibleSnapshotRefreshLogKeyRef = useRef(null);
  // The compensation stage begins only after global taxonomy validation. Its
  // progress uses the same main-process event as a Job Search node, but the
  // node id below keeps concurrent boards/searches completely isolated.
  const [compensationProgress, setCompensationProgress] = useState(null);
  const [combineResearchProgress, setCombineResearchProgress] = useState(null);
  const [combineTrace, setCombineTrace] = useState(null);
  const combineTraceRef = useRef(null);
  const combineAttemptRef = useRef(0);
  const recordCombineStage = useCallback((phase, status = 'running', details = {}) => {
    const now = Date.now();
    const previous = combineTraceRef.current;
    const next = {
      attempt: previous?.attempt || combineAttemptRef.current,
      startedAt: previous?.startedAt || now,
      phase,
      phaseAt: now,
      status,
      ...details,
    };
    combineTraceRef.current = next;
    setCombineTrace(next);
  }, []);
  const [emptyReplacementPrompt, setEmptyReplacementPrompt] = useState(null);

  useEffect(() => {
    if (!window.electronAPI?.onCompensationProgress) return undefined;
    return window.electronAPI.onCompensationProgress((payload) => {
      // Board work is always scoped. Do not accept legacy/unscoped events here:
      // an unrelated search's progress is worse than no cosmetic indicator.
      const activeRequestId = compensationRequestIdRef.current;
      if (!activeRequestId || payload?.nodeId !== id || payload?.requestId !== activeRequestId) return;
      setCompensationProgress({ processed: payload.processed ?? 0, total: payload.total ?? 0 });
    });
  }, [id]);

  // Reactively track which Job Search Modules are wired into this board (either
  // edge direction — ConnectionMode.Loose). Returns a STRING signature so the
  // selector is stable (re-renders only when a connection or a module's job count
  // changes), then we derive the rich list via getNodes() keyed on that.
  // Read from each search's saved result, so a broken scraper stays visible on the Board after a restart.
  const brokenSourceNotices = useStore(useCallback(store => {
    const connected = store.edges.filter(edge => edge.source === id || edge.target === id).flatMap(edge => [edge.source, edge.target]);
    const selected = new Set(getSelectedConnectedJobSearchIds(data.selectedSearchModuleIds, connected));
    const seen = new Set();
    for (const node of store.nodes) {
      if (node.type !== 'jobhub' || !selected.has(node.id)) continue;
      for (const item of sourceHealthCaveats(node.data?.collectionScopeCaveats)) seen.add(`${sourceHealthSiteName(item.sourceId)}: ${describeSourceHealthFailures(item.failures)}`);
    }
    return [...seen].join('\n');
  }, [id, data.selectedSearchModuleIds]));
  const incompleteOfficialLookups = useStore(useCallback(store => countBoardOfficialRetries(store.nodes, id), [id]));
  // Every path that writes a lookup result (Board refresh, a card's own lookup, Generate) changes this.
  const closedCardIds = useStore(useCallback(store => store.nodes
    .filter(node => node.type === 'jobcard' && node.data?.hubId === id && jobCardClosedAtMostOfficialSource(node.data))
    .map(node => `${node.id}\t${node.data?.source || ''}`).join('\n'), [id]));
  const closedCardCount = closedCardIds ? closedCardIds.split('\n').length : 0;
  // The clock the cooldown-dependent readiness is evaluated at; advanced by a
  // timer when a connected Search's next platform becomes due.
  const [rescrapeClock, setRescrapeClock] = useState(() => Date.now());
  const connectedSig = useStore(
    useCallback((s) => {
      const ids = new Set();
      s.edges.forEach((e) => {
        if (e.source === id) ids.add(e.target);
        else if (e.target === id) ids.add(e.source);
      });
      // The legacy/default execution order is the connected Job Search order
      // in the canvas. Track only its relative source rank so reordering two
      // connected sources refreshes the selector, while unrelated nodes moving
      // or being inserted ahead of them do not create signature churn.
      const sourceCanvasOrder = new Map();
      (Array.isArray(s.nodes) ? s.nodes : []).forEach((node) => {
        if (node?.type !== 'jobhub' || !ids.has(node.id)) return;
        sourceCanvasOrder.set(node.id, sourceCanvasOrder.size);
      });
      const parts = [];
      ids.forEach((nid) => {
        const n = s.nodeLookup.get(nid);
        if (n && n.type === 'jobhub') {
          // Fingerprint (not just length) so re-running a module — same count,
          // different jobs/scores — registers as changed data, not a no-op.
          // Include scoring provenance too. A collection-only completion has the
          // same empty array/state shape as a real zero-result search, but it is
          // not safe to use as a replacement input for an existing board.
          parts.push(JSON.stringify({
            id: nid,
            sourceCanvasOrder: sourceCanvasOrder.get(nid) ?? null,
            fingerprint: moduleCombineFingerprint(
              n.data?.scoredJobs,
              n.data?.locationSnapshot?.remoteResidences || n.data?.remoteResidences || {},
            ),
            hubState: n.data?.hubState || '',
            jobRunId: n.data?.jobRunId || '',
            aiSkipped: !!n.data?.aiSkipped,
            collectionOnly: !!n.data?.collectionOnly,
            testMode: !!n.data?.testMode,
            resultDisposition: n.data?.resultDisposition || '',
            // Parent scan recovery waits on the child-owned manual handoff.
            // Include its durable marker and terminal error so the Board's
            // continuation effect wakes even when the child restores to the
            // same hubState/run metadata it had before the interruption.
            manualAiResumeRunId: n.data?.manualAiResume?.runId || '',
            manualAiResumeTask: n.data?.manualAiResume?.task || '',
            manualAiRecoveryMode: n.data?.manualAiResume?.recoveryMode || '',
            manualAiRetirementPending: n.data?.manualAiResume?.retirementPending === true,
            // Use the same malformed-receipt-safe predicate as readiness.
            // A run id is an ownership detail, not an input to selector state.
            hasCancellationPendingManualAiCleanup: hasCancellationPendingManualAiCleanup(n.data),
            terminalFinalizationRunId: n.data?.terminalFinalizationRecovery?.runId || '',
            hasTerminalFinalizationRecovery: n.data?.terminalFinalizationRecovery?.kind === 'terminal-finalization',
            errorMessage: n.data?.errorMessage || '',
            locked: !!n.data?.locked,
            hasCareerInput: hubHasAcceptedInitialDrop(n),
            preferredLocation: n.data?.preferredLocation || '',
            canonicalLocation: n.data?.canonicalLocation || '',
            searchLocation: n.data?.searchLocation || null,
            enabledSourceIds: n.data?.enabledSourceIds || null,
            collectionLimits: n.data?.collectionLimits || null,
            // Fresh-import admission is intentionally one-shot, but a legacy
            // login preflight can reclaim its exact unstarted claim. Include
            // the compact capability identity—not volatile timestamps—so the
            // selector immediately re-evaluates setup when that admission
            // state changes without any other Search data changing.
            careerImportAdmission: {
              generation: n.data?.careerImportGeneration || null,
              freshCapability: n.data?.careerImportFreshCapability || null,
              compilation: n.data?.careerImportCompilation && typeof n.data.careerImportCompilation === 'object'
                ? {
                  generation: n.data.careerImportCompilation.generation || null,
                  attemptId: n.data.careerImportCompilation.attemptId || null,
                  status: n.data.careerImportCompilation.status || null,
                  careerSnapshotId: n.data.careerImportCompilation.careerSnapshotId || null,
                }
                : null,
              careerSnapshotId: n.data?.careerSnapshotId || null,
              consumption: n.data?.careerImportConsumption && typeof n.data.careerImportConsumption === 'object'
                ? {
                  generation: n.data.careerImportConsumption.generation || null,
                  capability: n.data.careerImportConsumption.capability || null,
                  origin: n.data.careerImportConsumption.origin || null,
                  boardRunId: n.data.careerImportConsumption.boardRunId || null,
                  admissionVersion: n.data.careerImportConsumption.admissionVersion ?? null,
                }
                : null,
            },
            // The admission enum collapses the legacy no-work proof into one
            // non-sensitive reactive value. Do not serialize profile, query,
            // warning, or count payloads merely to refresh the selector.
            admissionKind: classifyJobBoardSourceAdmission(n, { boardId: id }).kind,
            // Which Board first showed this run decides whether this Board
            // re-scrapes, reuses or leaves it out; it changes on its own when
            // another Board's Combine records it.
            shownRunId: n.data?.boardShownRun?.runId || '',
            shownBoardId: n.data?.boardShownRun?.boardId || '',
            // Exact interrupted recovery also needs the current profile
            // identity, but this signature contains only a fingerprint/boolean
            // and normalized location fields—never career content.
            recoveryProbeSignature: interruptedRecoveryProbeSignature(n.data),
          }));
        }
      });
      parts.sort();
      return parts.join('|');
    }, [id])
  );

  // Recovery ownership can live on a different Board node, so changes to the
  // connected Search alone are not always enough to wake a queued recovered
  // transaction. Track the compact global ownership ledger and retry only when
  // one of those durable plans actually changes.
  const boardRecoverySig = useStore(
    useCallback((store) => {
      const owners = [];
      // `getNodes()` elects its last-resort owner by array index. Read this
      // same user-node array and retain that index in the signature: two
      // otherwise-identical legacy plans can legitimately change owner when
      // their canvas order changes. Positions are intentionally excluded, so
      // ordinary dragging does not wake recovery work.
      const canvasNodes = Array.isArray(store.nodes) ? store.nodes : [];
      canvasNodes.forEach((node, canvasIndex) => {
        if (node?.type !== 'jobboard') return;
        const plan = node.data?.boardScanResume;
        if (plan?.version === 1 && typeof plan.boardRunId === 'string' && !!plan.boardRunId) {
          const sourceIds = boardScanRecoverySourceIdGroups(plan);
          owners.push(JSON.stringify({
            kind: 'scan',
            id: node.id,
            canvasIndex,
            boardRunId: plan.boardRunId,
            phase: plan.phase || '',
            startedAt: normalizeJobBoardRecoveryTimestamp(plan.startedAt),
            admissionOrder: normalizeJobBoardAdmissionOrder(plan.admissionOrder),
            activeSourceId: plan.activeSourceId || '',
            cancellationSourceId: plan.cancellationCleanup?.sourceId || '',
            combineManualAiRunId: plan.combineManualAiRunId || '',
            ...sourceIds,
          }));
        }
        const cancellation = node.data?.boardCancellation;
        const cancellationSourceIds = boardCancellationRecoverySourceIds(cancellation);
        if (
          typeof cancellation?.boardRunId === 'string'
          && !!cancellation.boardRunId
          && cancellationSourceIds.length > 0
        ) {
          owners.push(JSON.stringify({
            kind: 'cancellation',
            id: node.id,
            canvasIndex,
            boardRunId: cancellation.boardRunId || '',
            startedAt: normalizeJobBoardRecoveryTimestamp(cancellation.startedAt),
            admissionOrder: normalizeJobBoardAdmissionOrder(cancellation.admissionOrder),
            sourceId: cancellation.sourceId || '',
            sourceIds: cancellationSourceIds,
          }));
        }
        // A standalone manual Combine also reserves each exact completed
        // Search input. Include that owner in the global wake signature so a
        // recovered scan that yielded to it retries as soon as the marker is
        // completed/cancelled, even when the shared Search itself did not move.
        const manual = node.data?.manualAiResume;
        const manualCombineSourceIds = normalizeBoardRecoverySourceIds(
          (Array.isArray(manual?.combineSourceRuns) ? manual.combineSourceRuns : [])
            .map(entry => entry?.sourceId),
        );
        const manualStartedAt = normalizeJobBoardRecoveryTimestamp(manual?.startedAt)
          ?? normalizeJobBoardRecoveryTimestamp(manual?.updatedAt);
        if (
          typeof manual?.runId === 'string'
          && !!manual.runId
          && manual.retirementPending !== true
          && manualCombineSourceIds.length > 0
        ) {
          owners.push(JSON.stringify({
            kind: 'combine',
            id: node.id,
            canvasIndex,
            runId: manual.runId,
            // Cleanup-only manual markers intentionally stop reserving their
            // completed Search inputs. Include that ownership boundary in the
            // wake key so a recovered Board that yielded to this Combine is
            // woken when that marker is retired.
            retirementPending: manual.retirementPending === true,
            startedAt: manualStartedAt,
            combineInputSignature: manual.combineInputSignature || '',
            sourceIds: manualCombineSourceIds,
          }));
        }
      });
      // Ownership of completed/combine inputs exists only while that foreign
      // Board remains connected to the Search. A disconnect may therefore
      // unblock this Board without changing either node's durable marker.
      // Include the compact global Board↔Search topology so yielded recovery
      // turns wake exactly when that election input changes.
      // Owner election treats Board↔Search edges as an undirected Set. Match
      // that here so duplicate/reversed edges and insertion order do not cause
      // irrelevant signature churn, while a real topology change still wakes
      // recovery arbitration.
      const boardSearchEdges = new Set();
      (Array.isArray(store.edges) ? store.edges : []).forEach((edge) => {
        const source = store.nodeLookup.get(edge?.source);
        const target = store.nodeLookup.get(edge?.target);
        const isBoardSearch = (source?.type === 'jobboard' && target?.type === 'jobhub')
          || (source?.type === 'jobhub' && target?.type === 'jobboard');
        if (!isBoardSearch) return;
        const board = source?.type === 'jobboard' ? source : target;
        const search = source?.type === 'jobhub' ? source : target;
        boardSearchEdges.add(JSON.stringify({
          kind: 'edge',
          boardId: board.id,
          searchId: search.id,
        }));
      });
      owners.push(...boardSearchEdges);
      owners.sort();
      return owners.join('|');
    }, []),
  );

  useEffect(() => {
    const generation = ++interruptedRecoveryProbeGenerationRef.current;
    let cancelled = false;
    // The child refuses to run while its platform session is being verified.
    // Do not retain an optimistic pre-verification affordance through that
    // window; a later effect will inspect again once the live session settles.
    if (!canvasFilePath || hasActivePlatformVerification(verifyingPlatforms)) {
      setInterruptedRecoveryProbes({});
      return () => { cancelled = true; };
    }

    const nodes = getNodes();
    const edges = getEdges();
    const candidateNodes = getConnectedJobSearchIds(id, nodes, edges)
      .map(nodeId => nodes.find(node => node.id === nodeId))
      .filter(node => {
        if (node?.type !== 'jobhub') return false;
        const recoveryOwner = node.data?.manualAiResume?.runId
          ? findJobSearchBoardRecoveryOwner(node.id, node.data.manualAiResume.runId, nodes, edges)
          : findJobSearchBoardActiveRecoveryOwner(node.id, nodes, edges);
        const readiness = moduleSearchReadiness(node, verifyingPlatforms, {
          orchestratorNodeId: id,
          recoveryOwner,
        });
        return canInspectInterruptedRecovery(readiness, node.data, { boardId: id });
      });

    Promise.all(candidateNodes.map(async (node) => ({
      nodeId: node.id,
      signature: interruptedRecoveryProbeSignature(node.data),
      // A finished card with no run id can only hide this Board's own paused
      // search; its age is not a reason to leave it unreachable.
      runId: await inspectExactResumableJobRun(canvasFilePath, node.id, node.data, {
        excludeSavedRun: true,
        allowAged: node.data?.hubState === 'done' && !node.data?.jobRunId,
      }),
    }))).then((results) => {
      if (cancelled || interruptedRecoveryProbeGenerationRef.current !== generation) return;
      const next = {};
      results.forEach(({ nodeId, signature, runId }) => {
        if (runId) next[nodeId] = { signature, runId };
      });
      setInterruptedRecoveryProbes(next);
    }).catch(() => {
      if (!cancelled && interruptedRecoveryProbeGenerationRef.current === generation) {
        setInterruptedRecoveryProbes({});
      }
    });
    return () => { cancelled = true; };
  }, [boardRecoverySig, canvasFilePath, connectedSig, deletionLifecycleRevision, getEdges, getNodes, id, verifyingPlatforms]);

  useEffect(() => {
    const onRecoveryLedgerChanged = (event) => {
      const { hubId, canvasFilePath: changedCanvasFilePath } = event?.detail || {};
      if (!hubId || changedCanvasFilePath !== canvasFilePath) return;
      // A Clear career data action can arrive while a previous peek is still in flight.
      // Invalidate that async generation before removing its cached affordance,
      // otherwise its stale completion can put the old token straight back.
      interruptedRecoveryProbeGenerationRef.current += 1;
      setInterruptedRecoveryProbes((current) => {
        if (!current[hubId]) return current;
        const next = { ...current };
        delete next[hubId];
        return next;
      });
    };
    document.addEventListener('job-run-recovery-ledger-changed', onRecoveryLedgerChanged);
    return () => document.removeEventListener('job-run-recovery-ledger-changed', onRecoveryLedgerChanged);
  }, [canvasFilePath]);

  const connectedModules = useMemo(() => {
    const edges = getEdges();
    const nodes = getNodes();
    const nodeIds = new Set(getConnectedJobSearchIds(id, nodes, edges));
    return nodes
      .filter((n) => nodeIds.has(n.id) && n.type === 'jobhub')
      .map((n) => {
        const recoveryOwner = n.data?.manualAiResume?.runId
          ? findJobSearchBoardRecoveryOwner(n.id, n.data.manualAiResume.runId, nodes, edges)
          : findJobSearchBoardActiveRecoveryOwner(n.id, nodes, edges);
        const readiness = moduleSearchReadiness(
          n,
          verifyingPlatforms,
          { orchestratorNodeId: id, recoveryOwner, now: rescrapeClock },
        );
        const probe = interruptedRecoveryProbes[n.id];
        const recoveryProbeEligible = !!canvasFilePath
          && !hasActivePlatformVerification(verifyingPlatforms)
          && canInspectInterruptedRecovery(readiness, n.data, { boardId: id })
          && probe?.signature === interruptedRecoveryProbeSignature(n.data)
          && typeof probe?.runId === 'string'
          && !!probe.runId;
        return {
          id: n.id,
          runId: n.data?.jobRunId || null,
          label: moduleLabel(n.data),
          count: Array.isArray(n.data?.scoredJobs) ? n.data.scoredJobs.length : 0,
          fingerprint: moduleCombineFingerprint(
            n.data?.scoredJobs,
            n.data?.locationSnapshot?.remoteResidences || n.data?.remoteResidences || {},
          ),
          hubState: n.data?.hubState || 'empty',
          aiSkipped: !!n.data?.aiSkipped,
          collectionOnly: !!n.data?.collectionOnly,
          testMode: !!n.data?.testMode,
          isScored: !isExplicitlyUnscoredModule(n.data),
          resultDisposition: n.data?.resultDisposition || null,
          // Shown first on another Board: this Board leaves it out, exactly as
          // liveCombineInputs does, so the live signature matches Combine's.
          shownElsewhere: isJobSearchRunShownOnOtherBoard(n, id),
          ...readiness,
          ...(recoveryProbeEligible ? {
            ready: true,
            statusLabel: 'Resume saved recovery',
            // A finished card hiding an unfinished search: say what the click
            // does, and count it as work so the Board is not "up to date".
            ...(finishedCardMayHideUnfinishedRun(readiness, n.data, { boardId: id }) ? {
              boardAction: 'continue',
              readinessReason: 'An unfinished search is saved for this Job Search. It continues from where it stopped; the jobs already on the card are kept.',
            } : {
              readinessReason: 'Resume this Search’s exact unfinished run.',
            }),
          } : {}),
          ...(isQueueableSearchContention(readiness) ? { ready: true } : {}),
          // The Board reads this Search's listing stream. What it holds from
          // that stream is its input; the card's own state no longer gates it.
          ...(() => {
            const streamRows = intakeSnapshot.rowsByStream.get(n.id) || [];
            const streamStatus = describeJobBoardStreamStatus(intakeSnapshot.statuses?.[n.id]);
            return {
              runId: jobBoardStreamRunId(n.id),
              count: streamRows.length,
              candidatePoolCount: (intakeSnapshot.filteredByStream.get(n.id) || []).length,
              fingerprint: moduleCombineFingerprint(streamRows, n.data?.locationSnapshot?.remoteResidences || n.data?.remoteResidences || {}),
              hubState: 'done',
              isScored: true,
              resultDisposition: 'scored',
              shownElsewhere: false,
              ready: true,
              boardAction: 'reuse',
              statusLabel: streamStatus.label,
              readinessReason: streamStatus.detail,
              streamActive: streamStatus.active,
            };
          })(),
        };
      });
    // connectedSig is the real reactive trigger; getEdges/getNodes are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardRecoverySig, canvasFilePath, connectedSig, deletionLifecycleRevision, id, intakeSnapshot, interruptedRecoveryProbes, rescrapeClock, savedAnalysisAvailabilityVersion, verifyingPlatforms]);

  // A finished Search becomes searchable again when its first platform leaves
  // the 24-hour cooldown. Nothing on the canvas changes at that moment, so wake
  // the readiness above once, at the earliest such time.
  useEffect(() => {
    const nodes = getNodes();
    const connected = new Set(getConnectedJobSearchIds(id, nodes, getEdges()));
    const nowMs = Date.now();
    const next = nodes
      .filter(node => connected.has(node.id) && node.type === 'jobhub' && node.data?.hubState === 'done')
      .map(node => jobSearchRescrapeAvailability(node.data, nowMs).nextEligibleAt)
      .filter(at => Number.isFinite(at) && at > nowMs)
      .reduce((earliest, at) => Math.min(earliest, at), Infinity);
    if (!Number.isFinite(next)) return undefined;
    const timer = setTimeout(() => setRescrapeClock(Date.now()), Math.min(next - nowMs + 1000, 24 * 60 * 60 * 1000));
    return () => clearTimeout(timer);
    // connectedSig is the real reactive trigger; getEdges/getNodes are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedSig, id, rescrapeClock]);

  const connectedModuleIds = useMemo(() => connectedModules.map((module) => module.id), [connectedModules]);
  // Execution preference is deliberately independent from selection: old
  // Boards (and newly connected Searches) retain this canvas-order fallback.
  const executionOrderedConnectedIds = useMemo(
    () => orderJobSearchIds(data.searchExecutionOrder, connectedModuleIds),
    [data.searchExecutionOrder, connectedModuleIds],
  );
  const executionOrderedModules = useMemo(() => {
    const modulesById = new Map(connectedModules.map(module => [module.id, module]));
    return executionOrderedConnectedIds.map(moduleId => modulesById.get(moduleId)).filter(Boolean);
  }, [connectedModules, executionOrderedConnectedIds]);
  const selectedSearchModuleIds = useMemo(
    () => orderJobSearchIds(
      data.searchExecutionOrder,
      getSelectedConnectedJobSearchIds(data.selectedSearchModuleIds, connectedModuleIds),
    ),
    [data.searchExecutionOrder, data.selectedSearchModuleIds, connectedModuleIds],
  );

  useEffect(() => {
    EventLogger.registerNodeState(id, {
      // How many connected Searches this Board found an unfinished run on
      // disk for (a count, no ids). Beside "up to date" it names a dead end.
      jobBoardSelector: selectorRuntimeSnapshot
        ? { ...selectorRuntimeSnapshot, unfinishedRunsFound: Object.keys(interruptedRecoveryProbes).length }
        : selectorRuntimeSnapshot,
      jobBoardCombine: {
        ...combineTrace,
        combining,
        scanning,
        activeCombineOwner: !!combineRunRef.current,
        compensationProcessed: compensationProgress?.processed ?? null,
        compensationTotal: compensationProgress?.total ?? null,
        finalizingCommittedCombine,
      },
    });
  }, [id, selectorRuntimeSnapshot, interruptedRecoveryProbes, combineTrace, combining, scanning, compensationProgress, finalizingCommittedCombine]);

  useEffect(() => () => EventLogger.unregisterNodeState(id), [id]);

  useEffect(() => {
    if (!selectorRuntimeSnapshot) return;
    const signature = [
      selectorRuntimeSnapshot.rowCount,
      selectorRuntimeSnapshot.selectedCount,
      selectorRuntimeSnapshot.actionVisible === false ? 'hidden' : selectorRuntimeSnapshot.actionEligible ? 'ready' : 'blocked',
      Array.isArray(selectorRuntimeSnapshot.eligibilityReasons)
        ? selectorRuntimeSnapshot.eligibilityReasons.join(',')
        : '',
    ].join('|');
    if (selectorEligibilityEventRef.current === signature) return;
    selectorEligibilityEventRef.current = signature;
    EventLogger.log(
      `[JobBoard] selector eligibility id=${id} rows=${selectorRuntimeSnapshot.rowCount ?? 0} `
      + `selected=${selectorRuntimeSnapshot.selectedCount ?? 0} `
      + `action=${selectorRuntimeSnapshot.actionVisible === false ? 'hidden' : selectorRuntimeSnapshot.actionEligible ? 'enabled' : 'disabled'} `
      + `reasons=${Array.isArray(selectorRuntimeSnapshot.eligibilityReasons) && selectorRuntimeSnapshot.eligibilityReasons.length > 0
        ? selectorRuntimeSnapshot.eligibilityReasons.join(',')
        : 'none'}`,
    );
  }, [id, selectorRuntimeSnapshot]);



  // Positive scored jobs always remain mergeable, even from an older canvas
  // that predates resultDisposition. An empty module is mergeable only when
  // Job Search explicitly recorded a terminal zero: either no score-ready jobs
  // existed (`empty-complete`) or Job Preferences deliberately filtered every
  // score-ready candidate (`preference-filtered`). Recovery/error branches can
  // also end in `done` with an empty array but must never erase a board.
  // Collection-only/test completions are likewise never empty inputs.
  const mergeableModules = useMemo(
    () => connectedModules.map((m) => ({
      ...m,
      hasPositiveResults: m.count > 0,
      isAuthoritativeEmpty: m.isScored
        && (m.resultDisposition === 'empty-complete' || m.resultDisposition === 'preference-filtered'),
    })),
    [connectedModules],
  );

  // Keep every valid terminal input in the staleness signature, INCLUDING a
  // genuinely completed zero-result re-run. Only positive-result modules
  // contribute jobs to the actual merge.
  const preferenceOverrideActive = !!activeJobBoardPreferenceOverride(data);
  const completedModules = useMemo(
    () => mergeableModules.filter((m) => m.hubState === 'done' && (m.hasPositiveResults || m.isAuthoritativeEmpty) && !m.shownElsewhere),
    [mergeableModules],
  );
  // Finished Searches this Board leaves out because another Board showed them
  // are settled here, so they never hold the Board in an unfinished state.
  const settledElsewhereCount = useMemo(
    () => mergeableModules.filter((m) => m.hubState === 'done' && (m.hasPositiveResults || m.isAuthoritativeEmpty) && m.shownElsewhere).length,
    [mergeableModules],
  );
  const readyModules = useMemo(
    () => completedModules.filter((m) => m.count > 0 || (preferenceOverrideActive && (m.candidatePoolCount || 0) > 0)),
    [completedModules, preferenceOverrideActive],
  );
  const allConnectedModulesDone = connectedModules.length > 0
    && completedModules.length + settledElsewhereCount === connectedModules.length;
  // Signature of every terminal module (id + data fingerprint). Compared against
  // the signature captured at the last Combine to tell whether the cached board
  // is still valid, including a terminal zero-result re-run.
  const liveSignature = useMemo(
    () => boardInputSignature(completedModules, connectedModules),
    [completedModules, connectedModules],
  );
  const salaryCareerKey = useStore(useCallback(store => {
    const connected = new Set(getConnectedJobSearchIds(id, store.nodes, store.edges));
    const selected = resolveSalaryCareerSnapshotId({
      boardData: store.nodeLookup.get(id)?.data,
      searchModules: store.nodes.filter(node => node.type === 'jobhub' && connected.has(node.id)),
    });
    return selected.blocked ? 'pending' : selected.careerSnapshotId || '';
  }, [id]));
  const salaryNeedsRefresh = jobBoardSalaryNeedsRefresh(data, salaryCareerKey);
  const stale = hubState === 'done' && !!data.stale;
  const staleReasonText = useMemo(
    () => (stale ? (data.staleReason || staleReason(data.combineSignature, completedModules, connectedModules)) : ''),
    [stale, data.staleReason, data.combineSignature, completedModules, connectedModules]
  );
  const emptyReplacementBlockReason = emptyReplacementIneligibilityReason({
    stale,
    allConnectedModulesDone,
    readyModuleCount: readyModules.length,
  });
  const canReplaceWithEmpty = emptyReplacementBlockReason === null;

  // ── Cascade filters (score slider + per-source), scoped to THIS board's cards.
  // computeJobTreeView REMOVES non-matching cards and any branch with no matching
  // descendant (vs. just dimming) and reflows, composing with expand/collapse.
  const applyCardFilters = useCallback(({ sourceFilter: sf, scoreThreshold: st, showReviewCards: rc } = {}) => {
    const base = hubCardFilter({ sourceFilter: data.sourceFilter, scoreThreshold: data.scoreThreshold, showReviewCards: data.showReviewCards });
    const filter = {
      sourceFilter: sf !== undefined ? sf : base.sourceFilter,
      scoreThreshold: st !== undefined ? st : base.scoreThreshold,
      showReviewCards: rc !== undefined ? rc : base.showReviewCards,
    };
    setNodes((nodes) => computeJobTreeView(nodes, id, filter));
  }, [data.sourceFilter, data.scoreThreshold, data.showReviewCards, id, setNodes]);

  const toggleSourceFilter = useCallback((sourceId) => {
    const newFilter = (data.sourceFilter || null) === sourceId ? null : sourceId;
    updateGlobal(id, { sourceFilter: newFilter });
    applyCardFilters({ sourceFilter: newFilter });
    EventLogger.log(`[JobBoard] source filter ${newFilter || 'cleared'} id=${id}`);
  }, [data.sourceFilter, id, updateGlobal, applyCardFilters]);

  const setScoreThreshold = useCallback((val) => {
    updateGlobal(id, { scoreThreshold: val });
    applyCardFilters({ scoreThreshold: val });
    EventLogger.log(`[JobBoard] hiring-fit filter ≥${val}/100 id=${id}`);
  }, [id, updateGlobal, applyCardFilters]);

  // Review cards (unscored placeholders, and scores the evidence-gap rule
  // pulled from above the slider to below it) stay visible under the slider
  // by default; this switch hides them. Persisted like the other two knobs.
  const setShowReviewCards = useCallback((val) => {
    const show = val !== false;
    updateGlobal(id, { showReviewCards: show });
    applyCardFilters({ showReviewCards: show });
    EventLogger.log(`[JobBoard] review cards ${show ? 'shown' : 'hidden'} below the hiring-fit filter id=${id}`);
  }, [id, updateGlobal, applyCardFilters]);

  // Re-apply filters on mount — card opacities are stripped from save files — and whenever a card's official posting
  // turns closed or open again. Starts empty so a saved Board with closed cards applies the rule on load.
  const appliedClosedCardIds = useRef('');
  // Source pills count what they can show. The selected source keeps its pill so the filter can always be cleared.
  const openSourceCounts = useMemo(() => {
    const counts = { ...(data.finalSourceCounts || {}) };
    for (const [, source] of closedCardIds ? closedCardIds.split('\n').map(line => line.split('\t')) : []) {
      if (!Object.hasOwn(counts, source)) continue;
      counts[source] -= 1;
      if (counts[source] <= 0 && source !== data.sourceFilter) delete counts[source];
    }
    return counts;
  }, [closedCardIds, data.finalSourceCounts, data.sourceFilter]);
  useEffect(() => {
    if (data.stale) return; // stale → cascade is hidden; don't reveal it here
    const min = data.scoreRangeMin ?? 0;
    const hasFilter = data.sourceFilter || (data.scoreThreshold ?? min) > min || data.showReviewCards === false;
    const closedCardsChanged = closedCardIds !== appliedClosedCardIds.current;
    appliedClosedCardIds.current = closedCardIds;
    if (hasFilter) applyCardFilters({});
    else if (closedCardsChanged) {
      const filter = hubCardFilter({ sourceFilter: data.sourceFilter, scoreThreshold: data.scoreThreshold, showReviewCards: data.showReviewCards });
      setNodes(nodes => computeJobTreeView(nodes, id, filter, undefined, false, { keepUserLayout: true }));
    }
  }, [applyCardFilters, closedCardIds, data.scoreThreshold, data.scoreRangeMin, data.sourceFilter, data.showReviewCards, data.stale, id, setNodes]);

  // Hide every spawned card/group (results "disappear") without touching their
  // expand/collapse state, so the exact view can be restored later.
  const hideBoardChildren = useCallback(() => {
    setNodes((nodes) => {
      let changed = false;
      const next = nodes.map((n) => {
        if ((n.type === 'jobcard' || n.type === 'jobgroup') && n.data?.hubId === id && !n.hidden) {
          changed = true;
          return { ...n, hidden: true };
        }
        return n;
      });
      return changed ? next : nodes;
    });
  }, [id, setNodes]);

  // Re-reveal the cascade exactly as it was: computeJobTreeView derives `hidden`
  // from each group's preserved `data.expanded` × the active filter, so the prior
  // expand/collapse + filter view comes back intact.
  const showBoardChildren = useCallback(() => {
    setNodes((nodes) => computeJobTreeView(nodes, id, hubCardFilter({ sourceFilter: data.sourceFilter, scoreThreshold: data.scoreThreshold, showReviewCards: data.showReviewCards })));
  }, [id, setNodes, data.sourceFilter, data.scoreThreshold, data.showReviewCards]);

  // Use one guarded path for every place a changing connected Search can
  // supersede a prior Combine. This is deliberately imperative too: Combine
  // admission/pre-commit fences read the live canvas, not render-time inputs.
  const keepCompletedSnapshotDuringActiveSearch = useCallback(({
    boardData = {},
    completedModules: liveCompletedModules = [],
    connectedModules: liveConnectedModules = [],
  } = {}) => {
    if (!shouldKeepCompletedBoardSnapshotVisible({
      boardHubState: boardData.hubState,
      boardStale: !!boardData.stale,
      boardLocked: !!boardData.locked,
      combineSignature: boardData.combineSignature,
      completedModules: liveCompletedModules,
      connectedModules: liveConnectedModules,
    })) {
      visibleSnapshotRefreshLogKeyRef.current = null;
      return false;
    }
    const activeSearchIds = liveConnectedModules
      .filter(module => ACTIVE_SEARCH_STATES.has(module.hubState))
      .map(module => module.id)
      .sort()
      .join(',');
    const refreshLogKey = `${boardData.combineSignature}|${activeSearchIds}`;
    if (visibleSnapshotRefreshLogKeyRef.current !== refreshLogKey) {
      visibleSnapshotRefreshLogKeyRef.current = refreshLogKey;
      EventLogger.log(`[JobBoard] previous completed results remain visible while connected Search updates id=${id} sources=${activeSearchIds}`);
    }
    return true;
  }, [id]);

  // Detect connection/data drift vs. the last Combine. Topology changes and
  // terminal output changes make the cached board stale → hide results + prompt
  // re-combine. A connected Search that is still actively re-running keeps the
  // prior cascade visible until it reaches a terminal changed input. Restoring
  // the exact connections+data (e.g. re-adding the same edge with unchanged
  // jobs) clears staleness → results reappear, no re-combine or LLM call needed.
  // Old boards (no stored signature) adopt the current connections as their
  // baseline instead of falsely going stale.
  useEffect(() => {
    if (hubState !== 'done' || data.locked) return; // locked = frozen snapshot
    // A released flat-board build persisted direct cards with no taxonomy.
    // They were never successfully bucketed, so hide them after upgrade and
    // require one successful API-backed Re-combine to restore board results.
    // (Locked boards remain historical snapshots by design.)
    if (isLegacyUnbucketedJobBoard(data, getNodes(), id)) {
      const legacyReason = 'This legacy board was never taxonomized — re-combine successfully to restore results';
      hideBoardChildren();
      if (!data.stale || data.staleReason !== legacyReason) {
        updateGlobal(id, { stale: true, staleReason: legacyReason });
        EventLogger.log(`[JobBoard] hid legacy unbucketed results id=${id}`);
      }
      return;
    }
    // No stored signature (pre-staleness boards) OR a signature in the legacy
    // pre-versioned fingerprint format (its math can't be compared against
    // live fingerprints) → adopt the current connections as the baseline
    // instead of falsely going stale.
    if (data.combineSignature == null || isLegacyCombineSignature(data.combineSignature)) {
      updateGlobal(id, { combineSignature: liveSignature, stale: false, staleReason: null });
      return;
    }
    // Listings arrive all the time while a search runs, so a Board is often a
    // little behind what it holds. That is not a reason to hide its cards: it
    // rebuilds itself (see the intake effects) and the cards stay on screen.
    if (JOB_BOARD_STREAM_RUN_PREFIX) {
      if (data.stale) {
        updateGlobal(id, { stale: false, staleReason: null });
        showBoardChildren();
        EventLogger.log(`[JobBoard] results kept visible while new listings arrive id=${id}`);
      }
      return;
    }
    if (keepCompletedSnapshotDuringActiveSearch({
      boardData: data,
      completedModules,
      connectedModules,
    })) {
      return;
    }
    const nextStale = liveSignature !== data.combineSignature;
    const nextStaleReason = nextStale ? staleReason(data.combineSignature, completedModules, connectedModules) : null;
    if (nextStale === !!data.stale) {
      // A stale marker can be persisted independently from a child `hidden`
      // update (or arrive from an older file). Reconcile it on mount too. The
      // helper returns the original nodes array when every child is already
      // hidden, so this is idempotent and does not churn the canvas store.
      if (nextStale) hideBoardChildren();
      // A re-run first leaves `done`, then returns to it. Keep the persisted
      // reason current when that terminal result arrives (especially zero),
      // rather than preserving an earlier transient "updating" label.
      if (nextStale && data.staleReason !== nextStaleReason) {
        updateGlobal(id, { staleReason: nextStaleReason });
        EventLogger.log(`[JobBoard] stale inputs updated id=${id} reason=${nextStaleReason}`);
      }
      return;
    }
    updateGlobal(id, { stale: nextStale, staleReason: nextStaleReason });
    if (nextStale) {
      hideBoardChildren();
      // Do not read staleReasonText here: state has not yet committed, so that
      // render intentionally sees stale=false and would log a blank reason.
      EventLogger.log(`[JobBoard] results hidden as stale id=${id} reason=${nextStaleReason}`);
    } else {
      showBoardChildren();
      EventLogger.log(`[JobBoard] results restored after stale state cleared id=${id}`);
    }
  }, [hubState, data, data.locked, liveSignature, data.combineSignature, data.stale, data.staleReason, completedModules, connectedModules, id, getNodes, updateGlobal, hideBoardChildren, showBoardChildren, keepCompletedSnapshotDuringActiveSearch]);

  // Cascade-delete the board's spawned cards/groups (re-combine, clear, unmount).
  const clearBoardChildren = useCallback(({ preserveNodeIds = [] } = {}) => {
    return deleteChildrenByHubId({
      getNodes, getEdges, deleteElements, hubId: id, childTypes: ['jobcard', 'jobgroup'],
      displayReplacement: true,
      preserveNodeIds,
      // The compact row is registered before React Flow settles deletion, so
      // describe the exact requested scope rather than claiming every removal
      // succeeded. Ordinary deletions remain itemized by EventLogger.
      removalLogSummary: `[JobBoard] child cascade requested id=${id}`,
    });
  }, [id, getNodes, getEdges, deleteElements]);

  const requestEmptyReplacement = useCallback(() => {
    const owned = getNodes().filter((node) =>
      (node.type === 'jobcard' || node.type === 'jobgroup') && node.data?.hubId === id
    );
    const resultCardCount = owned.filter((node) => node.type === 'jobcard').length;
    const resultGroupCount = owned.filter((node) => node.type === 'jobgroup').length;
    setEmptyReplacementPrompt({ resultCardCount, resultGroupCount });
    EventLogger.log(`[JobBoard] empty replacement confirmation requested id=${id} cards=${resultCardCount} groups=${resultGroupCount}`);
  }, [getNodes, id]);

  const cancelEmptyReplacement = useCallback(() => {
    const prompt = emptyReplacementPrompt;
    EventLogger.log(`[JobBoard] empty replacement cancelled id=${id} cards=${prompt?.resultCardCount ?? 0} groups=${prompt?.resultGroupCount ?? 0}`);
    setEmptyReplacementPrompt(null);
  }, [emptyReplacementPrompt, id]);

  const confirmEmptyReplacement = useCallback(() => {
    setEmptyReplacementPrompt(null);
    // The Board or its inputs may have changed while the modal was open. Read
    // the imperative graph at the click boundary: a stale render must never
    // mutate a newly locked/running snapshot or clear results after a Search
    // became positive/nonterminal again.
    const liveBoard = getNode(id);
    const liveBoardData = liveBoard?.data || {};
    if (
      !liveBoard
      || liveBoardData.locked
      || isJobWorkflowDeletionPending(id)
      || scanRunRef.current
      || combineRunRef.current
      || liveBoardData.boardScanResume
      || liveBoardData.manualAiResume
      || liveBoardData.boardCancellation
    ) {
      EventLogger.log(`[JobBoard] empty replacement confirmation ignored because the Board is no longer mutable id=${id}`);
      return;
    }
    const liveInputs = liveCombineInputs(id, getNodes(), getEdges());
    const liveAllConnectedDone = liveInputs.all.length > 0
      && liveInputs.settled.length === liveInputs.all.length;
    const liveInputSignature = boardInputSignature(liveInputs.completed, liveInputs.all);
    const liveStale = liveBoardData.hubState === 'done' && (
      isLegacyUnbucketedJobBoard(liveBoardData, getNodes(), id)
      || (
        typeof liveBoardData.combineSignature === 'string'
        && liveBoardData.combineSignature !== liveInputSignature
      )
    );
    const liveBlockReason = emptyReplacementIneligibilityReason({
      stale: liveStale,
      allConnectedModulesDone: liveAllConnectedDone,
      readyModuleCount: liveInputs.ready.length,
    });
    if (liveBlockReason) {
      EventLogger.log(`[JobBoard] empty replacement confirmation ignored id=${id} reason=${liveBlockReason}`);
      return;
    }
    document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
    // A card tied to an application outlives its listing, as it does in Combine.
    const applicationCardIds = getNodes().filter(node => node?.data?.hubId === id && isProtectedJobCard(node)).map(node => node.id);
    clearBoardChildren({ preserveNodeIds: applicationCardIds });
    const perModule = liveInputs.completed.map((m) => ({ label: m.label, count: 0, sourceCount: m.count }));
    updateGlobal(id, {
      hubState: 'done', resultCount: applicationCardIds.length, moduleCount: liveInputs.completed.length,
      scoreThreshold: 0, scoreRangeMin: 0, scoreRangeMax: 100,
      sourceFilter: null, jobTaxonomy: null, finalSourceCounts: {},
      mergeStats: {
        totalIncoming: 0, unique: 0, duplicatesRemoved: 0,
        collisions: 0, collisionUpgrades: 0, collisionAssessmentUpgrades: 0, modules: liveInputs.completed.length, perModule,
      },
      combineSignature: liveInputSignature,
      combineSourceRuns: boundedCombinedSourceRuns(liveInputs.completed),
      stale: false, staleReason: null,
      clearProvenance: null,
    });
    EventLogger.log(`[JobBoard] confirmed empty replacement id=${id} modules=${liveInputs.completed.length}`);
    addToast({ title: 'Board updated', description: 'The completed searches have no current jobs; old results were cleared. Undo restores them.', type: 'info' });
  }, [addToast, clearBoardChildren, getEdges, getNode, getNodes, id, updateGlobal]);

  const cancelActiveSearchModule = useCallback((reason, { allowStale = false, sourceIds: requestedSourceIds = null } = {}) => {
    const liveBoardData = getNode(id)?.data || data;
    const durablePlan = liveBoardData.boardScanResume || data.boardScanResume;
    const durableCancellation = liveBoardData.boardCancellation || data.boardCancellation || null;
    const sourceIds = new Set((Array.isArray(requestedSourceIds) && requestedSourceIds.length > 0
      ? requestedSourceIds
      : [
      ...activeSearchModuleIdsRef.current,
      activeSearchModuleIdRef.current,
      ...(durablePlan?.phase === 'searches' && Array.isArray(durablePlan.activeSourceIds)
        ? durablePlan.activeSourceIds
        : []),
      durablePlan?.phase === 'searches' ? durablePlan.activeSourceId : null,
      ...(Array.isArray(durableCancellation?.sourceIds) ? durableCancellation.sourceIds : []),
      durableCancellation?.sourceId,
      ]).filter(Boolean));
    const boardRunId = activeBoardRunIdRef.current
      || durablePlan?.boardRunId
      || durableCancellation?.boardRunId
      || null;
    if (Array.isArray(requestedSourceIds) && requestedSourceIds.length > 0) {
      requestedSourceIds.forEach(sourceId => activeSearchModuleIdsRef.current.delete(sourceId));
      if (requestedSourceIds.includes(activeSearchModuleIdRef.current)) {
        activeSearchModuleIdRef.current = activeSearchModuleIdsRef.current.values().next().value || null;
      }
    } else {
      activeSearchModuleIdRef.current = null;
      activeSearchModuleIdsRef.current.clear();
      activeBoardRunIdRef.current = null;
    }
    if (sourceIds.size === 0 || !boardRunId) return Promise.resolve({ status: 'none', cancelled: false });

    // The registered worker verifies both identities before rolling back, so a
    // late cleanup from an old Board run cannot abort a newer turn on the same
    // Job Search module. The raw node abort is only a compatibility fallback
    // for a source that unmounted before exposing its cancellation handler.
    const cancelOne = (sourceId) => jobSearchCoordinator.cancelSearchModule(sourceId, {
      orchestratorNodeId: id,
      boardRunId,
      reason,
      // A recovered child with no in-memory control performs disk cleanup. If
      // this Board already owns the outer job-search lease, that cleanup must
      // execute inside the turn instead of queueing a nested lease behind itself.
      queueManagedExternally: !!scanLaneLeaseOwnerRef.current,
      // Component unmount can remove the Board from React Flow before the
      // surviving Search validates this exact persisted cancellation claim.
      durablePlanOverride: durablePlan || (durableCancellation?.sourceId ? {
        version: 1,
        boardRunId,
        phase: 'searches',
        activeSourceId: durableCancellation.sourceId,
        selectedSearchModuleIds: [durableCancellation.sourceId],
        cancellationCleanup: durableCancellation.childCleanup || null,
      } : null),
    }).then((result) => {
      if (result?.cancelled !== true) {
        if (allowStale && result?.status === 'stale') return result;
        throw new Error('The active Job Search cancellation did not retain exact Board ownership.');
      }
      return result;
    }).catch((error) => {
      // A hub-scoped raw abort cannot distinguish two Boards sharing a Search.
      // Use it only when the source no longer exists anywhere on this active
      // canvas; an identity mismatch/stale response must never abort its owner.
      const sourceExistsAnywhere = nav?.enumerateAllNodes?.().some(node => node?.id === sourceId);
      if (error?.code === 'JOB_SEARCH_MODULE_UNAVAILABLE' && !sourceExistsAnywhere) {
        return (async () => {
          if (!window.electronAPI?.cancelNodeTaskAndWait) {
            throw new Error('Acknowledged Job Search cancellation is unavailable.');
          }
          const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(sourceId, reason);
          if (acknowledgement?.settled !== true) {
            throw new Error('The removed Job Search did not finish cancelling before the safety timeout.');
          }
          if (!canvasFilePath || !window.electronAPI?.peekJobRun) {
            return { status: 'cancelled', cancelled: true, fallback: true };
          }
          const info = await window.electronAPI.peekJobRun({ canvasFilePath, nodeId: sourceId });
          if (info?.success === false) {
            throw new Error(info.error || 'Could not inspect the removed Job Search recovery files.');
          }
          if (info?.found && info.nodeId === sourceId && info.runId) {
            // A removed renderer cannot safely reconstruct the exact durable
            // authority receipt.  Do not fall back to global/receiptless
            // deletion: leave the sealed recovery for an explicit Clear or a
            // mounted owner retry rather than risking another generation.
            throw new Error('The removed Job Search recovery needs its exact cancellation receipt; it was kept safely.');
          }
          return { status: 'cancelled', cancelled: true, fallback: true };
        })();
      }
      throw error;
    });
    // Each child writes its exact cleanup receipt into the Board plan.  Keep
    // those writes ordered: a Promise.all here would let two cancellations
    // race the legacy singular `cancellationCleanup` bridge during upgrade.
    return cancelJobBoardChildrenSequentially([...sourceIds], cancelOne).then((results) => (
      results.length === 1 ? results[0].value : { status: 'cancelled', cancelled: true, results }
    ));
  }, [canvasFilePath, data, getNode, id, jobSearchCoordinator, nav]);

  // An edge removal is an ownership event, not just a readiness change. Abort
  // the exact Board child immediately so a browser/manual-AI await cannot keep
  // the shared lane forever. The durable plan is intentionally left in place
  // until the child confirms its source/data rollback to the awaiting scan.
  useEffect(() => {
    const plan = getNode(id)?.data?.boardScanResume || null;
    const activeSourceIds = [...new Set([
      ...activeSearchModuleIdsRef.current,
      ...(Array.isArray(plan?.activeSourceIds) ? plan.activeSourceIds : []),
      plan?.activeSourceId,
    ].filter(Boolean))];
    // A fan-out can have several independent children parked at handoffs.
    // Removing one edge must cancel only that exact child; invalidating the
    // Board epoch here would also abort its still-connected siblings.
    if (activeSourceIds.length > 1) {
      const disconnectedSourceId = activeSourceIds.find((candidateId) => !getEdges().some(edge => (
        (edge.source === id && edge.target === candidateId)
        || (edge.target === id && edge.source === candidateId)
      )));
      if (disconnectedSourceId) {
        const boardRunId = activeBoardRunIdRef.current || plan?.boardRunId || null;
        if (!boardRunId) return;
        const cancellationKey = `${boardRunId}:${disconnectedSourceId}`;
        if (disconnectCancellationRef.current === cancellationKey) return;
        disconnectCancellationRef.current = cancellationKey;
        EventLogger.log(`[JobBoard] fanned-out Search disconnected; cancelling exact child id=${id} run=${boardRunId} source=${disconnectedSourceId}`);
        void cancelActiveSearchModule('job-board-search-disconnected', {
          sourceIds: [disconnectedSourceId],
        }).then(async () => {
          activeSearchManualAiRunIdsRef.current.delete(disconnectedSourceId);
          updateGlobal(id, (node) => {
            const livePlan = node?.data?.boardScanResume;
            if (livePlan?.boardRunId !== boardRunId) return null;
            const cancellationCleanupsBySource = {
              ...(livePlan.cancellationCleanupsBySource || {}),
            };
            delete cancellationCleanupsBySource[disconnectedSourceId];
            // Keep the singular field only as a compatibility bridge to one
            // remaining exact child receipt. It must never merge run ids or
            // metadata from two fanned-out children.
            const remainingCleanup = Object.values(cancellationCleanupsBySource)[0] || null;
            const promoted = promoteJobBoardPausedSourceResolution({
              awaitingSourceResolutions: livePlan.awaitingSourceResolutions
                || [livePlan.awaitingSourceResolution].filter(Boolean),
              activeSourceId: livePlan.activeSourceId,
              activeSourceIds: livePlan.activeSourceIds
                || [livePlan.activeSourceId].filter(Boolean),
              activeSourceRollbacks: livePlan.activeSourceRollbacks || {},
              activeSourceManualAiRunIds: livePlan.activeSourceManualAiRunIds || {},
              consumedSourceId: disconnectedSourceId,
            });
            return {
              boardScanResume: {
                ...livePlan,
                ...promoted,
                cancellationCleanupsBySource,
                cancellationCleanup: remainingCleanup,
                updatedAt: Date.now(),
              },
            };
          });
          const committed = await waitForBoardPlanCommit({
            getNode,
            nodeId: id,
            boardRunId,
            matches: nextPlan => nextPlan.phase === 'searches'
              && !nextPlan.activeSourceIds?.includes(disconnectedSourceId)
              && !nextPlan.cancellationCleanupsBySource?.[disconnectedSourceId]
              && nextPlan.cancellationCleanup?.sourceId !== disconnectedSourceId,
          });
          if (!committed) {
            throw new Error('The disconnected Job Search cleanup receipt was not retired from the Board plan.');
          }
        }).catch((error) => {
          EventLogger.error(`[JobBoard] fanned-out child cancellation failed id=${id} run=${boardRunId} source=${disconnectedSourceId}:`, error);
          setRecoveryError(error?.message || 'The disconnected Job Search could not be rolled back. Retry or cancel this Board run.');
        });
        return;
      }
    }
    const sourceId = activeSearchModuleIdRef.current
      || (plan?.phase === 'searches' ? plan.activeSourceId : null);
    const boardRunId = activeBoardRunIdRef.current || plan?.boardRunId || null;
    if (!sourceId || !boardRunId) {
      disconnectCancellationRef.current = null;
      return;
    }
    const connected = getEdges().some(edge => (
      (edge.source === id && edge.target === sourceId)
      || (edge.target === id && edge.source === sourceId)
    ));
    if (connected) {
      disconnectCancellationRef.current = null;
      return;
    }
    const cancellationKey = `${boardRunId}:${sourceId}`;
    if (disconnectCancellationRef.current === cancellationKey) return;
    disconnectCancellationRef.current = cancellationKey;
    const ownsOuterLane = !!scanLaneLeaseOwnerRef.current;
    // Stop the scan loop regardless of whether its outer lease has started. If
    // exact child cleanup fails, the loop must not continue and overwrite the
    // durable cancellationCleanup receipt as an ordinary incomplete search.
    epoch.bump();
    if (!ownsOuterLane) {
      // If this recovered Board is only queued, remove its outer entry before
      // the Search acquires a safety lease for disk cleanup. Otherwise the
      // cancellation entry sits behind the Board entry that awaits it.
      moduleRunQueue.cancelQueuedRunsForNode(id, 'Connected Job Search was removed');
    }
    EventLogger.log(
      `[JobBoard] active Search disconnected; cancelling exact child id=${id} run=${boardRunId} source=${sourceId}`,
    );
    void cancelActiveSearchModule('job-board-search-disconnected')
      .then(() => {
        const livePlan = getNode(id)?.data?.boardScanResume;
        if (
          livePlan?.boardRunId !== boardRunId
          || livePlan?.activeSourceId !== sourceId
        ) return;
        updateGlobal(id, { boardScanResume: null, queuedModuleRun: null });
        // This exact cancellation owns the now-cleared plan. Clear any stale
        // paused-source error queued by the same edge-removal commit; genuine
        // cancellation failures take the catch path below and remain visible.
        setRecoveryError(null);
      })
      .catch((error) => {
        EventLogger.error(
          `[JobBoard] disconnected child cancellation failed id=${id} run=${boardRunId} source=${sourceId}:`,
          error,
        );
        setRecoveryError(error?.message || 'The disconnected Job Search could not be rolled back. Retry or cancel this Board run.');
      });
  }, [boardRecoverySig, cancelActiveSearchModule, connectedSig, epoch, getEdges, getNode, id, moduleRunQueue, updateGlobal]);

  const persistBoardCancellationIntent = useCallback(async (reason) => {
    const liveData = getNode(id)?.data || data || {};
    const existing = liveData.boardCancellation;
    const plan = liveData.boardScanResume || null;
    const activeCombineRunId = activeCombineManualAiRunRef.current?.runId || null;
    const manualAiRunIds = [...new Set([
      ...(Array.isArray(existing?.manualAiRunIds) ? existing.manualAiRunIds : []),
      activeCombineRunId,
      liveData.manualAiResume?.runId,
      plan?.combineManualAiRunId,
    ].filter(isBoardCombineManualAiRunId))];
    const boardRunId = [activeBoardRunIdRef.current, plan?.boardRunId,
      existing?.boardRunId, activeCombineRunId, liveData.manualAiResume?.runId]
      .find(isBoardCombineManualAiRunId) || null;
    const sourceIds = [...new Set([
      ...activeSearchModuleIdsRef.current,
      activeSearchModuleIdRef.current,
      ...(plan?.phase === 'searches' && Array.isArray(plan.activeSourceIds)
        ? plan.activeSourceIds
        : []),
      plan?.phase === 'searches' ? plan.activeSourceId : null,
      ...(Array.isArray(existing?.sourceIds) ? existing.sourceIds : []),
      existing?.sourceId,
    ].filter(Boolean))];
    const sourceId = sourceIds[0] || null;
    if (!boardRunId && !sourceId && manualAiRunIds.length === 0) return null;

    const operationId = existing?.operationId
      || createPrefixedManualAiRunId('job-board-cancel', id);
    // Do not coerce a malformed/null persisted timestamp to epoch zero: that
    // would make this cancellation artificially outrank every real legacy
    // transaction in timestamp-based recovery arbitration.
    const existingStartedAt = normalizeJobBoardRecoveryTimestamp(existing?.startedAt);
    const planStartedAt = normalizeJobBoardRecoveryTimestamp(plan?.startedAt);
    const receipt = {
      version: 1,
      operationId,
      boardRunId,
      sourceId,
      sourceIds,
      manualAiRunIds,
      childCleanup: plan?.cancellationCleanup || existing?.childCleanup || null,
      reason: reason || existing?.reason || 'board-run-cancelled',
      // Legacy receipts have no admissionOrder. Keep the scan's original
      // timestamp when converting that plan into cancellation-only ownership
      // so recovery does not make an older transaction appear newly admitted.
      startedAt: existingStartedAt ?? planStartedAt ?? Date.now(),
      // A cancellation can outlive the scan plan that allocated this turn.
      // Carry its immutable admission sequence into the receipt so recovery
      // arbitration does not fall back to a tied timestamp/canvas order while
      // exact child cleanup is still reserving the Search.
      admissionOrder: normalizeJobBoardAdmissionOrder(plan?.admissionOrder)
        ?? normalizeJobBoardAdmissionOrder(existing?.admissionOrder),
      updatedAt: Date.now(),
    };
    updateGlobal(id, { boardCancellation: receipt });

    // The cancellation receipt is what prevents reload from resuming work the
    // user explicitly stopped. Make it observable before the first abort await.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await waitForBoardRendererCommitFrame();
      const current = getNode(id);
      if (!current || current.data?.boardCancellation?.operationId === operationId) return receipt;
    }
    throw new Error('The Job Board cancellation intent was not committed to the canvas.');
  }, [data, getNode, id, updateGlobal]);

  const retireActiveCombineManualAiRun = useCallback(async (
    expectedRunId = null,
    retirementReason = 'cancelled',
    receiptOverride = null,
  ) => {
    if (expectedRunId && !isBoardCombineManualAiRunId(expectedRunId)) return true;
    const active = activeCombineManualAiRunRef.current;
    const liveDataAtRetirement = getNode(id)?.data || {};
    const persistedRunId = liveDataAtRetirement.manualAiResume?.runId || null;
    const planRunId = liveDataAtRetirement.boardScanResume?.combineManualAiRunId || null;
    const cancellationRunIds = new Set(
      Array.isArray(liveDataAtRetirement.boardCancellation?.manualAiRunIds)
        ? liveDataAtRetirement.boardCancellation.manualAiRunIds
        : [],
    );
    // A dialog cancellation is correlated to the exact run that owned its
    // request. If an older notification arrives after a new Combine starts on
    // this same Board, retire only the old run and leave the new owner intact.
    const runIds = expectedRunId
      ? new Set([expectedRunId])
      : new Set([active?.runId, persistedRunId].filter(isBoardCombineManualAiRunId));
    const persistedMarker = liveDataAtRetirement.manualAiResume || null;
    const cleanupReceiptsByRunId = new Map(
      normalizeManualAiCleanupReceipts(liveDataAtRetirement.manualAiCleanupReceipts)
        .map(receipt => [receipt.runId, receipt]),
    );
    const retirementReceipts = new Map([...runIds].map((runId) => {
      const activeMatches = active?.runId === runId;
      const persistedMatches = persistedMarker?.runId === runId;
      const cleanupReceipt = cleanupReceiptsByRunId.get(runId) || null;
      const suppliedReceipt = receiptOverride?.runId === runId ? receiptOverride : null;
      return [runId, {
        ...(cleanupReceipt || {}),
        ...(suppliedReceipt || {}),
        runId,
        task: persistedMatches ? persistedMarker.task || null : suppliedReceipt?.task || cleanupReceipt?.task || null,
        stepKey: persistedMatches ? persistedMarker.stepKey || null : suppliedReceipt?.stepKey || cleanupReceipt?.stepKey || null,
        recoveryMode: persistedMatches
          ? persistedMarker.recoveryMode || null
          : suppliedReceipt?.recoveryMode || cleanupReceipt?.recoveryMode || null,
        combineInputSignature: activeMatches
          ? active.combineInputSignature || combineInputSignaturesRef.current.get(runId) || null
          : persistedMatches
            ? persistedMarker.combineInputSignature || null
            : combineInputSignaturesRef.current.get(runId) || null,
        combineSourceRuns: activeMatches
          ? active.combineSourceRuns || combineSourceRunsRef.current.get(runId) || null
          : persistedMatches
            ? persistedMarker.combineSourceRuns || null
            : combineSourceRunsRef.current.get(runId) || null,
        startedAt: activeMatches
          ? active.startedAt || null
          : persistedMatches
            ? persistedMarker.startedAt ?? persistedMarker.updatedAt ?? null
            : null,
      }];
    }));
    if (!expectedRunId || active?.runId === expectedRunId) {
      activeCombineManualAiRunRef.current = null;
    }
    const retirements = [...runIds].map(async (runId) => {
      const belongsToCurrentTransaction = cancellationRunIds.has(runId)
        || (active?.runId
          ? active.runId === runId
          : liveDataAtRetirement.boardScanResume?.boardRunId
            ? planRunId === runId
            : persistedRunId === runId);
      const storeAsSupersededCleanup = !!expectedRunId && !belongsToCurrentTransaction;
      try {
        if (!window.electronAPI?.completeNonApiAiRun) {
          throw new Error('Durable manual-AI cleanup is unavailable.');
        }
        const result = await window.electronAPI.completeNonApiAiRun(runId);
        if (result?.cleared !== true && result?.absent !== true) {
          throw new Error('The saved manual-AI handoff could not be retired.');
        }
        updateGlobal(id, (node) => {
          const retirementReceipt = retirementReceipts.get(runId) || {};
          const nextReceipts = removeManualAiCleanupReceipt(
            node?.data?.manualAiCleanupReceipts,
            runId,
          );
          const clearsMarker = node?.data?.manualAiResume?.runId === runId;
          const retryPlan = node?.data?.boardScanResume;
          const releasesRetryPlan = retirementReceipt.retryCombineAfterRetirement === true
            && retryPlan?.phase === 'combine'
            && retryPlan.combineManualAiRunId === runId;
          if (!clearsMarker
            && !releasesRetryPlan
            && nextReceipts.length === normalizeManualAiCleanupReceipts(
              node?.data?.manualAiCleanupReceipts,
            ).length) return null;
          return {
            ...(clearsMarker ? { manualAiResume: null } : {}),
            ...(releasesRetryPlan ? {
              // This manual response was consumed before the Board crossed its
              // visible commit boundary (for example, it was locked while the
              // provider was running). Retire that token, but keep the exact
              // Combine receipt and force its retry to mint a fresh run id.
              boardScanResume: {
                ...retryPlan,
                combineManualAiRunId: null,
                updatedAt: Date.now(),
              },
            } : {}),
            manualAiCleanupReceipts: nextReceipts.length > 0 ? nextReceipts : null,
          };
        });
        // A pending event can commit in the same turn as durable retirement.
        // Do not release cancellation/completion ownership until the exact old
        // marker is visibly absent; the mount-local tombstone handles any event
        // delivered after this point.
        let cleanupRemovalCommitted = false;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await waitForBoardRendererCommitFrame();
          const currentData = getNode(id)?.data || {};
          const markerRemoved = currentData.manualAiResume?.runId !== runId;
          const receiptRemoved = !normalizeManualAiCleanupReceipts(
            currentData.manualAiCleanupReceipts,
          ).some(receipt => receipt.runId === runId);
          const retryPlanReleased = retirementReceipts.get(runId)?.retryCombineAfterRetirement !== true
            || currentData.boardScanResume?.combineManualAiRunId !== runId;
          if (markerRemoved && receiptRemoved && retryPlanReleased) {
            cleanupRemovalCommitted = true;
            break;
          }
        }
        if (!cleanupRemovalCommitted) {
          throw new Error('The Job Board manual-AI cleanup result was not committed to the canvas.');
        }
        // Publish the mount-local tombstone only after the durable canvas no
        // longer contains a replayable marker. If renderer reconciliation is
        // delayed, the catch path restores a cleanup-only receipt and a reload
        // can safely retry the already-idempotent backend completion.
        rememberBoundedRunId(retiredCombineManualAiRunIdsRef.current, runId);
        combineInputSignaturesRef.current.delete(runId);
        combineSourceRunsRef.current.delete(runId);
        pendingCombineManualAiRunIdsRef.current.delete(runId);
      } catch (error) {
        updateGlobal(id, (node) => {
          const marker = node?.data?.manualAiResume;
          const receipt = retirementReceipts.get(runId) || { runId };
          const retryReceipt = {
            ...receipt,
            runId,
            retirementPending: true,
            retirementReason,
            updatedAt: Date.now(),
          };
          if (storeAsSupersededCleanup || (marker?.runId && marker.runId !== runId)) {
            return {
              ...(marker?.runId === runId ? { manualAiResume: null } : {}),
              manualAiCleanupReceipts: upsertManualAiCleanupReceipt(
                node?.data?.manualAiCleanupReceipts,
                retryReceipt,
              ),
            };
          }
          return {
            manualAiResume: {
              ...receipt,
              ...(marker || {}),
              runId,
              retirementPending: true,
              retirementReason,
              updatedAt: Date.now(),
            },
          };
        });
        // Keep the owning queue turn until the failed cleanup's exact receipt
        // is observable. Otherwise a newer Combine can replace the single
        // marker before this rejection is recorded.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await waitForBoardRendererCommitFrame();
          const liveData = getNode(id)?.data || {};
          const marker = liveData.manualAiResume;
          const cleanupReceipt = normalizeManualAiCleanupReceipts(
            liveData.manualAiCleanupReceipts,
          ).find(receipt => receipt.runId === runId);
          if (
            (marker?.runId === runId && marker.retirementPending)
            || cleanupReceipt?.retirementPending
          ) break;
        }
        throw error;
      }
    });
    await Promise.all(retirements);
    return true;
  }, [getNode, id, updateGlobal]);

  const persistAcknowledgedBoardManualAiRunIds = useCallback(async (
    discoveredRunIds,
    retirementReason,
  ) => {
    const runIds = [...new Set(
      (Array.isArray(discoveredRunIds) ? discoveredRunIds : [])
        .filter(isBoardCombineManualAiRunId),
    )];
    if (runIds.length === 0) return true;
    for (const runId of runIds) {
      attemptedSupersededCleanupRunIdsRef.current.add(runId);
    }
    updateGlobal(id, (node) => {
      const cancellation = node?.data?.boardCancellation || null;
      if (cancellation?.operationId) {
        return {
          boardCancellation: {
            ...cancellation,
            manualAiRunIds: [...new Set([
              ...(Array.isArray(cancellation.manualAiRunIds)
                ? cancellation.manualAiRunIds
                : []),
              ...runIds,
            ])],
            updatedAt: Date.now(),
          },
        };
      }
      let nextMarker = node?.data?.manualAiResume || null;
      let nextReceipts = normalizeManualAiCleanupReceipts(
        node?.data?.manualAiCleanupReceipts,
      );
      for (const runId of runIds) {
        const existingDescriptor = nextMarker?.runId === runId
          ? nextMarker
          : nextReceipts.find(receipt => receipt.runId === runId) || {};
        const receipt = {
          ...existingDescriptor,
          runId,
          retirementPending: true,
          retirementReason,
          cancellationPending: false,
          cancellationReason: retirementReason,
          updatedAt: Date.now(),
        };
        if (nextMarker?.runId === runId) {
          nextMarker = receipt;
          nextReceipts = removeManualAiCleanupReceipt(nextReceipts, runId);
        } else {
          nextReceipts = upsertManualAiCleanupReceipt(nextReceipts, receipt);
        }
      }
      return {
        manualAiResume: nextMarker,
        manualAiCleanupReceipts: nextReceipts.length > 0 ? nextReceipts : null,
      };
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await waitForBoardRendererCommitFrame();
      const liveData = getNode(id)?.data || {};
      const cancellationRunIds = new Set(
        Array.isArray(liveData.boardCancellation?.manualAiRunIds)
          ? liveData.boardCancellation.manualAiRunIds
          : [],
      );
      const cleanupReceipts = normalizeManualAiCleanupReceipts(
        liveData.manualAiCleanupReceipts,
      );
      const allCommitted = runIds.every(runId => (
        cancellationRunIds.has(runId)
        || (liveData.manualAiResume?.runId === runId
          && liveData.manualAiResume.retirementPending)
        || cleanupReceipts.some(receipt => (
          receipt.runId === runId && receipt.retirementPending
        ))
      ));
      if (allCommitted) return true;
    }
    throw new Error('The acknowledged Job Board manual-AI cleanup receipts were not committed.');
  }, [getNode, id, updateGlobal]);

  const retireBoardCleanupReceipt = useCallback(async (receipt) => {
    if (!isBoardCombineManualAiRunId(receipt?.runId)) return true;
    const retirementReason = receipt.retirementReason || 'superseded-cleanup';
    const runIds = new Set([receipt.runId]);
    if (receipt.cancellationPending === true) {
      if (!window.electronAPI?.cancelNodeTaskAndWait) {
        window.electronAPI?.cancelNodeTask?.(
          id,
          receipt.cancellationReason || retirementReason,
        );
        throw new Error('Acknowledged Job Board cancellation is unavailable.');
      }
      const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(
        id,
        receipt.cancellationReason || retirementReason,
      );
      if (acknowledgement?.settled !== true) {
        throw new Error('The Job Board did not finish cancelling before the safety timeout.');
      }
      for (const runId of acknowledgement?.manualAiRunIds || []) {
        if (isBoardCombineManualAiRunId(runId)) runIds.add(runId);
      }
      await persistAcknowledgedBoardManualAiRunIds(
        [...runIds],
        receipt.cancellationReason || retirementReason,
      );
    }
    await Promise.all([...runIds].map(runId => retireActiveCombineManualAiRun(
      runId,
      retirementReason,
      runId === receipt.runId
        ? receipt
        : { runId, retirementPending: true, retirementReason },
    )));
    return true;
  }, [id, persistAcknowledgedBoardManualAiRunIds, retireActiveCombineManualAiRun]);

  const cancelBoardTaskAndRetireManualAi = useCallback(async (reason) => {
    const liveData = getNode(id)?.data || {};
    const runIds = new Set([
      activeCombineManualAiRunRef.current?.runId,
      liveData.manualAiResume?.runId,
      liveData.boardScanResume?.combineManualAiRunId,
      ...(Array.isArray(liveData.boardCancellation?.manualAiRunIds)
        ? liveData.boardCancellation.manualAiRunIds
        : []),
      ...normalizeManualAiCleanupReceipts(liveData.manualAiCleanupReceipts)
        .map(receipt => receipt.runId),
    ].filter(isBoardCombineManualAiRunId));
    if (!window.electronAPI?.cancelNodeTaskAndWait) {
      window.electronAPI?.cancelNodeTask?.(id, reason);
      throw new Error('Acknowledged Job Board cancellation is unavailable.');
    }
    const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(id, reason);
    if (acknowledgement?.settled !== true) {
      throw new Error('The Job Board did not finish cancelling before the safety timeout.');
    }
    for (const runId of acknowledgement?.manualAiRunIds || []) {
      if (isBoardCombineManualAiRunId(runId)) runIds.add(runId);
    }
    await persistAcknowledgedBoardManualAiRunIds([...runIds], reason);
    await Promise.all([...runIds].map(runId => (
      retireActiveCombineManualAiRun(runId, reason)
    )));
    return acknowledgement;
  }, [getNode, id, persistAcknowledgedBoardManualAiRunIds, retireActiveCombineManualAiRun]);

  const cleanupBoard = useCallback(() => {
    if (isJobWorkflowDeletionPending(id)) {
      EventLogger.log(`[JobBoard] Unmount cleanup deferred to pending deletion transaction id=${id}`);
      return;
    }
    if (isJobWorkflowRelocationPending(id)) {
      EventLogger.log(`[JobBoard] Unmount cleanup deferred to pending relocation transaction id=${id}`);
      return;
    }
    if ((officialPostingRefreshRunRef.current || getOfficialPostingPreparation(canvasFilePath, id)?.owner === 'board-refresh')
      && nav?.getCurrentFile?.() === canvasFilePath
      && nav?.enumerateAllNodes?.().some(node => node.id === id && node.type === 'jobboard')) {
      EventLogger.log(`[JobBoard] Unmount keeps official-posting refresh on retained canvas id=${id}`);
      return;
    }
    const planAtUnmount = getNode(id)?.data?.boardScanResume || data.boardScanResume || null;
    const cancellationIntentPromise = persistBoardCancellationIntent('board-unmounted');
    // Start the exact child cancellation in this unmount turn, while the
    // Search's closing registration is still intentionally available. Waiting
    // for persistBoardCancellationIntent's renderer-frame acknowledgement here
    // used to outlive the registry's cleanup grace and incorrectly fall back
    // to a broad/unavailable child path. The pre-existing Board plan remains
    // valid durable authority; the intent write above is synchronous and the
    // child will publish its own cleanup receipt before retiring any ledger.
    const childCancellation = cancelActiveSearchModule('board-unmounted', { allowStale: true });
    // Observe a fast child failure now, rather than only from the later intent
    // continuation. The intent can take several renderer frames (or reject),
    // during which an unobserved child rejection would otherwise surface as an
    // unhandled promise rejection even though this cleanup retains the durable
    // receipt for retry.
    const childCancellationResult = childCancellation.then(
      () => ({ ok: true }),
      error => ({ ok: false, error }),
    );
    epoch.bump();
    scanRunRef.current = null;
    combineRunRef.current = null;
    committedCombineRef.current = null;
    compensationRequestIdRef.current = null;
    moduleRunQueue.cancelQueuedRunsForNode(id, 'Job Board unmounted');
    // Navigation stores the canvas we are leaving in a hidden stack before
    // React unmounts these nodes. Queue/manual ownership can retire immediately,
    // but the Board plan is also the only durable authority for exact child
    // cleanup. Clear that receipt only after cancellation is verified; a failed
    // unmount cleanup must remain retryable when the user returns to this canvas.
    updateGlobal(id, { queuedModuleRun: null });
    void cancellationIntentPromise.then(async (intent) => {
      const [childResult] = await Promise.all([
        childCancellationResult,
        cancelBoardTaskAndRetireManualAi('board-unmounted'),
      ]);
      if (!childResult.ok) throw childResult.error;
      updateGlobal(id, (node) => {
        if (
          intent?.operationId
          && node?.data?.boardCancellation?.operationId !== intent.operationId
        ) return null;
        const planOwned = !node?.data?.boardScanResume
          || node.data.boardScanResume.boardRunId === (intent?.boardRunId || planAtUnmount?.boardRunId);
        return {
          boardCancellation: null,
          ...(planOwned ? { boardScanResume: null } : {}),
          ...(intent?.manualAiRunIds?.includes(node?.data?.manualAiResume?.runId)
            ? { manualAiResume: null }
            : {}),
        };
      });
    }).catch((error) => {
      EventLogger.error(`[JobBoard] child cancellation during unmount failed; recovery receipt retained id=${id}:`, error);
    });
    // Leaving a sub-canvas unmounts this Board AFTER the shared store already
    // holds the parent level, so a blind hubId sweep deleted any card of this
    // Board that had been pasted (or moved) up there. Only cascade when this
    // Board's own tree is on the current level; its cards in the canvas being
    // left were already stashed with that level.
    const ownTreeOnThisLevel = getNodes().some(n => (
      n.data?.hubId === id && n.type === 'jobgroup'
    ));
    if (ownTreeOnThisLevel) clearBoardChildren();
    else EventLogger.log(`[JobBoard] unmount cascade skipped: Board tree not on this level id=${id}`);
  }, [getNodes,cancelActiveSearchModule, cancelBoardTaskAndRetireManualAi, clearBoardChildren, data.boardScanResume, epoch, getNode, id, moduleRunQueue, persistBoardCancellationIntent, updateGlobal, officialPostingRefreshRunRef, canvasFilePath, nav]);

  useUnmountEffect(cleanupBoard);

  const handleClear = useCallback(async () => {
    if (officialPostingRefreshRunRef.current || getOfficialPostingPreparation(canvasFilePath, id)?.owner === 'board-refresh') return;
    if (cancellationInFlightRef.current) return;
    if (getNode(id)?.data?.locked) {
      EventLogger.log(`[JobBoard] clear ignored because Board is locked id=${id}`);
      return;
    }
    const cancellationToken = Symbol('job-board-clear');
    cancellationInFlightRef.current = cancellationToken;
    const cancellationIntentPromise = persistBoardCancellationIntent('board-cleared');
    epoch.bump();
    moduleRunQueue.cancelQueuedRunsForNode(id, 'Job Board cleared');
    setScanning(false);
    setScanProgress(null);
    setCombining(false);
    setFinalizingCommittedCombine(false);
    setCompensationProgress(null);
    setCombineResearchProgress(null);
    setRecoveryError(null);
    let cancellationIntent = null;
    try {
      cancellationIntent = await cancellationIntentPromise;
      if (cancellationIntent?.operationId) {
        autoRetriedBoardCancellationRef.current = cancellationIntent.operationId;
      }
      const childCancellation = cancelActiveSearchModule('board-cleared', { allowStale: true });
      scanRunRef.current = null;
      combineRunRef.current = null;
      committedCombineRef.current = null;
      compensationRequestIdRef.current = null;
      const boardCancellation = cancelBoardTaskAndRetireManualAi('board-cleared');
      await Promise.all([childCancellation, boardCancellation]);
    } catch (error) {
      EventLogger.error(`[JobBoard] clear could not cancel its active child id=${id}:`, error);
      setRecoveryError('The active Job Search could not be cancelled safely. Retry Cancel before clearing the board.');
      addToast({
        title: 'Board clear paused',
        description: 'The active Job Search could not be cancelled safely. Existing results were kept.',
        type: 'error',
      });
      if (cancellationInFlightRef.current === cancellationToken) cancellationInFlightRef.current = null;
      return;
    }
    if (cancellationInFlightRef.current === cancellationToken) cancellationInFlightRef.current = null;
    if (!getNode(id)) return;
    // Read the live store immediately before snapshotting. `data` can be one
    // render behind a just-finished Combine, and this receipt is only useful if
    // it names the exact cascade the user chose to remove.
    const currentData = getNode(id)?.data || data;
    const priorCombineSignature = typeof currentData.combineSignature === 'string'
      ? currentData.combineSignature.slice(0, 4_000)
      : null;
    const priorResultCount = normalizeBoardResultCount(currentData.resultCount);
    const priorSourceRuns = boundedCombinedSourceRuns(currentData.combineSourceRuns);
    // Undo must restore the board exactly as it looked before the user cleared
    // it, including the absence of this post-clear receipt.
    document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
    const clearProvenance = {
      clearedAt: Date.now(),
      priorCombineSignature,
      priorResultCount,
      priorSourceRuns,
    };
    clearBoardChildren();
    updateGlobal(id, {
      hubState: 'empty',
      resultCount: 0, moduleCount: 0,
      scoreThreshold: 0, scoreRangeMin: 0, scoreRangeMax: 100,
      sourceFilter: null, jobTaxonomy: null, finalSourceCounts: {}, mergeStats: null,
      combineSignature: null, combineSourceRuns: null, researchRemovedLookups: null, stale: false, staleReason: null,
      dismissedJobKeys: [],
      clearProvenance,
      manualAiResume: null,
      boardScanResume: null,
      boardCancellation: null,
      manualAiCleanupReceipts: null,
      queuedModuleRun: null,
    });
    EventLogger.log(`[JobBoard] cleared id=${id}`);
  }, [addToast, id, data, getNode, cancelActiveSearchModule, cancelBoardTaskAndRetireManualAi, clearBoardChildren, updateGlobal, epoch, moduleRunQueue, persistBoardCancellationIntent, officialPostingRefreshRunRef, canvasFilePath]);

  const completeManualAiRun = useCallback(async (runId, {
    retryCombineAfterRetirement = false,
  } = {}) => {
    if (!runId) return true;
    try {
      await retireActiveCombineManualAiRun(
        runId,
        'completed',
        retryCombineAfterRetirement ? { runId, retryCombineAfterRetirement: true } : null,
      );
      if (getNode(id)?.data?.manualAiResume?.runId === runId) {
        updateGlobal(id, { manualAiResume: null });
      }
      return true;
    } catch (error) {
      EventLogger.error(`[JobBoard] completed manual-AI handoff cleanup failed id=${id} run=${runId}:`, error);
      setRecoveryError(error?.message || 'Saved manual-AI cleanup did not finish.');
      return false;
    }
  }, [getNode, id, retireActiveCombineManualAiRun, updateGlobal]);

  const handleCancelRun = useCallback(async ({
    expectedBoardRunId = null,
    reason = 'board-run-cancelled',
    suppressToast = false,
  } = {}) => {
    if (expectedBoardRunId && !isBoardCombineManualAiRunId(expectedBoardRunId)) return { status: 'stale', cancelled: false };
    const liveData = getNode(id)?.data || data;
    const committedCombine = committedCombineRef.current;
    const persistedCommittedCleanup = liveData.manualAiResume?.retirementPending === true
      && liveData.manualAiResume?.committedResult === true;
    const committedResultAlreadyVisible = (
      committedCombine?.token && combineRunRef.current === committedCombine.token
    ) || persistedCommittedCleanup;
    const committedCleanupMustSettle = !!liveData.boardCancellation || reason === 'node-deleted';
    if (committedResultAlreadyVisible && !committedCleanupMustSettle) {
      // The new Board is already visible. Only idempotent recovery-ledger
      // retirement remains, so treating a click/event in this render gap as a
      // rollback would report a cancellation that did not (and cannot) occur.
      if (!suppressToast) {
        addToast({
          title: 'Board already updated',
          description: 'The new results were already committed and are finishing cleanup.',
          type: 'info',
        });
      }
      return { status: 'completed', cancelled: false };
    }
    const liveBoardRunIds = new Set([
      activeBoardRunIdRef.current,
      liveData.boardScanResume?.boardRunId,
      liveData.manualAiResume?.runId,
      liveData.boardCancellation?.boardRunId,
    ].filter(Boolean));
    if (expectedBoardRunId && !liveBoardRunIds.has(expectedBoardRunId)) {
      return { status: 'stale', cancelled: false };
    }
    const hadActiveRun = !!scanRunRef.current
      || !!combineRunRef.current
      || !!liveData.boardScanResume
      || isBoardCombineManualAiRunId(liveData.manualAiResume?.runId)
      || (!!liveData.boardCancellation && boardIndependentManualAiMarkerCleanup(liveData)?.boardCancellation !== null);
    if (!hadActiveRun) return { status: 'none', cancelled: false };
    if (cancellationInFlightRef.current) return { status: 'busy', cancelled: false };
    const cancellationToken = Symbol('job-board-cancel');
    cancellationInFlightRef.current = cancellationToken;

    const cancellationIntentPromise = persistBoardCancellationIntent(reason);
    epoch.bump();
    moduleRunQueue.cancelQueuedRunsForNode(id, 'Job Board run cancelled');
    setScanning(false);
    setScanProgress(null);
    setCombining(false);
    setFinalizingCommittedCombine(false);
    setCompensationProgress(null);
    setCombineResearchProgress(null);
    setRecoveryError(null);
    let cancellationIntent = null;
    try {
      cancellationIntent = await cancellationIntentPromise;
      if (cancellationIntent?.operationId) {
        autoRetriedBoardCancellationRef.current = cancellationIntent.operationId;
      }
      const childCancellation = cancelActiveSearchModule(reason, { allowStale: true });
      scanRunRef.current = null;
      combineRunRef.current = null;
      committedCombineRef.current = null;
      compensationRequestIdRef.current = null;
      const boardCancellation = cancelBoardTaskAndRetireManualAi(reason);
      await Promise.all([childCancellation, boardCancellation]);
    } catch (error) {
      EventLogger.error(`[JobBoard] exact child cancellation failed id=${id}:`, error);
      setRecoveryError('The active Job Search could not be cancelled safely. Retry this cancellation.');
      addToast({
        title: 'Cancellation not finished',
        description: 'The Board kept its recovery receipt so you can retry safely.',
        type: 'error',
      });
      if (cancellationInFlightRef.current === cancellationToken) cancellationInFlightRef.current = null;
      return { status: 'failed', cancelled: false, error: error?.message || String(error) };
    }
    // Keep the exact durable plan in place until the child has finished its
    // token discovery/rollback. It is both cancellation authority and the
    // reservation that keeps another Board from adopting this Search.
    if (cancellationInFlightRef.current === cancellationToken) cancellationInFlightRef.current = null;
    if (!getNode(id)) return { status: 'cancelled', cancelled: true };
    const retiredRunIds = new Set(cancellationIntent?.manualAiRunIds || []);
    updateGlobal(id, (node) => {
      if (
        cancellationIntent?.operationId
        && node?.data?.boardCancellation?.operationId !== cancellationIntent.operationId
      ) return null;
      const planOwned = !node?.data?.boardScanResume
        || !cancellationIntent?.boardRunId
        || node.data.boardScanResume.boardRunId === cancellationIntent.boardRunId;
      const markerOwned = !!node?.data?.manualAiResume?.runId
        && retiredRunIds.has(node.data.manualAiResume.runId);
      const remainingCleanupReceipts = normalizeManualAiCleanupReceipts(
        node?.data?.manualAiCleanupReceipts,
      ).filter(receipt => !retiredRunIds.has(receipt.runId));
      return {
        queuedModuleRun: null,
        boardCancellation: null,
        ...(planOwned ? { boardScanResume: null } : {}),
        ...(markerOwned ? { manualAiResume: null } : {}),
        manualAiCleanupReceipts: remainingCleanupReceipts.length > 0
          ? remainingCleanupReceipts
          : null,
      };
    });
    if (committedResultAlreadyVisible) {
      EventLogger.log(`[JobBoard] committed-run cleanup completed without rollback id=${id}`);
      if (reason === 'node-deleted') {
        return { status: 'cancelled', cancelled: true };
      }
      if (!suppressToast) {
        addToast({
          title: 'Board cleanup finished',
          description: 'The updated board and completed search results were kept.',
          type: 'info',
        });
      }
      return { status: 'completed', cancelled: false };
    }
    EventLogger.log(`[JobBoard] active run cancelled by user id=${id}`);
    if (!suppressToast) {
      addToast({
        title: 'Board run cancelled',
        description: 'Partial work in the active Search was rolled back. Completed Search results and existing Board results were kept.',
        type: 'info',
      });
    }
    return { status: 'cancelled', cancelled: true };
  }, [addToast, cancelActiveSearchModule, cancelBoardTaskAndRetireManualAi, data, epoch, getNode, id, moduleRunQueue, persistBoardCancellationIntent, updateGlobal]);

  const pauseBoardForQuit = useCallback(async ({ pauseSearchModule, isQuitPauseCurrent = () => true } = {}) => {
    const live = getNode(id)?.data || data;
    const plan = live.boardScanResume;
    if (!isQuitPauseCurrent()) return { success: false, status: 'stale', error: 'This search run is no longer current.' };
    if (!jobWorkflowNeedsQuitPause({ type: 'jobboard', data: live })
      && !scanRunRef.current && !scanPreflightRef.current && !combineRunRef.current
      && !combineRecoveryTokenClaimRef.current && !activeCombineManualAiRunRef.current
      && !activeSearchModuleIdRef.current && activeSearchModuleIdsRef.current.size === 0) {
      return { success: true, settled: true, idle: true };
    }
    const activeCombine = activeCombineManualAiRunRef.current;
    const marker = live.manualAiResume || (activeCombine?.runId ? {
      runId: activeCombine.runId, startedAt: activeCombine.startedAt,
      combineInputSignature: combineInputSignaturesRef.current.get(activeCombine.runId) || null,
      combineSourceRuns: combineSourceRunsRef.current.get(activeCombine.runId) || null,
    } : null);
    const sourceIds = [...new Set([
      ...activeSearchModuleIdsRef.current,
      activeSearchModuleIdRef.current,
      ...(plan?.activeSourceIds || []), plan?.activeSourceId,
      plan?.awaitingSourceResolution?.sourceId,
      ...(plan?.awaitingSourceResolutions || []).map(item => item?.sourceId),
    ].filter(Boolean))];
    // Checked before any mark is written: this refusal stops nothing.
    if (sourceIds.length && typeof pauseSearchModule !== 'function') throw new Error('The Board cannot save its active Search owners.');
    let pauseCommitted = false;
    // What this attempt changed, so an unconfirmed pause can take back exactly
    // its own marks (see jobboard/boardPauseRefusal.js).
    const pauseAttempt = ++boardPauseAttemptRef.current;
    let appliedMarks = null;
    updateGlobal(id, node => {
      if (!isQuitPauseCurrent()) return null;
      if (plan?.boardRunId && node?.data?.boardScanResume?.boardRunId !== plan.boardRunId) return null;
      if (live.manualAiResume?.runId && node?.data?.manualAiResume?.runId !== live.manualAiResume.runId) return null;
      pauseCommitted = true;
      const priorPlan = node.data.boardScanResume;
      const priorMarker = node.data.manualAiResume;
      appliedMarks = {
        plan: plan ? { boardRunId: priorPlan?.boardRunId ?? null,
          prior: { pausedByUser: priorPlan?.pausedByUser, autoResumeEligible: priorPlan?.autoResumeEligible } } : null,
        marker: marker ? { runId: priorMarker?.runId || marker.runId, existed: !!priorMarker, priorValue: priorMarker,
          prior: { pausedByUser: priorMarker?.pausedByUser, autoResumeEligible: priorMarker?.autoResumeEligible } } : null,
      };
      return {
        queuedModuleRun: null,
        ...(plan ? { boardScanResume: { ...node.data.boardScanResume, autoResumeEligible: false, pausedByUser: true, updatedAt: Date.now() } } : {}),
        ...(marker ? { manualAiResume: { ...marker, ...node.data.manualAiResume, autoResumeEligible: false, pausedByUser: true, updatedAt: Date.now() } } : {}),
      };
    });
    // Install each child's pauseCompletion synchronously before the parent
    // epoch changes. Those controls route aborted workers to saved Pause,
    // instead of the ordinary Board cancellation/rollback path.
    const childPauses = sourceIds.map(sourceId => pauseSearchModule(sourceId));
    const childSettlement = Promise.allSettled(childPauses);
    epoch.bump();
    moduleRunQueue.cancelQueuedRunsOwnedByNode(id, 'App paused for quit');
    let acknowledgement = null;
    let backendError = null;
    try {
      acknowledgement = await window.electronAPI?.pauseJobRunAndCancel?.({
        canvasFilePath, nodeId: id, cause: 'app-quit',
      });
    } catch (error) {
      backendError = error;
    }
    const children = await childSettlement;
    if (!isQuitPauseCurrent()) return { success: false, error: 'This quit request was released.' };
    if (backendError || acknowledgement?.settled !== true || acknowledgement?.ok === false
      || children.some(result => result.status === 'rejected' || result.value?.success !== true)) {
      // The app process refused or did not confirm, or a child Search did not
      // pause. The paused marks written above would now show "paused" (and
      // switch off auto-resume) for work that was never proven stopped, so
      // take back this attempt's own marks. The epoch bump and the cancelled
      // queued runs cannot be undone: the Board's own loop has let go of this
      // run, and the message below says how to pick it back up.
      const outcome = classifyBoardPauseOutcome({ acknowledgement, backendError, children,
        phase: plan?.phase, hasCombineMarker: !!marker, drainedBeforeAnswer: true });
      const mayRestore = outcome.restoreMarks && pauseCommitted && boardPauseAttemptRef.current === pauseAttempt;
      const marksRestored = mayRestore && !!boardPauseRestorePatch(getNode(id)?.data, appliedMarks);
      if (marksRestored) updateGlobal(id, node => boardPauseRestorePatch(node?.data, appliedMarks));
      const message = boardPauseRefusalMessage(outcome, { marksRestored });
      EventLogger.log(`[JobBoard] pause not confirmed id=${id} run=${plan?.boardRunId || marker?.runId || 'none'} backend=${outcome.backend} reason=${outcome.reason || 'none'} searches-paused=${outcome.searches.paused} searches-idle=${outcome.searches.idle} searches-failed=${outcome.searches.failed} marks=${marksRestored ? 'restored' : outcome.restoreMarks ? 'left-changed' : 'kept'}`);
      // Held (see pauseRefusalMessageRef) until the person chooses Retry, so
      // un-marking cannot start a second copy of work that may still be running.
      pauseRefusalMessageRef.current = message;
      setRecoveryError(message);
      throw new Error(message);
    }
    scanRunRef.current = null;
    scanPreflightRef.current = null;
    combineRunRef.current = null;
    activeCombineManualAiRunRef.current = null;
    compensationRequestIdRef.current = null;
    setScanning(false);
    setScanProgress(null);
    setCombining(false);
    setCompensationProgress(null);
    setCombineResearchProgress(null);
    // A pause taken while the Board is still searching names a search; one
    // that holds a Combine handoff keeps the AI-handoff notice.
    setRecoveryError(savedPauseMessageForPlan(plan, marker));
    updateGlobal(id, node => isQuitPauseCurrent() ? savedWorkflowQuitPausePatch(node, acknowledgement) : null);
    await settlePreFenceCanvasBatches();
    const committed = getNode(id)?.data;
    if (!pauseCommitted || (committed?.boardScanResume && committed.boardScanResume.autoResumeEligible !== false)
      || (committed?.manualAiResume && committed.manualAiResume.pausedByUser !== true)) throw new Error('The Job Board pause was not committed.');
    return { success: true, settled: true };
  }, [canvasFilePath, data, epoch, getNode, id, moduleRunQueue, updateGlobal]);

  const pauseSearchesAndSave = useCallback(async () => {
    if (pauseSaving) return { success: false, error: 'A save is already running.' };
    const boardRunId = getNode(id)?.data?.boardScanResume?.boardRunId || null;
    const isCurrentSearchRun = () => {
      const plan = getNode(id)?.data?.boardScanResume;
      return Boolean(boardRunId && plan?.boardRunId === boardRunId && plan.phase === 'searches');
    };
    if (!isCurrentSearchRun()) return { success: true };
    setPauseSaving(true);
    try {
      const result = await pauseBoardForQuit({ boardRunId,
        pauseSearchModule: sourceId => jobSearchCoordinator.pauseSearchModule(sourceId),
        isQuitPauseCurrent: isCurrentSearchRun,
      });
      if (result?.success) addToast({ title: 'Search paused and saved',
        description: 'The active Search can continue later. Existing Board results stay in place.', type: 'info' });
      else if (result?.status !== 'stale') throw new Error(result?.error || 'The active Search could not be paused safely.');
      return { success: true };
    } catch (error) {
      setRecoveryError(error?.message || 'The active Search could not be paused safely.');
      addToast({ title: 'Pause & save did not finish', description: error?.message || 'The Board kept its recovery receipt.', type: 'error' });
      return { success: false, error: error?.message || 'The active Search could not be paused safely.' };
    } finally { setPauseSaving(false); }
  }, [addToast, getNode, id, jobSearchCoordinator, pauseBoardForQuit, pauseSaving]);

  useEffect(() => jobSearchCoordinator.registerBoardModule(id, async (options = {}) => {
    const result = await handleCancelRun({
      expectedBoardRunId: options.boardRunId || null,
      reason: options.reason || 'board-run-cancelled',
      suppressToast: options.suppressToast === true,
    });
    return result;
  }, pauseBoardForQuit), [handleCancelRun, id, jobSearchCoordinator, pauseBoardForQuit]);

  useEffect(() => {
    const receipt = data.boardCancellation;
    if (!receipt?.operationId || cancellationInFlightRef.current) return;
    if (autoRetriedBoardCancellationRef.current === receipt.operationId) return;
    autoRetriedBoardCancellationRef.current = receipt.operationId;
    EventLogger.log(`[JobBoard] Retrying durable cancellation id=${id} operation=${receipt.operationId}`);
    void handleCancelRun({
      expectedBoardRunId: receipt.boardRunId || null,
      reason: receipt.reason || 'board-run-cancelled',
      suppressToast: true,
    });
  }, [data.boardCancellation, handleCancelRun, id]);

  // A Board that was saved while it was running searches itself (before the
  // listing stream) still carries that plan. Nothing can continue it from
  // here any more: the Job Search card resumes its own run. Retire the plan
  // once so the Board is not held in a recovery state for ever.
  useEffect(() => {
    if (!data.boardScanResume || data.locked) return;
    EventLogger.log(`[JobBoard] retired a saved Board-run search plan id=${id}: searches now belong to their Job Search cards`);
    updateGlobal(id, { boardScanResume: null });
  }, [data.boardScanResume, data.locked, id, updateGlobal]);

  // ── Listing streams ────────────────────────────────────────────────────────
  // The Board takes listings from the streams of its connected Job Searches,
  // a small batch at a time, for as long as it is on screen. It never starts,
  // pauses or steers a search.
  const intakeHoldReleaseRef = useRef(null);
  const [intakeNotice, setIntakeNotice] = useState(null);
  const intakeStreamKey = connectedModuleIds.join('\n');
  const boardCareerSnapshotIdForIntake = boardOwnCareerSnapshotId(data) || null;
  const dismissedKeysRef = useRef(data.dismissedJobKeys);
  dismissedKeysRef.current = data.dismissedJobKeys;
  useEffect(() => {
    if (!combining) {
      intakeHoldReleaseRef.current?.();
      intakeHoldReleaseRef.current = null;
    }
  }, [combining]);
  useEffect(() => () => { intakeHoldReleaseRef.current?.(); intakeHoldReleaseRef.current = null; }, []);
  useEffect(() => {
    if (!canvasFilePath || data.locked || !window.electronAPI?.boardIntakeStep) return undefined;
    const streamIds = intakeStreamKey ? intakeStreamKey.split('\n') : [];
    let stopped = false;
    let timer = null;
    let failures = 0;
    const refresh = async () => {
      const state = await window.electronAPI.boardIntakeState({ canvasFilePath, nodeId: id, includeRows: true });
      if (!stopped && state?.success) setJobBoardIntakeState(id, state);
    };
    const tick = async () => {
      if (stopped) return;
      let done = true;
      try {
        if (streamIds.length > 0) {
          const result = await window.electronAPI.boardIntakeStep({
            canvasFilePath, nodeId: id, streamIds,
            deletedKeys: Array.isArray(dismissedKeysRef.current) ? dismissedKeysRef.current : [],
            careerSnapshotId: boardCareerSnapshotIdForIntake,
          });
          if (stopped) return;
          if (!result?.success) throw new Error(result?.error || 'The Job Board could not take new listings.');
          done = result.done === true;
          failures = 0;
          setIntakeNotice(null);
          const changed = Object.entries(result.counts || {}).some(([key, value]) => key !== 'unchanged' && key !== 'read' && value > 0);
          if (changed || Object.keys(result.streams || {}).length > 0) await refresh();
        }
      } catch (error) {
        if (stopped) return;
        failures += 1;
        done = true;
        setIntakeNotice(String(error?.message || error).slice(0, 240));
        EventLogger.log(`[JobBoard] listing intake step failed id=${id} failures=${failures}`);
      }
      if (!stopped) timer = setTimeout(tick, nextJobBoardIntakeDelayMs({ done, failures }));
    };
    refresh().catch(() => {}).finally(() => { if (!stopped) tick(); });
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [boardCareerSnapshotIdForIntake, canvasFilePath, data.locked, id, intakeStreamKey]);

  const handleCombine = useCallback(async (options = {}) => {
    if (officialPostingRefreshRunRef.current || getOfficialPostingPreparation(canvasFilePath, id)?.owner === 'board-refresh') return { status: 'busy' };
    if (isJobWorkflowDeletionPending(id)) return { status: 'cancelled' };
    const liveBoardDataAtAdmission = getNode(id)?.data || {};
    if (
      liveBoardDataAtAdmission.boardCancellation
      || hasPendingManualAiRetirement(liveBoardDataAtAdmission)
      || liveBoardDataAtAdmission.locked
    ) return { status: 'busy' };
    // State alone cannot make this atomic: React applies setState after the
    // handler returns, so two calls in one event turn both see combining=false.
    if (combineRunRef.current || combineRecoveryTokenClaimRef.current) return { status: 'busy' };
    if (scanRunRef.current && options?.afterSearch !== true) return { status: 'busy' };
    // A board-owned scan deliberately calls this with the pre-scan render's
    // closure. Defer its input decision until after it acquires the lane and
    // snapshots the live source nodes; standalone Combine keeps the immediate
    // feedback below.
    const afterSearch = options?.afterSearch === true;
    const queueManagedByScan = afterSearch && options?.queueManagedByScan === true;
    const recoveryAttempt = options?.recoveryAttempt === true;
    // This render's module list predates the preferences just applied; admission re-reads the live graph.
    const preferencesJustApplied = options?.preferencesJustApplied === true;
    if (!preferencesJustApplied && !afterSearch && !recoveryAttempt && readyModules.length === 0 && allConnectedModulesDone) {
      // A source may legitimately complete with no matching/new jobs. Replace
      // the hidden previous cascade only after an explicit confirmation. The
      // prompt makes the affected board-owned node count visible and defaults to
      // retaining the stale results.
      if (canReplaceWithEmpty) {
        requestEmptyReplacement();
      } else {
        addToast({
          title: 'Board already current',
          description: 'The completed searches have no jobs and this board already reflects that result.',
          type: 'info',
        });
      }
      return { status: 'not-ready' };
    }
    if (!preferencesJustApplied && !afterSearch && !recoveryAttempt && readyModules.length === 0) {
      addToast({ title: 'Nothing to combine', description: 'Connect Job Search Modules that have finished scoring, then try again.', type: 'error' });
      return { status: 'not-ready' };
    }
    let manualAiRunId = options?.manualAiRunId || null;
    if (manualAiRunId && !isBoardCombineManualAiRunId(manualAiRunId)) return { status: 'not-ready' };
    if (afterSearch && recoveryAttempt && !manualAiRunId) {
      const recoveryTokenClaim = Symbol('job-board-combine-token-claim');
      combineRecoveryTokenClaimRef.current = recoveryTokenClaim;
      const expectedBoardRunId = typeof options?.expectedBoardRunId === 'string'
        ? options.expectedBoardRunId
        : null;
      try {
        const recoveryPlanAtClaim = getNode(id)?.data?.boardScanResume;
        if (
          !expectedBoardRunId
          || recoveryPlanAtClaim?.version !== 1
          || recoveryPlanAtClaim.phase !== 'combine'
          || recoveryPlanAtClaim.boardRunId !== expectedBoardRunId
        ) return { status: 'superseded' };

        const durableManualAiRunId = recoveryPlanAtClaim.combineManualAiRunId || null;
        if (durableManualAiRunId && !isBoardCombineManualAiRunId(durableManualAiRunId)) return { status: 'not-ready' };
        if (durableManualAiRunId) {
          // A stale render can invoke recovery with no token just after another
          // exact claimant committed one. Adopt that durable token; classifying
          // it as superseded would let the stale caller clear the valid plan.
          manualAiRunId = durableManualAiRunId;
        } else {
          // A pre-commit lock/deletion can consume and retire the prior manual-AI
          // token while leaving this exact phase=combine receipt retryable. Install
          // its replacement in the durable plan before any provider work. If the
          // app closes between this commit and the first pending event, reload will
          // reuse this token instead of minting another run and orphaning the first.
          const claimedManualAiRunId = createManualAiRunId(id);
          updateGlobal(id, (node) => {
            const currentPlan = node?.data?.boardScanResume;
            if (
              currentPlan?.version !== 1
              || currentPlan.phase !== 'combine'
              || currentPlan.boardRunId !== expectedBoardRunId
              || currentPlan.combineManualAiRunId
              || currentPlan.updatedAt !== recoveryPlanAtClaim.updatedAt
              || currentPlan.combineInputSignature !== recoveryPlanAtClaim.combineInputSignature
            ) return null;
            return {
              boardScanResume: {
                ...currentPlan,
                combineManualAiRunId: claimedManualAiRunId,
                updatedAt: Math.max(
                  Date.now(),
                  Number.isFinite(Number(currentPlan.updatedAt))
                    ? Number(currentPlan.updatedAt) + 1
                    : 0,
                ),
              },
            };
          });
          const recoveryTokenCommitted = await waitForBoardPlanCommit({
            getNode,
            nodeId: id,
            boardRunId: expectedBoardRunId,
            matches: plan => plan.phase === 'combine'
              && plan.combineManualAiRunId === claimedManualAiRunId
              && plan.combineInputSignature === recoveryPlanAtClaim.combineInputSignature,
          });
          if (!recoveryTokenCommitted) {
            return getNode(id) ? { status: 'busy' } : { status: 'cancelled' };
          }
          manualAiRunId = claimedManualAiRunId;
        }

        const liveDataAfterClaim = getNode(id)?.data;
        if (!liveDataAfterClaim || isJobWorkflowDeletionPending(id)) {
          return { status: 'cancelled' };
        }
        if (cancellationInFlightRef.current || liveDataAfterClaim.boardCancellation) {
          return { status: 'cancelled' };
        }
        if (hasPendingManualAiRetirement(liveDataAfterClaim)) return { status: 'busy' };
        if (liveDataAfterClaim.locked) {
          return { status: 'not-ready', error: 'Unlock this Job Board first.' };
        }
        if (
          liveDataAfterClaim.boardScanResume?.phase !== 'combine'
          || liveDataAfterClaim.boardScanResume?.boardRunId !== expectedBoardRunId
          || liveDataAfterClaim.boardScanResume?.combineManualAiRunId !== manualAiRunId
        ) return { status: 'superseded' };
      } catch (error) {
        EventLogger.error(`[JobBoard] recovered Combine token claim failed id=${id}:`, error);
        return { status: 'failed', error: error?.message || String(error) };
      } finally {
        if (combineRecoveryTokenClaimRef.current === recoveryTokenClaim) {
          combineRecoveryTokenClaimRef.current = null;
        }
      }
    }
    manualAiRunId ||= createManualAiRunId(id);
    const combineToken = Symbol('job-board-combine');
    // UUID makes this safe across an unmount/remount of the same board id;
    // the counter keeps the fallback unique within one mounted component.
    const entropy = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${++compensationRequestSequenceRef.current}-${Math.random().toString(36).slice(2)}`;
    const compensationRequestId = `board-compensation:${id}:${entropy}`;
    const persistedManualCombine = options?.manualAiRunId
      ? getNode(id)?.data?.manualAiResume
      : null;
    const persistedCombineStartedAt = normalizeJobBoardRecoveryTimestamp(
      persistedManualCombine?.startedAt,
    ) ?? normalizeJobBoardRecoveryTimestamp(persistedManualCombine?.updatedAt);
    const combineStartedAt = persistedCombineStartedAt ?? Date.now();
    combineRunRef.current = combineToken;
    // Build from the listings held now; what arrives meanwhile waits for the next build.
    intakeHoldReleaseRef.current?.();
    intakeHoldReleaseRef.current = holdJobBoardIntake(id);
    activeCombineManualAiRunRef.current = {
      token: combineToken,
      runId: manualAiRunId,
      startedAt: combineStartedAt,
    };
    compensationRequestIdRef.current = compensationRequestId;
    setCombining(true);
    EventLogger.log(`[JobBoard] combine started id=${id}`);
    setCompensationProgress(null);
    setCombineResearchProgress(null);
    const traceStartedAt = Date.now();
    const initialTrace = {
      attempt: ++combineAttemptRef.current,
      startedAt: traceStartedAt,
      phase: 'admission',
      phaseAt: traceStartedAt,
      status: 'running',
    };
    combineTraceRef.current = initialTrace;
    setCombineTrace(initialTrace);
    const cancelled = epoch.start();
    // A dock "Cancel task" aborts the in-flight request before its DOM event
    // reaches this Board. Every user-cancellation exit therefore starts this
    // Board's own exact cancellation while combineRunRef still owns this run,
    // so the finally block cannot leave a cancelled Board ownerless and let it
    // be offered as a resumable "Saved AI handoff".
    const cancelledOutsideBoard = (stage) => {
      if (!cancelled()) void handleCancelRun();
      // Each stage keeps a literal log line so diagnostics stay greppable.
      const stageLog = {
        taxonomy: `[JobBoard] combine cancelled by user id=${id} stage=taxonomy`,
        compensation: `[JobBoard] combine cancelled by user id=${id} stage=compensation`,
        'location-consolidation': `[JobBoard] combine cancelled by user id=${id} stage=location-consolidation`,
        'official-postings': `[JobBoard] combine cancelled by user id=${id} stage=official-postings`,
        pipeline: `[JobBoard] combine cancelled by user id=${id} stage=pipeline`,
      };
      EventLogger.log(stageLog[stage] || `[JobBoard] combine cancelled by user id=${id} stage=${stage}`);
      return { status: 'cancelled' };
    };
    let lease = null;
    let postingClaim = null;
    try {
      if (!queueManagedByScan) {
        // A standalone Combine owns one job-domain turn. A selected-search run
        // already holds the Board transaction's turn and deliberately bypasses
        // this nested acquisition so the scan cannot deadlock behind itself.
        lease = await moduleRunQueue.acquireModuleRun({
          nodeId: id,
          kind: 'job-board-combine',
          lane: 'job-search',
          label: 'Combine Job Board',
          onQueued: ({ position }) => updateGlobal(id, { queuedModuleRun: { label: 'Combine Job Board', position } }),
          onQueueUpdate: ({ position }) => updateGlobal(id, { queuedModuleRun: { label: 'Combine Job Board', position } }),
          onStart: () => {
            updateGlobal(id, { queuedModuleRun: null });
            if (cancelled() || isJobWorkflowDeletionPending(id)) {
              const error = new Error('Job Board combine cancelled');
              error.code = 'JOB_WORKFLOW_DELETION_PENDING';
              throw error;
            }
          },
        });
      } else {
        EventLogger.log(`[JobBoard] combine continuing inside scan queue turn id=${id}`);
        updateGlobal(id, { queuedModuleRun: null });
      }
      if (cancelled() || !getNode(id)) return { status: 'cancelled' };
      // The Board may have been locked while this turn waited in the shared
      // lane. Locked means a frozen snapshot, so do not even start provider
      // work from the click-time unlocked render.
      if (getNode(id)?.data?.locked) return { status: 'not-ready', error: 'Unlock this Job Board first.' };
      const pendingCardLookup = getNodes().some(node => node?.type === 'jobcard' && node.data?.hubId === id
        && getOfficialPostingPreparation(canvasFilePath, node.id));
      if (pendingCardLookup) {
        addToast({ title: 'Official posting lookup running', description: 'Finish or cancel the card lookup before combining this board.', type: 'info' });
        return { status: 'busy' };
      }
      postingClaim = beginOfficialPostingPreparation({ canvasFilePath, nodeId: id, purpose: 'lookup' });
      if (!postingClaim) return { status: 'busy' };
      // Take the input snapshot only after the shared lane starts. A search
      // ahead of this board can complete while it is queued; using the click-
      // time closure would waste a manual run and could misstate provenance.
      const inputsAtCombine = liveCombineInputs(id, getNodes(), getEdges());
      const completedAtCombine = inputsAtCombine.completed;
      const readyAtCombine = inputsAtCombine.ready;
      const salarySources = new Set(getConnectedJobSearchIds(id, getNodes(), getEdges()));
      const salaryCareerAtCombine = resolveSalaryCareerSnapshotId({
        boardData: getNode(id)?.data,
        searchModules: getNodes().filter(node => node.type === 'jobhub' && salarySources.has(node.id)),
      });
      if (salaryCareerAtCombine.blocked) {
        return { status: 'not-ready', error: 'Finish or discard the Job Board career-data import before salary analysis.' };
      }
      if (inputsAtCombine.all.some(module => isJobWorkflowDeletionPending(module.id))) {
        return { status: 'cancelled' };
      }
      const sigAtCombine = boardInputSignature(completedAtCombine, inputsAtCombine.all);
      const expectedSourceRuns = options?.expectedSourceRuns && typeof options.expectedSourceRuns === 'object'
        ? options.expectedSourceRuns
        : null;
      const expectedSourceMismatch = !selectedRunsMatchExpected(completedAtCombine, expectedSourceRuns);
      const persistedManualResume = getNode(id)?.data?.manualAiResume || null;
      const expectedCombineSignature = typeof options?.expectedCombineSignature === 'string'
        ? options.expectedCombineSignature
        : options?.manualAiRunId && persistedManualResume?.runId === manualAiRunId
          ? persistedManualResume.combineInputSignature || null
          : null;
      const expectedCombineSourceRuns = Array.isArray(options?.expectedCombineSourceRuns)
        ? options.expectedCombineSourceRuns
        : options?.manualAiRunId && persistedManualResume?.runId === manualAiRunId
          ? persistedManualResume.combineSourceRuns || null
          : null;
      const exactCombineRunsMatch = combineInputsMatchExpected(
        completedAtCombine,
        expectedCombineSourceRuns,
      );
      const missingRecoveryProof = recoveryAttempt
        && !hasExactCombineRecoveryProof(expectedCombineSignature, expectedCombineSourceRuns);
      if (
        expectedSourceMismatch
        || (expectedCombineSourceRuns ? !exactCombineRunsMatch : recoveryAttempt)
        || missingRecoveryProof
        || (expectedCombineSignature && expectedCombineSignature !== sigAtCombine)
      ) {
        const reason = 'Connected Job Search results changed before the interrupted Combine resumed';
        const preserveCompletedSnapshot = keepCompletedSnapshotDuringActiveSearch({
          boardData: getNode(id)?.data || {},
          completedModules: completedAtCombine,
          connectedModules: inputsAtCombine.all,
        });
        if (!preserveCompletedSnapshot) {
          hideBoardChildren();
          updateGlobal(id, { stale: true, staleReason: reason });
        }
        autoResumedManualAiRunRef.current = null;
        await completeManualAiRun(manualAiRunId);
        EventLogger.log(
          `[JobBoard] recovered combine superseded at admission id=${id} reason=${
            expectedSourceMismatch
              ? 'selected-runs'
              : (expectedCombineSourceRuns ? !exactCombineRunsMatch : recoveryAttempt)
                ? 'exact-source-runs'
                : missingRecoveryProof ? 'missing-recovery-proof' : 'input-signature'
          } inputs=${completedAtCombine.length}`
          + ` expected=${Array.isArray(expectedCombineSourceRuns) ? expectedCombineSourceRuns.length : 'none'}`,
        );
        return { status: 'superseded' };
      }
      if (readyAtCombine.length === 0) {
        const liveConnectedCount = getConnectedJobSearchIds(id, getNodes(), getEdges()).length;
        const allLiveConnectedDone = liveConnectedCount > 0 && inputsAtCombine.settled.length === liveConnectedCount;
        const emptySignature = sigAtCombine;
        const liveBoardData = getNode(id)?.data || {};
        const replacingPriorBoard = liveBoardData.hubState === 'done'
          && liveBoardData.combineSignature !== emptySignature;

        if (afterSearch && allLiveConnectedDone && replacingPriorBoard) {
          requestEmptyReplacement();
          return { status: 'completed' };
        }
        if (afterSearch && allLiveConnectedDone && liveBoardData.hubState !== 'done') {
          const perModule = completedAtCombine.map((module) => ({ label: module.label, count: 0, sourceCount: module.count }));
          updateGlobal(id, {
            hubState: 'done', resultCount: 0, moduleCount: completedAtCombine.length,
            scoreThreshold: 0, scoreRangeMin: 0, scoreRangeMax: 100,
            sourceFilter: null, jobTaxonomy: null, finalSourceCounts: {},
            mergeStats: {
              totalIncoming: 0, unique: 0, duplicatesRemoved: 0,
              collisions: 0, collisionUpgrades: 0, collisionAssessmentUpgrades: 0,
              modules: completedAtCombine.length, perModule,
            },
            combineSignature: emptySignature,
            combineSourceRuns: boundedCombinedSourceRuns(completedAtCombine),
            stale: false, staleReason: null, clearProvenance: null,
          });
          addToast({ title: 'Board search complete', description: 'The connected searches completed with no current jobs.', type: 'info' });
          return { status: 'completed' };
        }
        if (afterSearch && allLiveConnectedDone) {
          addToast({ title: 'Board already current', description: 'The connected searches still have no current jobs.', type: 'info' });
          return { status: 'completed' };
        }
        // A recovery may reach here after waiting behind another job-domain run
        // whose inputs changed. The old manual-AI prompt no longer describes
        // mergeable jobs, so retire its durable marker instead of suppressing
        // it forever behind the one-shot ref. A selected scan can also reach
        // here when other connected modules are not terminal; their absence is
        // not authoritative enough to replace an existing board.
        if (options?.manualAiRunId) {
          autoResumedManualAiRunRef.current = null;
          await completeManualAiRun(manualAiRunId);
        }
        addToast({ title: 'No current jobs to combine', description: 'Connected Job Search results changed while this board was queued.', type: 'info' });
        return { status: 'superseded' };
      }
      const exactSourceRunsAtCombine = completedAtCombine.map(combineSourceRunEntry);
      const sourceRunsAtCombine = boundedCombinedSourceRuns(completedAtCombine);
      if (activeCombineManualAiRunRef.current?.token === combineToken) {
        activeCombineManualAiRunRef.current = {
          ...activeCombineManualAiRunRef.current,
          combineInputSignature: sigAtCombine,
          combineSourceRuns: exactSourceRunsAtCombine,
        };
      }
      combineInputSignaturesRef.current.set(manualAiRunId, sigAtCombine);
      combineSourceRunsRef.current.set(manualAiRunId, exactSourceRunsAtCombine);
      while (combineInputSignaturesRef.current.size > 32) {
        const oldestRunId = combineInputSignaturesRef.current.keys().next().value;
        combineInputSignaturesRef.current.delete(oldestRunId);
        combineSourceRunsRef.current.delete(oldestRunId);
      }
      // Gather each positive-result module's scored jobs, tagging each with its ORIGIN
      // module id so a merged card's "Generate Résumé" reads career data from
      // the right search module (a string per card, not a deep résumé copy —
      // the old per-job resumeProfile clone persisted N identical profile
      // objects into the canvas file and was read by nothing).
      let jobArrays = readyAtCombine.map((m) =>
        m.scoredJobs
          .map((j) => ({ ...j, originHubId: j.originHubId || m.id }))
      );
      const preferenceOverrideAtCombine = activeJobBoardPreferenceOverride(getNode(id)?.data);
      let preferenceOverrideCounts = null;
      if (preferenceOverrideAtCombine) {
        recordCombineStage('board-preferences');
        const applied = await runBoardPreferenceOverrideStage(readyAtCombine, {
          override: preferenceOverrideAtCombine, nodeId: id, manualAiRunId,
          cancelled: () => cancelled() || !getNode(id) || !!getNode(id)?.data?.locked,
          onProgress: progress => { if (!cancelled()) setCombineResearchProgress(progress); },
          persist: record => updateGlobal(id, { jobBoardPreferenceOverride: record }),
          interpret: args => window.electronAPI.interpretJobPreferences(args),
          reapply: args => window.electronAPI.reapplyJobPreferences(args),
          evaluate: args => window.electronAPI.evaluateJobPreferences(args),
          score: args => window.electronAPI.scoreBoardPreferenceJobs(args),
        });
        if (applied.cancelled) return { status: 'cancelled' };
        jobArrays = applied.jobArrays;
        preferenceOverrideCounts = applied.counts;
      }
      // The Board's rows no longer come only from the Search's own result.
      const markBoardPreferencesCombined = () => {
        if (preferenceOverrideAtCombine) updateGlobal(id, node => ({ jobBoardPreferenceOverride: { ...activeJobBoardPreferenceOverride(node?.data), combinedAt: Date.now() } }));
      };
      const mergeStats = {};
      let union = unionScoredJobs(jobArrays, mergeStats);
      if (preferenceOverrideCounts) {
        mergeStats.overrideChecked = preferenceOverrideCounts.checked;
        mergeStats.overrideRemoved = preferenceOverrideCounts.removed;
        mergeStats.overrideCheckedRows = preferenceOverrideCounts.checkedRows;
        mergeStats.overrideRemovedRows = preferenceOverrideCounts.removedRows;
      }
      // Location consolidation runs BEFORE taxonomy so a four-location
      // posting becomes one "Multiple locations" row. Exact descriptions are
      // deterministic; non-identical ≥75%-similar descriptions receive an AI
      // same-requisition confirmation before they may merge. Existing board
      // cards are snapshotted as protected anchors: their ids/state are reused
      // and application-linked cards are never dropped.
      const existingBoardCards = (getNodes() || []).filter(
        n => n?.type === 'jobcard' && n?.data?.hubId === id,
      );
      const protectedBoardCards = existingBoardCards.filter(isProtectedJobCard);
      const candidateCountBeforeDismissal = union.length;
      // A card the user deleted from this Board stays deleted: its listing
      // keys are saved on the Board and matching rows are left out here. A
      // listing that still has a card on the Board is never left out.
      const dismissedJobKeysAtCombine = boardDeletedJobKeys(getNode(id)?.data?.dismissedJobKeys, existingBoardCards);
      const deletedSplit = splitBoardDeletedJobs(union, dismissedJobKeysAtCombine);
      union = deletedSplit.kept;
      mergeStats.deletedRemoved = deletedSplit.removed.length;
      // These rows were shown on this Board before the user deleted them, so
      // their Searches still count as shown here.
      const deletedOriginIdsAtCombine = [...new Set(deletedSplit.removed.map(job => job?.originHubId).filter(Boolean))];
      if (deletedSplit.removed.length > 0) {
        EventLogger.log(`[JobBoard] combine left out ${deletedSplit.removed.length} job(s) the user deleted from this Board id=${id} savedKeys=${dismissedJobKeysAtCombine.length}`);
      }
      let locationStats = {
        candidateGroups: 0, postingsCollapsed: 0, protectedRetained: 0,
        representedPostings: 0, alreadyConsolidated: 0,
      };
      if (union.length > 0 || protectedBoardCards.length > 0) {
        recordCombineStage('location-consolidation');
        const attached = attachProtectedCards(union, protectedBoardCards);
        const confirmation = await window.electronAPI.confirmJobLocationConsolidations({
          jobs: attached.jobs,
          nodeId: id,
          manualAiRunId,
        });
        if (cancelled() || !getNode(id)) {
          EventLogger.log(`[JobBoard] combine cancelled during location confirmation id=${id}`);
          return { status: 'cancelled' };
        }
        // A cancelled confirmation used to be rethrown as a generic error and
        // shown as "Combine failed".
        if (isJobBoardUserCancellation(confirmation)) return cancelledOutsideBoard('location-consolidation');
        if (!confirmation?.success) {
          throw new Error(confirmation?.error || 'Job-location consolidation confirmation failed.');
        }
        const consolidated = consolidateJobLocations(attached.jobs, {
          protectedIds: new Set(protectedBoardCards.map(card => card.id)),
          confirmedSimilarPairIds: new Set(confirmation.confirmedPairIds || []),
        });
        // Protected cards with no union counterpart must still render: append
        // them so an application-linked card is never lost to a Combine.
        union = consolidated.jobs.concat(attached.unmatchedProtected);
        locationStats = consolidated.stats;
        if (locationStats.candidateGroups > 0) {
          EventLogger.log(
            `[JobBoard] location consolidation id=${id} groups=${locationStats.candidateGroups} `
            + `postingsCollapsed=${locationStats.postingsCollapsed} protected=${locationStats.protectedRetained} `
            + `similarPairsConfirmed=${confirmation.confirmedPairIds?.length || 0}/${confirmation.candidateCount || 0}`,
          );
        }
      }
      // Bind lookups to the final card shape: location consolidation can change
      // the semantic source. Keep exact current card receipts, then retry legacy
      // and incomplete rows without changing the source-run artifacts.
      union = carryBoardOfficialPostingResults(union, existingBoardCards);
      recordCombineStage('official-postings');
      const savedRemovals = getNode(id)?.data?.researchRemovedLookups;
      const boardResearch = await runBoardResearchStage(union, {
        nodeId: id, manualAiRunId, existingCards: existingBoardCards,
        // A new Search run can change why a row left, so only the same runs reuse its lookup.
        removedLookups: JSON.stringify(savedRemovals?.sourceRuns) === JSON.stringify(sourceRunsAtCombine) ? savedRemovals.entries : null,
        protectedIds: new Set(protectedBoardCards.map(card => card.id)),
        cancelled: () => cancelled() || !getNode(id) || !!getNode(id)?.data?.locked,
        // Every eligible row crosses the host proof check. Only the host can reuse
        // an exact current cache receipt; renderer freshness is display-only.
        refresh: args => window.electronAPI.refreshOfficialPostings({ ...args, force: false }),
        settle: args => window.electronAPI.settleBoardResearch(args),
        onProgress: progress => { if (!cancelled()) setCombineResearchProgress(progress); },
      });
      if (boardResearch.cancelled) return cancelledOutsideBoard('official-postings');
      union = boardResearch.jobs;
      const researchRemovedLookups = boardResearch.removedLookups?.length
        ? { sourceRuns: sourceRunsAtCombine, entries: boardResearch.removedLookups } : null;
      if (boardResearch.reusedRemovals) EventLogger.log(`[JobBoard] combine reused ${boardResearch.reusedRemovals} official lookup(s) from rows the previous Combine removed id=${id}`);
      if (boardResearch.pausedRetries) EventLogger.log(`[JobBoard] combine skipped ${boardResearch.pausedRetries} exhausted official lookup(s) id=${id}`);
      if (cancelled() || !getNode(id)) return { status: 'cancelled' };
      const perModule = boardCombinePerModule(completedAtCombine, readyAtCombine, jobArrays);
      EventLogger.log(`[JobBoard] combine merged id=${id} signature=${sigAtCombine} mergedUnique=${mergeStats.unique} locationCollapsed=${locationStats.postingsCollapsed} afterResearch=${union.length}`);
      EventLogger.log(
        `[JobBoard] Combined ${completedAtCombine.length} completed module(s): ` +
        `${describeBoardMergeInputs({ ...mergeStats, perModule })} → ` +
        `${mergeStats.unique} unique (${mergeStats.duplicatesRemoved} dup removed, ` +
        // Without this term the printed equation silently stops balancing:
        // incoming − duplicates ≠ unique whenever preference-filtered rows were
        // skipped, and the missing count appeared in no other line.
        `${mergeStats.preferenceFilteredSkipped || 0} preference-filtered skipped, ` +
        `${mergeStats.collisionUpgrades} score-upgrade(s), ` +
        `${mergeStats.collisionAssessmentUpgrades} assessment-upgrade(s))`
      );
      if (union.length === 0) {
        if (candidateCountBeforeDismissal > 0 || preferenceOverrideAtCombine) {
          // The user deleted every saved candidate from this Board, or the
          // Board's own preferences removed them. Commit an empty, current Board instead of treating
          // either as missing data.
          if (getNode(id)?.data?.locked) {
            autoResumedManualAiRunRef.current = null;
            await completeManualAiRun(manualAiRunId, { retryCombineAfterRetirement: true });
            return { status: 'not-ready', error: 'Unlock this Job Board first.' };
          }
          // The re-check can take minutes; a card that gained an application meanwhile stays.
          const liveApplicationCardIds = getNodes().filter(node => node?.data?.hubId === id && isProtectedJobCard(node)).map(node => node.id);
          document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
          clearBoardChildren({ preserveNodeIds: liveApplicationCardIds });
          updateGlobal(id, {
            hubState: 'done', resultCount: liveApplicationCardIds.length, moduleCount: completedAtCombine.length,
            scoreRangeMin: 0, scoreRangeMax: 100, scoreThreshold: 0,
            sourceFilter: null, finalSourceCounts: {}, jobTaxonomy: null,
            combineSignature: sigAtCombine,
            combineSourceRuns: sourceRunsAtCombine,
            researchRemovedLookups,
            stale: false, staleReason: null,
            boardScanResume: null, manualAiResume: null,
          });
          markBoardPreferencesCombined();
          autoResumedManualAiRunRef.current = null;
          await completeManualAiRun(manualAiRunId);
          return { status: 'completed' };
        }
        // Legacy/corrupt sources can claim scored rows whose preference status
        // removes every row from the merge. Any pending manual response describes
        // a now-empty input and must not survive as an ownerless recovery marker.
        autoResumedManualAiRunRef.current = null;
        await completeManualAiRun(manualAiRunId);
        addToast({ title: 'No jobs to combine', description: 'The connected modules have no mergeable scored jobs.', type: 'error' });
        return { status: 'superseded' };
      }

      // Re-bucket over the union. Ship only the projection the taxonomy needs
      // (the handler strips to exactly these fields anyway) — the full union
      // carries snippets/reasoning and used to serialize hundreds of KB over
      // IPC for nothing. Index alignment with `union` is what matters.
      let bucketTree;
      try {
        recordCombineStage('taxonomy');
        const compactJobs = union.map((j) => ({
          careerDirection: j.careerDirection || '',
          matchScore: normalizeJobMatchScore(j.matchScore),
          salary: j.salary || '',
          title: j.title || '',
          source: j.source || '',
        }));
        const res = await window.electronAPI.bucketJobs({ jobs: compactJobs, nodeId: id, manualAiRunId });
        if (cancelled() || !getNode(id)) {
          EventLogger.log(`[JobBoard] combine cancelled before spawn id=${id}`);
          return { status: 'cancelled' };
        }
        if (!res?.success) {
          if (isJobBoardUserCancellation(res)) return cancelledOutsideBoard('taxonomy');
          const error = new Error(res?.error || 'Job Board taxonomy generation failed.');
          error.code = res?.errorCode;
          throw error;
        }
        bucketTree = {
          likelihoodBands: res.likelihoodBands,
          salaryRanges: res.salaryRanges,
          roles: res.roles,
        };
        const taxonomyCheck = validateJobBoardTaxonomy(bucketTree, union.length);
        if (!taxonomyCheck.valid) throw new Error(`Job Board taxonomy was invalid: ${taxonomyCheck.reason}`);
      } catch (err) {
        if (cancelled() || !getNode(id)) return { status: 'cancelled' };
        if (isJobBoardUserCancellation(err)) return cancelledOutsideBoard('taxonomy');
        // Do not replace the existing board when its required taxonomy could
        // not be generated. Clearing only happens after this whole try block.
        EventLogger.error('[JobBoard] Bucketing failed; preserving prior board:', err);
        throw err;
      }

      if (cancelled() || !getNode(id)) return { status: 'cancelled' };

      // Compensation has to run while `union` still carries the scorer-only
      // context (especially compensationContext). Job cards intentionally do
      // not persist that internal prompt material, so researching after spawn
      // would fragment or skip the cohort work. The main-process cache makes a
      // repeat Combine reuse unchanged cohorts when the provider supports it.
      try {
        recordCombineStage('compensation', 'running', { compensationInput: union.length });
        const remoteResidencesByOrigin = Object.fromEntries(readyAtCombine.map((module) => [module.id, module.remoteResidences]));
        // Keep this transient routing input on the full union rather than
        // choosing one module's residence for every remote listing. The card
        // builder's explicit whitelist omits it after research is complete.
        const searchCountryByOrigin = Object.fromEntries(readyAtCombine.map((module) => [module.id, module.searchCountryCode]));
        union = attachCompensationRemoteResidences(union, remoteResidencesByOrigin, searchCountryByOrigin);
        const compensationResult = await window.electronAPI?.researchJobCompensation?.({
          jobs: union,
          nodeId: id,
          requestId: compensationRequestId,
          manualAiRunId,
          salaryCareerSnapshotId: salaryCareerAtCombine.careerSnapshotId,
        });
        if (cancelled() || !getNode(id)) {
          EventLogger.log(`[JobBoard] combine cancelled during compensation research id=${id}`);
          return { status: 'cancelled' };
        }
        if (!compensationResult?.success || !Array.isArray(compensationResult.jobs)) {
          if (isJobBoardUserCancellation(compensationResult)) return cancelledOutsideBoard('compensation');
          const error = new Error(compensationResult?.error || 'Job Board compensation research failed.');
          error.code = compensationResult?.errorCode;
          throw error;
        }
        union = compensationResult.jobs;
        recordCombineStage('card-build', 'running', { compensationInput: union.length });
      } catch (err) {
        if (cancelled() || !getNode(id)) return { status: 'cancelled' };
        if (isJobBoardUserCancellation(err)) return cancelledOutsideBoard('compensation');
        // Like failed taxonomy, a failed research invocation must leave the
        // previously displayed board intact rather than replacing it with a
        // partial set of cards.
        EventLogger.error('[JobBoard] Compensation research failed; preserving prior board:', err);
        throw err;
      }

      // Prepare, but do not consume, the durable seen-history capability
      // before this Board's visible cascade is committed. The host binds it to
      // the exact source receipts/current artifacts; a later source change or
      // cancellation makes the pending token unusable rather than recording
      // listings that were never displayed.
      const historyRows = union.filter(j => !isUnscoredPlaceholderCard(j) && !isLegacyUnscoredPlaceholder(j)).flatMap((j) => {
        if (Array.isArray(j.postingVariants) && j.postingVariants.length > 0) {
          return j.postingVariants.map((variant) => ({
            source: variant.source || j.source,
            company: j.company,
            title: j.title,
            location: variant.location || j.location,
            url: variant.url || j.url,
          }));
        }
        return [{ source: j.source, company: j.company, title: j.title, location: j.location, url: j.url }];
      });
      let historyToken = null;
      // A card whose saved scores were kept under nearly unchanged career data
      // has no receipt until its next search (Clear Career Data retired it).
      // Its jobs were recorded as seen when they were first shown, so it sits
      // out of this write instead of cancelling the write for every other
      // Search on the Board.
      const keptScoreSourceIds = new Set(completedAtCombine
        .filter(module => !module.operationAuthority && currentSavedJobsRescoreSkip(getNode(module.id)?.data))
        .map(module => module.id));
      const historySources = completedAtCombine.filter(module => !keptScoreSourceIds.has(module.id));
      const historyAuthorityAvailable = boardHistoryAuthorityAvailable(historySources);
      if (union.length > 0 && canvasFilePath && historyAuthorityAvailable) {
        recordCombineStage('history-preflight');
        const prepared = await window.electronAPI?.prepareBoardJobsHistory?.({
          canvasFilePath,
          jobs: historyRows,
          sources: historySources.map((module) => ({
            hubId: module.id,
            runId: module.runId,
            careerSnapshotId: module.careerSnapshotId,
            operationAuthority: module.operationAuthority,
          })),
        });
        if (cancelled() || !getNode(id)) return { status: 'cancelled' };
        if (prepared?.success !== true || !prepared.historyToken) {
          EventLogger.log(`[JobBoard] history preflight rejected id=${id} outcome=${prepared?.operationSuperseded ? 'superseded' : 'unavailable'} reason=${/^[a-z-]+$/.test(prepared?.reason || '') ? prepared.reason : 'unknown'}`);
          if (prepared?.operationSuperseded === true) {
            autoResumedManualAiRunRef.current = null;
            await completeManualAiRun(manualAiRunId);
            return { status: 'superseded', error: prepared?.error || 'Board inputs changed before display commit.' };
          }
          throw new Error(prepared?.error || 'Board history preflight did not finish.');
        }
        historyToken = prepared.historyToken;
      } else if (union.length > 0 && canvasFilePath) {
        EventLogger.log(`[JobBoard] history preflight skipped id=${id} reason=${historySources.length > 0 ? 'legacy-source-authority-unavailable' : 'kept-scores-sources-only'} sources=${completedAtCombine.length}`);
      }

      // A source can finish, reset, or be reconnected during any provider or
      // history-preflight await. Keep this fence after the final await before
      // building/replacing the visible cascade. Never replace cards,
      // write provenance, or append seen-history for that obsolete union.
      if (getNode(id)?.data?.locked) {
        autoResumedManualAiRunRef.current = null;
        await completeManualAiRun(manualAiRunId, { retryCombineAfterRetirement: true });
        EventLogger.log(`[JobBoard] combine stopped before commit because Board was locked id=${id}`);
        return { status: 'not-ready', error: 'Unlock this Job Board first.' };
      }
      const liveStateBeforeCommit = liveCombineInputs(id, getNodes(), getEdges());
      const liveInputsBeforeCommit = liveStateBeforeCommit.completed;
      const boardDeletionPending = isJobWorkflowDeletionPending(id);
      if (
        boardDeletionPending
        || liveStateBeforeCommit.all.some(module => isJobWorkflowDeletionPending(module.id))
      ) {
        autoResumedManualAiRunRef.current = null;
        await completeManualAiRun(manualAiRunId, { retryCombineAfterRetirement: true });
        EventLogger.log(
          `[JobBoard] combine stopped before commit because ${boardDeletionPending ? 'the Board' : 'a Search'} is being deleted id=${id}`,
        );
        return { status: 'cancelled' };
      }
      const salarySourcesAtCommit = new Set(getConnectedJobSearchIds(id, getNodes(), getEdges()));
      const salaryCareerAtCommit = resolveSalaryCareerSnapshotId({
        boardData: getNode(id)?.data,
        searchModules: getNodes().filter(node => node.type === 'jobhub' && salarySourcesAtCommit.has(node.id)),
      });
      const signatureMatches = (
        !salaryCareerAtCommit.blocked && salaryCareerAtCommit.careerSnapshotId === salaryCareerAtCombine.careerSnapshotId &&
        boardInputSignature(
          liveInputsBeforeCommit,
          liveStateBeforeCommit.all,
        ) === sigAtCombine
      );
      const selectedRunsMatch = selectedRunsMatchExpected(liveInputsBeforeCommit, expectedSourceRuns);
      const exactSourceRunsMatch = combineInputsMatchExpected(liveInputsBeforeCommit, exactSourceRunsAtCombine);
      const mismatchReason = combineCommitMismatchReason({
        signatureMatches,
        selectedRunsMatch,
        exactSourceRunsMatch,
      });
      if (mismatchReason !== null) {
        const reason = 'Connected Job Search results changed while Combine was running';
        const preserveCompletedSnapshot = keepCompletedSnapshotDuringActiveSearch({
          boardData: getNode(id)?.data || {},
          completedModules: liveInputsBeforeCommit,
          connectedModules: liveStateBeforeCommit.all,
        });
        if (!preserveCompletedSnapshot) {
          hideBoardChildren();
          updateGlobal(id, { stale: true, staleReason: reason });
        }
        // A manual taxonomy/compensation handoff belongs to the immutable input
        // signature captured above. Once that signature changes, this response
        // can never be resumed safely. Retire its exact marker now so it cannot
        // strand the Board in "Recovering" or revive the obsolete union later.
        autoResumedManualAiRunRef.current = null;
        await completeManualAiRun(manualAiRunId);
        // Name the receipt SHAPE that failed per input (fixed codes, no ids) so
        // a report can tell real input drift from a receipt-normalization bug.
        const liveById = new Map(liveInputsBeforeCommit.map(module => [module.id, module]));
        const receiptDetail = exactSourceRunsAtCombine
          .map((expected, index) => `#${index + 1}=${describeReceiptMismatch(liveById.get(expected.sourceId), expected) || 'match'}`)
          .join(',');
        EventLogger.log(`[JobBoard] combine superseded before commit id=${id} signature=${sigAtCombine} reason=${mismatchReason} receipts=${receiptDetail}`);
        addToast({ title: 'Combine discarded', description: 'Connected Job Search results changed while Combine was running, so nothing was combined. Run Combine saved results again.', type: 'info' });
        return { status: 'superseded' };
      }

      // An application can be queued on an existing card while the Board is
      // awaiting taxonomy/history. Its newly protected identity was not part
      // of the consolidation plan; rebuilding that plan would invalidate the
      // already validated taxonomy indices. Retry rather than delete its card.
      const liveProtectedBoardCards = getNodes().filter(
        node => node?.data?.hubId === id && isProtectedJobCard(node),
      );
      const protectedCardIdsAtCombine = new Set(protectedBoardCards.map(card => card.id));
      if (liveProtectedBoardCards.length !== protectedCardIdsAtCombine.size
        || liveProtectedBoardCards.some(card => !protectedCardIdsAtCombine.has(card.id))) {
        autoResumedManualAiRunRef.current = null;
        await completeManualAiRun(manualAiRunId);
        EventLogger.log(`[JobBoard] combine superseded before commit id=${id} reason=protected-cards-changed`);
        addToast({ title: 'Combine paused', description: 'Application cards changed while Combine was running. Run Combine saved results again to keep their current application state.', type: 'info' });
        return { status: 'superseded' };
      }

      // Links a card marked as no longer showing the job stay marked on the
      // rebuilt rows. Read from the live cards right before the build: cards
      // stay editable while Combine runs, so a mark or Restore made after the
      // Combine snapshot must not be lost or undone.
      const liveBoardCards = getNodes().filter(node => node?.type === 'jobcard' && node?.data?.hubId === id);
      union = carryBoardDeadSourceUrls(union, liveBoardCards);

      const originalPos = getNode(id)?.position || { x: 0, y: 0 };
      const baseNodeId = `board-${id}-${Date.now()}`;
      const { newNodes, newEdges, scoreRangeMin, scoreRangeMax, taxonomy } = buildJobTreeNodes({
        displayedJobs: union,
        bucketTree,
        originalPos,
        hubId: id,
        baseNodeId,
        // Reuse protected card ids/state so an application-linked card survives
        // a live Combine unchanged (same node id, localApplication preserved).
        protectedCards: liveProtectedBoardCards,
      });

      // Replace only after the complete cascade and its authority checks are
      // ready. Reused application card ids stay live while the older groups and
      // unprotected cards pass through the normal asynchronous deletion path.
      // Snapshot before asking ReactFlow to delete anything. `deleteElements`
      // currently yields internally, but undo correctness must not depend on
      // that implementation detail or a future synchronous deletion path.
      if (newNodes.length > 0) {
        document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
      }
      if (newNodes.length > 0) {
        replaceBoardDisplayChildren({
          hubId: id, newNodes, newEdges, getNodes,
          clearChildren: clearBoardChildren,
          updateNodeData: updateGlobal,
          setNodes,
          addElements: (addedNodes, addedEdges) => {
            if (addElementsGlobally) addElementsGlobally(id, addedNodes, addedEdges, 'sibling');
            else { addNodes(addedNodes); addEdges(addedEdges); }
          },
        });
        requestAnimationFrame(() => fitView({ duration: 600, padding: 0.2 }));
      } else {
        clearBoardChildren();
      }

      const finalSourceCounts = finalSourceCountsOf(union);

      // Publish a durable cleanup-only receipt in the same node update as the
      // visible Board metadata. If the renderer/app is torn down before the
      // following completion acknowledgement returns, reload must retire this
      // exact manual run instead of replaying a Combine whose cascade already
      // replaced the prior result. Clearing boardScanResume here removes the
      // second recovery entry point for the same committed transaction.
      committedCombineRef.current = { token: combineToken, manualAiRunId };
      recordCombineStage('commit');
      if (manualAiRunId) {
        rememberBoundedRunId(committedCombineManualAiRunIdsRef.current, manualAiRunId);
      }
      setFinalizingCommittedCombine(true);
      updateGlobal(id, (node) => {
        const existingManualResume = node?.data?.manualAiResume;
        const sameManualRun = existingManualResume?.runId === manualAiRunId;
        const persistedStartedAt = normalizeJobBoardRecoveryTimestamp(existingManualResume?.startedAt);
        return {
          hubState: 'done',
          resultCount: union.length,
          moduleCount: completedAtCombine.length,
          scoreRangeMin,
          scoreRangeMax,
          scoreThreshold: scoreRangeMin,
          sourceFilter: null,
          // Only a validated API taxonomy reaches this point, so diagnostics and
          // reload state describe the hierarchy the provider actually generated.
          jobTaxonomy: { likelihoodBands: taxonomy.likelihoodBands, salaryRanges: taxonomy.salaryRanges },
          finalSourceCounts,
          // Merge provenance for the bug report — the dedup is otherwise
          // invisible. Location consolidation is reported separately from the
          // cross-source dedup so neither count is silently folded into the
          // other: one removed identical postings, the other collapsed exact
          // multi-location duplicates.
          mergeStats: {
            ...mergeStats,
            modules: completedAtCombine.length,
            perModule,
            locationVariantGroups: locationStats.candidateGroups,
            locationVariantPostingsCollapsed: locationStats.postingsCollapsed,
            locationVariantProtectedRetained: locationStats.protectedRetained,
            researchRemoved: boardResearch.removed || 0,
            // Earlier rows a Board re-scan kept on its Searches (they are in
            // the union but not in the latest run's own count).
            carriedJobs: completedAtCombine.reduce((sum, module) => {
              const sourceData = getNode(module.id)?.data;
              return sum + (sourceData?.jobRunId === module.runId && Number.isSafeInteger(sourceData?.carriedJobCount)
                ? Math.max(0, sourceData.carriedJobCount)
                : 0);
            }, 0),
          },
          // Baseline for staleness detection (connection/data drift vs. this combine).
          combineSignature: sigAtCombine,
          combineSourceRuns: sourceRunsAtCombine,
          researchRemovedLookups,
          salaryCareerSnapshotId: salaryCareerAtCombine.careerSnapshotId,
          salaryMethodVersion: JOB_COMPENSATION_METHOD_VERSION,
          stale: false, staleReason: null,
          clearProvenance: null,
          boardScanResume: null,
          manualAiResume: manualAiRunId ? {
            ...(sameManualRun ? existingManualResume : {}),
            runId: manualAiRunId,
            combineInputSignature: sigAtCombine,
            combineSourceRuns: exactSourceRunsAtCombine,
            startedAt: sameManualRun && persistedStartedAt != null
              ? persistedStartedAt
              : combineStartedAt,
            retirementPending: true,
            retirementReason: 'completed',
            committedResult: true,
            updatedAt: Date.now(),
          } : null,
        };
      });

      // A scored job becomes "seen" only after this Combine/Re-combine has
      // completed and displayed its cards. Search/scoring completion — even
      // while connected to this board — is intentionally not enough.
      if (newNodes.length > 0 && canvasFilePath && historyToken) {
        // The visible Board is already committed and cannot be rolled back by
        // Cancel. Do not keep the run in its cancellable UI state merely while a
        // diagnostic/history write drains; finish the transaction synchronously
        // and report any persistence failure out-of-band.
        try {
          const historyWrite = window.electronAPI?.appendJobsHistory?.({
            canvasFilePath, jobs: historyRows, nodeId: id, historyStage: 'boardDisplay', historyToken,
          });
          void Promise.resolve(historyWrite).then((historyResult) => {
            if (!historyResult?.success || historyResult?.error) {
              EventLogger.error('[JobBoard] Displayed-results history append failed:', historyResult?.error || 'unknown error');
            }
          }).catch((error) => {
            EventLogger.error('[JobBoard] Displayed-results history append failed:', error);
          });
        } catch (error) {
          EventLogger.error('[JobBoard] Displayed-results history append failed:', error);
        }
      }
      // Record on each Search which Board first showed its run. That record is
      // what later lets a Board search replace these jobs with new ones, and
      // keeps any other Board (including one made after this Board is
      // deleted) from showing them a second time.
      // Only a Search with at least one row in the displayed set counts:
      // research, dedup or Board preferences can remove every row of one, and
      // rows shown through a Board preference override count too.
      if (newNodes.length > 0) {
        const shownAt = Date.now();
        const displayedOriginIds = new Set([...union.map(job => job?.originHubId).filter(Boolean), ...deletedOriginIdsAtCombine]);
        for (const module of completedAtCombine) {
          if (!module.runId || !displayedOriginIds.has(module.id)) continue;
          // A stream has no run to mark as shown: what was shown is recorded per listing.
          if (isJobBoardStreamRunId(module.runId)) continue;
          updateGlobal(module.id, node => jobSearchShownRunPatch(node?.data, {
            boardId: id,
            runId: module.runId,
            now: shownAt,
          }));
        }
      }
      markBoardPreferencesCombined();
      EventLogger.log(`[JobBoard] combine completed id=${id} signature=${sigAtCombine} results=${union.length} children=${newNodes.length} locationGroups=${locationStats.candidateGroups} locationCollapsed=${locationStats.postingsCollapsed}`);
      if (newNodes.length > 0 && canvasFilePath) {
        // The cards are on screen: record their listings as seen, so no later
        // Board shows them again. Each is named by its stream key; the app
        // process writes only those this Board's own record holds.
        const shown = union.filter(job => typeof job?.listingStreamKey === 'string' && job.listingStreamKey
          && !isUnscoredPlaceholderCard(job) && !isLegacyUnscoredPlaceholder(job)).map(job => ({
          key: job.listingStreamKey,
          rows: Array.isArray(job.postingVariants) && job.postingVariants.length > 0
            ? job.postingVariants.map(variant => ({ source: variant.source || job.source, company: job.company, title: job.title, location: variant.location || job.location, url: variant.url || job.url }))
            : [{ source: job.source, company: job.company, title: job.title, location: job.location, url: job.url }],
        }));
        if (shown.length > 0) {
          try {
            const recorded = await window.electronAPI?.recordBoardShownListings?.({ canvasFilePath, nodeId: id, shown });
            EventLogger.log(`[JobBoard] shown listings recorded as seen id=${id} sent=${shown.length} written=${recorded?.written ?? '?'} refused=${recorded?.refused ?? '?'}`);
          } catch (error) {
            EventLogger.error('[JobBoard] Shown listings could not be recorded as seen:', error);
          }
        }
      }
      recordCombineStage('cleanup', 'completed');
      await completeManualAiRun(manualAiRunId);
      return { status: 'completed' };
    } catch (err) {
      if (err?.code === 'APP_QUIT_PAUSED' || err?.message === 'App paused for quit') {
        return { status: 'paused', reason: 'awaiting-explicit-ai-continue' };
      }
      if (err?.pausedForQuit === true) return { status: 'paused', reason: 'awaiting-explicit-ai-continue' };
      if (
        cancelled()
        || !getNode(id)
        || isJobWorkflowDeletionPending(id)
        || err?.code === 'JOB_WORKFLOW_DELETION_PENDING'
      ) return { status: 'cancelled' };
      if (isJobBoardUserCancellation(err)) return cancelledOutsideBoard('pipeline');
      EventLogger.error('[JobBoard] Combine failed:', err);
      recordCombineStage(combineTraceRef.current?.phase || 'unknown', 'failed');
      addToast({ title: 'Combine failed', description: err?.message || String(err), type: 'error' });
      return { status: 'failed', error: err?.message || String(err) };
    } finally {
      postingClaim?.finish();
      lease?.release();
      if (committedCombineRef.current?.token === combineToken) {
        committedCombineRef.current = null;
        setFinalizingCommittedCombine(false);
      }
      // Clear only the run that acquired this token. A Clear/unmount releases
      // the lock synchronously; a late former run must never unlock, clear
      // progress, or otherwise alter a newer Combine.
      if (combineRunRef.current === combineToken) {
        const lastTrace = combineTraceRef.current;
        recordCombineStage('settled', lastTrace?.status === 'running' ? 'stopped' : lastTrace?.status || 'stopped', {
          lastPhase: lastTrace?.phase || 'unknown',
          endedAt: Date.now(),
        });
        combineRunRef.current = null;
        if (activeCombineManualAiRunRef.current?.token === combineToken) {
          activeCombineManualAiRunRef.current = null;
        }
        compensationRequestIdRef.current = null;
        setCompensationProgress(null);
    setCombineResearchProgress(null);
        if (!cancelled() && getNode(id)) setCombining(false);
      }
    }
  }, [readyModules, allConnectedModulesDone, canReplaceWithEmpty, getNodes, getEdges, getNode, id, clearBoardChildren, hideBoardChildren, requestEmptyReplacement, addElementsGlobally, addNodes, addEdges, fitView, updateGlobal, setNodes, addToast, epoch, canvasFilePath, completeManualAiRun, moduleRunQueue, keepCompletedSnapshotDuringActiveSearch, recordCombineStage, officialPostingRefreshRunRef, handleCancelRun]);

  // A Board that is behind the listings it holds rebuilds its cards on its own.
  // Nobody presses Combine for it: the cards on screen stay until the new set
  // is ready. While a search is still sending, rebuilds are spaced out.
  const lastBuildEndedAtRef = useRef(0);
  const rebuildFailuresRef = useRef(0);
  const handleCombineRef = useRef(handleCombine);
  handleCombineRef.current = handleCombine;
  // Behind: it holds listings its cards do not show yet, or the pay method changed since they were built.
  const boardBehindListings = readyModules.length > 0
    && (hubState !== 'done' || data.combineSignature !== liveSignature || salaryNeedsRefresh);
  const boardCanBuildNow = !!canvasFilePath && !combining && !scanning && !data.locked && !data.boardCancellation
    && !officialPostingRefreshRunRef.current && !careerOverrideRunRef.current;
  const anyStreamActive = connectedModules.some(module => module.streamActive === true);
  useEffect(() => {
    const delay = jobBoardRebuildDelayMs({
      behind: boardBehindListings,
      canBuild: boardCanBuildNow,
      streamActive: anyStreamActive,
      lastBuildEndedAt: lastBuildEndedAtRef.current,
      failures: rebuildFailuresRef.current,
    });
    if (delay == null) return undefined;
    const timer = setTimeout(async () => {
      const outcome = await handleCombineRef.current({ fromListingStream: true }).catch(error => ({ status: 'failed', error: error?.message }));
      lastBuildEndedAtRef.current = Date.now();
      if (outcome?.status === 'completed') rebuildFailuresRef.current = 0;
      else if (outcome?.status === 'failed') rebuildFailuresRef.current += 1;
    }, delay);
    return () => clearTimeout(timer);
    // intakeVersion restarts the quiet period each time a listing arrives.
  }, [anyStreamActive, boardBehindListings, boardCanBuildNow, intakeVersion]);


  // ── Single-stage reruns ─────────────────────────────────────────────────
  // Combine stays the do-everything action. These redo ONE of its stages on
  // the cards already shown, so a salary-only change does not repay official
  // lookups, listing checks and grouping. Each stage uses the same IPC
  // Combine uses, and writes back only its own card fields, skipping any card
  // that changed meanwhile.
  const stageTaxonomy = async (rows, manualAiRunId, current) => {
    const res = await window.electronAPI.bucketJobs({ jobs: taxonomyRowsFromCards(rows), nodeId: id, manualAiRunId });
    if (!current()) return null;
    if (!res?.success) {
      if (isJobBoardUserCancellation(res)) return null;
      throw new Error(res?.error || 'Job Board grouping failed.');
    }
    const bucketTree = { likelihoodBands: res.likelihoodBands, salaryRanges: res.salaryRanges, roles: res.roles };
    const check = validateJobBoardTaxonomy(bucketTree, rows.length);
    if (!check.valid) throw new Error(`Job Board grouping was invalid: ${check.reason}`);
    return bucketTree;
  };

  // Rebuild the group tree in the given card order. Each entry names a card to
  // keep plus the fields this stage changed on it; everything else is read
  // from the LIVE card right now, so a note, application or link Restore made
  // while the stage ran is kept. A card with no entry is deleted.
  const stageRebuildTree = (entries, bucketTree, { removedCount = 0 } = {}) => {
    // useReactFlow is scoped to the canvas level on screen. Only rebuild when
    // this Board is on it; otherwise the tree would land on another level.
    if (!getNode(id)) throw new Error('Return to this board’s canvas and run the step again.');
    const liveCards = getNodes().filter(node => node?.type === 'jobcard' && node.data?.hubId === id);
    const liveById = new Map(liveCards.map(card => [card.id, card]));
    const displayedJobs = entries.map(({ cardId, changes = {} }) => {
      const live = liveById.get(cardId);
      if (!live) throw new Error('A card was removed while this step ran. Run it again.');
      return { ...live.data, ...changes, reuseCardId: cardId };
    });
    const { newNodes, newEdges, scoreRangeMin, scoreRangeMax, taxonomy } = buildJobTreeNodes({
      displayedJobs, bucketTree, originalPos: getNode(id)?.position || { x: 0, y: 0 }, hubId: id,
      baseNodeId: `board-${id}-${Date.now()}`, protectedCards: liveCards,
    });
    document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
    if (newNodes.length > 0) {
      replaceBoardDisplayChildren({
        hubId: id, newNodes, newEdges, getNodes, clearChildren: clearBoardChildren, updateNodeData: updateGlobal, setNodes,
        addElements: (addedNodes, addedEdges) => {
          if (addElementsGlobally) addElementsGlobally(id, addedNodes, addedEdges, 'sibling');
          else { addNodes(addedNodes); addEdges(addedEdges); }
        },
      });
    } else {
      clearBoardChildren();
    }
    const finalSourceCounts = finalSourceCountsOf(displayedJobs);
    const liveBoard = getNode(id)?.data || {};
    const priorThreshold = Number(liveBoard.scoreThreshold);
    // Keep the user's filters unless the new tree no longer has what they select.
    const filter = {
      sourceFilter: liveBoard.sourceFilter && finalSourceCounts[liveBoard.sourceFilter] ? liveBoard.sourceFilter : null,
      scoreThreshold: Number.isFinite(priorThreshold) ? Math.min(Math.max(priorThreshold, scoreRangeMin), scoreRangeMax) : scoreRangeMin,
      showReviewCards: liveBoard.showReviewCards,
    };
    updateGlobal(id, node => ({
      resultCount: displayedJobs.length, scoreRangeMin, scoreRangeMax, finalSourceCounts,
      sourceFilter: filter.sourceFilter, scoreThreshold: filter.scoreThreshold,
      jobTaxonomy: { likelihoodBands: taxonomy.likelihoodBands, salaryRanges: taxonomy.salaryRanges },
      ...(removedCount ? { mergeStats: { ...(node?.data?.mergeStats || {}), researchRemoved: (node?.data?.mergeStats?.researchRemoved || 0) + removedCount } } : {}),
    }));
    // New group nodes arrive unfiltered; apply the kept filters once they exist.
    requestAnimationFrame(() => {
      applyCardFilters(filter);
      fitView({ duration: 600, padding: 0.2 });
    });
  };

  const runSalaryStage = async ({ manualAiRunId, current, stillOwned, setProgress }) => {
    const nodes = refreshNodes();
    const edges = refreshEdges();
    const cards = boardStageCards(nodes, id);
    const lockedCount = nodes.filter(node => node?.type === 'jobcard' && node.data?.hubId === id).length - cards.length;
    if (!cards.length) {
      addToast({ title: 'No job cards to update', description: 'This board has no unlocked job cards.', type: 'info' });
      return;
    }
    const salarySources = new Set(getConnectedJobSearchIds(id, nodes, edges));
    const salaryCareer = resolveSalaryCareerSnapshotId({
      boardData: refreshNode(id)?.data,
      searchModules: nodes.filter(node => node.type === 'jobhub' && salarySources.has(node.id)),
    });
    if (salaryCareer.blocked) {
      addToast({ title: 'Career data import pending', description: 'Finish or discard the Job Board career-data import before salary analysis.', type: 'info' });
      return;
    }
    const { rows, matched } = compensationRowsFromCards(cards, liveCombineInputs(id, nodes, edges).all);
    const snapshots = cards.map(card => stageCardSnapshot(card, COMPENSATION_FIELDS));
    const requestId = `board-stage-compensation:${id}:${globalThis.crypto.randomUUID()}`;
    setProgress({ completed: 0, total: 0 });
    const unsubscribe = window.electronAPI.onCompensationProgress?.(payload => {
      if (payload?.nodeId === id && payload.requestId === requestId) setProgress({ completed: payload.processed ?? 0, total: payload.total ?? 0 });
    });
    let result;
    try {
      result = await window.electronAPI.researchJobCompensation({
        jobs: rows, nodeId: id, requestId, manualAiRunId, salaryCareerSnapshotId: salaryCareer.careerSnapshotId,
      });
    } finally { unsubscribe?.(); }
    if (!current()) return;
    if (!result?.success || !Array.isArray(result.jobs) || result.jobs.length !== rows.length) {
      if (isJobBoardUserCancellation(result)) return;
      throw new Error(result?.error || 'Salary research failed. The board kept its previous salary results.');
    }
    // Node updaters apply in order, so the Board updater below sees every
    // card's outcome. A skipped card keeps the Board marked out of date.
    let skipped = lockedCount;
    result.jobs.forEach((row, index) => {
      const snapshot = snapshots[index];
      updateGlobal(snapshot.id, node => {
        if (stillOwned() && stageCardUnchanged(node, snapshot, id, COMPENSATION_FIELDS)) return compensationPatch(row);
        skipped++;
        return null;
      });
    });
    updateGlobal(id, () => (stillOwned() && skipped === 0
      ? { salaryCareerSnapshotId: salaryCareer.careerSnapshotId, salaryMethodVersion: JOB_COMPENSATION_METHOD_VERSION } : null));
    const researched = result.jobs.filter(row => !['below_fit_threshold', 'fit_score_unavailable'].includes(row.compensationAssessment?.reasonCode)).length;
    EventLogger.log(`[JobBoard] salary rerun finished id=${id} cards=${cards.length} researched=${researched} sourceRows=${matched} locked=${lockedCount}`);
    requestAnimationFrame(() => addToast({
      title: skipped ? 'Salary analysis partly updated' : 'Salary analysis updated',
      description: `${researched} card${researched === 1 ? '' : 's'} at fit ${RESEARCH_MIN_FIT_SCORE} or above were researched again; nothing else on the board was redone.`
        + (skipped ? ` ${skipped} card${skipped === 1 ? ' was' : 's were'} locked or changed meanwhile and kept the old result, so the board still shows salary as out of date.` : '')
        + (matched < cards.length ? ` ${cards.length - matched} card${cards.length - matched === 1 ? '' : 's'} no longer had a saved search row, so their salary context came from the card itself.` : ''),
      type: skipped ? 'info' : 'success',
    }));
  };

  const runRegroupStage = async ({ manualAiRunId, current, stillOwned, setProgress }) => {
    const cards = boardStageCards(refreshNodes(), id);
    if (!cards.length) {
      addToast({ title: 'No job cards to sort', description: 'This board has no unlocked job cards.', type: 'info' });
      return;
    }
    if (cards.length !== refreshNodes().filter(node => node?.type === 'jobcard' && node.data?.hubId === id).length) {
      addToast({ title: 'Locked cards on this board', description: 'Re-sorting would move locked cards. Unlock them or use Re-combine.', type: 'info' });
      return;
    }
    setProgress({ label: 'Grouping jobs' });
    const bucketTree = await stageTaxonomy(cards.map(rebuildRowFromCard), manualAiRunId, current);
    if (!bucketTree || !stillOwned()) return;
    const liveIds = boardStageCards(refreshNodes(), id).map(card => card.id).sort().join('\u0000');
    if (liveIds !== cards.map(card => card.id).sort().join('\u0000')) {
      throw new Error('Cards were added or removed while sorting. Run the grouping step again.');
    }
    const live = new Map(refreshNodes().map(node => [node.id, node]));
    const groupingFields = ['matchScore', 'careerDirection', 'title', 'salary', 'source', 'officialPosting'];
    if (cards.some(card => !stageCardUnchanged(live.get(card.id), stageCardSnapshot(card, groupingFields), id, groupingFields))) {
      throw new Error('A card’s fit, role or pay changed while sorting. Run the grouping step again.');
    }
    stageRebuildTree(cards.map(card => ({ cardId: card.id })), bucketTree);
    addToast({ title: 'Board re-sorted', description: `${cards.length} card${cards.length === 1 ? '' : 's'} regrouped by hiring fit, salary and role. Card contents were not changed.`, type: 'success' });
  };

  const runListingStage = async ({ manualAiRunId, current, stillOwned, setProgress }) => {
    const allCards = refreshNodes().filter(node => node?.type === 'jobcard' && node.data?.hubId === id);
    const cards = boardStageCards(refreshNodes(), id);
    if (!cards.length) {
      addToast({ title: 'No job cards to check', description: 'This board has no unlocked job cards.', type: 'info' });
      return;
    }
    if (cards.length !== allCards.length) {
      addToast({ title: 'Locked cards on this board', description: 'A listing check can remove or regroup cards. Unlock them or use Re-combine.', type: 'info' });
      return;
    }
    setProgress({ label: `Checking ${cards.length} listing${cards.length === 1 ? '' : 's'}` });
    const snapshots = cards.map(card => stageCardSnapshot(card, LISTING_FIELDS));
    const settled = await window.electronAPI.settleBoardResearch({
      jobs: cards.map(card => ({ ...card.data, cardId: card.id })), nodeId: id, manualAiRunId, officialLookups: 0,
    });
    if (!current()) return;
    if (!settled?.success || !Array.isArray(settled.jobs) || settled.jobs.length !== cards.length) {
      if (isJobBoardUserCancellation(settled) || settled?.cancelled) return;
      throw new Error(settled?.error || 'The listing check failed. The board kept its previous results.');
    }
    // Application-linked cards are never removed, exactly as in Combine.
    const removed = new Set((settled.dropped || []).map(entry => entry?.index)
      .filter(index => Number.isSafeInteger(index) && !cards[index]?.data?.localApplication));
    const keptIndexes = cards.map((_card, index) => index).filter(index => !removed.has(index));
    const keptRows = keptIndexes.map(index => settled.jobs[index]);
    const keptCards = keptIndexes.map(index => cards[index]);
    const regroup = removed.size > 0 || listingChangedGrouping(keptRows, keptCards);
    const salaryInputsChanged = listingChangedSalaryInputs(keptRows, keptCards);
    if (!regroup) {
      keptIndexes.forEach((index, position) => {
        const patch = listingPatch(keptRows[position], cards[index]);
        if (!Object.keys(patch).length) return;
        updateGlobal(snapshots[index].id, node => (stillOwned() && stageCardUnchanged(node, snapshots[index], id, LISTING_FIELDS) ? patch : null));
      });
    } else {
      setProgress({ label: 'Regrouping changed cards' });
      const bucketTree = await stageTaxonomy(keptRows, manualAiRunId, current);
      if (!bucketTree || !stillOwned()) return;
      // A concurrent edit to any listing field, or a card that gained an
      // application meanwhile and is due for removal, cancels the rebuild.
      const live = new Map(refreshNodes().map(node => [node.id, node]));
      if (snapshots.some(snapshot => !stageCardUnchanged(live.get(snapshot.id), snapshot, id, LISTING_FIELDS))
        || [...removed].some(index => isProtectedJobCard(live.get(cards[index].id)))) {
        throw new Error('A card changed while its listing was checked. Run the listings step again.');
      }
      stageRebuildTree(keptIndexes.map((index, position) => ({ cardId: cards[index].id, changes: listingPatch(keptRows[position], cards[index]) })),
        bucketTree, { removedCount: removed.size });
      // Let the next Combine reuse the finished lookups of the removed rows,
      // which still exist in the Searches, instead of researching them again.
      const entries = (await Promise.all([...removed].map(index => removedLookupEntry(settled.jobs[index])))).filter(Boolean);
      if (entries.length) {
        updateGlobal(id, node => {
          const sourceRuns = node?.data?.combineSourceRuns ?? null;
          const saved = node?.data?.researchRemovedLookups;
          const prior = JSON.stringify(saved?.sourceRuns) === JSON.stringify(sourceRuns) && Array.isArray(saved?.entries) ? saved.entries : [];
          const keys = new Set(entries.map(entry => entry.key));
          return { researchRemovedLookups: { sourceRuns, entries: [...prior.filter(entry => !keys.has(entry?.key)), ...entries].slice(-MAX_BOARD_REMOVED_LOOKUPS) } };
        });
      }
    }
    // A rescore changes what salary analysis read; flag it rather than keep
    // a salary answer computed from the old fit audit.
    if (salaryInputsChanged) updateGlobal(id, () => (stillOwned() ? { salaryMethodVersion: null } : null));
    const counts = settled.counts || {};
    const parts = [
      [removed.size, 'removed (closed or duplicate)'], [counts.rescoreChanged, 'rescored'], [counts.livenessRechecked, 'listing status rechecked'],
    ].filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
    addToast({
      title: 'Listings re-checked',
      description: `${parts.length ? parts.join(', ') : 'No changes'}. Official postings were not looked up again${regroup ? '; the board was regrouped' : ''}.`
        + (salaryInputsChanged ? ' Scores changed, so salary analysis is now marked out of date: redo the Salary step.' : ''),
      type: 'success',
    });
  };

  const { running: stageRerunning, progress: stageRerunProgress, start: startStageRerun, cancel: cancelStageRerun } = useBoardStageRerun({
    nodeId: id, canvasFilePath, getNode: refreshNode, getNodes: refreshNodes,
    getCurrentFile: nav?.getCurrentFile, moduleRunQueue, addToast,
    canStart: () => {
      const live = refreshNode(id)?.data;
      return !!live && live.hubState === 'done' && !live.stale && !live.locked && !live.boardCancellation
        && !hasPendingManualAiRetirement(live) && !combineRunRef.current && !scanRunRef.current
        && !scanPreflightRef.current && !cancellationInFlightRef.current && !combineRecoveryTokenClaimRef.current
        && !officialPostingRefreshRunRef.current && !careerOverrideRunRef.current
        && !live.boardScanResume && !isBoardCombineManualAiRunId(live.manualAiResume?.runId);
    },
    getScopeKey: () => {
      const inputs = liveCombineInputs(id, refreshNodes(), refreshEdges());
      return JSON.stringify([refreshNode(id)?.data?.combineSignature, boardInputSignature(inputs.completed, inputs.all),
        inputs.completed.map(combineSourceRunEntry)]);
    },
    stages: { compensation: runSalaryStage, listings: runListingStage, regroup: runRegroupStage },
  });

  // A Job Board never starts, continues or pauses a search: it reads the
  // listing streams of its connected Job Searches and nothing else. The
  // former entry point remains only as the inert target of the saved-plan
  // recovery effects, which are removed with the rest of that machinery.
  const handleSearchSelected = useCallback(async () => ({ status: 'not-ready' }), []);

  const settleRecoveredCombine = useCallback((outcome, expectedBoardRunId) => {
    if (
      outcome?.status === 'busy'
      || outcome?.status === 'not-ready'
      || outcome?.status === 'cancelled'
    ) {
      // Keep the exact recovery receipt. Unlocking, queue settlement, or an
      // aborted deletion will re-enter this Combine from its immutable input
      // signature; none of these states proves success or obsolescence.
      autoResumedBoardScanRef.current = null;
      autoResumedManualAiRunRef.current = null;
      setRecoveryError(null);
      return false;
    }
    if (outcome?.status === 'failed' || !outcome?.status) {
      setRecoveryError(outcome?.error || 'The interrupted Board combine did not finish.');
      return false;
    }
    if (outcome.status !== 'completed' && outcome.status !== 'superseded') {
      setRecoveryError(outcome.error || 'The interrupted Board combine returned an unknown result.');
      return false;
    }
    const livePlan = getNode(id)?.data?.boardScanResume;
    if (
      livePlan?.phase === 'combine'
      && (!expectedBoardRunId || livePlan.boardRunId === expectedBoardRunId)
    ) {
      clearExactBoardScanResume(updateGlobal, id, livePlan.boardRunId);
    }
    setRecoveryError(null);
    return true;
  }, [getNode, id, updateGlobal]);

  // A Board-owned child can survive an app restart through its own durable
  // manual-AI marker. Keep the parent transaction durable as well: once that
  // child settles, resume only the searches that had not completed before the
  // interruption, then perform the original all-connected combine.
  useEffect(() => {
    const plan = data.boardScanResume;
    if (!plan || plan.version !== 1 || !plan.boardRunId) {
      autoResumedBoardScanRef.current = null;
      searchRecoveryErrorRef.current = null;
      foreignRecoveryWaitSigRef.current = null;
      // No plan, so no recovery notice of its own: the report must not keep
      // printing the last plan's latch beside an idle Board.
      boardRecoveryDiagnosticsRef.current = { recoveryErrorLatch: 'none', awaitedSource: 'none' };
      return;
    }
    if (recoveryError && recoveryError === pauseRefusalMessageRef.current) return;
    if (data.manualAiResume?.pausedByUser === true
      || data.manualAiResume?.autoResumeEligible === false
      || plan.pausedByUser === true || plan.autoResumeEligible === false) {
      // A saved pause has no live executor after remount. Publish the explicit
      // Continue action before returning; the durable marker alone otherwise
      // leaves the selector showing recovery progress forever.
      const publishesPause = !scanRunRef.current && !combineRunRef.current && !data.boardCancellation;
      // The report's latch must describe the message this branch publishes;
      // the classification further down is never reached for a saved pause.
      boardRecoveryDiagnosticsRef.current = {
        recoveryErrorLatch: publishesPause ? 'paused-continue' : (recoveryError ? 'sticky' : 'none'),
        awaitedSource: awaitedSourceTerminalStatus(plan, getNode),
      };
      if (publishesPause) {
        setRecoveryError(savedPauseMessageForPlan(plan, data.manualAiResume));
      }
      return;
    }
    if (boardRecoveryTouchesPendingDeletion(id, plan, data.manualAiResume)) {
      // onBeforeDelete is reversible. Do not consume the durable recovery
      // receipt (or its one-shot latch) while its Board/input is only pending
      // removal; settling the lifecycle revision must be able to retry it.
      autoResumedBoardScanRef.current = null;
      foreignRecoveryWaitSigRef.current = null;
      return;
    }
    if (foreignRecoveryWaitSigRef.current === boardRecoverySig) return;
    foreignRecoveryWaitSigRef.current = null;
    const selectedSearchModuleIds = [...new Set(
      (Array.isArray(plan.selectedSearchModuleIds) ? plan.selectedSearchModuleIds : [])
        .filter(sourceId => typeof sourceId === 'string' && sourceId),
    )];
    // Only verification that affects a selected Search is recovery input.
    // An unrelated platform's brief check must not consume a retryable Search
    // error, while finishing a selected platform check remains a real wake-up.
    const relevantVerifyingPlatforms = new Set(
      [...(verifyingPlatforms || [])].filter((platformId) => (
        selectedSearchModuleIds.some((sourceId) => (
          moduleSearchReadiness(getNode(sourceId), new Set([platformId])).statusLabel === 'Checking connections'
        ))
      )),
    );
    // Exact interrupted recovery is allowed only while the global session has
    // settled, even when today's enabled-source set is empty. In that state no
    // platform appears in `relevantVerifyingPlatforms`, so carry a compact
    // global marker into the recovery key and wake the same durable plan when
    // verification starts or finishes.
    const exactRecoveryBlockedByGlobalVerification = selectedSearchModuleIds.some((sourceId) => {
      const source = getNode(sourceId);
      const sourceData = source?.data;
      return canInspectInterruptedRecovery(
        moduleSearchReadiness(source, new Set()),
        sourceData,
      );
    });
    const verificationSignature = [
      ...relevantVerifyingPlatforms,
      ...(exactRecoveryBlockedByGlobalVerification && hasActivePlatformVerification(verifyingPlatforms)
        ? ['exact-recovery-verifying']
        : []),
    ].sort().join(',');
    const recoveryKey = jobBoardSearchRecoveryKey(
      plan,
      connectedSig,
      verificationSignature,
    );
    const userPausedChild = selectedSearchModuleIds.some(sourceId => {
      const marker = getNode(sourceId)?.data?.manualAiResume;
      return marker?.pausedByUser === true && marker.orchestratorNodeId === id
        && marker.boardRunId === plan.boardRunId;
    });
    if (userPausedChild && !scanRunRef.current && !scanPreflightRef.current) {
      boardRecoveryDiagnosticsRef.current = {
        recoveryErrorLatch: 'paused-continue',
        awaitedSource: awaitedSourceTerminalStatus(plan, getNode),
      };
      setRecoveryError('This Job Search is paused with its saved work. Continue from the Job Board when ready.');
      return;
    }
    // Classify the awaited source(s) once per run of this effect, right where the
    // recovery inputs are read. It is the same terminal receipt the continuation
    // consumes, so the retry guard below and the report's `awaitedSource` field
    // can never disagree about whether it arrived.
    const awaitedStatus = awaitedSourceTerminalStatus(plan, getNode);
    boardRecoveryDiagnosticsRef.current = {
      recoveryErrorLatch: recoveryError
        ? (searchRecoveryErrorRef.current?.message === recoveryError ? 'search-retryable' : 'sticky')
        : 'none',
      awaitedSource: awaitedStatus,
    };
    // A Search error may retry only after a *consumable* external state change.
    // The error identity is intentionally separate from autoResumedBoardScanRef:
    // that latch also carries cleanup/combine tokens whose prefixes cannot prove
    // that a Search changed. We defer clearing until after selected-platform
    // verification is no longer pending below.
    // `canRetryBoardRecoveryAfterError` is the single decision point: the
    // Search-key rule this local name has always meant, plus the awaited-source
    // rule that stops a directly-set recovery error from being sticky forever.
    const searchRecoveryError = searchRecoveryErrorRef.current;
    const hasChangedSearchRecoveryInput = plan.phase === 'searches'
      && canRetryBoardRecoveryAfterError({
        plan,
        recoveryError,
        searchRecoveryError,
        recoveryKey,
        awaitedStatus,
      });
    // Most recovery errors are published directly with `setRecoveryError(...)`
    // and so never record the key they were raised under. The Search rule above
    // cannot see those, which left this effect dead even when the exact awaited
    // source then finished. Removing the local Search identity narrows the same
    // helper to its awaited-source rule, so this flag names the admitting rule.
    const awaitedSourceAdmittedRetry = !!recoveryError && canRetryBoardRecoveryAfterError({
      plan,
      recoveryError,
      searchRecoveryError: null,
      recoveryKey,
      awaitedStatus,
    });
    // Reload recovery needs a file-scoped sidecar. The only no-file exception
    // is a run this mounted Board started itself: source-card resolution is an
    // in-memory continuation of that exact transaction, not durable recovery.
    const canResumePlanInThisRenderer = !!canvasFilePath
      || inMemoryUntitledBoardRunIdsRef.current.has(plan.boardRunId);
    if (
      !canResumePlanInThisRenderer
      || data.locked
      || data.boardCancellation
      || (recoveryError && !hasChangedSearchRecoveryInput)
      || scanRunRef.current
      || scanPreflightRef.current
      || combineRunRef.current
      || cancellationInFlightRef.current
    ) return;
    const setSearchRecoveryError = (message) => {
      // Associate the error with this immutable external state. The next real
      // Search/verification transition gets a different key and can retry;
      // progress writes do not.
      searchRecoveryErrorRef.current = { key: recoveryKey, message };
      setRecoveryError(message);
    };

    const clearMatchingPlan = () => {
      clearExactBoardScanResume(updateGlobal, id, plan.boardRunId);
    };
    const runClaimedRecoveryOperation = (operation, callback) => {
      void (async () => {
        const claim = await claimJobBoardProcessLease({
          canvasFilePath,
          nodeId: id,
          boardRunId: plan.boardRunId,
          operation,
          autoResume: true,
          waitForRelease: true,
        });
        if (claim.error) {
          EventLogger.log(
            `[JobBoard] recovery operation not admitted in this window id=${id}`
            + ` run=${plan.boardRunId} operation=${operation} reason=${claim.error}`,
          );
          return;
        }
        try {
          await callback();
        } finally {
          await releaseJobBoardProcessLease(canvasFilePath, id, plan.boardRunId, claim);
        }
      })();
    };

    const pendingChildCleanups = plan.cancellationCleanupsBySource || (
      plan.cancellationCleanup?.sourceId ? { [plan.cancellationCleanup.sourceId]: plan.cancellationCleanup } : {}
    );
    if (Object.keys(pendingChildCleanups).length > 0) {
      const key = `cleanup:${recoveryKey}:${Object.keys(pendingChildCleanups).join(',')}`;
      if (autoResumedBoardScanRef.current === key) return;
      autoResumedBoardScanRef.current = key;
      EventLogger.log(`[JobBoard] Retrying interrupted child cleanup id=${id} run=${plan.boardRunId}`);
      runClaimedRecoveryOperation('board-cleanup', () => handleCancelRun());
      return;
    }

    if (plan.phase === 'combine') {
      if (isBoardIndependentManualAiRunId(plan.combineManualAiRunId)) return;
      // The normal Board manual-resume effect below owns a persisted taxonomy /
      // compensation prompt. If no prompt was published before the interruption,
      // restart only the combine from the completed source snapshots.
      if (isBoardCombineManualAiRunId(data.manualAiResume?.runId)) return;
      const key = `combine:${recoveryKey}:${plan.combineManualAiRunId || 'unclaimed'}`;
      if (autoResumedBoardScanRef.current === key) return;
      autoResumedBoardScanRef.current = key;
      EventLogger.log(`[JobBoard] Resuming interrupted combine id=${id} run=${plan.boardRunId}`);
      runClaimedRecoveryOperation('board-combine', async () => {
        const outcome = await handleCombine({
          afterSearch: true,
          recoveryAttempt: true,
          expectedBoardRunId: plan.boardRunId,
          manualAiRunId: plan.combineManualAiRunId || undefined,
          expectedCombineSignature: plan.combineInputSignature || null,
          expectedSourceRuns: plan.completedSourceRuns || null,
          expectedCombineSourceRuns: plan.combineSourceRuns || null,
        });
        if (settleRecoveredCombine(outcome, plan.boardRunId)) clearMatchingPlan();
      });
      return;
    }

    const savedAiSources = [plan.activeSourceId, ...(plan.activeSourceIds || [])].filter(Boolean);
    const terminalCleanupPending = selectedSearchModuleIds.some(sourceId => (
      getNode(sourceId)?.data?.terminalFinalizationRecovery?.kind === 'terminal-finalization'
    ));
    if (!terminalCleanupPending && savedAiSources.some(sourceId => jobBoardHasSavedAiContinuation({
      plan, boardNodeId: id, node: getNode(sourceId),
      connected: getEdges().some(edge => (edge.source === id && edge.target === sourceId)
        || (edge.target === id && edge.source === sourceId)),
    }))) {
      setSearchRecoveryError('Saved AI handoffs are paused after restart. Choose Continue saved AI handoff to resume unfinished batches using the accepted answers already saved.');
      return;
    }

    if (selectedSearchModuleIds.length === 0) {
      clearMatchingPlan();
      return;
    }
    const recoveryWaitingForVerification = selectedSearchModuleIds.some((sourceId) => (
      moduleSearchReadiness(getNode(sourceId), relevantVerifyingPlatforms).statusLabel === 'Checking connections'
    ));
    if (recoveryWaitingForVerification) {
      // A verification wait is never terminal. If a prior effect turn claimed
      // this recovery key, let the changed verification signature re-admit the
      // same durable plan once the session settles.
      autoResumedBoardScanRef.current = null;
      return;
    }

    const completedSourceRuns = { ...(plan.completedSourceRuns || {}) };
    const incompleteSearches = Array.isArray(plan.incompleteSearches)
      ? plan.incompleteSearches.map(entry => ({ ...entry }))
      : [];
    const activeSourceId = typeof plan.activeSourceId === 'string' ? plan.activeSourceId : null;
    const awaitingSourceResolution = plan.awaitingSourceResolution;
    const planActiveSourceIds = [...new Set([
      ...(Array.isArray(plan.activeSourceIds) ? plan.activeSourceIds : []),
      activeSourceId,
    ].filter(Boolean))];
    const planAwaitingSourceResolutions = [
      ...(Array.isArray(plan.awaitingSourceResolutions) ? plan.awaitingSourceResolutions : []),
      awaitingSourceResolution,
    ].filter((descriptor, index, descriptors) => (
      descriptor?.sourceId
      && descriptors.findIndex(item => item?.sourceId === descriptor.sourceId) === index
    ));
    // A source-card continuation can already be waiting on a manual-AI handoff
    // when this Board mounts. Preserve its original source/run proof through
    // Board admission too: the child can settle while this Board waits behind
    // the source-card lane, and the lane-turn guard needs that proof to consume
    // the resulting terminal receipt rather than start a replacement search.
    let exactReplayHandoff = false;

    if (awaitingSourceResolution?.sourceId === activeSourceId) {
      const source = getNode(activeSourceId);
      const sourceData = source?.data || {};
      const remainsConnected = getEdges().some((edge) => (
        (edge.source === id && edge.target === activeSourceId)
        || (edge.target === id && edge.source === activeSourceId)
      ));
      const disconnectCancellationKey = `${plan.boardRunId}:${activeSourceId}`;
      if (!remainsConnected && disconnectCancellationRef.current === disconnectCancellationKey) {
        // Edge removal synchronously starts exact child cancellation in the
        // preceding effect. Its success clears this plan asynchronously; do
        // not publish a competing paused-source recovery error in that window.
        // A cancellation failure still reports from that effect's catch path.
        return;
      }
      const expectedRunId = awaitingSourceResolution.jobRunId;
      const sourceRecoveryOwner = sourceData.manualAiResume?.runId
        ? findJobSearchBoardRecoveryOwner(
            activeSourceId,
            sourceData.manualAiResume.runId,
            getNodes(),
            getEdges(),
          )
        : findJobSearchBoardActiveRecoveryOwner(activeSourceId, getNodes(), getEdges());
      // New manual-AI markers record the Search generation that created their
      // request. A same-node marker for a newer/other generation must never
      // consume this Board's paused source handoff. Old saves had no such
      // field, so retain their existing exact-owner fallback for migration.
      const manualHandoffMatchesPausedGeneration = !Object.hasOwn(
        sourceData.manualAiResume || {},
        'jobRunId',
      ) || sourceData.manualAiResume?.jobRunId === expectedRunId;
      exactReplayHandoff = (
        sourceData.manualAiResume?.runId
        && manualHandoffMatchesPausedGeneration
        && sourceRecoveryOwner?.orchestratorNodeId === id
        && sourceRecoveryOwner?.boardRunId === plan.boardRunId
      ) || (
        sourceData.terminalFinalizationRecovery?.runId === expectedRunId
        && sourceRecoveryOwner?.orchestratorNodeId === id
        && sourceRecoveryOwner?.boardRunId === plan.boardRunId
      );
      const pausedContinuation = exactPausedSourceContinuation(
        plan,
        activeSourceId,
        sourceData,
      );
      // Do not let a source reset/re-run or a stale completion consume this
      // Board receipt. The source-card continuation is authorized only for the
      // exact paused generation recorded above.
      if (
        !source
        || source.type !== 'jobhub'
        || !remainsConnected
        || typeof expectedRunId !== 'string'
        || !expectedRunId
        || sourceData.jobRunId !== expectedRunId
      ) {
        if (exactReplayHandoff) {
          // Save sanitization can temporarily restore an in-flight manual-AI
          // scorer as `empty` while retaining its exact durable marker. The
          // Board still owns that handoff, so re-enter its registered executor
          // below instead of turning a reload into a permanent failure.
        } else {
          setSearchRecoveryError('The paused Job Search changed before it could finish. Cancel this Board run or resolve the original search again.');
          return;
        }
      }
      if (
        !exactReplayHandoff
        && !pausedContinuation
        && (sourceData.hubState === 'sources-ready' || ACTIVE_SEARCH_STATES.has(sourceData.hubState))
      ) {
        // The exact source-card continuation owns its own shared-lane turn.
        // Keep this Board transaction parked until it publishes its terminal
        // receipt; polling/reacquiring here could deadlock behind that turn.
        return;
      }
      const terminal = terminalJobSearchOutcome(source);
      if (exactReplayHandoff || pausedContinuation) {
        // Leave activeSourceId and the immutable handoff intact for the
        // resumed Board executor below. `pausedContinuation` is either the
        // clean source-card handoff or the save-sanitized scoring replay, both
        // bound to the same Board/Search run tokens.
      } else if (!terminal || terminal.runId !== expectedRunId) {
        setSearchRecoveryError(sourceData.errorMessage || 'The paused Job Search did not finish cleanly. Resolve it or cancel this Board run.');
        return;
      } else if (!isMergeableTerminalJobSearchOutcome(source, terminal)) {
        incompleteSearches.push({
          sourceId: activeSourceId,
          label: moduleLabel(sourceData),
          status: 'non-mergeable',
          error: nonMergeableSearchMessage(sourceData),
        });
      } else {
        completedSourceRuns[activeSourceId] = terminal;
      }
    }
    const retainedRecoverableFailure = plan.recoverableFailure?.sourceId === activeSourceId
      ? plan.recoverableFailure
      : null;

    if (
      activeSourceId
      && !completedSourceRuns[activeSourceId]
      && !incompleteSearches.some(entry => entry?.sourceId === activeSourceId)
    ) {
      const source = getNode(activeSourceId);
      const connected = getEdges().some(edge => (
        (edge.source === id && edge.target === activeSourceId)
        || (edge.target === id && edge.source === activeSourceId)
      ));
      const sourceData = source?.data || {};

      const pausedContinuation = exactPausedSourceContinuation(
        plan,
        activeSourceId,
        sourceData,
      );
      if (retainedRecoverableFailure) {
        // The previous renderer reached a terminal result but could not prove
        // snapshot/manifest finalization. Keep the exact child active so Retry
        // re-enters its staged ledger instead of converting the durable error
        // into an ordinary incomplete row and discarding the Board receipt.
      } else if (pausedContinuation) {
        // Keep the exact source-resolution descriptor through queue admission.
        // The child executor validates it again before continuing either the
        // in-memory paused scorer or its staged ledger.
      } else if (!source || source.type !== 'jobhub' || !connected) {
        // Leave the interrupted child active. The resumed scan loop first
        // invokes exact cancellation while this durable plan still proves
        // ownership, then records the disconnected module as incomplete.
      } else if (sourceData.manualAiResume?.runId) {
        // Re-enter the registered child executor below with this exact durable
        // descriptor. The parent Board reacquires the queue lease and keeps
        // orchestration ownership across the restart.
      } else if (ACTIVE_SEARCH_STATES.has(sourceData.hubState)) {
        return;
      } else {
        const baseline = plan.baselineSourceRuns?.[activeSourceId] || {};
        const current = {
          runId: sourceData.jobRunId || null,
          resultDisposition: sourceData.resultDisposition || null,
          fingerprint: moduleCombineFingerprint(
            sourceData.scoredJobs,
            sourceData.locationSnapshot?.remoteResidences || sourceData.remoteResidences || {},
          ),
        };
        const changedFromBaseline = current.runId !== (baseline.runId || null)
          || current.resultDisposition !== (baseline.resultDisposition || null)
          || current.fingerprint !== baseline.fingerprint;
        // Save sanitization intentionally exposes the previous scoredJobs while
        // an in-flight Search is interrupted. Those old rows can differ from
        // the baseline after fresh-run metadata was cleared, but that is not a
        // completion receipt. Only a terminal run id + disposition proves the
        // child committed before the crash; otherwise resume its staged ledger.
        const hasCredibleTerminalReceipt = typeof current.runId === 'string'
          && current.runId.length > 0
          && typeof current.resultDisposition === 'string'
          && current.resultDisposition.length > 0;
        if (
          sourceData.hubState === 'done'
          && !sourceData.errorMessage
          && changedFromBaseline
          && hasCredibleTerminalReceipt
        ) {
          const terminal = terminalJobSearchOutcome(source);
          if (!terminal) {
            incompleteSearches.push({
              sourceId: activeSourceId,
              label: moduleLabel(sourceData),
              status: 'incomplete',
              error: sourceData.errorMessage
                || 'This Job Search completed with incomplete results and cannot be combined.',
            });
          } else if (!isMergeableTerminalJobSearchOutcome(source, terminal)) {
            incompleteSearches.push({
              sourceId: activeSourceId,
              label: moduleLabel(sourceData),
              status: 'non-mergeable',
              error: nonMergeableSearchMessage(sourceData),
            });
          } else {
            completedSourceRuns[activeSourceId] = terminal;
          }
        } else if (sourceData.hubState === 'sources-ready') {
          incompleteSearches.push({
            sourceId: activeSourceId,
            label: moduleLabel(sourceData),
            status: 'paused',
            error: 'Resolve or skip its blocked sources first.',
          });
        } else if (sourceData.errorMessage) {
          incompleteSearches.push({
            sourceId: activeSourceId,
            label: moduleLabel(sourceData),
            status: 'failed',
            error: sourceData.errorMessage,
          });
        }
        // An unchanged idle source means the interrupted step never committed;
        // leave it out of both maps so the resumed Board reruns it exactly once.
      }
    }

    const retainActiveSource = activeSourceId
      && !completedSourceRuns[activeSourceId]
      && !incompleteSearches.some(entry => entry?.sourceId === activeSourceId);
    const retainedPausedDescriptor = (
      exactReplayHandoff
      || exactPausedSourceContinuation(
        plan,
        activeSourceId,
        getNode(activeSourceId)?.data || {},
      )
    );
    // A completed first source may be observed by recovery before the regular
    // scan handler gets its next turn. Promote the next exact paused child in
    // that case, retaining every outstanding child rollback instead of
    // flattening a multi-handoff receipt back to the legacy singular fields.
    const promotedPausedSources = !retainActiveSource && activeSourceId
      ? promoteJobBoardPausedSourceResolution({
        awaitingSourceResolutions: planAwaitingSourceResolutions,
        activeSourceId,
        activeSourceIds: planActiveSourceIds,
        activeSourceRollbacks: plan.activeSourceRollbacks || {},
        activeSourceManualAiRunIds: plan.activeSourceManualAiRunIds || {},
        consumedSourceId: activeSourceId,
      })
      : null;
    const resumedPlan = {
      ...plan,
      selectedSearchModuleIds,
      completedSourceRuns,
      incompleteSearches,
      awaitingSourceResolution: retainedPausedDescriptor
        ? awaitingSourceResolution
        : (promotedPausedSources?.awaitingSourceResolution || null),
      awaitingSourceResolutions: retainedPausedDescriptor
        ? planAwaitingSourceResolutions
        : (promotedPausedSources?.awaitingSourceResolutions || []),
      // Preserve the interrupted child identity long enough for the scan
      // handler to forward either its manual-AI descriptor or its staged
      // scrape-recovery intent to that executor.
      activeSourceId: retainActiveSource
        ? activeSourceId
        : (promotedPausedSources?.activeSourceId || null),
      activeSourceIds: retainActiveSource
        ? planActiveSourceIds
        : (promotedPausedSources?.activeSourceIds || []),
      activeSourceRollback: retainActiveSource
        ? (plan.activeSourceRollbacks?.[activeSourceId] || plan.activeSourceRollback || null)
        : (promotedPausedSources?.activeSourceRollback || null),
      activeSourceRollbacks: retainActiveSource
        ? (plan.activeSourceRollbacks || (activeSourceId && plan.activeSourceRollback
          ? { [activeSourceId]: plan.activeSourceRollback }
          : {}))
        : (promotedPausedSources?.activeSourceRollbacks || {}),
      activeSourceManualAiRunIds: retainActiveSource
        ? (plan.activeSourceManualAiRunIds || {})
        : (promotedPausedSources?.activeSourceManualAiRunIds || {}),
      phase: 'searches',
    };
    // `updatedAt` changes for progress-only writes. It is not recovery
    // authority, and using it here can repeatedly re-enter the same mounted
    // renderer's plan. A fresh explicit run gets a new boardRunId; genuine
    // deferred recovery paths clear this latch deliberately.
    if (recoveryError && hasChangedSearchRecoveryInput) {
      // We reached a state the resumed Search can actually consume: no
      // selected-platform check is pending and no earlier recovery branch
      // parked this exact transaction. Clear only this associated Search error
      // immediately before re-admission.
      searchRecoveryErrorRef.current = null;
      setRecoveryError(null);
    }
    if (awaitedSourceAdmittedRetry) {
      // The awaited source finished with the exact generation this plan
      // recorded, which is the one fact a direct `setRecoveryError(...)` could
      // never express. Also reset the re-admission latch: re-entering this same
      // `recoveryKey` under a sticky error is the deadlock being recovered from.
      const awaitedRunId = plan.awaitingSourceResolution?.jobRunId
        || (Array.isArray(plan.awaitingSourceResolutions) ? plan.awaitingSourceResolutions : [])
          .find(entry => entry?.jobRunId)?.jobRunId
        || '';
      autoResumedBoardScanRef.current = null;
      EventLogger.log(`[JobBoard] recovery error cleared: awaited source finished id=${id} run=${awaitedRunId}`);
    }
    if (autoResumedBoardScanRef.current === recoveryKey) return;
    if (!isCurrentBoardScanResume(getNode(id)?.data?.boardScanResume, plan)) {
      // `clearExactBoardScanResume` may have committed between this effect's
      // render snapshot and its async recovery work. Do not log or launch a
      // ghost retry from the now-retired plan.
      autoResumedBoardScanRef.current = null;
      return;
    }
    autoResumedBoardScanRef.current = recoveryKey;
    EventLogger.log(`[JobBoard] Resuming interrupted selected search id=${id} run=${plan.boardRunId}`);
    void handleSearchSelected({ resumeBoardScan: true, plan: resumedPlan });
  }, [boardRecoverySig, canvasFilePath, combining, connectedSig, data.boardCancellation, data.boardScanResume, data.locked, data.manualAiResume, deletionLifecycleRevision, getEdges, getNode, getNodes, handleCancelRun, handleCombine, handleSearchSelected, id, recoveryError, scanning, settleRecoveredCombine, updateGlobal, verifyingPlatforms]);

  useEffect(() => {
    let pausing = false;
    const onPause = (event) => {
      const detail = event?.detail || {};
      if (detail.nodeId !== id) return;
      const active = activeCombineManualAiRunRef.current;
      if (pausing || !active?.runId || active.runId !== detail.runId
        || active.token !== combineRunRef.current) return;
      detail.accept?.();
      pausing = true;
      void pauseBoardCombine({
        runId: detail.runId,
        getMarker: () => getNode(id)?.data?.manualAiResume,
        saveMarker: marker => updateGlobal(id, { manualAiResume: marker }),
        waitForCommit: async () => {
          for (let attempt = 0; attempt < 4; attempt++) {
            await waitForBoardRendererCommitFrame();
            if (getNode(id)?.data?.manualAiResume?.pausedByUser === true) return;
          }
        },
        fence: () => { epoch.bump(); },
        pauseBackend: () => window.electronAPI?.pauseJobRunAndCancel?.({
          canvasFilePath, nodeId: id, cause: 'user-paused-board',
        }),
        settle: () => {
          if (combineRunRef.current === active.token) combineRunRef.current = null;
          if (activeCombineManualAiRunRef.current === active) activeCombineManualAiRunRef.current = null;
          compensationRequestIdRef.current = null;
          setCompensationProgress(null);
          setCombineResearchProgress(null);
          setCombining(false);
          setRecoveryError(SAVED_HANDOFF_READY_MESSAGE);
          EventLogger.log(`[JobBoard] Pause & save acknowledged id=${id} run=${detail.runId}`);
        },
      }).then(detail.acknowledge, error => {
        // pauseBoardCombine took its paused mark back when the app process did
        // not confirm. Say so on the Board; the set error also holds automatic
        // re-entry of this Combine until the person chooses Retry.
        if (error?.pauseMarkRestored) {
          EventLogger.log(`[JobBoard] Pause & save not confirmed id=${id} run=${detail.runId} reason=${error.pauseRefusalReason || 'none'} marks=restored`);
          // The fence above already made this window's Combine let go, and its
          // own exit does not clear the busy state once fenced. Release it here
          // (as a confirmed pause does) so the statement and Retry can show.
          if (combineRunRef.current === active.token) combineRunRef.current = null;
          if (activeCombineManualAiRunRef.current === active) activeCombineManualAiRunRef.current = null;
          compensationRequestIdRef.current = null;
          setCompensationProgress(null);
          setCombineResearchProgress(null);
          setCombining(false);
          pauseRefusalMessageRef.current = error.message;
          setRecoveryError(error.message);
        }
        detail.acknowledge?.({ success: false, error: error?.message || 'The Job Board could not pause.' });
      }).finally(() => { pausing = false; });
    };
    document.addEventListener('job-search-pause-and-save', onPause);
    return () => document.removeEventListener('job-search-pause-and-save', onPause);
  }, [canvasFilePath, epoch, getNode, id, updateGlobal]);

  useEffect(() => {
    const onManualAiNodeCancelled = (event) => {
      // Career imports and card research own their own cancellation, even when
      // they use this Board as their handoff hub.
      if (!isBoardCombineManualAiRunId(event.detail?.runId)) return;
      const cancelledNodeId = event.detail?.nodeId || null;
      const childPlan = getNode(id)?.data?.boardScanResume || null;
      const activeChildIds = new Set([
        ...activeSearchModuleIdsRef.current,
        ...(Array.isArray(childPlan?.activeSourceIds) ? childPlan.activeSourceIds : []),
        childPlan?.activeSourceId,
      ].filter(Boolean));
      const childMarker = cancelledNodeId && cancelledNodeId !== id
        ? getNode(cancelledNodeId)?.data?.manualAiResume
        : null;
      const rememberedChildRun = cancelledNodeId
        ? activeSearchManualAiRunIdsRef.current.get(cancelledNodeId)
        : null;
      const persistedChildRunId = cancelledNodeId
        ? childPlan?.activeSourceManualAiRunIds?.[cancelledNodeId]
        : null;
      const cancelledActiveChild = !!(
        cancelledNodeId
        && activeChildIds.has(cancelledNodeId)
        && (
          (
            childMarker?.orchestratorNodeId === id
            && childMarker?.boardRunId === childPlan?.boardRunId
            && childMarker?.runId === event.detail?.runId
          )
          || (
            rememberedChildRun?.boardRunId === childPlan?.boardRunId
            && rememberedChildRun.runId === event.detail?.runId
          )
          || (
            childPlan?.boardRunId
            && persistedChildRunId === event.detail?.runId
          )
        )
      );
      if (cancelledNodeId !== id && !cancelledActiveChild) return;
      const cancelledRunId = event.detail?.runId || null;
      // Modern notifications always identify the exact request. A legacy or
      // malformed node-only event has no authority to cancel whichever newer
      // Board transaction happens to be active when it arrives.
      if (!cancelledRunId) {
        EventLogger.log(`[JobBoard] ignored manual-AI cancellation without a run id=${id}`);
        return;
      }
      if (cancelledActiveChild) {
        // One child dialog cancellation ends this exact Board transaction.
        // `handleCancelRun` fans cancellation out through every active child;
        // do this before the Board-only run-id checks below, which intentionally
        // know nothing about Search-owned manual handoffs.
        EventLogger.log(`[JobBoard] child manual-AI cancellation aborting fan-out id=${id} run=${childPlan.boardRunId} source=${cancelledNodeId}`);
        void handleCancelRun();
        return;
      }
      const liveData = getNode(id)?.data || {};
      const persistedCommittedRun = liveData.manualAiResume?.retirementPending === true
        && liveData.manualAiResume?.committedResult === true
        && liveData.manualAiResume?.runId === cancelledRunId;
      if (
        cancelledRunId
        && (
          committedCombineManualAiRunIdsRef.current.has(cancelledRunId)
          || persistedCommittedRun
        )
      ) {
        // Completion/cancellation notifications share the same renderer event
        // channel. Once this exact run committed the new Board, the only legal
        // continuation is idempotent durable retirement; routing it through
        // handleCancelRun would falsely claim the committed cascade rolled back.
        void retireActiveCombineManualAiRun(cancelledRunId, 'post-commit-cleanup').catch((error) => {
          EventLogger.error(`[JobBoard] committed manual-AI handoff cleanup failed id=${id} run=${cancelledRunId}:`, error);
        });
        return;
      }
      const persistedRunId = liveData.manualAiResume?.runId || null;
      const activeRunId = activeCombineManualAiRunRef.current?.runId || null;
      const planRunId = liveData.boardScanResume?.combineManualAiRunId || null;
      const cancellationOwnsRun = Array.isArray(liveData.boardCancellation?.manualAiRunIds)
        && liveData.boardCancellation.manualAiRunIds.includes(cancelledRunId);
      const belongsToCurrentTransaction = cancellationOwnsRun
        || (activeRunId
          ? activeRunId === cancelledRunId
          : liveData.boardScanResume?.boardRunId
            ? planRunId === cancelledRunId
            : persistedRunId === cancelledRunId);
      // Current renderers include runId. A stale exact event may retire its old
      // backend handoff, but it must not cancel the newer Board transaction.
      if (
        cancelledRunId
        && !belongsToCurrentTransaction
      ) {
        void retireActiveCombineManualAiRun(cancelledRunId).catch((error) => {
          EventLogger.error(`[JobBoard] stale manual-AI handoff cleanup failed id=${id} run=${cancelledRunId}:`, error);
        });
        return;
      }
      // Cancel the complete transaction, including a recovered Combine that is
      // still queued. Merely clearing the marker lets that queued callback
      // recreate the same prompt after the user has cancelled it.
      handleCancelRun();
    };
    document.addEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled);
    return () => document.removeEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled);
  }, [getNode, handleCancelRun, id, retireActiveCombineManualAiRun]);

  useEffect(() => {
    const onPending = (event) => {
      const detail = event.detail || {};
      if (!detail.runId) return;
      // Card research and career imports share the handoff hub, but never own
      // Combine recovery or superseded-Combine retirement.
      if (!isBoardCombineManualAiRunId(detail.runId)) return;
      const liveData = getNode(id)?.data || {};
      const childPlan = liveData.boardScanResume;
      const childActiveIds = new Set([
        ...activeSearchModuleIdsRef.current,
        ...(Array.isArray(childPlan?.activeSourceIds) ? childPlan.activeSourceIds : []),
        childPlan?.activeSourceId,
      ].filter(Boolean));
      const childPendingCandidate = detail.nodeId !== id
        && childActiveIds.has(detail.nodeId)
        && childPlan?.phase === 'searches'
        && childPlan?.boardRunId;
      if (childPendingCandidate) {
        const expectedBoardRunId = childPlan.boardRunId;
        const expectedScanToken = scanRunRef.current;
        // JobSearch may write its marker in its own event listener after this
        // Board listener. Delay only the correlation capture until that React
        // commit boundary; UI has not painted a cancellable dialog yet. Recheck
        // every ownership fence so an old queued callback cannot annotate a
        // newer Board run.
        const captureChildPending = () => {
          const currentPlan = getNode(id)?.data?.boardScanResume;
          const childMarker = getNode(detail.nodeId)?.data?.manualAiResume;
          if (
            (expectedScanToken && scanRunRef.current !== expectedScanToken)
            || currentPlan?.phase !== 'searches'
            || currentPlan.boardRunId !== expectedBoardRunId
            || !Array.isArray(currentPlan.activeSourceIds)
            || !currentPlan.activeSourceIds.includes(detail.nodeId)
            || childMarker?.orchestratorNodeId !== id
            || childMarker?.boardRunId !== expectedBoardRunId
            || childMarker?.runId !== detail.runId
          ) return;
          activeSearchManualAiRunIdsRef.current.set(detail.nodeId, {
            boardRunId: expectedBoardRunId,
            runId: detail.runId,
          });
          // Persist the same correlation before returning to the dialog. A
          // renderer restart between pending and cancel must retain the fence;
          // the cancellation handler still requires the exact run id.
          updateGlobal(id, (node) => {
            const plan = node?.data?.boardScanResume;
            if (
              plan?.phase !== 'searches'
              || plan.boardRunId !== expectedBoardRunId
              || !Array.isArray(plan.activeSourceIds)
              || !plan.activeSourceIds.includes(detail.nodeId)
            ) return null;
            return {
              boardScanResume: {
                ...plan,
                activeSourceManualAiRunIds: {
                  ...(plan.activeSourceManualAiRunIds || {}),
                  [detail.nodeId]: detail.runId,
                },
                updatedAt: Date.now(),
              },
            };
          });
        };
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(captureChildPending);
        } else {
          Promise.resolve().then(captureChildPending);
        }
        return;
      }
      if (detail.nodeId !== id) return;
      if (retiredCombineManualAiRunIdsRef.current.has(detail.runId)) return;
      const persistedCommittedRun = liveData.manualAiResume?.retirementPending === true
        && liveData.manualAiResume?.committedResult === true
        && liveData.manualAiResume?.runId === detail.runId;
      if (
        committedCombineManualAiRunIdsRef.current.has(detail.runId)
        || persistedCommittedRun
      ) {
        // The provider can post its last pending notification in the same turn
        // the renderer commits. Never recreate a resumable Combine marker for
        // an already displayed result; retry only the exact cleanup ledger.
        void retireActiveCombineManualAiRun(detail.runId, 'post-commit-cleanup').catch((error) => {
          EventLogger.error(`[JobBoard] late committed manual-AI pending cleanup failed id=${id} run=${detail.runId}:`, error);
        });
        return;
      }
      const active = activeCombineManualAiRunRef.current;
      const livePlan = liveData.boardScanResume;
      if (
        !active?.runId
        && (
          (scanRunRef.current && livePlan?.combineManualAiRunId !== detail.runId)
          || livePlan?.phase === 'searches'
          || (
            livePlan?.phase === 'combine'
            && livePlan.combineManualAiRunId
            && livePlan.combineManualAiRunId !== detail.runId
          )
        )
      ) {
        EventLogger.log(`[JobBoard] Retiring late manual-AI pending notification superseded by active scan id=${id} run=${detail.runId}`);
        void retireActiveCombineManualAiRun(detail.runId, 'superseded-by-board-scan').catch((error) => {
          EventLogger.error(`[JobBoard] Failed to retire superseded manual-AI run id=${id} run=${detail.runId}:`, error);
        });
        return;
      }
      if (active?.runId && active.runId !== detail.runId) {
        EventLogger.log(`[JobBoard] Retiring stale manual-AI pending notification id=${id} run=${detail.runId}`);
        void retireActiveCombineManualAiRun(detail.runId, 'superseded-by-newer-combine').catch((error) => {
          EventLogger.error(`[JobBoard] Failed to retire stale manual-AI run id=${id} run=${detail.runId}:`, error);
        });
        return;
      }
      rememberBoundedRunId(pendingCombineManualAiRunIdsRef.current, detail.runId);
      const capturedSignature = active?.runId === detail.runId
        ? active.combineInputSignature
        : combineInputSignaturesRef.current.get(detail.runId);
      const capturedSourceRuns = active?.runId === detail.runId
        ? active.combineSourceRuns
        : combineSourceRunsRef.current.get(detail.runId);
      updateGlobal(id, (node) => {
        const existing = node?.data?.manualAiResume;
        if (
          existing?.runId
          && existing.runId !== detail.runId
          && active?.runId !== detail.runId
        ) return null;
        const sameRun = existing?.runId === detail.runId;
        const startedAt = (sameRun
          ? normalizeJobBoardRecoveryTimestamp(existing?.startedAt)
          : null)
          ?? (active?.runId === detail.runId
            ? normalizeJobBoardRecoveryTimestamp(active.startedAt)
            : null)
          ?? Date.now();
        return { manualAiResume: {
          ...(sameRun ? existing : {}),
          runId: detail.runId,
          task: detail.task || null,
          stepKey: detail.stepKey || null,
          recoveryMode: detail.recoveryMode || null,
          combineInputSignature: capturedSignature ?? (sameRun ? existing.combineInputSignature : null) ?? null,
          combineSourceRuns: capturedSourceRuns ?? (sameRun ? existing.combineSourceRuns : null) ?? null,
          // Recovery arbitration must use admission order, not the time of the
          // latest prompt in a multi-step manual run. Preserve this for every
          // subsequent pending event carrying the same run token.
          startedAt,
          updatedAt: Date.now(),
        } };
      });
    };
    document.addEventListener('non-api-ai-node-pending', onPending);
    return () => {
      document.removeEventListener('non-api-ai-node-pending', onPending);
    };
  }, [getNode, id, retireActiveCombineManualAiRun, updateGlobal]);

  useEffect(() => {
    // Independent workflows retire through their actual owner's lifecycle.
    const receipts = normalizeManualAiCleanupReceipts(data.manualAiCleanupReceipts)
      .filter(receipt => isBoardCombineManualAiRunId(receipt?.runId));
    if (receipts.length === 0) return;
    // The interactive deletion boundary owns acknowledged retirement while it
    // is pending. Starting a second recovery attempt here can race that exact
    // snapshot/receipt transaction; lifecycle settlement will rerun this effect
    // if deletion is aborted and the Board is retained.
    if (isJobWorkflowDeletionPending(id)) return;
    const liveData = getNode(id)?.data || data;
    const hasCurrentRecovery = !!liveData.boardCancellation
      || !!liveData.boardScanResume
      || isBoardCombineManualAiRunId(liveData.manualAiResume?.runId);
    if (liveData.boardCancellation) return;
    const next = receipts.find(receipt => (
      !attemptedSupersededCleanupRunIdsRef.current.has(receipt.runId)
    ));
    if (!next) {
      if (!hasCurrentRecovery) {
        setRecoveryError('An older saved manual-AI handoff still needs cleanup. Retry recovery.');
      }
      return;
    }
    attemptedSupersededCleanupRunIdsRef.current.add(next.runId);
    void retireBoardCleanupReceipt(next).then(() => {
      const after = getNode(id)?.data || {};
      if (
        normalizeManualAiCleanupReceipts(after.manualAiCleanupReceipts).length === 0
        && !after.boardCancellation
        && !after.boardScanResume
        && !after.manualAiResume
      ) setRecoveryError(null);
    }).catch((error) => {
      EventLogger.error(`[JobBoard] Superseded manual-AI cleanup retry failed id=${id} run=${next.runId}:`, error);
      const after = getNode(id)?.data || {};
      if (!after.boardCancellation && !after.boardScanResume && !after.manualAiResume) {
        setRecoveryError(error?.message || 'An older saved manual-AI handoff still needs cleanup.');
      }
    });
  }, [data, deletionLifecycleRevision, getNode, id, retireBoardCleanupReceipt]);

  // Self-heal canvases saved while an independent handoff was wrongly adopted
  // as Board recovery. Its actual owner retains the backend run lifecycle.
  useEffect(() => {
    const liveData = getNode(id)?.data || data;
    const patch = boardIndependentManualAiMarkerCleanup(liveData);
    if (!patch) return;
    const runIds = [
      ...(patch.manualAiResume === null ? [liveData.manualAiResume?.runId] : []),
      ...(Array.isArray(liveData.manualAiCleanupReceipts)
        ? liveData.manualAiCleanupReceipts.map(receipt => receipt?.runId)
        : []),
      ...(Array.isArray(liveData.boardCancellation?.manualAiRunIds)
        ? liveData.boardCancellation.manualAiRunIds
        : []),
    ].filter(isBoardIndependentManualAiRunId);
    updateGlobal(id, node => boardIndependentManualAiMarkerCleanup(node?.data));
    EventLogger.log(`[JobBoard] cleared independent run from Board recovery state id=${id} run=${[...new Set(runIds)].join(',')}`);
  }, [data, getNode, id, updateGlobal]);

  useEffect(() => {
    const resume = data.manualAiResume;
    if (!isBoardCombineManualAiRunId(resume?.runId)) return;
    if (boardRecoveryTouchesPendingDeletion(id, data.boardScanResume, resume)) {
      autoResumedManualAiRunRef.current = null;
      return;
    }
    if (recoveryError && recoveryError === pauseRefusalMessageRef.current) return;
    if (autoResumedManualAiRunRef.current === resume.runId) return;
    if (retiredCombineManualAiRunIdsRef.current.has(resume.runId)) {
      updateGlobal(id, (node) => (
        node?.data?.manualAiResume?.runId === resume.runId
          ? { manualAiResume: null }
          : null
      ));
      return;
    }
    if (!canvasFilePath) return;
    // The durable marker is legitimate while THIS mount's own combine is
    // running; only a marker restored from disk (no live owner) is an
    // interruption that needs the resume notice. Do not flag or claim it here.
    if (isLiveCombineOwnedMarker(resume.runId, activeCombineManualAiRunRef.current?.runId)) return;
    // A cancellation is in progress for this exact run. Offering "Saved AI
    // handoff ready … Continue" here would present the run the user just
    // cancelled as resumable half-done work.
    if (data.boardCancellation || cancellationInFlightRef.current) return;
    if (resume.retirementPending !== true) {
      const message = SAVED_HANDOFF_READY_MESSAGE;
      autoResumedManualAiRunRef.current = null;
      if (recoveryError !== message) {
        EventLogger.log(`[JobBoard] recovery notice set: saved-handoff-ready id=${id} run=${resume.runId} liveCombine=${!!combineRunRef.current}`);
        setRecoveryError(message);
      }
      return;
    }
    if (combineRunRef.current || data.boardCancellation || data.locked || recoveryError) return;
    if (resume.retirementPending) {
      // A failed durable retirement rewrites this marker with a new updatedAt.
      // Claim the exact run once per mount so that render cannot turn one
      // recovery attempt into an unbounded completeNonApiAiRun retry loop.
      if (attemptedSupersededCleanupRunIdsRef.current.has(resume.runId)) return;
      attemptedSupersededCleanupRunIdsRef.current.add(resume.runId);
      autoResumedManualAiRunRef.current = resume.runId;
      void retireBoardCleanupReceipt(resume).then(() => {
        updateGlobal(id, (node) => {
          const markerOwned = node?.data?.manualAiResume?.runId === resume.runId;
          const ownsPlan = node?.data?.boardScanResume?.combineManualAiRunId === resume.runId;
          if (!markerOwned && !ownsPlan) return null;
          return {
            ...(markerOwned ? { manualAiResume: null } : {}),
            ...(ownsPlan ? { boardScanResume: null } : {}),
          };
        });
      }).catch((error) => {
        autoResumedManualAiRunRef.current = null;
        setRecoveryError(error?.message || 'Saved manual-AI cleanup did not finish.');
      });
      return;
    }
  }, [canvasFilePath, combining, data.boardCancellation, data.boardScanResume, data.manualAiResume, data.locked, deletionLifecycleRevision, handleCombine, id, readyModules.length, recoveryError, retireBoardCleanupReceipt, settleRecoveredCombine, updateGlobal]);

  // Once the marker that produced the "Saved AI handoff ready" notice is
  // retired (no marker, and no live combine left to own it), the selector
  // must not stay disabled behind a stale recoveryError forever. Recheck when
  // either executor settles: marker retirement can render before finally
  // releases the imperative combine owner.
  useEffect(() => {
    if (!isSavedPauseNotice(recoveryError)) return;
    // An independent handoff never justifies this notice; clear it.
    if (isBoardCombineManualAiRunId(data.manualAiResume?.runId)) return;
    if (data.boardScanResume?.boardRunId) return;
    if (combineRunRef.current) return;
    setRecoveryError(null);
  }, [combining, scanning, data.boardScanResume?.boardRunId, data.manualAiResume?.runId, recoveryError]);



  // An independent handoff is never Board-run recovery (self-healed above).
  const durableRecoveryActive = !!data.boardCancellation || !!data.boardScanResume
    || isBoardCombineManualAiRunId(data.manualAiResume?.runId);
  const cancellationCleanupActive = hasPendingManualAiRetirement(data);
  // --- Board career override (career data for applications) ---------------
  // Independent of Board runs: it never writes combine/scan markers and uses
  // its own `job-board-career:` run ids. Cards only read the approved id.
  const retireCareerOverrideRuns = useCallback(async () => {
    const live = getNode(id)?.data;
    const record = live?.jobBoardCareerOverride;
    const runIds = Array.isArray(record?.retirePending) ? [...record.retirePending] : [];
    if (runIds.length === 0 || !window.electronAPI?.completeNonApiAiRun) return;
    const retired = [];
    for (const runId of runIds) {
      try {
        const result = await window.electronAPI.completeNonApiAiRun(runId);
        if (result?.cleared === true || result?.absent === true) retired.push(runId);
      } catch {
        // Stays queued; retried on the next mount or compile.
      }
    }
    if (retired.length === 0) return;
    updateGlobal(id, node => ({
      jobBoardCareerOverride: markJobBoardCareerOverrideRunsRetired(node?.data, retired),
    }));
  }, [getNode, id, updateGlobal]);

  useEffect(() => {
    // Once per mount: later retries happen before each compile/discard/clear.
    if (careerOverrideMountRetiredRef.current) return;
    careerOverrideMountRetiredRef.current = true;
    void retireCareerOverrideRuns();
  }, [retireCareerOverrideRuns]);

  const compileCareerOverride = useCallback(async ({ filePaths = [], fileNames = [], resume = false } = {}) => {
    if (data.locked || !window.electronAPI?.parseCareerData) return;
    if (careerOverrideRunRef.current || careerOverrideBusy) return;
    if (!resume) {
      const refused = filePaths.length === 0
        || filePaths.some(path => typeof path !== 'string'
          || /\.app[\\/]*$/iu.test(path)
          || !isCareerTextFileName(path));
      if (refused) {
        addToast({ title: 'Only .txt or .md files', description: CAREER_TEXT_ONLY_MESSAGE, type: 'error' });
        return;
      }
    }
    await retireCareerOverrideRuns();
    const live = getNode(id)?.data;
    let record = null;
    let manualAiRunId = null;
    if (resume) {
      const resumed = resumeJobBoardCareerOverride(live);
      if (resumed) {
        record = resumed.record;
        manualAiRunId = resumed.manualAiRunId;
        filePaths = resumed.filePaths;
        fileNames = resumed.fileNames;
      }
    } else {
      record = beginJobBoardCareerOverride(live, { nodeId: id, filePaths, fileNames });
      manualAiRunId = record?.pending?.manualAiRunId || null;
    }
    if (!record || !manualAiRunId) {
      addToast({ title: 'Career data is busy', description: 'Finish or discard the current career compilation first.', type: 'info' });
      return;
    }
    updateGlobal(id, { jobBoardCareerOverride: record });
    careerOverrideRunRef.current = manualAiRunId;
    setCareerOverrideLocalRunId(manualAiRunId);
    setCareerOverrideBusy(true);
    EventLogger.log(`[JobBoard][${id}] Career override compile ${resume ? 'resumed' : 'started'}: ${fileNames.length} file(s)`);
    try {
      const reply = await window.electronAPI.parseCareerData({ filePaths, nodeId: id, manualAiRunId, importModule: 'job-board' });
      if (!reply?.success) {
        throw new Error(reply?.error || 'Career compilation did not return an approved snapshot.');
      }
      // Only the exact live run approves; a superseded completion is stale.
      const approvedNow = !!approveJobBoardCareerOverride(getNode(id)?.data, {
        careerSnapshotId: reply.careerSnapshotId,
        profileFingerprint: reply.fingerprint,
        manualAiRunId,
      });
      updateGlobal(id, node => {
        const next = approveJobBoardCareerOverride(node?.data, {
          careerSnapshotId: reply.careerSnapshotId,
          profileFingerprint: reply.fingerprint,
          manualAiRunId,
        });
        return next ? { jobBoardCareerOverride: next } : null;
      });
      if (approvedNow) {
        addToast({ title: 'Career data ready for applications and salary guidance', description: fileNames.join(', '), type: 'success' });
      } else {
        EventLogger.log(`[JobBoard][${id}] Career override result superseded; not approved`);
      }
      let retiredRun = false;
      try {
        const result = await window.electronAPI.completeNonApiAiRun?.(manualAiRunId);
        retiredRun = result?.cleared === true || result?.absent === true;
      } catch {
        retiredRun = false;
      }
      if (!retiredRun) {
        updateGlobal(id, node => ({
          jobBoardCareerOverride: queueJobBoardCareerOverrideRetire(node?.data, manualAiRunId),
        }));
      }
    } catch (error) {
      const message = error?.message || String(error || 'Failed to compile career files');
      if (message !== 'Node deleted') {
        updateGlobal(id, node => {
          const next = failJobBoardCareerOverride(node?.data, { manualAiRunId, error: message });
          return next ? { jobBoardCareerOverride: next } : null;
        });
        addToast({ title: 'Career data failed', description: message, type: 'error' });
        EventLogger.error(`[JobBoard][${id}] Career override compile failed: ${message}`);
      }
    } finally {
      if (careerOverrideRunRef.current === manualAiRunId) {
        careerOverrideRunRef.current = null;
        setCareerOverrideLocalRunId(current => (current === manualAiRunId ? null : current));
      }
      setCareerOverrideBusy(false);
    }
  }, [addToast, careerOverrideBusy, data.locked, getNode, id, retireCareerOverrideRuns, updateGlobal]);

  const handleCareerOverrideDrop = useCallback((event) => {
    const files = filesToDropPayloads(event?.dataTransfer?.files);
    void compileCareerOverride(careerFileRequest(files));
  }, [compileCareerOverride]);

  const handleCareerOverridePick = useCallback((event) => {
    const input = event?.target;
    const files = filesToDropPayloads(input?.files);
    if (input) input.value = '';
    if (files.length === 0) return;
    void compileCareerOverride(careerFileRequest(files));
  }, [compileCareerOverride]);

  const handleCareerOverrideOpenCanvasFiles = useCallback((event) => {
    event?.stopPropagation?.();
    setCareerCanvasSelections([]);
    setCareerCanvasError(null);
    setCareerCanvasOpen(true);
  }, []);

  const handleCareerOverrideToggleCanvasFile = useCallback((file) => {
    if (!file?.nodeId || !file?.filePath) return;
    setCareerCanvasSelections(current => toggleCareerCanvasFileSelection(current, file));
  }, []);

  const handleCareerOverrideImportCanvasFiles = useCallback(() => {
    // Resolve from the live canvas level at confirmation time.
    const liveFiles = canvasCareerImportCandidates(getNodes());
    const selected = selectedCareerCanvasFiles(liveFiles, careerCanvasSelections);
    if (selected.length === 0) {
      setCareerCanvasError('Select one or more .txt or .md file cards from this canvas.');
      return;
    }
    const filePaths = selected.map(file => file.filePath);
    if (filePaths.some(path => /\.app[\\/]*$/iu.test(path) || !isCareerTextFileName(path))) {
      setCareerCanvasError(CAREER_TEXT_ONLY_MESSAGE);
      return;
    }
    setCareerCanvasOpen(false);
    setCareerCanvasError(null);
    void compileCareerOverride(careerFileRequest(filePaths.map(path => ({ path }))));
  }, [careerCanvasSelections, compileCareerOverride, getNodes]);

  // A canvas document node dragged onto this Board (resolved and gated in
  // useDragCorrections) sets its career data, like the canvas-file picker.
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.hubId !== id || e.detail?.hubType !== 'jobboard') return;
      const files = (e.detail?.files || []).filter(file => typeof file?.filePath === 'string' && file.filePath);
      if (files.length === 0) return;
      void compileCareerOverride(careerFileRequest(files.map(file => ({ path: file.filePath, name: file.filename }))));
    };
    document.addEventListener('canvas-file-nodes-dropped-on-hub', handler);
    return () => document.removeEventListener('canvas-file-nodes-dropped-on-hub', handler);
  }, [compileCareerOverride, id]);

  const handleCareerOverrideResume = useCallback(() => {
    void compileCareerOverride({ resume: true });
  }, [compileCareerOverride]);

  const handleCareerOverrideDiscard = useCallback(() => {
    if (data.locked || careerOverrideRunRef.current) return;
    updateGlobal(id, node => ({ jobBoardCareerOverride: discardJobBoardCareerOverridePending(node?.data) }));
    void retireCareerOverrideRuns();
  }, [data.locked, id, retireCareerOverrideRuns, updateGlobal]);

  const handleCareerOverrideClear = useCallback(() => {
    if (data.locked || careerOverrideRunRef.current) return;
    updateGlobal(id, node => {
      const data = node?.data;
      const view = jobBoardCareerOverrideView(data, { localRunId: careerOverrideRunRef.current, locked: !!data?.locked });
      if (view.state === 'compiling') return null;
      // clear refuses while pending is 'compiling'; an interrupted compile is
      // discarded first so Clear really clears.
      const base = view.state === 'interrupted'
        ? { ...data, jobBoardCareerOverride: discardJobBoardCareerOverridePending(data) }
        : data;
      return { jobBoardCareerOverride: clearJobBoardCareerOverride(base) };
    });
    void retireCareerOverrideRuns();
    addToast({ title: 'Career data for applications cleared', description: 'Job cards go back to the career data of their Job Search.', type: 'info' });
  }, [addToast, data.locked, id, retireCareerOverrideRuns, updateGlobal]);

  const preferenceOverrideView = jobBoardPreferenceOverrideView(data);
  const handlePreferenceOverrideApply = useCallback(async (brief) => {
    updateGlobal(id, node => ({ jobBoardPreferenceOverride: applyJobBoardPreferenceBrief(node?.data, brief) }));
    await waitForRendererCommitFrame();
    return handleCombine({ preferencesJustApplied: true });
  }, [handleCombine, id, updateGlobal]);
  const handlePreferenceOverrideClear = useCallback(async () => {
    updateGlobal(id, { jobBoardPreferenceOverride: null });
    addToast({ title: 'Board preferences cleared', description: 'This Board goes back to each search’s own rules.', type: 'info' });
    await waitForRendererCommitFrame();
    const live = liveCombineInputs(id, getNodes(), getEdges());
    if (live.completed.length === 0) return { status: 'not-ready' };
    if (live.ready.length > 0) return handleCombine({ preferencesJustApplied: true });
    // The searches' own rules pass nothing, so the override's cards have no source left.
    document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
    const applicationCardIds = getNodes().filter(node => node?.data?.hubId === id && isProtectedJobCard(node)).map(node => node.id);
    clearBoardChildren({ preserveNodeIds: applicationCardIds });
    updateGlobal(id, {
      hubState: 'done', resultCount: applicationCardIds.length, moduleCount: live.completed.length,
      scoreThreshold: 0, scoreRangeMin: 0, scoreRangeMax: 100, sourceFilter: null, jobTaxonomy: null, finalSourceCounts: {},
      combineSignature: boardInputSignature(live.completed, live.all), combineSourceRuns: boundedCombinedSourceRuns(live.completed),
      stale: false, staleReason: null, clearProvenance: null,
    });
    return { status: 'completed' };
  }, [addToast, clearBoardChildren, getEdges, getNodes, handleCombine, id, updateGlobal]);

  const careerOverrideView = jobBoardCareerOverrideView(data, { localRunId: careerOverrideLocalRunId, locked: !!data.locked });
  const careerCanvasFiles = careerCanvasOpen ? canvasCareerImportCandidates(getNodes()) : [];
  const careerCanvasFileKey = careerCanvasFiles.map(file => `${file.nodeId}\u0000${file.filePath}`).join('\u0001');

  // Keep the chooser open across harmless canvas updates, but never leave a
  // checked selection that no longer names a compatible file on this level.
  useEffect(() => {
    if (!careerCanvasOpen) return;
    const liveFiles = canvasCareerImportCandidates(getNodes());
    setCareerCanvasSelections(current => {
      const next = reconcileCareerCanvasFileSelections(current, liveFiles);
      return next.length === current.length ? current : next;
    });
  }, [careerCanvasOpen, careerCanvasFileKey, getNodes]);

  const boardRunVisible = scanning || combining || durableRecoveryActive || cancellationCleanupActive;
  const awaitingSourceEntries = [
    ...(Array.isArray(data.boardScanResume?.awaitingSourceResolutions) ? data.boardScanResume.awaitingSourceResolutions : []),
    data.boardScanResume?.awaitingSourceResolution,
  ].filter((entry, index, entries) => entry?.sourceId
    && entries.findIndex(other => other?.sourceId === entry.sourceId) === index);
  const awaitingSourceIds = awaitingSourceEntries.map(entry => entry.sourceId);
  const awaitingSourceLabels = awaitingSourceIds.map(sourceId =>
    connectedModules.find(module => module.id === sourceId)?.label || 'selected Job Search');
  const awaitingSourceLabel = awaitingSourceLabels.length ? awaitingSourceLabels.join(', ') : null;
  const waitingForWorkers = data.boardScanResume?.phase === 'searches' && awaitingSourceIds.length > 0;
  // The side panel lists work in progress. A saved run waiting for its Continue
  // or Retry button runs nothing, and the Board itself says so. A run stopped
  // for a source Solve is still in progress.
  const savedRunAwaitsContinue = !scanning && !combining && (!!recoveryError
    || [data.boardScanResume, data.manualAiResume].some(marker => marker?.pausedByUser === true || marker?.autoResumeEligible === false));
  const boardWorkRunning = boardRunVisible && !savedRunAwaitsContinue;
  const showPauseSave = boardWorkRunning && data.boardScanResume?.phase === 'searches';
  const pauseDisabledReason = !showPauseSave ? 'Pause & save is available only during the searches phase.'
    : data.locked ? 'Unlock this Job Board before pausing the search.'
      : pauseSaving ? 'Saving the active Search continuation…'
        : !data.boardScanResume?.boardRunId ? 'Waiting for the Job Board to save a search run id before pausing safely.' : '';
  const waitingWorkersLabel = waitingForWorkers
    ? `Waiting for ${awaitingSourceLabel} to finish.` : null;
  // Status and Pause & save live in the side panel, with every other module's.
  const boardProgress = normalizeProgress(finalizingCommittedCombine
    ? { label: 'Board updated — finalizing saved recovery cleanup…' }
    : scanning
    ? waitingForWorkers ? { label: waitingWorkersLabel } : scanProgress
    : combining
      ? { label: combineResearchProgress?.label || 'Combining all connected saved results…' }
      : durableRecoveryActive
        ? { label: awaitingSourceLabel
          ? `Waiting for ${awaitingSourceLabel} to finish…`
          : 'Recovering the interrupted Board run…' }
        : null, selectedSearchModuleIds.length);
  usePublishJobRunStatus(id, boardWorkRunning ? {
    label: 'Job Board',
    headline: boardProgress?.label || 'Processing',
    lines: boardProgress?.completed != null && boardProgress?.total != null ? [`${boardProgress.completed} of ${boardProgress.total} searches`] : [],
    pauseKeys: [`node:${id}`, ...[...new Set([...awaitingSourceIds, ...selectedSearchModuleIds])].map(sourceId => `node:${sourceId}`)],
    onPause: showPauseSave ? pauseSearchesAndSave : null,
    pauseDisabledReason,
  } : null);

  return (
    <>
      {/* No OS-lane drops on the Board body (the career panel's own drop zone takes those), but a canvas-node career-file accept verdict must be allowed to paint. */}
      <HubContainer hubState={hubState} theme="blue" width={260} minHeight={hubState === 'empty' ? 150 : 100} dragHover={data.dragHover || null} dropsBlocked={data.dragHover?.kind !== 'accept'}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <div className="w-7 h-7 rounded-lg bg-indigo-500/15 flex items-center justify-center shrink-0">
          <LayoutGrid size={15} className="text-indigo-300/80" />
        </div>
        <div className="min-w-0">
          <p className="text-white/80 text-xs font-semibold leading-tight">Job Board</p>
          <p className="text-white/30 text-[9px] leading-tight">Scores and shows listings as connected Job Searches send them</p>
        </div>
      </div>

      <JobBoardStreamStatus
        modules={executionOrderedModules}
        summary={intakeSnapshot.summary}
        // A build that stopped on a problem says so here; nothing else shows it now.
        notice={intakeNotice || (combining ? null : recoveryError)}
        building={combining}
        behind={boardBehindListings}
        // Stopping a build keeps the cards already on screen; the new set is not finished.
        onStopBuilding={combining && !finalizingCommittedCombine && !data.locked ? () => { void handleCancelRun(); } : null}
      />

      {combining && compensationProgress?.total > 0 && (
        <p className="px-3 pb-2 text-center text-blue-300/70 text-[10px]">
          Researching pay for {compensationProgress.processed} / {compensationProgress.total} jobs…
        </p>
      )}

      <div className="px-3 pb-3">
        <JobBoardCareerOverridePanel
          nodeId={id}
          view={careerOverrideView}
          busy={careerOverrideBusy}
          onDropFiles={handleCareerOverrideDrop}
          onPickFiles={handleCareerOverridePick}
          onOpenCanvasFiles={handleCareerOverrideOpenCanvasFiles}
          onResume={handleCareerOverrideResume}
          onDiscard={handleCareerOverrideDiscard}
          onClear={handleCareerOverrideClear}
        />
        <JobBoardPreferenceOverridePanel
          view={preferenceOverrideView}
          busy={!!data.locked || boardRunVisible}
          hasSavedJobs={completedModules.length > 0}
          onApply={handlePreferenceOverrideApply}
          onClear={handlePreferenceOverrideClear}
        />
      </div>

      {hubState === 'done' && (
        <JobBoardDoneState
          brokenSourceNotices={brokenSourceNotices ? brokenSourceNotices.split('\n') : []}
          resultCount={data.resultCount}
          closedCardCount={closedCardCount}
          moduleCount={data.moduleCount}
          totalIncoming={data.mergeStats?.totalIncoming || 0}
          duplicatesRemoved={data.mergeStats?.duplicatesRemoved || 0}
          preferenceFilteredSkipped={data.mergeStats?.preferenceFilteredSkipped}
          boardPreferenceChecked={data.mergeStats?.overrideChecked}
          boardPreferenceRemoved={data.mergeStats?.overrideRemoved}
          researchRemoved={data.mergeStats?.researchRemoved}
          locationPostingsCollapsed={data.mergeStats?.locationVariantPostingsCollapsed}
          locationVariantGroups={data.mergeStats?.locationVariantGroups}
          stale={stale}
          staleReason={staleReasonText}
          canReplaceWithEmpty={canReplaceWithEmpty}
          locked={!!data.locked}
          scoreThreshold={data.scoreThreshold ?? (data.scoreRangeMin ?? 0)}
          setScoreThreshold={setScoreThreshold}
          scoreRangeMin={data.scoreRangeMin ?? 0}
          scoreRangeMax={data.scoreRangeMax ?? 100}
          sourceFilter={data.sourceFilter || null}
          toggleSourceFilter={toggleSourceFilter}
          sourceCounts={openSourceCounts}
          showReviewCards={data.showReviewCards !== false}
          setShowReviewCards={setShowReviewCards}
          onRecombine={boardRunVisible ? null : () => handleCombine()}
          onClear={handleClear}
          combining={combining}
          scanning={scanning}
          officialPostingRefreshing={officialPostingRefreshing}
          officialPostingProgress={officialPostingProgress}
          onRefreshOfficialPostings={boardRunVisible ? null : refreshOfficialPostings}
          onRetryIncompleteOfficialPostings={boardRunVisible ? null : retryIncompleteOfficialPostings}
          incompleteOfficialLookups={incompleteOfficialLookups}
          onCancelOfficialPostingRefresh={cancelOfficialPostingRefresh}
          onRerunStage={boardRunVisible ? null : startStageRerun}
          onCancelStageRerun={cancelStageRerun}
          stageRerunning={stageRerunning}
          stageRerunProgress={stageRerunProgress}
          salaryNeedsRefresh={salaryNeedsRefresh}
        />
      )}
      </HubContainer>

      {careerCanvasOpen && (
        <CareerCanvasFileImportDialog
          files={careerCanvasFiles}
          selectedSelections={careerCanvasSelections}
          onToggle={handleCareerOverrideToggleCanvasFile}
          onClose={() => setCareerCanvasOpen(false)}
          onImport={handleCareerOverrideImportCanvasFiles}
          importDisabled={careerCanvasSelections.length === 0 || !careerOverrideView.canImport || careerOverrideBusy}
          title="Career data for applications"
          description="Select .txt or .md career files on this canvas. They are compiled for this board's application bundles only."
          importLabel="Compile for applications"
          errorMessage={careerCanvasError}
        />
      )}

      {emptyReplacementPrompt && (
        <ConfirmDialog
          title="Clear stale board results?"
          message={`The completed scored searches have no current jobs. This will remove ${emptyReplacementPrompt.resultCardCount} board-owned result card${emptyReplacementPrompt.resultCardCount === 1 ? '' : 's'} and ${emptyReplacementPrompt.resultGroupCount} board-owned group${emptyReplacementPrompt.resultGroupCount === 1 ? '' : 's'}. Undo restores them.`}
          confirmLabel="Clear stale results"
          cancelLabel="Keep stale results"
          variant="warning"
          onConfirm={confirmEmptyReplacement}
          onCancel={cancelEmptyReplacement}
        />
      )}
    </>
  );
});
