import {
  discoverLocalApplicationJobs,
  getLocalApplicationHandoff,
  localApplicationStatus,
  submitLocalApplicationHandoff,
  subscribeLocalApplicationDiscards,
} from '../../localAiApplication.js';

// The only bridge-side view of the app's bundle-removal chokepoint. The
// composition uses the per-source method below; index.js uses this one when
// no runtime exists yet (a discard or completed save while the bridge is off
// still has to free its durable lane). Listeners receive { jobId,
// canvasFilePath, cause } where cause is a closed enum.
export function subscribeApplicationDiscards(listener) {
  return subscribeLocalApplicationDiscards(listener);
}

const WATCHDOG_MS = 8_000;
const CONFIRM_TEXT_MAX_CHARS = 60;
// Authority matching deliberately exposes one bounded live wave. Keep this
// projection bounded too: injected adapters must not turn one handoff into an
// unbounded number of durable bridge lanes.
const MAX_APPLICATION_PARALLEL_TASKS = 10;
const INTEGRITY_MESSAGE = 'This application needs attention before it can continue.';
const CONTROL_OR_BIDI = new RegExp(String.raw`[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]`, 'g');
const FRESH_CONTEXT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function validFreshContextKey(value) {
  return typeof value === 'string' && FRESH_CONTEXT_KEY.test(value);
}

function operationKey(lane) {
  return `${String(lane?.jobId || '')}\u0000${String(lane?.canvasFilePath || '')}\u0000${String(lane?.matchTaskId || '')}`;
}

function copyParallelTaskForecast(value, parallelTaskCount) {
  if (!value || typeof value !== 'object') return null;
  const { totalUnits, completedUnits, remainingUnits, activeWaveUnits } = value;
  if (![totalUnits, completedUnits, remainingUnits, activeWaveUnits]
    .every(unit => Number.isSafeInteger(unit) && unit >= 0)
    || completedUnits > totalUnits
    || remainingUnits !== totalUnits - completedUnits
    || activeWaveUnits > totalUnits
    || activeWaveUnits > MAX_APPLICATION_PARALLEL_TASKS
    || parallelTaskCount > activeWaveUnits) return null;
  return { totalUnits, completedUnits, remainingUnits, activeWaveUnits };
}

function copyHandoff(value) {
  const handoff = value && typeof value === 'object' ? value : null;
  const code = handoff?.handoffCode ?? handoff?.code;
  if (!nonEmptyString(code) || !nonEmptyString(handoff?.stage) || !nonEmptyString(handoff?.prompt)) return null;
  if (handoff.freshContextKey !== undefined && !validFreshContextKey(handoff.freshContextKey)) return null;
  const parallelTasks = Array.isArray(handoff.parallelTasks)
    ? handoff.parallelTasks.slice(0, MAX_APPLICATION_PARALLEL_TASKS)
      .map(task => typeof task?.id === 'string' ? { id: task.id } : null)
      .filter(Boolean)
    : null;
  const parallelTaskForecast = copyParallelTaskForecast(handoff.parallelTaskForecast, parallelTasks?.length || 0);
  const copied = {
    code,
    stage: handoff.stage,
    revision: Number.isInteger(handoff.revision) ? handoff.revision : 0,
    prompt: handoff.prompt,
    corrections: Array.isArray(handoff.corrections) ? handoff.corrections.filter(item => typeof item === 'string') : [],
    correctionPrompt: typeof handoff.correctionPrompt === 'string' ? handoff.correctionPrompt : '',
    recovered: Boolean(handoff.correctionsRecovered),
    draftBytes: Buffer.byteLength(typeof handoff.draft === 'string' ? handoff.draft : '', 'utf8'),
    // Task ids are opaque queue-claim identities. They deliberately never
    // appear in the public handoff body; the engine uses them only to route a
    // virtual career-match lane back to the app.
    ...(nonEmptyString(handoff.matchTaskId) ? { matchTaskId: handoff.matchTaskId } : {}),
    ...(parallelTasks ? { parallelTasks } : {}),
    // Aggregate work remains app-owned; the bridge only materializes the
    // bounded live wave. Preserve the exact forecast for pool telemetry
    // without turning a large Cartesian plan into lanes.
    ...(parallelTaskForecast ? { parallelTaskForecast } : {}),
  };
  // Main-process-only transition metadata: non-enumerable so object spreads,
  // JSON audits, and persistence cannot publish the chat-boundary request.
  if (handoff.freshContextRequired === true) {
    Object.defineProperty(copied, 'freshContextRequired', {
      value: true, enumerable: false, configurable: false, writable: false,
    });
  }
  if (validFreshContextKey(handoff.freshContextKey)) {
    Object.defineProperty(copied, 'freshContextKey', {
      value: handoff.freshContextKey, enumerable: false, configurable: false, writable: false,
    });
  }
  return copied;
}

/**
 * This deliberately exposes only the three Source operations.  The injected
 * port is for deterministic tests; production uses the four frozen exports
 * above and this is the only bridge module which imports that file.
 */
export function createApplicationSource({
  api = {},
  getHandoff = api.getLocalApplicationHandoff || getLocalApplicationHandoff,
  submitHandoff = api.submitLocalApplicationHandoff || submitLocalApplicationHandoff,
  getStatus = api.localApplicationStatus || localApplicationStatus,
  discover = api.discoverLocalApplicationJobs || discoverLocalApplicationJobs,
  watchdogMs = WATCHDOG_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  codeGuard = null,
  subscribeDiscards = api.subscribeLocalApplicationDiscards || subscribeLocalApplicationDiscards,
} = {}) {
  let guard = null;
  function setCodeGuard(value) {
    if (!value || typeof value.key !== 'function' || typeof value.digest !== 'function'
        || typeof value.sameDigest !== 'function' || typeof value.equal !== 'function') throw new TypeError('A handoff-code guard is required');
    guard = value;
    return true;
  }
  if (codeGuard) setCodeGuard(codeGuard);
  function requireCodeGuard() {
    if (!guard) throw new TypeError('A handoff-code guard is required');
    return guard;
  }
  const inFlight = {
    read: new Map(),
    status: new Map(),
    submit: new Map(),
    discover: new Map(),
  };

  function callOnce(kind, key, fn) {
    const existing = inFlight[kind].get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(fn);
    inFlight[kind].set(key, promise);
    promise.then(
      () => { if (inFlight[kind].get(key) === promise) inFlight[kind].delete(key); },
      () => { if (inFlight[kind].get(key) === promise) inFlight[kind].delete(key); },
    );
    return promise;
  }

  async function withWatchdog(promise) {
    if (!Number.isFinite(watchdogMs) || watchdogMs < 0 || typeof setTimeoutImpl !== 'function') return promise;
    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise(resolve => {
          timer = setTimeoutImpl(() => resolve({ timeout: true }), watchdogMs);
          timer?.unref?.();
        }),
      ]);
    } finally {
      if (timer !== null && typeof clearTimeoutImpl === 'function') clearTimeoutImpl(timer);
    }
  }

  async function bounded(kind, key, fn) {
    try {
      const result = await withWatchdog(callOnce(kind, key, fn));
      return result?.timeout === true ? { timeout: true } : { result };
    } catch (error) {
      return { error };
    }
  }

  return Object.freeze({
    kind: 'application',
    setCodeGuard,

    // Tells the engine when a bundle it may have released stops existing. A
    // replaced/injected api without the seam simply never fires.
    subscribeDiscard(listener) {
      if (typeof listener !== 'function' || typeof subscribeDiscards !== 'function') return () => undefined;
      return subscribeDiscards(listener) || (() => undefined);
    },

    async read(lane) {
      const key = operationKey(lane);
      const outcome = await bounded('read', key, () => getHandoff({ jobId: lane?.jobId, canvasFilePath: lane?.canvasFilePath, matchTaskId: lane?.matchTaskId }));
      if (outcome.timeout) return { kind: 'busy' };
      if (outcome.error) return { kind: 'threw', ...classifyApplicationThrow(outcome.error) };
      if (outcome.result?.completed === true) return { kind: 'host' };
      const handoff = copyHandoff(outcome.result?.handoff);
      return handoff ? {
        kind: 'open', handoff,
        ...(nonEmptyString(handoff.matchTaskId) ? { matchTaskId: handoff.matchTaskId } : {}),
        ...(Array.isArray(handoff.parallelTasks) ? { parallelTasks: handoff.parallelTasks } : {}),
        ...(handoff.parallelTaskForecast ? { parallelTaskForecast: handoff.parallelTaskForecast } : {}),
      } : { kind: 'threw', shape: true };
    },

    async status(lane) {
      const key = operationKey(lane);
      const outcome = await bounded('status', key, () => getStatus(lane?.jobId, lane?.canvasFilePath, { absentRootIsGone: true, matchTaskId: lane?.matchTaskId }));
      if (outcome.timeout) return { kind: 'busy' };
      if (outcome.error) return { kind: 'threw', ...classifyApplicationThrow(outcome.error) };
      return mapApplicationStatus(outcome.result);
    },

    async submit(lane, { code, text } = {}) {
      const handoffCodeGuard = requireCodeGuard();
      const key = `${operationKey(lane)}\u0000${handoffCodeGuard.key(code)}\u0000${String(text || '')}`;
      // A submit must run to its app-side commit point.  It is single-flight,
      // but intentionally has no source watchdog: the engine owns its 25 s
      // response budget and leaves an accepted write running after a timeout.
      try {
        const result = await callOnce('submit', key, () => submitHandoff({
          jobId: lane?.jobId,
          canvasFilePath: lane?.canvasFilePath,
          matchTaskId: lane?.matchTaskId,
          handoffCode: code,
          response: text,
        }));
        const handoff = copyHandoff(result?.handoff);
        if (result?.accepted === true) {
          return { kind: 'accepted', completed: result.completed === true, ...(handoff ? { handoff, next: handoff } : {}) };
        }
        if (result?.accepted === false && handoff) {
          return {
            kind: 'rejected',
            validationErrors: Array.isArray(result.validationErrors) ? result.validationErrors.filter(item => typeof item === 'string') : [],
            handoff,
            rotated: !handoffCodeGuard.equal(handoff.code, code),
          };
        }
        return { kind: 'threw', shape: true };
      } catch (error) {
        return { kind: 'threw', ...classifyApplicationThrow(error) };
      }
    },

    // `requireAll: false` is for callers that can act on a subset (auto
    // release, the restart and enable sheets): one job that vanished must not
    // blank the names of every live job beside it. The default still fails
    // closed for the manual release confirmation, which must show exactly what
    // it will release.
    async describeForConfirm(canvasFilePath, jobIds, { requireAll = true } = {}) {
      const wanted = Array.isArray(jobIds) ? jobIds.filter(id => typeof id === 'string') : [];
      const discoveredOutcome = await bounded('discover', String(canvasFilePath || ''), () => discover(canvasFilePath));
      if (discoveredOutcome.timeout) return { ok: false, code: 'busy', canvasFilePath: null, items: [] };
      if (discoveredOutcome.error) return { ok: false, code: 'unavailable', canvasFilePath: null, items: [] };
      const discovered = discoveredOutcome.result;
      if (!Array.isArray(discovered)) return { ok: false, code: 'unavailable', canvasFilePath: null, items: [] };
      const canonical = discovered.find(item => typeof item?.canvasFilePath === 'string')?.canvasFilePath || null;
      const byId = new Map(discovered.filter(item => item && typeof item.id === 'string').map(item => [item.id, item]));
      const present = wanted.filter(id => byId.has(id));
      if (present.length === 0 || (requireAll !== false && present.length !== wanted.length)) return { ok: false, code: 'unknown_job', canvasFilePath: canonical, items: [] };
      const items = present.map(id => {
        const item = byId.get(id);
        return Object.freeze({
          jobId: id,
          title: cleanConfirmText(item?.job?.title),
          company: cleanConfirmText(item?.job?.company),
          createdAt: validCreatedAt(item?.createdAt),
        });
      });
      return Object.freeze({ ok: true, canvasFilePath: canonical, items: Object.freeze(items) });
    },

    async adoptCanvasPath(jobId, newPath, oldPath = null) {
      const key = `${String(jobId || '')}\u0000${String(newPath || '')}`;
      const outcome = await bounded('status', key, () => getStatus(jobId, newPath));
      if (!outcome.timeout && !outcome.error && isAdoptableStatus(outcome.result)) return { adopted: true, canvasFilePath: newPath };
      // Ownership, filesystem, and watchdog failures deliberately leave the
      // persisted lane path alone.
      return { adopted: false, canvasFilePath: oldPath };
    },

    isAutoReleaseEligible(item, processStartedAt) {
      const createdAt = Date.parse(validCreatedAt(item?.createdAt) || '');
      const launchedAt = Number(processStartedAt);
      return Number.isFinite(createdAt) && Number.isFinite(launchedAt) && createdAt > launchedAt;
    },
  });
}

export function createApplicationSourceAdapter(options) {
  return createApplicationSource(options);
}

export function classifyApplicationThrow(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const safeCode = ['LOCAL_AI_JOB_INTEGRITY', 'ENOENT', 'EACCES', 'EPERM'].includes(code) ? code : 'internal_error';
  return Object.freeze({
    code: safeCode,
    integrity: code === 'LOCAL_AI_JOB_INTEGRITY',
    enoent: code === 'ENOENT',
    eaccess: code === 'EACCES' || code === 'EPERM',
    ...(code === 'LOCAL_AI_JOB_INTEGRITY' ? { message: INTEGRITY_MESSAGE } : {}),
  });
}

export function mapApplicationStatus(status) {
  const value = status && typeof status === 'object' ? status : null;
  if (value?.status === 'saved') return { kind: 'done', phase: 'done' };
  if (value?.status === 'failed') return value.folder === null
    ? { kind: 'gone', phase: 'gone' }
    : { kind: 'needs_user', phase: 'needs_user', reason: 'job_broken' };
  if (value?.status === 'queued') return value.stage === 'completed'
    ? { kind: 'host', phase: 'host' }
    : { kind: 'awaiting', phase: 'awaiting', read: true };
  if (value?.status === 'completed' || value?.status === 'importing') return { kind: 'host', phase: 'host' };
  if (value?.status === 'revision-required' || value?.status === 'invalid') return { kind: 'host', phase: 'host', read: true };
  if (value?.status === 'render-retry-required') {
    return {
      kind: 'needs_user',
      phase: 'needs_user',
      reason: value.retryReproducesFailure === true ? 'app_fix_required' : 'render_retry',
    };
  }
  return { kind: 'threw', code: 'internal_error', shape: true };
}

export function isAdoptableStatus(status) {
  return ['queued', 'completed', 'importing', 'revision-required', 'invalid', 'render-retry-required'].includes(status?.status);
}

export function cleanConfirmText(value, maxChars = CONFIRM_TEXT_MAX_CHARS) {
  const max = Number.isInteger(maxChars) && maxChars >= 0 ? maxChars : CONFIRM_TEXT_MAX_CHARS;
  const cleaned = String(value ?? '').replace(CONTROL_OR_BIDI, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function validCreatedAt(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}
