import { useCallback, useEffect, useRef } from 'react';

export function useCanvasOSDeletion({ requestConfirm }) {
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const onNodesDelete = useCallback((deletedNodes) => {
    // Cancel any active background tasks for these nodes
    if (window.electronAPI?.cancelNodeTask) {
      deletedNodes.forEach(n => window.electronAPI.cancelNodeTask(n.id));
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
            if (!isMountedRef.current) break;
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
