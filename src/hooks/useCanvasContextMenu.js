import { useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { createTextNode, createLinkNode, createGroupNode } from '../utils/nodeFactory';

export function useCanvasContextMenu({
  isDrawingMode,
  placementMode,
  takeSnapshot,
  setNodes,
  setEdges,
  screenToFlowPosition,
  clearCanvas
}) {
  const [menu, setMenu] = useState(null);

  const onPaneContextMenuBase = useCallback((e) => {
    if (isDrawingMode || placementMode) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, type: 'pane' });
  }, [isDrawingMode, placementMode]);

  const onNodeContextMenuBase = useCallback((e, node) => {
    if (isDrawingMode || placementMode) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, type: 'node', node });
  }, [isDrawingMode, placementMode]);

  const bringToFront = useCallback(() => {
    if (!menu?.node) return;
    takeSnapshot();
    setNodes(nds => {
      const maxZ = Math.max(0, ...nds.map(n => n.zIndex || 0));
      return nds.map(n => n.id === menu.node.id ? { ...n, zIndex: maxZ + 1 } : n);
    });
    setMenu(null);
  }, [menu, setNodes, takeSnapshot]);

  const sendToBack = useCallback(() => {
    if (!menu?.node) return;
    takeSnapshot();
    setNodes(nds => {
      const minZ = Math.min(0, ...nds.map(n => n.zIndex || 0));
      return nds.map(n => n.id === menu.node.id ? { ...n, zIndex: minZ - 1 } : n);
    });
    setMenu(null);
  }, [menu, setNodes, takeSnapshot]);

  const spawnNode = useCallback((type) => {
    if (!menu) return;
    takeSnapshot();
    const pos = screenToFlowPosition({ x: menu.x, y: menu.y });
    pos.x -= 20;
    pos.y -= 20;
    if (type === 'text') setNodes(nds => nds.concat(createTextNode(pos)));
    if (type === 'link') setNodes(nds => nds.concat(createLinkNode(pos)));
    if (type === 'group') setNodes(nds => nds.concat(createGroupNode(pos)));
    setMenu(null);
  }, [menu, screenToFlowPosition, setNodes, takeSnapshot]);

  const duplicateNode = useCallback(() => {
    if (!menu?.node) return;
    takeSnapshot();
    const original = menu.node;
    const clone = {
      ...structuredClone(original),
      id: uuidv4(),
      position: { x: original.position.x + 40, y: original.position.y + 40 },
      selected: false,
    };
    // Clear isNew flag on duplicated nodes so they don't auto-enter edit mode
    if (clone.data) clone.data.isNew = false;
    setNodes(nds => nds.concat(clone));
    setMenu(null);
  }, [menu, setNodes, takeSnapshot]);

  const deleteSelectedNode = useCallback(() => {
    if (!menu?.node) return;
    takeSnapshot();
    setNodes(nds => nds.filter(n => n.id !== menu.node.id));
    setEdges(eds => eds.filter(e => e.source !== menu.node.id && e.target !== menu.node.id));
    setMenu(null);
  }, [menu, setNodes, setEdges, takeSnapshot]);

  const getContextMenuItems = useCallback(() => {
    if (!menu) return [];
    if (menu.type === 'pane') {
      return [
        { label: 'Add Text', onClick: () => spawnNode('text') },
        { label: 'Add Link', onClick: () => spawnNode('link') },
        { label: 'Add Nested Canvas', onClick: () => spawnNode('group') },
        { divider: true },
        { label: 'Clear Canvas', onClick: () => { clearCanvas(); setMenu(null); } },
      ];
    }
    if (menu.type === 'node') {
      return [
        { label: 'Duplicate', onClick: duplicateNode },
        { label: 'Bring to Front', onClick: bringToFront },
        { label: 'Send to Back', onClick: sendToBack },
        { divider: true },
        { label: 'Delete', onClick: deleteSelectedNode },
      ];
    }
    return [];
  }, [menu, spawnNode, duplicateNode, bringToFront, sendToBack, deleteSelectedNode, clearCanvas]);

  const closeMenu = useCallback(() => setMenu(null), []);

  return {
    menu,
    setMenu,
    closeMenu,
    onPaneContextMenuBase,
    onNodeContextMenuBase,
    getContextMenuItems
  };
}
