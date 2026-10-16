// React functional updates may be queued, eagerly evaluated, or replayed.
// A flag set by the updater is not a synchronous acknowledgement. Require an
// observable publication while the caller still owns its exact operation.
export async function waitForJobRendererCommit({ isCurrent, isCommitted, waitForFrame, maxFrames = 8 }) {
  for (let attempt = 0; attempt <= maxFrames; attempt++) {
    if (!isCurrent()) return false;
    if (isCommitted()) return true;
    if (attempt < maxFrames) await waitForFrame();
  }
  return false;
}
