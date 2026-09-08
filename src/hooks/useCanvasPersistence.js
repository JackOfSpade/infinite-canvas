import { useCallback, useState, useRef, useEffect, useEffectEvent, useLayoutEffect } from 'react';
import { toPng } from 'html-to-image';
import { EventLogger } from '../utils/EventLogger';
import { persistenceContentFingerprint, runNodeMigrations, CURRENT_SCHEMA_VERSION, sanitizeNodesForSave, sanitizeEdgesForSave } from '../utils/serializationUtils';
import { TIMINGS } from '../utils/timings';
import { useIsMountedRef } from './useIsMountedRef';
import { buildSaveData } from './canvasSaveData';
import { textDocumentSessions } from '../utils/textDocumentSessions';


/**
 * Encapsulates canvas save/load/export persistence logic.
 * Extracted from Canvas.jsx to keep the main component focused on rendering.
 *
 * @param {object} deps
 * @param {Array} deps.nodes - Current nodes array
 * @param {Array} deps.edges - Current edges array
 * @param {Array} deps.drawings - Current drawings array
 * @param {Function} deps.setNodes - Setter for nodes
 * @param {Function} deps.setEdges - Setter for edges
 * @param {Function} deps.setDrawings - Setter for drawings
 * @param {Function} deps.customFitView - Fit view callback
 * @param {Function} deps.addToast - Toast notification callback
 * @param {Function} deps.flushStack - Navigation stack flush (returns root-level data)
 */
export function useCanvasPersistence({
  nodes, edges, drawings, setNodes, setEdges, setDrawings, customFitView, addToast,
  flushStack,
  resetStack,
  quitGateRef,
  freezeCanvasForQuit,
  releaseCanvasQuitFence,
  clearHistory,
  isAnimatingRef,
  updateSetting,
}) {
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [currentFile, setCurrentFile] = useState(null);
  const [saveState, setSaveState] = useState('idle');
  const [loadState, setLoadState] = useState({ active: false, progress: 0, label: '' });
  const isMountedRef = useIsMountedRef();

  const isExportingRef = useRef(false);
  const saveStateTimerRef = useRef(null);
  const loadTimerRef = useRef(null);
  const loadHideTimerRef = useRef(null);
  const contentRevisionRef = useRef(0);
  const loadRequestRef = useRef(0);
  // Shared with the autosave hook. A close-time/manual save waits for the
  // operation which already owns the workspace writer, then re-checks whether
  // a fresh frozen snapshot is still needed instead of failing merely because
  // `saveStateRef` happened to read "autosaving".
  const saveOperationRef = useRef(null);

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const drawingsRef = useRef(drawings);
  // Save shortcuts may fire immediately after a committed canvas update.
  // Synchronize before paint so saveCanvas never reads the prior render.
  useLayoutEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
    drawingsRef.current = drawings;
    contentRevisionRef.current += 1;
  }, [nodes, edges, drawings]);

  // Mirror currentFile into a ref so saveCanvas can read it without being recreated
  // on every file-path change (which would cascade into loadCanvas / handleUnsavedChanges).
  const currentFileRef = useRef(currentFile);
  useLayoutEffect(() => { currentFileRef.current = currentFile; }, [currentFile]);

  // Mirror hasUnsavedChanges into a ref so the quit/unload listeners can
  // read the live value without being recreated on every state change.
  const hasUnsavedChangesRef = useRef(hasUnsavedChanges);
  useLayoutEffect(() => { hasUnsavedChangesRef.current = hasUnsavedChanges; }, [hasUnsavedChanges]);

  // Mirror saveState into a ref so saveCanvas can guard concurrent calls
  // without listing saveState as a dep (same pattern as hasUnsavedChangesRef).
  const saveStateRef = useRef(saveState);
  useLayoutEffect(() => { saveStateRef.current = saveState; }, [saveState]);

  // Keep the imperative lock and the rendered status in sync immediately.
  // Waiting for the next layout effect leaves a same-tick window where a
  // second Cmd+S (or auto-save) can start another write to the same file.
  const setSaveStatus = useCallback((nextStatus) => {
    saveStateRef.current = nextStatus;
    setSaveState(nextStatus);
  }, []);

  const performCanvasSave = useCallback(async () => {
    const saveStatus = saveStateRef.current;
    if (!window.electronAPI
        || saveStatus === 'saving'
        || saveStatus === 'autosaving'
        || isAnimatingRef?.current) return false;
    // A previous success badge may still have a delayed reset pending. Let a
    // new explicit save proceed, but cancel that stale feedback callback so it
    // cannot flip this new in-flight write back to idle.
    if (saveStateTimerRef.current) {
      clearTimeout(saveStateTimerRef.current);
      saveStateTimerRef.current = null;
    }
    setSaveStatus('saving');
    let attemptedFilePath = currentFileRef.current;
    try {
      // Shared with the debounced auto-save in useCanvasInitialization (flush
      // any in-progress contenteditable edit, e.g. a text node being typed
      // into when the user pressed Cmd+S, then sanitize) so the two save
      // paths can't drift out of sync with each other.
      const data = await buildSaveData({
        flushStack,
        fallbackState: { nodes: nodesRef.current, edges: edgesRef.current, drawings: drawingsRef.current },
      });
      // Capture both identities at the exact serialization boundary. If the
      // user edits or switches workspaces while disk I/O is in flight, this
      // completed write is real but it must not mark the newer live state clean.
      const savedRevision = contentRevisionRef.current;
      attemptedFilePath = currentFileRef.current;
      const res = await window.electronAPI.saveWorkspace({ data, filePath: attemptedFilePath });
      if (res?.success && res.filePath) {
        if (!isMountedRef.current) return false;
        const sameWorkspace = currentFileRef.current === attemptedFilePath;
        const snapshotIsCurrent = sameWorkspace && contentRevisionRef.current === savedRevision;

        // Save As still establishes the chosen path when edits landed while the
        // dialog/write was open. Those later edits remain dirty and will be
        // written by the next save instead of being silently declared saved.
        if (sameWorkspace) {
          currentFileRef.current = res.filePath;
          setCurrentFile(res.filePath);
          updateSetting?.('lastOpenedWorkspace', res.filePath);
        }

        if (!snapshotIsCurrent) {
          setSaveStatus('idle');
          addToast({
            title: 'Earlier Snapshot Saved',
            description: sameWorkspace
              ? 'Newer canvas changes are still waiting to be saved.'
              : 'The open workspace changed before this save completed.',
            type: 'info',
          });
          return false;
        }

        hasUnsavedChangesRef.current = false;
        setHasUnsavedChanges(false);
        setSaveStatus('saved');
        addToast({ title: 'Workspace Saved', description: 'Your canvas has been saved successfully.', type: 'success' });
        if (saveStateTimerRef.current) clearTimeout(saveStateTimerRef.current);
        saveStateTimerRef.current = setTimeout(() => {
          saveStateTimerRef.current = null;
          setSaveStatus('idle');
        }, TIMINGS.FEEDBACK_MS);
        return true;
      } else if (res?.canceled) {
        // User dismissed the native save dialog — not an error.
        if (!isMountedRef.current) return false;
        setSaveStatus('idle');
        return false;
      } else {
        if (!isMountedRef.current) return false;
        const reason = res?.error || 'Could not save the workspace.';
        EventLogger.recordSaveError(reason, attemptedFilePath);
        setSaveStatus('idle');
        addToast({ title: 'Save Failed', description: reason, type: 'error' });
        return false;
      }
    } catch (err) {
      const reason = err?.message || String(err) || 'An error occurred while saving.';
      EventLogger.recordSaveError(reason, attemptedFilePath);
      if (!isMountedRef.current) return false;
      setSaveStatus('idle');
      addToast({ title: 'Save Error', description: reason, type: 'error' });
      return false;
    }
  }, [addToast, flushStack, isAnimatingRef, updateSetting, isMountedRef, setSaveStatus]); // currentFile read via ref — omitted intentionally

  const saveCanvas = useCallback(async () => {
    // Serialize every explicit/close-time save behind an in-flight manual or
    // autosave operation. In particular, quit invalidates the autosave's UI
    // generation, so that older write intentionally leaves the dirty flag set;
    // after it settles this loop starts one fresh save of the frozen canvas.
    for (;;) {
      const activeOperation = saveOperationRef.current;
      if (!activeOperation) break;
      let activeSucceeded = false;
      try {
        activeSucceeded = Boolean(await activeOperation);
      } catch {
        // The owning save reports its own failure. A queued explicit save gets
        // one normal retry below using the current serialization boundary.
      }
      if (!isMountedRef.current) return false;
      // Autosave returns true only when its file path, content revision, quit
      // generation, and mounted owner all still match. That is already the
      // authoritative clean result; the React-backed dirty ref may lag its
      // just-enqueued false update by one layout effect.
      if (activeSucceeded) return true;
    }

    const operation = performCanvasSave();
    saveOperationRef.current = operation;
    try {
      return await operation;
    } finally {
      if (saveOperationRef.current === operation) saveOperationRef.current = null;
    }
  }, [performCanvasSave, isMountedRef]);

  const handleSaveRequest = useEffectEvent(async () => saveCanvas());

  const prepareQuitCommit = useEffectEvent(async () => {
    // Invalidating immediately makes any load already awaiting disk I/O a
    // stale request. Do this before the render-turn drain so a cancelled quit
    // never opens a different workspace after the UI is released.
    loadRequestRef.current += 1;
    return freezeCanvasForQuit?.();
  });
  const releaseQuitCommit = useEffectEvent(() => {
    releaseCanvasQuitFence?.();
  });

  const flushDocumentSessions = useCallback(async ({ notify = false } = {}) => {
    const result = await textDocumentSessions.flushAndSettleAll();
    if (!result.success && notify) {
      addToast({
        title: 'Document needs attention',
        description: 'Resolve the Markdown or text file save issue before replacing or closing this canvas.',
        type: 'error',
      });
    }
    return result;
  }, [addToast]);

  useEffect(() => {
    // Electron invokes these as EventEmitter callbacks. Do not let a renderer
    // exception turn into a missing acknowledgement: quit fails closed after a
    // timeout, but a save request deliberately waits for this correlated reply.
    const sendQuitResponse = (state, requestId) => {
      try {
        window.electronAPI?.sendQuitResponse?.(state, requestId);
      } catch (error) {
        console.error('Could not acknowledge quit request:', error);
      }
    };
    const sendSaveResponse = (success, requestId) => {
      try {
        window.electronAPI?.sendSaveResponse?.(Boolean(success), requestId);
      } catch (error) {
        console.error('Could not acknowledge save request:', error);
      }
    };

    // ── Quit Handshake ──────────────────────────────────────────────────────
    // Listens for the main process signaling a quit intent (e.g., Cmd+Q).
    const unlistenQuit = window.electronAPI?.onQuitRequest?.(async ({ requestId } = {}) => {
      let response = { hasUnsavedChanges: true, documentSaveFailed: true };
      try {
        // A paste can be followed immediately by Cmd+Q. Wait for preload's
        // outstanding draft invokes and main's disk barrier before answering the
        // close handshake, otherwise the last edit can trail window destruction.
        try {
          await window.electronAPI?.flushNonApiAiPersistence?.();
        } catch {
          // Main performs the same barrier before destruction; keep the standard
          // close handshake available if this renderer-side optimization fails.
        }
        const documents = await textDocumentSessions.flushAndSettleAll();
        response = {
          hasUnsavedChanges: hasUnsavedChangesRef.current,
          documentSaveFailed: !documents.success,
        };
      } catch (error) {
        // A failed renderer-side flush is never evidence that the document or
        // canvas is clean. Return a correlated fail-closed response instead of
        // leaving main waiting for its timeout.
        console.error('Could not prepare quit response:', error);
      } finally {
        sendQuitResponse(response, requestId);
      }
    });

    // The global quit coordinator asks every renderer to become inert before
    // its final revalidation. This closes the gap where a window checked early
    // in a multi-window quit could receive another edit while a later window
    // is being saved. Inert blocks human input; Canvas's synchronous gate also
    // rejects programmatic mutations (timers, promises, RF batches). The gate
    // waits for already-accepted batches before it acknowledges main.
    const unlistenQuitCommit = window.electronAPI?.onQuitCommitRequest?.(async ({ requestId } = {}) => {
      if (document.body) document.body.inert = true;
      try {
        const frozen = await prepareQuitCommit();
        if (frozen !== false) window.electronAPI?.sendQuitCommitAck?.(requestId);
      } catch (error) {
        // Do not ACK an incomplete state fence. Main will time out, broadcast a
        // release, and leave this renderer usable rather than trusting a late
        // programmatic update as clean.
        console.error('Could not prepare quit commit barrier:', error);
      }
    });
    const unlistenQuitCommitRelease = window.electronAPI?.onQuitCommitRelease?.(() => {
      releaseQuitCommit();
      if (document.body) document.body.inert = false;
    });

    // ── Preload Listeners ────────────────────────────────────────────────────
    const unlistenSaveAndRespond = window.electronAPI?.onRequestSaveAndRespond?.(async ({
      requestId,
      skipDocumentSessions = false,
      forceCanvasSave = false,
    } = {}) => {
      let success = false;
      try {
        if (!skipDocumentSessions) {
          const documents = await textDocumentSessions.flushAndSettleAll();
          if (!documents.success) return;
        }
        // A document-only edit is already durable at this point. Do not route a
        // clean/untitled canvas through Save As merely because the user chose a
        // menu save while its Markdown preview was being settled.
        if (!hasUnsavedChangesRef.current && !forceCanvasSave) {
          success = true;
          return;
        }
        success = await handleSaveRequest(); // force save
      } catch (error) {
        // requestSaveAndWait has no artificial deadline: a native Save As can
        // legitimately be user-paced. An exception must therefore answer false
        // rather than leaving main permanently awaiting this renderer callback.
        console.error('Could not prepare save response:', error);
      } finally {
        sendSaveResponse(success, requestId);
      }
    });

    // ── Window Unload Guard ──────────────────────────────────────────────────
    // Standard browser/electron safety for closing the window tab directly.
    const handleBeforeUnload = (e) => {
      if (textDocumentSessions.hasUnresolvedChanges()) {
        // beforeunload is synchronous. Start the durability flush now, but
        // always keep this window alive until a later close sees it settled.
        void textDocumentSessions.flushAndSettleAll();
        e.preventDefault();
        e.returnValue = '';
        return;
      }
      if (hasUnsavedChangesRef.current) {
        e.preventDefault();
        e.returnValue = ''; // Required for Chrome/Electron to show the prompt
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      unlistenQuit?.();
      unlistenQuitCommit?.();
      unlistenQuitCommitRelease?.();
      releaseQuitCommit();
      if (document.body) document.body.inert = false;
      unlistenSaveAndRespond?.();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (saveStateTimerRef.current) clearTimeout(saveStateTimerRef.current);
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
      if (loadHideTimerRef.current) clearTimeout(loadHideTimerRef.current);
    };
  }, []); // Stable: reads live value via ref / useEffectEvent — no need to re-register on change

  const handleUnsavedChanges = useCallback(async (actionName) => {
    const documents = await flushDocumentSessions({ notify: true });
    if (!documents.success) return false;
    if (!hasUnsavedChangesRef.current) return true;
    
    // Uses the main process OS-level dialog to pause and ask the user
    const choice = await window.electronAPI?.promptUnsavedChanges?.(actionName);
    
    if (choice === 'cancel') return false;
    
    if (choice === 'save') {
      const success = await saveCanvas();
      if (!success) return false; // Abort the action if save failed or was aborted
    }
    
    return true;
  }, [flushDocumentSessions, saveCanvas]);

  const loadCanvas = useCallback(async (targetFilePath = null, isSilent = false) => {
    if (!window.electronAPI || isAnimatingRef?.current || quitGateRef?.current?.frozen) return;
    const requestId = ++loadRequestRef.current;
    const gateGeneration = quitGateRef?.current?.generation;
    const isCurrentLoad = () => isMountedRef.current
      && requestId === loadRequestRef.current
      && !quitGateRef?.current?.frozen
      && quitGateRef?.current?.generation === gateGeneration;
    
    // Security/UX Guard: Prevent overwriting unsaved work
    if (!isSilent) {
      const canProceed = await handleUnsavedChanges('open a different canvas');
      if (!canProceed || !isCurrentLoad()) return;
    }

    try {
      const startedAt = performance.now();
      const setLoading = (progress, label) => {
        if (!isCurrentLoad()) return;
        setLoadState({ active: true, progress, label });
      };
      const finishLoading = (delayMs = 120) => {
        if (loadHideTimerRef.current) clearTimeout(loadHideTimerRef.current);
        loadHideTimerRef.current = setTimeout(() => {
          loadHideTimerRef.current = null;
          if (!isCurrentLoad()) return;
          setLoadState({ active: false, progress: 0, label: '' });
        }, delayMs);
      };

      if (loadHideTimerRef.current) {
        clearTimeout(loadHideTimerRef.current);
        loadHideTimerRef.current = null;
      }
      setLoading(0.08, 'Opening workspace...');
      EventLogger.log(`canvas load start silent=${isSilent} target=${targetFilePath || 'last-opened'}`);

      const loadOpts = typeof targetFilePath === 'string' ? { filePath: targetFilePath } : undefined;
      const res = await window.electronAPI.loadWorkspace(loadOpts);
      // The window can close (or this hook's owner unmount) while the load is
      // in flight — loadWorkspace involves a file read plus migrations and
      // can be slow. Bail before touching any state, matching saveCanvas's
      // guard on every post-await write below.
      if (!isCurrentLoad()) return;
      setLoading(0.35, 'Reading workspace...');
      if (res?.success && res.data) {
        // Reset navigation stack to root — prevents stale breadcrumbs/stack corruption
        resetStack?.();
        // Run versioned node migrations: every migration newer than the file's
        // schemaVersion (absent ⇒ 0) heals old/changed component shapes to the
        // current format — group→canvasData, legacy Job Search cascade→scoredJobs,
        // etc. Idempotent + same-ref when nothing changed, so current files are
        // free. The on-disk file is untouched until the next save, so a bad
        // migration is recoverable by not saving.
        const fileVersion = res.data.schemaVersion ?? 0;
        const inputNodes = Array.isArray(res.data.nodes) ? res.data.nodes : [];
        const relocatedNodes = runNodeMigrations(inputNodes, fileVersion);
        if (relocatedNodes !== inputNodes) {
          EventLogger.log(`[Migration] Healed canvas from schemaVersion ${fileVersion} → ${CURRENT_SCHEMA_VERSION}`);
        }
        setLoading(0.58, 'Preparing canvas...');
        // Sanitize transient hub state on load, not just on save. A workspace
        // saved before the save-time strip existed (or by any path that
        // bypassed it) can carry a stale data.errorMessage / pending-pipeline
        // buffer / mid-run hubState on a jobsearch/sellhub. Without stripping here
        // the "report an issue" banner from a forgotten failed run reappears on
        // every auto-load and never clears — a freshly-loaded canvas is marked
        // clean (hasUnsavedChanges=false below), so no auto-save ever fires to
        // re-sanitize it. Running the same sanitizer used on save makes load
        // idempotent for clean files and self-healing for stale ones.
        const sanitizedNodes = sanitizeNodesForSave(relocatedNodes);
        // Strip orphan edges on load too — files saved before the save-time
        // orphan filter existed can carry hundreds of orphans (refs to
        // long-deleted hub trees) that render as ghost connections in the
        // minimap and bloat ReactFlow's internal graph. Cleaning here means
        // the canvas appears clean the moment it opens, without waiting for
        // the auto-save debounce to land (which can be delayed indefinitely
        // when the pipeline is actively updating hub state). Pass the
        // sanitized nodes so edges to any dropped ephemeral are pruned too.
        const inputEdges = Array.isArray(res.data.edges) ? res.data.edges : [];
        const cleanEdges = sanitizeEdgesForSave(inputEdges, sanitizedNodes);
        const loadedDrawings = Array.isArray(res.data.drawings) ? res.data.drawings : [];
        const loadedFingerprint = persistenceContentFingerprint({ nodes: sanitizedNodes, edges: cleanEdges, drawings: loadedDrawings });
        setNodes(sanitizedNodes);
        setEdges(cleanEdges);
        setDrawings(loadedDrawings);
        currentFileRef.current = res.filePath;
        setCurrentFile(res.filePath);
        updateSetting?.('lastOpenedWorkspace', res.filePath);
        setLoading(0.78, 'Rendering canvas...');
        // Clear undo history — a freshly-loaded workspace should start with a blank slate
        clearHistory?.();
        // Defer: the useCanvasInitialization effect will fire setHasUnsavedChanges(true)
        // on the next render — we need our false to run *after* that effect.
        // A 50ms timeout ensures we safely skip past any React 18 concurrent rendering microtasks.
        if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
        loadTimerRef.current = setTimeout(() => {
          loadTimerRef.current = null;
          if (!isCurrentLoad()) return;
          // ReactFlow may add runtime measurements during the first render;
          // the persistence signature intentionally ignores those while deeply
          // traversing nested canvases. Only clear the dirty flag if persisted
          // content still matches what was loaded, so a quick user/background
          // edit at any depth cannot be erased here.
          const liveFingerprint = persistenceContentFingerprint({
            nodes: nodesRef.current,
            edges: edgesRef.current,
            drawings: drawingsRef.current,
          });
          if (liveFingerprint === loadedFingerprint) setHasUnsavedChanges(false);
          const fitDuration = isSilent ? 0 : 800;
          requestAnimationFrame(() => {
            if (!isCurrentLoad()) return;
            requestAnimationFrame(() => {
              if (!isCurrentLoad()) return;
              setLoading(0.92, fitDuration > 0 ? 'Fitting workspace...' : 'Framing workspace...');
              customFitView({ duration: fitDuration, reason: isSilent ? 'initial-load' : 'manual-load' });
              setLoading(1, 'Ready');
              EventLogger.log(`canvas load ready nodes=${sanitizedNodes.length} edges=${cleanEdges.length} fitDuration=${fitDuration}ms elapsed=${Math.round(performance.now() - startedAt)}ms`);
              finishLoading(fitDuration > 0 ? Math.min(fitDuration, 500) : 120);
            });
          });
        }, 50);
        if (!isSilent) addToast({ title: 'Workspace Loaded', description: 'Your canvas has been loaded successfully.', type: 'success' });
      } else if (!res?.canceled) {
        setLoadState({ active: false, progress: 0, label: '' });
        if (!isSilent) addToast({ title: 'Load Failed', description: 'Failed to load canvas or invalid file format.', type: 'error' });
      } else {
        setLoadState({ active: false, progress: 0, label: '' });
      }
    } catch (err) {
      if (!isCurrentLoad()) return;
      EventLogger.error('Failed to load canvas:', err);
      setLoadState({ active: false, progress: 0, label: '' });
      if (!isSilent) addToast({ title: 'Load Error', description: err?.message || String(err) || 'An error occurred while loading.', type: 'error' });
      // Clear auto-load config if it fails completely (deleted or broken) so we don't boot loop into it
      if (isSilent) updateSetting?.('lastOpenedWorkspace', null);
    }
  }, [handleUnsavedChanges, setNodes, setEdges, setDrawings, customFitView, addToast, resetStack, clearHistory, isAnimatingRef, updateSetting, isMountedRef, quitGateRef]);

  const exportCanvasToPNG = useCallback(() => {
    if (isAnimatingRef?.current || isExportingRef.current) return;
    const viewportNode = document.querySelector('.react-flow__viewport');
    if (!viewportNode) return;
    isExportingRef.current = true;
    toPng(viewportNode, { backgroundColor: '#0a0a0a' })
      .then((dataUrl) => {
        if (!isMountedRef.current) return;
        const date = new Date().toISOString().slice(0, 10);
        const link = document.createElement('a');
        link.download = `canvas-${date}.png`;
        link.href = dataUrl;
        link.click();
        addToast({ title: 'Export Successful', description: 'Canvas has been exported to PNG.', type: 'success'});
      })
      .catch((err) => {
        EventLogger.error('Failed to export image', err);
        if (!isMountedRef.current) return;
        addToast({ title: 'Export Failed', description: 'There was an error generating the PNG.', type: 'error'});
      })
      .finally(() => {
        isExportingRef.current = false;
      });
  }, [addToast, isAnimatingRef, isMountedRef]);

  return {
    saveCanvas,
    loadCanvas,
    exportCanvasToPNG,
    hasUnsavedChanges,
    setHasUnsavedChanges,
    currentFile,
    setCurrentFile,
    saveStateRef, // Exposed so useCanvasInitialization can gate auto-saves on in-progress saves
    saveOperationRef,
    loadState,
  };
}
