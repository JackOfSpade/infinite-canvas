import { useCallback } from 'react';
import { addEdge } from '@xyflow/react';
import { v4 as uuidv4 } from 'uuid';
import { setupDragGhost, setupCanvasDragGhost } from '../utils/dragUtils';
import { EDGE_STYLE } from '../utils/constants';

export function useCanvasActions({
  nodes,
  edges,
  setNodes,
  setEdges,
  setDrawings,
  setCurrentFile,
  setHasUnsavedChanges,
  takeSnapshot,
  requestClearConfirm,
}) {
  const onConnect = useCallback((params) => {
    takeSnapshot();
    setEdges((eds) => addEdge({ ...params, animated: true, style: EDGE_STYLE }, eds));
  }, [setEdges, takeSnapshot]);

  const onDragStart = useCallback((e, type) => {
    e.dataTransfer.setData('app/node-type', type);
    e.dataTransfer.effectAllowed = 'copy';
    if (type === 'group') {
      setupCanvasDragGhost(e);
    } else {
      setupDragGhost(e, type === 'text' ? 'text' : 'link', type === 'text' ? 'rgba(255, 255, 255, 0.9)' : 'rgb(96, 165, 250)');
    }
  }, []);

  const addGroupNode = useCallback(() => {
    const selectedNodes = nodes.filter(n => n.selected);
    if (selectedNodes.length === 0) return; // No selection — do nothing (placement mode handles empty creation)
    
    const items = selectedNodes.map(n => {
      if (n.type === 'document') return { id: n.id, type: 'document', filename: n.data.filename, filePath: n.data.filePath };
      if (n.type === 'text') return { id: n.id, type: 'document', filename: n.data.text || 'Text', filePath: null };
      if (n.type === 'group') return { id: n.id, type: 'group', title: n.data.title, items: n.data.items, collapsed: n.data.collapsed };
      return { id: n.id, type: 'document', filename: 'Unknown' };
    });
    
    // We keep type: 'group' internally for backwards compatibility of existing nodes, but it uses CanvasNode component
    const newGroup = { 
      id: uuidv4(), 
      type: 'group', 
      dragHandle: '.drag-handle', 
      style: { width: 320 }, 
      position: selectedNodes[0].position, 
      data: { title: 'Nested Group', items, collapsed: false } 
    };
    
    const remainingNodes = nodes.filter(n => !n.selected);
    const remainingIds = new Set([...remainingNodes.map(n => n.id), newGroup.id]);
    
    takeSnapshot();
    setNodes([...remainingNodes, newGroup]);
    setEdges(edges.filter(e => remainingIds.has(e.source) && remainingIds.has(e.target)));
  }, [nodes, edges, setNodes, setEdges, takeSnapshot]);

  const doClear = useCallback(() => {
    takeSnapshot();
    setNodes([]);
    setEdges([]);
    setDrawings([]);
    setCurrentFile(null);
    setHasUnsavedChanges(false);
  }, [takeSnapshot, setNodes, setEdges, setDrawings, setCurrentFile, setHasUnsavedChanges]);

  const clearCanvas = useCallback(() => {
    if (requestClearConfirm) {
      requestClearConfirm(doClear);
    } else {
      doClear();
    }
  }, [requestClearConfirm, doClear]);

  return { onConnect, onDragStart, addGroupNode, clearCanvas };
}
