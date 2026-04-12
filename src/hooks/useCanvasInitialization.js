import { useEffect, useRef } from 'react';

export function useCanvasInitialization({
  nodes,
  edges,
  drawings,
  currentFile,
  setCurrentFile,
  setHasUnsavedChanges,
  saveCanvas,
  loadCanvas
}) {
  // Track hasUnsavedChanges internally when props change
  useEffect(() => {
    if (nodes.length > 0 || edges.length > 0 || drawings.length > 0) {
      setHasUnsavedChanges(true);
    }
  }, [nodes, edges, drawings, setHasUnsavedChanges]);

  // Auto-save logic
  useEffect(() => {
    if (!currentFile || !window.electronAPI) return;
    const timer = setTimeout(() => {
      window.electronAPI.saveWorkspace({ data: { nodes, edges, drawings }, filePath: currentFile }).then(res => {
        if (res?.success && res.filePath) setCurrentFile(res.filePath);
      });
      setHasUnsavedChanges(false);
    }, 1000);
    return () => clearTimeout(timer);
  }, [nodes, edges, drawings, currentFile, setCurrentFile, setHasUnsavedChanges]);

  // Menu IPC — use refs to avoid stale closures in one-time mount effect
  const latestSave = useRef(saveCanvas);
  const latestLoad = useRef(loadCanvas);
  
  useEffect(() => { 
    latestSave.current = saveCanvas; 
    latestLoad.current = loadCanvas; 
  });
  
  useEffect(() => {
    if (!window.electronAPI) return;
    const cleanupSave = window.electronAPI.onMenuSave(() => latestSave.current());
    const cleanupOpen = window.electronAPI.onMenuOpen(() => latestLoad.current());
    return () => { cleanupSave(); cleanupOpen(); };
  }, []);
}
