import { useState, useCallback } from 'react';

const IS_MAC = (() => {
  const p = navigator.userAgentData?.platform ?? navigator.platform ?? '';
  return p.toLowerCase().includes('mac');
})();

export function useConfirmDialog() {
  const [confirmDialogData, setConfirmDialogData] = useState(null);

  const requestConfirm = useCallback((data) => {
    setConfirmDialogData(data);
  }, []);

  const requestClearConfirm = useCallback((onConfirm) => {
    setConfirmDialogData({
      title: "Clear Canvas",
      message: `This will remove all nodes, edges, and drawings. This action can be undone with ${IS_MAC ? '⌘' : 'Ctrl+'}Z.`,
      confirmLabel: "Clear Everything",
      cancelLabel: "Keep Canvas",
      variant: "danger",
      onConfirm
    });
  }, []);

  return {
    confirmDialogData,
    setConfirmDialogData,
    requestConfirm,
    requestClearConfirm
  };
}
