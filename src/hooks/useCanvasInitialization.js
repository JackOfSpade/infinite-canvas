import { useEffect, useRef } from 'react';
import { sanitizeNodesForSave } from './useCanvasPersistence';

export function useCanvasInitialization({
  nodes,
  edges,
  drawings,
  currentFile,
  setCurrentFile,
  hasUnsavedChanges,
  setHasUnsavedChanges,
  flushStack,
  isAnimatingRef,
}) {
  // Keep latest state in a ref so the auto-save timer reads current data
  // without the effect being torn down on every state change.
  const stateRef = useRef({ nodes, edges, drawings });

  useEffect(() => {
    stateRef.current = { nodes, edges, drawings };
  }, [nodes, edges, drawings]);

  const flushRef = useRef(flushStack);
  useEffect(() => { flushRef.current = flushStack; }, [flushStack]);

  // Mirror hasUnsavedChanges into a ref so the auto-save timer callback
  // can read the live value without the effect having it as a dependency.
  const hasUnsavedChangesRef = useRef(hasUnsavedChanges);
  useEffect(() => { hasUnsavedChangesRef.current = hasUnsavedChanges; }, [hasUnsavedChanges]);

  // Track hasUnsavedChanges internally when props change.
  // Skip the very first render where all collections are empty — that's the clean
  // initial mount before any workspace is loaded, not an actual edit.
  useEffect(() => {
    if (nodes.length === 0 && edges.length === 0 && drawings.length === 0) return;
    setHasUnsavedChanges(true);
  }, [nodes, edges, drawings, setHasUnsavedChanges]);

  // Auto-save: debounced 2-second timer that restarts whenever content or the
  // file path changes. Reads hasUnsavedChanges via ref so a successful save
  // (which flips the flag to false) doesn't reset the debounce unnecessarily.
  useEffect(() => {
    if (!currentFile || !window.electronAPI) return;

    const timer = setTimeout(() => {
      // Safety guard 1: never auto-save while navigation animations are active
      // as the stack/nodes state may be transient or intermediate.
      if (isAnimatingRef?.current) return;

      // Safety guard 2: don't save if there are no pending changes.
      // This specifically avoids redundant saves immediately after a workspace load.
      if (!hasUnsavedChangesRef.current) return;

      const rawData = flushRef.current ? flushRef.current() : stateRef.current;
      if (!rawData.nodes || !Array.isArray(rawData.nodes)) return;

      // Strip transient visual properties (e.g. source-filter opacity on job cards)
      const data = { ...rawData, nodes: sanitizeNodesForSave(rawData.nodes) };

      window.electronAPI.saveWorkspace({ data, filePath: currentFile }).then(res => {
        if (res?.success && res.filePath) {
          // Only update currentFile if the path changed (e.g. first save via dialog)
          if (res.filePath !== currentFile) setCurrentFile(res.filePath);
          setHasUnsavedChanges(false);
        }
      }).catch(err => console.error('[auto-save] saveWorkspace failed:', err));
    }, 2000);
    return () => clearTimeout(timer);
  }, [nodes, edges, drawings, currentFile, setCurrentFile, setHasUnsavedChanges, isAnimatingRef]);

}

