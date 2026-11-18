import { useSyncExternalStore } from 'react';

// Tracks how many modal overlays are currently open. Global keyboard shortcuts
// (undo/redo, tool shortcuts, WASD panning, node delete) suppress themselves
// while any modal is open by listening for the 'modal-stack-changed' event
// this dispatches. Any full-screen modal that owns the keyboard should bump
// the count on mount and drop it on unmount (see Dialog, ConfirmDialog).
let activeModalCount = 0;

export function updateModalCount(delta) {
  activeModalCount = Math.max(0, activeModalCount + delta);
  window.dispatchEvent(new CustomEvent('modal-stack-changed', {
    detail: { count: activeModalCount },
  }));
}

const getModalCount = () => activeModalCount;

function subscribeModalStack(onChange) {
  window.addEventListener('modal-stack-changed', onChange);
  return () => window.removeEventListener('modal-stack-changed', onChange);
}

/**
 * Live modal-open count for gating a global keyboard/canvas listener.
 * Shared by every listener that must go quiet while a dialog/menu/lightbox is
 * open (useUndoRedo, useCanvasKeyboardShortcuts, useCanvasWASD, Canvas.jsx's
 * delete-key gating) — previously each reimplemented this same
 * addEventListener('modal-stack-changed', ...) boilerplate independently.
 */
export function useModalStackCount() {
  return useSyncExternalStore(subscribeModalStack, getModalCount, getModalCount);
}
