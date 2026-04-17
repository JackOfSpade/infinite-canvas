import { useEffect } from 'react';

export function useCanvasKeyboardShortcuts({ 
  placementMode, setPlacementMode, 
  activeTool, setActiveTool, 
  setIsSettingsOpen,
  isAnimatingRef 
}) {
  useEffect(() => {
    const handleKey = (e) => {
      if (isAnimatingRef?.current) return;
      
      // Ignore if any modifier keys are pressed (to avoid colliding with OS/Browser shortcuts)
      // Exception: Escape is allowed to fire regardless of modifiers for emergency cancellation.
      if (e.key !== 'Escape' && (e.metaKey || e.ctrlKey || e.altKey)) return;

      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      
      if (e.key === 'Escape') {
        if (placementMode) { setPlacementMode(null); return; }
        if (activeTool)    { setActiveTool(null);    return; }
      }
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setIsSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [placementMode, activeTool, setPlacementMode, setActiveTool, setIsSettingsOpen, isAnimatingRef]);
}
