import { useState, useCallback } from 'react';
import { EventLogger } from '../utils/EventLogger';

const IS_MAC = (() => {
  const p = navigator.userAgentData?.platform ?? navigator.platform ?? '';
  return p.toLowerCase().includes('mac');
})();

export function useConfirmDialog() {
  const [confirmDialogData, setConfirmDialogData] = useState(null);

  const requestConfirm = useCallback((data) => {
    EventLogger.log(`ConfirmDialog requested: title="${data.title}"`);
    setConfirmDialogData(data);
  }, []);

  const requestClearConfirm = useCallback((onConfirm) => {
    EventLogger.log(`ConfirmDialog requested: title="Clear Canvas"`);
    setConfirmDialogData({
      title: "Clear Canvas",
      message: `This removes unlocked content from the current canvas. Undo with ${IS_MAC ? '⌘' : 'Ctrl+'}Z restores the visual content, but it cannot restart background work or recovery data discarded for removed modules. At the root canvas, the workspace file association is also reset.`,
      confirmLabel: "Clear Unlocked Content",
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
