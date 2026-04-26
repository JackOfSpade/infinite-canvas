import { useEffect, useRef } from 'react';
import { sanitizeNodesForSave } from '../utils/serializationUtils';
import { EventLogger } from '../utils/EventLogger';

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
  saveStateRef, // Ref to the active save state — prevents auto-save running concurrently with manual saves
}) {
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);

  // Keep latest state in a ref so the auto-save timer reads current data
  // without the effect being torn down on every state change.
  const stateRef = useRef({ nodes, edges, drawings });
  useEffect(() => {
    stateRef.current = { nodes, edges, drawings };
  }, [nodes, edges, drawings]);

  // Mirror flushStack and hasUnsavedChanges into refs so the auto-save timer
  // callback can read live values without being a dependency of the effect.
  const flushRef = useRef(flushStack);
  useEffect(() => { flushRef.current = flushStack; }, [flushStack]);

  const hasUnsavedChangesRef = useRef(hasUnsavedChanges);
  useEffect(() => { hasUnsavedChangesRef.current = hasUnsavedChanges; }, [hasUnsavedChanges]);

  // Mark the canvas dirty whenever content changes.
  // Skip the very first render where all collections are empty — that's the clean
  // initial mount before any workspace is loaded, not an actual user edit.
  // NOTE: setHasUnsavedChanges is a stable React state setter — omitting it from
  // the dep array is intentional; its identity never changes across renders.
  useEffect(() => {
    if (nodes.length === 0 && edges.length === 0 && drawings.length === 0) return;
    setHasUnsavedChanges(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, drawings]);

  // Auto-save: debounced 2-second timer that restarts whenever content or the
  // file path changes. Reads hasUnsavedChanges via ref so a successful save
  // (which flips the flag to false) doesn't reset the debounce unnecessarily.
  useEffect(() => {
    if (!currentFile || !window.electronAPI) return;

    let timer;
    const attemptSave = () => {
      // Safety guard 1: never auto-save while navigation animations are active
      // as the stack/nodes state may be transient or intermediate.
      if (isAnimatingRef?.current) {
        timer = setTimeout(attemptSave, 1000);
        return;
      }

      // Safety guard 2: don't save if a manual save (Cmd+S) is already in-progress.
      // Concurrent writes to the same file can cause partial-write corruption or OS lock conflicts.
      if (saveStateRef?.current && saveStateRef.current !== 'idle') {
        timer = setTimeout(attemptSave, 500);
        return;
      }

      // Safety guard 3: don't save if there are no pending changes.
      // This specifically avoids redundant saves immediately after a workspace load.
      if (!hasUnsavedChangesRef.current) return;

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
      }).catch(err => EventLogger.error('[auto-save] saveWorkspace failed:', err));
    };

    timer = setTimeout(attemptSave, 2000);
    return () => clearTimeout(timer);
  }, [nodes, edges, drawings, currentFile, setCurrentFile, setHasUnsavedChanges, isAnimatingRef, saveStateRef]);
}

