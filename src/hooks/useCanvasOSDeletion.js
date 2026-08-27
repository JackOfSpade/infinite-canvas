import { useCallback } from 'react';
import { EventLogger } from '../utils/EventLogger';
import { cancelNodeTasksRecursively } from '../utils/canvasInteractions';

/**
 * Recursively collects OS file/folder paths from a node tree, for the "also move
 * the linked file(s) to trash?" prompt on delete.
 *
 * ONLY nodes that ARE the canvas's representation of a file/folder contribute:
 * - document nodes: their own filePath.
 * - listing nodes: their filePath + image assets.
 * - group nodes created from a folder drag: the folder path.
 * - organic sub-canvas groups: recurses into children.
 *
 * Workflow/aggregator HUBS (sellhub, jobhub) deliberately do NOT contribute.
 * A hub merely REFERENCES external user files it was handed to work on — a
 * SellHub's product photos, a Job Search Module's dropped resume — which the user owns
 * (and, for a SellHub, are usually still represented by the source document
 * nodes left on the canvas, so trashing them would orphan those). Deleting a
 * hub cancels its run (see onNodesDelete); it must NOT offer to trash the
 * user's resume/photos. This is the fix for "deleting a hub mid-run asks to
 * keep the file on disk."
 */
function extractPaths(nodes, pathsToDelete) {
  nodes.forEach(n => {
    // Nodes that ARE a single file's on-canvas representation.
    if ((n.type === 'document' || n.type === 'listing') && n.data?.filePath) {
      pathsToDelete.add(n.data.filePath);
    }

    // Listing nodes can hold multiple image assets.
    if (n.type === 'listing' && Array.isArray(n.data?.imagePaths)) {
      n.data.imagePaths.forEach(p => {
        if (p) pathsToDelete.add(p);
      });
    }

    if (n.type === 'group') {
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

export function useCanvasOSDeletion({ requestConfirm, undo }) {
  const onNodesDelete = useCallback((deletedNodes) => {
    // Cancel any active background tasks for these nodes (including nested nodes)
    if (window.electronAPI?.cancelNodeTask) {
      cancelNodeTasksRecursively(deletedNodes);
    }
    // Job cards are disposable result-display nodes. Deleting a card, clearing
    // a Job Board, or replacing a board cascade must not cancel the independent
    // Local AI writer session represented by that card. A later successful
    // regeneration cleans only the exact terminal handoff it replaces.

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
        },
        // X-in-the-corner: roll the canvas back so the nodes that triggered
        // this dialog reappear. ReactFlow has already pushed the deletion
        // onto the undo stack by the time onNodesDelete fires, so one undo()
        // restores both nodes and their edges. OS files were never touched
        // (we only trash on Confirm), so nothing to clean up on disk.
        onAbort: undo ? () => undo() : undefined,
      });
    }
  }, [requestConfirm, undo]);

  return { onNodesDelete };
}
