import { CONSTANTS } from './constants.js';
import { STATUS_SNAPSHOT_EXAMPLE } from './contracts.js';
import { sanitizeActivityItem } from './log.js';

// The controller deliberately has no Electron, filesystem, network, or timer
// imports.  Its ports are supplied by index.js (and, more importantly, by the
// deterministic bridge harness).  Keep this module at the policy boundary:
// listeners own sockets, the tunnel owns children, and the engine owns lanes.

const TICK_MS = 15_000;
const ANOMALY_WINDOWS = Object.freeze({
  unknown_key: [5, 10 * 60_000],
  unknown_handoff: [5, 10 * 60_000],
  misrouted: [5, 10 * 60_000],
  rate_limited: [50, 60_000],
  held_cap: [3, 60 * 60_000],
});

const copy = value => JSON.parse(JSON.stringify(value));
const safeNow = now => {
  try {
    const value = Number(now());
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  } catch { return Date.now(); }
};
const noOp = () => undefined;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value, fallback = null) => Number.isFinite(value) ? value : fallback;
const bool = value => value === true;
const oneOf = (value, allowed, fallback) => allowed.has(value) ? value : fallback;
const shortText = (value, fallback = null) => typeof value === 'string' && value.length <= 200 ? value : fallback;
const arrayOf = (value, max = 50) => Array.isArray(value) ? value.slice(0, max) : [];
// Public status vocabulary. Diagnostic values from engine and supervisor are
// mapped into these closed enums before crossing the renderer boundary.
const TUNNEL_STATES = new Set(['off', 'blocked', 'needs-setup', 'needs-trust', 'starting', 'connecting', 'checking-public', 'up', 'degraded', 'backoff', 'paused', 'stopping', 'failed', 'unknown']);
const PROBE_STATES = new Set(['unknown', 'ok', 'failing']);
const PROBE_REASONS = new Set(['wrong-origin', 'unexpected-redirect', 'tunnel-not-serving', 'origin-unreachable', 'ingress-mismatch', 'edge-blocked', 'edge-unreachable', 'dns-not-found', 'hostname-not-public', 'offline', 'timeout', 'too_large', 'refused', 'other']);
const TUNNEL_EXIT_CODES = new Set(['spawn-failed', 'flag-rejected', 'tunnel-auth-rejected', 'credentials-invalid', 'network-unreachable', 'metrics-port-in-use', 'exited-unrequested', 'exited', 'exited-early', 'unrequested-exit-loop', 'crash-loop', 'hostname-not-public', 'config-rejected', 'owned-elsewhere', 'binary-untrusted', 'binary-not-found', 'binary-changed']);
const LINK_STATES = new Set(['unlinked', 'pairing', 'linked', 'needs-renewal', 'unknown']);
const CHAT_STATES = new Set(['none', 'awaiting-first-call', 'working', 'idle', 'full', 'ended']);
const LANE_PHASES = new Set(['unread', 'awaiting', 'host', 'needs_user', 'held', 'done', 'gone']);
const APPLICATION_STAGES = new Set(['evidence-plan', 'resume', 'cover-letter', 'review']);
const TASK_IDS = new Set(['job-scoring']);
const JOB_REASONS = new Set(['user_hold', 'human_advance', 'rejection_cap', 'junk_cap', 'review_round_cap', 'job_broken', 'render_retry', 'canvas_unavailable', 'read_failed', 'write_failed', 'submit_stuck', 'host_silent', 'lapsed', 'restart', 'app_only_handoffs', 'commit_failed', 'person_editing', 'hub_not_selected', 'task_disabled', 'integrity_fault', 'failed', 'render_retry_required', 'user', 'answered_in_dock']);
const ALARM_KINDS = new Set(['unknown_key', 'unknown_handoff', 'refresh_reuse', 'code_reuse', 'rate_limited', 'held_caps']);
const PAUSE_CAUSES = new Set(['user', 'idle', 'anomaly', 'revoked', 'quit']);
const FAULT_CODES = new Set(['socket_unavailable', 'tunnel_failed', 'state_unreadable', 'persist_failed', 'internal_error']);
const TOOL_OUTCOMES = Object.freeze({
  get: new Set(['served', 'waiting', 'queue_empty', 'empty', 'paused', 'session_full', 'needs_user', 'retry', 'error_retryable', 'app_unavailable', 'session_ended', 'unauthorized', 'rate_limited']),
  submit: new Set(['accepted', 'rejected', 'duplicate', 'junk', 'superseded', 'held', 'needs_user', 'misrouted', 'too_large', 'unknown_handoff', 'retry', 'error_retryable', 'app_unavailable', 'session_ended', 'unauthorized', 'rate_limited', 'paused']),
});
const AVAILABILITY_REASONS = new Set(['e2e', 'env-disabled', 'dev-build']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[a-z0-9][a-z0-9_.:-]{0,99}$/i;
const HUB_KEY = /^[a-f0-9]{64}$/;
const CLOUDFLARED_VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9A-Za-z.]{1,20})?$/;
const SHA256_PREFIX = /^[a-f0-9]{12}$/;
const STARTUP_TIMEOUT_MS = 25_000;
// The tunnel supervisor permits a 30-second first-success public-probe
// window before its normal retry/degrade policy takes over. This is distinct
// from the controller's per-port startup cap above.
const TUNNEL_READINESS_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 25_000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
// The supervisor owns the real readiness/public-probe cadence (first public
// probe at +2s, then every 5s).  This small controller-side poll only observes
// its closed state while Enable is already in progress; it never probes the
// network or starts a tunnel itself.
const TUNNEL_READINESS_POLL_MS = 250;
// `probe-restart` deliberately presents `stopping` and then `off` while the
// supervisor serially starts a replacement child. Those are not a user
// Disable and must remain waitable. A true failed/setup-blocked projection is
// safe to reject immediately.
const TERMINAL_TUNNEL_START_STATES = new Set(['blocked', 'needs-setup', 'needs-trust', 'failed']);
const IPV4_PREFIX = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.0\/24$/;
const IPV6_HEXTET = '(?:0|[1-9a-f][0-9a-f]{0,3})';
const IPV6_PREFIX = new RegExp(`^${IPV6_HEXTET}:${IPV6_HEXTET}:${IPV6_HEXTET}::/48$`);
const failure = (code, diagnostic = null) => {
  const error = new Error(code);
  error.code = code;
  if (diagnostic && typeof diagnostic === 'object') error.diagnostic = diagnostic;
  return error;
};

function safeSourcePrefix(value) {
  if (typeof value !== 'string') return null;
  const ipv4 = IPV4_PREFIX.exec(value);
  if (ipv4) return ipv4.slice(1).every(part => Number(part) <= 255) ? value : null;
  return IPV6_PREFIX.test(value) ? value : null;
}

function call(port, method, ...args) {
  try {
    const fn = typeof port === 'function' && !method ? port : port?.[method];
    return typeof fn === 'function' ? Promise.resolve(fn.apply(port, args)) : Promise.resolve(undefined);
  } catch (error) { return Promise.reject(error); }
}

function boundedCall(port, method, args, { timers, timeoutMs = STARTUP_TIMEOUT_MS, code = 'internal_error' } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false; let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { if (timer !== undefined) timers?.clearTimeout?.(timer); } catch { /* cleanup cannot alter the result */ }
      fn(value);
    };
    try {
      if (typeof timers?.setTimeout !== 'function') throw new TypeError('timer unavailable');
      timer = timers?.setTimeout?.(() => finish(reject, failure(code)), timeoutMs);
      timer?.unref?.();
    } catch { finish(reject, failure(code)); return; }
    call(port, method, ...args).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function boolConfirm(answer) {
  return answer === true || answer?.response === 1 || answer?.accepted === true || answer?.ok === true;
}

function snapshotOf(port) {
  try {
    const value = port?.snapshot?.() ?? port?.status?.() ?? null;
    return isObject(value) ? value : {};
  } catch { return {}; }
}

function statusOf(port) {
  try {
    const value = port?.status?.() ?? null;
    return isObject(value) ? value : {};
  } catch { return {}; }
}

function defaultConfig() {
  return {
    hostname: null, pluginName: 'infinite_canvas', autoStart: false, autoRelease: false,
    scope: { applications: true, scoring: false },
    limits: {
      releaseTtlHours: CONSTANTS.RELEASE_TTL_HOURS,
      chatKeyMaxAgeHours: CONSTANTS.CHAT_KEY_MAX_AGE_HOURS,
      idlePauseMinutes: CONSTANTS.IDLE_PAUSE_MINUTES,
      jobsPerChat: CONSTANTS.JOBS_PER_CHAT,
      epochSoftBytes: CONSTANTS.EPOCH_SOFT_BYTES,
      epochHardBytes: CONSTANTS.EPOCH_HARD_BYTES,
    },
    prefs: { sourcePolicy: CONSTANTS.SOURCE_POLICY, pairingNetworkCheck: true },
    telemetryInBugReports: false,
  };
}

function cleanConfig(value) {
  const fallback = defaultConfig();
  if (!isObject(value)) return fallback;
  const limits = isObject(value.limits) ? value.limits : {};
  const prefs = isObject(value.prefs) ? value.prefs : {};
  return {
    hostname: typeof value.hostname === 'string' ? value.hostname : null,
    pluginName: typeof value.pluginName === 'string' && value.pluginName ? value.pluginName : fallback.pluginName,
    autoStart: value.autoStart === true,
    autoRelease: value.autoRelease === true,
    scope: { applications: value.scope?.applications !== false, scoring: value.scope?.scoring === true },
    limits: {
      releaseTtlHours: Number.isFinite(limits.releaseTtlHours) ? Math.max(0, limits.releaseTtlHours) : fallback.limits.releaseTtlHours,
      chatKeyMaxAgeHours: Number.isFinite(limits.chatKeyMaxAgeHours) ? Math.max(0, limits.chatKeyMaxAgeHours) : fallback.limits.chatKeyMaxAgeHours,
      idlePauseMinutes: Number.isFinite(limits.idlePauseMinutes) ? Math.max(0, limits.idlePauseMinutes) : fallback.limits.idlePauseMinutes,
      jobsPerChat: Number.isFinite(limits.jobsPerChat) ? limits.jobsPerChat : fallback.limits.jobsPerChat,
      epochSoftBytes: Number.isFinite(limits.epochSoftBytes) ? limits.epochSoftBytes : fallback.limits.epochSoftBytes,
      epochHardBytes: Number.isFinite(limits.epochHardBytes) ? limits.epochHardBytes : fallback.limits.epochHardBytes,
    },
    prefs: {
      sourcePolicy: ['enforce', 'alert', 'off'].includes(prefs.sourcePolicy) ? prefs.sourcePolicy : fallback.prefs.sourcePolicy,
      pairingNetworkCheck: prefs.pairingNetworkCheck !== false,
    },
    telemetryInBugReports: value.telemetryInBugReports === true,
  };
}

/**
 * Main-process policy controller.  All mutable state is process-local by
 * design: no session keys, pairing codes, or request content is ever retained
 * here or put into a status notification.
 */
export function createHandoffBridgeController(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const timers = options.timers || globalThis;
  const store = options.store || {};
  const ui = options.ui || {};
  const audit = options.audit || {};
  const log = options.log || {};
  const windows = options.windows || {};
  const tunnel = options.tunnel || {};
  const oauth = options.oauth || {};
  let engine = options.engine || {};
  const listener = options.listener || {};
  const refusalForStart = typeof options.refusalForStart === 'function' ? options.refusalForStart : null;
  const sourcePolicy = typeof options.sourcePolicy === 'function' ? options.sourcePolicy : null;
  const rate = typeof options.rate === 'function' ? options.rate : null;
  const selfProbe = options.selfProbe || listener.selfProbe || listener.probe;
  const publicProbe = options.publicProbe || tunnel.publicProbe;
  const subscribers = new Set();
  const anomalyTimes = new Map();
  const releaseTimes = new Map();
  let config = cleanConfig(options.config);
  let enabled = options.enabled === true;
  let serving = 'off';
  let pauseCause = null;
  let fault = null;
  let seq = 0;
  let tickTimer = null;
  let notifyTimer = null;
  let operation = null;
  let teardown = null;
  let tunnelReadiness = null;
  let forgetting = false;
  let startGeneration = 0;
  // A request may cross several async policy ports before it reaches the
  // engine.  Disable/recreate must make every older continuation inert, so an
  // old request never calls a replacement engine in a fresh runtime.
  let lifecycleGeneration = 0;
  let stateBeforeQuit = null;
  let restartConfirmed = options.restartConfirmed === true;
  let lastHumanActionAt = safeNow(now);
  let serveIdleNoticeAt = 0;
  const counters = copy(STATUS_SNAPSHOT_EXAMPLE.counts);
  const lapsePending = new Set();
  const alarms = [];
  const preparedChats = new Map();
  let preparedChatOrdinal = 0;

  function servingGeneration(generation) {
    return generation === lifecycleGeneration && enabled === true && ['live', 'paused'].includes(serving);
  }

  function currentRuntime(generation, activeEngine = engine) {
    return servingGeneration(generation) && activeEngine === engine;
  }

  function gateUnavailable() {
    return { allow: false, status: 'app_unavailable' };
  }

  function auditEvent(ev, fields = {}) {
    try { audit.append?.(ev, fields, safeNow(now))?.catch?.(noOp); } catch { /* audit is best effort */ }
  }
  function record(code, fields = {}) {
    try { log.record?.(code, fields); } catch { /* logging is best effort */ }
  }
  function toolOutcome(tool, value) {
    const raw = typeof value?.status === 'string' ? value.status : typeof value === 'string' ? value : 'other';
    if (!TOOL_OUTCOMES[tool]?.has(raw)) return 'other';
    if (raw === 'error_retryable') return 'retry';
    // The log grammar permits both separators, but choose one stable public
    // spelling so the Activity projector never needs to inspect engine data.
    return raw.replaceAll('_', '-');
  }
  function recordToolOutcome(tool, result, startedAt) {
    const finishedAt = safeNow(now);
    const elapsed = Number.isFinite(startedAt) ? Math.max(0, Math.floor(finishedAt - startedAt)) : 0;
    record('tool_call', { tool, outcome: toolOutcome(tool, result), ms: elapsed });
  }
  function notify(kind) {
    try { ui.notify?.(kind); } catch { /* notification permission is outside policy */ }
  }
  function canvasOpen() {
    try {
      const list = windows.getCanvasWindows?.() ?? windows.list?.() ?? windows.windows;
      return Array.isArray(list) ? list.length > 0 : windows.canvasOpen === true;
    } catch { return false; }
  }
  function humanAction() {
    lastHumanActionAt = safeNow(now);
    serveIdleNoticeAt = 0;
  }
  function schedule() {
    if (notifyTimer !== null) return;
    try {
      notifyTimer = timers.setTimeout(() => {
        notifyTimer = null;
        const value = snapshot(false);
        for (const listenerFn of subscribers) { try { listenerFn(value); } catch { /* isolated subscriber */ } }
        try { ui.publishStatus?.(value); } catch { /* optional UI port */ }
      }, 0);
      notifyTimer?.unref?.();
    } catch { notifyTimer = null; }
  }
  function publishNow() {
    const value = snapshot(false);
    for (const listenerFn of subscribers) { try { listenerFn(value); } catch { /* isolated subscriber */ } }
    try { ui.publishStatus?.(value); } catch { /* optional UI port */ }
  }
  function change() { seq += 1; schedule(); }
  function startTicks() {
    if (tickTimer !== null) return;
    try {
      tickTimer = timers.setInterval(() => { void tick(); }, TICK_MS);
      tickTimer?.unref?.();
    } catch { tickTimer = null; }
  }
  function stopTicks() {
    try { if (tickTimer !== null) timers.clearInterval?.(tickTimer); } catch { /* cleanup continues */ }
    tickTimer = null;
  }
  function stopNotifications() {
    try { if (notifyTimer !== null) timers.clearTimeout?.(notifyTimer); } catch { /* cleanup continues */ }
    notifyTimer = null;
  }
  async function loadConfig({ isCurrent = null, activeEngine = engine } = {}) {
    let next = config;
    if (typeof options.getConfig === 'function') {
      const value = await Promise.resolve(options.getConfig());
      next = cleanConfig(value?.config ?? value);
    } else if (typeof store.readConfig === 'function') {
      const value = await Promise.resolve(store.readConfig());
      if (value?.state === 'unreadable') throw new Error('state_unreadable');
      next = cleanConfig(value?.config ?? value);
    }
    if (typeof isCurrent === 'function' && !isCurrent()) return null;
    // The controller is the one place config and the in-memory scheduler meet.
    // Do not let a changed UI limit silently leave a live engine on old limits.
    // Scope is a serving boundary. Synchronize it before any other asynchronous
    // config work so lowering either family takes effect before a reload can
    // return and before the next controller gate reaches the engine.
    if (typeof activeEngine?.setScope === 'function') await call(activeEngine, 'setScope', next.scope);
    if (typeof isCurrent === 'function' && !isCurrent()) return null;
    if (typeof activeEngine?.setLimits === 'function') await call(activeEngine, 'setLimits', next.limits);
    if (typeof isCurrent === 'function' && !isCurrent()) return null;
    config = next;
    return config;
  }
  function markFault(code) {
    const safe = FAULT_CODES.has(code) ? code : 'internal_error';
    fault = code ? { code: safe } : null;
    counters.lastErrorCode = code ? safe : null;
    // Only persist_failed is itself a credential-log code. Project every
    // other fixed controller fault to listener_error rather than silently
    // dropping it at the validating production logger.
    if (code) {
      if (safe === 'persist_failed') record('persist_failed', { store: 'controller', code: safe });
      else record('listener_error', { code: safe });
    }
  }
  function pauseInternal(cause, { alarm = false, alarmKind = null, deferEngine = false } = {}) {
    if (serving === 'off') return;
    serving = 'paused'; pauseCause = cause;
    counters.pauses += 1;
    if (!deferEngine) void call(engine, 'pause', cause).catch(noOp);
    // The engine owns the pause/resume ledger transition. Sharing the same
    // audit sink here would write every controller-driven pause twice.
    if (alarm) {
      counters.alarms += 1;
      const kind = ALARM_KINDS.has(alarmKind) ? alarmKind : 'unknown_key';
      alarms.unshift({ id: `${kind}-${safeNow(now)}`, kind, at: safeNow(now), acknowledged: false });
      if (alarms.length > 5) alarms.length = 5;
      notify('paused');
    }
    change();
  }
  function releaseDeadlines(stamp, generation = lifecycleGeneration) {
    const hours = config.limits.releaseTtlHours;
    if (!(hours > 0)) return [];
    let changed = false;
    const pending = [];
    for (const [jobId, releasedAt] of releaseTimes) {
      if (stamp - releasedAt < hours * 3_600_000 || lapsePending.has(jobId)) continue;
      lapsePending.add(jobId);
      // Yield before touching an adapter.  A Disable in the same turn must
      // make an expired deadline inert rather than letting a stale scheduler
      // call either the closing engine or a replacement epoch.
      const activeEngine = engine;
      pending.push(Promise.resolve().then(() => {
        if (!servingGeneration(generation) || activeEngine !== engine) return null;
        return call(activeEngine, 'hold', jobId, 'lapsed');
      }).then(result => {
        if (!servingGeneration(generation) || activeEngine !== engine) return;
        if (result?.ok === false) { markFault('persist_failed'); return; }
        releaseTimes.delete(jobId); changed = true;
      }, () => {
        if (servingGeneration(generation) && activeEngine === engine) markFault('persist_failed');
      }).finally(() => {
        lapsePending.delete(jobId);
        if (changed && servingGeneration(generation) && activeEngine === engine) change();
      }));
    }
    return pending;
  }
  function pruneReleasedEvidence() {
    const jobs = snapshotOf(engine).queue?.jobs;
    if (!Array.isArray(jobs)) return;
    const live = new Set(jobs.map(item => item?.jobId).filter(id => typeof id === 'string'));
    for (const jobId of releaseTimes.keys()) if (!live.has(jobId)) releaseTimes.delete(jobId);
  }
  function applyDeadlines(generation = lifecycleGeneration) {
    const stamp = safeNow(now);
    const pending = releaseDeadlines(stamp, generation);
    const age = stamp - lastHumanActionAt;
    if (enabled && serving !== 'off') {
      const idleMs = config.limits.idlePauseMinutes * 60_000;
      if (idleMs > 0 && age >= idleMs && serving !== 'paused') pauseInternal('idle');
    }
    return { stamp, pending };
  }
  function pauseForAnomaly(kind) {
    const setting = ANOMALY_WINDOWS[kind];
    if (!setting) return false;
    const stamp = safeNow(now); const [limit, windowMs] = setting;
    const list = (anomalyTimes.get(kind) || []).filter(time => stamp - time <= windowMs);
    list.push(stamp); anomalyTimes.set(kind, list);
    if (list.length < limit || serving === 'paused') return false;
    pauseInternal('anomaly', { alarm: true, alarmKind: kind === 'held_cap' ? 'held_caps' : kind });
    return true;
  }
  function mergedCounts(engineStatus) {
    const result = copy(counters);
    const candidate = engineStatus?.counts;
    if (isObject(candidate)) for (const key of Object.keys(result)) {
      if (key === 'acceptedByStage') continue;
      if (Number.isFinite(candidate[key])) result[key] = candidate[key];
    }
    if (isObject(candidate?.acceptedByStage)) for (const key of Object.keys(result.acceptedByStage)) {
      if (Number.isFinite(candidate.acceptedByStage[key])) result.acceptedByStage[key] = candidate.acceptedByStage[key];
    }
    return result;
  }
  function safeJobs(value) {
    return arrayOf(value).flatMap(item => {
      if (!isObject(item)) return [];
      return [{
        jobId: typeof item.jobId === 'string' && UUID.test(item.jobId) ? item.jobId : null,
        phase: oneOf(item.phase, LANE_PHASES, 'held'),
        stage: oneOf(item.stage, APPLICATION_STAGES, null),
        reason: oneOf(item.reason, JOB_REASONS, null),
        servedToChat: Number.isFinite(item.servedToChat) && item.servedToChat >= 0
          ? Math.floor(item.servedToChat) : null,
        changedAt: finite(item.changedAt),
      }];
    }).filter(item => item.jobId !== null);
  }
  function safeTasks(value) {
    return arrayOf(value, 20).flatMap(item => isObject(item) && TASK_IDS.has(item.task)
      ? [{ task: item.task, pending: Math.max(0, finite(item.pending, 0)) }] : []);
  }
  function safeLink(links, pairingStatus, stamp, base) {
    const raw = arrayOf(links, 1)[0];
    base.link.pairing.open = bool(pairingStatus?.open);
    base.link.pairing.expiresAt = finite(pairingStatus?.expiresAt);
    const unarmed = raw?.unarmedRequests ?? pairingStatus?.unarmedRequests;
    base.link.unarmedRequests = {
      count: Math.max(0, Math.min(999, finite(unarmed?.count, 0))),
      lastAt: finite(unarmed?.lastAt),
    };
    if (!isObject(raw)) {
      base.link.state = base.link.pairing.open ? 'pairing' : 'unlinked';
      return;
    }
    base.link.state = raw.revoked === true ? 'needs-renewal' : oneOf(raw.state, LINK_STATES, 'linked');
    base.link.linkedAt = finite(raw.createdAt ?? raw.linkedAt);
    base.link.lastUsedAt = finite(raw.lastRefreshedAt ?? raw.lastUsedAt);
    base.link.expiresAt = finite(raw.absoluteExpiresAt ?? raw.expiresAt);
    base.link.clientAuth = oneOf(raw.clientAuth, new Set(['none', 'assertion']), null);
    base.link.renewalCause = oneOf(raw.renewalCause, new Set(['refresh_expired', 'invalid_grant', 'revoked']), null);
    base.link.toolsStale = bool(raw.toolsStale);
    base.link.sources = arrayOf(raw.sources, 20).map(safeSourcePrefix).filter(Boolean);
    // OAuth progress is either a completed flag or its safe epoch timestamp.
    // Preserve both forms rather than silently turning a valid progress time
    // into false in the renderer snapshot.
    for (const key of Object.keys(base.link.progress)) {
      const progress = raw.progress?.[key];
      base.link.progress[key] = progress === true || Number.isFinite(progress) ? progress : false;
    }
    const absoluteSoon = Number.isFinite(base.link.expiresAt) && base.link.expiresAt - stamp <= 3 * 24 * 60 * 60_000;
    const idleSoon = Number.isFinite(raw.idleExpiresAt) && raw.idleExpiresAt - stamp <= 24 * 60 * 60_000;
    base.link.expiresSoon = absoluteSoon || idleSoon;
    base.setup.linked = base.link.state === 'linked';
  }
  function snapshot(runTick = true) {
    if (runTick) applyDeadlines();
    const base = copy(STATUS_SNAPSHOT_EXAMPLE);
    const stamp = safeNow(now);
    const engineStatus = snapshotOf(engine);
    const tunnelStatus = statusOf(tunnel);
    const links = (() => { try { return oauth.linkStatus?.() || []; } catch { return []; } })();
    const pairingStatus = (() => { try { return oauth.pairingStatus?.() || oauth.status?.() || {}; } catch { return {}; } })();
    base.seq = seq; base.at = stamp;
    const availabilityReason = oneOf(options.availability?.reason, AVAILABILITY_REASONS, null);
    base.availability = { ok: options.availability?.ok !== false && availabilityReason === null, reason: availabilityReason };
    base.enabled = enabled; base.autoStart = config.autoStart; base.autoRelease = config.autoRelease;
    base.serving = serving; base.paused = serving === 'paused'; base.pauseCause = pauseCause;
    base.hold = !canvasOpen() && enabled ? 'no-window' : (!restartConfirmed && enabled ? 'restart' : null);
    base.fault = fault;
    base.config = { hostname: config.hostname, pluginName: shortText(config.pluginName, '') || 'infinite_canvas', mcpUrl: config.hostname ? `https://${config.hostname}${CONSTANTS.MCP_PATH}` : null, scope: { applications: config.scope.applications, scoring: config.scope.scoring }, telemetryInBugReports: config.telemetryInBugReports };
    base.limits = { ...config.limits }; base.prefs = { ...config.prefs };
    base.setup.hostnameOk = Boolean(config.hostname);
    base.setup.binaryApproved = bool(tunnelStatus.binary?.approved ?? tunnelStatus.binaryApproved);
    base.setup.credentialsOk = bool(tunnelStatus.credentialsOk);
    base.setup.toolsListed = bool(engineStatus.setup?.toolsListed ?? engineStatus.link?.toolsListed);
    base.setup.firstCallSeen = bool(engineStatus.setup?.firstCallSeen ?? engineStatus.chat?.firstCallAt);
    // Do not spread a supervisor diagnostic into the renderer payload.  In
    // particular, a supervisor may know a local copy path or raw exit output.
    // The supervisor's operational vocabulary is deliberately not the
    // renderer contract.  In particular, its raw `online` state becomes the
    // sole public live state, `up`.
    base.tunnel.state = tunnelStatus.state === 'online'
      ? 'up'
      : oneOf(tunnelStatus.state, TUNNEL_STATES, 'unknown');
    // Pairing is permitted only after the public status projection says `up`.
    // A local listener can still be serving while the public supervisor is
    // degraded or failed; treating that as reachable would mint a pairing code
    // for an address ChatGPT cannot reach.
    base.setup.tunnelReachable = base.tunnel.state === 'up';
    base.tunnel.restarts = Number.isFinite(tunnelStatus.restarts) ? tunnelStatus.restarts : base.tunnel.restarts;
    base.tunnel.lastExit = oneOf(tunnelStatus.lastExit, TUNNEL_EXIT_CODES, null);
    base.tunnel.nextRetryAt = Number.isFinite(tunnelStatus.nextRetryAt) ? tunnelStatus.nextRetryAt : null;
    // A tunnel UUID is an operational identifier and must never cross status.
    base.tunnel.tunnelId = null;
    if (isObject(tunnelStatus.binary)) base.tunnel.binary = {
      path: null,
      version: typeof tunnelStatus.binary.version === 'string' && CLOUDFLARED_VERSION.test(tunnelStatus.binary.version) ? tunnelStatus.binary.version : null,
      sha256Prefix: typeof tunnelStatus.binary.sha256Prefix === 'string' && SHA256_PREFIX.test(tunnelStatus.binary.sha256Prefix) ? tunnelStatus.binary.sha256Prefix : null,
      approved: tunnelStatus.binary.approved === true,
    };
    if (isObject(tunnelStatus.probe)) base.tunnel.probe = {
      state: tunnelStatus.probe.ok === true || tunnelStatus.probe.state === 'ok'
        ? 'ok'
        : ['off', 'checking', 'ready', 'waiting', 'unavailable'].includes(tunnelStatus.probe.state)
          ? 'unknown' : oneOf(tunnelStatus.probe.state, PROBE_STATES, 'failing'),
      okAt: Number.isFinite(tunnelStatus.probe.okAt) ? tunnelStatus.probe.okAt : null,
      failingSince: Number.isFinite(tunnelStatus.probe.failingSince) ? tunnelStatus.probe.failingSince : null,
      consecutiveFailures: Number.isFinite(tunnelStatus.probe.consecutiveFailures) ? tunnelStatus.probe.consecutiveFailures : 0,
      reason: oneOf(tunnelStatus.probe.reason, PROBE_REASONS, 'other'),
    };
    // Permission details are a local diagnostic, not renderer copy.  Preserve
    // only whether the credential permissions are acceptable.
    base.tunnel.credentialsMode = tunnelStatus.credentialsMode === '0400' || tunnelStatus.credentialsMode === 'ok'
      ? 'ok'
      : tunnelStatus.credentialsMode === '0600' || tunnelStatus.credentialsMode === 'too-open' ? 'too-open'
        : 'unknown';
    base.tunnel.certPemPresent = bool(tunnelStatus.certPemPresent);
    safeLink(links, pairingStatus, stamp, base);
    const rawChat = isObject(engineStatus.chat) ? engineStatus.chat : {};
    base.chat = {
      ...base.chat,
      ordinal: Math.max(0, finite(rawChat.ordinal, base.chat.ordinal)),
      startedAt: finite(rawChat.startedAt), firstCallAt: finite(rawChat.firstCallAt), lastCallAt: finite(rawChat.lastCallAt),
      lastCallKind: oneOf(rawChat.lastCallKind, new Set(['get', 'submit']), null), calls: Math.max(0, finite(rawChat.calls, 0)),
      state: oneOf(rawChat.state, CHAT_STATES, base.chat.state), jobsAssigned: Math.max(0, finite(rawChat.jobsAssigned, 0)),
      jobsCap: Math.max(0, finite(rawChat.jobsCap, config.limits.jobsPerChat)), expiresInMs: finite(rawChat.expiresInMs),
      outstanding: null, servedTwice: bool(rawChat.servedTwice),
      previous: arrayOf(rawChat.previous, 5).flatMap(item => isObject(item) ? [{ ordinal: Math.max(0, finite(item.ordinal, 0)), endedAt: finite(item.endedAt), reason: oneOf(item.reason, new Set(['replaced', 'queue_empty', 'disabled']), null) }] : []),
    };
    if (isObject(rawChat.outstanding)) base.chat.outstanding = {
      servedAt: finite(rawChat.outstanding.servedAt), kind: oneOf(rawChat.outstanding.kind, new Set(['application', 'push']), null),
      stage: oneOf(rawChat.outstanding.stage, APPLICATION_STAGES, null), task: oneOf(rawChat.outstanding.task, TASK_IDS, null), stalled: bool(rawChat.outstanding.stalled),
      stalledSince: finite(rawChat.outstanding.stalledSince), stallsLastHour: Math.max(0, finite(rawChat.outstanding.stallsLastHour, 0)),
    };
    const rawQueue = isObject(engineStatus.queue) ? engineStatus.queue : {};
    const appQueue = isObject(rawQueue.applications) ? rawQueue.applications : rawQueue;
    base.queue = {
      applications: Object.fromEntries(Object.keys(base.queue.applications).map(key => [key, Math.max(0, finite(appQueue[key], 0))])),
      scoring: { pending: Math.max(0, finite(rawQueue.scoring?.pending, 0)), withChat: Math.max(0, finite(rawQueue.scoring?.withChat, 0)), tasks: safeTasks(rawQueue.scoring?.tasks) },
      jobs: safeJobs(rawQueue.jobs),
    };
    const rawPush = isObject(engineStatus.queue?.push) ? engineStatus.queue.push : engineStatus.push;
    if (isObject(rawPush)) {
      base.push.selectedHubs = arrayOf(rawPush.selectedHubs, 20).map(value => typeof value === 'string' && HUB_KEY.test(value) ? value : null).filter(Boolean);
      base.push.discovered = arrayOf(rawPush.discovered, 20).flatMap(item => isObject(item) && typeof item.key === 'string'
        && HUB_KEY.test(item.key)
        ? [{ key: item.key, pending: Math.max(0, finite(item.pending, 0)), tasks: safeTasks(item.tasks), excluded: Object.fromEntries(['ending', 'settling', 'attachment', 'grounded', 'free_text', 'task_not_allowed', 'node_not_allowed', 'person_editing'].map(reason => [reason, Math.max(0, finite(item.excluded?.[reason], 0))])) }] : []);
    }
    base.alarms = arrayOf([...alarms, ...arrayOf(engineStatus.alarms, 5)], 5).flatMap(item => isObject(item) && typeof item.id === 'string'
      && SAFE_KEY.test(item.id) && ALARM_KINDS.has(item.kind)
      ? [{ id: item.id, kind: item.kind, at: finite(item.at, stamp), acknowledged: bool(item.acknowledged) }] : []);
    base.counts = mergedCounts(engineStatus);
    let activityVersion = base.activityVersion;
    try {
      const owner = options.activity || log;
      const value = owner?.getVersion?.();
      if (Number.isFinite(value) && value >= 0) activityVersion = Math.max(activityVersion, Math.floor(value));
    } catch { /* the activity view is diagnostic only */ }
    base.activityVersion = Math.max(activityVersion, finite(engineStatus.activityVersion, base.activityVersion));
    base.windows = { canvasOpen: canvasOpen() };
    base.power = { keepAwake: CONSTANTS.KEEP_AWAKE_ENABLED };
    return base;
  }
  async function restartDetails(laneOrds = [], { generation = null, activeEngine = engine } = {}) {
    try {
      const stillCurrent = () => activeEngine === engine && (generation === null || currentRuntime(generation, activeEngine));
      if (!stillCurrent()) return { items: [] };
      const ords = arrayOf(laneOrds, 50).filter(value => Number.isInteger(value) && value > 0);
      // Restart metadata is an engine-internal port, never projected through
      // snapshot(): it is the only safe source of the canonical canvas path.
      const rows = arrayOf(await call(activeEngine, 'restartJobs', ords.length ? ords : undefined), 50).flatMap(item => isObject(item)
        && (ords.length === 0 || ords.includes(item.ord)) && typeof item.jobId === 'string' && UUID.test(item.jobId)
        && typeof item.canvasFilePath === 'string' && item.canvasFilePath.startsWith('/') && !item.canvasFilePath.includes('\0')
        ? [{ ord: item.ord, jobId: item.jobId, canvasFilePath: item.canvasFilePath }] : []);
      if (!stillCurrent()) return { items: [] };
      const grouped = new Map();
      for (const row of rows) {
        const group = grouped.get(row.canvasFilePath) || { canvasFilePath: row.canvasFilePath, laneOrds: [], jobIds: [] };
        group.laneOrds.push(row.ord); group.jobIds.push(row.jobId); grouped.set(row.canvasFilePath, group);
      }
      const value = typeof options.describeRestart === 'function'
        ? await Promise.resolve(options.describeRestart({ groups: [...grouped.values()] })) : { items: [] };
      return stillCurrent() && isObject(value) ? value : { items: [] };
    } catch { return { items: [] }; }
  }
  async function confirm(kind, details = {}, dialogContext = null) {
    const fn = kind === 'enable' ? (ui.confirmEnable || ui.confirm) : (ui.confirmRestart || ui.confirm);
    const answer = await call(fn, null, {
      kind,
      hostname: typeof details.hostname === 'string' ? details.hostname : null,
      // These names come from the main-owned application adapter.  No renderer
      // label or arbitrary tunnel diagnostic is ever supplied to a native sheet.
      items: arrayOf(details.items, 50).flatMap(item => isObject(item) ? [{
        title: shortText(item.title, ''), company: shortText(item.company, ''),
      }] : []),
    }, dialogContext);
    return boolConfirm(answer);
  }
  async function confirmRestart(laneOrds = [], {
    generation = lifecycleGeneration,
    activeEngine = engine,
    dialogContext = null,
  } = {}) {
    if (!currentRuntime(generation, activeEngine)) return false;
    if (restartConfirmed) return true;
    const details = await restartDetails(laneOrds, { generation, activeEngine });
    if (!currentRuntime(generation, activeEngine)) return false;
    const accepted = await confirm('restart', details, dialogContext);
    if (!currentRuntime(generation, activeEngine)) return false;
    if (accepted) {
      restartConfirmed = true;
      humanAction();
      change();
    }
    return accepted;
  }
  function createShutdownBudget() {
    const expired = Symbol('shutdown-expired');
    const capped = Symbol('shutdown-capped');
    let didExpire = false;
    let resolveDeadline;
    let deadlineTimer;
    const deadline = new Promise(resolve => { resolveDeadline = resolve; });
    const expire = () => {
      if (didExpire) return;
      didExpire = true;
      resolveDeadline(expired);
    };
    try {
      deadlineTimer = timers.setTimeout(expire, SHUTDOWN_TIMEOUT_MS);
      deadlineTimer?.unref?.();
    } catch { expire(); }

    // Convert every port result into an observed, non-rejecting task.  This is
    // important after the deadline: the operation keeps running, but a late
    // rejection must never become an unhandled rejection in the main process.
    const begin = work => {
      const task = { state: 'pending', value: undefined, error: undefined };
      task.promise = Promise.resolve(work).then(
        value => { task.state = 'fulfilled'; task.value = value; return task; },
        error => { task.state = 'rejected'; task.error = error; return task; },
      );
      return task;
    };
    const wait = async (task, timeoutMs = null) => {
      if (!task || task.state === 'fulfilled' || task.state === 'rejected') return task;
      if (didExpire) return { state: 'expired' };
      let capTimer;
      let cap = null;
      if (timeoutMs !== null) {
        cap = new Promise(resolve => {
          try {
            capTimer = timers.setTimeout(() => resolve(capped), timeoutMs);
            capTimer?.unref?.();
          } catch { resolve(capped); }
        });
      }
      try {
        const result = await Promise.race(cap ? [task.promise, deadline, cap] : [task.promise, deadline]);
        if (result === expired) return { state: 'expired' };
        if (result === capped) return { state: 'capped' };
        return result;
      } finally {
        try { if (capTimer !== undefined) timers.clearTimeout?.(capTimer); } catch { /* deadline owns completion */ }
      }
    };
    return Object.freeze({
      begin,
      invoke(port, method, args = [], timeoutMs = null) {
        // Start before inspecting expiry so every teardown owner is asked even
        // when an earlier owner consumed the one shared shutdown budget.
        return wait(begin(call(port, method, ...args)), timeoutMs);
      },
      wait,
      get expired() { return didExpire; },
      close() {
        try { if (deadlineTimer !== undefined) timers.clearTimeout?.(deadlineTimer); } catch { /* best effort */ }
      },
    });
  }
  function beginDurableOff(shutdown) {
    // The durable write is deliberately started, not awaited, before cleanup.
    // Its task remains observed by the shared shutdown budget if the adapter
    // hangs or rejects after the hard-off result has already been returned.
    return shutdown.begin(typeof store.setEnabled === 'function' ? call(store, 'setEnabled', false) : true);
  }
  async function cleanup({ clearVolatile = false, shutdown = null, quiesceTask = null } = {}) {
    const budget = shutdown || createShutdownBudget();
    try {
      // Quiesce is always first. Drain has a 10s sub-cap, while the enclosing
      // budget remains the sole 25s cap for the complete shutdown.
      // A quit stop starts this task before it returns to Electron, so the
      // listener cannot admit a fresh request in the small interval before
      // this async cleanup reaches its first await.  Keep the task in the
      // same shared budget either way.
      if (quiesceTask) await budget.wait(quiesceTask);
      else await budget.invoke(listener, 'quiesce');
      await budget.invoke(listener, 'drain', [], SHUTDOWN_DRAIN_TIMEOUT_MS);
      // A submit may outlive the listener's bounded drain. Fence its source
      // result before transport teardown continues, so it cannot persist or
      // notify while the bridge is already hard-off.
      // `close` synchronously advances the engine fence; start and observe it
      // now, but do not let a slow/disposed engine port delay tunnel/listener
      // ownership or turn a best-effort close into a teardown blocker.
      const engineClose = budget.invoke(engine, 'close');
      await budget.invoke(tunnel, 'stop');
      await budget.invoke(listener, typeof listener.close === 'function' ? 'close' : 'stop');
      if (clearVolatile) {
        await budget.invoke(engine, 'clearPushHubs');
        await budget.invoke(oauth, 'closePairing');
        preparedChats.clear();
      }
      await budget.wait(engineClose);
    } finally {
      if (!shutdown) budget.close();
      stopTicks();
      stopNotifications();
    }
  }
  async function replaceEngineAfterDisable(shutdown = null) {
    if (typeof options.recreateEngine !== 'function') return false;
    let next;
    if (shutdown) {
      const result = await shutdown.invoke(options, 'recreateEngine');
      if (result?.state !== 'fulfilled') return false;
      next = result.value;
    } else {
      try { next = await call(options.recreateEngine, null); } catch { return false; }
    }
    if (!isObject(next)) return false;
    const prior = engine;
    engine = next;
    if (shutdown) {
      await shutdown.invoke(prior, 'close');
      const scope = await shutdown.invoke(engine, 'setScope', [config.scope]);
      if (scope?.state === 'rejected') markFault('internal_error');
      const limits = await shutdown.invoke(engine, 'setLimits', [config.limits]);
      if (limits?.state !== 'fulfilled') markFault('internal_error');
    } else {
      try { await call(prior, 'close'); } catch { /* the replacement is already safe */ }
      try { await call(engine, 'setScope', config.scope); } catch { markFault('internal_error'); }
      try { await call(engine, 'setLimits', config.limits); } catch { markFault('internal_error'); }
    }
    return true;
  }
  function startCurrent(generation) { return generation === startGeneration; }
  function cancelTunnelReadiness() {
    // Disable must release the readiness wait immediately. Leaving its timer
    // live would make an already hard-off bridge retain an otherwise useless
    // readiness operation.
    try { tunnelReadiness?.finish?.(false); } catch { /* the hard-off fence still wins */ }
  }
  function waitForTunnelOnline(generation) {
    // Direct controller ports retain their historical start + immediate probe
    // behavior. Composition opts in only for the app-owned supervisor, whose
    // own cadence is the authority for edge readiness.
    if (options.waitForTunnelOnline !== true) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false; let pollTimer; let deadlineTimer;
      const pending = {
        finish(value) {
          if (settled) return;
          settled = true;
          try { if (pollTimer !== undefined) timers.clearTimeout?.(pollTimer); } catch { /* best effort */ }
          try { if (deadlineTimer !== undefined) timers.clearTimeout?.(deadlineTimer); } catch { /* best effort */ }
          if (tunnelReadiness === pending) tunnelReadiness = null;
          resolve(value === true);
        },
      };
      const inspect = () => {
        if (settled) return;
        if (!startCurrent(generation)) { pending.finish(false); return; }
        const state = statusOf(tunnel).state;
        if (state === 'online') { pending.finish(true); return; }
        if (TERMINAL_TUNNEL_START_STATES.has(state)) { pending.finish(false); return; }
        try {
          pollTimer = timers.setTimeout(inspect, TUNNEL_READINESS_POLL_MS);
          pollTimer?.unref?.();
        } catch { pending.finish(false); }
      };
      tunnelReadiness = pending;
      try {
        deadlineTimer = timers.setTimeout(() => {
          // A supervisor may publish online between the final 250ms observer
          // tick and this exact 30-second boundary. Give its closed status one
          // final read without extending the first-success window.
          pending.finish(startCurrent(generation) && statusOf(tunnel).state === 'online');
        }, TUNNEL_READINESS_TIMEOUT_MS);
        deadlineTimer?.unref?.();
      } catch { pending.finish(false); return; }
      inspect();
    });
  }
  async function cancelledStart(generation) {
    // Disable may have raced an in-flight durable enable write.  Reassert the
    // hard-off flag without waiting for a stale start, then close any owner
    // that resolved after Disable's initial cleanup pass.
    if (!startCurrent(generation) && typeof store.setEnabled === 'function') void call(store, 'setEnabled', false).catch(noOp);
    if (!teardown) await cleanup({ clearVolatile: false });
    return { success: false, code: 'CANCELLED', status: snapshot(false) };
  }
  async function runEnable(args = {}, generation) {
    const startedAt = safeNow(now);
    let startupPhase = 'listener-start';
    try {
      await loadConfig();
      if (!startCurrent(generation)) return cancelledStart(generation);
      const refusal = refusalForStart
        ? await Promise.resolve(refusalForStart({ ...(options.startContext || {}), ...(args.startContext || {}), enabled: true, config, reason: args.reason }))
        : null;
      if (!startCurrent(generation)) return cancelledStart(generation);
      if (refusal) return { success: false, code: refusal, status: snapshot(false) };
      if (!config.hostname) return { success: false, code: 'no_hostname', status: snapshot(false) };
      if (!args.autoStart && !args.confirmed) {
        const details = await restartDetails();
        if (!await confirm('enable', { hostname: config.hostname, ...details })) return { success: false, code: 'CANCELLED', status: snapshot(false) };
      }
      if (!startCurrent(generation)) return cancelledStart(generation);
      // A direct manual caller still receives the controller's fallback
      // confirmation above and earns this launch's restart acknowledgement.
      // The IPC UI can deliberately skip its repeat-enable sheet, in which
      // case the first New chat/Continue remains the required restart gate.
      restartConfirmed = args.autoStart !== true && args.restartConfirmed !== false;
      enabled = true; serving = 'starting'; pauseCause = null; markFault(null); change();
      // `enabled` is launch-local by design.  An injected setEnabled hook is
      // only an ordering/test port; config.json has no enabled field.
      if (typeof store.setEnabled === 'function' && await call(store, 'setEnabled', true) === false) throw failure('persist_failed');
      if (!startCurrent(generation)) return cancelledStart(generation);
      const bound = await boundedCall(listener, 'start', [], { timers, code: 'socket_unavailable' });
      if (!startCurrent(generation)) return cancelledStart(generation);
      if (bound === false || bound?.ok === false) throw failure('socket_unavailable', { phase: 'listener-start', cause: 'socket-unavailable' });
      if (typeof selfProbe === 'function') {
        startupPhase = 'listener-probe';
        const local = await boundedCall(selfProbe, null, [{ hostname: config.hostname }], { timers, code: 'socket_unavailable' });
        if (!startCurrent(generation)) return cancelledStart(generation);
        if (local === false || local?.ok === false) throw failure('socket_unavailable', { phase: 'listener-probe', cause: 'socket-unavailable' });
      }
      startupPhase = 'tunnel-start';
      const started = await boundedCall(tunnel, 'start', [], { timers, code: 'tunnel_failed' });
      if (!startCurrent(generation)) return cancelledStart(generation);
      if (started?.ok === false || started === false) throw failure('tunnel_failed', {
        phase: 'tunnel-start', cause: started?.code || 'startup-timeout', tunnel: statusOf(tunnel), startedAt,
      });
      if (options.waitForTunnelOnline === true) {
        startupPhase = 'tunnel-readiness';
        const ready = await waitForTunnelOnline(generation);
        if (!startCurrent(generation)) return cancelledStart(generation);
        if (ready !== true) throw failure('tunnel_failed', {
          phase: 'tunnel-readiness', cause: statusOf(tunnel).lastExit || 'readiness-timeout', tunnel: statusOf(tunnel), startedAt,
        });
      } else if (typeof publicProbe === 'function') {
        startupPhase = 'tunnel-readiness';
        const probe = await boundedCall(publicProbe, null, [{ hostname: config.hostname }], { timers, code: 'tunnel_failed' });
        if (!startCurrent(generation)) return cancelledStart(generation);
        if (probe?.ok === false || probe === false) throw failure('tunnel_failed', { phase: 'tunnel-readiness', cause: 'readiness-timeout', tunnel: statusOf(tunnel), startedAt });
      }
      if (!startCurrent(generation)) return cancelledStart(generation);
      serving = 'live'; startTicks();
      record('listener_started', { state: 'live' });
      change();
      return { success: true, status: snapshot(false) };
    } catch (error) {
      if (!startCurrent(generation)) return cancelledStart(generation);
      const observedTunnel = statusOf(tunnel);
      const fallbackCause = error?.code === 'socket_unavailable'
        ? 'socket-unavailable'
        : startupPhase === 'tunnel-readiness'
          ? observedTunnel.lastExit || 'readiness-timeout'
          : observedTunnel.lastExit || 'startup-timeout';
      const diagnostic = {
        phase: error?.diagnostic?.phase || startupPhase,
        cause: error?.diagnostic?.cause || fallbackCause,
        tunnel: error?.diagnostic?.tunnel || observedTunnel,
        startedAt: error?.diagnostic?.startedAt ?? startedAt,
        at: safeNow(now),
      };
      markFault(error?.code || 'tunnel_failed'); enabled = false; serving = 'error'; pauseCause = null; restartConfirmed = false;
      preparedChats.clear();
      const shutdown = createShutdownBudget();
      const durableOff = beginDurableOff(shutdown);
      try {
        await cleanup({ clearVolatile: false, shutdown });
        const persisted = await shutdown.wait(durableOff);
        if (persisted?.state !== 'fulfilled' || persisted.value === false) markFault('persist_failed');
      } finally { shutdown.close(); }
      seq += 1; publishNow();
      return { success: false, code: error?.code || 'tunnel_failed', status: snapshot(false), diagnostic };
    }
  }
  async function enable(args = {}) {
    if (forgetting) return { success: false, code: 'NOT_READY', status: snapshot(false) };
    if (enabled && ['live', 'paused'].includes(serving)) return { success: true, status: snapshot(false) };
    if (operation) return operation;
    const generation = ++startGeneration;
    lifecycleGeneration += 1;
    const current = runEnable(args, generation);
    let pending;
    pending = current.finally(() => { if (operation === pending) operation = null; });
    operation = pending;
    return operation;
  }
  function fenceEngineForHardOff() {
    // This is intentionally synchronous from the caller's perspective: the
    // engine advances its source fence before its returned promise settles.
    // A UI Disable may also escalate an already-running graceful quit stop.
    void call(engine, 'close').catch(noOp);
  }
  function stop({ gracefulQuit = false } = {}) {
    if (teardown) {
      // A human Disable remains a hard cut even if app shutdown already began
      // a grace drain.  It shares the existing teardown operation, but fences
      // the engine immediately so a late submit cannot persist.
      if (!gracefulQuit) fenceEngineForHardOff();
      return teardown;
    }
    // Cancel first. Both paths synchronously close the controller's accepting
    // gate and start the durable off write.  The quit-only path deliberately
    // leaves the already admitted engine work alive until listener.drain has
    // completed (or its fixed sub-cap has elapsed).
    startGeneration += 1;
    cancelTunnelReadiness();
    lifecycleGeneration += 1;
    enabled = false; serving = 'off'; pauseCause = null; stateBeforeQuit = null; restartConfirmed = false;
    record('listener_stopped', { cause: gracefulQuit ? 'quit' : 'disabled' });
    if (!gracefulQuit) fenceEngineForHardOff();
    stopTicks();
    change();
    const shutdown = createShutdownBudget();
    // Start both operations before the first await. Quiescing here matters on
    // actual app quit: a new listener request is refused even while Electron
    // unwinds the current turn toward the drain await below.
    const durableOff = beginDurableOff(shutdown);
    const quiesceTask = shutdown.begin(call(listener, 'quiesce'));
    releaseTimes.clear(); lapsePending.clear(); preparedChats.clear();
    const perform = async () => {
      try {
        await cleanup({ clearVolatile: true, shutdown, quiesceTask });
        // Only interactive Disable prepares a fresh, inert engine for a later
        // re-enable of this controller. stopHandoffBridge detaches the whole
        // graph after its bounded drain, so recreating one there would create
        // a needless owner during process teardown.
        if (!gracefulQuit) await replaceEngineAfterDisable(shutdown);
        const persisted = await shutdown.wait(durableOff);
        if (persisted?.state !== 'fulfilled' || persisted.value === false) throw failure('persist_failed');
        return { success: true, status: snapshot(false) };
      } catch (error) {
        markFault(error?.code || 'persist_failed');
        // The in-memory gate remains hard-off even if persistence failed. The
        // already-started cleanup owns all transport teardown and is bounded
        // by this same deadline, rather than beginning a second cleanup race.
        return { success: false, code: error?.code || 'persist_failed', status: snapshot(false) };
      } finally {
        shutdown.close();
        seq += 1;
        publishNow();
      }
    };
    let pending;
    pending = perform().finally(() => { if (teardown === pending) teardown = null; });
    teardown = pending;
    return teardown;
  }
  function disable() { return stop(); }
  // This is intentionally absent from the renderer controller bridge. The
  // exported index stop helper is the sole production caller; UI Disable is
  // always routed to disable() above and therefore fences immediately.
  function shutdownForQuit() { return stop({ gracefulQuit: true }); }
  async function tick(generation = lifecycleGeneration) {
    try {
      // A direct housekeeping tick after a completed Disable is intentionally
      // a successful no-op. A request-owned stale generation, however, must
      // fail closed so it cannot continue into a replacement runtime.
      if (generation !== lifecycleGeneration) return { success: false, code: 'cancelled', status: snapshot(false) };
      if (!enabled || serving === 'off') return { success: true, status: snapshot(false) };
      if (!servingGeneration(generation)) return { success: false, code: 'cancelled', status: snapshot(false) };
      const { stamp, pending } = applyDeadlines(generation);
      await Promise.all(pending);
      if (!servingGeneration(generation)) return { success: false, code: 'cancelled', status: snapshot(false) };
      await call(engine, 'tick', stamp);
      if (!servingGeneration(generation)) return { success: false, code: 'cancelled', status: snapshot(false) };
      pruneReleasedEvidence();
      return { success: true, status: snapshot(false) };
    } catch { return { success: false, code: 'internal_error', status: snapshot(false) }; }
  }
  async function gate(ctx = {}) {
    const generation = lifecycleGeneration;
    // Starting has a bound listener/self-probe sequence but is never a
    // serving state.  Do not let a public probe reach OAuth, source policy or
    // an engine while that transition is unfinished.
    if (!servingGeneration(generation)) return gateUnavailable();
    // A windowless app serves nothing.  This is intentionally before source
    // policy, OAuth, ticking and every engine/source call.
    if (!canvasOpen()) return gateUnavailable();
    // Prefix enforcement is deliberately before bearer parsing.  A caller on
    // the wrong network must get the same 401 without being able to exercise
    // token reuse, chat-key counters, or an anomaly pause.
    if (config.prefs.sourcePolicy === 'enforce' || config.prefs.sourcePolicy === 'alert') {
      let allowed = true;
      try {
        allowed = sourcePolicy
          ? await sourcePolicy({ request: ctx.req ?? ctx.request, source: ctx.source, policy: config.prefs.sourcePolicy })
          : ctx.sourceAllowed !== false;
      } catch { allowed = false; }
      if (!servingGeneration(generation)) return gateUnavailable();
      if (!allowed) {
        counters.sourceRejected += 1;
        if (config.prefs.sourcePolicy === 'enforce') {
          auditEvent('source_mismatch');
          return { allow: false, status: 'unauthorized', httpStatus: 401 };
        }
        // Alert mode intentionally preserves service. The status publication
        // gives the main-owned UI a banner seam without copying source data.
        auditEvent('source_mismatch');
        try { ui.sourceAlert?.(); } catch { /* a banner never changes policy */ }
        change();
      }
    }
    let grant = ctx.grant;
    try {
      if (!grant && typeof oauth.authenticate === 'function') grant = await call(oauth, 'authenticate', ctx.req || ctx.request || ctx);
    } catch { return servingGeneration(generation) ? { allow: false, status: 'unauthorized', httpStatus: 401 } : gateUnavailable(); }
    if (!servingGeneration(generation)) return gateUnavailable();
    if (!grant || typeof grant !== 'object') return { allow: false, status: 'unauthorized', httpStatus: 401 };
    const clock = await tick(generation);
    if (!servingGeneration(generation) || !clock.success) return gateUnavailable();
    try {
      if (rate && await rate({ request: ctx.req ?? ctx.request, source: ctx.source, grant }) === false) {
        if (!servingGeneration(generation)) return gateUnavailable();
        pauseForAnomaly('rate_limited'); return { allow: false, status: 'rate_limited', authenticated: true };
      }
    } catch { return servingGeneration(generation) ? { allow: false, status: 'rate_limited', authenticated: true } : gateUnavailable(); }
    if (!servingGeneration(generation)) return gateUnavailable();
    if (serving === 'paused') return { allow: false, status: 'paused', reason: pauseCause, authenticated: true };
    return { allow: true, grant, generation };
  }
  async function get(ctx = {}) {
    if (ctx.signal?.aborted) return { status: 'retry' };
    const startedAt = safeNow(now);
    const access = await gate(ctx);
    if (!access.allow) {
      // Source rejection happens before authentication and stays counters-only.
      // Rate/pause responses below authentication are controlled credential
      // events, so they may be represented by a closed tool_call record.
      if (access.authenticated === true) recordToolOutcome('get', { status: access.status }, startedAt);
      return { status: access.status, ...(access.reason ? { reason: access.reason } : {}) };
    }
    if (ctx.signal?.aborted) {
      const result = { status: 'retry' };
      recordToolOutcome('get', result, startedAt);
      return result;
    }
    if (!servingGeneration(access.generation)) {
      const result = { status: 'app_unavailable' };
      recordToolOutcome('get', result, startedAt);
      return result;
    }
    const activeEngine = engine;
    try {
      const result = await call(activeEngine, 'get', {
        session: ctx.session,
        linkId: ctx.linkId,
        grant: access.grant,
        canvasOpen: true,
        signal: ctx.signal,
      });
      if (!servingGeneration(access.generation) || activeEngine !== engine) {
        const unavailable = { status: 'app_unavailable' };
        recordToolOutcome('get', unavailable, startedAt);
        return unavailable;
      }
      const callAt = safeNow(now);
      counters.lastCallAt = callAt; if (result?.status === 'served'
        && callAt - lastHumanActionAt > CONSTANTS.SERVE_AFTER_IDLE_NOTICE_HOURS * 3_600_000
        && (serveIdleNoticeAt === 0 || callAt - serveIdleNoticeAt >= 3_600_000)) {
        serveIdleNoticeAt = callAt;
        // Both sinks receive enumerated facts only: no prompt, response,
        // source address, key or job metadata can reach an Activity item.
        auditEvent('served', { tool: 'get', outcome: 'served-after-idle', stage: 'none' });
        // This is a separate, rate-limited human-attention event rather than
        // a duplicate normal serve record. Its closed outcome has no request
        // text and preserves the existing serve-after-idle activity seam.
        record('tool_call', { tool: 'get', outcome: 'served-after-idle' });
        notify('served-after-idle');
      }
      recordToolOutcome('get', result, startedAt);
      change(); return result || { status: 'app_unavailable' };
    } catch {
      const failureResult = { status: 'error_retryable' };
      recordToolOutcome('get', failureResult, startedAt);
      return failureResult;
    }
  }
  async function submit(ctx = {}) {
    const startedAt = safeNow(now);
    const access = await gate(ctx);
    if (!access.allow) {
      if (access.authenticated === true) recordToolOutcome('submit', { status: access.status }, startedAt);
      return { status: access.status, ...(access.reason ? { reason: access.reason } : {}) };
    }
    if (!servingGeneration(access.generation)) {
      const result = { status: 'app_unavailable' };
      recordToolOutcome('submit', result, startedAt);
      return result;
    }
    const activeEngine = engine;
    try {
      const result = await call(activeEngine, 'submit', {
        session: ctx.session,
        handoffCode: ctx.handoffCode,
        response: ctx.response,
        linkId: ctx.linkId,
        grant: access.grant,
        canvasOpen: true,
      });
      if (!servingGeneration(access.generation) || activeEngine !== engine) {
        const unavailable = { status: 'app_unavailable' };
        recordToolOutcome('submit', unavailable, startedAt);
        return unavailable;
      }
      counters.lastCallAt = safeNow(now);
      recordToolOutcome('submit', result, startedAt);
      change(); return result || { status: 'app_unavailable' };
    }
    catch {
      const failureResult = { status: 'error_retryable' };
      recordToolOutcome('submit', failureResult, startedAt);
      return failureResult;
    }
  }
  async function pause(cause = 'user') {
    if (!enabled || serving === 'off') return { success: false, code: 'NOT_READY', status: snapshot(false) };
    pauseInternal(cause);
    return { success: true, status: snapshot(false) };
  }
  async function resume() {
    const generation = lifecycleGeneration;
    const activeEngine = engine;
    try {
      if (!currentRuntime(generation, activeEngine)) return { success: false, code: 'UNAVAILABLE', status: snapshot(false) };
      await call(activeEngine, 'resume');
      if (!currentRuntime(generation, activeEngine)) return { success: false, code: 'UNAVAILABLE', status: snapshot(false) };
      serving = 'live'; pauseCause = null; humanAction(); change(); return { success: true, status: snapshot(false) };
    } catch { return { success: false, code: 'internal_error', status: snapshot(false) }; }
  }
  async function revokeAll(ticket = null) {
    const generation = ticket?.generation ?? lifecycleGeneration;
    const activeEngine = ticket?.activeEngine ?? engine;
    const current = () => currentRuntime(generation, activeEngine);
    if (!current()) return { success: false, code: 'NOT_READY', status: snapshot(false) };
    try {
      // Revoke must await the one engine pause below as part of its durable
      // ordering. Do not also launch the ordinary fire-and-forget pause.
      pauseInternal('revoked', { deferEngine: true });
      const requireSuccess = async (port, method, ...args) => {
        if (!current()) throw failure('cancelled');
        if (typeof port?.[method] !== 'function') throw failure('persist_failed');
        const result = await call(port, method, ...args);
        if (!current()) throw failure('cancelled');
        if (result === false || result?.ok === false || result?.success === false || result === undefined) throw failure('persist_failed');
        return result;
      };
      await requireSuccess(activeEngine, 'pause', 'revoked');
      if (typeof oauth.revokeAll === 'function') {
        await requireSuccess(oauth, 'revokeAll');
      }
      else {
        let links = [];
        try { links = oauth.linkStatus?.() || []; } catch { links = []; }
        if (typeof oauth.revokeLink !== 'function') throw failure('persist_failed');
        for (const link of links) if (typeof link?.linkId === 'string') await requireSuccess(oauth, 'revokeLink', link.linkId);
      }
      await requireSuccess(oauth, 'closePairing');
      if (typeof activeEngine.revokeAll === 'function') await requireSuccess(activeEngine, 'revokeAll');
      else {
        const jobs = arrayOf(snapshotOf(activeEngine).queue?.jobs);
        if (typeof activeEngine.unrelease !== 'function') throw failure('persist_failed');
        for (const job of jobs) if (typeof job?.jobId === 'string') await requireSuccess(activeEngine, 'unrelease', job.jobId);
      }
      await requireSuccess(activeEngine, 'clearPushHubs');
      if (!current()) return { success: false, code: 'NOT_READY', status: snapshot(false) };
      releaseTimes.clear();
      await requireSuccess(oauth, 'flush');
      await requireSuccess(audit, 'flush');
      if (!current()) return { success: false, code: 'NOT_READY', status: snapshot(false) };
      counters.revokes += 1; change(); return { success: true, status: snapshot(false) };
    } catch (error) {
      return { success: false, code: error?.code === 'cancelled' ? 'NOT_READY' : 'persist_failed', status: snapshot(false) };
    }
  }
  async function forget() {
    const generation = lifecycleGeneration;
    const activeEngine = engine;
    const current = () => currentRuntime(generation, activeEngine);
    if (!current() || forgetting) return { success: false, code: 'NOT_READY', status: snapshot(false) };
    forgetting = true;
    try {
      const revoked = await revokeAll({ generation, activeEngine }); if (!revoked.success || !current()) return revoked.success ? { success: false, code: 'NOT_READY', status: snapshot(false) } : revoked;
      const disabled = await disable(); if (!disabled.success) return disabled;
      const offGeneration = lifecycleGeneration;
      if (enabled || serving !== 'off') return { success: false, code: 'NOT_READY', status: snapshot(false) };
      // Forget is complete only after the injected durable config wipe says so.
      // A missing adapter or an ambiguous return must fail closed: revocation
      // and Disable have already made the bridge inert, while the ledgers and
      // OAuth forensic state remain untouched for the composition owner.
      const wiped = await call(store, 'forget');
      if (lifecycleGeneration !== offGeneration || enabled || serving !== 'off') return { success: false, code: 'NOT_READY', status: snapshot(false) };
      if (wiped !== true) return { success: false, code: 'persist_failed', status: snapshot(false) };
      // Forget only removes config.json. The durable acknowledgement is the
      // point at which this process may stop exposing setup/config state.
      config = cleanConfig({});
      markFault(null);
      change();
      return { success: true, status: snapshot(false) };
    }
    catch { return { success: false, code: 'persist_failed', status: snapshot(false) }; }
    finally { forgetting = false; }
  }
  async function release(request) {
    const generation = lifecycleGeneration;
    if (!servingGeneration(generation)) return { ok: false, code: 'NOT_READY' };
    if (!config.scope.applications) return { ok: false, code: 'disabled' };
    const jobs = Array.isArray(request?.jobs) ? request.jobs : [];
    if (jobs.length === 0 || jobs.length > 50 || jobs.some(item => !isObject(item)
      || typeof item.jobId !== 'string' || !UUID.test(item.jobId)
      || typeof item.canvasFilePath !== 'string' || !item.canvasFilePath.startsWith('/') || item.canvasFilePath.includes('\0'))) {
      return { ok: false, code: 'invalid_arguments' };
    }
    try {
      // Canvas paths were derived by main from a live canvas window and are
      // required by the engine.  Do not accept an id-only release shape here.
      const activeEngine = engine;
      if (!servingGeneration(generation)) return { ok: false, code: 'NOT_READY' };
      const result = await call(activeEngine, 'release', { jobs: jobs.map(item => ({ jobId: item.jobId, canvasFilePath: item.canvasFilePath })) });
      if (!servingGeneration(generation) || activeEngine !== engine) return { ok: false, code: 'NOT_READY' };
      if (result?.ok) {
        for (const item of jobs) releaseTimes.set(item.jobId, safeNow(now));
        humanAction();
      }
      change(); return result || { ok: false, code: 'invalid_arguments' };
    } catch { return { ok: false, code: 'internal_error' }; }
  }
  async function unrelease(jobId) {
    if (typeof jobId !== 'string' || !UUID.test(jobId)) return { ok: false, code: 'invalid_arguments' };
    const generation = lifecycleGeneration;
    const activeEngine = engine;
    if (!currentRuntime(generation, activeEngine)) return { ok: false, code: 'NOT_READY' };
    try {
      const result = await call(activeEngine, 'unrelease', jobId);
      if (!currentRuntime(generation, activeEngine)) return { ok: false, code: 'NOT_READY' };
      if (result?.ok) { releaseTimes.delete(jobId); humanAction(); }
      change(); return result || { ok: false, code: 'not_found' };
    } catch { return { ok: false, code: 'internal_error' }; }
  }
  async function releasePushHubs(keys) {
    const generation = lifecycleGeneration;
    if (!servingGeneration(generation)) return { ok: false, code: 'NOT_READY' };
    if (!config.scope.scoring) return { ok: false, code: 'disabled' };
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 50 || keys.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))) return { ok: false, code: 'invalid_arguments' };
    let activeEngine = null;
    const selected = [];
    const rollback = async values => {
      // This intentionally talks to the captured old engine even after
      // Disable. A delayed source selection can otherwise repopulate its hub
      // registry after close() cleared it. No controller state is changed.
      for (const key of new Set(values)) {
        try { await call(activeEngine, 'unselectPushHubKey', key); } catch { /* old graph is being torn down */ }
      }
    };
    try {
      activeEngine = engine;
      if (await call(activeEngine, 'refreshPushHubs') !== true) return { ok: false, code: 'not_found' };
      if (!servingGeneration(generation) || activeEngine !== engine) return { ok: false, code: 'NOT_READY' };
      for (const key of keys) {
        const accepted = await call(activeEngine, 'selectPushHubKey', key);
        if (!servingGeneration(generation) || activeEngine !== engine) {
          await rollback([...selected, key]);
          return { ok: false, code: 'NOT_READY' };
        }
        if (accepted !== true) {
          await rollback([...selected, key]);
          return { ok: false, code: 'not_found' };
        }
        selected.push(key);
      }
      humanAction(); change();
      return { ok: true, released: selected.length };
    } catch {
      await rollback(selected);
      return { ok: false, code: 'internal_error' };
    }
  }
  async function unreleasePushHub(key) {
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return { ok: false, code: 'invalid_arguments' };
    const generation = lifecycleGeneration;
    const activeEngine = engine;
    if (!currentRuntime(generation, activeEngine)) return { ok: false, code: 'NOT_READY' };
    try {
      const removed = await call(activeEngine, 'unselectPushHubKey', key);
      if (!currentRuntime(generation, activeEngine)) return { ok: false, code: 'NOT_READY' };
      if (removed !== true) return { ok: false, code: 'not_found' };
      humanAction(); change(); return { ok: true };
    } catch { return { ok: false, code: 'internal_error' }; }
  }
  function currentLinkId(candidate) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    try {
      const links = oauth.linkStatus?.() || [];
      return arrayOf(links, 20).find(value => isObject(value) && value.revoked !== true && typeof value.linkId === 'string')?.linkId || null;
    } catch { return null; }
  }
  function makeCommitToken() {
    preparedChatOrdinal += 1;
    // This token is a one-shot main-process capability, not a session key. It
    // is never placed in status, an audit record, or an IPC reply.
    return `prepared-${safeNow(now).toString(36)}-${preparedChatOrdinal.toString(36)}`;
  }
  async function prepareChat(args = {}) {
    const kind = args?.kind === 'continue' ? 'continue' : 'new';
    // `restartContext` is an opaque main-process capability created by ui.js
    // after its sender/window guard. It is never copied into an engine call,
    // status, audit record, or IPC result.
    const dialogContext = args?.restartContext && typeof args.restartContext === 'object'
      ? args.restartContext : null;
    const generation = lifecycleGeneration;
    const activeEngine = engine;
    if (!currentRuntime(generation, activeEngine)) return { copied: false, status: 'app_unavailable' };
    if (serving === 'paused') {
      // Idle is a soft human-action deadline: preparing a new/continued chat
      // is that human action. Other pauses retain their explicit operator or
      // anomaly decision and cannot be bypassed by clipboard preparation.
      if (pauseCause !== 'idle') return { copied: false, status: 'paused', reason: pauseCause };
      try { await call(activeEngine, 'resume'); } catch { return { copied: false, status: 'paused', reason: 'idle' }; }
      if (!currentRuntime(generation, activeEngine)) return { copied: false, status: 'app_unavailable' };
      serving = 'live'; pauseCause = null; humanAction(); change();
    }
    // The engine receives this same callback in composition. Doing the check
    // here makes the controller boundary explicit and leaves older injected
    // engine fakes unable to bypass the once-per-launch restart confirmation.
    if (!restartConfirmed) {
      const restarted = await confirmRestart(undefined, { generation, activeEngine, dialogContext });
      if (!currentRuntime(generation, activeEngine)) return { copied: false, status: 'app_unavailable' };
      if (!restarted) return { copied: false, status: 'paused', reason: 'restart', code: 'DECLINED' };
    }
    if (!currentRuntime(generation, activeEngine)) return { copied: false, status: 'app_unavailable' };
    const linkId = currentLinkId(args?.linkId);
    try {
      const prepared = await call(activeEngine, 'prepareChat', { linkId, kind });
      if (!currentRuntime(generation, activeEngine)) return { copied: false, status: 'app_unavailable' };
      if (!prepared?.copied || typeof prepared.commit !== 'function' || typeof prepared.sessionCode !== 'string') {
        return { copied: false, status: prepared?.status === 'unlinked' ? 'unlinked' : 'paused', reason: prepared?.reason };
      }
      const commitToken = makeCommitToken();
      preparedChats.set(commitToken, { commit: prepared.commit, kind, at: safeNow(now), generation, engine: activeEngine });
      while (preparedChats.size > 4) preparedChats.delete(preparedChats.keys().next().value);
      // This result is consumed only by main-side ui.js for the clipboard write.
      // ui.js must return only copied/chatOrdinal to Electron's renderer IPC.
      return { copied: true, sessionCode: prepared.sessionCode, chatOrdinal: prepared.chatOrdinal, commitToken };
    } catch { return { copied: false, status: 'app_unavailable' }; }
  }
  async function commitChat(token) {
    const pending = typeof token === 'string' ? preparedChats.get(token) : null;
    if (!pending) return { success: false, code: 'NOT_READY' };
    preparedChats.delete(token);
    try {
      if (!currentRuntime(pending.generation, pending.engine)) return { success: false, code: 'NOT_READY' };
      if (pending.commit() !== true) return { success: false, code: 'NOT_READY' };
      restartConfirmed = true;
      humanAction();
      change();
      return { success: true };
    } catch { return { success: false, code: 'INTERNAL' }; }
  }
  async function abandonChat(token) {
    if (typeof token === 'string') preparedChats.delete(token);
    return { success: true };
  }
  async function chat(kind = 'new', args = {}) {
    const prepared = await prepareChat({ ...args, kind });
    if (!prepared.copied) return prepared;
    const committed = await commitChat(prepared.commitToken);
    // Never leak the session code from this compatibility path.
    return committed.success ? { copied: true, chatOrdinal: prepared.chatOrdinal } : { copied: false, status: 'app_unavailable' };
  }
  async function holdForQuit() {
    try { if (serving === 'off' || pauseCause === 'quit') return { success: true, status: snapshot(false) }; stateBeforeQuit = { serving, pauseCause }; pauseInternal('quit'); return { success: true, status: snapshot(false) }; }
    catch { return { success: false, status: snapshot(false) }; }
  }
  async function resumeAfterQuitCancel() {
    const generation = lifecycleGeneration;
    const activeEngine = engine;
    try {
      if (pauseCause === 'quit' && stateBeforeQuit && currentRuntime(generation, activeEngine)) {
        const prior = stateBeforeQuit;
        if (prior.serving === 'live') await call(activeEngine, 'resume');
        if (!currentRuntime(generation, activeEngine)) return { success: false, status: snapshot(false) };
        serving = prior.serving; pauseCause = prior.pauseCause; stateBeforeQuit = null;
        change();
      }
      return { success: true, status: snapshot(false) };
    }
    catch { return { success: false, status: snapshot(false) }; }
  }
  function notePairingAction() {
    // Composition calls this only after the main-owned pairing sheet has
    // opened successfully. Failed or remote authorize attempts never reach
    // this clock, and pairing does not silently lift an existing pause.
    if (!enabled || serving === 'off') return false;
    humanAction();
    change();
    return true;
  }
  function onPairingState() {
    // Pairing owns its short-lived secret. The controller only republishes a
    // fresh code-free projection when that state opens or closes, so every
    // renderer can discard an expired/cancelled code without retaining it
    // here or waiting for an unrelated controller mutation.
    change();
    return true;
  }
  function onAnonymous() { counters.anonymousRequests += 1; change(); return { paused: false }; }
  function onReconnectHint() {
    // OAuth/pairing already established a real renewal, fresh own-egress, and
    // the one-per-minute limit. Publishing status is the only allowed effect:
    // never open a panel/sheet, raise a notification, audit, or log.
    change();
    return true;
  }
  function onTransportCount(kind) {
    // HTTP can report only these closed, content-free counter classes. It
    // intentionally has no authority to pause, log, audit, or mutate a chat.
    if (kind === 'mcp_anon' || kind === 'host_mismatch') counters.anonymousRequests += 1;
    else if (kind === 'source_mismatch') counters.sourceRejected += 1;
    else if (kind === 'permit_leak') counters.permitLeaks += 1;
    else return false;
    change();
    return true;
  }
  function onSecurityEvent(event = {}) {
    try {
      const kind = typeof event === 'string' ? event : event.kind || event.event;
      if (kind === 'source_rejected' || kind === 'source_mismatch') { counters.sourceRejected += 1; auditEvent('source_mismatch'); return false; }
      // Every event that changes availability is opt-in authenticated.  Missing
      // metadata is anonymous noise, never a remote kill switch.
      if (event.authenticated !== true) return false;
      if (kind === 'refresh_reuse' || kind === 'code_reuse') { void revokeAll(); return true; }
      if (['unknown_key', 'unknown_handoff', 'misrouted', 'rate_limited', 'held_cap'].includes(kind)) return pauseForAnomaly(kind);
    } catch { /* event handling is non-throwing */ }
    return false;
  }
  function getActivity() {
    let raw = [];
    try {
      const owner = options.activity || log;
      const reader = options.getActivity || owner?.getRecent;
      raw = typeof reader === 'function' ? reader.call(owner) : [];
    } catch { raw = []; }
    return arrayOf(raw, 200).flatMap(item => {
      const safe = sanitizeActivityItem(item);
      return safe ? [{ ...safe }] : [];
    });
  }
  function subscribe(fn) { if (typeof fn !== 'function') return noOp; subscribers.add(fn); return () => subscribers.delete(fn); }
  async function reloadConfig() {
    const generation = lifecycleGeneration;
    const activeEngine = engine;
    const current = () => currentRuntime(generation, activeEngine);
    if (!current()) return { success: false, code: 'NOT_READY', status: snapshot(false) };
    try {
      const loaded = await loadConfig({ isCurrent: current, activeEngine });
      if (!loaded || !current()) return { success: false, code: 'NOT_READY', status: snapshot(false) };
      change(); return { success: true, status: snapshot(false) };
    }
    catch (error) { markFault(error?.code || 'state_unreadable'); change(); return { success: false, code: error?.code || 'state_unreadable', status: snapshot(false) }; }
  }
  function ackAlarm(id) {
    const alarm = alarms.find(item => item.id === id);
    if (!alarm) return { ok: false, code: 'not_found' };
    alarm.acknowledged = true; change(); return { ok: true };
  }

  return Object.freeze({
    snapshot, status: snapshot, getState: snapshot, subscribe, tick, gate, get, submit,
    enable, disable, shutdownForQuit, pause, resume, revokeAll, forget, release, unrelease, releasePushHubs, unreleasePushHub,
    newChat: args => chat('new', args), continueChat: args => chat('continue', args),
    prepareChat, commitChat, abandonChat, confirmRestart, getActivity,
    holdForQuit, resumeAfterQuitCancel, notePairingAction, onPairingState, onAnonymous, onReconnectHint, onTransportCount, onSecurityEvent, reloadConfig, ackAlarm,
  });
}

export default createHandoffBridgeController;
