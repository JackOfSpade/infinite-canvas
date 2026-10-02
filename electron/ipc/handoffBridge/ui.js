import electronPkg from 'electron';
import { IPC_CHANNELS, IPC_EVENTS } from './contracts.js';
import { CONSTANTS } from './constants.js';
import { buildContinueMessage, buildStarterMessage } from './framing.js';
import { sanitizeActivityItem } from './log.js';
import { createUiRestartContext } from './restartContext.js';
import { recordBridgeChatCopyResult } from './telemetry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCK_STATES = new Set(['awaiting', 'working', 'blocked', 'broken', 'unreadable']);
const MAX_JOBS = 50;
const KEEP_ALIVE_MS = 30_000;
const STATUS_INTERVAL_MS = 250;
const LIMIT_KEYS = Object.freeze(['releaseTtlHours', 'chatKeyMaxAgeHours', 'idlePauseMinutes', 'jobsPerChat', 'epochSoftBytes', 'epochHardBytes']);
const HUB_KEY = /^[a-f0-9]{64}$/;
const ALARM_ID = /^[a-z0-9][a-z0-9_.:-]{0,99}$/i;
// Alarm kinds are a closed status vocabulary.  The dialog gets only the
// documented threshold facts, never an alarm id or any remote/renderer text.
const ANOMALY_ALARM_FACTS = Object.freeze({
  unknown_key: Object.freeze({ count: 5, minutes: 10 }),
  unknown_handoff: Object.freeze({ count: 5, minutes: 10 }),
  misrouted: Object.freeze({ count: 5, minutes: 10 }),
  rate_limited: Object.freeze({ count: 50, minutes: 1 }),
  held_caps: Object.freeze({ count: 3, minutes: 60 }),
});
const TUNNEL_LINE_FORBIDDEN = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]`);
// This mirrors the import-free shared hostname grammar at the IPC boundary.
// Keeping it local preserves the B6 import allow-list; composition may inject
// the shared validator through `validateHostname` for one canonical authority.
const fallbackHostname = value => typeof value === 'string'
  && value.length <= 253 && value === value.toLowerCase() && !value.endsWith('.')
  && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?){2,}$/.test(value);
const isValidPluginName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(value) && /^[\x20-\x7e]+$/.test(value);
const PAIRING_CODE = /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/i;
const noOp = () => undefined;
const safeCall = async (port, method, ...args) => {
  try { return typeof port?.[method] === 'function' ? await port[method](...args) : undefined; } catch { return undefined; }
};
const isCanvasSender = sender => sender?.__isCanvasRenderer === true;
const fixed = code => ({ success: false, code: code || 'INTERNAL' });
const success = fields => ({ success: true, ...(fields || {}) });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
// Mutation ports must acknowledge their durable/transport action explicitly.
// `undefined`, a throw normalized by safeCall, and an arbitrary object are
// failures: an optimistic renderer reply would make a failed Disable, revoke,
// or setup write indistinguishable from success.
const acknowledged = (value, { allowTrue = false } = {}) => value?.success === true || value?.ok === true || (allowTrue && value === true);
const IPC_CODES = new Set(['UNAVAILABLE', 'SENDER', 'BUSY', 'DECLINED', 'INVALID', 'NO_WINDOW', 'NOT_READY', 'TUNNEL_NOT_READY', 'TUNNEL_NOT_SERVING', 'NOT_LINKED', 'PAUSED', 'NO_CHAT', 'CLIPBOARD_FAILED', 'NOT_FOUND', 'UNKNOWN_JOB', 'LIMIT_REACHED', 'DISABLED', 'LINK_WOULD_BREAK', 'INTERNAL']);
const INTERNAL_CODES = Object.freeze({
  cancelled: 'DECLINED', declined: 'DECLINED', invalid: 'INVALID', invalid_arguments: 'INVALID',
  unknown_job: 'UNKNOWN_JOB', not_found: 'NOT_FOUND', lane_limit: 'LIMIT_REACHED',
  disabled: 'DISABLED', busy: 'BUSY', not_ready: 'NOT_READY', tunnel_not_ready: 'TUNNEL_NOT_READY',
  unlinked: 'NOT_LINKED', not_linked: 'NOT_LINKED', paused: 'PAUSED', no_chat: 'NO_CHAT',
  clipboard_failed: 'CLIPBOARD_FAILED', link_would_break: 'LINK_WOULD_BREAK', unavailable: 'UNAVAILABLE',
  sender: 'SENDER', no_window: 'NO_WINDOW', persist_failed: 'INTERNAL', internal_error: 'INTERNAL',
});
const registeredPublishListeners = new WeakMap();
const REQUIRED_INVOKE_CHANNELS = Object.freeze(Object.values(IPC_CHANNELS)
  .filter(channel => channel !== IPC_CHANNELS.PUBLISH_JOBS));
function fixedCode(code, fallback = 'INTERNAL') {
  if (typeof code !== 'string') return fallback;
  const normalized = code.toUpperCase();
  return IPC_CODES.has(normalized) ? normalized : (INTERNAL_CODES[code.toLowerCase()] || fallback);
}
function boundedActivity(value) {
  if (!Array.isArray(value)) return [];
  // Activity is an enumerated audit view. Do not blindly relay an injected
  // controller object (or a future error/message field) to the renderer.
  return value.slice(0, 200).flatMap(item => {
    const safe = sanitizeActivityItem(item);
    return safe ? [{ ...safe }] : [];
  });
}

function validJob(item) {
  return plain(item)
    && UUID.test(item.jobId || '')
    && typeof item.canvasFilePath === 'string'
    && item.canvasFilePath.startsWith('/')
    && item.canvasFilePath.length <= 4096
    && DOCK_STATES.has(item.dockState)
    && typeof item.sig === 'string'
    && item.sig.length <= 200;
}

function validPatch(payload, hostnameValid = fallbackHostname) {
  if (!plain(payload) || !plain(payload.patch)) return null;
  const patch = payload.patch;
  const allowed = new Set(['hostname', 'pluginName', 'scope', 'autoStart', 'autoRelease', 'limits', 'prefs', 'telemetryInBugReports']);
  if (Object.keys(patch).some(key => !allowed.has(key))) return null;
  // store.writeConfig is the shared-validator authority.  This layer only
  // rejects obviously malformed IPC shapes and never copies parsed input.
  if (Object.hasOwn(patch, 'hostname') && patch.hostname !== null && !hostnameValid(patch.hostname)) return null;
  if (Object.hasOwn(patch, 'pluginName') && !isValidPluginName(patch.pluginName)) return null;
  if (Object.hasOwn(patch, 'autoStart') && typeof patch.autoStart !== 'boolean') return null;
  if (Object.hasOwn(patch, 'autoRelease') && typeof patch.autoRelease !== 'boolean') return null;
  if (Object.hasOwn(patch, 'telemetryInBugReports') && typeof patch.telemetryInBugReports !== 'boolean') return null;
  if (Object.hasOwn(patch, 'scope') && (!plain(patch.scope) || Object.keys(patch.scope).some(key => !['applications', 'scoring', 'marketplace'].includes(key) || typeof patch.scope[key] !== 'boolean'))) return null;
  if (Object.hasOwn(patch, 'limits') && (!plain(patch.limits) || Object.keys(patch.limits).some(key => !['releaseTtlHours', 'chatKeyMaxAgeHours', 'idlePauseMinutes', 'jobsPerChat', 'epochSoftBytes', 'epochHardBytes'].includes(key) || !Number.isSafeInteger(patch.limits[key]) || patch.limits[key] < 0))) return null;
  if (Object.hasOwn(patch, 'prefs') && (!plain(patch.prefs) || Object.keys(patch.prefs).some(key => !['sourcePolicy', 'pairingNetworkCheck'].includes(key)) || (Object.hasOwn(patch.prefs, 'sourcePolicy') && !['enforce', 'alert', 'off'].includes(patch.prefs.sourcePolicy)) || (Object.hasOwn(patch.prefs, 'pairingNetworkCheck') && typeof patch.prefs.pairingNetworkCheck !== 'boolean'))) return null;
  return patch;
}

function safeFieldErrors(value) {
  if (!plain(value)) return undefined;
  const entries = Object.entries(value).filter(([field, code]) => /^[a-zA-Z][a-zA-Z0-9.]{0,63}$/.test(field) && /^[A-Z_]{1,32}$/.test(code));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function safeTunnelLines(value) {
  if (!Array.isArray(value)) return null;
  // The supervisor owns redaction.  This IPC boundary only relays a bounded,
  // already-redacted textual view from that trusted main-process port.
  return value.slice(0, 100).filter(line => typeof line === 'string'
    && line.length <= 1024 && !TUNNEL_LINE_FORBIDDEN.test(line));
}

function weakensSourcePolicy(current, next) {
  const rank = { off: 0, alert: 1, enforce: 2 };
  return Object.hasOwn(rank, current) && Object.hasOwn(rank, next) && rank[next] < rank[current];
}

function expandsLimits(current, patch) {
  if (!plain(patch?.limits)) return false;
  return LIMIT_KEYS.some(key => {
    if (!Object.hasOwn(patch.limits, key) || !Number.isSafeInteger(patch.limits[key])) return false;
    const before = Number.isSafeInteger(current?.[key]) ? current[key] : 0;
    const after = patch.limits[key];
    return after === 0 || after > before;
  });
}

function anomalyResumeDetails(status) {
  if (!Array.isArray(status?.alarms)) return null;
  const alarm = status.alarms.find(item => item?.acknowledged !== true && Object.hasOwn(ANOMALY_ALARM_FACTS, item?.kind));
  if (!alarm) return null;
  const facts = ANOMALY_ALARM_FACTS[alarm.kind];
  const at = Number(alarm.at);
  return {
    reason: 'anomaly',
    count: facts.count,
    minutes: facts.minutes,
    at: Number.isSafeInteger(at) && at >= 0 ? at : null,
  };
}

/**
 * The only main-process IPC registration point.  It deliberately speaks in
 * fixed failure codes: no exception, renderer payload, path, or secret is
 * echoed to a renderer.
 */
export function registerHandoffBridgeUi({
  ipc = electronPkg.ipcMain,
  controller = {},
  store = {},
  tunnel = {},
  oauth = {},
  engine = {},
  push = {},
  application = {},
  dialogs = {},
  clipboard = electronPkg.clipboard,
  getCanvasWindows = () => [],
  now = Date.now,
  timers = globalThis,
  processStartedAt = Date.now(),
  // This is an internal main-process port.  It must never be derived from a
  // renderer status snapshot (which intentionally has no consent fields).
  enableConsent = {},
  validateHostname = fallbackHostname,
  onOpenPanel = noOp,
  onSuspend = noOp,
  onResume = noOp,
  // Setup mutations capture binary/credential values into a composed runtime.
  // The composition owner injects this only when it can detach that graph.
  onSetupMutation = null,
} = {}) {
  const isValidHostname = value => {
    try { return validateHostname(value) === true; } catch { return false; }
  };
  const candidates = new Map();
  let lastStatusAt = -Infinity;
  let statusTimer = null;
  let clipboardClearTimer = null;
  let latestStatus = null;
  const canvasWindows = () => {
    try { return (getCanvasWindows() || []).filter(window => !window?.isDestroyed?.()); } catch { return []; }
  };
  const windowFor = sender => canvasWindows().find(window => window?.webContents?.id === sender?.id) || null;
  // An exposure-raising IPC can await both main-owned disk descriptions and a
  // native sheet.  Do not let an old WebContents identity turn into authority
  // after either await: a destroyed/replaced canvas must not be able to start
  // a listener simply because its earlier confirmation eventually resolved.
  const stillOwnsWindow = (sender, expected) => {
    try { return Boolean(expected && !expected.isDestroyed?.() && windowFor(sender) === expected); }
    catch { return false; }
  };
  // sender id -> job ids the auto-release pipeline has already handled.
  const autoReleaseHandled = new Map();
  const sweep = () => {
    const stamp = Number(now());
    for (const [id, entry] of candidates) if (!Number.isFinite(stamp) || stamp - entry.at >= KEEP_ALIVE_MS || !windowFor({ id })) { candidates.delete(id); autoReleaseHandled.delete(id); }
  };
  const sendStatus = snapshot => {
    for (const window of canvasWindows()) {
      try { window.webContents?.send?.(IPC_EVENTS.STATUS, snapshot); } catch { /* individual renderer failure is isolated */ }
    }
  };
  const flushStatus = () => {
    statusTimer = null; lastStatusAt = Number(now());
    if (latestStatus) sendStatus(latestStatus);
  };
  const publishStatus = snapshot => {
    latestStatus = snapshot;
    const stamp = Number(now());
    if (!Number.isFinite(stamp) || stamp - lastStatusAt >= STATUS_INTERVAL_MS) { flushStatus(); return; }
    if (statusTimer !== null) return;
    try { statusTimer = timers.setTimeout(flushStatus, Math.max(0, STATUS_INTERVAL_MS - (stamp - lastStatusAt))); statusTimer?.unref?.(); } catch { statusTimer = null; }
  };
  const unsubscribe = typeof controller.subscribe === 'function' ? controller.subscribe(publishStatus) : noOp;
  const guard = (event, checkWindow = false) => {
    const sender = event?.sender;
    if (!isCanvasSender(sender)) return { code: 'SENDER', sender: null, window: null };
    const window = windowFor(sender);
    if (checkWindow && !window) return { code: 'NO_WINDOW', sender, window: null };
    return { code: null, sender, window };
  };
  const invoke = (fn, { window = false } = {}) => async (event, payload) => {
    const checked = guard(event, window);
    if (checked.code) return fixed(checked.code);
    try { return await fn(checked, payload); } catch { return fixed('INTERNAL'); }
  };
  const confirm = async (sender, kind, details) => {
    try { return await dialogs.ask?.(sender, kind, details) || { ok: false, code: 'DECLINED' }; }
    catch { return { ok: false, code: 'DECLINED' }; }
  };
  const currentStatus = () => {
    try { return controller.snapshot?.() || controller.status?.() || null; } catch { return null; }
  };
  // A describe/confirm round is deliberately asynchronous.  Re-check the
  // captured controller's closed status before and after each await so a
  // Disable cannot turn an already-open native dialog into a release against
  // this (or a subsequently composed) runtime.
  const releaseAvailable = () => {
    const status = currentStatus();
    return status?.enabled === true && (status?.serving === undefined || ['live', 'paused'].includes(status.serving));
  };
  const autoReleaseAvailable = () => releaseAvailable() && currentStatus()?.autoRelease === true;
  // A renderer publication is advisory and can be replaced while a disk read
  // or a native confirmation is outstanding.  Capture both the exact
  // BrowserWindow object and the whole candidate generation; reusing only a
  // sender id or path would let a Save As, window replacement, or a newer
  // publication release work the user did not just confirm.
  const captureReleaseContext = (sender, window, ids) => {
    const path = window?.__canvasFilePath;
    if (!window || window.isDestroyed?.() || typeof path !== 'string') return { code: 'NO_WINDOW' };
    const entry = candidates.get(sender?.id);
    if (!entry || !Number.isInteger(entry.seq) || !entry.jobs || !Array.isArray(ids)) return { code: 'UNKNOWN_JOB' };
    const jobs = new Map();
    for (const id of ids) {
      const job = entry.jobs.get(id);
      if (!job || job.canvasFilePath !== path) return { code: 'UNKNOWN_JOB' };
      jobs.set(id, job);
    }
    return { senderId: sender.id, window, path, entry, seq: entry.seq, ids: [...ids], jobs };
  };
  const releaseContextCode = context => {
    if (!context) return 'UNKNOWN_JOB';
    sweep();
    const liveWindow = windowFor({ id: context.senderId });
    if (!liveWindow || liveWindow !== context.window || liveWindow.isDestroyed?.() || liveWindow.__canvasFilePath !== context.path) return 'NO_WINDOW';
    const entry = candidates.get(context.senderId);
    if (entry !== context.entry || entry?.seq !== context.seq || !entry.jobs) return 'UNKNOWN_JOB';
    for (const id of context.ids) {
      const captured = context.jobs.get(id);
      if (!captured || entry.jobs.get(id) !== captured || captured.canvasFilePath !== context.path) return 'UNKNOWN_JOB';
    }
    return null;
  };
  const describedJobs = (description, requestedIds, canvasFilePath, { requireAll = true } = {}) => {
    if (!Array.isArray(description?.items) || description.canvasFilePath !== canvasFilePath) return null;
    const requested = new Set(requestedIds);
    if (requested.size !== requestedIds.length) return null;
    const found = new Map();
    for (const item of description.items) {
      // The application adapter is authoritative only for the requested ids.
      // Ignore an accidental/malicious extra row rather than rendering or
      // releasing it; duplicate requested rows are ambiguous and fail closed.
      if (!plain(item) || !requested.has(item.jobId)) continue;
      if (found.has(item.jobId)) return null;
      found.set(item.jobId, item);
    }
    if (requireAll && found.size !== requested.size) return null;
    return requestedIds.flatMap(jobId => found.has(jobId)
      ? [{ item: found.get(jobId), job: { jobId, canvasFilePath } }]
      : []);
  };
  const resultFailure = (result, fallback = 'INTERNAL') => fixed(fixedCode(result?.code, fallback));
  // SET_ENABLED has a deliberately smaller, closed error vocabulary than the
  // internal refusal ladder. Do not relay a refusal detail (which can describe
  // a local socket, file, or platform failure) across IPC.
  const startupEnableFailure = result => {
    let code; let cause; let probeReason;
    try {
      code = result?.code;
      cause = result?.diagnostic?.cause;
      probeReason = result?.diagnostic?.tunnel?.probe?.reason;
    } catch { return fixed('UNAVAILABLE'); }
    // This is the one startup detail that earns renderer copy: both values
    // are closed supervisor enums and identify a user-actionable Cloudflare
    // routing mismatch. All other internal failures remain UNAVAILABLE.
    if (cause === 'tunnel-not-serving' || probeReason === 'tunnel-not-serving') return fixed('TUNNEL_NOT_SERVING');
    switch (typeof code === 'string' ? code.toUpperCase() : '') {
      case 'CANCELLED':
      case 'DECLINED': return fixed('DECLINED');
      case 'BUSY': return fixed('BUSY');
      case 'NO_WINDOW': return fixed('NO_WINDOW');
      case 'UNAVAILABLE': return fixed('UNAVAILABLE');
      default: return fixed('UNAVAILABLE');
    }
  };
  const invalidateAfterSetupMutation = async kind => {
    if (typeof onSetupMutation !== 'function') return true;
    const result = await safeCall({ onSetupMutation }, 'onSetupMutation', kind);
    return acknowledged(result, { allowTrue: true });
  };
  const handlers = {
    [IPC_CHANNELS.GET_STATUS]: invoke(async () => {
      const status = currentStatus(); return status ? success({ status }) : fixed('UNAVAILABLE');
    }),
    [IPC_CHANNELS.SET_ENABLED]: invoke(async ({ sender, window }, payload) => {
      if (!plain(payload) || typeof payload.enabled !== 'boolean') return fixed('UNAVAILABLE');
      // Both directions change the live bridge graph. A canvas-marked
      // WebContents that no longer belongs to a live BrowserWindow must not
      // be able to start or stop it (even when stopping would not need a
      // native confirmation).
      if (!window) return fixed('NO_WINDOW');
      if (payload.enabled) {
        const status = currentStatus();
        // Availability is a main-owned refusal ladder (for example ordinary
        // E2E, packaged/platform, or the hard-off environment switch).  Do
        // not open a consent sheet for an enable that cannot proceed: besides
        // being misleading, an incomplete setup can make the dialog builder
        // return INVALID before the authoritative UNAVAILABLE result.
        if (status?.availability?.ok === false) return fixed('UNAVAILABLE');
        const details = await safeCall(enableConsent, 'describe', status) || {};
        const long = details.long !== false;
        const enableDetails = {
          hostname: isValidHostname(details.hostname) ? details.hostname : status?.config?.hostname,
          idlePauseMinutes: Number.isSafeInteger(details.idlePauseMinutes) ? details.idlePauseMinutes : status?.limits?.idlePauseMinutes,
          items: Array.isArray(details.items) ? details.items : [],
          long,
        };
        // describe() is asynchronous even for a repeat enable. Losing the
        // originating canvas while it runs must not turn a closed window into
        // an authority to start the bridge without a sheet.
        if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
        // A first/material enable has the one long consent sheet. A repeat
        // enable is still deliberate (the renderer toggle) but leaves the
        // launch restart hold in place until the first New chat/Continue.
        if (long) {
          if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
          const answer = await confirm(sender, 'enable', enableDetails);
          if (!answer.ok) return startupEnableFailure(answer);
          if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
        }
        const result = await safeCall(controller, 'enable', { confirmed: true, restartConfirmed: long });
        if (!acknowledged(result)) return startupEnableFailure(result);
        if (long) {
          const persisted = await safeCall(enableConsent, 'accept', enableDetails);
          if (!acknowledged(persisted, { allowTrue: true })) {
            await safeCall(controller, 'disable');
            return fixed('UNAVAILABLE');
          }
        }
        return success({ enabled: true });
      }
      // A hard stop normally takes effect immediately.  When released work is
      // still outstanding, however, it is the one stop action that needs a
      // main-owned acknowledgement.  Never accept a renderer-side "already
      // confirmed" flag: the exact canvas that requested the stop owns this
      // sheet and nothing else does.
      const status = currentStatus();
      if (status?.chat?.outstanding) {
        if (!window) return fixed('NO_WINDOW');
        const answer = await confirm(sender, 'disable');
        if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
        if (!answer.ok) return fixed(fixedCode(answer.code, 'DECLINED'));
      }
      const result = await safeCall(controller, 'disable');
      return acknowledged(result) ? success({ enabled: false }) : startupEnableFailure(result);
    }),
    [IPC_CHANNELS.SAVE_CONFIG]: invoke(async ({ sender, window }, payload) => {
      if (!window) return fixed('NO_WINDOW');
      const patch = validPatch(payload, isValidHostname); if (!patch) return fixed('INVALID');
      const status = currentStatus();
      const raisesScoring = patch.scope?.scoring === true && status?.config?.scope?.scoring !== true;
      const raisesMarketplace = patch.scope?.marketplace === true && status?.config?.scope?.marketplace !== true;
      const raisesAutoStart = patch.autoStart === true && status?.autoStart !== true;
      const raisesAutoRelease = patch.autoRelease === true && status?.autoRelease !== true;
      const weakensSource = typeof patch.prefs?.sourcePolicy === 'string'
        && weakensSourcePolicy(status?.prefs?.sourcePolicy, patch.prefs.sourcePolicy);
      const weakensNetwork = patch.prefs?.pairingNetworkCheck === false && status?.prefs?.pairingNetworkCheck !== false;
      const raisesLimits = expandsLimits(status?.limits, patch);
      const confirmations = [];
      if (raisesScoring) confirmations.push('scoring');
      if (raisesMarketplace) confirmations.push('marketplace');
      if (raisesAutoStart) confirmations.push('autoStart');
      if (raisesAutoRelease) confirmations.push('autoRelease');
      if (weakensSource) confirmations.push('sourcePolicy');
      if (weakensNetwork) confirmations.push('networkCheck');
      if (raisesLimits) confirmations.push('limits');
      for (const kind of confirmations) {
        const answer = await confirm(sender, kind);
        if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
        if (!answer.ok) return fixed(fixedCode(answer.code, 'DECLINED'));
      }
      // The renderer cannot authorize a hostname change. First let the
      // serialized store decide whether a currently linked bridge would be
      // broken. Only that result earns one main-owned native confirmation;
      // retrying with confirmBreak is therefore tied to this exact sheet.
      if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
      let result = await safeCall(store, 'writeConfig', { ...patch, confirmBreak: false });
      if (fixedCode(result?.code) === 'LINK_WOULD_BREAK') {
        if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
        const answer = await confirm(sender, 'linkBreak', { hostname: patch.hostname });
        if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
        if (!answer.ok) return fixed(fixedCode(answer.code, 'DECLINED'));
        result = await safeCall(store, 'writeConfig', { ...patch, confirmBreak: true });
      }
      if (!acknowledged(result)) {
        const fieldErrors = safeFieldErrors(result?.fieldErrors);
        return fieldErrors ? { ...fixed(fixedCode(result?.code, 'INVALID')), fieldErrors } : resultFailure(result, 'INTERNAL');
      }
      if (!acknowledged(await safeCall(controller, 'reloadConfig'))) return fixed('INTERNAL');
      return success();
    }),
    [IPC_CHANNELS.CHOOSE_BINARY]: invoke(async ({ sender, window }) => {
      if (!window) return fixed('NO_WINDOW'); const picked = await dialogs.choose?.(sender, 'binary');
      if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
      if (!picked?.ok) return fixed(picked?.code || 'DECLINED'); const result = await safeCall(tunnel, 'chooseBinary', picked.filePath);
      if (!acknowledged(result)) return resultFailure(result, 'INVALID');
      // A selected replacement is deliberately unapproved. Detach any graph
      // that captured the former executable before publishing that durable
      // trust state, just as approval and credentials changes do.
      if (!await invalidateAfterSetupMutation('chooseBinary')) return fixed('INTERNAL');
      return success({ chosen: true });
    }),
    [IPC_CHANNELS.APPROVE_BINARY]: invoke(async ({ sender, window }) => {
      if (!window) return fixed('NO_WINDOW');
      const details = await safeCall(tunnel, 'getApprovalDetails');
      if (!details || details.ok === false) return fixed('NOT_READY');
      if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
      const answer = await confirm(sender, 'binaryApproval', details);
      if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
      if (!answer.ok) return fixed(fixedCode(answer.code, 'DECLINED'));
      // Bind the durable approval to the pin that the main-owned details port
      // showed in this native sheet. The renderer supplies no approval value.
      const result = await safeCall(tunnel, 'approveBinary', details.sha256);
      if (!acknowledged(result)) return resultFailure(result, 'NOT_READY');
      // Do not detach on a failed/ambiguous adapter acknowledgement. Once an
      // approval has succeeded, its captured trust state requires a new graph.
      if (!await invalidateAfterSetupMutation('approveBinary')) return fixed('INTERNAL');
      return success({ approved: true });
    }),
    [IPC_CHANNELS.CHOOSE_CREDENTIALS]: invoke(async ({ sender, window }) => {
      if (!window) return fixed('NO_WINDOW'); const picked = await dialogs.choose?.(sender, 'credentials');
      if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
      if (!picked?.ok) return fixed(picked?.code || 'DECLINED'); const result = await safeCall(tunnel, 'chooseCredentials', picked.filePath);
      if (!acknowledged(result)) return resultFailure(result, 'INVALID');
      // Credentials are captured by the supervisor, so this applies only after
      // the setup adapter durably acknowledges the selected file.
      if (!await invalidateAfterSetupMutation('chooseCredentials')) return fixed('INTERNAL');
      return success({ chosen: true });
    }),
    [IPC_CHANNELS.RESTART_TUNNEL]: invoke(async () => {
      const result = await safeCall(tunnel, 'restart'); return acknowledged(result) ? success() : resultFailure(result, 'NOT_READY');
    }),
    [IPC_CHANNELS.STOP_ORPHAN]: invoke(async () => {
      // The only reaper input is the main-owned setup port's fixed userData
      // and config path. A renderer cannot name a PID, path, or process.
      const result = await safeCall(tunnel, 'reapOrphans');
      return result?.ok === true && Number.isInteger(result.reaped) && result.reaped > 0 ? success() : fixed('NOT_FOUND');
    }),
    [IPC_CHANNELS.GET_TUNNEL_LOG]: invoke(async () => {
      const lines = safeTunnelLines(await safeCall(tunnel, 'getLog'));
      return lines ? success({ lines }) : fixed('NOT_READY');
    }),
    [IPC_CHANNELS.OPEN_PAIRING]: invoke(async ({ sender, window }) => {
      if (!window) return fixed('NO_WINDOW');
      let status = currentStatus();
      if (status?.enabled !== true || status?.setup?.tunnelReachable !== true) return fixed('TUNNEL_NOT_READY');
      // Opening pairing itself shows the code sheet. Do not stack a routine
      // pre-confirmation ahead of it, but re-read status just before OAuth in
      // case Disable detached the runtime between this IPC turn and the port.
      if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
      status = currentStatus();
      if (status?.enabled !== true || status?.setup?.tunnelReachable !== true) return fixed('TUNNEL_NOT_READY');
      // `snapshot()` can synchronously cause a canvas teardown in production
      // adapters/tests. Recheck after the final read, not only before it: an
      // old renderer must never turn its now-closed window into OAuth authority.
      if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
      const result = await safeCall(oauth, 'openPairing', {
        parentWindow: window,
        hostname: status?.config?.hostname,
        networkCheck: status?.prefs?.pairingNetworkCheck === false ? 'off' : 'enforce',
      });
      // OAuth can await probe and native-sheet work. A renderer that closed in
      // that interval must not receive the code or leave a live pairing behind.
      if (!stillOwnsWindow(sender, window)) {
        await safeCall(oauth, 'cancelPairing');
        return fixed('NO_WINDOW');
      }
      // The pairing code is allowed only on this direct reply to the click
      // that opened it. It must never become status, an event, audit data, or
      // durable state. Pairing validates and formats it; validate again at the
      // IPC boundary before exposing the narrow renderer capability.
      const pairingCode = typeof result?.pairingCode === 'string' && PAIRING_CODE.test(result.pairingCode)
        ? result.pairingCode.toUpperCase()
        : null;
      if (!acknowledged(result)) return resultFailure(result, 'TUNNEL_NOT_READY');
      const expiresAt = Number.isFinite(result?.expiresAt) && result.expiresAt >= 0
        ? result.expiresAt
        : null;
      if (!pairingCode || expiresAt === null) {
        // A success without its complete ephemeral display capability would
        // leave an armed code that this exact renderer cannot show. Fail
        // closed and consume that malformed main-process session.
        await safeCall(oauth, 'cancelPairing');
        return fixed('INTERNAL');
      }
      return success({ expiresAt, pairingCode });
    }),
    [IPC_CHANNELS.CANCEL_PAIRING]: invoke(async () => {
      const result = await safeCall(oauth, 'cancelPairing'); return acknowledged(result) ? success() : resultFailure(result, 'NOT_READY');
    }),
    [IPC_CHANNELS.NEW_CHAT]: invoke(async ({ sender, window }) => chatWithClipboard('newChat', window, sender)),
    [IPC_CHANNELS.CONTINUE_CHAT]: invoke(async ({ sender, window }) => chatWithClipboard('continueChat', window, sender)),
    [IPC_CHANNELS.PAUSE]: invoke(async () => {
      const result = await safeCall(controller, 'pause'); return acknowledged(result) ? success() : resultFailure(result, 'NOT_READY');
    }),
    [IPC_CHANNELS.RESUME]: invoke(async ({ sender, window }) => {
      const status = currentStatus();
      if (status?.pauseCause === 'anomaly') {
        // An anomaly Resume is a security acknowledgement and must remain
        // parented. Ordinary user and idle soft pauses have no dialog and can
        // safely be resumed when the canvas has not yet opened a window.
        if (!window) return fixed('NO_WINDOW');
        const details = anomalyResumeDetails(status);
        if (!details) return fixed('NOT_READY');
        const answer = await confirm(sender, 'resume', details);
        if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW');
        if (!answer.ok) return fixed(fixedCode(answer.code, 'DECLINED'));
      }
      const result = await safeCall(controller, 'resume'); return acknowledged(result) ? success() : resultFailure(result, 'NOT_READY');
    }),
    [IPC_CHANNELS.REVOKE_ALL]: invoke(async () => {
      const result = await safeCall(controller, 'revokeAll'); return acknowledged(result) ? success() : resultFailure(result, 'NOT_READY');
    }),
    [IPC_CHANNELS.FORGET_SETUP]: invoke(async ({ sender, window }) => {
      if (!window) return fixed('NO_WINDOW'); { const answer = await confirm(sender, 'forget'); if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW'); if (!answer.ok) return fixed(fixedCode(answer.code, 'DECLINED')); }
      const result = await safeCall(controller, 'forget'); return acknowledged(result) ? success() : resultFailure(result, 'NOT_READY');
    }),
    [IPC_CHANNELS.RELEASE]: invoke(async ({ sender, window }, payload) => release(sender, window, payload)),
    [IPC_CHANNELS.UNRELEASE]: invoke(async (_checked, payload) => typeof payload?.jobId === 'string' ? fromResult(await safeCall(controller, 'unrelease', payload.jobId)) : fixed('INVALID')),
    [IPC_CHANNELS.RELEASE_PUSH]: invoke(async ({ sender, window }, payload) => {
      if (!window) return fixed('NO_WINDOW');
      if (!Array.isArray(payload?.hubs) || payload.hubs.length === 0 || payload.hubs.length > 50 || new Set(payload.hubs).size !== payload.hubs.length || !payload.hubs.every(key => typeof key === 'string' && HUB_KEY.test(key))) return fixed('INVALID');
      // Hub identifiers are renderer-originated routing values, never dialog
      // text. The consent is fixed and intentionally names no listing data.
      { const answer = await confirm(sender, 'releasePush'); if (!stillOwnsWindow(sender, window)) return fixed('NO_WINDOW'); if (!answer.ok) return fixed(fixedCode(answer.code, 'DECLINED')); }
      return fromResult(await safeCall(push, 'release', payload.hubs));
    }),
    [IPC_CHANNELS.UNRELEASE_PUSH]: invoke(async (_checked, payload) => typeof payload?.hub === 'string' && HUB_KEY.test(payload.hub) ? fromResult(await safeCall(push, 'unrelease', payload.hub)) : fixed('INVALID')),
    [IPC_CHANNELS.HOLD_JOB]: invoke(async (_checked, payload) => {
      if (typeof payload?.jobId !== 'string' || typeof payload?.held !== 'boolean') return fixed('INVALID');
      const result = payload.held
        ? await safeCall(engine, 'hold', payload.jobId, 'user_hold')
        : await safeCall(engine, 'resume', { jobId: payload.jobId });
      return fromResult(result);
    }),
    [IPC_CHANNELS.ACK_ALARM]: invoke(async (_checked, payload) => typeof payload?.id === 'string' && ALARM_ID.test(payload.id) ? fromResult(await safeCall(controller, 'ackAlarm', payload.id)) : fixed('NOT_FOUND')),
    [IPC_CHANNELS.GET_ACTIVITY]: invoke(async () => success({ items: boundedActivity(await safeCall(controller, 'getActivity')) })),
  };
  function fromResult(result) {
    if (!acknowledged(result)) return resultFailure(result, 'NOT_FOUND');
    return success(result?.released !== undefined ? { released: result.released } : undefined);
  }
  async function chatWithClipboard(method, window, sender) {
    const action = method === 'newChat' ? 'new' : 'continue';
    const statusAtPress = currentStatus();
    const finish = result => recordBridgeChatCopyResult({
      telemetry: statusAtPress?.config?.telemetryInBugReports === true,
      action,
      // The status is main-owned and is read before preparation. This fixed
      // marker says the guarded UI press acknowledged a restart hold; it
      // retains no dialog text, sender, path, key, or job identity.
      restartPath: statusAtPress?.hold === 'restart' ? 'ui-ack' : undefined,
      result,
    });
    if (!window) return finish(fixed('NO_WINDOW'));
    if (!stillOwnsWindow(sender, window)) return finish(fixed('NO_WINDOW'));
    // The engine's prepare/commit split is the safety boundary: no successful
    // epoch rotation is allowed before the main-owned clipboard write works.
    // This opaque capability is created only after the IPC sender has passed
    // the canvas guard. A Copy starter/Continue press is the user's explicit
    // authorization to restart the chat, so it suppresses only that routine
    // restart sheet. It stays in main-process memory and is neither status nor
    // an IPC value; arbitrary renderer payloads cannot forge it.
    const restartContext = createUiRestartContext();
    const prepared = await safeCall(controller, 'prepareChat', {
      kind: method === 'newChat' ? 'new' : 'continue',
      restartContext,
    });
    // prepareChat can wait on the deferred restart sheet or engine work. If
    // its originating canvas disappears meanwhile, discard the opaque
    // capability before it can touch the clipboard or rotate the chat epoch.
    if (!stillOwnsWindow(sender, window)) {
      await safeCall(controller, 'abandonChat', prepared?.commitToken);
      return finish(fixed('NO_WINDOW'));
    }
    // Never fall back to the legacy combined call: it rotates the epoch before
    // the clipboard write and turns a clipboard failure into a lost old chat.
    if (!prepared || typeof prepared !== 'object') return finish(fixed('NOT_READY'));
    const result = prepared;
    const abandonPrepared = () => safeCall(controller, 'abandonChat', prepared?.commitToken);
    let text = typeof result?.starter === 'string' ? result.starter : typeof result?.text === 'string' ? result.text : null;
    if (!text && typeof result?.sessionCode === 'string') {
      try {
        const pluginName = currentStatus()?.config?.pluginName;
        text = method === 'newChat'
          ? buildStarterMessage({ pluginName, sessionCode: result.sessionCode })
          : buildContinueMessage({ sessionCode: result.sessionCode });
      } catch { await abandonPrepared(); return finish(fixed('CLIPBOARD_FAILED')); }
    }
    if (!text) {
      await abandonPrepared();
      return finish(fixed(fixedCode(result?.code || (result?.status === 'unlinked' ? 'NOT_LINKED' : 'NO_CHAT'), 'NO_CHAT')));
    }
    if (text) {
      try { if (typeof clipboard?.writeText !== 'function') throw new TypeError('clipboard unavailable'); clipboard.writeText(text); }
      catch { await abandonPrepared(); return finish(fixed('CLIPBOARD_FAILED')); }
      const committed = await safeCall(controller, 'commitChat', prepared?.commitToken);
      if (!acknowledged(committed)) {
        await abandonPrepared();
        return finish(resultFailure(committed, 'INTERNAL'));
      }
      // ONE pending clear. Every copy replaces the clipboard, so an earlier
      // press's timer would only wipe a later (possibly byte-identical, e.g. a
      // re-copied starter) copy early. Cancel it; the newest copy owns the clock.
      if (clipboardClearTimer !== null) { try { timers.clearTimeout?.(clipboardClearTimer); } catch { /* optional */ } clipboardClearTimer = null; }
      try {
        const timer = timers.setTimeout(() => {
          if (clipboardClearTimer === timer) clipboardClearTimer = null;
          try { if (clipboard?.readText?.() === text) clipboard?.clear?.(); } catch { /* conditional clear only */ }
        }, CONSTANTS.CLIPBOARD_CLEAR_MS);
        clipboardClearTimer = timer ?? null;
        timer?.unref?.();
      } catch { /* write succeeded; clear is best effort */ }
    }
    return finish(success({ chatOrdinal: Number.isInteger(result?.chatOrdinal) ? result.chatOrdinal : 0, copied: true, ...(result?.recopied === true ? { recopied: true } : {}) }));
  }
  async function release(sender, window, payload) {
    if (!window || !plain(payload) || !Array.isArray(payload.items) || payload.items.length === 0 || payload.items.length > CONSTANTS.MAX_LANES || new Set(payload.items.map(item => item?.jobId)).size !== payload.items.length || payload.items.some(item => !plain(item) || typeof item.jobId !== 'string' || Object.keys(item).some(key => key !== 'jobId'))) return fixed(window ? 'INVALID' : 'NO_WINDOW');
    const ids = payload.items.map(item => item.jobId);
    sweep();
    const context = captureReleaseContext(sender, window, ids);
    if (context.code) return fixed(context.code);
    const description = await safeCall(application, 'describeForConfirm', context.path, context.ids);
    const afterDescribe = releaseContextCode(context);
    if (afterDescribe) return fixed(afterDescribe);
    const described = description?.ok ? describedJobs(description, context.ids, context.path) : null;
    if (!described) return fixed(fixedCode(description?.code, 'INVALID'));
    if (!releaseAvailable()) return fixed('NOT_READY');
    const canonicalJobs = described.map(value => value.job);
    { const answer = await confirm(sender, 'release', { items: described.map(value => value.item), canvasFilePath: context.path, hostname: currentStatus()?.config?.hostname }); if (!answer.ok) return fixed(fixedCode(answer.code, 'DECLINED')); }
    const afterConfirm = releaseContextCode(context);
    if (afterConfirm) return fixed(afterConfirm);
    if (!releaseAvailable()) return fixed('NOT_READY');
    const beforeRelease = releaseContextCode(context);
    if (beforeRelease) return fixed(beforeRelease);
    const result = await safeCall(controller, 'release', { jobs: canonicalJobs });
    if (!acknowledged(result)) return resultFailure(result, 'INVALID');
    return success({ released: Number.isFinite(result?.released ?? result?.count) ? (result.released ?? result.count) : canonicalJobs.length });
  }
  function publish(event, payload) {
    const checked = guard(event, false); if (checked.code || !plain(payload)) return;
    sweep(); const sender = checked.sender;
    if (payload.unmount === true) { candidates.delete(sender.id); autoReleaseHandled.delete(sender.id); return; }
    if (payload.v !== 1 || !Number.isInteger(payload.seq) || !Array.isArray(payload.jobs) || payload.jobs.length > MAX_JOBS || new Set(payload.jobs.map(item => item?.jobId)).size !== payload.jobs.length || payload.jobs.some(item => !validJob(item))) return;
    const window = windowFor(sender); if (!window || payload.jobs.some(item => item.canvasFilePath !== window.__canvasFilePath)) return;
    const previous = candidates.get(sender.id); if (previous && payload.seq <= previous.seq) return;
    const jobs = new Map(payload.jobs.map(item => [item.jobId, { jobId: item.jobId, canvasFilePath: item.canvasFilePath, dockState: item.dockState, sig: item.sig }]));
    const entry = { seq: payload.seq, jobs, at: Number(now()) };
    candidates.set(sender.id, entry);
    // Renderer publication is advisory and must never manufacture a
    // job-changed event.  Only a bridge-caused engine mutation may do that.
    const changed = [...jobs.values()].filter(item => {
      const before = previous?.jobs?.get(item.jobId);
      return !before || before.sig !== item.sig || before.dockState !== item.dockState || before.canvasFilePath !== item.canvasFilePath;
    });
    for (const item of changed) { try { engine.hint?.({ jobId: item.jobId }); } catch { /* a hint is best effort */ } }
    // A job that left the publication (its bundle was discarded or saved) is
    // also a state change. Without this a released lane for it was never
    // re-read until a chat happened to poll, so it kept occupying capacity.
    if (previous) {
      for (const jobId of previous.jobs.keys()) {
        if (!jobs.has(jobId)) { try { engine.hint?.({ jobId }); } catch { /* a hint is best effort */ } }
      }
    }
    // This is deliberately based on the disk adapter's createdAt view, not on
    // renderer publication time.  It is an opt-in convenience and never makes
    // an earlier job available after a relaunch.
    if (currentStatus()?.autoRelease !== true || !autoReleaseAvailable()) { autoReleaseHandled.delete(sender.id); return; }
    void (async () => {
      // One-shot per job per enabled session. The renderer republishes every
      // job on each state change and on a 30 s keep-alive, so without this
      // memory the whole describe (a disk discover) + release pipeline re-ran
      // for every awaiting card indefinitely, re-stamped the release TTL and
      // the idle-pause clock, and silently undid a user's Unrelease.
      let handled = autoReleaseHandled.get(sender.id);
      if (!handled) { handled = new Set(); autoReleaseHandled.set(sender.id, handled); }
      for (const id of [...handled]) if (!jobs.has(id)) handled.delete(id);
      // A job that already holds a live lane needs no release (a finished or
      // gone lane does not block a new one), and each one used to
      // cost a disk discover plus a no-op release: a card leaves the publication
      // between stages (dockState null while it is neither working nor awaiting),
      // which dropped it from `handled`, so every stage re-ran the pipeline.
      const laned = new Set((Array.isArray(currentStatus()?.queue?.jobs) ? currentStatus().queue.jobs : []).filter(lane => lane?.phase !== 'done' && lane?.phase !== 'gone').map(lane => lane?.jobId).filter(id => typeof id === 'string'));
      const candidatesNow = [...jobs.values()].filter(item => item.dockState === 'awaiting' && !handled.has(item.jobId));
      for (const item of candidatesNow) if (laned.has(item.jobId)) handled.add(item.jobId);
      const ids = candidatesNow.filter(item => !laned.has(item.jobId)).map(item => item.jobId);
      if (!ids.length) return;
      // Claim before the first await so an overlapping publication cannot
      // start a second run for the same ids.
      for (const id of ids) handled.add(id);
      const retry = list => { for (const id of list) handled.delete(id); };
      const context = captureReleaseContext(sender, window, ids);
      if (context.code || !autoReleaseAvailable()) { retry(ids); return; }
      const described = await safeCall(application, 'describeForConfirm', context.path, context.ids, { requireAll: false });
      if (releaseContextCode(context) || !autoReleaseAvailable()) { retry(ids); return; }
      const confirmed = described?.ok ? describedJobs(described, context.ids, context.path, { requireAll: false }) : null;
      if (!confirmed) { retry(ids); return; }
      const confirmedIds = new Set(confirmed.map(value => value.job.jobId));
      // A job the disk no longer lists has nothing to release; try again only
      // if it is still published on a later pass.
      retry(ids.filter(id => !confirmedIds.has(id)));
      const eligible = confirmed.filter(value => Number(new Date(value.item?.createdAt)) > Number(processStartedAt));
      if (!eligible.length) return;
      if (releaseContextCode(context) || !autoReleaseAvailable()) { retry(eligible.map(value => value.job.jobId)); return; }
      // Re-check in the same turn immediately before the mutating controller
      // port. There is no renderer-controlled await between this check and
      // release, so a stale publication cannot cross the boundary.
      const result = await safeCall(controller, 'release', { jobs: eligible.map(value => value.job), auto: true });
      if (!acknowledged(result)) retry(eligible.map(value => value.job.jobId));
    })();
  }
  // Registration is a closed all-or-nothing fact.  A partial Electron stub is
  // useful in isolated tests, but it is not a working bridge: reporting it as
  // registered would make the renderer retry an IPC surface that does not
  // exist.  The production IPC object supplies all four functions below.
  const registeredInvokes = [];
  let invokeRegistrationOk = typeof ipc?.handle === 'function' && typeof ipc?.removeHandler === 'function';
  if (invokeRegistrationOk) {
    for (const channel of REQUIRED_INVOKE_CHANNELS) {
      try {
        ipc.removeHandler(channel);
        ipc.handle(channel, handlers[channel]);
        // Electron does not expose handler introspection, but the test stub
        // does. Where that seam exists, a no-op `handle` is a failed route,
        // not a successful registration claim.
        if (typeof ipc.__getInvokeHandler === 'function' && ipc.__getInvokeHandler(channel) !== handlers[channel]) throw new Error('invoke handler missing');
        registeredInvokes.push(channel);
      } catch {
        invokeRegistrationOk = false;
        break;
      }
    }
  }
  let publishRegistered = false;
  let publishAttempted = false;
  if (invokeRegistrationOk && registeredInvokes.length === REQUIRED_INVOKE_CHANNELS.length
    && typeof ipc?.on === 'function' && typeof ipc?.removeListener === 'function') {
    try {
      const previous = registeredPublishListeners.get(ipc);
      if (previous) ipc.removeListener(IPC_CHANNELS.PUBLISH_JOBS, previous);
      publishAttempted = true;
      ipc.on(IPC_CHANNELS.PUBLISH_JOBS, publish);
      registeredPublishListeners.set(ipc, publish);
      publishRegistered = true;
    } catch { /* cleanup below makes a failed partial registration inert */ }
  }
  const registration = Object.freeze({
    ok: invokeRegistrationOk && registeredInvokes.length === REQUIRED_INVOKE_CHANNELS.length && publishRegistered,
    invokes: registeredInvokes.length,
    expectedInvokes: REQUIRED_INVOKE_CHANNELS.length,
    publish: publishRegistered,
  });
  let disposed = false;
  const dispose = ({ removePartialInvokes = false } = {}) => {
    if (disposed) return;
    disposed = true;
    try { unsubscribe?.(); } catch { /* optional */ }
    if (statusTimer !== null) try { timers.clearTimeout?.(statusTimer); } catch { /* optional */ }
    statusTimer = null;
    candidates.clear();
    try {
      if (publishAttempted || registeredPublishListeners.get(ipc) === publish) {
        ipc.removeListener?.(IPC_CHANNELS.PUBLISH_JOBS, publish);
        if (registeredPublishListeners.get(ipc) === publish) registeredPublishListeners.delete(ipc);
      }
    } catch { /* optional Electron cleanup */ }
    if (removePartialInvokes) {
      // This may be a replacement over a prior bridge registry. A throw at
      // channel N leaves the old handlers for N+1…end in Electron unless we
      // clear the full owned route set, not only the routes this attempt saw.
      for (const channel of REQUIRED_INVOKE_CHANNELS) {
        try { ipc.removeHandler?.(channel); } catch { /* best-effort failed-registration cleanup */ }
      }
      // Do not couple these cleanup attempts: a hostile/broken test double
      // (or a transient Electron failure) removing this attempt's listener
      // must not leave the prior registry's publisher or our ownership entry
      // behind.
      let previous;
      try { previous = registeredPublishListeners.get(ipc); } catch { /* best effort */ }
      try { ipc.removeListener?.(IPC_CHANNELS.PUBLISH_JOBS, publish); } catch { /* best effort */ }
      if (previous && previous !== publish) {
        try { ipc.removeListener?.(IPC_CHANNELS.PUBLISH_JOBS, previous); } catch { /* best effort */ }
      }
      try { registeredPublishListeners.delete(ipc); } catch { /* best effort */ }
    }
  };
  if (!registration.ok) dispose({ removePartialInvokes: true });
  return Object.freeze({
    registration,
    dispose: () => dispose(),
    publishStatus, publish, candidates: () => { sweep(); return candidates; },
    // Main-only composition port for engine/application mutations.  It sends
    // to the publishing live window, never broadcasts by canvas path.
    notifyJobChanged({ jobId, canvasFilePath } = {}) {
      if (!UUID.test(jobId || '') || typeof canvasFilePath !== 'string') return false;
      sweep();
      for (const [senderId, entry] of candidates) {
        const item = entry.jobs.get(jobId);
        if (!item || item.canvasFilePath !== canvasFilePath) continue;
        const owner = windowFor({ id: senderId });
        if (!owner || owner.__canvasFilePath !== canvasFilePath) continue;
        try { owner.webContents?.send?.(IPC_EVENTS.JOB_CHANGED, { jobId }); return true; } catch { return false; }
      }
      return false;
    },
    openPanel(panel = 'bridge', step = undefined) { try { onOpenPanel({ panel, ...(step ? { step } : {}) }); } catch { /* optional */ } },
    onSuspend, onResume,
  });
}

export default registerHandoffBridgeUi;
