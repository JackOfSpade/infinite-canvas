import { useState, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { EventLogger } from '../utils/EventLogger';
import { NODE_FACTORIES } from '../utils/nodeFactory';

/** Static color choices for the node color submenu. */
const NODE_COLORS = [
  { label: '🔴 Red', value: 'rgba(239, 68, 68, 0.2)' },
  { label: '🟠 Orange', value: 'rgba(249, 115, 22, 0.2)' },
  { label: '🟡 Yellow', value: 'rgba(234, 179, 8, 0.2)' },
  { label: '🟢 Green', value: 'rgba(34, 197, 94, 0.2)' },
  { label: '🔵 Blue', value: 'rgba(59, 130, 246, 0.2)' },
  { label: '🟣 Purple', value: 'rgba(168, 85, 247, 0.2)' },
  { label: '⚫️ Clear', value: null },
];

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
    EventLogger.log(`Node ${menu.node.id} brought to front`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot]);

  const sendToBack = useCallback(() => {
    if (!menu?.node) return;
    takeSnapshot();
    setNodes(nds => {
      const minZ = Math.min(0, ...nds.map(n => n.zIndex || 0));
      return nds.map(n => n.id === menu.node.id ? { ...n, zIndex: minZ - 1 } : n);
    });
    EventLogger.log(`Node ${menu.node.id} sent to back`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot]);

  const spawnNode = useCallback((type) => {
    if (!menu) return;
    const factory = NODE_FACTORIES[type];
    if (!factory) return;
    takeSnapshot();
    const pos = screenToFlowPosition({ x: menu.x, y: menu.y });
    pos.x -= 20;
    pos.y -= 20;
    setNodes(nds => nds.concat(factory(pos)));
    EventLogger.log(`Spawned node of type ${type}`);
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
    EventLogger.log(`Duplicated node ${original.id}`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot]);

  const deleteSelectedNode = useCallback(() => {
    if (!menu?.node) return;
    if (menu.node.data?.locked) {
      alert("Cannot delete a locked node. Unlock it first.");
      return;
    }
    takeSnapshot();
    setNodes(nds => nds.filter(n => n.id !== menu.node.id));
    setEdges(eds => eds.filter(e => e.source !== menu.node.id && e.target !== menu.node.id));
    EventLogger.log(`Deleted node ${menu.node.id}`);
    setMenu(null);
  }, [menu, setNodes, setEdges, takeSnapshot]);

  const toggleLockNode = useCallback(() => {
    if (!menu?.node) return;
    takeSnapshot();
    const isLocked = !menu.node.data?.locked;
    setNodes(nds => nds.map(n => {
      if (n.id === menu.node.id) {
        return { 
          ...n, 
          draggable: !isLocked,
          data: { ...n.data, locked: isLocked } 
        };
      }
      return n;
    }));
    EventLogger.log(`Node ${menu.node.id} ${isLocked ? 'locked' : 'unlocked'}`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot]);

  const setNodeColor = useCallback((color) => {
    if (!menu?.node) return;
    takeSnapshot();
    setNodes(nds => nds.map(n => n.id === menu.node.id ? { ...n, data: { ...n.data, backgroundColor: color } } : n));
    EventLogger.log(`Node ${menu.node.id} color changed`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot]);

  const tidyNodes = useCallback((onlySelected) => {
    takeSnapshot();
    setNodes(nds => {
      const targets = onlySelected ? nds.filter(n => n.selected) : nds;
      if (targets.length === 0) return nds;

      // Sort by approx Y, then X
      const sorted = [...targets].sort((a, b) => {
        if (Math.abs(a.position.y - b.position.y) > 100) return a.position.y - b.position.y;
        return a.position.x - b.position.x;
      });

      const cols = Math.ceil(Math.sqrt(targets.length));
      const anchorX = sorted[0]?.position.x || 0;
      const anchorY = sorted[0]?.position.y || 0;

      return nds.map(n => {
        const idx = sorted.findIndex(s => s.id === n.id);
        if (idx === -1) return n;
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        return {
          ...n,
          position: {
            x: anchorX + col * 350,
            y: anchorY + row * 250
          }
        };
      });
    });
    EventLogger.log(`Tidied ${onlySelected ? 'selected' : 'all'} nodes`);
    setMenu(null);
  }, [setNodes, takeSnapshot]);

  const aiPolishText = useCallback(async () => {
    if (!menu?.node || !window.electronAPI) return;
    const text = menu.node.data?.text || '';
    if (!text.trim()) {
       setMenu(null);
       return;
    }
    takeSnapshot();
    try {
      const res = await window.electronAPI.aiPolishText(text);
      if (res.success) {
        setNodes(nds => nds.map(n => n.id === menu.node.id ? { ...n, data: { ...n.data, text: res.text } } : n));
        EventLogger.log(`AI polished text for node ${menu.node.id}`);
      } else {
        alert("AI Polish failed: " + res.error);
        EventLogger.log("AI Polish failed: " + res.error);
      }
    } catch (err) {
      console.error(err);
      EventLogger.log("AI Polish crashed: " + err.message);
    }
    setMenu(null);
  }, [menu, setNodes, takeSnapshot]);

  const toggleStickyNote = useCallback(() => {
    if (!menu?.node) return;
    takeSnapshot();
    const isCurrentlySticky = menu.node.data?.isSticky;
    setNodes(nds => nds.map(n => {
      if (n.id === menu.node.id) {
        return { ...n, data: { ...n.data, isSticky: !isCurrentlySticky } };
      }
      return n;
    }));
    EventLogger.log(`Toggled Sticky Note ${!isCurrentlySticky ? 'ON' : 'OFF'} for node ${menu.node.id}`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot]);

  const closeMenu = useCallback(() => setMenu(null), []);

  const getContextMenuItems = useCallback(() => {
    if (!menu) return [];
    if (menu.type === 'pane') {
      return [
        { label: 'Add Text', onClick: () => spawnNode('text') },
        { label: 'Add Link', onClick: () => spawnNode('link') },
        { label: 'Add Nested Canvas', onClick: () => spawnNode('group') },
        { divider: true },
        { label: 'Tidy Canvas', onClick: () => tidyNodes(false) },
        { divider: true },
        { label: 'Clear Canvas', onClick: () => { clearCanvas(); setMenu(null); } },
      ];
    }
    if (menu.type === 'node') {
      const isText = menu.node.type === 'text';
      const isLink = menu.node.type === 'link';
      const isLocked = menu.node.data?.locked;

      const items = [];

      items.push({
        label: isLocked ? 'Unlock Node' : 'Lock Node',
        onClick: toggleLockNode,
      });

      items.push({ divider: true });
      items.push({ label: 'Duplicate', onClick: duplicateNode });
      items.push({ label: 'Bring to Front', onClick: bringToFront });
      items.push({ label: 'Send to Back', onClick: sendToBack });

      items.push({ divider: true });
      items.push({
        label: 'Color',
        submenu: NODE_COLORS.map(c => ({
          label: c.label,
          onClick: () => setNodeColor(c.value),
        })),
      });

      if (isLink) {
        items.push({ divider: true });
        items.push({ 
          label: 'Edit URL', 
          onClick: () => {
            document.dispatchEvent(new CustomEvent(`edit-node-url-${menu.node.id}`));
            closeMenu();
          } 
        });
      }

      if (isText || isLink) {
        if (!isLink) items.push({ divider: true });
        items.push({ 
          label: 'Font & Size', 
          onClick: () => {
            document.dispatchEvent(new CustomEvent(`edit-node-font-${menu.node.id}`));
            closeMenu();
          } 
        });
      }

      if (isText) {
        items.push({ divider: true });
        items.push({ label: '✨ AI Polish Text', onClick: aiPolishText });
        items.push({ label: menu.node.data?.isSticky ? 'Remove Sticky Style' : 'Make Sticky Note', onClick: toggleStickyNote });
      }

      items.push({ divider: true });
      items.push({ label: 'Tidy Selection', onClick: () => tidyNodes(true) });
      items.push({ divider: true });
      items.push({ 
        label: 'Delete', 
        onClick: deleteSelectedNode, 
        danger: true,
        disabled: isLocked 
      });

      return items;
    }
    return [];
  }, [menu, spawnNode, duplicateNode, bringToFront, sendToBack, deleteSelectedNode, toggleLockNode, setNodeColor, clearCanvas, tidyNodes, aiPolishText, toggleStickyNote, closeMenu]);

  return {
    menu,
    closeMenu,
    onPaneContextMenuBase,
    onNodeContextMenuBase,
    getContextMenuItems
  };
}
