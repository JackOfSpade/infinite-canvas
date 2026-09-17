import { useCallback, useRef } from 'react';
import { EventLogger } from '../utils/EventLogger';

import { ResizeCorrection, ResizeActive, TitleZoneCorrection, TitleZoneActive } from '../utils/canvasInteractions';

import { findNonOverlappingPlacement } from '../utils/layoutUtils';
import { getHubDropRejectLabel, getHubFileDropMode } from '../utils/hubDropEligibility';
import { buildHubHoverState, filePayloadFromDraggedNodes, fileSupportedByHub } from '../utils/hubNodeDrop';
import { appendPhotoFiles } from '../utils/photoPathList';
import { collectAbsorptionClosure, partitionEdgesForMove, buildGroupHoverState } from '../utils/nestedCanvasAbsorption';
import { markJobWorkflowRelocationPending, settleJobWorkflowRelocation } from '../utils/nodeDeletionLifecycle';

// ────────────────────────────────────────────────────────────────────────────

const HUB_DROP_TARGET_TYPES = new Set(['jobhub', 'sellhub']);

function findHubDropTarget(dragSet, getIntersectingNodes) {
  for (const dragged of dragSet) {
    const intersections = getIntersectingNodes(dragged);
    const targetHub = intersections.find(n =>
      HUB_DROP_TARGET_TYPES.has(n.type) &&
      n.id !== dragged.id &&
      !n.data?.locked
    );
    if (targetHub) return targetHub;
  }
  return null;
}

// Unlike findHubDropTarget, this does not filter out a locked group — a
// locked sub-canvas must still be found so getAbsorptionRejection (via
// buildGroupHoverState) can report "Sub-canvas is locked" instead of the drag
// silently showing no cue at all, same honesty goal as the rest of this file.
function findGroupDropTarget(dragSet, getIntersectingNodes) {
  for (const dragged of dragSet) {
    const intersections = getIntersectingNodes(dragged);
    const targetGroup = intersections.find(n => n.type === 'group' && n.id !== dragged.id);
    if (targetGroup) return targetGroup;
  }
  return null;
}

// A drag-hover cue that never appears and a drag that never found a target
// look identical from outside, and until this line existed a bug report could
// not tell them apart: between rf-drag-start and rf-drag-stop the renderer log
// held nothing at all about hover resolution. States the observation (what the
// resolver decided) and asserts no cause. Callers must invoke it ONLY on a
// transition — never on a stationary pointer-move frame.
function logHoverTransition(kind, previousId, nextId, hoverState) {
  if (!previousId && !nextId) return; // no target before, none now — nothing observed
  const verdict = nextId
    ? (hoverState ? `${hoverState.kind}:${hoverState.label}` : 'resolved-without-state')
    : 'none';
  EventLogger.log(`drag-hover ${kind} target=${nextId || 'none'} was=${previousId || 'none'} verdict=${verdict}`);
}

export function useDragCorrections({ setNodes, setEdges, getNodes, getEdges, getIntersectingNodes, getNode, takeSnapshot, updateNodeData, addElementsGlobally, extractToLevel, isAnimatingRef, isInteractionRef }) {
  const resizeDragActiveRef    = useRef(new Set());
  const titleZoneDragActiveRef = useRef(new Set());
  const targetGroupIdRef       = useRef(null);
  const targetHubIdRef         = useRef(null);
  const dragStartPositionsRef  = useRef(new Map());
  // The node/edge MEMBERSHIP the absorption hover math runs over, frozen at
  // drag-start: collectAbsorptionClosure and findSeveredRelations (run inside
  // buildGroupHoverState) are each O(nodes x closure), and canvas membership
  // does not change mid-drag from user input, so there is nothing to gain by
  // pulling getNodes()/getEdges() again every frame — only onNodeDragStop
  // re-resolves from live state, right before it actually mutates anything.
  //
  // The dragged nodes themselves are deliberately NOT frozen alongside it.
  // They move, and onNodeDrag's hover tests are geometric; see the comment at
  // that callback's dragSet for what freezing them cost.
  const dragCanvasRef          = useRef({ nodes: [], edges: [] });
  // Per-drag memo of group hover state, keyed by target group id, so a frame
  // that keeps hovering the same sub-canvas does no new closure/severed-refs
  // work — only switching to a different target pays for a fresh
  // buildGroupHoverState call.
  const groupHoverCacheRef     = useRef(new Map());

  const clearHubHover = useCallback(() => {
    if (!targetHubIdRef.current) return;
    updateNodeData(targetHubIdRef.current, { dragHover: null });
    targetHubIdRef.current = null;
  }, [updateNodeData]);

  const restoreDragStartPositions = useCallback((ids) => {
    const idSet = new Set(ids);
    setNodes(nds => nds.map(n => {
      if (!idSet.has(n.id)) return n;
      const position = dragStartPositionsRef.current.get(n.id);
      return position ? { ...n, position: { ...position } } : n;
    }));
  }, [setNodes]);

  const onNodeDragStart = useCallback((e, node) => {
    // Cleared before the animation guard, never after it. restoreDragStartPositions
    // reads this map by node id with no notion of WHICH drag recorded an entry, so
    // a start skipped mid-animation used to leave the previous gesture's positions
    // in place — and a later refused hub drop then "restored" the node to where it
    // sat two drags ago. Empty means the snap-back is a no-op and the node stays
    // where it was released, which is the honest outcome for a drag this hook
    // never observed starting.
    dragStartPositionsRef.current.clear();
    if (isAnimatingRef?.current) return;
    if (isInteractionRef) isInteractionRef.current = true;
    
    // Snapshot the state BEFORE the move starts so Undo has a valid "old" position to return to.
    if (takeSnapshot) takeSnapshot();
    
    EventLogger.log(`rf-drag-start id=${node.id} type=${node.type} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);
    const currentNodes = getNodes ? getNodes() : [node];
    const draggedAtStart = currentNodes.filter(n => n.id === node.id || n.selected);
    const dragSet = draggedAtStart.length > 0 ? draggedAtStart : [node];
    for (const n of dragSet) {
      dragStartPositionsRef.current.set(n.id, { ...n.position });
    }

    // Freeze only the node/edge snapshot the absorption hover math runs over
    // (see the comment on that ref above) — computed once here rather than per
    // pointer-move frame in onNodeDrag.
    dragCanvasRef.current = { nodes: currentNodes, edges: getEdges ? getEdges() : [] };
    groupHoverCacheRef.current = new Map();

    // Tag this RF drag as resize-initiated if a resize is currently active.
    if (ResizeActive.has(node.id)) {
      resizeDragActiveRef.current.add(node.id);
    }
    // Tag as title-zone-initiated if a title-zone press is currently active.
    if (TitleZoneActive.has(node.id)) {
      titleZoneDragActiveRef.current.add(node.id);
    }
  }, [getNodes, getEdges, isAnimatingRef, takeSnapshot, isInteractionRef]);

  const onNodeDrag = useCallback((e, node, draggedNodes) => {
    if (isAnimatingRef?.current) return;
    if (resizeDragActiveRef.current.has(node.id) || titleZoneDragActiveRef.current.has(node.id)) return;
    if (!getIntersectingNodes) return;

    // Read the LIVE drag set React Flow passes as the third argument — the
    // same list onNodeDragStop receives, each entry carrying the node's
    // CURRENT mid-drag position.
    //
    // This must never be a set captured at drag-start. getIntersectingNodes
    // resolves its rect from the object it is handed: getNodeRect does
    // `isNode(node) ? node : nodeLookup.get(node.id)` and then reads
    // nodeToUse.position, so a node object snapshotted in onNodeDragStart
    // yields that node's DRAG-START rect for the whole gesture. Testing
    // against it asked "did this node overlap the hub before the user moved
    // it?", so the hub/sub-canvas accept-reject cue could only ever appear
    // when the answer was already yes — i.e. never, for the ordinary gesture
    // of dragging a career file onto a Job Search module from elsewhere on
    // the canvas. The drop still worked, because onNodeDragStop re-resolves
    // from its own live argument; only the cue was missing.
    //
    // Reading the live argument also makes hover and drop agree by
    // construction: both now resolve their target from the identical list
    // React Flow actually moved, which is already extent-clamped and
    // post-snapToGrid, and which excludes a selected-but-undraggable node
    // that a getNodes()+filter would have wrongly included.
    //
    // Note this is the drag set, not the closure — the types that skip hover
    // work are decided by getAbsorptionRejection (via buildGroupHoverState,
    // e.g. ABSORB_EXCLUDED_TYPES or the run guard) with a visible reject cue,
    // never by a silent type-based carve-out here.
    const dragSet = (draggedNodes && draggedNodes.length > 0) ? draggedNodes : [node];

    // --- sub-canvas (group) absorption hover ---
    const targetGroup = findGroupDropTarget(dragSet, getIntersectingNodes);
    const newGroupId = targetGroup ? targetGroup.id : null;
    const previousGroupId = targetGroupIdRef.current;
    const groupTargetChanged = previousGroupId !== newGroupId;
    if (groupTargetChanged) {
      if (previousGroupId) {
        updateNodeData(previousGroupId, { isDropTarget: false, dragHover: null });
      }
      targetGroupIdRef.current = newGroupId;
    }
    let groupHoverState = null;
    if (newGroupId) {
      // collectAbsorptionClosure/findSeveredRelations inside
      // buildGroupHoverState are each O(nodes x closure) — paying that on
      // every pointer-move frame would stutter the drag on a large canvas.
      // Memoizing by target id is safe because buildGroupHoverState reads only
      // identity (id/type/data/edges), never position: the dragged nodes move
      // every frame, but the verdict for a given target group cannot change
      // while drag membership and canvas membership (dragCanvasRef) hold still.
      groupHoverState = groupHoverCacheRef.current.get(newGroupId);
      if (!groupHoverState) {
        groupHoverState = buildGroupHoverState(
          dragSet,
          targetGroup,
          dragCanvasRef.current.nodes,
          dragCanvasRef.current.edges,
        );
        groupHoverCacheRef.current.set(newGroupId, groupHoverState);
      }
      // isDropTarget only goes true on an accept, so the existing blue ring
      // keeps meaning "this will work" — a reject renders from dragHover alone.
      updateNodeData(newGroupId, {
        dragHover: groupHoverState,
        isDropTarget: groupHoverState.kind === 'accept',
      });
    }
    // TRANSITION-ONLY (enter / leave / target switch), and logged here rather
    // than inside the branch above so the line carries the resolved verdict.
    // The stationary-frame refresh deliberately stays silent: onNodeDrag runs
    // per pointer-move frame, and a per-frame line would flush every other
    // renderer event out of the ring buffer a bug report reads from.
    if (groupTargetChanged) {
      logHoverTransition('group', previousGroupId, newGroupId, groupHoverState);
    }

    // --- hub (jobhub/sellhub) drop hover — no closure math involved ---
    // Gated on the same type test onNodeDragStop uses to resolve its own
    // targetHub. Without it, dragging a Job Search over another Job Search
    // would light the target up with "Unsupported component" even though the
    // drop path never evaluates a hub target for a dragged hub — a cue for an
    // interaction that does not exist. A dragged Job Board is deliberately NOT
    // excluded: its drop DOES resolve a hub target, and its "Drop a career file
    // instead" cue is the one commit 4f3f448 added on purpose.
    const targetHub = HUB_DROP_TARGET_TYPES.has(node.type)
      ? null
      : findHubDropTarget(dragSet, getIntersectingNodes);
    const newHubId = targetHub?.id || null;
    const hubHoverState = targetHub ? buildHubHoverState(targetHub, dragSet) : null;
    if (newHubId !== targetHubIdRef.current) {
      // TRANSITION-ONLY — see the sub-canvas branch above for why the
      // stationary-frame refresh below stays silent.
      logHoverTransition('hub', targetHubIdRef.current, newHubId, hubHoverState);
      clearHubHover();
      if (newHubId && hubHoverState) {
        updateNodeData(newHubId, { dragHover: hubHoverState });
        targetHubIdRef.current = newHubId;
      }
    } else if (newHubId && hubHoverState) {
      updateNodeData(newHubId, { dragHover: hubHoverState });
    }
  }, [getIntersectingNodes, updateNodeData, isAnimatingRef, clearHubHover]);

  const onNodeDragStop = useCallback((e, node, draggedNodes) => {
    if (isInteractionRef) isInteractionRef.current = false;

    EventLogger.log(`rf-drag-stop id=${node.id} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);

    // Everything down to the isAnimatingRef guard below is teardown, and it runs
    // unconditionally. It used to sit BEHIND that guard, so a drag released
    // while a viewport animation was still playing left all of it alive: the
    // hover ring and its accept/reject label stayed lit on whatever node was
    // last targeted, with no drag in progress, until some unrelated later drag
    // happened to resolve a different target and trip the "target changed"
    // clear. Worse, node.id stayed flagged in resizeDragActiveRef /
    // titleZoneDragActiveRef, which made the NEXT drag of that same node skip
    // all hover work and read wasResizeDrag/wasTitleZoneDrag as true — silently
    // disabling the whole hub-drop and group-absorption block for an ordinary
    // move. An animation is a reason not to INTERPRET this drop; it is never a
    // reason to leave state behind.
    if (targetGroupIdRef.current) {
      updateNodeData(targetGroupIdRef.current, { isDropTarget: false, dragHover: null });
      targetGroupIdRef.current = null;
    }
    clearHubHover();
    // The drag is over — drop the frozen canvas snapshot and hover memo so a
    // stale reference from this gesture cannot leak into the next.
    dragCanvasRef.current = { nodes: [], edges: [] };
    groupHoverCacheRef.current = new Map();

    const wasResizeDrag    = resizeDragActiveRef.current.has(node.id);
    const wasTitleZoneDrag = titleZoneDragActiveRef.current.has(node.id);
    resizeDragActiveRef.current.delete(node.id);
    titleZoneDragActiveRef.current.delete(node.id);

    const correction   = ResizeCorrection.get(node.id);
    const tzCorrection = TitleZoneCorrection.get(node.id);
    ResizeCorrection.delete(node.id);
    TitleZoneCorrection.delete(node.id);

    // Teardown is done; from here on the drop is being interpreted.
    if (isAnimatingRef?.current) return;

    if (correction && wasResizeDrag) {
      const { flowCx, flowCy, size } = correction;
      const correctX = flowCx - size / 2;
      const correctY = flowCy - size / 2;
      EventLogger.log(`resize-correction id=${node.id} pos=(${correctX.toFixed(1)},${correctY.toFixed(1)}) size=${size}`);
      setNodes(nds => nds.map(n =>
        n.id === node.id ? {
          ...n,
          position: { x: correctX, y: correctY },
          width:  size,
          height: size,
          style:  { ...(n.style || {}), width: size, height: size },
        } : n
      ));
    } else if (correction) {
      EventLogger.log(`resize-correction DISCARDED (stale) id=${node.id}`);
    }

    if (tzCorrection && wasTitleZoneDrag) {
      EventLogger.log(`title-zone-correction id=${node.id} pos=(${tzCorrection.x.toFixed(1)},${tzCorrection.y.toFixed(1)})`);
      setNodes(nds => nds.map(n =>
        n.id === node.id ? { ...n, position: { x: tzCorrection.x, y: tzCorrection.y } } : n
      ));
    }

    // Check if the pointer was released over a breadcrumb navigator item
    const clientX = e.clientX ?? (e.touches && e.touches[0]?.clientX);
    const clientY = e.clientY ?? (e.touches && e.touches[0]?.clientY);

    let droppedOnBreadcrumbDepth = null;
    if (clientX !== undefined && clientY !== undefined) {
      const elements = document.elementsFromPoint(clientX, clientY);
      const breadcrumbBtn = elements.find(el => el.hasAttribute('data-breadcrumb-level'));
      if (breadcrumbBtn) {
        droppedOnBreadcrumbDepth = parseInt(breadcrumbBtn.getAttribute('data-breadcrumb-level'), 10);
      }
    }

    if (droppedOnBreadcrumbDepth !== null) {
      if (extractToLevel) {
        const nodesToExtract = (draggedNodes && draggedNodes.length > 0) ? draggedNodes.map(n => n.id) : [node.id];
        // Log what extractToLevel actually moved, not what was requested: it
        // resolves the same ownership closure the absorption path uses, so
        // dragging a Board out by itself also carries its cards. It returns
        // undefined when it refused (locked child, active run, bad level).
        const extractedIds = extractToLevel(nodesToExtract, droppedOnBreadcrumbDepth);
        if (extractedIds && extractedIds.length > 0) {
          EventLogger.log(`Extracted nodes [${extractedIds.join(',')}] to breadcrumb level ${droppedOnBreadcrumbDepth} (requested [${nodesToExtract.join(',')}])`);
        } else {
          EventLogger.log(`Extraction of [${nodesToExtract.join(',')}] to breadcrumb level ${droppedOnBreadcrumbDepth} was refused`);
        }
      }
      return; 
    }

    // Existing document nodes can be dropped onto workflow hubs as shortcuts to
    // their underlying files, and any node type (including jobhub/jobboard/
    // sellhub themselves) can now be absorbed into a sub-canvas group. A drop
    // can geometrically overlap both a hub and a group at once, so precedence
    // matters: the hub branch only has something to do with a drag set that
    // is actually carrying files, so it wins ONLY in that case — otherwise a
    // node that merely overlaps a hub while also being dropped on a group
    // must still absorb into the group rather than being swallowed by the
    // hub's unrelated "not a file" rejection.
    if (!wasResizeDrag && !wasTitleZoneDrag && getIntersectingNodes && getNode) {
      const dragSet = (draggedNodes && draggedNodes.length > 0) ? draggedNodes : [node];
      const targetHub = HUB_DROP_TARGET_TYPES.has(node.type) ? null : findHubDropTarget(dragSet, getIntersectingNodes);
      const filePayload = filePayloadFromDraggedNodes(dragSet);

      if (targetHub && filePayload.length > 0) {
        const draggedIds = dragSet.map(n => n.id);
        const acceptedFiles = filePayload.filter(file => fileSupportedByHub(targetHub.type, file));
        const dropMode = getHubFileDropMode(targetHub);
        if (acceptedFiles.length === 0 || !dropMode) {
          restoreDragStartPositions(draggedIds);
          if (!dropMode) {
            const reason = getHubDropRejectLabel(targetHub) || 'Not accepting drops';
            EventLogger.log(`Rejected document node drop for ${reason.toLowerCase()} ${targetHub.type}; restored drag position`);
            return;
          }
          EventLogger.log(`Rejected ${filePayload.length} document node(s) for ${targetHub.type}; restored drag position`);
          return;
        }

        if (dropMode === 'display-photos') {
          const { imagePaths, added } = appendPhotoFiles(targetHub.data?.imagePaths || [], acceptedFiles);
          if (added > 0) {
            setNodes(nds => nds.map(n =>
              n.id === targetHub.id
                ? { ...n, data: { ...(n.data || {}), imagePaths } }
                : n
            ));
          }
          restoreDragStartPositions(draggedIds);
          EventLogger.log(`Dropped ${acceptedFiles.length}/${filePayload.length} document node(s) onto ${targetHub.type} ${targetHub.id} mode=${dropMode} applied=${added}`);
          return;
        }

        document.dispatchEvent(new CustomEvent('canvas-file-nodes-dropped-on-hub', {
          detail: {
            hubId: targetHub.id,
            hubType: targetHub.type,
            files: acceptedFiles,
            mode: dropMode,
          },
        }));
        restoreDragStartPositions(draggedIds);
        EventLogger.log(`Dropped ${acceptedFiles.length}/${filePayload.length} document node(s) onto ${targetHub.type} ${targetHub.id} mode=${dropMode}`);
        return;
      }

      // --- sub-canvas (group) absorption ---
      const targetGroup = findGroupDropTarget(dragSet, getIntersectingNodes);
      if (targetGroup) {
        const currentNodes = getNodes ? getNodes() : [node];
        const currentEdges = getEdges ? getEdges() : [];
        // Re-resolve everything from live canvas state right before mutating
        // anything — the closure/hover cache built up during onNodeDrag is
        // for hover feedback only, and the canvas can in principle change
        // during a long drag (see dragCanvasRef's comment above).
        const closure = collectAbsorptionClosure(dragSet, currentNodes);
        const hoverResult = buildGroupHoverState(dragSet, targetGroup, currentNodes, currentEdges);

        if (hoverResult.kind === 'reject') {
          // Deliberately NOT a snap-back. Before this feature a drop onto a
          // group that could not absorb (a group onto a group, a locked
          // group) simply fell through to an ordinary move and the nodes
          // stayed where they were released — snapping them back now would
          // be a new surprise, and would make a sub-canvas impossible to
          // position over another one. The red drag-hover cue already told
          // the user it would not go in, and a non-absorbed node visibly
          // sits on top of the circle rather than inside it. Fall through to
          // the ordinary-move snapshot at the end of this callback.
          EventLogger.log(`Absorption into group ${targetGroup.id} refused (${hoverResult.label}); left as an ordinary move`);
        } else {
          if (takeSnapshot) takeSnapshot();

          // Move the whole closure, not just the dragged nodes — a hub must
          // never move without the children it owns (see
          // collectAbsorptionClosure's doc comment), or leaving them behind
          // re-triggers exactly the unmount cascade this feature exists to avoid.
          const closureNodes = closure.nodes;
          const movedIds = new Set(closureNodes.map(n => n.id));

          // Mark the relocation fence synchronously and BEFORE the setNodes
          // below unmounts these components. Each module's unmount handler
          // (isJobWorkflowRelocationPending) checks this fence to tell "the
          // user moved me into a sub-canvas" apart from "the user deleted me" —
          // see the relocation-fence comment in nodeDeletionLifecycle.js.
          const relocatedIds = markJobWorkflowRelocationPending(closureNodes);

          const { internal: edgesToTransfer, crossing } = partitionEdgesForMove(currentEdges, movedIds);
          if (crossing.length > 0) {
            // React Flow cannot hold a cross-level edge (serializationUtils.js:
            // ~376) — these are genuinely destroyed by this move. Say so
            // explicitly; silently dropping them is one of the bugs this
            // feature fixes.
            EventLogger.log(`Absorption into group ${targetGroup.id} cuts ${crossing.length} cross-level edge(s)`);
          }

          const childNodes = targetGroup.data?.canvasData?.nodes || [];
          const { anchorX, anchorY, dropMinX, dropMinY } = findNonOverlappingPlacement(closureNodes, childNodes);

          const newNodesPayload = closureNodes.map(n => {
            const offsetX = n.position.x - dropMinX;
            const offsetY = n.position.y - dropMinY;
            return {
              ...n,
              selected: false,
              position: { x: anchorX + offsetX, y: anchorY + offsetY }
            };
          });

          setNodes(nds => nds.filter(n => !movedIds.has(n.id)));
          if (setEdges) {
            setEdges(eds => eds.filter(e => !movedIds.has(e.source) && !movedIds.has(e.target)));
          }

          if (addElementsGlobally) {
            addElementsGlobally(targetGroup.id, newNodesPayload, edgesToTransfer);
          }
          EventLogger.log(`Absorbed ${movedIds.size} node(s) and ${edgesToTransfer.length} edge(s) into group ${targetGroup.id}`);

          // Settle on a macrotask, not a microtask: useUnmountEffect defers its
          // own cleanup by one microtask (Promise.resolve().then(...), see
          // useUnmountEffect.js) so a React StrictMode remount can invalidate a
          // stale cleanup before it runs its check. Settling the fence here
          // with a microtask could resolve before that deferred callback reads
          // isJobWorkflowRelocationPending, re-opening the exact race the fence
          // exists to close. setTimeout(...,0) is a macrotask, guaranteed to run
          // strictly after every microtask already queued by the unmount,
          // including that deferred one.
          setTimeout(() => settleJobWorkflowRelocation(relocatedIds), 0);
          return;
        }
      }

      if (!targetGroup && targetHub) {
        // Only when the drop never touched a sub-canvas at all. Once a group
        // was found, that branch above owns the outcome — including its
        // deliberate "refused, left as an ordinary move" case. Falling into
        // the hub snap-back there would undo that decision and blame the hub
        // in the log for a rejection the group actually made.
        //
        // No file payload and no group to fall through to: keep today's exact
        // snap-back + rejection log so a document-less drop onto a hub still
        // reads as rejected instead of silently doing nothing.
        const draggedIds = dragSet.map(n => n.id);
        restoreDragStartPositions(draggedIds);
        const draggedSummary = dragSet.map(n => `${n.id}:${n.type || 'unknown'}`).join(',');
        EventLogger.log(`Rejected non-file node drop [${draggedSummary}] onto ${targetHub.type} ${targetHub.id}; restored drag position`);
        return;
      }
    }

    // Snapshot the final resting canvas state for ordinary drags only. Hub-input
    // and group-absorption drops return earlier (they either snap back or have
    // already taken their own snapshot before mutating).
    if (takeSnapshot) takeSnapshot();
  }, [setNodes, setEdges, getNodes, getEdges, getIntersectingNodes, getNode, takeSnapshot, updateNodeData, addElementsGlobally, extractToLevel, isAnimatingRef, isInteractionRef, restoreDragStartPositions, clearHubHover]);

  return { onNodeDragStart, onNodeDrag, onNodeDragStop };
}
