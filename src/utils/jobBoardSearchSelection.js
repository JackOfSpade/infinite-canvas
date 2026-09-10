import { combineSignature, moduleCombineFingerprint } from '../nodes/jobboard/mergeJobs.js';

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
    const boardCancellationOwnsSearch = board.data?.boardCancellation?.sourceId === searchId
      && typeof board.data.boardCancellation.boardRunId === 'string'
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
        (plan.phase === 'searches' && plan.activeSourceId === searchId)
        || plan.cancellationCleanup?.sourceId === searchId
      );
    if (!connected && !ownsDisconnectedCleanup && !boardCancellationOwnsSearch) return [];
    const selectedBySearchPlan = plan?.phase === 'searches'
      && Array.isArray(plan.selectedSearchModuleIds)
      && plan.selectedSearchModuleIds.includes(searchId);
    const ownsActiveSearch = (selectedBySearchPlan || ownsDisconnectedCleanup)
      && plan.activeSourceId === searchId;
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
        startedAt: Number.isFinite(Number(plan.startedAt)) ? Number(plan.startedAt) : null,
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
        startedAt: Number.isFinite(Number(cancellation.startedAt))
          ? Number(cancellation.startedAt)
          : null,
        canvasIndex,
        ownsChildManualRecovery: true,
      }];
    }

    // A standalone "Combine saved" has no boardScanResume, but its durable
    // manual-AI marker now carries the exact completed Search generations that
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
    const manualStartedAt = Number.isFinite(Number(manualCombine.startedAt))
      ? Number(manualCombine.startedAt)
      // Backward-compatible fallback for canvases saved before immutable
      // combine admission timestamps were persisted.
      : (Number.isFinite(Number(manualCombine.updatedAt)) ? Number(manualCombine.updatedAt) : null);
    return [{
      orchestratorNodeId: board.id,
      boardRunId: manualCombine.runId,
      startedAt: manualStartedAt,
      canvasIndex,
      ownsChildManualRecovery: false,
    }];
  });
  candidates.sort((left, right) => {
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
    ownsChildManualRecovery: _ownsChildManualRecovery,
    ...owner
  } = candidates[0];
  return owner;
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

  return provenanceRemappedClones.map((clone) => {
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
          let signatureChanged = false;
          const priorCombineSignature = originalClearProvenance.priorCombineSignature
            .split('|')
            .filter(Boolean)
            .map((row) => {
              const separator = row.lastIndexOf('=');
              if (separator < 0) return row;
              const originalSourceId = row.slice(0, separator);
              const sourceId = copiedOwnerId(originalSourceId, 'jobhub');
              if (!sourceId) return row;
              signatureChanged = true;
              // This is a historical pre-clear fingerprint, not a statement
              // about the copied Search's current data. Translate only its id.
              return `${sourceId}=${row.slice(separator + 1)}`;
            })
            .sort()
            .join('|');
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
      const copiedResultCardCount = originalNodes.filter((node) => (
        node?.type === 'jobcard'
        && node.data?.hubId === original.id
        && copiedOwnerId(node.id, 'jobcard')
      )).length;
      const copiedCompleteCascade = Number.isFinite(expectedResultCount)
        && expectedResultCount >= 0
        && copiedResultCardCount === expectedResultCount;
      if (copiedCompleteCascade && typeof original.data?.combineSignature === 'string') {
        const signatureModules = original.data.combineSignature
          .split('|')
          .filter(Boolean)
          .map((row) => {
            const separator = row.lastIndexOf('=');
            if (separator < 0) return { id: row, fingerprint: '' };
            const originalSourceId = row.slice(0, separator);
            const originalFingerprint = row.slice(separator + 1);
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

      const selection = original.data?.selectedSearchModuleIds;
      if (Array.isArray(selection)) {
        // An explicit scan-none choice contains no connection ids and is safe
        // to retain when the Board is copied alone. A nonempty allow-list is
        // connection-specific: with no copied connected Search, keep
        // cloneNode's missing/default-all state for future connections.
        const copiedConnectedSearchIds = getConnectedJobSearchIds(
          original.id,
          originalNodes,
          originalEdges,
        ).filter(searchId => oldIdToNewId.has(searchId));
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
    }

    return remappedData === clone.data ? clone : { ...clone, data: remappedData };
  });
}

// Compatibility name for callers that only need the Board-selection behavior.
export const remapCopiedJobBoardSelections = remapCopiedJobModuleReferences;
