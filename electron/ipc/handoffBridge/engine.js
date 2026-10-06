import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONSTANTS } from './constants.js';
import {
  createApplicationLane,
  createHandoffCodeGuard,
  holdLane,
  indexLaneCode,
  isHumanAdvance,
  isHandoffCodeGuard,
  makeChatKey,
  normalizeCurrentHandoff,
  rehydrateApplicationLane,
  remainingCounts,
  rememberIssuedCode,
  resumeLane,
  tombstoneCode,
} from './lanes.js';
import {
  classifySubmission,
  extractPasteEnvelopeIdentity,
  responseFingerprint,
  stringifySubmission,
  trimHandoffCode,
} from './preflight.js';
import {
  makeRejectedBody,
  makeResultBody,
  makeServedBody,
  pushInstructionsFor,
  REJECTED_CAUTION,
  RESULT_NOTES,
  supersededStageNote,
} from './framing.js';
import { MAX_WORKER_POOL_PLANNING_UNITS, MAX_WORKER_POOL_SIZE, recommendWorkerPool } from './workerPool.js';

const JOB_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// Push tasks whose prompt/response carries marketplace listing or pricing
// data rather than job-scoring content. This is deliberately a literal list
// rather than an import from a concrete push source: the engine is written
// against a generic push-shaped port (see the push.get/push.submit shape
// check below) and must not depend on one source implementation's internal
// task-policy table to decide which consent boundary a served task needs.
const MARKETPLACE_PUSH_TASKS = new Set([
  'price-synthesis', 'price-synthesis-batch', 'bundle-price-synthesis', 'platform-fit-assessment',
]);
// Status is a public, privacy-reduced surface. Keep its task labels closed so
// an injected/generic push port cannot turn arbitrary task text into report
// telemetry. This is the release_one policy vocabulary from sources/push.js.
const STATUS_PUSH_TASKS = new Set([
  'price-synthesis', 'price-synthesis-batch', 'bundle-price-synthesis', 'platform-fit-assessment',
  'resume-parse', 'job-compensation-research', 'job-compensation-research-batch',
  'job-preference-research', 'job-preference-research-batch', 'job-query-generation', 'job-scoring',
  'job-taxonomy-plan', 'job-taxonomy-classify', 'job-taxonomy-classify-batch',
  'job-compensation-assessment', 'job-compensation-assessment-batch',
  'job-preference-interpretation', 'job-preference-evaluation',
  'job-preference-research-assessment', 'job-preference-research-batch-assessment',
  'job-role-audit', 'job-role-screen', 'job-role-screen-batch',
]);
const SCORING_PUSH_TASKS = new Set([...STATUS_PUSH_TASKS].filter(task => !MARKETPLACE_PUSH_TASKS.has(task)));
const PUSH_EXCLUSION_REASONS = ['ending', 'settling', 'attachment', 'free_text', 'task_not_allowed', 'node_not_allowed', 'person_editing'];
const STATUS_STAGES = new Set(['evidence-plan', 'resume', 'cover-letter', 'review']);
const STATUS_PHASES = new Set(['unread', 'awaiting', 'host', 'done', 'needs_user', 'held', 'gone']);
const STATUS_REASONS = new Set([
  'user_hold', 'human_advance', 'rejection_cap', 'junk_cap', 'review_round_cap',
  'job_broken', 'render_retry', 'app_fix_required', 'canvas_unavailable', 'read_failed', 'write_failed',
  'submit_stuck', 'host_silent', 'lapsed', 'restart',
]);
// Closed drop cause -> the per-cause counter it increments.
const DROP_COUNTER = Object.freeze({
  bundle_discarded: 'droppedDiscarded', bundle_pruned: 'droppedPruned', bundle_missing: 'droppedMissing', bundle_saved: 'droppedSaved',
});
const LOG_EPOCH_CAUSES = new Set(['continued', 'rotated', 'drained', 'source_ended', 'closed', 'link_changed']);
const LOG_PAUSE_CAUSES = new Set(['user', 'idle', 'anomaly', 'revoked', 'quit']);
// Composition reuses the push source when it replaces a terminal engine after
// Disable. Keep discovery visibility owned by the current engine instance so
// a late old refresh cannot leak its cache into the next lifecycle's status.
const PUSH_DISCOVERY_OWNERS = new WeakMap();

function statusStage(value) { return STATUS_STAGES.has(value) ? value : null; }
function statusPhase(value) { return STATUS_PHASES.has(value) ? value : 'unread'; }
function statusReason(value) { return STATUS_REASONS.has(value) ? value : null; }
function statusTime(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

function verdictKey(codeKey, text) {
  return createHash('sha256').update(codeKey).update('\0').update(text).digest('hex');
}

function epochHash(linkId, key) {
  return sha256(`epoch\n${linkId}\n${key}`);
}

// Ended-chat digest, persisted in the ledger and kept for in-memory retired
// chats. The chat key itself is never written: only a digest under its own
// domain-separation prefix (distinct from the in-memory epoch hash). It is
// deliberately NOT bound to the link: recognising that a key has ended must
// keep working after the person re-pairs (a new link id). Authenticating the
// LIVE key stays link-bound (epochHash).
function endedDigest(key) {
  return createHash('sha256').update(`retired-chat-v2\n${key}`, 'utf8').digest('hex');
}

// In-memory only: which link a live chat was started under, to notice a relink.
function epochLinkDigest(linkId) {
  return createHash('sha256').update(`epoch-link\n${linkId}`, 'utf8').digest('hex');
}

// Hex-digest equality through the same constant-time comparison as every other
// digest in this file.
function sameHex(left, right) {
  return typeof left === 'string' && typeof right === 'string' && sameDigest(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

const HEX_DIGEST = /^[a-f0-9]{64}$/;
const BAD_KEY_WINDOW_MS = 10 * 60_000;
// A live chat's ledger entry is re-stamped on authenticated use at most this often.
const LEDGER_REFRESH_MS = 3_600_000;

function sameDigest(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && timingSafeEqual(left, right);
}

function safeNow(now) {
  const value = Number(now());
  return Number.isFinite(value) ? value : Date.now();
}

function makeSemaphore(limit) {
  let active = 0;
  const waiters = [];
  const acquire = () => {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise(resolve => waiters.push(resolve)).then(() => { active++; });
  };
  const release = () => {
    active = Math.max(0, active - 1);
    waiters.shift()?.();
  };
  const close = () => { while (waiters.length) waiters.shift()?.(); };
  return Object.freeze({ acquire, release, close, active: () => active, waiting: () => waiters.length });
}

function normalizeSourceResult(result) {
  if (!result || typeof result !== 'object') return { kind: 'threw', code: 'internal_error' };
  if (result.kind === 'phase' && typeof result.phase === 'string') return { ...result, kind: result.phase };
  if (typeof result.kind === 'string') return result;
  if (result.completed === true && !result.handoff) return { kind: 'host', completed: true };
  if (result.handoff) return { kind: 'open', handoff: result.handoff };
  return { kind: 'threw', code: 'internal_error' };
}

function normalizeSubmitResult(result) {
  if (!result || typeof result !== 'object') return { kind: 'threw', code: 'internal_error' };
  if (typeof result.kind === 'string') {
    if (result.kind === 'accepted' && !result.handoff && result.next) return { ...result, handoff: result.next };
    return result;
  }
  if (result.accepted === true) return { kind: 'accepted', completed: result.completed === true, handoff: result.handoff ?? null };
  if (result.accepted === false) {
    return {
      kind: 'rejected',
      handoff: result.handoff ?? null,
      validationErrors: Array.isArray(result.validationErrors) ? result.validationErrors : [],
    };
  }
  return { kind: 'threw', code: 'internal_error' };
}

function isAbsoluteCanvasPath(value) {
  return typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !value.includes('\0');
}

function normalizeLimits(value = {}) {
  return {
    releaseTtlHours: Number.isFinite(value.releaseTtlHours) ? Math.max(0, value.releaseTtlHours) : CONSTANTS.RELEASE_TTL_HOURS,
    chatKeyMaxAgeHours: Number.isFinite(value.chatKeyMaxAgeHours) ? Math.max(0, value.chatKeyMaxAgeHours) : CONSTANTS.CHAT_KEY_MAX_AGE_HOURS,
    idlePauseMinutes: Number.isFinite(value.idlePauseMinutes) ? Math.max(0, value.idlePauseMinutes) : CONSTANTS.IDLE_PAUSE_MINUTES,
    jobsPerChat: Number.isInteger(value.jobsPerChat)
      ? Math.max(CONSTANTS.JOBS_PER_CHAT_MIN, Math.min(CONSTANTS.JOBS_PER_CHAT_MAX, value.jobsPerChat))
      : CONSTANTS.JOBS_PER_CHAT,
    epochSoftBytes: Number.isFinite(value.epochSoftBytes) ? Math.max(0, value.epochSoftBytes) : CONSTANTS.EPOCH_SOFT_BYTES,
    epochHardBytes: Number.isFinite(value.epochHardBytes) ? Math.max(0, value.epochHardBytes) : CONSTANTS.EPOCH_HARD_BYTES,
  };
}

function normalizeScope(value = {}) {
  // Keep the standalone engine's safe fallback aligned with persisted config
  // and bootstrap: every reviewed text-only handoff family is enabled unless
  // a caller explicitly opts it out. Composition still synchronizes the
  // persisted scope before serving, and every false remains an exact fence.
  return Object.freeze({
    applications: value?.applications !== false,
    scoring: value?.scoring !== false,
    marketplace: value?.marketplace !== false,
  });
}

export function createHandoffEngine({
  source,
  sources,
  store = null,
  audit = null,
  logger = null,
  now = Date.now,
  random = randomBytes,
  timers = globalThis,
  limits: initialLimits,
  scope: initialScope,
  confirmRestart = async () => true,
  onJobChanged = () => undefined,
  onServeAfterIdle = () => undefined,
  holdMs = CONSTANTS.GET_HOLD_MS,
  readWatchdogMs = CONSTANTS.LANE_READ_WATCHDOG_MS,
  submitBudgetMs = CONSTANTS.SUBMIT_RESPONSE_BUDGET_MS,
  restoredLanes = [],
  autoStart = false,
  codeGuard: injectedCodeGuard = null,
} = {}) {
  const codeGuard = isHandoffCodeGuard(injectedCodeGuard) ? injectedCodeGuard : createHandoffCodeGuard();
  const application = sources?.application ?? source;
  const push = sources?.push ?? null;
  if (!application || typeof application.read !== 'function' || typeof application.status !== 'function'
      || typeof application.submit !== 'function') throw new TypeError('An application source is required');
  if (push && (typeof push.get !== 'function' || typeof push.submit !== 'function')) throw new TypeError('A push source must implement get and submit');
  application.setCodeGuard?.(codeGuard);
  push?.setCodeGuard?.(codeGuard);
  const pushOwner = push && (typeof push === 'object' || typeof push === 'function') ? Object.freeze({}) : null;
  let pushDiscoveryCurrent = true;
  if (pushOwner) {
    // A brand-new source may expose its already-built safe discovery cache.
    // A source inherited from a closed engine must refresh in this lifecycle
    // before its cached rows can be projected again.
    pushDiscoveryCurrent = !PUSH_DISCOVERY_OWNERS.has(push);
    PUSH_DISCOVERY_OWNERS.set(push, pushOwner);
    try { push.setDiscoveryOwner?.(pushOwner); } catch { /* optional source ownership fence */ }
  }
  const ownsPushDiscovery = () => !pushOwner || PUSH_DISCOVERY_OWNERS.get(push) === pushOwner;

  let limits = normalizeLimits(initialLimits);
  // A zero byte budget means "do not force a chat rollover". This keeps the
  // bridge's old context-management guard available as an explicit safety
  // setting without pretending it is a ChatGPT-imposed limit. Per-response
  // and MCP transport caps remain enforced independently.
  function workerByteTotal(worker) {
    return Math.max(0, Number(worker?.bytesServed) || 0) + Math.max(0, Number(worker?.bytesReceived) || 0);
  }
  function atSoftByteBudget(worker) {
    return limits.epochSoftBytes > 0 && workerByteTotal(worker) >= limits.epochSoftBytes;
  }
  function atHardByteBudget(worker) {
    return limits.epochHardBytes > 0 && workerByteTotal(worker) >= limits.epochHardBytes;
  }
  // Scope is an engine-owned serving fence, rather than a UI-only release
  // preference.  It is checked immediately before every source call so an
  // already-released lane or selected hub cannot survive a scope downgrade.
  let scope = normalizeScope(initialScope);
  function pushAllowedTasks() {
    const allowed = new Set();
    if (scope.scoring) for (const task of SCORING_PUSH_TASKS) allowed.add(task);
    if (scope.marketplace) for (const task of MARKETPLACE_PUSH_TASKS) allowed.add(task);
    return allowed;
  }
  try { push?.setAllowedTasks?.(pushAllowedTasks()); } catch { /* source remains fail-closed at its own policy */ }
  const lanes = [];
  const codeIndex = new Map();
  const tombstones = new Map();
  const verdicts = new Map();
  const pushVerdicts = new Map();
  const retiredEpochs = [];
  // Chats, oldest first: {digest, retiredAt}. Loaded from the store at start (so a
  // chat from before a restart is recognised as ended), extended when a chat
  // starts (so a crash still leaves its key recognisable), and re-stamped when the
  // live chat is used (at most hourly) and when it ends. `retiredAt` is therefore
  // the last stamp, not necessarily the end. Digests only, never a key.
  let ledger = [];
  let ledgerPersistQueued = false;
  // Unrecognised chat keys, for diagnostics only. A stale or garbled chat is
  // not an attack signal (the caller already passed OAuth), so nothing here
  // pauses or alarms.
  const badKeyTimes = [];
  let lastBadKeyAt = null;
  let endedKeyCount = 0;
  const waiters = new Set();
  const hintTimers = new Map();
  const lastHintAt = new Map();
  const semaphore = makeSemaphore(CONSTANTS.SUBMIT_CONCURRENCY);
  const laneMutationQueue = [];
  let laneMutationRunning = false;
  const laneRevisions = new WeakMap();
  const laneCallRevisions = new WeakMap();
  let laneStateVersion = 0;
  let persistenceVersion = 0;
  let lastPersistOutcomeVersion = 0;
  let reconcileRunning = false;
  let reconcileRequestSerial = 0;
  let reconcileCompletedSerial = 0;

  function laneRevision(lane) { return laneRevisions.get(lane) ?? 0; }
  function touchLane(lane) {
    const next = laneRevision(lane) + 1;
    laneRevisions.set(lane, next);
    laneStateVersion += 1;
    return next;
  }

  // Route every lane mutation through a serial FIFO queue so concurrent
  // operations cannot interleave.  Keep the tail fulfilled even when a
  // caller fails, but return the original promise so each caller receives its
  // own result or error.  Do not use a global reentrancy flag here: an async
  // operation can yield while another caller arrives, and a global flag would
  // let that unrelated caller skip the queue.
  function mutateLanes(operation) {
    return new Promise((resolve, reject) => {
      laneMutationQueue.push({ operation, resolve, reject });
      runLaneMutationQueue();
    });
  }

  function runLaneMutationQueue() {
    if (laneMutationRunning) return;
    const entry = laneMutationQueue.shift();
    if (!entry) return;
    laneMutationRunning = true;
    // Invoke the first available operation now, rather than behind an
    // unnecessary microtask.  Invalidation callers rely on their state change
    // becoming visible before a same-turn poll, while later callers still wait
    // for this operation's complete async result.
    let result;
    try { result = entry.operation(); }
    catch (error) {
      laneMutationRunning = false;
      entry.reject(error);
      runLaneMutationQueue();
      return;
    }
    if (result && typeof result.then === 'function') {
      laneMutationRunning = false;
      entry.reject(new Error('lane mutation must be synchronous'));
      runLaneMutationQueue();
      return;
    }
    entry.resolve(result);
    laneMutationRunning = false;
    runLaneMutationQueue();
  }
  let epoch = null;
  let epochOrdinal = 0;
  // An epoch is intentionally retired on a genuine queue drain, but a report
  // taken seconds later must not rewrite a just-finished worker pool as a
  // "legacy single chat". Keep only a small, capability-free closure receipt.
  const closedPoolHistory = [];
  let reservedEpochOrdinal = 0;
  // Pool preparation crosses several async boundaries (restart confirmation
  // and source discovery). Coalesce overlapping presses so two callers can
  // never each commit a fresh epoch and strand the first set of starters.
  let workerPoolStartInFlight = null;
  let laneOrdinal = 0;
  let paused = false;
  let pauseCause = null;
  let closed = false;
  let restartConfirmed = restoredLanes.length === 0;
  let restartRevision = 0;
  let lastHumanActionAt = safeNow(now);
  let lastIdleNoticeAt = 0;
  let fault = null;
  let restartConfirmation = null;
  // Source operations cannot be cancelled once handed to the application or
  // push seam.  A generation fence nevertheless makes their *results*
  // disposable: Disable/close and a power resume must not let a delayed
  // result alter lanes, write persistence, notify a renderer, or populate a
  // verdict cache in the next lifecycle.
  let sourceGeneration = 0;
  // Memory-only sequence for application proof reservations. Every claim also
  // carries the epoch number, so an obsolete GET can never release a newer
  // worker-1 reservation after a rotation or source-generation fence.
  let getClaimOrdinal = 0;
  // One engine epoch can contain a small, explicitly started pool of distinct
  // ChatGPT sessions.  The epoch remains the shared source-generation fence;
  // worker records provide the ownership boundary so concurrent chats never
  // receive or submit one another's handoffs.
  function workerId(ordinal) { return `worker-${ordinal}`; }
  function epochWorkers(target = epoch) {
    if (!target) return [];
    return target.workers instanceof Map ? [...target.workers.values()] : [target];
  }
  function workerForId(target, id) {
    if (!target || typeof id !== 'string') return null;
    return target.workers instanceof Map ? target.workers.get(id) || null : id === 'worker-1' ? target : null;
  }
  function workerForSession(target, linkId, session) {
    const presented = typeof session === 'string' ? session.trim() : '';
    const boundLinkId = typeof linkId === 'string' ? linkId : '';
    for (const worker of epochWorkers(target)) {
      if (sameDigest(epochHash(boundLinkId, presented), worker.keyHash)) return worker;
    }
    return null;
  }
  function poolWorkerCount(target = epoch) {
    return Math.max(1, Math.min(MAX_WORKER_POOL_SIZE, epochWorkers(target).length || 1));
  }
  function clearLaneWorkerAssignment(lane) {
    if (!lane) return;
    for (const worker of epochWorkers()) {
      const wasFocusedTask = worker.focusLaneOrd === lane.ord;
      worker.assignedLaneOrds?.delete?.(lane.ord);
      worker.servedPrompt?.delete?.(lane.ord);
      if (wasFocusedTask) worker.focusLaneOrd = null;
      // Application ownership is single-handoff-at-a-time. Clearing the
      // focused lane must also clear its quiet-watch marker, while a worker
      // with a later push task stays untouched.
      if (wasFocusedTask && worker.activeTaskKind === 'application') {
        worker.activeTask = false;
        worker.activeTaskKind = null;
        worker.activeTaskSince = null;
      }
    }
    lane.servedWorkerId = null;
    lane.pendingWorkerId = null;
  }
  function makeWorker({ ordinal, sessionCode, linkId, kind, stamp }) {
    return {
      id: workerId(ordinal),
      workerOrdinal: ordinal,
      keyHash: epochHash(linkId, sessionCode),
      endedDigest: endedDigest(sessionCode),
      ledgerStampAt: 0,
      starterKey: kind === 'new' ? sessionCode : null,
      // Reserved before this worker's code can leave the engine. ui.js
      // releases it only when its clipboard write fails, preventing two chats
      // from receiving the same worker capability.
      starterExported: false,
      mintedBy: kind === 'new' ? 'new' : 'continue',
      presented: false,
      mintedAt: stamp,
      bytesServed: 0,
      bytesReceived: 0,
      lastGetAt: null,
      lastSubmitAt: null,
      firstCallAt: null,
      lastCallAt: null,
      lastCallKind: null,
      calls: 0,
      // A small, aggregate-only progress counter for the worker roster. It is
      // intentionally neither a job identity nor a prompt/result payload.
      completed: 0,
      // True only while this worker owns a served handoff. `laneAwaitingAnswer`
      // remains the authoritative application backstop; this covers push work.
      activeTask: false,
      activeTaskKind: null,
      // Main-process-only activity accounting. A submit may wait on source IO
      // longer than the recovery threshold, so it must never be mistaken for
      // a silent worker while that admitted call is still settling.
      submitInFlight: 0,
      // The moment this worker was last handed (or re-handed) an unanswered
      // task. It is process-local liveness bookkeeping only; status projects
      // the resulting closed state, never this timestamp or task identity.
      activeTaskSince: null,
      // Resume moves this floor forward so a deliberate bridge pause never
      // turns into an immediate false "quiet" retry alert.
      quietFrom: null,
      // `waitingSince` is distinct from a handoff being answered.  It starts
      // when this worker was explicitly told to poll again and lets the pool
      // offer a safe replacement starter if the ChatGPT composer/session goes
      // away before making that next call.
      waitingSince: null,
      consecutiveWaits: 0,
      idleSince: null,
      lastOutcome: null,
      lastOutcomeAt: null,
      restarts: 0,
      focusLaneOrd: null,
      servedPrompt: new Map(),
      assignedLaneOrds: new Set(),
      poolStarted: false,
      // A quiet worker can be restarted in place.  Its task ownership remains
      // with this ordinal while a fresh, one-shot starter is waiting to be
      // copied, so the status projection must offer that starter before it
      // describes the retained task as working.
      restartPending: false,
      // A second transport GET from this chat attaches here while the first
      // one is selecting, proving, and serving work. Never persisted or
      // exposed in status.
      getInFlight: null,
    };
  }
  function attachWorkers(primary, { workerCount = 1, linkId } = {}) {
    const count = Math.max(1, Math.min(MAX_WORKER_POOL_SIZE, Number.isInteger(workerCount) ? workerCount : 1));
    // Expanding a live ordinary chat into a pool must preserve worker 1 and
    // every already-issued sibling. Replacing the map here would strand an
    // in-flight handoff or silently invalidate a starter the person copied.
    const workers = primary.workers instanceof Map
      ? new Map(primary.workers)
      : new Map([[workerId(1), primary]]);
    workers.set(workerId(1), primary);
    for (let ordinal = 2; ordinal <= count; ordinal += 1) {
      if (workers.has(workerId(ordinal))) continue;
      const code = makeChatKey(random);
      workers.set(workerId(ordinal), makeWorker({ ordinal, sessionCode: code, linkId, kind: 'new', stamp: primary.mintedAt }));
    }
    primary.id = workerId(1);
    primary.workerOrdinal = 1;
    primary.starterExported = false;
    primary.workers = workers;
    primary.poolSize = Math.max(count, workers.size);
    primary.poolGeneration = primary.n;
    for (const worker of workers.values()) {
      worker.getInFlight = null;
      worker.activeTask = worker.activeTask === true;
      worker.activeTaskKind = worker.activeTaskKind === 'application' || worker.activeTaskKind === 'push'
        ? worker.activeTaskKind
        : null;
      worker.activeTaskSince = Number.isFinite(worker.activeTaskSince) ? worker.activeTaskSince : null;
      worker.submitInFlight = Number.isSafeInteger(worker.submitInFlight) && worker.submitInFlight > 0
        ? worker.submitInFlight
        : 0;
      worker.quietFrom = Number.isFinite(worker.quietFrom) ? worker.quietFrom : null;
      worker.waitingSince = Number.isFinite(worker.waitingSince) ? worker.waitingSince : null;
      worker.completed = Number.isSafeInteger(worker.completed) && worker.completed >= 0
        ? worker.completed
        : 0;
      worker.lastOutcome = typeof worker.lastOutcome === 'string' ? worker.lastOutcome : null;
      worker.lastOutcomeAt = Number.isFinite(worker.lastOutcomeAt) ? worker.lastOutcomeAt : null;
      worker.restarts = Number.isSafeInteger(worker.restarts) && worker.restarts >= 0 ? worker.restarts : 0;
      worker.restartPending = worker.restartPending === true;
    }
    return primary;
  }
  const counts = {
    getServed: 0, getWaiting: 0, getEmpty: 0, getPaused: 0, getUnauthorized: 0,
    submitAccepted: 0, submitRejected: 0, submitDuplicate: 0, submitJunk: 0,
    submitSuperseded: 0, submitMisrouted: 0, submitHeld: 0, submitTooLarge: 0,
    pauses: 0, chatsStarted: 0, chatsContinued: 0,
    // Lane lifecycle observations for bug reports. releaseNoops counts release
    // calls that added nothing (an auto-release keep-alive re-attempt); only
    // real additions are audited, logged, or treated as human activity.
    releaseCalls: 0, releaseNoops: 0, unreleaseCalls: 0, lanesDropped: 0,
    // lanesDropped split by the closed cause the app or a status probe gave.
    droppedDiscarded: 0, droppedPruned: 0, droppedMissing: 0, droppedSaved: 0,
  };

  function log(code, fields = {}) {
    try { logger?.record?.(code, fields); } catch { /* logging cannot break serving */ }
  }

  function auditEvent(event, fields = {}) {
    try {
      const pending = typeof audit?.append === 'function'
        ? audit.append(event, fields, safeNow(now))
        : audit?.write?.({ event, fields, at: safeNow(now) });
      pending?.catch?.(() => undefined);
    } catch { /* audit failures are surfaced separately by its owner */ }
  }

  function sourceCurrent(generation = sourceGeneration) {
    return !closed && generation === sourceGeneration;
  }

  // A source-generation fence protects Disable, power resume and scope
  // changes.  An epoch fence is separate: New chat/Continue deliberately keep
  // the same sources and lanes, but an already-authenticated call from the
  // retired chat must not be allowed to consume or frame work for its
  // replacement.
  function epochCurrent(expected, generation = sourceGeneration) {
    return sourceCurrent(generation) && epoch === expected;
  }

  function invalidateSourceWork() {
    sourceGeneration += 1;
    verdicts.clear();
    pushVerdicts.clear();
    // This hides (rather than destructively clearing) source-owned discovery.
    // The source can be shared with a replacement engine, so clearing it here
    // could erase the replacement's just-refreshed rows.
    pushDiscoveryCurrent = false;
    void mutateLanes(() => {
      for (const lane of lanes) {
        lane.inFlight.read = null;
        lane.inFlight.status = null;
        lane.inFlight.submit = null;
        lane.pendingWorkerId = null;
        if (lane.phase === 'awaiting') {
          lane.snapshot = null;
          lane.needsRefresh = true;
        } else if (lane.phase === 'unread' || lane.phase === 'host') {
          lane.snapshot = null;
        }
        touchLane(lane);
      }
    });
  }

  function notifyJobChanged(lane, generation = sourceGeneration) {
    if (!sourceCurrent(generation) || !lane || !JOB_ID_RE.test(lane.jobId) || !isAbsoluteCanvasPath(lane.canvasFilePath)) return;
    try { onJobChanged({ jobId: lane.jobId, canvasFilePath: lane.canvasFilePath }); } catch { /* renderer notification is advisory */ }
  }

  function lanePersistenceSnapshot() {
    // A store may serialize on a later turn. Never hand it live lane objects:
    // a later queued mutation must not change what this particular write means.
    return Object.freeze(lanes.map(lane => Object.freeze({
      ord: lane.ord,
      jobId: lane.jobId,
      canvasFilePath: lane.canvasFilePath,
      releasedAt: lane.releasedAt,
      phase: lane.phase,
      reason: lane.reason ?? null,
      heldFrom: lane.heldFrom ?? null,
      counters: Object.freeze({
        rejections: lane.counters?.rejections ?? 0,
        junkStreak: lane.counters?.junkStreak ?? 0,
        revisedRounds: lane.counters?.revisedRounds ?? 0,
        errStreak: lane.counters?.errStreak ?? 0,
        attemptByStage: Object.freeze({ ...(lane.counters?.attemptByStage ?? {}) }),
      }),
    })));
  }

  async function persistLanes(generation = sourceGeneration) {
    if (!sourceCurrent(generation)) {
      if (!closed) reconcileLanes(sourceGeneration);
      return false;
    }
    if (!store?.saveLanes) return true;
    const writeVersion = ++persistenceVersion;
    const snapshotVersion = laneStateVersion;
    const snapshot = lanePersistenceSnapshot();
    try {
      const result = await store.saveLanes(snapshot);
      if (!sourceCurrent(generation)) {
        if (!closed) reconcileLanes(sourceGeneration);
        return false;
      }
      if (result === false) throw Object.assign(new Error('lane persistence failed'), { code: 'persist_failed' });
      // The fault describes the LAST write, not history: a later successful
      // save proves the store works again, so a sticky flag would keep the
      // bridge reading as faulted until restart.
      if (writeVersion >= lastPersistOutcomeVersion) {
        lastPersistOutcomeVersion = writeVersion;
        if (fault === 'persist_failed') fault = null;
      }
      if (laneStateVersion > snapshotVersion) reconcileLanes(generation);
      return true;
    } catch {
      if (!sourceCurrent(generation)) {
        if (!closed) reconcileLanes(sourceGeneration);
        return false;
      }
      if (writeVersion >= lastPersistOutcomeVersion) {
        lastPersistOutcomeVersion = writeVersion;
        fault = 'persist_failed';
        // `persist_failed` has a deliberately narrow log schema. Do not send a
        // made-up `kind` field here: a production logger correctly rejects it,
        // which used to make this important fault invisible in bug reports.
        log('persist_failed', { store: 'lanes', code: 'persist_failed' });
      }
      return false;
    }
  }

  function reconcileLanes(generation = sourceGeneration) {
    // A failed optimistic snapshot may have been queued ahead of a newer one.
    // Persist the current immutable view after rollback so disk converges to
    // the state that won the revision check.
    if (!sourceCurrent(generation)) return;
    reconcileRequestSerial += 1;
    if (reconcileRunning) return;
    reconcileRunning = true;
    void (async () => {
      try {
        while (sourceCurrent(generation)) {
          const targetRequest = reconcileRequestSerial;
          const targetVersion = laneStateVersion;
          const saved = await persistLanes(generation);
          if (!sourceCurrent(generation)) return;
          // A request or semantic state advance that arrived while this save
          // ran deserves one fresh immutable snapshot. A lone failed
          // corrective save stops here to avoid a hot retry loop.
          if (!saved && reconcileRequestSerial <= targetRequest && laneStateVersion <= targetVersion) {
            reconcileCompletedSerial = Math.max(reconcileCompletedSerial, targetRequest);
            return;
          }
          if (saved && reconcileRequestSerial <= targetRequest && laneStateVersion <= targetVersion) {
            reconcileCompletedSerial = Math.max(reconcileCompletedSerial, targetRequest);
            return;
          }
        }
      } finally {
        reconcileRunning = false;
        if (sourceCurrent(sourceGeneration) && reconcileCompletedSerial < reconcileRequestSerial) reconcileLanes(sourceGeneration);
      }
    })().catch(() => undefined);
  }

  function humanAction() {
    lastHumanActionAt = safeNow(now);
    lastIdleNoticeAt = 0;
  }

  function wake() {
    for (const resolve of [...waiters]) resolve();
    waiters.clear();
  }

  function clearTimer(timer) {
    if (timer !== undefined && timer !== null) timers.clearTimeout?.(timer);
  }

  function clearLaneHint(lane) {
    if (!lane || !Number.isInteger(lane.ord)) return;
    clearTimer(hintTimers.get(lane.ord));
    hintTimers.delete(lane.ord);
    lastHintAt.delete(lane.ord);
  }

  function delay(ms) {
    if (!(ms > 0) || typeof timers.setTimeout !== 'function') {
      return { promise: Promise.resolve('timer'), clear: () => undefined };
    }
    let timer;
    return {
      promise: new Promise(resolve => {
        timer = timers.setTimeout(() => resolve('timer'), ms);
        timer?.unref?.();
      }),
      clear: () => clearTimer(timer),
    };
  }

  async function raceWithBudget(promise, ms, timeoutValue) {
    if (!(ms > 0)) return timeoutValue;
    const timer = delay(ms);
    try {
      return await Promise.race([Promise.resolve(promise), timer.promise.then(() => timeoutValue)]);
    } finally { timer.clear(); }
  }

  async function waitForWake(ms, signal = null) {
    if (signal?.aborted) return 'aborted';
    if (!(ms > 0)) return 'timer';
    let release;
    let aborted = false;
    const wakePromise = new Promise(resolve => { release = resolve; waiters.add(resolve); });
    const timer = delay(ms);
    const abort = () => { aborted = true; release(); };
    try {
      signal?.addEventListener?.('abort', abort, { once: true });
      await Promise.race([wakePromise, timer.promise]);
      return aborted || signal?.aborted ? 'aborted' : 'woke';
    }
    finally {
      waiters.delete(release);
      timer.clear();
      try { signal?.removeEventListener?.('abort', abort); } catch { /* optional AbortSignal */ }
    }
  }

  // ---- ended-chat ledger -------------------------------------------------
  // A chat key that is not the live one is almost always a chat that ended: one
  // from before an app restart, or one whose in-memory retired entry was evicted.
  // The ledger remembers ended chats across restarts so the answer is
  // 'session_ended' (which tells ChatGPT the chat is over) rather than
  // 'unauthorized' (which invites a retry with the same code).
  const ledgerWindowMs = () => Math.max(limits.chatKeyMaxAgeHours, 24) * 3_600_000;

  function persistLedger() {
    if (typeof store?.saveRetiredChats !== 'function') return;
    try {
      const pending = store.saveRetiredChats(ledger.map(entry => ({ ...entry })));
      if (pending && typeof pending.catch === 'function') pending.catch(() => undefined);
    } catch { /* the ledger is a best-effort aid; serving never depends on it */ }
  }

  // The hot path (an authenticated call) never persists inline: the write is
  // queued behind the current turn and coalesced, and it snapshots the ledger as
  // it is then. A failure is swallowed by persistLedger.
  function persistLedgerSoon() {
    if (ledgerPersistQueued) return;
    ledgerPersistQueued = true;
    queueMicrotask(() => { ledgerPersistQueued = false; persistLedger(); });
  }

  // The primary worker keeps the historical single-chat digest helper. Pool
  // aliases are included through liveDigests wherever a key can be recognised
  // or retained, so ending one pool never makes its sibling starter look
  // unrecognised.
  const liveDigest = () => (epoch && typeof epoch.endedDigest === 'string' ? epoch.endedDigest : null);
  const liveDigests = () => epochWorkers().map(worker => worker.endedDigest).filter(value => typeof value === 'string');

  function ledgerAdd(digest, stamp) {
    ledger = ledger.filter(entry => !sameHex(entry.digest, digest));
    ledger.push({ digest, retiredAt: stamp });
    // Over the cap, drop the oldest entry that is not the live chat's own.
    while (ledger.length > CONSTANTS.RETIRED_EPOCHS) {
      const live = liveDigests();
      const index = ledger.findIndex(entry => !live.some(digest => sameHex(entry.digest, digest)));
      ledger.splice(index === -1 ? 0 : index, 1);
    }
  }

  // Age out old entries, never the live chat's own while it is live. Returns
  // whether anything was dropped. (A relink does not purge: its ended keys stay
  // ended. Only a revoke, by `all`, clears the ledger.)
  function pruneLedger({ all = false } = {}) {
    const stamp = safeNow(now);
    const window = ledgerWindowMs();
    const live = liveDigests();
    const before = ledger.length;
    ledger = all ? [] : ledger.filter(entry => live.some(digest => sameHex(entry.digest, digest)) || stamp - entry.retiredAt <= window);
    return ledger.length !== before;
  }

  // Re-stamp the live chat's entry. Its chat was minted (and stamped) at commit;
  // without this a chat live for more than the window would lose the entry that
  // makes a crash recoverable.
  function refreshLiveEntry(stamp) {
    const workers = epochWorkers();
    if (workers.length === 0) return;
    for (const worker of workers) {
      if (typeof worker.endedDigest !== 'string') continue;
      worker.ledgerStampAt = stamp;
      ledgerAdd(worker.endedDigest, stamp);
    }
    persistLedgerSoon();
  }

  // A validated call, or the relink event, names the link now in force. A live
  // chat started under another link can never authenticate again (its key is
  // bound to that link), so end it: its key becomes an ended key and its next
  // call is answered session_ended, the status shows no chat, and the person is
  // led to start a new one. Returns whether a chat was retired.
  function noteLink(linkId) {
    if (closed || !epoch || typeof linkId !== 'string' || !linkId) return false;
    if (sameHex(epoch.linkDigest, epochLinkDigest(linkId))) return false;
    retireEpoch('link_changed');
    return true;
  }

  function isEndedKey(digest) {
    if (pruneLedger()) persistLedger();
    if (liveDigests().some(live => sameHex(digest, live))) return false;
    return ledger.some(entry => sameHex(entry.digest, digest));
  }

  function loadLedger() {
    try {
      const loaded = store?.loadRetiredChats?.(safeNow(now));
      if (!Array.isArray(loaded)) return;
      ledger = loaded.filter(entry => entry && HEX_DIGEST.test(String(entry.digest)) && Number.isSafeInteger(entry.retiredAt))
        .map(entry => ({ digest: entry.digest, retiredAt: entry.retiredAt }))
        .slice(-CONSTANTS.RETIRED_EPOCHS);
      // Anything here belongs to a process that no longer exists. Age out what
      // is too old to matter (from its last stamp), and write the trimmed list back.
      if (pruneLedger()) persistLedger();
    } catch { ledger = []; /* fail closed to an empty list */ }
  }

  function retireEpoch(reason) {
    if (!epoch) return;
    const closingEpoch = epoch;
    if (closingEpoch.poolStarted === true) {
      const stamp = safeNow(now);
      const planned = closingEpoch.poolRecommendation || {};
      const workers = epochWorkers(closingEpoch).map(worker => {
        const quiet = workerIsQuiet(worker, stamp);
        const pollingAfterWait = workerIsPollingAfterWait(worker);
        const state = worker.restartPending === true
          ? (worker.starterExported === true ? 'ready' : 'available')
          : worker.idleSince != null ? 'idle'
            : quiet ? 'quiet'
              : worker.activeTask === true || (worker.getInFlight != null && !pollingAfterWait) ? 'working'
                : worker.presented === true || worker.calls > 0 ? 'waiting'
                  : worker.starterExported === true ? 'ready' : 'available';
        return Object.freeze({
          ordinal: worker.workerOrdinal,
          state,
          completed: Math.max(0, Number.isSafeInteger(worker.completed) ? worker.completed : 0),
          firstCallAt: statusTime(worker.firstCallAt),
          lastCallAt: statusTime(worker.lastCallAt),
          lastCallKind: ['get', 'submit'].includes(worker.lastCallKind) ? worker.lastCallKind : null,
          lastOutcome: ['served', 'waiting', 'queue_empty', 'paused', 'session_full', 'needs_user', 'retry', 'accepted', 'rejected', 'held', 'unknown_handoff', 'session_ended'].includes(worker.lastOutcome) ? worker.lastOutcome : null,
          lastOutcomeAt: statusTime(worker.lastOutcomeAt),
          quietReason: workerQuietReason(worker, stamp),
          restarts: Math.max(0, Number.isSafeInteger(worker.restarts) ? worker.restarts : 0),
        });
      });
      closedPoolHistory.push(Object.freeze({
        endedAt: stamp,
        reason: ['drained', 'source_ended', 'continued', 'rotated', 'link_changed', 'revoked', 'quit', 'disabled'].includes(reason) ? reason : 'other',
        generation: Number.isSafeInteger(closingEpoch.poolGeneration) ? closingEpoch.poolGeneration : null,
        workerCount: workers.length,
        workers: Object.freeze(workers),
        plan: Object.freeze({
          recommended: Math.max(0, Number.isInteger(planned.recommended) ? planned.recommended : workers.length),
          queued: Math.max(0, Number.isInteger(planned.queued) ? planned.queued : 0),
          materialized: Math.max(0, Number.isInteger(planned.materialized) ? planned.materialized : 0),
          expandBy: 0,
          reason: ['empty', 'one_work_item', 'maximum_parallelism', 'preserved_live_workers'].includes(planned.reason) ? planned.reason : 'empty',
          expansionCount: Math.max(0, Number.isInteger(closingEpoch.poolExpansion?.count) ? closingEpoch.poolExpansion.count : 0),
          lastExpansionAt: statusTime(closingEpoch.poolExpansion?.at),
          lastExpansionAdded: Math.max(0, Number.isInteger(closingEpoch.poolExpansion?.added) ? closingEpoch.poolExpansion.added : 0),
        }),
      }));
      while (closedPoolHistory.length > 3) closedPoolHistory.shift();
    }
    // Drop the plaintext starter with the epoch: nothing may re-copy it (or
    // find it in a still-referenced object) once the chat has ended.
    for (const worker of epochWorkers(epoch)) worker.starterKey = null;
    // Worker ordinals restart in every pool. Clear both in-memory ownership
    // hints and transient probe claims so a successor cannot inherit an old
    // worker-1 assignment or be blocked by its pending source call.
    for (const lane of lanes) {
      lane.servedWorkerId = null;
      lane.pendingWorkerId = null;
    }
    const retiringPushEpoch = pushEpochId(epoch);
    try { push?.closeEpoch?.(retiringPushEpoch); } catch { /* push state is disposable */ }
    for (const [key, value] of pushVerdicts) if (value.epochId === retiringPushEpoch) pushVerdicts.delete(key);
    retiredEpochs.push({ n: epoch.n, digest: liveDigest(), endedAt: safeNow(now), reason });
    while (retiredEpochs.length > CONSTANTS.RETIRED_EPOCHS) retiredEpochs.shift();
    // Re-stamp this chat's persisted digest with the moment it ended. (No entry
    // is added when the link was revoked: that path cleared the ledger.)
    if (liveDigests().length > 0) {
      for (const digest of liveDigests()) ledgerAdd(digest, safeNow(now));
      pruneLedger();
      persistLedger();
    }
    auditEvent('epoch_closed', { reason });
    log('epoch_closed', { cause: LOG_EPOCH_CAUSES.has(reason) ? reason : 'other' });
    epoch = null;
    // App/seam calls are not cancellable once started.  Their source-global
    // commit may still settle, but its result must be ignored and every new
    // chat must re-read rather than inheriting an old call's cache or prompt.
    invalidateSourceWork();
    wake();
  }

  function pushEpochId(value = epoch) {
    // This id is deliberately derived only from the in-memory epoch ordinal;
    // neither the chat key nor a stable external identifier crosses the seam.
    return value ? `epoch-${value.n}` : null;
  }

  function checkIdlePause() {
    if (!epoch || paused || limits.idlePauseMinutes <= 0) return;
    // Starting a worker pool is an explicit request to keep draining later
    // waves. Do not make it require another starter solely because a person
    // has not touched the app for the legacy idle interval.
    if (epoch.poolStarted === true) return;
    if (safeNow(now) - lastHumanActionAt >= limits.idlePauseMinutes * 60_000) {
      paused = true;
      pauseCause = 'idle';
      counts.pauses++;
      auditEvent('pause', { cause: 'idle' });
      log('pause', { cause: 'idle' });
    }
  }

  function markPresented(target) {
    target.presented = true;
    target.starterExported = true;
    target.starterKey = null;
    // Restart uses a reserved replacement starter that was copied directly by
    // the main-process UI path. Once its fresh chat authenticates, it is an
    // ordinary live worker again: it must report active work and may later
    // become quiet/restartable, rather than remaining permanently `ready`.
    target.restartPending = false;
    target.lastCallAt = safeNow(now);
  }

  // The controller turned away a call that carried this chat's key before the
  // engine's own gates ran (its idle pause, its rate limit). The chat holds the
  // key all the same. Matches only; it never counts a wrong key.
  function notePresented({ session, linkId, grant } = {}) {
    if (closed || !epoch || typeof session !== 'string') return false;
    const boundLinkId = typeof (grant?.linkId ?? linkId) === 'string' ? (grant?.linkId ?? linkId) : '';
    const worker = workerForSession(epoch, boundLinkId, session);
    if (!worker) return false;
    markPresented(worker);
    return true;
  }

  function authenticate(session, linkId) {
    const presented = typeof session === 'string' ? session.trim() : '';
    const boundLinkId = typeof linkId === 'string' ? linkId : '';
    // A call ends the live chat for a link change only when it presents that
    // chat's own key under another link: the chat itself proves the link moved.
    // Any other call names a link that may be stale (its grant was checked when
    // its headers arrived, possibly before a re-pair), so it must not end a
    // healthy chat. The relink event (controller.onLinkChanged) is the
    // authoritative path.
    if (liveDigests().some(liveKey => sameHex(endedDigest(presented), liveKey))) noteLink(boundLinkId);
    if (!epoch) {
      if (isEndedKey(endedDigest(presented))) endedKeyCount++;
      return { status: 'session_ended', worker: null };
    }
    const worker = workerForSession(epoch, boundLinkId, presented);
    if (worker) {
      // The chat holds its key and has reached the bridge with it, whatever
      // the gates below decide. The starter can no longer be handed to a second
      // chat, and the chat is no longer "awaiting its first call".
      markPresented(worker);
      const stamp = safeNow(now);
      if (limits.chatKeyMaxAgeHours > 0
          && stamp - worker.mintedAt >= limits.chatKeyMaxAgeHours * 3_600_000) return { status: 'session_ended', worker: null };
      // Keep the crash-recovery entry of a long-lived chat fresh, at most hourly.
      if (stamp - worker.ledgerStampAt >= LEDGER_REFRESH_MS) refreshLiveEntry(stamp);
      return { status: 'ok', worker };
    }
    const ended = endedDigest(presented);
    for (const retired of retiredEpochs) {
      if (retired.digest && sameHex(retired.digest, ended)) { endedKeyCount++; return { status: 'session_ended', worker: null }; }
    }
    if (isEndedKey(ended)) { endedKeyCount++; return { status: 'session_ended', worker: null }; }
    // An unrecognised key. The caller already passed OAuth, so this is our own
    // paired ChatGPT: a stale chat or a garbled code, not an attack (chat keys
    // are high-entropy and the controller rate-limits attempts). It is counted
    // for the bug report and otherwise ignored: no pause, no alarm.
    const stamp = safeNow(now);
    badKeyTimes.push(stamp);
    lastBadKeyAt = stamp;
    while (badKeyTimes.length && stamp - badKeyTimes[0] > BAD_KEY_WINDOW_MS) badKeyTimes.shift();
    while (badKeyTimes.length > 1000) badKeyTimes.shift();
    counts.getUnauthorized++;
    return { status: 'unauthorized', worker: null };
  }

  // MCP tool arguments intentionally contain only the session (and, for a
  // submit, its handoff payload). The authenticated OAuth grant supplies the
  // link binding in production. Keep every post-auth action on the exact same
  // link-id precedence as authentication; otherwise a valid MCP worker can
  // serve work but cannot grow a pool after a fresh forecast arrives.
  function authenticatedLinkId(args = {}) {
    const value = args?.grant?.linkId ?? args?.linkId;
    return typeof value === 'string' ? value : '';
  }

  function gate(args) {
    if (closed) return { body: makeResultBody('paused', { reason: 'closed' }), worker: null };
    const auth = authenticate(args.session, authenticatedLinkId(args));
    if (auth.status !== 'ok') return { body: makeResultBody(auth.status), worker: null };
    checkIdlePause();
    if (paused) return { body: makeResultBody('paused', { reason: pauseCause }), worker: null };
    return { body: null, worker: auth.worker };
  }

  function adoptCurrent(lane, handoff) {
    const current = normalizeCurrentHandoff(handoff, safeNow(now));
    if (!current) return false;
    const previous = lane.current;
    const previousKey = codeGuard.key(previous?.code);
    if (previous?.code && !codeGuard.equal(previous.code, current.code) && codeIndex.has(previousKey)) {
      tombstoneCode(tombstones, previous.code, 'rotated', { laneOrd: lane.ord, at: safeNow(now) }, CONSTANTS.TOMBSTONES_PER_ENGINE, codeGuard);
      codeIndex.delete(previousKey);
    }
    // A different handoff replaced the one the chat was given: nothing has
    // been served for THIS one yet (serveLane stamps it when it goes out).
    if (previous?.code && !codeGuard.equal(previous.code, current.code)) {
      lane.servedAt = null;
      lane.awaitingAnswer = false;
    }
    // A lane that was not awaiting (held, unread, with the app) was not being
    // answered meanwhile: its wait starts over rather than counting that time.
    if (lane.phase !== 'awaiting') lane.quietFrom = safeNow(now);
    lane.current = current;
    lane.needsRefresh = false;
    setPhase(lane, 'awaiting');
    lane.reason = null;
    lane.heldFrom = null;
    lane.hostSince = null;
    lane.snapshot = { at: safeNow(now), kind: 'open' };
    rememberIssuedCode(lane, current.code, codeGuard);
    indexLaneCode(codeIndex, lane, { epochN: epoch?.n ?? null, servedAt: null }, CONSTANTS.CODE_INDEX_PER_LANE, codeGuard);
    return true;
  }

  // A lane the person (or a cap) held while a call for it was in flight. Calls
  // are only ever started for lanes that are not held, so a held lane when the
  // result lands was held DURING the call: the result must not un-hold it.
  function isHeldPhase(lane) {
    return lane.phase === 'held' || lane.phase === 'needs_user';
  }

  // Every phase change goes through here so `changedAt` (what the dock and the
  // bug report show as "in this phase") is the moment the lane ENTERED its
  // phase. It used to be stamped only by a hold, so a lane that went host ->
  // done reported its age since release.
  function setPhase(lane, phase, stamp = safeNow(now)) {
    if (lane.phase !== phase) lane.changedAt = stamp;
    lane.phase = phase;
  }

  // Work the engine still owes a lane. `needsRefresh` is a re-read request that
  // only an AWAITING lane still owes: a renderer hint (or one that landed while
  // the lane was awaiting) leaves the flag behind on a host, held or finished
  // lane, where nothing consumes it, so counting it there made a saved job read
  // as pending work forever and get() answered 'waiting' until the wait limit
  // instead of 'queue_empty'. A held lane that resumes to awaiting keeps its flag
  // and is counted again from that moment.
  function laneBusy(item) {
    return (item.needsRefresh === true && item.phase === 'awaiting')
      || ['unread', 'host'].includes(item.phase)
      || Boolean(item.inFlight.read || item.inFlight.status || item.inFlight.submit);
  }

  // ChatGPT was told to stop calling. Nothing will call again until the person
  // sends Continue (or starts a chat), so the chat reads as idle, not working,
  // until its next authenticated call clears it.
  function markChatStopped(target) {
    if (target && epochWorkers(epoch).includes(target)) {
      target.idleSince ??= safeNow(now);
      target.activeTask = false;
      target.activeTaskKind = null;
      target.activeTaskSince = null;
      target.waitingSince = null;
    }
  }

  function markWorkerWaiting(target, stamp = safeNow(now)) {
    if (!target || !epochWorkers(epoch).includes(target)) return;
    target.idleSince = null;
    // Every successful `waiting` result renews the next promised poll. A poll
    // follows the previous instruction but is also positive liveness proof,
    // so preserving the first wait would falsely mark a healthy long-running
    // poll loop quiet. The served paths below clear this atomically with new
    // ownership, avoiding a waiting -> working -> waiting roster flap.
    target.waitingSince = stamp;
    target.activeTask = false;
    target.activeTaskKind = null;
    target.activeTaskSince = null;
  }

  // Pool workers share one authenticated MCP grant. Keep their idle polling
  // comfortably below that grant's one-request-per-second refill rate, while
  // preserving the established short cadence for a single legacy chat. The
  // worker-ordinal spread prevents a full-capacity pool from synchronizing every
  // retry wave and leaves headroom for submit_handoff calls.
  function workerRetryAfterSeconds(expectedEpoch = epoch, worker = expectedEpoch, singleChatSeconds = 5) {
    if (expectedEpoch?.poolStarted !== true || !worker) return singleChatSeconds;
    const workerCount = poolWorkerCount(expectedEpoch);
    const ordinal = Math.max(1, Math.min(workerCount, Number(worker.workerOrdinal) || 1));
    const span = CONSTANTS.POOL_WAIT_MAX_SECONDS - CONSTANTS.POOL_WAIT_MIN_SECONDS;
    const offset = workerCount > 1 ? Math.round((ordinal - 1) * span / (workerCount - 1)) : 0;
    return CONSTANTS.POOL_WAIT_MIN_SECONDS + offset;
  }

  function recordWorkerOutcome(target, status, stamp = safeNow(now)) {
    if (!target || !epochWorkers(epoch).includes(target)) return;
    const safe = ['served', 'waiting', 'queue_empty', 'paused', 'session_full', 'needs_user', 'retry', 'accepted', 'rejected', 'held', 'unknown_handoff', 'session_ended'].includes(status)
      ? status
      : 'retry';
    target.lastOutcome = safe;
    target.lastOutcomeAt = stamp;
  }

  // Keep the worker roster deliberately aggregate-only. The count is updated
  // at the same durable acceptance points as `counts.submitAccepted`, rather
  // than on a renderer retry that happens to receive a cached accepted result.
  function markWorkerCompleted(target) {
    if (!target || !epochWorkers(epoch).includes(target)) return;
    target.completed = Math.min(Number.MAX_SAFE_INTEGER,
      Math.max(0, Number.isSafeInteger(target.completed) ? target.completed : 0) + 1);
    target.activeTask = false;
    target.activeTaskKind = null;
    target.activeTaskSince = null;
  }

  // An unanswered handoff can legitimately take several minutes. The bridge
  // cannot prove why a chat has gone silent, but after a bounded interval it
  // must no longer claim the chat is actively working. This is deliberately a
  // recovery *warning*, never an automatic revoke/reassignment: a replacement
  // keeps the same logical worker id and re-reads the same owned handoff.
  function workerAnswerSilent(worker, stamp = safeNow(now)) {
    if (paused || !worker || worker.getInFlight != null || worker.submitInFlight > 0) return false;
    const outstandingApplication = lanes.some(lane => laneAwaitingAnswer(lane, worker));
    const outstandingPush = worker.activeTask === true && worker.activeTaskKind === 'push';
    if (!outstandingApplication && !outstandingPush) return false;
    const servedAt = Number.isFinite(worker.activeTaskSince) ? worker.activeTaskSince : worker.lastGetAt;
    if (!Number.isFinite(servedAt)) return false;
    // A submit/re-get while the same task remains open is real liveness and
    // starts a new ambiguity interval (for example, a correction round).
    const anchor = Math.max(servedAt, Number.isFinite(worker.lastCallAt) ? worker.lastCallAt : servedAt);
    return stamp - anchor >= CONSTANTS.STALL_NOTICE_MS;
  }

  function workerQuietReason(worker, stamp = safeNow(now)) {
    if (worker?.submitInFlight > 0) return null;
    if (workerAnswerSilent(worker, stamp)) return 'answer_silent';
    if (paused || !worker || worker.getInFlight != null || !Number.isFinite(worker.waitingSince)) return null;
    const anchors = [worker.waitingSince, worker.quietFrom].filter(Number.isFinite);
    if (anchors.length === 0 || stamp - Math.max(...anchors) < CONSTANTS.STALL_NOTICE_MS) return null;
    return 'polling_stopped';
  }

  function workerIsQuiet(worker, stamp = safeNow(now)) {
    return workerQuietReason(worker, stamp) !== null;
  }

  // A worker that was explicitly told to wait stays in that lifecycle state
  // while its next polling GET is selecting. `getInFlight` otherwise denotes
  // real work (initial claims and active handoffs), but treating an ordinary
  // wait poll as working makes a healthy pool visibly oscillate on every
  // cadence tick.
  function workerIsPollingAfterWait(worker, hasOutstandingApplication = lanes.some(lane => laneAwaitingAnswer(lane, worker))) {
    return worker?.getInFlight != null
      && Number.isFinite(worker.waitingSince)
      && worker.activeTask !== true
      && !hasOutstandingApplication;
  }

  // The result of an in-flight call reached a lane that was held meanwhile. The
  // hold stands; the lane re-reads when it is resumed rather than trusting a
  // read that predates the hold.
  function keepHoldOverResult(lane) {
    lane.heldFrom = 'unread';
    lane.snapshot = null;
  }

  // The app answered a submit for `code` while its lane could not take the
  // result (it was detached, the chat/generation was fenced off, or the submit
  // outlived its stuck timeout). Remember the fact on the lane so a lane that
  // comes back is consistent: an accepted code is retired, a rejected code that
  // rotated is superseded, the successor is a known code (not a person's edit)
  // and the lane re-reads before it serves anything.
  function recordAcceptedElsewhereOp(lane, code, result) {
    if (!lane || !code) return;
    let record = null;
    if (result?.kind === 'accepted') {
      let nextCode = null;
      if (!result.completed && result.handoff) nextCode = normalizeCurrentHandoff(result.handoff, safeNow(now))?.code ?? null;
      record = { kind: 'accepted', code, nextCode };
    } else if (result?.kind === 'rejected') {
      const returned = normalizeCurrentHandoff(result.handoff, safeNow(now));
      // An unchanged code needs no bookkeeping: a re-read sees the same handoff.
      if (!returned || codeGuard.equal(returned.code, code)) return;
      // A recorded acceptance is the stronger fact; never overwrite it.
      if (lane.acceptedElsewhere?.kind === 'accepted') return;
      record = { kind: 'rejected', code, nextCode: returned.code };
    }
    if (!record) return;
    // A fenced/timed-out X can finish after this still-included lane adopted
    // Y (or cleared its current handoff).  An included lane owns a late result
    // only when it still owns X itself, or when its current handoff is null but
    // the exact-digest route still points back at this same lane. Retire X in
    // every other case; never settle the late result onto Y.
    const indexed = codeIndex.get(codeGuard.key(code));
    const ownsLateCode = lane.current?.code
      ? codeGuard.equal(lane.current.code, code)
      : lane.current === null && indexed?.lane === lane
        && codeGuard.sameDigest(indexed.codeDigest, codeGuard.digest(code));
    if (lanes.includes(lane) && !ownsLateCode) {
      const stamp = safeNow(now);
      if (record.kind === 'accepted') {
        tombstoneCode(tombstones, code, 'accepted', { laneOrd: lane.ord, at: stamp }, CONSTANTS.TOMBSTONES_PER_ENGINE, codeGuard);
      } else if (record.nextCode && !codeGuard.equal(record.nextCode, code)) {
        tombstoneCode(tombstones, code, 'rotated', { laneOrd: lane.ord, at: stamp }, CONSTANTS.TOMBSTONES_PER_ENGINE, codeGuard);
      }
      return;
    }
    lane.acceptedElsewhere = record;
    if (lanes.includes(lane)) settleAcceptedElsewhere(lane);
    else touchLane(lane);
  }

  function recordAcceptedElsewhere(lane, code, result) {
    void mutateLanes(() => recordAcceptedElsewhereOp(lane, code, result));
  }

  function settleAcceptedElsewhere(lane) {
    const record = lane.acceptedElsewhere;
    if (!record) return;
    lane.acceptedElsewhere = null;
    const stamp = safeNow(now);
    const accepted = record.kind !== 'rejected';
    tombstoneCode(tombstones, record.code, accepted ? 'accepted' : 'rotated', { laneOrd: lane.ord, at: stamp }, CONSTANTS.TOMBSTONES_PER_ENGINE, codeGuard);
    const key = codeGuard.key(record.code);
    if (codeIndex.get(key)?.lane === lane) codeIndex.delete(key);
    if (record.nextCode) rememberIssuedCode(lane, record.nextCode, codeGuard);
    if (accepted) {
      lane.answeredAt = stamp;
      lane.awaitingAnswer = false;
      lane.servedAt = null;
    }
    lane.retained = null;
    lane.snapshot = null;
    if (isHeldPhase(lane)) lane.heldFrom = 'unread';
    else if (lane.phase === 'awaiting') lane.needsRefresh = true;
    touchLane(lane);
  }

  // Puts a lane a failed save had taken out back, in ordinal order, but never
  // when the job already has a lane again (a keep-alive release ran meanwhile).
  function reinstateLane(lane, expectedRevision = null) {
    if (expectedRevision !== null && laneRevision(lane) !== expectedRevision) return false;
    if (lanes.includes(lane) || lanes.some(item => item.jobId === lane.jobId)) return false;
    // Ordinals are never rewound, but a reinstated lane must never sit at or
    // above the counter, or the next release would hand out its ordinal again.
    laneOrdinal = Math.max(laneOrdinal, lane.ord);
    const at = lanes.findIndex(item => item.ord > lane.ord);
    lanes.splice(at < 0 ? lanes.length : at, 0, lane);
    touchLane(lane);
    return true;
  }

  async function applyReadResult(lane, raw, { fromStatus = false, recoveryStage = null, generation = sourceGeneration, expectedRevision = null } = {}) {
    // A result that lands after its lane was removed (Unrelease, discard, a
    // proven-gone drop) must not touch it: adopting the handoff would index the
    // served code again for a lane that no longer exists.
    if (!sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
    const result = normalizeSourceResult(raw);
    if (expectedRevision !== null && laneRevision(lane) !== expectedRevision && !isHeldPhase(lane)) return { kind: 'retry' };
    if (result.kind === 'threw' && result.code === 'ENOENT' && !fromStatus) {
      return statusLane(lane, { readAfterAwaiting: false, generation });
    }
    const staged = await mutateLanes(() => {
      if (!sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
      if (isHeldPhase(lane)) { keepHoldOverResult(lane); touchLane(lane); return { result }; }
      if (expectedRevision !== null && laneRevision(lane) !== expectedRevision) return { kind: 'retry' };
      const stamp = safeNow(now);
      let persist = false;
      if (result.kind === 'open') {
        const code = result.handoff?.code ?? result.handoff?.handoffCode;
        const sameRecoveryStage = typeof recoveryStage === 'string' && result.handoff?.stage === recoveryStage;
        if (lane.phase === 'awaiting' && isHumanAdvance(lane, code, codeGuard) && !sameRecoveryStage) {
          holdLane(lane, 'human_advance', stamp);
          // The prompt this lane holds is retired: Resume must re-read and adopt
          // the app's current code, not come back awaiting the stale one.
          keepHoldOverResult(lane);
          persist = true;
        } else {
          adoptCurrent(lane, result.handoff);
          lane.counters.errStreak = 0;
        }
      } else if (result.kind === 'host') {
        setPhase(lane, 'host', stamp);
        lane.reason = null;
        lane.hostSince ??= stamp;
        lane.snapshot = { at: stamp, kind: 'host' };
        lane.counters.errStreak = 0;
      } else if (result.kind === 'done') {
        setPhase(lane, 'done', stamp);
        lane.reason = null;
        lane.snapshot = { at: stamp, kind: 'done' };
        clearLaneHint(lane);
        persist = true;
      } else if (result.kind === 'gone') {
        setPhase(lane, 'gone', stamp);
        lane.reason = null;
        lane.snapshot = { at: stamp, kind: 'gone' };
        clearLaneHint(lane);
        // A vanished bundle can never be answered, so it must not keep one of
        // the chat's job slots and starve a live job.
        epoch?.assignedLaneOrds.delete(lane.ord);
        clearLaneWorkerAssignment(lane);
        persist = true;
      } else if (result.kind === 'threw') {
        if (result.code === 'LOCAL_AI_JOB_INTEGRITY') holdLane(lane, 'job_broken', stamp);
        else if (result.code === 'ENOENT') holdLane(lane, 'canvas_unavailable', stamp);
        else if (++lane.counters.errStreak >= CONSTANTS.APPLICATION_ERROR_STREAK) holdLane(lane, 'read_failed', stamp);
        lane.snapshot = { at: stamp, kind: 'threw', code: result.code ?? 'internal_error' };
        persist = ['held', 'needs_user'].includes(lane.phase);
      }
      touchLane(lane);
      return { result, persist };
    });
    if (staged?.persist && !await persistLanes(generation)) reconcileLanes(generation);
    return sourceCurrent(generation) ? (staged?.result ?? staged) : { kind: 'retry' };
  }

  async function raceLaneCall(lane, slot, promise, generation = sourceGeneration) {
    const timedOut = Symbol('lane-call-timeout');
    const result = await raceWithBudget(promise, readWatchdogMs, timedOut);
    if (!sourceCurrent(generation)) return { kind: 'retry' };
    if (result !== timedOut) return result;
    const finished = await mutateLanes(() => {
      if (!sourceCurrent(generation)) return { kind: 'retry' };
      if (lane.inFlight[slot] !== promise) return { kind: 'retry' };
      lane.inFlight[slot] = null;
      if (!lanes.includes(lane) || laneRevision(lane) !== laneCallRevisions.get(promise)) return { kind: 'retry' };
      lane.snapshot = { at: safeNow(now), kind: 'busy' };
      touchLane(lane);
      wake();
      return { kind: 'busy' };
    });
    return finished;
  }

  async function startLaneCall(lane, slot, call, apply, generation = sourceGeneration) {
    const reserved = await mutateLanes(() => {
      if (!sourceCurrent(generation)) return { promise: Promise.resolve({ kind: 'retry' }) };
      if (lane.inFlight[slot]) return { promise: lane.inFlight[slot] };
      const revision = laneRevision(lane);
      let promise;
      promise = Promise.resolve()
        .then(() => sourceCurrent(generation) ? call() : { kind: 'retry' })
        .then(result => sourceCurrent(generation) ? apply(result, revision) : { kind: 'retry' })
        .catch(error => sourceCurrent(generation)
          ? apply({ kind: 'threw', code: typeof error?.code === 'string' ? error.code : 'internal_error' }, revision)
          : { kind: 'retry' })
        .finally(() => {
          void mutateLanes(() => {
            if (sourceCurrent(generation) && lane.inFlight[slot] === promise) lane.inFlight[slot] = null;
          });
        });
      lane.inFlight[slot] = promise;
      laneCallRevisions.set(promise, revision);
      return { promise };
    });
    return reserved;
  }

  async function readLane(lane, { recoveryStage = null, generation = sourceGeneration } = {}) {
    if (!scope.applications || !sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
    const { promise } = await startLaneCall(
      lane,
      'read',
      () => application.read({ jobId: lane.jobId, canvasFilePath: lane.canvasFilePath }),
      (result, revision) => sourceCurrent(generation)
        ? applyReadResult(lane, result, { recoveryStage, generation, expectedRevision: revision })
        : { kind: 'retry' },
      generation,
    );
    return raceLaneCall(lane, 'read', promise, generation);
  }

  async function applyStatusResult(lane, raw, { readAfterAwaiting = true, generation = sourceGeneration, expectedRevision = null } = {}) {
    if (!sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
    const result = normalizeSourceResult(raw);
    if (isHeldPhase(lane)) {
      return mutateLanes(() => {
        if (!sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
        keepHoldOverResult(lane);
        touchLane(lane);
        return result;
      });
    }
    if (expectedRevision !== null && laneRevision(lane) !== expectedRevision) return { kind: 'retry' };
    if (result.kind === 'open' || result.kind === 'host' || result.kind === 'done' || result.kind === 'gone' || result.kind === 'threw') {
      await applyReadResult(lane, result, { fromStatus: true, generation, expectedRevision });
      if (!sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
      if (result.read === true) return readLane(lane, { generation });
      return result;
    }
    if (result.kind === 'awaiting') {
      const staged = await mutateLanes(() => {
        if (!sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
        if (isHeldPhase(lane)) { keepHoldOverResult(lane); touchLane(lane); return { held: true, result }; }
        if (expectedRevision !== null && laneRevision(lane) !== expectedRevision) return { kind: 'retry' };
        setPhase(lane, 'unread');
        lane.snapshot = null;
        touchLane(lane);
        return { result };
      });
      if (staged?.kind === 'retry') return staged;
      if (staged?.held) return result;
      return readAfterAwaiting ? readLane(lane, { generation }) : result;
    }
    if (result.kind === 'needs_user') {
      const staged = await mutateLanes(() => {
        if (!sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
        if (isHeldPhase(lane)) { keepHoldOverResult(lane); touchLane(lane); return { result }; }
        if (expectedRevision !== null && laneRevision(lane) !== expectedRevision) return { kind: 'retry' };
        holdLane(lane, result.reason || 'read_failed', safeNow(now));
        touchLane(lane);
        return { persist: true };
      });
      if (staged?.persist && !await persistLanes(generation)) reconcileLanes(generation);
      return sourceCurrent(generation) ? result : { kind: 'retry' };
    }
    return result;
  }

  async function statusLane(lane, { readAfterAwaiting = true, generation = sourceGeneration } = {}) {
    if (!scope.applications || !sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
    const { promise } = await startLaneCall(
      lane,
      'status',
      () => application.status({ jobId: lane.jobId, canvasFilePath: lane.canvasFilePath }),
      (result, revision) => sourceCurrent(generation)
        ? applyStatusResult(lane, result, { readAfterAwaiting, generation, expectedRevision: revision })
        : { kind: 'retry' },
      generation,
    );
    return raceLaneCall(lane, 'status', promise, generation);
  }

  function canAssign(lane, worker = epoch) {
    if (!epoch || !worker || (lane.servedWorkerId && lane.servedWorkerId !== worker.id)
      // A pending source-proof reservation is never shareable. Duplicate GETs
      // attach at the worker boundary; distinct workers choose another lane.
      || lane.pendingWorkerId) return false;
    if (worker.assignedLaneOrds.has(lane.ord)) return true;
    // A manually started pool promises that each worker keeps pulling later
    // handoffs. Keep the per-worker byte ceilings and the lane ownership fence,
    // but do not apply the legacy two-job single-chat cap to a pool worker.
    // A non-pool chat retains that conservative context-management limit.
    return (epoch.poolStarted === true || worker.assignedLaneOrds.size < limits.jobsPerChat)
      && !atSoftByteBudget(worker);
  }

  function chooseApplicationContinuation(worker = epoch) {
    if (!epoch || !worker) return null;
    const focus = lanes.find(lane => lane.ord === worker.focusLaneOrd && lane.phase === 'awaiting' && !lane.needsRefresh && canAssign(lane, worker));
    if (focus) return focus;
    const outstanding = lanes.find(lane => lane.phase === 'awaiting' && !lane.needsRefresh && lane.servedAt != null && canAssign(lane, worker));
    if (outstanding) return outstanding;
    // A correction is an application continuation even after a chat rotation;
    // it must never be displaced by an unrelated scoring handoff.
    return [...lanes]
      .filter(lane => lane.phase === 'awaiting' && !lane.needsRefresh && lane.current?.corrections?.length && canAssign(lane, worker))
      .sort((a, b) => a.releasedAt - b.releasedAt || a.ord - b.ord)[0] ?? null;
  }

  function chooseFreshApplication(worker = epoch) {
    if (!epoch || !worker) return null;
    return [...lanes]
      .filter(lane => lane.phase === 'awaiting' && !lane.needsRefresh && canAssign(lane, worker))
      .sort((a, b) => a.releasedAt - b.releasedAt || a.ord - b.ord)[0] ?? null;
  }

  function combinedRemaining(pushRemaining = null) {
    const applicationRemaining = remainingCounts(lanes);
    return {
      ready: applicationRemaining.ready + Number(pushRemaining?.ready || 0),
      working: applicationRemaining.working + Number(pushRemaining?.working || 0),
      needsYou: applicationRemaining.needsYou + Number(pushRemaining?.needsYou || 0),
    };
  }

  // A served push item's task decides which consent boundary applies:
  // marketplace tasks need scope.marketplace, everything else (job-scoring
  // and the rest of the release_one table) still needs scope.scoring. Both
  // families share one push channel/source, so this per-task check is the
  // only place that can actually keep a marketplace task inert while its
  // scope is off.
  function pushTaskInScope(task) {
    return MARKETPLACE_PUSH_TASKS.has(task) ? scope.marketplace : scope.scoring;
  }

  function framePushGet(raw, generation = sourceGeneration, expectedEpoch = epoch, worker = expectedEpoch) {
    if ((!scope.scoring && !scope.marketplace) || !epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
    const decision = raw && typeof raw === 'object' ? raw : { status: 'retry' };
    const remaining = combinedRemaining(decision.remaining);
    if (decision.status === 'served') {
      if (!pushTaskInScope(decision.task)) {
        // The task was actually served by the push source (it is already
        // marked served there), but this consent scope is off. Hold rather
        // than leak served content: never expose the prompt to the client.
        return makeResultBody('held', { reason: 'scope_disabled', remaining });
      }
      if (!worker || atHardByteBudget(worker)) {
        return makeResultBody('session_full', { remaining });
      }
      const body = {
        status: 'served',
        handoffCode: typeof decision.handoffCode === 'string' ? decision.handoffCode : '',
        kind: 'push',
        stage: null,
        task: typeof decision.task === 'string' ? decision.task : null,
        batch: Number.isFinite(decision.batch) ? decision.batch : null,
        batchTotal: Number.isFinite(decision.batchTotal) ? decision.batchTotal : null,
        attempt: Number.isInteger(decision.attempt) ? decision.attempt : 1,
        responseFormat: decision.responseFormat === 'text' ? 'text' : 'json',
        instructions: pushInstructionsFor(decision.responseFormat),
        prompt: typeof decision.prompt === 'string' ? decision.prompt : '',
        correction: typeof decision.correction === 'string' ? decision.correction : '',
        remaining,
      };
      if (decision.correctionOnly !== true && typeof decision.note === 'string') {
        body.note = decision.note;
      }
      const stamp = safeNow(now);
      // The push adapter returns a private, once-per-request prompt charge.
      // Do not charge a ChatGPT retry again: re-serving is intentionally
      // idempotent and can happen several times while a run is settling.
      const promptBytes = Number(decision.promptBytes);
      worker.bytesServed += Number.isFinite(promptBytes) && promptBytes >= 0
        ? Math.floor(promptBytes)
        : Buffer.byteLength(JSON.stringify(body), 'utf8');
      worker.lastGetAt = stamp;
      worker.idleSince = null;
      worker.waitingSince = null;
      worker.activeTask = true;
      worker.activeTaskKind = 'push';
      worker.activeTaskSince = stamp;
      counts.getServed++;
      worker.consecutiveWaits = 0; // work was served, so the wait streak is broken
      auditEvent('served', { tool: 'get_handoff', outcome: 'ok', stage: 'push' });
      return body;
    }
    if (decision.status === 'needs_user') return makeResultBody('needs_user', { reason: 'app_only_handoffs', remaining });
    if (decision.status === 'waiting') {
      markWorkerWaiting(worker);
      return makeResultBody('waiting', {
        retryAfterSeconds: workerRetryAfterSeconds(expectedEpoch, worker, 3),
        remaining,
      });
    }
    if (decision.status === 'queue_empty') return makeResultBody('queue_empty', { remaining });
    return makeResultBody('retry');
  }

  async function readPush(generation = sourceGeneration, expectedEpoch = epoch, worker = expectedEpoch) {
    // Either consent alone is enough to poll: the shared push source can hold
    // a mix of scoring and marketplace tasks, and framePushGet applies the
    // exact per-task scope once the served task is known.
    if ((!scope.scoring && !scope.marketplace) || !push) return { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } };
    if (!expectedEpoch || !epochCurrent(expectedEpoch, generation)) return { status: 'retry' };
    const expectedEpochId = pushEpochId(expectedEpoch);
    try {
      // Match the application-call fence: this yield creates a final,
      // observable generation boundary before entering an external source.
      // A synchronous Disable/resume/scope downgrade therefore cannot launch
      // a new push poll from an already obsolete GET continuation.
      await Promise.resolve();
      if ((!scope.scoring && !scope.marketplace) || !epochCurrent(expectedEpoch, generation)) return { status: 'retry' };
      const result = await push.get({
        epoch: expectedEpochId,
        owner: pushOwner,
        worker: worker?.id,
        keepWaiting: expectedEpoch?.poolStarted === true,
      });
      if (epochCurrent(expectedEpoch, generation)) return result;
      // `push.get` owns per-epoch bookkeeping.  It can finish after Close or
      // rotation, so make the old id disposable even if its late completion
      // recreated source-local state.
      try { push.closeEpoch?.(expectedEpochId); } catch { /* stale state is best-effort */ }
      return { status: 'retry' };
    }
    catch { return { status: 'retry' }; }
  }

  async function refreshOneLane(generation = sourceGeneration) {
    if (!scope.applications || !sourceCurrent(generation)) return { kind: 'retry' };
    const target = await mutateLanes(() => {
      if (!scope.applications || !sourceCurrent(generation)) return null;
      const invalidated = [...lanes]
        .filter(lane => lane.phase === 'awaiting' && lane.needsRefresh === true)
        .sort((a, b) => a.releasedAt - b.releasedAt || a.ord - b.ord)[0];
      if (invalidated) {
        // Let an older read finish as retry before consuming this refresh flag;
        // otherwise attaching to it would clear the fence and let it adopt its
        // stale result.
        if (invalidated.inFlight.read) return { action: 'read', lane: invalidated };
        invalidated.needsRefresh = false;
        touchLane(invalidated);
        return { action: 'read', lane: invalidated };
      }
      const unread = [...lanes].filter(lane => lane.phase === 'unread').sort((a, b) => a.releasedAt - b.releasedAt || a.ord - b.ord)[0];
      if (unread) return { action: 'read', lane: unread };
      const stamp = safeNow(now);
      const host = [...lanes]
        .filter(lane => lane.phase === 'host'
          && (!lane.snapshot || stamp - lane.snapshot.at >= CONSTANTS.HOST_POLL_MS))
        .sort((a, b) => (a.hostSince ?? 0) - (b.hostSince ?? 0))[0];
      if (host) {
        if (host.hostSince && stamp - host.hostSince >= CONSTANTS.HOST_SILENT_MS) {
          holdLane(host, 'host_silent', stamp);
          touchLane(host);
          return { action: 'needs_user', persist: true };
        }
        return { action: 'status', lane: host };
      }
      return null;
    });
    if (!target) return null;
    if (target.persist && !await persistLanes(generation)) reconcileLanes(generation);
    if (!sourceCurrent(generation)) return { kind: 'retry' };
    if (target.action === 'read') return readLane(target.lane, { generation });
    if (target.action === 'status') return statusLane(target.lane, { generation });
    if (target.action === 'needs_user') return { kind: 'needs_user' };
    return { kind: 'retry' };
  }

  // Core serve logic that runs inside a queued mutation. Factored out so
  // mapSubmitResult can call it directly (it already owns a queued operation).
  function serveLaneOp(lane, generation, expectedEpoch, worker = expectedEpoch, claimId = null) {
    if (!scope.applications || !epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
    // Nothing between choosing a lane and serving it may have changed it: the
    // serve-time probe is asynchronous, so a lane can be answered, dropped or
    // held while it runs. A lane in any of those states is never served.
    if (!worker || !lanes.includes(lane) || lane.pendingWorkerId && lane.pendingWorkerId !== claimId
      || lane.phase !== 'awaiting' || !lane.current || lane.needsRefresh) return makeResultBody('retry');
    if (claimId && lane.pendingWorkerId === claimId) lane.pendingWorkerId = null;
    if (!canAssign(lane, worker)) return makeResultBody('retry');
    if (atHardByteBudget(worker)) {
      return makeResultBody('session_full', { remaining: combinedRemaining() });
    }
    const marker = worker.servedPrompt.get(lane.ord);
    const servedBefore = marker?.stage === lane.current.stage
      && codeGuard.sameDigest(marker?.codeDigest, codeGuard.digest(lane.current.code));
    lane.current.attempt = (lane.counters.attemptByStage[`${lane.current.stage}@${lane.current.revision}`] ?? 0) + 1;
    lane.counters.attemptByStage[`${lane.current.stage}@${lane.current.revision}`] = lane.current.attempt;
    const body = makeServedBody({ lane, remaining: remainingCounts(lanes), servedBefore });
    const stamp = safeNow(now);
    const servedBeforeInThisChat = lane.servedEpochN === expectedEpoch.n;
    lane.servedAt = stamp;
    lane.awaitingAnswer = true;
    lane.servedEpochN = expectedEpoch.n;
    lane.servedWorkerId = worker.id;
    lane.serves++;
    // The same handoff code going out again (not a new stage after an accepted
    // answer) is what `servedTwice` reports.
    const servedDigest = codeGuard.digest(lane.current.code);
    // Only a repeat inside ONE chat is two-chats-on-one-code evidence: a rotation
    // revoked the old chat, and a hold (which clears the digest) ended the wait.
    lane.servedCodeAgain = servedBeforeInThisChat && codeGuard.sameDigest(lane.lastServedDigest, servedDigest);
    lane.lastServedDigest = servedDigest;
    touchLane(lane);
    worker.servedPrompt.set(lane.ord, { stage: lane.current.stage, codeDigest: codeGuard.digest(lane.current.code) });
    expectedEpoch.assignedLaneOrds.add(lane.ord);
    worker.assignedLaneOrds.add(lane.ord);
    worker.focusLaneOrd = lane.ord;
    worker.idleSince = null;
    worker.waitingSince = null;
    worker.activeTask = true;
    worker.activeTaskKind = 'application';
    worker.activeTaskSince = stamp;
    worker.lastGetAt = stamp;
    worker.bytesServed += Buffer.byteLength(JSON.stringify(body), 'utf8');
    counts.getServed++;
    worker.consecutiveWaits = 0; // work was served, so the wait streak is broken
    auditEvent('served', { tool: 'get_handoff', outcome: 'ok', stage: lane.current.stage });
    const idleNoticeMs = CONSTANTS.SERVE_AFTER_IDLE_NOTICE_HOURS * 3_600_000;
    if (stamp - lastHumanActionAt >= idleNoticeMs && stamp - lastIdleNoticeAt >= 3_600_000) {
      lastIdleNoticeAt = stamp;
      try { onServeAfterIdle({ hours: Math.floor((stamp - lastHumanActionAt) / 3_600_000) }); } catch { /* contained */ }
    }
    return body;
  }

  function serveLane(lane, generation = sourceGeneration, expectedEpoch = epoch, worker = expectedEpoch, claimId = null) {
    return mutateLanes(() => serveLaneOp(lane, generation, expectedEpoch, worker, claimId));
  }

  // ---- Per-job answer tracking and stall detection -------------------------
  // A lane is "awaiting an answer" only when its current prompt was served to
  // THIS chat and no accepted submit (or replacement handoff) has come since.
  // Every input is engine-owned state; nothing here reads a source.
  function laneAwaitingAnswer(lane, worker = null) {
    return Boolean(epoch) && lane.phase === 'awaiting' && lane.awaitingAnswer === true
      && lane.servedEpochN === epoch.n && (!worker || lane.servedWorkerId === worker.id)
      && Number.isFinite(lane.servedAt) && Boolean(lane.current);
  }

  // Silence is ambiguity, not proof of failure. It becomes a renderer warning
  // only when the owning worker has crossed the same explicit-recovery gate.
  function laneStall(lane, stamp = safeNow(now)) {
    if (!laneAwaitingAnswer(lane)) return null;
    const worker = workerForId(epoch, lane.servedWorkerId);
    if (workerQuietReason(worker, stamp) !== 'answer_silent') return null;
    const anchor = Math.max(
      Number.isFinite(lane.servedAt) ? lane.servedAt : 0,
      Number.isFinite(worker?.activeTaskSince) ? worker.activeTaskSince : 0,
      Number.isFinite(worker?.lastCallAt) ? worker.lastCallAt : 0,
    );
    return { anchor, since: anchor };
  }

  // Distinct stalls (a lane + the quiet period's anchor) seen in the last hour.
  const stallLog = new Map();
  function noteStalls(stamp) {
    const current = new Set();
    for (const lane of lanes) {
      const stall = laneStall(lane, stamp);
      if (!stall) continue;
      const key = `${lane.ord}:${stall.anchor}`;
      current.add(key);
      if (!stallLog.has(key)) stallLog.set(key, stall.since);
    }
    for (const [key, since] of stallLog) if (!current.has(key) && stamp - since > 3_600_000) stallLog.delete(key);
    return stallLog.size;
  }

  // ---- Proof that a bundle is gone -----------------------------------------
  // One status probe through the application source. ONLY a proven-gone answer
  // counts ('failed' with no folder, or a discarded/pruned/saved tombstone,
  // which the source maps to gone / done); a thrown error, a timeout or an
  // unrecognisable answer proves nothing and returns null.
  // `includeSaved` also accepts the saved tombstone. `mapApplicationStatus`
  // answers 'done' ONLY for a saved job (a finished build is 'host'), so for a
  // lane that is being served or restored, 'done' can only mean the job was
  // saved elsewhere and its private folder is gone.
  // `ran` is false when no probe was attempted at all (scope off, or the source
  // was replaced), so a caller never spends a retry on a probe that did not
  // happen. `alive` is a conclusive answer that the bundle still exists.
  async function probeBundle(lane, generation = sourceGeneration, { includeSaved = false } = {}) {
    if (!scope.applications || !sourceCurrent(generation)) return { cause: null, alive: false, ran: false };
    const target = { jobId: lane.jobId, canvasFilePath: lane.canvasFilePath };
    const timedOut = Symbol('bundle-probe-timeout');
    let raw;
    try {
      raw = await raceWithBudget(
        Promise.resolve().then(() => application.status(target)),
        readWatchdogMs,
        timedOut,
      );
    } catch { return { cause: null, alive: false, ran: true }; }
    if (raw === timedOut || !sourceCurrent(generation)) return { cause: null, alive: false, ran: true };
    const result = normalizeSourceResult(raw);
    if (result.kind === 'gone') return { cause: 'bundle_missing', alive: false, ran: true };
    if (includeSaved && result.kind === 'done') return { cause: 'bundle_saved', alive: false, ran: true };
    return { cause: null, alive: ['awaiting', 'host', 'needs_user', 'open'].includes(result.kind), ran: true };
  }

  async function proveBundleGone(lane, generation = sourceGeneration, options = {}) {
    return (await probeBundle(lane, generation, options)).cause;
  }

  // Drops a lane whose bundle is proven gone. If the durable write refuses, the
  // lane still must not be served, so it is ended in memory (terminal lanes are
  // never persisted and are pruned after an hour).
  async function dropProvenGoneLane(lane, cause, generation, expectedRevision = null) {
    if (!lanes.includes(lane) || (expectedRevision !== null && laneRevision(lane) !== expectedRevision)) return false;
    const removed = await removeLane(lane.jobId, cause, { expectedLane: lane, expectedRevision });
    if (removed.ok) return true;
    if (!sourceCurrent(generation)) return false;
    const fallbackRevision = Number.isInteger(removed.revision) ? removed.revision : expectedRevision;
    const finished = await mutateLanes(() => {
      if (lanes.includes(lane) && (fallbackRevision === null || laneRevision(lane) === fallbackRevision)
          && !['done', 'gone'].includes(lane.phase)) {
        setPhase(lane, 'gone');
        lane.reason = null;
        lane.snapshot = { at: safeNow(now), kind: 'gone' };
        epoch?.assignedLaneOrds.delete(lane.ord);
        clearLaneWorkerAssignment(lane);
        touchLane(lane);
      }
      return true;
    });
    return finished;
  }

  // Stranded lanes: restored from a lanes.json written before their bundle was
  // discarded, pruned, saved elsewhere or deleted by hand while the bridge was
  // off. They would sit as held/restart ("needs you") and hold a slot until a
  // chat read them. Each restored lane is probed; only proof drops it, and one
  // that could not be checked is retried on later ticks a bounded number of
  // times (serve-time revalidation still covers it after that).
  const RESTORE_PROBE_ATTEMPTS = 5;
  // After the fast attempts a lane that still could not be checked is retried
  // at this slow cadence, so a probe that failed five times in a row does not
  // leave a really-gone lane counted as "needs you" until the person acts.
  const RESTORE_REPROBE_MS = 5 * 60_000;
  // `restoreProbes` is null once a probe answered conclusively (gone or alive).
  function restoreProbeDue(lane, stamp) {
    return scope.applications && Number.isInteger(lane.restoreProbes)
      && ['held', 'needs_user'].includes(lane.phase)
      && !(Number.isFinite(lane.restoreProbeAt) && lane.restoreProbeAt > stamp);
  }
  let restoreProbe = null;
  let restoreProbeRequest = 0;
  async function probeRestoredLanes(generation = sourceGeneration, { rescan = false } = {}) {
    if (rescan) restoreProbeRequest += 1;
    if (restoreProbe) return restoreProbe;
    restoreProbe = (async () => {
      try {
        let passRequest = 0;
        const processed = new WeakMap();
        do {
          passRequest = restoreProbeRequest;
          for (const lane of [...lanes]) {
            if (!sourceCurrent(generation)) return;
            const claim = await mutateLanes(() => {
              if (!lanes.includes(lane) || !restoreProbeDue(lane, safeNow(now))) return null;
              if (processed.get(lane) === laneRevision(lane)) return null;
              return { lane, revision: laneRevision(lane) };
            });
            if (!claim) continue;
            processed.set(lane, claim.revision);
            const outcome = await probeBundle(lane, generation, { includeSaved: true });
            if (!sourceCurrent(generation)) return;
            if (outcome.cause) {
              await dropProvenGoneLane(lane, outcome.cause, generation, claim.revision);
              await mutateLanes(() => {
                if (!sourceCurrent(generation) || !lanes.includes(lane) || laneRevision(lane) !== claim.revision
                    || !restoreProbeDue(lane, safeNow(now))) return;
                lane.restoreProbes = null;
              });
              continue;
            }
            if (outcome.alive) {
              await mutateLanes(() => {
                if (!sourceCurrent(generation) || !lanes.includes(lane) || laneRevision(lane) !== claim.revision
                    || !restoreProbeDue(lane, safeNow(now))) return;
                lane.restoreProbes = null;
              });
              continue;
            }
            if (!outcome.ran) continue;
            await mutateLanes(() => {
              if (!sourceCurrent(generation) || !lanes.includes(lane) || laneRevision(lane) !== claim.revision
                  || !restoreProbeDue(lane, safeNow(now))) return;
              if (lane.restoreProbes > 0) lane.restoreProbes -= 1;
              if (lane.restoreProbes === 0) lane.restoreProbeAt = safeNow(now) + RESTORE_REPROBE_MS;
            });
          }
        } while (sourceCurrent(generation) && restoreProbeRequest > passRequest);
      } finally { restoreProbe = null; }
    })();
    return restoreProbe;
  }

  // The lane to serve, after confirming its bundle still exists. A lane whose
  // bundle is proven gone is dropped and the NEXT candidate is tried, so the
  // chat is served the next job or an honest empty answer, never a prompt for a
  // job that can no longer be answered. Returns { retry: true } if the world
  // changed under the probe.
  async function pickVerifiedLane(choose, generation, expectedEpoch, worker = expectedEpoch, claimId = null) {
    // The reservation belongs to one GET, rather than to a whole worker. A
    // worker can have two transport requests in flight, and they must attach to
    // that one GET instead of both being allowed through a worker-scoped claim.
    if (typeof claimId !== 'string' || !claimId) return { retry: true };
    for (let attempt = 0; attempt <= CONSTANTS.MAX_LANES; attempt += 1) {
      const lane = choose(worker);
      if (!lane) return null;
      const claim = await mutateLanes(() => {
        if (!epochCurrent(expectedEpoch, generation) || !lanes.includes(lane) || !canAssign(lane, worker)) return null;
        lane.pendingWorkerId = claimId;
        return { lane, revision: laneRevision(lane) };
      });
      if (!claim) return { retry: true };
      const releaseClaim = async () => {
        await mutateLanes(() => {
          if (lane.pendingWorkerId === claimId) lane.pendingWorkerId = null;
        });
      };
      const cause = await proveBundleGone(lane, generation, { includeSaved: true });
      if (!epochCurrent(expectedEpoch, generation)) {
        await releaseClaim();
        return { retry: true };
      }
      if (!lanes.includes(lane) || laneRevision(lane) !== claim.revision) {
        await releaseClaim();
        continue;
      }
      if (!cause) {
        // The probe was asynchronous: the lane may have been answered, dropped,
        // held or refreshed meanwhile. Only a lane that is still servable goes
        // out; otherwise choose again.
        if (lanes.includes(lane) && lane.phase === 'awaiting' && lane.current && !lane.needsRefresh
          && lane.pendingWorkerId === claimId) return lane;
        await releaseClaim();
        continue;
      }
      await releaseClaim();
      await dropProvenGoneLane(lane, cause, generation, claim.revision);
      if (!epochCurrent(expectedEpoch, generation)) return { retry: true };
    }
    return null;
  }

  function terminalDrain(remaining = null) {
    const applicationsDrained = lanes.length === 0 || lanes.every(lane => ['done', 'gone'].includes(lane.phase));
    if (!applicationsDrained) return false;
    // A pool worker can observe an empty local pull while another worker's
    // push handoff is still settling. Do not retire the shared epoch until the
    // source's own aggregate says that no ready, working, or held work remains.
    // Older source seams omit `remaining`, in which case retain the historic
    // application-only behavior rather than treating missing metadata as work.
    if (!remaining || typeof remaining !== 'object') return true;
    return !['ready', 'working', 'needsYou'].some(key => Number(remaining[key]) > 0);
  }

  // A source can end or remove a push handoff while a worker still owns it.
  // Preserve that distinction in the retired-pool receipt rather than calling
  // the pool naturally drained. This must run before markChatStopped(), which
  // clears the ownership evidence for the worker that observed queue_empty.
  function terminalPoolCloseReason(expectedEpoch) {
    if (!(scope.scoring || scope.marketplace) || !expectedEpoch || epoch !== expectedEpoch) return 'drained';
    return epochWorkers(expectedEpoch).some(candidate => candidate.activeTask === true && candidate.activeTaskKind === 'push')
      ? 'source_ended'
      : 'drained';
  }

  async function pruneTerminalLanes(stamp = safeNow(now), generation = sourceGeneration) {
    const staged = await mutateLanes(() => {
      if (!sourceCurrent(generation)) return false;
      const cutoff = stamp - 60 * 60_000;
      const expired = lanes.filter(lane => ['done', 'gone'].includes(lane.phase)
        && Number.isFinite(lane.snapshot?.at) && lane.snapshot.at <= cutoff);
      if (expired.length === 0) return false;
      const removed = new Set(expired);
      const priorCodes = [...codeIndex.entries()];
      lanes.splice(0, lanes.length, ...lanes.filter(lane => !removed.has(lane)));
      for (const lane of expired) {
        clearLaneHint(lane);
        touchLane(lane);
      }
      for (const [codeKey, entry] of codeIndex) if (removed.has(entry?.lane)) codeIndex.delete(codeKey);
      return { expired, priorCodes, revisions: new Map(expired.map(lane => [lane, laneRevision(lane)])), persist: true };
    });
    if (!staged?.persist) return staged;
    const saved = await persistLanes(generation);
    const finished = await mutateLanes(() => {
      if (!saved && sourceCurrent(generation)) {
        // Put back only the lanes this prune took out. Restoring a snapshot of the
        // whole array would erase every lane a release added while the save ran.
        for (const lane of staged.expired) {
          if (!reinstateLane(lane, staged.revisions.get(lane))) continue;
          for (const [codeKey, entry] of staged.priorCodes) if (entry?.lane === lane && !codeIndex.has(codeKey)) codeIndex.set(codeKey, entry);
        }
        return false;
      }
      return saved;
    });
    if (!saved) reconcileLanes(generation);
    return finished;
  }

  async function tick(stamp = safeNow(now)) {
    if (closed) return false;
    checkIdlePause();
    // Never awaited: a slow probe must not delay the request that ticked.
    const at = Number.isFinite(stamp) ? stamp : safeNow(now);
    if (lanes.some(lane => restoreProbeDue(lane, at))) void probeRestoredLanes().catch(() => undefined);
    await pruneTerminalLanes(at);
    noteStalls(at);
    return !closed;
  }

  async function getAuthenticated(args, { expectedEpoch, worker, generation, claimId }) {
    const resumedDuringGet = () => !epochCurrent(expectedEpoch, generation);

    // A hinted host lane is re-probed here, before a push item is served, so its
    // continuation is not passed over. (A stale flag on a finished lane is inert.)
    if (scope.applications && lanes.some(item => item.needsRefresh === true && !['done', 'gone'].includes(item.phase))) {
      const refreshed = await refreshOneLane(generation);
      if (resumedDuringGet() || refreshed?.kind === 'retry') return makeResultBody('retry');
    }
    let lane = scope.applications ? await pickVerifiedLane(chooseApplicationContinuation, generation, expectedEpoch, worker, claimId) : null;
    if (lane?.retry) return makeResultBody('retry');
    if (lane) return serveLane(lane, generation, expectedEpoch, worker, claimId);

    // Push handoffs (scoring and marketplace) are preferred only at
    // application job boundaries. A focused, outstanding, or correction
    // application lane has already won.
    let pushDecision = (scope.scoring || scope.marketplace)
      ? await readPush(generation, expectedEpoch, worker)
      : { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } };
    if (resumedDuringGet()) return makeResultBody('retry');
    if ((scope.scoring || scope.marketplace) && pushDecision?.status === 'served') return framePushGet(pushDecision, generation, expectedEpoch, worker);

    // A lazy read can reveal a correction or a newly-open continuation after
    // the push poll; give it another chance before starting fresh work.
    const refreshed = scope.applications ? await refreshOneLane(generation) : null;
    if (resumedDuringGet() || refreshed?.kind === 'retry') return makeResultBody('retry');
    lane = scope.applications ? await pickVerifiedLane(chooseApplicationContinuation, generation, expectedEpoch, worker, claimId) : null;
    if (lane?.retry) return makeResultBody('retry');
    if (lane) return serveLane(lane, generation, expectedEpoch, worker, claimId);
    lane = scope.applications ? await pickVerifiedLane(chooseFreshApplication, generation, expectedEpoch, worker, claimId) : null;
    if (lane?.retry) return makeResultBody('retry');
    if (lane) return serveLane(lane, generation, expectedEpoch, worker, claimId);

    const pushWorking = (scope.scoring || scope.marketplace) && pushDecision?.status === 'waiting';
    const pushNeedsUser = (scope.scoring || scope.marketplace) && pushDecision?.status === 'needs_user';
    const working = pushWorking || (scope.applications && lanes.some(laneBusy));
    if (working) {
      // A pool deliberately has several independent chats. Holding every one
      // of their MCP requests for GET_HOLD_MS made a completed wave look like
      // an entire stuck worker roster (and made the advertised retry false).
      // Pool workers therefore take the existing immediate refresh/drain pass
      // below without a timer. That pass is important: another worker can be
      // reading a distinct application lane at the same moment, and the
      // second worker must still be able to claim it before being told to poll.
      const wakeReason = await waitForWake(expectedEpoch?.poolStarted === true ? 0 : holdMs, args.signal);
      if (wakeReason === 'aborted' || args.signal?.aborted) return makeResultBody('retry');
      if (resumedDuringGet()) return makeResultBody('retry');
      const refreshedAfterWait = scope.applications ? await refreshOneLane(generation) : null;
      if (resumedDuringGet() || refreshedAfterWait?.kind === 'retry') return makeResultBody('retry');
      lane = scope.applications ? await pickVerifiedLane(chooseApplicationContinuation, generation, expectedEpoch, worker, claimId) : null;
      if (lane?.retry) return makeResultBody('retry');
      if (lane) return serveLane(lane, generation, expectedEpoch, worker, claimId);
      // A successor can be published during the held poll. Preserve the
      // ordering at the boundary: continuations first, then push, then a
      // fresh application lane.
      pushDecision = (scope.scoring || scope.marketplace)
        ? await readPush(generation, expectedEpoch, worker)
        : { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } };
      if (resumedDuringGet()) return makeResultBody('retry');
      if ((scope.scoring || scope.marketplace) && pushDecision?.status === 'served') return framePushGet(pushDecision, generation, expectedEpoch, worker);
      lane = scope.applications ? await pickVerifiedLane(chooseFreshApplication, generation, expectedEpoch, worker, claimId) : null;
      if (lane?.retry) return makeResultBody('retry');
      if (lane) return serveLane(lane, generation, expectedEpoch, worker, claimId);
      const stillWorking = ((scope.scoring || scope.marketplace) && pushDecision?.status === 'waiting')
        || (scope.applications && lanes.some(laneBusy));
      if (!stillWorking) {
        if (scope.applications && lanes.some(item => ['held', 'needs_user'].includes(item.phase))) {
          counts.getPaused++;
          markChatStopped(worker);
          return makeResultBody('paused', { reason: 'needs_user', remaining: combinedRemaining(pushDecision?.remaining) });
        }
        if (scope.applications && lanes.some(item => item.phase === 'awaiting' && !canAssign(item, worker))) {
          return makeResultBody('session_full', { remaining: combinedRemaining(pushDecision?.remaining) });
        }
        if ((scope.scoring || scope.marketplace) && pushDecision?.status === 'needs_user') { markChatStopped(worker); return framePushGet(pushDecision, generation, expectedEpoch, worker); }
        if (pushDecision?.status === 'retry') return makeResultBody('retry');
        counts.getEmpty++;
        const drained = (scope.scoring || scope.marketplace)
          ? framePushGet(pushDecision, generation, expectedEpoch, worker)
          : makeResultBody('queue_empty', { remaining: combinedRemaining() });
        const closeReason = drained.status === 'queue_empty' && terminalDrain(drained.remaining)
          ? terminalPoolCloseReason(expectedEpoch)
          : null;
        if (drained.status === 'queue_empty') markChatStopped(worker);
        if (closeReason) retireEpoch(closeReason);
        return drained;
      }
      worker.consecutiveWaits = Math.min(1_000_000, worker.consecutiveWaits + 1);
      // The pool path is explicitly meant to bridge future upstream waves.
      // Only legacy single-chat sessions end on the app-owned wait counter.
      // A `waiting` result is an explicit durable instruction to poll again.
      // Stopping a legacy chat after an arbitrary count contradicted that
      // contract and was the direct cause of users having to type Continue.
      // Silence after that instruction is surfaced as a quiet worker instead
      // of silently retiring or invalidating a possibly still-writing chat.
      const waitLimit = Infinity;
      if (worker.consecutiveWaits >= waitLimit) {
        counts.getPaused++;
        markChatStopped(worker);
        return makeResultBody('paused', { reason: 'waiting_limit', remaining: combinedRemaining(pushDecision?.remaining) });
      }
      counts.getWaiting++;
      markWorkerWaiting(worker);
      return makeResultBody('waiting', {
        pollCount: worker.consecutiveWaits,
        retryAfterSeconds: workerRetryAfterSeconds(expectedEpoch, worker),
        remaining: combinedRemaining(pushDecision?.remaining),
      });
    }

    if (scope.applications && lanes.some(item => ['held', 'needs_user'].includes(item.phase))) {
      counts.getPaused++;
      markChatStopped(worker);
      return makeResultBody('paused', { reason: 'needs_user', remaining: combinedRemaining(pushDecision?.remaining) });
    }
    if (scope.applications && lanes.some(item => item.phase === 'awaiting' && !canAssign(item, worker))) {
      return makeResultBody('session_full', { remaining: combinedRemaining(pushDecision?.remaining) });
    }
    if (pushNeedsUser) { markChatStopped(worker); return framePushGet(pushDecision, generation, expectedEpoch, worker); }
    if (pushDecision?.status === 'retry') return makeResultBody('retry');
    counts.getEmpty++;
    const result = (scope.scoring || scope.marketplace)
      ? framePushGet(pushDecision, generation, expectedEpoch, worker)
      : makeResultBody('queue_empty', { remaining: combinedRemaining() });
    const closeReason = result.status === 'queue_empty' && terminalDrain(result.remaining)
      ? terminalPoolCloseReason(expectedEpoch)
      : null;
    if (result.status === 'queue_empty') markChatStopped(worker);
    if (closeReason) retireEpoch(closeReason);
    return result;
  }

  async function get(args = {}) {
    const admission = gate(args);
    if (admission.body) {
      if (admission.body.status === 'paused') counts.getPaused++;
      return admission.body;
    }
    if (args.canvasOpen === false) return makeResultBody('app_unavailable');
    if (args.signal?.aborted) return makeResultBody('retry');
    const expectedEpoch = epoch;
    const worker = admission.worker;
    const callAt = safeNow(now);
    // Count each authenticated request for diagnostics, even when it attaches
    // to an existing GET. The work itself, including bytes and served counts,
    // is owned by the one in-flight operation below.
    worker.calls += 1;
    worker.starterKey = null;
    worker.firstCallAt ??= callAt;
    worker.lastCallAt = callAt;
    worker.lastCallKind = 'get';
    // A real poll proves this chat still has a usable composer/session, but a
    // prior `waiting` result remains the roster state until this poll either
    // receives work or returns its next terminal/wait instruction.
    const generation = sourceGeneration;
    const stamp = safeNow(now);
    if (worker.lastGetAt != null && stamp - worker.lastGetAt >= CONSTANTS.WAIT_COUNTER_RESET_IDLE_MS) worker.consecutiveWaits = 0;
    worker.lastGetAt = stamp;

    // Same-chat duplicate GETs are retries, not a request to claim a second
    // application lane. Attach them before any source proof begins so every
    // caller receives the exact one result and one serve mutation is charged.
    const existing = worker.getInFlight;
    if (existing?.epoch === expectedEpoch && existing.generation === generation && existing.promise) return existing.promise;
    if (atHardByteBudget(worker)) return makeResultBody('session_full');

    // `worker.id` repeats across pools, but the epoch and monotonic sequence
    // make this memory-only reservation unique across every stale async path.
    const claimId = `${expectedEpoch.n}:${worker.id}:${++getClaimOrdinal}`;
    const flight = { epoch: expectedEpoch, generation, claimId, promise: null };
    worker.getInFlight = flight;
    const operation = getAuthenticated(args, { expectedEpoch, worker, generation, claimId });
    flight.promise = operation;
    try {
      const result = await operation;
      // A pool is allowed to grow only after a real authenticated worker
      // interaction refreshed its source view.  This mints copyable starters
      // for newly-known work; it never opens a ChatGPT chat or shrinks a pool.
      maybeExpandWorkerPool(expectedEpoch, generation, authenticatedLinkId(args));
      recordWorkerOutcome(worker, result?.status);
      return result;
    } finally {
      // A power resume can admit a newer GET on this same worker before the
      // obsolete source call settles. Never erase that newer operation.
      if (worker.getInFlight === flight) worker.getInFlight = null;
    }
  }

  function tombstoneResult(code) {
    const digest = codeGuard.digest(code);
    const tombstone = tombstones.get(codeGuard.key(code));
    if (!tombstone || !codeGuard.sameDigest(digest, tombstone.codeDigest)) return makeResultBody('unknown_handoff');
    if (tombstone.reason === 'accepted') {
      counts.submitDuplicate++;
      return makeResultBody('duplicate');
    }
    counts.submitSuperseded++;
    return makeResultBody('superseded');
  }

  // Optional claim fields make a cap a conditional transition rather than a
  // delayed side effect of an older submit. Callers that have no source-code
  // ownership requirement retain the lifecycle behaviour they had before.
  async function persistCap(lane, reason, generation = sourceGeneration, claim = null) {
    const staged = await mutateLanes(() => {
      if (!sourceCurrent(generation) || !lanes.includes(lane)) return null;
      if (claim && (!epochCurrent(claim.expectedEpoch, generation)
          || (claim.expectedPhase != null && lane.phase !== claim.expectedPhase)
          || (claim.expectedCode != null && !codeGuard.equal(lane.current?.code, claim.expectedCode))
          || (claim.expectedRevision != null && laneRevision(lane) !== claim.expectedRevision))) return null;
      holdLane(lane, reason, safeNow(now));
      return { revision: touchLane(lane) };
    });
    if (!staged) return false;
    if (!await persistLanes(generation)) reconcileLanes(generation);
    return mutateLanes(() => {
      if (!sourceCurrent(generation)) return false;
      if (laneRevision(lane) === staged.revision) wake();
      return true;
    });
  }

  async function callApplicationSubmit(lane, code, text, generation = sourceGeneration, expectedEpoch = epoch) {
    if (!epochCurrent(expectedEpoch, generation)) return { kind: 'retry' };
    const skipped = Symbol('stale-submit');
    // Capture this during the queued admission, before the source promise can
    // run. A later re-read is allowed to rotate the code only within this same
    // stage when recovering from a thrown write.
    let submittedStage = null;
    const submitEligible = () => epochCurrent(expectedEpoch, generation) && lanes.includes(lane)
      && lane.phase === 'awaiting' && codeGuard.equal(lane.current?.code, code);
    const task = Promise.resolve().then(() => submitEligible()
      ? application.submit({ jobId: lane.jobId, canvasFilePath: lane.canvasFilePath }, { code, text })
      : skipped);
    const reserved = await mutateLanes(() => {
      if (!submitEligible()) return false;
      submittedStage = lane.current.stage;
      lane.inFlight.submit = task;
      touchLane(lane);
      return true;
    });
    if (!reserved) return { kind: 'retry' };
    const timeout = Symbol('submit-stuck');
    try {
      const settled = await raceWithBudget(
        task.then(value => ({ value }), error => ({ error })),
        CONSTANTS.SUBMIT_STUCK_MS,
        timeout,
      );
      if (settled === timeout) {
        // The app is still working. If it commits after the lane was already
        // reported stuck, that answer must not be forgotten: Resume would
        // otherwise re-serve the stage the person's chat already answered.
        void task.then(value => {
          if (value === skipped) return;
          // The lane moved to another handoff meanwhile; adoption already
          // retired this code.
          if (lane.current?.code && !codeGuard.equal(lane.current.code, code)) return;
          recordAcceptedElsewhere(lane, code, normalizeSubmitResult(value));
        }, () => undefined);
      }
      if (!epochCurrent(expectedEpoch, generation)) {
        // The chat or generation moved on, but the app may have committed the
        // answer. The fenced result is otherwise ignored, so record only that.
        if (settled !== timeout && !settled.error && settled.value !== skipped) {
          recordAcceptedElsewhere(lane, code, normalizeSubmitResult(settled.value));
        }
        return { kind: 'retry' };
      }
      if (settled.value === skipped) return { kind: 'retry' };
      if (settled === timeout) return { kind: 'submit_stuck' };
      if (settled.error) {
        return {
          kind: 'threw',
          code: typeof settled.error?.code === 'string' ? settled.error.code : 'internal_error',
          stage: submittedStage,
        };
      }
      return normalizeSubmitResult(settled.value);
    } finally {
      await mutateLanes(() => {
        if (lane.inFlight.submit === task) {
          lane.inFlight.submit = null;
          if (lanes.includes(lane)) touchLane(lane);
        }
      });
    }
  }

  function detachedSubmitResult(result, code) {
    if (result.kind === 'accepted') return makeResultBody('accepted', { jobComplete: false, next: null });
    return code ? tombstoneResult(code) : makeResultBody('unknown_handoff');
  }

  // A result for X that lands on an included lane now serving Y must retire X
  // without treating Y as the late result's continuation. Detached lanes use
  // the separate accepted-elsewhere path for crash-gap recovery.
  function retireSupersededSubmit(lane, code, result, stamp) {
    if (result.kind === 'accepted') {
      tombstoneCode(tombstones, code, 'accepted', { laneOrd: lane.ord, at: stamp }, CONSTANTS.TOMBSTONES_PER_ENGINE, codeGuard);
    } else if (result.kind === 'rejected') {
      const returned = normalizeCurrentHandoff(result.handoff, stamp);
      if (returned && !codeGuard.equal(returned.code, code)) {
        tombstoneCode(tombstones, code, 'rotated', { laneOrd: lane.ord, at: stamp }, CONSTANTS.TOMBSTONES_PER_ENGINE, codeGuard);
      }
    }
    return detachedSubmitResult(result, code);
  }

  async function mapSubmitResult(lane, text, result, retryCount = 0, generation = sourceGeneration, expectedEpoch = epoch, submittedCode = null, worker = expectedEpoch) {
    if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
    const stamp = safeNow(now);
    const currentCode = submittedCode ?? lane.current?.code;
    // The lane left the bridge (Unrelease, discard) while its submit was in
    // flight. An accepted answer was still written, so say so, but never adopt
    // the next handoff or index a code for a lane that is gone.
    if (!lanes.includes(lane)) {
      recordAcceptedElsewhere(lane, currentCode, result);
      return detachedSubmitResult(result, currentCode);
    }
    // A stuck X must never hold the successor Y after a rotation. A thrown X
    // is different: a same-stage reread may legitimately rotate X to a fresh
    // code and retry that fresh code, so its terminal fallbacks fence ownership
    // at their own mutation turns below.
    if (result.kind === 'submit_stuck'
        && (!lane.current || !codeGuard.equal(lane.current.code, currentCode))) {
      return tombstoneResult(currentCode);
    }
    if (result.kind === 'submit_stuck') {
      const stuckCap = await persistCap(lane, 'submit_stuck', generation, {
        expectedEpoch,
        expectedCode: currentCode,
        expectedPhase: 'awaiting',
      });
      if (!stuckCap) return tombstoneResult(currentCode);
      if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
      return makeResultBody('needs_user', { reason: 'submit_stuck' });
    }
    if (result.kind === 'accepted') {
      const staged = await mutateLanes(() => {
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        if (!lanes.includes(lane)) {
          recordAcceptedElsewhereOp(lane, currentCode, result);
          return detachedSubmitResult(result, currentCode);
        }
        if (!lane.current || !codeGuard.equal(lane.current.code, currentCode)) {
          return retireSupersededSubmit(lane, currentCode, result, stamp);
        }
        // A hold placed while the submit was in flight stands: the answer is
        // recorded but nothing is served or re-armed for a paused lane.
        const heldOnLanding = isHeldPhase(lane);
        tombstoneCode(tombstones, currentCode, 'accepted', { laneOrd: lane.ord, at: stamp }, CONSTANTS.TOMBSTONES_PER_ENGINE, codeGuard);
        codeIndex.delete(codeGuard.key(currentCode));
        const fingerprint = responseFingerprint(text);
        if (fingerprint) {
          lane.acceptedFingerprints.add(fingerprint);
          while (lane.acceptedFingerprints.size > 32) lane.acceptedFingerprints.delete(lane.acceptedFingerprints.values().next().value);
        }
        lane.counters.rejections = 0;
        lane.counters.junkStreak = 0;
        lane.counters.errStreak = 0;
        lane.retained = null;
        // The answer that was outstanding for this job has arrived. If a next
        // stage exists, serveLane below stamps it as served; until then nothing
        // is being answered.
        lane.answeredAt = stamp;
        lane.awaitingAnswer = false;
        lane.servedAt = null;
        counts.submitAccepted++;
        markWorkerCompleted(worker);
        touchLane(lane);
        auditEvent('accepted', { tool: 'submit_handoff', outcome: 'accepted', stage: lane.current?.stage ?? 'unknown' });
        if (result.completed || !result.handoff) {
          if (heldOnLanding) keepHoldOverResult(lane);
          else {
            setPhase(lane, 'host', stamp);
            lane.hostSince = stamp;
          }
          lane.current = null;
          notifyJobChanged(lane, generation);
          return { persist: true, body: makeResultBody('accepted', { jobComplete: true, next: null }) };
        }
        const priorStage = lane.current?.stage;
        if (heldOnLanding) {
          const held = normalizeCurrentHandoff(result.handoff, stamp);
          lane.current = held;
          keepHoldOverResult(lane);
          if (held) {
            rememberIssuedCode(lane, held.code, codeGuard);
            indexLaneCode(codeIndex, lane, { epochN: expectedEpoch.n, servedAt: null }, CONSTANTS.CODE_INDEX_PER_LANE, codeGuard);
          }
          notifyJobChanged(lane, generation);
          return { persist: true, body: makeResultBody('accepted', { jobComplete: false, next: null }) };
        }
        if (!adoptCurrent(lane, result.handoff)) {
          holdLane(lane, 'write_failed', safeNow(now));
          return { persist: true, body: makeResultBody('needs_user', { reason: 'write_failed' }) };
        }
        notifyJobChanged(lane, generation);
        // Review-to-review accepts are authoring progress.  The Local AI
        // application workflow deliberately has no revision limit, so keep
        // this counter for telemetry/persistence but never turn it into an
        // unattended bridge hold.
        if (priorStage === 'review' && lane.current.stage === 'review') lane.counters.revisedRounds++;
        return { persist: true, serve: true };
      });
      if (!staged?.persist) return staged;
      if (!await persistLanes(generation)) reconcileLanes(generation);
      return mutateLanes(() => {
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        wake();
        if (staged.body) return staged.body;
        return makeResultBody('accepted', { jobComplete: false, next: serveLaneOp(lane, generation, expectedEpoch, worker) });
      });
    }

    if (result.kind === 'rejected') {
      const staged = await mutateLanes(() => {
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        if (!lanes.includes(lane)) {
          recordAcceptedElsewhereOp(lane, currentCode, result);
          return detachedSubmitResult(result, currentCode);
        }
        if (!lane.current || !codeGuard.equal(lane.current.code, currentCode)) {
          return retireSupersededSubmit(lane, currentCode, result, stamp);
        }
        lane.retained = null;
        lane.counters.rejections++;
        lane.counters.junkStreak = 0;
        lane.counters.errStreak = 0;
        const returned = normalizeCurrentHandoff(result.handoff, stamp);
        if (returned) {
          if (!codeGuard.equal(returned.code, currentCode)) {
            tombstoneCode(tombstones, currentCode, 'rotated', { laneOrd: lane.ord, at: stamp }, CONSTANTS.TOMBSTONES_PER_ENGINE, codeGuard);
            codeIndex.delete(codeGuard.key(currentCode));
          }
          lane.current = returned;
          rememberIssuedCode(lane, returned.code, codeGuard);
          indexLaneCode(codeIndex, lane, { epochN: expectedEpoch.n, servedAt: null }, CONSTANTS.CODE_INDEX_PER_LANE, codeGuard);
        }
        const errors = result.validationErrors?.length ? result.validationErrors : lane.current?.corrections;
        if (lane.current) {
          lane.current.corrections = Array.isArray(errors) ? errors : [];
          if (typeof result.correctionPrompt === 'string') lane.current.correctionPrompt = result.correctionPrompt;
        }
        counts.submitRejected++;
        auditEvent('rejected', { tool: 'submit_handoff', outcome: 'rejected', stage: lane.current?.stage ?? 'unknown' });
        // A validator rejection is a normal correction round, not a safety
        // failure.  Preserve its aggregate counter for telemetry and durable
        // lane state, but keep serving corrections until the app accepts one.
        // ChatGPT is handed a code for the corrected answer. A recovery re-read
        // that rotated the code reset the serve state (adoptCurrent), so re-arm it.
        if (lane.phase === 'awaiting' && !laneAwaitingAnswer(lane)) {
          lane.awaitingAnswer = true;
          lane.servedAt = stamp;
          lane.servedEpochN = expectedEpoch.n;
        }
        const body = makeRejectedBody({
          handoffCode: lane.current?.code ?? currentCode,
          attempt: lane.counters.rejections + 1,
          validationErrors: errors,
          correctionPrompt: result.correctionPrompt ?? lane.current?.correctionPrompt,
        });
        return { body, persist: true, revision: touchLane(lane) };
      });
      if (!staged?.persist) return staged;
      if (!await persistLanes(generation)) reconcileLanes(generation);
      return mutateLanes(() => {
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        if (laneRevision(lane) === staged.revision) wake();
        return staged.body;
      });
    }

    if (result.kind === 'threw') {
      if (result.code === 'LOCAL_AI_JOB_INTEGRITY') {
        const integrityCap = await persistCap(lane, 'job_broken', generation, {
          expectedEpoch,
          expectedCode: currentCode,
          expectedPhase: 'awaiting',
        });
        if (!integrityCap) return tombstoneResult(currentCode);
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        return makeResultBody('needs_user', { reason: 'job_broken', note: 'Infinite Canvas found an integrity problem in this application bundle.' });
      }
      if (retryCount < 2) {
        const originalStage = result.stage ?? lane.current?.stage;
        const reread = await readLane(lane, { recoveryStage: originalStage, generation });
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        if (!lanes.includes(lane)) return detachedSubmitResult(result, currentCode);
        if (reread?.kind === 'open' && lane.current) {
          const freshStage = reread.handoff?.stage ?? lane.current.stage;
          if (originalStage && freshStage !== originalStage) {
            return makeResultBody('superseded', { note: supersededStageNote(originalStage, freshStage) });
          }
          // Held while the re-read ran: do not send the answer to the app again.
          if (isHeldPhase(lane)) return makeResultBody(lane.phase, { reason: lane.reason });
          const recoveryCode = lane.current.code;
          const retried = await callApplicationSubmit(lane, recoveryCode, text, generation, expectedEpoch);
          return mapSubmitResult(lane, text, retried, retryCount + 1, generation, expectedEpoch, recoveryCode, worker);
        }
        if (lane.phase === 'host') return makeResultBody('superseded');
        // The reread proved the bundle is gone, or saved elsewhere ('done' is
        // only ever a saved job). Counting that as a transient write error
        // answered 'retry' and then flipped a finished lane to needs_user; it
        // is a definite, final answer.
        if (lane.phase === 'gone' || lane.phase === 'done') return makeResultBody('unknown_handoff');
      }
      const staged = await mutateLanes(() => {
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        // A terminal fallback is about the code that actually threw. Do not
        // charge or hold a successor adopted while the recovery read ran.
        if (!lanes.includes(lane) || lane.phase !== 'awaiting'
            || !codeGuard.equal(lane.current?.code, currentCode)) return tombstoneResult(currentCode);
        lane.counters.errStreak++;
        if (lane.counters.errStreak >= CONSTANTS.APPLICATION_ERROR_STREAK) {
          holdLane(lane, 'write_failed', safeNow(now));
          return { body: makeResultBody('needs_user', { reason: 'write_failed' }), persist: true, revision: touchLane(lane) };
        }
        return { body: makeResultBody('retry', { inFlight: false }), persist: true, revision: touchLane(lane) };
      });
      if (!staged?.persist) return staged;
      if (!await persistLanes(generation)) reconcileLanes(generation);
      return mutateLanes(() => epochCurrent(expectedEpoch, generation) ? staged.body : makeResultBody('retry'));
    }
    return makeResultBody('retry');
  }

  // What a submit that waited for a semaphore slot answers when its lane changed
  // while it waited, or null when the lane can still take it.
  function staleQueuedSubmitResult(lane, code, text) {
    if (!lanes.includes(lane)) return tombstoneResult(code);
    if (isHeldPhase(lane)) {
      // Not a durable verdict: the person can resume and send the same answer.
      verdicts.delete(verdictKey(codeGuard.key(code), text));
      if (lane.phase === 'held') { counts.submitHeld++; return makeResultBody('held', { reason: lane.reason }); }
      return makeResultBody('needs_user', { reason: lane.reason });
    }
    if (lane.phase === 'host') { counts.submitSuperseded++; return makeResultBody('superseded'); }
    if (lane.phase === 'gone' || lane.phase === 'done' || !lane.current) return makeResultBody('unknown_handoff');
    if (!codeGuard.equal(lane.current.code, code)) return tombstoneResult(code);
    return null;
  }

  async function runSubmit(lane, text, submittedCode, generation = sourceGeneration, expectedEpoch = epoch, worker = expectedEpoch) {
    await semaphore.acquire();
    try {
      const claimed = await mutateLanes(() => {
        if (!epochCurrent(expectedEpoch, generation)) return { body: makeResultBody('retry') };
        if (lane.servedWorkerId && lane.servedWorkerId !== worker?.id) return { body: makeResultBody('unknown_handoff') };
        const stale = staleQueuedSubmitResult(lane, submittedCode, text);
        if (stale) return { body: stale };
        if (lane.phase !== 'awaiting' || !lane.current || !codeGuard.equal(lane.current.code, submittedCode)) {
          return { body: tombstoneResult(submittedCode) };
        }
        return {
          code: submittedCode,
          key: verdictKey(codeGuard.key(submittedCode), text),
          retained: lane.retained,
        };
      });
      if (claimed.body) return claimed.body;
      const { code, key, retained } = claimed;
      if (codeGuard.sameDigest(retained?.codeDigest, codeGuard.digest(code)) && retained.sha256 !== key) {
        const recovered = await callApplicationSubmit(lane, code, retained.text, generation, expectedEpoch);
        // A was durably retained before the crash; it owns this recovery
        // attempt. Never fall through and stamp/send incoming B after *any*
        // recovered outcome (including throw/retry): map it as A so only a
        // definitive result can clear or replace the retained record.
        return mapSubmitResult(lane, retained.text, recovered, 2, generation, expectedEpoch, code, worker);
      }
      await mutateLanes(() => {
        if (!epochCurrent(expectedEpoch, generation) || !lanes.includes(lane)
            || lane.phase !== 'awaiting' || !codeGuard.equal(lane.current?.code, submittedCode)) return;
        lane.submittedAt = safeNow(now);
        lane.retained = { codeDigest: codeGuard.digest(code), text, sha256: key, at: lane.submittedAt };
        touchLane(lane);
      });
      if (!epochCurrent(expectedEpoch, generation) || !lanes.includes(lane)
          || lane.phase !== 'awaiting' || !codeGuard.equal(lane.current?.code, submittedCode)) return makeResultBody('retry');
      const result = await callApplicationSubmit(lane, code, text, generation, expectedEpoch);
      return await mapSubmitResult(lane, text, result, 0, generation, expectedEpoch, code, worker);
    } finally {
      semaphore.release();
      if (epochCurrent(expectedEpoch, generation)) wake();
    }
  }

  async function framePushSubmit(raw, { successorBudgetMs = 0, generation = sourceGeneration, expectedEpoch = epoch, worker = expectedEpoch } = {}) {
    if ((!scope.scoring && !scope.marketplace) || !epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
    const decision = raw && typeof raw === 'object' ? raw : { status: 'retry' };
    if (decision.status === 'rejected') {
      const body = {
        status: 'rejected',
        handoffCode: typeof decision.handoffCode === 'string' ? decision.handoffCode : '',
        attempt: Number.isInteger(decision.attempt) ? decision.attempt : 1,
        caution: REJECTED_CAUTION,
        note: typeof decision.note === 'string' ? decision.note : RESULT_NOTES.rejected,
      };
      if (typeof decision.validationCode === 'string') body.validationCode = decision.validationCode;
      if (typeof decision.correction === 'string' && decision.correction) body.correction = decision.correction;
      counts.submitRejected++;
      return body;
    }
    if (decision.status === 'accepted') {
      counts.submitAccepted++;
      markWorkerCompleted(worker);
      let next = null;
      // Pools do not keep submit_handoff open to wait for a later wave. Return
      // the same explicit poll instruction the worker would have received
      // after that probe, then let its next GET observe the real terminal
      // state. This keeps the worker's quiet/restart lifecycle accurate too.
      if (expectedEpoch?.poolStarted === true && successorBudgetMs === 0) {
        next = makeResultBody('waiting', {
          retryAfterSeconds: workerRetryAfterSeconds(expectedEpoch, worker),
        });
      } else if (successorBudgetMs > 0 && typeof push?.nextAfterAccept === 'function') {
        let successor;
        try {
          if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
          successor = await raceWithBudget(
            push.nextAfterAccept({
              epoch: pushEpochId(expectedEpoch),
              budgetMs: successorBudgetMs,
              owner: pushOwner,
              worker: worker?.id,
              keepWaiting: expectedEpoch?.poolStarted === true,
            }),
            successorBudgetMs,
            { status: 'waiting' },
          );
        } catch { successor = { status: 'waiting' }; }
        if (!epochCurrent(expectedEpoch, generation)) {
          try { push?.closeEpoch?.(pushEpochId(expectedEpoch)); } catch { /* stale state is best-effort */ }
          return makeResultBody('retry');
        }
        if (successor?.status && successor.status !== 'queue_empty') next = framePushGet(successor, generation, expectedEpoch, worker);
      }
      // A bounded successor probe can legitimately finish while more work is
      // materialising. Preserve the established top-level accepted contract,
      // but arm quiet recovery for a chat that never makes the next poll.
      if (next?.status === 'waiting') {
        markWorkerWaiting(worker);
      }
      return { status: 'accepted', jobComplete: false, next };
    }
    if (decision.status === 'duplicate') { counts.submitDuplicate++; return makeResultBody('duplicate'); }
    if (decision.status === 'superseded') { counts.submitSuperseded++; return makeResultBody('superseded'); }
    if (decision.status === 'held') {
      counts.submitHeld++;
      const reason = ['person_editing', 'hub_not_selected', 'task_disabled'].includes(decision.reason)
        ? decision.reason
        : 'task_disabled';
      return makeResultBody('held', { reason });
    }
    if (decision.status === 'needs_user') {
      const reason = ['rejection_cap', 'commit_failed'].includes(decision.reason)
        ? decision.reason
        : 'commit_failed';
      return makeResultBody('needs_user', { reason });
    }
    if (decision.status === 'junk') { counts.submitJunk++; return makeResultBody('junk'); }
    if (decision.status === 'misrouted') { counts.submitMisrouted++; return makeResultBody('misrouted'); }
    if (decision.status === 'too_large') { counts.submitTooLarge++; return makeResultBody('too_large'); }
    return makeResultBody('retry', { inFlight: decision.status === 'retry' });
  }

  function runPushSubmit(code, text, generation = sourceGeneration, expectedEpoch = epoch, worker = expectedEpoch) {
    if ((!scope.scoring && !scope.marketplace) || !epochCurrent(expectedEpoch, generation)) return null;
    const epochId = pushEpochId(expectedEpoch);
    const key = verdictKey(`push\n${epochId ?? ''}\n${worker?.id ?? ''}\n${codeGuard.key(code)}`, text);
    const cached = pushVerdicts.get(key);
    if (cached && safeNow(now) - cached.at <= CONSTANTS.VERDICT_CACHE_MS) return cached;
    let rawPromise;
    rawPromise = Promise.resolve()
      .then(() => semaphore.acquire())
      .then(() => epochCurrent(expectedEpoch, generation)
        ? push.submit({ epoch: epochId, handoffCode: code, response: text, worker: worker?.id })
        : { status: 'retry' })
      .catch(() => ({ status: 'retry' }))
      .finally(() => semaphore.release());
    const record = { at: safeNow(now), rawPromise, framedPromise: null, epochId, generation, expectedEpoch, worker };
    pushVerdicts.set(key, record);
    rawPromise.finally(() => {
      const current = pushVerdicts.get(key);
      if (epochCurrent(expectedEpoch, generation) && current === record && safeNow(now) - current.at > CONSTANTS.VERDICT_CACHE_MS) pushVerdicts.delete(key);
    });
    return record;
  }

  // An admitted submit that ends the chat's work tells it to stop (hold, needs
  // attention), which reads as idle exactly as a stopping get does; an accepted
  // one is progress, so the chat's wait streak starts over.
  async function submit(args = {}) {
    const admission = gate(args);
    if (admission.body) return admission.body;
    const startEpoch = epoch;
    const worker = admission.worker;
    if (worker) worker.submitInFlight = Math.max(0, Number.isSafeInteger(worker.submitInFlight) ? worker.submitInFlight : 0) + 1;
    try {
      const result = await submitAdmitted(args, worker);
      const expectsPoll = result?.status === 'accepted' && result?.next?.status === 'waiting';
      if (result?.status === 'accepted' && epoch === startEpoch && worker) worker.consecutiveWaits = 0;
      if (['held', 'needs_user', 'paused'].includes(result?.status)) markChatStopped(worker);
      recordWorkerOutcome(worker, result?.status);
      if (expectsPoll) markWorkerWaiting(worker);
      maybeExpandWorkerPool(startEpoch, sourceGeneration, authenticatedLinkId(args));
      return result;
    } finally {
      if (worker) worker.submitInFlight = Math.max(0, Number.isSafeInteger(worker.submitInFlight) ? worker.submitInFlight - 1 : 0);
    }
  }

  async function submitAdmitted(args = {}, worker = epoch) {
    if (args.canvasOpen === false) return makeResultBody('app_unavailable');
    const generation = sourceGeneration;
    const expectedEpoch = epoch;
    const callAt = safeNow(now);
    if (!worker) return makeResultBody('retry');
    worker.calls += 1;
    worker.idleSince = null;
    worker.starterKey = null; // belt and braces: authenticate() already dropped it
    worker.firstCallAt ??= callAt;
    worker.lastCallAt = callAt;
    worker.lastCallKind = 'submit';
    worker.waitingSince = null;
    const normalized = stringifySubmission(args.response);
    if (!normalized.ok) {
      counts.submitJunk++;
      return makeResultBody('junk');
    }
    const text = normalized.text;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > CONSTANTS.MAX_RESPONSE_BYTES) {
      counts.submitTooLarge++;
      return makeResultBody('too_large');
    }
    worker.bytesReceived += bytes;
    worker.lastSubmitAt = safeNow(now);
    const code = trimHandoffCode(args.handoffCode);
    // Push owns its served-code/tombstone namespace. It has to be consulted
    // before the application unknown-code path so an accepted scoring or
    // marketplace retry is never reported as an application unknown handoff.
    if (push && (scope.scoring || scope.marketplace)) {
      const pushStartedAt = safeNow(now);
      const pushRecord = runPushSubmit(code, text, generation, expectedEpoch, worker);
      if (!pushRecord) return makeResultBody('retry');
      const pushTimeout = Symbol('push-submit-timeout');
      const pushDecision = await raceWithBudget(pushRecord.rawPromise, submitBudgetMs, pushTimeout);
      if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
      if (pushDecision === pushTimeout) return makeResultBody('retry', { inFlight: true });
      if (pushDecision?.status !== 'unknown_handoff') {
        const elapsed = Math.max(0, safeNow(now) - pushStartedAt);
        if (!pushRecord.framedPromise) {
          pushRecord.framedPromise = Promise.resolve(pushDecision).then(decision => framePushSubmit(decision, {
            // Pool workers immediately perform their own next GET. Waiting
            // here for a successor can consume the complete submit budget for
            // every worker, despite no result being ready yet. A legacy chat
            // retains the bounded successor probe that can inline the next
            // handoff in its accepted response.
            successorBudgetMs: expectedEpoch?.poolStarted === true
              ? 0
              : Math.max(0, submitBudgetMs - elapsed),
            generation,
            expectedEpoch,
            worker,
          }));
        }
        return raceWithBudget(
          pushRecord.framedPromise,
          Math.max(0, submitBudgetMs - elapsed),
          makeResultBody('retry', { inFlight: true }),
        );
      }
    }
    const codeDigest = codeGuard.digest(code);
    const entry = codeIndex.get(codeGuard.key(code));
    if (!entry?.lane || !codeGuard.sameDigest(codeDigest, entry.codeDigest)) return tombstoneResult(code);
    // Backstop: a route for a lane that is no longer in the bridge is stale.
    if (!lanes.includes(entry.lane)) {
      await mutateLanes(() => { if (!lanes.includes(entry.lane)) codeIndex.delete(codeGuard.key(code)); });
      return tombstoneResult(code);
    }
    // A scope downgrade never lets a previously served application answer
    // reach the adapter.  Keep the release durable for a later, confirmed
    // re-enable, but deny this in-flight handoff without touching its state.
    if (!scope.applications) return makeResultBody('held', { reason: 'scope_disabled' });
    const lane = entry.lane;
    if (lane.servedWorkerId && lane.servedWorkerId !== worker.id) return makeResultBody('unknown_handoff');
    // Any submit that reaches its lane is ChatGPT being heard on this job, even
    // when it is turned away before the source is asked (junk, wrong stage, a
    // cached verdict, held). runSubmit stamps its own retained record.
    const admission = await mutateLanes(() => {
      if (!epochCurrent(expectedEpoch, generation) || !lanes.includes(lane)
          || !codeGuard.equal(lane.current?.code, code)) return null;
      lane.submittedAt = safeNow(now);
      return { revision: touchLane(lane) };
    });
    // The queued stamp yields to other state turns. Do not classify an old
    // handoff against a successor lane: an invalid X must never advance Y's
    // junk counter or trigger its cap.
    if (!admission || !lanes.includes(lane) || !codeGuard.equal(lane.current?.code, code)) return tombstoneResult(code);
    if (lane.phase === 'held') { counts.submitHeld++; return makeResultBody('held', { reason: lane.reason }); }
    if (lane.phase === 'needs_user') return makeResultBody('needs_user', { reason: lane.reason });
    if (lane.phase === 'host') { counts.submitSuperseded++; return makeResultBody('superseded'); }
    if (lane.phase === 'gone' || lane.phase === 'done' || !lane.current) return makeResultBody('unknown_handoff');

    const classification = classifySubmission({ response: text, lane, lanes, codeGuard });
    if (classification !== 'pass') {
      if (classification === 'junk') {
        // This is a complete fenced state turn: a stale X may neither charge
        // Y's streak nor cap Y after the submitted-at stamp yielded.
        const junk = await mutateLanes(() => {
          if (!epochCurrent(expectedEpoch, generation) || !lanes.includes(lane)
              || lane.phase !== 'awaiting' || !codeGuard.equal(lane.current?.code, code)
              || laneRevision(lane) !== admission.revision) return null;
          lane.counters.junkStreak++;
          const cap = lane.counters.junkStreak >= CONSTANTS.APPLICATION_MAX_JUNK_STREAK;
          if (cap) holdLane(lane, 'junk_cap', safeNow(now));
          return { cap, revision: touchLane(lane) };
        });
        if (!junk) return tombstoneResult(code);
        counts.submitJunk++;
        if (junk.cap) {
          if (!await persistLanes(generation)) reconcileLanes(generation);
          return mutateLanes(() => {
            if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
            if (laneRevision(lane) === junk.revision) wake();
            return makeResultBody('held', { reason: 'junk_cap' });
          });
        }
      } else if (classification === 'misrouted') counts.submitMisrouted++;
      else counts.submitSuperseded++;
      const gotStage = extractPasteEnvelopeIdentity(text).stage;
      return makeResultBody(classification, classification === 'superseded' && gotStage
        ? { note: supersededStageNote(gotStage, lane.current.stage) }
        : {});
    }

    const key = verdictKey(codeGuard.key(code), text);
    const cached = verdicts.get(key);
    if (cached && cached.epochN === expectedEpoch.n && safeNow(now) - cached.at <= CONSTANTS.VERDICT_CACHE_MS) {
      if (cached.verdict) return cached.verdict;
      const attached = await raceWithBudget(cached.promise, submitBudgetMs, makeResultBody('retry', { inFlight: true }));
      return epochCurrent(expectedEpoch, generation) ? attached : makeResultBody('retry');
    }
    const promise = runSubmit(lane, text, code, generation, expectedEpoch, worker);
    const record = { at: safeNow(now), epochN: expectedEpoch.n, promise, verdict: null };
    verdicts.set(key, record);
    promise.then(verdict => {
      if (!epochCurrent(expectedEpoch, generation)) return;
      record.verdict = verdict; record.promise = null;
    }, () => { if (epochCurrent(expectedEpoch, generation)) verdicts.delete(key); });
    for (const [cacheKey, value] of verdicts) if (safeNow(now) - value.at > CONSTANTS.VERDICT_CACHE_MS) verdicts.delete(cacheKey);
    const settled = await raceWithBudget(promise, submitBudgetMs, makeResultBody('retry', { inFlight: true }));
    return epochCurrent(expectedEpoch, generation) ? settled : makeResultBody('retry');
  }

  async function performRestartConfirmation() {
    if (restartConfirmed) return true;
    const generation = sourceGeneration;
    if (!sourceCurrent(generation)) return false;
    const claim = await mutateLanes(() => {
      if (!sourceCurrent(generation) || restartConfirmed) return null;
      return {
        restartRevision,
        lanes: lanes
          .filter(lane => lane.phase === 'held' && lane.reason === 'restart')
          .map(lane => ({ lane, revision: laneRevision(lane), ord: lane.ord })),
      };
    });
    if (!claim) return false;
    let accepted = false;
    try { accepted = await confirmRestart(claim.lanes.map(item => item.ord)); } catch { accepted = false; }
    if (!accepted || !sourceCurrent(generation)) return false;
    const staged = await mutateLanes(() => {
      if (!sourceCurrent(generation) || restartConfirmed || restartRevision !== claim.restartRevision
          || claim.lanes.some(item => !lanes.includes(item.lane) || laneRevision(item.lane) !== item.revision)) return false;
      const prior = [];
      restartConfirmed = true;
      const restartToken = ++restartRevision;
      for (const item of claim.lanes) {
        const lane = item.lane;
        const values = {
          phase: lane.phase,
          reason: lane.reason,
          heldFrom: lane.heldFrom,
          snapshot: lane.snapshot,
          changedAt: lane.changedAt,
        };
        setPhase(lane, 'unread');
        lane.reason = null;
        lane.heldFrom = null;
        lane.snapshot = null;
        prior.push({ lane, values, revision: touchLane(lane) });
      }
      return { generation, restartToken, prior, persist: true };
    });
    if (!staged?.persist) return staged;
    const saved = await persistLanes(staged.generation);
    const finished = await mutateLanes(() => {
      if (!sourceCurrent(staged.generation)) return false;
      if (!saved) {
        if (restartRevision === staged.restartToken) {
          restartConfirmed = false;
          restartRevision += 1;
        }
        for (const state of staged.prior) {
          if (!lanes.includes(state.lane) || laneRevision(state.lane) !== state.revision) continue;
          Object.assign(state.lane, state.values);
          touchLane(state.lane);
        }
        return false;
      }
      if (restartRevision !== staged.restartToken) return false;
      humanAction();
      auditEvent('restart_confirmed');
      log('restart_confirmed');
      return true;
    });
    if (!saved) reconcileLanes(staged.generation);
    return finished;
  }

  function confirmRestartIfNeeded() {
    if (restartConfirmed) return Promise.resolve(true);
    if (restartConfirmation) return restartConfirmation;
    const pending = performRestartConfirmation();
    restartConfirmation = pending;
    const clear = () => {
      if (restartConfirmation === pending) restartConfirmation = null;
    };
    pending.then(clear, clear);
    return pending;
  }

  function recopiable(target, linkId) {
    // Only a chat started by a 'new' press has a starter to hand out again: a
    // Continue key is pasted into an EXISTING chat, so a new-chat press on it
    // must rotate and retire that key. Nothing may have presented the key (a
    // chat that was turned away still holds it), and the engine must be
    // serving: a pause is not lifted by re-copying, so a paused engine rotates
    // (rotation commits a fresh chat and clears the pause). Unrecognised keys
    // from stale chats do not count against this: they are noise, and rotating
    // for them would kill a starter that was pasted but has not called yet.
    if (!target || target.mintedBy !== 'new' || target.presented || target.calls !== 0) return false;
    if (typeof target.starterKey !== 'string' || !target.starterKey) return false;
    if (!sameDigest(epochHash(linkId, target.starterKey), target.keyHash)) {
      target.starterKey = null; // a different link: the plaintext is dead weight
      return false;
    }
    if (paused) return false;
    if (atHardByteBudget(target)) return false;
    return !(limits.chatKeyMaxAgeHours > 0
      && safeNow(now) - target.mintedAt >= limits.chatKeyMaxAgeHours * 3_600_000);
  }

  async function prepareChat({ linkId, kind = 'new', forceNew = false } = {}) {
    if (typeof linkId !== 'string' || !linkId) return { copied: false, status: 'unlinked' };
    if (!await confirmRestartIfNeeded()) return { copied: false, status: 'paused', reason: 'restart' };
    // A worker pool is a single coordinated generation. Do not let the
    // ordinary one-chat controls silently retire all of its independently
    // started workers; only startWorkerPool's explicit forced preparation can
    // make a replacement generation.
    if (epoch?.poolStarted === true && forceNew !== true) return { copied: false, status: 'pool_active' };
    // Re-copy: a chat that has been started but has not yet made a single call
    // is still waiting for its starter to be pasted. Pressing "Copy starter"
    // again must hand back THAT starter, not burn the unused chat and bump the
    // ordinal. Only 'new' re-copies ('continue' pastes into an existing chat).
    // The plaintext key is held solely on this in-memory epoch object, never
    // persisted, logged, audited or put in status. It is dropped the moment
    // anything presents the key (authenticate, or the controller's notePresented
    // for a call it turned away), when the epoch is retired, when a paused
    // revoke/quit begins, and when a prepared epoch is refused. That does not
    // widen exposure: a key nobody has presented has not been used, and it was
    // already placed on the clipboard when the chat was started. A key that is
    // no longer reproducible (no plaintext, presented, engine paused, other
    // link, expired, or minted by Continue) falls through to the rotate below.
    const target = epoch;
    if (kind === 'new' && forceNew !== true && recopiable(target, linkId)) {
      return {
        copied: true,
        recopied: true,
        sessionCode: target.starterKey,
        chatOrdinal: target.n,
        commit() {
          // Same chat, same key: nothing rotates. Refuse only if that chat was
          // replaced while the clipboard was being written.
          if (epoch !== target) return false;
          humanAction();
          log('starter_recopied', { chatOrdinal: target.n });
          return true;
        },
      };
    }
    const sessionCode = makeChatKey(random);
    // Preparation and clipboard confirmation are deliberately split. Reserve
    // a unique ordinal before returning the one-shot commit capability so two
    // overlapping native sheets can never share a push epoch id. Gaps from an
    // abandoned preparation are harmless because ordinals are process-local.
    const preparedOrdinal = ++reservedEpochOrdinal;
    const prepared = {
      n: preparedOrdinal,
      keyHash: epochHash(linkId, sessionCode),
      // Link-free digest for the ended-chat ledger (see endedDigest), and the
      // link the chat was started under. Computed here because the plaintext key
      // is not kept once it has been presented.
      endedDigest: endedDigest(sessionCode),
      linkDigest: epochLinkDigest(linkId),
      // When the ledger entry was last stamped (see refreshLiveEntry).
      ledgerStampAt: 0,
      // Plaintext key, in memory only, until the key is first presented (see
      // re-copy above). Only a 'new' press hands out a re-copyable starter.
      starterKey: kind === 'new' ? sessionCode : null,
      mintedBy: kind === 'new' ? 'new' : 'continue',
      presented: false,
      mintedAt: safeNow(now),
      bytesServed: 0,
      bytesReceived: 0,
      lastGetAt: null,
      lastSubmitAt: null,
      firstCallAt: null,
      lastCallAt: null,
      lastCallKind: null,
      calls: 0,
      completed: 0,
      activeTask: false,
      activeTaskKind: null,
      submitInFlight: 0,
      activeTaskSince: null,
      quietFrom: null,
      consecutiveWaits: 0,
      idleSince: null,
      focusLaneOrd: null,
      servedPrompt: new Map(),
      assignedLaneOrds: new Set(),
    };
    attachWorkers(prepared, { workerCount: 1, linkId });
    let committed = false;
    return {
      copied: true,
      sessionCode,
      chatOrdinal: prepared.n,
      commit() {
        if (committed) return false;
        committed = true;
        // A later preparation may be copied and committed first. Refuse the
        // older capability instead of rotating the live chat backwards onto
        // an already-used ordinal (and therefore an aliased push namespace).
        if (prepared.n <= epochOrdinal) { prepared.starterKey = null; return false; }
        retireEpoch(kind === 'continue' ? 'continued' : 'rotated');
        epochOrdinal = prepared.n;
        epoch = prepared;
        paused = false;
        pauseCause = null;
        // Record the new chat in the ledger now, so a process that dies before
        // this chat is retired still recognises its key as ended afterwards.
        for (const worker of epochWorkers(prepared)) worker.ledgerStampAt = prepared.mintedAt;
        pruneLedger();
        for (const digest of epochWorkers(prepared).map(worker => worker.endedDigest)) ledgerAdd(digest, prepared.mintedAt);
        persistLedger();
        humanAction();
        if (kind === 'continue') counts.chatsContinued++;
        else counts.chatsStarted++;
        auditEvent(kind === 'continue' ? 'continue' : 'new_chat');
        log(kind === 'continue' ? 'continue' : 'new_chat', { chatOrdinal: prepared.n });
        wake();
        return true;
      },
    };
  }

  async function newChat(args = {}) {
    const prepared = await prepareChat({ ...args, kind: 'new' });
    if (!prepared.copied) return prepared;
    prepared.commit();
    return { copied: true, sessionCode: prepared.sessionCode, chatOrdinal: prepared.chatOrdinal, ...(prepared.recopied ? { recopied: true } : {}) };
  }

  async function continueChat(args = {}) {
    const prepared = await prepareChat({ ...args, kind: 'continue' });
    if (!prepared.copied) return prepared;
    prepared.commit();
    return { copied: true, sessionCode: prepared.sessionCode, chatOrdinal: prepared.chatOrdinal };
  }

  function workerPoolRecommendation(maxWorkers = MAX_WORKER_POOL_SIZE) {
    let pushState = {};
    try { pushState = push?.status?.(pushEpochId()) || {}; } catch { pushState = {}; }
    const pushEnabled = scope.scoring || scope.marketplace;
    // Production push status exposes the selected opaque hub keys. Discovery
    // intentionally also remembers opted-out hubs for the chooser, but those
    // must not inflate the pool plan. Test seams without selection metadata
    // retain their historical all-discovered fallback.
    const selectedKnown = Array.isArray(pushState.selectedHubs);
    const selected = new Set(selectedKnown
      ? pushState.selectedHubs.filter(key => typeof key === 'string')
      : []);
    const rawTasks = pushEnabled && Array.isArray(pushState.discovered)
      ? pushState.discovered
        .filter(hub => !selectedKnown || selected.has(hub?.key))
        .flatMap(hub => Array.isArray(hub?.tasks) ? hub.tasks : [])
      : [];
    let plannerBudget = MAX_WORKER_POOL_PLANNING_UNITS;
    const tasks = [];
    for (const entry of rawTasks) {
      if (!STATUS_PUSH_TASKS.has(entry?.task) || plannerBudget < 1) continue;
      const pending = Number.isSafeInteger(entry.pending) && entry.pending > 0 ? entry.pending : 0;
      const forecast = Number.isSafeInteger(entry.forecast) && entry.forecast > 0 ? entry.forecast : 0;
      // Forecast covers the active wave plus later units in its UUID-scoped
      // scheduler. It may grow the plan, never hide currently materialized
      // handoffs, and must stay within the aggregate planner bound.
      const count = Math.min(plannerBudget, Math.max(pending, forecast));
      if (count < 1) continue;
      tasks.push({ task: entry.task, pending, forecast });
      plannerBudget -= count;
    }
    // A host lane is still planned work (the app may release its next
    // handoff), but it is document-building work owned by the app right now,
    // not a handoff a ChatGPT worker can claim. Keep the two counts separate
    // so the UI never labels it "released now".
    const applicationForecastCount = scope.applications
      ? lanes.filter(lane => ['awaiting', 'unread', 'host'].includes(lane.phase)).length
      : 0;
    const applicationCount = scope.applications
      ? lanes.filter(lane => ['awaiting', 'unread'].includes(lane.phase)).length
      : 0;
    return recommendWorkerPool({ tasks, applicationCount, applicationForecastCount, maxWorkers });
  }

  // The source status is refreshed by authenticated get/submit work.  Grow a
  // live pool monotonically from that fresh aggregate view, without trying to
  // launch or control ChatGPT chats on the person's behalf.
  function maybeExpandWorkerPool(expectedEpoch = epoch, generation = sourceGeneration, linkId = null) {
    if (!epochCurrent(expectedEpoch, generation) || expectedEpoch?.poolStarted !== true
      || typeof linkId !== 'string' || !linkId) return false;
    // Application lanes are already counted when the pool is explicitly
    // started, but they are not a refreshed upstream forecast.  Restrict
    // automatic later expansion to the selected push inventory that this
    // authenticated worker call just refreshed; otherwise an application-only
    // pool could unexpectedly mint sibling starters mid-run.
    if (!scope.scoring && !scope.marketplace) return false;
    const recommendation = workerPoolRecommendation(MAX_WORKER_POOL_SIZE);
    const before = poolWorkerCount(expectedEpoch);
    const target = Math.max(before, recommendation.recommended);
    expectedEpoch.poolRecommendation = Object.freeze({
      ...recommendation,
      actualWorkers: target,
      reason: target > recommendation.recommended ? 'preserved_live_workers' : recommendation.reason,
    });
    if (target <= before) return false;
    attachWorkers(expectedEpoch, { workerCount: target, linkId });
    expectedEpoch.poolExpansion = Object.freeze({
      count: Math.min(999, (Number.isInteger(expectedEpoch.poolExpansion?.count) ? expectedEpoch.poolExpansion.count : 0) + 1),
      at: safeNow(now), added: target - before, queued: recommendation.queued, materialized: recommendation.materialized, recommended: recommendation.recommended,
    });
    for (const worker of epochWorkers(expectedEpoch)) {
      worker.ledgerStampAt = expectedEpoch.mintedAt;
      ledgerAdd(worker.endedDigest, expectedEpoch.mintedAt);
    }
    persistLedger();
    auditEvent('worker_pool_expanded', { workers: target, added: target - before });
    log('worker_pool_expanded', {
      workers: target,
      recommended: recommendation.recommended,
      queued: recommendation.queued,
      added: target - before,
    });
    wake();
    return true;
  }

  async function startWorkerPoolInternal({ linkId, requestedWorkers } = {}) {
    if (typeof linkId !== 'string' || !linkId) return { started: false, status: 'unlinked' };
    if (!await confirmRestartIfNeeded()) return { started: false, status: 'paused', reason: 'restart' };
    // A relink invalidates every live starter. Make that boundary explicit
    // before adding a sibling worker whose code would otherwise be bound to a
    // different link than worker 1.
    noteLink(linkId);
    // A new pool retains the historical explicit cap (used by focused callers
    // that intentionally start one worker).  Once a pool is live, an explicit
    // target is instead a user-owned capacity reservation: it lets later
    // workflow waves find already-waiting workers.  The recommendation always
    // still observes all safely known work, including a source forecast.
    const requestedTarget = Number.isInteger(requestedWorkers)
      ? Math.max(1, Math.min(MAX_WORKER_POOL_SIZE, requestedWorkers))
      : null;
    // Refresh once before planning. A newly selected hub can otherwise look
    // empty even though it has already queued handoffs.
    if (scope.scoring || scope.marketplace) await refreshPushHubs();
    const recommendation = workerPoolRecommendation(MAX_WORKER_POOL_SIZE);
    // A fresh empty queue has nothing to start.  A live pool is different:
    // its current units may all be claimed/in-flight during this refresh, yet
    // the person can deliberately add waiting workers for the next wave.
    // Never retire or invalidate the existing starters in either case.
    if (recommendation.recommended < 1 && epoch?.poolStarted !== true) {
      return { started: false, status: 'queue_empty', recommendation };
    }
    let created = false;
    if (!epoch) {
      // No existing chat: prepare a fresh shared generation. The renderer
      // receives only metadata and copies each unique starter separately.
      const prepared = await prepareChat({ linkId, kind: 'new', forceNew: true });
      if (!prepared?.copied || typeof prepared.commit !== 'function') return { started: false, status: prepared?.status || 'paused', reason: prepared?.reason, recommendation };
      if (prepared.commit() !== true || !epoch) return { started: false, status: 'retry', recommendation };
      created = true;
    }
    // Do not replace an active legacy chat. It becomes worker 1, keeps its
    // outstanding handoff and session key, and only the added workers receive
    // new starters. This makes an in-progress long run safely expandable.
    const before = poolWorkerCount(epoch);
    // A new pool follows the exact X = min(known work, configured capacity) plan. Existing
    // copied or active chats cannot be silently retired without stranding a
    // one-time starter or in-flight handoff, so a later explicit start only
    // expands the live pool when the newly calculated target is larger.
    const automaticTarget = created && requestedTarget !== null
      ? Math.min(recommendation.recommended, requestedTarget)
      : recommendation.recommended;
    const manualExpansionTarget = created ? 0 : (requestedTarget || 0);
    const workerCount = Math.max(before, automaticTarget, manualExpansionTarget);
    attachWorkers(epoch, { workerCount, linkId });
    epoch.poolStarted = true;
    epoch.poolExpansion = Object.freeze({ count: 0, at: null, added: 0, queued: recommendation.queued, materialized: recommendation.materialized, recommended: recommendation.recommended });
    epoch.poolRecommendation = Object.freeze({
      ...recommendation,
      actualWorkers: workerCount,
      reason: workerCount > recommendation.recommended ? 'preserved_live_workers' : recommendation.reason,
    });
    const newWorkerOrdinals = [];
    for (let ordinal = before + 1; ordinal <= workerCount; ordinal += 1) newWorkerOrdinals.push(ordinal);
    // A just-created pool's primary worker did not exist before the plan and
    // must be represented alongside its siblings. An existing untouched
    // legacy starter remains copyable through its normal re-copy semantics.
    if (created && before === 1 && !newWorkerOrdinals.includes(1)) newWorkerOrdinals.unshift(1);
    for (const worker of epochWorkers(epoch)) {
      worker.ledgerStampAt = epoch.mintedAt;
      ledgerAdd(worker.endedDigest, epoch.mintedAt);
    }
    persistLedger();
    auditEvent('worker_pool_started', { workers: workerCount, expanded: created ? false : true });
    log('worker_pool_started', {
      workers: workerCount,
      recommended: recommendation.recommended,
      queued: recommendation.queued,
      materialized: recommendation.materialized,
    });
    wake();
    return {
      started: true,
      existing: !created,
      generation: epoch.poolGeneration,
      workerCount,
      // Keep the calculated target distinct from a preserved older pool.
      // `workerCount` is the actual live-chat count shown to the user.
      recommended: recommendation.recommended,
      queued: recommendation.queued,
      materialized: recommendation.materialized,
      newWorkerOrdinals,
      lockedWorkerOrdinals: epochWorkers(epoch)
        .filter(worker => worker.starterExported === true || worker.presented === true || worker.calls > 0)
        .map(worker => worker.workerOrdinal)
        .filter(ordinal => Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= MAX_WORKER_POOL_SIZE),
      recommendation: epoch.poolRecommendation,
    };
  }

  function startWorkerPool(args = {}) {
    if (typeof args?.linkId !== 'string' || !args.linkId) return Promise.resolve({ started: false, status: 'unlinked' });
    if (workerPoolStartInFlight) return workerPoolStartInFlight;
    const operation = startWorkerPoolInternal(args);
    const shared = operation.finally(() => {
      if (workerPoolStartInFlight === shared) workerPoolStartInFlight = null;
    });
    workerPoolStartInFlight = shared;
    return shared;
  }

  function copyWorkerStarter({ linkId, generation, workerOrdinal } = {}) {
    if (!epoch?.poolStarted || !Number.isInteger(generation) || generation !== epoch.poolGeneration) return { copied: false, status: 'session_ended' };
    if (typeof linkId !== 'string' || !linkId) return { copied: false, status: 'unlinked' };
    if (!Number.isInteger(workerOrdinal) || workerOrdinal < 1 || workerOrdinal > MAX_WORKER_POOL_SIZE) return { copied: false, status: 'session_ended' };
    const worker = workerForId(epoch, workerId(workerOrdinal));
    if (worker?.starterExported === true) return { copied: false, status: 'starter_copied' };
    if (!worker || !recopiable(worker, linkId)) {
      return { copied: false, status: worker?.presented ? 'session_started' : 'session_ended' };
    }
    // This precedes returning the session code. ui.js abandons this temporary
    // reservation if its main-process clipboard write cannot complete.
    worker.starterExported = true;
    worker.restartPending = false;
    return {
      copied: true,
      sessionCode: worker.starterKey,
      generation: epoch.poolGeneration,
      workerOrdinal: worker.workerOrdinal,
      workerCount: epoch.poolSize,
    };
  }

  function abandonWorkerStarter({ linkId, generation, workerOrdinal } = {}) {
    if (!epoch?.poolStarted || !Number.isInteger(generation) || generation !== epoch.poolGeneration) return false;
    if (typeof linkId !== 'string' || !linkId || !Number.isInteger(workerOrdinal)) return false;
    const worker = workerForId(epoch, workerId(workerOrdinal));
    if (!worker?.starterExported || worker.presented || worker.calls !== 0 || typeof worker.starterKey !== 'string') return false;
    if (!sameDigest(epochHash(linkId, worker.starterKey), worker.keyHash)) return false;
    worker.starterExported = false;
    return true;
  }

  // Replace only a quiet worker's session capability.  Keep its ordinal,
  // aggregate completion count, and lane/push ownership so a fresh chat can
  // safely re-get the exact outstanding handoff.  The prior key stays in the
  // ended-key ledger and can never authenticate again.
  function restartWorker({ linkId, generation, workerOrdinal } = {}) {
    if (!epoch?.poolStarted || !Number.isInteger(generation) || generation !== epoch.poolGeneration) return { copied: false, status: 'session_ended' };
    if (typeof linkId !== 'string' || !linkId || !Number.isInteger(workerOrdinal) || workerOrdinal < 1 || workerOrdinal > MAX_WORKER_POOL_SIZE) return { copied: false, status: 'session_ended' };
    const worker = workerForId(epoch, workerId(workerOrdinal));
    if (!worker || !workerIsQuiet(worker)) return { copied: false, status: 'not_quiet' };
    const stamp = safeNow(now);
    // The live ledger already contains this digest, but stamp it again before
    // dropping the only credential that could authenticate it.
    ledgerAdd(worker.endedDigest, stamp);
    const sessionCode = makeChatKey(random);
    worker.keyHash = epochHash(linkId, sessionCode);
    worker.endedDigest = endedDigest(sessionCode);
    worker.ledgerStampAt = stamp;
    ledgerAdd(worker.endedDigest, stamp);
    worker.starterKey = sessionCode;
    worker.starterExported = true;
    worker.restartPending = true;
    worker.mintedBy = 'new';
    worker.presented = false;
    worker.mintedAt = stamp;
    worker.bytesServed = 0;
    worker.bytesReceived = 0;
    worker.firstCallAt = null;
    worker.lastCallAt = null;
    worker.lastCallKind = null;
    worker.lastGetAt = null;
    worker.lastSubmitAt = null;
    worker.calls = 0;
    worker.getInFlight = null;
    worker.submitInFlight = 0;
    // Keep the current lane/push ownership, but start a fresh ambiguity
    // interval for its deliberately replaced credential. Until this starter
    // actually calls get, a second restart must not invalidate it merely
    // because the prior chat had already been silent for five minutes.
    worker.activeTaskSince = stamp;
    worker.quietFrom = stamp;
    worker.waitingSince = null;
    worker.consecutiveWaits = 0;
    worker.idleSince = null;
    worker.restarts = Math.min(Number.MAX_SAFE_INTEGER, (Number.isSafeInteger(worker.restarts) ? worker.restarts : 0) + 1);
    persistLedger();
    auditEvent('worker_restarted', { worker: workerOrdinal });
    log('worker_restarted', { worker: workerOrdinal });
    wake();
    return { copied: true, sessionCode, generation: epoch.poolGeneration, workerOrdinal, workerCount: epoch.poolSize };
  }

  // Job ids whose bundle the app discarded or pruned this session (insertion
  // ordered, bounded). Only these are refused by `release`; a person's own
  // Unrelease and the probe-proven drops stay reversible.
  const REMOVED_BUNDLES_CAP = 256;
  const removedBundles = new Set();

  async function release({ jobs = [] } = {}) {
    // Source adoption is intentionally outside the state queue. Its result is
    // applied only if the same lane/path still wins the queued state turn.
    const generation = sourceGeneration;
    const adoptionResults = new Map();
    if (Array.isArray(jobs) && typeof application.adoptCanvasPath === 'function') {
      for (const item of jobs) {
        if (!item || !JOB_ID_RE.test(String(item.jobId || '')) || !isAbsoluteCanvasPath(item.canvasFilePath)) continue;
        const claim = await mutateLanes(() => {
          if (!sourceCurrent(generation)) return null;
          const lane = lanes.find(value => value.jobId === item.jobId);
          if (!lane || lane.canvasFilePath === item.canvasFilePath) return null;
          return { lane, before: lane.canvasFilePath, revision: laneRevision(lane) };
        });
        if (!claim) continue;
        try {
          const adopted = await application.adoptCanvasPath(claim.lane.jobId, item.canvasFilePath, claim.before);
          if (adopted?.adopted === true && sourceCurrent(generation)) {
            adoptionResults.set(item.jobId, { ...claim, after: item.canvasFilePath });
          }
        } catch { /* retain the existing trusted path */ }
      }
    }
    const staged = await mutateLanes(() => {
      if (!sourceCurrent(generation)) return { ok: false, code: 'not_ready' };
      if (!scope.applications) return { ok: false, code: 'disabled' };
      if (!Array.isArray(jobs) || jobs.length === 0) return { ok: false, code: 'invalid_arguments' };
      const unique = new Map();
      for (const item of jobs) {
        if (!item || !JOB_ID_RE.test(String(item.jobId || '')) || !isAbsoluteCanvasPath(item.canvasFilePath)) {
          return { ok: false, code: 'invalid_arguments' };
        }
        unique.set(item.jobId, { jobId: item.jobId, canvasFilePath: item.canvasFilePath });
      }
      counts.releaseCalls++;
      // A bundle the app already discarded or pruned can never be answered. A
      // release that was in flight across that event (the manual sheet's confirm
      // dialog can stay open) must not resurrect a lane for it.
      for (const jobId of [...unique.keys()]) if (removedBundles.has(jobId)) unique.delete(jobId);
      if (unique.size === 0) return { ok: false, code: 'unknown_job' };
      const additions = [...unique.values()].filter(item => !lanes.some(lane => lane.jobId === item.jobId));
      if (lanes.filter(lane => !['done', 'gone'].includes(lane.phase)).length + additions.length > CONSTANTS.MAX_LANES) {
        return { ok: false, code: 'lane_limit' };
      }
      // Rollback is lane-precise: a save can fail while another release, an
      // Unrelease or a discard changes the list, so only what THIS call did is
      // undone. The lane ordinal is never rewound (ordinals may have gaps).
      const addedLanes = [];
      const adoptedPaths = [];
      const added = [];
      let adoptedPath = false;
      for (const item of unique.values()) {
        const existing = lanes.find(lane => lane.jobId === item.jobId);
        if (existing) {
          const adoption = adoptionResults.get(item.jobId);
          if (adoption && existing === adoption.lane && laneRevision(existing) === adoption.revision
              && existing.canvasFilePath === adoption.before) {
            existing.canvasFilePath = adoption.after;
            adoptedPaths.push({ lane: existing, before: adoption.before, after: adoption.after, revision: touchLane(existing) });
            adoptedPath = true;
          }
          continue;
        }
        added.push(item.jobId);
        const created = createApplicationLane({
          ord: ++laneOrdinal,
          jobId: item.jobId,
          canvasFilePath: item.canvasFilePath,
          releasedAt: safeNow(now),
          codeGuard,
        });
        addedLanes.push(created);
        lanes.push(created);
      }
      // Releasing a job that already has a lane changes nothing. It must not
      // persist, write an audit row, log a "release", count as human activity or
      // wake a poller: the renderer re-publishes every 30 s and auto-release used
      // to turn each keep-alive into a phantom release that also reset the idle
      // pause. A path adoption alone is still a durable change, so it persists,
      // but it is not a release.
      if (added.length === 0) {
        counts.releaseNoops++;
        if (!adoptedPath) return { ok: true, count: 0, added: [] };
      }
      // Saving is deliberately outside the mutation turn. Other callers can
      // stage their own changes while storage is slow; the completion below
      // serializes only this release's commit or lane-precise rollback.
      for (const lane of addedLanes) touchLane(lane);
      return {
        generation,
        persist: true,
        added,
        revisions: new Map(addedLanes.map(lane => [lane, laneRevision(lane)])),
        adoptedPaths,
      };
    });
    if (!staged?.persist) return staged;
    const saved = await persistLanes(staged.generation);
    const finished = await mutateLanes(() => {
      if (!sourceCurrent(staged.generation)) return { ok: false, code: 'not_ready' };
      if (!saved) {
        for (const [lane, revision] of staged.revisions) {
          if (laneRevision(lane) !== revision) continue;
          const at = lanes.indexOf(lane);
          if (at >= 0) {
            lanes.splice(at, 1);
            touchLane(lane);
          }
        }
        for (const path of staged.adoptedPaths) {
          if (!lanes.includes(path.lane) || laneRevision(path.lane) !== path.revision || path.lane.canvasFilePath !== path.after) continue;
          path.lane.canvasFilePath = path.before;
          touchLane(path.lane);
        }
        return { ok: false, code: 'persist_failed' };
      }
      if (staged.added.length > 0) {
        humanAction();
        auditEvent('release', { count: staged.added.length });
        log('release', { kind: 'application', count: staged.added.length });
        wake();
      }
      return { ok: true, count: staged.added.length, added: staged.added };
    });
    if (!saved) reconcileLanes(staged.generation);
    return finished;
  }

  // Removes one lane. `cause` is a closed enum: 'user' is the person's own
  // Unrelease (a human action); the others are the app noticing the bundle
  // itself stopped existing, which is bookkeeping, never human activity.
  async function removeLane(jobId, cause, { expectedLane = null, expectedRevision = null } = {}) {
    const staged = await mutateLanes(() => {
      const generation = sourceGeneration;
      if (!sourceCurrent(generation)) return { ok: false, code: 'not_ready' };
      const index = lanes.findIndex(lane => lane.jobId === jobId);
      if (index < 0) return { ok: false, code: 'not_found' };
      if (expectedLane && (lanes[index] !== expectedLane
          || (expectedRevision !== null && laneRevision(lanes[index]) !== expectedRevision))) {
        return { ok: false, code: 'not_found' };
      }
      const [lane] = lanes.splice(index, 1);
      const removedCodes = [];
      for (const [codeKey, entry] of codeIndex) {
        if (entry.lane !== lane) continue;
        removedCodes.push([codeKey, entry]);
        codeIndex.delete(codeKey);
      }
      const hadSlot = epoch?.assignedLaneOrds.delete(lane.ord) === true;
      const assignedWorkerId = lane.servedWorkerId;
      clearLaneWorkerAssignment(lane);
      clearLaneHint(lane);
      const revision = touchLane(lane);
      return { generation, lane, removedCodes, hadSlot, assignedWorkerId, cause, revision, persist: true };
    });
    if (!staged?.persist) return staged;
    const saved = await persistLanes(staged.generation);
    const finished = await mutateLanes(() => {
      const { generation, lane, removedCodes, hadSlot, assignedWorkerId } = staged;
      if (!sourceCurrent(generation)) return { ok: false, code: 'not_ready' };
      if (!saved) {
        // Only this lane goes back, and only if the job has no lane again: a
        // keep-alive release that ran during the save already owns the job.
        let rollbackRevision = null;
        if (reinstateLane(lane)) {
          for (const [codeKey, entry] of removedCodes) if (!codeIndex.has(codeKey)) codeIndex.set(codeKey, entry);
          if (hadSlot) epoch?.assignedLaneOrds.add(lane.ord);
          const owner = workerForId(epoch, assignedWorkerId);
          if (owner) owner.assignedLaneOrds.add(lane.ord);
          lane.servedWorkerId = assignedWorkerId || null;
          // An answer the app accepted while the lane was out was not applied to it.
          settleAcceptedElsewhere(lane);
          rollbackRevision = laneRevision(lane);
        }
        return { ok: false, code: 'persist_failed', revision: rollbackRevision };
      }
      // A retired handoff code must never be replayable as a fresh one.
      // When the app (not the person) retired the lane, a chat still holding
      // its code should hear "superseded", not look like a forged code.
      if (cause !== 'user' && lane.current?.code) {
        tombstoneCode(tombstones, lane.current.code, 'rotated', { laneOrd: lane.ord, at: safeNow(now) }, CONSTANTS.TOMBSTONES_PER_ENGINE, codeGuard);
      }
      if (cause === 'user') {
        counts.unreleaseCalls++;
        humanAction();
        auditEvent('unrelease');
        log('unrelease', { kind: 'application', count: 1 });
      } else {
        counts.lanesDropped++;
        const perCause = DROP_COUNTER[cause];
        if (perCause) counts[perCause]++;
        auditEvent('unrelease', { cause });
        log('unrelease', { kind: 'application', count: 1, cause });
      }
      wake();
      return { ok: true };
    });
    if (!saved) reconcileLanes(staged.generation);
    return finished;
  }

  async function unrelease(jobId) {
    return removeLane(jobId, 'user');
  }

  // The app tells the bridge its bundle was discarded or pruned. Only closed
  // causes are accepted, so nothing derived from job content can reach a log.
  async function dropLane(jobId, cause = 'bundle_discarded') {
    const safeCause = ['bundle_discarded', 'bundle_pruned', 'bundle_missing', 'bundle_saved'].includes(cause) ? cause : 'bundle_discarded';
    await mutateLanes(() => {
      if ((safeCause === 'bundle_discarded' || safeCause === 'bundle_pruned') && typeof jobId === 'string') {
        removedBundles.delete(jobId);
        removedBundles.add(jobId);
        while (removedBundles.size > REMOVED_BUNDLES_CAP) removedBundles.delete(removedBundles.values().next().value);
      }
    });
    return removeLane(jobId, safeCause);
  }

  async function hold(jobId, reason = 'user_hold') {
    const staged = await mutateLanes(() => {
      const lane = lanes.find(item => item.jobId === jobId);
      if (!lane) return { ok: false, code: 'not_found' };
      const targetPhase = ['job_broken', 'render_retry', 'app_fix_required', 'canvas_unavailable', 'read_failed', 'write_failed', 'submit_stuck', 'host_silent'].includes(reason)
        ? 'needs_user'
        : 'held';
      // An identical later hold is a no-op, rather than a second optimistic
      // transaction with an indistinguishable marker (an ABA rollback hazard).
      if (lane.phase === targetPhase && lane.reason === reason) return { ok: true };
      const prior = {
        phase: lane.phase,
        reason: lane.reason,
        heldFrom: lane.heldFrom,
        snapshot: lane.snapshot,
        changedAt: lane.changedAt,
        awaitingAnswer: lane.awaitingAnswer,
        servedAt: lane.servedAt,
        lastServedDigest: lane.lastServedDigest,
        servedCodeAgain: lane.servedCodeAgain,
      };
      const heldCurrent = lane.current;
      const heldAnsweredAt = lane.answeredAt;
      try { holdLane(lane, reason, safeNow(now)); }
      catch { return { ok: false, code: 'invalid_arguments' }; }
      return { generation: sourceGeneration, lane, prior, heldCurrent, heldAnsweredAt, phase: lane.phase, reason: lane.reason, revision: touchLane(lane), persist: true };
    });
    if (!staged?.persist) return staged;
    const saved = await persistLanes(staged.generation);
    const finished = await mutateLanes(() => {
      const { lane, prior, heldCurrent, heldAnsweredAt } = staged;
      if (!sourceCurrent(staged.generation)) return { ok: false, code: 'not_ready' };
      if (!saved) {
        // An answer the app accepted (or a rotated code it returned) while the
        // save ran already replaced the lane's handoff: the serve bookkeeping
        // that was cleared belongs to the OLD prompt and must not come back.
        // A later lane transition owns its own state and must not be rolled
        // back by this failed save.
        // A source acceptance may change the handoff while deliberately
        // retaining this hold marker. Only that exact marker still belongs to
        // this operation; a later Hold/Resume/drop must win even if it also
        // changed the lane revision.
        if (!lanes.includes(lane) || lane.phase !== staged.phase || lane.reason !== staged.reason) {
          return { ok: false, code: 'persist_failed' };
        }
        const landed = lane.current !== heldCurrent || lane.answeredAt !== heldAnsweredAt;
        if (laneRevision(lane) !== staged.revision && !landed) return { ok: false, code: 'persist_failed' };
        const { awaitingAnswer, servedAt, lastServedDigest, servedCodeAgain, ...marker } = prior;
        Object.assign(lane, marker);
        if (landed) {
          if (!lane.current && ['awaiting', 'host'].includes(lane.phase)) setPhase(lane, 'unread');
        } else Object.assign(lane, { awaitingAnswer, servedAt, lastServedDigest, servedCodeAgain });
        touchLane(lane);
        return { ok: false, code: 'persist_failed' };
      }
      humanAction();
      wake();
      return { ok: true };
    });
    if (!saved) reconcileLanes(staged.generation);
    return finished;
  }

  async function resume({ jobId } = {}) {
    const staged = await mutateLanes(() => {
      if (jobId) {
        const lane = lanes.find(item => item.jobId === jobId);
        if (!lane) return { ok: false, code: 'not_found' };
        // Only a held lane has anything to resume. A stale or repeated click on a
        // lane that is already running must not restart its quiet clock and hide a
        // real stall.
        if (!isHeldPhase(lane)) return { ok: true };
        const prior = {
          phase: lane.phase,
          reason: lane.reason,
          heldFrom: lane.heldFrom,
          snapshot: lane.snapshot,
          changedAt: lane.changedAt,
        };
        resumeLane(lane);
        // The time held was time ChatGPT could not have answered in.
        lane.quietFrom = safeNow(now);
        lane.changedAt = lane.quietFrom;
        if (!lane.current && ['awaiting', 'host'].includes(lane.phase)) setPhase(lane, 'unread');
        return { generation: sourceGeneration, lane, prior, phase: lane.phase, reason: lane.reason, revision: touchLane(lane), persist: true };
      } else {
        paused = false;
        pauseCause = null;
        // A pause turns ChatGPT's calls away: no lane's quiet time includes it.
        const resumedAt = safeNow(now);
        for (const lane of lanes) {
          lane.quietFrom = resumedAt;
          touchLane(lane);
        }
        for (const worker of epochWorkers()) worker.quietFrom = resumedAt;
        return { bridge: true };
      }
    });
    if (staged?.persist) {
      const saved = await persistLanes(staged.generation);
      const finished = await mutateLanes(() => {
        if (!sourceCurrent(staged.generation)) return { ok: false, code: 'not_ready' };
        if (!saved) {
          // A later hold, source result, or drop has already superseded this
          // resume. Its state is authoritative.
          if (lanes.includes(staged.lane) && laneRevision(staged.lane) === staged.revision) {
            Object.assign(staged.lane, staged.prior);
            touchLane(staged.lane);
          }
          return { ok: false, code: 'persist_failed' };
        }
        humanAction();
        auditEvent('resume', { cause: 'lane' });
        log('resume', { cause: 'lane' });
        wake();
        return { ok: true };
      });
      if (!saved) reconcileLanes(staged.generation);
      return finished;
    }
    if (!staged?.bridge) return staged;
    return mutateLanes(() => {
      humanAction();
      auditEvent('resume', { cause: 'bridge' });
      log('resume', { cause: 'bridge' });
      wake();
      return { ok: true };
    });
  }

  function pause(cause = 'user') {
    // A revoked link or a quitting app ends any chance of re-copying the
    // starter: drop the plaintext now rather than at the next rotation.
    if ((cause === 'revoked' || cause === 'quit') && epoch) {
      for (const worker of epochWorkers(epoch)) worker.starterKey = null;
    }
    if (cause === 'revoked') {
      // The link is gone (unpaired). Forget every ended chat, in memory and on
      // disk, and stop the live chat from re-entering the ledger when it is
      // retired: after an unpair a stale key reads as unrecognised again.
      if (epoch) for (const worker of epochWorkers(epoch)) worker.endedDigest = null;
      for (const retired of retiredEpochs) retired.digest = null;
      const had = ledger.length > 0;
      pruneLedger({ all: true });
      if (had) persistLedger();
    }
    paused = true;
    pauseCause = cause;
    counts.pauses++;
    auditEvent('pause', { cause });
    log('pause', { cause: LOG_PAUSE_CAUSES.has(cause) ? cause : 'user' });
    wake();
    return { ok: true };
  }

  function hint({ jobId } = {}) {
    const generation = sourceGeneration;
    if (!sourceCurrent(generation)) return false;
    const lane = lanes.find(item => item.jobId === jobId);
    if (!lane || ['done', 'gone'].includes(lane.phase)) return false;
    const stamp = safeNow(now);
    const last = lastHintAt.get(lane.ord) ?? -Infinity;
    const invalidate = () => {
      void mutateLanes(() => {
        if (!sourceCurrent(generation) || !lanes.includes(lane) || ['done', 'gone'].includes(lane.phase)) {
          clearLaneHint(lane);
          return;
        }
        lastHintAt.set(lane.ord, safeNow(now));
        hintTimers.delete(lane.ord);
        lane.snapshot = null;
        // Every live lane is flagged, not only an awaiting one: a lane held while
        // awaiting comes back awaiting on Resume, and the person may have advanced
        // its stage by pasting in the meantime, so it must re-read before it is
        // served again. The flag can outlive its use on a host or finished lane;
        // laneBusy() is what stops that stale flag counting as pending work.
        lane.needsRefresh = true;
        touchLane(lane);
        // A get that is waiting is woken and probes this lane itself. With none
        // waiting (ChatGPT was told to stop, or is busy elsewhere) nothing else
        // will, and a saved job would read as "the app is saving this" until
        // ChatGPT is prodded: probe the host lane once, in the background. The
        // per-lane in-flight slot makes this at most one probe per lane, the
        // hint throttle bounds how often it can start, and a stale source
        // generation drops the result.
        const probeHost = lane.phase === 'host' && waiters.size === 0 && !closed && scope.applications
          && !lane.inFlight.status && !lane.inFlight.read;
        wake();
        if (probeHost) void statusLane(lane, { generation }).catch(() => undefined);
      });
    };
    if (stamp - last >= CONSTANTS.HINT_MIN_INTERVAL_MS) invalidate();
    else if (!hintTimers.has(lane.ord)) {
      const timer = timers.setTimeout?.(invalidate, CONSTANTS.HINT_MIN_INTERVAL_MS - (stamp - last));
      timer?.unref?.();
      hintTimers.set(lane.ord, timer);
    }
    return true;
  }

  function restoreNow(values = []) {
    if (!Array.isArray(values)) return 0;
    for (const value of values) {
      try {
        // A finished or vanished lane has nothing left to serve; restoring it
        // as a held 'restart' lane made the person Resume a dead job.
        if (['done', 'gone'].includes(value?.phase)) continue;
        const lane = rehydrateApplicationLane(value, safeNow(now));
        if (lanes.some(existing => existing.ord === lane.ord || existing.jobId === lane.jobId)) continue;
        lane.restoreProbes = RESTORE_PROBE_ATTEMPTS;
        lane.restoreProbeAt = 0;
        lanes.push(lane);
        laneOrdinal = Math.max(laneOrdinal, lane.ord);
        touchLane(lane);
      } catch { /* unknown/corrupt lanes are skipped */ }
    }
    restartConfirmed = lanes.length === 0;
    restartRevision += 1;
    return lanes.length;
  }

  // Construction calls restoreNow before the engine is exposed. Public restore
  // keeps its numeric synchronous contract: a reentrant caller joins the
  // current synchronous mutation turn (there is no async queue callback).
  function restore(values = []) {
    let restored = 0;
    const before = laneStateVersion;
    if (laneMutationRunning) {
      restored = restoreNow(values);
      const added = laneStateVersion > before;
      void Promise.resolve().then(() => {
        if (added && lanes.some(lane => restoreProbeDue(lane, safeNow(now)))) return probeRestoredLanes(sourceGeneration, { rescan: true });
        return undefined;
      }).catch(() => undefined);
      return restored;
    }
    void mutateLanes(() => { restored = restoreNow(values); });
    if (laneStateVersion > before && lanes.some(lane => restoreProbeDue(lane, safeNow(now)))) {
      void probeRestoredLanes(sourceGeneration, { rescan: true }).catch(() => undefined);
    }
    return restored;
  }

  function snapshot() {
    const queue = remainingCounts(lanes);
    let pushState = { served: 0, held: 0, selectedHubs: 0, optedOutHubs: 0, working: 0, needsYou: 0 };
    try {
      if (push?.status) pushState = { ...pushState, ...push.status(pushEpochId()) };
    } catch { /* status is advisory and must never break the control plane */ }
    const stamp = safeNow(now);
    const stallsNow = noteStalls(stamp);
    // The lane a chat is being waited on for: a stalled one first, otherwise the
    // first served to THIS chat with no accepted answer since.
    const outstandingLane = lanes.find(lane => laneStall(lane, stamp)) ?? lanes.find(laneAwaitingAnswer);
    const outstandingStall = outstandingLane ? laneStall(outstandingLane, stamp) : null;
    const applications = {
      ready: lanes.filter(lane => lane.phase === 'awaiting').length,
      working: lanes.filter(lane => ['unread', 'host'].includes(lane.phase)).length,
      needsYou: lanes.filter(lane => ['held', 'needs_user'].includes(lane.phase)).length,
      held: lanes.filter(lane => lane.phase === 'held').length,
      done: lanes.filter(lane => ['done', 'gone'].includes(lane.phase)).length,
    };
    const safeSelectedHubs = Array.isArray(pushState.selectedHubs)
      ? pushState.selectedHubs.filter(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)).slice(0, 50)
      : [];
    // Opaque UUIDs correlate a renderer's own pending handoff with a live
    // bridge claim. They carry no request id/code/content and are not an
    // authority surface (all bridge submission remains main-process gated).
    const safePushClaims = Array.isArray(pushState.claimed)
      ? pushState.claimed.filter(value => typeof value === 'string' && JOB_ID_RE.test(value)).slice(0, 100)
      : [];
    const safePushClaimSet = new Set(safePushClaims);
    const safePushClaimWorkers = Array.isArray(pushState.claimWorkers)
      ? pushState.claimWorkers.flatMap(item => {
        if (!item || typeof item !== 'object' || typeof item.claimId !== 'string' || !JOB_ID_RE.test(item.claimId)
            || !safePushClaimSet.has(item.claimId) || !Number.isInteger(item.workerOrdinal)
            || item.workerOrdinal < 1 || item.workerOrdinal > MAX_WORKER_POOL_SIZE) return [];
        return [Object.freeze({ claimId: item.claimId, workerOrdinal: item.workerOrdinal })];
      }).slice(0, 100)
      : [];
    // Same opaque, renderer-only correlation token as `claimed`, but for a
    // selected eligible handoff that has not been delivered to a chat yet.
    // It is deliberately never copied into reports or tool responses.
    const safePushAvailable = Array.isArray(pushState.available)
      ? pushState.available.filter(value => typeof value === 'string' && JOB_ID_RE.test(value)).slice(0, 100)
      : [];
    const pushDiscovered = pushDiscoveryCurrent && ownsPushDiscovery() && Array.isArray(pushState.discovered) ? pushState.discovered : [];
    const pushTasks = new Map();
    const safeDiscoveredHubs = [];
    let discoveredPending = 0;
    for (const hub of pushDiscovered) {
      if (typeof hub?.key !== 'string' || !/^[a-f0-9]{64}$/.test(hub.key) || safeDiscoveredHubs.length >= 50) continue;
      const tasks = [];
      for (const task of Array.isArray(hub?.tasks) ? hub.tasks : []) {
        if (!STATUS_PUSH_TASKS.has(task?.task)) continue;
        const pending = Number.isSafeInteger(task.pending) ? Math.max(0, task.pending) : 0;
        tasks.push(Object.freeze({ task: task.task, pending }));
        pushTasks.set(task.task, (pushTasks.get(task.task) || 0) + pending);
      }
      const excluded = {};
      for (const reason of PUSH_EXCLUSION_REASONS) {
        excluded[reason] = Number.isSafeInteger(hub?.excluded?.[reason]) ? Math.max(0, hub.excluded[reason]) : 0;
      }
      safeDiscoveredHubs.push(Object.freeze({
        key: hub.key,
        pending: Number.isSafeInteger(hub.pending) ? Math.max(0, hub.pending) : 0,
        tasks: Object.freeze(tasks),
        excluded: Object.freeze(excluded),
      }));
      discoveredPending += Number.isSafeInteger(hub.pending) ? Math.max(0, hub.pending) : 0;
    }
    const rawPushDiagnostics = pushState.diagnostics && typeof pushState.diagnostics === 'object' ? pushState.diagnostics : {};
    const pushDiagnosticCount = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(999999, value) : 0;
    const pushDiagnosticTime = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const safePush = Object.freeze({
      selectedHubs: Object.freeze(safeSelectedHubs),
      optedOutHubs: pushDiagnosticCount(pushState.optedOutHubs),
      discovered: Object.freeze(safeDiscoveredHubs),
      claimed: Object.freeze(safePushClaims),
      claimWorkers: Object.freeze(safePushClaimWorkers),
      available: Object.freeze(safePushAvailable),
      // Aggregate ownership is report-safe; individual opaque claim UUIDs
      // remain available only to the renderer so its own dock row can hide.
      served: pushDiagnosticCount(pushState.served),
      held: pushDiagnosticCount(pushState.held),
      diagnostics: Object.freeze({
        refreshAttempts: pushDiagnosticCount(rawPushDiagnostics.refreshAttempts),
        refreshFailures: pushDiagnosticCount(rawPushDiagnostics.refreshFailures),
        lastRefreshAt: pushDiagnosticTime(rawPushDiagnostics.lastRefreshAt),
        lastRefreshOk: rawPushDiagnostics.lastRefreshOk === true ? true : rawPushDiagnostics.lastRefreshOk === false ? false : null,
        selectedPolls: pushDiagnosticCount(rawPushDiagnostics.selectedPolls),
        selectedPollFailures: pushDiagnosticCount(rawPushDiagnostics.selectedPollFailures),
        lastSelectedPollAt: pushDiagnosticTime(rawPushDiagnostics.lastSelectedPollAt),
        lastSelectedPollOk: rawPushDiagnostics.lastSelectedPollOk === true ? true : rawPushDiagnostics.lastSelectedPollOk === false ? false : null,
        exclusions: Object.freeze(Object.fromEntries(PUSH_EXCLUSION_REASONS.map(reason => [reason, pushDiagnosticCount(rawPushDiagnostics.exclusions?.[reason])]))),
        exclusionScope: rawPushDiagnostics.exclusionScope === 'all' || rawPushDiagnostics.exclusionScope === 'selected' ? rawPushDiagnostics.exclusionScope : 'none',
      }),
    });
    // A pool is one logical chat generation in the renderer, but each
    // starter has its own request/byte counters. Project the aggregate here
    // so a quiet primary worker cannot make nine actively serving workers look
    // like an untouched or full single chat.
    const statusWorkers = epochWorkers(epoch);
    const chatCalls = statusWorkers.reduce((total, worker) => total + Math.max(0, Number(worker?.calls) || 0), 0);
    const firstWorkerCallAt = statusWorkers.reduce((earliest, worker) => {
      const stamp = worker?.firstCallAt;
      return Number.isFinite(stamp) && stamp >= 0 && (earliest === null || stamp < earliest) ? stamp : earliest;
    }, null);
    const lastWorker = statusWorkers.reduce((latest, worker) => {
      const stamp = worker?.lastCallAt;
      if (!Number.isFinite(stamp) || stamp < 0) return latest;
      return !latest || stamp > latest.stamp ? { worker, stamp } : latest;
    }, null);
    const allWorkersAtHardBudget = statusWorkers.length > 0 && statusWorkers.every(worker => atHardByteBudget(worker));
    const anyWorkerStillServing = statusWorkers.some(worker => worker?.idleSince == null);
    const anyWorkerPresented = statusWorkers.some(worker => worker?.presented === true);
    const chatState = !epoch
      ? 'none'
      : allWorkersAtHardBudget
        ? 'full'
        : chatCalls === 0
          ? (anyWorkerPresented ? 'reached' : 'awaiting-first-call')
          : anyWorkerStillServing ? 'working' : 'idle';
    // A legacy primary can retain an older bookkeeping reference while a
    // sibling owns the live lane. Count the lane ordinals, not the worker-set
    // sizes, so diagnostics never inflate a pool's application assignments.
    const assignedLaneOrdinals = new Set();
    for (const worker of statusWorkers) {
      if (!(worker?.assignedLaneOrds instanceof Set)) continue;
      for (const ordinal of worker.assignedLaneOrds) if (Number.isInteger(ordinal) && ordinal > 0) assignedLaneOrdinals.add(ordinal);
    }
    const jobsAssigned = assignedLaneOrdinals.size;
    const chatBytesServed = statusWorkers.reduce((total, worker) => total + Math.max(0, Number(worker?.bytesServed) || 0), 0);
    const chatBytesReceived = statusWorkers.reduce((total, worker) => total + Math.max(0, Number(worker?.bytesReceived) || 0), 0);
    // This is deliberately only a process-local correlation identity for the
    // renderer. It lets a permanently mounted panel prove that its local
    // worker controls still name the live pool after Disable/re-enable or a
    // drained epoch, without exposing any worker capability or prompt.
    const activePool = epoch?.poolStarted === true;
    const poolGeneration = activePool && Number.isSafeInteger(epoch?.poolGeneration) && epoch.poolGeneration > 0
      ? epoch.poolGeneration
      : null;
    const workerCount = poolGeneration === null ? 0 : poolWorkerCount(epoch);
    const poolPlan = poolGeneration === null
      ? { recommended: 0, queued: 0, materialized: 0, expandBy: 0, reason: 'empty', expansionCount: 0, lastExpansionAt: null, lastExpansionAdded: 0 }
      : (() => {
        const planned = epoch?.poolRecommendation || workerPoolRecommendation(MAX_WORKER_POOL_SIZE);
        const recommended = Math.max(0, Math.min(MAX_WORKER_POOL_SIZE, Number.isInteger(planned?.recommended) ? planned.recommended : workerCount));
        const queued = Math.max(0, Math.min(MAX_WORKER_POOL_PLANNING_UNITS, Number.isInteger(planned?.queued) ? planned.queued : 0));
        const materialized = Math.max(0, Math.min(MAX_WORKER_POOL_PLANNING_UNITS, Number.isInteger(planned?.materialized) ? planned.materialized : queued));
        const expandBy = Math.max(0, recommended - workerCount);
        const reason = ['empty', 'one_work_item', 'maximum_parallelism', 'preserved_live_workers'].includes(planned?.reason)
          ? planned.reason
          : 'empty';
        const expansion = epoch?.poolExpansion || {};
        return {
          recommended, queued, materialized, expandBy, reason,
          expansionCount: Math.max(0, Number.isInteger(expansion.count) ? expansion.count : 0),
          lastExpansionAt: statusTime(expansion.at),
          lastExpansionAdded: Math.max(0, Number.isInteger(expansion.added) ? expansion.added : 0),
        };
      })();
    const workerRoster = poolGeneration === null
      ? []
      : statusWorkers
        .filter(worker => Number.isInteger(worker?.workerOrdinal)
          && worker.workerOrdinal >= 1 && worker.workerOrdinal <= workerCount)
        .sort((left, right) => left.workerOrdinal - right.workerOrdinal)
        .map(worker => {
          const hasOutstandingApplication = lanes.some(lane => laneAwaitingAnswer(lane, worker));
          const pollingAfterWait = workerIsPollingAfterWait(worker, hasOutstandingApplication);
          // A restarted worker is only copyable again when the protected
          // main-process clipboard write failed and abandoned its reserved
          // starter.  A successfully copied restart remains `ready`, just
          // like every other one-time starter, so a status refresh cannot
          // invite a second, invalid copy attempt.
          const state = worker.restartPending === true
            ? (worker.starterExported === true ? 'ready' : 'available')
            : worker.idleSince != null
            ? 'idle'
            : workerIsQuiet(worker, stamp)
              ? 'quiet'
              : worker.activeTask === true || (worker.getInFlight != null && !pollingAfterWait) || hasOutstandingApplication
              ? 'working'
              : worker.presented === true || worker.calls > 0
                ? 'waiting'
                : worker.starterExported === true
                  ? 'ready'
                  : 'available';
          return Object.freeze({
            ordinal: worker.workerOrdinal,
            state,
            completed: Math.max(0, Number.isSafeInteger(worker.completed) ? worker.completed : 0),
            firstCallAt: statusTime(worker.firstCallAt),
            lastCallAt: statusTime(worker.lastCallAt),
            lastCallKind: ['get', 'submit'].includes(worker.lastCallKind) ? worker.lastCallKind : null,
            lastOutcome: ['served', 'waiting', 'queue_empty', 'paused', 'session_full', 'needs_user', 'retry', 'accepted', 'rejected', 'held', 'unknown_handoff', 'session_ended'].includes(worker.lastOutcome) ? worker.lastOutcome : null,
            lastOutcomeAt: statusTime(worker.lastOutcomeAt),
            quietReason: state === 'quiet' ? workerQuietReason(worker, stamp) : null,
            restarts: Math.max(0, Number.isSafeInteger(worker.restarts) ? worker.restarts : 0),
          });
        });
    const keyStamp = safeNow(now);
    return Object.freeze({
      paused,
      pauseCause,
      fault,
      autoStart: autoStart === true,
      // Diagnostics only: chat keys the engine did not recognise. Counts and a
      // time, never any key text.
      keys: Object.freeze({
        unrecognisedRecent: badKeyTimes.filter(time => keyStamp - time <= BAD_KEY_WINDOW_MS).length,
        unrecognisedWindowMinutes: BAD_KEY_WINDOW_MS / 60_000,
        lastUnrecognisedAt: statusTime(lastBadKeyAt),
        ended: endedKeyCount,
      }),
      chat: Object.freeze({
        ordinal: epoch?.n ?? 0,
        startedAt: statusTime(epoch?.mintedAt),
        firstCallAt: statusTime(firstWorkerCallAt),
        lastCallAt: statusTime(lastWorker?.stamp),
        lastCallKind: ['get', 'submit'].includes(lastWorker?.worker?.lastCallKind) ? lastWorker.worker.lastCallKind : null,
        calls: Number.isSafeInteger(chatCalls) ? chatCalls : 0,
        state: chatState,
        jobsAssigned,
        jobsCap: limits.jobsPerChat,
          pool: Object.freeze({
            active: poolGeneration !== null && workerCount > 0,
            generation: poolGeneration,
            workerCount,
            workers: Object.freeze(workerRoster),
            plan: Object.freeze(poolPlan),
            history: Object.freeze(closedPoolHistory.slice(-3)),
          }),
        bytesServed: chatBytesServed,
        bytesReceived: chatBytesReceived,
        outstanding: outstandingLane ? Object.freeze({
          servedAt: statusTime(outstandingLane.servedAt),
          kind: 'application',
          stage: statusStage(outstandingLane.current?.stage),
          task: null,
          stalled: outstandingStall !== null,
          stalledSince: outstandingStall ? statusTime(outstandingStall.anchor) : null,
          stallsLastHour: Math.min(stallsNow, 999),
        }) : null,
        servedTwice: outstandingLane?.servedCodeAgain === true,
        previous: Object.freeze(retiredEpochs.slice(-5).map(item => Object.freeze({
          ordinal: Number.isInteger(item.n) && item.n > 0 ? item.n : 0,
          endedAt: statusTime(item.endedAt),
          reason: item.reason === 'continued' || item.reason === 'rotated'
            ? 'replaced'
            : item.reason === 'link_changed'
              ? 'link_changed'
              : item.reason === 'drained'
                ? 'queue_empty'
                : item.reason === 'source_ended'
                  ? 'source_ended'
                : 'disabled',
        }))),
      }),
      queue: Object.freeze({
        ...queue,
        applications: Object.freeze(applications),
        scoring: Object.freeze({
          pending: discoveredPending,
          withChat: Number.isSafeInteger(pushState.served) ? Math.max(0, pushState.served) : 0,
          tasks: Object.freeze([...pushTasks].map(([task, pending]) => Object.freeze({ task, pending }))),
        }),
        push: safePush,
        jobs: Object.freeze(lanes.map(lane => {
          const stall = laneStall(lane, stamp);
          return Object.freeze({
            jobId: JOB_ID_RE.test(lane.jobId) ? lane.jobId : null,
            phase: statusPhase(lane.phase),
            stage: statusStage(lane.current?.stage),
            reason: statusReason(lane.reason),
            servedToChat: epoch?.assignedLaneOrds.has(lane.ord) ? epoch.n : null,
            workerOrdinal: (() => {
              const worker = workerForId(epoch, lane.servedWorkerId);
              return Number.isInteger(worker?.workerOrdinal) && worker.workerOrdinal >= 1
                && worker.workerOrdinal <= MAX_WORKER_POOL_SIZE ? worker.workerOrdinal : null;
            })(),
            changedAt: statusTime(lane.changedAt ?? lane.releasedAt),
            // Per-job answer tracking, all for the CURRENT chat only.
            // Silence becomes an ambiguity warning only after the owning
            // worker's closed answer_silent recovery state; it never proves a
            // slow answer failed or revokes its ownership.
            servedAt: epoch && lane.servedEpochN === epoch.n && lane.phase === 'awaiting' ? statusTime(lane.servedAt) : null,
            answeredAt: statusTime(lane.answeredAt),
            awaitingAnswer: laneAwaitingAnswer(lane),
            stalled: stall !== null,
            stalledSince: stall ? statusTime(stall.anchor) : null,
          });
        })),
      }),
      push: safePush,
      counts: Object.freeze({ ...counts }),
    });
  }

  function debugState() {
    return Object.freeze({ submitActive: semaphore.active(), submitWaiting: semaphore.waiting(), waiters: waiters.size });
  }

  // Main-process-only confirmation port. This deliberately never appears in
  // snapshot/status: canvas paths are private source material, not bridge UI.
  function restartJobs(ords = []) {
    const requested = new Set(Array.isArray(ords) ? ords.filter(value => Number.isInteger(value) && value > 0) : []);
    // Enable confirmation asks with no explicit ords; that safely means every
    // restored/released lane, while malformed non-array input means none.
    const include = Array.isArray(ords) && requested.size === 0 ? () => true : lane => requested.has(lane.ord);
    return Object.freeze(lanes.filter(lane => include(lane) && JOB_ID_RE.test(lane.jobId) && isAbsoluteCanvasPath(lane.canvasFilePath))
      .map(lane => Object.freeze({ ord: lane.ord, jobId: lane.jobId, canvasFilePath: lane.canvasFilePath })));
  }

  // Another private composition port for the optional power policy. It exposes
  // only path membership and time, never into status or an IPC reply.
  function powerState() {
    return Object.freeze({
      hostCanvasPaths: Object.freeze(lanes.filter(lane => lane.phase === 'host' && isAbsoluteCanvasPath(lane.canvasFilePath)).map(lane => lane.canvasFilePath)),
      // Awaiting work keeps the Mac awake too, but has no renderer throttle
      // override.  This remains a private boolean rather than a status field.
      awaiting: lanes.some(lane => lane.phase === 'awaiting'),
      lastCallAt: statusTime(epoch?.lastCallAt),
    });
  }

  function onPowerResume() {
    if (closed) return false;
    invalidateSourceWork();
    // Discard every pre-sleep result/cache before fresh status reads begin.
    // The external application call may still finish, but its completion can
    // no longer alter this epoch.
    wake();
    return true;
  }

  function setLimits(next) {
    limits = normalizeLimits({ ...limits, ...next });
    return { ...limits };
  }

  function setScope(next) {
    const updated = normalizeScope(next);
    if (updated.applications === scope.applications && updated.scoring === scope.scoring
        && updated.marketplace === scope.marketplace) return { ...scope };
    scope = updated;
    // Source polling must use the same consent boundary as framePushGet. This
    // also releases any already-served task that a scope downgrade handed
    // back to the dock before it can suppress its paste controls.
    try { push?.setAllowedTasks?.(pushAllowedTasks()); } catch { /* source port is optional */ }
    // Scope changes are an exposure boundary just like sleep/Disable. Discard
    // every pre-change result before it can populate a cache or frame a push
    // successor under the newly lowered scope.
    invalidateSourceWork();
    if (!scope.scoring && !scope.marketplace) {
      try { push?.closeEpoch?.(pushEpochId()); } catch { /* selected hubs remain process-local */ }
    }
    wake();
    return { ...scope };
  }

  function selectPushHub(value) {
    if (!scope.scoring && !scope.marketplace) return false;
    try { return push?.selectHub?.(value) === true; } catch { return false; }
  }

  async function selectPushHubKey(value) {
    const generation = sourceGeneration;
    if ((!scope.scoring && !scope.marketplace) || !sourceCurrent(generation) || !ownsPushDiscovery()) return false;
    try {
      // The production source is synchronous today, but keep this boundary
      // safe for a delayed seam implementation too. A selection that finishes
      // after Disable/close must be undone on the old source rather than
      // silently recreating exposure after clearPushHubs().
      const selected = await Promise.resolve(push?.selectHubKey?.(value));
      if (!sourceCurrent(generation) || !ownsPushDiscovery()) {
        try { await Promise.resolve(push?.unselectHubKey?.(value)); } catch { /* close remains fail-closed */ }
        return false;
      }
      return selected === true;
    } catch { return false; }
  }

  async function unselectPushHubKey(value) {
    try { return await Promise.resolve(push?.unselectHubKey?.(value)) === true; } catch { return false; }
  }

  async function refreshPushHubs() {
    const generation = sourceGeneration;
    if ((!scope.scoring && !scope.marketplace) || !sourceCurrent(generation) || !ownsPushDiscovery()) return false;
    try {
      const refreshed = await push?.refreshHubs?.({ owner: pushOwner });
      if (!sourceCurrent(generation) || !ownsPushDiscovery()) {
        // Do not clear the shared push source: a replacement engine may have
        // refreshed it since this old call began. Its stale rows remain
        // invisible through this instance's ownership/freshness fence.
        if (ownsPushDiscovery()) pushDiscoveryCurrent = false;
        return false;
      }
      pushDiscoveryCurrent = refreshed === true;
      return refreshed === true;
    } catch {
      if (!sourceCurrent(generation) || !ownsPushDiscovery()) pushDiscoveryCurrent = false;
      return false;
    }
  }

  function clearPushHubs(value) {
    try { push?.clearHubs?.(value); return true; } catch { return false; }
  }

  function prunePushHubs() {
    try { push?.pruneHubs?.(); return true; } catch { return false; }
  }

  async function close() {
    sourceGeneration += 1;
    closed = true;
    pushDiscoveryCurrent = false;
    verdicts.clear();
    pushVerdicts.clear();
    retireEpoch('closed');
    clearPushHubs();
    await mutateLanes(() => {
      for (const lane of lanes) {
        lane.inFlight.read = null;
        lane.inFlight.status = null;
        lane.inFlight.submit = null;
        lane.retained = null;
        touchLane(lane);
      }
    });
    for (const timer of hintTimers.values()) clearTimer(timer);
    hintTimers.clear();
    semaphore.close();
    wake();
  }

  restoreNow(restoredLanes);
  if (lanes.some(lane => restoreProbeDue(lane, safeNow(now)))) void probeRestoredLanes().catch(() => undefined);
  loadLedger();

  return Object.freeze({
    get,
    submit,
    tick,
    release,
    unrelease,
    dropLane,
    hold,
    resume,
    pause,
    newChat,
    continueChat,
    startWorkerPool,
    copyWorkerStarter,
    abandonWorkerStarter,
    restartWorker,
    notePresented,
    noteLink,
    prepareChat,
    hint,
    restore,
    snapshot,
    status: snapshot,
    debugState,
    restartJobs,
    powerState,
    onPowerResume,
    setLimits,
    setScope,
    selectPushHub,
    selectPushHubKey,
    unselectPushHubKey,
    refreshPushHubs,
    clearPushHubs,
    prunePushHubs,
    close,
  });
}

export default createHandoffEngine;
