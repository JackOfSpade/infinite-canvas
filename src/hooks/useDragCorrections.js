import { useCallback, useRef } from 'react';
import { EventLogger } from '../utils/EventLogger';

import { ResizeCorrection, ResizeActive, TitleZoneCorrection, TitleZoneActive } from '../utils/canvasInteractions';

import { findNonOverlappingPlacement } from '../utils/layoutUtils';

// ────────────────────────────────────────────────────────────────────────────

export function useDragCorrections({ setNodes, setEdges, getEdges, getIntersectingNodes, getNode, takeSnapshot, updateNodeData, addElementsGlobally, extractToLevel, isAnimatingRef, isInteractionRef }) {
  const resizeDragActiveRef    = useRef(new Set());
  const titleZoneDragActiveRef = useRef(new Set());
  const targetGroupIdRef       = useRef(null);

  const onNodeDragStart = useCallback((e, node) => {
    if (isAnimatingRef?.current) return;
    if (isInteractionRef) isInteractionRef.current = true;
    
    // Snapshot the state BEFORE the move starts so Undo has a valid "old" position to return to.
    if (takeSnapshot) takeSnapshot();
    
    EventLogger.log(`rf-drag-start id=${node.id} type=${node.type} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);

    // Tag this RF drag as resize-initiated if a resize is currently active.
    if (ResizeActive.has(node.id)) {
      resizeDragActiveRef.current.add(node.id);
    }
    // Tag as title-zone-initiated if a title-zone press is currently active.
    if (TitleZoneActive.has(node.id)) {
      titleZoneDragActiveRef.current.add(node.id);
    }
  }, [isAnimatingRef, takeSnapshot, isInteractionRef]);

  const onNodeDrag = useCallback((e, node) => {
    if (isAnimatingRef?.current) return;
    if (resizeDragActiveRef.current.has(node.id) || titleZoneDragActiveRef.current.has(node.id)) return;
    
    if (getIntersectingNodes && node.type !== 'group' && node.type !== 'jobhub' && node.type !== 'sellhub') {
      const intersections = getIntersectingNodes(node);
      const targetGroup = intersections.find(n => n.type === 'group' && !n.data?.locked);
      const newTargetId = targetGroup ? targetGroup.id : null;
      
      if (targetGroupIdRef.current !== newTargetId) {
        if (targetGroupIdRef.current) updateNodeData(targetGroupIdRef.current, { isDropTarget: false });
        if (newTargetId) updateNodeData(newTargetId, { isDropTarget: true });
        targetGroupIdRef.current = newTargetId;
      }
    }
  }, [getIntersectingNodes, updateNodeData, isAnimatingRef]);

  const onNodeDragStop = useCallback((e, node, draggedNodes) => {
    if (isAnimatingRef?.current) return;
    if (isInteractionRef) isInteractionRef.current = false;

    EventLogger.log(`rf-drag-stop id=${node.id} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);

    // Snapshot the FINAL resting position so the "Redo" stack is cleared and history is consistent.
    if (takeSnapshot) takeSnapshot();

    // Clear the drop target visual indicator if active
    if (targetGroupIdRef.current) {
      updateNodeData(targetGroupIdRef.current, { isDropTarget: false });
      targetGroupIdRef.current = null;
    }

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

    // Check if the node was dropped inside a group (nested canvas)
    // Only standard nodes (no groups) are absorbed, to prevent deep recursion complexities.
    if (!wasResizeDrag && !wasTitleZoneDrag && node.type !== 'group' && node.type !== 'jobhub' && node.type !== 'sellhub') {
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
        }
      }
    }
  }, [setNodes, setEdges, getEdges, getIntersectingNodes, getNode, takeSnapshot, updateNodeData, addElementsGlobally, extractToLevel, isAnimatingRef, isInteractionRef]);

  return { onNodeDragStart, onNodeDrag, onNodeDragStop };
}
