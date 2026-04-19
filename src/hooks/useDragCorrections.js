import { useCallback, useRef } from 'react';
import { getNodeDims } from '../utils/constants';
import { EventLogger } from '../utils/EventLogger';
import { ResizeCorrection, ResizeActive, TitleZoneCorrection, TitleZoneActive } from '../nodes/CanvasNode';

export function useDragCorrections({ setNodes, setEdges, isInteractionRef, getIntersectingNodes, takeSnapshot }) {
  const resizeDragActiveRef    = useRef(new Set());
  const titleZoneDragActiveRef = useRef(new Set());

  const onNodeDragStart = useCallback((e, node) => {
    EventLogger.log(`rf-drag-start id=${node.id} type=${node.type} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);
    
    if (isInteractionRef) isInteractionRef.current = true;

    // Tag this RF drag as resize-initiated if a resize is currently active.
    if (ResizeActive.has(node.id)) {
      resizeDragActiveRef.current.add(node.id);
    }
    // Tag as title-zone-initiated if a title-zone press is currently active.
    if (TitleZoneActive.has(node.id)) {
      titleZoneDragActiveRef.current.add(node.id);
    }
  }, [isInteractionRef]);

  const onNodeDragStop = useCallback((e, node) => {
    EventLogger.log(`rf-drag-stop id=${node.id} x=${node.position.x.toFixed(1)} y=${node.position.y.toFixed(1)}`);
    
    if (isInteractionRef) isInteractionRef.current = false;

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

    // Check if the node was dropped inside a group (nested canvas)
    // Only standard nodes (no groups) are absorbed, to prevent deep recursion complexities.
    if (!wasResizeDrag && !wasTitleZoneDrag && node.type !== 'group' && node.type !== 'jobhub' && node.type !== 'sellhub') {
      if (getIntersectingNodes) {
        const intersections = getIntersectingNodes(node);
        const targetGroup = intersections.find(n => n.type === 'group' && !n.data?.locked);
        if (targetGroup) {
          if (takeSnapshot) takeSnapshot();
          setNodes(nds => {
            const draggedNode = nds.find(n => n.id === node.id);
            if (!draggedNode) return nds;

            // Offset the node's position relative to the nested canvas center
            const dims = getNodeDims(targetGroup);
            const cx = dims.w / 2;
            const cy = dims.h / 2;
            const nestedPos = { x: draggedNode.position.x - targetGroup.position.x - cx + 100, y: draggedNode.position.y - targetGroup.position.y - cy  + 100 };
            
            const newNodeState = { ...draggedNode, position: nestedPos };

            const newNds = nds.filter(n => n.id !== node.id).map(n => {
              if (n.id === targetGroup.id) {
                const canvasData = n.data?.canvasData || { nodes: [], edges: [], drawings: [] };
                return {
                  ...n,
                  data: {
                    ...n.data,
                    canvasData: {
                      ...canvasData,
                      nodes: [...(canvasData.nodes || []), newNodeState]
                    }
                  }
                };
              }
              return n;
            });
            return newNds;
          });
          
          if (setEdges) {
            setEdges(eds => eds.filter(e => e.source !== node.id && e.target !== node.id));
          }
          EventLogger.log(`Absorbed node ${node.id} into group ${targetGroup.id}`);
        }
      }
    }
  }, [setNodes, setEdges, isInteractionRef, getIntersectingNodes, takeSnapshot]);

  return { onNodeDragStart, onNodeDragStop };
}
