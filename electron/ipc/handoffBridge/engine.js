import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONSTANTS } from './constants.js';
import {
  createApplicationLane,
  holdLane,
  indexLaneCode,
  isHumanAdvance,
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
  supersededStageNote,
} from './framing.js';

const JOB_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

function verdictKey(code, text) {
  return createHash('sha256').update(code).update('\0').update(text).digest('hex');
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
  confirmRestart = async () => true,
  onServeAfterIdle = () => undefined,
  holdMs = CONSTANTS.GET_HOLD_MS,
  readWatchdogMs = CONSTANTS.LANE_READ_WATCHDOG_MS,
  submitBudgetMs = CONSTANTS.SUBMIT_RESPONSE_BUDGET_MS,
  restoredLanes = [],
  autoStart = false,
} = {}) {
  const application = sources?.application ?? source;
  if (!application || typeof application.read !== 'function' || typeof application.status !== 'function'
      || typeof application.submit !== 'function') throw new TypeError('An application source is required');

  let limits = normalizeLimits(initialLimits);
  const lanes = [];
  const codeIndex = new Map();
  const tombstones = new Map();
  const verdicts = new Map();
  const retiredEpochs = [];
  const badKeyTimes = [];
  const waiters = new Set();
  const hintTimers = new Map();
  const lastHintAt = new Map();
  const semaphore = makeSemaphore(CONSTANTS.SUBMIT_CONCURRENCY);
  let epoch = null;
  let epochOrdinal = 0;
  let laneOrdinal = 0;
  let paused = false;
  let pauseCause = null;
  let closed = false;
  let restartConfirmed = restoredLanes.length === 0;
  let lastHumanActionAt = safeNow(now);
  let lastIdleNoticeAt = 0;
  let fault = null;
  let lastGetAt = null;
  const counts = {
    getServed: 0, getWaiting: 0, getEmpty: 0, getPaused: 0, getUnauthorized: 0,
    submitAccepted: 0, submitRejected: 0, submitDuplicate: 0, submitJunk: 0,
    submitSuperseded: 0, submitMisrouted: 0, submitHeld: 0, submitTooLarge: 0,
    pauses: 0, chatsStarted: 0, chatsContinued: 0,
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

  async function persistLanes() {
    if (!store?.saveLanes) return true;
    try {
      const result = await store.saveLanes(lanes);
      if (result === false) throw Object.assign(new Error('lane persistence failed'), { code: 'persist_failed' });
      return true;
    } catch {
      fault = 'persist_failed';
      log('persist_failed', { kind: 'lanes' });
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

  async function waitForWake(ms) {
    if (!(ms > 0)) return;
    let release;
    const wakePromise = new Promise(resolve => { release = resolve; waiters.add(resolve); });
    const timer = delay(ms);
    try { await Promise.race([wakePromise, timer.promise]); }
    finally {
      waiters.delete(release);
      timer.clear();
    }
  }

  function retireEpoch(reason) {
    if (!epoch) return;
    retiredEpochs.push({ hash: epoch.keyHash, linkId: epoch.linkId, endedAt: safeNow(now), reason });
    while (retiredEpochs.length > CONSTANTS.RETIRED_EPOCHS) retiredEpochs.shift();
    auditEvent('epoch_closed', { reason });
    epoch = null;
    wake();
  }

  function checkIdlePause() {
    if (!epoch || paused || limits.idlePauseMinutes <= 0) return;
    if (safeNow(now) - lastHumanActionAt >= limits.idlePauseMinutes * 60_000) {
      paused = true;
      pauseCause = 'idle';
      counts.pauses++;
      auditEvent('pause', { cause: 'idle' });
    }
  }

  function authenticate(session, linkId) {
    if (!epoch) return 'session_ended';
    const presented = typeof session === 'string' ? session.trim() : '';
    const digest = epochHash(String(linkId ?? ''), presented);
    if (sameDigest(digest, epoch.keyHash) && linkId === epoch.linkId) {
      if (limits.chatKeyMaxAgeHours > 0
          && safeNow(now) - epoch.mintedAt >= limits.chatKeyMaxAgeHours * 3_600_000) return 'session_ended';
      return 'ok';
    }
    for (const retired of retiredEpochs) {
      if (retired.linkId === linkId && sameDigest(digest, retired.hash)) return 'session_ended';
    }
    const stamp = safeNow(now);
    badKeyTimes.push(stamp);
    while (badKeyTimes.length && stamp - badKeyTimes[0] > 10 * 60_000) badKeyTimes.shift();
    if (badKeyTimes.length >= 5) {
      paused = true;
      pauseCause = 'anomaly';
      counts.pauses++;
      auditEvent('pause', { cause: 'anomaly' });
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
    if (previous?.code && previous.code !== current.code && codeIndex.has(previous.code)) {
      tombstoneCode(tombstones, previous.code, 'rotated', { laneOrd: lane.ord, at: safeNow(now) });
      codeIndex.delete(previous.code);
    }
    lane.current = current;
    lane.needsRefresh = false;
    lane.phase = 'awaiting';
    lane.reason = null;
    lane.heldFrom = null;
    lane.hostSince = null;
    lane.snapshot = { at: safeNow(now), kind: 'open' };
    rememberIssuedCode(lane, current.code);
    indexLaneCode(codeIndex, lane, { epochN: epoch?.n ?? null, servedAt: null });
    return true;
  }

  async function applyReadResult(lane, raw, { fromStatus = false, recoveryStage = null } = {}) {
    const result = normalizeSourceResult(raw);
    const stamp = safeNow(now);
    if (result.kind === 'open') {
      const code = result.handoff?.code ?? result.handoff?.handoffCode;
      const sameRecoveryStage = typeof recoveryStage === 'string' && result.handoff?.stage === recoveryStage;
      if (lane.phase === 'awaiting' && isHumanAdvance(lane, code) && !sameRecoveryStage) {
        holdLane(lane, 'human_advance', stamp);
        await persistLanes();
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
      await persistLanes();
    } else if (result.kind === 'gone') {
      lane.phase = 'gone';
      lane.reason = null;
      lane.snapshot = { at: stamp, kind: 'gone' };
      await persistLanes();
    } else if (result.kind === 'threw') {
      if (result.code === 'LOCAL_AI_JOB_INTEGRITY') holdLane(lane, 'job_broken', stamp);
      else if (result.code === 'ENOENT' && !fromStatus) return statusLane(lane, { readAfterAwaiting: false });
      else if (result.code === 'ENOENT') holdLane(lane, 'canvas_unavailable', stamp);
      else if (++lane.counters.errStreak >= CONSTANTS.APPLICATION_ERROR_STREAK) holdLane(lane, 'read_failed', stamp);
      lane.snapshot = { at: stamp, kind: 'threw', code: result.code ?? 'internal_error' };
      if (['held', 'needs_user'].includes(lane.phase)) await persistLanes();
    }
    return result;
  }

  async function raceLaneCall(lane, slot, promise) {
    const timedOut = Symbol('lane-call-timeout');
    const result = await raceWithBudget(promise, readWatchdogMs, timedOut);
    if (result !== timedOut) return result;
    if (lane.inFlight[slot] === promise) lane.inFlight[slot] = null;
    lane.snapshot = { at: safeNow(now), kind: 'busy' };
    wake();
    return { kind: 'busy' };
  }

  function startLaneCall(lane, slot, call, apply) {
    if (lane.inFlight[slot]) return lane.inFlight[slot];
    let promise;
    promise = Promise.resolve()
      .then(call)
      .then(apply)
      .catch(error => apply({ kind: 'threw', code: typeof error?.code === 'string' ? error.code : 'internal_error' }))
      .finally(() => {
        if (lane.inFlight[slot] === promise) lane.inFlight[slot] = null;
      });
    lane.inFlight[slot] = promise;
    return promise;
  }

  async function readLane(lane, { recoveryStage = null } = {}) {
    const promise = startLaneCall(
      lane,
      'read',
      () => application.read({ jobId: lane.jobId, canvasFilePath: lane.canvasFilePath }),
      result => applyReadResult(lane, result, { recoveryStage }),
    );
    return raceLaneCall(lane, 'read', promise);
  }

  async function applyStatusResult(lane, raw, { readAfterAwaiting = true } = {}) {
    const result = normalizeSourceResult(raw);
    if (result.kind === 'open' || result.kind === 'host' || result.kind === 'done' || result.kind === 'gone' || result.kind === 'threw') {
      await applyReadResult(lane, result, { fromStatus: true });
      if (result.read === true) return readLane(lane);
      return result;
    }
    if (result.kind === 'awaiting') {
      lane.phase = 'unread';
      lane.snapshot = null;
      return readAfterAwaiting ? readLane(lane) : result;
    }
    if (result.kind === 'needs_user') {
      holdLane(lane, result.reason || 'read_failed', safeNow(now));
      await persistLanes();
      return result;
    }
    return result;
  }

  async function statusLane(lane, { readAfterAwaiting = true } = {}) {
    const promise = startLaneCall(
      lane,
      'status',
      () => application.status({ jobId: lane.jobId, canvasFilePath: lane.canvasFilePath }),
      result => applyStatusResult(lane, result, { readAfterAwaiting }),
    );
    return raceLaneCall(lane, 'status', promise);
  }

  function canAssign(lane) {
    if (!epoch) return false;
    if (epoch.assignedLaneOrds.has(lane.ord)) return true;
    return epoch.assignedLaneOrds.size < limits.jobsPerChat
      && epoch.bytesServed + epoch.bytesReceived < limits.epochSoftBytes;
  }

  function chooseAwaiting() {
    if (!epoch) return null;
    const focus = lanes.find(lane => lane.ord === epoch.focusLaneOrd && lane.phase === 'awaiting' && canAssign(lane));
    if (focus) return focus;
    const outstanding = lanes.find(lane => lane.phase === 'awaiting' && lane.servedAt != null && canAssign(lane));
    if (outstanding) return outstanding;
    return [...lanes]
      .filter(lane => lane.phase === 'awaiting' && canAssign(lane))
      .sort((a, b) => a.releasedAt - b.releasedAt || a.ord - b.ord)[0] ?? null;
  }

  async function refreshOneLane() {
    const invalidated = [...lanes]
      .filter(lane => lane.phase === 'awaiting' && lane.needsRefresh === true)
      .sort((a, b) => a.releasedAt - b.releasedAt || a.ord - b.ord)[0];
    if (invalidated) {
      invalidated.needsRefresh = false;
      return readLane(invalidated);
    }
    const unread = [...lanes].filter(lane => lane.phase === 'unread').sort((a, b) => a.releasedAt - b.releasedAt || a.ord - b.ord)[0];
    if (unread) return readLane(unread);
    const stamp = safeNow(now);
    const host = [...lanes]
      .filter(lane => lane.phase === 'host'
        && (!lane.snapshot || stamp - lane.snapshot.at >= CONSTANTS.HOST_POLL_MS))
      .sort((a, b) => (a.hostSince ?? 0) - (b.hostSince ?? 0))[0];
    if (host) {
      if (host.hostSince && stamp - host.hostSince >= CONSTANTS.HOST_SILENT_MS) {
        holdLane(host, 'host_silent', stamp);
        await persistLanes();
        return { kind: 'needs_user' };
      }
      return statusLane(host);
    }
    return null;
  }

  function serveLane(lane) {
    const marker = epoch.servedPrompt.get(lane.ord);
    const servedBefore = marker?.stage === lane.current.stage && marker?.code === lane.current.code;
    lane.current.attempt = (lane.counters.attemptByStage[`${lane.current.stage}@${lane.current.revision}`] ?? 0) + 1;
    lane.counters.attemptByStage[`${lane.current.stage}@${lane.current.revision}`] = lane.current.attempt;
    const body = makeServedBody({ lane, remaining: remainingCounts(lanes), servedBefore });
    const stamp = safeNow(now);
    lane.servedAt = stamp;
    lane.serves++;
    epoch.servedPrompt.set(lane.ord, { stage: lane.current.stage, code: lane.current.code });
    epoch.assignedLaneOrds.add(lane.ord);
    epoch.focusLaneOrd = lane.ord;
    epoch.lastGetAt = stamp;
    epoch.bytesServed += Buffer.byteLength(JSON.stringify(body), 'utf8');
    counts.getServed++;
    auditEvent('served', { tool: 'get_handoff', outcome: 'ok', stage: lane.current.stage });
    const idleNoticeMs = CONSTANTS.SERVE_AFTER_IDLE_NOTICE_HOURS * 3_600_000;
    if (stamp - lastHumanActionAt >= idleNoticeMs && stamp - lastIdleNoticeAt >= 3_600_000) {
      lastIdleNoticeAt = stamp;
      try { onServeAfterIdle({ hours: Math.floor((stamp - lastHumanActionAt) / 3_600_000) }); } catch { /* contained */ }
    }
    return body;
  }

  function terminalDrain() {
    return lanes.length === 0 || lanes.every(lane => ['done', 'gone'].includes(lane.phase));
  }

  async function get(args = {}) {
    const blocked = gate(args);
    if (blocked) {
      if (blocked.status === 'paused') counts.getPaused++;
      return blocked;
    }
    if (args.canvasOpen === false) return makeResultBody('app_unavailable');
    if (epoch.bytesServed + epoch.bytesReceived >= limits.epochHardBytes) return makeResultBody('session_full');
    const stamp = safeNow(now);
    if (lastGetAt != null && stamp - lastGetAt >= CONSTANTS.WAIT_COUNTER_RESET_IDLE_MS) epoch.consecutiveWaits = 0;
    lastGetAt = stamp;

    if (lanes.some(item => item.needsRefresh === true)) await refreshOneLane();
    let lane = chooseAwaiting();
    if (!lane) {
      await refreshOneLane();
      lane = chooseAwaiting();
    }
    if (lane) return serveLane(lane);

    const working = lanes.some(item => ['unread', 'host'].includes(item.phase) || item.inFlight.read || item.inFlight.status || item.inFlight.submit);
    if (working) {
      await waitForWake(holdMs);
      await refreshOneLane();
      lane = chooseAwaiting();
      if (lane) return serveLane(lane);
      epoch.consecutiveWaits++;
      if (epoch.consecutiveWaits >= CONSTANTS.MAX_CONSECUTIVE_WAITS) {
        counts.getPaused++;
        return makeResultBody('paused', { reason: 'waiting_limit', remaining: remainingCounts(lanes) });
      }
      counts.getWaiting++;
      return makeResultBody('waiting', { pollCount: epoch.consecutiveWaits, retryAfterSeconds: 5, remaining: remainingCounts(lanes) });
    }

    if (lanes.some(item => ['held', 'needs_user'].includes(item.phase))) {
      counts.getPaused++;
      return makeResultBody('paused', { reason: 'needs_user', remaining: remainingCounts(lanes) });
    }
    if (lanes.some(item => item.phase === 'awaiting' && !canAssign(item))) {
      return makeResultBody('session_full', { remaining: remainingCounts(lanes) });
    }
    counts.getEmpty++;
    const result = makeResultBody('queue_empty', { remaining: remainingCounts(lanes) });
    if (terminalDrain()) retireEpoch('drained');
    return result;
  }

  function tombstoneResult(code) {
    const tombstone = tombstones.get(code);
    if (!tombstone) return makeResultBody('unknown_handoff');
    if (tombstone.reason === 'accepted') {
      counts.submitDuplicate++;
      return makeResultBody('duplicate');
    }
    counts.submitSuperseded++;
    return makeResultBody('superseded');
  }

  async function persistCap(lane, reason) {
    holdLane(lane, reason, safeNow(now));
    await persistLanes();
    wake();
  }

  async function callApplicationSubmit(lane, code, text) {
    const task = Promise.resolve().then(() => application.submit({
      jobId: lane.jobId,
      canvasFilePath: lane.canvasFilePath,
    }, { code, text }));
    lane.inFlight.submit = task;
    const timeout = Symbol('submit-stuck');
    try {
      const settled = await raceWithBudget(
        task.then(value => ({ value }), error => ({ error })),
        CONSTANTS.SUBMIT_STUCK_MS,
        timeout,
      );
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
      if (lane.inFlight.submit === task) lane.inFlight.submit = null;
    }
  }

  async function mapSubmitResult(lane, text, result, retryCount = 0) {
    const stamp = safeNow(now);
    const currentCode = lane.current?.code;
    if (result.kind === 'submit_stuck') {
      await persistCap(lane, 'submit_stuck');
      return makeResultBody('needs_user', { reason: 'submit_stuck' });
    }
    if (result.kind === 'accepted') {
      tombstoneCode(tombstones, currentCode, 'accepted', { laneOrd: lane.ord, at: stamp });
      codeIndex.delete(currentCode);
      const fingerprint = responseFingerprint(text);
      if (fingerprint) {
        lane.acceptedFingerprints.add(fingerprint);
        while (lane.acceptedFingerprints.size > 32) lane.acceptedFingerprints.delete(lane.acceptedFingerprints.values().next().value);
      }
      lane.counters.rejections = 0;
      lane.counters.junkStreak = 0;
      lane.counters.errStreak = 0;
      lane.retained = null;
      counts.submitAccepted++;
      auditEvent('accepted', { tool: 'submit_handoff', outcome: 'accepted', stage: lane.current?.stage ?? 'unknown' });
      if (result.completed || !result.handoff) {
        lane.phase = 'host';
        lane.hostSince = stamp;
        lane.current = null;
        await persistLanes();
        wake();
        return makeResultBody('accepted', { jobComplete: true, next: null });
      }
      const priorStage = lane.current?.stage;
      if (!adoptCurrent(lane, result.handoff)) {
        await persistCap(lane, 'write_failed');
        return makeResultBody('needs_user', { reason: 'write_failed' });
      }
      if (priorStage === 'review' && lane.current.stage === 'review') lane.counters.revisedRounds++;
      if (lane.counters.revisedRounds >= CONSTANTS.APPLICATION_MAX_REVISED_ROUNDS) {
        await persistCap(lane, 'review_round_cap');
        return makeResultBody('held', { reason: 'review_round_cap' });
      }
      await persistLanes();
      wake();
      return makeResultBody('accepted', { jobComplete: false, next: serveLane(lane) });
    }

    if (result.kind === 'rejected') {
      lane.retained = null;
      lane.counters.rejections++;
      lane.counters.junkStreak = 0;
      lane.counters.errStreak = 0;
      const returned = normalizeCurrentHandoff(result.handoff, stamp);
      if (returned) {
        if (returned.code !== currentCode) {
          tombstoneCode(tombstones, currentCode, 'rotated', { laneOrd: lane.ord, at: stamp });
          codeIndex.delete(currentCode);
        }
        lane.current = returned;
        rememberIssuedCode(lane, returned.code);
        indexLaneCode(codeIndex, lane, { epochN: epoch?.n ?? null, servedAt: null });
      }
      const errors = result.validationErrors?.length ? result.validationErrors : lane.current?.corrections;
      if (lane.current) {
        lane.current.corrections = Array.isArray(errors) ? errors : [];
        if (typeof result.correctionPrompt === 'string') lane.current.correctionPrompt = result.correctionPrompt;
      }
      counts.submitRejected++;
      auditEvent('rejected', { tool: 'submit_handoff', outcome: 'rejected', stage: lane.current?.stage ?? 'unknown' });
      if (lane.counters.rejections >= CONSTANTS.APPLICATION_MAX_REJECTIONS) {
        await persistCap(lane, 'rejection_cap');
        return makeResultBody('held', { reason: 'rejection_cap' });
      }
      await persistLanes();
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
        await persistCap(lane, 'job_broken');
        return makeResultBody('needs_user', { reason: 'job_broken', note: 'Infinite Canvas found an integrity problem in this application bundle.' });
      }
      if (retryCount < 2) {
        const originalStage = result.stage ?? lane.current?.stage;
        const reread = await readLane(lane, { recoveryStage: originalStage });
        if (reread?.kind === 'open' && lane.current) {
          const freshStage = reread.handoff?.stage ?? lane.current.stage;
          if (originalStage && freshStage !== originalStage) {
            return makeResultBody('superseded', { note: supersededStageNote(originalStage, freshStage) });
          }
          const retried = await callApplicationSubmit(lane, lane.current.code, text);
          return mapSubmitResult(lane, text, retried, retryCount + 1);
        }
        if (lane.phase === 'host') return makeResultBody('superseded');
      }
      lane.counters.errStreak++;
      if (lane.counters.errStreak >= CONSTANTS.APPLICATION_ERROR_STREAK) {
        await persistCap(lane, 'write_failed');
        return makeResultBody('needs_user', { reason: 'write_failed' });
      }
      await persistLanes();
      return makeResultBody('retry', { inFlight: false });
    }
    return makeResultBody('retry');
  }

  async function runSubmit(lane, text) {
    await semaphore.acquire();
    try {
      const code = lane.current.code;
      const key = verdictKey(code, text);
      const retained = lane.retained;
      if (retained?.code === code && retained.sha256 !== key) {
        const recovered = await callApplicationSubmit(lane, retained.code, retained.text);
        if (recovered.kind === 'accepted' || recovered.kind === 'submit_stuck') {
          return mapSubmitResult(lane, retained.text, recovered, 2);
        }
      }
      lane.submittedAt = safeNow(now);
      lane.retained = { code, text, sha256: key, at: lane.submittedAt };
      const result = await callApplicationSubmit(lane, code, text);
      return await mapSubmitResult(lane, text, result);
    } finally {
      semaphore.release();
      wake();
    }
  }

  async function submit(args = {}) {
    const blocked = gate(args);
    if (blocked) return blocked;
    if (args.canvasOpen === false) return makeResultBody('app_unavailable');
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
    epoch.bytesReceived += bytes;
    epoch.lastSubmitAt = safeNow(now);
    const code = trimHandoffCode(args.handoffCode);
    const entry = codeIndex.get(code);
    if (!entry?.lane) return tombstoneResult(code);
    const lane = entry.lane;
    if (lane.phase === 'held') { counts.submitHeld++; return makeResultBody('held', { reason: lane.reason }); }
    if (lane.phase === 'needs_user') return makeResultBody('needs_user', { reason: lane.reason });
    if (lane.phase === 'host') { counts.submitSuperseded++; return makeResultBody('superseded'); }
    if (lane.phase === 'gone' || !lane.current) return makeResultBody('unknown_handoff');

    const classification = classifySubmission({ response: text, lane, lanes });
    if (classification !== 'pass') {
      if (classification === 'junk') {
        counts.submitJunk++;
        lane.counters.junkStreak++;
        if (lane.counters.junkStreak >= CONSTANTS.APPLICATION_MAX_JUNK_STREAK) await persistCap(lane, 'junk_cap');
      } else if (classification === 'misrouted') counts.submitMisrouted++;
      else counts.submitSuperseded++;
      const gotStage = extractPasteEnvelopeIdentity(text).stage;
      return makeResultBody(classification, classification === 'superseded' && gotStage
        ? { note: supersededStageNote(gotStage, lane.current.stage) }
        : {});
    }

    const key = verdictKey(code, text);
    const cached = verdicts.get(key);
    if (cached && cached.epochN === epoch.n && safeNow(now) - cached.at <= CONSTANTS.VERDICT_CACHE_MS) {
      if (cached.verdict) return cached.verdict;
      return raceWithBudget(cached.promise, submitBudgetMs, makeResultBody('retry', { inFlight: true }));
    }
    const promise = runSubmit(lane, text);
    const record = { at: safeNow(now), epochN: epoch.n, promise, verdict: null };
    verdicts.set(key, record);
    promise.then(verdict => { record.verdict = verdict; record.promise = null; }, () => { verdicts.delete(key); });
    for (const [cacheKey, value] of verdicts) if (safeNow(now) - value.at > CONSTANTS.VERDICT_CACHE_MS) verdicts.delete(cacheKey);
    return raceWithBudget(promise, submitBudgetMs, makeResultBody('retry', { inFlight: true }));
  }

  async function confirmRestartIfNeeded() {
    if (restartConfirmed) return true;
    let accepted = false;
    try { accepted = await confirmRestart(lanes.map(lane => lane.ord)); } catch { accepted = false; }
    if (!accepted) return false;
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
    if (!await persistLanes()) {
      restartConfirmed = false;
      lastHumanActionAt = priorHumanActionAt;
      for (const state of prior) {
        const { lane, ...values } = state;
        Object.assign(lane, values);
      }
      return false;
    }
    auditEvent('restart_confirmed');
    return true;
  }

  async function prepareChat({ linkId, kind = 'new' } = {}) {
    if (typeof linkId !== 'string' || !linkId) return { copied: false, status: 'unlinked' };
    if (!await confirmRestartIfNeeded()) return { copied: false, status: 'paused', reason: 'restart' };
    const sessionCode = makeChatKey(random);
    const prepared = {
      n: epochOrdinal + 1,
      linkId,
      keyHash: epochHash(linkId, sessionCode),
      mintedAt: safeNow(now),
      bytesServed: 0,
      bytesReceived: 0,
      lastGetAt: null,
      lastSubmitAt: null,
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

  async function release({ jobs = [] } = {}) {
    if (!Array.isArray(jobs) || jobs.length === 0) return { ok: false, code: 'invalid_arguments' };
    const unique = new Map();
    for (const item of jobs) {
      if (!item || !JOB_ID_RE.test(String(item.jobId || '')) || !isAbsoluteCanvasPath(item.canvasFilePath)) {
        return { ok: false, code: 'invalid_arguments' };
      }
      unique.set(item.jobId, { jobId: item.jobId, canvasFilePath: item.canvasFilePath });
    }
    const additions = [...unique.values()].filter(item => !lanes.some(lane => lane.jobId === item.jobId));
    if (lanes.filter(lane => !['done', 'gone'].includes(lane.phase)).length + additions.length > CONSTANTS.MAX_LANES) {
      return { ok: false, code: 'lane_limit' };
    }
    const beforeLanes = lanes.slice();
    const beforePaths = new Map(beforeLanes.map(lane => [lane, lane.canvasFilePath]));
    const beforeLaneOrdinal = laneOrdinal;
    for (const item of unique.values()) {
      const existing = lanes.find(lane => lane.jobId === item.jobId);
      if (existing) {
        if (existing.canvasFilePath !== item.canvasFilePath && typeof application.adoptCanvasPath === 'function') {
          try {
            const adopted = await application.adoptCanvasPath(existing.jobId, item.canvasFilePath, existing.canvasFilePath);
            if (adopted?.adopted === true) existing.canvasFilePath = item.canvasFilePath;
          } catch { /* keep the trusted old path */ }
        }
        continue;
      }
      lanes.push(createApplicationLane({
        ord: ++laneOrdinal,
        jobId: item.jobId,
        canvasFilePath: item.canvasFilePath,
        releasedAt: safeNow(now),
      }));
    }
    if (!await persistLanes()) {
      lanes.splice(0, lanes.length, ...beforeLanes);
      for (const [lane, canvasFilePath] of beforePaths) lane.canvasFilePath = canvasFilePath;
      laneOrdinal = beforeLaneOrdinal;
      return { ok: false, code: 'persist_failed' };
    }
    humanAction();
    auditEvent('release', { count: unique.size });
    wake();
    return { ok: true, count: unique.size };
  }

  async function unrelease(jobId) {
    const index = lanes.findIndex(lane => lane.jobId === jobId);
    if (index < 0) return { ok: false, code: 'not_found' };
    const [lane] = lanes.splice(index, 1);
    const removedCodes = [];
    for (const [code, entry] of codeIndex) {
      if (entry.lane !== lane) continue;
      removedCodes.push([code, entry]);
      codeIndex.delete(code);
    }
    if (!await persistLanes()) {
      lanes.splice(index, 0, lane);
      for (const [code, entry] of removedCodes) codeIndex.set(code, entry);
      return { ok: false, code: 'persist_failed' };
    }
    humanAction();
    auditEvent('unrelease');
    wake();
    return { ok: true };
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
    };
    try { holdLane(lane, reason, safeNow(now)); }
    catch { return { ok: false, code: 'invalid_arguments' }; }
    if (!await persistLanes()) {
      Object.assign(lane, prior);
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
      const prior = {
        phase: lane.phase,
        reason: lane.reason,
        heldFrom: lane.heldFrom,
        snapshot: lane.snapshot,
      };
      resumeLane(lane);
      if (!lane.current && ['awaiting', 'host'].includes(lane.phase)) lane.phase = 'unread';
      if (!await persistLanes()) {
        Object.assign(lane, prior);
        return { ok: false, code: 'persist_failed' };
      }
    } else {
      paused = false;
      pauseCause = null;
    }
    humanAction();
    auditEvent('resume', { cause: jobId ? 'lane' : 'bridge' });
    wake();
    return { ok: true };
  }

  function pause(cause = 'user') {
    paused = true;
    pauseCause = cause;
    counts.pauses++;
    auditEvent('pause', { cause });
    wake();
    return { ok: true };
  }

  function hint({ jobId } = {}) {
    const lane = lanes.find(item => item.jobId === jobId);
    if (!lane || ['done', 'gone'].includes(lane.phase)) return false;
    const stamp = safeNow(now);
    const last = lastHintAt.get(lane.ord) ?? -Infinity;
    const invalidate = () => {
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
        const lane = rehydrateApplicationLane(value, safeNow(now));
        lanes.push(lane);
        laneOrdinal = Math.max(laneOrdinal, lane.ord);
      } catch { /* unknown/corrupt lanes are skipped */ }
    }
    restartConfirmed = lanes.length === 0;
    return lanes.length;
  }

  function snapshot() {
    const queue = remainingCounts(lanes);
    return Object.freeze({
      paused,
      pauseCause,
      fault,
      autoStart: autoStart === true,
      chat: Object.freeze({
        ordinal: epoch?.n ?? 0,
        state: epoch ? 'active' : 'none',
        jobsAssigned: epoch?.assignedLaneOrds.size ?? 0,
        jobsCap: limits.jobsPerChat,
        bytesServed: epoch?.bytesServed ?? 0,
        bytesReceived: epoch?.bytesReceived ?? 0,
      }),
      queue: Object.freeze({ ...queue, jobs: lanes.map(lane => Object.freeze({ ord: lane.ord, phase: lane.phase, reason: lane.reason })) }),
      counts: Object.freeze({ ...counts }),
    });
  }

  function debugState() {
    return Object.freeze({ submitActive: semaphore.active(), submitWaiting: semaphore.waiting(), waiters: waiters.size });
  }

  function setLimits(next) {
    limits = normalizeLimits({ ...limits, ...next });
    return { ...limits };
  }

  async function close() {
    closed = true;
    retireEpoch('closed');
    for (const timer of hintTimers.values()) clearTimer(timer);
    hintTimers.clear();
    semaphore.close();
    wake();
  }

  restore(restoredLanes);

  return Object.freeze({
    get,
    submit,
    release,
    unrelease,
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
    setLimits,
    close,
  });
}

export default createHandoffEngine;
