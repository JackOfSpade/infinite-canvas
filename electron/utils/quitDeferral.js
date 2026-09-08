/**
 * Records a Cmd/Ctrl+Q that arrives while one window already owns its close
 * handshake. The handshake gets exactly one chance to finish: success resumes
 * the app-wide quit; cancel/save failure consumes the intent so a later,
 * unrelated close cannot unexpectedly terminate the app.
 */
export function createPendingGlobalQuitDeferral() {
  let pending = false;

  return {
    defer() {
      pending = true;
    },
    consumeAfterClose(succeeded) {
      const shouldResume = pending && Boolean(succeeded);
      pending = false;
      return shouldResume;
    },
    isPending() {
      return pending;
    },
  };
}
