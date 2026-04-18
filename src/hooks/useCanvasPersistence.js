import { useCallback, useState, useRef, useEffect } from 'react';
import { toPng } from 'html-to-image';

/**
 * Recursively migrate old group nodes from separate data.nodes/edges/drawings
 * to the unified data.canvasData structure.
 */
function migrateGroupNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map(node => {
    if (node.type === 'group' && !node.data?.canvasData && (node.data?.nodes || node.data?.edges || node.data?.drawings)) {
      const { nodes: innerNodes, edges: innerEdges, drawings: innerDrawings,
              collapsed: _collapsed, pushedNodes: _pushedNodes, items: _items, ...restData } = node.data;
      const { dragHandle: _dragHandle, ...restNode } = node;
      return {
        ...restNode,
        style: { width: node.style?.width || 180, height: node.style?.height || 130 },
        data: {
          ...restData,
          canvasData: {
            nodes: migrateGroupNodes(innerNodes || []),
            edges: innerEdges || [],
            drawings: innerDrawings || [],
          },
        },
      };
    }
    // Ensure locked nodes have deletable: false (added retroactively).
    // Use a separate variable — arrow-function parameters are const and cannot be reassigned.
    let current = node;
    if (current.data?.locked && current.deletable !== false) {
      current = { ...current, deletable: false };
    }
    // Recurse into existing canvasData for new-format group nodes
    if (current.type === 'group' && current.data?.canvasData?.nodes?.length > 0) {
      const migratedInner = migrateGroupNodes(current.data.canvasData.nodes);
      if (migratedInner !== current.data.canvasData.nodes) {
        return {
          ...current,
          data: {
            ...current.data,
            canvasData: { ...current.data.canvasData, nodes: migratedInner },
          },
        };
      }
    }
    return current;
  });
}
/**
 * Strip transient visual properties from nodes before saving.
 * Prevents runtime-only state (e.g. source-filter dim opacity) from
 * being persisted to disk and corrupting the loaded workspace.
 *
 * This is recursive: group (CanvasNode) nodes can contain arbitrary
 * nested canvases, so we must sanitize down every level.
 */
export function sanitizeNodesForSave(nodes) {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map(n => {
    // Strip opacity from jobcard nodes — it's set transiently by toggleSourceFilter
    // and should never be persisted (the hub's sourceFilter is saved separately).
    if (n.type === 'jobcard' && n.style?.opacity !== undefined) {
      const { opacity: _opacity, ...restStyle } = n.style || {};
      return { ...n, style: Object.keys(restStyle).length ? restStyle : undefined };
    }
    // Recurse into nested canvas nodes so deeply-nested jobcards are also sanitized
    if (n.type === 'group' && n.data?.canvasData?.nodes?.length > 0) {
      const sanitizedInner = sanitizeNodesForSave(n.data.canvasData.nodes);
      return {
        ...n,
        data: {
          ...n.data,
          canvasData: { ...n.data.canvasData, nodes: sanitizedInner },
        },
      };
    }
    return n;
  });
}

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
}) {
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [currentFile, setCurrentFile] = useState(null);
  const [saveState, setSaveState] = useState('idle');
  const isMountedRef = useRef(true);
  const isExportingRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    
    // ── Quit Handshake ──────────────────────────────────────────────────────
    // Listens for the main process signaling a quit intent (e.g., Cmd+Q).
    const unlistenQuit = window.electronAPI?.onQuitRequest?.(() => {
      if (!isMountedRef.current) return;
      window.electronAPI.sendQuitResponse(hasUnsavedChanges);
    });

    // ── Window Unload Guard ──────────────────────────────────────────────────
    // Standard browser/electron safety for closing the window tab directly.
    const handleBeforeUnload = (e) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = ''; // Required for Chrome/Electron to show the prompt
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      isMountedRef.current = false;
      unlistenQuit?.();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [hasUnsavedChanges]);

  const saveCanvas = useCallback(async () => {
    if (!window.electronAPI || saveState !== 'idle' || isAnimatingRef?.current) return;
    setSaveState('saving');
    try {
      // Flush the navigation stack to get complete root-level data
      const rawData = flushStack ? flushStack() : { nodes, edges, drawings };
      // Strip transient visual properties (e.g. source-filter opacity on job cards)
      const data = { ...rawData, nodes: sanitizeNodesForSave(rawData.nodes) };
      const res = await window.electronAPI.saveWorkspace({ data, filePath: currentFile });
      if (!isMountedRef.current) return;
      if (res?.success && res.filePath) {
        setCurrentFile(res.filePath);
        setHasUnsavedChanges(false);
        setSaveState('saved');
        addToast({ title: 'Workspace Saved', description: 'Your canvas has been saved successfully.', type: 'success' });
        setTimeout(() => { if (isMountedRef.current) setSaveState('idle'); }, 1500);
      } else {
        setSaveState('idle');
        addToast({ title: 'Save Failed', description: 'Could not save the workspace.', type: 'error' });
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      console.error('Failed to save canvas:', err);
      setSaveState('idle');
      addToast({ title: 'Save Error', description: err?.message || String(err) || 'An error occurred while saving.', type: 'error' });
    }
  }, [nodes, edges, drawings, currentFile, saveState, addToast, flushStack, isAnimatingRef]);

  const confirmDiscardChanges = useCallback(() => {
    if (!hasUnsavedChanges) return true;
    return window.confirm('You have unsaved changes. Loading another workspace will discard them. Continue?');
  }, [hasUnsavedChanges]);

  const loadCanvas = useCallback(async () => {
    if (!window.electronAPI || isAnimatingRef?.current) return;
    
    // Security/UX Guard: Prevent overwriting unsaved work
    if (!confirmDiscardChanges()) return;

    try {
      const res = await window.electronAPI.loadWorkspace();
      if (!isMountedRef.current) return;
      if (res?.success && res.data) {
        // Reset navigation stack to root — prevents stale breadcrumbs/stack corruption
        resetStack?.();
        // Migrate old group nodes on load
        const migratedNodes = migrateGroupNodes(res.data.nodes || []);
        setNodes(migratedNodes);
        setEdges(res.data.edges || []);
        setDrawings(res.data.drawings || []);
        setCurrentFile(res.filePath);
        // Clear undo history — a freshly-loaded workspace should start with a blank slate
        clearHistory?.();
        // Defer: the useCanvasInitialization effect will fire setHasUnsavedChanges(true)
        // on the next render — we need our false to run *after* that effect.
        // A 50ms timeout ensures we safely skip past any React 18 concurrent rendering microtasks.
        setTimeout(() => { if (isMountedRef.current) setHasUnsavedChanges(false); }, 50);
        setTimeout(() => { if (isMountedRef.current) customFitView(); }, 50);
        addToast({ title: 'Workspace Loaded', description: 'Your canvas has been loaded successfully.', type: 'success'});
      } else if (!res?.canceled) {
        addToast({ title: 'Load Failed', description: 'Failed to load canvas or invalid file format.', type: 'error'});
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      console.error('Failed to load canvas:', err);
      addToast({ title: 'Load Error', description: err?.message || String(err) || 'An error occurred while loading.', type: 'error'});
    }
  }, [confirmDiscardChanges, setNodes, setEdges, setDrawings, setCurrentFile, setHasUnsavedChanges, customFitView, addToast, resetStack, clearHistory, isAnimatingRef]);

  const exportCanvasToPNG = useCallback(() => {
    if (isAnimatingRef?.current || isExportingRef.current) return;
    const viewportNode = document.querySelector('.react-flow__viewport');
    if (!viewportNode) return;
    isExportingRef.current = true;
    toPng(viewportNode, { backgroundColor: '#0a0a0a' })
      .then((dataUrl) => {
        if (!isMountedRef.current) return;
        const link = document.createElement('a');
        link.download = 'canvas-export.png';
        link.href = dataUrl;
        link.click();
        addToast({ title: 'Export Successful', description: 'Canvas has been exported to PNG.', type: 'success'});
      })
      .catch((err) => {
        if (!isMountedRef.current) return;
        console.error('Failed to export image', err);
        addToast({ title: 'Export Failed', description: 'There was an error generating the PNG.', type: 'error'});
      })
      .finally(() => {
        isExportingRef.current = false;
      });
  }, [addToast, isAnimatingRef]);

  return {
    saveCanvas,
    loadCanvas,
    exportCanvasToPNG,
    saveState,
    hasUnsavedChanges,
    setHasUnsavedChanges,
    currentFile,
    setCurrentFile,
  };
}
