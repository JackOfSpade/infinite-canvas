import { useCallback } from 'react';
import { addEdge, useReactFlow } from '@xyflow/react';
import { setupDragGhost, setupCanvasDragGhost } from '../utils/dragUtils';
import { EDGE_STYLE, getNodesBounds } from '../utils/constants';
import { cloneNode, reassignCanvasDataIDs } from '../utils/nodeFactory';
import { EventLogger } from '../utils/EventLogger';
import { generateId } from '../utils/idGenerator';
import { cancelNodeTasksRecursively } from '../utils/canvasInteractions';

const CLIPBOARD_KEY = 'infinite-canvas-clipboard';
let applicationClipboardFallback = null;

export function useCanvasActions({
  setNodes,
  setEdges,
  setDrawings,
  drawings,
  setCurrentFile,
  setHasUnsavedChanges,
  takeSnapshot,
  requestClearConfirm,
  resetStack,
  depth,
  isAnimatingRef,
}) {
  const { getNodes, getEdges, setEdges: rfSetEdges, getViewport } = useReactFlow();

  const onConnect = useCallback((params) => {
    if (isAnimatingRef?.current) return;
    if (params.source === params.target) return;
    takeSnapshot();
    setEdges((eds) => addEdge({ ...params, animated: true, style: EDGE_STYLE }, eds));
  }, [setEdges, takeSnapshot, isAnimatingRef]);

  const onDragStart = useCallback((e, type) => {
    e.dataTransfer.setData('app/node-type', type);
    e.dataTransfer.effectAllowed = 'copy';
    if (type === 'group') {
      setupCanvasDragGhost(e);
    } else {
      setupDragGhost(e, type === 'text' ? 'text' : 'link', type === 'text' ? 'rgba(255, 255, 255, 0.9)' : 'rgb(96, 165, 250)');
    }
  }, []);

  const duplicateNodes = useCallback((nodesToDuplicate) => {
    if (isAnimatingRef?.current) return;
    if (!nodesToDuplicate || nodesToDuplicate.length === 0) return;
    takeSnapshot?.();
    
    const oldIdToNewId = new Map();
    const newNodes = nodesToDuplicate.map(original => {
      let clone = cloneNode(original);
      oldIdToNewId.set(original.id, clone.id);
      clone = reassignCanvasDataIDs(clone);
      return clone;
    });

    const newEdges = [];
    getEdges().forEach(eEdge => {
      if (oldIdToNewId.has(eEdge.source) && oldIdToNewId.has(eEdge.target)) {
        newEdges.push({
          ...eEdge,
          id: generateId(),
          source: oldIdToNewId.get(eEdge.source),
          target: oldIdToNewId.get(eEdge.target),
          selected: true,
        });
      }
    });

    setNodes(nds => {
      const unselected = nds.map(n => ({ ...n, selected: false }));
      return unselected.concat(newNodes);
    });
    
    if (newEdges.length > 0) {
      rfSetEdges(eds => {
        const unselected = eds.map(edge => ({ ...edge, selected: false }));
        return unselected.concat(newEdges);
      });
    }

    EventLogger.log(`Duplicated ${newNodes.length} nodes and ${newEdges.length} edges`);
  }, [takeSnapshot, getEdges, setNodes, rfSetEdges, isAnimatingRef]);

  const copyNodes = useCallback((nodesToCopy) => {
    if (isAnimatingRef?.current) return;
    if (!nodesToCopy || nodesToCopy.length === 0) return;
    const oldIds = new Set(nodesToCopy.map(n => n.id));
    const edgesToCopy = getEdges().filter(e => oldIds.has(e.source) && oldIds.has(e.target));
    
    // Find intersecting drawings perfectly bounded by the copied nodes selection box
    let drawingsToCopy = [];
    if (drawings && drawings.length > 0) {
      const { minX, maxX, minY, maxY } = getNodesBounds(nodesToCopy);
      drawingsToCopy = drawings.filter(d =>
        d.points.some(p => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)
      );
    }

    // Deep clone to prevent unintended reference mutations while in clipboard
    const clipboardData = {
      nodes: structuredClone(nodesToCopy),
      edges: structuredClone(edgesToCopy),
      drawings: structuredClone(drawingsToCopy)
    };

    try {
      localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clipboardData));
      applicationClipboardFallback = clipboardData; // Always update memory state safely
      EventLogger.log(`Copied ${nodesToCopy.length} nodes, ${edgesToCopy.length} edges, and ${drawingsToCopy.length} drawings to localStorage.`);
    } catch (e) {
      EventLogger.error('Failed to write to localStorage clipboard, using isolated memory fallback:', e);
      applicationClipboardFallback = clipboardData;
    }
  }, [getEdges, drawings, isAnimatingRef]);

  const pasteNodes = useCallback(() => {
    if (isAnimatingRef?.current) return;
    let clipboardData = applicationClipboardFallback;
    try {
      const dataStr = localStorage.getItem(CLIPBOARD_KEY);
      if (dataStr) {
        const parsed = JSON.parse(dataStr);
        // Only overwrite clipboard fallback if parsed representation is genuinely populated
        if (parsed && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
           clipboardData = parsed;
           applicationClipboardFallback = clipboardData; // Re-sync memory on successful parse
        }
      }
    } catch (e) {
      EventLogger.error('Failed to parse localStorage clipboard, utilizing isolated memory fallback:', e);
    }

    if (!clipboardData || !clipboardData.nodes || clipboardData.nodes.length === 0) return;
    takeSnapshot?.();

    const { x: vpx, y: vpy, zoom } = getViewport();
    const viewportNode = document.querySelector('.react-flow__viewport');
    const container = viewportNode?.parentElement;
    const flowWidth  = container ? container.clientWidth / zoom  : window.innerWidth / zoom;
    const flowHeight = container ? container.clientHeight / zoom : window.innerHeight / zoom;
    
    // Compute center of current viewport in flow coordinates
    const centerX = -vpx / zoom + flowWidth / 2;
    const centerY = -vpy / zoom + flowHeight / 2;

    // Compute bounding box of copied cluster to find its local center
    const { minX, maxX, minY, maxY } = getNodesBounds(clipboardData.nodes);
    const clusterCenterX = (minX + maxX) / 2;
    const clusterCenterY = (minY + maxY) / 2;

    const oldIdToNewId = new Map();
    const newNodes = clipboardData.nodes.map(original => {
      let clone = cloneNode(original, 0, 0); 
      oldIdToNewId.set(original.id, clone.id);
      clone = reassignCanvasDataIDs(clone);
      
      // Position relative to viewport center
      const offsetX = original.position.x - clusterCenterX;
      const offsetY = original.position.y - clusterCenterY;
      clone.position = { x: centerX + offsetX, y: centerY + offsetY };
      clone.selected = true;
      return clone;
    });

    const newEdges = (clipboardData.edges || [])
      .filter(eEdge => oldIdToNewId.has(eEdge.source) && oldIdToNewId.has(eEdge.target))
      .map(eEdge => ({
        ...eEdge,
        id: generateId(),
        source: oldIdToNewId.get(eEdge.source),
        target: oldIdToNewId.get(eEdge.target),
        selected: true,
      }));

    const newDrawings = (clipboardData.drawings || []).map(originalDrawing => {
      return {
        ...originalDrawing,
        id: generateId(),
        points: originalDrawing.points.map(p => ({
          x: centerX + (p.x - clusterCenterX),
          y: centerY + (p.y - clusterCenterY)
        }))
      };
    });

    setNodes(nds => {
      const unselected = nds.map(n => ({ ...n, selected: false }));
      return unselected.concat(newNodes);
    });

    if (newEdges.length > 0) {
      rfSetEdges(eds => {
        const unselected = eds.map(edge => ({ ...edge, selected: false }));
        return unselected.concat(newEdges);
      });
    }

    if (newDrawings.length > 0) {
      setDrawings(drws => drws.concat(newDrawings));
    }
    
    // Re-save pasted items into clipboard so consecutive pastes offset incrementally
    const nextClipboard = {
      nodes: newNodes.map(n => ({...n, selected: false})),
      edges: newEdges.map(e => ({...e, selected: false})),
      drawings: newDrawings
    };
    try {
      applicationClipboardFallback = nextClipboard;
      localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(nextClipboard));
    } catch {
      // Ignored clipboard update failure
    }

    EventLogger.log(`Pasted ${newNodes.length} nodes, ${newEdges.length} edges, and ${newDrawings.length} drawings from localStorage.`);
  }, [takeSnapshot, setNodes, rfSetEdges, setDrawings, isAnimatingRef, getViewport]);

  const doClear = useCallback(() => {
    if (isAnimatingRef?.current) return;
    takeSnapshot();

    // If we're nested, we only clear the current canvas level (this is fully undoable).
    // If we're at the root level, we also reset the file association because it's effectively a "New Workspace".
    if (depth === 0) {
      resetStack?.();
      setCurrentFile(null);
      setHasUnsavedChanges(false);
    }

    const allNodes = getNodes();
    const lockedNodes = allNodes.filter((n) => n.data?.locked);
    const lockedIds = new Set(lockedNodes.map((n) => n.id));

    // Cancel any active background tasks for nodes being removed
    if (window.electronAPI?.cancelNodeTask) {
      cancelNodeTasksRecursively(allNodes, lockedIds);
    }

    setNodes(lockedNodes);
    setEdges(allEdges => allEdges.filter(
      (e) => lockedIds.has(e.source) && lockedIds.has(e.target)
    ));
    setDrawings([]);
  }, [takeSnapshot, resetStack, depth, getNodes, setNodes, setEdges, setDrawings, setCurrentFile, setHasUnsavedChanges, isAnimatingRef]);

  const clearCanvas = useCallback(() => {
    if (requestClearConfirm) {
      requestClearConfirm(doClear);
    } else {
      doClear();
    }
  }, [requestClearConfirm, doClear]);

  return { onConnect, onDragStart, clearCanvas, duplicateNodes, copyNodes, pasteNodes };
}
