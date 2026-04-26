import { useCallback, useState, useRef, useEffect } from 'react';
import { toPng } from 'html-to-image';
import { EventLogger } from '../utils/EventLogger';
import { migrateGroupNodes, sanitizeNodesForSave } from '../utils/serializationUtils';


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
  clearHistory,
  isAnimatingRef,
  updateSetting,
}) {
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [currentFile, setCurrentFile] = useState(null);
  const [saveState, setSaveState] = useState('idle');
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);

  const isExportingRef = useRef(false);
  const saveStateTimerRef = useRef(null);
  const loadTimerRef = useRef(null);

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const drawingsRef = useRef(drawings);
  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
    drawingsRef.current = drawings;
  }, [nodes, edges, drawings]);

  // Mirror currentFile into a ref so saveCanvas can read it without being recreated
  // on every file-path change (which would cascade into loadCanvas / handleUnsavedChanges).
  const currentFileRef = useRef(currentFile);
  useEffect(() => { currentFileRef.current = currentFile; }, [currentFile]);

  // Mirror hasUnsavedChanges into a ref so the quit/unload listeners can
  // read the live value without being recreated on every state change.
  const hasUnsavedChangesRef = useRef(hasUnsavedChanges);
  useEffect(() => { hasUnsavedChangesRef.current = hasUnsavedChanges; }, [hasUnsavedChanges]);

  // Mirror saveState into a ref so saveCanvas can guard concurrent calls
  // without listing saveState as a dep (same pattern as hasUnsavedChangesRef).
  const saveStateRef = useRef(saveState);
  useEffect(() => { saveStateRef.current = saveState; }, [saveState]);

  useEffect(() => {
    // ── Quit Handshake ──────────────────────────────────────────────────────
    // Listens for the main process signaling a quit intent (e.g., Cmd+Q).
    const unlistenQuit = window.electronAPI?.onQuitRequest?.(() => {
      window.electronAPI.sendQuitResponse(hasUnsavedChangesRef.current);
    });

    // ── Preload Listeners ────────────────────────────────────────────────────
    const unlistenMenuNew = window.electronAPI?.onMenuNew?.(() => {
      // Defer to prevent state closures from being stale, though we use refs where possible
      setTimeout(() => newCanvasRef.current?.(), 0);
    });

    const unlistenSaveAndRespond = window.electronAPI?.onRequestSaveAndRespond?.(async () => {
      const success = await saveCanvasRef.current?.(true); // force save
      window.electronAPI.sendSaveResponse(success);
    });

    // ── Window Unload Guard ──────────────────────────────────────────────────
    // Standard browser/electron safety for closing the window tab directly.
    const handleBeforeUnload = (e) => {
      if (hasUnsavedChangesRef.current) {
        e.preventDefault();
        e.returnValue = ''; // Required for Chrome/Electron to show the prompt
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      unlistenQuit?.();
      unlistenMenuNew?.();
      unlistenSaveAndRespond?.();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (saveStateTimerRef.current) clearTimeout(saveStateTimerRef.current);
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    };
  }, []); // Stable: reads live value via ref — no need to re-register on change

  const saveCanvas = useCallback(async () => {
    if (!window.electronAPI || saveStateRef.current !== 'idle' || isAnimatingRef?.current) return;
    setSaveState('saving');
    try {
      // Flush the navigation stack to get complete root-level data
      const rawData = flushStack ? flushStack() : { nodes: nodesRef.current, edges: edgesRef.current, drawings: drawingsRef.current };
      // Strip transient visual properties (e.g. source-filter opacity on job cards)
      const data = { ...rawData, nodes: sanitizeNodesForSave(rawData.nodes) };
      // Read currentFile via ref to avoid this callback being recreated on every file-path change
      const res = await window.electronAPI.saveWorkspace({ data, filePath: currentFileRef.current });
      if (res?.success && res.filePath) {
        if (!isMountedRef.current) return false;
        setCurrentFile(res.filePath);
        updateSetting?.('lastOpenedWorkspace', res.filePath);
        setHasUnsavedChanges(false);
        setSaveState('saved');
        addToast({ title: 'Workspace Saved', description: 'Your canvas has been saved successfully.', type: 'success' });
        if (saveStateTimerRef.current) clearTimeout(saveStateTimerRef.current);
        saveStateTimerRef.current = setTimeout(() => { setSaveState('idle'); }, 1500);
        return true;
      } else {
        if (!isMountedRef.current) return false;
        setSaveState('idle');
        addToast({ title: 'Save Failed', description: 'Could not save the workspace.', type: 'error' });
        return false;
      }
    } catch (err) {
      EventLogger.error('Failed to save canvas:', err);
      if (!isMountedRef.current) return false;
      setSaveState('idle');
      addToast({ title: 'Save Error', description: err?.message || String(err) || 'An error occurred while saving.', type: 'error' });
      return false;
    }
  }, [addToast, flushStack, isAnimatingRef, updateSetting]); // currentFile read via ref — omitted intentionally

  // Expose stable references for the IPC listeners.
  // Direct render-body assignment is the correct pattern for ref syncing in ESLint v7+
  // (react-hooks/immutability disallows mutation inside useEffect).
  const saveCanvasRef = useRef(saveCanvas);
  // eslint-disable-next-line react-hooks/immutability -- render-body ref sync is the correct pattern when useEffect mutation is also disallowed by the same rule
  saveCanvasRef.current = saveCanvas;

  const handleUnsavedChanges = useCallback(async (actionName) => {
    if (!hasUnsavedChangesRef.current) return true;
    
    // Uses the main process OS-level dialog to pause and ask the user
    const choice = await window.electronAPI?.promptUnsavedChanges?.(actionName);
    
    if (choice === 'cancel') return false;
    
    if (choice === 'save') {
      const success = await saveCanvas();
      if (!success) return false; // Abort the action if save failed or was aborted
    }
    
    return true;
  }, [saveCanvas]);

  const newCanvas = useCallback(async () => {
    if (!window.electronAPI || isAnimatingRef?.current) return;
    
    const canProceed = await handleUnsavedChanges('create a new canvas');
    if (!canProceed) return;
    
    resetStack?.();
    setNodes([]);
    setEdges([]);
    setDrawings([]);
    setCurrentFile(null);
    updateSetting?.('lastOpenedWorkspace', null);
    clearHistory?.();
    
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    // Defer resetting this so React batches the empty nodes state first
    setTimeout(() => {
      if (!isMountedRef.current) return;
      setHasUnsavedChanges(false);
      customFitView();
    }, 50);
    
    addToast({ title: 'New Canvas', description: 'Created a blank canvas.', type: 'info' });
  }, [handleUnsavedChanges, isAnimatingRef, setNodes, setEdges, setDrawings, resetStack, clearHistory, customFitView, addToast, updateSetting]);

  const newCanvasRef = useRef(newCanvas);
  // eslint-disable-next-line react-hooks/immutability -- render-body ref sync is the correct pattern when useEffect mutation is also disallowed by the same rule
  newCanvasRef.current = newCanvas;

  const loadCanvas = useCallback(async (targetFilePath = null, isSilent = false) => {
    if (!window.electronAPI || isAnimatingRef?.current) return;
    
    // Security/UX Guard: Prevent overwriting unsaved work
    if (!isSilent) {
      const canProceed = await handleUnsavedChanges('open a different canvas');
      if (!canProceed) return;
    }

    try {
      const loadOpts = typeof targetFilePath === 'string' ? { filePath: targetFilePath } : undefined;
      const res = await window.electronAPI.loadWorkspace(loadOpts);
      if (res?.success && res.data) {
        // Reset navigation stack to root — prevents stale breadcrumbs/stack corruption
        resetStack?.();
        // Migrate old group nodes on load
        const migratedNodes = migrateGroupNodes(res.data.nodes || []);
        setNodes(migratedNodes);
        setEdges(res.data.edges || []);
        setDrawings(res.data.drawings || []);
        setCurrentFile(res.filePath);
        updateSetting?.('lastOpenedWorkspace', res.filePath);
        // Clear undo history — a freshly-loaded workspace should start with a blank slate
        clearHistory?.();
        // Defer: the useCanvasInitialization effect will fire setHasUnsavedChanges(true)
        // on the next render — we need our false to run *after* that effect.
        // A 50ms timeout ensures we safely skip past any React 18 concurrent rendering microtasks.
        if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
        loadTimerRef.current = setTimeout(() => {
          loadTimerRef.current = null;
          if (!isMountedRef.current) return;
          setHasUnsavedChanges(false);
          customFitView();
        }, 50);
        if (!isSilent) addToast({ title: 'Workspace Loaded', description: 'Your canvas has been loaded successfully.', type: 'success' });
      } else if (!res?.canceled) {
        if (!isSilent) addToast({ title: 'Load Failed', description: 'Failed to load canvas or invalid file format.', type: 'error' });
      }
    } catch (err) {
      EventLogger.error('Failed to load canvas:', err);
      if (!isSilent) addToast({ title: 'Load Error', description: err?.message || String(err) || 'An error occurred while loading.', type: 'error' });
      // Clear auto-load config if it fails completely (deleted or broken) so we don't boot loop into it
      if (isSilent) updateSetting?.('lastOpenedWorkspace', null);
    }
  }, [handleUnsavedChanges, setNodes, setEdges, setDrawings, customFitView, addToast, resetStack, clearHistory, isAnimatingRef, updateSetting]);

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
  }, [addToast, isAnimatingRef]);

  return {
    saveCanvas,
    loadCanvas,
    newCanvas,
    exportCanvasToPNG,
    hasUnsavedChanges,
    setHasUnsavedChanges,
    currentFile,
    setCurrentFile,
    saveStateRef, // Exposed so useCanvasInitialization can gate auto-saves on in-progress saves
  };
}
