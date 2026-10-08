/*
 * A stopped acceptance harness has no authority to rewrite the live bridge's
 * durable lane store. Node exposes pathname-based rename, not a conditional
 * rename relative to an already-open directory descriptor, so a validate-then-
 * rename implementation cannot close a parent-symlink swap TOCTOU window.
 *
 * The bridge runtime is the sole lanes.json writer. Its in-process store and
 * engine serialize normal removal. The harness therefore records a deferred
 * request after its own job/bundle rollback and performs no lane-store I/O.
 */

function validJobId(value) {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
}

function validCanvasPath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0');
}

/**
 * Validate a deferred bridge-lane retirement without reading or writing the
 * bridge directory. `afterValidationForTest` proves a concurrent mutation or
 * parent swap cannot turn this into an out-of-root write.
 */
export function deferOwnedBridgeLaneCleanup({
  jobId,
  canvasFilePath,
  afterValidationForTest = null,
} = {}) {
  if (!validJobId(jobId) || !validCanvasPath(canvasFilePath)) {
    throw new Error('Bridge lane cleanup requires the exact queued job id and an absolute canvas path.');
  }
  const deferred = Object.freeze({
    jobId,
    canvasFilePath,
    removed: false,
    deferred: true,
    reason: 'live bridge runtime exclusively owns lanes.json persistence',
  });
  if (afterValidationForTest !== null) {
    if (typeof afterValidationForTest !== 'function') {
      throw new TypeError('afterValidationForTest must be a function when supplied.');
    }
    afterValidationForTest(deferred);
  }
  return deferred;
}
