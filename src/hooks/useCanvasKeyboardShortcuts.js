import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { EventLogger } from '../utils/EventLogger';
import { cloneNode, reassignCanvasDataIDs } from '../utils/nodeFactory';

export function useCanvasKeyboardShortcuts({

  placementMode, setPlacementMode, 
  activeTool, setActiveTool, 
  setIsSettingsOpen,
  isAnimatingRef,
  takeSnapshot
}) {
  const { getNodes, setNodes, getEdges, setEdges } = useReactFlow();

  useEffect(() => {
    const handleKey = (e) => {
      if (isAnimatingRef?.current) return;
      
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      const k = e.key.toLowerCase();

      // Duplicate shortcut
      if (k === 'd' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const selectedNodes = getNodes().filter(n => n.selected);
        if (selectedNodes.length === 0) return;

        takeSnapshot?.();
        
        const oldIdToNewId = new Map();
        const newNodes = selectedNodes.map(original => {
          let clone = cloneNode(original);
          oldIdToNewId.set(original.id, clone.id);
          clone = reassignCanvasDataIDs(clone);
          return clone;
        });

        // Duplicate internal spanning edges
        const newEdges = [];
        getEdges().forEach(eEdge => {
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
          setEdges(eds => {
            const unselected = eds.map(edge => ({ ...edge, selected: false }));
            return unselected.concat(newEdges);
          });
        }
        
        EventLogger.log(`Duplicated ${newNodes.length} nodes and ${newEdges.length} edges via shortcut`);
        return;
      }

      // Ignore if any modifier keys are pressed (to avoid colliding with OS/Browser shortcuts)
      // Exception: Escape is allowed to fire regardless of modifiers for emergency cancellation.
      if (e.key !== 'Escape' && (e.metaKey || e.ctrlKey || e.altKey)) return;

      if (e.key === 'Escape') {
        if (placementMode) { setPlacementMode(null); return; }
        if (activeTool)    { setActiveTool(null);    return; }
      }

      // Tool shortcuts (Text, Link)
      if (k === 't' || k === 'l') {
        e.preventDefault();
        setPlacementMode(k === 't' ? 'text' : 'link');
        setActiveTool(null);
        return;
      }

      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setIsSettingsOpen(true);
        return;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [placementMode, activeTool, setPlacementMode, setActiveTool, setIsSettingsOpen, isAnimatingRef, getNodes, setNodes, getEdges, setEdges, takeSnapshot]);
}
