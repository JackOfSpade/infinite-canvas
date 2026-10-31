/**
 * IPC Utility functions for robust handler lifecycle management.
 */
import electronPkg from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
const { ipcMain } = electronPkg;
import { logger } from '../logger.js';
import { ensureListingLivenessRules } from './listingLivenessCalibration.js';

// AI handoffs can be reached several async layers below an IPC handler. Keep
// the originating WebContents in async-local state so a sensitive manual-AI
// prompt is delivered only to the window that initiated the job, never to a
// focused or broadcast window.
const ipcRequestContext = new AsyncLocalStorage();

export function getCurrentIpcRequestContext() {
  return ipcRequestContext.getStore() || null;
}

// Host-owned companion workflows bind handoffs to their canvas owner rather
// than giving the restricted child a general AI bridge.
export function runWithIpcRequestContext(context, callback) {
  return ipcRequestContext.run(context || null, callback);
}

// Test seam for exercising main-process helpers that rely on the same request
// context as handleSafe, without registering a real Electron IPC handler.
export function __runWithIpcRequestContextForTests(context, callback) {
  return runWithIpcRequestContext(context, callback);
}

// ── Node Task Registry ──────────────────────────────────────────────────────
// WebContents -> Map<nodeId, Map<AbortController, { registeredAt, channel }>>.
// Node IDs are unique only inside one canvas. Keep ordinary cancellation local
// to its sender; retained MCP invocations can also be found by node and logical
// run after a replacement renderer takes ownership.
const nodeTasks = new Map();
// File exports/imports can own durable transactions without a canvas node id.
// Track every invoke by sender as well, so quit can drain those transactions
// before destroying their renderer. Diagnostics keep using the node-only map.
const senderTasks = new Map();
// Once an invocation admits a handoff, its prompt/answer owner lives in main.
// A reload can re-present that handoff; MCP also serves it without a renderer.
// Retain this policy for the whole invocation, including gaps between steps.
const senderTaskRendererLifecycle = new WeakMap();
// Startup can dispatch dozens of invokes against one WebContents before any
// settles. Share its lifecycle subscriptions instead of adding four listeners
// per invoke; controllers still retain independent handoff/cancellation state.
const senderLifecycleSubscriptions = new WeakMap();
const taskRegistrySenders = new WeakSet();
const quitPausedSenders = new WeakSet();
const QUIT_PAUSE_WORK_CHANNELS = new Set([
  'claim-job-analysis-operation', 'begin-job-continuation', 'claim-job-continuation', 'claim-job-board-run',
  'parse-career-data', 'resolve-job-search-location', 'interpret-job-preferences', 'resolve-search-roles',
  'evaluate-job-preferences', 'generate-job-queries', 'search-jobs', 'search-jobs-single-source', 'score-jobs',
  'research-job-compensation', 'confirm-job-location-consolidations', 'bucket-jobs', 'resolve-job-source', 'resume-job-source',
  'queue-local-application', 'prepare-official-posting-for-generation', 'refresh-official-postings', 'check-application-generation-gate', 'import-local-application', 'save-application', 'build-interview-brief',
  'analyze-photos', 'scrape-price-comps', 'synthesize-price', 'synthesize-prices-batch', 'synthesize-bundle-price',
  'rescrape-source', 'resolve-captcha', 'assess-platform-fit',
]);
// An admitted import may already be promoting output or issuing its export
// capability. Let already-admitted import/export transactions finish; new ones
// remain gated and their persisted application result is recoverable on restart.
// Claims/queue admissions likewise must return their allocated identity rather
// than orphan a lease or persisted job behind an aborted invoke response.
const QUIT_FINISH_COMMIT_CHANNELS = new Set([
  'claim-job-analysis-operation', 'begin-job-continuation', 'claim-job-continuation', 'claim-job-board-run',
  'queue-local-application', 'import-local-application', 'save-application',
]);

/** Main-owned admission fence; lifecycle save/pause/read IPC remains available. */
export function beginSenderQuitPause(sender) {
  if (!sender || sender.isDestroyed?.()) return false;
  quitPausedSenders.add(sender);
  return true;
}

export function releaseSenderQuitPause(sender) {
  return sender ? quitPausedSenders.delete(sender) : false;
}

export function appQuitPauseError() {
  return cancellationError('App paused for quit', 'app-quit');
}

export function isAppQuitPauseReason(reason) {
  return reason?.message === 'App paused for quit' && reason?.cancelCause === 'app-quit';
}
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
    for (const ac of senderTasks.get(sender)?.keys() || []) {
      if (senderTaskRendererLifecycle.get(ac)?.mcp) continue;
      if (!ac.signal.aborted) ac.abort(Object.assign(new Error('Sender destroyed'), { code: 'IPC_SENDER_DESTROYED' }));
    }
    // A handler is expected to settle cooperatively, but a broken dependency
    // can ignore AbortSignal forever. Do not retain the destroyed WebContents
    // in diagnostics/registry state while waiting for that detached promise.
    // MCP work still has a live main-process owner. Keep it cancellable and
    // drainable until the handler settles instead of detaching its registry.
    const byNode = nodeTasks.get(sender);
    for (const [nodeId, tasks] of byNode || []) {
      for (const ac of tasks.keys()) if (!senderTaskRendererLifecycle.get(ac)?.mcp) tasks.delete(ac);
      if (tasks.size === 0) byNode.delete(nodeId);
    }
    if (byNode?.size === 0) nodeTasks.delete(sender);
    const bySender = senderTasks.get(sender);
    for (const ac of bySender?.keys() || []) if (!senderTaskRendererLifecycle.get(ac)?.mcp) bySender.delete(ac);
    if (!bySender?.size) {
      senderTasks.delete(sender);
      quitPausedSenders.delete(sender);
      acknowledgedManualAiRunIds.delete(sender);
    }
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
function registerNodeTask(sender, nodeId, ac, channel, manualAiRunId = null, logTaskRegistration = true) {
  if (!sender || !nodeId) return;
  ensureSenderRegistryCleanup(sender);
  const tasks = senderTaskMap(sender, true);
  if (!tasks.has(nodeId)) {
    tasks.set(nodeId, new Map());
  }
  tasks.get(nodeId).set(ac, {
    registeredAt: Date.now(),
    channel: channel || null,
    manualAiRunId: typeof manualAiRunId === 'string' && manualAiRunId
      ? manualAiRunId
      : null,
  });
  // Name the channel. Every invoke registers its own AbortController, so two
  // registrations for one node a millisecond apart are ordinarily two
  // concurrent operations and nothing is overwritten — but without the
  // channel the line cannot be told apart from the same channel being
  // dispatched twice, which would be a renderer-side duplicate. A reader of
  // the bug report had to correlate against source to reach "benign".
  if (logTaskRegistration) {
    logger.info(`[IPC] Registered task for sender ${sender.id ?? '?'} node ${nodeId} channel ${channel || '?'}`);
  }
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
}

function registerSenderTask(sender, ac, { channel, nodeId, manualAiRunId }) {
  ensureSenderRegistryCleanup(sender);
  let tasks = senderTasks.get(sender);
  if (!tasks) { tasks = new Map(); senderTasks.set(sender, tasks); }
  let resolveSettled;
  const settled = new Promise(resolve => { resolveSettled = resolve; });
  nodeTaskSettlements.set(ac, { settled, resolveSettled });
  tasks.set(ac, { channel, nodeId: nodeId || null, manualAiRunId: manualAiRunId || null });
}

function unregisterSenderTask(sender, ac) {
  const tasks = senderTasks.get(sender);
  tasks?.delete(ac);
  if (tasks?.size === 0) senderTasks.delete(sender);
  nodeTaskSettlements.get(ac)?.resolveSettled?.();
  nodeTaskSettlements.delete(ac);
}

async function drainQuitTasks(sender, { nodeId = null, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 30_000);
  let abortedCount = 0;
  const manualAiRunIds = new Set();
  for (;;) {
    const entries = [...(senderTasks.get(sender)?.entries() || [])]
      .filter(([, meta]) => !nodeId || meta.nodeId === nodeId);
    if (entries.length === 0) return { settled: true, abortedCount, manualAiRunIds: [...manualAiRunIds] };
    const settlements = entries.map(([controller]) => nodeTaskSettlements.get(controller)?.settled).filter(Boolean);
    for (const [controller, meta] of entries) {
      if (meta.manualAiRunId) manualAiRunIds.add(meta.manualAiRunId);
      if (QUIT_PAUSE_WORK_CHANNELS.has(meta.channel) && !QUIT_FINISH_COMMIT_CHANNELS.has(meta.channel)
        && !controller.signal.aborted) {
        controller.abort(appQuitPauseError());
        abortedCount += 1;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { settled: false, abortedCount, manualAiRunIds: [...manualAiRunIds] };
    let timer;
    const settled = await Promise.race([
      Promise.allSettled(settlements).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), remaining); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) return { settled: false, abortedCount, manualAiRunIds: [...manualAiRunIds] };
    // Include persistence invocations already dispatched by an import's
    // completion before its renderer sees the new admission fence.
    await new Promise(resolve => setImmediate(resolve));
  }
}

export function drainSenderNodeTasksForQuit(sender, options = {}) {
  return drainQuitTasks(sender, options);
}

export function drainNodeTasksForQuit(nodeId, sender, options = {}) {
  return drainQuitTasks(sender, { ...options, nodeId });
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

function nodeTaskCancellationEntries(nodeId, sender, { manualAiRunIds = [] } = {}) {
  const local = [...(senderTaskMap(sender)?.get(nodeId)?.entries() || [])];
  const runIds = new Set(normalizedManualAiRunIds(manualAiRunIds));
  for (const [, meta] of local) if (meta.manualAiRunId) runIds.add(meta.manualAiRunId);
  for (const runId of acknowledgedManualAiRunIds.get(sender)?.get(nodeId) || []) runIds.add(runId);
  const entries = [];
  for (const [owner, tasks] of nodeTasks) {
    for (const [controller, meta] of tasks.get(nodeId) || []) {
      if (sender && owner !== sender) {
        const lifecycle = senderTaskRendererLifecycle.get(controller);
        if (!lifecycle?.mcp || !meta.manualAiRunId) continue;
        // An adopted run has the same identity in both invocations. Without
        // one (deletion before auto-resume), only a handoff whose old dock is
        // gone can be cancelled across senders. A live canvas with a coincident
        // node id and a different run must retain its own work.
        if (runIds.size > 0 ? !runIds.has(meta.manualAiRunId) : !(lifecycle.gone || lifecycle.navigating || owner.isDestroyed?.())) continue;
      }
      entries.push({ owner, controller, meta });
    }
  }
  return entries;
}

function abortNodeTaskEntries(nodeId, entries, reason) {
  const counts = new Map();
  for (const { owner } of entries) counts.set(owner, (counts.get(owner) || 0) + 1);
  for (const [owner, count] of counts) logger.info(`[IPC] Aborting ${count} tasks for sender ${owner?.id ?? '?'} node ${nodeId}`);
  for (const { controller } of entries) controller.abort(reason);
}

/** Cancel local node work and the same retained MCP run across renderers. */
export function abortNodeTasks(nodeId, sender = null, reason = nodeCancellationError(), options = {}) {
  abortNodeTaskEntries(nodeId, nodeTaskCancellationEntries(nodeId, sender, options), reason);
}

/**
 * Abort node-scoped handlers, including retained MCP owners reached from a new
 * sender, and wait until their `handleSafe` finally blocks have run. The bounded
 * wait reports failure while a non-cooperative handler is still draining.
 */
export async function abortNodeTasksAndWait(
  nodeId,
  sender,
  reason = nodeCancellationError(),
  timeoutMs = 30_000,
  options = {},
) {
  const entries = nodeTaskCancellationEntries(nodeId, sender, options);
  const controllers = entries.map(({ controller }) => controller);
  const activeManualAiRunIds = [...new Set(
    entries.map(({ meta }) => meta?.manualAiRunId).filter(Boolean),
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
  abortNodeTaskEntries(nodeId, entries, reason);
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
      // Keep a small, redacted per-controller shape for diagnostics that need
      // to distinguish one node's simultaneous operations.  In particular a
      // manual AI handoff is a legitimate long-lived IPC invocation, whereas
      // an unrelated operation on the same node may still be genuinely stuck.
      // Channel and opaque workflow id are control-plane metadata only; neither
      // is rendered, and no IPC arguments, prompt, response, or file path is
      // retained here.
      const taskDetails = [];
      for (const meta of set.values()) {
        if (meta.registeredAt < oldestRegisteredAt) oldestRegisteredAt = meta.registeredAt;
        if (meta.channel) channels.add(meta.channel);
        taskDetails.push({
          channel: meta.channel || null,
          manualAiRunId: meta.manualAiRunId || null,
        });
      }
      out.push({
        senderId: sender?.id ?? null,
        nodeId,
        taskCount: set.size,
        oldestAgeMs: now - oldestRegisteredAt,
        channels: [...channels],
        taskDetails,
      });
    }
  }
  return out;
}

/** Subscribe active invokes through one set of listeners per WebContents. */
function subscribeSenderLifecycle(sender, ac) {
  let subscription = senderLifecycleSubscriptions.get(sender);
  if (subscription) {
    subscription.controllers.add(ac);
    return subscription;
  }
  const controllers = new Set([ac]);
  const forEachController = callback => {
    for (const controller of [...controllers]) {
      const lifecycle = senderTaskRendererLifecycle.get(controller);
      if (lifecycle) callback(controller, lifecycle);
    }
  };
  const onSenderDestroyed = () => {
    forEachController((controller, lifecycle) => {
      lifecycle.gone = true;
      if (!lifecycle.mcp) controller.abort(Object.assign(new Error('Sender destroyed'), { code: 'IPC_SENDER_DESTROYED' }));
    });
  };
  const onRendererGone = () => {
    forEachController((controller, lifecycle) => {
      lifecycle.gone = true;
      if (!lifecycle.mcp) controller.abort(Object.assign(new Error('Renderer stopped'), { code: 'IPC_RENDERER_STOPPED' }));
    });
  };
  const onRendererReady = () => {
    forEachController((_controller, lifecycle) => { lifecycle.gone = false; lifecycle.navigating = false; });
  };
  // Generic invokes still lose their continuation on main-frame navigation.
  // Admitted handoffs remain main-owned and replay into the replacement dock;
  // navigation is presentation loss, not cancellation of those requests.
  const onMainFrameNavigation = (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    forEachController((controller, lifecycle) => {
      lifecycle.navigating = true;
      if (!lifecycle.handoff) controller.abort(Object.assign(new Error('Renderer navigated'), { code: 'IPC_RENDERER_NAVIGATED' }));
    });
  };

  subscription = {
    controllers,
    detach: () => {
      sender.removeListener?.('destroyed', onSenderDestroyed);
      sender.removeListener?.('render-process-gone', onRendererGone);
      sender.removeListener?.('dom-ready', onRendererReady);
      sender.removeListener?.('did-start-navigation', onMainFrameNavigation);
    },
  };
  senderLifecycleSubscriptions.set(sender, subscription);
  sender.once('destroyed', onSenderDestroyed);
  sender.on?.('render-process-gone', onRendererGone);
  sender.on?.('dom-ready', onRendererReady);
  sender.on?.('did-start-navigation', onMainFrameNavigation);
  return subscription;
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
  const rendererLifecycle = { handoff: false, mcp: false, gone: false, navigating: false };
  senderTaskRendererLifecycle.set(ac, rendererLifecycle);
  const subscription = subscribeSenderLifecycle(event.sender, ac);
  const retainHandoffRendererLifecycle = route => {
    if (!['manual', 'mcp'].includes(route)) return;
    rendererLifecycle.handoff = true;
    if (route === 'mcp') rendererLifecycle.mcp = true;
  };

  let timeoutId = null;
  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => ac.abort(Object.assign(new Error('Timeout'), { code: 'IPC_REQUEST_TIMEOUT' })), timeoutMs);
  }

  return {
    ac,
    signal: ac.signal,
    retainHandoffRendererLifecycle,
    isRendererIndependent: () => rendererLifecycle.mcp,
    isHandoffRendererGone: () => Boolean(event.sender.isDestroyed?.() || rendererLifecycle.gone),
    cleanup: () => {
      senderTaskRendererLifecycle.delete(ac);
      if (timeoutId) clearTimeout(timeoutId);
      subscription.controllers.delete(ac);
      if (subscription.controllers.size === 0) {
        subscription.detach();
        senderLifecycleSubscriptions.delete(event.sender);
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
 * Report-safe top frames of a thrown error. A bare `error.message` such as
 * "Cannot read properties of undefined (reading 'length')" names no code, so a
 * bug report could not locate the throw. Bug-report redaction blanks everything
 * from an absolute path to the end of its line, which would erase the
 * file:line:col, so reduce each frame to its basename here. Frames are joined
 * on one line because the report renders each log entry as a single line.
 */
function compactErrorStack(error, maxFrames = 6) {
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  const frames = stack.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('at '))
    .slice(0, maxFrames)
    // The directory part may contain spaces ("My Apps", "Application Support"),
    // so it cannot be matched as a non-space run: that left a stray path prefix
    // that the report's path redactor then swallowed together with the whole
    // rest of the line, reducing every frame to `at <local-path>`.
    .map(frame => frame.replace(/(^at (?:async )?|\()(?:file:\/\/)?[^()]*[\\/]([^\\/():]+:\d+(?::\d+)?)(?=\)?$)/, '$1$2'));
  return frames.join(' ← ');
}

export function __compactErrorStackForTests(error, maxFrames) {
  return compactErrorStack(error, maxFrames);
}

/**
 * Wraps an IPC handler with standardized error handling, lifecycle-aware abort signaling,
 * and standard `{ success, data, error }` return payloads.
 *
 * @param {string} channel - The IPC channel name
 * @param {Function} handler - Async function taking (event, args, signal)
 * @param {number|object} timeoutOrOptions - Optional timeout, or lifecycle hooks.
 * Set `logTaskRegistration: false` only for high-frequency routine probes;
 * node-task registration and cancellation remain active.
 * Set `validateArgs(args, event)` for a synchronous route-specific boundary
 * check. It runs before `args.nodeId` is read, registered, or logged, making
 * it safe for routes whose node ID grammar is stricter than the generic task
 * registry. Throws use the normal IPC error payload and cleanup path. Do not
 * return a Promise: registration must not begin until validation has settled.
 * `additionalNodeIds(args, event)` adds bounded secondary owners of the same
 * controller after validation. `reportCancellation` opts into cancelled:true.
 */
export function handleSafe(channel, handler, timeoutOrOptions = 0) {
  const options = timeoutOrOptions && typeof timeoutOrOptions === 'object'
    ? timeoutOrOptions
    : {};
  const timeoutMs = Number.isFinite(timeoutOrOptions) ? timeoutOrOptions : 0;
  ipcMain.handle(channel, async (event, args) => {
    if (quitPausedSenders.has(event.sender) && QUIT_PAUSE_WORK_CHANNELS.has(channel)) {
      return { success: false, pausedForQuit: true, errorCode: 'APP_QUIT_PAUSED', error: 'App paused for quit' };
    }
    const { ac, signal, cleanup, retainHandoffRendererLifecycle, isRendererIndependent, isHandoffRendererGone } = createSenderAbortController(event, timeoutMs);
    let nodeId = null;
    let additionalNodeIds = [];
    let senderTaskRegistered = false;

    try {
      // This must stay ahead of every `args.nodeId` read. Node IDs feed the
      // task registry and its diagnostic logging, so route-owned validation
      // belongs at this generic lifecycle boundary rather than only inside a
      // route handler (which runs after registration).
      if (typeof options.validateArgs === 'function') {
        const validationResult = options.validateArgs(args, event);
        if (validationResult && typeof validationResult.then === 'function') {
          throw new TypeError('IPC argument validation must be synchronous.');
        }
      }

      if (typeof options.additionalNodeIds === 'function') {
        const ids = options.additionalNodeIds(args, event);
        const maxAdditionalNodeIds = Number.isSafeInteger(options.maxAdditionalNodeIds)
          ? Math.max(1, Math.min(128, options.maxAdditionalNodeIds)) : 8;
        if (!Array.isArray(ids) || ids.length > maxAdditionalNodeIds || ids.some(id => typeof id !== 'string' || !id || id.length > 300)) {
          throw new TypeError('Additional IPC task owners must be bounded node identifiers.');
        }
        additionalNodeIds = [...new Set(ids)];
      }
      nodeId = args?.nodeId;
      registerSenderTask(event.sender, ac, { channel, nodeId,
        manualAiRunId: typeof args?.manualAiRunId === 'string' ? args.manualAiRunId : null });
      senderTaskRegistered = true;
      if (nodeId) {
        registerNodeTask(
          event.sender,
          nodeId,
          ac,
          channel,
          typeof args?.manualAiRunId === 'string' ? args.manualAiRunId : null,
          options.logTaskRegistration !== false,
        );
      }

      for (const ownerId of additionalNodeIds) if (ownerId !== nodeId) registerNodeTask(event.sender, ownerId, ac, channel,
        typeof args?.manualAiRunId === 'string' ? args.manualAiRunId : null, options.logTaskRegistration !== false);

      const livenessRules = options.captureListingLiveness === true
        ? await ensureListingLivenessRules() : null;
      if (signal.aborted) throw signal.reason || nodeCancellationError();
      const result = await ipcRequestContext.run(
        {
          sender: event.sender,
          abortController: ac,
          nodeId: nodeId || null,
          channel,
          retainHandoffRendererLifecycle,
          isHandoffRendererGone,
          livenessEvidence: new Map(),
          livenessRules,
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

      // Some workflows must make the handler's terminal result crash-durable
      // before the invoke can resolve. Keep this inside the same try/finally so
      // a failed durability barrier is reported as an operation failure and the
      // normal task/sender cleanup still runs.
      const beforeReplyResult = typeof options.beforeReply === 'function'
        ? await options.beforeReply({ event, args, signal, result, channel })
        : null;
      
      // Guard: Window may have been closed during await
      if (event.sender.isDestroyed() && !isRendererIndependent()) return { success: false, error: 'Window closed', errorCode: ipcErrorCode(signal.reason) || 'IPC_SENDER_DESTROYED' };
      // A cooperative handler may finish just after its cancellation signal
      // fired. Do not report that detached work as successful.
      if (signal.aborted) return { success: false, error: abortErrorMessage(signal), errorCode: ipcErrorCode(signal.reason), ...(options.reportCancellation === true ? { cancelled: true } : {}) };
      
      return {
        success: true,
        ...result,
        ...(beforeReplyResult && typeof beforeReplyResult === 'object' ? beforeReplyResult : {}),
      };
    } catch (e) {
      if (signal.aborted) {
        return { success: false, error: abortErrorMessage(signal, e), errorCode: ipcErrorCode(signal.reason), ...(options.reportCancellation === true ? { cancelled: true } : {}) };
      }
      const failureStack = compactErrorStack(e);
      logger.error(`[${channel}] failed:`, e?.message || String(e), ...(failureStack ? [`stack: ${failureStack}`] : []));
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
      for (const ownerId of additionalNodeIds) if (ownerId !== nodeId) unregisterNodeTask(event.sender, ownerId, ac);
      try { cleanup(); }
      finally { if (senderTaskRegistered) unregisterSenderTask(event.sender, ac); }
    }
  });
}
