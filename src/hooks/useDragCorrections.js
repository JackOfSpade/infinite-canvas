import { useCallback, useRef } from 'react';
import { getNodeDims } from '../utils/constants';
import { EventLogger } from '../utils/EventLogger';
import { ResizeCorrection, ResizeActive, TitleZoneCorrection, TitleZoneActive } from '../nodes/CanvasNode';

// ── Pure module-level helpers ────────────────────────────────────────────────

/**
 * Returns true if placing the `nodesToAbsorb` cluster at `(anchorX, anchorY)`
 * (relative to `dropMinX`/`dropMinY`) overlaps any existing `childNodes`.
 * Used by the spiral-search placement algorithm in onNodeDragStop.
 */
function placementOverlaps(anchorX, anchorY, nodesToAbsorb, dropMinX, dropMinY, childNodes, padding) {
  return childNodes.some(child => {
    const cDims  = getNodeDims(child);
    const cLeft  = child.position.x - padding;
    const cRight = child.position.x + cDims.w + padding;
    const cTop   = child.position.y - padding;
    const cBottom = child.position.y + cDims.h + padding;
    return nodesToAbsorb.some(dragged => {
      const dDims   = getNodeDims(dragged);
      const dLeft   = anchorX + (dragged.position.x - dropMinX);
      const dRight  = dLeft + dDims.w;
      const dTop    = anchorY + (dragged.position.y - dropMinY);
      const dBottom = dTop + dDims.h;
      return !(dRight <= cLeft || dLeft >= cRight || dBottom <= cTop || dTop >= cBottom);
    });
  });
}

// ────────────────────────────────────────────────────────────────────────────

export function useDragCorrections({ setNodes, setEdges, getEdges, getIntersectingNodes, getNode, takeSnapshot, updateNodeData, addElementsGlobally, extractToLevel, isAnimatingRef }) {
  const resizeDragActiveRef    = useRef(new Set());
  const titleZoneDragActiveRef = useRef(new Set());
  const targetGroupIdRef       = useRef(null);

  const onNodeDragStart = useCallback((e, node) => {
    if (isAnimatingRef?.current) return;
    EventLogger.log(`rf-drag-start id=${node.id} type=${node.type} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);

    // Tag this RF drag as resize-initiated if a resize is currently active.
    if (ResizeActive.has(node.id)) {
      resizeDragActiveRef.current.add(node.id);
    }
    // Tag as title-zone-initiated if a title-zone press is currently active.
    if (TitleZoneActive.has(node.id)) {
      titleZoneDragActiveRef.current.add(node.id);
    }
  }, []);

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
  }, [getIntersectingNodes, updateNodeData]);

  const onNodeDragStop = useCallback((e, node, draggedNodes) => {
    if (isAnimatingRef?.current) return;
    EventLogger.log(`rf-drag-stop id=${node.id} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);

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
                                draggedNodes.filter(n => n.id !== targetGroup.id) : 
                                [draggedNode];
          
          if (nodesToAbsorb.length === 0) return;

          const childNodes = targetGroup.data?.canvasData?.nodes || [];
          let anchorX = 0;
          let anchorY = 0;

          // Measure the collective bounding box of everything the user is dragging
          let dropMinX = Infinity, dropMaxX = -Infinity, dropMinY = Infinity, dropMaxY = -Infinity;
          nodesToAbsorb.forEach(n => {
            const d = getNodeDims(n);
            dropMinX = Math.min(dropMinX, n.position.x);
            dropMaxX = Math.max(dropMaxX, n.position.x + d.w);
            dropMinY = Math.min(dropMinY, n.position.y);
            dropMaxY = Math.max(dropMaxY, n.position.y + d.h);
          });
          const dropWidth  = dropMaxX - dropMinX;
          const dropHeight = dropMaxY - dropMinY;

          if (childNodes.length > 0) {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            childNodes.forEach(child => {
              const cDims = getNodeDims(child);
              minX = Math.min(minX, child.position.x);
              maxX = Math.max(maxX, child.position.x + cDims.w);
              minY = Math.min(minY, child.position.y);
              maxY = Math.max(maxY, child.position.y + cDims.h);
            });
            
            const padding = 40;
            const childCx = (minX + maxX) / 2;
            const childCy = (minY + maxY) / 2;

            // Start by trying the absolute center of the cluster view
            anchorX = childCx - (dropWidth / 2);
            anchorY = childCy - (dropHeight / 2);

            // Spiral search for non-overlapping placement
            if (placementOverlaps(anchorX, anchorY, nodesToAbsorb, dropMinX, dropMinY, childNodes, padding)) {
              let found = false;
              let radius = 60;
              const radStep = 60;
              const maxRadius = Math.max(5000, dropWidth * 3, dropHeight * 3);

              while (!found && radius < maxRadius) {
                const numPoints = Math.max(8, Math.floor((2 * Math.PI * radius) / radStep));
                const angleStep = (2 * Math.PI) / numPoints;

                for (let i = 0; i < numPoints; i++) {
                  const angle = i * angleStep;
                  const testX = anchorX + radius * Math.cos(angle);
                  const testY = anchorY + radius * Math.sin(angle);

                  if (!placementOverlaps(testX, testY, nodesToAbsorb, dropMinX, dropMinY, childNodes, padding)) {
                    anchorX = testX;
                    anchorY = testY;
                    found = true;
                    break;
                  }
                }
                radius += radStep;
              }
            }
          } else {
            // Empty sub-canvas, place dead center so view centers perfectly
            anchorX = -dropWidth / 2;
            anchorY = -dropHeight / 2;
          }

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
  }, [setNodes, setEdges, getEdges, getIntersectingNodes, getNode, takeSnapshot, updateNodeData, addElementsGlobally, extractToLevel, isAnimatingRef]);

  return { onNodeDragStart, onNodeDrag, onNodeDragStop };
}
