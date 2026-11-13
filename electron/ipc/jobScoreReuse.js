// Per-job score reuse for resumed Job Search scoring runs.
//
// A scoring run's manual-handoff answers are saved per whole-batch prompt hash,
// so ONE job whose text changed invalidates the entire ~44-job batch. This
// module keeps a per-run map from a single job's fingerprint to the validated
// score row that came back for it, which lets a resumed run reuse the rows for
// jobs whose text is byte-identical and score only the rest.
//
// Pure: no electron imports, no I/O beyond the injected recall/remember.
import { createHash } from 'node:crypto';

export const JOB_SCORE_REUSE_KEY = 'job-scoring-rows:v1';
export const JOB_SCORE_REUSE_MAX_ENTRIES = 5000;

const sha256Hex = value => createHash('sha256').update(String(value)).digest('hex');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (isPlainObject(value)) {
    const copy = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = deepCopy(entry);
    return copy;
  }
  return value;
}

// The slim scoring row carries a per-batch `index`; it is positional, not part
// of the job's identity, so the fingerprint drops it.
function withoutIndex(value) {
  if (!isPlainObject(value)) return null;
  const { index: _index, ...rest } = value;
  return rest;
}

/**
 * Deterministic identity of one job's scoring input. Any change to the job's
 * prompt fields, the cached prefix, the scoring contract or the career snapshot
 * the evidence came from changes the fingerprint, so a reused row can only ever
 * stand in for exactly the input that produced it.
 */
export function jobScoreReuseFingerprint({ contract, prefix, careerSnapshotId, job } = {}) {
  const payload = {
    contract: contract ?? null,
    careerSnapshotId: careerSnapshotId || null,
    prefix: sha256Hex(String(prefix || '')),
    job: withoutIndex(job),
  };
  return sha256Hex(JSON.stringify(payload));
}

function normalizeStoredRows(value) {
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.rows)) return [];
  const entries = [];
  for (const [fingerprint, row] of Object.entries(value.rows)) {
    if (!fingerprint || !isPlainObject(row)) continue;
    entries.push([fingerprint, withoutIndex(deepCopy(row))]);
  }
  return entries;
}

/**
 * Per-run score-row store. The in-memory map is always the superset of what is
 * being written, and every `record()` persists the WHOLE map, so two batches
 * completing concurrently cannot drop each other's rows.
 *
 * Every method is a safe no-op without a run id (an unscoped scoring pass must
 * behave exactly as it did before this store existed).
 */
export function createJobScoreReuseStore({
  runId,
  recall,
  remember,
  maxEntries = JOB_SCORE_REUSE_MAX_ENTRIES,
} = {}) {
  const id = typeof runId === 'string' && runId.trim() ? runId.trim() : null;
  const limit = Number.isFinite(maxEntries) && maxEntries > 0
    ? Math.floor(maxEntries)
    : JOB_SCORE_REUSE_MAX_ENTRIES;
  const rows = new Map(); // insertion-ordered: the oldest insert is evicted first

  const canRecall = () => !!id && typeof recall === 'function';

  const load = async () => {
    if (!canRecall()) return 0;
    let stored = null;
    try {
      stored = await recall(id, JOB_SCORE_REUSE_KEY);
    } catch {
      stored = null;
    }
    const entries = normalizeStoredRows(stored);
    for (const [fingerprint, row] of entries) {
      if (rows.has(fingerprint)) continue;
      rows.set(fingerprint, row);
    }
    while (rows.size > limit) {
      const oldest = rows.keys().next();
      if (oldest.done) break;
      rows.delete(oldest.value);
    }
    return entries.length;
  };

  const get = fingerprint => {
    if (!canRecall() || typeof fingerprint !== 'string' || !fingerprint) return null;
    const row = rows.get(fingerprint);
    return row ? deepCopy(row) : null;
  };

  const record = (entries = []) => {
    if (!id || !Array.isArray(entries)) return Promise.resolve();
    for (const entry of entries) {
      const fingerprint = typeof entry?.fingerprint === 'string' ? entry.fingerprint : '';
      if (!fingerprint || !isPlainObject(entry.row)) continue;
      rows.set(fingerprint, withoutIndex(deepCopy(entry.row)));
    }
    while (rows.size > limit) {
      const oldest = rows.keys().next();
      if (oldest.done) break;
      rows.delete(oldest.value);
    }
    if (typeof remember !== 'function') return Promise.resolve();
    const payload = { version: 1, rows: Object.fromEntries(rows) };
    try {
      return Promise.resolve(remember(id, JOB_SCORE_REUSE_KEY, payload)).then(() => {}, () => {});
    } catch {
      // A failed remember must never fail scoring: the rows are still in memory
      // and the next batch's write persists them again.
      return Promise.resolve();
    }
  };

  const size = () => rows.size;

  return { load, get, record, size };
}

/**
 * Split one top-level batch into reusables and jobs that must still be scored.
 * A row is reused only when the store has one for the job's fingerprint AND it
 * still validates against THIS job (the scorer's own grounding check).
 */
export function partitionBatchForReuse(batch, { fingerprintOf, store, isReusable } = {}) {
  const jobs = Array.isArray(batch) ? batch : [];
  const fingerprints = [];
  const reused = new Map();
  const pendingIndices = [];
  jobs.forEach((job, index) => {
    let fingerprint = '';
    try {
      const value = typeof fingerprintOf === 'function' ? fingerprintOf(job, index) : null;
      fingerprint = typeof value === 'string' ? value : '';
    } catch {
      fingerprint = '';
    }
    fingerprints.push(fingerprint);
    let row = null;
    if (fingerprint) {
      try {
        row = store?.get?.(fingerprint) || null;
      } catch {
        row = null;
      }
    }
    let reusable = false;
    if (row) {
      try {
        reusable = typeof isReusable === 'function' && isReusable(row, job, index) === true;
      } catch {
        reusable = false;
      }
    }
    if (reusable) reused.set(index, row);
    else pendingIndices.push(index);
  });
  return { fingerprints, reused, pendingIndices };
}

/**
 * Put reused rows and freshly scored rows back into one array aligned 1:1 with
 * the batch. `pendingIndices[k]` is the batch position of `scoredRows[k]`.
 */
export function mergeReusedAndScored(length, reused, pendingIndices, scoredRows) {
  const size = Number.isInteger(length) && length > 0 ? length : 0;
  const merged = new Array(size).fill(null);
  const scored = Array.isArray(scoredRows) ? scoredRows : [];
  const pending = Array.isArray(pendingIndices) ? pendingIndices : [];
  const reusedMap = reused instanceof Map ? reused : new Map(Object.entries(isPlainObject(reused) ? reused : {}));
  for (const [index, row] of reusedMap) {
    if (!Number.isInteger(index) || index < 0 || index >= size) continue;
    merged[index] = isPlainObject(row) ? { ...deepCopy(row), index } : null;
  }
  pending.forEach((index, offset) => {
    if (!Number.isInteger(index) || index < 0 || index >= size) return;
    merged[index] = scored[offset] ?? null;
  });
  return merged;
}
