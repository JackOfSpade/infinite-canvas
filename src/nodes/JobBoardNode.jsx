import React, { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { EventLogger } from '../utils/EventLogger';
import { hubCardFilter } from '../utils/jobCardFilters';
import { buildJobTreeNodes, computeJobTreeView } from './jobsearch/buildJobTree';
import { deleteChildrenByHubId } from './_shared/hubChildCleanup';
import { ACTIVE_JOB_SEARCH_STATES, attachCompensationRemoteResidences, unionScoredJobs, moduleCombineFingerprint, moduleFingerprint, combineSignature, normalizeJobMatchScore, staleReason, isLegacyCombineSignature, emptyReplacementIneligibilityReason, shouldKeepCompletedBoardSnapshotVisible } from './jobboard/mergeJobs';
import { attachProtectedCards, consolidateJobLocations, isProtectedJobCard } from '../utils/jobLocationConsolidation';
// Shown only for a restored marker: 'Saved AI handoff ready. Choose Continue saved AI handoff…'
import { SAVED_HANDOFF_READY_MESSAGE, isLiveCombineOwnedMarker, combineCommitMismatchReason } from './jobboard/boardRecoveryNotice';
import { JobBoardDoneState } from './jobboard/JobBoardDoneState';
import { JobBoardSearchSelection } from './jobboard/JobBoardSearchSelection';
import { isJobBoardUserCancellation, isLegacyUnbucketedJobBoard, validateJobBoardTaxonomy } from '../utils/jobBoardAiProvider';
import { boundedCombinedSourceRuns, normalizeBoardResultCount } from '../utils/jobBoardProvenance';
import { allocateJobBoardAdmissionOrder, findJobSearchBoardActiveRecoveryOwner, findJobSearchBoardRecoveryOwner, getConnectedJobSearchIds, getSelectedConnectedJobSearchIds, isJobBoardUpToDate, moveJobSearchExecutionOrder, normalizeJobBoardAdmissionOrder, normalizeJobBoardRecoveryTimestamp, orderJobSearchIds, toggleSelectedJobSearchId } from '../utils/jobBoardSearchSelection';
import { hubHasAcceptedInitialDrop } from '../utils/hubDropEligibility';
import { getSearchLocation, hasRequiredLocations, locationValidationMessage } from '../utils/jobSearchLocations';
import { exactInterruptedRecoveryAdmission } from '../utils/jobBoardRecoveryAdmission';
import { cancelJobBoardChildrenSequentially, promoteJobBoardPausedSourceResolution, runJobBoardChildFanout } from '../utils/jobBoardChildFanout';
import { classifyJobBoardSourceAdmission, combineSourceRunEntry, completedJobSearchOutcomeMatches, describeReceiptMismatch, jobSearchOutcomeReceiptMatches, partitionJobBoardSourceAdmissions } from '../utils/jobBoardSourceAdmission';
import { getRunnableJobSourceIds, normalizeEnabledJobSourceIds } from '../utils/jobPlatformSelection';
import { normalizeJobCollectionLimits } from '../utils/jobCollectionLimits';
import { getJobAuthPreflightSourceIds } from '../utils/jobAuthPreflight';
import { exactPausedSourceContinuation, resolveExactPausedJobBoardTerminal, isMergeableTerminalJobSearchOutcome, terminalJobSearchOutcome } from '../utils/jobBoardPausedSourceContinuation';
import { prepareBackgroundBoardChildRequest, validateBackgroundBoardChildRequest } from '../utils/jobBoardBackgroundRecovery';
import { ACTIVE_JOB_SOURCES } from '../utils/constants';
import { safeClone } from '../utils/navigationUtils';
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
  const entropy = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `job-board:${nodeId}:${entropy}`;
}

function rememberBoundedRunId(runIds, runId, limit = 32) {
  if (!(runIds instanceof Set) || !runId) return;
  runIds.add(runId);
  while (runIds.size > limit) {
    runIds.delete(runIds.values().next().value);
  }
}

function normalizeManualAiCleanupReceipts(receipts) {
  if (!Array.isArray(receipts)) return [];
  const byRunId = new Map();
  for (const receipt of receipts) {
    if (typeof receipt?.runId !== 'string' || !receipt.runId) continue;
    byRunId.set(receipt.runId, { ...(byRunId.get(receipt.runId) || {}), ...receipt });
  }
  return [...byRunId.values()].slice(-32);
}

function upsertManualAiCleanupReceipt(receipts, receipt) {
  return normalizeManualAiCleanupReceipts([
    ...normalizeManualAiCleanupReceipts(receipts).filter(item => item.runId !== receipt?.runId),
    receipt,
  ]);
}

function removeManualAiCleanupReceipt(receipts, runId) {
  return normalizeManualAiCleanupReceipts(receipts).filter(receipt => receipt.runId !== runId);
}

function hasCancellationPendingManualAiCleanup(data) {
  return normalizeManualAiCleanupReceipts(data?.manualAiCleanupReceipts)
    .some(receipt => receipt.cancellationPending === true);
}

function hasPendingManualAiRetirement(data) {
  return data?.manualAiResume?.retirementPending === true
    || hasCancellationPendingManualAiCleanup(data);
}

function waitForBoardRendererCommitFrame() {
  return new Promise((resolve) => {
    let settled = false;
    let fallbackTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (fallbackTimer != null) clearTimeout(fallbackTimer);
      resolve();
    };
    fallbackTimer = setTimeout(finish, 50);
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(finish);
    }
  });
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
    });
  } catch {
    // Closing/reloading the renderer releases its sender-owned main lease.
  }
}

function isSavedScrapeManualAiResume(resume) {
  return resume?.task === 'job-scoring'
    || SAVED_SCRAPE_MANUAL_AI_RECOVERY_MODES.has(resume?.recoveryMode);
}

function captureJobSearchRollback(sourceId, sourceData, nodes, edges) {
  const allNodes = Array.isArray(nodes) ? nodes : [];
  const allEdges = Array.isArray(edges) ? edges : [];
  const ownedNodes = allNodes.filter(
    node => node?.type === 'jobsourcecard' && node.data?.hubId === sourceId,
  );
  const ownedIds = new Set(ownedNodes.map(node => node.id));
  return safeClone({
    version: 1,
    sourceId,
    previousData: sourceData && typeof sourceData === 'object' ? sourceData : {},
    sourceGraph: {
      nodes: ownedNodes,
      edges: allEdges.filter(edge => ownedIds.has(edge?.source) || ownedIds.has(edge?.target)),
      nodeOrder: allNodes.map(node => node?.id).filter(Boolean),
      edgeOrder: allEdges.map(edge => edge?.id).filter(Boolean),
    },
  });
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
// resolvedRoles entirely. `d?.targetRole` itself is legacy-only (an
// unmigrated canvas may still carry it) and is deliberately not read here —
// reading it would show a stale role no run has actually pinned on.
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
  // A terminal generation is immutable Board input.  Its saved hiring-fit
  // rows (including a truthful zero) are safe to combine, but sending it into
  // the normal runner would parse/scrape the same career input again.  Keep
  // this before platform/location setup: reuse must not be disabled merely
  // because a completed Search's current controls were later edited.
  const sourceAdmission = classifyJobBoardSourceAdmission(node);
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
  if (sourceAdmission.kind === 'terminal-requires-fresh-input') {
    return {
      ready: false,
      boardAction: 'terminal-blocked',
      readinessReason: sourceAdmission.reason,
      statusLabel: 'Clear + import required',
    };
  }
  if (sourceAdmission.kind === 'fresh-import-requires-clear') {
    return {
      ready: false,
      boardAction: 'fresh-import-blocked',
      readinessReason: sourceAdmission.reason,
      statusLabel: 'Clear + import required',
    };
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
  const runnableSources = getRunnableJobSourceIds(
    normalizeEnabledJobSourceIds(sourceData.enabledSourceIds),
    ACTIVE_JOB_SOURCES,
    normalizeJobCollectionLimits(sourceData.collectionLimits),
  );
  const browserLoginSources = getJobAuthPreflightSourceIds(
    sourceIds => sourceIds.filter(sourceId => runnableSources.includes(sourceId)),
  );
  if (verifyingPlatforms instanceof Set && browserLoginSources.some(sourceId => verifyingPlatforms.has(sourceId))) {
    return {
      ready: false,
      readinessReason: 'Its selected platform connections are still being checked.',
      statusLabel: 'Checking connections',
    };
  }
  if (runnableSources.length === 0) {
    return { ready: false, readinessReason: 'Select at least one job platform.', statusLabel: 'Needs platform' };
  }
  if (!hubHasAcceptedInitialDrop(node)) {
    return { ready: false, readinessReason: 'Drop career files on this module first.', statusLabel: 'Needs files' };
  }
  const searchLocation = getSearchLocation(sourceData);
  if (!hasRequiredLocations(searchLocation)) {
    return {
      ready: false,
      readinessReason: locationValidationMessage(searchLocation),
      statusLabel: 'Needs location',
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
} = {}) {
  if (!canvasFilePath || !nodeId || !window.electronAPI?.peekJobRun) return null;
  try {
    const info = await window.electronAPI.peekJobRun({ canvasFilePath, nodeId });
    const admission = exactInterruptedRecoveryAdmission({
      info,
      nodeId,
      sourceData,
      platformsVerifying,
    });
    return admission.ok ? admission.runId : null;
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

function canInspectInterruptedRecovery(readiness, sourceData) {
  // A paused source still belongs to its Source-card Resolve/Skip path. Do
  // not let a disabled current platform toggle disguise that gate as a generic
  // interrupted search recovery. An already-consumed import is also allowed to
  // probe: only an exact manifest can continue it; a missing manifest remains
  // fail-closed rather than becoming another fresh search.
  const recoveryProbeBlocked = readiness?.statusLabel === 'Needs platform'
    || readiness?.statusLabel === 'Clear + import required';
  return recoveryProbeBlocked
    && sourceData?.hubState !== 'sources-ready'
    && !!sourceData?.resumeProfile
    && typeof sourceData.resumeProfile === 'object';
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
    return 'It completed without hiring-fit scoring, so its results cannot be combined. Turn off Test Mode if enabled, then choose Re-scan for New Jobs on its Job Search card before using the Board.';
  }
  return 'It completed without mergeable hiring-fit results. Choose Re-scan for New Jobs on its Job Search card before using the Board.';
}

// Capture the mergeable terminal inputs from the live canvas. A Combine can
// wait behind another Job Search run, then spend minutes in manual AI; render-
// time closures are not authority at either boundary.
function liveCombineInputs(boardId, nodes, edges) {
  const connected = new Set(getConnectedJobSearchIds(boardId, nodes, edges));
  const all = (Array.isArray(nodes) ? nodes : [])
    .filter(node => connected.has(node?.id) && node?.type === 'jobhub')
    .map(node => {
      const data = node.data || {};
      const terminal = terminalJobSearchOutcome(node);
      const scoredJobs = Array.isArray(data.scoredJobs) ? data.scoredJobs : [];
      const careerSnapshotId = typeof data.careerSnapshotId === 'string' ? data.careerSnapshotId.trim() : '';
      const operationAuthority = data.analysisOperation?.authority || null;
      // Scope a module's rows to the profile currently pinned on that module
      // before computing its Combine fingerprint. This also upgrades saved
      // rows from before per-row pinning, without duplicating the profile.
      const snapshotScopedJobs = careerSnapshotId
        ? scoredJobs.map(job => ({ ...job, careerSnapshotId }))
        : scoredJobs;
      const remoteResidences = data.locationSnapshot?.remoteResidences || data.remoteResidences || {};
      const count = snapshotScopedJobs.length;
      const authoritativeEmpty = !isExplicitlyUnscoredModule(data)
        && (data.resultDisposition === 'empty-complete' || data.resultDisposition === 'preference-filtered');
      return {
        id: node.id,
        runId: terminal?.runId || null,
        careerSnapshotId,
        operationAuthority,
        resultDisposition: terminal?.resultDisposition || null,
        legacyPositiveResult: terminal?.legacyPositiveResult === true,
        label: moduleLabel(data),
        count,
        fingerprint: moduleCombineFingerprint(snapshotScopedJobs, remoteResidences),
        scoredJobs: snapshotScopedJobs,
        remoteResidences,
        hubState: data.hubState || 'empty',
        include: !!terminal && isMergeableTerminalJobSearchOutcome(node, terminal)
          && (count > 0 || authoritativeEmpty),
      };
    });
  const completed = all.filter(module => module.include);
  return { all, completed, ready: completed.filter(module => module.count > 0) };
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

// A combine signature identifies the input payload, but not the Job Search run
// that produced it. Retain a compact exact-run index alongside the signature so
// a later manual Clear cannot accidentally certify a newer run from the same
// hub whose board state had not caught up yet.
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

  const hubState = data.hubState || 'empty';
  const [combining, setCombining] = useState(false);
  // Once the replacement cascade and Board metadata are committed, Cancel can
  // no longer truthfully promise to keep the previous Board. Durable manual-AI
  // retirement may still take a few frames, so keep that short finalization
  // boundary distinct from the cancellable Combine phase in both the imperative
  // handler and the rendered controls.
  const [finalizingCommittedCombine, setFinalizingCommittedCombine] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(null);
  const [recoveryError, setRecoveryError] = useState(null);
  // Kept out of persistent Board data: this is a renderer-only observation of
  // the selector's real action predicate and measured layout at report time.
  const [selectorRuntimeSnapshot, setSelectorRuntimeSnapshot] = useState(null);
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
            targetRole: n.data?.targetRole || '',
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
            admissionKind: classifyJobBoardSourceAdmission(n).kind,
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
            // wake key so a recovered Board that yielded to this Combine gets
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
        return canInspectInterruptedRecovery(readiness, node.data);
      });

    Promise.all(candidateNodes.map(async (node) => ({
      nodeId: node.id,
      signature: interruptedRecoveryProbeSignature(node.data),
      runId: await inspectExactResumableJobRun(canvasFilePath, node.id, node.data),
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
          { orchestratorNodeId: id, recoveryOwner },
        );
        const probe = interruptedRecoveryProbes[n.id];
        const recoveryProbeEligible = !!canvasFilePath
          && !hasActivePlatformVerification(verifyingPlatforms)
          && canInspectInterruptedRecovery(readiness, n.data)
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
          ...readiness,
          ...(recoveryProbeEligible ? {
            ready: true,
            statusLabel: 'Resume saved recovery',
            readinessReason: 'Resume this Search’s exact unfinished run.',
          } : {}),
          ...(isQueueableSearchContention(readiness) ? { ready: true } : {}),
        };
      });
    // connectedSig is the real reactive trigger; getEdges/getNodes are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardRecoverySig, canvasFilePath, connectedSig, deletionLifecycleRevision, id, interruptedRecoveryProbes, verifyingPlatforms]);

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
  const captureSelectorRuntimeSnapshot = useCallback((nextSnapshot) => {
    // ResizeObserver can deliver duplicate observations. Avoid a state/render
    // loop while retaining the latest exact client/scroll bounds.
    setSelectorRuntimeSnapshot((current) => (
      JSON.stringify(current) === JSON.stringify(nextSnapshot) ? current : nextSnapshot
    ));
  }, []);

  useEffect(() => {
    EventLogger.registerNodeState(id, {
      jobBoardSelector: selectorRuntimeSnapshot,
    });
  }, [id, selectorRuntimeSnapshot]);

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

  const toggleSearchModule = useCallback((moduleId, checked) => {
    // An edge can disappear after this row rendered but before its checkbox
    // event runs. Resolve against the imperative graph so that stale event is
    // a true no-op and cannot rewrite the durable selection.
    const connectedAtEvent = getConnectedJobSearchIds(id, getNodes(), getEdges());
    if (!connectedAtEvent.includes(moduleId)) return;
    // Use a functional patch because two checkbox events can arrive before the
    // first React write renders. Deriving both from this render's `data` would
    // make the second toggle overwrite the first one.
    updateGlobal(id, (node) => {
      const liveConnectedIds = getConnectedJobSearchIds(id, getNodes(), getEdges());
      if (!liveConnectedIds.includes(moduleId)) return null;
      const liveSelection = node?.data?.selectedSearchModuleIds;
      const currentlySelected = getSelectedConnectedJobSearchIds(
        liveSelection,
        liveConnectedIds,
      ).includes(moduleId);
      // Checkbox events carry their intended state. Apply them idempotently so
      // duplicate delivery cannot toggle the row back, while a rapid off→on
      // sequence still ends in the state of its second event.
      if (typeof checked === 'boolean' && currentlySelected === checked) return null;
      const next = toggleSelectedJobSearchId(
        liveSelection,
        moduleId,
        liveConnectedIds,
      );
      return Array.isArray(next) ? { selectedSearchModuleIds: next } : null;
    });
    EventLogger.log(`[JobBoard] scan selection changed id=${id} module=${moduleId} checked=${checked === true}`);
  }, [getEdges, getNodes, id, updateGlobal]);

  const moveSearchModule = useCallback((moduleId, direction) => {
    const connectedAtEvent = getConnectedJobSearchIds(id, getNodes(), getEdges());
    if (!connectedAtEvent.includes(moduleId)) return;
    updateGlobal(id, (node) => {
      const liveConnectedIds = getConnectedJobSearchIds(id, getNodes(), getEdges());
      if (!liveConnectedIds.includes(moduleId)) return null;
      const next = moveJobSearchExecutionOrder(
        node?.data?.searchExecutionOrder,
        liveConnectedIds,
        moduleId,
        direction,
      );
      if (!Array.isArray(next)) return null;
      const current = Array.isArray(node?.data?.searchExecutionOrder)
        ? node.data.searchExecutionOrder
        : null;
      if (JSON.stringify(current) === JSON.stringify(next)) return null;
      return { searchExecutionOrder: next };
    });
    EventLogger.log(`[JobBoard] search execution order changed id=${id} module=${moduleId} direction=${direction}`);
  }, [getEdges, getNodes, id, updateGlobal]);

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
  const completedModules = useMemo(
    () => mergeableModules.filter((m) => m.hubState === 'done' && (m.hasPositiveResults || m.isAuthoritativeEmpty)),
    [mergeableModules],
  );
  const readyModules = useMemo(
    () => completedModules.filter((m) => m.count > 0),
    [completedModules],
  );
  const allConnectedModulesDone = connectedModules.length > 0 && completedModules.length === connectedModules.length;
  // Signature of every terminal module (id + data fingerprint). Compared against
  // the signature captured at the last Combine to tell whether the cached board
  // is still valid, including a terminal zero-result re-run.
  const liveSignature = useMemo(
    () => boardInputSignature(completedModules, connectedModules),
    [completedModules, connectedModules],
  );
  const stale = hubState === 'done' && !!data.stale;
  // The Combine action is only useful when the cached board is out of date or
  // a connected source is incomplete; a done, current, fully complete board
  // shows a status line instead of an inert-looking button.
  const boardUpToDate = isJobBoardUpToDate({
    hubState,
    stale,
    connectedCount: connectedModules.length,
    completedCount: completedModules.length,
    combineSignature: data.combineSignature,
    liveSignature,
  });
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
  const applyCardFilters = useCallback(({ sourceFilter: sf, scoreThreshold: st } = {}) => {
    const base = hubCardFilter({ sourceFilter: data.sourceFilter, scoreThreshold: data.scoreThreshold });
    const filter = {
      sourceFilter: sf !== undefined ? sf : base.sourceFilter,
      scoreThreshold: st !== undefined ? st : base.scoreThreshold,
    };
    setNodes((nodes) => computeJobTreeView(nodes, id, filter));
  }, [data.sourceFilter, data.scoreThreshold, id, setNodes]);

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

  // Re-apply filters on mount — card opacities are stripped from save files.
  useEffect(() => {
    if (data.stale) return; // stale → cascade is hidden; don't reveal it here
    const min = data.scoreRangeMin ?? 0;
    const hasFilter = data.sourceFilter || (data.scoreThreshold ?? min) > min;
    if (!hasFilter) return;
    applyCardFilters({});
  }, [applyCardFilters, data.scoreThreshold, data.scoreRangeMin, data.sourceFilter, data.stale]);

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
    setNodes((nodes) => computeJobTreeView(nodes, id, hubCardFilter({ sourceFilter: data.sourceFilter, scoreThreshold: data.scoreThreshold })));
  }, [id, setNodes, data.sourceFilter, data.scoreThreshold]);

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
    // A connected Search leaves the terminal signature as soon as it starts.
    // Keep the last completed cascade usable during that transient phase; a
    // topology edit, existing stale result, or terminal result change still
    // falls through to the normal stale/hide path below.
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
  const clearBoardChildren = useCallback(() => {
    deleteChildrenByHubId({
      getNodes, getEdges, deleteElements, hubId: id, childTypes: ['jobcard', 'jobgroup'],
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
      && liveInputs.completed.length === liveInputs.all.length;
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
    clearBoardChildren();
    const perModule = liveInputs.completed.map((m) => ({ label: m.label, count: m.count }));
    updateGlobal(id, {
      hubState: 'done', resultCount: 0, moduleCount: liveInputs.completed.length,
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
    ].filter(Boolean))];
    const boardRunId = activeBoardRunIdRef.current
      || plan?.boardRunId
      || existing?.boardRunId
      || activeCombineRunId
      || liveData.manualAiResume?.runId
      || null;
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
      || `job-board-cancel:${id}:${globalThis.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
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
      : new Set([active?.runId, persistedRunId].filter(Boolean));
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
        .filter(runId => typeof runId === 'string' && runId),
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
    if (!receipt?.runId) return true;
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
        if (runId) runIds.add(runId);
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
    ].filter(Boolean));
    if (!window.electronAPI?.cancelNodeTaskAndWait) {
      window.electronAPI?.cancelNodeTask?.(id, reason);
      throw new Error('Acknowledged Job Board cancellation is unavailable.');
    }
    const acknowledgement = await window.electronAPI.cancelNodeTaskAndWait(id, reason);
    if (acknowledgement?.settled !== true) {
      throw new Error('The Job Board did not finish cancelling before the safety timeout.');
    }
    for (const runId of acknowledgement?.manualAiRunIds || []) {
      if (runId) runIds.add(runId);
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
    clearBoardChildren();
  }, [cancelActiveSearchModule, cancelBoardTaskAndRetireManualAi, clearBoardChildren, data.boardScanResume, epoch, getNode, id, moduleRunQueue, persistBoardCancellationIntent, updateGlobal]);

  useUnmountEffect(cleanupBoard);

  const handleClear = useCallback(async () => {
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
      combineSignature: null, combineSourceRuns: null, stale: false, staleReason: null,
      clearProvenance,
      manualAiResume: null,
      boardScanResume: null,
      boardCancellation: null,
      manualAiCleanupReceipts: null,
      queuedModuleRun: null,
    });
    if (autoRetriedBoardCancellationRef.current === cancellationIntent?.operationId) {
      autoRetriedBoardCancellationRef.current = null;
    }
    EventLogger.log(`[JobBoard] cleared id=${id}`);
  }, [addToast, id, data, getNode, cancelActiveSearchModule, cancelBoardTaskAndRetireManualAi, clearBoardChildren, updateGlobal, epoch, moduleRunQueue, persistBoardCancellationIntent]);

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
      || !!liveData.manualAiResume
      || !!liveData.boardCancellation;
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
    if (autoRetriedBoardCancellationRef.current === cancellationIntent?.operationId) {
      autoRetriedBoardCancellationRef.current = null;
    }
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
        description: 'The existing board and completed search results were kept.',
        type: 'info',
      });
    }
    return { status: 'cancelled', cancelled: true };
  }, [addToast, cancelActiveSearchModule, cancelBoardTaskAndRetireManualAi, data, epoch, getNode, id, moduleRunQueue, persistBoardCancellationIntent, updateGlobal]);

  useEffect(() => jobSearchCoordinator.registerBoardModule(id, async (options = {}) => {
    const result = await handleCancelRun({
      expectedBoardRunId: options.boardRunId || null,
      reason: options.reason || 'board-run-cancelled',
      suppressToast: options.suppressToast === true,
    });
    return result;
  }), [handleCancelRun, id, jobSearchCoordinator]);

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

  const handleCombine = useCallback(async (options = {}) => {
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
    if (!afterSearch && !recoveryAttempt && readyModules.length === 0 && allConnectedModulesDone) {
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
    if (!afterSearch && !recoveryAttempt && readyModules.length === 0) {
      addToast({ title: 'Nothing to combine', description: 'Connect Job Search Modules that have finished scoring, then try again.', type: 'error' });
      return { status: 'not-ready' };
    }
    let manualAiRunId = options?.manualAiRunId || null;
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
    activeCombineManualAiRunRef.current = {
      token: combineToken,
      runId: manualAiRunId,
      startedAt: combineStartedAt,
    };
    compensationRequestIdRef.current = compensationRequestId;
    setCombining(true);
    setCompensationProgress(null);
    const cancelled = epoch.start();
    let lease = null;
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
      // Take the input snapshot only after the shared lane starts. A search
      // ahead of this board can complete while it is queued; using the click-
      // time closure would waste a manual run and could misstate provenance.
      const inputsAtCombine = liveCombineInputs(id, getNodes(), getEdges());
      const completedAtCombine = inputsAtCombine.completed;
      const readyAtCombine = inputsAtCombine.ready;
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
        EventLogger.log(`[JobBoard] recovered combine superseded at admission id=${id}`);
        return { status: 'superseded' };
      }
      if (readyAtCombine.length === 0) {
        const liveConnectedCount = getConnectedJobSearchIds(id, getNodes(), getEdges()).length;
        const allLiveConnectedDone = liveConnectedCount > 0 && completedAtCombine.length === liveConnectedCount;
        const emptySignature = sigAtCombine;
        const liveBoardData = getNode(id)?.data || {};
        const replacingPriorBoard = liveBoardData.hubState === 'done'
          && liveBoardData.combineSignature !== emptySignature;

        if (afterSearch && allLiveConnectedDone && replacingPriorBoard) {
          requestEmptyReplacement();
          return { status: 'completed' };
        }
        if (afterSearch && allLiveConnectedDone && liveBoardData.hubState !== 'done') {
          const perModule = completedAtCombine.map((module) => ({ label: module.label, count: 0 }));
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
      const jobArrays = readyAtCombine.map((m) =>
        m.scoredJobs
          .map((j) => ({ ...j, originHubId: j.originHubId || m.id }))
      );
      const mergeStats = {};
      let union = unionScoredJobs(jobArrays, mergeStats);
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
      let locationStats = {
        candidateGroups: 0, postingsCollapsed: 0, protectedRetained: 0,
        representedPostings: 0, alreadyConsolidated: 0,
      };
      if (union.length > 0) {
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
            + `aiConfirmed=${confirmation.confirmedPairIds?.length || 0}/${confirmation.candidateCount || 0}`,
          );
        }
      }
      const perModule = completedAtCombine.map((m) => ({ label: m.label, count: m.count }));
      EventLogger.log(`[JobBoard] combine started id=${id} signature=${sigAtCombine} incoming=${union.length}`);
      EventLogger.log(
        `[JobBoard] Combined ${completedAtCombine.length} completed module(s): ` +
        `${perModule.map((p) => p.count).join('+')}=${mergeStats.totalIncoming} → ` +
        `${mergeStats.unique} unique (${mergeStats.duplicatesRemoved} dup removed, ` +
        // Without this term the printed equation silently stops balancing:
        // incoming − duplicates ≠ unique whenever preference-filtered rows were
        // skipped, and the missing count appeared in no other line.
        `${mergeStats.preferenceFilteredSkipped || 0} preference-filtered skipped, ` +
        `${mergeStats.collisionUpgrades} score-upgrade(s), ` +
        `${mergeStats.collisionAssessmentUpgrades} assessment-upgrade(s))`
      );
      if (union.length === 0) {
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
          if (isJobBoardUserCancellation(res)) {
            EventLogger.log(`[JobBoard] combine cancelled by user id=${id} stage=taxonomy`);
            return { status: 'cancelled' };
          }
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
        if (isJobBoardUserCancellation(err)) {
          EventLogger.log(`[JobBoard] combine cancelled by user id=${id} stage=taxonomy`);
          return { status: 'cancelled' };
        }
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
        const remoteResidencesByOrigin = Object.fromEntries(readyAtCombine.map((module) => [module.id, module.remoteResidences]));
        // Keep this transient routing input on the full union rather than
        // choosing one module's residence for every remote listing. The card
        // builder's explicit whitelist omits it after research is complete.
        union = attachCompensationRemoteResidences(union, remoteResidencesByOrigin);
        const compensationResult = await window.electronAPI?.researchJobCompensation?.({
          jobs: union,
          nodeId: id,
          requestId: compensationRequestId,
          manualAiRunId,
        });
        if (cancelled() || !getNode(id)) {
          EventLogger.log(`[JobBoard] combine cancelled during compensation research id=${id}`);
          return { status: 'cancelled' };
        }
        if (!compensationResult?.success || !Array.isArray(compensationResult.jobs)) {
          if (isJobBoardUserCancellation(compensationResult)) {
            EventLogger.log(`[JobBoard] combine cancelled by user id=${id} stage=compensation`);
            return { status: 'cancelled' };
          }
          const error = new Error(compensationResult?.error || 'Job Board compensation research failed.');
          error.code = compensationResult?.errorCode;
          throw error;
        }
        union = compensationResult.jobs;
      } catch (err) {
        if (cancelled() || !getNode(id)) return { status: 'cancelled' };
        if (isJobBoardUserCancellation(err)) {
          EventLogger.log(`[JobBoard] combine cancelled by user id=${id} stage=compensation`);
          return { status: 'cancelled' };
        }
        // Like failed taxonomy, a failed research invocation must leave the
        // previously displayed board intact rather than replacing it with a
        // partial set of cards.
        EventLogger.error('[JobBoard] Compensation research failed; preserving prior board:', err);
        throw err;
      }

      // A source can finish, reset, or be reconnected while taxonomy or
      // compensation was awaiting the manual handoff. Never replace cards,
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
      const signatureMatches = (
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
        protectedCards: protectedBoardCards,
      });

      // Prepare, but do not consume, the durable seen-history capability
      // before this Board's visible cascade is committed. The host binds it to
      // the exact source receipts/current artifacts; a later source change or
      // cancellation makes the pending token unusable rather than recording
      // listings that were never displayed.
      const historyRows = union.flatMap((j) => {
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
      if (newNodes.length > 0 && canvasFilePath) {
        const prepared = await window.electronAPI?.prepareBoardJobsHistory?.({
          canvasFilePath,
          jobs: historyRows,
          sources: completedAtCombine.map((module) => ({
            hubId: module.id,
            runId: module.runId,
            careerSnapshotId: module.careerSnapshotId,
            operationAuthority: module.operationAuthority,
          })),
        });
        if (prepared?.success !== true || !prepared.historyToken || cancelled() || !getNode(id)) {
          return { status: 'superseded', error: prepared?.error || 'Board inputs changed before display commit.' };
        }
        historyToken = prepared.historyToken;
      }

      // Replace the prior combine only now that the new cascade is BUILT — the
      // clear used to run before the multi-second bucketing await, so any
      // failure in that window left a board claiming "N unique jobs" over an
      // empty canvas. Clearing and adding back-to-back (no await between)
      // closes that orphan window: a throw above leaves the old board intact.
      // Snapshot before asking ReactFlow to delete anything. `deleteElements`
      // currently yields internally, but undo correctness must not depend on
      // that implementation detail or a future synchronous deletion path.
      if (newNodes.length > 0) {
        document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
      }
      clearBoardChildren();
      if (newNodes.length > 0) {
        if (addElementsGlobally) addElementsGlobally(id, newNodes, newEdges, 'sibling');
        else { addNodes(newNodes); addEdges(newEdges); }
        requestAnimationFrame(() => fitView({ duration: 600, padding: 0.2 }));
      }

      const finalSourceCounts = {};
      union.forEach((j) => { finalSourceCounts[j.source] = (finalSourceCounts[j.source] || 0) + 1; });

      // Publish a durable cleanup-only receipt in the same node update as the
      // visible Board metadata. If the renderer/app is torn down before the
      // following completion acknowledgement returns, reload must retire this
      // exact manual run instead of replaying a Combine whose cascade already
      // replaced the prior result. Clearing boardScanResume here removes the
      // second recovery entry point for the same committed transaction.
      committedCombineRef.current = { token: combineToken, manualAiRunId };
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
          },
          // Baseline for staleness detection (connection/data drift vs. this combine).
          combineSignature: sigAtCombine,
          combineSourceRuns: sourceRunsAtCombine,
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
      if (newNodes.length > 0 && canvasFilePath) {
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
      EventLogger.log(`[JobBoard] combine completed id=${id} signature=${sigAtCombine} results=${union.length} children=${newNodes.length} locationGroups=${locationStats.candidateGroups} locationCollapsed=${locationStats.postingsCollapsed}`);
      await completeManualAiRun(manualAiRunId);
      return { status: 'completed' };
    } catch (err) {
      if (
        cancelled()
        || !getNode(id)
        || isJobWorkflowDeletionPending(id)
        || err?.code === 'JOB_WORKFLOW_DELETION_PENDING'
      ) return { status: 'cancelled' };
      if (isJobBoardUserCancellation(err)) {
        EventLogger.log(`[JobBoard] combine cancelled by user id=${id} stage=pipeline`);
        return { status: 'cancelled' };
      }
      EventLogger.error('[JobBoard] Combine failed:', err);
      addToast({ title: 'Combine failed', description: err?.message || String(err), type: 'error' });
      return { status: 'failed', error: err?.message || String(err) };
    } finally {
      lease?.release();
      if (committedCombineRef.current?.token === combineToken) {
        committedCombineRef.current = null;
        setFinalizingCommittedCombine(false);
      }
      // Clear only the run that acquired this token. A Clear/unmount releases
      // the lock synchronously; a late former run must never unlock, clear
      // progress, or otherwise alter a newer Combine.
      if (combineRunRef.current === combineToken) {
        combineRunRef.current = null;
        if (activeCombineManualAiRunRef.current?.token === combineToken) {
          activeCombineManualAiRunRef.current = null;
        }
        compensationRequestIdRef.current = null;
        setCompensationProgress(null);
        if (!cancelled() && getNode(id)) setCombining(false);
      }
    }
  }, [readyModules, allConnectedModulesDone, canReplaceWithEmpty, getNodes, getEdges, getNode, id, clearBoardChildren, hideBoardChildren, requestEmptyReplacement, addElementsGlobally, addNodes, addEdges, fitView, updateGlobal, addToast, epoch, canvasFilePath, completeManualAiRun, moduleRunQueue, keepCompletedSnapshotDuringActiveSearch]);

  const handleSearchSelected = useCallback(async (request = null) => {
    if (isJobWorkflowDeletionPending(id)) return { status: 'cancelled' };
    const liveBoardDataAtAdmission = getNode(id)?.data || data;
    if (
      scanRunRef.current
      || combineRunRef.current
      || cancellationInFlightRef.current
      || liveBoardDataAtAdmission.boardCancellation
      || hasPendingManualAiRetirement(liveBoardDataAtAdmission)
      || liveBoardDataAtAdmission.locked
    ) return;
    if (scanPreflightRef.current) return;
    const preflightToken = Symbol(`job-board-preflight:${id}`);
    scanPreflightRef.current = preflightToken;
    setRecoveryError(null);
    let processBoardClaim = null;

    // The click handler receives a React event; only our recovery effect passes
    // this explicit marker. A durable plan lets a Board regain ownership after
    // reload without re-running children that already completed before the
    // interruption.
    const resumePlan = request?.resumeBoardScan === true && request.plan && typeof request.plan === 'object'
      ? request.plan
      : null;
    const explicitRecoveryContinue = request?.explicitRecoveryContinue === true;
    if (resumePlan && !isCurrentBoardScanResume(
      getNode(id)?.data?.boardScanResume,
      resumePlan,
    )) {
      // A recovery effect can hold the immediately-prior render after another
      // callback cleared this plan. Do not turn that stale prop into a fresh
      // scan; the current store is the recovery authority.
      if (scanPreflightRef.current === preflightToken) scanPreflightRef.current = null;
      return { status: 'superseded' };
    }
    if (resumePlan) {
      processBoardClaim = await claimJobBoardProcessLease({
        canvasFilePath,
        nodeId: id,
        boardRunId: resumePlan.boardRunId,
        operation: 'board-orchestration',
        autoResume: !explicitRecoveryContinue,
        // A hidden startup coordinator may be finishing this same Board's safe
        // provider-only phase. Wait for that distinct operation, then re-inspect
        // the child manifest inside the ordinary Board lane.
        waitForRelease: true,
      });
      if (processBoardClaim.error) {
        if (scanPreflightRef.current === preflightToken) scanPreflightRef.current = null;
        EventLogger.log(
          `[JobBoard] saved recovery not admitted in this window id=${id}`
          + ` run=${resumePlan.boardRunId} reason=${processBoardClaim.error}`,
        );
        return { status: processBoardClaim.busy ? 'busy' : 'failed', error: processBoardClaim.error };
      }
    }

    // Resolve the allow-list from the live graph at admission. The stored list
    // can contain ids whose edges were removed since the last render; those
    // modules must never be run merely because a stale closure still listed
    // them. Missing selection remains the backwards-compatible "all" default.
    const liveNodes = getNodes();
    const liveEdges = getEdges();
    // Canvas node order is the stable fallback. An explicit per-Board
    // execution preference can move connected Searches ahead of that fallback
    // without changing the persisted selection allow-list's membership.
    const connectedIds = getConnectedJobSearchIds(id, liveNodes, liveEdges);
    const liveBoardData = getNode(id)?.data || data;
    const configuredSelectedIds = orderJobSearchIds(
      liveBoardData.searchExecutionOrder,
      getSelectedConnectedJobSearchIds(liveBoardData.selectedSearchModuleIds, connectedIds),
    );
    const transactionSelectedIds = resumePlan
      ? [...new Set((resumePlan.selectedSearchModuleIds || []).filter(sourceId => typeof sourceId === 'string' && sourceId))]
      : configuredSelectedIds;
    if (transactionSelectedIds.length === 0) {
      addToast({ title: 'Choose Job Search sources', description: 'Select at least one connected source to start or continue. Completed connected results are reused when combining.', type: 'info' });
      if (resumePlan) clearExactBoardScanResume(updateGlobal, id, resumePlan.boardRunId);
      if (scanPreflightRef.current === preflightToken) scanPreflightRef.current = null;
      await releaseJobBoardProcessLease(canvasFilePath, id, resumePlan?.boardRunId, processBoardClaim);
      return;
    }

    const sourceNodesById = new Map(liveNodes.map((node) => [node.id, node]));
    // An unfinished manifest freezes its original provider set. Probe it only
    // when today's all-disabled platform selection is the sole admission
    // blocker; every other readiness boundary stays authoritative.
    const admissionReadiness = !resumePlan
      ? await Promise.all(transactionSelectedIds.map(async (sourceId) => {
        const source = sourceNodesById.get(sourceId);
        const cachedRecoveryProbe = interruptedRecoveryProbes[sourceId] || null;
        const recoveryOwner = source?.data?.manualAiResume?.runId
          ? findJobSearchBoardRecoveryOwner(sourceId, source.data.manualAiResume.runId, liveNodes, liveEdges)
          : findJobSearchBoardActiveRecoveryOwner(sourceId, liveNodes, liveEdges);
        const readiness = moduleSearchReadiness(source, verifyingPlatformsRef.current, {
          orchestratorNodeId: id,
          recoveryOwner,
        });
        const interruptedRecoveryRunId = canInspectInterruptedRecovery(readiness, source?.data)
          ? await inspectExactResumableJobRun(canvasFilePath, sourceId, source?.data, {
            platformsVerifying: hasActivePlatformVerification(verifyingPlatformsRef.current),
          })
          : null;
        return {
          sourceId,
          readiness,
          interruptedRecoveryRunId,
          cachedRecoveryProbe,
        };
      }))
      : [];
    if (
      scanPreflightRef.current !== preflightToken
      || isJobWorkflowDeletionPending(id)
      || !getNode(id)
    ) {
      if (scanPreflightRef.current === preflightToken) scanPreflightRef.current = null;
      await releaseJobBoardProcessLease(canvasFilePath, id, resumePlan?.boardRunId, processBoardClaim);
      return { status: 'cancelled' };
    }
    // Disk state can disappear or be replaced without a React Flow data update.
    // If this click disproves the exact cached token, remove only the matching
    // snapshot so the row immediately returns to its truthful setup state.
    if (!resumePlan) {
      const failedCachedProbes = admissionReadiness.filter(({ sourceId, interruptedRecoveryRunId, cachedRecoveryProbe }) => (
        !interruptedRecoveryRunId
        && cachedRecoveryProbe?.signature === interruptedRecoveryProbeSignature(sourceNodesById.get(sourceId)?.data)
        && typeof cachedRecoveryProbe?.runId === 'string'
        && !!cachedRecoveryProbe.runId
      ));
      if (failedCachedProbes.length > 0) {
        setInterruptedRecoveryProbes((current) => {
          let next = current;
          failedCachedProbes.forEach(({ sourceId, cachedRecoveryProbe }) => {
            const currentProbe = current[sourceId];
            if (
              currentProbe?.signature === cachedRecoveryProbe.signature
              && currentProbe?.runId === cachedRecoveryProbe.runId
            ) {
              if (next === current) next = { ...current };
              delete next[sourceId];
            }
          });
          return next;
        });
      }
    }
    const notReady = !resumePlan && admissionReadiness
      .find(({ readiness, interruptedRecoveryRunId }) => (
        !readiness.ready
        && !interruptedRecoveryRunId
        && !isQueueableSearchContention(readiness)
      ));
    if (notReady) {
      const label = moduleLabel(sourceNodesById.get(notReady.sourceId)?.data);
      addToast({
        title: `${label} needs setup`,
        description: notReady.readiness.readinessReason || 'Finish setting up this search, then try again.',
        type: 'error',
      });
      if (scanPreflightRef.current === preflightToken) scanPreflightRef.current = null;
      return;
    }

    const selectedSourceNodes = transactionSelectedIds
      .map(sourceId => sourceNodesById.get(sourceId))
      .filter(Boolean);
    const admissionPartition = resumePlan
      ? null
      : partitionJobBoardSourceAdmissions(selectedSourceNodes);
    const completedOutcomes = new Map(Object.entries(resumePlan?.completedSourceRuns || {}));
    const incompleteSearches = Array.isArray(resumePlan?.incompleteSearches)
      ? resumePlan.incompleteSearches.map(entry => ({ ...entry }))
      : [];
    // A fresh Board action may include searches that have already completed.
    // Those generations are immutable display inputs, not work items: record
    // their exact terminal receipt now so `selectedIds` below never forwards
    // one to JobSearchNode.runForJobBoard (which would otherwise re-scrape its
    // old career files).  Recovery plans already persist this map and retain
    // their own exact active-child handling, so do not rewrite it here.
    if (!resumePlan) {
      for (const { sourceId, source, admission } of admissionPartition.reusable) {
        // A durable terminal/manual recovery still needs its registered child
        // executor to finish cleanup. Only an ordinary settled generation can
        // be adopted directly as a completed Board input.
        if (source?.data?.manualAiResume?.runId || source?.data?.terminalFinalizationRecovery) continue;
        completedOutcomes.set(sourceId, admission.outcome);
      }
    }
    // A plan written by an older renderer can already list a Test Mode /
    // collection-only child as completed. It is terminal, but not mergeable;
    // normalize that receipt before deciding which children to skip so recovery
    // cannot fall through to the final exact-input mismatch and hide the Board.
    for (const [sourceId, outcome] of completedOutcomes) {
      const source = sourceNodesById.get(sourceId);
      const sourceData = source?.data || {};
      const incompleteOutcome = sourceData.resultDisposition === 'incomplete'
        || outcome?.resultDisposition === 'incomplete';
      if (
        source?.type === 'jobhub'
        && (
          isExplicitlyUnscoredModule(sourceData)
          || sourceData.resultDisposition === 'collection-only'
          || outcome?.resultDisposition === 'collection-only'
          || incompleteOutcome
        )
      ) {
        completedOutcomes.delete(sourceId);
        if (!incompleteSearches.some(entry => entry?.sourceId === sourceId)) {
          incompleteSearches.push({
            sourceId,
            label: moduleLabel(sourceData),
            status: incompleteOutcome ? 'incomplete' : 'non-mergeable',
            error: incompleteOutcome
              ? (sourceData.errorMessage || 'This Job Search completed with incomplete results and cannot be combined.')
              : nonMergeableSearchMessage(sourceData),
          });
        }
      }
    }
    const incompleteIds = new Set(incompleteSearches.map(entry => entry?.sourceId).filter(Boolean));
    const selectedIds = transactionSelectedIds.filter(sourceId => (
      !completedOutcomes.has(sourceId) && !incompleteIds.has(sourceId)
    ));
    // A pre-existing blocked-source generation must be serialised through the
    // Board's exact paused-source receipt.  It is not fresh work, even when a
    // mixed selection also contains newly imported career data.
    const initialContinuationSourceIds = new Set(
      resumePlan ? [] : admissionPartition.continuations.map(entry => entry.sourceId),
    );
    // This one-shot value is the only authority for a provider-starting fresh
    // child. It survives the parent plan for exact crash recovery, while the
    // Search consumes it atomically at its own lane turn.
    const freshImportCapabilities = resumePlan?.freshImportCapabilities || Object.fromEntries(
      (admissionPartition?.fresh || []).map(({ sourceId, admission }) => [
        sourceId,
        admission.freshImportCapability,
      ]).filter(([, capability]) => typeof capability === 'string' && !!capability),
    );

    // A recovered plan can already have classified every selected Search as
    // incomplete while its parent render still carries the durable receipt.
    // There is no child work left to admit in that case.  Do not create a new
    // scan token, rewrite the plan, or take the shared lane merely to discover
    // the same attention state again; clear only this exact old transaction.
    // A plan with every source completed still proceeds to Combine below.
    if (resumePlan && selectedIds.length === 0 && incompleteSearches.length > 0) {
      const pausedOnly = incompleteSearches.every((entry) => entry.status === 'paused');
      const nonMergeableOnly = incompleteSearches.every((entry) => entry.status === 'non-mergeable');
      const labels = incompleteSearches.map((entry) => entry.label).join(', ');
      addToast({
        title: pausedOnly
          ? 'Some searches need attention'
          : nonMergeableOnly
            ? 'Some searches need hiring-fit scoring'
            : 'Some searches did not finish',
        description: pausedOnly
          ? `${labels} paused. Resolve or skip their blocked sources, then run the board again.`
          : nonMergeableOnly
            ? `${labels} completed without hiring-fit scoring. Turn off Test Mode if enabled, then choose Re-scan for New Jobs on each Job Search card before using the Board.`
            : `${labels} did not finish. Review those modules, then run the board again.`,
        type: (pausedOnly || nonMergeableOnly) ? 'info' : 'error',
      });
      clearExactBoardScanResume(updateGlobal, id, resumePlan.boardRunId);
      if (scanPreflightRef.current === preflightToken) scanPreflightRef.current = null;
      await releaseJobBoardProcessLease(canvasFilePath, id, resumePlan.boardRunId, processBoardClaim);
      return { status: 'attention' };
    }

    const entropy = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const boardRunId = resumePlan?.boardRunId || `job-board-scan:${id}:${entropy}`;
    if (!processBoardClaim) {
      processBoardClaim = await claimJobBoardProcessLease({
        canvasFilePath,
        nodeId: id,
        boardRunId,
        operation: 'board-orchestration',
        autoResume: false,
      });
      if (processBoardClaim.error) {
        if (scanPreflightRef.current === preflightToken) scanPreflightRef.current = null;
        EventLogger.log(
          `[JobBoard] new run not admitted in this window id=${id}`
          + ` run=${boardRunId} reason=${processBoardClaim.error}`,
        );
        return { status: processBoardClaim.busy ? 'busy' : 'failed', error: processBoardClaim.error };
      }
    }
    // A plan on an untitled canvas is intentionally not durable across a
    // reload. It is still valid for this Board instance, though: a source-card
    // pause must be able to resume the remaining selected searches and Combine
    // after the user resolves that source without requiring a saved file.
    if (!canvasFilePath && !resumePlan) {
      rememberBoundedRunId(inMemoryUntitledBoardRunIdsRef.current, boardRunId);
    }
    const scanStartedAt = normalizeJobBoardRecoveryTimestamp(resumePlan?.startedAt) ?? Date.now();
    // A timestamp can tie for two click events. Preserve a separate monotonic
    // admission sequence in the plan so recovery ownership replays the same
    // outer-lane FIFO order after a reload, independent of canvas node order.
    const scanAdmissionOrder = normalizeJobBoardAdmissionOrder(resumePlan?.admissionOrder)
      ?? allocateJobBoardAdmissionOrder(liveNodes);
    const scanToken = Symbol(boardRunId);
    const locallyCancelled = epoch.start();
    const cancelled = () => locallyCancelled() || scanRunRef.current !== scanToken || !getNode(id);
    scanRunRef.current = scanToken;
    if (scanPreflightRef.current === preflightToken) scanPreflightRef.current = null;
    activeBoardRunIdRef.current = boardRunId;
    setScanning(true);
    const totalSelected = transactionSelectedIds.length;
    let completed = completedOutcomes.size;
    let processed = completed + incompleteSearches.length;
    const freshSelectedCount = selectedIds.length;
    const reusedSelectedCount = completedOutcomes.size;
    setScanProgress({
      completed: processed,
      total: totalSelected,
      label: freshSelectedCount > 0
        ? 'Waiting to start or continue selected sources…'
        : 'Waiting to combine saved results…',
    });
    EventLogger.log(`[JobBoard] scan ${resumePlan ? 'resumed' : 'started'} id=${id} run=${boardRunId} selected=${transactionSelectedIds.join(',')} fresh=${freshSelectedCount} reused=${reusedSelectedCount}`);

    const baselineSourceRuns = resumePlan?.baselineSourceRuns || Object.fromEntries(
      transactionSelectedIds.map((sourceId) => {
        const source = sourceNodesById.get(sourceId);
        return [sourceId, {
          runId: source?.data?.jobRunId || null,
          resultDisposition: source?.data?.resultDisposition || null,
          fingerprint: moduleCombineFingerprint(
            source?.data?.scoredJobs,
            source?.data?.locationSnapshot?.remoteResidences || source?.data?.remoteResidences || {},
          ),
        }];
      }),
    );
    const queuedRecoverySourceIds = [...new Set([
      ...(Array.isArray(resumePlan?.activeSourceIds) ? resumePlan.activeSourceIds : []),
      resumePlan?.activeSourceId,
    ].filter(sourceId => selectedIds.includes(sourceId)))];
    const queuedRecoverySourceId = queuedRecoverySourceIds[0] || null;
    const queuedRecoverySourceRollbacks = Object.fromEntries(queuedRecoverySourceIds.map((sourceId) => {
      const rollback = resumePlan?.activeSourceRollbacks?.[sourceId]
        || (resumePlan?.activeSourceRollback?.sourceId === sourceId
          ? resumePlan.activeSourceRollback
          : null);
      return [sourceId, rollback];
    }).filter(([, rollback]) => !!rollback));
    const queuedRecoverySourceManualAiRunIds = Object.fromEntries(queuedRecoverySourceIds.map((sourceId) => [
      sourceId,
      resumePlan?.activeSourceManualAiRunIds?.[sourceId],
    ]).filter(([, runId]) => typeof runId === 'string' && !!runId));
    const queuedAwaitingSourceResolutions = (Array.isArray(resumePlan?.awaitingSourceResolutions)
      ? resumePlan.awaitingSourceResolutions
      : [resumePlan?.awaitingSourceResolution]
    ).filter((entry) => (
      entry
      && queuedRecoverySourceIds.includes(entry.sourceId)
      && typeof entry.jobRunId === 'string'
      && !!entry.jobRunId
    ));
    const queuedAwaitingSourceResolution = queuedAwaitingSourceResolutions.find(
      entry => entry.sourceId === queuedRecoverySourceId,
    ) || queuedAwaitingSourceResolutions[0] || null;
    // Freeze any already-planned, unattended-safe child request in the Board
    // receipt before the lane starts. If the app stops between serial children,
    // workspace startup can create that exact child's manifest without mounting
    // the nested canvas or inventing a fresh search window. Unsafe/native/AI-
    // planning children simply have no entry and stay mounted/human-gated.
    const backgroundChildRequests = resumePlan?.backgroundChildRequests || Object.fromEntries(
      transactionSelectedIds.map((sourceId) => [
        sourceId,
        prepareBackgroundBoardChildRequest({
          node: sourceNodesById.get(sourceId),
          boardNodeId: id,
          boardRunId,
          startedAt: scanStartedAt,
          canvasFilePath,
        }),
      ]).filter(([, prepared]) => !!prepared),
    );
    let durableScanResume = {
      version: 1,
      boardRunId,
      startedAt: scanStartedAt,
      admissionOrder: scanAdmissionOrder,
      selectedSearchModuleIds: transactionSelectedIds,
      baselineSourceRuns,
      freshImportCapabilities,
      backgroundChildRequests,
      completedSourceRuns: Object.fromEntries(completedOutcomes),
      incompleteSearches,
      // This exact source/run handoff is the only case where a Board-owned
      // Search may continue from its source-card Solve/Skip UI. Keep the
      // active source and its rollback receipt too, so Cancel remains able to
      // restore the pre-search graph while the Board waits.
      awaitingSourceResolution: queuedAwaitingSourceResolution,
      awaitingSourceResolutions: queuedAwaitingSourceResolutions,
      recoverableFailure: resumePlan?.recoverableFailure || null,
      activeSourceRollback: queuedRecoverySourceId
        ? queuedRecoverySourceRollbacks[queuedRecoverySourceId] || null
        : null,
      activeSourceIds: queuedRecoverySourceIds,
      activeSourceRollbacks: queuedRecoverySourceRollbacks,
      activeSourceManualAiRunIds: queuedRecoverySourceManualAiRunIds,
      // Keep the interrupted child's ownership visible while this recovered
      // Board waits for the outer lane. Clearing it here lets JobSearch's own
      // auto-resume adopt the same manual handoff as a standalone run.
      activeSourceId: queuedRecoverySourceId,
      phase: 'searches',
      updatedAt: Date.now(),
    };
    const persistScanResume = (patch = {}) => {
      let nextPatch = patch;
      // A fan-out can reach more than one source-card pause.  The existing UI
      // deliberately operates one Solve/Skip card at a time, so consuming the
      // active descriptor promotes the next durable descriptor rather than
      // dropping it with the legacy singular field.
      if (
        patch.awaitingSourceResolution === null
        && !Object.hasOwn(patch, 'awaitingSourceResolutions')
        && Array.isArray(durableScanResume.awaitingSourceResolutions)
        && durableScanResume.awaitingSourceResolutions.length > 0
      ) {
        const consumedSourceId = durableScanResume.awaitingSourceResolution?.sourceId
          || durableScanResume.activeSourceId;
        const promoted = promoteJobBoardPausedSourceResolution({
          awaitingSourceResolutions: durableScanResume.awaitingSourceResolutions,
          activeSourceId: durableScanResume.activeSourceId,
          activeSourceIds: durableScanResume.activeSourceIds,
          activeSourceRollbacks: durableScanResume.activeSourceRollbacks,
          activeSourceManualAiRunIds: durableScanResume.activeSourceManualAiRunIds,
          consumedSourceId,
        });
        nextPatch = {
          ...patch,
          ...promoted,
        };
      }
      // Child pending notifications can persist an exact manual-AI run id
      // independently while this Board is awaiting another fan-out child.
      // Merge that same-generation data before any whole-plan write, then
      // prune only sources no longer active in the new receipt.
      const livePlan = getNode(id)?.data?.boardScanResume;
      const liveManualAiRunIds = livePlan?.boardRunId === boardRunId
        ? livePlan.activeSourceManualAiRunIds || {}
        : {};
      const liveCancellationCleanupMap = livePlan?.boardRunId === boardRunId
        ? livePlan.cancellationCleanupsBySource || {}
        : null;
      const liveCancellationCleanups = liveCancellationCleanupMap
        ? (Object.keys(liveCancellationCleanupMap).length > 0
          ? liveCancellationCleanupMap
          : (livePlan.cancellationCleanup?.sourceId
            ? { [livePlan.cancellationCleanup.sourceId]: livePlan.cancellationCleanup }
            : {}))
        : null;
      const nextActiveSourceIds = Object.hasOwn(nextPatch, 'activeSourceIds')
        ? nextPatch.activeSourceIds
        : durableScanResume.activeSourceIds;
      const mergedManualAiRunIds = Object.fromEntries(Object.entries({
        ...liveManualAiRunIds,
        ...(durableScanResume.activeSourceManualAiRunIds || {}),
        ...(nextPatch.activeSourceManualAiRunIds || {}),
      }).filter(([sourceId]) => Array.isArray(nextActiveSourceIds) && nextActiveSourceIds.includes(sourceId)));
      // Source-keyed child cleanup is the canonical receipt. When the live
      // plan exists, prefer it over this closure's older snapshot so a just
      // retired disconnected child cannot be resurrected by a later progress
      // write. The singular field is compatibility-only and mirrors one exact
      // remaining source, never a merged union.
      const mergedCancellationCleanups = {
        ...(liveCancellationCleanups || durableScanResume.cancellationCleanupsBySource || {}),
        ...(nextPatch.cancellationCleanupsBySource || {}),
      };
      const legacyCancellationCleanup = Object.hasOwn(nextPatch, 'cancellationCleanup')
        ? nextPatch.cancellationCleanup
        : Object.values(mergedCancellationCleanups)[0]
          || (liveCancellationCleanups ? null : durableScanResume.cancellationCleanup || null);
      durableScanResume = {
        ...durableScanResume,
        ...nextPatch,
        activeSourceManualAiRunIds: mergedManualAiRunIds,
        cancellationCleanupsBySource: mergedCancellationCleanups,
        cancellationCleanup: legacyCancellationCleanup,
        updatedAt: Date.now(),
      };
      updateGlobal(id, { boardScanResume: durableScanResume });
    };
    persistScanResume();
    let lease = null;
    try {
      const admissionPlanCommitted = await waitForBoardPlanCommit({
        getNode,
        nodeId: id,
        boardRunId,
        matches: plan => plan.phase === 'searches'
          && Array.isArray(plan.selectedSearchModuleIds)
          && transactionSelectedIds.every(sourceId => plan.selectedSearchModuleIds.includes(sourceId)),
      });
      if (!admissionPlanCommitted) {
        throw new Error('The Job Board scan recovery plan was not committed before queue admission.');
      }
      if (cancelled()) return;
      const queueLabel = freshSelectedCount === 0
        ? (totalSelected === 1
          ? 'Combine 1 saved Job Search'
          : `Combine ${totalSelected} saved Job Searches`)
        : freshSelectedCount === 1
          ? 'Continue 1 Job Search and combine'
          : `Continue ${freshSelectedCount} Job Searches and combine`;
      // One Board action is one queue transaction. Keeping this lease through
      // every selected child and the final combine prevents another Board from
      // overwriting an earlier child's result between our verified completion
      // and the live combine snapshot.
      lease = await moduleRunQueue.acquireModuleRun({
        nodeId: id,
        cancellationNodeIds: transactionSelectedIds,
        kind: 'job-board-search',
        lane: 'job-search',
        label: queueLabel,
        onQueued: ({ position }) => {
          updateGlobal(id, { queuedModuleRun: { label: queueLabel, position } });
          setScanProgress({
            completed: processed,
            total: totalSelected,
            label: freshSelectedCount > 0
              ? `Waiting to start or continue selected sources · queue position ${position}`
              : `Waiting to combine saved results · queue position ${position}`,
          });
        },
        onQueueUpdate: ({ position }) => {
          updateGlobal(id, { queuedModuleRun: { label: queueLabel, position } });
          setScanProgress({
            completed: processed,
            total: totalSelected,
            label: freshSelectedCount > 0
              ? `Waiting to start or continue selected sources · queue position ${position}`
              : `Waiting to combine saved results · queue position ${position}`,
          });
        },
        onStart: () => {
          updateGlobal(id, { queuedModuleRun: null });
          if (
            cancelled()
            || isJobWorkflowDeletionPending(id)
            || transactionSelectedIds.some(sourceId => isJobWorkflowDeletionPending(sourceId))
          ) {
            const error = new Error('Job Board scan cancelled');
            error.code = 'JOB_WORKFLOW_DELETION_PENDING';
            throw error;
          }
        },
      });
      scanLaneLeaseOwnerRef.current = scanToken;
      if (cancelled()) return;
      // The Board can be locked while this transaction waits behind another
      // lane owner. Yield without touching any child and retain the exact
      // recovery plan so unlocking can retry the same Board run.
      if (getNode(id)?.data?.locked) {
        autoResumedBoardScanRef.current = null;
        EventLogger.log(`[JobBoard] scan deferred because Board was locked at its lane turn id=${id} run=${boardRunId}`);
        return;
      }

      // Fresh searches are independent until their results are joined for the
      // Board Combine.  Do not make a person answer Search A's copy/paste
      // prompt before Searches B and C are even allowed to issue theirs.  The
      // Board remains the single lane owner; this is deliberately a child
      // *fan-out*, not a second Board transaction or a concurrent Combine.
      // Recovery keeps the same source order and replays these children one at
      // a time, which is safe because every pending child has its own durable
      // manual-AI marker and rollback receipt.
      const parallelFreshChildren = !resumePlan
        && selectedIds.length > 1
        && initialContinuationSourceIds.size === 0;
      let sourceIdsToRunSerially = selectedIds;
      if (parallelFreshChildren) {
        const activeSourceRollbacks = Object.fromEntries(selectedIds.map((sourceId) => {
          const source = getNode(sourceId);
          return [sourceId, captureJobSearchRollback(
            sourceId,
            source?.data || {},
            getNodes(),
            getEdges(),
          )];
        }));
        const firstSourceId = selectedIds[0];
        persistScanResume({
          activeSourceId: firstSourceId,
          activeSourceIds: [...selectedIds],
          activeSourceRollback: activeSourceRollbacks[firstSourceId],
          activeSourceRollbacks,
          activeSourceManualAiRunIds: {},
          awaitingSourceResolution: null,
        });
        const fanoutPlanCommitted = await waitForBoardPlanCommit({
          getNode,
          nodeId: id,
          boardRunId,
          matches: plan => plan.phase === 'searches'
            && Array.isArray(plan.activeSourceIds)
            && selectedIds.every(sourceId => plan.activeSourceIds.includes(sourceId)),
        });
        if (!fanoutPlanCommitted) {
          throw new Error('The Job Board child handoff plan was not committed before starting selected searches.');
        }
        if (cancelled()) return;
        selectedIds.forEach(sourceId => activeSearchModuleIdsRef.current.add(sourceId));
        EventLogger.log(`[JobBoard] scan launching fresh child fan-out id=${id} run=${boardRunId} sources=${selectedIds.join(',')}`);
        const fanoutTerminalSourceIds = new Set();
        const fanoutCleanupFailureSourceIds = new Set();
        const recordFreshChildSettlement = async ({ sourceId, result, error }) => {
          // This callback waits for an exact durable receipt: a process crash
          // while another child waits at manual AI must leave every finished
          // sibling as a Board outcome, not as an active source recovery can
          // rerun.
          if (cancelled() || scanRunRef.current !== scanToken) return;
          const livePlan = getNode(id)?.data?.boardScanResume;
          const activeIds = Array.isArray(durableScanResume.activeSourceIds)
            ? durableScanResume.activeSourceIds
            : [];
          if (
            livePlan?.boardRunId !== boardRunId
            || durableScanResume.boardRunId !== boardRunId
            || !activeIds.includes(sourceId)
          ) return;
          const source = getNode(sourceId);
          const sourceData = source?.data || {};
          const label = moduleLabel(sourceData);
          if (
            error?.code === 'BOARD_CANCELLATION_CLEANUP_FAILED'
            || (
              livePlan.cancellationCleanup?.sourceId === sourceId
              && livePlan.cancellationCleanup?.boardRunId === boardRunId
            )
          ) {
            fanoutCleanupFailureSourceIds.add(sourceId);
            setRecoveryError(error?.message || `${label} cleanup did not finish.`);
            return;
          }
          const terminal = terminalJobSearchOutcome(source);
          const exactCompleted = result?.status === 'completed'
            && !!terminal
            && isMergeableTerminalJobSearchOutcome(source, terminal)
            && (!result.runId || terminal.runId === result.runId)
            && (!sourceData.jobRunId || terminal.runId === sourceData.jobRunId);
          const removeActiveSource = async (patch) => {
            const promoted = promoteJobBoardPausedSourceResolution({
              awaitingSourceResolutions: durableScanResume.awaitingSourceResolutions,
              activeSourceId: durableScanResume.activeSourceId,
              activeSourceIds: durableScanResume.activeSourceIds,
              activeSourceRollbacks: durableScanResume.activeSourceRollbacks,
              activeSourceManualAiRunIds: durableScanResume.activeSourceManualAiRunIds,
              consumedSourceId: sourceId,
            });
            persistScanResume({ ...patch, ...promoted });
            const committed = await waitForBoardPlanCommit({
              getNode,
              nodeId: id,
              boardRunId,
              matches: plan => plan.phase === 'searches'
                && !plan.activeSourceIds?.includes(sourceId)
                && (
                  (patch.completedSourceRuns?.[sourceId]
                    && plan.completedSourceRuns?.[sourceId]?.runId === patch.completedSourceRuns[sourceId].runId)
                  || Array.isArray(plan.incompleteSearches)
                      && plan.incompleteSearches.some(entry => entry?.sourceId === sourceId)
                ),
            });
            if (!committed) throw new Error(`${label} settlement receipt was not committed.`);
            activeSearchModuleIdsRef.current.delete(sourceId);
            fanoutTerminalSourceIds.add(sourceId);
          };
          if (exactCompleted) {
            completedOutcomes.set(sourceId, terminal);
            completed += 1;
            processed += 1;
            await removeActiveSource({
              completedSourceRuns: Object.fromEntries(completedOutcomes),
              incompleteSearches: incompleteSearches.map(entry => ({ ...entry })),
              recoverableFailure: null,
            });
            return;
          }
          if (result?.status === 'paused') {
            const jobRunId = result.runId || sourceData.jobRunId || null;
            if (!jobRunId) return;
            const resolutions = [
              ...(Array.isArray(durableScanResume.awaitingSourceResolutions)
                ? durableScanResume.awaitingSourceResolutions
                : [durableScanResume.awaitingSourceResolution].filter(Boolean)),
              { sourceId, jobRunId, pausedAt: Date.now() },
            ].filter((entry, index, entries) => (
              entry?.sourceId
              && entries.findIndex(item => item.sourceId === entry.sourceId) === index
            )).sort((left, right) => (
              selectedIds.indexOf(left.sourceId) - selectedIds.indexOf(right.sourceId)
            ));
            const activeSourceIds = [...new Set([
              ...(durableScanResume.activeSourceIds || []),
              sourceId,
            ])];
            const activeSourceId = resolutions[0]?.sourceId
              || activeSourceIds.find(candidateId => selectedIds.includes(candidateId))
              || null;
            persistScanResume({
              activeSourceId,
              activeSourceIds,
              activeSourceRollback: durableScanResume.activeSourceRollbacks?.[activeSourceId] || null,
              awaitingSourceResolution: resolutions[0] || null,
              awaitingSourceResolutions: resolutions,
            });
            const committed = await waitForBoardPlanCommit({
              getNode,
              nodeId: id,
              boardRunId,
              matches: plan => plan.phase === 'searches'
                && plan.awaitingSourceResolutions?.some(entry => (
                  entry?.sourceId === sourceId && entry.jobRunId === jobRunId
                )),
            });
            if (!committed) throw new Error(`${label} paused-source receipt was not committed.`);
            return;
          }
          // A failed, invalid, or individually-cancelled child is terminal for
          // this Board run. Keep its exact attention row and retire its active
          // rollback so reload never starts a replacement provider run.
          const status = result?.status === 'cancelled'
            ? 'disconnected'
            : result?.status || (error ? 'failed' : 'incomplete');
          const message = result?.error || error?.message || (
            result?.status === 'completed'
              ? `${label} changed before its terminal result could be recorded.`
              : `${label} did not finish.`
          );
          if (!incompleteSearches.some(entry => entry?.sourceId === sourceId)) {
            incompleteSearches.push({ sourceId, label, status, error: message });
          }
          processed += 1;
          await removeActiveSource({
            completedSourceRuns: Object.fromEntries(completedOutcomes),
            incompleteSearches: incompleteSearches.map(entry => ({ ...entry })),
          });
        };
        const childResults = await runJobBoardChildFanout(selectedIds, async (sourceId) => {
          const childCancelled = () => cancelled() || !getEdges().some((edge) => (
            (edge.source === id && edge.target === sourceId)
            || (edge.target === id && edge.source === sourceId)
          ));
          return jobSearchCoordinator.runSearchModule(sourceId, {
            orchestratorNodeId: id,
            boardRunId,
            isCancelled: childCancelled,
            freshImportCapability: freshImportCapabilities[sourceId] || null,
          });
        }, { onSettled: recordFreshChildSettlement });
        EventLogger.log(`[JobBoard] scan fresh child fan-out settled id=${id} run=${boardRunId} sources=${selectedIds.join(',')}`);
        if (cancelled()) return;
        const settlementCommitFailure = childResults.find(item => item.persistenceError);
        if (settlementCommitFailure) {
          const message = settlementCommitFailure.persistenceError?.message
            || `${moduleLabel(getNode(settlementCommitFailure.sourceId)?.data)} settlement could not be committed.`;
          setRecoveryError(message);
          EventLogger.error(
            `[JobBoard] child settlement receipt was not committed; retaining recovery authority id=${id}`
            + ` run=${boardRunId} source=${settlementCommitFailure.sourceId}:`,
            settlementCommitFailure.persistenceError,
          );
          return;
        }
        if (fanoutCleanupFailureSourceIds.size > 0) {
          // The child has already installed the exact cleanup receipt. Keep
          // it authoritative; classifying this as a normal incomplete result
          // would clear the retryable cancellation ledger on reload.
          return;
        }
        const pausedSources = [];
        for (const { sourceId, result, error } of childResults) {
          if (cancelled()) return;
          if (fanoutTerminalSourceIds.has(sourceId)) continue;
          activeSearchModuleIdsRef.current.delete(sourceId);
          const source = getNode(sourceId);
          const label = moduleLabel(source?.data);
          if (error || result?.status === 'failed' || result?.status === 'not-ready' || result?.status === 'busy') {
            processed += 1;
            incompleteSearches.push({
              sourceId,
              label,
              status: result?.status || 'failed',
              error: result?.error || error?.message || `${label} did not finish.`,
            });
            continue;
          }
          if (result?.status === 'cancelled') {
            // A single disconnected child is cancelled in place so its
            // siblings can finish their independent work.  Only the Board
            // cancellation token above ends the whole transaction.
            processed += 1;
            incompleteSearches.push({
              sourceId,
              label,
              status: 'disconnected',
              error: result?.error || `${label} was disconnected while it was running.`,
            });
            continue;
          }
          if (result?.status === 'paused') {
            const pausedJobRunId = result.runId || source?.data?.jobRunId || null;
            if (pausedJobRunId) pausedSources.push({ sourceId, jobRunId: pausedJobRunId });
            continue;
          }
          if (result?.status === 'recovery-inspection-failed'
            || result?.status === 'recovery-finalization-failed'
            || result?.status === 'recovery-cleanup-failed') {
            persistScanResume({
              activeSourceId: sourceId,
              activeSourceIds: [sourceId],
              activeSourceRollback: activeSourceRollbacks[sourceId],
              activeSourceRollbacks: { [sourceId]: activeSourceRollbacks[sourceId] },
              recoverableFailure: { sourceId, kind: 'inspection', status: result.status, runId: result.runId || null, error: result.error || null },
            });
            setRecoveryError(result.error || `${label} recovery could not be inspected.`);
            return;
          }
          const outcome = terminalJobSearchOutcome(source);
          if (result?.status !== 'completed' || !outcome || !isMergeableTerminalJobSearchOutcome(source, outcome)) {
            processed += 1;
            incompleteSearches.push({
              sourceId,
              label,
              status: !outcome ? 'incomplete' : 'non-mergeable',
              error: !outcome
                ? (source?.data?.errorMessage || `${label} did not publish a complete result that can be combined.`)
                : nonMergeableSearchMessage(source?.data),
            });
            continue;
          }
          completedOutcomes.set(sourceId, outcome);
          completed += 1;
          processed += 1;
        }
        if (pausedSources.length > 0) {
          const firstPaused = pausedSources[0];
          const pausedSourceRollbacks = Object.fromEntries(pausedSources.map(({ sourceId }) => [
            sourceId,
            activeSourceRollbacks[sourceId],
          ]));
          persistScanResume({
            activeSourceId: firstPaused.sourceId,
            activeSourceIds: pausedSources.map(({ sourceId }) => sourceId),
          activeSourceRollback: activeSourceRollbacks[firstPaused.sourceId],
          activeSourceRollbacks: pausedSourceRollbacks,
          activeSourceManualAiRunIds: Object.fromEntries(pausedSources.map(({ sourceId }) => [
            sourceId,
            activeSearchManualAiRunIdsRef.current.get(sourceId)?.runId,
          ]).filter(([, runId]) => typeof runId === 'string' && !!runId)),
            completedSourceRuns: Object.fromEntries(completedOutcomes),
            incompleteSearches: incompleteSearches.map(entry => ({ ...entry })),
            awaitingSourceResolution: { ...firstPaused, pausedAt: Date.now() },
            // The singular field remains the source-card continuation contract.
            // Retain every other paused child durably so a reload/cancellation
            // cannot orphan its rollback or manual marker; recovery advances
            // them in selected order after the active card is resolved.
            awaitingSourceResolutions: pausedSources.map(item => ({ ...item, pausedAt: Date.now() })),
          });
          setScanProgress({
            completed: processed,
            total: totalSelected,
            currentLabel: moduleLabel(getNode(firstPaused.sourceId)?.data),
            label: 'Waiting for a selected Job Search to finish its resolved sources…',
          });
          EventLogger.log(`[JobBoard] scan waiting for source resolution after fresh child fan-out id=${id} run=${boardRunId} source=${firstPaused.sourceId} jobRun=${firstPaused.jobRunId}`);
          return;
        }
        persistScanResume({
          activeSourceId: null,
          activeSourceIds: [],
          activeSourceRollback: null,
          activeSourceRollbacks: {},
          activeSourceManualAiRunIds: {},
          completedSourceRuns: Object.fromEntries(completedOutcomes),
          incompleteSearches: incompleteSearches.map(entry => ({ ...entry })),
          awaitingSourceResolution: null,
          recoverableFailure: null,
        });
        sourceIdsToRunSerially = [];
      }

      for (const sourceId of sourceIdsToRunSerially) {
        if (cancelled()) return;
        // This receipt can promote the next paused child while this same
        // recovered Board invocation is still walking the selected order.
        // Never keep consulting the immutable click/reload snapshot here: it
        // would recognize only the first manual-AI handoff and strand the
        // remaining durable descriptors after that first continuation settles.
        const iterationPlan = durableScanResume;
        const sourceNode = getNode(sourceId);
        const stillConnected = getEdges().some((edge) => (
          (edge.source === id && edge.target === sourceId)
          || (edge.target === id && edge.source === sourceId)
        ));
        const label = moduleLabel(sourceNode?.data);
        if (!sourceNode || sourceNode.type !== 'jobhub' || !stillConnected) {
          const disconnectedResume = sourceNode?.data?.manualAiResume;
          if (
            iterationPlan?.activeSourceId === sourceId
            || (
              disconnectedResume?.runId
              && disconnectedResume.orchestratorNodeId === id
              && disconnectedResume.boardRunId === boardRunId
            )
          ) {
            try {
              await jobSearchCoordinator.cancelSearchModule(sourceId, {
                orchestratorNodeId: id,
                boardRunId,
                reason: 'job-board-search-disconnected',
                queueManagedExternally: true,
              });
            } catch (error) {
              const message = error?.message || `${label} could not be rolled back safely.`;
              setRecoveryError(message);
              setScanProgress({
                completed: processed,
                total: totalSelected,
                currentLabel: label,
                label: `${label} cleanup needs Retry or Cancel…`,
              });
              EventLogger.error(
                `[JobBoard] disconnected recovery cleanup failed; receipt retained id=${id}`
                + ` run=${boardRunId} source=${sourceId}:`,
                error,
              );
              return;
            }
            if (cancelled()) return;
          }
          processed += 1;
          incompleteSearches.push({
            sourceId,
            label,
            status: 'disconnected',
            error: `${label} was disconnected before its turn.`,
          });
          persistScanResume({
            activeSourceId: null,
            activeSourceRollback: null,
            incompleteSearches: incompleteSearches.map(entry => ({ ...entry })),
          });
          EventLogger.log(`[JobBoard] disconnected scan module skipped id=${id} run=${boardRunId} source=${sourceId}`);
          continue;
        }

        // A source-card continuation can already own the shared lane when this
        // recovered Board queues behind it.  Its terminal React write may land
        // just before this Board receives its turn.  Adopt only the exact
        // paused generation this plan recorded, before readiness/recovery can
        // interpret the now-`done` hub as a new interrupted search and start a
        // replacement provider run.  A manual-AI marker, including a terminal
        // retirement marker, remains a required child cleanup transaction and
        // must therefore go through the registered child executor below.
        const pausedLaneOutcome = resolveExactPausedJobBoardTerminal({
          boardRunId,
          resumePlan: iterationPlan,
          livePlan: getNode(id)?.data?.boardScanResume || null,
          sourceId,
          source: sourceNode,
        });
        if (pausedLaneOutcome.status === 'adopted') {
          if (!pausedLaneOutcome.mergeable) {
            processed += 1;
            incompleteSearches.push({
              sourceId,
              label,
              status: 'non-mergeable',
              error: nonMergeableSearchMessage(sourceNode.data),
            });
            persistScanResume({
              activeSourceId: null,
              activeSourceRollback: null,
              awaitingSourceResolution: null,
              recoverableFailure: null,
              incompleteSearches: incompleteSearches.map(entry => ({ ...entry })),
            });
            setScanProgress({
              completed: processed,
              total: totalSelected,
              currentLabel: label,
              label: `${label} needs hiring-fit scoring before this Board can combine…`,
            });
            EventLogger.log(
              `[JobBoard] paused source completed without mergeable results id=${id}`
              + ` run=${boardRunId} source=${sourceId}`,
            );
            continue;
          }
          completedOutcomes.set(sourceId, pausedLaneOutcome.outcome);
          completed += 1;
          processed += 1;
          persistScanResume({
            activeSourceId: null,
            activeSourceRollback: null,
            completedSourceRuns: Object.fromEntries(completedOutcomes),
            awaitingSourceResolution: null,
            recoverableFailure: null,
          });
          setScanProgress({ completed: processed, total: totalSelected, currentLabel: label });
          EventLogger.log(
            `[JobBoard] adopted terminal paused source id=${id} run=${boardRunId}`
            + ` source=${sourceId} jobRun=${pausedLaneOutcome.expectedRunId}`,
          );
          continue;
        }
        if (pausedLaneOutcome.status === 'generation-changed') {
          // The waiting Board must never turn a newer/older Search generation
          // into a generic interrupted-run retry. The original exact handoff
          // is still durable so the user can inspect or cancel it, but its
          // source identity changed while we were queued.
          const message = `${label} changed before its paused source continuation could finish.`;
          setRecoveryError(message);
          setScanProgress({
            completed: processed,
            total: totalSelected,
            currentLabel: label,
            label: `${label} changed while the Board was waiting. Retry or cancel this Board run.`,
          });
          EventLogger.log(
            `[JobBoard] paused source generation changed before lane turn id=${id}`
            + ` run=${boardRunId} source=${sourceId}`,
          );
          return;
        }

        // A Board can wait behind another transaction for minutes. Re-evaluate
        // the complete live admission contract at the moment this child would
        // start; the click-time verdict is no longer authoritative. In
        // particular, never wipe a sources-ready recovery left by the Board
        // that ran ahead of us.
        let turnSourceNode = sourceNode;
        let childManualAiResume = turnSourceNode.data?.manualAiResume || null;
        let turnNodes = getNodes();
        let turnEdges = getEdges();
        let recoveryOwner = childManualAiResume?.runId
          ? findJobSearchBoardRecoveryOwner(sourceId, childManualAiResume.runId, turnNodes, turnEdges)
          : findJobSearchBoardActiveRecoveryOwner(sourceId, turnNodes, turnEdges);
        let recoveryOwnedHere = !recoveryOwner || (
          recoveryOwner.orchestratorNodeId === id && recoveryOwner.boardRunId === boardRunId
        );
        let turnReadiness = moduleSearchReadiness(turnSourceNode, verifyingPlatformsRef.current, {
          orchestratorNodeId: id,
          boardRunId,
          recoveryOwner,
        });
        // This check is repeated at the actual queue turn. The click-time
        // inspection above may now be stale, and a resumed Board has no
        // click-time inspection at all.
        const initialRecoveryProbeSignature = interruptedRecoveryProbeSignature(sourceNode.data);
        let interruptedRecoveryRunId = canInspectInterruptedRecovery(turnReadiness, sourceNode.data)
          ? await inspectExactResumableJobRun(canvasFilePath, sourceId, sourceNode.data, {
            platformsVerifying: hasActivePlatformVerification(verifyingPlatformsRef.current),
          })
          : null;
        // Inspection crosses an async IPC boundary. Re-read both the Search and
        // platform session immediately afterwards: the child itself performs
        // this same verification check before it can mutate state. If it began
        // while we were peeking, retain the durable Board plan and yield rather
        // than recording a false incomplete result (or handing a stale token to
        // a child that will only return `not-ready`).
        turnSourceNode = getNode(sourceId);
        turnNodes = getNodes();
        turnEdges = getEdges();
        if (!turnSourceNode || turnSourceNode.type !== 'jobhub') {
          persistScanResume({ activeSourceId: sourceId });
          return;
        }
        childManualAiResume = turnSourceNode.data?.manualAiResume || null;
        recoveryOwner = childManualAiResume?.runId
          ? findJobSearchBoardRecoveryOwner(sourceId, childManualAiResume.runId, turnNodes, turnEdges)
          : findJobSearchBoardActiveRecoveryOwner(sourceId, turnNodes, turnEdges);
        recoveryOwnedHere = !recoveryOwner || (
          recoveryOwner.orchestratorNodeId === id && recoveryOwner.boardRunId === boardRunId
        );
        turnReadiness = moduleSearchReadiness(turnSourceNode, verifyingPlatformsRef.current, {
          orchestratorNodeId: id,
          boardRunId,
          recoveryOwner,
        });
        if (
          hasActivePlatformVerification(verifyingPlatformsRef.current)
          || turnReadiness.statusLabel === 'Checking connections'
        ) {
          persistScanResume({ activeSourceId: sourceId });
          // This scan already consumed its one-shot recovery key. Verification
          // is an external, retryable gate, so release it for the settled
          // session rather than stranding the durable plan after it finishes.
          autoResumedBoardScanRef.current = null;
          setScanProgress({
            completed: processed,
            total: totalSelected,
            currentLabel: label,
            label: `Waiting for ${label} connection checks…`,
          });
          EventLogger.log(`[JobBoard] recovered scan waiting for platform verification after manifest inspection id=${id} run=${boardRunId} source=${sourceId}`);
          return;
        }
        // Location/profile edits during the first peek invalidate that answer.
        // Re-inspect against the current Search data before passing any token to
        // the child; a replaced manifest still fails closed in the child too.
        if (initialRecoveryProbeSignature !== interruptedRecoveryProbeSignature(turnSourceNode.data)) {
          interruptedRecoveryRunId = canInspectInterruptedRecovery(turnReadiness, turnSourceNode.data)
            ? await inspectExactResumableJobRun(canvasFilePath, sourceId, turnSourceNode.data, {
              platformsVerifying: hasActivePlatformVerification(verifyingPlatformsRef.current),
            })
            : null;
          if (hasActivePlatformVerification(verifyingPlatformsRef.current)) {
            persistScanResume({ activeSourceId: sourceId });
            // See the post-peek verification yield above: the same exact plan
            // must re-enter after the connection check settles.
            autoResumedBoardScanRef.current = null;
            setScanProgress({
              completed: processed,
              total: totalSelected,
              currentLabel: label,
              label: `Waiting for ${label} connection checks…`,
            });
            EventLogger.log(`[JobBoard] recovered scan waiting for platform verification after manifest reinspection id=${id} run=${boardRunId} source=${sourceId}`);
            return;
          }
        }
        const exactSavedScrapeRecovery = !!childManualAiResume?.runId
          && childManualAiResume.runId === turnSourceNode.data?.manualAiResume?.runId
          && isSavedScrapeManualAiResume(childManualAiResume);
        const savedRecoveryCanProceed = exactSavedScrapeRecovery
          && recoveryOwnedHere
          && !turnSourceNode.data?.locked
          && !ACTIVE_SEARCH_STATES.has(turnSourceNode.data?.hubState)
          && turnReadiness.statusLabel !== 'Checking connections'
          && turnReadiness.statusLabel !== 'Deletion pending';
        const pausedContinuation = exactPausedSourceContinuation(
          iterationPlan,
          sourceId,
          turnSourceNode.data,
        );
        const awaitingPausedSource = iterationPlan?.awaitingSourceResolution?.sourceId === sourceId
          && iterationPlan.awaitingSourceResolution?.jobRunId === turnSourceNode.data?.jobRunId;
        // The first Board click against an already-paused Search records this
        // exact source/run pair before dispatching the child. Until the user
        // resolves/skips the source card (or its own continuation starts), do
        // not turn that durable nonterminal generation into a fresh scan.
        if (
          awaitingPausedSource
          && !pausedContinuation
          && (
            turnSourceNode.data?.hubState === 'sources-ready'
            || ACTIVE_SEARCH_STATES.has(turnSourceNode.data?.hubState)
          )
        ) {
          setScanProgress({
            completed: processed,
            total: totalSelected,
            currentLabel: label,
            label: `Waiting for ${label} to finish its existing paused search…`,
          });
          autoResumedBoardScanRef.current = null;
          return;
        }
        // The exact paused handoff may be clean-but-still-sources-ready, or it
        // may have been save-sanitized after scoring started. In both cases the
        // Board's durable source/run pair—not today's editable platform
        // settings—authorizes the child continuation.
        const pausedContinuationCanProceed = !!pausedContinuation
          && recoveryOwnedHere
          && !turnSourceNode.data?.locked
          && !hasPendingManualAiRetirement(turnSourceNode.data)
          && turnReadiness.statusLabel !== 'Checking connections'
          && turnReadiness.statusLabel !== 'Deletion pending';
        const interruptedRecoveryCanProceed = !!interruptedRecoveryRunId
          && recoveryOwnedHere
          && !turnSourceNode.data?.locked
          && !ACTIVE_SEARCH_STATES.has(turnSourceNode.data?.hubState)
          && turnReadiness.statusLabel !== 'Deletion pending';
        if (!turnReadiness.ready && !savedRecoveryCanProceed && !pausedContinuationCanProceed && !interruptedRecoveryCanProceed) {
          if (turnReadiness.statusLabel === 'Deletion pending') {
            // onBeforeDelete is reversible until its cancellation/OS work
            // commits. Keep this exact Board transaction intact; if deletion
            // is aborted, React Flow's next update can resume the same source.
            EventLogger.log(
              `[JobBoard] scan yielding while Search deletion is pending id=${id}`
              + ` run=${boardRunId} source=${sourceId}`,
            );
            return;
          }
          if (recoveryOwner && !recoveryOwnedHere) {
            // Renderer mount order can let a later queued Board acquire the
            // lane before the older durable owner has re-entered it. Yield
            // without recording a failure or changing this plan; the older
            // owner needs this same lane to finish or roll back. Its durable
            // ownership update wakes this Board for another exact attempt.
            autoResumedBoardScanRef.current = null;
            foreignRecoveryWaitSigRef.current = boardRecoverySig;
            setScanProgress({
              completed: processed,
              total: totalSelected,
              currentLabel: label,
              label: `Waiting for ${label} to finish its earlier Board recovery…`,
            });
            EventLogger.log(
              `[JobBoard] recovered scan yielding to prior owner id=${id} run=${boardRunId}`
              + ` source=${sourceId} owner=${recoveryOwner.orchestratorNodeId}:${recoveryOwner.boardRunId}`,
            );
            return;
          }
          if (turnReadiness.statusLabel === 'Checking connections') {
            // Startup session verification is temporary and commonly overlaps
            // durable scan recovery. Keep the parent receipt intact and retry
            // after verification settles instead of misclassifying the child
            // as a failed/incomplete search.
            persistScanResume({ activeSourceId: sourceId });
            autoResumedBoardScanRef.current = null;
            setScanProgress({
              completed: processed,
              total: totalSelected,
              currentLabel: label,
              label: `Waiting for ${label} connection checks…`,
            });
            EventLogger.log(`[JobBoard] recovered scan waiting for platform verification id=${id} run=${boardRunId} source=${sourceId}`);
            return;
          }
          processed += 1;
          incompleteSearches.push({
            sourceId,
            label,
            status: turnSourceNode.data?.hubState === 'sources-ready' ? 'paused' : 'not-ready',
            error: turnReadiness.readinessReason || `${label} is not ready to scan.`,
          });
          persistScanResume({
            activeSourceId: null,
            activeSourceRollback: null,
            incompleteSearches: incompleteSearches.map(entry => ({ ...entry })),
          });
          setScanProgress({
            completed: processed,
            total: totalSelected,
            currentLabel: label,
            label: `${label} needs attention — continuing with the remaining searches…`,
          });
          EventLogger.log(
            `[JobBoard] scan module no longer ready; skipped id=${id} run=${boardRunId} source=${sourceId}`,
          );
          continue;
        }

        setScanProgress({
          completed: processed,
          total: totalSelected,
          currentLabel: label,
          label: `Scanning ${label} (${processed + 1} of ${totalSelected})…`,
        });

        activeSearchModuleIdRef.current = sourceId;
        activeSearchModuleIdsRef.current.add(sourceId);
        const retainedRollback = durableScanResume.activeSourceId === sourceId
          && durableScanResume.activeSourceRollback?.sourceId === sourceId
          ? durableScanResume.activeSourceRollback
          : null;
        const activeSourceRollback = retainedRollback || captureJobSearchRollback(
          sourceId,
          turnSourceNode.data,
          getNodes(),
          getEdges(),
        );
        const initialPausedDescriptor = !resumePlan
          && initialContinuationSourceIds.has(sourceId)
          && turnSourceNode.data?.hubState === 'sources-ready'
          && typeof turnSourceNode.data?.jobRunId === 'string'
          && !!turnSourceNode.data.jobRunId
          ? { sourceId, jobRunId: turnSourceNode.data.jobRunId, pausedAt: Date.now() }
          : null;
        // Persist the exact pre-run hub + source-card graph before the child is
        // allowed to clear provenance or dismiss warning cards. This is the
        // reload-safe counterpart of JobSearch's in-memory rollback control.
        persistScanResume({
          activeSourceId: sourceId,
          activeSourceRollback,
          // Do not consume the source-resolution proof until its exact child
          // reaches a terminal receipt. A reload during this call otherwise
          // cannot tell a sanitized empty/done scorer from an unrelated retry.
          awaitingSourceResolution: pausedContinuation
            ? durableScanResume.awaitingSourceResolution
            : initialPausedDescriptor,
        });
        const childPlanCommitted = await waitForBoardPlanCommit({
          getNode,
          nodeId: id,
          boardRunId,
          matches: plan => plan.phase === 'searches'
            && plan.activeSourceId === sourceId
            && plan.activeSourceRollback?.sourceId === sourceId
            && (!initialPausedDescriptor || (
              plan.awaitingSourceResolution?.sourceId === sourceId
              && plan.awaitingSourceResolution?.jobRunId === initialPausedDescriptor.jobRunId
            )),
        });
        if (!childPlanCommitted) {
          throw new Error(`${label} could not start because its rollback receipt was not committed.`);
        }
        if (cancelled()) return;
        try {
          const childCancelled = () => cancelled() || !getEdges().some((edge) => (
            (edge.source === id && edge.target === sourceId)
            || (edge.target === id && edge.source === sourceId)
          ));
          const providerPhaseOnlyRecovery = !!resumePlan
            && !explicitRecoveryContinue
            && !pausedContinuation
            && !durableScanResume.recoverableFailure;
          const backgroundProviderBootstrap = providerPhaseOnlyRecovery
            ? validateBackgroundBoardChildRequest(
              durableScanResume.backgroundChildRequests?.[sourceId],
              turnSourceNode,
              durableScanResume,
              canvasFilePath,
            )
            : null;
          const result = await jobSearchCoordinator.runSearchModule(sourceId, {
            orchestratorNodeId: id,
            boardRunId,
            isCancelled: childCancelled,
            // On restart the child still owns the exact pending AI handoff, but
            // the Board must reacquire and retain the queue transaction. Give
            // its registered executor the durable descriptor instead of
            // letting JobSearchNode resume as an unrelated standalone run.
            manualAiResume: childManualAiResume,
            // This only carries the Board's already-persisted exact handoff.
            // It lets the Search finish clean paused rows or reopen the same
            // staged run; it never authorizes a fresh search.
            pausedSourceContinuation: pausedContinuation,
            freshImportCapability: durableScanResume.freshImportCapabilities?.[sourceId] || null,
            // A Board reload during query/scrape has no manual-AI marker yet.
            // Preserve that distinct recovery intent so the Search probes its
            // exact staged run before considering a fresh retry.
            recoverInterruptedJobRun: !!iterationPlan
              && iterationPlan.activeSourceId === sourceId,
            // Never persist this probe result. It is a one-turn capability
            // that lets the child verify and resume this exact manifest before
            // applying its normal fresh-search source validation.
            interruptedRecoveryRunId,
            finalizationRecovery: durableScanResume.recoverableFailure?.sourceId === sourceId
              && ['terminal-finalization', 'manual-ai-retirement']
                .includes(durableScanResume.recoverableFailure?.kind)
              ? durableScanResume.recoverableFailure
              : null,
            providerPhaseOnlyRecovery,
            allowFreshProviderBootstrap: !!backgroundProviderBootstrap,
            boardRecoveryClaim: processBoardClaim?.claimToken ? {
              nodeId: id,
              boardRunId,
              claimToken: processBoardClaim.claimToken,
              operation: processBoardClaim.operation || 'board-orchestration',
            } : null,
          });
          if (cancelled()) return;
          if (result?.transientReason === 'platforms-verifying') {
            // This is the final race fence: verification can begin after our
            // post-peek check but before the child reads its own live state.
            // The child tags that transient refusal, so keep this exact Board
            // receipt rather than treating it as an incomplete Search or
            // clearing a recovery manifest that has not been touched.
            const postResultSource = getNode(sourceId);
            const verificationStillActive = hasActivePlatformVerification(verifyingPlatformsRef.current)
              || moduleSearchReadiness(postResultSource, verifyingPlatformsRef.current, {
                orchestratorNodeId: id,
                boardRunId,
                recoveryOwner: postResultSource?.data?.manualAiResume?.runId
                  ? findJobSearchBoardRecoveryOwner(
                    sourceId,
                    postResultSource.data.manualAiResume.runId,
                    getNodes(),
                    getEdges(),
                  )
                  : findJobSearchBoardActiveRecoveryOwner(sourceId, getNodes(), getEdges()),
              }).statusLabel === 'Checking connections';
            persistScanResume({
              activeSourceId: sourceId,
              activeSourceRollback,
              recoverableFailure: null,
            });
            // A resumed Board may have claimed a one-shot recovery key. The
            // verification transition is an external input, so let that same
            // durable plan re-enter once its connection check has settled.
            autoResumedBoardScanRef.current = null;
            setScanProgress({
              completed: processed,
              total: totalSelected,
              currentLabel: label,
              label: verificationStillActive
                ? `Waiting for ${label} connection checks…`
                : `${label} connection checks changed; waiting to retry…`,
            });
            EventLogger.log(
              `[JobBoard] scan yielding to child platform verification id=${id}`
              + ` run=${boardRunId} source=${sourceId} stillActive=${verificationStillActive}`,
            );
            return;
          }
          if (result?.status === 'cancelled') {
            if (
              isJobWorkflowDeletionPending(id)
              || isJobWorkflowDeletionPending(sourceId)
            ) {
              // A React Flow deletion is still reversible until onBeforeDelete
              // commits. Preserve the exact parent plan so aborting that
              // boundary can resume this child instead of reporting a user
              // cancellation and silently abandoning the remaining queue.
              autoResumedBoardScanRef.current = null;
              EventLogger.log(
                `[JobBoard] scan yielding after child deletion cancellation id=${id}`
                + ` run=${boardRunId} source=${sourceId}`,
              );
              return;
            }
            // The child card/manual dialog is another control surface for this
            // same Board transaction. Its exact rollback has already restored
            // the Search; stop the parent turn too instead of scanning later
            // children or treating an intentional cancel as a failed module.
            clearExactBoardScanResume(updateGlobal, id, boardRunId);
            EventLogger.log(`[JobBoard] scan cancelled from child id=${id} run=${boardRunId} source=${sourceId}`);
            addToast({
              title: 'Board run cancelled',
              description: 'The existing board and completed search results were kept.',
              type: 'info',
            });
            return;
          }
          if (result?.status === 'paused') {
            if (result.reason === 'awaiting-explicit-ai-continue') {
              persistScanResume({
                activeSourceId: sourceId,
                activeSourceRollback,
                recoverableFailure: null,
              });
              autoResumedBoardScanRef.current = null;
              setScanProgress({
                completed: processed,
                total: totalSelected,
                currentLabel: label,
                label: `${label} provider collection is saved and ready to continue.`,
              });
              setRecoveryError(
                result.error
                || `Saved provider results for ${label} are ready. Continue to run the exact AI handoff.`,
              );
              EventLogger.log(
                `[JobBoard] provider recovery reached explicit AI boundary id=${id}`
                + ` run=${boardRunId} source=${sourceId} jobRun=${result.runId || 'pending'}`,
              );
              return;
            }
            const pausedJobRunId = result.runId || getNode(sourceId)?.data?.jobRunId || null;
            if (typeof pausedJobRunId !== 'string' || !pausedJobRunId) {
              const error = new Error(`${label} paused without a recoverable search run id.`);
              error.searchStatus = 'failed';
              throw error;
            }
            // Stop at the first source-card gate.  The card's exact Solve/Skip
            // continuation completes this same search generation; once it
            // reaches `done`, recovery resumes this Board's remaining selected
            // modules and final Combine without another Board action.
            persistScanResume({
              activeSourceId: sourceId,
              activeSourceRollback,
              awaitingSourceResolution: {
                sourceId,
                jobRunId: pausedJobRunId,
                pausedAt: Date.now(),
              },
            });
            setScanProgress({
              completed: processed,
              total: totalSelected,
              currentLabel: label,
              label: `Waiting for ${label} to finish its resolved sources…`,
            });
            autoResumedBoardScanRef.current = null;
            EventLogger.log(`[JobBoard] scan waiting for source resolution id=${id} run=${boardRunId} source=${sourceId} jobRun=${pausedJobRunId}`);
            return;
          }
          if (
            result?.status === 'recovery-inspection-failed'
            || result?.status === 'recovery-finalization-failed'
            || result?.status === 'recovery-cleanup-failed'
          ) {
            // A transient disk/IPC failure says nothing about whether the
            // staged pages are valid. Keep the exact recovery receipt so Retry
            // inspects that run again instead of overwriting it with a fresh one.
            persistScanResume({
              activeSourceId: sourceId,
              recoverableFailure: {
                kind: result.status === 'recovery-finalization-failed'
                  ? 'terminal-finalization'
                  : result.status === 'recovery-cleanup-failed'
                    ? 'manual-ai-retirement'
                    : 'inspection',
                sourceId,
                status: result.status,
                runId: result.runId || null,
                resultDisposition: result.resultDisposition || null,
                terminalStatus: result.terminalStatus
                  || (result.resultDisposition === 'incomplete' ? 'failed' : 'completed'),
                terminalOutcome: result.terminalOutcome
                  || (result.resultDisposition === 'empty-complete'
                    ? 'zero'
                    : result.resultDisposition === 'scored'
                      ? 'populated'
                      : result.resultDisposition || 'unknown'),
                scoreReadyCount: result.scoreReadyCount != null
                  && Number.isFinite(Number(result.scoreReadyCount))
                  ? Math.max(0, Math.floor(Number(result.scoreReadyCount)))
                  : Array.isArray(getNode(sourceId)?.data?.scoredJobs)
                    ? getNode(sourceId).data.scoredJobs.length
                    : null,
                fingerprint: result.fingerprint || moduleFingerprint(getNode(sourceId)?.data?.scoredJobs),
                manualAiRunId: result.manualAiRunId || null,
                error: result.error || null,
              },
            });
            setRecoveryError(result.error || `${label} recovery could not be inspected.`);
            setScanProgress({
              completed: processed,
              total: totalSelected,
              currentLabel: label,
              label: result.status === 'recovery-finalization-failed'
                ? `${label} recovery files could not be finalized. Retry when ready.`
                : result.status === 'recovery-cleanup-failed'
                  ? `${label} manual-AI cleanup did not finish. Retry when ready.`
                  : `${label} recovery could not be inspected. Retry when ready.`,
            });
            EventLogger.error(
              `[JobBoard] recoverable child failure; receipt retained id=${id} run=${boardRunId} source=${sourceId}:`,
              result.error || 'unknown recovery inspection error',
            );
            return;
          }
          if (result?.status !== 'completed') {
            const error = new Error(result?.error || `${label} did not finish.`);
            error.searchStatus = result?.status || 'failed';
            throw error;
          }
          const remainsConnected = getEdges().some((edge) => (
            (edge.source === id && edge.target === sourceId)
            || (edge.target === id && edge.source === sourceId)
          ));
          if (!remainsConnected) {
            throw new Error(`${label} was disconnected while it was running.`);
          }
          const completedSource = getNode(sourceId);
          const completedOutcome = terminalJobSearchOutcome(completedSource);
          if (!completedOutcome) {
            processed += 1;
            incompleteSearches.push({
              sourceId,
              label,
              status: 'incomplete',
              error: completedSource?.data?.errorMessage
                || `${label} did not publish a complete result that can be combined.`,
            });
            persistScanResume({
              activeSourceId: null,
              activeSourceRollback: null,
              awaitingSourceResolution: null,
              recoverableFailure: null,
              incompleteSearches: incompleteSearches.map(entry => ({ ...entry })),
            });
            setScanProgress({
              completed: processed,
              total: totalSelected,
              currentLabel: label,
              label: `${label} did not finish cleanly — continuing with the remaining searches…`,
            });
            EventLogger.error(
              `[JobBoard] selected source returned completed without a terminal receipt id=${id}`
              + ` run=${boardRunId} source=${sourceId}`,
            );
            continue;
          }
          if (!isMergeableTerminalJobSearchOutcome(completedSource, completedOutcome)) {
            processed += 1;
            incompleteSearches.push({
              sourceId,
              label,
              status: 'non-mergeable',
              error: nonMergeableSearchMessage(completedSource?.data),
            });
            persistScanResume({
              activeSourceId: null,
              activeSourceRollback: null,
              awaitingSourceResolution: null,
              recoverableFailure: null,
              incompleteSearches: incompleteSearches.map(entry => ({ ...entry })),
            });
            setScanProgress({
              completed: processed,
              total: totalSelected,
              currentLabel: label,
              label: `${label} needs hiring-fit scoring before this Board can combine…`,
            });
            EventLogger.log(
              `[JobBoard] selected source completed without mergeable results id=${id}`
              + ` run=${boardRunId} source=${sourceId}`,
            );
            continue;
          }
          completedOutcomes.set(sourceId, completedOutcome);
          completed += 1;
          processed += 1;
          persistScanResume({
            activeSourceId: null,
            activeSourceRollback: null,
            completedSourceRuns: Object.fromEntries(completedOutcomes),
            awaitingSourceResolution: null,
            recoverableFailure: null,
          });
          setScanProgress({ completed: processed, total: totalSelected, currentLabel: label });
          EventLogger.log(`[JobBoard] scan module completed id=${id} run=${boardRunId} source=${sourceId}`);
        } catch (error) {
          if (cancelled()) return;
          if (
            isJobWorkflowDeletionPending(id)
            || isJobWorkflowDeletionPending(sourceId)
            || error?.code === 'JOB_WORKFLOW_DELETION_PENDING'
          ) {
            autoResumedBoardScanRef.current = null;
            EventLogger.log(
              `[JobBoard] scan yielding after child deletion error id=${id}`
              + ` run=${boardRunId} source=${sourceId}`,
            );
            return;
          }
          const cleanupPlan = getNode(id)?.data?.boardScanResume;
          if (
            error?.code === 'BOARD_CANCELLATION_CLEANUP_FAILED'
            || (
              cleanupPlan?.boardRunId === boardRunId
              && cleanupPlan.cancellationCleanup?.sourceId === sourceId
            )
          ) {
            // A child card/manual dialog can initiate the same exact rollback.
            // Its cleanup failure is retryable authority, not a provider failure;
            // never replace it with an incomplete row or retire it below.
            const message = error?.message || `${label} cleanup did not finish.`;
            setRecoveryError(message);
            setScanProgress({
              completed: processed,
              total: totalSelected,
              currentLabel: label,
              label: `${label} cleanup needs Retry or Cancel…`,
            });
            EventLogger.error(
              `[JobBoard] child cancellation cleanup retained id=${id} run=${boardRunId} source=${sourceId}:`,
              error,
            );
            return;
          }
          processed += 1;
          incompleteSearches.push({
            sourceId,
            label,
            status: error?.searchStatus || 'failed',
            error: error?.message || String(error),
          });
          persistScanResume({
            activeSourceId: null,
            activeSourceRollback: null,
            incompleteSearches: incompleteSearches.map(entry => ({ ...entry })),
          });
          setScanProgress({
            completed: processed,
            total: totalSelected,
            currentLabel: label,
            label: `${label} needs attention — continuing with the remaining searches…`,
          });
          EventLogger.error(
            `[JobBoard] scan module incomplete; continuing id=${id} run=${boardRunId} source=${sourceId}:`,
            error,
          );
        } finally {
          activeSearchModuleIdsRef.current.delete(sourceId);
          if (activeSearchModuleIdRef.current === sourceId) activeSearchModuleIdRef.current = null;
        }
      }

      if (cancelled()) return;
      if (
        isJobWorkflowDeletionPending(id)
        || transactionSelectedIds.some(sourceId => isJobWorkflowDeletionPending(sourceId))
      ) {
        autoResumedBoardScanRef.current = null;
        EventLogger.log(`[JobBoard] scan yielding before combine while deletion is pending id=${id} run=${boardRunId}`);
        return;
      }
      if (incompleteSearches.length > 0) {
        const pausedOnly = incompleteSearches.every((entry) => entry.status === 'paused');
        const nonMergeableOnly = incompleteSearches.every((entry) => entry.status === 'non-mergeable');
        const labels = incompleteSearches.map((entry) => entry.label).join(', ');
        EventLogger.log(
          `[JobBoard] scan awaiting source attention id=${id} run=${boardRunId} completed=${completed} incomplete=${incompleteSearches.length}`,
        );
        addToast({
          title: pausedOnly
            ? 'Some searches need attention'
            : nonMergeableOnly
              ? 'Some searches need hiring-fit scoring'
              : 'Some searches did not finish',
          description: pausedOnly
            ? `${labels} paused. Resolve or skip their blocked sources, then run the board again.`
            : nonMergeableOnly
              ? `${labels} completed without hiring-fit scoring. Turn off Test Mode if enabled, then choose Re-scan for New Jobs on each Job Search card before using the Board.`
              : `${labels} did not finish. Review those modules, then run the board again.`,
          type: (pausedOnly || nonMergeableOnly) ? 'info' : 'error',
        });
        clearExactBoardScanResume(updateGlobal, id, boardRunId);
        return;
      }
      const supersededSourceId = [...completedOutcomes.keys()].find((sourceId) => {
        const expected = completedOutcomes.get(sourceId);
        const source = getNode(sourceId);
        const connected = getEdges().some((edge) => (
          (edge.source === id && edge.target === sourceId)
          || (edge.target === id && edge.source === sourceId)
        ));
        return !expected
          || !source
          || source.type !== 'jobhub'
          || !connected
          || !completedJobSearchOutcomeMatches(source, expected);
      });
      if (supersededSourceId) {
        const label = moduleLabel(getNode(supersededSourceId)?.data);
        EventLogger.log(`[JobBoard] scan superseded before combine id=${id} run=${boardRunId} source=${supersededSourceId}`);
        addToast({
          title: 'Search results changed',
          description: `${label} changed before the board could combine this scan. Run the board again to keep the result set consistent.`,
          type: 'info',
        });
        clearExactBoardScanResume(updateGlobal, id, boardRunId);
        return;
      }
      setScanProgress({
        completed: totalSelected,
        total: totalSelected,
        label: 'Selected searches complete — combining all connected results…',
      });
      const combineInputState = liveCombineInputs(id, getNodes(), getEdges());
      const combineInputs = combineInputState.completed;
      const combineInputSignature = boardInputSignature(
        combineInputs,
        combineInputState.all,
      );
      // This is transaction authority, not the bounded diagnostic summary kept
      // on a completed Board. Every connected input must remain represented so
      // a 26th+ Search cannot change runs undetected during crash recovery.
      const combineSourceRuns = combineInputs.map(combineSourceRunEntry);
      const combineManualAiRunId = createManualAiRunId(id);
      persistScanResume({
        activeSourceId: null,
        activeSourceRollback: null,
        phase: 'combine',
        completedSourceRuns: Object.fromEntries(completedOutcomes),
        combineInputSignature,
        combineSourceRuns,
        combineManualAiRunId,
      });
      const combinePlanCommitted = await waitForBoardPlanCommit({
        getNode,
        nodeId: id,
        boardRunId,
        matches: plan => plan.phase === 'combine'
          && plan.combineManualAiRunId === combineManualAiRunId
          && plan.combineInputSignature === combineInputSignature,
      });
      if (!combinePlanCommitted) {
        throw new Error('The Job Board combine recovery plan was not committed before processing started.');
      }
      if (cancelled()) return;
      // Continue inside the same Board-owned queue turn. The child executors and
      // Combine both bypass nested admission; the outer lease is released only
      // after the complete scan-and-merge transaction settles.
      const combineOutcome = await handleCombine({
        afterSearch: true,
        queueManagedByScan: true,
        manualAiRunId: combineManualAiRunId,
        expectedCombineSignature: combineInputSignature,
        expectedSourceRuns: Object.fromEntries(completedOutcomes),
        expectedCombineSourceRuns: combineSourceRuns,
      });
      if (cancelled()) return;
      if (combineOutcome?.status === 'failed') {
        setRecoveryError(combineOutcome.error || 'The final Board combine did not finish.');
        return;
      }
      if (
        combineOutcome?.status === 'busy'
        || combineOutcome?.status === 'not-ready'
        || combineOutcome?.status === 'cancelled'
      ) {
        // The exact phase=combine receipt remains authoritative. A transient
        // lock/contention or a reversible deletion attempt must not convert a
        // deferred Combine into a falsely completed scan.
        autoResumedBoardScanRef.current = null;
        autoResumedManualAiRunRef.current = null;
        EventLogger.log(
          `[JobBoard] scan combine deferred id=${id} run=${boardRunId}`
          + ` status=${combineOutcome.status}`,
        );
        return;
      }
      if (combineOutcome?.status === 'superseded') {
        clearExactBoardScanResume(updateGlobal, id, boardRunId);
        EventLogger.log(`[JobBoard] scan combine superseded id=${id} run=${boardRunId}`);
        return;
      }
      if (combineOutcome?.status !== 'completed') {
        setRecoveryError(combineOutcome?.error || 'The final Board combine returned an unknown result.');
        return;
      }
      clearExactBoardScanResume(updateGlobal, id, boardRunId);
      EventLogger.log(`[JobBoard] scan completed id=${id} run=${boardRunId} selected=${totalSelected}`);
    } catch (error) {
      if (
        cancelled()
        || isJobWorkflowDeletionPending(id)
        || transactionSelectedIds.some(sourceId => isJobWorkflowDeletionPending(sourceId))
        || error?.code === 'JOB_WORKFLOW_DELETION_PENDING'
      ) return;
      EventLogger.error(`[JobBoard] scan stopped id=${id} run=${boardRunId}:`, error);
      addToast({
        title: 'Board search stopped',
        description: error?.message || String(error),
        type: 'error',
      });
      clearExactBoardScanResume(updateGlobal, id, boardRunId);
    } finally {
      lease?.release();
      await releaseJobBoardProcessLease(canvasFilePath, id, boardRunId, processBoardClaim);
      if (scanPreflightRef.current === preflightToken) scanPreflightRef.current = null;
      if (scanLaneLeaseOwnerRef.current === scanToken) {
        scanLaneLeaseOwnerRef.current = null;
      }
      if (scanRunRef.current === scanToken) {
        scanRunRef.current = null;
        activeSearchModuleIdRef.current = null;
        activeBoardRunIdRef.current = null;
        updateGlobal(id, { queuedModuleRun: null });
        if (getNode(id)) {
          setScanning(false);
          setScanProgress(null);
        }
      }
    }
  }, [addToast, boardRecoverySig, canvasFilePath, data, epoch, getEdges, getNode, getNodes, handleCombine, id, interruptedRecoveryProbes, jobSearchCoordinator, moduleRunQueue, updateGlobal]);

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
    const searchRecoveryError = searchRecoveryErrorRef.current;
    // A Search error may retry only after a *consumable* external state change.
    // The error identity is intentionally separate from autoResumedBoardScanRef:
    // that latch also carries cleanup/combine tokens whose prefixes cannot prove
    // that a Search changed. We defer clearing until after selected-platform
    // verification is no longer pending below.
    const hasChangedSearchRecoveryInput = plan.phase === 'searches'
      && searchRecoveryError?.message === recoveryError
      && searchRecoveryError.key !== recoveryKey;
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
      // The normal Board manual-resume effect below owns a persisted taxonomy /
      // compensation prompt. If no prompt was published before the interruption,
      // restart only the combine from the completed source snapshots.
      if (data.manualAiResume?.runId) return;
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
    const onManualAiNodeCancelled = (event) => {
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
    const receipts = normalizeManualAiCleanupReceipts(data.manualAiCleanupReceipts);
    if (receipts.length === 0) return;
    // The interactive deletion boundary owns acknowledged retirement while it
    // is pending. Starting a second recovery attempt here can race that exact
    // snapshot/receipt transaction; lifecycle settlement will rerun this effect
    // if deletion is aborted and the Board is retained.
    if (isJobWorkflowDeletionPending(id)) return;
    const liveData = getNode(id)?.data || data;
    const hasCurrentRecovery = !!liveData.boardCancellation
      || !!liveData.boardScanResume
      || !!liveData.manualAiResume;
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

  useEffect(() => {
    const resume = data.manualAiResume;
    if (!resume?.runId) return;
    if (boardRecoveryTouchesPendingDeletion(id, data.boardScanResume, resume)) {
      autoResumedManualAiRunRef.current = null;
      return;
    }
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
  // must not stay disabled behind a stale recoveryError forever.
  useEffect(() => {
    if (recoveryError !== SAVED_HANDOFF_READY_MESSAGE) return;
    if (data.manualAiResume?.runId) return;
    if (combineRunRef.current) return;
    setRecoveryError(null);
  }, [data.manualAiResume?.runId, recoveryError]);

  const handleRetryRecovery = useCallback(() => {
    const liveData = getNode(id)?.data || {};
    const plan = liveData.boardScanResume;
    setRecoveryError(null);
    if (liveData.boardCancellation?.operationId) {
      autoRetriedBoardCancellationRef.current = null;
      void handleCancelRun({
        expectedBoardRunId: liveData.boardCancellation.boardRunId || null,
        reason: liveData.boardCancellation.reason || 'board-run-cancelled',
        suppressToast: true,
      });
      return;
    }
    const supersededCleanupReceipts = normalizeManualAiCleanupReceipts(
      liveData.manualAiCleanupReceipts,
    );
    if (supersededCleanupReceipts.length > 0 && !plan && !liveData.manualAiResume) {
      supersededCleanupReceipts.forEach((receipt) => {
        attemptedSupersededCleanupRunIdsRef.current.delete(receipt.runId);
      });
      void Promise.all(supersededCleanupReceipts.map(receipt => (
        retireBoardCleanupReceipt(receipt)
      ))).then(() => {
        setRecoveryError(null);
      }).catch((error) => {
        setRecoveryError(error?.message || 'An older saved manual-AI handoff still needs cleanup.');
      });
      return;
    }
    if (liveData.manualAiResume?.retirementPending) {
      const manualRunId = liveData.manualAiResume.runId;
      // An explicit Retry is a fresh attempt, even when mount recovery already
      // claimed this id. Reclaim it before invoking cleanup so the auto-effect
      // still sees an in-flight owner if the marker changes during the await.
      attemptedSupersededCleanupRunIdsRef.current.delete(manualRunId);
      attemptedSupersededCleanupRunIdsRef.current.add(manualRunId);
      autoResumedManualAiRunRef.current = manualRunId;
      void retireBoardCleanupReceipt(liveData.manualAiResume).then(() => {
        updateGlobal(id, (node) => {
          const markerOwned = node?.data?.manualAiResume?.runId === manualRunId;
          const ownsPlan = node?.data?.boardScanResume?.combineManualAiRunId === manualRunId;
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
    if (!plan?.boardRunId) {
      const manualRunId = liveData.manualAiResume?.runId || null;
      if (!manualRunId) return;
      autoResumedManualAiRunRef.current = manualRunId;
      void handleCombine({
        manualAiRunId: manualRunId,
        recoveryAttempt: true,
        expectedCombineSignature: liveData.manualAiResume?.combineInputSignature || null,
        expectedCombineSourceRuns: liveData.manualAiResume?.combineSourceRuns || null,
      })
        .then((outcome) => settleRecoveredCombine(outcome, null));
      return;
    }
    if (plan.cancellationCleanup || Object.keys(plan.cancellationCleanupsBySource || {}).length > 0) {
      void handleCancelRun();
      return;
    }
    if (plan.phase === 'combine') {
      autoResumedManualAiRunRef.current = liveData.manualAiResume?.runId
        || plan.combineManualAiRunId
        || null;
      void handleCombine({
        afterSearch: true,
        recoveryAttempt: true,
        expectedBoardRunId: plan.boardRunId,
        manualAiRunId: liveData.manualAiResume?.runId || plan.combineManualAiRunId || undefined,
        expectedCombineSignature: plan.combineInputSignature
          || liveData.manualAiResume?.combineInputSignature
          || null,
        expectedSourceRuns: plan.completedSourceRuns || null,
        expectedCombineSourceRuns: plan.combineSourceRuns || null,
      }).then((outcome) => settleRecoveredCombine(outcome, plan.boardRunId));
      return;
    }
    autoResumedBoardScanRef.current = null;
    void handleSearchSelected({ resumeBoardScan: true, plan, explicitRecoveryContinue: true });
  }, [getNode, handleCancelRun, handleCombine, handleSearchSelected, id, retireBoardCleanupReceipt, settleRecoveredCombine, updateGlobal]);

  const durableRecoveryActive = !!data.boardCancellation || !!data.boardScanResume || !!data.manualAiResume;
  const cleanupOnlyRecovery = normalizeManualAiCleanupReceipts(data.manualAiCleanupReceipts).length > 0
    && !durableRecoveryActive;
  const cancellationCleanupActive = hasPendingManualAiRetirement(data);
  const boardRunVisible = scanning || combining || durableRecoveryActive || cancellationCleanupActive;
  const awaitingSourceId = data.boardScanResume?.awaitingSourceResolution?.sourceId || null;
  const awaitingSourceLabel = awaitingSourceId
    ? connectedModules.find(module => module.id === awaitingSourceId)?.label || 'selected Job Search'
    : null;

  return (
    <>
      <HubContainer hubState={hubState} theme="blue" width={260} minHeight={hubState === 'empty' ? 150 : 100} dropsBlocked>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <div className="w-7 h-7 rounded-lg bg-indigo-500/15 flex items-center justify-center shrink-0">
          <LayoutGrid size={15} className="text-indigo-300/80" />
        </div>
        <div className="min-w-0">
          <p className="text-white/80 text-xs font-semibold leading-tight">Job Board</p>
          <p className="text-white/30 text-[9px] leading-tight">Start or continue selected searches, then merge completed results</p>
        </div>
      </div>

      {combining && compensationProgress?.total > 0 && (
        <p className="px-3 pb-2 text-center text-blue-300/70 text-[10px]">
          Researching pay for {compensationProgress.processed} / {compensationProgress.total} jobs…
        </p>
      )}

      <div className="px-3 pb-3">
        <JobBoardSearchSelection
          modules={executionOrderedModules}
          selectedIds={selectedSearchModuleIds}
          onToggle={toggleSearchModule}
          onMove={moveSearchModule}
          disabled={!!data.locked}
          running={boardRunVisible}
          upToDate={boardUpToDate}
          progress={finalizingCommittedCombine
            ? { label: 'Board updated — finalizing saved recovery cleanup…' }
            : scanning
            ? scanProgress
            : combining
              ? { label: 'Combining all connected saved results…' }
              : durableRecoveryActive
                ? { label: awaitingSourceLabel
                  ? `Waiting for ${awaitingSourceLabel} to finish manual source resolution…`
                  : 'Recovering the interrupted Board run…' }
                : null}
          onRun={handleSearchSelected}
          onCancel={handleCancelRun}
          recoveryError={recoveryError}
          onRetry={handleRetryRecovery}
          recoveryActionLabel={
            (data.manualAiResume?.runId && data.manualAiResume.retirementPending !== true)
              || recoveryError?.includes('AI handoff')
              ? 'Continue saved AI handoff'
              : 'Retry recovery'
          }
          recoveryCanCancel={!cleanupOnlyRecovery && !cancellationCleanupActive && !finalizingCommittedCombine}
          onRuntimeSnapshot={captureSelectorRuntimeSnapshot}
        />
        {connectedModules.length > 0 && (
          <p className="mt-1.5 text-center text-[8px] leading-snug text-white/20">
            Fresh searches may start in parallel. The shown order controls recovery and result reconciliation; completed searches are reused without another scan. Selection controls which sources start or continue; the board combines all connected completed results.
          </p>
        )}
      </div>

      {hubState === 'done' && (
        <JobBoardDoneState
          resultCount={data.resultCount}
          moduleCount={data.moduleCount}
          totalIncoming={data.mergeStats?.totalIncoming || 0}
          duplicatesRemoved={data.mergeStats?.duplicatesRemoved || 0}
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
          sourceCounts={data.finalSourceCounts || {}}
          onRecombine={null}
          onClear={handleClear}
          combining={scanning || combining}
        />
      )}
      </HubContainer>

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
