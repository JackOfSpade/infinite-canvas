// A UI chat press is itself the user's deliberate instruction to start or
// replace a chat.  This capability lets the main IPC adapter communicate that
// fact to the controller without accepting an equivalent renderer payload.
//
// It is intentionally identity-only: it carries no sender, window, job, or
// session data, is never serialized, and can be minted only by main-process
// modules which import this file.  Direct controller callers therefore retain
// the restart confirmation policy unless they were explicitly routed through
// the guarded UI adapter.
const uiRestartContexts = new WeakSet();

export function createUiRestartContext() {
  const context = Object.freeze({});
  uiRestartContexts.add(context);
  return context;
}

export function isUiRestartContext(value) {
  return value !== null && typeof value === 'object' && uiRestartContexts.has(value);
}
