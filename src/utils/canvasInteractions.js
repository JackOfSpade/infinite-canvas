import { normalizeJobAnalysisClearRunId } from './jobAnalysisRecovery.js';

// ── Global Canvas Interaction State ──────────────────────────────────────────
// These state objects are abstracted completely out of the React lifecycle to
// ensure they survive Hot Module Replacement (HMR) seamlessly during development,
// and prevent catastrophic pointer loss (race conditions) if the active component
// tree unexpectedly unmounts mid-drag.

// Map<nodeId, { flowCx, flowCy, size: { width, height } }>
// Stores the node's dimensions and exact center-point globally right before a resize drag starts.
// Tracked so that standard node-dnd handlers instantly fix the offset shift caused by scaling operations.
export const ResizeCorrection = new Map();

// Set<nodeId>
// Tracks nodes currently participating in an active user resize session.
export const ResizeActive = new Set();

// Set<nodeId>
// Tracks nodes currently being pressed explicitly along their reserved title drag-zone.
export const TitleZoneActive = new Set();

// Map<nodeId, { x, y }>
// Tracks original positional values mid-drag when TitleZone logic intercepts coordinate spaces.
export const TitleZoneCorrection = new Map();

function durableManualAiRunIdsForWorkflowNode(node) {
  if (node?.type !== 'jobhub' && node?.type !== 'jobboard') return [];
  const data = node.data || {};
  return [...new Set([
    data.manualAiResume?.runId,
    data.boardScanResume?.combineManualAiRunId,
    ...(data.boardScanResume?.activeSourceManualAiRunIds
      && typeof data.boardScanResume.activeSourceManualAiRunIds === 'object'
      ? Object.values(data.boardScanResume.activeSourceManualAiRunIds)
      : []),
    data.boardScanResume?.cancellationCleanup?.manualAiRunId,
    ...(Array.isArray(data.boardScanResume?.cancellationCleanup?.manualAiRunIds)
      ? data.boardScanResume.cancellationCleanup.manualAiRunIds
      : []),
    ...Object.values(data.boardScanResume?.cancellationCleanupsBySource || {}).flatMap(cleanup => [
      cleanup?.manualAiRunId,
      ...(Array.isArray(cleanup?.manualAiRunIds) ? cleanup.manualAiRunIds : []),
    ]),
    data.boardScanResume?.recoverableFailure?.manualAiRunId,
    ...(Array.isArray(data.boardCancellation?.manualAiRunIds)
      ? data.boardCancellation.manualAiRunIds
      : []),
    data.boardCancellation?.childCleanup?.manualAiRunId,
    ...(Array.isArray(data.boardCancellation?.childCleanup?.manualAiRunIds)
      ? data.boardCancellation.childCleanup.manualAiRunIds
      : []),
    ...(Array.isArray(data.manualAiCleanupReceipts)
      ? data.manualAiCleanupReceipts.map(receipt => receipt?.runId)
      : []),
  ].filter(runId => typeof runId === 'string' && runId.trim()))];
}

// ── Shared Node Lifecycle Helpers ─────────────────────────────────────────────

/**
 * Recursively cancels active background IPC tasks for a node tree.
 * Optional-chains the IPC call so a missing `window.electronAPI` (or a single
 * throwing cancel) can't abort the recursion mid-tree and strand the remaining
 * nodes' background tasks (partial cancellation).
 *
 * @param {Array}  nodes   - Array of ReactFlow node objects to process
 * @param {Set}   [skipIds] - Optional set of node IDs to skip (e.g. locked nodes)
 */
export function cancelNodeTasksRecursively(nodes, skipIds) {
  if (!Array.isArray(nodes)) return;
  nodes.forEach(n => {
    if (skipIds?.has(n.id)) return;
    // This helper is only reached from the two real deletion paths, so it is
    // the one caller whose cancel genuinely IS a node deletion — every other
    // caller passes its own cause so diagnostics stop calling a Reset a delete.
    window.electronAPI?.cancelNodeTask?.(n.id, 'node-deleted');
    if (n.data?.canvasData?.nodes) cancelNodeTasksRecursively(n.data.canvasData.nodes, skipIds);
    // Legacy nodes shape fallback
    if (n.data?.nodes) cancelNodeTasksRecursively(n.data.nodes, skipIds);
  });
}

/**
 * Return exact durable manual-AI workflow ids owned by deleted Job Search or
 * Job Board nodes, including nodes nested inside removed canvas groups.
 */
export function collectDeletedManualAiRetirements(nodes) {
  if (!Array.isArray(nodes)) return [];
  const retirements = [];
  const seenRunIds = new Set();
  const visit = (items) => {
    for (const node of items || []) {
      if (node?.type === 'jobhub' || node?.type === 'jobboard') {
        const nodeId = typeof node.id === 'string' && node.id ? node.id : null;
        for (const runId of durableManualAiRunIdsForWorkflowNode(node)) {
          if (nodeId && !seenRunIds.has(runId)) {
            seenRunIds.add(runId);
            retirements.push({ nodeId, runId });
          }
        }
      }
      visit(node?.data?.canvasData?.nodes);
      visit(node?.data?.nodes);
    }
  };
  visit(nodes);
  return retirements;
}

export function collectDeletedManualAiWorkflowNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  const workflowNodesById = new Map();
  const visit = (items) => {
    for (const node of items || []) {
      if ((node?.type === 'jobhub' || node?.type === 'jobboard') && node.id) {
        const entry = workflowNodesById.get(node.id) || { nodeId: node.id, markerRunIds: [] };
        for (const markerRunId of durableManualAiRunIdsForWorkflowNode(node)) {
          if (!entry.markerRunIds.includes(markerRunId)) entry.markerRunIds.push(markerRunId);
        }
        workflowNodesById.set(node.id, entry);
      }
      visit(node?.data?.canvasData?.nodes);
      visit(node?.data?.nodes);
    }
  };
  visit(nodes);
  return [...workflowNodesById.values()];
}

export function collectDeletedBoardChildClaims(nodes) {
  const claims = [];
  const seen = new Set();
  const visit = (items) => {
    for (const node of items || []) {
      const plan = node?.type === 'jobboard' ? node.data?.boardScanResume : null;
      const activeSourceIds = [...new Set([
        ...(Array.isArray(plan?.activeSourceIds) ? plan.activeSourceIds : []),
        plan?.activeSourceId,
      ].filter(Boolean))];
      if (
        plan?.version === 1
        && plan.phase === 'searches'
        && node.id
        && plan.boardRunId
        && activeSourceIds.length > 0
      ) {
        for (const sourceId of activeSourceIds) {
          const key = `${node.id}\u0000${plan.boardRunId}\u0000${sourceId}`;
          if (!seen.has(key)) {
            seen.add(key);
            claims.push({
              orchestratorNodeId: node.id,
              boardRunId: plan.boardRunId,
              sourceId,
              plan,
            });
          }
        }
      }
      visit(node?.data?.canvasData?.nodes);
      visit(node?.data?.nodes);
    }
  };
  visit(nodes);
  return claims;
}

/**
 * At a real deletion boundary, wait for the deleted node's handler cleanup
 * before removing its exact durable manual-AI handoff. If either acknowledgement
 * fails, the caller can restore/retain the node and its retry marker.
 */
export async function retireDeletedManualAiRuns(nodes) {
  const workflowNodes = collectDeletedManualAiWorkflowNodes(nodes);
  if (workflowNodes.length === 0) return [];
  const cancelAndWait = window.electronAPI?.cancelNodeTaskAndWait;
  if (typeof cancelAndWait !== 'function') {
    const error = new Error('Acknowledged manual-AI deletion cleanup is unavailable.');
    error.manualAiRetirementReceipts = workflowNodes.flatMap(workflowNode => (
      workflowNode.markerRunIds.map(runId => ({
        nodeId: workflowNode.nodeId,
        runId,
        cancellationPending: true,
      }))
    ));
    throw error;
  }

  // Wait for every node first and collect run ids from the main-process task
  // registry. Those ids exist before the renderer's pending event, closing the
  // durable-write → marker-publication deletion race.
  const acknowledgements = await Promise.all(workflowNodes.map(async (workflowNode) => {
    try {
      const acknowledgement = await cancelAndWait(workflowNode.nodeId, 'node-deleted');
      return { workflowNode, acknowledgement, error: null };
    } catch (error) {
      return { workflowNode, acknowledgement: null, error };
    }
  }));
  const receipts = acknowledgements.flatMap(({ workflowNode, acknowledgement, error }) => {
    const cancellationPending = !!error || acknowledgement?.settled !== true;
    return [...new Set([
      ...workflowNode.markerRunIds,
      ...(Array.isArray(acknowledgement?.manualAiRunIds)
        ? acknowledgement.manualAiRunIds
        : []),
    ].filter(Boolean))].map(runId => ({
      nodeId: workflowNode.nodeId,
      runId,
      cancellationPending,
    }));
  });
  const failedAcknowledgement = acknowledgements.find(({ acknowledgement, error }) => (
    !!error || acknowledgement?.settled !== true
  ));
  if (failedAcknowledgement) {
    const error = failedAcknowledgement.error
      || new Error('The deleted node did not finish cancelling before the safety timeout.');
    error.manualAiRetirementReceipts = receipts;
    throw error;
  }

  const runIds = [...new Set(acknowledgements.flatMap(({ workflowNode, acknowledgement }) => [
    ...workflowNode.markerRunIds,
    ...(Array.isArray(acknowledgement?.manualAiRunIds)
      ? acknowledgement.manualAiRunIds
      : []),
  ]).filter(Boolean))];
  if (runIds.length === 0) return [];
  const completeRuns = window.electronAPI?.completeNonApiAiRuns;
  if (typeof completeRuns !== 'function') {
    const error = new Error('Atomic durable manual-AI deletion cleanup is unavailable.');
    error.manualAiRetirementReceipts = receipts;
    throw error;
  }
  let result;
  try {
    result = await completeRuns(runIds);
  } catch (error) {
    error.manualAiRetirementReceipts = receipts;
    throw error;
  }
  const retired = new Set([
    ...(Array.isArray(result?.clearedRunIds) ? result.clearedRunIds : []),
    ...(Array.isArray(result?.absentRunIds) ? result.absentRunIds : []),
  ]);
  if (result?.completed !== true || runIds.some(runId => !retired.has(runId))) {
    const error = new Error('The deleted nodes\' saved manual-AI handoffs could not be retired atomically.');
    error.manualAiRetirementReceipts = receipts;
    throw error;
  }
  return runIds.map(runId => ({ runId }));
}

/** Reattach exact cleanup receipts when a pending deletion/clear is retained. */
export function applyManualAiRetirementReceiptsToNodes(nodes, receipts) {
  const byNodeId = new Map();
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (!receipt?.nodeId || !receipt?.runId) continue;
    const list = byNodeId.get(receipt.nodeId) || [];
    list.push(receipt);
    byNodeId.set(receipt.nodeId, list);
  }
  const patchItems = (items) => (Array.isArray(items) ? items.map((node) => {
    const candidates = byNodeId.get(node?.id) || [];
    const currentMarker = node?.data?.manualAiResume;
    const receipt = candidates.find(candidate => candidate.runId === currentMarker?.runId)
      || candidates[0]
      || null;
    const nestedCanvasNodes = patchItems(node?.data?.canvasData?.nodes);
    const legacyNestedNodes = patchItems(node?.data?.nodes);
    if (!receipt && nestedCanvasNodes === node?.data?.canvasData?.nodes && legacyNestedNodes === node?.data?.nodes) {
      return node;
    }
    const nextData = { ...(node?.data || {}) };
    if (node?.type === 'jobboard' && candidates.length > 0) {
      const cleanupReceiptsByRunId = new Map(
        (Array.isArray(nextData.manualAiCleanupReceipts)
          ? nextData.manualAiCleanupReceipts
          : [])
          .filter(item => item?.runId)
          .map(item => [item.runId, item]),
      );
      for (const candidate of candidates) {
        if (currentMarker?.runId === candidate.runId) {
          nextData.manualAiResume = {
            ...currentMarker,
            runId: candidate.runId,
            retirementPending: true,
            retirementReason: 'node-deleted',
            cancellationPending: candidate.cancellationPending === true,
            cancellationReason: 'node-deleted',
            updatedAt: Date.now(),
          };
          cleanupReceiptsByRunId.delete(candidate.runId);
          continue;
        }
        cleanupReceiptsByRunId.set(candidate.runId, {
          ...(cleanupReceiptsByRunId.get(candidate.runId) || {}),
          runId: candidate.runId,
          retirementPending: true,
          retirementReason: 'node-deleted',
          cancellationPending: candidate.cancellationPending === true,
          cancellationReason: 'node-deleted',
          updatedAt: Date.now(),
        });
      }
      const cleanupReceipts = [...cleanupReceiptsByRunId.values()].slice(-32);
      nextData.manualAiCleanupReceipts = cleanupReceipts.length > 0 ? cleanupReceipts : null;
    } else if (node?.type === 'jobhub' && candidates.length > 0) {
      const cleanupError = candidates.some(candidate => candidate.cancellationPending === true)
        ? 'Deletion cancellation did not finish. Retry the saved cleanup.'
        : 'Deletion was restored because saved manual-AI cleanup did not finish.';
      const cleanupReceiptsByRunId = new Map(
        (Array.isArray(nextData.manualAiCleanupReceipts)
          ? nextData.manualAiCleanupReceipts
          : [])
          .filter(item => item?.runId)
          .map(item => [item.runId, item]),
      );
      const matchingCurrentReceipt = currentMarker?.runId
        ? candidates.find(candidate => candidate.runId === currentMarker.runId) || null
        : null;
      // Keep an unrelated live marker authoritative. With no live marker,
      // retain the legacy primary-receipt shape so Search recovery can surface
      // and retry it, while preserving every additional run separately.
      const primaryReceipt = matchingCurrentReceipt || (!currentMarker?.runId ? candidates[0] : null);
      if (currentMarker?.runId) cleanupReceiptsByRunId.delete(currentMarker.runId);
      for (const candidate of candidates) {
        if (primaryReceipt?.runId === candidate.runId) {
          nextData.manualAiResume = {
            ...(currentMarker?.runId === candidate.runId ? currentMarker : {}),
            runId: candidate.runId,
            retirementPending: true,
            retirementReason: 'node-deleted',
            cancellationPending: candidate.cancellationPending === true,
            cancellationReason: 'node-deleted',
            cleanupError,
            updatedAt: Date.now(),
          };
          cleanupReceiptsByRunId.delete(candidate.runId);
          continue;
        }
        cleanupReceiptsByRunId.set(candidate.runId, {
          ...(cleanupReceiptsByRunId.get(candidate.runId) || {}),
          runId: candidate.runId,
          retirementPending: true,
          retirementReason: 'node-deleted',
          cancellationPending: candidate.cancellationPending === true,
          cancellationReason: 'node-deleted',
          cleanupError,
          updatedAt: Date.now(),
        });
      }
      const cleanupReceipts = [...cleanupReceiptsByRunId.values()].slice(-32);
      nextData.manualAiCleanupReceipts = cleanupReceipts.length > 0 ? cleanupReceipts : null;
      nextData.errorMessage = cleanupError;
    } else if (receipt) {
      nextData.manualAiResume = {
        ...(currentMarker?.runId === receipt.runId ? currentMarker : {}),
        runId: receipt.runId,
        retirementPending: true,
        retirementReason: 'node-deleted',
        cancellationPending: receipt.cancellationPending === true,
        cancellationReason: 'node-deleted',
        updatedAt: Date.now(),
      };
      nextData.errorMessage = receipt.cancellationPending
        ? 'Deletion cancellation did not finish. Retry the saved cleanup.'
        : 'Deletion was restored because saved manual-AI cleanup did not finish.';
    }
    if (Array.isArray(node?.data?.canvasData?.nodes)) {
      nextData.canvasData = { ...node.data.canvasData, nodes: nestedCanvasNodes };
    }
    if (Array.isArray(node?.data?.nodes)) nextData.nodes = legacyNestedNodes;
    return { ...node, data: nextData };
  }) : items);
  return patchItems(nodes);
}

/**
 * Restore only roots whose saved tree contains an affected Job workflow (plus
 * its top-level owned cards), then layer newly discovered cleanup receipts on
 * top. This rolls back renderer transitions caused by acknowledged aborts
 * without overwriting unrelated edits which landed during an async preflight.
 */
export function restoreJobWorkflowSnapshots(liveNodes, snapshotNodes, workflowNodeIds, receipts = null) {
  const workflowIds = workflowNodeIds instanceof Set
    ? workflowNodeIds
    : new Set(Array.isArray(workflowNodeIds) ? workflowNodeIds : []);
  if (workflowIds.size === 0) {
    return applyManualAiRetirementReceiptsToNodes(liveNodes, receipts);
  }
  const treeContainsWorkflow = (node) => {
    if (workflowIds.has(node?.id) || workflowIds.has(node?.data?.hubId)) return true;
    return (node?.data?.canvasData?.nodes || []).some(treeContainsWorkflow)
      || (node?.data?.nodes || []).some(treeContainsWorkflow);
  };
  const snapshots = (Array.isArray(snapshotNodes) ? snapshotNodes : [])
    .filter(treeContainsWorkflow);
  const snapshotById = new Map(snapshots.map(node => [node.id, node]));
  const transientSearchStates = new Set([
    'queued', 'parsing', 'interpreting-preferences', 'querying', 'searching',
    'evaluating-preferences', 'scoring',
  ]);
  const stableLiveSearchIds = new Set((Array.isArray(liveNodes) ? liveNodes : [])
    .filter(node => node?.type === 'jobhub'
      && workflowIds.has(node.id)
      && !transientSearchStates.has(node.data?.hubState))
    .map(node => node.id));
  const restored = (Array.isArray(liveNodes) ? liveNodes : []).map((node) => {
    const snapshot = snapshotById.get(node.id);
    if (!snapshot) return node;
    // Board cancellation intentionally leaves its visible prior result while
    // clearing/augmenting exact recovery receipts. Never resurrect the older
    // plan captured before that cancellation.
    if (node.type === 'jobboard') return node;
    // Exact Search cancellation restores its owned source-card graph together
    // with the stable hub. If a later deletion preflight fails, the mid-run
    // preflight snapshot is no longer authoritative for those cards: restoring
    // it would resurrect warnings/progress that the exact rollback removed.
    if (node.type === 'jobsourcecard' && stableLiveSearchIds.has(node.data?.hubId)) return node;
    if (node.type !== 'jobhub') return snapshot;
    // Exact Board rollback and re-analysis cancellation both publish a stable
    // live state. Prefer it to the mid-run preflight snapshot.
    if (!transientSearchStates.has(node.data?.hubState)) return node;
    const snapshotData = { ...(snapshot.data || {}) };
    if (transientSearchStates.has(snapshotData.hubState)) {
      const hasPriorResults = Array.isArray(snapshotData.scoredJobs)
        && snapshotData.scoredJobs.length > 0;
      const hasPausedPayload = Array.isArray(snapshotData.pendingJobs);
      snapshotData.hubState = hasPriorResults
        ? 'done'
        : hasPausedPayload
          ? 'sources-ready'
          : 'empty';
      snapshotData.queuedModuleRun = null;
    }
    return { ...snapshot, data: snapshotData };
  });
  const liveIds = new Set(restored.map(node => node.id));
  for (const snapshot of snapshots) {
    if (
      snapshot?.type === 'jobsourcecard'
      && stableLiveSearchIds.has(snapshot.data?.hubId)
    ) continue;
    if (!liveIds.has(snapshot.id)) restored.push(snapshot);
  }
  return applyManualAiRetirementReceiptsToNodes(restored, receipts);
}

/**
 * Return the exact durable Job Search runs abandoned by a real canvas deletion.
 * This deliberately consumes the deleted-node snapshot supplied by React Flow:
 * component unmount is also used for canvas navigation and therefore is not
 * evidence that the user deleted anything.
 */
export function collectDeletedJobRunDiscards(nodes, canvasFilePath) {
  if (!Array.isArray(nodes)) return [];
  const discards = [];
  const seen = new Set();
  const visit = (items) => {
    for (const node of items || []) {
      if (node?.type === 'jobhub') {
        const nodeId = node.id || null;
        const runId = node.data?.jobRunId || null;
        const key = `${nodeId || ''}\u0000${runId || ''}`;
        if (nodeId && runId && !seen.has(key)) {
          seen.add(key);
          discards.push({ canvasFilePath, nodeId, runId });
        }
      }
      visit(node?.data?.canvasData?.nodes);
      visit(node?.data?.nodes);
    }
  };
  visit(nodes);
  return discards;
}

/**
 * Dispatch best-effort exact-run cleanup for every deleted Job Search hub.
 * Kept beside the collector so interactive React Flow deletion and the
 * programmatic Clear Canvas path cannot drift into different lifecycle rules.
 */
export function discardDeletedJobRuns(nodes, canvasFilePath, onError = null) {
  const discards = collectDeletedJobRunDiscards(nodes, canvasFilePath);
  for (const discard of discards) {
    const discardRun = window.electronAPI?.discardJobRun;
    if (typeof discardRun !== 'function') {
      onError?.(new Error('Job run cleanup is unavailable'), discard, null);
      continue;
    }
    try {
      Promise.resolve(discardRun(discard)).then((result) => {
        if (result?.success !== true || result?.ok !== true) {
          onError?.(new Error(result?.error || result?.reason || 'Job run cleanup failed'), discard, result);
        }
      }).catch((error) => onError?.(error, discard, null));
    } catch (error) {
      onError?.(error, discard, null);
    }
  }
  return discards;
}

/**
 * Capture analysis-bundle cleanup ownership at a committed deletion boundary.
 * The bundle is canvas-scoped, so the hub/run and clear timestamp must be
 * captured before React Flow removes the node. Callers pass the actual removed
 * roots: Clear Canvas has already excluded its top-level locked roots, while a
 * locked descendant of an unlocked deleted group is still removed and must be
 * cleaned rather than left resumable on disk.
 */
export function collectDeletedJobAnalysisDiscards(nodes, canvasFilePath, clearedAt = Date.now()) {
  if (!Array.isArray(nodes)) return [];
  const discards = [];
  const seen = new Set();
  const visit = (items) => {
    for (const node of items || []) {
      if (node?.type === 'jobhub') {
        const nodeId = typeof node.id === 'string' && node.id ? node.id : null;
        const rawRunId = node.data?.jobRunId || null;
        // A malformed persisted run token must not turn an otherwise safe
        // boundary clear into an invalid IPC request. Null still deletes
        // pre-boundary artifacts by exact hub/canvas ownership; a valid token
        // simply adds the equal-time/late-write tombstone.
        const runId = normalizeJobAnalysisClearRunId(rawRunId);
        // A terminal hub can have saved analysis without a live staging token,
        // so null runId still needs an exact hub-owned cleanup attempt.
        if (nodeId && !seen.has(nodeId)) {
          seen.add(nodeId);
          discards.push({ canvasFilePath, nodeId, runId, clearedAt });
        }
      }
      visit(node?.data?.canvasData?.nodes);
      visit(node?.data?.nodes);
    }
  };
  visit(nodes);
  return discards;
}

// A cross-hub bundle can be mixed because `current` has already advanced to a
// different hub/run while this deleted hub still owns an older last-success
// record. Preserving the foreign/new artifacts and clearing the exact old one
// is a successful safe outcome, not a warning. An `unpaired` prompt is NOT
// safe: it has no owner metadata, may retain the removed hub's career data,
// and needs an honest cleanup warning. Never silently accept malformed JSON,
// uncertain removal, or an unknown state either.
export function isSafeJobAnalysisCleanupNoop(result) {
  if (result?.reason !== 'ownership-mismatch') return false;
  const artifacts = Object.values(result?.artifacts || {});
  const safeStates = new Set(['missing', 'ownership-mismatch', 'foreign-paired', 'post-clear', 'post-clear-paired', 'cleared']);
  return artifacts.length > 0
    && artifacts.every(artifact => safeStates.has(artifact?.state));
}

/**
 * Dispatch best-effort analysis cleanup without delaying visual deletion. The
 * main process rechecks canvas/hub ownership and uses the captured timestamp
 * plus run tombstone to prevent Undo or a late same-run writer resurfacing
 * pre-clear career-derived recovery.
 */
export function discardDeletedJobAnalysisSnapshots(nodes, canvasFilePath, onFailure = null, clearedAt = Date.now()) {
  const discards = collectDeletedJobAnalysisDiscards(nodes, canvasFilePath, clearedAt);
  for (const discard of discards) {
    const discardSnapshot = window.electronAPI?.discardJobAnalysisSnapshot;
    if (!discardSnapshot) {
      onFailure?.(new Error('Saved Job Search recovery cleanup is unavailable'), discard, null);
      continue;
    }
    try {
      Promise.resolve(discardSnapshot(discard)).then((result) => {
        const safeNoop = isSafeJobAnalysisCleanupNoop(result);
        if (result?.success !== true || (result?.ok !== true && !safeNoop)) {
          const detail = result?.error || result?.reason;
          onFailure?.(new Error(`Saved Job Search recovery cleanup failed${detail ? `: ${detail}` : ''}`), discard, result);
        }
      }).catch((error) => onFailure?.(error, discard, null));
    } catch (error) {
      onFailure?.(error, discard, null);
    }
  }
  return discards;
}
