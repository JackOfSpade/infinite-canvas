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

export function useDragCorrections({ setNodes, setEdges, getNodes, getEdges, getIntersectingNodes, getNode, takeSnapshot, updateNodeData, addElementsGlobally, extractToLevel, isAnimatingRef, isInteractionRef }) {
  const resizeDragActiveRef    = useRef(new Set());
  const titleZoneDragActiveRef = useRef(new Set());
  const targetGroupIdRef       = useRef(null);
  const targetHubIdRef         = useRef(null);
  const dragStartPositionsRef  = useRef(new Map());
  // React Flow fixes the drag set at drag-start (getDragItems), so it is
  // captured once here instead of re-derived via getNodes()+filter on every
  // onNodeDrag pointer-move frame. dragCanvasRef freezes the node/edge
  // membership alongside it for the same reason: collectAbsorptionClosure and
  // findSeveredRelations (run inside buildGroupHoverState) are each
  // O(nodes x closure), and neither the drag set nor canvas membership
  // changes mid-drag from user input, so there is nothing to gain by pulling
  // getNodes()/getEdges() again every frame — only onNodeDragStop re-resolves
  // from live state, right before it actually mutates anything.
  const dragSetRef             = useRef([]);
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
    if (isAnimatingRef?.current) return;
    if (isInteractionRef) isInteractionRef.current = true;
    
    // Snapshot the state BEFORE the move starts so Undo has a valid "old" position to return to.
    if (takeSnapshot) takeSnapshot();
    
    EventLogger.log(`rf-drag-start id=${node.id} type=${node.type} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);
    dragStartPositionsRef.current.clear();
    const currentNodes = getNodes ? getNodes() : [node];
    const draggedAtStart = currentNodes.filter(n => n.id === node.id || n.selected);
    const dragSet = draggedAtStart.length > 0 ? draggedAtStart : [node];
    for (const n of dragSet) {
      dragStartPositionsRef.current.set(n.id, { ...n.position });
    }

    // Freeze the drag set and the node/edge snapshot used for absorption
    // hover math (see the comment on these refs above) — computed once here
    // rather than per pointer-move frame in onNodeDrag.
    dragSetRef.current = dragSet;
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

  const onNodeDrag = useCallback((e, node) => {
    if (isAnimatingRef?.current) return;
    if (resizeDragActiveRef.current.has(node.id) || titleZoneDragActiveRef.current.has(node.id)) return;
    if (!getIntersectingNodes) return;

    // React Flow fixes the drag set at drag-start (see onNodeDragStart), so
    // every check below reads dragSetRef instead of re-deriving it. This also
    // removes the old reason a drag whose primary node was itself a
    // group/jobhub/jobboard/sellhub skipped hover work entirely: those types
    // now participate too, and it is getAbsorptionRejection (via
    // buildGroupHoverState, e.g. ABSORB_EXCLUDED_TYPES or the run guard) that
    // decides — with a visible reject cue — whether a given combination is
    // actually legal, rather than a silent type-based carve-out here.
    const dragSet = dragSetRef.current.length > 0 ? dragSetRef.current : [node];

    // --- sub-canvas (group) absorption hover ---
    const targetGroup = findGroupDropTarget(dragSet, getIntersectingNodes);
    const newGroupId = targetGroup ? targetGroup.id : null;
    if (targetGroupIdRef.current !== newGroupId) {
      if (targetGroupIdRef.current) {
        updateNodeData(targetGroupIdRef.current, { isDropTarget: false, dragHover: null });
      }
      targetGroupIdRef.current = newGroupId;
    }
    if (newGroupId) {
      // collectAbsorptionClosure/findSeveredRelations inside
      // buildGroupHoverState are each O(nodes x closure) — paying that on
      // every pointer-move frame would stutter the drag on a large canvas.
      // The drag set and canvas membership are frozen for the whole drag
      // (dragCanvasRef), so the hover state for a given target group cannot
      // change frame-to-frame either; memoize by target id so re-hovering the
      // same group across many frames does no new work.
      let groupHoverState = groupHoverCacheRef.current.get(newGroupId);
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
    if (isAnimatingRef?.current) return;
    if (isInteractionRef) isInteractionRef.current = false;

    EventLogger.log(`rf-drag-stop id=${node.id} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);

    // Clear the drop target visual indicator if active
    if (targetGroupIdRef.current) {
      updateNodeData(targetGroupIdRef.current, { isDropTarget: false, dragHover: null });
      targetGroupIdRef.current = null;
    }
    clearHubHover();
    // The drag is over — drop the frozen drag-set/canvas snapshot and hover
    // memo so a stale reference from this gesture cannot leak into the next.
    dragSetRef.current = [];
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
