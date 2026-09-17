// Pure helpers for dragging jobhub/jobboard/sellhub module nodes into a
// sub-canvas (React Flow type `group`, rendered by CanvasNode.jsx).
//
// Nested canvasData is never mounted (a group renders an SVG thumbnail), so
// absorbing a module unmounts it — and each module's unmount handler treats
// unmount as "this hub is gone" (Job Search deletes its source cards, Job
// Board aborts the backend run, SellHub deletes its comp/marketplace cards).
// The safety net is therefore three-fold and lives across three files: a
// relocation fence (nodeDeletionLifecycle.js) so cleanups know this is a
// move, a run guard (undoNonRestorableState.js's hasActiveExternalRunState,
// reused below) mirroring the one navigation already uses, and the closure +
// edge/reference honesty implemented here.
//
// No React imports — pure functions only, unit-testable without a renderer.

import { hasActiveExternalRunState } from './undoNonRestorableState.js';

// Only a nested canvas cannot be absorbed into another nested canvas — that is the
// recursion limit the original exclusion comment actually justified. Module nodes
// (jobhub/jobboard/sellhub) are eligible; their safety comes from the run guard and
// the relocation fence, not from a type blacklist.
export const ABSORB_EXCLUDED_TYPES = new Set(['group']);

/**
 * Whether a drag set (the resolved closure, not the raw selection — see
 * `collectAbsorptionClosure`) can be dropped into `targetGroup`. Returns
 * `null` when the move is allowed, else `{ kind: 'reject', label }`.
 *
 * Checks are evaluated in order and the first hit wins, so a locked
 * sub-canvas is reported before anything about the dragged nodes themselves.
 */
export function getAbsorptionRejection(dragSet, targetGroup) {
  if (!targetGroup) return null; // nothing to reject against
  if (targetGroup.data?.locked) {
    return { kind: 'reject', label: 'Sub-canvas is locked' };
  }

  const nodes = Array.isArray(dragSet) ? dragSet : [];
  if (nodes.some(node => node?.data?.locked)) {
    return { kind: 'reject', label: 'Unlock the node first' };
  }
  if (nodes.some(node => ABSORB_EXCLUDED_TYPES.has(node?.type))) {
    return { kind: 'reject', label: 'Sub-canvases can’t nest' };
  }
  // `dragSet` here is already the closure, so a running child blocks the
  // move exactly like a running node dragged directly would.
  if (hasActiveExternalRunState(nodes, { recursive: true })) {
    return { kind: 'reject', label: 'Finish the run first' };
  }
  return null;
}

/**
 * A hub must never move without the children it owns, because leaving them
 * behind is exactly what triggers the unmount-cascade cleanup. Expands
 * `dragSet` into every owned descendant found in `allNodes`, via a fixpoint
 * loop over a `Set` (never unbounded recursion) so cyclic/self-referential
 * `hubId`/`childIds` data cannot hang this.
 *
 * Ownership is downward only — never pull in a node because the set
 * references it via `originHubId`/`selectedSearchModuleIds`. Those are peer
 * references, reported (not absorbed) by `findSeveredRelations`.
 */
export function collectAbsorptionClosure(dragSet, allNodes) {
  const nodes = Array.isArray(allNodes) ? allNodes : [];
  // childId → the jobgroups listing it. Indexed once so the fixpoint pass below
  // is a constant-time lookup per node instead of a scan of the whole closure
  // per node — this runs on the drag-hover path, where an O(nodes × closure)
  // inner loop would stutter the drag on a large canvas.
  const childIdOwners = new Map();
  for (const node of nodes) {
    if (node?.type !== 'jobgroup' || !Array.isArray(node.data?.childIds)) continue;
    for (const childId of node.data.childIds) {
      if (typeof childId !== 'string' || !childId) continue;
      let owners = childIdOwners.get(childId);
      if (!owners) {
        owners = new Set();
        childIdOwners.set(childId, owners);
      }
      owners.add(node.id);
    }
  }

  const closureIds = new Set();
  const orderedNodes = [];
  const addToClosure = (node) => {
    if (!node || typeof node.id !== 'string' || !node.id || closureIds.has(node.id)) return;
    closureIds.add(node.id);
    orderedNodes.push(node);
  };

  for (const node of Array.isArray(dragSet) ? dragSet : []) addToClosure(node);
  const seededIds = new Set(closureIds);

  let lockedBlockerId = null;
  // Fixpoint loop: repeat a full pass over `allNodes` until one adds nothing
  // new, then stop. A cycle (a jobgroup whose childIds loops back on itself,
  // or a hubId chain that loops) cannot grow the set forever — it just stops
  // contributing once every reachable id is already in `closureIds`.
  let changed = true;
  while (changed && !lockedBlockerId) {
    changed = false;
    for (const node of nodes) {
      if (lockedBlockerId) break;
      if (!node || typeof node.id !== 'string' || !node.id || closureIds.has(node.id)) continue;
      // Ownership only ever runs through a hub-owned child or a jobgroup's
      // own childIds — a `group` (sub-canvas) node never qualifies as
      // either, so the target group can never be pulled in here.
      if (ABSORB_EXCLUDED_TYPES.has(node.type)) continue;

      const ownedByHub = typeof node.data?.hubId === 'string' && closureIds.has(node.data.hubId);
      const childIdOwnerIds = ownedByHub ? null : childIdOwners.get(node.id);
      const ownedByChildIds = !!childIdOwnerIds
        && [...childIdOwnerIds].some(ownerId => closureIds.has(ownerId));
      if (!ownedByHub && !ownedByChildIds) continue;

      addToClosure(node);
      changed = true;
      // An owned child that cannot travel blocks the whole move. Stop
      // growing the closure — the caller turns this into the rejection
      // label 'Unlock its cards first'.
      if (node.data?.locked) lockedBlockerId = node.id;
    }
  }

  return {
    nodes: orderedNodes,
    addedIds: orderedNodes.filter(node => !seededIds.has(node.id)).map(node => node.id),
    lockedBlockerId,
  };
}

/**
 * Split `edges` by how many endpoints are in `movedIds`. React Flow cannot
 * hold a cross-level edge (see serializationUtils.js:376), so `crossing`
 * edges must be dropped rather than transferred — the caller reports that
 * count instead of silently discarding them.
 */
export function partitionEdgesForMove(edges, movedIds) {
  const moved = movedIds instanceof Set ? movedIds : new Set(Array.isArray(movedIds) ? movedIds : []);
  const internal = [];
  const external = [];
  const crossing = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    const sourceMoved = !!edge?.source && moved.has(edge.source);
    const targetMoved = !!edge?.target && moved.has(edge.target);
    if (sourceMoved && targetMoved) internal.push(edge);
    else if (!sourceMoved && !targetMoved) external.push(edge);
    else crossing.push(edge);
  }
  return { internal, external, crossing };
}

// Peer id-reference fields between job module nodes, confirmed against
// remapCopiedJobModuleReferences (jobBoardSearchSelection.js) — the
// authoritative enumeration of this same reference graph. Each entry is
// read straight off the node, never invented: a scalar field pointing at one
// owner id, per node type.
const SCALAR_ID_REF_FIELDS = [
  { nodeType: 'jobcard', field: 'originHubId', targetType: 'jobhub' },
  { nodeType: 'jobsourcecard', field: 'hubId', targetType: 'jobhub' },
  { nodeType: 'jobcard', field: 'hubId', targetType: 'jobboard' },
  { nodeType: 'jobgroup', field: 'hubId', targetType: 'jobboard' },
];

// Array-of-id reference fields.
const ARRAY_ID_REF_FIELDS = [
  { nodeType: 'jobboard', field: 'selectedSearchModuleIds', targetType: 'jobhub' },
  { nodeType: 'jobboard', field: 'searchExecutionOrder', targetType: 'jobhub' },
];

// Array-of-object reference fields, where each entry carries its own
// `originHubId`.
const ENTRY_ID_REF_FIELDS = [
  { nodeType: 'jobhub', field: 'scoredJobs', targetType: 'jobhub' },
  { nodeType: 'jobhub', field: 'preferenceCandidatePool', targetType: 'jobhub' },
];

/**
 * Peer references the move would break, for the warning label. Scans every
 * node in `allNodes` (moved or not) for the reference fields above and
 * reports one whose owner and target land on opposite sides of `movedIds` —
 * this naturally covers both directions (a moved node referencing something
 * left behind, and something left behind referencing a moved node) in one
 * pass, since it does not matter which side started inside the set.
 *
 * Only counts a reference when the referenced id actually resolves to a node
 * of the expected type in `allNodes` — a dangling id that already pointed
 * nowhere is not something this move severed.
 */
export function findSeveredRelations(movedIds, allNodes, edges) {
  const moved = movedIds instanceof Set ? movedIds : new Set(Array.isArray(movedIds) ? movedIds : []);
  const nodes = Array.isArray(allNodes) ? allNodes : [];
  const nodeById = new Map();
  for (const node of nodes) {
    if (typeof node?.id === 'string' && node.id) nodeById.set(node.id, node);
  }

  const { crossing: crossingEdges } = partitionEdgesForMove(edges, moved);

  // Every job-tree link is stored twice: a real React Flow edge AND a parallel
  // data.hubId backlink (buildJobTree.js pushes both for each card/group, and
  // JobSearchNode does the same for its source cards). Counting both would
  // report one severed hub-to-child link as "2 connections will be cut".
  // Index the crossing edges by unordered endpoint pair so a reference field
  // that merely restates an edge already counted is not counted again.
  const crossingPairs = new Set();
  for (const edge of crossingEdges) {
    if (!edge?.source || !edge?.target) continue;
    const pair = [edge.source, edge.target].sort();
    crossingPairs.add(`${pair[0]}\x00${pair[1]}`);
  }

  const severedRefs = [];
  const seenKeys = new Set();
  const addSevered = (fromId, toId, field) => {
    if (!fromId || !toId || fromId === toId) return;
    if (moved.has(fromId) === moved.has(toId)) return; // both sides moved together, or both stayed
    const pair = [fromId, toId].sort();
    if (crossingPairs.has(`${pair[0]}\x00${pair[1]}`)) return; // already counted as an edge
    const key = `${fromId}|${toId}|${field}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    severedRefs.push({ fromId, toId, field });
  };

  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !node.id) continue;
    const data = node.data || {};

    for (const { nodeType, field, targetType } of SCALAR_ID_REF_FIELDS) {
      if (node.type !== nodeType) continue;
      const refId = data[field];
      if (typeof refId !== 'string' || !refId) continue;
      if (nodeById.get(refId)?.type !== targetType) continue;
      addSevered(node.id, refId, field);
    }

    for (const { nodeType, field, targetType } of ARRAY_ID_REF_FIELDS) {
      if (node.type !== nodeType || !Array.isArray(data[field])) continue;
      for (const refId of data[field]) {
        if (typeof refId !== 'string' || !refId) continue;
        if (nodeById.get(refId)?.type !== targetType) continue;
        addSevered(node.id, refId, field);
      }
    }

    for (const { nodeType, field, targetType } of ENTRY_ID_REF_FIELDS) {
      if (node.type !== nodeType || !Array.isArray(data[field])) continue;
      for (const entry of data[field]) {
        const refId = entry?.originHubId;
        if (typeof refId !== 'string' || !refId) continue;
        if (nodeById.get(refId)?.type !== targetType) continue;
        addSevered(node.id, refId, field);
      }
    }
  }

  return { crossingEdges, severedRefs };
}

/**
 * The drag-hover cue for a sub-canvas, mirroring the hub contract in
 * hubNodeDrop.js/HubContainer.jsx (`{ kind, label }`). `closureNodes` is the
 * candidate drag set (typically the raw selection); this resolves its own
 * closure over `allNodes` so a caller can hand it the drag set directly and
 * get back a fully-formed hover state, locked-child rejection included.
 * Keep labels short — they render inside a circular node.
 */
export function buildGroupHoverState(closureNodes, targetGroup, allNodes, edges) {
  // A locked target sub-canvas outranks everything about the dragged nodes —
  // same precedence getAbsorptionRejection documents. Unlocking a blocked child
  // would not make this drop succeed while the target itself stays locked, so
  // reporting the child first would send the user to fix the wrong thing.
  if (targetGroup?.data?.locked) {
    return { kind: 'reject', label: 'Sub-canvas is locked' };
  }

  const closure = collectAbsorptionClosure(closureNodes, allNodes);
  if (closure.lockedBlockerId) {
    return { kind: 'reject', label: 'Unlock its cards first' };
  }

  const rejection = getAbsorptionRejection(closure.nodes, targetGroup);
  if (rejection) return rejection;

  const movedIds = new Set(closure.nodes.map(node => node.id));
  const { crossingEdges, severedRefs } = findSeveredRelations(movedIds, allNodes, edges);
  const cutCount = crossingEdges.length + severedRefs.length;

  const originalCount = (Array.isArray(closureNodes) ? closureNodes : [])
    .filter(node => typeof node?.id === 'string' && node.id).length;
  const totalCount = closure.nodes.length;
  const addedChildren = totalCount > originalCount;

  if (cutCount === 0) {
    return {
      kind: 'accept',
      label: addedChildren ? `Move ${totalCount} nodes into sub-canvas` : 'Move into sub-canvas',
    };
  }
  const cutLabel = cutCount === 1 ? '1 connection will be cut' : `${cutCount} connections will be cut`;
  return {
    kind: 'accept',
    label: addedChildren ? `${cutLabel} · ${totalCount} nodes` : cutLabel,
  };
}
