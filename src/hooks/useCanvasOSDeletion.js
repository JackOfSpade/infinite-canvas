import { useCallback } from 'react';
import { EventLogger } from '../utils/EventLogger';
import { cancelNodeTasksRecursively } from '../utils/canvasInteractions';

/**
 * Recursively collects OS file/folder paths from a node tree.
 * - document nodes: contributes their own filePath.
 * - group nodes created from a folder drag: contributes the folder path.
 * - organic sub-canvas groups: recurses into children.
 */
function extractPaths(nodes, pathsToDelete) {
  nodes.forEach(n => {
    if (n.type === 'document' && n.data?.filePath) {
      pathsToDelete.add(n.data.filePath);
    } else if (n.type === 'group') {
      if (n.data?.filePath) {
        // Group created from a folder drag-in: delete the entire OS folder
        pathsToDelete.add(n.data.filePath);
      } else {
        // Organic sub-canvas: recurse into children to delete inner files
        if (n.data?.canvasData?.nodes) extractPaths(n.data.canvasData.nodes, pathsToDelete);
        if (n.data?.nodes) extractPaths(n.data.nodes, pathsToDelete);
      }
    }
  });
}

export function useCanvasOSDeletion({ requestConfirm }) {
  const onNodesDelete = useCallback((deletedNodes) => {
    // Cancel any active background tasks for these nodes (including nested nodes)
    if (window.electronAPI?.cancelNodeTask) {
      cancelNodeTasksRecursively(deletedNodes);
    }

    const pathsToDelete = new Set();
    extractPaths(deletedNodes, pathsToDelete);
    const osPaths = Array.from(pathsToDelete);

    if (osPaths.length > 0 && window.electronAPI) {
      requestConfirm({
        title: 'Delete from OS?',
        message: 'Do you also want to move the actual linked file(s) and folder(s) to trash?',
        confirmLabel: 'Move to Trash',
        cancelLabel: 'Keep OS File',
        variant: 'warning',
        onConfirm: async () => {
          for (const path of osPaths) {
            // Proceed with OS deletion even if unmounted because user confirmed
            try {
              await window.electronAPI.deleteOSFile(path);
            } catch (err) {
              EventLogger.error('Failed to trash file/folder:', err);
            }
          }
        }
      });
    }
  }, [requestConfirm]);

  return { onNodesDelete };
}
