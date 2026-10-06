import { CONSTANTS } from './constants.js';

// Main-process-only worker-pool sizing.  It intentionally consumes only
// aggregate task metadata: a recommendation must never copy a prompt, a
// handoff code, a canvas path, or a ChatGPT session key into status.

export const MAX_WORKER_POOL_SIZE = CONSTANTS.MAX_LANES;
// This is deliberately an aggregate planning bound, not a handoff or chat
// limit. It only prevents untrusted/adaptor status metadata from causing the
// pure sizing helper to count an unbounded number of planned/forecast work
// units. Above
// this count the configured worker-cap recommendation is already saturated.
export const MAX_WORKER_POOL_PLANNING_UNITS = 10_000;

function whole(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function boundedWorkers(value) {
  return Math.max(1, Math.min(MAX_WORKER_POOL_SIZE, whole(value, MAX_WORKER_POOL_SIZE) || MAX_WORKER_POOL_SIZE));
}

export function buildWorkerPoolUnits({ tasks = [], applicationCount = 0, applicationForecastCount = applicationCount } = {}) {
  const units = [];
  let budget = MAX_WORKER_POOL_PLANNING_UNITS;
  for (const entry of Array.isArray(tasks) ? tasks : []) {
    if (budget < 1) break;
    // A source may know a bounded future-wave forecast (for example a job
    // preference run that exposes a full handoff roster). Use it only for
    // sizing the one-time starter pool; live assignment still comes solely
    // from currently released handoffs.
    const count = Math.min(budget, Math.max(whole(entry?.forecast), whole(entry?.pending)));
    for (let index = 0; index < count; index += 1) units.push(1);
    budget -= count;
  }
  // Each unfinished application lane is independently claimable work.
  const applicationUnits = Math.min(budget, whole(applicationForecastCount));
  for (let index = 0; index < applicationUnits; index += 1) units.push(1);
  return units;
}

// Materialized units are handoffs that exist in the registry right now. They
// are intentionally separate from the forecast used to prewarm the worker
// pool: a workflow can publish a small concurrent wave while accurately
// estimating hundreds of later units. Treating that forecast as current work
// made an otherwise healthy roster of waiting workers look like a dispatcher
// failure.
export function countMaterializedWorkerPoolUnits({ tasks = [], applicationCount = 0 } = {}) {
  let count = 0;
  let budget = MAX_WORKER_POOL_PLANNING_UNITS;
  for (const entry of Array.isArray(tasks) ? tasks : []) {
    if (budget < 1) break;
    const pending = Math.min(budget, whole(entry?.pending));
    count += pending;
    budget -= pending;
  }
  const applications = Math.min(budget, whole(applicationCount));
  return count + applications;
}

/**
 * Prewarm one worker for each bounded planned unit, up to the shared worker
 * ceiling. Forecast units reserve later-wave capacity; only `materialized`
 * units are claimable now. The user confirmed copying starters is fast, so
 * duration estimates must never reduce this count: X = min(Y, capacity), where Y
 * is the bounded count returned by buildWorkerPoolUnits. `maxWorkers` remains
 * an explicit caller safety cap for test/seam callers.
 */
export function recommendWorkerPool({
  tasks = [],
  applicationCount = 0,
  applicationForecastCount = applicationCount,
  maxWorkers = MAX_WORKER_POOL_SIZE,
} = {}) {
  const units = buildWorkerPoolUnits({ tasks, applicationCount, applicationForecastCount });
  const queued = units.length;
  const materialized = countMaterializedWorkerPoolUnits({ tasks, applicationCount });
  if (queued === 0) {
    return Object.freeze({
      recommended: 0,
      max: 0,
      queued: 0,
      materialized: 0,
      reason: 'empty',
    });
  }
  const recommended = Math.min(boundedWorkers(maxWorkers), queued);
  return Object.freeze({
    recommended,
    max: recommended,
    queued,
    materialized,
    reason: recommended > 1 ? 'maximum_parallelism' : 'one_work_item',
  });
}
