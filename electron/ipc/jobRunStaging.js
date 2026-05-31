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
 *       stage: 'searching' | 'scoring' | 'bucketing' | 'done',
 *       inputs: { queries, profileFingerprint, targetRole, maxAgeDays, nodeId },
 *       sources: { [sourceId]: { status: 'pending'|'done'|'blocked',
 *                                queries: { [query]: { lastPage } } } }
 *     }
 *
 * On a clean finish both files are deleted. On the next launch, an incomplete +
 * recent manifest is what the renderer detects to offer "Resume or start fresh?".
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
// A manifest older than this is "stale" — not auto-offered for resume (the user
// likely abandoned it). 24h; the renderer can still surface a manual choice.
export const RESUMABLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Sidecar paths for a canvas file, or null when the canvas was never saved. */
export function runFilesForCanvas(canvasFilePath) {
  if (!canvasFilePath || typeof canvasFilePath !== 'string') return null;
  const dir = path.dirname(canvasFilePath);
  const base = path.basename(canvasFilePath).replace(/\.json$/i, '');
  return {
    staging:  path.join(dir, `${base}${STAGING_SUFFIX}`),
    manifest: path.join(dir, `${base}${MANIFEST_SUFFIX}`),
  };
}

let _tmpSeq = 0;
async function atomicWriteJson(filePath, obj) {
  // Unique tmp name PER WRITE: concurrent writers must not share a tmp path, or
  // the first rename() moves it out from under the others → ENOENT (and a lost
  // write). A bare counter is enough (the test runner forbids Date.now/random);
  // the per-path mutex below already serializes manifest writers, so this is
  // defense-in-depth for any caller that bypasses the lock.
  const tmp = `${filePath}.${process.pid}.${_tmpSeq++}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, filePath);
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
  _manifestTails.set(filePath, result.then(() => {}, () => {}));
  return result;
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
export async function startRun(canvasFilePath, { runId, startedAt, queries = [], profileFingerprint = null, targetRole = null, maxAgeDays = null, nodeId = null, sourceIds = [] }) {
  const files = runFilesForCanvas(canvasFilePath);
  if (!files) return null;
  const sources = {};
  for (const id of sourceIds) sources[id] = { status: 'pending', queries: {} };
  const manifest = {
    version: MANIFEST_VERSION,
    runId, startedAt, lastUpdated: startedAt,
    stage: 'searching',
    inputs: { queries, profileFingerprint, targetRole, maxAgeDays, nodeId },
    sources,
  };
  const ok = await withManifestLock(files.manifest, async () => {
    try {
      await fs.promises.writeFile(files.staging, '', 'utf8'); // truncate prior staging
      await atomicWriteJson(files.manifest, manifest);
      return true;
    } catch (e) {
      logger.warn(`[JobRunStaging] startRun failed: ${e?.message || e}`);
      return false;
    }
  });
  return ok ? manifest : null;
}

/**
 * Flush one page's raw jobs to staging and bump the (source,query) ledger.
 * `now` is the caller-stamped timestamp. No-op when there is no canvas/manifest.
 */
export async function recordSourcePage(canvasFilePath, { sourceId, query = '', page = 0, jobs = [], now }) {
  const files = runFilesForCanvas(canvasFilePath);
  if (!files) return;
  return withManifestLock(files.manifest, async () => {
    try {
      if (Array.isArray(jobs) && jobs.length > 0) {
        const lines = jobs.map(j => JSON.stringify({ sourceId, query, page, job: j })).join('\n') + '\n';
        await fs.promises.appendFile(files.staging, lines, 'utf8');
      }
      const manifest = await readManifest(canvasFilePath);
      if (!manifest) return;
      const src = manifest.sources[sourceId] || (manifest.sources[sourceId] = { status: 'pending', queries: {} });
      const q = src.queries[query] || (src.queries[query] = { lastPage: -1 });
      q.lastPage = Math.max(q.lastPage ?? -1, page);
      manifest.lastUpdated = now ?? manifest.lastUpdated;
      await atomicWriteJson(files.manifest, manifest);
    } catch (e) {
      // Staging is best-effort recovery scaffolding — never let it break a scrape.
      logger.warn(`[JobRunStaging] recordSourcePage(${sourceId}) failed: ${e?.message || e}`);
    }
  });
}

/** Set a source's terminal status ('done' | 'blocked'). */
export async function markSourceStatus(canvasFilePath, sourceId, status, now) {
  const files = runFilesForCanvas(canvasFilePath);
  if (!files) return;
  return withManifestLock(files.manifest, async () => {
    const manifest = await readManifest(canvasFilePath);
    if (!manifest) return;
    const src = manifest.sources[sourceId] || (manifest.sources[sourceId] = { status: 'pending', queries: {} });
    src.status = status;
    manifest.lastUpdated = now ?? manifest.lastUpdated;
    try { await atomicWriteJson(files.manifest, manifest); }
    catch (e) { logger.warn(`[JobRunStaging] markSourceStatus failed: ${e?.message || e}`); }
  });
}

/** Advance the pipeline stage ('searching'→'scoring'→'bucketing'→'done'). */
export async function setStage(canvasFilePath, stage, now) {
  const files = runFilesForCanvas(canvasFilePath);
  if (!files) return;
  return withManifestLock(files.manifest, async () => {
    const manifest = await readManifest(canvasFilePath);
    if (!manifest) return;
    manifest.stage = stage;
    manifest.lastUpdated = now ?? manifest.lastUpdated;
    try { await atomicWriteJson(files.manifest, manifest); }
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
  const incomplete = manifest.stage !== 'done';
  const ageMs = (typeof now === 'number' && typeof manifest.lastUpdated === 'number')
    ? now - manifest.lastUpdated
    : null;
  const recent = ageMs == null ? true : ageMs <= RESUMABLE_MAX_AGE_MS;
  const stagedJobs = incomplete ? await readStagedJobs(canvasFilePath) : [];
  return { manifest, stagedJobs, incomplete, ageMs, resumable: incomplete && recent };
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
export async function clearRun(canvasFilePath, { trashItem = null } = {}) {
  const files = runFilesForCanvas(canvasFilePath);
  if (!files) return;
  for (const p of [files.staging, files.manifest]) {
    // Skip a sidecar that isn't there (a run may have only one, or it was
    // already cleared) so trashItem doesn't error on a missing path.
    try { await fs.promises.access(p); } catch { continue; }
    if (trashItem) {
      try { await trashItem(p); continue; }
      catch (err) {
        // trashItem can fail on volumes without a Trash (network / exFAT). Fall
        // back to a hard delete so "Start fresh" still clears the run rather
        // than leaving a stale resumable manifest behind.
        logger.warn(`[JobRunStaging] trashItem failed for ${p} (${err?.message || err}); hard-deleting instead`);
      }
    }
    try { await fs.promises.unlink(p); } catch { /* already gone (race) */ }
  }
}
