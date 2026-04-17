import { useState, useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { v4 as uuidv4 } from 'uuid';
import { EventLogger } from '../utils/EventLogger';
import { NODE_FACTORIES } from '../utils/nodeFactory';
import { useToast } from '../components/ToastProvider';

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

/**
 * Recursively remaps all node, edge, and drawing IDs inside a duplicated group's canvasData
 * to prevent ID collisions if identical child nodes are later extracted to a shared parent.
 * Pure function — returns a new object tree; does not mutate the input.
 */
function reassignCanvasDataIDs(node) {
  if (node.type !== 'group' || !node.data?.canvasData) return node;

  const idMap = new Map();
  const getMappedId = (oldId) => {
    if (!idMap.has(oldId)) idMap.set(oldId, uuidv4());
    return idMap.get(oldId);
  };

  const processCanvasData = (canvasData) => {
    if (!canvasData) return canvasData;
    const newNodes = (canvasData.nodes || []).map(n => {
      const newNode = { ...n, id: getMappedId(n.id) };
      if (newNode.type === 'group' && newNode.data?.canvasData) {
        newNode.data = { ...newNode.data, canvasData: processCanvasData(newNode.data.canvasData) };
      }
      return newNode;
    });
    const newEdges = (canvasData.edges || []).map(e => ({
      ...e,
      id: uuidv4(),
      source: idMap.has(e.source) ? idMap.get(e.source) : e.source,
      target: idMap.has(e.target) ? idMap.get(e.target) : e.target,
    }));
    const newDrawings = (canvasData.drawings || []).map(d => d.id ? { ...d, id: uuidv4() } : d);
    return { nodes: newNodes, edges: newEdges, drawings: newDrawings };
  };

  return {
    ...node,
    data: {
      ...node.data,
      canvasData: processCanvasData(node.data.canvasData),
    },
  };
}

export function useCanvasContextMenu({
  placementMode,
  takeSnapshot,
  setNodes,
  screenToFlowPosition,
  clearCanvas,
  extractToParent,
  depth
}) {
  const [menu, setMenu] = useState(null);
  const reactFlow = useReactFlow();
  const { deleteElements, getEdges, getNode } = reactFlow;
  const { addToast } = useToast();
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const onPaneContextMenuBase = useCallback((e) => {
    if (placementMode) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, type: 'pane' });
  }, [placementMode]);

  const onNodeContextMenuBase = useCallback((e, node) => {
    if (placementMode) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, type: 'node', node });
  }, [placementMode]);

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
    let clone = {
      ...structuredClone(original),
      id: uuidv4(),
      position: { x: original.position.x + 40, y: original.position.y + 40 },
      selected: false,
    };
    clone = reassignCanvasDataIDs(clone);
    // Clear isNew flag on duplicated nodes so they don't auto-enter edit mode
    if (clone.data) clone.data.isNew = false;
    // Don't carry over lock state — the clone should be freely editable
    if (clone.data?.locked) {
      clone.data.locked = false;
      delete clone.draggable;
      delete clone.deletable;
    }
    setNodes(nds => nds.concat(clone));
    EventLogger.log(`Duplicated node ${original.id}`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot]);

  const deleteSelectedNode = useCallback(() => {
    if (!menu?.node) return;
    if (menu.node.data?.locked) return; // Button is disabled, but guard defensively
    takeSnapshot();
    deleteElements({ nodes: [{ id: menu.node.id }] });
    EventLogger.log(`Deleted node ${menu.node.id}`);
    setMenu(null);
  }, [menu, deleteElements, takeSnapshot]);

  const toggleLockNode = useCallback(() => {
    if (!menu?.node) return;
    takeSnapshot();
    const isLocked = !menu.node.data?.locked;
    setNodes(nds => nds.map(n => {
      if (n.id === menu.node.id) {
        return { 
          ...n, 
          draggable: !isLocked,
          deletable: !isLocked,
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
    if (menu.node.data?.locked) return; // Cannot modify locked nodes
    takeSnapshot();
    setNodes(nds => nds.map(n => n.id === menu.node.id ? { ...n, data: { ...n.data, backgroundColor: color } } : n));
    EventLogger.log(`Node ${menu.node.id} color changed`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot]);

  const tidyNodes = useCallback((onlySelected) => {
    takeSnapshot();
    setNodes(nds => {
      // Filter out locked nodes from being tidied
      const targets = nds.filter(n => {
        if (n.data?.locked) return false;
        return onlySelected ? n.selected : true;
      });
      
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
        if (idx === -1) return n; // Keep unchanged (including locked nodes)
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
    if (menu.node.data?.locked) return; // Cannot modify locked nodes
    const text = menu.node.data?.text || '';
    if (!text.trim()) {
       setMenu(null);
       return;
    }
    takeSnapshot();
    const nodeId = menu.node.id;
    try {
      const res = await window.electronAPI.aiPolishText(text);
      if (!isMountedRef.current) return;
      // Guard: node may have been deleted while the AI call was in-flight
      if (!getNode(nodeId)) {
        EventLogger.log(`AI Polish complete but node ${nodeId} no longer exists — discarding`);
        setMenu(null);
        return;
      }
      if (res.success) {
        setNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, text: res.text } } : n));
        EventLogger.log(`AI polished text for node ${nodeId}`);
      } else {
        addToast({ title: 'AI Polish Failed', description: res.error, type: 'error' });
        EventLogger.log("AI Polish failed: " + res.error);
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      console.error(err);
      EventLogger.log("AI Polish crashed: " + (err?.message || String(err)));
    }
    setMenu(null);
  }, [menu, setNodes, takeSnapshot, addToast, getNode]);

  const toggleStickyNote = useCallback(() => {
    if (!menu?.node) return;
    if (menu.node.data?.locked) return; // Cannot modify locked nodes
    takeSnapshot();
    const isCurrentlySticky = menu.node.data?.isSticky;
    
    // If it's becoming sticky, we must sever any incoming edges to honor the "no edges TO sticky notes" rule
    if (!isCurrentlySticky) {
      const allEdges = getEdges();
      const incomingEdges = allEdges.filter(e => e.target === menu.node.id);
      if (incomingEdges.length > 0) {
        deleteElements({ edges: incomingEdges.map(e => ({ id: e.id })) });
      }
    }

    setNodes(nds => nds.map(n => {
      if (n.id === menu.node.id) {
        return { ...n, data: { ...n.data, isSticky: !isCurrentlySticky } };
      }
      return n;
    }));
    EventLogger.log(`Toggled Sticky Note ${!isCurrentlySticky ? 'ON' : 'OFF'} for node ${menu.node.id}`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot, deleteElements, getEdges]);

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
      const isText  = menu.node.type === 'text';
      const isLink  = menu.node.type === 'link';
      const isGroup = menu.node.type === 'group';
      const isSticky = isText && !!menu.node.data?.isSticky;
      const isLocked = menu.node.data?.locked;

      const items = [];

      items.push({
        label: isLocked ? 'Unlock Node' : 'Lock Node',
        onClick: toggleLockNode,
      });

      items.push({ divider: true });
      items.push({ label: 'Duplicate', onClick: duplicateNode });
      
      if (depth > 0) {
        items.push({ 
          label: 'Move to Parent Canvas', 
          disabled: isLocked,
          onClick: () => {
            takeSnapshot();
            extractToParent(menu.node.id);
            setMenu(null);
          } 
        });
      }
      
      items.push({ label: 'Bring to Front', onClick: bringToFront, disabled: isLocked });
      items.push({ label: 'Send to Back', onClick: sendToBack, disabled: isLocked });

      // "Sticky Note Color" only appears when right-clicking a sticky text node
      if (isSticky) {
        items.push({ divider: true });
        items.push({
          label: 'Sticky Note Color',
          disabled: isLocked,
          submenu: isLocked ? undefined : NODE_COLORS.map(c => ({
            label: c.label,
            onClick: () => setNodeColor(c.value),
          })),
        });
      }

      if (isLink) {
        items.push({ divider: true });
        items.push({ 
          label: 'Edit URL', 
          disabled: isLocked,
          onClick: isLocked ? undefined : () => {
            document.dispatchEvent(new CustomEvent(`edit-node-url-${menu.node.id}`));
            closeMenu();
          } 
        });
      }

      if (isText || isLink || isGroup) {
        if (!isLink && !isSticky) items.push({ divider: true });
        items.push({
          label: 'Font & Size',
          disabled: isLocked,
          onClick: isLocked ? undefined : () => {
            document.dispatchEvent(new CustomEvent(`edit-node-font-${menu.node.id}`));
            closeMenu();
          }
        });
      }

      if (isText) {
        items.push({ divider: true });
        items.push({ label: '✨ AI Polish Text', onClick: aiPolishText, disabled: isLocked });
        items.push({ label: menu.node.data?.isSticky ? 'Remove Sticky Style' : 'Make Sticky Note', onClick: toggleStickyNote, disabled: isLocked });
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, spawnNode, duplicateNode, bringToFront, sendToBack, deleteSelectedNode, toggleLockNode, setNodeColor, clearCanvas, tidyNodes, aiPolishText, toggleStickyNote, closeMenu, depth, extractToParent]);

  return {
    menu,
    closeMenu,
    onPaneContextMenuBase,
    onNodeContextMenuBase,
    getContextMenuItems
  };
}
