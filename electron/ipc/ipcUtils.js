import { logger } from '../logger.js';
/**
 * IPC Utility functions for robust handler lifecycle management.
 */
import electronPkg from 'electron';
const { ipcMain } = electronPkg;

// ── Node Task Registry ──────────────────────────────────────────────────────
const nodeTasks = new Map(); // nodeId -> Set<AbortController>

/**
 * Register an AbortController for a specific node.
 * Allows cancelling background tasks (e.g. search, analysis) when the node is deleted.
 */
function registerNodeTask(nodeId, ac) {
  if (!nodeId) return;
  if (!nodeTasks.has(nodeId)) {
    nodeTasks.set(nodeId, new Set());
  }
  nodeTasks.get(nodeId).add(ac);
  logger.info(`[IPC] Registered task for node ${nodeId}`);
}

/**
 * Unregister an AbortController when a task completes.
 */
function unregisterNodeTask(nodeId, ac) {
  const set = nodeTasks.get(nodeId);
  if (set) {
    set.delete(ac);
    if (set.size === 0) nodeTasks.delete(nodeId);
  }
}

/**
 * Cancel all active background tasks for a specific node.
 */
export function abortNodeTasks(nodeId) {
  const set = nodeTasks.get(nodeId);
  if (set) {
    logger.info(`[IPC] Aborting ${set.size} tasks for node ${nodeId}`);
    for (const ac of set) {
      ac.abort(new Error('Node deleted'));
    }
    nodeTasks.delete(nodeId);
  }
}

/**
 * Creates an AbortController tied to the IPC event sender's lifecycle.
 * If the sender window is destroyed (e.g., closed by the user), the signal aborts.
 * Optionally aborts after a timeout.
 * 
 * @param {Electron.IpcMainInvokeEvent} event - The IPC event
 * @param {number} timeoutMs - Optional timeout in milliseconds
 * @returns {{ ac: AbortController, signal: AbortSignal, cleanup: Function }}
 */
export function createSenderAbortController(event, timeoutMs = 0) {
  const ac = new AbortController();
  const onSenderDestroyed = () => ac.abort(new Error('Sender destroyed'));
  
  event.sender.once('destroyed', onSenderDestroyed);

  let timeoutId = null;
  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => ac.abort(new Error('Timeout')), timeoutMs);
  }

  return {
    ac,
    signal: ac.signal,
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!event.sender.isDestroyed()) {
        event.sender.removeListener('destroyed', onSenderDestroyed);
      }
    }
  };
}

/**
 * Wraps an IPC handler with standardized error handling, lifecycle-aware abort signaling,
 * and standard `{ success, data, error }` return payloads.
 *
 * @param {string} channel - The IPC channel name
 * @param {Function} handler - Async function taking (event, args, signal)
 * @param {number} timeoutMs - Optional timeout
 */
export function handleSafe(channel, handler, timeoutMs = 0) {
  ipcMain.handle(channel, async (event, args) => {
    const { ac, signal, cleanup } = createSenderAbortController(event, timeoutMs);
    const nodeId = args?.nodeId;
    
    if (nodeId) {
      registerNodeTask(nodeId, ac);
    }

    try {
      const result = await handler(event, args, signal);
      
      // Guard: Window may have been closed during await
      if (event.sender.isDestroyed()) return { success: false, error: 'Window closed' };
      
      return { success: true, ...result };
    } catch (e) {
      if (signal.aborted) {
        return { success: false, error: e?.message === 'Node deleted' ? 'Node deleted' : 'Window closed' };
      }
      logger.error(`[${channel}] failed:`, e?.message || String(e));
      return { success: false, error: e?.message || String(e) };
    } finally {
      if (nodeId) {
        unregisterNodeTask(nodeId, ac);
      }
      cleanup();
    }
  });
}

