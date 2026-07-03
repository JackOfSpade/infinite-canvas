import { useEffect, useRef } from 'react';
import { EventLogger } from '../utils/EventLogger';
import { TIMINGS, autosaveDebounceMs } from '../utils/timings';
import { useIsMountedRef } from './useIsMountedRef';
import { buildSaveData } from './canvasSaveData';

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
  navigationStateSwapRef,
  saveStateRef, // Ref to the active save state — prevents auto-save running concurrently with manual saves
}) {
  const isMountedRef = useIsMountedRef();

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
    // Diving into/out of a nested canvas swaps the active React Flow arrays but
    // does not change workspace content. Consume that one-shot marker so a pure
    // view transition cannot dirty an untouched saved workspace.
    if (navigationStateSwapRef?.current) {
      navigationStateSwapRef.current = false;
      return;
    }
    if (nodes.length === 0 && edges.length === 0 && drawings.length === 0) return;
    setHasUnsavedChanges(true);
  }, [nodes, edges, drawings, setHasUnsavedChanges, navigationStateSwapRef]);

  // Auto-save: debounced timer (≥2s, longer for big workspaces — see
  // autosaveDebounceMs) that restarts whenever content or the file path changes.
  // Reads hasUnsavedChanges via ref so a successful save (which flips the flag
  // to false) doesn't reset the debounce unnecessarily.
  useEffect(() => {
    if (!currentFile || !window.electronAPI) return;

    let timer;
    const attemptSave = async () => {
      // Safety guard 1: never auto-save while navigation animations are active
      // as the stack/nodes state may be transient or intermediate.
      if (isAnimatingRef?.current) {
        timer = setTimeout(attemptSave, TIMINGS.AUTOSAVE_RETRY_ANIMATING_MS);
        return;
      }

      // Safety guard 2: don't save if a manual save (Cmd+S) is already in-progress.
      // Concurrent writes to the same file can cause partial-write corruption or OS lock conflicts.
      if (saveStateRef?.current && saveStateRef.current !== 'idle') {
        timer = setTimeout(attemptSave, TIMINGS.AUTOSAVE_RETRY_SAVING_MS);
        return;
      }

      // Safety guard 3: don't save if there are no pending changes.
      // This specifically avoids redundant saves immediately after a workspace load.
      if (!hasUnsavedChangesRef.current) return;

      // Shared with the manual save in useCanvasPersistence — flushes any
      // in-progress contenteditable edit (a text node the user is still
      // typing into) before serializing, so a debounce window landing
      // mid-edit can't silently persist stale pre-edit text.
      const data = await buildSaveData({
        flushStack: flushRef.current,
        fallbackState: stateRef.current,
      });
      if (!isMountedRef.current) return;
      if (!data.nodes || !Array.isArray(data.nodes)) return;

      window.electronAPI.saveWorkspace({ data, filePath: currentFile }).then(res => {
        if (!isMountedRef.current) return;
        if (res?.success && res.filePath) {
          // Only update currentFile if the path changed (e.g. first save via dialog)
          if (res.filePath !== currentFile) setCurrentFile(res.filePath);
          setHasUnsavedChanges(false);
        }
      }).catch(err => EventLogger.error('[auto-save] saveWorkspace failed:', err));
    };

    // Debounce scales with workspace size (bigger = costlier to serialize/write).
    timer = setTimeout(attemptSave, autosaveDebounceMs(nodes.length));
    return () => clearTimeout(timer);
  }, [nodes, edges, drawings, currentFile, setCurrentFile, setHasUnsavedChanges, isAnimatingRef, saveStateRef, isMountedRef]);
}
