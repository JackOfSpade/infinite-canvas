import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';

export function useCanvasKeyboardShortcuts({
  placementMode, setPlacementMode, 
  activeTool, setActiveTool, 
  setIsSettingsOpen,
  isAnimatingRef,
  duplicateNodes
}) {
  const { getNodes } = useReactFlow();

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
        duplicateNodes(selectedNodes);
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
  }, [placementMode, activeTool, setPlacementMode, setActiveTool, setIsSettingsOpen, isAnimatingRef, getNodes, duplicateNodes]);
}
