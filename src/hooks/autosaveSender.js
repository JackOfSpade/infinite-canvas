import { createCanvasDeltaEncoder } from '../../electron/ipc/workspaceSaveDelta.js';

// Records per hand-over call when many must be sent (the first auto-save after
// opening a canvas, or after the app process lost its copy). Each call blocks
// the window while its records are copied, so a large canvas goes over in
// small calls. Waiting for each reply is what lets the window paint in
// between; a timer would be slowed to one per second in a hidden window.
const AUTOSAVE_STAGE_BATCH = 16;

/**
 * Hands a canvas to the app process for an auto-save, sending only the nodes
 * that changed since the last one (see workspaceSaveDelta.js). One sender per
 * window. Returns the save reply; `onBlocked(ms)` reports each stretch the
 * window was blocked copying data out.
 *
 * Falls back to sending the whole canvas when the bridge has no staging call
 * or the app process no longer holds what earlier saves sent.
 */
export function createAutosaveSender() {
  const encoder = createCanvasDeltaEncoder();
  const timed = (onBlocked, call) => {
    const startedAt = performance.now();
    const pending = call();
    onBlocked?.(performance.now() - startedAt);
    return pending;
  };
  return async function sendAutosave({ api, data, filePath, onBlocked }) {
    const sendWhole = () => timed(onBlocked, () => api.saveWorkspace({ data, filePath }));
    if (typeof api.stageWorkspaceChunks !== 'function') return sendWhole();
    const startedAt = performance.now();
    const { session, root, chunks, settle } = encoder.encode(data);
    onBlocked?.(performance.now() - startedAt);
    let reply;
    try {
      // The last batch rides with the save itself.
      let sent = 0;
      while (chunks.length - sent > AUTOSAVE_STAGE_BATCH) {
        const batch = chunks.slice(sent, sent + AUTOSAVE_STAGE_BATCH);
        sent += batch.length;
        const staged = await timed(onBlocked, () => api.stageWorkspaceChunks({ session, chunks: batch }));
        if (!staged?.success) {
          settle('lost');
          return sendWhole();
        }
      }
      reply = await timed(onBlocked, () => api.saveWorkspace({
        canvas: { session, root, chunks: sent ? chunks.slice(sent) : chunks },
        filePath,
      }));
    } catch (error) {
      settle('lost');
      throw error;
    }
    if (reply?.needsFullCanvas) {
      settle('lost');
      return sendWhole();
    }
    settle(reply?.success ? 'saved' : 'failed');
    return reply;
  };
}
