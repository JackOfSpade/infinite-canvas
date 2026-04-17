import { useEffect, useRef } from 'react';
import { sanitizeNodesForSave } from './useCanvasPersistence';

export function useCanvasInitialization({
  nodes,
  edges,
  drawings,
  currentFile,
  setCurrentFile,
  setHasUnsavedChanges,
  saveCanvas,
  loadCanvas,
  flushStack,
  isAnimatingRef,
}) {
  // Keep latest state in a ref so the auto-save timer reads current data
  // without the effect being torn down on every state change.
  const stateRef = useRef({ nodes, edges, drawings });
  const isMountedRef = useRef(true);
  
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    stateRef.current = { nodes, edges, drawings };
  }, [nodes, edges, drawings]);

  const flushRef = useRef(flushStack);
  useEffect(() => { flushRef.current = flushStack; }, [flushStack]);

  // Track hasUnsavedChanges internally when props change
  useEffect(() => {
    if (nodes.length > 0 || edges.length > 0 || drawings.length > 0) {
      setHasUnsavedChanges(true);
    }
  }, [nodes, edges, drawings, setHasUnsavedChanges]);

  // Auto-save: debounced timer only recreated when the file path changes.
  // Uses flushStack to capture nested canvas data.
  useEffect(() => {
    if (!currentFile || !window.electronAPI) return;

    const timer = setTimeout(() => {
      // Safety guard: never auto-save while navigation animations are active 
      // as the stack/nodes state may be transient or intermediate.
      if (isAnimatingRef?.current) return;
      
      const rawData = flushRef.current ? flushRef.current() : stateRef.current;
      if (!rawData.nodes || !Array.isArray(rawData.nodes)) return;

      // Strip transient visual properties (e.g. source-filter opacity on job cards)
      const data = { ...rawData, nodes: sanitizeNodesForSave(rawData.nodes) };
      
      window.electronAPI.saveWorkspace({ data, filePath: currentFile }).then(res => {
        if (!isMountedRef.current) return;
        if (res?.success && res.filePath) {
          // Only update currentFile if the path changed (e.g. first save via dialog)
          if (res.filePath !== currentFile) setCurrentFile(res.filePath);
          setHasUnsavedChanges(false);
        }
      }).catch(err => console.error('[auto-save] saveWorkspace failed:', err));
    }, 2000);
    return () => clearTimeout(timer);
  }, [nodes, edges, drawings, currentFile, setCurrentFile, setHasUnsavedChanges, isAnimatingRef]);

  const latestSave = useRef(saveCanvas);
  const latestLoad = useRef(loadCanvas);
  useEffect(() => {
    latestSave.current = saveCanvas;
    latestLoad.current = loadCanvas;
  }, [saveCanvas, loadCanvas]);
  useEffect(() => {
    if (!window.electronAPI) return;
    const cleanupSave = window.electronAPI.onMenuSave(() => latestSave.current());
    const cleanupOpen = window.electronAPI.onMenuOpen(() => latestLoad.current());
    return () => { cleanupSave(); cleanupOpen(); };
  }, []);
}
