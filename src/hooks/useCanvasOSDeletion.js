import { useCallback } from 'react';

export function useCanvasOSDeletion({ requestConfirm }) {
  const onNodesDelete = useCallback((deletedNodes) => {
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
