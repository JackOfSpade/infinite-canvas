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
  PUSH_INSTRUCTIONS,
  REJECTED_CAUTION,
  RESULT_NOTES,
  supersededStageNote,
} from './framing.js';

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
const STATUS_STAGES = new Set(['evidence-plan', 'resume', 'cover-letter', 'review']);
const STATUS_PHASES = new Set(['unread', 'awaiting', 'host', 'done', 'needs_user', 'held', 'gone']);
const STATUS_REASONS = new Set([
  'user_hold', 'human_advance', 'rejection_cap', 'junk_cap', 'review_round_cap',
  'job_broken', 'render_retry', 'canvas_unavailable', 'read_failed', 'write_failed',
  'submit_stuck', 'host_silent', 'lapsed', 'restart',
]);
// Closed drop cause -> the per-cause counter it increments.
const DROP_COUNTER = Object.freeze({
  bundle_discarded: 'droppedDiscarded', bundle_pruned: 'droppedPruned', bundle_missing: 'droppedMissing', bundle_saved: 'droppedSaved',
});
const LOG_EPOCH_CAUSES = new Set(['continued', 'rotated', 'drained', 'closed']);
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
  // Standalone engine users predate the persisted scope preference and retain
  // the complete source surface by default. Composition always synchronizes
  // the explicit config (whose scoring default is false) before serving.
  // marketplace has no such legacy: it is a consent boundary that must never
  // default on, so an unspecified value stays off even for a standalone
  // engine, unlike applications/scoring.
  return Object.freeze({
    applications: value?.applications !== false,
    scoring: value?.scoring !== false,
    marketplace: value?.marketplace === true,
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
  }
  const ownsPushDiscovery = () => !pushOwner || PUSH_DISCOVERY_OWNERS.get(push) === pushOwner;

  let limits = normalizeLimits(initialLimits);
  // Scope is an engine-owned serving fence, rather than a UI-only release
  // preference.  It is checked immediately before every source call so an
  // already-released lane or selected hub cannot survive a scope downgrade.
  let scope = normalizeScope(initialScope);
  const lanes = [];
  const codeIndex = new Map();
  const tombstones = new Map();
  const verdicts = new Map();
  const pushVerdicts = new Map();
  const retiredEpochs = [];
  const badKeyTimes = [];
  const waiters = new Set();
  const hintTimers = new Map();
  const lastHintAt = new Map();
  const semaphore = makeSemaphore(CONSTANTS.SUBMIT_CONCURRENCY);
  let epoch = null;
  let epochOrdinal = 0;
  let reservedEpochOrdinal = 0;
  let laneOrdinal = 0;
  let paused = false;
  let pauseCause = null;
  let closed = false;
  let restartConfirmed = restoredLanes.length === 0;
  let lastHumanActionAt = safeNow(now);
  let lastIdleNoticeAt = 0;
  let fault = null;
  let lastGetAt = null;
  let restartConfirmation = null;
  // Source operations cannot be cancelled once handed to the application or
  // push seam.  A generation fence nevertheless makes their *results*
  // disposable: Disable/close and a power resume must not let a delayed
  // result alter lanes, write persistence, notify a renderer, or populate a
  // verdict cache in the next lifecycle.
  let sourceGeneration = 0;
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
    for (const lane of lanes) {
      lane.inFlight.read = null;
      lane.inFlight.status = null;
      lane.inFlight.submit = null;
      if (lane.phase === 'awaiting') {
        lane.snapshot = null;
        lane.needsRefresh = true;
      } else if (lane.phase === 'unread' || lane.phase === 'host') {
        lane.snapshot = null;
      }
    }
  }

  function notifyJobChanged(lane, generation = sourceGeneration) {
    if (!sourceCurrent(generation) || !lane || !JOB_ID_RE.test(lane.jobId) || !isAbsoluteCanvasPath(lane.canvasFilePath)) return;
    try { onJobChanged({ jobId: lane.jobId, canvasFilePath: lane.canvasFilePath }); } catch { /* renderer notification is advisory */ }
  }

  async function persistLanes(generation = sourceGeneration) {
    if (!sourceCurrent(generation)) return false;
    if (!store?.saveLanes) return true;
    try {
      const result = await store.saveLanes(lanes);
      if (!sourceCurrent(generation)) return false;
      if (result === false) throw Object.assign(new Error('lane persistence failed'), { code: 'persist_failed' });
      // The fault describes the LAST write, not history: a later successful
      // save proves the store works again, so a sticky flag would keep the
      // bridge reading as faulted until restart.
      if (fault === 'persist_failed') fault = null;
      return true;
    } catch {
      if (!sourceCurrent(generation)) return false;
      fault = 'persist_failed';
      // `persist_failed` has a deliberately narrow log schema. Do not send a
      // made-up `kind` field here: a production logger correctly rejects it,
      // which used to make this important fault invisible in bug reports.
      log('persist_failed', { store: 'lanes', code: 'persist_failed' });
      return false;
    }
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

  function retireEpoch(reason) {
    if (!epoch) return;
    const retiringPushEpoch = pushEpochId(epoch);
    try { push?.closeEpoch?.(retiringPushEpoch); } catch { /* push state is disposable */ }
    for (const [key, value] of pushVerdicts) if (value.epochId === retiringPushEpoch) pushVerdicts.delete(key);
    retiredEpochs.push({ n: epoch.n, hash: epoch.keyHash, endedAt: safeNow(now), reason });
    while (retiredEpochs.length > CONSTANTS.RETIRED_EPOCHS) retiredEpochs.shift();
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
    if (safeNow(now) - lastHumanActionAt >= limits.idlePauseMinutes * 60_000) {
      paused = true;
      pauseCause = 'idle';
      counts.pauses++;
      auditEvent('pause', { cause: 'idle' });
      log('pause', { cause: 'idle' });
    }
  }

  function authenticate(session, linkId) {
    if (!epoch) return 'session_ended';
    const presented = typeof session === 'string' ? session.trim() : '';
    const boundLinkId = typeof linkId === 'string' ? linkId : '';
    const digest = epochHash(boundLinkId, presented);
    if (sameDigest(digest, epoch.keyHash)) {
      if (limits.chatKeyMaxAgeHours > 0
          && safeNow(now) - epoch.mintedAt >= limits.chatKeyMaxAgeHours * 3_600_000) return 'session_ended';
      return 'ok';
    }
    for (const retired of retiredEpochs) {
      if (sameDigest(digest, retired.hash)) return 'session_ended';
    }
    const stamp = safeNow(now);
    badKeyTimes.push(stamp);
    while (badKeyTimes.length && stamp - badKeyTimes[0] > 10 * 60_000) badKeyTimes.shift();
    if (badKeyTimes.length >= 5) {
      paused = true;
      pauseCause = 'anomaly';
      counts.pauses++;
      auditEvent('pause', { cause: 'anomaly' });
      log('pause', { cause: 'anomaly' });
    }
    counts.getUnauthorized++;
    return 'unauthorized';
  }

  function gate(args) {
    if (closed) return makeResultBody('paused', { reason: 'closed' });
    const auth = authenticate(args.session, args.grant?.linkId ?? args.linkId);
    if (auth !== 'ok') return makeResultBody(auth);
    checkIdlePause();
    if (paused) return makeResultBody('paused', { reason: pauseCause });
    return null;
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
    lane.phase = 'awaiting';
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
  function recordAcceptedElsewhere(lane, code, result) {
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
    lane.acceptedElsewhere = record;
    if (lanes.includes(lane)) settleAcceptedElsewhere(lane);
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
  }

  // Puts a lane a failed save had taken out back, in ordinal order, but never
  // when the job already has a lane again (a keep-alive release ran meanwhile).
  function reinstateLane(lane) {
    if (lanes.includes(lane) || lanes.some(item => item.jobId === lane.jobId)) return false;
    // Ordinals are never rewound, but a reinstated lane must never sit at or
    // above the counter, or the next release would hand out its ordinal again.
    laneOrdinal = Math.max(laneOrdinal, lane.ord);
    const at = lanes.findIndex(item => item.ord > lane.ord);
    lanes.splice(at < 0 ? lanes.length : at, 0, lane);
    return true;
  }

  async function applyReadResult(lane, raw, { fromStatus = false, recoveryStage = null, generation = sourceGeneration } = {}) {
    // A result that lands after its lane was removed (Unrelease, discard, a
    // proven-gone drop) must not touch it: adopting the handoff would index the
    // served code again for a lane that no longer exists.
    if (!sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
    const result = normalizeSourceResult(raw);
    if (isHeldPhase(lane)) { keepHoldOverResult(lane); return result; }
    const stamp = safeNow(now);
    if (result.kind === 'open') {
      const code = result.handoff?.code ?? result.handoff?.handoffCode;
      const sameRecoveryStage = typeof recoveryStage === 'string' && result.handoff?.stage === recoveryStage;
      if (lane.phase === 'awaiting' && isHumanAdvance(lane, code, codeGuard) && !sameRecoveryStage) {
        holdLane(lane, 'human_advance', stamp);
        // The prompt this lane holds is retired: Resume must re-read and adopt
        // the app's current code, not come back awaiting the stale one.
        keepHoldOverResult(lane);
        await persistLanes(generation);
        if (!sourceCurrent(generation)) return { kind: 'retry' };
        return result;
      }
      adoptCurrent(lane, result.handoff);
      lane.counters.errStreak = 0;
    } else if (result.kind === 'host') {
      lane.phase = 'host';
      lane.reason = null;
      lane.hostSince ??= stamp;
      lane.snapshot = { at: stamp, kind: 'host' };
      lane.counters.errStreak = 0;
    } else if (result.kind === 'done') {
      lane.phase = 'done';
      lane.reason = null;
      lane.snapshot = { at: stamp, kind: 'done' };
      clearLaneHint(lane);
      await persistLanes(generation);
      if (!sourceCurrent(generation)) return { kind: 'retry' };
    } else if (result.kind === 'gone') {
      lane.phase = 'gone';
      lane.reason = null;
      lane.snapshot = { at: stamp, kind: 'gone' };
      clearLaneHint(lane);
      // A vanished bundle can never be answered, so it must not keep one of
      // the chat's job slots and starve a live job.
      epoch?.assignedLaneOrds.delete(lane.ord);
      await persistLanes(generation);
      if (!sourceCurrent(generation)) return { kind: 'retry' };
    } else if (result.kind === 'threw') {
      if (result.code === 'LOCAL_AI_JOB_INTEGRITY') holdLane(lane, 'job_broken', stamp);
      else if (result.code === 'ENOENT' && !fromStatus) return statusLane(lane, { readAfterAwaiting: false, generation });
      else if (result.code === 'ENOENT') holdLane(lane, 'canvas_unavailable', stamp);
      else if (++lane.counters.errStreak >= CONSTANTS.APPLICATION_ERROR_STREAK) holdLane(lane, 'read_failed', stamp);
      lane.snapshot = { at: stamp, kind: 'threw', code: result.code ?? 'internal_error' };
      if (['held', 'needs_user'].includes(lane.phase)) {
        await persistLanes(generation);
        if (!sourceCurrent(generation)) return { kind: 'retry' };
      }
    }
    return result;
  }

  async function raceLaneCall(lane, slot, promise, generation = sourceGeneration) {
    const timedOut = Symbol('lane-call-timeout');
    const result = await raceWithBudget(promise, readWatchdogMs, timedOut);
    if (!sourceCurrent(generation)) return { kind: 'retry' };
    if (result !== timedOut) return result;
    if (lane.inFlight[slot] === promise) lane.inFlight[slot] = null;
    lane.snapshot = { at: safeNow(now), kind: 'busy' };
    wake();
    return { kind: 'busy' };
  }

  function startLaneCall(lane, slot, call, apply, generation = sourceGeneration) {
    if (!sourceCurrent(generation)) return Promise.resolve({ kind: 'retry' });
    if (lane.inFlight[slot]) return lane.inFlight[slot];
    let promise;
    promise = Promise.resolve()
      .then(() => sourceCurrent(generation) ? call() : { kind: 'retry' })
      .then(result => sourceCurrent(generation) ? apply(result) : { kind: 'retry' })
      .catch(error => sourceCurrent(generation)
        ? apply({ kind: 'threw', code: typeof error?.code === 'string' ? error.code : 'internal_error' })
        : { kind: 'retry' })
      .finally(() => {
        if (sourceCurrent(generation) && lane.inFlight[slot] === promise) lane.inFlight[slot] = null;
      });
    lane.inFlight[slot] = promise;
    return promise;
  }

  async function readLane(lane, { recoveryStage = null, generation = sourceGeneration } = {}) {
    if (!scope.applications || !sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
    const promise = startLaneCall(
      lane,
      'read',
      () => application.read({ jobId: lane.jobId, canvasFilePath: lane.canvasFilePath }),
      result => sourceCurrent(generation)
        ? applyReadResult(lane, result, { recoveryStage, generation })
        : { kind: 'retry' },
      generation,
    );
    return raceLaneCall(lane, 'read', promise, generation);
  }

  async function applyStatusResult(lane, raw, { readAfterAwaiting = true, generation = sourceGeneration } = {}) {
    if (!sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
    const result = normalizeSourceResult(raw);
    if (isHeldPhase(lane)) { keepHoldOverResult(lane); return result; }
    if (result.kind === 'open' || result.kind === 'host' || result.kind === 'done' || result.kind === 'gone' || result.kind === 'threw') {
      await applyReadResult(lane, result, { fromStatus: true, generation });
      if (!sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
      if (result.read === true) return readLane(lane, { generation });
      return result;
    }
    if (result.kind === 'awaiting') {
      lane.phase = 'unread';
      lane.snapshot = null;
      return readAfterAwaiting ? readLane(lane, { generation }) : result;
    }
    if (result.kind === 'needs_user') {
      holdLane(lane, result.reason || 'read_failed', safeNow(now));
      await persistLanes(generation);
      if (!sourceCurrent(generation)) return { kind: 'retry' };
      return result;
    }
    return result;
  }

  async function statusLane(lane, { readAfterAwaiting = true, generation = sourceGeneration } = {}) {
    if (!scope.applications || !sourceCurrent(generation) || !lanes.includes(lane)) return { kind: 'retry' };
    const promise = startLaneCall(
      lane,
      'status',
      () => application.status({ jobId: lane.jobId, canvasFilePath: lane.canvasFilePath }),
      result => sourceCurrent(generation)
        ? applyStatusResult(lane, result, { readAfterAwaiting, generation })
        : { kind: 'retry' },
      generation,
    );
    return raceLaneCall(lane, 'status', promise, generation);
  }

  function canAssign(lane) {
    if (!epoch) return false;
    if (epoch.assignedLaneOrds.has(lane.ord)) return true;
    return epoch.assignedLaneOrds.size < limits.jobsPerChat
      && epoch.bytesServed + epoch.bytesReceived < limits.epochSoftBytes;
  }

  function chooseApplicationContinuation() {
    if (!epoch) return null;
    const focus = lanes.find(lane => lane.ord === epoch.focusLaneOrd && lane.phase === 'awaiting' && !lane.needsRefresh && canAssign(lane));
    if (focus) return focus;
    const outstanding = lanes.find(lane => lane.phase === 'awaiting' && !lane.needsRefresh && lane.servedAt != null && canAssign(lane));
    if (outstanding) return outstanding;
    // A correction is an application continuation even after a chat rotation;
    // it must never be displaced by an unrelated scoring handoff.
    return [...lanes]
      .filter(lane => lane.phase === 'awaiting' && !lane.needsRefresh && lane.current?.corrections?.length && canAssign(lane))
      .sort((a, b) => a.releasedAt - b.releasedAt || a.ord - b.ord)[0] ?? null;
  }

  function chooseFreshApplication() {
    if (!epoch) return null;
    return [...lanes]
      .filter(lane => lane.phase === 'awaiting' && !lane.needsRefresh && canAssign(lane))
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

  function framePushGet(raw, generation = sourceGeneration, expectedEpoch = epoch) {
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
      if (expectedEpoch.bytesServed + expectedEpoch.bytesReceived >= limits.epochHardBytes) {
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
        instructions: PUSH_INSTRUCTIONS,
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
      expectedEpoch.bytesServed += Number.isFinite(promptBytes) && promptBytes >= 0
        ? Math.floor(promptBytes)
        : Buffer.byteLength(JSON.stringify(body), 'utf8');
      expectedEpoch.lastGetAt = stamp;
      counts.getServed++;
      auditEvent('served', { tool: 'get_handoff', outcome: 'ok', stage: 'push' });
      return body;
    }
    if (decision.status === 'needs_user') return makeResultBody('needs_user', { reason: 'app_only_handoffs', remaining });
    if (decision.status === 'waiting') return makeResultBody('waiting', { retryAfterSeconds: 3, remaining });
    if (decision.status === 'queue_empty') return makeResultBody('queue_empty', { remaining });
    return makeResultBody('retry');
  }

  async function readPush(generation = sourceGeneration, expectedEpoch = epoch) {
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
      const result = await push.get({ epoch: expectedEpochId });
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
    const invalidated = [...lanes]
      .filter(lane => lane.phase === 'awaiting' && lane.needsRefresh === true)
      .sort((a, b) => a.releasedAt - b.releasedAt || a.ord - b.ord)[0];
    if (invalidated) {
      invalidated.needsRefresh = false;
      return readLane(invalidated, { generation });
    }
    const unread = [...lanes].filter(lane => lane.phase === 'unread').sort((a, b) => a.releasedAt - b.releasedAt || a.ord - b.ord)[0];
    if (unread) return readLane(unread, { generation });
    const stamp = safeNow(now);
    const host = [...lanes]
      .filter(lane => lane.phase === 'host'
        && (!lane.snapshot || stamp - lane.snapshot.at >= CONSTANTS.HOST_POLL_MS))
      .sort((a, b) => (a.hostSince ?? 0) - (b.hostSince ?? 0))[0];
    if (host) {
      if (host.hostSince && stamp - host.hostSince >= CONSTANTS.HOST_SILENT_MS) {
        holdLane(host, 'host_silent', stamp);
        await persistLanes(generation);
        if (!sourceCurrent(generation)) return { kind: 'retry' };
        return { kind: 'needs_user' };
      }
      return statusLane(host, { generation });
    }
    return null;
  }

  function serveLane(lane, generation = sourceGeneration, expectedEpoch = epoch) {
    if (!scope.applications || !epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
    // Nothing between choosing a lane and serving it may have changed it: the
    // serve-time probe is asynchronous, so a lane can be answered, dropped or
    // held while it runs. A lane in any of those states is never served.
    if (!lanes.includes(lane) || lane.phase !== 'awaiting' || !lane.current || lane.needsRefresh) return makeResultBody('retry');
    if (expectedEpoch.bytesServed + expectedEpoch.bytesReceived >= limits.epochHardBytes) {
      return makeResultBody('session_full', { remaining: combinedRemaining() });
    }
    const marker = expectedEpoch.servedPrompt.get(lane.ord);
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
    lane.serves++;
    // The same handoff code going out again (not a new stage after an accepted
    // answer) is what `servedTwice` reports.
    const servedDigest = codeGuard.digest(lane.current.code);
    // Only a repeat inside ONE chat is two-chats-on-one-code evidence: a rotation
    // revoked the old chat, and a hold (which clears the digest) ended the wait.
    lane.servedCodeAgain = servedBeforeInThisChat && codeGuard.sameDigest(lane.lastServedDigest, servedDigest);
    lane.lastServedDigest = servedDigest;
    expectedEpoch.servedPrompt.set(lane.ord, { stage: lane.current.stage, codeDigest: codeGuard.digest(lane.current.code) });
    expectedEpoch.assignedLaneOrds.add(lane.ord);
    expectedEpoch.focusLaneOrd = lane.ord;
    expectedEpoch.lastGetAt = stamp;
    expectedEpoch.bytesServed += Buffer.byteLength(JSON.stringify(body), 'utf8');
    counts.getServed++;
    auditEvent('served', { tool: 'get_handoff', outcome: 'ok', stage: lane.current.stage });
    const idleNoticeMs = CONSTANTS.SERVE_AFTER_IDLE_NOTICE_HOURS * 3_600_000;
    if (stamp - lastHumanActionAt >= idleNoticeMs && stamp - lastIdleNoticeAt >= 3_600_000) {
      lastIdleNoticeAt = stamp;
      try { onServeAfterIdle({ hours: Math.floor((stamp - lastHumanActionAt) / 3_600_000) }); } catch { /* contained */ }
    }
    return body;
  }

  // ---- Per-job answer tracking and stall detection -------------------------
  // A lane is "awaiting an answer" only when its current prompt was served to
  // THIS chat and no accepted submit (or replacement handoff) has come since.
  // Every input is engine-owned state; nothing here reads a source.
  function laneAwaitingAnswer(lane) {
    return Boolean(epoch) && lane.phase === 'awaiting' && lane.awaitingAnswer === true
      && lane.servedEpochN === epoch.n && Number.isFinite(lane.servedAt) && Boolean(lane.current);
  }

  // The moment the chat was last heard on this job: the serve, or a later submit
  // attempt (a rejected answer hands ChatGPT a correction to answer again, so
  // that clock restarts). A submit still running is activity, never a stall.
  // A paused bridge turns every call away, and a hold or pause is time nobody
  // could answer in: `quietFrom` (set on resume and when a lane returns to
  // awaiting) is also a floor for the quiet clock. `anchor` is when the quiet
  // began, which is what the person is told; `since` is when it crossed the
  // notice threshold, which only orders the hourly stall history.
  function laneStall(lane, stamp) {
    if (paused || !laneAwaitingAnswer(lane) || lane.inFlight.submit) return null;
    let anchor = lane.servedAt;
    for (const later of [lane.submittedAt, lane.quietFrom]) if (Number.isFinite(later) && later > anchor) anchor = later;
    if (!(stamp - anchor >= CONSTANTS.STALL_NOTICE_MS)) return null;
    return { anchor, since: anchor + CONSTANTS.STALL_NOTICE_MS };
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
    const timedOut = Symbol('bundle-probe-timeout');
    let raw;
    try {
      raw = await raceWithBudget(
        Promise.resolve().then(() => application.status({ jobId: lane.jobId, canvasFilePath: lane.canvasFilePath })),
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
  async function dropProvenGoneLane(lane, cause, generation) {
    if (!lanes.includes(lane)) return true;
    const removed = await removeLane(lane.jobId, cause);
    if (removed.ok) return true;
    if (!sourceCurrent(generation)) return false;
    if (lanes.includes(lane) && !['done', 'gone'].includes(lane.phase)) {
      lane.phase = 'gone';
      lane.reason = null;
      lane.snapshot = { at: safeNow(now), kind: 'gone' };
      epoch?.assignedLaneOrds.delete(lane.ord);
    }
    return true;
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
  async function probeRestoredLanes(generation = sourceGeneration) {
    if (restoreProbe) return restoreProbe;
    restoreProbe = (async () => {
      try {
        for (const lane of [...lanes]) {
          if (!sourceCurrent(generation)) return;
          if (!lanes.includes(lane) || !restoreProbeDue(lane, safeNow(now))) continue;
          const outcome = await probeBundle(lane, generation, { includeSaved: true });
          if (!sourceCurrent(generation)) return;
          if (outcome.cause) { await dropProvenGoneLane(lane, outcome.cause, generation); lane.restoreProbes = null; continue; }
          if (outcome.alive) { lane.restoreProbes = null; continue; }
          if (!outcome.ran) continue;
          if (lane.restoreProbes > 0) lane.restoreProbes -= 1;
          if (lane.restoreProbes === 0) lane.restoreProbeAt = safeNow(now) + RESTORE_REPROBE_MS;
        }
      } finally { restoreProbe = null; }
    })();
    return restoreProbe;
  }

  // The lane to serve, after confirming its bundle still exists. A lane whose
  // bundle is proven gone is dropped and the NEXT candidate is tried, so the
  // chat is served the next job or an honest empty answer, never a prompt for a
  // job that can no longer be answered. Returns { retry: true } if the world
  // changed under the probe.
  async function pickVerifiedLane(choose, generation, expectedEpoch) {
    for (let attempt = 0; attempt <= CONSTANTS.MAX_LANES; attempt += 1) {
      const lane = choose();
      if (!lane) return null;
      const cause = await proveBundleGone(lane, generation, { includeSaved: true });
      if (!epochCurrent(expectedEpoch, generation)) return { retry: true };
      if (!cause) {
        // The probe was asynchronous: the lane may have been answered, dropped,
        // held or refreshed meanwhile. Only a lane that is still servable goes
        // out; otherwise choose again.
        if (lanes.includes(lane) && lane.phase === 'awaiting' && lane.current && !lane.needsRefresh && canAssign(lane)) return lane;
        continue;
      }
      await dropProvenGoneLane(lane, cause, generation);
      if (!epochCurrent(expectedEpoch, generation)) return { retry: true };
    }
    return null;
  }

  function terminalDrain() {
    return lanes.length === 0 || lanes.every(lane => ['done', 'gone'].includes(lane.phase));
  }

  async function pruneTerminalLanes(stamp = safeNow(now), generation = sourceGeneration) {
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
    }
    for (const [codeKey, entry] of codeIndex) if (removed.has(entry?.lane)) codeIndex.delete(codeKey);
    const saved = await persistLanes(generation);
    if (!saved && sourceCurrent(generation)) {
      // Put back only the lanes this prune took out. Restoring a snapshot of the
      // whole array would erase every lane a release added while the save ran.
      for (const lane of expired) {
        if (!reinstateLane(lane)) continue;
        for (const [codeKey, entry] of priorCodes) if (entry?.lane === lane && !codeIndex.has(codeKey)) codeIndex.set(codeKey, entry);
      }
      return false;
    }
    return saved;
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

  async function get(args = {}) {
    const blocked = gate(args);
    if (blocked) {
      if (blocked.status === 'paused') counts.getPaused++;
      return blocked;
    }
    if (args.canvasOpen === false) return makeResultBody('app_unavailable');
    if (args.signal?.aborted) return makeResultBody('retry');
    const expectedEpoch = epoch;
    const callAt = safeNow(now);
    expectedEpoch.calls += 1;
    expectedEpoch.firstCallAt ??= callAt;
    expectedEpoch.lastCallAt = callAt;
    expectedEpoch.lastCallKind = 'get';
    if (expectedEpoch.bytesServed + expectedEpoch.bytesReceived >= limits.epochHardBytes) return makeResultBody('session_full');
    const stamp = safeNow(now);
    if (lastGetAt != null && stamp - lastGetAt >= CONSTANTS.WAIT_COUNTER_RESET_IDLE_MS) expectedEpoch.consecutiveWaits = 0;
    lastGetAt = stamp;
    const generation = sourceGeneration;
    const resumedDuringGet = () => !epochCurrent(expectedEpoch, generation);

    if (scope.applications && lanes.some(item => item.needsRefresh === true)) {
      const refreshed = await refreshOneLane(generation);
      if (resumedDuringGet() || refreshed?.kind === 'retry') return makeResultBody('retry');
    }
    let lane = scope.applications ? await pickVerifiedLane(chooseApplicationContinuation, generation, expectedEpoch) : null;
    if (lane?.retry) return makeResultBody('retry');
    if (lane) return serveLane(lane, generation, expectedEpoch);

    // Push handoffs (scoring and marketplace) are preferred only at
    // application job boundaries. A focused, outstanding, or correction
    // application lane has already won.
    let pushDecision = (scope.scoring || scope.marketplace)
      ? await readPush(generation, expectedEpoch)
      : { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } };
    if (resumedDuringGet()) return makeResultBody('retry');
    if ((scope.scoring || scope.marketplace) && pushDecision?.status === 'served') return framePushGet(pushDecision, generation, expectedEpoch);

    // A lazy read can reveal a correction or a newly-open continuation after
    // the push poll; give it another chance before starting fresh work.
    const refreshed = scope.applications ? await refreshOneLane(generation) : null;
    if (resumedDuringGet() || refreshed?.kind === 'retry') return makeResultBody('retry');
    lane = scope.applications ? await pickVerifiedLane(chooseApplicationContinuation, generation, expectedEpoch) : null;
    if (lane?.retry) return makeResultBody('retry');
    if (lane) return serveLane(lane, generation, expectedEpoch);
    lane = scope.applications ? await pickVerifiedLane(chooseFreshApplication, generation, expectedEpoch) : null;
    if (lane?.retry) return makeResultBody('retry');
    if (lane) return serveLane(lane, generation, expectedEpoch);

    const pushWorking = (scope.scoring || scope.marketplace) && pushDecision?.status === 'waiting';
    const pushNeedsUser = (scope.scoring || scope.marketplace) && pushDecision?.status === 'needs_user';
    const working = pushWorking || (scope.applications && lanes.some(item => item.needsRefresh || ['unread', 'host'].includes(item.phase) || item.inFlight.read || item.inFlight.status || item.inFlight.submit));
    if (working) {
      const wakeReason = await waitForWake(holdMs, args.signal);
      if (wakeReason === 'aborted' || args.signal?.aborted) return makeResultBody('retry');
      if (resumedDuringGet()) return makeResultBody('retry');
      const refreshedAfterWait = scope.applications ? await refreshOneLane(generation) : null;
      if (resumedDuringGet() || refreshedAfterWait?.kind === 'retry') return makeResultBody('retry');
      lane = scope.applications ? await pickVerifiedLane(chooseApplicationContinuation, generation, expectedEpoch) : null;
      if (lane?.retry) return makeResultBody('retry');
      if (lane) return serveLane(lane, generation, expectedEpoch);
      // A successor can be published during the held poll. Preserve the
      // ordering at the boundary: continuations first, then push, then a
      // fresh application lane.
      pushDecision = (scope.scoring || scope.marketplace)
        ? await readPush(generation, expectedEpoch)
        : { status: 'queue_empty', remaining: { ready: 0, working: 0, needsYou: 0 } };
      if (resumedDuringGet()) return makeResultBody('retry');
      if ((scope.scoring || scope.marketplace) && pushDecision?.status === 'served') return framePushGet(pushDecision, generation, expectedEpoch);
      lane = scope.applications ? await pickVerifiedLane(chooseFreshApplication, generation, expectedEpoch) : null;
      if (lane?.retry) return makeResultBody('retry');
      if (lane) return serveLane(lane, generation, expectedEpoch);
      const stillWorking = ((scope.scoring || scope.marketplace) && pushDecision?.status === 'waiting')
        || (scope.applications && lanes.some(item => item.needsRefresh || ['unread', 'host'].includes(item.phase) || item.inFlight.read || item.inFlight.status || item.inFlight.submit));
      if (!stillWorking) {
        if (scope.applications && lanes.some(item => ['held', 'needs_user'].includes(item.phase))) {
          counts.getPaused++;
          return makeResultBody('paused', { reason: 'needs_user', remaining: combinedRemaining(pushDecision?.remaining) });
        }
        if (scope.applications && lanes.some(item => item.phase === 'awaiting' && !canAssign(item))) {
          return makeResultBody('session_full', { remaining: combinedRemaining(pushDecision?.remaining) });
        }
        if ((scope.scoring || scope.marketplace) && pushDecision?.status === 'needs_user') return framePushGet(pushDecision, generation, expectedEpoch);
        if (pushDecision?.status === 'retry') return makeResultBody('retry');
        counts.getEmpty++;
        const drained = (scope.scoring || scope.marketplace)
          ? framePushGet(pushDecision, generation, expectedEpoch)
          : makeResultBody('queue_empty', { remaining: combinedRemaining() });
        if (drained.status === 'queue_empty' && terminalDrain()) retireEpoch('drained');
        return drained;
      }
      expectedEpoch.consecutiveWaits++;
      if (expectedEpoch.consecutiveWaits >= CONSTANTS.MAX_CONSECUTIVE_WAITS) {
        counts.getPaused++;
        return makeResultBody('paused', { reason: 'waiting_limit', remaining: combinedRemaining(pushDecision?.remaining) });
      }
      counts.getWaiting++;
      return makeResultBody('waiting', { pollCount: expectedEpoch.consecutiveWaits, retryAfterSeconds: 5, remaining: combinedRemaining(pushDecision?.remaining) });
    }

    if (scope.applications && lanes.some(item => ['held', 'needs_user'].includes(item.phase))) {
      counts.getPaused++;
      return makeResultBody('paused', { reason: 'needs_user', remaining: combinedRemaining(pushDecision?.remaining) });
    }
    if (scope.applications && lanes.some(item => item.phase === 'awaiting' && !canAssign(item))) {
      return makeResultBody('session_full', { remaining: combinedRemaining(pushDecision?.remaining) });
    }
    if (pushNeedsUser) return framePushGet(pushDecision, generation, expectedEpoch);
    if (pushDecision?.status === 'retry') return makeResultBody('retry');
    counts.getEmpty++;
    const result = (scope.scoring || scope.marketplace)
      ? framePushGet(pushDecision, generation, expectedEpoch)
      : makeResultBody('queue_empty', { remaining: combinedRemaining() });
    if (result.status === 'queue_empty' && terminalDrain()) retireEpoch('drained');
    return result;
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

  async function persistCap(lane, reason, generation = sourceGeneration) {
    if (!sourceCurrent(generation)) return false;
    holdLane(lane, reason, safeNow(now));
    await persistLanes(generation);
    if (!sourceCurrent(generation)) return false;
    wake();
    return true;
  }

  async function callApplicationSubmit(lane, code, text, generation = sourceGeneration, expectedEpoch = epoch) {
    if (!epochCurrent(expectedEpoch, generation)) return { kind: 'retry' };
    const skipped = Symbol('stale-submit');
    const task = Promise.resolve().then(() => epochCurrent(expectedEpoch, generation)
      ? application.submit({ jobId: lane.jobId, canvasFilePath: lane.canvasFilePath }, { code, text })
      : skipped);
    lane.inFlight.submit = task;
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
          stage: lane.current?.stage,
        };
      }
      return normalizeSubmitResult(settled.value);
    } finally {
      if (epochCurrent(expectedEpoch, generation) && lane.inFlight.submit === task) lane.inFlight.submit = null;
    }
  }

  function detachedSubmitResult(result, code) {
    if (result.kind === 'accepted') return makeResultBody('accepted', { jobComplete: false, next: null });
    return code ? tombstoneResult(code) : makeResultBody('unknown_handoff');
  }

  async function mapSubmitResult(lane, text, result, retryCount = 0, generation = sourceGeneration, expectedEpoch = epoch) {
    if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
    const stamp = safeNow(now);
    const currentCode = lane.current?.code;
    // The lane left the bridge (Unrelease, discard) while its submit was in
    // flight. An accepted answer was still written, so say so, but never adopt
    // the next handoff or index a code for a lane that is gone.
    if (!lanes.includes(lane)) {
      recordAcceptedElsewhere(lane, currentCode, result);
      return detachedSubmitResult(result, currentCode);
    }
    // A hold placed while the submit was in flight stands: the answer is recorded
    // but nothing is served or re-armed for a lane the person paused.
    const heldOnLanding = isHeldPhase(lane);
    if (result.kind === 'submit_stuck') {
      await persistCap(lane, 'submit_stuck', generation);
      if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
      return makeResultBody('needs_user', { reason: 'submit_stuck' });
    }
    if (result.kind === 'accepted') {
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
      auditEvent('accepted', { tool: 'submit_handoff', outcome: 'accepted', stage: lane.current?.stage ?? 'unknown' });
      if (result.completed || !result.handoff) {
        if (heldOnLanding) keepHoldOverResult(lane);
        else {
          lane.phase = 'host';
          lane.hostSince = stamp;
        }
        lane.current = null;
        notifyJobChanged(lane, generation);
        await persistLanes(generation);
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        wake();
        return makeResultBody('accepted', { jobComplete: true, next: null });
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
        await persistLanes(generation);
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        wake();
        return makeResultBody('accepted', { jobComplete: false, next: null });
      }
      if (!adoptCurrent(lane, result.handoff)) {
        await persistCap(lane, 'write_failed', generation);
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        return makeResultBody('needs_user', { reason: 'write_failed' });
      }
      notifyJobChanged(lane, generation);
      if (priorStage === 'review' && lane.current.stage === 'review') lane.counters.revisedRounds++;
      if (lane.counters.revisedRounds >= CONSTANTS.APPLICATION_MAX_REVISED_ROUNDS) {
        await persistCap(lane, 'review_round_cap', generation);
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        return makeResultBody('held', { reason: 'review_round_cap' });
      }
      await persistLanes(generation);
      if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
      wake();
      return makeResultBody('accepted', { jobComplete: false, next: serveLane(lane, generation, expectedEpoch) });
    }

    if (result.kind === 'rejected') {
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
      if (lane.counters.rejections >= CONSTANTS.APPLICATION_MAX_REJECTIONS) {
        await persistCap(lane, 'rejection_cap', generation);
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        return makeResultBody('held', { reason: 'rejection_cap' });
      }
      // ChatGPT is handed a code for the corrected answer. A recovery re-read
      // that rotated the code reset the serve state (adoptCurrent), so re-arm it.
      if (lane.phase === 'awaiting' && !laneAwaitingAnswer(lane)) {
        lane.awaitingAnswer = true;
        lane.servedAt = stamp;
        lane.servedEpochN = expectedEpoch.n;
      }
      await persistLanes(generation);
      if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
      wake();
      return makeRejectedBody({
        handoffCode: lane.current?.code ?? currentCode,
        attempt: lane.counters.rejections + 1,
        validationErrors: errors,
        correctionPrompt: result.correctionPrompt ?? lane.current?.correctionPrompt,
      });
    }

    if (result.kind === 'threw') {
      if (result.code === 'LOCAL_AI_JOB_INTEGRITY') {
        await persistCap(lane, 'job_broken', generation);
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
          const retried = await callApplicationSubmit(lane, lane.current.code, text, generation, expectedEpoch);
          return mapSubmitResult(lane, text, retried, retryCount + 1, generation, expectedEpoch);
        }
        if (lane.phase === 'host') return makeResultBody('superseded');
        // The reread proved the bundle is gone, or saved elsewhere ('done' is
        // only ever a saved job). Counting that as a transient write error
        // answered 'retry' and then flipped a finished lane to needs_user; it
        // is a definite, final answer.
        if (lane.phase === 'gone' || lane.phase === 'done') return makeResultBody('unknown_handoff');
      }
      lane.counters.errStreak++;
      if (lane.counters.errStreak >= CONSTANTS.APPLICATION_ERROR_STREAK) {
        await persistCap(lane, 'write_failed', generation);
        if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
        return makeResultBody('needs_user', { reason: 'write_failed' });
      }
      await persistLanes(generation);
      if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
      return makeResultBody('retry', { inFlight: false });
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

  async function runSubmit(lane, text, generation = sourceGeneration, expectedEpoch = epoch) {
    const submittedCode = lane.current?.code;
    await semaphore.acquire();
    try {
      if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
      const stale = staleQueuedSubmitResult(lane, submittedCode, text);
      if (stale) return stale;
      const code = lane.current.code;
      const key = verdictKey(codeGuard.key(code), text);
      const retained = lane.retained;
      if (codeGuard.sameDigest(retained?.codeDigest, codeGuard.digest(code)) && retained.sha256 !== key) {
        const recovered = await callApplicationSubmit(lane, code, retained.text, generation, expectedEpoch);
        if (recovered.kind === 'accepted' || recovered.kind === 'submit_stuck') {
          return mapSubmitResult(lane, retained.text, recovered, 2, generation, expectedEpoch);
        }
      }
      lane.submittedAt = safeNow(now);
      lane.retained = { codeDigest: codeGuard.digest(code), text, sha256: key, at: lane.submittedAt };
      const result = await callApplicationSubmit(lane, code, text, generation, expectedEpoch);
      return await mapSubmitResult(lane, text, result, 0, generation, expectedEpoch);
    } finally {
      semaphore.release();
      if (epochCurrent(expectedEpoch, generation)) wake();
    }
  }

  async function framePushSubmit(raw, { successorBudgetMs = 0, generation = sourceGeneration, expectedEpoch = epoch } = {}) {
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
      let next = null;
      if (successorBudgetMs > 0 && typeof push?.nextAfterAccept === 'function') {
        let successor;
        try {
          if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
          successor = await raceWithBudget(
            push.nextAfterAccept({ epoch: pushEpochId(expectedEpoch), budgetMs: successorBudgetMs }),
            successorBudgetMs,
            { status: 'waiting' },
          );
        } catch { successor = { status: 'waiting' }; }
        if (!epochCurrent(expectedEpoch, generation)) {
          try { push?.closeEpoch?.(pushEpochId(expectedEpoch)); } catch { /* stale state is best-effort */ }
          return makeResultBody('retry');
        }
        if (successor?.status && successor.status !== 'queue_empty') next = framePushGet(successor, generation, expectedEpoch);
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

  function runPushSubmit(code, text, generation = sourceGeneration, expectedEpoch = epoch) {
    if ((!scope.scoring && !scope.marketplace) || !epochCurrent(expectedEpoch, generation)) return null;
    const epochId = pushEpochId(expectedEpoch);
    const key = verdictKey(`push\n${epochId ?? ''}\n${codeGuard.key(code)}`, text);
    const cached = pushVerdicts.get(key);
    if (cached && safeNow(now) - cached.at <= CONSTANTS.VERDICT_CACHE_MS) return cached;
    let rawPromise;
    rawPromise = Promise.resolve()
      .then(() => semaphore.acquire())
      .then(() => epochCurrent(expectedEpoch, generation)
        ? push.submit({ epoch: epochId, handoffCode: code, response: text })
        : { status: 'retry' })
      .catch(() => ({ status: 'retry' }))
      .finally(() => semaphore.release());
    const record = { at: safeNow(now), rawPromise, framedPromise: null, epochId, generation, expectedEpoch };
    pushVerdicts.set(key, record);
    rawPromise.finally(() => {
      const current = pushVerdicts.get(key);
      if (epochCurrent(expectedEpoch, generation) && current === record && safeNow(now) - current.at > CONSTANTS.VERDICT_CACHE_MS) pushVerdicts.delete(key);
    });
    return record;
  }

  async function submit(args = {}) {
    const blocked = gate(args);
    if (blocked) return blocked;
    if (args.canvasOpen === false) return makeResultBody('app_unavailable');
    const generation = sourceGeneration;
    const expectedEpoch = epoch;
    const callAt = safeNow(now);
    expectedEpoch.calls += 1;
    expectedEpoch.firstCallAt ??= callAt;
    expectedEpoch.lastCallAt = callAt;
    expectedEpoch.lastCallKind = 'submit';
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
    expectedEpoch.bytesReceived += bytes;
    expectedEpoch.lastSubmitAt = safeNow(now);
    const code = trimHandoffCode(args.handoffCode);
    // Push owns its served-code/tombstone namespace. It has to be consulted
    // before the application unknown-code path so an accepted scoring or
    // marketplace retry is never reported as an application unknown handoff.
    if (push && (scope.scoring || scope.marketplace)) {
      const pushStartedAt = safeNow(now);
      const pushRecord = runPushSubmit(code, text, generation, expectedEpoch);
      if (!pushRecord) return makeResultBody('retry');
      const pushTimeout = Symbol('push-submit-timeout');
      const pushDecision = await raceWithBudget(pushRecord.rawPromise, submitBudgetMs, pushTimeout);
      if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
      if (pushDecision === pushTimeout) return makeResultBody('retry', { inFlight: true });
      if (pushDecision?.status !== 'unknown_handoff') {
        const elapsed = Math.max(0, safeNow(now) - pushStartedAt);
        if (!pushRecord.framedPromise) {
          pushRecord.framedPromise = Promise.resolve(pushDecision).then(decision => framePushSubmit(decision, {
            successorBudgetMs: Math.max(0, submitBudgetMs - elapsed),
            generation,
            expectedEpoch,
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
    if (!lanes.includes(entry.lane)) { codeIndex.delete(codeGuard.key(code)); return tombstoneResult(code); }
    // A scope downgrade never lets a previously served application answer
    // reach the adapter.  Keep the release durable for a later, confirmed
    // re-enable, but deny this in-flight handoff without touching its state.
    if (!scope.applications) return makeResultBody('held', { reason: 'scope_disabled' });
    const lane = entry.lane;
    // Any submit that reaches its lane is ChatGPT being heard on this job, even
    // when it is turned away before the source is asked (junk, wrong stage, a
    // cached verdict, held). runSubmit stamps its own retained record.
    lane.submittedAt = safeNow(now);
    if (lane.phase === 'held') { counts.submitHeld++; return makeResultBody('held', { reason: lane.reason }); }
    if (lane.phase === 'needs_user') return makeResultBody('needs_user', { reason: lane.reason });
    if (lane.phase === 'host') { counts.submitSuperseded++; return makeResultBody('superseded'); }
    if (lane.phase === 'gone' || lane.phase === 'done' || !lane.current) return makeResultBody('unknown_handoff');

    const classification = classifySubmission({ response: text, lane, lanes, codeGuard });
    if (classification !== 'pass') {
      if (classification === 'junk') {
        counts.submitJunk++;
        lane.counters.junkStreak++;
        if (lane.counters.junkStreak >= CONSTANTS.APPLICATION_MAX_JUNK_STREAK) {
          await persistCap(lane, 'junk_cap', generation);
          if (!epochCurrent(expectedEpoch, generation)) return makeResultBody('retry');
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
    const promise = runSubmit(lane, text, generation, expectedEpoch);
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
    let accepted = false;
    try { accepted = await confirmRestart(lanes.map(lane => lane.ord)); } catch { accepted = false; }
    if (!accepted || !sourceCurrent(generation)) return false;
    const priorHumanActionAt = lastHumanActionAt;
    const prior = lanes.map(lane => ({
      lane,
      phase: lane.phase,
      reason: lane.reason,
      heldFrom: lane.heldFrom,
      snapshot: lane.snapshot,
    }));
    restartConfirmed = true;
    for (const lane of lanes) {
      if (lane.phase !== 'held' || lane.reason !== 'restart') continue;
      lane.phase = 'unread';
      lane.reason = null;
      lane.heldFrom = null;
      lane.snapshot = null;
    }
    humanAction();
    if (!await persistLanes(generation)) {
      restartConfirmed = false;
      lastHumanActionAt = priorHumanActionAt;
      for (const state of prior) {
        const { lane, ...values } = state;
        Object.assign(lane, values);
      }
      return false;
    }
    auditEvent('restart_confirmed');
    log('restart_confirmed');
    return true;
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

  async function prepareChat({ linkId, kind = 'new' } = {}) {
    if (typeof linkId !== 'string' || !linkId) return { copied: false, status: 'unlinked' };
    if (!await confirmRestartIfNeeded()) return { copied: false, status: 'paused', reason: 'restart' };
    const sessionCode = makeChatKey(random);
    // Preparation and clipboard confirmation are deliberately split. Reserve
    // a unique ordinal before returning the one-shot commit capability so two
    // overlapping native sheets can never share a push epoch id. Gaps from an
    // abandoned preparation are harmless because ordinals are process-local.
    const preparedOrdinal = ++reservedEpochOrdinal;
    const prepared = {
      n: preparedOrdinal,
      keyHash: epochHash(linkId, sessionCode),
      mintedAt: safeNow(now),
      bytesServed: 0,
      bytesReceived: 0,
      lastGetAt: null,
      lastSubmitAt: null,
      firstCallAt: null,
      lastCallAt: null,
      lastCallKind: null,
      calls: 0,
      consecutiveWaits: 0,
      focusLaneOrd: null,
      servedPrompt: new Map(),
      assignedLaneOrds: new Set(),
    };
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
        if (prepared.n <= epochOrdinal) return false;
        retireEpoch(kind === 'continue' ? 'continued' : 'rotated');
        epochOrdinal = prepared.n;
        epoch = prepared;
        paused = false;
        pauseCause = null;
        badKeyTimes.length = 0;
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
    return { copied: true, sessionCode: prepared.sessionCode, chatOrdinal: prepared.chatOrdinal };
  }

  async function continueChat(args = {}) {
    const prepared = await prepareChat({ ...args, kind: 'continue' });
    if (!prepared.copied) return prepared;
    prepared.commit();
    return { copied: true, sessionCode: prepared.sessionCode, chatOrdinal: prepared.chatOrdinal };
  }

  // Job ids whose bundle the app discarded or pruned this session (insertion
  // ordered, bounded). Only these are refused by `release`; a person's own
  // Unrelease and the probe-proven drops stay reversible.
  const REMOVED_BUNDLES_CAP = 256;
  const removedBundles = new Set();

  async function release({ jobs = [] } = {}) {
    const generation = sourceGeneration;
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
        if (existing.canvasFilePath !== item.canvasFilePath && typeof application.adoptCanvasPath === 'function') {
          try {
            const adopted = await application.adoptCanvasPath(existing.jobId, item.canvasFilePath, existing.canvasFilePath);
            if (!sourceCurrent(generation)) return { ok: false, code: 'not_ready' };
            if (adopted?.adopted === true) {
              adoptedPaths.push([existing, existing.canvasFilePath, item.canvasFilePath]);
              existing.canvasFilePath = item.canvasFilePath;
              adoptedPath = true;
            }
          } catch { /* keep the trusted old path */ }
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
    const undoRelease = () => {
      for (const created of addedLanes) {
        const at = lanes.indexOf(created);
        if (at >= 0) lanes.splice(at, 1);
      }
      for (const [lane, before, adopted] of adoptedPaths) if (lane.canvasFilePath === adopted) lane.canvasFilePath = before;
    };
    // Releasing a job that already has a lane changes nothing. It must not
    // persist, write an audit row, log a "release", count as human activity or
    // wake a poller: the renderer re-publishes every 30 s and auto-release used
    // to turn each keep-alive into a phantom release that also reset the idle
    // pause. A path adoption alone is still a durable change, so it persists,
    // but it is not a release.
    if (added.length === 0) {
      counts.releaseNoops++;
      if (adoptedPath && !await persistLanes(generation)) {
        if (sourceCurrent(generation)) undoRelease();
        return { ok: false, code: 'persist_failed' };
      }
      if (!sourceCurrent(generation)) return { ok: false, code: 'not_ready' };
      return { ok: true, count: 0, added: [] };
    }
    if (!await persistLanes(generation)) {
      if (sourceCurrent(generation)) undoRelease();
      return { ok: false, code: 'persist_failed' };
    }
    if (!sourceCurrent(generation)) return { ok: false, code: 'not_ready' };
    humanAction();
    auditEvent('release', { count: added.length });
    log('release', { kind: 'application', count: added.length });
    wake();
    return { ok: true, count: added.length, added };
  }

  // Removes one lane. `cause` is a closed enum: 'user' is the person's own
  // Unrelease (a human action); the others are the app noticing the bundle
  // itself stopped existing, which is bookkeeping, never human activity.
  async function removeLane(jobId, cause) {
    const generation = sourceGeneration;
    if (!sourceCurrent(generation)) return { ok: false, code: 'not_ready' };
    const index = lanes.findIndex(lane => lane.jobId === jobId);
    if (index < 0) return { ok: false, code: 'not_found' };
    const [lane] = lanes.splice(index, 1);
    const removedCodes = [];
    for (const [codeKey, entry] of codeIndex) {
      if (entry.lane !== lane) continue;
      removedCodes.push([codeKey, entry]);
      codeIndex.delete(codeKey);
    }
    const hadSlot = epoch?.assignedLaneOrds.delete(lane.ord) === true;
    clearLaneHint(lane);
    if (!await persistLanes(generation)) {
      if (sourceCurrent(generation)) {
        // Only this lane goes back, and only if the job has no lane again: a
        // keep-alive release that ran during the save already owns the job.
        if (reinstateLane(lane)) {
          for (const [codeKey, entry] of removedCodes) if (!codeIndex.has(codeKey)) codeIndex.set(codeKey, entry);
          if (hadSlot) epoch?.assignedLaneOrds.add(lane.ord);
          // An answer the app accepted while the lane was out was not applied to it.
          settleAcceptedElsewhere(lane);
        }
        return { ok: false, code: 'persist_failed' };
      }
      return { ok: false, code: 'not_ready' };
    }
    if (!sourceCurrent(generation)) return { ok: false, code: 'not_ready' };
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
  }

  async function unrelease(jobId) {
    return removeLane(jobId, 'user');
  }

  // The app tells the bridge its bundle was discarded or pruned. Only closed
  // causes are accepted, so nothing derived from job content can reach a log.
  async function dropLane(jobId, cause = 'bundle_discarded') {
    const safeCause = ['bundle_discarded', 'bundle_pruned', 'bundle_missing', 'bundle_saved'].includes(cause) ? cause : 'bundle_discarded';
    if ((safeCause === 'bundle_discarded' || safeCause === 'bundle_pruned') && typeof jobId === 'string') {
      removedBundles.delete(jobId);
      removedBundles.add(jobId);
      while (removedBundles.size > REMOVED_BUNDLES_CAP) removedBundles.delete(removedBundles.values().next().value);
    }
    return removeLane(jobId, safeCause);
  }

  async function hold(jobId, reason = 'user_hold') {
    const lane = lanes.find(item => item.jobId === jobId);
    if (!lane) return { ok: false, code: 'not_found' };
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
    if (!await persistLanes()) {
      // An answer the app accepted (or a rotated code it returned) while the
      // save ran already replaced the lane's handoff: the serve bookkeeping
      // that was cleared belongs to the OLD prompt and must not come back.
      const landed = lane.current !== heldCurrent || lane.answeredAt !== heldAnsweredAt;
      const { awaitingAnswer, servedAt, lastServedDigest, servedCodeAgain, ...marker } = prior;
      Object.assign(lane, marker);
      if (landed) {
        if (!lane.current && ['awaiting', 'host'].includes(lane.phase)) lane.phase = 'unread';
      } else Object.assign(lane, { awaitingAnswer, servedAt, lastServedDigest, servedCodeAgain });
      return { ok: false, code: 'persist_failed' };
    }
    humanAction();
    wake();
    return { ok: true };
  }

  async function resume({ jobId } = {}) {
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
      };
      resumeLane(lane);
      // The time held was time ChatGPT could not have answered in.
      lane.quietFrom = safeNow(now);
      if (!lane.current && ['awaiting', 'host'].includes(lane.phase)) lane.phase = 'unread';
      if (!await persistLanes()) {
        Object.assign(lane, prior);
        return { ok: false, code: 'persist_failed' };
      }
    } else {
      paused = false;
      pauseCause = null;
      // A pause turns ChatGPT's calls away: no lane's quiet time includes it.
      const resumedAt = safeNow(now);
      for (const lane of lanes) lane.quietFrom = resumedAt;
    }
    humanAction();
    auditEvent('resume', { cause: jobId ? 'lane' : 'bridge' });
    log('resume', { cause: jobId ? 'lane' : 'bridge' });
    wake();
    return { ok: true };
  }

  function pause(cause = 'user') {
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
      if (!sourceCurrent(generation) || !lanes.includes(lane) || ['done', 'gone'].includes(lane.phase)) {
        clearLaneHint(lane);
        return;
      }
      lastHintAt.set(lane.ord, safeNow(now));
      hintTimers.delete(lane.ord);
      lane.snapshot = null;
      lane.needsRefresh = true;
      wake();
    };
    if (stamp - last >= CONSTANTS.HINT_MIN_INTERVAL_MS) invalidate();
    else if (!hintTimers.has(lane.ord)) {
      const timer = timers.setTimeout?.(invalidate, CONSTANTS.HINT_MIN_INTERVAL_MS - (stamp - last));
      timer?.unref?.();
      hintTimers.set(lane.ord, timer);
    }
    return true;
  }

  function restore(values = []) {
    if (!Array.isArray(values)) return 0;
    for (const value of values) {
      try {
        // A finished or vanished lane has nothing left to serve; restoring it
        // as a held 'restart' lane made the person Resume a dead job.
        if (['done', 'gone'].includes(value?.phase)) continue;
        const lane = rehydrateApplicationLane(value, safeNow(now));
        lane.restoreProbes = RESTORE_PROBE_ATTEMPTS;
        lane.restoreProbeAt = 0;
        lanes.push(lane);
        laneOrdinal = Math.max(laneOrdinal, lane.ord);
      } catch { /* unknown/corrupt lanes are skipped */ }
    }
    restartConfirmed = lanes.length === 0;
    if (lanes.some(lane => restoreProbeDue(lane, safeNow(now)))) void probeRestoredLanes().catch(() => undefined);
    return lanes.length;
  }

  function snapshot() {
    const queue = remainingCounts(lanes);
    let pushState = { served: 0, held: 0, selectedHubs: 0, working: 0, needsYou: 0 };
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
    const pushDiscovered = pushDiscoveryCurrent && ownsPushDiscovery() && Array.isArray(pushState.discovered) ? pushState.discovered : [];
    const pushTasks = new Map();
    const safeDiscoveredHubs = [];
    let discoveredPending = 0;
    for (const hub of pushDiscovered) {
      if (typeof hub?.key !== 'string' || !/^[a-f0-9]{64}$/.test(hub.key) || safeDiscoveredHubs.length >= 50) continue;
      const tasks = [];
      for (const task of Array.isArray(hub?.tasks) ? hub.tasks : []) {
        if (task?.task !== 'job-scoring') continue;
        const pending = Number.isSafeInteger(task.pending) ? Math.max(0, task.pending) : 0;
        tasks.push(Object.freeze({ task: task.task, pending }));
        pushTasks.set(task.task, (pushTasks.get(task.task) || 0) + pending);
      }
      const excluded = {};
      for (const reason of ['ending', 'settling', 'attachment', 'grounded', 'free_text', 'task_not_allowed', 'node_not_allowed', 'person_editing']) {
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
    const safePush = Object.freeze({ selectedHubs: Object.freeze(safeSelectedHubs), discovered: Object.freeze(safeDiscoveredHubs) });
    const chatCalls = epoch?.calls ?? 0;
    return Object.freeze({
      paused,
      pauseCause,
      fault,
      autoStart: autoStart === true,
      chat: Object.freeze({
        ordinal: epoch?.n ?? 0,
        startedAt: statusTime(epoch?.mintedAt),
        firstCallAt: statusTime(epoch?.firstCallAt),
        lastCallAt: statusTime(epoch?.lastCallAt),
        lastCallKind: ['get', 'submit'].includes(epoch?.lastCallKind) ? epoch.lastCallKind : null,
        calls: Number.isSafeInteger(chatCalls) ? chatCalls : 0,
        state: !epoch ? 'none' : epoch.bytesServed + epoch.bytesReceived >= limits.epochHardBytes ? 'full' : chatCalls === 0 ? 'awaiting-first-call' : 'working',
        jobsAssigned: epoch?.assignedLaneOrds.size ?? 0,
        jobsCap: limits.jobsPerChat,
        bytesServed: epoch?.bytesServed ?? 0,
        bytesReceived: epoch?.bytesReceived ?? 0,
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
            : item.reason === 'drained'
              ? 'queue_empty'
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
            changedAt: statusTime(lane.changedAt ?? lane.releasedAt),
            // Per-job answer tracking, all for the CURRENT chat only:
            // servedAt is when this job's current stage went out, answeredAt
            // the last accepted submit, awaitingAnswer that the stage is out
            // and unanswered, stalled that it has been quiet too long.
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
      const refreshed = await push?.refreshHubs?.();
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
    for (const lane of lanes) {
      lane.inFlight.read = null;
      lane.inFlight.status = null;
      lane.inFlight.submit = null;
      lane.retained = null;
    }
    for (const timer of hintTimers.values()) clearTimer(timer);
    hintTimers.clear();
    semaphore.close();
    wake();
  }

  restore(restoredLanes);

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
