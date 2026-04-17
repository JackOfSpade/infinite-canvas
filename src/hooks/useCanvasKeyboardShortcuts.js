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
