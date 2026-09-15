import { TRANSIENT_PROCESSING_HUB_STATES } from './persistenceTransientState.js';

// External-lifecycle data must not participate in undo. It is stripped from
// fingerprints and merged from the live nodes on restore so Undo cannot revive
// a retired provider request, queue lease, Board transaction, rollback fence,
// reminder clock, or legacy marketplace status check.
const MARKETPLACE_STATUS_FIELDS = [
  'status',
  'statusMessage',
  'lastChecked',
  'attention',
  'lastCheckTrace',
  'lastPriceDropAt',
  'priceDropReminderDue',
];

const JOB_BOARD_RUN_FIELDS = [
  'boardScanResume',
  'boardCancellation',
  'manualAiResume',
  'manualAiCleanupReceipts',
  'queuedModuleRun',
];

const JOB_SEARCH_RUN_FIELDS = [
  'manualAiResume',
  'manualAiCleanupReceipts',
  'terminalFinalizationRecovery',
  'queuedModuleRun',
  '_boardRollbackSourceProgressFence',
];

const JOB_SOURCE_RUN_FIELDS = [
  '_boardRollbackProgressRestore',
  'persistedProgress',
];

const ACTIVE_JOB_SEARCH_STATES = new Set([
  'queued',
  'parsing',
  'interpreting-preferences',
  'querying',
  'searching',
  'evaluating-preferences',
  'scoring',
]);

// These are the only Job Search data fields whose previous value is safe and
// meaningful to apply during Undo. Everything else can be coupled to an
// external scrape/scoring worker, durable sidecar, or the atomic result that a
// Board cancellation restores. Using a small positive allow-list also keeps a
// newly added run field from silently becoming undo-restorable by default.
const JOB_SEARCH_UNDOABLE_SETTING_FIELDS = [
  'targetRole',
  'jobPreferences',
  'searchLocation',
  'preferredLocation',
  'remoteResidences',
  'maxAgeDays',
  'collectionLimits',
  'enabledSourceIds',
  'locked',
];

// FIX 11: once the two-pass role resolver has locked a Search Brief hub,
// JobSearchNode.jsx freezes all seven Search Brief settings (search brief,
// location, remote residences, look-back window, collection limits,
// platforms) — but 'locked' here is a DIFFERENT, unrelated field: the
// generic canvas-wide "Lock Node" toggle (see useCanvasContextMenu.js),
// which stays ordinarily undo-restorable regardless of role-lock state.
const JOB_SEARCH_FROZEN_SETTING_FIELDS = new Set(
  JOB_SEARCH_UNDOABLE_SETTING_FIELDS.filter(field => field !== 'locked'),
);

// Mirrors JobSearchNode.jsx's hasResolvedRoleLock exactly (resolvedRolesMeta
// truthy is the one sentinel that is true iff a resolution ran, even for a
// legitimate zero-title lock — see that function's header comment). Kept as
// a local duplicate rather than an import: this is a shared, provider-
// agnostic undo utility, and importing the multi-thousand-line node
// component here would be a needless, fragile coupling for a two-line check.
function hasResolvedRoleLock(source) {
  return !!(source && typeof source === 'object'
    && source.resolvedRolesMeta && typeof source.resolvedRolesMeta === 'object');
}

function hasExternallyOwnedJobSearchState(data) {
  if (!data || typeof data !== 'object') return false;
  return ACTIVE_JOB_SEARCH_STATES.has(data.hubState)
    || data.hubState === 'sources-ready'
    || data.manualAiResume
    || (Array.isArray(data.manualAiCleanupReceipts) && data.manualAiCleanupReceipts.length > 0)
    || data.terminalFinalizationRecovery
    || data.queuedModuleRun
    || data.pendingJobs
    || data.pendingTargetRole
    || data.pendingCareerData
    || data.pendingJobPreferences
    || data.pendingJobPreferencePlan
    || data.pendingJobPreferencesInterpretation;
}

// A SellHub mid photo-analysis/comp-research is externally owned the same way
// a Job Search run is: `hubState` is one of the shared transient-processing
// states while a worker is between phases, and `queuedModuleRun`/
// `platformFitPending` mark a request already handed to (or awaiting) a
// backend call. Without this, ordinary navigation could unmount a SellHub
// mid-run and silently discard its result — a standing bug independent of
// absorption, not only a nested-canvas concern.
//
// `platformFitPending` is load-bearing rather than redundant: the second,
// post-pricing fit assessment runs while hubState is already the TERMINAL
// 'priced', so it is the only marker covering that window. Its failure mode is
// bounded — every success/failure/reset path clears it, and it is a
// SELLHUB_TRANSIENT_KEY, so a reload strips it even if a pathological unmount
// left it set. It can therefore never durably wedge navigation or Undo.
function hasExternallyOwnedSellHubState(data) {
  if (!data || typeof data !== 'object') return false;
  return TRANSIENT_PROCESSING_HUB_STATES.includes(data.hubState)
    || !!data.queuedModuleRun
    || !!data.platformFitPending;
}

export function hasActiveExternalRunState(nodes, { recursive = true } = {}) {
  if (!Array.isArray(nodes)) return false;
  return nodes.some((node) => {
    const data = node?.data || {};
    if (node?.type === 'jobboard' && (
      data.boardScanResume
      || data.boardCancellation
      || data.manualAiResume
      || (Array.isArray(data.manualAiCleanupReceipts) && data.manualAiCleanupReceipts.length > 0)
      || data.queuedModuleRun
    )) return true;
    if (node?.type === 'jobhub' && hasExternallyOwnedJobSearchState(data)) return true;
    if (node?.type === 'sellhub' && hasExternallyOwnedSellHubState(data)) return true;
    // marketplacestatus is deliberately NOT guarded here: it has no unmount
    // cleanup and keeps its in-flight scan in a module-level store (not node
    // data), precisely so an unmount/remount (navigation, or absorption) is
    // safe without a run guard.
    return recursive && hasActiveExternalRunState(data.canvasData?.nodes, { recursive: true });
  });
}

function nonRestorableFields(node) {
  if (node?.type === 'marketplacecard') return MARKETPLACE_STATUS_FIELDS;
  if (node?.type === 'jobboard') return JOB_BOARD_RUN_FIELDS;
  if (node?.type === 'jobhub') return JOB_SEARCH_RUN_FIELDS;
  if (node?.type === 'jobsourcecard') return JOB_SOURCE_RUN_FIELDS;
  return null;
}

function pickNonRestorableData(node) {
  const fields = nonRestorableFields(node);
  if (!fields) return null;
  const nodeData = node?.data || {};
  const picked = {
    fields,
    values: {},
    ...(node?.type === 'jobhub' ? { completeData: nodeData } : {}),
  };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(nodeData, field)) {
      picked.values[field] = nodeData[field];
    }
  }
  // Store an entry even when every field is absent. Absence in the live node is
  // authoritative: Undo must delete a marker found only in the old snapshot.
  return picked;
}

export function stripNonRestorableNodeDataForUndo(node) {
  if (node?.type === 'jobhub') {
    const source = node.data || {};
    const settings = {};
    for (const field of JOB_SEARCH_UNDOABLE_SETTING_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(source, field)) settings[field] = source[field];
    }
    return settings;
  }
  const fields = nonRestorableFields(node);
  if (!fields || !node?.data) return node?.data;

  let changed = false;
  const data = { ...node.data };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      delete data[field];
      changed = true;
    }
  }
  return changed ? data : node.data;
}

function collectNonRestorableData(nodes, byId) {
  if (!Array.isArray(nodes)) return;

  for (const node of nodes) {
    const picked = pickNonRestorableData(node);
    if (picked && node.id) byId.set(node.id, picked);
    collectNonRestorableData(node?.data?.canvasData?.nodes, byId);
  }
}

function mergeNonRestorableData(nodes, byId) {
  if (!Array.isArray(nodes)) return nodes;

  let changed = false;
  const nextNodes = nodes.map((node) => {
    let nextNode = node;
    const liveData = node?.id ? byId.get(node.id) : null;
    const fields = liveData?.fields || nonRestorableFields(node);
    const restoredActiveJobSearch = node?.type === 'jobhub'
      && hasExternallyOwnedJobSearchState(node.data);

    if (node?.type === 'jobhub' && liveData?.completeData) {
      // The live Search owns the entire run/result/career identity atomically.
      // Overlay only settings the user can legitimately undo. This covers not
      // just visibly processing states, but a retired `sources-ready` snapshot
      // whose pending tuple must never be resurrected after Solve/Skip.
      const mergedData = { ...liveData.completeData };
      // FIX 11: make the settings freeze atomic with the role lock. Once
      // resolvedRoles/searchBriefPlan/resolvedRolesMeta are locked, those
      // three fields are already excluded from this allow-list (never
      // undo-restorable), but the seven settings they were DERIVED FROM
      // were still being overlaid from the pre-lock undo snapshot on every
      // pass through here. That desynced the visible settings (reverted)
      // from the durable lock (unchanged) while the UI stayed frozen and
      // gave the user no way to reconcile the two. Skip the overlay for the
      // frozen subset once locked; 'locked' itself (the unrelated canvas
      // Lock Node toggle) stays undo-restorable either way.
      const roleLockEngaged = hasResolvedRoleLock(liveData.completeData);
      for (const field of JOB_SEARCH_UNDOABLE_SETTING_FIELDS) {
        if (roleLockEngaged && JOB_SEARCH_FROZEN_SETTING_FIELDS.has(field)) continue;
        delete mergedData[field];
        if (Object.prototype.hasOwnProperty.call(node.data || {}, field)) {
          mergedData[field] = node.data[field];
        }
      }
      nextNode = { ...nextNode, data: mergedData };
      changed = true;
    } else if (node?.type === 'jobsourcecard' && liveData) {
      // Source progress and rollback fencing are backend-owned. Preserve the
      // live card payload while still allowing Undo to restore its position.
      const mergedData = { ...(nextNode.data || {}) };
      for (const field of JOB_SOURCE_RUN_FIELDS) delete mergedData[field];
      Object.assign(mergedData, liveData.values);
      nextNode = { ...nextNode, data: mergedData };
      changed = true;
    } else if (fields) {
      const mergedData = { ...(nextNode.data || {}) };
      for (const field of fields) delete mergedData[field];
      if (liveData) Object.assign(mergedData, liveData.values);
      if (restoredActiveJobSearch) {
        // The node itself was deleted, so there is no live worker to preserve.
        // Reintroducing it through Undo must be inert and provenance-safe. We
        // cannot reconstruct the pre-run score/run pairing without a live
        // rollback snapshot, so retain setup/settings but clear run results.
        mergedData.hubState = 'empty';
        mergedData.scoredJobs = null;
        mergedData.finalSourceCounts = {};
        mergedData.resultCount = 0;
        mergedData.totalScoredCount = 0;
        mergedData.scrapedCount = 0;
        mergedData.gatheredCount = 0;
        mergedData.jobCount = null;
        mergedData.scoreThreshold = 0;
        mergedData.jobRunId = null;
        mergedData.resultDisposition = null;
        mergedData.pendingJobs = null;
        mergedData.pendingTargetRole = null;
        mergedData.pendingCareerData = null;
        mergedData.pendingJobPreferences = null;
        mergedData.pendingJobPreferencePlan = null;
        mergedData.pendingJobPreferencesInterpretation = null;
      }
      nextNode = {
        ...nextNode,
        data: mergedData,
      };
      changed = true;
    }

    if (nextNode?.data?.canvasData?.nodes) {
      const childNodes = mergeNonRestorableData(nextNode.data.canvasData.nodes, byId);
      if (childNodes !== nextNode.data.canvasData.nodes) {
        nextNode = {
          ...nextNode,
          data: {
            ...nextNode.data,
            canvasData: {
              ...nextNode.data.canvasData,
              nodes: childNodes,
            },
          },
        };
        changed = true;
      }
    }

    return nextNode;
  });

  return changed ? nextNodes : nodes;
}

export function mergeNonRestorableNodeDataFromLive(restoredNodes, liveNodes) {
  const liveById = new Map();
  collectNonRestorableData(liveNodes, liveById);
  const merged = mergeNonRestorableData(restoredNodes, liveById);
  return reconcileJobSearchSourceTopology(merged, liveNodes, restoredNodes);
}

/** Preserve structural edges incident to live Job Search source cards. */
export function mergeNonRestorableEdgesFromLive(restoredEdges, liveEdges, restoredNodes, liveNodes = []) {
  const nodeIds = new Set((Array.isArray(restoredNodes) ? restoredNodes : []).map(node => node?.id));
  const liveHubIds = new Set(
    (Array.isArray(liveNodes) ? liveNodes : [])
      .filter(node => node?.type === 'jobhub' && nodeIds.has(node.id))
      .map(node => node.id),
  );
  const liveSourceCardIds = new Set(
    (Array.isArray(liveNodes) ? liveNodes : [])
      .filter(node => node?.type === 'jobsourcecard' && liveHubIds.has(node.data?.hubId))
      .map(node => node.id),
  );
  const target = (Array.isArray(restoredEdges) ? restoredEdges : []).filter(edge => (
    nodeIds.has(edge?.source)
    && nodeIds.has(edge?.target)
    && !liveSourceCardIds.has(edge?.source)
    && !liveSourceCardIds.has(edge?.target)
  ));
  const ids = new Set(target.map(edge => edge.id));
  for (const edge of Array.isArray(liveEdges) ? liveEdges : []) {
    if (!nodeIds.has(edge?.source) || !nodeIds.has(edge?.target)) continue;
    if (!liveSourceCardIds.has(edge.source) && !liveSourceCardIds.has(edge.target)) continue;
    if (ids.has(edge.id)) continue;
    target.push(edge);
    ids.add(edge.id);
  }
  return target;
}

function reconcileJobSearchSourceTopology(mergedNodes, liveNodes, originalRestoredNodes) {
  const mergedList = Array.isArray(mergedNodes) ? mergedNodes : [];
  const liveList = Array.isArray(liveNodes) ? liveNodes : [];
  const originalList = Array.isArray(originalRestoredNodes) ? originalRestoredNodes : [];
  const liveById = new Map(liveList.map(node => [node?.id, node]));
  const originalById = new Map(originalList.map(node => [node?.id, node]));

  // First recurse so nested canvases receive the same run/topology isolation.
  const recursivelyMerged = mergedList.map((node) => {
    if (node?.type !== 'group' || !node.data?.canvasData) return node;
    const liveGroup = liveById.get(node.id);
    const originalGroup = originalById.get(node.id);
    const childNodes = reconcileJobSearchSourceTopology(
      node.data.canvasData.nodes,
      liveGroup?.data?.canvasData?.nodes,
      originalGroup?.data?.canvasData?.nodes,
    );
    const childEdges = mergeNonRestorableEdgesFromLive(
      node.data.canvasData.edges,
      liveGroup?.data?.canvasData?.edges,
      childNodes,
      liveGroup?.data?.canvasData?.nodes,
    );
    if (
      childNodes === node.data.canvasData.nodes
      && childEdges === node.data.canvasData.edges
    ) return node;
    return {
      ...node,
      data: {
        ...node.data,
        canvasData: {
          ...node.data.canvasData,
          nodes: childNodes,
          edges: childEdges,
        },
      },
    };
  });

  // Source-card membership is part of a Search's external transaction, not an
  // undoable canvas edit. For every live Search, keep exactly its live card
  // ids; matching target cards retain their historical position, newly-live
  // cards are appended, and retired cards are never resurrected.
  const restoredHubIds = new Set(
    recursivelyMerged.filter(node => node?.type === 'jobhub').map(node => node.id),
  );
  const liveHubIds = new Set(
    liveList
      .filter(node => node?.type === 'jobhub' && restoredHubIds.has(node.id))
      .map(node => node.id),
  );
  const unsafeDeletedHubIds = new Set(
    originalList
      .filter(node => (
        node?.type === 'jobhub'
        && !liveHubIds.has(node.id)
        && hasExternallyOwnedJobSearchState(node.data)
      ))
      .map(node => node.id),
  );
  const liveCards = liveList.filter(
    node => node?.type === 'jobsourcecard' && liveHubIds.has(node.data?.hubId),
  );
  const liveCardById = new Map(liveCards.map(node => [node.id, node]));
  const output = [];
  const included = new Set();
  for (const node of recursivelyMerged) {
    if (node?.type === 'jobsourcecard' && liveHubIds.has(node.data?.hubId)) {
      if (!liveCardById.has(node.id)) continue;
      included.add(node.id);
    } else if (node?.type === 'jobsourcecard' && unsafeDeletedHubIds.has(node.data?.hubId)) {
      // Undoing deletion of an interrupted/paused legacy Search must not also
      // recreate source controls for a worker that no longer exists.
      continue;
    }
    output.push(node);
  }
  for (const liveCard of liveCards) {
    if (included.has(liveCard.id)) continue;
    output.push(liveCard);
  }
  return output;
}
