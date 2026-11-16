// Whether an auto-save is running right now. Saving a large canvas briefly
// blocks the window; the status bar shows this so the pause has a visible reason.
let active = false;
const listeners = new Set();

export function setAutosaveActive(next) {
  if (active === !!next) return;
  active = !!next;
  for (const listener of listeners) listener();
}

export function subscribeAutosaveActive(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isAutosaveActive() {
  return active;
}
