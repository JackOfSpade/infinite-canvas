/**
 * IPC Utility functions for robust handler lifecycle management.
 */
import electronPkg from 'electron';
const { ipcMain } = electronPkg;
import { logger } from '../logger.js';

// ── Node Task Registry ──────────────────────────────────────────────────────
// nodeId -> Map<AbortController, { registeredAt, channel }>. We track WHEN each
// task was registered and which channel it came from so the bug report can show
// a task's age + which IPC it is — a long-lived task with no recent log activity
// is the signature of a hang (e.g. a navigation on a dead VPN IP that never
// times out), which a bare count can't reveal.
const nodeTasks = new Map();

/**
 * Register an AbortController for a specific node.
 * Allows cancelling background tasks (e.g. search, analysis) when the node is deleted.
 */
function registerNodeTask(nodeId, ac, channel) {
  if (!nodeId) return;
  if (!nodeTasks.has(nodeId)) {
    nodeTasks.set(nodeId, new Map());
  }
  nodeTasks.get(nodeId).set(ac, { registeredAt: Date.now(), channel: channel || null });
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
    for (const ac of set.keys()) {
      ac.abort(new Error('Node deleted'));
    }
    nodeTasks.delete(nodeId);
  }
}

/**
 * Returns a snapshot of every node currently holding active IPC tasks.
 * Used by the bug-report generator so "I clicked Cancel but the pipeline
 * kept running" reports immediately reveal whether the cancel call actually
 * cleared the tasks or never fired at all.
 */
export function snapshotActiveNodeTasks() {
  const out = [];
  const now = Date.now();
  for (const [nodeId, set] of nodeTasks.entries()) {
    let oldestRegisteredAt = now;
    const channels = new Set();
    for (const meta of set.values()) {
      if (meta.registeredAt < oldestRegisteredAt) oldestRegisteredAt = meta.registeredAt;
      if (meta.channel) channels.add(meta.channel);
    }
    out.push({
      nodeId,
      taskCount: set.size,
      oldestAgeMs: now - oldestRegisteredAt,
      channels: [...channels],
    });
  }
  return out;
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
      registerNodeTask(nodeId, ac, channel);
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
      return { 
        success: false, 
        error: e?.message || String(e),
        isRateLimit: e?.isRateLimit,
        provider: e?.provider
      };
    } finally {
      if (nodeId) {
        unregisterNodeTask(nodeId, ac);
      }
      cleanup();
    }
  });
}
