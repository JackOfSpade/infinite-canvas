import { CONSTANTS } from './constants.js';
import { resolveHandoffConcurrency } from '../../../src/utils/handoffScheduler.js';

// Main-process-only worker-pool sizing.  It intentionally consumes only
// aggregate task metadata: a recommendation must never copy a prompt, a
// handoff code, a canvas path, or a ChatGPT session key into status.

export const MAX_WORKER_POOL_SIZE = CONSTANTS.MAX_LANES;
// Deprecated compatibility name. Planning no longer uses a unit-count cap;
// its only retained value is the largest exact count JavaScript can represent.
export const MAX_WORKER_POOL_PLANNING_UNITS = Number.MAX_SAFE_INTEGER;

function whole(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function boundedWorkers(value, capability) {
  const supported = resolveHandoffConcurrency(capability);
  return Math.max(1, Math.min(MAX_WORKER_POOL_SIZE, supported, whole(value, supported) || supported));
}

// Planning needs only the minimum of work and live capacity.  Do not build an
// array per forecast item: sources may honestly report millions of later-wave
// descriptors, and those descriptors remain in their own durable queues.
export function countWorkerPoolUnits({ tasks = [], applicationCount = 0, applicationForecastCount = applicationCount } = {}) {
  // Keep aggregate progress truthful even when it is far larger than the
  // active pool. Number.MAX_SAFE_INTEGER is a representation guard, not a
  // work/call ceiling; only `recommended` is constrained by live capacity.
  const add = (left, right) => Math.min(Number.MAX_SAFE_INTEGER, left + right);
  let queued = 0;
  let materialized = 0;
  for (const entry of Array.isArray(tasks) ? tasks : []) {
    queued = add(queued, Math.max(whole(entry?.forecast), whole(entry?.pending)));
    materialized = add(materialized, whole(entry?.pending));
  }
  queued = add(queued, whole(applicationForecastCount));
  materialized = add(materialized, whole(applicationCount));
  return Object.freeze({ queued, materialized });
}

// Compatibility exports keep test/seam callers from allocating a giant unit
// array while moving the planning API to a saturating count.
export function buildWorkerPoolUnits(options = {}) {
  const { queued } = countWorkerPoolUnits(options);
  return Object.freeze({ length: queued });
}

export function countMaterializedWorkerPoolUnits(options = {}) {
  return countWorkerPoolUnits(options).materialized;
}

/**
 * Prewarm one worker for each available planned unit, up to negotiated live
 * capacity. Forecast units reserve later-wave capacity; only `materialized`
 * units are claimable now. `maxWorkers` is a caller restriction; `capability`
 * is the explicit host/plugin source of the supported live parallelism.
 */
export function recommendWorkerPool({
  tasks = [],
  applicationCount = 0,
  applicationForecastCount = applicationCount,
  maxWorkers = MAX_WORKER_POOL_SIZE,
  capability = null,
} = {}) {
  const capacity = boundedWorkers(maxWorkers, capability);
  const { queued, materialized } = countWorkerPoolUnits({ tasks, applicationCount, applicationForecastCount, capacity });
  if (queued === 0) {
    return Object.freeze({
      recommended: 0,
      max: 0,
      queued: 0,
      materialized: 0,
      reason: 'empty',
    });
  }
  const recommended = Math.min(capacity, queued);
  return Object.freeze({
    recommended,
    max: recommended,
    queued,
    materialized,
    reason: recommended > 1 ? 'maximum_parallelism' : 'one_work_item',
  });
}
