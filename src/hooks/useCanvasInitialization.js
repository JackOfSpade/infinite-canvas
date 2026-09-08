import { useEffect, useLayoutEffect, useRef } from 'react';
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
  quitGateRef,
  quitFenceReleaseVersion = 0,
  isAnimatingRef,
  navigationStateSwapRef,
  saveStateRef, // Ref to the active save state — prevents auto-save running concurrently with manual saves
  saveOperationRef, // Promise lane shared with close-time/manual saves
}) {
  const isMountedRef = useIsMountedRef();

  // Keep latest state in a ref so the auto-save timer reads current data
  // without the effect being torn down on every state change.
  const stateRef = useRef({ nodes, edges, drawings });
  const stateRevisionRef = useRef(0);
  useLayoutEffect(() => {
    stateRef.current = { nodes, edges, drawings };
    stateRevisionRef.current += 1;
  }, [nodes, edges, drawings]);

  // Mirror flushStack and hasUnsavedChanges into refs so the auto-save timer
  // callback can read live values without being a dependency of the effect.
  const flushRef = useRef(flushStack);
  useLayoutEffect(() => { flushRef.current = flushStack; }, [flushStack]);

  const hasUnsavedChangesRef = useRef(hasUnsavedChanges);
  useLayoutEffect(() => { hasUnsavedChangesRef.current = hasUnsavedChanges; }, [hasUnsavedChanges]);

  // Mirror currentFile into a ref for the in-flight-file-switch guard below —
  // an already-fired attemptSave keeps running to completion even after the
  // effect re-runs (clearTimeout only stops a timer that hasn't fired yet), so
  // it needs a way to notice the live file changed out from under it.
  const currentFileRef = useRef(currentFile);
  useLayoutEffect(() => { currentFileRef.current = currentFile; }, [currentFile]);

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
    let cancelled = false;
    // A quit fence invalidates an autosave that was scheduled or serialized by
    // the prior interactive generation. It may still finish an already-started
    // disk write, but must not mark a newer/final revalidation clean.
    const gateGeneration = quitGateRef?.current?.generation;
    const isCurrentGeneration = () => !quitGateRef?.current?.frozen
      && quitGateRef?.current?.generation === gateGeneration;
    const retry = (delayMs) => {
      if (!cancelled && isCurrentGeneration()) timer = setTimeout(attemptSave, delayMs);
    };
    const attemptSave = async () => {
      if (cancelled || !isCurrentGeneration()) return;
      // Safety guard 1: never auto-save while navigation animations are active
      // as the stack/nodes state may be transient or intermediate.
      if (isAnimatingRef?.current) {
        retry(TIMINGS.AUTOSAVE_RETRY_ANIMATING_MS);
        return;
      }

      // Safety guard 2: don't save if a manual save (Cmd+S) is already in-progress.
      // Concurrent writes to the same file can cause partial-write corruption or OS lock conflicts.
      if (saveStateRef?.current && saveStateRef.current !== 'idle') {
        retry(TIMINGS.AUTOSAVE_RETRY_SAVING_MS);
        return;
      }

      // Safety guard 3: don't save if there are no pending changes.
      // This specifically avoids redundant saves immediately after a workspace load.
      if (!hasUnsavedChangesRef.current) return;

      // Safety guard 4: don't force-commit an in-progress contenteditable edit.
      // buildSaveData's flush calls document.activeElement.blur(), which fires the
      // node's real onBlur handler — for TextNode/StickyNode that exits edit mode
      // AND deletes the node outright if it's still empty (useNodeAutoEdit's
      // auto-delete-if-empty convenience, meant for a deliberate blur, not a timer).
      // A silent background autosave must not do either of those to a user who is
      // still mid-sentence. Defer and retry; the manual save / quit-time flush
      // still force-commits, since those are deliberate user actions.
      if (document.activeElement?.isContentEditable) {
        retry(TIMINGS.AUTOSAVE_RETRY_EDITING_MS);
        return;
      }

      // Shared with the manual save in useCanvasPersistence — flushes any
      // in-progress contenteditable edit (a text node the user is still
      // typing into) before serializing, so a debounce window landing
      // mid-edit can't silently persist stale pre-edit text.
      const data = await buildSaveData({
        flushStack: flushRef.current,
        fallbackState: stateRef.current,
      });
      if (cancelled || !isMountedRef.current || !isCurrentGeneration()) return;
      if (!data.nodes || !Array.isArray(data.nodes)) return;

      // Capture the serialized revision. A later edit tears down this effect,
      // but the explicit revision check also closes the commit-to-passive-cleanup
      // window where a fast IPC response could otherwise mark newer state clean.
      const savedRevision = stateRevisionRef.current;

      // Safety guard 5: the open workspace may have been swapped to a
      // different file while this attempt was mid-flight (buildSaveData has
      // an await point above). `currentFile` in this closure is whatever was
      // current when this attemptSave was scheduled — if the live file has
      // since changed, `data` was just built from stateRef/flushStack, which
      // may already reflect the NEW file's content (loading a workspace
      // replaces nodes/edges/drawings in the same React state this hook
      // reads). Writing that under the OLD path would silently overwrite it
      // with an unrelated file's data. The new file gets its own correct
      // autosave once its content settles, so just drop this stale attempt.
      if (currentFileRef.current !== currentFile) return;

      // Acquire the same imperative write lock used by manual save. This makes
      // the check-and-set atomic on the JS thread and prevents both overlapping
      // auto-saves and an auto/manual write collision.
      if (saveStateRef?.current && saveStateRef.current !== 'idle') {
        retry(TIMINGS.AUTOSAVE_RETRY_SAVING_MS);
        return;
      }
      if (saveStateRef) saveStateRef.current = 'autosaving';

      const operation = (async () => {
        try {
          const res = await window.electronAPI.saveWorkspace({ data, filePath: currentFile });
          if (cancelled || !isMountedRef.current || !isCurrentGeneration()) return false;
          const snapshotIsCurrent = currentFileRef.current === currentFile
            && stateRevisionRef.current === savedRevision;
          if (res?.success && res.filePath && snapshotIsCurrent) {
            // Only update currentFile if the path changed (e.g. an on-disk rename
            // was resolved by the save implementation).
            if (res.filePath !== currentFile) setCurrentFile(res.filePath);
            hasUnsavedChangesRef.current = false;
            setHasUnsavedChanges(false);
          } else if (!res?.success && !res?.canceled) {
            EventLogger.error('[auto-save] saveWorkspace failed:', res?.error || 'unknown error');
          }
          return Boolean(res?.success && res.filePath && snapshotIsCurrent);
        } catch (err) {
          EventLogger.error('[auto-save] saveWorkspace failed:', err);
          return false;
        } finally {
          if (saveStateRef?.current === 'autosaving') saveStateRef.current = 'idle';
        }
      })();
      if (saveOperationRef) saveOperationRef.current = operation;
      try {
        await operation;
      } finally {
        if (saveOperationRef?.current === operation) saveOperationRef.current = null;
      }
    };

    // Debounce scales with workspace size (bigger = costlier to serialize/write).
    timer = setTimeout(attemptSave, autosaveDebounceMs(nodes.length));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [nodes, edges, drawings, currentFile, setCurrentFile, setHasUnsavedChanges, isAnimatingRef, saveStateRef, saveOperationRef, isMountedRef, quitGateRef, quitFenceReleaseVersion]);
}
