/**
 * Job-search run staging + manifest — crash/quit recovery for long scrapes.
 *
 * A job search can run for minutes (browser sources scrape sequentially, deep
 * paginating). Today everything lives in memory until the very end, so a crash /
 * quit / power-loss mid-run loses the whole scrape. This module persists two
 * sidecars next to the canvas JSON, surviving an app restart:
 *
 *   <canvas>.jobs-staging.jsonl   append-only, ONE job per line, flushed per page
 *                                  as each source/query/page completes. Holds the
 *                                  RAW gathered jobs (pre dedup/score) so a resume
 *                                  recovers them without re-scraping finished pages.
 *
 *   <canvas>.jobs-run.json        the run manifest / ledger — the "did it finish?"
 *                                  signal + where each (source,query) got to:
 *     {
 *       version, runId, startedAt, lastUpdated,
 *       stage: 'searching' | 'gathered',
 *       inputs: { queries, profileFingerprint, targetRole, canonicalLocation,
 *                 maxAgeDays, nodeId },
 *       sources: { [sourceId]: { status: 'pending'|'done'|'blocked',
 *                                queries: { [query]: { lastPage } } } }
 *     }
 *
 * `stage` values actually written: 'searching' (run start / resume re-entry)
 * and 'gathered' (search phase finished; the renderer-driven scoring/bucketing
 * that follows can crash and still resume from the staged jobs). There is NO
 * 'done' stage — a clean finish is signaled by DELETING both sidecars
 * (complete-job-run), so any manifest on disk means an unfinished run.
 *
 * On the next launch, an incomplete + recent manifest is what the renderer
 * detects to offer "Resume or start fresh?".
 *
 * Atomicity: the manifest is written tmp→rename (never half-written). The staging
 * file is append-only — a torn final line after a hard crash is just one
 * unparseable JSONL row, which the reader skips. No heavy deps (fs/path/logger
 * only) so it is unit-testable in the plain-node test runner.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

const MANIFEST_VERSION = 1;
const STAGING_SUFFIX = '.jobs-staging.jsonl';
const MANIFEST_SUFFIX = '.jobs-run.json';
// Unlike the manifest/staging pair, this compact receipt intentionally survives
// a clean finish. It answers "did the prior-process run complete?" without
// retaining listings, search queries, career data, URLs, or warning evidence.
const LAST_RUN_RECEIPT_SUFFIX = '.jobs-last-run.json';
const JOB_RUN_RECEIPT_VERSION = 1;
// A manifest older than this is "stale" — not auto-offered for resume (the user
// likely abandoned it). 24h; the renderer can still surface a manual choice.
export const RESUMABLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Sidecar paths for a canvas file, or null when the canvas was never saved. */
function runFilesForCanvas(canvasFilePath) {
  if (!canvasFilePath || typeof canvasFilePath !== 'string') return null;
  const dir = path.dirname(canvasFilePath);
  const base = path.basename(canvasFilePath).replace(/\.json$/i, '');
  return {
    staging:  path.join(dir, `${base}${STAGING_SUFFIX}`),
    manifest: path.join(dir, `${base}${MANIFEST_SUFFIX}`),
  };
}

/** Durable, redacted terminal receipt path for a saved canvas. */
export function lastRunReceiptPathForCanvas(canvasFilePath) {
  if (!canvasFilePath || typeof canvasFilePath !== 'string') return null;
  const dir = path.dirname(canvasFilePath);
  const base = path.basename(canvasFilePath).replace(/\.json$/i, '');
  return path.join(dir, `${base}${LAST_RUN_RECEIPT_SUFFIX}`);
}

let _tmpSeq = 0;
async function atomicWriteJson(filePath, obj) {
  // Unique tmp name PER WRITE: concurrent writers must not share a tmp path, or
  // the first rename() moves it out from under the others → ENOENT (and a lost
  // write). A bare counter is enough (the test runner forbids Date.now/random);
  // the per-path mutex below already serializes manifest writers, so this is
  // defense-in-depth for any caller that bypasses the lock.
  const tmp = `${filePath}.${process.pid}.${_tmpSeq++}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tmp, filePath);
  } finally {
    // A failed write/rename must not accumulate sidecars forever. If rename
    // succeeded the temporary no longer exists, so ENOENT is expected here.
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

// Per-manifest-path FIFO mutex. Every mutator is a read-modify-write of the WHOLE
// manifest; without serialization, concurrent callers (e.g. the per-source
// markSourceStatus loop firing one write per source at once) all read the same
// stale manifest and clobber each other's updates — and a late stale write can
// even revert `stage` back to 'searching'. Keyed by path so different canvases
// never block one another. Same dependency-free pattern as sharedProfileLock.
const _manifestTails = new Map();
function withManifestLock(filePath, fn) {
  const prev = _manifestTails.get(filePath) || Promise.resolve();
  const result = prev.then(fn, fn); // run regardless of the prior op's outcome
  const tail = result.then(() => {}, () => {});
  _manifestTails.set(filePath, tail);
  return result.finally(() => {
    // Canvas paths are unbounded over a long app session. Remove an idle key
    // without disturbing a newer operation that queued behind this one.
    if (_manifestTails.get(filePath) === tail) _manifestTails.delete(filePath);
  });
}

// Receipt writes are normally made from the manifest-locked completion
// transaction below. Keep an independent path mutex for report/test callers
// too, so an out-of-band read/update cannot tear a JSON receipt.
const _receiptTails = new Map();
function withReceiptLock(filePath, fn) {
  const prev = _receiptTails.get(filePath) || Promise.resolve();
  const result = prev.then(fn, fn);
  const tail = result.then(() => {}, () => {});
  _receiptTails.set(filePath, tail);
  return result.finally(() => {
    if (_receiptTails.get(filePath) === tail) _receiptTails.delete(filePath);
  });
}

function receiptNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function receiptToken(value, max = 80) {
  const text = String(value ?? '').trim();
  // Source IDs, stop reasons, and warning codes are controlled identifiers.
  // Still restrict their character set here so no provider body/error text can
  // accidentally become durable report data through a future caller.
  return /^[a-zA-Z0-9_.:/-]+$/.test(text) ? text.slice(0, max) : null;
}

function sanitizeReceiptSource(source = {}) {
  const warning = source.warning && typeof source.warning === 'object'
    ? {
        ...(receiptToken(source.warning.code) ? { code: receiptToken(source.warning.code) } : {}),
        ...(receiptToken(source.warning.severity, 24) ? { severity: receiptToken(source.warning.severity, 24) } : {}),
      }
    : null;
  return {
    count: receiptNumber(source.count),
    providerGathered: receiptNumber(source.providerGathered),
    relevanceDropped: receiptNumber(source.relevanceDropped),
    ...(receiptNumber(source.sponsoredDropped) > 0 ? { sponsoredDropped: receiptNumber(source.sponsoredDropped) } : {}),
    ...(receiptToken(source.stopReason) ? { stopReason: receiptToken(source.stopReason) } : {}),
    ...(warning && Object.keys(warning).length > 0 ? { warning } : {}),
  };
}

/**
 * Whitelist the completion receipt shape. Keep this boundary defensive: this
 * artifact is read by support reports after restart, so it must never become a
 * backdoor for jobs, queries, profile data, URLs, or provider error bodies.
 */
export function sanitizeLastRunReceipt(receipt = {}) {
  const runId = String(receipt.runId || '').slice(0, 180);
  const nodeId = String(receipt.nodeId || '').slice(0, 180);
  const terminalStatus = ['completed', 'failed', 'aborted'].includes(receipt?.terminal?.status)
    ? receipt.terminal.status
    : 'completed';
  const terminalOutcome = ['zero', 'populated', 'collection-only', 'incomplete', 'unknown'].includes(receipt?.terminal?.outcome)
    ? receipt.terminal.outcome
    : 'unknown';
  // The initial search funnel can legitimately be smaller than the terminal
  // score-ready set when a post-search source resume contributes additional
  // rows. Preserve the terminal count independently rather than implying that
  // the initial funnel's `kept` value is the completed scoring total.
  const scoreReadyCount = receiptNumber(receipt?.terminal?.scoreReadyCount, null);
  const sources = {};
  for (const [sourceId, source] of Object.entries(receipt.sources || {}).slice(0, 20)) {
    const safeId = receiptToken(sourceId, 60);
    if (safeId) sources[safeId] = sanitizeReceiptSource(source);
  }
  const funnel = receipt.funnel && typeof receipt.funnel === 'object' ? {
    raw: receiptNumber(receipt.funnel.raw),
    relevanceDropped: receiptNumber(receipt.funnel.relevanceDropped),
    deduped: receiptNumber(receipt.funnel.deduped),
    ageDropped: receiptNumber(receipt.funnel.ageDropped),
    roleDropped: receiptNumber(receipt.funnel.roleDropped),
    historyDropped: receiptNumber(receipt.funnel.historyDropped),
    descriptionEvidenceDropped: receiptNumber(receipt.funnel.descriptionEvidenceDropped),
    kept: receiptNumber(receipt.funnel.kept),
  } : null;
  return {
    version: JOB_RUN_RECEIPT_VERSION,
    runId,
    nodeId,
    startedAt: receiptNumber(receipt.startedAt, null),
    completedAt: receiptNumber(receipt.completedAt, null),
    updatedAt: receiptNumber(receipt.updatedAt ?? receipt.completedAt, null),
    terminal: {
      status: terminalStatus,
      outcome: terminalOutcome,
      ...(scoreReadyCount != null ? { scoreReadyCount } : {}),
    },
    ...(funnel ? { funnel } : {}),
    sources,
    stagingStarted: receipt.stagingStarted === true,
    cleanup: {
      attempted: receipt.cleanup?.attempted === true,
      cleared: typeof receipt.cleanup?.cleared === 'boolean' ? receipt.cleanup.cleared : null,
    },
  };
}

export async function readLastRunReceipt(canvasFilePath) {
  const filePath = lastRunReceiptPathForCanvas(canvasFilePath);
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Synchronous companion for bug-report assembly, which is intentionally sync. */
export function readLastRunReceiptSync(canvasFilePath) {
  const filePath = lastRunReceiptPathForCanvas(canvasFilePath);
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Direct, token-guarded receipt write for focused tests/support tooling. */
export async function writeLastRunReceipt(canvasFilePath, receipt, { expectedRunId = null } = {}) {
  const filePath = lastRunReceiptPathForCanvas(canvasFilePath);
  if (!filePath) return { written: false, receipt: null };
  return withReceiptLock(filePath, async () => {
    const current = await readLastRunReceipt(canvasFilePath);
    if (expectedRunId != null && current?.runId !== expectedRunId) {
      return { written: false, receipt: current, tokenMismatch: true };
    }
    const sanitized = sanitizeLastRunReceipt(receipt);
    if (!sanitized.runId) return { written: false, receipt: current, invalid: true };
    try {
      await atomicWriteJson(filePath, sanitized);
      return { written: true, receipt: sanitized };
    } catch (error) {
      logger.warn(`[JobRunStaging] writeLastRunReceipt failed: ${error?.message || error}`);
      return { written: false, receipt: current, error: String(error?.message || error) };
    }
  });
}

async function readManifest(canvasFilePath) {
  const files = runFilesForCanvas(canvasFilePath);
  if (!files) return null;
  try {
    const raw = await fs.promises.readFile(files.manifest, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null; // missing or corrupt → treated as "no run"
  }
}

/**
 * Begin a run: write a fresh manifest (stage='searching') and truncate any prior
 * staging file. `runId`/`startedAt` are passed in (callers stamp time, since the
 * test runner forbids Date.now()). Returns the manifest, or null if no canvas.
 */
export async function startRun(canvasFilePath, { runId, startedAt, queries = [], profileFingerprint = null, targetRole = null, canonicalLocation = '', maxAgeDays = null, collectionLimits = null, nodeId = null, sourceIds = [] }) {
  const files = runFilesForCanvas(canvasFilePath);
  if (!files) return null;
  const sources = {};
  for (const id of sourceIds) sources[id] = { status: 'pending', queries: {} };
  const manifest = {
    version: MANIFEST_VERSION,
    runId, startedAt, lastUpdated: startedAt,
    stage: 'searching',
    inputs: { queries, profileFingerprint, targetRole, canonicalLocation, maxAgeDays, collectionLimits, nodeId },
    sources,
  };
  const ok = await withManifestLock(files.manifest, async () => {
    // Do not truncate the prior recovery file until the replacement manifest
    // has committed. A manifest write can fail (read-only volume, a path that
    // was replaced by a directory, disk-full), and losing the old JSONL while
    // its old manifest remains would turn a recoverable run into an empty one.
    // This is a rollback guard for ordinary I/O failures; the two sidecars
    // cannot be made one filesystem-atomic unit across a sudden power loss.
    const stagingBackup = `${files.staging}.${process.pid}.${_tmpSeq++}.bak`;
    let movedPriorStaging = false;
    let createdFreshStaging = false;
    try {
      try {
        await fs.promises.rename(files.staging, stagingBackup);
        movedPriorStaging = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      // `wx` prevents a concurrent external writer from being silently
      // truncated between the move above and this fresh-run initialization.
      await fs.promises.writeFile(files.staging, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      createdFreshStaging = true;
      await atomicWriteJson(files.manifest, manifest);
      if (movedPriorStaging) await fs.promises.unlink(stagingBackup).catch((error) => {
        // The new run is already valid. Retain the backup for manual recovery
        // rather than falsely reporting start failure after its commit.
        logger.warn(`[JobRunStaging] could not remove prior staging backup: ${error?.message || error}`);
      });
      return true;
    } catch (e) {
      if (createdFreshStaging) await fs.promises.unlink(files.staging).catch(() => {});
      if (movedPriorStaging) {
        try { await fs.promises.rename(stagingBackup, files.staging); }
        catch (restoreError) {
          // Leave the backup in place rather than deleting the user's only
          // recoverable copy. The warning gives support a concrete path.
          logger.warn(`[JobRunStaging] could not restore prior staging from ${stagingBackup}: ${restoreError?.message || restoreError}`);
        }
      }
      logger.warn(`[JobRunStaging] startRun failed: ${e?.message || e}`);
      return false;
    }
  });
  return ok ? manifest : null;
}

/**
 * Flush one page's raw jobs to staging and bump the (source,query) ledger.
 * `now` is the caller-stamped timestamp. `expectedRunId` makes late work from
 * a cancelled predecessor a no-op after a fresh run has replaced the manifest.
 * No-op when there is no canvas/manifest.
 */
export async function recordSourcePage(canvasFilePath, { sourceId, query = '', page = 0, jobs = [], now, expectedRunId = null }) {
  const files = runFilesForCanvas(canvasFilePath);
  if (!files) return;
  return withManifestLock(files.manifest, async () => {
    try {
      // Check the token BEFORE appending: a manifest write is atomic, whereas
      // staging is append-only and cannot be rolled back after an old run has
      // leaked rows into its successor's file.
      const manifest = await readManifest(canvasFilePath);
      if (!manifest || (expectedRunId != null && manifest.runId !== expectedRunId)) return false;
      if (Array.isArray(jobs) && jobs.length > 0) {
        const lines = jobs.map(j => JSON.stringify({ sourceId, query, page, job: j })).join('\n') + '\n';
        await fs.promises.appendFile(files.staging, lines, { encoding: 'utf8', mode: 0o600 });
      }
      const src = manifest.sources[sourceId] || (manifest.sources[sourceId] = { status: 'pending', queries: {} });
      const q = src.queries[query] || (src.queries[query] = { lastPage: -1 });
      q.lastPage = Math.max(q.lastPage ?? -1, page);
      manifest.lastUpdated = now ?? manifest.lastUpdated;
      await atomicWriteJson(files.manifest, manifest);
      return true;
    } catch (e) {
      // Staging is best-effort recovery scaffolding — never let it break a scrape.
      logger.warn(`[JobRunStaging] recordSourcePage(${sourceId}) failed: ${e?.message || e}`);
    }
  });
}

/** Set a source's terminal status ('done' | 'blocked') for the expected run. */
export async function markSourceStatus(canvasFilePath, sourceId, status, now, { expectedRunId = null } = {}) {
  const files = runFilesForCanvas(canvasFilePath);
  if (!files) return;
  return withManifestLock(files.manifest, async () => {
    const manifest = await readManifest(canvasFilePath);
    if (!manifest || (expectedRunId != null && manifest.runId !== expectedRunId)) return false;
    const src = manifest.sources[sourceId] || (manifest.sources[sourceId] = { status: 'pending', queries: {} });
    src.status = status;
    manifest.lastUpdated = now ?? manifest.lastUpdated;
    try { await atomicWriteJson(files.manifest, manifest); return true; }
    catch (e) { logger.warn(`[JobRunStaging] markSourceStatus failed: ${e?.message || e}`); }
  });
}

/** Advance the pipeline stage ('searching'→'gathered'; see the header). */
export async function setStage(canvasFilePath, stage, now, { expectedRunId = null } = {}) {
  const files = runFilesForCanvas(canvasFilePath);
  if (!files) return;
  return withManifestLock(files.manifest, async () => {
    const manifest = await readManifest(canvasFilePath);
    if (!manifest || (expectedRunId != null && manifest.runId !== expectedRunId)) return false;
    manifest.stage = stage;
    manifest.lastUpdated = now ?? manifest.lastUpdated;
    try { await atomicWriteJson(files.manifest, manifest); return true; }
    catch (e) { logger.warn(`[JobRunStaging] setStage failed: ${e?.message || e}`); }
  });
}

/** Parse the staging JSONL, skipping any torn/garbage lines. Returns [] on miss. */
export async function readStagedJobs(canvasFilePath) {
  const files = runFilesForCanvas(canvasFilePath);
  if (!files) return [];
  let raw;
  try { raw = await fs.promises.readFile(files.staging, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* torn last line after a crash — skip */ }
  }
  return out;
}

/**
 * Read the full run state for resume detection. Returns null when there is no
 * (parseable) manifest. `resumable` is true when the run did not finish AND is
 * recent enough to auto-offer (within RESUMABLE_MAX_AGE_MS of `now`).
 */
export async function readRunState(canvasFilePath, now = null) {
  const manifest = await readManifest(canvasFilePath);
  if (!manifest) return null;
  // A manifest on disk IS an unfinished run — clean finishes delete the
  // sidecars (see header). `incomplete` is kept on the return shape for the
  // renderer's peek payload rather than re-derived at every consumer.
  const incomplete = true;
  const ageMs = (typeof now === 'number' && typeof manifest.lastUpdated === 'number')
    ? now - manifest.lastUpdated
    : null;
  const recent = ageMs == null ? true : ageMs <= RESUMABLE_MAX_AGE_MS;
  const stagedJobs = await readStagedJobs(canvasFilePath);
  return { manifest, stagedJobs, incomplete, ageMs, resumable: incomplete && recent };
}

/**
 * 1-based page a URL-paginated source should resume from, given its manifest
 * ledger. Fast-forwards to min(lastPage)+1 ONLY when every query of the run
 * recorded at least one page — buildJobTasks applies ONE start page to EVERY
 * query of the source, and a query that crashed before flushing its first page
 * has no ledger entry, so fast-forwarding past page min(...) would silently
 * skip that query's early pages. Any unrecorded query ⇒ restart at page 1
 * (the cross-source dedup absorbs the re-scraped overlap).
 *
 * @param {object} sourceLedger  manifest.sources[sid] ({ queries: { [q]: { lastPage } } })
 * @param {number} totalQueryCount  how many queries the run scrapes per source
 * @returns {number} 1-based start page
 */
export function computeResumeStartPage(sourceLedger, totalQueryCount) {
  const qmap = sourceLedger?.queries || {};
  const pages = Object.values(qmap)
    .map(q => q?.lastPage)
    .filter(n => typeof n === 'number' && n >= 0);
  const allQueriesRecorded = pages.length >= Math.max(1, totalQueryCount | 0);
  return (pages.length && allQueriesRecorded) ? Math.min(...pages) + 1 : 1;
}

/**
 * Remove both sidecars.
 *
 * @param {string} canvasFilePath
 * @param {object} [opts]
 * @param {(path:string)=>Promise<void>} [opts.trashItem] - When provided (e.g.
 *   electron `shell.trashItem`), move the sidecars to the OS Trash instead of
 *   hard-deleting, so an accidental "Start fresh" is recoverable. A clean finish
 *   passes nothing and hard-deletes — there's nothing to recover, and trashing a
 *   sidecar on every successful run would steadily clutter the Trash. The
 *   function is INJECTED, not imported, so this module stays electron-free and
 *   unit-testable in the plain-node runner.
 */
export async function clearRun(canvasFilePath, { trashItem = null, expectedRunId = null } = {}) {
  const files = runFilesForCanvas(canvasFilePath);
  if (!files) return false;
  return withManifestLock(files.manifest, async () => {
    // Completion is renderer-driven and may arrive after the user has already
    // started another search on this canvas. Compare under the same manifest
    // lock as startRun so an old completion can never delete a newer run.
    if (expectedRunId != null) {
      const manifest = await readManifest(canvasFilePath);
      if (!manifest || manifest.runId !== expectedRunId) return false;
    }
    return clearRunFiles(files, trashItem);
  });
}

async function clearRunFiles(files, trashItem = null) {
  let cleared = true;
  for (const p of [files.staging, files.manifest]) {
    // Skip a sidecar that isn't there (a run may have only one, or it was
    // already cleared) so trashItem doesn't error on a missing path.
    try { await fs.promises.access(p); } catch { continue; }
    if (trashItem) {
      try {
        await trashItem(p);
      } catch (err) {
        // trashItem can fail on volumes without a Trash (network / exFAT). Fall
        // back to a hard delete so "Start fresh" still clears the run rather
        // than leaving a stale resumable manifest behind.
        logger.warn(`[JobRunStaging] trashItem failed for ${p} (${err?.message || err}); hard-deleting instead`);
        try { await fs.promises.unlink(p); } catch { /* verified below */ }
      }
    } else {
      try { await fs.promises.unlink(p); } catch { /* verified below */ }
    }
    try {
      await fs.promises.access(p);
      cleared = false;
    } catch { /* absent = cleared */ }
  }
  return cleared;
}

/**
 * Atomically records a redacted terminal receipt before removing recovery
 * sidecars, then records the actual cleanup outcome. The manifest token is
 * checked under the same lock as startRun/clearRun, so a delayed completion from
 * an older hub run cannot overwrite a newer run's receipt or delete its files.
 */
export async function completeRunWithReceipt(canvasFilePath, receipt, { trashItem = null } = {}) {
  const files = runFilesForCanvas(canvasFilePath);
  const receiptPath = lastRunReceiptPathForCanvas(canvasFilePath);
  const expectedRunId = String(receipt?.runId || '');
  if (!files || !receiptPath || !expectedRunId) {
    return { ok: false, cleared: false, receipt: null, reason: 'missing-canvas-or-run-token' };
  }
  return withManifestLock(files.manifest, async () => withReceiptLock(receiptPath, async () => {
    const manifest = await readManifest(canvasFilePath);
    if (!manifest || manifest.runId !== expectedRunId) {
      return { ok: false, cleared: false, receipt: null, tokenMismatch: true };
    }
    const initial = sanitizeLastRunReceipt({
      ...receipt,
      // Do not use process-global telemetry as a fallback here. The manifest is
      // this run's durable owner and safely fills identity/timing only when the
      // receipt builder could not match an in-memory search token.
      nodeId: receipt?.nodeId || manifest.inputs?.nodeId || null,
      startedAt: receipt?.startedAt ?? manifest.startedAt,
      stagingStarted: true,
      cleanup: { attempted: false, cleared: null },
    });
    try {
      await atomicWriteJson(receiptPath, initial);
    } catch (error) {
      logger.warn(`[JobRunStaging] completion receipt write failed: ${error?.message || error}`);
      return { ok: false, cleared: false, receipt: null, receiptWriteFailed: true };
    }

    const cleared = await clearRunFiles(files, trashItem);
    const completed = sanitizeLastRunReceipt({
      ...initial,
      updatedAt: Date.now(),
      cleanup: { attempted: true, cleared },
    });
    try {
      await atomicWriteJson(receiptPath, completed);
      return { ok: true, cleared, receipt: completed };
    } catch (error) {
      // The pre-cleanup receipt is still durable, explicitly showing that cleanup
      // had not yet been confirmed. Do not falsely claim a fully recorded finish.
      logger.warn(`[JobRunStaging] completion receipt cleanup update failed: ${error?.message || error}`);
      return { ok: false, cleared, receipt: initial, receiptUpdateFailed: true };
    }
  }));
}
