import { useCallback, useState } from 'react';
import { toPng } from 'html-to-image';

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
 */
export function useCanvasPersistence({
  nodes, edges, drawings, setNodes, setEdges, setDrawings, customFitView, addToast
}) {
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [currentFile, setCurrentFile] = useState(null);
  const [saveState, setSaveState] = useState('idle');

  const saveCanvas = useCallback(async () => {
    if (!window.electronAPI || saveState !== 'idle') return;
    setSaveState('saving');
    try {
      const res = await window.electronAPI.saveWorkspace({ data: { nodes, edges, drawings }, filePath: currentFile });
      if (res?.success && res.filePath) {
        setCurrentFile(res.filePath);
        setHasUnsavedChanges(false);
        setSaveState('saved');
        addToast({ title: 'Workspace Saved', description: 'Your canvas has been saved successfully.', type: 'success' });
        setTimeout(() => setSaveState('idle'), 1500);
      } else {
        setSaveState('idle');
        addToast({ title: 'Save Failed', description: 'Could not save the workspace.', type: 'error' });
      }
    } catch (err) {
      console.error('Failed to save canvas:', err);
      setSaveState('idle');
      addToast({ title: 'Save Error', description: err.message || 'An error occurred while saving.', type: 'error' });
    }
  }, [nodes, edges, drawings, currentFile, saveState, addToast]);

  const loadCanvas = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const res = await window.electronAPI.loadWorkspace();
      if (res?.success && res.data) {
        setNodes(res.data.nodes || []);
        setEdges(res.data.edges || []);
        setDrawings(res.data.drawings || []);
        setCurrentFile(res.filePath);
        setHasUnsavedChanges(false);
        setTimeout(() => customFitView(), 50);
        addToast({ title: 'Workspace Loaded', description: 'Your canvas has been loaded successfully.', type: 'success'});
      } else if (!res?.canceled) {
        addToast({ title: 'Load Failed', description: 'Failed to load canvas or invalid file format.', type: 'error'});
      }
    } catch (err) {
      console.error('Failed to load canvas:', err);
      addToast({ title: 'Load Error', description: err.message || 'An error occurred while loading.', type: 'error'});
    }
  }, [setNodes, setEdges, customFitView, addToast]);

  const exportCanvasToPNG = useCallback(() => {
    const viewportNode = document.querySelector('.react-flow__viewport');
    if (!viewportNode) return;
    toPng(viewportNode, { backgroundColor: '#0a0a0a' })
      .then((dataUrl) => {
        const link = document.createElement('a');
        link.download = 'canvas-export.png';
        link.href = dataUrl;
        link.click();
        addToast({ title: 'Export Successful', description: 'Canvas has been exported to PNG.', type: 'success'});
      })
      .catch((err) => {
        console.error('Failed to export image', err);
        addToast({ title: 'Export Failed', description: 'There was an error generating the PNG.', type: 'error'});
      });
  }, [addToast]);

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
