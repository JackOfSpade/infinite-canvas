import { useState, useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { EventLogger } from '../utils/EventLogger';
import { NODE_FACTORIES } from '../utils/nodeFactory';
import { useToast } from '../components/ToastProvider';
import { getNodeDims } from '../utils/constants';

export function useCanvasContextMenu({
  placementMode,
  takeSnapshot,
  setNodes,
  screenToFlowPosition,
  clearCanvas,
  extractToParent,
  depth,
  updateGlobal,
  duplicateNodes,
  isAnimatingRef
}) {
  const [menu, setMenu] = useState(null);
  const reactFlow = useReactFlow();
  const { deleteElements } = reactFlow;
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
    if (isAnimatingRef?.current) return;
    if (!menu?.node) return;
    takeSnapshot();
    
    const selectedNodes = reactFlow.getNodes().filter(n => n.selected);
    let targetIds = [menu.node.id];
    if (selectedNodes.find(n => n.id === menu.node.id)) {
      targetIds = selectedNodes.map(n => n.id);
    }
    
    setNodes(nds => {
      const maxZ = nds.reduce((m, n) => Math.max(m, n.zIndex || 0), 0);
      return nds.map(n => targetIds.includes(n.id) ? { ...n, zIndex: maxZ + 1 } : n);
    });
    EventLogger.log(`Brought ${targetIds.length} nodes to front`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot, reactFlow, isAnimatingRef]);

  const sendToBack = useCallback(() => {
    if (isAnimatingRef?.current) return;
    if (!menu?.node) return;
    takeSnapshot();
    
    const selectedNodes = reactFlow.getNodes().filter(n => n.selected);
    let targetIds = [menu.node.id];
    if (selectedNodes.find(n => n.id === menu.node.id)) {
      targetIds = selectedNodes.map(n => n.id);
    }
    
    setNodes(nds => {
      const minZ = nds.reduce((m, n) => Math.min(m, n.zIndex || 0), 0);
      return nds.map(n => targetIds.includes(n.id) ? { ...n, zIndex: minZ - 1 } : n);
    });
    EventLogger.log(`Sent ${targetIds.length} nodes to back`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot, reactFlow, isAnimatingRef]);

  const spawnNode = useCallback((type) => {
    if (isAnimatingRef?.current) return;
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
    if (isAnimatingRef?.current) return;
    if (!menu?.node) return;
    
    // Default to just the clicked node
    let nodesToDuplicate = [menu.node];
    
    // If the clicked node is part of the current selection, duplicate all selected nodes
    const selectedNodes = reactFlow.getNodes().filter(n => n.selected);
    if (selectedNodes.find(n => n.id === menu.node.id)) {
      nodesToDuplicate = selectedNodes;
    }

    duplicateNodes(nodesToDuplicate);
    setMenu(null);
  }, [menu, duplicateNodes, reactFlow]);

  const deleteSelectedNode = useCallback(() => {
    if (isAnimatingRef?.current) return;
    if (!menu?.node) return;
    if (menu.node.data?.locked) return; // Button is disabled, but guard defensively
    takeSnapshot();
    
    const selectedNodes = reactFlow.getNodes().filter(n => n.selected);
    if (selectedNodes.find(n => n.id === menu.node.id)) {
      deleteElements({ nodes: selectedNodes.map(n => ({ id: n.id })) });
      EventLogger.log(`Deleted ${selectedNodes.length} selected nodes`);
    } else {
      deleteElements({ nodes: [{ id: menu.node.id }] });
      EventLogger.log(`Deleted node ${menu.node.id}`);
    }
    
    setMenu(null);
  }, [menu, deleteElements, takeSnapshot, reactFlow, isAnimatingRef]);

  const toggleLockNode = useCallback(() => {
    if (isAnimatingRef?.current) return;
    if (!menu?.node) return;
    takeSnapshot();
    
    const isLocked = !menu.node.data?.locked;
    const selectedNodes = reactFlow.getNodes().filter(n => n.selected);
    let targetIds = [menu.node.id];
    
    if (selectedNodes.find(n => n.id === menu.node.id)) {
      targetIds = selectedNodes.map(n => n.id);
    }

    setNodes(nds => nds.map(n => {
      if (targetIds.includes(n.id)) {
        return { 
          ...n, 
          draggable: !isLocked,
          deletable: !isLocked,
          data: { ...n.data, locked: isLocked } 
        };
      }
      return n;
    }));
    EventLogger.log(`Toggled lock (${isLocked}) for ${targetIds.length} nodes`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot, reactFlow, isAnimatingRef]);

  const tidyNodes = useCallback((onlySelected) => {
    if (isAnimatingRef?.current) return;
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
    if (isAnimatingRef?.current) return;
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
      
      // Guard: node may have been deleted while the AI call was in-flight.
      // If updateGlobal is available, we allow it to process because it checks the stack safely.
      if (!updateGlobal && !reactFlow.getNode(nodeId)) return;
      
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
      EventLogger.error('[ContextMenu] AI polish crashed:', err);
    }
    setMenu(null);
  }, [menu, setNodes, takeSnapshot, addToast, updateGlobal, reactFlow, isAnimatingRef]);

  const toggleStickyNote = useCallback(() => {
    if (isAnimatingRef?.current) return;
    if (!menu?.node) return;
    if (menu.node.data?.locked) return; // Cannot modify locked nodes
    takeSnapshot();
    
    const isCurrentlySticky = menu.node.data?.isSticky;
    const selectedNodes = reactFlow.getNodes().filter(n => n.selected);
    let targetIds = [menu.node.id];
    
    if (selectedNodes.find(n => n.id === menu.node.id)) {
      targetIds = selectedNodes.map(n => n.id);
    }

    setNodes(nds => nds.map(n => {
      // Don't apply to non-text/non-sticky compatible elements passively? 
      // Actually sticky note is meant for text nodes. We will just toggle the visual state for targeted nodes.
      if (targetIds.includes(n.id)) {
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
    EventLogger.log(`Toggled Sticky Note ${!isCurrentlySticky ? 'ON' : 'OFF'} for ${targetIds.length} nodes`);
    setMenu(null);
  }, [menu, setNodes, takeSnapshot, reactFlow, isAnimatingRef]);

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
        { label: 'Clear Canvas', danger: true, onClick: () => { clearCanvas(); setMenu(null); } },
      ];
    }
    if (menu.type === 'node') {
      const isText  = menu.node.type === 'text';
      const isLink  = menu.node.type === 'link';
      const isGroup = menu.node.type === 'group';
      const isDocument = menu.node.type === 'document';
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
            const selectedNodes = reactFlow.getNodes().filter(n => n.selected);
            let nodesToExtract = [menu.node];
            if (selectedNodes.find(n => n.id === menu.node.id)) {
              nodesToExtract = selectedNodes;
            }
            extractToParent(nodesToExtract.map(n => n.id));
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
          label: 'Customize',
          disabled: isLocked,
          onClick: isLocked ? undefined : () => {
            document.dispatchEvent(new CustomEvent(`edit-node-font-${menu.node.id}`));
            closeMenu();
          }
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
  }, [menu, spawnNode, duplicateNode, bringToFront, sendToBack, deleteSelectedNode, toggleLockNode, clearCanvas, tidyNodes, aiPolishText, toggleStickyNote, closeMenu, depth, extractToParent, reactFlow]);

  return {
    menu,
    closeMenu,
    onPaneContextMenuBase,
    onNodeContextMenuBase,
    getContextMenuItems
  };
}
