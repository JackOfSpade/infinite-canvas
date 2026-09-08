// A minimized/occluded Chromium renderer can pause requestAnimationFrame
// indefinitely (or deliver it at roughly one frame per second). Keep the
// normal two-frame path for a visible React Flow canvas, but never make the
// close handshake depend on both frames arriving: Electron's main process has
// a 1.5s fail-closed ACK deadline.
export const QUIT_COMMIT_SETTLE_FALLBACK_MS = 100;

/**
 * Wait for controlled React Flow batches accepted before a quit fence to run.
 *
 * React Flow flushes its setNodes/setEdges queue from a layout effect, so two
 * animation frames are a useful visible-window settle point. The single timer
 * fallback is deliberately shared by both frames rather than chained after
 * them: background timer throttling may stretch it to about one second, which
 * still leaves room beneath main's 1.5s commit-ACK timeout. Cancelling queued
 * frames avoids a stale callback retaining this commit after the fallback wins.
 *
 * Optional scheduler injection keeps the paused-rAF behavior deterministic in
 * unit tests without mounting a renderer.
 */
export function settlePreFenceCanvasBatches({
  requestFrame = globalThis.requestAnimationFrame,
  cancelFrame = globalThis.cancelAnimationFrame,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  timeoutMs = QUIT_COMMIT_SETTLE_FALLBACK_MS,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let firstFrameId = null;
    let secondFrameId = null;
    let timeoutId = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) clearTimer?.(timeoutId);
      if (firstFrameId !== null) cancelFrame?.(firstFrameId);
      if (secondFrameId !== null) cancelFrame?.(secondFrameId);
      resolve();
    };

    // Schedule once, not once per rAF. If rAF is paused and background timer
    // throttling applies, this is one ~1s wait rather than two (~2s).
    timeoutId = setTimer(finish, timeoutMs);
    if (typeof requestFrame !== 'function') return;

    firstFrameId = requestFrame(() => {
      firstFrameId = null;
      if (settled) return;
      secondFrameId = requestFrame(finish);
    });
  });
}
