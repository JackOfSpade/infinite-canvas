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

function isManualAiWorkflowNode(node) {
  return node?.type === 'jobhub'
    || node?.type === 'jobboard'
    || node?.type === 'interviewhelper';
}

// These renderer-owned receipts become arguments to main-process cleanup APIs
// at a deletion boundary. Keep their grammar in lockstep with
// InterviewHelperNode and undoNonRestorableState: persisted canvas data is not
// trusted simply because it has a string named `runId`.
const INTERVIEW_HELPER_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const INTERVIEW_HELPER_MAX_RETIREMENT_RECEIPTS = 32;
// Canvas JSON is normally a tree, but imported/corrupt in-memory data can
// contain a cyclic reference or pathological nesting. Lifecycle cleanup runs
// at destructive boundaries, so it must not overflow the renderer stack or
// silently loop before it can cancel a real sibling. These limits are far
// above a practical nested-canvas workspace while still bounding hostile data.
export const CANVAS_LIFECYCLE_MAX_NESTED_DEPTH = 64;
export const CANVAS_LIFECYCLE_MAX_NODES = 10_000;

/**
 * Visit each reachable canvas node once without recursion.
 *
 * Returns `{ complete: false }` if the input is malformed beyond the safe
 * traversal envelope. Callers that retire durable work use that result as a
 * fail-closed signal; best-effort post-commit notification callers still
 * process the safely reachable prefix.
 */
export function walkCanvasNodesBounded(nodes, visitor, {
  maxDepth = CANVAS_LIFECYCLE_MAX_NESTED_DEPTH,
  maxNodes = CANVAS_LIFECYCLE_MAX_NODES,
} = {}) {
  if (!Array.isArray(nodes) || typeof visitor !== 'function') return { complete: !nodes || Array.isArray(nodes), visited: 0 };
  const stack = nodes.map(node => ({ node, depth: 0 })).reverse();
  const seenNodes = new WeakSet();
  const seenArrays = new WeakSet([nodes]);
  let visited = 0;
  let complete = true;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (seenNodes.has(node)) { complete = false; continue; }
    seenNodes.add(node);
    if (depth > maxDepth || visited >= maxNodes) { complete = false; continue; }
    visited += 1;
    visitor(node, depth);
    const childLists = [node.data?.canvasData?.nodes, node.data?.nodes];
    const locallyAliasedChildArrays = new Set();
    for (let index = childLists.length - 1; index >= 0; index -= 1) {
      const children = childLists[index];
      if (children == null) continue;
      if (!Array.isArray(children)) { complete = false; continue; }
      // A migrated group can expose the same child array through both the
      // current and legacy field. It is already covered; that is not a
      // malformed graph or a reason to reject an otherwise safe deletion.
      if (seenArrays.has(children)) {
        // The one benign alias is a single migrated node exposing its exact
        // children through both current and legacy fields. A root/self cycle
        // or an array shared by a different node is malformed and must make
        // transactional retirement fail closed.
        if (locallyAliasedChildArrays.has(children)) continue;
        complete = false;
        continue;
      }
      seenArrays.add(children);
      locallyAliasedChildArrays.add(children);
      if (depth >= maxDepth) { complete = false; continue; }
      for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
        stack.push({ node: children[childIndex], depth: depth + 1 });
      }
    }
  }
  return { complete, visited };
}

function isPlainRecord(value) {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isInterviewHelperRunId(value) {
  return typeof value === 'string' && INTERVIEW_HELPER_RUN_ID_RE.test(value);
}

function hasExactOwnKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length
    && actual.every((key, index) => key === keys[index]);
}

function interviewHelperCareerRunId(value) {
  return isPlainRecord(value)
    && ['compiling', 'failed'].includes(value.status)
    && Object.hasOwn(value, 'manualAiRunId')
    && isInterviewHelperRunId(value.manualAiRunId)
    ? value.manualAiRunId
    : null;
}

function interviewHelperPreparationRunId(data) {
  const preparation = data?.interviewHelperPreparation;
  const runId = data?.interviewHelperPreparationRunId;
  return isPlainRecord(preparation)
    && ['preparing', 'failed'].includes(preparation.status)
    && Object.hasOwn(data || {}, 'interviewHelperPreparationRunId')
    && isInterviewHelperRunId(runId)
    ? runId
    : null;
}

function interviewHelperCleanupMarkerRunId(value) {
  return hasExactOwnKeys(value, ['kind', 'runId', 'status', 'version'])
    && value.version === 1
    && (value.kind === 'career' || value.kind === 'preparation')
    && value.status === 'failed'
    && isInterviewHelperRunId(value.runId)
    ? value.runId
    : null;
}

function normalizeInterviewHelperRetirementReceipt(value) {
  const legacyKeys = ['cancellationPending', 'cancellationReason', 'retirementPending', 'retirementReason', 'runId'];
  const currentKeys = [...legacyKeys, 'updatedAt'];
  if (!hasExactOwnKeys(value, legacyKeys) && !hasExactOwnKeys(value, currentKeys)) return null;
  if (!isInterviewHelperRunId(value.runId)
    || value.retirementPending !== true
    || value.retirementReason !== 'node-deleted'
    || typeof value.cancellationPending !== 'boolean'
    || value.cancellationReason !== 'node-deleted'
    || (Object.hasOwn(value, 'updatedAt')
      && (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0))) return null;
  return {
    runId: value.runId,
    retirementPending: true,
    retirementReason: 'node-deleted',
    cancellationPending: value.cancellationPending,
    cancellationReason: 'node-deleted',
    ...(Object.hasOwn(value, 'updatedAt') ? { updatedAt: value.updatedAt } : {}),
  };
}

function normalizedInterviewHelperRetirementReceipts(value) {
  if (!Array.isArray(value)) return [];
  const byRunId = new Map();
  for (const item of value) {
    const receipt = normalizeInterviewHelperRetirementReceipt(item);
    if (!receipt) continue;
    // Match the UI's last-seen-wins, bounded persistence behavior.
    byRunId.delete(receipt.runId);
    byRunId.set(receipt.runId, receipt);
  }
  return [...byRunId.values()].slice(-INTERVIEW_HELPER_MAX_RETIREMENT_RECEIPTS);
}

// Receipts passed back from a failed deletion are not persisted UI receipts:
// they are the narrow handoff between deletion and restoration. Give them an
// equally strict schema before they may seed any durable retry record.
function normalizeInterviewHelperDeletionReceipt(value) {
  if (!hasExactOwnKeys(value, ['cancellationPending', 'nodeId', 'runId'])
    || typeof value.nodeId !== 'string'
    || !value.nodeId
    || !isInterviewHelperRunId(value.runId)
    || typeof value.cancellationPending !== 'boolean') return null;
  return {
    nodeId: value.nodeId,
    runId: value.runId,
    cancellationPending: value.cancellationPending,
  };
}

function acknowledgedManualAiRunIds(workflowNode, acknowledgement) {
  const raw = Array.isArray(acknowledgement?.manualAiRunIds)
    ? acknowledgement.manualAiRunIds
    : [];
  // Do not change the long-standing Search/Board compatibility grammar here.
  // Interview Helper's newly introduced persisted/UI contract is strict.
  return workflowNode?.type === 'interviewhelper'
    ? raw.filter(isInterviewHelperRunId)
    : raw.filter(Boolean);
}

function durableManualAiRunIdsForWorkflowNode(node) {
  if (!isManualAiWorkflowNode(node)) return [];
  const data = node.data || {};
  if (node.type === 'interviewhelper') {
    return [...new Set([
      interviewHelperCareerRunId(data.interviewHelperCareerCompilation),
      interviewHelperPreparationRunId(data),
      interviewHelperCleanupMarkerRunId(data.interviewHelperManualAiCleanup),
      ...normalizedInterviewHelperRetirementReceipts(
        data.interviewHelperManualAiRetirementReceipts,
      ).map(receipt => receipt.runId),
    ].filter(isInterviewHelperRunId))];
  }
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
 * @param {Set}   [skipIds] - Optional set of node IDs to skip (e.g. already
 *                              acknowledged manual-AI workflow roots)
 * @param {object} [options]
 * @param {boolean} [options.notifySkippedInterviewHelpers=false] - A committed
 * deletion has already acknowledged an Interview Helper's worker before the
 * raw sweep. It still needs this direct, post-commit notification to retire
 * its owner-scoped companion window. Job/Search and Board roots remain skipped
 * so they are never needlessly aborted a second time.
 */
export function cancelNodeTasksRecursively(nodes, skipIds, options = {}) {
  if (!Array.isArray(nodes)) return { complete: true, visited: 0 };
  const { notifySkippedInterviewHelpers = false } = options;
  return walkCanvasNodesBounded(nodes, n => {
    const skipped = skipIds?.has(n.id);
    if (skipped && !(notifySkippedInterviewHelpers && n?.type === 'interviewhelper')) return;
    // This helper is only reached from the two real deletion paths, so it is
    // the one caller whose cancel genuinely IS a node deletion — every other
    // caller passes its own cause so diagnostics stop calling a Reset a delete.
    try {
      window.electronAPI?.cancelNodeTask?.(n.id, 'node-deleted');
    } catch {
      // Cancellation is best effort at this post-commit sweep. Continue to
      // reachable siblings so one bridge failure cannot strand their tasks.
    }
  });
}

/**
 * Return every Marketplace recovery owner in a removed node tree. Group nodes
 * persist their children under `canvasData.nodes` (with `data.nodes` retained
 * as a legacy fallback), so lifecycle cleanup must recurse just like generic
 * task cancellation does. The durable sidecar itself is authoritative for the
 * run id; `runId` here is only the renderer-marker fallback for the autosave
 * gap where a peek reports no active receipt.
 */
export function collectMarketplaceRecoveryOwners(nodes) {
  if (!Array.isArray(nodes)) return [];
  const owners = [];
  const seen = new Set();
  walkCanvasNodesBounded(nodes, node => {
      const kind = node?.type === 'sellhub'
        ? 'sellhub'
        : node?.type === 'marketplacestatus'
          ? 'marketplace-status'
          : null;
      if (kind && node?.id) {
        const key = `${kind}\u0000${node.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          owners.push({
            nodeId: node.id,
            kind,
            runId: kind === 'sellhub'
              ? node.data?.marketplaceRunResume?.runId || null
              : node.data?.marketplaceStatusRunResume?.runId || null,
            inputKey: kind === 'sellhub'
              ? node.data?.marketplaceRunResume?.inputKey ?? null
              : node.data?.marketplaceStatusRunResume?.inputKey ?? null,
          });
        }
      }
  });
  return owners;
}

/**
 * Return exact durable manual-AI workflow ids owned by deleted Job Search,
 * Job Board, or Interview Helper nodes, including nodes nested inside removed
 * canvas groups.
 */
export function collectDeletedManualAiRetirements(nodes) {
  if (!Array.isArray(nodes)) return [];
  const retirements = [];
  const seenRunIds = new Set();
  walkCanvasNodesBounded(nodes, node => {
      if (isManualAiWorkflowNode(node)) {
        const nodeId = typeof node.id === 'string' && node.id ? node.id : null;
        for (const runId of durableManualAiRunIdsForWorkflowNode(node)) {
          if (nodeId && !seenRunIds.has(runId)) {
            seenRunIds.add(runId);
            retirements.push({ nodeId, runId });
          }
        }
      }
  });
  return retirements;
}

export function collectDeletedManualAiWorkflowNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  const workflowNodesById = new Map();
  walkCanvasNodesBounded(nodes, node => {
      if (isManualAiWorkflowNode(node) && node.id) {
        const entry = workflowNodesById.get(node.id) || {
          nodeId: node.id,
          type: node.type,
          markerRunIds: [],
        };
        for (const markerRunId of durableManualAiRunIdsForWorkflowNode(node)) {
          if (!entry.markerRunIds.includes(markerRunId)) entry.markerRunIds.push(markerRunId);
        }
        workflowNodesById.set(node.id, entry);
      }
  });
  return [...workflowNodesById.values()];
}

export function collectDeletedBoardChildClaims(nodes) {
  const claims = [];
  const seen = new Set();
  walkCanvasNodesBounded(nodes, node => {
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
  });
  return claims;
}

/**
 * At a real deletion boundary, wait for the deleted node's handler cleanup
 * before removing its exact durable manual-AI handoff. If either acknowledgement
 * fails, the caller can restore/retain the node and its retry marker.
 */
export async function retireDeletedManualAiRuns(nodes) {
  // Unlike post-commit best-effort cancellation, durable manual-AI retirement
  // must not proceed with a partial tree: that could delete a parent while a
  // hidden descendant still owns a resumable handoff. Reject the transaction
  // and let its caller retain/restore the canvas instead.
  const traversal = walkCanvasNodesBounded(nodes, () => {});
  if (!traversal.complete) {
    throw new Error('Canvas lifecycle cleanup stopped at an unsafe nested-canvas boundary. The deletion was not completed.');
  }
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
      ...acknowledgedManualAiRunIds(workflowNode, acknowledgement),
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
    ...acknowledgedManualAiRunIds(workflowNode, acknowledgement),
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
  // Receipt restoration is reached on a failed destructive transaction. Do
  // not recurse into corrupt data while trying to make it safe; preserving the
  // live tree unchanged is the only honest recovery when traversal is bounded.
  if (!walkCanvasNodesBounded(nodes, () => {}).complete) return nodes;
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
    const currentChildren = node?.data?.canvasData?.nodes;
    const legacyChildren = node?.data?.nodes;
    const nestedCanvasNodes = patchItems(currentChildren);
    // Current + legacy fields can deliberately alias the same array during a
    // migration. Reusing its transformed result keeps a valid deeply nested
    // tree linear instead of expanding work exponentially at every level.
    const legacyNestedNodes = legacyChildren === currentChildren
      ? nestedCanvasNodes
      : patchItems(legacyChildren);
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
    } else if (node?.type === 'interviewhelper' && candidates.length > 0) {
      // The helper's UI cleanup marker is deliberately an exact terminal-only
      // shape. A deletion acknowledgement can still be in flight, so do not
      // add cancellation metadata to that marker or manufacture a failed
      // marker for a live worker. Retain every exact id separately; the next
      // deletion/recovery preflight will include these receipts alongside the
      // helper's native career, preparation, and terminal-cleanup owners.
      const receiptsByRunId = new Map(
        normalizedInterviewHelperRetirementReceipts(
          nextData.interviewHelperManualAiRetirementReceipts,
        ).map(item => [item.runId, item]),
      );
      for (const rawCandidate of candidates) {
        const candidate = normalizeInterviewHelperDeletionReceipt(rawCandidate);
        if (!candidate || candidate.nodeId !== node?.id) continue;
        receiptsByRunId.delete(candidate.runId);
        receiptsByRunId.set(candidate.runId, {
          runId: candidate.runId,
          retirementPending: true,
          retirementReason: 'node-deleted',
          cancellationPending: candidate.cancellationPending === true,
          cancellationReason: 'node-deleted',
          updatedAt: Date.now(),
        });
      }
      const retainedReceipts = [...receiptsByRunId.values()]
        .slice(-INTERVIEW_HELPER_MAX_RETIREMENT_RECEIPTS);
      nextData.interviewHelperManualAiRetirementReceipts = retainedReceipts.length > 0
        ? retainedReceipts
        : null;
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
  // This helper performs structural recursion below. A malformed group graph
  // is not a valid rollback target; retain live state rather than risking a
  // stack overflow or reviving a worker marker from an unbounded snapshot.
  if (!walkCanvasNodesBounded(liveNodes, () => {}).complete
    || !walkCanvasNodesBounded(snapshotNodes, () => {}).complete) return liveNodes;
  const workflowIds = workflowNodeIds instanceof Set
    ? workflowNodeIds
    : new Set(Array.isArray(workflowNodeIds) ? workflowNodeIds : []);
  if (workflowIds.size === 0) {
    return applyManualAiRetirementReceiptsToNodes(liveNodes, receipts);
  }
  const treeContainsWorkflow = (node) => {
    if (workflowIds.has(node?.id) || workflowIds.has(node?.data?.hubId)) return true;
    const currentChildren = node?.data?.canvasData?.nodes || [];
    const legacyChildren = node?.data?.nodes || [];
    return currentChildren.some(treeContainsWorkflow)
      || (legacyChildren !== currentChildren && legacyChildren.some(treeContainsWorkflow));
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
  walkCanvasNodesBounded(nodes, node => {
      if (node?.type === 'jobhub') {
        const nodeId = node.id || null;
        const runId = node.data?.jobRunId || null;
        const key = `${nodeId || ''}\u0000${runId || ''}`;
        if (nodeId && runId && !seen.has(key)) {
          seen.add(key);
          discards.push({ canvasFilePath, nodeId, runId });
        }
      }
  });
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
  walkCanvasNodesBounded(nodes, node => {
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
  });
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
