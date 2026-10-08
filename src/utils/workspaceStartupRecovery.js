import {
  isAutomaticMarketplaceResolveIntent,
  isRestorableMarketplaceRecovery,
  isRestorableMarketplaceStatusRecovery,
  marketplaceTerminalReceiptApplied,
} from './marketplaceRunRecovery.js';
import {
  findJobSearchBoardActiveRecoveryOwner,
  findJobSearchBoardPausedContinuationOwner,
} from './jobBoardSearchSelection.js';
import { flattenJobSearchQueries } from './jobSearchQueries.js';
import { normalizeJobCollectionLimits } from './jobCollectionLimits.js';
import { getRunnableJobSourceIds, normalizeEnabledJobSourceIds } from './jobPlatformSelection.js';
import { ACTIVE_JOB_SOURCES } from './constants.js';
import { moduleFingerprint } from '../nodes/jobboard/mergeJobs.js';
import { findJobContinuationAppliedReceipt } from './jobContinuationReceipt.js';
import { validateBackgroundBoardChildRequest } from './jobBoardBackgroundRecovery.js';

/**
 * Build a read-only nested workspace index. Nodes below a group are not
 * mounted at the root React Flow level, so startup recovery must discover them
 * from their persisted canvas data rather than from the visible store.
 */
export function collectNestedStartupRecoveryGraph(rootNodes) {
  const nodes = [];
  const edges = [];
  const seenNodeIds = new Set();
  const seenEdgeIds = new Set();

  const addLevel = (levelNodes, levelEdges, nested) => {
    if (!Array.isArray(levelNodes)) return;
    const levelIds = new Set();
    for (const node of levelNodes) {
      if (!node?.id || seenNodeIds.has(node.id)) continue;
      // Root nodes are already mounted by the visible canvas. A group itself
      // has no durable scrape action; only its child canvas belongs here.
      if (nested) {
        nodes.push(node);
        seenNodeIds.add(node.id);
        levelIds.add(node.id);
      }
    }
    if (nested && Array.isArray(levelEdges)) {
      for (const edge of levelEdges) {
        if (!edge?.id || seenEdgeIds.has(edge.id)) continue;
        if (!levelIds.has(edge.source) || !levelIds.has(edge.target)) continue;
        edges.push(edge);
        seenEdgeIds.add(edge.id);
      }
    }
    for (const node of levelNodes) {
      const canvasData = node?.data?.canvasData;
      if (Array.isArray(canvasData?.nodes)) {
        addLevel(canvasData.nodes, canvasData.edges, true);
      }
    }
  };

  addLevel(rootNodes, [], false);
  return { nodes, edges };
}

function isPotentialJobSearchRecovery(node) {
  const data = node?.data || {};
  if (data.manualAiResume?.autoResumeEligible === false) return false;
  // The durable Job Search run is held in an IPC sidecar, so the renderer
  // cannot know in advance whether a recovered node has one. Mount an
  // unlocked Search only when it still has recovery-capable state; its own
  // peek/claim gate is the authority and is side-effect free when no sidecar
  // exists. Board-connected children are included for graph hydration, but
  // they never claim independently (JobSearchNode enforces Board ownership).
  return !!(
    data.manualAiResume?.runId
    || data.jobRunId
    || data.resumeProfile
    || data.careerData
    || data.filePath
    || (Array.isArray(data.filePaths) && data.filePaths.length)
    || (Array.isArray(data.careerFilePaths) && data.careerFilePaths.length)
  );
}

/** Exact, durable recovery candidates only. Explicit stop/reset/clear either
 * remove their marker or mark it ineligible; this filter never reconstructs a
 * run from transient processing state. */
export function isNestedStartupRecoveryCandidate(node) {
  if (!node || node.data?.locked) return false;
  switch (node.type) {
    case 'jobhub':
      return isPotentialJobSearchRecovery(node);
    case 'jobboard':
      return !!(node.data?.boardScanResume?.boardRunId || node.data?.manualAiResume?.runId);
    case 'sellhub':
      return isRestorableMarketplaceRecovery(node.data?.marketplaceRunResume);
    case 'marketplacestatus':
      return isRestorableMarketplaceStatusRecovery(node.data?.marketplaceStatusRunResume);
    default:
      return false;
  }
}

export function hasNestedStartupRecoveryCandidate(rootNodes) {
  return collectNestedStartupRecoveryGraph(rootNodes).nodes.some(isNestedStartupRecoveryCandidate);
}

/**
 * ReactFlow recreates its root node array for drag/layout frames. Recovery
 * discovery cares about durable workflow identity and inputs, never geometry;
 * this signature keeps position/style churn from re-reading every sidecar and
 * Settings while still invalidating for every field used by discovery.
 */
export function workspaceStartupRecoverySignature(rootNodes) {
  const { nodes, edges } = collectNestedStartupRecoveryGraph(rootNodes);
  const nodeSnapshot = nodes.map((node) => {
    const data = node?.data || {};
    if (node.type === 'jobhub') return {
      id: node.id, type: node.type,
      locked: !!data.locked,
      jobRunId: data.jobRunId || null,
      hubState: data.hubState || null,
      manualAiResume: data.manualAiResume || null,
      terminalFinalizationRecovery: data.terminalFinalizationRecovery || null,
      resumeFingerprint: data.resumeFingerprint || null,
      hasResumeProfile: !!data.resumeProfile,
      hasCareerData: !!data.careerData,
      filePath: data.filePath || null,
      filePaths: data.filePaths || null,
      careerFilePaths: data.careerFilePaths || null,
      canonicalLocation: data.canonicalLocation || null,
      preferredLocation: data.preferredLocation || null,
      searchWindow: data.searchWindow || null,
      collectionLimits: data.collectionLimits || null,
      enabledSourceIds: data.enabledSourceIds || null,
      queries: data.queries || null,
      resultDisposition: data.resultDisposition || null,
      scoredJobsFingerprint: moduleFingerprint(data.scoredJobs),
      pendingJobsFingerprint: moduleFingerprint(data.pendingJobs),
      continuationReceipts: data.jobContinuationAppliedReceipts || null,
    };
    if (node.type === 'jobsourcecard') return {
      id: node.id, type: node.type,
      hubId: data.hubId || null,
      sourceId: data.sourceId || null,
      persistedProgress: data.persistedProgress || null,
    };
    if (node.type === 'jobboard') return {
      id: node.id, type: node.type,
      locked: !!data.locked,
      boardScanResume: data.boardScanResume || null,
      boardCancellation: data.boardCancellation || null,
      manualAiResume: data.manualAiResume || null,
      manualAiCleanupReceipts: data.manualAiCleanupReceipts || null,
      selectedSearchModuleIds: data.selectedSearchModuleIds || null,
      searchExecutionOrder: data.searchExecutionOrder || null,
    };
    if (node.type === 'sellhub') return {
      id: node.id, type: node.type,
      locked: !!data.locked,
      marketplaceRunResume: data.marketplaceRunResume || null,
      hubState: data.hubState || null,
      product: data.product || null,
      extraItems: data.extraItems || null,
      itemPricings: data.itemPricings || null,
      pricingNotes: data.pricingNotes || null,
    };
    if (node.type === 'marketplacestatus') return {
      id: node.id, type: node.type,
      locked: !!data.locked,
      marketplaceStatusRunResume: data.marketplaceStatusRunResume || null,
      platformStatus: data.platformStatus || null,
    };
    return { id: node.id, type: node.type };
  });
  const edgeSnapshot = edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
  }));
  return JSON.stringify({ nodes: nodeSnapshot, edges: edgeSnapshot });
}

function connectedBoardIds(nodeId, nodes, edges) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const edgeOwners = (Array.isArray(edges) ? edges : []).flatMap((edge) => {
    if (edge?.source === nodeId && byId.get(edge.target)?.type === 'jobboard') return [edge.target];
    if (edge?.target === nodeId && byId.get(edge.source)?.type === 'jobboard') return [edge.source];
    return [];
  });
  // A Board plan remains the child owner during a reload/cancellation even if
  // an older saved graph lost the visual edge. Match the Board's persisted
  // selected/execution sets as well as its active/complete recovery plan so a
  // standalone child can never steal its exact run in that gap.
  const declaredOwners = nodes.flatMap((node) => {
    if (node?.type !== 'jobboard') return [];
    const data = node.data || {};
    const plan = data.boardScanResume || {};
    const selected = [
      ...(Array.isArray(data.selectedSearchModuleIds) ? data.selectedSearchModuleIds : []),
      ...(Array.isArray(data.searchExecutionOrder) ? data.searchExecutionOrder : []),
      ...(Array.isArray(plan.selectedSearchModuleIds) ? plan.selectedSearchModuleIds : []),
      ...(Array.isArray(plan.activeSourceIds) ? plan.activeSourceIds : []),
      plan.activeSourceId,
      plan.awaitingSourceResolution?.sourceId,
      plan.cancellationCleanup?.sourceId,
      ...Object.keys(plan.completedSourceRuns || {}),
      ...(Array.isArray(plan.combineSourceRuns) ? plan.combineSourceRuns.map(entry => entry?.sourceId) : []),
      data.boardCancellation?.sourceId,
      ...(Array.isArray(data.boardCancellation?.sourceIds) ? data.boardCancellation.sourceIds : []),
    ];
    return selected.includes(nodeId) ? [node.id] : [];
  });
  return [...new Set([...edgeOwners, ...declaredOwners])];
}

function safeBackgroundBoardChildOwner(nodeId, nodes, edges, canvasFilePath) {
  let owner = findJobSearchBoardActiveRecoveryOwner(nodeId, nodes, edges);
  if (!owner) {
    // Between serial children the Board intentionally has no activeSourceId.
    // A request frozen into the same durable Board plan is still an exact owner
    // for a manifest the hidden coordinator bootstrapped before a crash.
    const child = nodes.find(node => node?.id === nodeId && node.type === 'jobhub');
    const preparedBoard = nodes.find((candidate) => {
      if (candidate?.type !== 'jobboard') return false;
      const plan = candidate.data?.boardScanResume;
      const incomplete = new Set((Array.isArray(plan?.incompleteSearches) ? plan.incompleteSearches : [])
        .map(entry => entry?.sourceId).filter(Boolean));
      return plan?.version === 1
        && plan.phase === 'searches'
        && plan.autoResumeEligible !== false
        && Array.isArray(plan.selectedSearchModuleIds)
        && plan.selectedSearchModuleIds.includes(nodeId)
        && !plan.completedSourceRuns?.[nodeId]
        && !incomplete.has(nodeId)
        && !!validateBackgroundBoardChildRequest(
          plan.backgroundChildRequests?.[nodeId],
          child,
          plan,
          canvasFilePath,
        );
    });
    if (preparedBoard) {
      owner = {
        orchestratorNodeId: preparedBoard.id,
        boardRunId: preparedBoard.data.boardScanResume.boardRunId,
        preparedBetweenChildren: true,
      };
    }
  }
  if (!owner?.orchestratorNodeId || !owner?.boardRunId) return null;
  const board = nodes.find(node => node?.id === owner.orchestratorNodeId && node.type === 'jobboard');
  const data = board?.data || {};
  const plan = data.boardScanResume;
  const activeSourceIds = new Set([
    plan?.activeSourceId,
    ...(Array.isArray(plan?.activeSourceIds) ? plan.activeSourceIds : []),
  ].filter(Boolean));
  const waitingSourceIds = new Set([
    plan?.awaitingSourceResolution?.sourceId,
    ...(Array.isArray(plan?.awaitingSourceResolutions)
      ? plan.awaitingSourceResolutions.map(entry => entry?.sourceId)
      : []),
  ].filter(Boolean));
  const incompleteSourceIds = new Set((Array.isArray(plan?.incompleteSearches) ? plan.incompleteSearches : [])
    .map(entry => entry?.sourceId).filter(Boolean));
  const preparedBetweenChildren = owner.preparedBetweenChildren === true || (
    activeSourceIds.size === 0
    && Array.isArray(plan?.selectedSearchModuleIds)
    && plan.selectedSearchModuleIds.includes(nodeId)
    && !plan.completedSourceRuns?.[nodeId]
    && !incompleteSourceIds.has(nodeId)
    && !!validateBackgroundBoardChildRequest(
      plan.backgroundChildRequests?.[nodeId],
      nodes.find(node => node?.id === nodeId && node.type === 'jobhub'),
      plan,
      canvasFilePath,
    )
  );
  if (
    !board
    || data.locked
    || data.boardCancellation
    || data.manualAiResume?.runId
    || data.manualAiResume?.autoResumeEligible === false
    || plan?.version !== 1
    || plan.phase !== 'searches'
    || plan.autoResumeEligible === false
    || plan.boardRunId !== owner.boardRunId
    || (!activeSourceIds.has(nodeId) && !preparedBetweenChildren)
    // This descriptor is a human/source-card decision boundary. Even an API-
    // safe manifest must not bypass the Board's explicit paused-source gate.
    || waitingSourceIds.has(nodeId)
  ) return null;
  return { orchestratorNodeId: board.id, boardRunId: plan.boardRunId };
}

function hiddenBoardChildBootstrapEntry(board, nodes, edges, jobRunOffers, canvasFilePath) {
  const data = board?.data || {};
  const plan = data.boardScanResume;
  const activeIds = new Set([
    plan?.activeSourceId,
    ...(Array.isArray(plan?.activeSourceIds) ? plan.activeSourceIds : []),
  ].filter(Boolean));
  const awaitingIds = new Set([
    plan?.awaitingSourceResolution?.sourceId,
    ...(Array.isArray(plan?.awaitingSourceResolutions)
      ? plan.awaitingSourceResolutions.map(entry => entry?.sourceId)
      : []),
  ].filter(Boolean));
  if (
    board?.type !== 'jobboard'
    || data.locked
    || data.boardCancellation
    || data.manualAiResume?.runId
    || plan?.version !== 1
    || plan.phase !== 'searches'
    || plan.autoResumeEligible === false
    || activeIds.size > 0
    || awaitingIds.size > 0
    || plan.recoverableFailure
    || plan.cancellationCleanup
    || Object.keys(plan.cancellationCleanupsBySource || {}).length > 0
  ) return null;
  const completed = new Set(Object.keys(plan.completedSourceRuns || {}));
  const incomplete = new Set((Array.isArray(plan.incompleteSearches) ? plan.incompleteSearches : [])
    .map(entry => entry?.sourceId).filter(Boolean));
  const childId = (Array.isArray(plan.selectedSearchModuleIds) ? plan.selectedSearchModuleIds : [])
    .find(sourceId => !completed.has(sourceId) && !incomplete.has(sourceId));
  if (!childId || jobRunOffers.get(childId)?.found !== false) return null;
  const child = nodes.find(node => node?.id === childId && node.type === 'jobhub');
  const connected = edges.some(edge => (
    (edge?.source === board.id && edge.target === childId)
    || (edge?.target === board.id && edge.source === childId)
  ));
  if (!child || !connected) return null;
  const prepared = validateBackgroundBoardChildRequest(
    plan.backgroundChildRequests?.[childId],
    child,
    plan,
    canvasFilePath,
  );
  if (!prepared) return null;
  return {
    kind: 'jobboard-child-bootstrap',
    nodeId: board.id,
    childNodeId: childId,
    runId: plan.boardRunId,
    boardOwner: { orchestratorNodeId: board.id, boardRunId: plan.boardRunId },
    prepared,
    request: prepared.request,
    state: 'ready',
  };
}

function hasManualStop(data) {
  return data?.manualAiResume?.autoResumeEligible === false
    || data?.boardScanResume?.autoResumeEligible === false
    || data?.marketplaceRunResume?.autoResumeEligible === false
    || data?.marketplaceStatusRunResume?.autoResumeEligible === false;
}

// Startup can recover every supported provider, including browser-backed
// Google, Indeed, ZipRecruiter, and Glassdoor. The durable manifest is the
// safety authority: a manual/human-required source makes the whole offer
// ineligible before this request can be created. Keep this allow-list anyway
// so corrupted/unrecognised source ids never reach an unattended dispatch.
const BACKGROUND_AUTO_RESUME_SOURCE_IDS = new Set(ACTIVE_JOB_SOURCES);

export function backgroundJobResumeRequest(node, offer, canvasFilePath) {
  const data = node?.data || {};
  const queries = Array.isArray(offer?.queries) ? offer.queries.filter(query => typeof query === 'string' && query.trim()) : [];
  const sourceIds = Array.isArray(offer?.unfinishedSourceIds) ? offer.unfinishedSourceIds : [];
  const location = String(data.canonicalLocation || data.preferredLocation || '').trim();
  if (
    offer?.autoResumeEligible === false
    || offer?.incomplete !== true
    || !offer?.locationRecorded
    || location !== String(offer.canonicalLocation || '').trim()
    || !data.resumeProfile
    || !data.resumeFingerprint
    || data.resumeFingerprint !== offer.profileFingerprint
    || queries.length === 0
  ) return null;
  if (sourceIds.some(sourceId => !BACKGROUND_AUTO_RESUME_SOURCE_IDS.has(sourceId))) return null;
  // Hidden startup recovery advances provider I/O only. Semantic role screens,
  // preference evaluation, and scoring all belong to an explicitly continued
  // mounted card. With no unfinished provider there is therefore nothing this
  // coordinator may advance.
  if (sourceIds.length === 0) return null;
  return {
    queries,
    nodeId: node.id,
    searchWindow: offer.searchWindow || null,
    collectionLimits: data.collectionLimits || null,
    enabledSourceIds: Array.isArray(data.enabledSourceIds) ? data.enabledSourceIds : undefined,
    canvasFilePath,
    preferredLocation: location,
    rawLocation: String(data.preferredLocation || ''),
    profileLocations: Array.isArray(data.resumeProfile?.locations) ? data.resumeProfile.locations : [],
    targetRole: offer.targetRole || '',
    jobPreferences: offer.jobPreferences || '',
    preferencePlan: offer.jobPreferencePlan || null,
    countryScope: data.canonicalCountry || '',
    resume: true,
    resumeRunId: offer.runId,
    profileFingerprint: data.resumeFingerprint,
    runOrigin: 'crash-resume',
    profileInputMode: 'stored-profile',
    providerPhaseOnly: true,
  };
}

function exactContinuationReceiptState(node, intent) {
  if (!intent?.terminalResultAvailable) return null;
  const data = node?.data || {};
  const receipt = findJobContinuationAppliedReceipt(data, intent);
  if (!receipt) return { state: 'awaiting-mounted-replay', receipt: null };
  // The sidecar, rather than mutable canvas node data, is the authority for a
  // terminal acknowledgement. The hidden worker may claim a one-hop successor
  // later, but it must begin from these exact persisted values.
  const operationAuthority = intent.operationAuthority || null;
  const careerSnapshotId = typeof intent.careerSnapshotId === 'string' && /^[a-f0-9]{64}$/.test(intent.careerSnapshotId)
    ? intent.careerSnapshotId
    : null;
  const parentArtifactFingerprint = typeof intent.parentArtifactFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(intent.parentArtifactFingerprint)
    ? intent.parentArtifactFingerprint
    : null;
  // A terminal acknowledgement mutates durable continuation state. It must
  // retain the same pin/evidence boundary as its provider action, not infer a
  // new authority merely because startup discovered an applied UI receipt.
  if (!operationAuthority || !careerSnapshotId || !parentArtifactFingerprint) {
    return { state: 'awaiting-mounted-replay', receipt: null };
  }
  return {
    state: receipt.appliedProcessEpoch === intent.processEpoch
      ? 'awaiting-canvas-save'
      : 'terminal-ack-ready',
    receipt,
    operationAuthority,
    careerSnapshotId,
    parentArtifactFingerprint,
  };
}

function lateSourceContinuationEntry(node, intent, canvasFilePath, boardIds) {
  const data = node?.data || {};
  if (
    intent?.kind !== 'late-source-refresh'
    || intent.operation !== 'search-jobs-single-source'
    || intent.sourceId !== 'usajobs'
    || intent.recoveryMode !== 'automatic'
    || intent.parentRunId !== data.jobRunId
  ) return null;
  const receiptState = exactContinuationReceiptState(node, intent);
  if (receiptState) {
    return {
      kind: 'jobcontinuation', nodeId: node.id, runId: intent.parentRunId,
      intent, ...receiptState,
    };
  }
  if (boardIds.length > 0 || !['done', 'sources-ready'].includes(data.hubState)) return null;
  // Pre-fingerprint intents can still be recovered by the mounted owner, but
  // are not exact enough for a hidden process to reconstruct provider input.
  if (!intent.operationInputFingerprint) return {
    kind: 'jobcontinuation', nodeId: node.id, runId: intent.parentRunId,
    intent, state: 'awaiting-mounted-recovery',
  };
  const query = flattenJobSearchQueries(data.queries)[0] || '';
  const profileFingerprint = typeof data.resumeFingerprint === 'string'
    ? data.resumeFingerprint.trim()
    : '';
  const enabledSourceIds = normalizeEnabledJobSourceIds(data.enabledSourceIds);
  const collectionLimits = normalizeJobCollectionLimits(data.collectionLimits);
  const runnableSources = getRunnableJobSourceIds(
    enabledSourceIds,
    ACTIVE_JOB_SOURCES,
    collectionLimits,
  );
  if (!query || !profileFingerprint || !runnableSources.includes('usajobs')) return null;
  const preferredLocation = String(data.canonicalLocation || data.preferredLocation || '').trim();
  const operationInput = {
    query,
    searchWindow: data.searchWindow || null,
    collectionLimits,
    enabledSourceIds,
    preferredLocation,
    targetRole: String(data.activeTargetRole ?? data.targetRole ?? '').trim(),
    jobPreferences: data.activeJobPreferences ?? data.jobPreferences ?? '',
    preferencePlan: data.jobPreferencePlan ?? data.jobPreferencesInterpretation ?? null,
  };
  const operationAuthority = intent.operationAuthority || null;
  const careerSnapshotId = typeof intent.careerSnapshotId === 'string' && /^[a-f0-9]{64}$/.test(intent.careerSnapshotId)
    ? intent.careerSnapshotId
    : null;
  if (!operationAuthority || !careerSnapshotId || typeof intent.parentArtifactFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(intent.parentArtifactFingerprint)) return {
    kind: 'jobcontinuation', nodeId: node.id, runId: intent.parentRunId,
    intent, state: 'awaiting-mounted-recovery',
  };
  const parentArtifactFingerprint = intent.parentArtifactFingerprint;
  const inheritedBase = operationAuthority?.semanticBase || {};
  return {
    kind: 'jobcontinuation',
    nodeId: node.id,
    runId: intent.parentRunId,
    intent,
    state: 'ready',
    operationAuthority,
    operationSemanticBase: {
      kind: 'usajobs-late-append', careerSnapshotId, runId: intent.parentRunId,
      fingerprint: inheritedBase.fingerprint ?? null, analysisRevisionId: inheritedBase.analysisRevisionId ?? null,
      continuationId: intent.intentId || null, sourceArtifactFingerprint: parentArtifactFingerprint,
    },
    identity: {
      canvasFilePath,
      nodeId: node.id,
      parentRunId: intent.parentRunId,
      profileFingerprint,
      kind: intent.kind,
      operation: intent.operation,
      sourceId: intent.sourceId,
      searchWindow: data.searchWindow || null,
      canonicalLocation: preferredLocation,
      generationFingerprint: `${data.resultDisposition || ''}:${moduleFingerprint(data.scoredJobs)}`,
      operationInput,
      operationAuthority,
      careerSnapshotId,
      parentArtifactFingerprint,
    },
    request: {
      query,
      sourceId: 'usajobs',
      searchWindow: data.searchWindow || null,
      collectionLimits,
      enabledSourceIds,
      canvasFilePath,
      nodeId: node.id,
      jobRunId: intent.parentRunId,
      preferredLocation,
      targetRole: operationInput.targetRole,
      jobPreferences: operationInput.jobPreferences,
      preferencePlan: operationInput.preferencePlan,
      operationAuthority,
      careerSnapshotId,
      parentArtifactFingerprint,
    },
  };
}

function sourceRecoveryContinuationEntry(node, nodes, edges, intent, canvasFilePath, boardIds) {
  const data = node?.data || {};
  if (
    intent?.kind !== 'source-recovery'
    || intent.operation !== 'resume-job-source'
    || intent.sourceId !== 'indeed'
    || intent.recoveryMode !== 'automatic'
    || intent.parentRunId !== data.jobRunId
  ) return null;
  const receiptState = exactContinuationReceiptState(node, intent);
  if (receiptState) {
    return {
      kind: 'jobcontinuation', nodeId: node.id, runId: intent.parentRunId,
      intent, ...receiptState,
    };
  }
  if (data.hubState !== 'sources-ready') return null;
  const boardOwner = boardIds.length > 0
    ? findJobSearchBoardPausedContinuationOwner(node.id, intent.parentRunId, nodes, edges)
    : null;
  if (boardIds.length > 0 && !boardOwner) return null;
  if (!intent.operationInputFingerprint) return {
    kind: 'jobcontinuation', nodeId: node.id, runId: intent.parentRunId,
    intent, boardOwner, state: 'awaiting-mounted-recovery',
  };
  const cards = nodes.filter(candidate => (
    candidate?.type === 'jobsourcecard'
    && candidate.data?.hubId === node.id
    && candidate.data?.sourceId === 'indeed'
  ));
  const matchingCards = cards.filter((card) => {
    const progress = card.data?.persistedProgress;
    return progress?.jobRunId === intent.parentRunId
      && String(progress?.warning?.resumeState?.mode || '').toLowerCase() === 'retry-descriptions';
  });
  if (matchingCards.length !== 1) return null;
  const progress = matchingCards[0].data.persistedProgress;
  const resumeState = progress.warning.resumeState;
  const profileFingerprint = typeof data.resumeFingerprint === 'string'
    ? data.resumeFingerprint.trim()
    : '';
  if (!profileFingerprint) return null;
  const collectionLimits = normalizeJobCollectionLimits(data.collectionLimits);
  const preferredLocation = String(data.canonicalLocation || '').trim();
  const operationInput = {
    sourceId: 'indeed',
    resumeState,
    collectionLimits,
    enabledSourceIds: data.enabledSourceIds,
    preferredLocation,
  };
  const operationAuthority = intent.operationAuthority || null;
  const careerSnapshotId = typeof intent.careerSnapshotId === 'string' && /^[a-f0-9]{64}$/.test(intent.careerSnapshotId)
    ? intent.careerSnapshotId
    : null;
  if (!operationAuthority || !careerSnapshotId || typeof intent.parentArtifactFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(intent.parentArtifactFingerprint)) return {
    kind: 'jobcontinuation', nodeId: node.id, runId: intent.parentRunId,
    intent, boardOwner, state: 'awaiting-mounted-recovery',
  };
  const parentArtifactFingerprint = intent.parentArtifactFingerprint;
  const inheritedBase = operationAuthority?.semanticBase || {};
  return {
    kind: 'jobcontinuation',
    nodeId: node.id,
    runId: intent.parentRunId,
    intent,
    boardOwner,
    state: 'ready',
    operationAuthority,
    operationSemanticBase: {
      kind: 'resolved-source-continuation', careerSnapshotId, runId: intent.parentRunId,
      fingerprint: inheritedBase.fingerprint ?? null, analysisRevisionId: inheritedBase.analysisRevisionId ?? null,
      continuationId: intent.intentId || null, sourceArtifactFingerprint: parentArtifactFingerprint,
    },
    identity: {
      canvasFilePath,
      nodeId: node.id,
      parentRunId: intent.parentRunId,
      profileFingerprint,
      kind: intent.kind,
      operation: intent.operation,
      sourceId: intent.sourceId,
      searchWindow: data.searchWindow || null,
      canonicalLocation: data.canonicalLocation || data.preferredLocation || '',
      generationFingerprint: `${data.resultDisposition || ''}:${moduleFingerprint(data.scoredJobs)}:${moduleFingerprint(data.pendingJobs)}`,
      operationInput,
      operationAuthority,
      careerSnapshotId,
      parentArtifactFingerprint,
    },
    request: {
      sourceId: 'indeed',
      nodeId: node.id,
      canvasFilePath,
      searchWindow: data.searchWindow || null,
      collectionLimits,
      enabledSourceIds: data.enabledSourceIds,
      jobRunId: intent.parentRunId,
      preferredLocation,
      resumeState,
      operationAuthority,
      careerSnapshotId,
      parentArtifactFingerprint,
    },
  };
}

export function hiddenJobContinuationEntry({
  node,
  nodes,
  edges,
  intent,
  canvasFilePath,
} = {}) {
  if (!node || node.type !== 'jobhub' || node.data?.locked || !intent) return null;
  const boardIds = connectedBoardIds(node.id, nodes, edges);
  return lateSourceContinuationEntry(node, intent, canvasFilePath, boardIds)
    || sourceRecoveryContinuationEntry(node, nodes, edges, intent, canvasFilePath, boardIds);
}

// A replay receipt must survive the first write into canvas state so a crash
// before autosave cannot lose the terminal result. Once a later launch observes
// that exact result in the persisted node, it is safe to consume the receipt.
export function terminalMarketplaceReplayDisposition(entry) {
  if (!entry || !['sellhub', 'marketplacestatus'].includes(entry.kind) || entry.state !== 'terminal-replay-ready') return null;
  return entry.alreadyApplied ? 'acknowledge' : 'apply';
}

// Sidecar payloads are JSON data, but object key order may differ after the
// canvas serializer round-trips them. Compare the actual structured terminal
// value rather than a coarse truthy field or JSON string order.
function exactTerminalValueEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => exactTerminalValueEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && exactTerminalValueEqual(left[key], right[key]));
}

function exactTerminalMarkerMatches(marker, recovery) {
  return marker?.runId === recovery?.runId
    && marker?.phase === recovery?.phase
    && marker?.inputKey === recovery?.inputKey
    && marker?.updatedAt === recovery?.updatedAt
    && exactTerminalValueEqual(marker?.result, recovery?.result);
}

function sellTerminalAlreadyApplied(data, recovery) {
  const terminal = recovery?.result;
  if (marketplaceTerminalReceiptApplied(recovery, data?.marketplaceRunResume)) return true;
  if (!exactTerminalMarkerMatches(data?.marketplaceRunResume, recovery) || !terminal) return false;
  if (recovery.phase === 'analysis-result') {
    return data.hubState === 'draft' && exactTerminalValueEqual(data.product, terminal.product);
  }
  if (recovery.phase === 'priced-result') {
    return data.hubState === 'priced'
      && Object.keys(terminal).every(key => exactTerminalValueEqual(data[key], terminal[key]));
  }
  return false;
}

function marketplaceStatusTerminalAlreadyApplied(data, recovery) {
  if (marketplaceTerminalReceiptApplied(recovery, data?.marketplaceStatusRunResume)) return true;
  if (recovery?.phase !== 'status-result'
    || !exactTerminalMarkerMatches(data?.marketplaceStatusRunResume, recovery)) return false;
  return Object.entries(recovery.completedResults || {}).every(([platformId, result]) => (
    exactTerminalValueEqual(data?.platformStatus?.[platformId], result)
  ));
}

/**
 * A small coordinator with no provider/browser action of its own. It claims
 * only after exact recovery inspection and leaves actual execution to an
 * explicit, type-specific executor. This prevents an unmounted child from
 * being accidentally revived by a generic renderer replay.
 */
export function createWorkspaceStartupRecoveryCoordinator({
  peekJobRun,
  listJobContinuations,
  peekMarketplaceRecovery,
} = {}) {
  const claimed = new Set();

  async function discover({ canvasFilePath, rootNodes }) {
    if (!canvasFilePath) return [];
    const { nodes, edges } = collectNestedStartupRecoveryGraph(rootNodes);
    const planned = [];
    const boardNodes = [];
    const jobRunOffers = new Map();

    for (const node of nodes) {
      const data = node?.data || {};
      // Marketplace mirrors may not have reached the debounced canvas save
      // when their main-process sidecar is already durable. Therefore each
      // unlocked marketplace owner may be probed, but never executed, from its
      // exact sidecar. The public candidate helper remains conservative so a
      // cleared/reset node is not represented as a recovery candidate itself.
      const canProbeMarketplaceSidecar = node.type === 'sellhub' || node.type === 'marketplacestatus';
      if ((!isNestedStartupRecoveryCandidate(node) && !canProbeMarketplaceSidecar) || data.locked || hasManualStop(data)) continue;

      // Boards are planned after every child sidecar has been probed. A Board
      // between children may bootstrap only when the selected child is proven
      // to have no manifest; processing canvas order directly made a Board that
      // appeared before its child race a normal exact child resume.
      if (node.type === 'jobboard') {
        boardNodes.push(node);
        continue;
      }

      if (node.type === 'jobhub') {
        // A Board owns every connected child, including one whose own sidecar
        // looks runnable. This is intentionally checked before the sidecar
        // read so a child cannot claim while its Board is hydrating.
        const boardIds = connectedBoardIds(node.id, nodes, edges);
        if (typeof listJobContinuations === 'function') {
          try {
            const listed = await listJobContinuations({ canvasFilePath, nodeId: node.id });
            const intents = Array.isArray(listed) ? listed : (listed?.intents || []);
            let exactContinuationOwned = false;
            for (const intent of intents) {
              const entry = hiddenJobContinuationEntry({
                node, nodes, edges, intent, canvasFilePath,
              });
              if (!entry) continue;
              exactContinuationOwned = true;
              const continuationClaimKey = `${canvasFilePath}:jobcontinuation:${node.id}:${intent.intentId}:${entry.state}`;
              if (claimed.has(continuationClaimKey)) continue;
              claimed.add(continuationClaimKey);
              planned.push(entry);
            }
            // A source continuation owns the same exact generation as the
            // primary manifest. Never start both provider paths in parallel.
            if (exactContinuationOwned) continue;
          } catch {
            planned.push({ kind: 'jobcontinuation', nodeId: node.id, state: 'sidecar-unavailable' });
          }
        }
        const boardOwner = boardIds.length
          ? safeBackgroundBoardChildOwner(node.id, nodes, edges, canvasFilePath)
          : null;
        if (boardIds.length && !boardOwner) {
          planned.push({ kind: 'jobhub', nodeId: node.id, state: 'board-owned', boardIds });
          continue;
        }
        if (typeof peekJobRun !== 'function') {
          planned.push({ kind: 'jobhub', nodeId: node.id, state: 'awaiting-sidecar' });
          continue;
        }
        let offer;
        try {
          offer = await peekJobRun({ canvasFilePath, nodeId: node.id });
          jobRunOffers.set(node.id, offer || { found: false });
        } catch {
          jobRunOffers.set(node.id, { found: null, unavailable: true });
          planned.push({ kind: 'jobhub', nodeId: node.id, state: 'sidecar-unavailable' });
          continue;
        }
        if (
          offer?.found !== true
          || offer?.incomplete !== true
          || offer?.nodeId !== node.id
          || typeof offer?.runId !== 'string'
          || !offer.runId
          || offer.autoResumeEligible === false
        ) continue;
        const request = backgroundJobResumeRequest(node, offer, canvasFilePath);
        if (!request) {
          planned.push({ kind: 'jobhub', nodeId: node.id, runId: offer.runId, offer, state: 'awaiting-mounted-recovery' });
          continue;
        }
        const claimKey = `${canvasFilePath}:jobhub:${node.id}:${offer.runId}`;
        if (claimed.has(claimKey)) continue;
        claimed.add(claimKey);
        planned.push({
          kind: 'jobhub',
          nodeId: node.id,
          runId: offer.runId,
          offer,
          request,
          boardOwner,
          state: 'ready',
        });
        continue;
      }

      if (node.type === 'sellhub') {
        if (typeof peekMarketplaceRecovery !== 'function') {
          planned.push({ kind: 'sellhub', nodeId: node.id, state: 'awaiting-sidecar' });
          continue;
        }
        let recovered;
        try {
          recovered = await peekMarketplaceRecovery({ canvasFilePath, nodeId: node.id, kind: 'sellhub' });
        } catch {
          planned.push({ kind: 'sellhub', nodeId: node.id, state: 'sidecar-unavailable' });
          continue;
        }
        const recovery = recovered?.found === true && isRestorableMarketplaceRecovery(recovered.recovery)
          ? recovered.recovery
          : null;
        if (!recovery) continue;
        const runId = recovery.runId;
        const claimKey = `${canvasFilePath}:sellhub:${node.id}:${runId}`;
        if (claimed.has(claimKey)) continue;
        claimed.add(claimKey);
        // Exact headless source-rescrape intents are provider-safe and resume
        // once. Native CAPTCHA/login work and the general comps-ready pricing
        // decision remain explicit human pauses.
        let state;
        if (recovery.manualPause?.status === 'manual-required') state = 'human-paused';
        else if (isAutomaticMarketplaceResolveIntent(recovery)) state = 'source-rescrape-ready';
        else if (recovery.manualPause || recovery.phase === 'comps-ready') state = 'deliberate-comps-ready';
        else if (['analysis-result', 'priced-result'].includes(recovery.phase)) state = 'terminal-replay-ready';
        else if (recovery.phase === 'scrape') state = 'ready';
        else if (recovery.phase === 'synthesis') state = 'manual-ai-paused';
        else state = 'analysis-deferred';
        const alreadyApplied = sellTerminalAlreadyApplied(data, recovery);
        planned.push({
          kind: 'sellhub', nodeId: node.id, runId, recovery, nodeData: data,
          processEpoch: recovered.processEpoch || null,
          alreadyApplied, state,
        });
        continue;
      }

      if (node.type === 'marketplacestatus') {
        if (typeof peekMarketplaceRecovery !== 'function') {
          planned.push({ kind: 'marketplacestatus', nodeId: node.id, state: 'awaiting-sidecar' });
          continue;
        }
        let recovered;
        try {
          recovered = await peekMarketplaceRecovery({ canvasFilePath, nodeId: node.id, kind: 'marketplace-status' });
        } catch {
          planned.push({ kind: 'marketplacestatus', nodeId: node.id, state: 'sidecar-unavailable' });
          continue;
        }
        const recovery = recovered?.found === true && isRestorableMarketplaceStatusRecovery(recovered.recovery)
          ? recovered.recovery
          : null;
        if (!recovery) continue;
        const runId = recovery.runId;
        const claimKey = `${canvasFilePath}:marketplacestatus:${node.id}:${runId}`;
        if (claimed.has(claimKey)) continue;
        claimed.add(claimKey);
        planned.push({
          kind: 'marketplacestatus',
          nodeId: node.id,
          runId,
          recovery,
          nodeData: data,
          processEpoch: recovered.processEpoch || null,
          alreadyApplied: marketplaceStatusTerminalAlreadyApplied(data, recovery),
          state: recovery.manualPause
            ? 'human-paused'
            : recovery.phase === 'status-result' || recovery.remainingPlatformIds.length === 0
              ? 'terminal-replay-ready'
              : 'ready',
        });
      }
    }

    for (const node of boardNodes) {
      const data = node?.data || {};
      const runId = data.boardScanResume?.boardRunId || data.manualAiResume?.runId;
      if (!runId) continue;
      const claimKey = `${canvasFilePath}:jobboard:${node.id}:${runId}`;
      if (claimed.has(claimKey)) continue;
      claimed.add(claimKey);
      const bootstrap = hiddenBoardChildBootstrapEntry(
        node,
        nodes,
        edges,
        jobRunOffers,
        canvasFilePath,
      );
      planned.push(bootstrap || {
        kind: 'jobboard',
        nodeId: node.id,
        runId,
        state: 'awaiting-board-hydration',
      });
    }
    return planned;
  }

  return { discover };
}
