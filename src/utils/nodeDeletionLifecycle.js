// React Flow applies node removal before `onNodesDelete` cleanup can await IPC.
// Mark job workflow nodes synchronously so their component-unmount handlers do
// not independently retire external work while a delete/OS prompt is still
// reversible. The deletion boundary later commits cleanup or explicitly
// restores the captured nodes.
// More than one reversible boundary can observe the same node (for example, a
// second Delete/Clear request while the first OS confirmation is still open).
// Reference counts ensure settling one transaction cannot wake recovery while
// another transaction still owns the deletion guard.
const pendingJobWorkflowDeletions = new Map();
const deletionLifecycleSubscribers = new Set();
let deletionLifecycleRevision = 0;

function publishDeletionLifecycleChange() {
  deletionLifecycleRevision += 1;
  for (const subscriber of deletionLifecycleSubscribers) {
    try {
      subscriber();
    } catch {
      // External-store subscribers are observers only. A broken renderer must
      // not prevent the deletion guard itself from being updated.
    }
  }
}

export function subscribeJobWorkflowDeletionLifecycle(subscriber) {
  if (typeof subscriber !== 'function') return () => {};
  deletionLifecycleSubscribers.add(subscriber);
  return () => deletionLifecycleSubscribers.delete(subscriber);
}

export function getJobWorkflowDeletionLifecycleRevision() {
  return deletionLifecycleRevision;
}

function visitNodeTree(nodes, callback) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    callback(node);
    visitNodeTree(node?.data?.canvasData?.nodes, callback);
    visitNodeTree(node?.data?.nodes, callback);
  }
}

export function getActiveJobBoardSearchReferenceIds(board) {
  if (board?.type !== 'jobboard') return [];
  const data = board.data || {};
  const plan = data.boardScanResume || null;
  const manual = data.manualAiResume || null;
  const cancellation = data.boardCancellation || null;
  // A retirement-only receipt cannot read or mutate Search inputs. Counting it
  // as an active reference would make a harmless cleanup failure block deletion
  // of a connected Search indefinitely.
  const replayableManualSourceRuns = manual?.retirementPending === true
    ? []
    : Array.isArray(manual?.combineSourceRuns)
      ? manual.combineSourceRuns
      : [];
  return [...new Set([
    ...(Array.isArray(plan?.selectedSearchModuleIds) ? plan.selectedSearchModuleIds : []),
    plan?.activeSourceId,
    plan?.cancellationCleanup?.sourceId,
    ...Object.keys(plan?.completedSourceRuns || {}),
    ...(Array.isArray(plan?.combineSourceRuns) ? plan.combineSourceRuns.map(entry => entry?.sourceId) : []),
    ...replayableManualSourceRuns.map(entry => entry?.sourceId),
    cancellation?.sourceId,
    cancellation?.childCleanup?.sourceId,
  ].filter(Boolean))];
}

export function jobBoardHasCancellableRecovery(board) {
  const data = board?.data || {};
  return !!data.boardScanResume
    || !!data.boardCancellation
    || (!!data.manualAiResume && data.manualAiResume.retirementPending !== true);
}

/**
 * Return every Board whose current renderer/durable work can be affected by
 * deleting the supplied workflow ids. Live edges are necessary for standalone
 * queued/Combine runs that have not published a marker yet; durable references
 * cover recovered plans whose edge was already removed.
 */
export function collectJobBoardsAffectedByDeletion(nodes, edges, deletedWorkflowIds) {
  const workflowIds = deletedWorkflowIds instanceof Set
    ? deletedWorkflowIds
    : new Set(Array.isArray(deletedWorkflowIds) ? deletedWorkflowIds : []);
  const allNodes = [];
  const seenNodeIds = new Set();
  visitNodeTree(nodes, (node) => {
    if (!node?.id || seenNodeIds.has(node.id)) return;
    seenNodeIds.add(node.id);
    allNodes.push(node);
  });
  const deletedSearchIds = new Set(allNodes
    .filter(node => node?.type === 'jobhub' && workflowIds.has(node.id))
    .map(node => node.id));
  const liveEdges = Array.isArray(edges) ? edges : [];
  return allNodes.filter((node) => {
    if (node?.type !== 'jobboard') return false;
    if (workflowIds.has(node.id)) return true;
    if (getActiveJobBoardSearchReferenceIds(node)
      .some(sourceId => deletedSearchIds.has(sourceId))) return true;
    return liveEdges.some(edge => (
      (edge?.source === node.id && deletedSearchIds.has(edge?.target))
      || (edge?.target === node.id && deletedSearchIds.has(edge?.source))
    ));
  });
}

/**
 * Clear Canvas retains locked workflow roots as one coherent visual unit. Their
 * display children are owned state, so keeping only the locked root would leave
 * result counts with no cascade/source cards. Conversely, a locked owned child
 * cannot survive after its unlocked workflow root is removed: that would be an
 * orphan with stale controls and provenance.
 */
export function getClearCanvasRetainedNodes(nodes) {
  const items = Array.isArray(nodes) ? nodes : [];
  const lockedWorkflowIds = new Set(items
    .filter(node => (
      (node?.type === 'jobhub' || node?.type === 'jobboard')
      && node.data?.locked
      && node.id
    ))
    .map(node => node.id));
  const removedWorkflowIds = new Set(items
    .filter(node => (
      (node?.type === 'jobhub' || node?.type === 'jobboard')
      && !node.data?.locked
      && node.id
    ))
    .map(node => node.id));
  return items.filter((node) => {
    if (lockedWorkflowIds.has(node?.id)) return true;
    const ownerId = node?.data?.hubId;
    if (ownerId && removedWorkflowIds.has(ownerId)) return false;
    if (ownerId && lockedWorkflowIds.has(ownerId)) return true;
    return node?.data?.locked === true;
  });
}

const CLEAR_CANVAS_OWNED_CHILD_TYPES = new Set([
  'jobcard',
  'jobgroup',
  'jobsourcecard',
]);

function clearCanvasMutationFenceRecords(nodes) {
  const records = [];
  visitNodeTree(nodes, (node) => {
    if (!node?.id) return;
    // Exact child restoration is an expected consequence of acknowledged
    // Board/Search cancellation. The owner root is guarded below, and the
    // live retained partition is recomputed after cancellation so restored
    // cards are kept or removed with that owner.
    if (CLEAR_CANVAS_OWNED_CHILD_TYPES.has(node.type) && node.data?.hubId) return;
    records.push(`${node.id}\u0000${node.type || ''}\u0000${node.data?.locked === true ? '1' : '0'}`);
  });
  return records.sort();
}

function clearCanvasMutationFenceEdgeRecords(nodes, edges) {
  const ownedChildIds = new Set();
  visitNodeTree(nodes, (node) => {
    if (
      node?.id
      && CLEAR_CANVAS_OWNED_CHILD_TYPES.has(node.type)
      && node.data?.hubId
    ) ownedChildIds.add(node.id);
  });
  return (Array.isArray(edges) ? edges : [])
    .filter(edge => (
      edge?.source
      && edge?.target
      && !ownedChildIds.has(edge.source)
      && !ownedChildIds.has(edge.target)
    ))
    .map((edge) => {
      const endpoints = [edge.source, edge.target].sort();
      return `${endpoints[0]}\u0000${endpoints[1]}`;
    })
    .sort();
}

/**
 * Clear Canvas performs acknowledged cancellation asynchronously. Fail closed
 * if a user-visible/root node was added, removed, retyped, locked, or unlocked
 * during that window; otherwise a stale final array replacement could erase a
 * newly created workflow which was never included in lifecycle cleanup.
 */
export function isClearCanvasDeletionFenceIntact(
  initialNodes,
  liveNodes,
  initialEdges = [],
  liveEdges = [],
) {
  const initial = clearCanvasMutationFenceRecords(initialNodes);
  const live = clearCanvasMutationFenceRecords(liveNodes);
  const initialConnections = clearCanvasMutationFenceEdgeRecords(initialNodes, initialEdges);
  const liveConnections = clearCanvasMutationFenceEdgeRecords(liveNodes, liveEdges);
  return initial.length === live.length
    && initial.every((record, index) => record === live[index])
    && initialConnections.length === liveConnections.length
    && initialConnections.every((record, index) => record === liveConnections[index]);
}

export function markJobWorkflowDeletionPending(nodes) {
  const ids = new Set();
  visitNodeTree(nodes, (node) => {
    if ((node?.type === 'jobhub' || node?.type === 'jobboard') && node.id) {
      ids.add(node.id);
    }
  });
  let changed = false;
  for (const id of ids) {
    const priorCount = pendingJobWorkflowDeletions.get(id) || 0;
    pendingJobWorkflowDeletions.set(id, priorCount + 1);
    if (priorCount === 0) changed = true;
  }
  if (changed) publishDeletionLifecycleChange();
  return [...ids];
}

export function settleJobWorkflowDeletion(ids) {
  let changed = false;
  for (const id of new Set(Array.isArray(ids) ? ids : [])) {
    const priorCount = pendingJobWorkflowDeletions.get(id) || 0;
    if (priorCount <= 1) {
      if (pendingJobWorkflowDeletions.delete(id)) changed = true;
    } else {
      pendingJobWorkflowDeletions.set(id, priorCount - 1);
    }
  }
  if (changed) publishDeletionLifecycleChange();
}

export function isJobWorkflowDeletionPending(nodeId) {
  return !!nodeId && pendingJobWorkflowDeletions.has(nodeId);
}
