import { useCallback } from 'react';

export function useCanvasOSDeletion({ requestConfirm }) {
  const onNodesDelete = useCallback((deletedNodes) => {
    // Cancel any active background tasks for these nodes (including nested nodes)
    if (window.electronAPI?.cancelNodeTask) {
      const cancelRecursively = (nodes) => {
        nodes.forEach(n => {
          window.electronAPI.cancelNodeTask(n.id);
          if (n.data?.canvasData?.nodes) {
            cancelRecursively(n.data.canvasData.nodes);
          }
          // Also check legacy nodes shape if present
          if (n.data?.nodes) {
            cancelRecursively(n.data.nodes);
          }
        });
      };
      cancelRecursively(deletedNodes);
    }

    const documentNodes = deletedNodes.filter(n => n.type === 'document' && n.data?.filePath);
    if (documentNodes.length > 0 && window.electronAPI) {
      requestConfirm({
        title: 'Delete from OS?',
        message: 'Do you also want to move the actual linked file(s) to trash?',
        confirmLabel: 'Move to Trash',
        cancelLabel: 'Keep OS File',
        variant: 'warning',
        onConfirm: async () => {
          for (const node of documentNodes) {
            // Proceed with OS deletion even if unmounted because user confirmed
            try {
              await window.electronAPI.deleteOSFile(node.data.filePath);
            } catch (err) {
              console.error('Failed to trash file:', err);
            }
          }
        }
      });
    }
  }, [requestConfirm]);

  return { onNodesDelete };
}
