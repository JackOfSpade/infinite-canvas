import { useCallback, useRef } from 'react';
import { EventLogger } from '../utils/EventLogger';

import { ResizeCorrection, ResizeActive, TitleZoneCorrection, TitleZoneActive } from '../utils/canvasInteractions';

import { findNonOverlappingPlacement } from '../utils/layoutUtils';
import { isProductImageFile } from '../utils/fileDropUtils';
import { canSellHubAcceptDisplayPhotoDrop, getHubDropRejectLabel, getHubFileDropMode } from '../utils/hubDropEligibility';
import { appendPhotoFiles } from '../utils/photoPathList';

// ────────────────────────────────────────────────────────────────────────────

const HUB_DROP_TARGET_TYPES = new Set(['jobhub', 'sellhub']);

function filePayloadFromDraggedNodes(nodes) {
  return (nodes || [])
    .filter(n => n?.type === 'document' && typeof n.data?.filePath === 'string' && n.data.filePath.trim())
    .map(n => ({
      nodeId: n.id,
      filePath: n.data.filePath,
      filename: n.data.filename || n.data.filePath.split(/[\\/]/).pop() || 'file',
    }));
}

function fileSupportedByHub(hubType, file) {
  const name = file?.filename || file?.filePath || '';
  if (hubType === 'jobhub') return !/\.app$/i.test(name);
  if (hubType === 'sellhub') return isProductImageFile(file);
  return false;
}

function buildHubHoverState(targetHub, dragSet) {
  if (!targetHub) return null;
  if (targetHub.data?.locked) {
    return { kind: 'reject', label: 'Locked' };
  }

  const filePayload = filePayloadFromDraggedNodes(dragSet);
  if (filePayload.length === 0) {
    return { kind: 'reject', label: 'Unsupported component' };
  }

  const acceptedFiles = filePayload.filter(file => fileSupportedByHub(targetHub.type, file));
  if (acceptedFiles.length === 0) {
    return {
      kind: 'reject',
      label: targetHub.type === 'jobhub' ? 'Unsupported resume file' : 'Images only',
    };
  }

  if (canSellHubAcceptDisplayPhotoDrop(targetHub)) {
    return { kind: 'accept', label: 'Add display photos' };
  }

  const lockLabel = getHubDropRejectLabel(targetHub);
  if (lockLabel) {
    return { kind: 'reject', label: lockLabel };
  }

  return {
    kind: 'accept',
    label: targetHub.type === 'jobhub' ? 'Use as resume' : 'Use as photos',
  };
}

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

export function useDragCorrections({ setNodes, setEdges, getNodes, getEdges, getIntersectingNodes, getNode, takeSnapshot, updateNodeData, addElementsGlobally, extractToLevel, isAnimatingRef, isInteractionRef }) {
  const resizeDragActiveRef    = useRef(new Set());
  const titleZoneDragActiveRef = useRef(new Set());
  const targetGroupIdRef       = useRef(null);
  const targetHubIdRef         = useRef(null);
  const dragStartPositionsRef  = useRef(new Map());

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
    for (const n of draggedAtStart.length > 0 ? draggedAtStart : [node]) {
      dragStartPositionsRef.current.set(n.id, { ...n.position });
    }

    // Tag this RF drag as resize-initiated if a resize is currently active.
    if (ResizeActive.has(node.id)) {
      resizeDragActiveRef.current.add(node.id);
    }
    // Tag as title-zone-initiated if a title-zone press is currently active.
    if (TitleZoneActive.has(node.id)) {
      titleZoneDragActiveRef.current.add(node.id);
    }
  }, [getNodes, isAnimatingRef, takeSnapshot, isInteractionRef]);

  const onNodeDrag = useCallback((e, node) => {
    if (isAnimatingRef?.current) return;
    if (resizeDragActiveRef.current.has(node.id) || titleZoneDragActiveRef.current.has(node.id)) return;

    if (getIntersectingNodes && node.type !== 'group' && node.type !== 'jobhub' && node.type !== 'jobboard' && node.type !== 'sellhub') {
      const intersections = getIntersectingNodes(node);
      const targetGroup = intersections.find(n => n.type === 'group' && !n.data?.locked);
      const newTargetId = targetGroup ? targetGroup.id : null;

      if (targetGroupIdRef.current !== newTargetId) {
        if (targetGroupIdRef.current) updateNodeData(targetGroupIdRef.current, { isDropTarget: false });
        if (newTargetId) updateNodeData(newTargetId, { isDropTarget: true });
        targetGroupIdRef.current = newTargetId;
      }

      // Only the hub-drop path needs the selected-node set; compute it here so a
      // drag of a group/hub (which returns above) doesn't pay getNodes()+filter
      // over the whole canvas on every pointer-move frame.
      const dragSet = (() => {
        const currentNodes = getNodes ? getNodes() : [node];
        const selected = currentNodes.filter(n => n.id === node.id || n.selected);
        return selected.length > 0 ? selected : [node];
      })();

      const targetHub = findHubDropTarget(dragSet, getIntersectingNodes);
      const newHubId = targetHub?.id || null;
      const hoverState = targetHub ? buildHubHoverState(targetHub, dragSet) : null;
      if (newHubId !== targetHubIdRef.current) {
        clearHubHover();
        if (newHubId && hoverState) {
          updateNodeData(newHubId, { dragHover: hoverState });
          targetHubIdRef.current = newHubId;
        }
      } else if (newHubId && hoverState) {
        updateNodeData(newHubId, { dragHover: hoverState });
      }
    }
  }, [getIntersectingNodes, updateNodeData, isAnimatingRef, getNodes, clearHubHover]);

  const onNodeDragStop = useCallback((e, node, draggedNodes) => {
    if (isAnimatingRef?.current) return;
    if (isInteractionRef) isInteractionRef.current = false;

    EventLogger.log(`rf-drag-stop id=${node.id} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);

    // Clear the drop target visual indicator if active
    if (targetGroupIdRef.current) {
      updateNodeData(targetGroupIdRef.current, { isDropTarget: false });
      targetGroupIdRef.current = null;
    }
    clearHubHover();

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
        extractToLevel(nodesToExtract, droppedOnBreadcrumbDepth);
        EventLogger.log(`Extracted nodes [${nodesToExtract.join(',')}] to breadcrumb level ${droppedOnBreadcrumbDepth}`);
      }
      return; 
    }

    // Existing document nodes can be dropped onto workflow hubs as shortcuts to
    // their underlying files. Keep the document node on the canvas and let the
    // hub run the same pipeline it would run for a Finder file drop.
    if (!wasResizeDrag && !wasTitleZoneDrag && getIntersectingNodes && !HUB_DROP_TARGET_TYPES.has(node.type)) {
      const dragSet = (draggedNodes && draggedNodes.length > 0) ? draggedNodes : [node];
      const targetHub = findHubDropTarget(dragSet, getIntersectingNodes);
      const filePayload = filePayloadFromDraggedNodes(dragSet);
      if (targetHub) {
        const draggedIds = dragSet.map(n => n.id);
        if (filePayload.length === 0) {
          restoreDragStartPositions(draggedIds);
          EventLogger.log(`Rejected non-file node drop onto ${targetHub.type}; restored drag position`);
          return;
        }

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
    }

    // Check if the node was dropped inside a group (nested canvas)
    // Only standard nodes (no groups) are absorbed, to prevent deep recursion complexities.
    if (!wasResizeDrag && !wasTitleZoneDrag && node.type !== 'group' && node.type !== 'jobhub' && node.type !== 'jobboard' && node.type !== 'sellhub') {
      if (getIntersectingNodes && getNode) {
        const intersections = getIntersectingNodes(node);
        const targetGroup = intersections.find(n => n.type === 'group' && !n.data?.locked);
        if (targetGroup) {
          const draggedNode = getNode(node.id);
          if (!draggedNode) return;
          
          if (takeSnapshot) takeSnapshot();
          
          const nodesToAbsorb = (draggedNodes && draggedNodes.length > 0) ? 
                                draggedNodes.filter(n => n.id !== targetGroup.id && !n.data?.locked) : 
                                [draggedNode].filter(n => !n.data?.locked);
          
          if (nodesToAbsorb.length === 0) return;

          const childNodes = targetGroup.data?.canvasData?.nodes || [];
          const { anchorX, anchorY, dropMinX, dropMinY } = findNonOverlappingPlacement(nodesToAbsorb, childNodes);

          const newNodesPayload = nodesToAbsorb.map(n => {
            const offsetX = n.position.x - dropMinX;
            const offsetY = n.position.y - dropMinY;
            return {
              ...n,
              selected: false,
              position: { x: anchorX + offsetX, y: anchorY + offsetY }
            };
          });

          const absorbedIds = new Set(nodesToAbsorb.map(n => n.id));
          
          let edgesToTransfer = [];
          if (getEdges) {
            const currentEdges = getEdges();
            edgesToTransfer = currentEdges.filter(e => absorbedIds.has(e.source) && absorbedIds.has(e.target));
          }

          setNodes(nds => nds.filter(n => !absorbedIds.has(n.id)));
          if (setEdges) {
            setEdges(eds => eds.filter(e => !absorbedIds.has(e.source) && !absorbedIds.has(e.target)));
          }
          
          if (addElementsGlobally) {
            addElementsGlobally(targetGroup.id, newNodesPayload, edgesToTransfer);
          }
          EventLogger.log(`Absorbed ${absorbedIds.size} node(s) and ${edgesToTransfer.length} edge(s) into group ${targetGroup.id}`);
          return;
        }
      }
    }

    // Snapshot the final resting canvas state for ordinary drags only. Hub-input
    // drops return earlier because they intentionally snap back to the start.
    if (takeSnapshot) takeSnapshot();
  }, [setNodes, setEdges, getEdges, getIntersectingNodes, getNode, takeSnapshot, updateNodeData, addElementsGlobally, extractToLevel, isAnimatingRef, isInteractionRef, restoreDragStartPositions, clearHubHover]);

  return { onNodeDragStart, onNodeDrag, onNodeDragStop };
}
