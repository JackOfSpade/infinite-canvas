import { useState, useCallback, useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import { EventLogger } from '../utils/EventLogger';
import { NODE_FACTORIES } from '../utils/nodeFactory';
import { useToast } from '../components/ToastProvider';
import { computeTidiedNodes } from '../utils/layoutUtils';
import { useIsMountedRef } from './useIsMountedRef';
import { nodeSupportsCustomization } from '../utils/nodeCustomization';

// Helper to determine if an action applies to a single clicked node or the entire selected group
const getTargetNodeIds = (reactFlow, menuNodeId) => {
  const selectedNodes = reactFlow.getNodes().filter(n => n.selected);
  if (selectedNodes.find(n => n.id === menuNodeId)) {
    return selectedNodes.map(n => n.id);
  }
  return [menuNodeId];
};

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
  const isMountedRef = useIsMountedRef();
  const { deleteElements } = reactFlow;
  const { addToast } = useToast();

  const onPaneContextMenuBase = useCallback((e) => {
    if (placementMode) return;
    // React Flow's zoom-pane fires onPaneContextMenu for any right-click that did
    // not pass through a `nopan` element. Draggable nodes carry `nopan`, but LOCKED
    // nodes (draggable:false) do not — so a right-click on a locked node also bubbles
    // here and would clobber the node menu that onNodeContextMenuBase opens. Bail when
    // the click landed on a node so the node menu (incl. Unlock Node) is preserved.
    if (e.target?.closest?.('.react-flow__node')) return;
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
    
    const targetIds = getTargetNodeIds(reactFlow, menu.node.id);
    
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
    
    const targetIds = getTargetNodeIds(reactFlow, menu.node.id);
    
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
  }, [menu, screenToFlowPosition, setNodes, takeSnapshot, isAnimatingRef]);

  const duplicateNode = useCallback(() => {
    if (isAnimatingRef?.current) return;
    if (!menu?.node) return;
    
    // If the clicked node is part of the current selection, duplicate all selected nodes
    const targetIds = getTargetNodeIds(reactFlow, menu.node.id);
    const nodesToDuplicate = reactFlow.getNodes().filter(n => targetIds.includes(n.id));

    duplicateNodes(nodesToDuplicate);
    setMenu(null);
  }, [menu, duplicateNodes, reactFlow, isAnimatingRef]);

  const deleteSelectedNode = useCallback(() => {
    if (isAnimatingRef?.current) return;
    if (!menu?.node) return;
    if (menu.node.data?.locked) return; // Button is disabled, but guard defensively
    takeSnapshot();
    
    const targetIds = getTargetNodeIds(reactFlow, menu.node.id);
    deleteElements({ nodes: targetIds.map(id => ({ id })) });
    EventLogger.log(`Deleted ${targetIds.length} nodes`);
    
    setMenu(null);
  }, [menu, deleteElements, takeSnapshot, reactFlow, isAnimatingRef]);

  const toggleLockNode = useCallback(() => {
    if (isAnimatingRef?.current) return;
    if (!menu?.node) return;
    takeSnapshot();
    
    const isLocked = !menu.node.data?.locked;
    const targetIds = getTargetNodeIds(reactFlow, menu.node.id);

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
    setNodes(nds => computeTidiedNodes(nds, onlySelected));
    EventLogger.log(`Tidied ${onlySelected ? 'selected' : 'all'} nodes with dynamic layout`);
    setMenu(null);
  }, [setNodes, takeSnapshot, isAnimatingRef]);

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
    
    // Immediately close menu to prevent double clicks and avoid unmount race conditions
    setMenu(null);
    
    try {
      const res = await window.electronAPI.aiPolishText(text);
      if (!isMountedRef.current) return;
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
      if (!isMountedRef.current) return;
    }
  }, [menu, setNodes, takeSnapshot, addToast, updateGlobal, isAnimatingRef, isMountedRef]);

  const toggleStickyNote = useCallback(() => {
    if (isAnimatingRef?.current) return;
    if (!menu?.node) return;
    if (menu.node.data?.locked) return; // Cannot modify locked nodes
    takeSnapshot();
    
    const isCurrentlySticky = menu.node.data?.isSticky;
    const targetIds = getTargetNodeIds(reactFlow, menu.node.id);

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

  // useMemo: computes a value (items array) for the current menu state.
  // useCallback would be semantically incorrect here since we're not stabilizing
  // a function identity for event handlers — we're deriving a rendered value.
  //
  /* eslint-disable react-hooks/refs */
  // The callbacks below (bringToFront, aiPolishText, etc.) hold closures that reference
  // isAnimatingRef?.current, but they are only invoked on user interaction (onClick),
  // never during render. This is a false-positive from the v7 rule's ref-propagation tracking.
  const contextMenuItems = useMemo(() => {
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
      const isText     = menu.node.type === 'text';
      const isLink     = menu.node.type === 'link';
      const isMarketplaceCard = menu.node.type === 'marketplacecard';
      const isLocked   = menu.node.data?.locked;
      const supportsCustomize = nodeSupportsCustomization(menu.node.type);

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
            const targetIds = getTargetNodeIds(reactFlow, menu.node.id);
            extractToParent(targetIds);
            setMenu(null);
          }
        });
      }

      items.push({ label: 'Bring to Front', onClick: bringToFront, disabled: isLocked });
      items.push({ label: 'Send to Back',   onClick: sendToBack,   disabled: isLocked });

      if (supportsCustomize) {
        items.push({ divider: true });
        items.push({
          label: 'Customize',
          disabled: isLocked && !isMarketplaceCard,
          onClick: isLocked && !isMarketplaceCard ? undefined : () => {
            const targetIds = isMarketplaceCard ? [menu.node.id] : getTargetNodeIds(reactFlow, menu.node.id);
            document.dispatchEvent(new CustomEvent('open-multi-customize', { detail: { ids: targetIds } }));
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
  /* eslint-enable react-hooks/refs */

  return {
    menu,
    closeMenu,
    onPaneContextMenuBase,
    onNodeContextMenuBase,
    contextMenuItems,
  };
}
