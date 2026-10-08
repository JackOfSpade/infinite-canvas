/**
 * Job-search run staging + manifest — crash/quit recovery for long scrapes.
 *
 * A job search can run for minutes (browser sources scrape sequentially, deep
 * paginating). Today everything lives in memory until the very end, so a crash /
 * quit / power-loss mid-run loses the whole scrape. This module persists two
 * sidecars next to the canvas JSON, surviving an app restart:
 *
 *   <canvas>.jobs-staging.<hub>.jsonl   append-only, ONE job per line, flushed per page
 *                                  as each source/query/page completes. Holds the
 *                                  RAW gathered jobs (pre dedup/score) so a resume
 *                                  recovers them without re-scraping finished pages.
 *
 *   <canvas>.jobs-run.<hub>.json  the run manifest / ledger — the "did it finish?"
 *                                  signal + where each (source,query) got to:
 *     {
 *       version, runId, startedAt, lastUpdated,
 *       stage: 'searching' | 'gathered',
 *       providerGatheredAt?: number, collectionCompletedAt?: number,
 *       collectionDisposition?: 'user-finished-partial',
 *       inputs: { queries, profileFingerprint, targetRole, jobPreferences,
 *                 jobPreferencePlan, canonicalLocation, searchWindow,
 *                 maxAgeDays, nodeId },
 *       sources: { [sourceId]: { status: 'pending'|'done'|'skipped'|'blocked',
 *                                recoveryDisposition?: 'manual',
 *                                queries: { ['#'+queryIndex]: { lastPage } },
 *                                collectionScopeCaveats?: [{ sourceId, code }] } }
 *     }
 *
 * `stage` values actually written: 'searching' (run start / resume re-entry)
 * and 'gathered' (search phase finished; the renderer-driven scoring/bucketing
 * that follows can crash and still resume from the staged jobs). There is NO
 * 'done' stage — a clean finish is signaled by DELETING both sidecars
 * (complete-job-run), so any manifest on disk means an unfinished run.
 *
 * On the next launch, any incomplete manifest is surfaced. Age is retained as
 * diagnostic metadata, but is never allowed to silently abandon exact staged
 * work; automatic recovery is gated only by explicit user/human-required
 * recovery dispositions.
 *
 * Atomicity: the manifest is written tmp→rename (never half-written). The staging
 * file is append-only — a torn final line after a hard crash is just one
 * unparseable JSONL row, which the reader skips. No heavy deps (fs/path/logger
 * only) so it is unit-testable in the plain-node test runner.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { normalizeCollectionScopeCaveats } from '../../src/utils/jobCollectionScopeCaveats.js';
import { JOB_SEARCH_MAX_PROVIDER_LOOKBACK_DAYS } from '../../src/utils/jobSearchDateWindow.js';
import { JOB_PREFERENCE_CRITERION_MAX_LENGTH, JOB_PREFERENCE_TITLE_MAX_LENGTH } from './aiSchemas.js';
import { rawCanvasRecoveryPath, resolveCanvasRecoveryPath, withCanvasRecoveryRead } from './canvasRecoveryPaths.js';
import { getJobDescriptionRecoveryCheckpointPath } from './jobAnalysisPaths.js';
import { jobAnalysisOperationAuthorityReceipt, withCurrentJobAnalysisOperationAuthority } from './jobAnalysisOperationAuthorityStore.js';

const MANIFEST_VERSION = 2;
// A Solve checkpoint can contain the full saved candidate universe; it is not
// subject to the small metadata-only discovery bound. Keep adoption aligned
// with the maximum recovery artifact size accepted by Save As, while still
// refusing an unbounded read from the canvas-adjacent user-writable folder.
const MAX_DESCRIPTION_RECOVERY_CHECKPOINT_ADOPTION_BYTES = 64 * 1024 * 1024;
// An explicit user choice to stop collection and carry the durable ledger into
// preference/scoring.  This is intentionally distinct from `stage: 'gathered'`:
// the latter normally means every provider completed, while this marker means
// some provider work was deliberately left unfinished and must never be
// silently restarted after a scoring/restart interruption.
export const JOB_RUN_COLLECTION_DISPOSITION = Object.freeze({
  USER_FINISHED_PARTIAL: 'user-finished-partial',
});
const JOB_RUN_COLLECTION_DISPOSITIONS = new Set(Object.values(JOB_RUN_COLLECTION_DISPOSITION));
// Recovery starts automatically after an unexpected renderer/app interruption.
// Root absence means automatic for backwards compatibility. At source level,
// new blocked outcomes explicitly distinguish safe unattended retry from a
// human gate; legacy/missing markers are likewise automatic unless a durable
// explicit manual disposition says otherwise.
export const JOB_RUN_RECOVERY_DISPOSITION = Object.freeze({
  AUTOMATIC: 'automatic',
  MANUAL: 'manual',
});
const JOB_RUN_RECOVERY_DISPOSITIONS = new Set(Object.values(JOB_RUN_RECOVERY_DISPOSITION));
// Unlike the manifest/staging pair, this compact receipt intentionally survives
// a clean finish. It answers "did the prior-process run complete?" without
// retaining listings, search queries, career data, URLs, or warning evidence.
// Version 3 adds the redacted, run-scoped post-search recovery delta alongside
// scoring and safe source-cap coverage. Readers remain compatible because every
// added field is optional.
const JOB_RUN_RECEIPT_VERSION = 3;
// Age remains useful diagnostic/UI metadata. It is deliberately *not* an
// automatic-recovery gate: an exact staged run must not disappear merely
// because the app stayed closed for more than a day.
export const RESUMABLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Sidecar paths for a canvas file, or null when the canvas was never saved. */
function normalizeNodeId(nodeIdOrOptions) {
  const nodeId = typeof nodeIdOrOptions === 'object' && nodeIdOrOptions !== null
    ? nodeIdOrOptions.nodeId
    : nodeIdOrOptions;
  return typeof nodeId === 'string' && nodeId.trim() ? nodeId.trim() : null;
}

// Resume identity is a parser-produced lowercase SHA-256 only. Keep this at
// the durable schema boundary as well as renderer/IPC admission, so direct or
// future callers cannot serialize arbitrary or oversized profile tokens.
export function normalizeJobRunProfileFingerprint(value) {
  const fingerprint = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : null;
}

function normalizeCareerSnapshotId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function pathHash(value, length = 24) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

// Long-running IPC handlers keep the canvasFilePath captured when they began.
// Once a Save As/Finder rename has durably moved the sidecars, route those old
// arguments to the new owner for the rest of this process. This is intentionally
// process-local: a fresh launch discovers only the new canonical path/files.
function resolvedCanvasPath(canvasFilePath, { followRebindAliases = true } = {}) {
  return followRebindAliases ? resolveCanvasRecoveryPath(canvasFilePath) : rawCanvasRecoveryPath(canvasFilePath);
}

// A fixed-size full-path canvas hash prevents `project` and `project.json`
// from sharing sidecars. A fixed owner hash also makes imported malformed IDs
// unable to exceed filesystem NAME_MAX. The manifest remains the authority
// for the human-readable owner id.
export function jobRunPathScopeForCanvas(canvasFilePath, nodeIdOrOptions = null) {
  const canvasPath = resolvedCanvasPath(canvasFilePath);
  if (!canvasPath) return null;
  const nodeId = normalizeNodeId(nodeIdOrOptions);
  return {
    canvasPath,
    dir: path.dirname(canvasPath),
    base: path.basename(canvasPath).replace(/\.json$/i, ''),
    canvasHash: pathHash(canvasPath),
    nodeId,
    ownerHash: nodeId ? pathHash(nodeId) : null,
  };
}

function rawJobRunPathScopeForCanvas(canvasFilePath) {
  const canvasPath = resolvedCanvasPath(canvasFilePath, { followRebindAliases: false });
  if (!canvasPath) return null;
  return {
    canvasPath,
    dir: path.dirname(canvasPath),
    base: path.basename(canvasPath).replace(/\.json$/i, ''),
    canvasHash: pathHash(canvasPath),
  };
}

// Baseline singleton filenames are deliberately retained for migration. The
// prior node-scoped generation used an escaped owner ID and is readable only
// after exact owner verification and a basename-collision check.
function runFilesForCanvas(canvasFilePath, nodeIdOrOptions = null) {
  const scope = jobRunPathScopeForCanvas(canvasFilePath, nodeIdOrOptions);
  if (!scope) return null;
  const { dir, base, canvasHash, nodeId, ownerHash } = scope;
  const scoped = nodeId ? `.${canvasHash}.${ownerHash}` : '';
  return {
    staging:  path.join(dir, `${base}.jobs-staging${scoped}.jsonl`),
    manifest: path.join(dir, `${base}.jobs-run${scoped}.json`),
    nodeId,
    legacy: !nodeId,
  };
}

function priorScopedRunFilesForCanvas(canvasFilePath, nodeIdOrOptions = null) {
  const scope = jobRunPathScopeForCanvas(canvasFilePath, nodeIdOrOptions);
  if (!scope?.nodeId) return null;
  const escaped = encodeURIComponent(scope.nodeId);
  return {
    staging: path.join(scope.dir, `${scope.base}.jobs-staging.${escaped}.jsonl`),
    manifest: path.join(scope.dir, `${scope.base}.jobs-run.${escaped}.json`),
    nodeId: scope.nodeId,
    legacy: false,
    priorScoped: true,
  };
}

/** Durable, redacted terminal receipt path for a saved canvas. */
export function lastRunReceiptPathForCanvas(canvasFilePath, nodeIdOrOptions = null) {
  const scope = jobRunPathScopeForCanvas(canvasFilePath, nodeIdOrOptions);
  if (!scope) return null;
  return path.join(scope.dir, `${scope.base}.jobs-last-run${scope.nodeId ? `.${scope.canvasHash}.${scope.ownerHash}` : ''}.json`);
}

function priorScopedLastRunReceiptPathForCanvas(canvasFilePath, nodeIdOrOptions = null) {
  const scope = jobRunPathScopeForCanvas(canvasFilePath, nodeIdOrOptions);
  if (!scope?.nodeId) return null;
  return path.join(scope.dir, `${scope.base}.jobs-last-run.${encodeURIComponent(scope.nodeId)}.json`);
}

// A legacy basename sidecar carries no full canvas identity. It is safe only
// when the sibling spelling that shares this basename does not exist.
async function hasBasenameCanvasCollision(canvasFilePath) {
  const scope = jobRunPathScopeForCanvas(canvasFilePath);
  if (!scope) return true;
  for (const candidate of [path.join(scope.dir, scope.base), path.join(scope.dir, `${scope.base}.json`)]) {
    if (candidate === scope.canvasPath) continue;
    const stat = await fs.promises.stat(candidate).catch(() => null);
    if (stat?.isFile()) return true;
  }
  return false;
}

let _tmpSeq = 0;
async function atomicWriteJson(filePath, obj) {
  // Unique tmp name PER WRITE: concurrent writers must not share a tmp path, or
  // the first rename() moves it out from under the others → ENOENT (and a lost
  // write). A bare counter is enough (the test runner forbids Date.now/random);
  // the per-path mutex below already serializes manifest writers, so this is
  // defense-in-depth for any caller that bypasses the lock.
  const tmp = `${filePath}.${process.pid}.${_tmpSeq++}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(tmp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(obj, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tmp, filePath);
    const directory = await fs.promises.open(path.dirname(filePath), 'r').catch(() => null);
    if (directory) {
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    // A failed write/rename must not accumulate sidecars forever. If rename
    // succeeded the temporary no longer exists, so ENOENT is expected here.
    await handle?.close().catch(() => {});
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

async function appendStagingDurably(filePath, text) {
  const handle = await fs.promises.open(filePath, 'a', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
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

// A save/rename changes the full-path hash used in every modern sidecar name.
// Keep the durable work with the canvas rather than treating a spelling change
// as a new owner.  The caller performs this before publishing the new canvas
// path to the renderer.  We deliberately copy all candidates first and delete
// the old set only after every destination is durable: a failed rebind leaves
// the old canvas as the sole authoritative owner (and the caller fails closed).
function jobRecoverySidecarNames(scope) {
  const prefix = `${scope.base}.jobs-`;
  const marker = `.${scope.canvasHash}.`;
  return fs.readdirSync(scope.dir, { withFileTypes: true })
    // Include lookalike links/directories in validation below. Filtering them
    // out here would silently leave an ambiguous candidate behind and make a
    // later rename appear to have completed safely.
    .filter(entry => entry.name.startsWith(prefix) && entry.name.includes(marker))
    .map(entry => entry.name)
    .filter(name => (
      /^.+\.jobs-(?:staging|run)\.[a-f0-9]{24}\.[a-f0-9]{24}\.(?:jsonl|json)$/.test(name)
      || /^.+\.jobs-last-run\.[a-f0-9]{24}\.[a-f0-9]{24}\.json$/.test(name)
    ));
}

const MAX_REBIND_JSON_SIDECAR_BYTES = 8 * 1024 * 1024;
// A healthy staged search can contain thousands of raw rows. Keep an explicit
// cap for hostile/corrupt files, but it must exceed real recovery ledgers (the
// migration copies bytes exactly; it does not parse listing payloads).
const MAX_REBIND_STAGING_BYTES = 64 * 1024 * 1024;

async function fsyncDirectory(directory) {
  const handle = await fs.promises.open(directory, 'r').catch(() => null);
  if (!handle) return;
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readSafeRebindSidecar(filePath) {
  const stat = await fs.promises.lstat(filePath);
  const maxBytes = filePath.endsWith('.jsonl') ? MAX_REBIND_STAGING_BYTES : MAX_REBIND_JSON_SIDECAR_BYTES;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error('unsafe-sidecar');
  }
  return { stat, bytes: await fs.promises.readFile(filePath) };
}

// A matching pathname alone is never ownership authority: the parent
// directory is user controlled and may contain arbitrary lookalikes.  Verify
// the exact modern owner hash against the signed-in-envelope identity before
// copying or deleting anything. Staging rows are intentionally migrated only
// with their verified manifest; a lone JSONL cannot prove which run owns it.
async function validateJobRecoverySidecars(scope, names, reboundScope = null) {
  const byOwner = new Map();
  for (const name of names) {
    const match = name.match(/^.+\.jobs-(staging|run)\.([a-f0-9]{24})\.([a-f0-9]{24})\.(jsonl|json)$/)
      || name.match(/^.+\.jobs-(last-run)\.([a-f0-9]{24})\.([a-f0-9]{24})\.(json)$/);
    if (!match || match[2] !== scope.canvasHash) throw new Error('unsafe-sidecar-name');
    const type = match[1];
    const ownerHash = match[3];
    const entry = byOwner.get(ownerHash) || {};
    if (entry[type]) throw new Error('ambiguous-sidecar');
    entry[type] = name;
    byOwner.set(ownerHash, entry);
  }
  const verified = [];
  for (const [ownerHash, entry] of byOwner) {
    if (entry.run) {
      const manifestFile = path.join(scope.dir, entry.run);
      const { bytes } = await readSafeRebindSidecar(manifestFile);
      let manifest;
      try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('malformed-manifest'); }
      const ownerId = normalizeNodeId(manifest?.inputs?.nodeId);
      if (!ownerId || pathHash(ownerId) !== ownerHash || typeof manifest.runId !== 'string' || !manifest.runId.trim()) {
        throw new Error('manifest-ownership-mismatch');
      }
      verified.push(entry.run);
      if (entry.staging) {
        await readSafeRebindSidecar(path.join(scope.dir, entry.staging));
        verified.push(entry.staging);
      }
    } else if (entry.staging) {
      // A crash may have copied the verified pair and then unlinked only the
      // old manifest.  It is safe to converge that one remaining JSONL only
      // when the exact destination manifest and destination bytes prove the
      // pair already migrated; otherwise an orphan remains ambiguous.
      if (!reboundScope) throw new Error('orphaned-staging-sidecar');
      const oldManifestName = entry.staging.replace('.jobs-staging.', '.jobs-run.').replace(/\.jsonl$/, '.json');
      const destinationManifest = path.join(reboundScope.dir, reboundJobRecoveryName(oldManifestName, scope, reboundScope));
      const destinationStaging = path.join(reboundScope.dir, reboundJobRecoveryName(entry.staging, scope, reboundScope));
      const { bytes: manifestBytes } = await readSafeRebindSidecar(destinationManifest);
      const { bytes: oldStaging } = await readSafeRebindSidecar(path.join(scope.dir, entry.staging));
      const { bytes: newStaging } = await readSafeRebindSidecar(destinationStaging);
      let manifest;
      try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new Error('orphaned-staging-manifest-invalid'); }
      const ownerId = normalizeNodeId(manifest?.inputs?.nodeId);
      if (!ownerId || pathHash(ownerId) !== ownerHash || typeof manifest.runId !== 'string' || !manifest.runId.trim()
          || !oldStaging.equals(newStaging)) {
        throw new Error('orphaned-staging-sidecar');
      }
      verified.push(entry.staging);
    }
    if (entry['last-run']) {
      const receiptFile = path.join(scope.dir, entry['last-run']);
      const { bytes } = await readSafeRebindSidecar(receiptFile);
      let receipt;
      try { receipt = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('malformed-receipt'); }
      const ownerId = normalizeNodeId(receipt?.nodeId);
      if (!ownerId || pathHash(ownerId) !== ownerHash || typeof receipt.runId !== 'string' || !receipt.runId.trim()) {
        throw new Error('receipt-ownership-mismatch');
      }
      verified.push(entry['last-run']);
    }
  }
  return verified;
}

function reboundJobRecoveryName(name, oldScope, newScope) {
  const prefix = `${oldScope.base}.`;
  if (!name.startsWith(prefix)) return null;
  const replaced = `${newScope.base}.${name.slice(prefix.length)}`;
  return replaced.replace(`.${oldScope.canvasHash}.`, `.${newScope.canvasHash}.`);
}

async function copySidecarExclusively(source, destination) {
  const { stat: sourceStat, bytes: sourceBytes } = await readSafeRebindSidecar(source);
  try {
    const { bytes: existingBytes } = await readSafeRebindSidecar(destination);
    if (!sourceBytes.equals(existingBytes)) throw new Error('destination-sidecar-conflict');
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let handle;
  let created = false;
  try {
    handle = await fs.promises.open(destination, 'wx', sourceStat.mode & 0o777);
    created = true;
    await handle.writeFile(sourceBytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsyncDirectory(path.dirname(destination));
    return true;
  } catch (error) {
    // O_EXCL is the no-clobber commit primitive. A competing new-canvas owner
    // therefore cannot be overwritten by an old-path migration.
    if (error?.code === 'EEXIST') {
      const { bytes: existingBytes } = await readSafeRebindSidecar(destination);
      if (sourceBytes.equals(existingBytes)) return false;
      throw new Error('destination-sidecar-conflict');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    if (created && handle) await fs.promises.unlink(destination).catch(() => {});
  }
}

/** Move modern manifest/staging/receipt sidecars to a newly-adopted canvas path. */
export async function rebindJobRunRecoveryOwners(oldCanvasFilePath, newCanvasFilePath) {
  const oldScope = rawJobRunPathScopeForCanvas(oldCanvasFilePath);
  const newScope = rawJobRunPathScopeForCanvas(newCanvasFilePath);
  if (!oldScope || !newScope) return { success: false, reason: 'invalid-canvas-path' };
  if (oldScope.canvasPath === newScope.canvasPath) return { success: true, migratedCount: 0 };
  let names;
  try { names = jobRecoverySidecarNames(oldScope); } catch (error) {
    if (error?.code === 'ENOENT') return { success: true, migratedCount: 0 };
    return { success: false, reason: 'scan-failed' };
  }
  let verifiedNames;
  try {
    verifiedNames = await validateJobRecoverySidecars(oldScope, names, newScope);
  } catch (error) {
    logger.warn(`[JobRunStaging] refusing unsafe recovery rebind candidate: ${error?.message || error}`);
    return { success: false, reason: 'invalid-sidecar' };
  }
  const pairs = verifiedNames.map(name => ({
    source: path.join(oldScope.dir, name),
    destination: path.join(newScope.dir, reboundJobRecoveryName(name, oldScope, newScope)),
  }));
  const created = [];
  let sourceDeletionStarted = false;
  try {
    for (const pair of pairs) {
      if (await copySidecarExclusively(pair.source, pair.destination)) created.push(pair.destination);
    }
    // Keep deletion last. Existing per-file mutexes serialize normal writers;
    // callers must not publish the new path unless this whole transaction wins.
    for (const pair of pairs) {
      sourceDeletionStarted = true;
      await fs.promises.unlink(pair.source);
    }
    await fsyncDirectory(oldScope.dir);
    return { success: true, migratedCount: pairs.length };
  } catch (error) {
    // No source is removed before all new files are copied. Best-effort cleanup
    // avoids a failed transaction becoming visible under the new canvas path.
    // A late unlink/directory-fsync failure occurs after the destination has
    // become the sole exact copy for at least one sidecar. Preserve it for the
    // journal's idempotent replay rather than rolling user work back into loss.
    if (!sourceDeletionStarted) await Promise.all(created.map(filePath => fs.promises.unlink(filePath).catch(() => {})));
    logger.warn(`[JobRunStaging] recovery owner rebind failed: ${error?.message || error}`);
    return { success: false, reason: error?.message === 'destination-sidecar-conflict' ? 'destination-conflict' : 'migration-failed' };
  }
}

function receiptNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function receiptTimestamp(value, fallback = null) {
  // Completion ordering is provenance, unlike display-only counters. Keep it
  // a real Date.now()-style number so strings/booleans cannot become a
  // plausible terminal instant before the board-clear report boundary sees it.
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && Number.isFinite(new Date(value).getTime())
    ? value
    : fallback;
}

function receiptToken(value, max = 80) {
  const text = String(value ?? '').trim();
  // Source IDs, stop reasons, and warning codes are controlled identifiers.
  // Still restrict their character set here so no provider body/error text can
  // accidentally become durable report data through a future caller.
  return /^[a-zA-Z0-9_.:/-]+$/.test(text) ? text.slice(0, max) : null;
}

const RECEIPT_REVEAL_EXITS = new Set([
  'end-of-list',
  'plateau',
  'iteration-ceiling',
  'target-reached',
  'aborted',
]);
const RECEIPT_MAX_PAGES_WALKED = 100_000;

function sanitizeReceiptRevealOutcomes(values) {
  const outcomes = [];
  for (const value of (Array.isArray(values) ? values : []).slice(0, 20)) {
    const queryIndex = receiptNumber(value?.queryIndex, null);
    const queryTotal = receiptNumber(value?.queryTotal, null);
    const exit = receiptToken(value?.exit, 32);
    if (!(queryIndex > 0) || !(queryTotal > 0) || queryIndex > queryTotal || !RECEIPT_REVEAL_EXITS.has(exit)) continue;
    outcomes.push({
      queryIndex,
      queryTotal,
      exit,
      count: receiptNumber(value?.count),
      iterations: receiptNumber(value?.iterations),
    });
  }
  return outcomes;
}

function sanitizeReceiptSourceCap(cap) {
  if (!cap || typeof cap !== 'object' || Array.isArray(cap)) return null;
  // `source-internal` is a provider's own finite result ceiling (currently
  // LinkedIn's 150-offset walk), not a user-configured collection cap. It is
  // still safe aggregate-only provenance and the report explicitly refuses it
  // as configured-cap proof; dropping it here left a durable `result-ceiling`
  // stop with no number after restart.
  if (!['per-platform', 'jobs-per-platform', 'pages-per-platform', 'auto-jobs-per-platform', 'auto-pages-per-platform', 'source-internal'].includes(cap.type)) return null;
  // A cap is completion evidence, not a display hint. Do not coerce truthy
  // values or fractions into a different integer cap (for example, 0.5 → 0),
  // since that could make a malformed receipt look like a user-configured
  // boundary in restart diagnostics.
  if (typeof cap.limit !== 'number' || !Number.isSafeInteger(cap.limit) || cap.limit <= 0) return null;
  return { type: cap.type, limit: cap.limit };
}

function sanitizeReceiptStopReason(value) {
  // Stop reasons are a slash-joined set assembled across API fan-out queries.
  // Bound individual controlled tokens, never the joined string: a blind
  // 80-character slice can cut `pages-per-platform` in half and turn a valid
  // configured-cap receipt into restart-time unproven coverage.
  const seen = new Set();
  const stops = [];
  for (const raw of String(value ?? '').split('/').slice(0, 24)) {
    const token = receiptToken(raw, 32);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    stops.push(token);
    if (stops.length >= 8) break;
  }
  return stops.join('/') || null;
}

function sanitizeReceiptSourceCaps(caps) {
  const seen = new Set();
  const safe = [];
  for (const cap of (Array.isArray(caps) ? caps : []).slice(0, 3)) {
    const normalized = sanitizeReceiptSourceCap(cap);
    if (!normalized) continue;
    const key = `${normalized.type}:${normalized.limit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    safe.push(normalized);
  }
  return safe;
}

function sanitizeReceiptSource(source = {}) {
  const warning = source.warning && typeof source.warning === 'object'
    ? {
        ...(receiptToken(source.warning.code) ? { code: receiptToken(source.warning.code) } : {}),
        ...(receiptToken(source.warning.severity, 24) ? { severity: receiptToken(source.warning.severity, 24) } : {}),
      }
    : null;
  const revealOutcomes = sanitizeReceiptRevealOutcomes(source.revealOutcomes);
  const cap = sanitizeReceiptSourceCap(source.cap);
  const caps = sanitizeReceiptSourceCaps(source.caps);
  const stopReason = sanitizeReceiptStopReason(source.stopReason);
  return {
    count: receiptNumber(source.count),
    providerGathered: receiptNumber(source.providerGathered),
    // This is a safe aggregate only: no titles, URLs, or provider text. It
    // explains why distinct candidate identities can exceed returned usable
    // rows after a detail page confirms that a posting is unavailable.
    ...(receiptNumber(source.unavailableDetailDropped) > 0
      ? { unavailableDetailDropped: receiptNumber(source.unavailableDetailDropped) }
      : {}),
    // A known Glassdoor nation-tier caveat. This is intentionally independent
    // from the source warning slot, so a benign scope disclosure cannot mask a
    // later block/error and remains available after process restart.
    ...(source.locationScopeUnenforced === true ? { locationScopeUnenforced: true } : {}),
    // Numbers only, same as every other field here: the provider's own corpus
    // size for this query plus the walk's own truncation flag. They are what
    // separates "this source has 44 postings" from "this source has 973 and we
    // read 44", which no other retained field can express.
    ...(source.providerTotal != null && source.providerTotal !== ''
      && Number.isFinite(Number(source.providerTotal)) && Number(source.providerTotal) >= 0
      ? { providerTotal: receiptNumber(source.providerTotal) }
      : {}),
    ...(source.truncated === true ? { truncated: true } : {}),
    ...(source.pagesWalked != null && source.pagesWalked !== ''
      && Number.isFinite(Number(source.pagesWalked)) && Number(source.pagesWalked) >= 0
      ? { pagesWalked: Math.min(RECEIPT_MAX_PAGES_WALKED, receiptNumber(source.pagesWalked)) }
      : {}),
    relevanceDropped: receiptNumber(source.relevanceDropped),
    ...(receiptNumber(source.sponsoredDropped) > 0 ? { sponsoredDropped: receiptNumber(source.sponsoredDropped) } : {}),
    ...(cap ? { cap } : {}),
    ...(caps.length > 0 ? { caps } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(warning && Object.keys(warning).length > 0 ? { warning } : {}),
    ...(revealOutcomes.length > 0 ? { revealOutcomes } : {}),
  };
}

function sanitizeReceiptScoring(scoring) {
  if (!scoring || typeof scoring !== 'object' || Array.isArray(scoring)) return null;
  const coreFields = ['input', 'selected', 'scored', 'placeholders', 'unscored', 'failedBatches'];
  if (!coreFields.every(key => (
    scoring[key] != null
    && scoring[key] !== ''
    && Number.isFinite(Number(scoring[key]))
    && Number(scoring[key]) >= 0
  ))) return null;
  // These are aggregate counters only. In particular, never retain a model
  // response, failure text, listing field, prompt, provider metadata, or URL.
  return {
    input: receiptNumber(scoring.input),
    selected: receiptNumber(scoring.selected),
    scored: receiptNumber(scoring.scored),
    placeholders: receiptNumber(scoring.placeholders),
    unscored: receiptNumber(scoring.unscored),
    failedBatches: receiptNumber(scoring.failedBatches),
    ...(Number.isFinite(Number(scoring.cappedForBudget)) && Number(scoring.cappedForBudget) >= 0
      ? { cappedForBudget: receiptNumber(scoring.cappedForBudget) }
      : {}),
    ...(Number.isFinite(Number(scoring.providerCalls)) && Number(scoring.providerCalls) >= 0
      ? { providerCalls: receiptNumber(scoring.providerCalls) }
      : {}),
  };
}

function sanitizeReceiptRecovery(recovery) {
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return null;
  // Recovery is deliberately one signed integer. It reconciles the initial
  // funnel to the terminal scorer after restart, while excluding source IDs,
  // job rows, listing text, URLs, and renderer event detail.
  const mergeNet = recovery.mergeNet;
  if (typeof mergeNet !== 'number' || !Number.isSafeInteger(mergeNet)) return null;
  return { mergeNet };
}

/**
 * Whitelist the completion receipt shape. Keep this boundary defensive: this
 * artifact is read by support reports after restart, so it must never become a
 * backdoor for jobs, queries, profile data, URLs, or provider error bodies.
 */
export function sanitizeLastRunReceipt(receipt = {}) {
  // These opaque IDs correlate durable terminal receipts with a live hub and
  // board-clear provenance. Do not coerce `42`/`true` into plausible tokens:
  // a malformed sidecar must become invalid evidence, never a different run.
  const runId = typeof receipt.runId === 'string' ? receipt.runId.trim().slice(0, 180) : '';
  const nodeId = typeof receipt.nodeId === 'string' ? receipt.nodeId.trim().slice(0, 180) : '';
  const terminalStatus = ['completed', 'failed', 'aborted'].includes(receipt?.terminal?.status)
    ? receipt.terminal.status
    : 'completed';
  const terminalOutcome = ['zero', 'populated', 'collection-only', 'preference-filtered', 'incomplete', 'unknown'].includes(receipt?.terminal?.outcome)
    ? receipt.terminal.outcome
    : 'unknown';
  const completedAt = receiptTimestamp(receipt.completedAt);
  const careerSnapshotId = normalizeCareerSnapshotId(receipt.careerSnapshotId);
  // This is a compact host-issued capability receipt, never the authority
  // sidecar. Keeping it in the terminal receipt makes a post-cleanup retry
  // prove it owns this exact run rather than borrowing a later hub operation.
  const operationAuthority = jobAnalysisOperationAuthorityReceipt(receipt.operationAuthority);
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
    countryScopeDropped: receiptNumber(receipt.funnel.countryScopeDropped),
    ...(receipt.funnel.windowEligible != null
      ? { windowEligible: receiptNumber(receipt.funnel.windowEligible) }
      : {}),
    ...(receipt.funnel.platformDuplicateDropped != null
      ? { platformDuplicateDropped: receiptNumber(receipt.funnel.platformDuplicateDropped) }
      : {}),
    ...(receipt.funnel.platformCapDropped != null
      ? { platformCapDropped: receiptNumber(receipt.funnel.platformCapDropped) }
      : {}),
    ...(receipt.funnel.platformUnique != null
      ? { platformUnique: receiptNumber(receipt.funnel.platformUnique) }
      : {}),
    ...(receipt.funnel.platformCapped != null
      ? { platformCapped: receiptNumber(receipt.funnel.platformCapped) }
      : {}),
    deduped: receiptNumber(receipt.funnel.deduped),
    ageDropped: receiptNumber(receipt.funnel.ageDropped),
    // Rows the AI role screen rejected (screenJobRolesByTitle, replacing the
    // old deterministic pinned-title gate — see jobs.js's reconcileSearchFunnel
    // and the search-jobs call site for the full rationale). Still sits
    // between age and history in this funnel because that is exactly where
    // the screen runs; 0 on a run with no resolved titles to screen against.
    roleDropped: receiptNumber(receipt.funnel.roleDropped),
    historyDropped: receiptNumber(receipt.funnel.historyDropped),
    descriptionEvidenceDropped: receiptNumber(receipt.funnel.descriptionEvidenceDropped),
    ...(receipt.funnel.finalDedupDropped != null ? { finalDedupDropped: receiptNumber(receipt.funnel.finalDedupDropped) } : {}),
    kept: receiptNumber(receipt.funnel.kept),
  } : null;
  const scoring = sanitizeReceiptScoring(receipt.scoring);
  const recovery = sanitizeReceiptRecovery(receipt.recovery);
  return {
    version: JOB_RUN_RECEIPT_VERSION,
    runId,
    nodeId,
    ...(careerSnapshotId ? { careerSnapshotId } : {}),
    ...(operationAuthority ? { operationAuthority } : {}),
    startedAt: receiptTimestamp(receipt.startedAt),
    completedAt,
    updatedAt: receiptTimestamp(receipt.updatedAt, completedAt),
    terminal: {
      status: terminalStatus,
      outcome: terminalOutcome,
      ...(scoreReadyCount != null ? { scoreReadyCount } : {}),
    },
    ...(funnel ? { funnel } : {}),
    ...(scoring ? { scoring } : {}),
    ...(recovery ? { recovery } : {}),
    sources,
    stagingStarted: receipt.stagingStarted === true,
    cleanup: {
      attempted: receipt.cleanup?.attempted === true,
      cleared: typeof receipt.cleanup?.cleared === 'boolean' ? receipt.cleanup.cleared : null,
    },
  };
}

async function readLegacyReceiptForNode(canvasFilePath, nodeId) {
  if (await hasBasenameCanvasCollision(canvasFilePath)) return null;
  const priorScopedPath = priorScopedLastRunReceiptPathForCanvas(canvasFilePath, nodeId);
  if (priorScopedPath) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(priorScopedPath, 'utf8'));
      if (normalizeNodeId(parsed?.nodeId) === nodeId) return parsed;
    } catch { /* fall through to baseline singleton */ }
  }
  const legacyPath = lastRunReceiptPathForCanvas(canvasFilePath);
  if (!legacyPath) return null;
  try {
    const parsed = JSON.parse(await fs.promises.readFile(legacyPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const recordedOwner = normalizeNodeId(parsed.nodeId);
    return !recordedOwner || recordedOwner === nodeId ? parsed : null;
  } catch {
    return null;
  }
}

function readLegacyReceiptForNodeSync(canvasFilePath, nodeId) {
  // Synchronous report assembly cannot await the collision check. Refuse the
  // old basename fallback whenever both spellings exist; current hashed paths
  // are read before this helper.
  const scope = jobRunPathScopeForCanvas(canvasFilePath);
  if (!scope) return null;
  for (const candidate of [path.join(scope.dir, scope.base), path.join(scope.dir, `${scope.base}.json`)]) {
    if (candidate !== scope.canvasPath && fs.existsSync(candidate)) return null;
  }
  const priorScopedPath = priorScopedLastRunReceiptPathForCanvas(canvasFilePath, nodeId);
  if (priorScopedPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(priorScopedPath, 'utf8'));
      if (normalizeNodeId(parsed?.nodeId) === nodeId) return parsed;
    } catch { /* fall through to baseline singleton */ }
  }
  const legacyPath = lastRunReceiptPathForCanvas(canvasFilePath);
  if (!legacyPath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const recordedOwner = normalizeNodeId(parsed.nodeId);
    return !recordedOwner || recordedOwner === nodeId ? parsed : null;
  } catch {
    return null;
  }
}

async function readLastRunReceiptRaw(canvasFilePath, nodeIdOrOptions = null) {
  const filePath = lastRunReceiptPathForCanvas(canvasFilePath, nodeIdOrOptions);
  if (!filePath) return null;
  try {
    if (!normalizeNodeId(nodeIdOrOptions) && await hasBasenameCanvasCollision(canvasFilePath)) {
      throw new Error('ambiguous-basename-legacy-receipt');
    }
    const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const nodeId = normalizeNodeId(nodeIdOrOptions);
    return !nodeId || normalizeNodeId(parsed.nodeId) === nodeId ? parsed : null;
  } catch {
    // Receipts used to be canvas-singleton. A scoped caller can consult ONLY
    // that legacy singleton when it was unowned or belonged to this hub; it
    // must never fall through to another modern hub's receipt.
    const nodeId = normalizeNodeId(nodeIdOrOptions);
    if (nodeId) return readLegacyReceiptForNode(canvasFilePath, nodeId);
    // As with manifests, a legacy caller can safely consume exactly one modern
    // receipt while it migrates to nodeId-aware reads. Multiple receipts are
    // intentionally ambiguous and therefore never selected implicitly.
    try {
      const scope = jobRunPathScopeForCanvas(canvasFilePath);
      if (!scope) return null;
      const names = await fs.promises.readdir(scope.dir);
      const matches = names.filter(name => name.startsWith(`${scope.base}.jobs-last-run.${scope.canvasHash}.`) && name.endsWith('.json'));
      if (matches.length === 1) {
        const parsed = JSON.parse(await fs.promises.readFile(path.join(scope.dir, matches[0]), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      }
    } catch { /* no usable unambiguous receipt */ }
    return null;
  }
}

/** Synchronous companion for bug-report assembly, which is intentionally sync. */
export function readLastRunReceiptSync(canvasFilePath, nodeIdOrOptions = null) {
  const filePath = lastRunReceiptPathForCanvas(canvasFilePath, nodeIdOrOptions);
  if (!filePath) return null;
  try {
    if (!normalizeNodeId(nodeIdOrOptions)) {
      const scope = jobRunPathScopeForCanvas(canvasFilePath);
      if (scope && [path.join(scope.dir, scope.base), path.join(scope.dir, `${scope.base}.json`)]
        .some(candidate => candidate !== scope.canvasPath && fs.existsSync(candidate))) {
        throw new Error('ambiguous-basename-legacy-receipt');
      }
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const nodeId = normalizeNodeId(nodeIdOrOptions);
    return !nodeId || normalizeNodeId(parsed.nodeId) === nodeId ? parsed : null;
  } catch {
    const nodeId = normalizeNodeId(nodeIdOrOptions);
    if (nodeId) return readLegacyReceiptForNodeSync(canvasFilePath, nodeId);
    try {
      const scope = jobRunPathScopeForCanvas(canvasFilePath);
      if (!scope) return null;
      const matches = fs.readdirSync(scope.dir)
        .filter(name => name.startsWith(`${scope.base}.jobs-last-run.${scope.canvasHash}.`) && name.endsWith('.json'));
      if (matches.length === 1) {
        const parsed = JSON.parse(fs.readFileSync(path.join(scope.dir, matches[0]), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      }
    } catch { /* no usable unambiguous receipt */ }
    return null;
  }
}

/** Direct, token-guarded receipt write for focused tests/support tooling. */
async function writeLastRunReceiptRaw(canvasFilePath, receipt, { expectedRunId = null, nodeId = null } = {}) {
  const filePath = lastRunReceiptPathForCanvas(canvasFilePath, nodeId || receipt?.nodeId || null);
  if (!filePath) return { written: false, receipt: null };
  return withReceiptLock(filePath, async () => {
    const current = await readLastRunReceipt(canvasFilePath, nodeId || receipt?.nodeId || null);
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

async function readManifestFromFiles(files) {
  if (!files) return null;
  try {
    const raw = await fs.promises.readFile(files.manifest, 'utf8');
    const manifest = JSON.parse(raw);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    // Version-1 manifests predate Job Preferences. Materializing neutral
    // defaults here lets all recovery consumers use one contract, while still
    // keeping the old run's ordinary query/location semantics intact.
    const inputs = manifest.inputs && typeof manifest.inputs === 'object' && !Array.isArray(manifest.inputs)
      ? manifest.inputs
      : {};
    const {
      collectionCompletedAt: rawCollectionCompletedAt,
      collectionDisposition: rawCollectionDisposition,
      recoveryDisposition: rawRecoveryDisposition,
      ...otherManifest
    } = manifest;
    const collectionCompletedAt = manifestTimestamp(rawCollectionCompletedAt);
    const collectionDisposition = normalizeJobRunCollectionDisposition(rawCollectionDisposition);
    const recoveryDisposition = normalizeJobRunRecoveryDisposition(rawRecoveryDisposition);
    const { searchWindow: rawSearchWindow, ...otherInputs } = inputs;
    const searchWindow = sanitizeJobSearchWindow(rawSearchWindow);
    return {
      ...otherManifest,
      ...(collectionCompletedAt != null ? { collectionCompletedAt } : {}),
      ...(collectionDisposition ? { collectionDisposition } : {}),
      ...(recoveryDisposition ? { recoveryDisposition } : {}),
      inputs: {
        ...otherInputs,
        jobPreferences: sanitizeJobPreferences(inputs.jobPreferences),
        jobPreferencePlan: sanitizeJobPreferencePlan(inputs.jobPreferencePlan),
        ...(searchWindow ? { searchWindow } : {}),
      },
    };
  } catch {
    return null; // missing or corrupt → treated as "no run"
  }
}

// Locate one hub's ledger. A node-scoped ledger always wins. If it has not
// been created yet, a legacy singleton may be resumed by its recorded owner
// (or deliberately handled as owner-unknown); it is never moved or replaced as
// an incidental side effect of opening another hub.
async function locateRun(canvasFilePath, nodeIdOrOptions = null) {
  const nodeId = normalizeNodeId(nodeIdOrOptions);
  const files = runFilesForCanvas(canvasFilePath, nodeId);
  if (!files) return { files: null, manifest: null };
  const manifest = !nodeId && await hasBasenameCanvasCollision(canvasFilePath)
    ? null
    : await readManifestFromFiles(files);
  if (manifest) {
    // Filename hashes are routing hints, never ownership authority. A corrupt
    // or deliberately planted file at this path must not pair another hub's
    // manifest with this hub's staging ledger.
    if (!nodeId || normalizeNodeId(manifest.inputs?.nodeId) === nodeId) return { files, manifest, legacy: false };
    return { files, manifest: null, legacy: false };
  }
  if (!nodeId) {
    // Preserve incremental callers from the singleton era when the canvas has
    // exactly one modern hub ledger. Ambiguity is intentionally a miss: callers
    // that could otherwise cross hubs must pass a nodeId.
    try {
      const scope = jobRunPathScopeForCanvas(canvasFilePath);
      if (!scope) return { files, manifest: null, legacy: false };
      const names = await fs.promises.readdir(scope.dir);
      const matches = names.filter(name => name.startsWith(`${scope.base}.jobs-run.${scope.canvasHash}.`) && name.endsWith('.json'));
      const candidates = [];
      for (const name of matches) {
        const candidateFiles = {
          staging: path.join(scope.dir, name.replace(/\.jobs-run\.(.+)\.json$/, '.jobs-staging.$1.jsonl')),
          manifest: path.join(scope.dir, name),
          nodeId: null,
          legacy: false,
        };
        const candidate = await readManifestFromFiles(candidateFiles);
        const candidateNodeId = normalizeNodeId(candidate?.inputs?.nodeId);
        if (!candidate || !candidateNodeId) continue;
        candidates.push({ files: { ...candidateFiles, nodeId: candidateNodeId }, manifest: candidate });
      }
      if (candidates.length === 1) return { ...candidates[0], legacy: false };
    } catch { /* missing/unreadable canvas directory behaves as no run */ }
    return { files, manifest: null, legacy: false };
  }

  const collision = await hasBasenameCanvasCollision(canvasFilePath);
  const priorScopedFiles = priorScopedRunFilesForCanvas(canvasFilePath, nodeId);
  const priorScopedManifest = !collision ? await readManifestFromFiles(priorScopedFiles) : null;
  const priorScopedOwner = normalizeNodeId(priorScopedManifest?.inputs?.nodeId);
  if (priorScopedManifest && priorScopedOwner === nodeId) {
    return { files: priorScopedFiles, manifest: priorScopedManifest, legacy: true };
  }
  const legacyFiles = runFilesForCanvas(canvasFilePath);
  const legacyManifest = !collision ? await readManifestFromFiles(legacyFiles) : null;
  const legacyOwner = normalizeNodeId(legacyManifest?.inputs?.nodeId);
  if (legacyManifest && (!legacyOwner || legacyOwner === nodeId)) {
    return { files: legacyFiles, manifest: legacyManifest, legacy: true };
  }
  return { files, manifest: null, legacy: false };
}

// The preference plan comes from model output, but becomes durable recovery
// input. Keep the persisted form deliberately small and data-only: a corrupt
// or future plan must not make a saved canvas impossible to resume, and we do
// not retain arbitrary model payloads merely because they happened to be
// adjacent to the useful plan fields.
function manifestText(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function manifestTextList(value, { maxItems = 30, maxItemLength = 280 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => manifestText(item, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizeManifestPreferenceRows(value, strict) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const criterion = manifestText(row.criterion, 600);
    if (!criterion) return [];
    const id = manifestText(row.id, 100) || `${strict ? 'strict' : 'soft'}-${index + 1}`;
    const category = manifestText(row.category, 100);
    return [{ id, criterion, ...(category ? { category } : {}) }];
  });
}

/**
 * Make a durable, backwards-compatible subset of the preference interpreter's
 * model result. This is intentionally exported for regression tests; callers
 * should keep treating a null plan as "interpret again" rather than a failed
 * recovery.
 */
export function sanitizeJobPreferencePlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const directionValue = value.direction && typeof value.direction === 'object' && !Array.isArray(value.direction)
    ? value.direction
    : {};
  const direction = {
    summary: manifestText(directionValue.summary, 1000),
    // Directions are exact mirrors of role criteria. Preserve the same full
    // bound here or a crash/restart can truncate a valid accepted plan into a
    // direction/criterion mismatch that fails recovery validation.
    roleDirections: manifestTextList(directionValue.roleDirections, { maxItemLength: JOB_PREFERENCE_CRITERION_MAX_LENGTH }),
    avoidDirections: manifestTextList(directionValue.avoidDirections, { maxItemLength: JOB_PREFERENCE_CRITERION_MAX_LENGTH }),
    explorationEnabled: directionValue.explorationEnabled === true,
  };
  const plan = {
    // Plans are intentionally normalized to the only format this build can
    // resume. Future versions fall back to their raw Job Preferences text.
    version: 1,
    summary: manifestText(value.summary, 1000),
    direction,
    softPreferences: sanitizeManifestPreferenceRows(value.softPreferences, false),
    strictRequirements: sanitizeManifestPreferenceRows(value.strictRequirements, true),
    warnings: manifestTextList(value.warnings, { maxItems: 10, maxItemLength: 500 }),
    // FIX 9: `titles` must survive the manifest round-trip. This is the
    // AI-determined role list generate-job-queries's ladder rung 2 (see
    // jobs.js) uses to reproduce the exact same board queries on a resumed
    // run — omitting it here (as this function previously did) silently fell
    // a resume through to ladder rung 3's exploratory profile-driven query
    // generation instead, which is not the same search. Bounds mirror
    // normalizeJobPreferencePlan's (<=20 items, <=180 chars/item) so a
    // recovered manifest can never carry a larger titles list than a
    // freshly-interpreted plan could produce.
    // `titleSource` (brief vs. generated) is gone: the two-mode design was
    // removed — the AI always determines the roles now — so there is no
    // longer a "which mode produced these titles" distinction to persist.
    titles: manifestTextList(value.titles, { maxItems: 20, maxItemLength: JOB_PREFERENCE_TITLE_MAX_LENGTH }),
  };
  const meaningful = plan.summary
    || plan.direction.summary
    || plan.direction.roleDirections.length > 0
    || plan.direction.avoidDirections.length > 0
    || plan.direction.explorationEnabled
    || plan.softPreferences.length > 0
    || plan.strictRequirements.length > 0
    || plan.warnings.length > 0
    // FIX 9 (cont.): a plan can now be "meaningful" on titles alone — without
    // this, an interpretation that produced titles but no summary/direction/
    // preference text would fail the meaningful check and get discarded as
    // null, silently reproducing the exact bug this fix closes.
    || plan.titles.length > 0;
  return meaningful ? plan : null;
}

export function sanitizeJobPreferences(value) {
  // The renderer bounds this input, but IPC callers and old canvases can bypass
  // it. Match the backend cap so manifests remain small and deterministic.
  return typeof value === 'string' ? value.trim().slice(0, 4000) : '';
}

const JOB_SEARCH_WINDOW_CAP_REASONS = new Set([
  'no-completion',
  'invalid-completion',
  'future-completion',
  'older-than-max-lookback',
  'legacy-max-age-days',
]);

function manifestTimestamp(value) {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && Number.isFinite(new Date(value).getTime())
    ? value
    : null;
}

/** Keep the durable collection outcome to a fixed, non-provider-controlled enum. */
export function normalizeJobRunCollectionDisposition(value) {
  return typeof value === 'string' && JOB_RUN_COLLECTION_DISPOSITIONS.has(value)
    ? value
    : null;
}

/** Keep the restart policy to the single explicit, user-controlled state. */
export function normalizeJobRunRecoveryDisposition(value) {
  return typeof value === 'string' && JOB_RUN_RECOVERY_DISPOSITIONS.has(value)
    ? value
    : null;
}

/** Legacy/missing disposition is the automatic crash-recovery default. */
export function isJobRunAutomaticRecoveryEligible(manifest) {
  if (normalizeJobRunRecoveryDisposition(manifest?.recoveryDisposition)
      === JOB_RUN_RECOVERY_DISPOSITION.MANUAL) return false;
  return !Object.values(manifest?.sources || {}).some((source) => {
    if (source?.status === 'done' || source?.status === 'skipped') return false;
    const disposition = normalizeJobRunRecoveryDisposition(source?.recoveryDisposition);
    if (disposition === JOB_RUN_RECOVERY_DISPOSITION.MANUAL) return true;
    // Missing/legacy disposition remains automatic. Only an explicit durable
    // manual gate is allowed to suppress restart recovery.
    return false;
  });
}

/**
 * True only when this exact ledger was deliberately ended with its saved rows.
 * Callers still validate run ownership, query identity, and profile identity;
 * this predicate answers only whether provider collection must remain stopped.
 */
export function isRunCollectionFinishedWithSavedListings(manifest) {
  return manifest?.stage === 'gathered'
    && normalizeJobRunCollectionDisposition(manifest?.collectionDisposition)
      === JOB_RUN_COLLECTION_DISPOSITION.USER_FINISHED_PARTIAL;
}

/**
 * Return the immutable instant at which this run first reached its gathered
 * checkpoint. Older manifests stored only `lastUpdated`; that value is a safe
 * conservative fallback only while their stage is already `gathered`.
 */
export function collectionCompletedAtForManifest(manifest) {
  const exact = manifestTimestamp(manifest?.collectionCompletedAt);
  if (exact != null) return exact;
  return manifest?.stage === 'gathered'
    ? manifestTimestamp(manifest?.lastUpdated)
    : null;
}

/**
 * Provider collection is a narrower boundary than `stage: 'gathered'`.
 * The main process can still be waiting on semantic/manual-AI processing after
 * every provider has terminally checkpointed its rows. It admits a renderer
 * click to the shared job-work queue; source mutation and crash recovery still
 * require the existing post-filter `gathered` stage.
 */
export function providerGatheredAtForManifest(manifest) {
  return manifestTimestamp(manifest?.providerGatheredAt);
}

// Keep diagnostics and renderer-facing callers on the same explicit-only
// contract. A legacy all-terminal source ledger is collection evidence, not a
// recovery checkpoint, so it must never be inferred as this boundary.
export function hasProviderGatheredBoundary(manifest) {
  return providerGatheredAtForManifest(manifest) != null;
}

/**
 * Keep the exact, data-only date boundary needed to resume an interrupted
 * gather. Provider lookback is deliberately separate from `startTimestamp`:
 * providers may need a broader whole-day request while the final client-side
 * pass enforces the precise inclusive boundary.
 */
export function sanitizeJobSearchWindow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const startTimestamp = manifestTimestamp(value.startTimestamp);
  const providerLookbackDays = Number(value.providerLookbackDays);
  if (startTimestamp == null
    || !Number.isSafeInteger(providerLookbackDays)
    || providerLookbackDays <= 0
    || providerLookbackDays > JOB_SEARCH_MAX_PROVIDER_LOOKBACK_DAYS) return null;

  const completionTimestamp = value.completionTimestamp == null
    ? null
    : manifestTimestamp(value.completionTimestamp);
  if (value.completionTimestamp != null && completionTimestamp == null) return null;
  const capReason = value.capReason == null
    ? null
    : String(value.capReason);
  if (capReason != null && !JOB_SEARCH_WINDOW_CAP_REASONS.has(capReason)) return null;

  return {
    startTimestamp,
    // `anchorTimestamp` was part of the original resolver result. Normalize it
    // to the authoritative start so a malformed IPC payload cannot persist two
    // contradictory exact boundaries.
    anchorTimestamp: startTimestamp,
    completionTimestamp,
    capped: value.capped === true,
    capReason,
    providerLookbackDays,
  };
}

/**
 * Begin a run: write a fresh manifest (stage='searching') and truncate any prior
 * staging file. `runId`/`startedAt` are passed in (callers stamp time, since the
 * test runner forbids Date.now()). Returns the manifest, or null if no canvas.
 */
async function startRunRaw(canvasFilePath, { runId, startedAt, queries = [], profileFingerprint = null, careerSnapshotId = null, targetRole = null, jobPreferences = '', jobPreferencePlan = null, canonicalLocation = '', searchWindow = null, maxAgeDays = null, collectionLimits = null, nodeId = null, sourceIds = [], operationAuthority = null, __testOnlyAllowUnpinned = false }) {
  const ownerNodeId = normalizeNodeId(nodeId);
  const files = runFilesForCanvas(canvasFilePath, ownerNodeId);
  if (!files) return null;
  const normalizedCareerSnapshotId = normalizeCareerSnapshotId(careerSnapshotId);
  // Every production collection must begin pinned. The sole exception is an
  // explicit test-only store seam used to exercise legacy-file migration;
  // production IPC never forwards this private parameter.
  if (!normalizedCareerSnapshotId && !__testOnlyAllowUnpinned) {
    return { rejected: true, careerSnapshotMissing: true };
  }
  if (!__testOnlyAllowUnpinned && !jobAnalysisOperationAuthorityReceipt(operationAuthority)) {
    return { rejected: true, operationAuthorityMissing: true };
  }
  const sources = {};
  for (const id of sourceIds) sources[id] = { status: 'pending', queries: {} };
  const manifest = {
    version: MANIFEST_VERSION,
    runId, startedAt, lastUpdated: startedAt,
    stage: 'searching',
    inputs: {
      queries,
      profileFingerprint: normalizeJobRunProfileFingerprint(profileFingerprint),
      careerSnapshotId: normalizedCareerSnapshotId,
      targetRole,
      jobPreferences: sanitizeJobPreferences(jobPreferences),
      jobPreferencePlan: sanitizeJobPreferencePlan(jobPreferencePlan),
      canonicalLocation,
      searchWindow: sanitizeJobSearchWindow(searchWindow),
      maxAgeDays,
      collectionLimits,
      nodeId: ownerNodeId,
      // Main validated this compact host-issued receipt immediately before
      // creating the manifest. Resume/provider paths compare it exactly.
      operationAuthority,
    },
    sources,
  };
  const result = await withManifestLock(files.manifest, async () => {
    // Each hub owns its own staging ledger. This lock only serializes one
    // hub's replacement, so another hub can continue its recoverable search
    // independently while same-hub reruns retain the established fencing.
    const existing = await readManifestFromFiles(files);
    const existingNodeId = normalizeNodeId(existing?.inputs?.nodeId);
    if (existing && ownerNodeId) {
      // A manifest on disk is an unfinished recovery record, including one
      // owned by THIS hub. Never let a new start truncate a same-hub staging
      // ledger behind the user's back; Resume (or Finish with saved listings)
      // owns that token, while Clear career data is the explicit destructive
      // escape hatch. A legacy manifest without ownership is likewise real
      // recovery data rather than permission to overwrite it.
      return {
        conflict: true,
        ownerNodeId: existingNodeId,
        ownerUnknown: !existingNodeId,
        ownerRunId: existing.runId || null,
      };
    }
    // A legacy singleton belongs to no scoped filename. Never let a new run
    // silently hide it behind this hub's new sidecar: its recorded owner (or an
    // unknown legacy owner) must Resume/Discard it explicitly first. A legacy
    // run owned by another hub does not block this hub because the new files do
    // not overwrite or mutate it.
    if (!existing && ownerNodeId) {
      const collision = await hasBasenameCanvasCollision(canvasFilePath);
      const priorScopedFiles = priorScopedRunFilesForCanvas(canvasFilePath, ownerNodeId);
      const priorScoped = !collision ? await readManifestFromFiles(priorScopedFiles) : null;
      const priorOwner = normalizeNodeId(priorScoped?.inputs?.nodeId);
      if (priorScoped && priorOwner === ownerNodeId) {
        return {
          conflict: true,
          ownerNodeId: priorOwner,
          ownerUnknown: false,
          ownerRunId: priorScoped.runId || null,
          legacy: true,
        };
      }
      const legacyFiles = runFilesForCanvas(canvasFilePath);
      const legacy = !collision ? await readManifestFromFiles(legacyFiles) : null;
      const legacyOwner = normalizeNodeId(legacy?.inputs?.nodeId);
      if (legacy && (!legacyOwner || legacyOwner === ownerNodeId)) {
        return {
          conflict: true,
          ownerNodeId: legacyOwner,
          ownerUnknown: !legacyOwner,
          ownerRunId: legacy.runId || null,
          legacy: true,
        };
      }
    }
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
      return { started: true };
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
      return { started: false };
    }
  });
  if (result?.conflict) return result;
  return result?.started ? manifest : null;
}

function sameOperationAuthorityReceipt(left, right) {
  const normalized = value => value && typeof value === 'object'
    && typeof value.operationId === 'string'
    && Number.isSafeInteger(value.revision) && value.revision > 0
    && value.semanticBase && typeof value.semanticBase === 'object'
    ? JSON.stringify({ operationId: value.operationId, revision: value.revision, semanticBase: value.semanticBase })
    : null;
  const a = normalized(left);
  const b = normalized(right);
  return !!a && a === b;
}

function sameAuthorityReceipt(left, right) {
  return sameOperationAuthorityReceipt(left, right);
}

function checkpointPublicationForReceipt(authorityRecord, slot, digest, expectedReceipt) {
  const candidates = [authorityRecord?.publications?.[slot], authorityRecord?.pendingPublications?.[slot]];
  return candidates.some(candidate => candidate?.digest === digest
    && sameAuthorityReceipt(candidate?.receipt, expectedReceipt));
}

function checkpointMatchesRun(snapshot, { canvasFilePath, nodeId, runId, careerSnapshotId } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const snapshotCanvas = typeof snapshot.canvasFilePath === 'string' ? resolvedCanvasPath(snapshot.canvasFilePath) : null;
  return snapshotCanvas === resolvedCanvasPath(canvasFilePath)
    && snapshot.sourceHubId === nodeId
    && snapshot.nodeId === nodeId
    && snapshot.runId === runId
    && snapshot.careerSnapshotId === careerSnapshotId;
}

async function writeCheckpointAtomically(filePath, snapshot) {
  // The checkpoint envelope is intentionally retained as parsed. Newer
  // checkpoint writers put reportMetadata first, and JSON preserves that key
  // insertion order when we only replace the authority receipt below.
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await fs.promises.rename(temporary, filePath);
    const directory = await fs.promises.open(path.dirname(filePath), 'r').catch(() => null);
    if (directory) {
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await fs.promises.unlink(temporary).catch(() => {}); }
}

/**
 * Read one exact checkpoint through a regular, no-follow descriptor. The
 * checkpoint directory sits beside the canvas and must be treated as hostile:
 * a pathname lstat followed by readFile would allow a swap to a symlink/FIFO
 * or an arbitrary large file. Read only the fstat-bounded descriptor and
 * reject truncation/replacement-style short reads fail-closed.
 */
async function readBoundedRegularRunCheckpoint(filePath) {
  const noFollow = fs.constants?.O_NOFOLLOW;
  const nonBlocking = fs.constants?.O_NONBLOCK;
  if (!Number.isInteger(noFollow) || !Number.isInteger(nonBlocking)) {
    return { errorCode: 'UNSAFE_FILE' };
  }
  let handle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
    const before = await handle.stat();
    if (!before.isFile()) return { errorCode: 'UNSAFE_FILE' };
    const size = Math.max(0, Number(before.size) || 0);
    if (size > MAX_DESCRIPTION_RECOVERY_CHECKPOINT_ADOPTION_BYTES) return { errorCode: 'TOO_LARGE' };
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (!bytesRead) return { errorCode: 'UNSAFE_FILE' };
      offset += bytesRead;
    }
    const after = await handle.stat();
    // The descriptor itself cannot be redirected after O_NOFOLLOW open, but
    // a concurrent truncate/write must not give adoption a partial or stale
    // byte sequence. Stable dev/ino/size makes the digest below meaningful.
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      return { errorCode: 'UNSAFE_FILE' };
    }
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) };
  } catch (error) {
    return { errorCode: error?.code === 'ENOENT' ? 'MISSING' : 'UNSAFE_FILE' };
  } finally { await handle?.close().catch(() => {}); }
}

/**
 * Re-stamp the optional Solve checkpoint as part of the same authority
 * transaction that adopts the manifest.  A checkpoint is not merely a
 * run-keyed file: it must be the exact sealed predecessor artifact.  The
 * write is deliberately checkpoint-first. If power fails before the manifest
 * rename, replay sees a S2-stamped sealed checkpoint plus S1 manifest and
 * deterministically completes the one legal S1 -> S2 adoption.
 */
async function adoptRunCheckpoint({
  canvasFilePath, expectedNodeId, expectedRunId, careerSnapshotId,
  currentAuthorityRecord, currentAuthority, predecessorAuthority, stagePublication,
} = {}) {
  const checkpointPath = getJobDescriptionRecoveryCheckpointPath(canvasFilePath, expectedRunId, null);
  if (!checkpointPath) return { ok: false, reason: 'checkpoint-path-invalid' };
  const read = await readBoundedRegularRunCheckpoint(checkpointPath);
  if (read.errorCode === 'MISSING') return { ok: true, absent: true };
  if (read.errorCode) return { ok: false, reason: 'checkpoint-invalid' };
  const serialized = read.text;
  let checkpoint;
  try { checkpoint = JSON.parse(serialized); }
  catch { return { ok: false, reason: 'checkpoint-invalid' }; }
  if (!checkpointMatchesRun(checkpoint, {
    canvasFilePath, nodeId: expectedNodeId, runId: expectedRunId, careerSnapshotId,
  })) return { ok: false, reason: 'checkpoint-mismatch' };

  const slotToken = path.basename(checkpointPath).match(/description-recovery-([a-f0-9]{24})\.json$/)?.[1];
  if (!slotToken) return { ok: false, reason: 'checkpoint-path-invalid' };
  const slot = `checkpoint:${slotToken}`;
  const actualAuthority = jobAnalysisOperationAuthorityReceipt(checkpoint.operationAuthority
    ?? checkpoint.snapshotContext?.operationAuthority);
  const digest = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');

  if (sameAuthorityReceipt(actualAuthority, currentAuthority)) {
    if (!checkpointPublicationForReceipt(currentAuthorityRecord, slot, digest, currentAuthority)) {
      return { ok: false, reason: 'checkpoint-unsealed' };
    }
    return { ok: true, idempotent: true };
  }
  if (!sameAuthorityReceipt(actualAuthority, predecessorAuthority)
    || !checkpointPublicationForReceipt(currentAuthorityRecord, slot, digest, predecessorAuthority)) {
    return { ok: false, reason: 'checkpoint-predecessor-mismatch' };
  }

  // Preserve every evidence field verbatim; only the host-issued capability
  // changes. A legacy nested receipt is updated too when present, preventing
  // a future reader from selecting an old fallback field after S2 adoption.
  checkpoint.operationAuthority = currentAuthority;
  if (checkpoint.snapshotContext && typeof checkpoint.snapshotContext === 'object'
    && !Array.isArray(checkpoint.snapshotContext)
    && Object.hasOwn(checkpoint.snapshotContext, 'operationAuthority')) {
    checkpoint.snapshotContext = { ...checkpoint.snapshotContext, operationAuthority: currentAuthority };
  }
  const rewritten = `${JSON.stringify(checkpoint, null, 2)}\n`;
  await stagePublication({ publications: [{ slot, digest: crypto.createHash('sha256').update(rewritten, 'utf8').digest('hex') }] });
  await writeCheckpointAtomically(checkpointPath, checkpoint);
  return { ok: true, adopted: true };
}

/**
 * Atomically adopt one immediate host-authorized resume receipt into an exact
 * manifest and its optional sealed Solve checkpoint. This function owns the
 * authority transaction; callers must not wrap it in `withCurrent...`, or a
 * rebind would self-deadlock on the per-hub durable authority lock. A manifest
 * from S1 can move to S2 only when S2 names S1 as predecessor; S3 therefore
 * cannot skip S2 and rebind S1 directly.
 */
export async function rebindRunOperationAuthority(canvasFilePath, {
  expectedRunId, expectedNodeId, careerSnapshotId, currentAuthority, predecessorAuthority,
} = {}) {
  const files = runFilesForCanvas(canvasFilePath, expectedNodeId);
  const authority = jobAnalysisOperationAuthorityReceipt(currentAuthority);
  const predecessor = jobAnalysisOperationAuthorityReceipt(predecessorAuthority);
  if (!files || !expectedRunId || !expectedNodeId || !normalizeCareerSnapshotId(careerSnapshotId) || !authority
    || (predecessorAuthority != null && !predecessor)) {
    return { ok: false, reason: 'invalid-rebind-request' };
  }
  // A receipt is not interchangeable merely because it currently owns this
  // hub. Resume adoption is bound to the exact immutable career corpus and
  // durable scrape run. Check both sides before taking any authority/artifact
  // lock, so a forged receipt cannot use a same-hub manifest as an oracle.
  // A newly-started renderer operation is claimed before the main process
  // allocates the durable run id.  Its S1 receipt therefore legitimately has
  // `runId: null`; startRun binds that exact receipt into the sealed manifest.
  // Permit that one narrow bridge on the predecessor only.  The current
  // resume receipt must already name the allocated run, and the manifest
  // comparison below must prove the null-run predecessor is the exact
  // receipt that owns this node/career/run tuple.  Never coerce or accept a
  // different non-null predecessor run id.
  const predecessorRunMatches = predecessor
    && (predecessor.semanticBase?.runId === expectedRunId
      || predecessor.semanticBase?.runId === null);
  if (authority.semanticBase?.careerSnapshotId !== careerSnapshotId
    || authority.semanticBase?.runId !== expectedRunId
    || (predecessor && (predecessor.semanticBase?.careerSnapshotId !== careerSnapshotId
      || !predecessorRunMatches))) {
    return { ok: false, reason: 'authority-semantic-mismatch' };
  }
  const admission = await withCurrentJobAnalysisOperationAuthority({
    canvasFilePath, hubId: expectedNodeId, ...authority,
  }, async (currentAuthorityRecord, stagePublication) => {
    // Re-check the explicit predecessor under the exact S2 lock. The claim
    // helper validates this at admission, but this also rejects a forged
    // direct caller and makes the S1->S3 skip rule local to the rebind.
    const immediatePredecessor = predecessor || currentAuthorityRecord.predecessor;
    if (!immediatePredecessor || (predecessor && !sameAuthorityReceipt(currentAuthorityRecord.predecessor, predecessor))) {
      return { ok: false, reason: 'authority-predecessor-mismatch' };
    }
    const immediatePredecessorRunMatches = immediatePredecessor.semanticBase?.runId === expectedRunId
      || immediatePredecessor.semanticBase?.runId === null;
    if (immediatePredecessor.semanticBase?.careerSnapshotId !== careerSnapshotId
      || !immediatePredecessorRunMatches) {
      return { ok: false, reason: 'authority-semantic-mismatch' };
    }
    return withManifestLock(files.manifest, async () => {
      const manifest = await readManifestFromFiles(files);
      if (!manifest || manifest.runId !== expectedRunId || manifest.inputs?.nodeId !== expectedNodeId
        || manifest.inputs?.careerSnapshotId !== careerSnapshotId) return { ok: false, reason: 'manifest-mismatch' };
      const recorded = manifest.inputs?.operationAuthority;
      // When callers omit the optional predecessor argument, the durable S2
      // record is still the authoritative immediate predecessor. Compare the
      // manifest against that resolved receipt—not the null optional input.
      if (!sameAuthorityReceipt(recorded, authority) && !sameAuthorityReceipt(recorded, immediatePredecessor)) {
        return { ok: false, reason: 'manifest-predecessor-mismatch' };
      }
      const checkpoint = await adoptRunCheckpoint({
        canvasFilePath, expectedNodeId, expectedRunId, careerSnapshotId,
        currentAuthorityRecord, currentAuthority: authority, predecessorAuthority: immediatePredecessor, stagePublication,
      });
      if (!checkpoint.ok) return checkpoint;
      if (sameAuthorityReceipt(recorded, authority)) return { ok: true, idempotent: true, checkpoint, manifest };
      manifest.inputs = { ...manifest.inputs, operationAuthority: authority };
      await atomicWriteJson(files.manifest, manifest);
      return { ok: true, rebound: true, checkpoint, manifest };
    });
  });
  return admission.admitted ? admission.value : { ok: false, reason: admission.reason || 'operation-superseded' };
}

/**
 * Provider/staging mutations are an authority→manifest transaction.  The
 * preliminary manifest read only discovers the compact receipt; the receipt
 * is checked again under the manifest lock while the authority lock is held,
 * so an S2 claim or manifest rebind cannot admit a late S1 provider result.
 */
async function withLiveManifestOperationAuthority(canvasFilePath, files, nodeId, expectedRunId, expectedOperationAuthority, write, { __testOnlyAllowUnpinned = false } = {}) {
  const observed = await readManifestFromFiles(files);
  // This capability belongs to the provider callback that initiated this
  // mutation. Never read it from a mutable replacement manifest: doing so
  // would let delayed S1 work borrow S2's receipt after a rebind.
  const authority = jobAnalysisOperationAuthorityReceipt(expectedOperationAuthority);
  const owner = normalizeNodeId(nodeId) || normalizeNodeId(observed?.inputs?.nodeId);
  // This private branch is only reached by the deterministic test dependency
  // adapter. It exists to retain fixtures for pre-authority sidecars without
  // teaching any production IPC how to mutate an unpinned manifest.
  if (__testOnlyAllowUnpinned
    && observed?.inputs?.careerSnapshotId == null
    && observed?.inputs?.operationAuthority == null) {
    return withManifestLock(files.manifest, async () => {
      const manifest = await readManifestFromFiles(files);
      if (!manifest || (expectedRunId != null && manifest.runId !== expectedRunId)
        || (owner && normalizeNodeId(manifest.inputs?.nodeId) !== owner)
        || manifest.inputs?.careerSnapshotId != null || manifest.inputs?.operationAuthority != null) return false;
      return write(manifest);
    });
  }
  if (!authority || !owner || !sameOperationAuthorityReceipt(observed?.inputs?.operationAuthority, authority)) return false;
  const admission = await withCurrentJobAnalysisOperationAuthority({
    canvasFilePath, hubId: owner, ...authority,
  }, () => withManifestLock(files.manifest, async () => {
    const manifest = await readManifestFromFiles(files);
    if (!manifest || (expectedRunId != null && manifest.runId !== expectedRunId)
      || normalizeNodeId(manifest.inputs?.nodeId) !== owner
      || !sameOperationAuthorityReceipt(manifest.inputs?.operationAuthority, authority)) return false;
    return write(manifest);
  }));
  return admission.admitted ? admission.value : false;
}

/**
 * Flush one page's raw jobs to staging and bump the (source,query) ledger.
 * `now` is the caller-stamped timestamp. `expectedRunId` makes late work from
 * a cancelled predecessor a no-op after a fresh run has replaced the manifest.
 * No-op when there is no canvas/manifest.
 */
async function recordSourcePageRaw(canvasFilePath, { sourceId, query = '', queryIndex = null, page = 0, jobs = [], terminal = false, now, expectedRunId = null, nodeId = null, expectedOperationAuthority = null, __testOnlyAllowUnpinned = false }) {
  const located = await locateRun(canvasFilePath, nodeId);
  const { files } = located;
  if (!files) return;
  return withLiveManifestOperationAuthority(canvasFilePath, files, nodeId, expectedRunId, expectedOperationAuthority, async manifest => {
    try {
      // Check the token BEFORE appending: a manifest write is atomic, whereas
      // staging is append-only and cannot be rolled back after an old run has
      // leaked rows into its successor's file.
      if (Array.isArray(jobs) && jobs.length > 0) {
        const lines = jobs.map(j => JSON.stringify({ sourceId, query, page, job: j })).join('\n') + '\n';
        // Never advance the manifest page cursor until the staged rows have
        // reached the filesystem. A crash may leave extra rows (dedup handles
        // that), but it must not claim a page whose rows were never durable.
        await appendStagingDurably(files.staging, lines);
      }
      const src = manifest.sources[sourceId] || (manifest.sources[sourceId] = { status: 'pending', queries: {} });
      // Persist by query position, not query text: duplicated role phrases are
      // separate planned work and must not steal each other's resume cursor.
      // Read compatibility remains in computeResumeStartPagesByQuery below.
      const queryKey = Number.isSafeInteger(queryIndex) && queryIndex >= 0 ? `#${queryIndex}` : query;
      const q = src.queries[queryKey] || (src.queries[queryKey] = { lastPage: -1 });
      q.lastPage = Math.max(q.lastPage ?? -1, page);
      if (terminal === true) q.terminal = true;
      manifest.lastUpdated = now ?? manifest.lastUpdated;
      await atomicWriteJson(files.manifest, manifest);
      return true;
    } catch (e) {
      // The caller treats this falsey result as a source failure.  Do not throw
      // here because this boundary is also used by best-effort enrichment paths.
      logger.warn(`[JobRunStaging] recordSourcePage(${sourceId}) failed: ${e?.message || e}`);
    }
  }, { __testOnlyAllowUnpinned });
}

/** Set a source's terminal status ('done' | 'skipped' | 'blocked') for the expected run. */
async function markSourceStatusRaw(canvasFilePath, sourceId, status, now, {
  expectedRunId = null,
  nodeId = null,
  expectedOperationAuthority = null,
  __testOnlyAllowUnpinned = false,
  // Omitted preserves older/source-only status writes. A supplied value is
  // normalized at this durable boundary so recovery never trusts provider data.
  collectionScopeCaveats = undefined,
  // `manual` means this unfinished source needs a human action (login/CAPTCHA/
  // native challenge) and must not open a visible browser during app startup.
  // `automatic` positively identifies a safe unattended retry. Explicit null
  // clears an earlier gate after a terminal transition; omission preserves a
  // legacy blocked row, which automatic eligibility treats as manual/fail-safe.
  recoveryDisposition = undefined,
} = {}) {
  const located = await locateRun(canvasFilePath, nodeId);
  const { files } = located;
  if (!files) return;
  return withLiveManifestOperationAuthority(canvasFilePath, files, nodeId, expectedRunId, expectedOperationAuthority, async manifest => {
    const src = manifest.sources[sourceId] || (manifest.sources[sourceId] = { status: 'pending', queries: {} });
    src.status = status;
    if (status === 'done' || status === 'skipped') {
      delete src.recoveryDisposition;
    } else if (recoveryDisposition !== undefined) {
      const normalizedRecovery = normalizeJobRunRecoveryDisposition(recoveryDisposition);
      if (normalizedRecovery) src.recoveryDisposition = normalizedRecovery;
      else delete src.recoveryDisposition;
    }
    if (collectionScopeCaveats !== undefined) {
      src.collectionScopeCaveats = normalizeCollectionScopeCaveats(collectionScopeCaveats);
    }
    manifest.lastUpdated = now ?? manifest.lastUpdated;
    try { await atomicWriteJson(files.manifest, manifest); return true; }
    catch (e) { logger.warn(`[JobRunStaging] markSourceStatus failed: ${e?.message || e}`); }
  }, { __testOnlyAllowUnpinned });
}

/** Advance the pipeline stage ('searching'→'gathered'; see the header). */
async function setStageRaw(canvasFilePath, stage, now, {
  expectedRunId = null,
  nodeId = null,
  expectedOperationAuthority = null,
  __testOnlyAllowUnpinned = false,
  collectionCompletedAt = null,
} = {}) {
  const located = await locateRun(canvasFilePath, nodeId);
  const { files } = located;
  if (!files) return;
  return withLiveManifestOperationAuthority(canvasFilePath, files, nodeId, expectedRunId, expectedOperationAuthority, async manifest => {
    // A deliberate partial finish is an irreversible collection decision for
    // this run.  Never let a later/general resume caller quietly demote the
    // manifest back to `searching`: a crash after that demotion would make the
    // durable marker fail its gathered-stage predicate and re-open provider
    // collection. Returning success keeps this a safe no-op for old callers.
    if (stage === 'searching' && isRunCollectionFinishedWithSavedListings(manifest)) {
      return true;
    }
    // The first gathered boundary is immutable for this run. A gathered-only
    // recovery may happen on a later calendar date; moving this timestamp to
    // the resume time would let the next scan skip postings created between
    // the original gather and the resume. For a pre-field manifest, preserve
    // its gathered `lastUpdated` before refreshing that liveness timestamp.
    if (stage === 'gathered' && manifestTimestamp(manifest.collectionCompletedAt) == null) {
      const firstGatheredAt = manifestTimestamp(collectionCompletedAt)
        ?? collectionCompletedAtForManifest(manifest)
        ?? manifestTimestamp(now);
      if (firstGatheredAt != null) manifest.collectionCompletedAt = firstGatheredAt;
    }
    manifest.stage = stage;
    manifest.lastUpdated = now ?? manifest.lastUpdated;
    try { await atomicWriteJson(files.manifest, manifest); return true; }
    catch (e) { logger.warn(`[JobRunStaging] setStage failed: ${e?.message || e}`); }
  }, { __testOnlyAllowUnpinned });
}

/** Mark the one-way provider-I/O boundary without claiming semantic processing is complete. */
async function markProviderGatheredRaw(canvasFilePath, now, {
  expectedRunId = null,
  nodeId = null,
  expectedOperationAuthority = null,
  __testOnlyAllowUnpinned = false,
  requiredSourceIds = [],
} = {}) {
  const located = await locateRun(canvasFilePath, nodeId);
  const { files } = located;
  if (!files) return false;
  return withLiveManifestOperationAuthority(canvasFilePath, files, nodeId, expectedRunId, expectedOperationAuthority, async manifest => {
    const terminal = new Set(['done', 'skipped', 'blocked']);
    const sourceIds = Array.isArray(requiredSourceIds)
      ? requiredSourceIds.filter(id => typeof id === 'string' && id)
      : [];
    if (!sourceIds.every(id => terminal.has(manifest.sources?.[id]?.status))) return false;
    if (providerGatheredAtForManifest(manifest) == null) {
      const timestamp = manifestTimestamp(now);
      if (timestamp == null) return false;
      manifest.providerGatheredAt = timestamp;
    }
    manifest.lastUpdated = now ?? manifest.lastUpdated;
    try { await atomicWriteJson(files.manifest, manifest); return true; }
    catch (error) { logger.warn(`[JobRunStaging] markProviderGathered failed: ${error?.message || error}`); return false; }
  }, { __testOnlyAllowUnpinned });
}

/**
 * Persist an explicit Stop without discarding this run's staged rows.  Both
 * coordinates are mandatory and compared under the manifest mutex, so a late
 * cancellation acknowledgement can never pause a replacement generation.
 */
async function pauseRunForManualResumeRaw(canvasFilePath, {
  expectedRunId = null,
  nodeId = null,
  now = null,
} = {}) {
  const expectedRunToken = typeof expectedRunId === 'string' && expectedRunId.trim()
    ? expectedRunId.trim()
    : null;
  const expectedNodeId = normalizeNodeId(nodeId);
  if (!expectedRunToken || !expectedNodeId || manifestTimestamp(now) == null) {
    return { ok: false, paused: false, reason: 'missing-ownership' };
  }
  const located = await locateRun(canvasFilePath, expectedNodeId);
  const { files } = located;
  if (!files) return { ok: false, paused: false, absent: true, reason: 'missing-canvas' };
  return withManifestLock(files.manifest, async () => {
    const manifest = await readManifestFromFiles(files);
    if (!manifest) return { ok: false, paused: false, absent: true, reason: 'run-absent' };
    if (
      manifest.runId !== expectedRunToken
      || normalizeNodeId(manifest.inputs?.nodeId) !== expectedNodeId
    ) {
      return { ok: false, paused: false, tokenMismatch: true, reason: 'ownership-mismatch' };
    }
    manifest.recoveryDisposition = JOB_RUN_RECOVERY_DISPOSITION.MANUAL;
    manifest.lastUpdated = now;
    try {
      await atomicWriteJson(files.manifest, manifest);
      return { ok: true, paused: true, runId: manifest.runId };
    } catch (error) {
      logger.warn(`[JobRunStaging] pauseRunForManualResume failed: ${error?.message || error}`);
      return { ok: false, paused: false, reason: 'write-failed' };
    }
  });
}

/**
 * An exact Resume click/auto-claim re-arms crash recovery before any provider
 * or scoring work begins.  If that continuation is interrupted again, its
 * unchanged manifest will therefore launch automatically on the next start.
 */
async function activateRunForResumeRaw(canvasFilePath, {
  expectedRunId = null,
  nodeId = null,
  expectedOperationAuthority = null,
  __testOnlyAllowUnpinned = false,
  now = null,
} = {}) {
  const expectedRunToken = typeof expectedRunId === 'string' && expectedRunId.trim()
    ? expectedRunId.trim()
    : null;
  const expectedNodeId = normalizeNodeId(nodeId);
  if (!expectedRunToken || !expectedNodeId || manifestTimestamp(now) == null) {
    return { ok: false, activated: false, reason: 'missing-ownership' };
  }
  const located = await locateRun(canvasFilePath, expectedNodeId);
  const { files } = located;
  if (!files) return { ok: false, activated: false, absent: true, reason: 'missing-canvas' };
  // Report an already-replaced run as an ownership mismatch before attempting
  // authority admission. This read makes no mutation; the authoritative
  // receipt is still rechecked under the write lock below.
  const observed = await readManifestFromFiles(files);
  if (observed && (observed.runId !== expectedRunToken
    || normalizeNodeId(observed.inputs?.nodeId) !== expectedNodeId)) {
    return { ok: false, activated: false, tokenMismatch: true, reason: 'ownership-mismatch' };
  }
  return withLiveManifestOperationAuthority(canvasFilePath, files, expectedNodeId, expectedRunToken, expectedOperationAuthority, async manifest => {
    if (
      manifest.runId !== expectedRunToken
      || normalizeNodeId(manifest.inputs?.nodeId) !== expectedNodeId
    ) {
      return { ok: false, activated: false, tokenMismatch: true, reason: 'ownership-mismatch' };
    }
    delete manifest.recoveryDisposition;
    // A click on this exact Resume control is the user's consent to retry any
    // human-gated source in the run. Re-arm crash recovery before dispatch;
    // if it reaches the same gate again, markSourceStatus writes it manual
    // again, so a later restart still never auto-opens an interactive window.
    for (const source of Object.values(manifest.sources || {})) {
      if (!source || typeof source !== 'object') continue;
      if (source.status === 'blocked') {
        source.recoveryDisposition = JOB_RUN_RECOVERY_DISPOSITION.AUTOMATIC;
      } else {
        delete source.recoveryDisposition;
      }
    }
    manifest.lastUpdated = now;
    try {
      await atomicWriteJson(files.manifest, manifest);
      return { ok: true, activated: true, runId: manifest.runId };
    } catch (error) {
      logger.warn(`[JobRunStaging] activateRunForResume failed: ${error?.message || error}`);
      return { ok: false, activated: false, reason: 'write-failed' };
    }
  }, { __testOnlyAllowUnpinned });
}

/**
 * Durably record the user's explicit choice to stop provider collection and
 * continue only with the rows already staged.  This is deliberately a single
 * manifest-lock transaction: writing the marker before renderer-side role
 * screening/scoring means a crash during either step cannot turn the next
 * Resume into another provider scrape.
 *
 * Existing source statuses are left untouched. `pending`/`blocked` remains a
 * truthful record of work that was not completed, while the fixed disposition
 * tells exact recovery to process the saved ledger without dispatching it.
 */
async function finishRunWithSavedListingsRaw(canvasFilePath, {
  expectedRunId = null,
  nodeId = null,
  expectedOperationAuthority = null,
  now = null,
} = {}) {
  const expectedRunToken = typeof expectedRunId === 'string' && expectedRunId.trim()
    ? expectedRunId.trim()
    : null;
  const expectedNodeId = normalizeNodeId(nodeId);
  // This is a recovery action, never a best-effort generic manifest edit. A
  // delayed banner click without both ownership coordinates must fail closed.
  if (!expectedRunToken || !expectedNodeId) {
    return { ok: false, marked: false, missingOwnership: true, reason: 'missing-ownership' };
  }
  const stoppedAt = manifestTimestamp(now);
  if (stoppedAt == null) {
    return { ok: false, marked: false, invalidTimestamp: true, reason: 'invalid-stop-time' };
  }
  const located = await locateRun(canvasFilePath, nodeId);
  const { files } = located;
  if (!files) return { ok: false, marked: false, absent: true, reason: 'missing-canvas' };
  return withLiveManifestOperationAuthority(canvasFilePath, files, expectedNodeId, expectedRunToken, expectedOperationAuthority, async manifest => {
    if (
      manifest.runId !== expectedRunToken
      || normalizeNodeId(manifest.inputs?.nodeId) !== expectedNodeId
    ) {
      return { ok: false, marked: false, tokenMismatch: true, reason: 'ownership-mismatch' };
    }
    // The action is idempotent.  Preserve the first explicit collection
    // boundary so retries cannot move the next-run coverage anchor forward.
    const alreadyFinished = isRunCollectionFinishedWithSavedListings(manifest);
    const sourceEntries = Object.entries(manifest.sources || {});
    const sourceIsTerminal = source => source?.status === 'done' || source?.status === 'skipped';
    const alreadyFullyGathered = manifest.stage === 'gathered'
      && sourceEntries.length > 0
      && sourceEntries.every(([, source]) => sourceIsTerminal(source));
    // An already clean gathered checkpoint already has the normal no-network
    // recovery path. Do not relabel it as a deliberately partial collection.
    if (alreadyFullyGathered && !alreadyFinished) {
      return {
        ok: true,
        marked: false,
        alreadyGathered: true,
        runId: manifest.runId || null,
        collectionDisposition: null,
        collectionCompletedAt: collectionCompletedAtForManifest(manifest),
        unfinishedSourceIds: [],
      };
    }
    const existingBoundary = collectionCompletedAtForManifest(manifest);
    manifest.stage = 'gathered';
    manifest.collectionDisposition = JOB_RUN_COLLECTION_DISPOSITION.USER_FINISHED_PARTIAL;
    if (manifestTimestamp(manifest.collectionCompletedAt) == null) {
      manifest.collectionCompletedAt = existingBoundary ?? stoppedAt;
    }
    manifest.lastUpdated = stoppedAt;
    try {
      await atomicWriteJson(files.manifest, manifest);
      const unfinishedSourceIds = sourceEntries
        .filter(([, source]) => !sourceIsTerminal(source))
        .map(([sourceId]) => sourceId)
        .slice(0, 32);
      return {
        ok: true,
        marked: !alreadyFinished,
        runId: manifest.runId || null,
        collectionDisposition: manifest.collectionDisposition,
        collectionCompletedAt: manifest.collectionCompletedAt,
        unfinishedSourceIds,
      };
    } catch (error) {
      logger.warn(`[JobRunStaging] finishRunWithSavedListings failed: ${error?.message || error}`);
      return { ok: false, marked: false, reason: 'write-failed' };
    }
  });
}

/** Parse one resolved staging JSONL, skipping torn/garbage lines. */
async function readStagedJobsFromFiles(files) {
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

/** Parse the staging JSONL, skipping any torn/garbage lines. Returns [] on miss. */
async function readStagedJobsRaw(canvasFilePath, nodeIdOrOptions = null) {
  const { files } = await locateRun(canvasFilePath, nodeIdOrOptions);
  return readStagedJobsFromFiles(files);
}

/**
 * Read the full run state for resume detection. Returns null when there is no
 * (parseable) manifest. `resumable` is the historical <=24h freshness signal
 * retained for diagnostics/UI only; callers must surface and recover older
 * exact manifests too.
 */
async function readRunStateRaw(canvasFilePath, now = null, nodeIdOrOptions = null) {
  const located = await locateRun(canvasFilePath, nodeIdOrOptions);
  const { manifest } = located;
  if (!manifest) return null;
  // A manifest on disk IS an unfinished run — clean finishes delete the
  // sidecars (see header). `incomplete` is kept on the return shape for the
  // renderer's peek payload rather than re-derived at every consumer.
  const incomplete = true;
  const ageMs = (typeof now === 'number' && typeof manifest.lastUpdated === 'number')
    ? now - manifest.lastUpdated
    : null;
  const recent = ageMs == null ? true : ageMs <= RESUMABLE_MAX_AGE_MS;
  // Reuse the exact ledger locateRun selected. Re-locating by its nullable
  // `files.nodeId` would make an owned legacy manifest accidentally read the
  // sole modern hub's staging file during a migration.
  const stagedJobs = await readStagedJobsFromFiles(located.files);
  return { manifest, stagedJobs, incomplete, ageMs, resumable: incomplete && recent, legacy: located.legacy === true };
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
 * Return an index-aligned resume plan for every exact query. `durable` is
 * intentionally separate from `startPage`: an unstarted query falls back to
 * page 1, while a Google one-view query whose page 1 is durable must be
 * skipped. Older manifests used text keys; use those only as a read fallback.
 */
export function computeResumeStartPagesByQuery(sourceLedger, queries) {
  const queryList = Array.isArray(queries) ? queries : [];
  const stored = sourceLedger?.queries && typeof sourceLedger.queries === 'object'
    ? sourceLedger.queries
    : {};
  const occurrences = new Map();
  for (const query of queryList) {
    if (typeof query === 'string' && query) occurrences.set(query, (occurrences.get(query) || 0) + 1);
  }
  return queryList.map((query, index) => {
    const indexed = stored[`#${index}`];
    // A legacy text key cannot distinguish repeated query slots. Treat it as
    // absent in that case: replay is safe; skipping an unstarted duplicate is
    // not. Indexed records above remain exact.
    const legacy = typeof query === 'string' && query && occurrences.get(query) === 1 ? stored[query] : null;
    const lastPage = Number((indexed || legacy)?.lastPage);
    const durable = Number.isSafeInteger(lastPage) && lastPage >= 1;
    return { startPage: durable ? lastPage + 1 : 1, durable, terminal: (indexed || legacy)?.terminal === true };
  });
}

/**
 * Remove both sidecars.
 *
 * @param {string} canvasFilePath
 * @param {object} [opts]
 * @param {(path:string)=>Promise<void>} [opts.trashItem] - When provided (e.g.
 *   electron `shell.trashItem`), move the sidecars to the OS Trash instead of
 *   hard-deleting, so an explicit Clear career data action is recoverable. A clean finish
 *   passes nothing and hard-deletes — there's nothing to recover, and trashing a
 *   sidecar on every successful run would steadily clutter the Trash. The
 *   function is INJECTED, not imported, so this module stays electron-free and
 *   unit-testable in the plain-node runner.
 */
async function clearRunWithResultRaw(canvasFilePath, { trashItem = null, expectedRunId = null, expectedNodeId = null, expectedOwnerUnknown = false } = {}) {
  const located = await locateRun(canvasFilePath, expectedNodeId);
  const { files } = located;
  if (!files) return { ok: true, cleared: false, absent: true, reason: 'missing-canvas' };
  return withManifestLock(files.manifest, async () => {
    // Completion is renderer-driven and may arrive after the user has already
    // started another search on this canvas. Compare under the same manifest
    // lock as startRun so an old completion can never delete a newer run.
    if (expectedRunId != null || expectedNodeId != null || expectedOwnerUnknown) {
      const manifest = await readManifestFromFiles(files);
      if (!manifest) return { ok: true, cleared: false, absent: true, reason: 'run-absent' };
      if ((expectedRunId != null && manifest.runId !== expectedRunId)
        || (expectedNodeId != null && manifest.inputs?.nodeId !== expectedNodeId)
        || (expectedOwnerUnknown && manifest.inputs?.nodeId)) {
        return { ok: true, cleared: false, tokenMismatch: true, reason: 'ownership-mismatch' };
      }
    }
    const cleared = await clearRunFiles(files, trashItem);
    return {
      ok: cleared,
      cleared,
      reason: cleared ? null : 'cleanup-failed',
    };
  });
}

async function clearRunRaw(canvasFilePath, options = {}) {
  const result = await clearRunWithResult(canvasFilePath, options);
  return result.cleared === true;
}

async function clearRunFiles(files, trashItem = null) {
  const removeAndVerify = async (p) => {
    // Skip a sidecar that isn't there (a run may have only one, or it was
    // already cleared) so trashItem doesn't error on a missing path.
    try {
      await fs.promises.access(p);
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      // An access failure does not prove absence. Keep the aggregate cleanup
      // verdict false rather than issuing a terminal receipt that claims an
      // unreadable or temporarily unavailable sidecar was removed.
      logger.warn(`[JobRunStaging] Could not inspect ${p} before cleanup: ${error?.message || error}`);
      return false;
    }
    if (trashItem) {
      try {
        await trashItem(p);
      } catch (err) {
        // trashItem can fail on volumes without a Trash (network / exFAT). Fall
        // back to a hard delete so Clear career data still clears the run rather
        // than leaving a stale resumable manifest behind.
        logger.warn(`[JobRunStaging] trashItem failed for ${p} (${err?.message || err}); hard-deleting instead`);
        try { await fs.promises.unlink(p); } catch { /* verified below */ }
      }
    } else {
      try { await fs.promises.unlink(p); } catch { /* verified below */ }
    }
    try {
      await fs.promises.access(p);
      return false;
    } catch (error) {
      // Only a definite missing-path result verifies deletion. Permission,
      // device, and other I/O failures leave cleanup unconfirmed.
      if (error?.code !== 'ENOENT') {
        logger.warn(`[JobRunStaging] Could not verify cleanup of ${p}: ${error?.message || error}`);
        return false;
      }
      return true;
    }
  };

  // The manifest is the discoverability/ownership record for the staged rows.
  // Never remove it while staging still exists: doing so leaves private job data
  // orphaned and makes an exact cleanup retry impossible. Deleting staging first
  // can still leave a manifest-only partial state, but that state is safe and
  // intentionally finalized by retrying the exact terminal receipt.
  const stagingCleared = await removeAndVerify(files.staging);
  if (!stagingCleared) return false;
  return removeAndVerify(files.manifest);
}

/**
 * Atomically records a redacted terminal receipt before removing recovery
 * sidecars, then records the actual cleanup outcome. The manifest token is
 * checked under the same lock as startRun/clearRun, so a delayed completion from
 * an older hub run cannot overwrite a newer run's receipt or delete its files.
 */
async function completeRunWithReceiptRaw(canvasFilePath, receipt, { trashItem = null, expectedNodeId = null, expectedCareerSnapshotId = null, __testOnlyAllowUnpinned = false } = {}) {
  const located = await locateRun(canvasFilePath, expectedNodeId || receipt?.nodeId || null);
  const { files } = located;
  const receiptPath = lastRunReceiptPathForCanvas(canvasFilePath, files?.nodeId);
  const expectedRunId = String(receipt?.runId || '');
  if (!files || !receiptPath || !expectedRunId) {
    return { ok: false, cleared: false, receipt: null, reason: 'missing-canvas-or-run-token' };
  }
  return withManifestLock(files.manifest, async () => withReceiptLock(receiptPath, async () => {
    const manifest = await readManifestFromFiles(files);
    let existingReceipt = null;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existingReceipt = sanitizeLastRunReceipt(parsed);
      }
    } catch { /* a first completion legitimately has no prior receipt */ }
    const expectedOwner = normalizeNodeId(expectedNodeId || receipt?.nodeId);
    const exactExistingReceipt = !!existingReceipt?.runId
      && existingReceipt.runId === expectedRunId
      && (!expectedOwner || normalizeNodeId(existingReceipt.nodeId) === expectedOwner);

    if (manifest && (
      manifest.runId !== expectedRunId
      || (expectedOwner != null && normalizeNodeId(manifest.inputs?.nodeId) !== expectedOwner)
    )) {
      return { ok: false, cleared: false, receipt: null, tokenMismatch: true };
    }
    // Compare immutable career authority under this exact manifest lock, before
    // a delayed terminal callback can create a receipt or delete sidecars.
    const suppliedCareerSnapshotId = normalizeCareerSnapshotId(expectedCareerSnapshotId);
    const persistedCareerSnapshotId = normalizeCareerSnapshotId(manifest?.inputs?.careerSnapshotId);
    if (manifest) {
      const legacyFixture = __testOnlyAllowUnpinned
        && manifest.inputs?.careerSnapshotId == null
        && manifest.inputs?.operationAuthority == null;
      if (!persistedCareerSnapshotId && !legacyFixture) {
        return { ok: false, cleared: false, receipt: null, careerSnapshotMissing: true };
      }
      if (!legacyFixture && (!suppliedCareerSnapshotId || suppliedCareerSnapshotId !== persistedCareerSnapshotId)) {
        return { ok: false, cleared: false, receipt: null, careerSnapshotMismatch: true };
      }
    }

    // A receipt-only retry occurs after a prior exact terminal transaction
    // removed its sidecars. Keep that idempotence, but bind it to the receipt's
    // persisted authority instead of accepting an unpinned replay.
    const receiptCareerSnapshotId = normalizeCareerSnapshotId(existingReceipt?.careerSnapshotId);
    if (!manifest && exactExistingReceipt) {
      const legacyFixture = __testOnlyAllowUnpinned
        && existingReceipt?.careerSnapshotId == null
        && existingReceipt?.operationAuthority == null;
      if (!receiptCareerSnapshotId && !legacyFixture) {
        return { ok: false, cleared: false, receipt: existingReceipt, careerSnapshotMissing: true };
      }
      if (!legacyFixture && (!suppliedCareerSnapshotId || suppliedCareerSnapshotId !== receiptCareerSnapshotId)) {
        return { ok: false, cleared: false, receipt: existingReceipt, careerSnapshotMismatch: true };
      }
    }

    // A prior completion can have removed the manifest and staging successfully,
    // then failed only while updating the receipt, or it can have left a single
    // residual sidecar. The exact durable receipt is sufficient authority to
    // finish that cleanup idempotently; never reinterpret this as a scrape to
    // resume. Without either an exact manifest or exact receipt, fail closed.
    if (!manifest && !exactExistingReceipt) {
      return { ok: false, cleared: false, receipt: existingReceipt, tokenMismatch: true };
    }

    const initial = exactExistingReceipt
      ? existingReceipt
      : sanitizeLastRunReceipt({
          ...receipt,
          // Do not use process-global telemetry as a fallback here. The manifest
          // is this run's durable owner and safely fills identity/timing only
          // when the receipt builder could not match in-memory telemetry.
          nodeId: receipt?.nodeId || manifest?.inputs?.nodeId || null,
          startedAt: receipt?.startedAt ?? manifest?.startedAt,
          stagingStarted: true,
          cleanup: { attempted: false, cleared: null },
          ...(suppliedCareerSnapshotId ? { careerSnapshotId: suppliedCareerSnapshotId } : {}),
        });
    if (!exactExistingReceipt) {
      try {
        await atomicWriteJson(receiptPath, initial);
      } catch (error) {
        logger.warn(`[JobRunStaging] completion receipt write failed: ${error?.message || error}`);
        return { ok: false, cleared: false, receipt: null, receiptWriteFailed: true };
      }
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

// Every public async store operation participates in the canvas-path reader
// gate. Rebind owns the exclusive gate; these wrappers resolve an old captured
// path under a lease and hold it through the full read/modify/write operation.
// Function declarations stay above for local readability and unit seams; their
// exported live bindings are replaced once, after module initialization.
function recoveryBound(operation) {
  return async (canvasFilePath, ...args) => withCanvasRecoveryRead(
    canvasFilePath,
    ownerCanvasPath => operation(ownerCanvasPath, ...args),
  );
}

export const readLastRunReceipt = recoveryBound(readLastRunReceiptRaw);
export const writeLastRunReceipt = recoveryBound(writeLastRunReceiptRaw);
export const startRun = recoveryBound(startRunRaw);
export const recordSourcePage = recoveryBound(recordSourcePageRaw);
export const markSourceStatus = recoveryBound(markSourceStatusRaw);
export const setStage = recoveryBound(setStageRaw);
export const markProviderGathered = recoveryBound(markProviderGatheredRaw);
export const pauseRunForManualResume = recoveryBound(pauseRunForManualResumeRaw);
export const activateRunForResume = recoveryBound(activateRunForResumeRaw);
export const finishRunWithSavedListings = recoveryBound(finishRunWithSavedListingsRaw);
export const readStagedJobs = recoveryBound(readStagedJobsRaw);
export const readRunState = recoveryBound(readRunStateRaw);
export const clearRunWithResult = recoveryBound(clearRunWithResultRaw);
export const clearRun = recoveryBound(clearRunRaw);
export const completeRunWithReceipt = recoveryBound(completeRunWithReceiptRaw);
