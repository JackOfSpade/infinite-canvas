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
  // Keep latest state in a ref so the auto-save timer reads current data
  // without the effect being torn down on every state change.
  const stateRef = useRef({ nodes, edges, drawings });
  useEffect(() => {
    stateRef.current = { nodes, edges, drawings };
  }, [nodes, edges, drawings]);

  // Track hasUnsavedChanges internally when props change
  useEffect(() => {
    if (nodes.length > 0 || edges.length > 0 || drawings.length > 0) {
      setHasUnsavedChanges(true);
    }
  }, [nodes, edges, drawings, setHasUnsavedChanges]);

  // Auto-save: debounced timer only recreated when the file path changes.
  // Reads latest state from ref when actually saving.
  useEffect(() => {
    if (!currentFile || !window.electronAPI) return;

    const timer = setTimeout(() => {
      const { nodes: n, edges: e, drawings: d } = stateRef.current;
      window.electronAPI.saveWorkspace({ data: { nodes: n, edges: e, drawings: d }, filePath: currentFile }).then(res => {
        if (res?.success && res.filePath) setCurrentFile(res.filePath);
      });
      setHasUnsavedChanges(false);
    }, 2000);
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

