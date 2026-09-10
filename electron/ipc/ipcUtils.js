/**
 * IPC Utility functions for robust handler lifecycle management.
 */
import electronPkg from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
const { ipcMain } = electronPkg;
import { logger } from '../logger.js';

// AI handoffs can be reached several async layers below an IPC handler. Keep
// the originating WebContents in async-local state so a sensitive manual-AI
// prompt is delivered only to the window that initiated the job, never to a
// focused or broadcast window.
const ipcRequestContext = new AsyncLocalStorage();

export function getCurrentIpcRequestContext() {
  return ipcRequestContext.getStore() || null;
}

// Test seam for exercising main-process helpers that rely on the same request
// context as handleSafe, without registering a real Electron IPC handler.
export function __runWithIpcRequestContextForTests(context, callback) {
  return ipcRequestContext.run(context || null, callback);
}

// ── Node Task Registry ──────────────────────────────────────────────────────
// WebContents -> Map<nodeId, Map<AbortController, { registeredAt, channel }>>.
// Node IDs are unique only inside one canvas. Keying this registry globally by
// nodeId made deleting `node-1` in one window abort `node-1` work in every other
// open canvas. Sender ownership keeps cancellation local while still letting
// diagnostics take an app-wide snapshot.
const nodeTasks = new Map();
const taskRegistrySenders = new WeakSet();
// Aborted controllers remain registered until their handleSafe `finally` runs.
// That makes repeated acknowledged cancellation join the same cleanup barrier
// instead of falsely reporting success merely because an earlier raw abort
// removed the registry row first.
const nodeTaskSettlements = new WeakMap();
// A renderer can crash after acknowledged cancellation returns its manual-AI
// run ids but before it copies them into canvas recovery state. Keep that exact
// acknowledgement in the main process until durable handoff completion confirms
// each id. Scope by WebContents as well as node id: canvas-local node ids may
// collide across windows. Refuse overflow instead of evicting an uncompleted id.
const acknowledgedManualAiRunIds = new WeakMap();
const MAX_ACKNOWLEDGED_MANUAL_AI_RUNS_PER_NODE = 256;
const MAX_ACKNOWLEDGED_MANUAL_AI_RUNS_PER_SENDER = 2_048;

function normalizedManualAiRunIds(runIds) {
  return [...new Set((Array.isArray(runIds) ? runIds : [])
    .filter(runId => typeof runId === 'string' && runId && runId.length <= 160))];
}

function retainAcknowledgedManualAiRunIds(sender, nodeId, runIds) {
  const discovered = normalizedManualAiRunIds(runIds);
  if (!sender || !nodeId) return discovered;
  ensureSenderRegistryCleanup(sender);
  let byNode = acknowledgedManualAiRunIds.get(sender);
  if (!byNode && discovered.length === 0) return [];
  if (!byNode) {
    byNode = new Map();
    acknowledgedManualAiRunIds.set(sender, byNode);
  }
  const existing = byNode.get(nodeId) || new Set();
  const additions = discovered.filter(runId => !existing.has(runId));
  const senderTotal = [...byNode.values()].reduce((sum, ids) => sum + ids.size, 0);
  if (
    existing.size + additions.length > MAX_ACKNOWLEDGED_MANUAL_AI_RUNS_PER_NODE
    || senderTotal + additions.length > MAX_ACKNOWLEDGED_MANUAL_AI_RUNS_PER_SENDER
  ) {
    const error = new Error('Too many acknowledged manual-AI runs are awaiting durable cleanup.');
    error.code = 'MANUAL_AI_ACKNOWLEDGEMENT_CAPACITY';
    throw error;
  }
  for (const runId of additions) existing.add(runId);
  if (existing.size > 0) byNode.set(nodeId, existing);
  return [...existing];
}

export function releaseAcknowledgedManualAiRunIds(sender, runIds) {
  const completed = new Set(normalizedManualAiRunIds(runIds));
  const byNode = sender ? acknowledgedManualAiRunIds.get(sender) : null;
  if (!byNode || completed.size === 0) return 0;
  let released = 0;
  for (const [nodeId, ids] of byNode) {
    for (const runId of completed) {
      if (ids.delete(runId)) released += 1;
    }
    if (ids.size === 0) byNode.delete(nodeId);
  }
  if (byNode.size === 0) acknowledgedManualAiRunIds.delete(sender);
  return released;
}

function ensureSenderRegistryCleanup(sender) {
  if (!sender || taskRegistrySenders.has(sender)) return;
  taskRegistrySenders.add(sender);
  sender.once('destroyed', () => {
    const tasks = nodeTasks.get(sender);
    if (tasks) {
      for (const controllers of tasks.values()) {
        for (const ac of controllers.keys()) {
          if (!ac.signal.aborted) ac.abort(new Error('Sender destroyed'));
        }
      }
    }
    // A handler is expected to settle cooperatively, but a broken dependency
    // can ignore AbortSignal forever. Do not retain the destroyed WebContents
    // in diagnostics/registry state while waiting for that detached promise.
    nodeTasks.delete(sender);
    acknowledgedManualAiRunIds.delete(sender);
  });
}

function senderTaskMap(sender, create = false) {
  let tasks = nodeTasks.get(sender);
  if (!tasks && create) {
    tasks = new Map();
    nodeTasks.set(sender, tasks);
  }
  return tasks;
}

/**
 * Register an AbortController for a specific node.
 * Allows cancelling background tasks (e.g. search, analysis) when the node is deleted.
 */
function registerNodeTask(sender, nodeId, ac, channel, manualAiRunId = null) {
  if (!sender || !nodeId) return;
  ensureSenderRegistryCleanup(sender);
  const tasks = senderTaskMap(sender, true);
  if (!tasks.has(nodeId)) {
    tasks.set(nodeId, new Map());
  }
  let resolveSettled;
  const settled = new Promise(resolve => { resolveSettled = resolve; });
  nodeTaskSettlements.set(ac, { settled, resolveSettled });
  tasks.get(nodeId).set(ac, {
    registeredAt: Date.now(),
    channel: channel || null,
    manualAiRunId: typeof manualAiRunId === 'string' && manualAiRunId
      ? manualAiRunId
      : null,
  });
  logger.info(`[IPC] Registered task for sender ${sender.id ?? '?'} node ${nodeId}`);
}

/**
 * Unregister an AbortController when a task completes.
 */
function unregisterNodeTask(sender, nodeId, ac) {
  const tasks = senderTaskMap(sender);
  const set = tasks?.get(nodeId);
  if (set) {
    set.delete(ac);
    if (set.size === 0) tasks.delete(nodeId);
    if (tasks.size === 0) nodeTasks.delete(sender);
  }
  const settlement = nodeTaskSettlements.get(ac);
  settlement?.resolveSettled?.();
  nodeTaskSettlements.delete(ac);
}

/**
 * The cancellation sentinel every node-scoped abort carries. The MESSAGE is
 * load-bearing — `jobs.js` keys its "intentional abandonment, drop this run's
 * recovery sidecars" branch on `reason.message === 'Node deleted'`, and the IPC
 * layer forwards it verbatim as the caller-visible error — so it must not
 * change. The NAME is what identifies this as a cancellation to generic
 * abort-aware code (`fetch` rejects with this exact object, and a bare `Error`
 * made a user's Stop read as a network failure in `safeApiFetch`).
 */
export function cancellationError(message, cause = null) {
  const error = Object.assign(new Error(message), { name: 'AbortError' });
  // A bounded, renderer-supplied label for WHY this was cancelled. The message
  // cannot carry it (control flow and IPC contracts key on the message), so
  // diagnostics read this instead of guessing from the sentinel.
  const label = String(cause || '').trim().toLowerCase().slice(0, 40);
  if (/^[a-z][a-z0-9-]*$/.test(label)) error.cancelCause = label;
  return error;
}

export function nodeCancellationError(cause = null) {
  return cancellationError('Node deleted', cause);
}

/**
 * Cancel all active background tasks for a specific node.
 */
export function abortNodeTasks(nodeId, sender = null, reason = nodeCancellationError()) {
  const owners = sender ? [[sender, senderTaskMap(sender)]] : [...nodeTasks.entries()];
  for (const [owner, tasks] of owners) {
    const set = tasks?.get(nodeId);
    if (!set) continue;
    logger.info(`[IPC] Aborting ${set.size} tasks for sender ${owner?.id ?? '?'} node ${nodeId}`);
    for (const ac of set.keys()) {
      ac.abort(reason);
    }
  }
}

/**
 * Abort one sender's node-scoped handlers and wait until their `handleSafe`
 * finally blocks have run. The bounded wait reports failure rather than claiming
 * cancellation completed while a non-cooperative handler is still draining.
 */
export async function abortNodeTasksAndWait(
  nodeId,
  sender,
  reason = nodeCancellationError(),
  timeoutMs = 30_000,
) {
  const tasks = senderTaskMap(sender);
  const entries = [...(tasks?.get(nodeId)?.entries() || [])];
  const controllers = entries.map(([controller]) => controller);
  const activeManualAiRunIds = [...new Set(
    entries.map(([, meta]) => meta?.manualAiRunId).filter(Boolean),
  )];
  // Retain before firing AbortSignal. A cooperative handler can unregister in
  // the same turn; later retries must still recover these ids even after that
  // active registry row has disappeared.
  const manualAiRunIds = retainAcknowledgedManualAiRunIds(
    sender,
    nodeId,
    activeManualAiRunIds,
  );
  const settlements = controllers
    .map(controller => nodeTaskSettlements.get(controller)?.settled)
    .filter(Boolean);
  abortNodeTasks(nodeId, sender, reason);
  if (settlements.length === 0) {
    return { abortedCount: controllers.length, settled: true, manualAiRunIds };
  }

  let timeoutId = null;
  const timeout = new Promise(resolve => {
    timeoutId = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || 30_000));
  });
  const settled = await Promise.race([
    Promise.allSettled(settlements).then(() => true),
    timeout,
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  return { abortedCount: controllers.length, settled, manualAiRunIds };
}

/**
 * Returns a snapshot of every node currently holding active IPC tasks.
 * Used by the bug-report generator so "I clicked Cancel but the pipeline
 * kept running" reports immediately reveal whether the cancel call actually
 * cleared the tasks or never fired at all.
 */
export function snapshotActiveNodeTasks(senderId = null) {
  const out = [];
  const now = Date.now();
  for (const [sender, tasks] of nodeTasks.entries()) {
    if (senderId != null && sender?.id !== senderId) continue;
    for (const [nodeId, set] of tasks.entries()) {
      let oldestRegisteredAt = now;
      const channels = new Set();
      for (const meta of set.values()) {
        if (meta.registeredAt < oldestRegisteredAt) oldestRegisteredAt = meta.registeredAt;
        if (meta.channel) channels.add(meta.channel);
      }
      out.push({
        senderId: sender?.id ?? null,
        nodeId,
        taskCount: set.size,
        oldestAgeMs: now - oldestRegisteredAt,
        channels: [...channels],
      });
    }
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
function createSenderAbortController(event, timeoutMs = 0) {
  const ac = new AbortController();
  const onSenderDestroyed = () => ac.abort(new Error('Sender destroyed'));
  // A renderer reload replaces its IPC world but keeps the same WebContents.
  // Without this listener, an invoke already waiting on a manual-AI paste is
  // orphaned forever: the old renderer cannot receive its result and the new
  // renderer no longer owns the invoke continuation. Only a genuine main-frame
  // navigation tears down that continuation; in-page navigation must not
  // cancel active work.
  const onMainFrameNavigation = (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) ac.abort(new Error('Renderer navigated'));
  };
  
  event.sender.once('destroyed', onSenderDestroyed);
  event.sender.on?.('did-start-navigation', onMainFrameNavigation);

  let timeoutId = null;
  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => ac.abort(new Error('Timeout')), timeoutMs);
  }

  return {
    ac,
    signal: ac.signal,
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId);
      event.sender.removeListener?.('did-start-navigation', onMainFrameNavigation);
      if (!event.sender.isDestroyed()) {
        event.sender.removeListener('destroyed', onSenderDestroyed);
      }
    }
  };
}

/**
 * Return the cancellation reason without relying on the error a downstream
 * operation happened to throw. Fetch and browser libraries often replace an
 * AbortController's reason with a generic AbortError.
 */
function abortErrorMessage(signal, fallbackError) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  if (fallbackError?.message) return fallbackError.message;
  return 'Operation cancelled';
}

/** Preserve only compact primitive error identifiers across the IPC boundary. */
function ipcErrorCode(error) {
  const value = error?.code;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 128) : undefined;
}

/** Preserve a compact capability identifier when an IPC route is unsupported. */
function ipcErrorCapability(error) {
  const value = error?.capability;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 128) : undefined;
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
      registerNodeTask(
        event.sender,
        nodeId,
        ac,
        channel,
        typeof args?.manualAiRunId === 'string' ? args.manualAiRunId : null,
      );
    }

    try {
      const result = await ipcRequestContext.run(
        {
          sender: event.sender,
          nodeId: nodeId || null,
          channel,
          // A renderer-created id spanning every manual AI step in one logical
          // workflow. nonApiAi uses it to replay accepted copy/paste steps after
          // a process restart without ever confusing two runs of the same node.
          manualAiRunId: typeof args?.manualAiRunId === 'string' ? args.manualAiRunId : null,
          // Recovery semantics are workflow-owned renderer state. In particular,
          // a late background source refresh appends its scored rows while a
          // normal search/re-analysis replaces the prior result set.
          manualAiRecoveryMode: typeof args?.manualAiRecoveryMode === 'string'
            ? args.manualAiRecoveryMode.trim().slice(0, 80)
            : null,
        },
        () => handler(event, args, signal),
      );
      
      // Guard: Window may have been closed during await
      if (event.sender.isDestroyed()) return { success: false, error: 'Window closed' };
      // A cooperative handler may finish just after its cancellation signal
      // fired. Do not report that detached work as successful.
      if (signal.aborted) return { success: false, error: abortErrorMessage(signal) };
      
      return { success: true, ...result };
    } catch (e) {
      if (signal.aborted) {
        return { success: false, error: abortErrorMessage(signal, e) };
      }
      logger.error(`[${channel}] failed:`, e?.message || String(e));
      return { 
        success: false, 
        error: e?.message || String(e),
        errorCode: ipcErrorCode(e),
        capability: ipcErrorCapability(e),
        isRateLimit: e?.isRateLimit,
        provider: e?.provider
      };
    } finally {
      if (nodeId) {
        unregisterNodeTask(event.sender, nodeId, ac);
      }
      cleanup();
    }
  });
}
