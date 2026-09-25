import { combineSignature, moduleCombineFingerprint, parseCombineSignature } from '../nodes/jobboard/mergeJobs.js';

// `Date.now()` is not an ordering primitive: two Board clicks can share its
// millisecond. Keep a process-local high-water mark while also writing the
// allocated value into the durable plan, so reload arbitration preserves the
// same click/admission order rather than falling back to canvas layout order.
let nextBoardAdmissionOrder = 1;

export function normalizeJobBoardAdmissionOrder(value) {
  // This sequence is durable transaction authority, not a display number.
  // Reject coercible JSON shapes such as `true` and `[1]`: Number() would turn
  // them into a plausible order and let malformed persistence reorder recovery
  // or advance the high-water mark. Numeric strings remain compatible with
  // older serialized canvases, but blank strings are not an order.
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const order = Number(value);
  return Number.isSafeInteger(order) && order > 0 ? order : null;
}

// Persisted orchestration data is user-controlled canvas JSON. In particular,
// `Number(null)` and `Number('')` are zero, not real timestamps. Keep invalid
// values out of recovery ordering instead of letting a malformed plan become
// the oldest possible transaction.
export function normalizeJobBoardRecoveryTimestamp(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

export function allocateJobBoardAdmissionOrder(nodes) {
  const allNodes = Array.isArray(nodes)
    ? nodes
    : (nodes && typeof nodes.values === 'function' ? [...nodes.values()] : []);
  let highestPersistedOrder = 0;
  for (const node of allNodes) {
    if (node?.type !== 'jobboard') continue;
    // A cancellation receipt can be the only surviving part of a just-ended
    // plan (for example while exact child cleanup is still in flight). It
    // retains the same ownership sequence and must advance the high-water
    // mark too; otherwise a reload could give a new Board a smaller number
    // and let it jump ahead of that still-reserved Search.
    for (const value of [
      node.data?.boardScanResume?.admissionOrder,
      node.data?.boardCancellation?.admissionOrder,
    ]) {
      const order = normalizeJobBoardAdmissionOrder(value);
      if (order != null) highestPersistedOrder = Math.max(highestPersistedOrder, order);
    }
  }
  const allocated = Math.max(nextBoardAdmissionOrder, highestPersistedOrder + 1);
  nextBoardAdmissionOrder = allocated + 1;
  return allocated;
}

function uniqueStringIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter(id => typeof id === 'string' && id))];
}

/**
 * Whether a Job Search is connected to at least one live Job Board.
 *
 * `nodes` accepts either React Flow's node array or its nodeLookup Map so the
 * same policy can back both imperative click guards and a reactive selector.
 * Edge direction is deliberately ignored because the canvas uses loose
 * connections for modules.
 */
export function isJobSearchConnectedToBoard(searchId, nodes, edges) {
  if (typeof searchId !== 'string' || !searchId) return false;
  const nodeForId = nodes && typeof nodes.get === 'function'
    ? nodeId => nodes.get(nodeId)
    : nodeId => (Array.isArray(nodes) ? nodes.find(node => node?.id === nodeId) : null);
  if (nodeForId(searchId)?.type !== 'jobhub') return false;

  return (Array.isArray(edges) ? edges : []).some((edge) => {
    const connectedId = edge?.source === searchId
      ? edge.target
      : edge?.target === searchId
        ? edge.source
        : null;
    return connectedId !== searchId && nodeForId(connectedId)?.type === 'jobboard';
  });
}

/**
 * Find the one durable Board transaction that owns a Search's pending manual
 * step. This prevents a second Board (or standalone auto-resume) from adopting
 * the same saved handoff after reload merely because it shares the Search.
 */
function activeBoardRecoveryCandidates(searchId, nodes, edges) {
  if (typeof searchId !== 'string' || !searchId) return { search: null, candidates: [] };
  const allNodes = Array.isArray(nodes)
    ? nodes
    : (nodes && typeof nodes.values === 'function' ? [...nodes.values()] : []);
  const nodeById = new Map(allNodes.map(node => [node?.id, node]));
  const search = nodeById.get(searchId);
  if (search?.type !== 'jobhub') return { search: null, candidates: [] };

  const connectedBoardIds = new Set();
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (edge?.source === searchId) connectedBoardIds.add(edge.target);
    else if (edge?.target === searchId) connectedBoardIds.add(edge.source);
  }

  const candidates = allNodes.flatMap((board, canvasIndex) => {
    if (board?.type !== 'jobboard') return [];
    const plan = board.data?.boardScanResume;
    const connected = connectedBoardIds.has(board.id);
    const boardCancellationOwnsSearch = (
      board.data?.boardCancellation?.sourceId === searchId
      || (Array.isArray(board.data?.boardCancellation?.sourceIds)
        && board.data.boardCancellation.sourceIds.includes(searchId))
    ) && typeof board.data?.boardCancellation?.boardRunId === 'string'
      && !!board.data.boardCancellation.boardRunId;
    // Disconnect is itself an asynchronous ownership transition. Keep an
    // active/cleanup plan in the election until exact child retirement has
    // settled, even though its edge was intentionally removed. Otherwise a
    // second connected Board can take the lane and have its newer ledger
    // mistaken for the disconnected Board's run by the later cleanup barrier.
    const ownsDisconnectedCleanup = !connected
      && plan?.version === 1
      && typeof plan.boardRunId === 'string'
      && !!plan.boardRunId
      && (
        (plan.phase === 'searches' && (
          plan.activeSourceId === searchId
          || (Array.isArray(plan.activeSourceIds) && plan.activeSourceIds.includes(searchId))
        ))
        || plan.cancellationCleanup?.sourceId === searchId
      );
    if (!connected && !ownsDisconnectedCleanup && !boardCancellationOwnsSearch) return [];
    const selectedBySearchPlan = plan?.phase === 'searches'
      && Array.isArray(plan.selectedSearchModuleIds)
      && plan.selectedSearchModuleIds.includes(searchId);
    const activeSourceIds = Array.isArray(plan?.activeSourceIds)
      ? plan.activeSourceIds.filter(sourceId => typeof sourceId === 'string' && sourceId)
      : [];
    const ownsActiveSearch = (selectedBySearchPlan || ownsDisconnectedCleanup)
      && (plan.activeSourceId === searchId || activeSourceIds.includes(searchId));
    const ownsCancellationCleanup = plan?.cancellationCleanup?.sourceId === searchId;
    // Completed children are frozen inputs of the same still-open transaction.
    // Reserve them too: another Board must not rerun one between a crash and the
    // original Board's eventual Combine merely because it is no longer `active`.
    const ownsCompletedSearch = selectedBySearchPlan
      && Object.hasOwn(plan.completedSourceRuns || {}, searchId);
    const ownsCombineInput = plan?.phase === 'combine' && (
      (Array.isArray(plan.combineSourceRuns)
        && plan.combineSourceRuns.some(entry => entry?.sourceId === searchId))
      || Object.hasOwn(plan.completedSourceRuns || {}, searchId)
    );
    const planOwnsSearch = plan?.version === 1
      && typeof plan.boardRunId === 'string'
      && !!plan.boardRunId
      // A persisted scan waiting for its first outer-lane turn already owns its
      // full selected set. Reserving only active/completed children lets reload
      // mount order invert durable FIFO and makes a newer Board rerun the same
      // shared Search before the older transaction reacquires its turn.
      && (selectedBySearchPlan || ownsActiveSearch || ownsCancellationCleanup || ownsCompletedSearch || ownsCombineInput);
    if (planOwnsSearch) {
      return [{
        orchestratorNodeId: board.id,
        boardRunId: plan.boardRunId,
        startedAt: normalizeJobBoardRecoveryTimestamp(plan.startedAt),
        admissionOrder: normalizeJobBoardAdmissionOrder(plan.admissionOrder),
        canvasIndex,
        // A searches-phase plan reserves every selected Search from competing
        // Board reruns, but only the active child (or its exact cancellation
        // cleanup) can own that Search's manual-AI handoff. Treating a merely
        // queued selection as the marker owner can steal a standalone late
        // append/re-analysis prompt after reload.
        ownsChildManualRecovery: ownsActiveSearch
          || ownsCancellationCleanup
          || boardCancellationOwnsSearch,
      }];
    }

    if (boardCancellationOwnsSearch) {
      const cancellation = board.data.boardCancellation;
      return [{
        orchestratorNodeId: board.id,
        boardRunId: cancellation.boardRunId,
        startedAt: normalizeJobBoardRecoveryTimestamp(cancellation.startedAt),
        admissionOrder: normalizeJobBoardAdmissionOrder(cancellation.admissionOrder),
        canvasIndex,
        ownsChildManualRecovery: true,
      }];
    }

    // A standalone/recovered Combine has no boardScanResume, but its durable
    // manual-AI marker carries the exact completed Search generations that
    // produced the pending prompt. Reserve those shared inputs too: otherwise a
    // second Board can rerun one while the first Board is recovering, wasting
    // valid manual work and forcing the exact signature fence to supersede it.
    const manualCombine = connected ? board.data?.manualAiResume : null;
    const ownsStandaloneCombineInput = typeof manualCombine?.runId === 'string'
      && !!manualCombine.runId
      // Cleanup-only markers can no longer consume or publish Search inputs.
      // Keeping their old signature as a reservation would let an unrelated
      // backend-retirement outage freeze every Board sharing those Searches
      // even though this Board's result is already committed/superseded.
      && manualCombine.retirementPending !== true
      && Array.isArray(manualCombine.combineSourceRuns)
      && manualCombine.combineSourceRuns.some(entry => entry?.sourceId === searchId);
    if (!ownsStandaloneCombineInput) return [];
    const manualStartedAt = normalizeJobBoardRecoveryTimestamp(manualCombine.startedAt)
      // Backward-compatible fallback for canvases saved before immutable
      // combine admission timestamps were persisted.
      ?? normalizeJobBoardRecoveryTimestamp(manualCombine.updatedAt);
    return [{
      orchestratorNodeId: board.id,
      boardRunId: manualCombine.runId,
      startedAt: manualStartedAt,
      admissionOrder: null,
      canvasIndex,
      ownsChildManualRecovery: false,
    }];
  });
  candidates.sort((left, right) => {
    // Compare the durable admission sequence only when both plans carry it.
    // Mixed upgraded/legacy canvases retain their historical timestamp and
    // canvas-order behavior until every competing plan has a real sequence.
    if (
      left.admissionOrder != null
      && right.admissionOrder != null
      && left.admissionOrder !== right.admissionOrder
    ) {
      return left.admissionOrder - right.admissionOrder;
    }
    // Valid durable times rank ahead of malformed/missing legacy timestamps.
    // Otherwise a canvas-index tie-break could let `startedAt: null` (coerced
    // from hand-edited persistence) jump in front of a real transaction.
    if (left.startedAt != null && right.startedAt == null) return -1;
    if (left.startedAt == null && right.startedAt != null) return 1;
    if (left.startedAt != null && right.startedAt != null && left.startedAt !== right.startedAt) {
      return left.startedAt - right.startedAt;
    }
    if (left.startedAt != null && right.startedAt == null) return -1;
    if (left.startedAt == null && right.startedAt != null) return 1;
    return left.canvasIndex - right.canvasIndex;
  });
  return { search, candidates };
}

/**
 * Reserve a Search for the connected Board whose durable plan was interrupted
 * while that exact child was active, including query/scrape phases that have no
 * manual-AI marker yet.
 */
export function findJobSearchBoardActiveRecoveryOwner(searchId, nodes, edges) {
  const { candidates } = activeBoardRecoveryCandidates(searchId, nodes, edges);
  if (candidates.length === 0) return null;
  const {
    canvasIndex: _canvasIndex,
    startedAt: _startedAt,
    admissionOrder: _admissionOrder,
    ownsChildManualRecovery: _ownsChildManualRecovery,
    ...owner
  } = candidates[0];
  return owner;
}

/**
 * A Board keeps its transaction receipt while its active Search is paused at a
 * source-card solve/skip gate. The receipt still reserves that Search from
 * other Boards, but the *exact* paused Search needs to finish its already-
 * collected generation when the user resolves its sources. This is deliberately
 * narrower than `findJobSearchBoardActiveRecoveryOwner`: callers may use it
 * only for the paused Search continuation, never to admit a new search run.
 */
export function findJobSearchBoardPausedContinuationOwner(
  searchId,
  jobRunId,
  nodes,
  edges,
  { allowLocked = false } = {},
) {
  if (typeof jobRunId !== 'string' || !jobRunId) return null;
  const owner = findJobSearchBoardActiveRecoveryOwner(searchId, nodes, edges);
  if (!owner) return null;
  const allNodes = Array.isArray(nodes)
    ? nodes
    : (nodes && typeof nodes.values === 'function' ? [...nodes.values()] : []);
  const board = allNodes.find(node => node?.id === owner.orchestratorNodeId);
  const plan = board?.data?.boardScanResume;
  const awaiting = plan?.awaitingSourceResolution;
  const search = allNodes.find(node => node?.id === searchId);
  // A paused source continuation is a narrow handoff inside a searches-phase
  // Board plan. A Board-level manual prompt or cleanup receipt is incompatible
  // with that phase; if a torn save contains both, fail closed rather than let
  // a source-card action race a different Board-owned manual-AI transaction.
  const boardHasManualAiRecovery = typeof board?.data?.manualAiResume?.runId === 'string'
    && !!board.data.manualAiResume.runId;
  const boardHasPendingCleanup = Array.isArray(board?.data?.manualAiCleanupReceipts)
    && board.data.manualAiCleanupReceipts.some(receipt => (
      typeof receipt?.runId === 'string' && !!receipt.runId
    ));
  const connected = (Array.isArray(edges) ? edges : []).some((edge) => (
    (edge?.source === board?.id && edge?.target === searchId)
    || (edge?.target === board?.id && edge?.source === searchId)
  ));
  if (
    plan?.version !== 1
    || plan.phase !== 'searches'
    || plan.boardRunId !== owner.boardRunId
    // A lock blocks continuation controls, but a final source-card removal
    // still has to route through the owning Board's exact cancellation path.
    // Callers retain the conservative default; only lifecycle cleanup opts in.
    || (!allowLocked && board?.data?.locked)
    || board?.data?.boardCancellation
    || boardHasManualAiRecovery
    || boardHasPendingCleanup
    || plan.activeSourceId !== searchId
    || awaiting?.sourceId !== searchId
    || typeof awaiting?.jobRunId !== 'string'
    || !awaiting.jobRunId
    || awaiting.jobRunId !== jobRunId
    || search?.type !== 'jobhub'
    || search.data?.hubState !== 'sources-ready'
    || search.data?.jobRunId !== jobRunId
    || !connected
  ) return null;
  return owner;
}

/**
 * Find the Board that can cancel a source-card gate during the tiny handoff
 * between a child returning `paused` and its parent persisting
 * `awaitingSourceResolution`. It deliberately does not authorize a source
 * continuation: callers may use it only to cancel the exact active Board.
 *
 * Requiring the active rollback receipt makes this narrower than the generic
 * active-owner election. Without that receipt a queued Board has merely
 * reserved the Search and must not inherit a standalone/other-Board warning.
 */
export function findJobSearchBoardCancellablePausedSourceOwner(
  searchId,
  jobRunId,
  nodes,
  edges,
  { allowInFlightContinuation = false } = {},
) {
  // Once the handoff is durable, retain all of the regular paused-continuation
  // proof (including a locked Board, whose card controls are disabled but whose
  // removal still needs exact cancellation).
  const pausedOwner = findJobSearchBoardPausedContinuationOwner(
    searchId,
    jobRunId,
    nodes,
    edges,
    { allowLocked: true },
  );
  if (pausedOwner) return pausedOwner;
  if (typeof searchId !== 'string' || !searchId || typeof jobRunId !== 'string' || !jobRunId) {
    return null;
  }
  const owner = findJobSearchBoardActiveRecoveryOwner(searchId, nodes, edges);
  if (!owner) return null;
  const allNodes = Array.isArray(nodes)
    ? nodes
    : (nodes && typeof nodes.values === 'function' ? [...nodes.values()] : []);
  const board = allNodes.find(node => node?.id === owner.orchestratorNodeId);
  const search = allNodes.find(node => node?.id === searchId);
  const plan = board?.data?.boardScanResume;
  const rollback = plan?.activeSourceRollback;
  const cancellation = board?.data?.boardCancellation;
  const boardHasManualAiRecovery = typeof board?.data?.manualAiResume?.runId === 'string'
    && !!board.data.manualAiResume.runId;
  const boardHasPendingCleanup = Array.isArray(board?.data?.manualAiCleanupReceipts)
    && board.data.manualAiCleanupReceipts.some(receipt => (
      typeof receipt?.runId === 'string' && !!receipt.runId
    ));
  const connected = (Array.isArray(edges) ? edges : []).some((edge) => (
    (edge?.source === board?.id && edge?.target === searchId)
    || (edge?.target === board?.id && edge?.source === searchId)
  ));
  // A successful Solve clears its gating warning before the source resolver
  // releases its shared lane: the same resolver synchronously starts scoring
  // through the exact Board continuation. During that small no-warning window
  // a final card unmount must still cancel the Board transaction—not raw-abort
  // the hub mid-continuation. This wider proof is deliberately opt-in for the
  // card that actually owns a started resolver; ordinary clean siblings keep
  // the gating-warning requirement below and cannot cancel another source.
  const awaiting = plan?.awaitingSourceResolution;
  const exactInFlightAwaitingContinuation = (
    plan?.version === 1
    && plan.phase === 'searches'
    && plan.boardRunId === owner.boardRunId
    && !cancellation
    && !boardHasManualAiRecovery
    && !boardHasPendingCleanup
    && plan.activeSourceId === searchId
    && awaiting?.sourceId === searchId
    && awaiting.jobRunId === jobRunId
    && search?.type === 'jobhub'
    && search.data?.jobRunId === jobRunId
    && connected
  );
  const exactInFlightCancellation = (
    cancellation?.boardRunId === owner.boardRunId
    && cancellation.sourceId === searchId
    && search?.type === 'jobhub'
    && search.data?.jobRunId === jobRunId
    && connected
  );
  if (
    allowInFlightContinuation
    && (exactInFlightAwaitingContinuation || exactInFlightCancellation)
  ) return owner;
  // A Board cancellation is already an exact source-owned transaction. Card
  // removal during the short receipt→child-abort window must join that same
  // coordinator cancellation (which returns busy/retries as appropriate), not
  // fall through to a raw hub abort before the Board reaches its child.
  if (
    exactInFlightCancellation
    && search.data?.hubState === 'sources-ready'
  ) return owner;
  if (
    plan?.version !== 1
    || plan.phase !== 'searches'
    || plan.boardRunId !== owner.boardRunId
    || plan.awaitingSourceResolution != null
    || cancellation
    || boardHasManualAiRecovery
    || boardHasPendingCleanup
    || plan.activeSourceId !== searchId
    || !Array.isArray(plan.selectedSearchModuleIds)
    || !plan.selectedSearchModuleIds.includes(searchId)
    || rollback?.version !== 1
    || rollback.sourceId !== searchId
    || search?.type !== 'jobhub'
    || search.data?.hubState !== 'sources-ready'
    || search.data?.jobRunId !== jobRunId
    || !connected
  ) return null;
  return owner;
}

/**
 * A Board can keep ownership while it is cancelling or while the Search has
 * moved to another generation. In either case a source-card event must not
 * merge rows into the Search or admit its scoring continuation. Standalone
 * Searches have no active owner and remain eligible.
 */
export function isJobSearchBoardPausedContinuationBlocked(searchId, jobRunId, nodes, edges) {
  return !!findJobSearchBoardActiveRecoveryOwner(searchId, nodes, edges)
    && !findJobSearchBoardPausedContinuationOwner(searchId, jobRunId, nodes, edges);
}

export function findJobSearchBoardRecoveryOwner(searchId, manualAiRunId, nodes, edges) {
  if (!manualAiRunId) return null;
  const { search, candidates } = activeBoardRecoveryCandidates(searchId, nodes, edges);
  if (!search || search.data?.manualAiResume?.runId !== manualAiRunId) return null;
  // A standalone Board Combine reserves a completed Search result, but it did
  // not create and must never adopt that Search's own saved manual-AI step.
  const childRecoveryCandidates = candidates.filter(candidate => candidate.ownsChildManualRecovery);
  // New saves carry the owner on the child marker as an additional tie-breaker.
  // Older saves remain deterministic by canvas-node order.
  const marker = search.data.manualAiResume;
  if (childRecoveryCandidates.length === 0) {
    return marker.orchestratorNodeId || marker.boardRunId
      ? {
          orchestratorNodeId: marker.orchestratorNodeId || null,
          boardRunId: marker.boardRunId || null,
          missingPlan: true,
        }
      : null;
  }
  const exactMarkerOwner = childRecoveryCandidates.find(candidate => (
    candidate.orchestratorNodeId === marker.orchestratorNodeId
    && (!marker.boardRunId || candidate.boardRunId === marker.boardRunId)
  ));
  if (exactMarkerOwner) {
    const {
      canvasIndex: _canvasIndex,
      startedAt: _startedAt,
      admissionOrder: _admissionOrder,
      ownsChildManualRecovery: _ownsChildManualRecovery,
      ...owner
    } = exactMarkerOwner;
    return owner;
  }
  if (marker.orchestratorNodeId || marker.boardRunId) {
    // Explicit ownership is fail-closed. A surviving but mismatched plan must
    // not be allowed to adopt another Board's manual handoff after reload.
    return {
      orchestratorNodeId: marker.orchestratorNodeId || null,
      boardRunId: marker.boardRunId || null,
      missingPlan: true,
    };
  }
  const {
    canvasIndex: _canvasIndex,
    startedAt: _startedAt,
    admissionOrder: _admissionOrder,
    ownsChildManualRecovery: _ownsChildManualRecovery,
    ...owner
  } = childRecoveryCandidates[0];
  return owner;
}

/** Return connected Job Search ids in stable canvas-node order. */
export function getConnectedJobSearchIds(boardId, nodes, edges) {
  if (typeof boardId !== 'string' || !boardId) return [];
  const connected = new Set();
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (edge?.source === boardId && edge.target !== boardId) connected.add(edge.target);
    else if (edge?.target === boardId && edge.source !== boardId) connected.add(edge.source);
  }
  return (Array.isArray(nodes) ? nodes : [])
    .filter(node => node?.type === 'jobhub' && connected.has(node.id))
    .map(node => node.id)
    .filter((nodeId, index, ids) => typeof nodeId === 'string' && nodeId && ids.indexOf(nodeId) === index);
}

/**
 * Resolve a board's persisted module allow-list against its live connections.
 * A missing allow-list keeps pre-selection canvases compatible by selecting all
 * connected modules; an explicit empty array deliberately selects none.
 */
export function getSelectedConnectedJobSearchIds(selection, connectedIds) {
  const connected = uniqueStringIds(connectedIds);
  if (!Array.isArray(selection)) return connected;
  const selected = new Set(uniqueStringIds(selection));
  return connected.filter(nodeId => selected.has(nodeId));
}

/**
 * Resolve a Board's optional execution preference against a live set of
 * searches.  The preference intentionally carries no membership meaning:
 * missing, stale, or newly-connected ids simply fall back to the stable canvas
 * order supplied by `ids`.
 */
export function orderJobSearchIds(executionOrder, ids) {
  const available = uniqueStringIds(ids);
  if (!Array.isArray(executionOrder)) return available;
  const availableSet = new Set(available);
  const preferred = uniqueStringIds(executionOrder)
    .filter(nodeId => availableSet.has(nodeId));
  const preferredSet = new Set(preferred);
  return [...preferred, ...available.filter(nodeId => !preferredSet.has(nodeId))];
}

/**
 * Move a connected Search in the visible execution order.  Disconnected ids
 * are retained after the visible order so reconnecting a Search does not lose
 * a user's saved preference, while new connections retain canvas-order
 * fallback until explicitly moved.
 */
export function moveJobSearchExecutionOrder(executionOrder, connectedIds, searchId, direction) {
  const connected = uniqueStringIds(connectedIds);
  if (typeof searchId !== 'string' || !connected.includes(searchId)) return executionOrder;
  const offset = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
  if (!offset) return executionOrder;
  const ordered = orderJobSearchIds(executionOrder, connected);
  const from = ordered.indexOf(searchId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= ordered.length) return executionOrder;
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  const connectedSet = new Set(connected);
  const hidden = Array.isArray(executionOrder)
    ? uniqueStringIds(executionOrder).filter(nodeId => !connectedSet.has(nodeId))
    : [];
  return [...ordered, ...hidden];
}

/**
 * Toggle one live connection and return an explicit allow-list.
 *
 * A disconnected id is hidden from the current selector/run, but remains part
 * of the user's persisted intent in case that exact module is reconnected.
 * Toggling another visible row must not silently erase those hidden choices.
 */
export function toggleSelectedJobSearchId(selection, searchId, connectedIds) {
  const connected = uniqueStringIds(connectedIds);
  if (!connected.includes(searchId)) {
    // Preserve the representation too: turning a missing legacy/default-all
    // selection into an explicit snapshot here would make later connections
    // unexpectedly start unchecked even though this stale action did nothing.
    return Array.isArray(selection) ? uniqueStringIds(selection) : selection;
  }

  const persisted = Array.isArray(selection) ? uniqueStringIds(selection) : connected;
  const connectedSet = new Set(connected);
  const selected = new Set(persisted);
  if (selected.has(searchId)) selected.delete(searchId);
  else selected.add(searchId);
  return [
    ...connected.filter(nodeId => selected.has(nodeId)),
    ...persisted.filter(nodeId => !connectedSet.has(nodeId) && selected.has(nodeId)),
  ];
}

/**
 * Restore node-id references after a batch clone has allocated every new id.
 * `cloneNode` cannot do this itself because it sees only one node at a time.
 *
 * Besides translating a Board's explicit Search allow-list, keep the cloned
 * result/source graph isolated from its originals:
 * - Board-owned job groups/cards point at the copied Board.
 * - Search-owned source cards point at the copied Search.
 * - Job-group childIds contain only copied children and use their copied ids.
 * - A job card's origin Search follows the copied Search when it is present;
 *   otherwise that provenance reference deliberately remains external.
 *
 * Missing Board selection remains missing (legacy/default-all), while an
 * explicit [] remains an explicit scan-none choice.
 */
export function remapCopiedJobModuleReferences(originalNodes, clonedNodes, oldIdToNewId, originalEdges = []) {
  if (!Array.isArray(originalNodes) || !Array.isArray(clonedNodes) || !(oldIdToNewId instanceof Map)) {
    return clonedNodes;
  }

  const originalsById = new Map(
    originalNodes
      .filter(node => typeof node?.id === 'string' && node.id)
      .map(node => [node.id, node]),
  );
  const oldIdByNewId = new Map(
    [...oldIdToNewId.entries()].map(([oldId, newId]) => [newId, oldId]),
  );
  const rawClonesById = new Map(
    clonedNodes
      .filter(node => typeof node?.id === 'string' && node.id)
      .map(node => [node.id, node]),
  );

  // A completed Search can carry explicit origin provenance on its stored rows
  // (legacy/imported rows and prior aggregate inputs do this). Translate those
  // backlinks before rebuilding a copied Board signature; otherwise the copied
  // Search fingerprints differently or a later Re-combine creates cards that
  // still read career data from the original module.
  const provenanceRemappedClones = clonedNodes.map((clone) => {
    const original = originalsById.get(oldIdByNewId.get(clone?.id));
    if (clone?.type !== 'jobhub' || !original) return clone;
    let remappedData = clone.data;
    for (const field of ['scoredJobs', 'preferenceCandidatePool']) {
      if (!Array.isArray(clone.data?.[field])) continue;
      let changed = false;
      const jobs = clone.data[field].map((job) => {
        if (!job || typeof job !== 'object' || typeof job.originHubId !== 'string') return job;
        const copiedOriginId = oldIdToNewId.get(job.originHubId);
        if (
          originalsById.get(job.originHubId)?.type !== 'jobhub'
          || rawClonesById.get(copiedOriginId)?.type !== 'jobhub'
        ) return job;
        changed = true;
        return { ...job, originHubId: copiedOriginId };
      });
      if (changed) remappedData = { ...remappedData, [field]: jobs };
    }
    return remappedData === clone.data ? clone : { ...clone, data: remappedData };
  });
  const clonesById = new Map(
    provenanceRemappedClones
      .filter(node => typeof node?.id === 'string' && node.id)
      .map(node => [node.id, node]),
  );

  const copiedOwnerId = (ownerId, ownerType) => {
    const copiedId = oldIdToNewId.get(ownerId);
    return originalsById.get(ownerId)?.type === ownerType
      && clonesById.get(copiedId)?.type === ownerType
      ? copiedId
      : null;
  };

  const resetBoardCloneIds = new Set();
  const remappedClones = provenanceRemappedClones.map((clone) => {
    const original = originalsById.get(oldIdByNewId.get(clone.id));
    if (!original) return clone;

    let remappedData = clone.data;
    const setDataField = (key, value) => {
      if (remappedData === clone.data) remappedData = { ...(clone.data || {}) };
      remappedData[key] = value;
    };

    const expectedOwnerType = clone.type === 'jobsourcecard'
      ? 'jobhub'
      : (clone.type === 'jobgroup' || clone.type === 'jobcard')
        ? 'jobboard'
        : null;
    if (expectedOwnerType) {
      const ownerId = copiedOwnerId(original.data?.hubId, expectedOwnerType);
      if (ownerId) setDataField('hubId', ownerId);
    }

    if (clone.type === 'jobgroup' && Array.isArray(original.data?.childIds)) {
      const remappedChildIds = uniqueStringIds(original.data.childIds.flatMap((childId) => {
        const child = originalsById.get(childId);
        const copiedChildId = oldIdToNewId.get(childId);
        const copiedChild = clonesById.get(copiedChildId);
        const validType = child?.type === 'jobgroup' || child?.type === 'jobcard';
        return validType && copiedChild?.type === child.type ? [copiedChildId] : [];
      }));
      setDataField('childIds', remappedChildIds);
    }

    if (clone.type === 'jobcard' && typeof original.data?.originHubId === 'string') {
      const originHubId = copiedOwnerId(original.data.originHubId, 'jobhub');
      if (originHubId) setDataField('originHubId', originHubId);
    }

    if (clone.type === 'jobboard') {
      const originalClearProvenance = original.data?.clearProvenance;
      if (originalClearProvenance && typeof originalClearProvenance === 'object'
        && !Array.isArray(originalClearProvenance)) {
        let clearProvenanceChanged = false;
        let clearProvenance = originalClearProvenance;
        if (Array.isArray(originalClearProvenance.priorSourceRuns)) {
          const priorSourceRuns = originalClearProvenance.priorSourceRuns.map((sourceRun) => {
            if (!sourceRun || typeof sourceRun !== 'object') return sourceRun;
            const sourceHubId = copiedOwnerId(sourceRun.sourceHubId, 'jobhub');
            if (!sourceHubId) return sourceRun;
            clearProvenanceChanged = true;
            return { ...sourceRun, sourceHubId };
          });
          if (clearProvenanceChanged) clearProvenance = { ...clearProvenance, priorSourceRuns };
        }
        if (typeof originalClearProvenance.priorCombineSignature === 'string') {
          const parsedPriorSignature = parseCombineSignature(originalClearProvenance.priorCombineSignature);
          let signatureChanged = false;
          const priorCombineSignature = parsedPriorSignature.valid
            ? combineSignature(parsedPriorSignature.entries.map(([originalSourceId, fingerprint]) => {
              const sourceId = copiedOwnerId(originalSourceId, 'jobhub');
              if (!sourceId) return { id: originalSourceId, fingerprint };
              signatureChanged = true;
              // This is a historical pre-clear fingerprint, not a statement
              // about the copied Search's current data. Translate only its id.
              return { id: sourceId, fingerprint };
            }))
            : originalClearProvenance.priorCombineSignature;
          if (signatureChanged) {
            clearProvenanceChanged = true;
            clearProvenance = { ...clearProvenance, priorCombineSignature };
          }
        }
        if (clearProvenanceChanged) setDataField('clearProvenance', clearProvenance);
      }

      if (Array.isArray(original.data?.combineSourceRuns)) {
        const combineSourceRuns = original.data.combineSourceRuns.map((sourceRun) => {
          if (!sourceRun || typeof sourceRun !== 'object') return sourceRun;
          // Completed Boards persist the bounded diagnostic shape
          // `{ sourceHubId, runId }`; phase=combine recovery receipts from older
          // canvases used `{ sourceId, runId, fingerprint }`. Translate whichever
          // explicit identity fields are present without converting one schema
          // into the other (Clear/report readers deliberately distinguish them).
          const sourceHubId = copiedOwnerId(sourceRun.sourceHubId, 'jobhub');
          const legacySourceId = copiedOwnerId(sourceRun.sourceId, 'jobhub');
          if (!sourceHubId && !legacySourceId) return sourceRun;
          const copiedSearchId = sourceHubId || legacySourceId;
          const copiedSearchData = clonesById.get(copiedSearchId)?.data || {};
          return {
            ...sourceRun,
            ...(sourceHubId ? { sourceHubId } : {}),
            ...(legacySourceId ? { sourceId: legacySourceId } : {}),
            ...(Object.hasOwn(sourceRun, 'fingerprint') ? {
              fingerprint: moduleCombineFingerprint(
                copiedSearchData.scoredJobs,
                copiedSearchData.locationSnapshot?.remoteResidences
                  || copiedSearchData.remoteResidences
                  || {},
              ),
            } : {}),
          };
        });
        setDataField('combineSourceRuns', combineSourceRuns);
      }

      const expectedResultCount = Number(original.data?.resultCount);
      const originalResultCardCount = originalNodes.filter((node) => (
        node?.type === 'jobcard' && node.data?.hubId === original.id
      )).length;
      const copiedResultCardCount = originalNodes.filter((node) => (
        node?.type === 'jobcard'
        && node.data?.hubId === original.id
        && copiedOwnerId(node.id, 'jobcard')
      )).length;
      const hasDeclaredResultCount = Number.isFinite(expectedResultCount) && expectedResultCount >= 0;
      const copiedCompleteCascade = hasDeclaredResultCount
        ? copiedResultCardCount === expectedResultCount
        : originalResultCardCount > 0 && copiedResultCardCount === originalResultCardCount;

      // `cloneNode` intentionally preserves a completed Board long enough for
      // this graph-aware pass to rebuild its copied signature/provenance. A
      // normal duplicate, however, often contains only the Board itself: its
      // job groups/cards were not selected. Leaving that clone as “Done · N
      // results” creates an empty, misleading Board with no display cascade.
      // Reset only when a positive original cascade was not copied in full;
      // a complete cluster/group copy (and a truthful zero-result Board) keeps
      // its completed presentation and receives the remapped signature below.
      const originalHadVisibleResults = expectedResultCount > 0 || originalResultCardCount > 0;
      // A legacy Board with neither a declared result count nor result cards
      // cannot prove it was a truthful zero-result completion. Treat it as an
      // empty setup on copy rather than cloning a terminal-looking Board whose
      // visible cascade was never present in this graph level.
      const unverifiedTerminalBoard = original.data?.hubState === 'done'
        && !hasDeclaredResultCount
        && originalResultCardCount === 0;
      if ((originalHadVisibleResults && !copiedCompleteCascade) || unverifiedTerminalBoard) {
        if (remappedData === clone.data) remappedData = { ...(clone.data || {}) };
        remappedData.hubState = 'empty';
        for (const key of [
          'resultCount', 'moduleCount', 'scoreRangeMin', 'scoreRangeMax',
          'scoreThreshold', 'sourceFilter', 'jobTaxonomy', 'finalSourceCounts',
          'mergeStats', 'combineSignature', 'combineSourceRuns', 'stale',
          'staleReason', 'clearProvenance',
        ]) delete remappedData[key];
        resetBoardCloneIds.add(clone.id);
      }
      if (copiedCompleteCascade && typeof original.data?.combineSignature === 'string') {
        const parsedSignature = parseCombineSignature(original.data.combineSignature);
        if (parsedSignature.valid) {
          const signatureModules = parsedSignature.entries.map(([originalSourceId, originalFingerprint]) => {
            const sourceId = copiedOwnerId(originalSourceId, 'jobhub');
            if (!sourceId) return { id: originalSourceId, fingerprint: originalFingerprint };
            // A state:* row describes a Search deliberately excluded from the
            // old cascade. Preserve that state receipt (under the copied id) so
            // clone sanitization/result changes correctly make the Board stale.
            if (!originalFingerprint.startsWith('7:')) {
              return { id: sourceId, fingerprint: originalFingerprint };
            }
            const copiedSearchData = clonesById.get(sourceId)?.data || {};
            return {
              id: sourceId,
              fingerprint: moduleCombineFingerprint(
                copiedSearchData.scoredJobs,
                copiedSearchData.locationSnapshot?.remoteResidences
                  || copiedSearchData.remoteResidences
                  || {},
              ),
            };
          });
          setDataField('combineSignature', combineSignature(signatureModules));
        }
      }

      const selection = original.data?.selectedSearchModuleIds;
      const copiedConnectedSearchIds = getConnectedJobSearchIds(
        original.id,
        originalNodes,
        originalEdges,
      ).filter(searchId => oldIdToNewId.has(searchId));
      if (Array.isArray(selection)) {
        // An explicit scan-none choice contains no connection ids and is safe
        // to retain when the Board is copied alone. A nonempty allow-list is
        // connection-specific: with no copied connected Search, keep
        // cloneNode's missing/default-all state for future connections.
        const remappedSelection = uniqueStringIds(
          selection.map(searchId => copiedOwnerId(searchId, 'jobhub')),
        );
        if (
          selection.length === 0
          || remappedSelection.length > 0
          || copiedConnectedSearchIds.length > 0
        ) {
          // Preserve copied selections even when their edge is temporarily
          // absent. A user may reconnect that copied Search later and expects
          // its durable allow-list intent to survive. Conversely, when only an
          // explicitly unselected connected Search is copied, persist [] so it
          // cannot silently become selected through the default-all fallback.
          setDataField('selectedSearchModuleIds', remappedSelection);
        }
      }

      const executionOrder = original.data?.searchExecutionOrder;
      if (Array.isArray(executionOrder)) {
        const remappedExecutionOrder = uniqueStringIds(
          executionOrder.map(searchId => copiedOwnerId(searchId, 'jobhub')),
        );
        // Unlike selection, an empty execution order has no semantic meaning.
        // Preserve an explicit priority only when this duplicate includes a
        // compatible Search, while retaining hidden copied ids for a later
        // reconnect just as the selection remap does.
        if (remappedExecutionOrder.length > 0 || copiedConnectedSearchIds.length > 0) {
          setDataField('searchExecutionOrder', remappedExecutionOrder);
        }
      }
    }

    return remappedData === clone.data ? clone : { ...clone, data: remappedData };
  });

  // A partial Board cascade is not meaningful on its own: cards/groups point
  // at the reset Board and can otherwise remain visible as orphaned results.
  // Remove only the display descendants owned by a Board normalized above;
  // independent copied Job Cards (whose original Board was not copied) retain
  // their existing standalone-copy behavior.
  if (resetBoardCloneIds.size === 0) return remappedClones;
  return remappedClones.filter((clone) => !(
    (clone?.type === 'jobgroup' || clone?.type === 'jobcard')
    && resetBoardCloneIds.has(clone.data?.hubId)
  ));
}

// Compatibility name for callers that only need the Board-selection behavior.
export const remapCopiedJobBoardSelections = remapCopiedJobModuleReferences;

const JOB_BOARD_SELECTOR_ACTIVE_STATES = new Set([
  'queued', 'parsing', 'interpreting-preferences', 'querying', 'searching',
  'evaluating-preferences', 'scoring',
]);

// This is deliberately a pure boundary between Board admission and its
// selector.  Callers that supplied a computed continuation verdict must not
// have it overwritten by the raw persisted `sources-ready` display state.
export function jobBoardModuleReadiness(module) {
  if (module?.ready === false || module?.canRun === false || module?.runnable === false) {
    return {
      ready: false,
      label: module.readinessLabel || module.statusLabel || 'Needs setup',
      reason: module.readinessReason || module.disabledReason || module.reason || '',
    };
  }
  const state = module?.hubState || module?.status || '';
  if (module?.running || JOB_BOARD_SELECTOR_ACTIVE_STATES.has(state)) {
    return { ready: true, active: true, label: module.statusLabel || 'Searching…', reason: '' };
  }
  if (module?.ready === true || module?.boardAction === 'continue') {
    return {
      ready: true,
      label: module.statusLabel || 'Resume saved search',
      reason: module.readinessReason || module.reason || '',
    };
  }
  if (state === 'sources-ready') {
    return {
      ready: false,
      label: module.statusLabel || 'Needs attention',
      reason: module.readinessReason || module.reason || 'Resolve or skip the blocked source before continuing.',
    };
  }
  if (state === 'done') {
    const count = Number.isFinite(module?.count)
      ? module.count
      : Number.isFinite(module?.resultCount) ? module.resultCount : null;
    return {
      ready: true,
      label: module.statusLabel || (count == null ? 'Ready to search' : `${count} saved job${count === 1 ? '' : 's'}`),
      reason: '',
    };
  }
  return {
    ready: true,
    label: module?.statusLabel || module?.readinessLabel || 'Ready to search',
    reason: module?.readinessReason || '',
  };
}

export function jobBoardSelectionPresentation(selectedModules) {
  const selected = Array.isArray(selectedModules) ? selectedModules : [];
  const freshCount = selected.filter(module => module?.boardAction === 'scan').length;
  const reusableCount = selected.filter(module => module?.boardAction === 'reuse').length;
  const hasContinuation = selected.some(module => (
    module?.boardAction === 'continue'
    || /^(Finish saved search|Resume saved scoring|Resume pending search|Resume saved recovery)$/.test(module?.statusLabel || '')
  ));
  const hasTokenlessPaused = selected.some(module => module?.boardAction === 'continue-blocked');
  const runLabel = freshCount > 0
    ? ((reusableCount > 0 || hasContinuation) ? 'Continue & combine' : 'Search & combine')
    : hasContinuation
      ? 'Resume & combine'
      : reusableCount > 0
        ? 'Combine saved results'
        : 'Search selected & combine';
  const title = freshCount > 0
    ? 'Selected fresh sources will start and selected paused sources will continue. Completed selected sources are reused without another scan; the Board then combines every connected completed result.'
    : hasContinuation
      ? 'Continue the selected Job Search state. Completed results are reused without another scan; the Board then combines every connected completed result.'
      : reusableCount > 0
        ? 'Reuse the selected completed Job Search results without another scan, then combine every connected completed result.'
        : 'Start or continue the selected Job Search state. If a source needs manual attention, resolve it there; this Board resumes and combines every connected completed result automatically.';
  const unreadyMessage = hasTokenlessPaused
    ? 'A selected paused Job Search has no recoverable run token. Resolve it from Job Search, or clear career data, re-import, then start fresh.'
    : 'Finish setting up the selected sources before running this board. Completed searches are reused here; to refresh one, choose Re-scan for New Jobs on its Job Search card, then return to the Board.';
  return { freshCount, reusableCount, hasContinuation, hasTokenlessPaused, runLabel, title, unreadyMessage };
}
