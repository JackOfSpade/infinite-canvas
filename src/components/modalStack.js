// Tracks how many modal overlays are currently open. Global keyboard shortcuts
// (undo/redo in useUndoRedo) suppress themselves while any modal is open by
// listening for the 'modal-stack-changed' event this dispatches. Any full-screen
// modal that owns the keyboard should bump the count on mount and drop it on
// unmount (see Dialog, ConfirmDialog).
let activeModalCount = 0;

export function updateModalCount(delta) {
  activeModalCount = Math.max(0, activeModalCount + delta);
  window.dispatchEvent(new CustomEvent('modal-stack-changed', {
    detail: { count: activeModalCount },
  }));
}
