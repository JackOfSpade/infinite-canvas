import { useState, useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { EventLogger } from '../utils/EventLogger';
import { NODE_FACTORIES } from '../utils/nodeFactory';
import { useToast } from '../components/ToastProvider';
import { getNodeDims } from '../utils/constants';

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
export function reassignCanvasDataIDs(node) {
  if (node.type !== 'group' || !node.data?.canvasData) return node;

  const idMap = new Map();
  const getMappedId = (oldId) => {
    if (!idMap.has(oldId)) idMap.set(oldId, crypto.randomUUID());
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
      id: crypto.randomUUID(),
      source: idMap.has(e.source) ? idMap.get(e.source) : e.source,
      target: idMap.has(e.target) ? idMap.get(e.target) : e.target,
    }));
    const newDrawings = (canvasData.drawings || []).map(d => d.id ? { ...d, id: crypto.randomUUID() } : d);
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
  depth,
  updateGlobal
}) {
  const [menu, setMenu] = useState(null);
  const reactFlow = useReactFlow();
  const { deleteElements, getEdges } = reactFlow;
  const { addToast } = useToast();

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
    
    // Default to just the clicked node
    let nodesToDuplicate = [menu.node];
    
    // If the clicked node is part of the current selection, duplicate all selected nodes
    const selectedNodes = reactFlow.getNodes().filter(n => n.selected);
    if (selectedNodes.find(n => n.id === menu.node.id)) {
      nodesToDuplicate = selectedNodes;
    }

    const oldIdToNewId = new Map();
    const newNodes = nodesToDuplicate.map(original => {
      let clonedOriginal;
      try {
        clonedOriginal = structuredClone(original);
      } catch {
        console.warn("structuredClone failed during duplicateNode, falling back to JSON");
        clonedOriginal = JSON.parse(JSON.stringify(original));
      }

      let clone = {
        ...clonedOriginal,
        id: crypto.randomUUID(),
        position: { x: original.position.x + 40, y: original.position.y + 40 },
        selected: true,
      };
      
      oldIdToNewId.set(original.id, clone.id);
      clone = reassignCanvasDataIDs(clone);
      // Clear isNew flag on duplicated nodes so they don't auto-enter edit mode
      if (clone.data) clone.data.isNew = false;
      // Don't carry over lock state — the clone should be freely editable
      if (clone.data?.locked) {
        clone.data.locked = false;
        delete clone.draggable;
        delete clone.deletable;
      }

      // Sanitize transient AI/Scraping states so the clone doesn't get stuck waiting for an IPC it didn't launch
      if (clone.data?.hubState) {
        const state = clone.data.hubState;
        if (['parsing', 'querying', 'searching', 'scoring', 'analyzing'].includes(state)) {
          clone.data.hubState = 'empty';
        } else if (state === 'researching') {
          clone.data.hubState = 'draft';
        }
      }
      return clone;
    });

    // Duplicate internal spanning edges
    const newEdges = [];
    reactFlow.getEdges().forEach(eEdge => {
      if (oldIdToNewId.has(eEdge.source) && oldIdToNewId.has(eEdge.target)) {
        newEdges.push({
          ...eEdge,
          id: crypto.randomUUID(),
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
      reactFlow.setEdges(eds => {
        const unselected = eds.map(edge => ({ ...edge, selected: false }));
        return unselected.concat(newEdges);
      });
    }

    EventLogger.log(`Duplicated ${newNodes.length} nodes via context menu`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot, reactFlow]);

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
      const targets = nds.filter(n => {
        if (n.data?.locked) return false;
        return onlySelected ? n.selected : true;
      });
      
      if (targets.length === 0) return nds;

      const parentGroups = {};
      targets.forEach(n => {
        const key = n.parentId || 'ROOT';
        if (!parentGroups[key]) parentGroups[key] = [];
        parentGroups[key].push(n);
      });

      const newPositions = {};

      Object.values(parentGroups).forEach(group => {
        const sorted = [...group].sort((a, b) => {
          if (Math.abs(a.position.y - b.position.y) > 100) return a.position.y - b.position.y;
          return a.position.x - b.position.x;
        });

        const cols = Math.ceil(Math.sqrt(group.length));
        const rows = Math.ceil(group.length / cols);
        const gutter = 40;

        const colWidths = new Array(cols).fill(0);
        const rowHeights = new Array(rows).fill(0);

        sorted.forEach((n, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const { w, h } = getNodeDims(n);
          colWidths[col] = Math.max(colWidths[col], w);
          rowHeights[row] = Math.max(rowHeights[row], h);
        });

        const colOffsets = new Array(cols).fill(0);
        const rowOffsets = new Array(rows).fill(0);
        for (let i = 1; i < cols; i++) colOffsets[i] = colOffsets[i - 1] + colWidths[i - 1] + gutter;
        for (let i = 1; i < rows; i++) rowOffsets[i] = rowOffsets[i - 1] + rowHeights[i - 1] + gutter;

        let anchorX = Infinity;
        let anchorY = Infinity;
        sorted.forEach(n => {
          anchorX = Math.min(anchorX, n.position.x);
          anchorY = Math.min(anchorY, n.position.y);
        });

        sorted.forEach((n, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          newPositions[n.id] = {
            x: anchorX + colOffsets[col],
            y: anchorY + rowOffsets[row]
          };
        });
      });

      return nds.map(n => {
        if (newPositions[n.id]) {
          return {
            ...n,
            position: newPositions[n.id]
          };
        }
        return n;
      });
    });
    EventLogger.log(`Tidied ${onlySelected ? 'selected' : 'all'} nodes with dynamic layout`);
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
      // Guard: node may have been deleted while the AI call was in-flight
      if (res.success) {
        if (updateGlobal) {
          updateGlobal(nodeId, { text: res.text });
        } else {
          setNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, text: res.text } } : n));
        }
        EventLogger.log(`AI polished text for node ${nodeId}`);
      } else {
        addToast({ title: 'AI Polish Failed', description: res.error, type: 'error' });
        EventLogger.log("AI Polish failed: " + res.error);
      }
    } catch (err) {
      console.error('[ContextMenu] AI polish crashed:', err);
      EventLogger.log("AI Polish crashed: " + (err?.message || String(err)));
    }
    setMenu(null);
  }, [menu, setNodes, takeSnapshot, addToast, updateGlobal]);

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
        return { 
          ...n, 
          data: { 
            ...n.data, 
            isSticky: !isCurrentlySticky,
            backgroundColor: !isCurrentlySticky ? (n.data?.backgroundColor === 'transparent' || !n.data?.backgroundColor ? '#fde047' : n.data?.backgroundColor) : 'transparent'
          } 
        };
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
      const isDocument = menu.node.type === 'document';
      const isSticky = isText && !!menu.node.data?.isSticky;
      const isLocked = menu.node.data?.locked;
      const supportsColor = isText || isLink || isGroup || isDocument;

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

      // Node Color supports text, link, group, document, and sticky notes
      if (supportsColor) {
        items.push({ divider: true });
        items.push({
          label: isSticky ? 'Sticky Note Color' : 'Node Color',
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
