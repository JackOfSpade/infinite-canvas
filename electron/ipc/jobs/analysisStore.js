import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { MAX_JOB_ANALYSIS_ARTIFACT_BYTES, assertJobAnalysisArtifactSize } from '../jobAnalysisArtifactLimits.js';
import { checkpointJobContinuationResult, clearJobContinuations, listJobContinuations, pauseJobContinuations, publishJobContinuationParentUpdate, validateJobContinuationAuthority } from '../jobContinuation.js';
import { claimJobAnalysisOperationAuthority, currentJobAnalysisOperationAuthority, jobAnalysisOperationAuthorityReceipt, publishedJobAnalysisOperationAuthority, retireJobAnalysisOperationPublication, withCurrentJobAnalysisOperationAuthority } from '../jobAnalysisOperationAuthorityStore.js';
import { clearRunWithResult, readRunState, sanitizeJobRunCollectionDiagnostics } from '../jobRunStaging.js';
import { getCurrentIpcRequestContext, isAppQuitPauseReason } from '../ipcUtils.js';
import { getJobAnalysisPaths, getJobDescriptionRecoveryCheckpointPath, getJobDescriptionRecoveryCheckpointPrefix, snapshotOwnedByCanvas } from '../jobAnalysisPaths.js';
import { recordJobAnalysisRecoveryLifecycle } from '../jobAnalysisRecoveryLifecycle.js';
import { resolveCanvasRecoveryPath } from '../canvasRecoveryPaths.js';
import { materializeScoringCareerEvidence } from './careerInput.js';
import electronPkg from 'electron';
const { app } = electronPkg;

export const REANALYZE_SAVED_JOBS_RECOVERY_MODE = 'reanalyze-saved-jobs';

// A Job provider run writes an exact manifest/staging ledger before its first
// browser/API side effect. An untitled canvas has no restart owner, so reject
// collection (and post-search durable continuations) up front rather than
// pretending renderer memory can recover a quit/crash. Parsing and other
// non-collection preparation remain intentionally available before first Save.
export function requireSavedJobRecoveryCanvas(canvasFilePath) {
  if (typeof canvasFilePath !== 'string' || !canvasFilePath.trim() || !path.isAbsolute(canvasFilePath)) {
    throw new Error('Save this canvas first before starting Job Search. Your current inputs will remain in place.');
  }
}

// Renderer module queues are window-local. Two windows opening the same saved
// canvas can therefore observe the same manifest and both request Resume. Keep
// an app-process lease around the *entire* exact search-jobs invocation. It is
// intentionally in memory: a process crash releases it automatically, while a
// finally block releases every normal/error/cancel path.
const activeExactJobRunExecutions = new Map();

function exactJobRunExecutionKey(canvasFilePath, nodeId, runId) {
  if (!canvasFilePath || !nodeId || !runId) return null;
  try {
    return `${resolveCanvasRecoveryPath(canvasFilePath) || path.resolve(canvasFilePath)}\u0000${String(nodeId)}\u0000${String(runId)}`;
  } catch {
    return null;
  }
}

export function claimExactJobRunExecution(canvasFilePath, nodeId, runId) {
  const key = exactJobRunExecutionKey(canvasFilePath, nodeId, runId);
  if (!key) return { ok: false, reason: 'missing-ownership' };
  if (activeExactJobRunExecutions.has(key)) return { ok: false, busy: true, reason: 'already-running' };
  const token = Symbol(`job-run:${runId}`);
  activeExactJobRunExecutions.set(key, token);
  return {
    ok: true,
    release: () => {
      if (activeExactJobRunExecutions.get(key) === token) activeExactJobRunExecutions.delete(key);
    },
  };
}

function continuationTerminalResult(operation, result) {
  if (operation === 'search-jobs-single-source') {
    return result?.success === true && Array.isArray(result.jobs);
  }
  return (operation === 'resolve-job-source' || operation === 'resume-job-source')
    && result?.resolved === true
    && Array.isArray(result.items);
}

export function checkpointContinuationBeforeReply(operation) {
  return async ({ event, args, signal, result }) => {
    if (!args?.continuationIntentId || (signal?.aborted && !isAppQuitPauseReason(signal.reason))) return;
    const admission = await validateJobContinuationAuthority(args.canvasFilePath, {
      nodeId: args.nodeId,
      parentRunId: args.jobRunId,
      intentId: args.continuationIntentId,
      leaseToken: args.continuationLeaseToken,
      operation,
      careerSnapshotId: args.careerSnapshotId,
      operationAuthority: args.operationAuthority,
      parentArtifactFingerprint: args.parentArtifactFingerprint,
    }, { sender: event.sender });
    if (!admission.ok) {
      return operation === 'search-jobs-single-source'
        ? { success: false, operationSuperseded: true, jobs: [], continuationCheckpoint: null }
        : { success: false, resolved: false, operationSuperseded: true, items: [], continuationCheckpoint: null };
    }
    const receipt = await checkpointJobContinuationResult(args.canvasFilePath, {
      nodeId: args.nodeId,
      parentRunId: args.jobRunId,
      intentId: args.continuationIntentId,
      leaseToken: args.continuationLeaseToken,
      operation,
      careerSnapshotId: args.careerSnapshotId,
      operationAuthority: args.operationAuthority,
      parentArtifactFingerprint: args.parentArtifactFingerprint,
      result,
    }, { sender: event.sender });
    if (continuationTerminalResult(operation, result) && receipt?.saved !== true) {
      throw new Error(`The ${operation} result could not be saved for exact restart replay.`);
    }
    return receipt?.saved === true ? { continuationCheckpoint: receipt } : null;
  };
}

export async function admitContinuationProviderWork(event, args, operation) {
  if (!args?.continuationIntentId) return { ok: true, continuation: false };
  const admitted = await validateJobContinuationAuthority(args.canvasFilePath, {
    nodeId: args.nodeId,
    parentRunId: args.jobRunId,
    intentId: args.continuationIntentId,
    leaseToken: args.continuationLeaseToken,
    operation,
    careerSnapshotId: args.careerSnapshotId,
    operationAuthority: args.operationAuthority,
    parentArtifactFingerprint: args.parentArtifactFingerprint,
  }, { sender: event.sender });
  return admitted.ok ? { ok: true, continuation: true } : {
    ok: false, continuation: true, reason: admitted.reason || 'operation-superseded',
  };
}

// Continuation stores can contain more than one intent for a hub.  Lifecycle
// cleanup must never turn a run-level button into an unscoped sidecar delete:
// enumerate the persisted receipts first, then submit each complete durable
// tuple back through the exact continuation gate.  In particular, this keeps
// a later run (or a sibling source) intact when an older run finishes.
export async function mutatePersistedRunContinuations({
  canvasFilePath,
  nodeId,
  parentRunId,
  mode,
  now = Date.now(),
  // Stop/terminal cleanup may execute after that exact authority deliberately
  // tombstoned itself.  This is passed only by host control paths and remains
  // subject to the stored tuple + sealed parent artifact validation.
  allowRevokedExactAuthority = false,
  pauseAuthority = null,
} = {}) {
  if (!canvasFilePath || !nodeId || !parentRunId || !['pause', 'clear'].includes(mode)) {
    return { ok: false, reason: 'missing-ownership', paused: 0, removed: 0 };
  }
  const intents = await listJobContinuations(canvasFilePath, nodeId);
  const owned = intents.filter(intent => intent?.parentRunId === parentRunId
    && intent?.intentId && intent?.careerSnapshotId && intent?.operationAuthority
    && intent?.parentArtifactFingerprint);
  let paused = 0;
  let removed = 0;
  for (const intent of owned) {
    // A completed source Resolve receipt may remain until a later autosave
    // acknowledgement. Once scoring has advanced authority it is already
    // fenced; leave that obsolete receipt intact instead of making it block
    // the current run's saved Pause. Current intents still require full checks.
    if (mode === 'pause' && pauseAuthority
      && !sameJobAnalysisOperationAuthority(intent.operationAuthority, pauseAuthority)) continue;
    const tuple = {
      nodeId,
      parentRunId,
      intentId: intent.intentId,
      careerSnapshotId: intent.careerSnapshotId,
      operationAuthority: intent.operationAuthority,
      parentArtifactFingerprint: intent.parentArtifactFingerprint,
      ...(allowRevokedExactAuthority ? { allowRevokedExactAuthority: true } : {}),
    };
    const result = mode === 'pause'
      ? await pauseJobContinuations(canvasFilePath, { ...tuple, now })
      : await clearJobContinuations(canvasFilePath, tuple);
    if (result?.ok !== true) {
      return {
        ok: false,
        reason: result?.reason || 'continuation-mutation-failed',
        operationSuperseded: result?.operationSuperseded === true,
        paused,
        removed,
      };
    }
    paused += Number(result.paused) || 0;
    removed += Number(result.removed) || 0;
  }
  return { ok: true, paused, removed, matched: owned.length };
}

// This is deliberately an internal control-flow error, rather than an IPC
// error.  A stale operation is an expected quiet outcome: callers must stop
// before their next observable side effect and return their normal
// supersession shape instead of turning a lost CAS race into a provider error.
export class JobOperationSupersededError extends Error {
  constructor() {
    super('This Job Search operation was superseded.');
    this.name = 'JobOperationSupersededError';
    this.operationSuperseded = true;
  }
}

export function isJobOperationSupersededError(error) {
  return error?.operationSuperseded === true;
}

export const JOB_ANALYSIS_SNAPSHOT_VERSION = 2;

const JOB_ANALYSIS_REPORT_METADATA_VERSION = 1;

const JOB_ANALYSIS_DIR = 'job-search';

// Unsaved canvases do not have a stable file path. Pair this process-unique
// token with the initiating WebContents so two unsaved windows that retain a
// cloned Job Search node ID cannot read or overwrite one another's private
// recovery artifacts. It intentionally changes on restart: unsaved recovery
// is never restart-resumable, and reusing an old renderer id would be worse
// than leaving its private temporary files inert.
const UNSAVED_ANALYSIS_PROCESS_SCOPE = `u${process.pid}_${crypto.randomUUID().replace(/-/g, '')}`;

const UNSAVED_ANALYSIS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Bug-report generation runs synchronously on Electron's main process. A
// checkpoint contains whole job rows, so a damaged/abandoned recovery folder
// must not turn a diagnostic request into an unbounded directory walk or file
// read. These bounds are intentionally separate from normal recovery reads:
// this helper exposes metadata only.
const MAX_DESCRIPTION_RECOVERY_CHECKPOINT_DIRECTORY_ENTRIES = 256;

const MAX_DESCRIPTION_RECOVERY_CHECKPOINT_CANDIDATES = 48;

const MAX_DESCRIPTION_RECOVERY_CHECKPOINT_BYTES = 512 * 1024;

const MAX_DESCRIPTION_RECOVERY_CHECKPOINT_METADATA_BYTES = 16 * 1024;

export function unsavedAnalysisScopeForCurrentRequest(canvasFilePath) {
  if (typeof canvasFilePath === 'string' && canvasFilePath.trim()) return null;
  const senderId = getCurrentIpcRequestContext()?.sender?.id;
  return Number.isSafeInteger(senderId) && senderId > 0
    ? `${UNSAVED_ANALYSIS_PROCESS_SCOPE}_w${senderId}`
    : null;
}

// Unsaved recovery is intentionally process-local. Prune only stale files from
// older process scopes so a user who repeatedly quits with an unsaved canvas
// cannot accumulate inert prompts/checkpoints forever. New filenames embed the
// current scope hash, which makes excluding this process's active artifacts
// deterministic even if a run is unusually long-lived.
export async function pruneStaleUnsavedAnalysisArtifacts() {
  const dir = path.join(app.getPath('userData'), JOB_ANALYSIS_DIR);
  const currentScopeHash = crypto.createHash('sha256')
    .update(UNSAVED_ANALYSIS_PROCESS_SCOPE)
    .digest('hex')
    .slice(0, 16);
  const ownedPrefix = `job-search-unsaved-${currentScopeHash}-`;
  const isArtifact = (name) => /^job-search-unsaved-(?:[a-f0-9]{16}-)?[a-f0-9]{32}-(?:last-scrape|last-successful-scrape(?:-[23])?)\.json$/.test(name)
    || /^job-search-unsaved-(?:[a-f0-9]{16}-)?[a-f0-9]{32}-scoring-AI-prompt\.txt$/.test(name)
    || /^job-search-unsaved-[a-f0-9]{16}-description-recovery-[a-f0-9]{24}\.json$/.test(name);
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const cutoff = Date.now() - UNSAVED_ANALYSIS_MAX_AGE_MS;
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || entry.name.startsWith(ownedPrefix) || !isArtifact(entry.name)) return;
      const filePath = path.join(dir, entry.name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < cutoff) await fs.promises.unlink(filePath).catch(() => {});
    }));
  } catch { /* private recovery cleanup is best effort */ }
}

export function analysisPathsForCanvas(canvasFilePath, fallbackDir = null, nodeId = null, unsavedScope = undefined) {
  return getJobAnalysisPaths(
    canvasFilePath,
    fallbackDir || path.join(app.getPath('userData'), JOB_ANALYSIS_DIR),
    nodeId,
    unsavedScope === undefined ? unsavedAnalysisScopeForCurrentRequest(canvasFilePath) : unsavedScope,
  );
}

// Kept outside every owner bundle: an explicit career-data clear may move all
// snapshot generations to Trash, but the metadata-only explanation must
// survive that removal and the next app restart.
function jobAnalysisRecoveryLifecyclePath() {
  return path.join(app.getPath('userData'), JOB_ANALYSIS_DIR, 'analysis-recovery-lifecycle.json');
}

export function recordAnalysisRecoveryLifecycle(input) {
  return recordJobAnalysisRecoveryLifecycle(jobAnalysisRecoveryLifecyclePath(), input).catch(() => false);
}

function descriptionRecoveryCheckpointPath(canvasFilePath, runId) {
  return getJobDescriptionRecoveryCheckpointPath(
    canvasFilePath,
    runId,
    path.join(app.getPath('userData'), JOB_ANALYSIS_DIR),
    unsavedAnalysisScopeForCurrentRequest(canvasFilePath),
  );
}

function descriptionRecoveryCheckpointPrefix(canvasFilePath) {
  return getJobDescriptionRecoveryCheckpointPrefix(
    canvasFilePath,
    path.join(app.getPath('userData'), JOB_ANALYSIS_DIR),
    unsavedAnalysisScopeForCurrentRequest(canvasFilePath),
  );
}

// Test seam: prove renderer-owned unsaved path isolation through the real
// AsyncLocalStorage request context rather than a pure helper only.
export function __analysisPathsForCurrentRequestForTests(canvasFilePath, nodeId) {
  return analysisPathsForCanvas(canvasFilePath, null, nodeId);
}

// Diagnostics executes in the initiating bug-report IPC context, so it can
// use this narrow bridge to inspect the same unsaved owner bundle without
// receiving or persisting the process/session scope token itself.
export function getCurrentRequestJobAnalysisPaths(canvasFilePath, nodeId = null) {
  const paths = analysisPathsForCanvas(canvasFilePath, null, nodeId);
  return {
    ...paths,
    requestScopedUnsaved: !paths.canvasPath && !!unsavedAnalysisScopeForCurrentRequest(canvasFilePath),
  };
}

// The readable prompt file must be reproducible from the JSON snapshot that
// was actually written, so the body is derived rather than trusted: an old
// file that still carries `prompt` formats identically to one where the write
// dropped it, and an omitted batch says so instead of looking empty.
const OMITTED_PREVIEW_BATCH_JOBS_NOTICE = '(batch jobs omitted from the saved snapshot to stay under the 128 MiB recovery limit)';

function formatPromptBatchBody(batch) {
  if (typeof batch?.prompt === 'string') return batch.prompt;
  if (batch?.jobsOmitted === true) return OMITTED_PREVIEW_BATCH_JOBS_NOTICE;
  return `JOBS TO SCORE (array, indexed):\n${JSON.stringify(Array.isArray(batch?.jobs) ? batch.jobs : [])}`;
}

// Writes the exact text sent to the AI: the cached prefix followed by each
// batch payload. Uses previewBatches (all gathered jobs, ignoring score cap)
// so the file is populated even when AI scoring is skipped in test mode.
function formatPromptFile(snapshot) {
  const { createdAt, gatheredJobCount, cachedPrefix, previewBatches } = snapshot || {};
  const ts = createdAt ? new Date(createdAt).toLocaleString() : '';
  const batches = Array.isArray(previewBatches) ? previewBatches : [];
  const sep = '='.repeat(72);

  const lines = [
    `Complete AI scoring prompt — ${ts}`,
    `${gatheredJobCount ?? 0} jobs gathered, ${batches.length} batch${batches.length === 1 ? '' : 'es'}`,
    '',
    sep,
    'CACHED PREFIX  (identical text prepended to every batch handoff below; shown once here rather than duplicated per batch)',
    sep,
    '',
    materializeScoringCareerEvidence(cachedPrefix, snapshot?.careerData || ''),
  ];

  if (batches.length === 0) {
    lines.push('', '(no jobs — scoring was skipped or no jobs were gathered)');
  } else {
    for (const batch of batches) {
      lines.push('', sep, `BATCH ${batch?.batchNumber ?? ''} of ${batches.length}  (${batch?.jobCount ?? 0} jobs)`, sep, '', formatPromptBatchBody(batch));
    }
  }

  return lines.join('\n');
}

// The prompt is written after the JSON snapshot. A process crash in that
// interval leaves the new recovery JSON next to a missing or previous-run
// prompt. Never expose the companion path until its complete contents bind it
// to the exact snapshot we just loaded. Prompt availability is auxiliary; any
// I/O/shape failure must not make durable scrape recovery fail.
async function verifiedPromptPathForSnapshot(promptPath, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  try {
    const [actual, expected] = await Promise.all([
      fs.promises.readFile(promptPath, 'utf8'),
      Promise.resolve(formatPromptFile(snapshot)),
    ]);
    return actual === expected ? promptPath : null;
  } catch {
    return null;
  }
}

async function writeJobAnalysisFileAtomically(filePath, content, { mode } = {}) {
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    // These files are the recovery point, not merely a cache. Flush the
    // replacement before publishing it, then flush the parent directory after
    // rename; otherwise an immediate power loss can acknowledge a generation
    // rotation whose new name or contents existed only in the OS cache.
    const handle = await fs.promises.open(tmpPath, 'w', mode);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmpPath, filePath);
    const directory = await fs.promises.open(path.dirname(filePath), 'r').catch(() => null);
    if (directory) {
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await fs.promises.unlink(tmpPath).catch(() => {});
  }
}

// A snapshot is a three-file logical record: the current machine-readable
// scrape, its human-readable scoring prompt, and (for a populated gather) the
// durable last-success recovery copy. Search, re-score, and a source Solve can
// all save for the same canvas without awaiting one another. Serialize the
// complete bundle so the JSON from one run cannot be paired with the prompt
// from another, or let an older save win after a newer one has finished.
const _jobAnalysisSnapshotTails = new Map();

// Clearing one career identity must win over an already-dispatched write. Keep
// one boundary per canvas/hub rather than an unbounded set of run IDs: all
// snapshots created before that boundary are stale, and its exact run ID also
// fences an equal-millisecond or late same-run writer. A later clear advances
// the boundary without making a new run on that hub unwritable.
const _retiredJobAnalysisSnapshots = new Map();

export function normalizeJobAnalysisIdentifier(value, max = 200) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
    ? normalized
    : null;
}

// Career snapshots are immutable SHA-256-addressed artifacts. Keep the
// opaque address separate from the renderer's mutable profile/career text so
// a recovered analysis can still resolve exactly the corpus that produced it.
export function normalizeCareerSnapshotIdentifier(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function jobAnalysisRetirementKey(canvasFilePath, nodeId) {
  const canvas = typeof canvasFilePath === 'string' && canvasFilePath.trim()
    ? path.resolve(canvasFilePath)
    : null;
  // A clear tombstone must use the same owner namespace as the artifact it
  // fences. Otherwise a clear in unsaved window A could suppress a later save
  // from unsaved window B merely because both cloned the same hub ID.
  const scope = canvas || `unsaved:${unsavedAnalysisScopeForCurrentRequest(canvasFilePath) || 'legacy'}`;
  return `${scope}\u0000${String(nodeId || '')}`;
}

export function snapshotCreatedAtMs(snapshot) {
  const createdAt = snapshot?.createdAt;
  const value = typeof createdAt === 'number'
    ? createdAt
    : (typeof createdAt === 'string' ? Date.parse(createdAt) : NaN);
  // A finite number can still be outside ECMAScript's Date range. Those
  // values would compare as permanently newer than every real clear boundary
  // and make stale recovery impossible to classify safely.
  return Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())
    ? value
    : null;
}

function normalizeJobAnalysisClearBoundary(value) {
  if (value == null) return null;
  // This is a renderer Date.now() contract, not a user-facing numeric parser.
  // Coercion would let false, whitespace, or a string select a surprising
  // boundary; a fractional/zero value cannot name a real clear instant either.
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && Number.isFinite(new Date(value).getTime())
    ? value
    : null;
}

export function jobAnalysisSnapshotOwner(snapshot) {
  return typeof snapshot?.sourceHubId === 'string' && snapshot.sourceHubId.trim()
    ? snapshot.sourceHubId.trim()
    : (typeof snapshot?.nodeId === 'string' && snapshot.nodeId.trim()
      ? snapshot.nodeId.trim()
      : (typeof snapshot?.snapshotContext?.sourceHubId === 'string' && snapshot.snapshotContext.sourceHubId.trim()
        ? snapshot.snapshotContext.sourceHubId.trim()
        : (typeof snapshot?.snapshotContext?.nodeId === 'string' ? snapshot.snapshotContext.nodeId.trim() : '')));
}

function jobAnalysisSnapshotCanvas(snapshot) {
  return typeof snapshot?.canvasFilePath === 'string' && snapshot.canvasFilePath.trim()
    ? snapshot.canvasFilePath
    : snapshot?.snapshotContext?.canvasFilePath;
}

export function snapshotOperationAuthority(snapshot) {
  return jobAnalysisOperationAuthorityReceipt(snapshot?.operationAuthority
    ?? snapshot?.snapshotContext?.operationAuthority);
}

export function sameJobAnalysisOperationAuthority(left, right) {
  const a = jobAnalysisOperationAuthorityReceipt(left);
  const b = jobAnalysisOperationAuthorityReceipt(right);
  return !!a && !!b && a.operationId === b.operationId && a.revision === b.revision
    && JSON.stringify(a.semanticBase) === JSON.stringify(b.semanticBase);
}

async function hasPublishedSnapshotOperationAuthority(snapshot, slot, serialized) {
  const canvasFilePath = exactSnapshotCanvas(snapshot);
  const hubId = exactSnapshotOwner(snapshot);
  const receipt = snapshotOperationAuthority(snapshot);
  if (!canvasFilePath || !hubId || !receipt || typeof serialized !== 'string') return false;
  return publishedJobAnalysisOperationAuthority({
    canvasFilePath, hubId, slot, digest: jobAnalysisArtifactDigest(serialized), ...receipt,
  });
}

function exactSnapshotOwner(snapshot) {
  const rawOwners = [
    snapshot?.sourceHubId,
    snapshot?.nodeId,
    snapshot?.snapshotContext?.sourceHubId,
    snapshot?.snapshotContext?.nodeId,
  ];
  if (rawOwners.some(value => value != null && !normalizeJobAnalysisIdentifier(value))) return null;
  const owners = [...new Set(rawOwners.filter(value => value != null).map(value => normalizeJobAnalysisIdentifier(value)))];
  return owners.length === 1 ? owners[0] : null;
}

function exactSnapshotCanvas(snapshot) {
  const rawCanvases = [snapshot?.canvasFilePath, snapshot?.snapshotContext?.canvasFilePath];
  if (rawCanvases.some(value => value != null && (typeof value !== 'string' || !value.trim()))) return undefined;
  const supplied = rawCanvases.filter(value => value != null);
  if (supplied.length === 0) return null;
  const canvases = [...new Set(supplied.map(value => {
    try { return path.resolve(value); }
    catch { return undefined; }
  }))];
  return canvases.length === 1 && canvases[0] ? canvases[0] : undefined;
}

function safeSnapshotCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

// A diagnostic report must not need to parse an arbitrarily large saved job
// payload merely to establish which run/hub wrote it. This compact envelope is
// written as the FIRST JSON property with every new snapshot. It is regenerated
// from the actual payload at serialization time, so renderer-provided metadata
// can neither spoof ownership nor survive an update-only recovery rewrite.
function buildJobAnalysisReportMetadata(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const owner = exactSnapshotOwner(snapshot);
  const canvasFilePath = exactSnapshotCanvas(snapshot);
  const createdAtMs = snapshotCreatedAtMs(snapshot);
  const runId = snapshot?.runId == null ? null : normalizeJobAnalysisIdentifier(snapshot.runId);
  const recoveryMode = snapshot?.snapshotContext?.recoveryMode;
  const analysisRevisionId = normalizeJobAnalysisIdentifier(
    snapshot?.analysisRevisionId ?? snapshot?.snapshotContext?.analysisRevisionId,
  );
  const candidatePoolJobCount = Array.isArray(snapshot.jobs) ? snapshot.jobs.length : null;
  const descriptionRecoveryJobCount = Array.isArray(snapshot.descriptionRecoveryJobs)
    ? snapshot.descriptionRecoveryJobs.length
    : 0;
  const gatheredJobCount = safeSnapshotCount(snapshot.gatheredJobCount);
  // The bounded report reader treats Unix epoch as an unrecorded timestamp.
  // Keep the writer from emitting an envelope it will necessarily reject.
  const declaresSavedJobReanalysis = recoveryMode === REANALYZE_SAVED_JOBS_RECOVERY_MODE;
  const savedJobReanalysis = declaresSavedJobReanalysis && !!analysisRevisionId;
  // A saved-job reanalysis is a downstream operation over an already-saved
  // candidate pool. It can legitimately have no source-run token, unlike a
  // normal search snapshot. Version 2 makes that exception explicit and
  // narrow so a missing token can never be accepted for another recovery mode.
  if (!owner || typeof canvasFilePath !== 'string' || !canvasFilePath || createdAtMs == null || createdAtMs <= 0
    || !Object.hasOwn(snapshot, 'runId') || snapshot.runId === undefined
    || (declaresSavedJobReanalysis && !analysisRevisionId)
    || (snapshot?.runId != null && !runId) || (!runId && !savedJobReanalysis)
    || candidatePoolJobCount == null || descriptionRecoveryJobCount == null || gatheredJobCount == null
    // The candidate pool is the complete retained universe; score-ready
    // gathered jobs are a subset. Do not write an envelope the reader must
    // reject when malformed IPC/test input violates that durable accounting.
    || gatheredJobCount > candidatePoolJobCount) return null;
  return {
    schemaVersion: savedJobReanalysis ? 2 : JOB_ANALYSIS_REPORT_METADATA_VERSION,
    createdAt: new Date(createdAtMs).toISOString(),
    canvasFilePath,
    sourceHubId: owner,
    nodeId: owner,
    runId,
    ...(savedJobReanalysis ? { recoveryMode, analysisRevisionId } : {}),
    gatheredJobCount,
    candidatePoolJobCount,
    descriptionRecoveryJobCount,
  };
}

// Serialize the durable envelope WITHOUT the size assertion. The recovery
// writer retries a smaller form before it fails the whole save, so the assert
// lives in serializeJobAnalysisSnapshot and in prepareJobAnalysisSnapshotForWrite.
function serializeJobAnalysisSnapshotText(snapshot) {
  const payload = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot
    : {};
  // `reportMetadata` is diagnostic-only and always writer-authored. Strip an
  // incoming copy rather than spreading it through as stale or spoofed state.
  const { reportMetadata: _ignoredReportMetadata, ...rest } = payload;
  const reportMetadata = buildJobAnalysisReportMetadata(rest);
  if (!reportMetadata) return `${JSON.stringify(rest, null, 2)}\n`;

  // Object-property enumeration promotes array-index keys ahead of ordinary
  // string keys. A normal production snapshot has none, but this is a durable
  // file-format promise rather than a convention for today's builder: keep the
  // writer-authored envelope physically first even for malformed/future input.
  // Serialize each remaining property with JSON's ordinary omission/error
  // behavior (undefined is omitted; BigInt still throws) without ever letting
  // a supplied property displace or duplicate the envelope.
  const property = (key, value) => {
    const encoded = JSON.stringify(value, null, 2);
    return encoded === undefined
      ? null
      : `  ${JSON.stringify(key)}: ${encoded.replace(/\n/g, '\n  ')}`;
  };
  const properties = [property('reportMetadata', reportMetadata)];
  for (const key of Object.keys(rest)) {
    const encoded = property(key, rest[key]);
    if (encoded != null) properties.push(encoded);
  }
  return `{\n${properties.join(',\n')}\n}\n`;
}

// A snapshot's previewBatches store the same batch payload twice: `jobs` and
// `prompt` (an escaped JSON copy of `jobs`). Only formatPromptFile ever reads
// `prompt`, and it can derive identical text from `jobs`, so the durable write
// drops the copy first and only then drops the batch jobs themselves.
function jobAnalysisSnapshotWithoutPreviewBatchPrompts(snapshot) {
  const payload = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot
    : {};
  if (!Array.isArray(payload.previewBatches)) return { ...payload };
  return {
    ...payload,
    previewBatches: payload.previewBatches.map((batch) => {
      if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return batch;
      const { prompt: _ignoredPrompt, ...rest } = batch;
      return rest;
    }),
  };
}

function jobAnalysisSnapshotWithOmittedPreviewBatchJobs(persisted) {
  if (!Array.isArray(persisted.previewBatches)) return null;
  return {
    ...persisted,
    previewBatchJobsOmitted: true,
    previewBatches: persisted.previewBatches.map((batch) => {
      if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return batch;
      const { jobs: _omittedJobs, ...rest } = batch;
      // Keep the batch count and its accounting: only the (reproducible) job
      // payload is dropped, so readers still see one entry per batch.
      return { ...rest, jobs: [], jobsOmitted: true };
    }),
  };
}

function prepareJobAnalysisSnapshotForWrite(snapshot, { maxBytes = MAX_JOB_ANALYSIS_ARTIFACT_BYTES } = {}) {
  const limit = Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : MAX_JOB_ANALYSIS_ARTIFACT_BYTES;
  const persisted = jobAnalysisSnapshotWithoutPreviewBatchPrompts(snapshot);
  const serialized = serializeJobAnalysisSnapshotText(persisted);
  if (Buffer.byteLength(serialized, 'utf8') <= limit) return { snapshot: persisted, serialized };
  const omitted = jobAnalysisSnapshotWithOmittedPreviewBatchJobs(persisted);
  if (omitted) {
    const omittedSerialized = serializeJobAnalysisSnapshotText(omitted);
    if (Buffer.byteLength(omittedSerialized, 'utf8') <= limit) {
      return { snapshot: omitted, serialized: omittedSerialized };
    }
  }
  // Still too large. The default limit keeps reporting through the shared
  // assertion (single source of the message and code); an explicit test limit
  // gets an identical error without depending on the real 128 MiB threshold.
  if (limit === MAX_JOB_ANALYSIS_ARTIFACT_BYTES) {
    assertJobAnalysisArtifactSize(serializeJobAnalysisSnapshotText(omitted || persisted));
  }
  const error = new Error('Saved job analysis exceeds the 128 MiB recovery limit. The previous saved analysis was preserved.');
  error.code = 'JOB_ANALYSIS_ARTIFACT_TOO_LARGE';
  throw error;
}

function serializeJobAnalysisSnapshot(snapshot) {
  return prepareJobAnalysisSnapshotForWrite(snapshot).serialized;
}

export function jobAnalysisArtifactDigest(serialized) {
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function isAllFilteredSavedJobReanalysisSnapshot(snapshot) {
  // An all-filtered saved-job re-analysis intentionally has no score-ready
  // rows or prompt batches, but its retained candidate pool is still the only
  // durable input for a revised brief. Keep this exception extremely narrow:
  // ordinary empty runs, malformed snapshots, and incomplete score attempts
  // must never enter the successful-generation fallback chain.
  return snapshot?.snapshotContext?.recoveryMode === REANALYZE_SAVED_JOBS_RECOVERY_MODE
    && Array.isArray(snapshot?.jobs)
    && snapshot.jobs.length > 0
    && snapshot?.gatheredJobCount === 0
    && snapshot?.selectedJobCount === 0
    && Array.isArray(snapshot?.previewBatches)
    && snapshot.previewBatches.length === 0
    && Number.isSafeInteger(snapshot?.sourceGatheredCount)
    && snapshot.sourceGatheredCount > 0
    && !!snapshot?.preferenceEvaluation
    && typeof snapshot.preferenceEvaluation === 'object'
    && !Array.isArray(snapshot.preferenceEvaluation);
}

function isPopulatedSuccessfulJobAnalysisSnapshot(snapshot) {
  if (!Array.isArray(snapshot?.jobs) || snapshot.jobs.length === 0) return false;
  if (isAllFilteredSavedJobReanalysisSnapshot(snapshot)) return true;
  // Pre-accounting snapshots did not write gatheredJobCount. Their non-empty
  // job pool is still a populated successful recovery point; a present count,
  // however, must not contradict that claim.
  return snapshot?.gatheredJobCount == null || Number(snapshot.gatheredJobCount) > 0;
}

function successfulSnapshotIdentity(snapshot, serialized) {
  const owner = exactSnapshotOwner(snapshot);
  const runId = normalizeJobAnalysisIdentifier(snapshot?.runId);
  const recoveryMode = snapshot?.snapshotContext?.recoveryMode;
  const analysisRevisionId = normalizeJobAnalysisIdentifier(
    snapshot?.analysisRevisionId ?? snapshot?.snapshotContext?.analysisRevisionId,
  );
  // A run token is durable provenance, and repeated in-place saves (such as a
  // description-recovery update) must refresh generation 1 rather than burn
  // through all three recovery slots. Saved-job re-analysis deliberately
  // retains that source run token, so its manual-AI revision is part
  // of the identity: a new brief rotates, while resume/retry of that exact
  // revision overwrites generation 1. Version-2 report metadata carries the
  // raw revision for bounded ownership correlation; report rendering digests it.
  if (owner && recoveryMode === REANALYZE_SAVED_JOBS_RECOVERY_MODE && analysisRevisionId) {
    // Old scored canvases can legitimately predate a durable provider run
    // token. The opaque re-analysis revision still identifies a retry of the
    // exact downstream operation, so it must deduplicate even with a null
    // source run instead of comparing a newly-generated createdAt payload.
    return `${owner}\u0000reanalyze\u0000${runId || ''}\u0000${analysisRevisionId}`;
  }
  // Legacy records without a usable token remain distinct only when their
  // exact serialized payload differs.
  return owner && runId ? `${owner}\u0000${runId}` : serialized;
}

async function readValidSuccessfulGeneration(filePath, canvasFilePath, nodeId, slot, authorityRecord) {
  try {
    const read = await readAnalysisArtifact(filePath);
    if (read.state !== 'present') return null;
    const { snapshot, serialized } = read;
    if (classifySnapshotExactOwnership(snapshot, canvasFilePath, nodeId) !== 'owned'
      || !isPopulatedSuccessfulJobAnalysisSnapshot(snapshot)) return null;
    const publication = scopedPublicationFor(authorityRecord, slot, serialized, snapshotOperationAuthority(snapshot));
    if (!publication) return null;
    // Keep the exact sealed bytes and receipt. Re-serializing a retained backup
    // would require a new seal and could promote altered/unpublished content.
    return { filePath, snapshot, serialized, publication, fileIdentity: read.identity,
      identity: successfulSnapshotIdentity(snapshot, serialized) };
  } catch {
    // A recovery generation is optional. Never overwrite an unparseable or
    // foreign record merely because its filename happens to be in this scope.
    return null;
  }
}

// The writer lock covers the entire bundle (current + all generations), so a
// newer save cannot interleave with a rotation.  Write oldest-to-newest: until
// the final generation-1 rename, the prior newest recovery point remains
// intact. A crash can leave a harmless duplicate but never makes all valid
// populated recovery points disappear.
async function planSuccessfulJobAnalysisGenerations(paths, snapshot, serialized, authorityRecord) {
  if (!isPopulatedSuccessfulJobAnalysisSnapshot(snapshot)) return null;
  const owner = jobAnalysisSnapshotOwner(snapshot);
  const previous = [];
  const destinations = paths.lastSuccessJsonPaths || [paths.lastSuccessJsonPath];
  const validByPath = new Map();
  for (const [index, filePath] of destinations.entries()) {
    const record = await readValidSuccessfulGeneration(filePath, snapshot.canvasFilePath, owner, `success:${index + 1}`, authorityRecord);
    if (record) validByPath.set(filePath, record);
    if (record && !previous.some(candidate => candidate.identity === record.identity)) previous.push(record);
  }
  const next = [{
    filePath: paths.lastSuccessJsonPath,
    snapshot,
    serialized,
    identity: successfulSnapshotIdentity(snapshot, serialized),
  }];
  for (const record of previous) {
    if (record.identity !== next[0].identity) next.push(record);
    if (next.length >= destinations.length) break;
  }
  return {
    next, destinations,
    retainedPublications: next.slice(1).map((record, index) => ({ ...record.publication, slot: `success:${index + 2}` })),
    surplus: destinations.slice(next.length).map(filePath => validByPath.get(filePath)).filter(Boolean),
  };
}

async function rotateSuccessfulJobAnalysisGenerations(plan) {
  if (!plan) return { rotated: false, retainedGenerations: 0 };
  const { next, destinations } = plan;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    await writeJobAnalysisFileAtomically(destinations[index], next[index].serialized);
  }
  // Do not remove a corrupt/foreign surplus record. A valid, owned fourth
  // record is safely retired only after its three newer successors exist.
  for (const record of plan.surplus) {
    await removeAnalysisArtifactIfUnchanged(record.filePath, record.fileIdentity);
  }
  return { rotated: true, retainedGenerations: next.length };
}

function retireJobAnalysisSnapshot(canvasFilePath, snapshot, clearedAt = null) {
  const runId = normalizeJobAnalysisIdentifier(snapshot?.runId) || '';
  const nodeId = jobAnalysisSnapshotOwner(snapshot);
  if (!nodeId) return;
  const key = jobAnalysisRetirementKey(canvasFilePath, nodeId);
  const prior = _retiredJobAnalysisSnapshots.get(key);
  const nextBoundary = normalizeJobAnalysisClearBoundary(clearedAt);
  const nextAfterPrior = prior?.clearedAt != null
    ? normalizeJobAnalysisClearBoundary(prior.clearedAt + 1)
    : null;
  // The renderer supplies strictly increasing clear timestamps, but IPC can
  // also be reached by a stale window. Serialize that caller behind the last
  // boundary rather than letting an equal/non-monotonic timestamp retain the
  // prior run's tombstone and revive the later cleared run.
  const effectiveBoundary = nextBoundary != null
    ? Math.max(nextBoundary, prior?.clearedAt ?? 0, nextAfterPrior ?? 0)
    : null;
  // An explicit clear boundary is monotonic. Direct internal callers without
  // one retain the legacy exact-run tombstone behavior.
  if (nextBoundary != null || runId) {
    const advancesBoundary = effectiveBoundary != null && effectiveBoundary > (prior?.clearedAt ?? -1);
    const retirement = {
      clearedAt: effectiveBoundary == null
        ? (prior?.clearedAt ?? null)
        : effectiveBoundary,
      // A clear establishes one exact-run tie-breaker. Older sidecars found
      // during that same clear must not overwrite it with their own run ID.
      runId: advancesBoundary ? (runId || null) : (prior?.runId || runId || null),
    };
    _retiredJobAnalysisSnapshots.set(key, retirement);
    return retirement;
  }
  return prior || null;
}

function isRetiredJobAnalysisSnapshot(snapshot) {
  const runId = normalizeJobAnalysisIdentifier(snapshot?.runId) || '';
  const nodeId = jobAnalysisSnapshotOwner(snapshot);
  if (!nodeId) return false;
  const retirement = _retiredJobAnalysisSnapshots.get(jobAnalysisRetirementKey(jobAnalysisSnapshotCanvas(snapshot), nodeId));
  if (!retirement) return false;
  if (runId && retirement.runId === runId) return true;
  if (retirement.clearedAt == null) return false;
  const createdAt = snapshotCreatedAtMs(snapshot);
  if (createdAt == null || createdAt > retirement.clearedAt) return false;
  if (createdAt < retirement.clearedAt) return true;
  // Date.now ties are only safe when both sides prove they are separate,
  // well-formed run tokens. This is the persisted renderer rule as well:
  // without a tie-breaker, favour the clear over possibly stale recovery.
  return !runId || !retirement.runId || runId === retirement.runId;
}

function withJobAnalysisSnapshotLock(filePath, fn) {
  const key = path.resolve(filePath);
  const previous = _jobAnalysisSnapshotTails.get(key) || Promise.resolve();
  const result = previous.then(fn, fn);
  const tail = result.then(() => {}, () => {});
  _jobAnalysisSnapshotTails.set(key, tail);
  void tail.finally(() => {
    if (_jobAnalysisSnapshotTails.get(key) === tail) _jobAnalysisSnapshotTails.delete(key);
  });
  return result;
}

/**
 * The collection facts that travel with a saved scrape: when the run's walk
 * began and ended, whether it was a full collection, and which platforms
 * finished. They live and die with the saved rows on purpose. A card whose
 * completion was never recorded can then still move each finished platform's
 * date when those rows are shown, and Clear Scrape drops the proof together
 * with the rows it described.
 *
 * Sources, in order: this run's live manifest (the host's own settled search
 * boundary), evidence already on the snapshot, then the copy in the file being
 * replaced (a re-analysis rewrites the same run). Null when none names this
 * exact run.
 */
export function collectionEvidenceForSnapshot(snapshot, manifest = null, priorSnapshot = null) {
  const runId = typeof snapshot?.runId === 'string' && snapshot.runId ? snapshot.runId : null;
  if (!runId) return null;
  const candidates = [
    manifest?.runId === runId ? manifest.collectionDiagnostics : null,
    snapshot?.collectionEvidence?.runId === runId ? snapshot.collectionEvidence : null,
    priorSnapshot?.runId === runId && priorSnapshot?.collectionEvidence?.runId === runId
      ? priorSnapshot.collectionEvidence : null,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const evidence = sanitizeJobRunCollectionDiagnostics(candidate);
    if (evidence.disposition === 'unknown' || evidence.startedAt == null || evidence.completedAt == null) continue;
    return { runId, ...evidence };
  }
  return null;
}

async function attachCollectionEvidence(snapshot, jsonPath) {
  if (!snapshot?.runId || !snapshot.canvasFilePath) return snapshot;
  let manifest = null;
  try {
    manifest = (await readRunState(snapshot.canvasFilePath, Date.now(), { nodeId: jobAnalysisSnapshotOwner(snapshot) }))?.manifest || null;
  } catch { /* a missing or foreign manifest supplies nothing */ }
  let evidence = collectionEvidenceForSnapshot(snapshot, manifest);
  if (!evidence) {
    // Only now pay for parsing the file being replaced.
    try {
      evidence = collectionEvidenceForSnapshot(snapshot, null, JSON.parse(await fs.promises.readFile(jsonPath, 'utf8')));
    } catch { /* first save, or an unreadable predecessor */ }
  }
  if (!evidence) {
    const { collectionEvidence: _stale, ...rest } = snapshot;
    return rest;
  }
  return { ...snapshot, collectionEvidence: evidence };
}

export async function saveJobAnalysisSnapshot(snapshot) {
  const paths = analysisPathsForCanvas(
    snapshot.canvasFilePath,
    null,
    jobAnalysisSnapshotOwner(snapshot),
  );
  const { dir, jsonPath, lastSuccessJsonPath, promptPath } = paths;
  const authority = snapshotOperationAuthority(snapshot);
  const transaction = await withCurrentJobAnalysisOperationAuthority({
    canvasFilePath: snapshot.canvasFilePath, hubId: jobAnalysisSnapshotOwner(snapshot), ...authority,
  }, (authorityRecord, stagePublication) => withJobAnalysisSnapshotLock(jsonPath, async () => {
    if (isRetiredJobAnalysisSnapshot(snapshot)) {
      await recordAnalysisRecoveryLifecycle({
        operation: 'snapshot-save', result: 'retired', reason: 'retired-before-write',
        canvasFilePath: snapshot.canvasFilePath, ownerId: jobAnalysisSnapshotOwner(snapshot), runId: snapshot.runId,
        recoveryMode: snapshot?.snapshotContext?.recoveryMode,
      });
      return { retired: true, jsonPath, lastSuccessJsonPath, promptPath };
    }
    if (!snapshot.canvasFilePath) await fs.promises.mkdir(dir, { recursive: true });
    snapshot = await attachCollectionEvidence(snapshot, jsonPath);
    const { snapshot: persisted, serialized } = prepareJobAnalysisSnapshotForWrite(snapshot);
    const rotationPlan = await planSuccessfulJobAnalysisGenerations(paths, snapshot, serialized, authorityRecord);
    await stagePublication({
      publications: [
        { slot: 'current', digest: jobAnalysisArtifactDigest(serialized) },
        ...(rotationPlan ? [{ slot: 'success:1', digest: jobAnalysisArtifactDigest(serialized) }] : []),
      ],
      ...(rotationPlan ? { retainedSuccessfulPublications: rotationPlan.retainedPublications } : {}),
    });
    await writeJobAnalysisFileAtomically(jsonPath, serialized);
    // Keep a durable recovery copy of the most recent populated gather. A valid
    // empty run may replace the current diagnostic snapshot, but it must not
    // erase the only detailed copy of opportunities that durable seen-history
    // will correctly suppress from future reruns.
    const rotation = await rotateSuccessfulJobAnalysisGenerations(rotationPlan);
    await writeJobAnalysisFileAtomically(promptPath, formatPromptFile(persisted));
    const lifecycle = {
      canvasFilePath: snapshot.canvasFilePath,
      ownerId: jobAnalysisSnapshotOwner(snapshot),
      runId: snapshot.runId,
      recoveryMode: snapshot?.snapshotContext?.recoveryMode,
      gatheredJobCount: snapshot.gatheredJobCount,
      candidatePoolJobCount: Array.isArray(snapshot.jobs) ? snapshot.jobs.length : null,
    };
    const lifecycleReason = snapshot?.snapshotContext?.recoveryMode === 'reanalyze-saved-jobs'
      ? 'reanalysis-save'
      : 'normal-save';
    await recordAnalysisRecoveryLifecycle({
      ...lifecycle, operation: 'snapshot-save', result: 'saved', reason: lifecycleReason,
      generation: rotation.rotated ? 1 : 0, retainedGenerations: rotation.retainedGenerations,
    });
    if (rotation.rotated) await recordAnalysisRecoveryLifecycle({
      ...lifecycle, operation: 'generation-rotate', result: 'rotated', reason: lifecycleReason,
      generation: 1, retainedGenerations: rotation.retainedGenerations,
    });
    return { jsonPath, lastSuccessJsonPath, promptPath };
  }));
  if (!transaction.admitted) {
    await recordAnalysisRecoveryLifecycle({
      operation: 'snapshot-save', result: 'retired', reason: transaction.reason || 'operation-superseded',
      canvasFilePath: snapshot.canvasFilePath, ownerId: jobAnalysisSnapshotOwner(snapshot), runId: snapshot.runId,
      recoveryMode: snapshot?.snapshotContext?.recoveryMode,
    });
    return { retired: true, reason: transaction.reason || 'operation-superseded', jsonPath, lastSuccessJsonPath, promptPath };
  }
  return transaction.value;
}

export function classifySnapshotExactOwnership(snapshot, canvasFilePath, nodeId) {
  const owner = normalizeJobAnalysisIdentifier(nodeId);
  if (!owner || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 'ownership-invalid';
  const savedCanvas = typeof canvasFilePath === 'string' && canvasFilePath.trim();
  const rawOwners = [
    snapshot?.sourceHubId,
    snapshot?.nodeId,
    snapshot?.snapshotContext?.sourceHubId,
    snapshot?.snapshotContext?.nodeId,
  ];
  if (rawOwners.some(value => value != null && (typeof value !== 'string' || !normalizeJobAnalysisIdentifier(value)))) {
    return 'ownership-invalid';
  }
  const owners = [...new Set(rawOwners.filter(value => typeof value === 'string').map(value => value.trim()))];
  if (owners.length === 0 || owners.length > 1) return 'ownership-invalid';

  const rawCanvases = [snapshot?.canvasFilePath, snapshot?.snapshotContext?.canvasFilePath];
  if (rawCanvases.some(value => value != null && (typeof value !== 'string' || !value.trim()))) {
    return 'ownership-invalid';
  }
  const canvases = [...new Set(rawCanvases.filter(value => typeof value === 'string').map(value => path.resolve(value)))];
  if (canvases.length > 1) return 'ownership-invalid';
  if (savedCanvas) {
    // Saved-canvas records, including legacy ones, must embed the exact canvas.
    if (canvases.length === 0) return 'ownership-invalid';
    if (canvases[0] !== path.resolve(canvasFilePath)) return 'ownership-mismatch';
  } else if (canvases.length > 0) {
    return 'ownership-mismatch';
  }
  return owners[0] === owner ? 'owned' : 'ownership-mismatch';
}

export async function readAnalysisArtifact(filePath) {
  const maxBytes = MAX_JOB_ANALYSIS_ARTIFACT_BYTES;
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlocking = fs.constants.O_NONBLOCK;
  let handle = null;
  try {
    if (!Number.isInteger(noFollow) || !Number.isInteger(nonBlocking)) throw new Error('safe artifact reads unavailable');
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 0 || before.size > maxBytes) throw new Error('unsafe analysis artifact');
    const serialized = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || Buffer.byteLength(serialized) !== before.size) {
      throw new Error('analysis artifact changed while read');
    }
    return {
      state: 'present', snapshot: JSON.parse(serialized), serialized,
      identity: { dev: before.dev, ino: before.ino, size: before.size },
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', snapshot: null };
    return { state: 'invalid', snapshot: null, error };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeAnalysisArtifactIfUnchanged(filePath, identity) {
  try {
    const current = await fs.promises.lstat(filePath);
    if (!current.isFile() || current.isSymbolicLink()
      || current.dev !== identity?.dev || current.ino !== identity?.ino || current.size !== identity?.size) {
      return { state: 'changed', cleared: false };
    }
    await fs.promises.unlink(filePath);
    return { state: 'cleared', cleared: true, method: 'delete' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', cleared: false };
    return { state: 'error', cleared: false, error: error?.message || String(error) };
  }
}

async function removeAnalysisArtifact(filePath, trashItem = null, verifyRemoval = fs.promises.access) {
  try {
    if (trashItem) await trashItem(filePath);
    else await fs.promises.unlink(filePath);
  } catch (error) {
    // An external cleaner can win the narrow read→trash/unlink race. ENOENT
    // is a successful no-op only after a fresh absence check; if a new artifact
    // appeared in that interval, keep the cleanup failure visible rather than
    // claiming it was removed.
    if (error?.code === 'ENOENT') {
      try {
        await verifyRemoval(filePath);
        return { state: 'error', cleared: false, error: 'artifact-still-exists' };
      } catch (verifyError) {
        if (verifyError?.code === 'ENOENT') {
          return { state: 'missing', cleared: false, method: 'already-missing' };
        }
        return { state: 'error', cleared: false, error: verifyError?.message || String(verifyError) };
      }
    }
    return { state: 'error', cleared: false, error: error?.message || String(error) };
  }
  try {
    await verifyRemoval(filePath);
    return { state: 'error', cleared: false, error: 'artifact-still-exists' };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { state: 'cleared', cleared: true, method: trashItem ? 'trash' : 'delete' };
    }
    return { state: 'error', cleared: false, error: error?.message || String(error) };
  }
}

/**
 * Discard only the analysis bundle whose embedded canvas and hub ownership
 * match. The filenames are canvas-scoped, not hub-scoped, so ownership must be
 * proven from the JSON before deleting any artifact. This shares the writer
 * lock with saveJobAnalysisSnapshot; matching run IDs are retired before their
 * files are removed, preventing a delayed same-run save from resurrecting them.
 */
export async function discardJobAnalysisSnapshot(canvasFilePath, nodeId, { trashItem = null, runId = null, clearedAt = null, fallbackDir = null, verifyRemoval = fs.promises.access, lifecycleReason = 'career-data-clear' } = {}) {
  const owner = normalizeJobAnalysisIdentifier(nodeId);
  const nodeProvided = nodeId != null && nodeId !== '';
  const savedCanvas = typeof canvasFilePath === 'string' && canvasFilePath.trim()
    ? canvasFilePath
    : null;
  // Null is the one intentional unsaved-canvas sentinel. In particular,
  // undefined and blank strings must not select the private fallback bundle.
  const unsavedCanvas = canvasFilePath === null;
  const requestedRunId = runId == null || runId === '' ? null : normalizeJobAnalysisIdentifier(runId);
  const requestedClearedAt = normalizeJobAnalysisClearBoundary(clearedAt);
  const artifacts = {
    current: { state: 'missing', cleared: false },
    lastSuccess: { state: 'missing', cleared: false },
    lastSuccessGeneration2: { state: 'missing', cleared: false },
    lastSuccessGeneration3: { state: 'missing', cleared: false },
    prompt: { state: 'missing', cleared: false },
    legacyCanvasCurrent: { state: 'missing', cleared: false },
    legacyCanvasLastSuccess: { state: 'missing', cleared: false },
    legacyCanvasPrompt: { state: 'missing', cleared: false },
    legacyCurrent: { state: 'missing', cleared: false },
    legacyLastSuccess: { state: 'missing', cleared: false },
    legacyPrompt: { state: 'missing', cleared: false },
  };
  if (!owner) {
    return { ok: false, cleared: false, reason: nodeProvided ? 'invalid-node-id' : 'missing-ownership', artifacts };
  }
  if (!savedCanvas && !unsavedCanvas) {
    return { ok: false, cleared: false, reason: 'invalid-canvas-path', artifacts };
  }
  if (runId != null && runId !== '' && !requestedRunId) {
    return { ok: false, cleared: false, reason: 'invalid-run-id', artifacts };
  }
  if (clearedAt != null && requestedClearedAt == null) {
    return { ok: false, cleared: false, reason: 'invalid-clear-boundary', artifacts };
  }
  const paths = analysisPathsForCanvas(savedCanvas, fallbackDir, owner);

  return withJobAnalysisSnapshotLock(paths.jsonPath, async () => {
    let effectiveRequestedClearedAt = requestedClearedAt;
    if (requestedRunId || requestedClearedAt != null) {
      const retirement = retireJobAnalysisSnapshot(savedCanvas, { sourceHubId: owner, runId: requestedRunId }, requestedClearedAt);
      effectiveRequestedClearedAt = retirement?.clearedAt ?? requestedClearedAt;
    }
    const entries = [
      ['current', paths.jsonPath, 'prompt', paths.promptPath],
      ['lastSuccess', paths.lastSuccessJsonPath, 'prompt', paths.promptPath],
      ...(paths.lastSuccessJsonPaths || []).slice(1).map((filePath, index) => [
        `lastSuccessGeneration${index + 2}`, filePath, 'prompt', paths.promptPath,
      ]),
      ['legacyCanvasCurrent', paths.legacyCanvasJsonPath, 'legacyCanvasPrompt', paths.legacyCanvasPromptPath],
      ['legacyCanvasLastSuccess', paths.legacyCanvasLastSuccessJsonPath, 'legacyCanvasPrompt', paths.legacyCanvasPromptPath],
      ['legacyCurrent', paths.legacyJsonPath, 'legacyPrompt', paths.legacyPromptPath],
      ['legacyLastSuccess', paths.legacyLastSuccessJsonPath, 'legacyPrompt', paths.legacyPromptPath],
    ];
    let failure = false;
    const removable = [];
    const promptCandidates = new Map();
    const preservedPromptCandidates = new Map();
    const ambiguousPromptCandidates = new Map();
    // Inspect every physical prompt path even when both of its JSON companions
    // are absent. An orphan prompt can still hold the cleared hub's profile and
    // scoring evidence; treating the initialized artifact state as "missing"
    // without reading it would silently leave that material resumable.
    const promptPaths = new Map([
      ['prompt', paths.promptPath],
      ['legacyCanvasPrompt', paths.legacyCanvasPromptPath],
      ['legacyPrompt', paths.legacyPromptPath],
    ].filter(([, promptPath]) => !!promptPath));

    const addPromptCandidate = (target, promptKey, promptPath, snapshot, state = null) => {
      if (!promptPath || !promptKey) return;
      const candidates = target.get(promptKey) || { promptPath, snapshots: [] };
      candidates.snapshots.push({ snapshot, state });
      target.set(promptKey, candidates);
    };

    for (const [key, filePath, promptKey, promptPath] of entries) {
      if (!filePath) continue;
      const read = await readAnalysisArtifact(filePath);
      if (read.state !== 'present') {
        artifacts[key] = { state: read.state, cleared: false };
        if (read.state === 'invalid') {
          failure = true;
          if (promptPath && promptKey) ambiguousPromptCandidates.set(promptKey, { promptPath });
        }
        continue;
      }
      const ownership = classifySnapshotExactOwnership(read.snapshot, canvasFilePath, owner);
      if (ownership !== 'owned') {
        artifacts[key] = { state: ownership, cleared: false };
        if (ownership === 'ownership-invalid') {
          failure = true;
          if (promptPath && promptKey) ambiguousPromptCandidates.set(promptKey, { promptPath });
        }
        if (ownership === 'ownership-mismatch') {
          addPromptCandidate(preservedPromptCandidates, promptKey, promptPath, read.snapshot, 'foreign-paired');
        }
        continue;
      }

      const createdAt = snapshotCreatedAtMs(read.snapshot);
      const snapshotRunId = normalizeJobAnalysisIdentifier(read.snapshot?.runId);
      const exactRetiredRun = !!(requestedRunId && snapshotRunId === requestedRunId);
      // A caller that predates the boundary contract keeps the historic
      // clear-all-owned behavior. Modern renderer clears provide a boundary,
      // so an already-written newer run is never mistaken for stale run A.
      // The exact requested run is authoritative provenance in either
      // direction: its own timestamp cannot make it survive its clear, while
      // timestamp protection remains mandatory for every different/new run.
      if (effectiveRequestedClearedAt != null && !exactRetiredRun) {
        if (createdAt == null) {
          artifacts[key] = { state: 'created-at-invalid', cleared: false };
          failure = true;
          if (promptPath && promptKey) ambiguousPromptCandidates.set(promptKey, { promptPath });
          continue;
        }
        if (createdAt > effectiveRequestedClearedAt) {
          artifacts[key] = { state: 'post-clear', cleared: false };
          addPromptCandidate(preservedPromptCandidates, promptKey, promptPath, read.snapshot, 'post-clear-paired');
          continue;
        }
        if (createdAt === effectiveRequestedClearedAt) {
          if (snapshotRunId && requestedRunId) {
            artifacts[key] = { state: 'post-clear', cleared: false };
            addPromptCandidate(preservedPromptCandidates, promptKey, promptPath, read.snapshot, 'post-clear-paired');
            continue;
          }
          artifacts[key] = { state: 'run-id-invalid', cleared: false };
          failure = true;
          if (promptPath && promptKey) ambiguousPromptCandidates.set(promptKey, { promptPath });
          continue;
        }
      }
      if (!requestedRunId && requestedClearedAt == null) retireJobAnalysisSnapshot(canvasFilePath, read.snapshot);
      removable.push({ key, filePath });
      addPromptCandidate(promptCandidates, promptKey, promptPath, read.snapshot);
    }

    // A prompt has no independent owner metadata. It may pair with either the
    // current or last-success JSON; delete it only when its full contents bind
    // it to one owned stale record, never merely because a sibling is absent.
    const promptKeys = new Set([
      ...promptPaths.keys(),
      ...promptCandidates.keys(),
      ...preservedPromptCandidates.keys(),
      ...ambiguousPromptCandidates.keys(),
    ]);
    for (const promptKey of promptKeys) {
      const { promptPath } = promptCandidates.get(promptKey)
        || preservedPromptCandidates.get(promptKey)
        || ambiguousPromptCandidates.get(promptKey)
        || { promptPath: promptPaths.get(promptKey) };
      // A malformed or internally contradictory JSON companion prevents us
      // from proving which hub owns the shared prompt. Prompt text deliberately
      // omits owner/run metadata and can be byte-identical across hubs, so even
      // a matching owned stale sibling must not authorize deletion here.
      if (ambiguousPromptCandidates.has(promptKey)) {
        const promptRead = await readAnalysisArtifact(promptPath);
        artifacts[promptKey] = {
          state: promptRead.state === 'missing' ? 'missing' : 'ownership-ambiguous',
          cleared: false,
        };
        if (promptRead.state !== 'missing') failure = true;
        continue;
      }
      // The prompt format intentionally omits owner/run IDs, so snapshots with
      // different owners can legitimately produce the same prompt bytes. A
      // retained current/new snapshot therefore has first claim on a matching
      // shared prompt even when an owned stale sibling matches it as well.
      let preservedState = null;
      for (const { snapshot, state } of (preservedPromptCandidates.get(promptKey)?.snapshots || [])) {
        if (await verifiedPromptPathForSnapshot(promptPath, snapshot)) {
          preservedState = state;
          break;
        }
      }
      if (preservedState) {
        artifacts[promptKey] = { state: preservedState, cleared: false };
        continue;
      }

      let paired = false;
      for (const { snapshot } of (promptCandidates.get(promptKey)?.snapshots || [])) {
        if (await verifiedPromptPathForSnapshot(promptPath, snapshot)) {
          paired = true;
          break;
        }
      }
      if (paired) {
        artifacts[promptKey] = await removeAnalysisArtifact(promptPath, trashItem, verifyRemoval);
        if (artifacts[promptKey].state === 'error') failure = true;
      } else {
        const promptRead = await readAnalysisArtifact(promptPath);
        artifacts[promptKey] = {
          state: promptRead.state === 'missing' ? 'missing' : 'unpaired',
          cleared: false,
        };
        if (promptRead.state !== 'missing') failure = true;
      }
    }
    for (const { key, filePath } of removable) {
      artifacts[key] = await removeAnalysisArtifact(filePath, trashItem, verifyRemoval);
      if (artifacts[key].state === 'error') failure = true;
    }

    const cleared = Object.values(artifacts).some(artifact => artifact.cleared);
    const result = {
      ok: !failure,
      cleared,
      retiredRun: !!requestedRunId,
      reason: failure ? 'cleanup-failed' : null,
      artifacts,
    };
    // This receipt deliberately outlives every snapshot generation and its
    // prompt. It proves an explicit career-data clear (or partial failure),
    // rather than making a later report guess that re-analysis erased data.
    await recordAnalysisRecoveryLifecycle({
      operation: 'discard', result: failure ? 'partial' : 'discarded',
      reason: lifecycleReason === 'career-data-clear' ? 'career-data-clear' : 'run-discard',
      canvasFilePath, ownerId: owner, runId: requestedRunId,
      discardedArtifacts: Object.values(artifacts).filter(artifact => artifact?.cleared === true).length,
    });
    return result;
  });
}

export async function __discardJobAnalysisSnapshotForTests(canvasFilePath, nodeId, options = {}) {
  return discardJobAnalysisSnapshot(canvasFilePath, nodeId, options);
}

export function authorityReceiptMatches(left, right) {
  return sameJobAnalysisOperationAuthority(left, right);
}

function scopedPublicationFor(record, slot, serialized, authority) {
  const digest = jobAnalysisArtifactDigest(serialized);
  return [record?.publications?.[slot], record?.pendingPublications?.[slot]]
    .find(publication => publication?.digest === digest && authorityReceiptMatches(publication.receipt, authority)) || null;
}

export function scopedPublicationMatches(record, slot, serialized, authority) {
  return !!scopedPublicationFor(record, slot, serialized, authority);
}

/**
 * Board Cancel is rollback, not Clear career data.  Retire only sealed files
 * proven to be from the exact cancelled run/receipt, under the same durable
 * authority lock writers use.  In particular, never advance the authority
 * revision or erase success generations from another operation.
 */
export async function discardCancelledBoardRunArtifacts(canvasFilePath, nodeId, runId, operationAuthority) {
  const authority = jobAnalysisOperationAuthorityReceipt(operationAuthority);
  const owner = normalizeJobAnalysisIdentifier(nodeId);
  const exactRunId = normalizeJobAnalysisIdentifier(runId);
  if (!canvasFilePath || !owner || !exactRunId || !authority
    || authority.semanticBase?.careerSnapshotId == null) {
    return { ok: false, cleared: false, operationAuthorityMismatch: true };
  }
  // A semantic run id is optional for downstream/reanalysis operations. The
  // embedded, sealed artifact run is therefore the deletion target; when the
  // semantic record does name a run it must agree exactly.
  if (authority.semanticBase.runId != null && authority.semanticBase.runId !== exactRunId) {
    return { ok: false, cleared: false, operationAuthorityMismatch: true };
  }
  const paths = analysisPathsForCanvas(canvasFilePath, null, owner);
  const slotFiles = [
    ['current', paths.jsonPath],
    ...((paths.lastSuccessJsonPaths || []).map((filePath, index) => [`success:${index + 1}`, filePath])),
  ];
  const admitted = await withCurrentJobAnalysisOperationAuthority({
    canvasFilePath, hubId: owner, ...authority, allowRevoked: true,
  }, async (record) => withJobAnalysisSnapshotLock(paths.jsonPath, async () => {
    const artifacts = {};
    const retirePublications = [];
    let failure = false;
    for (const [slot, filePath] of slotFiles) {
      const read = await readAnalysisArtifact(filePath);
      if (read.state === 'missing') { artifacts[slot] = { state: 'missing', cleared: false }; continue; }
      if (read.state !== 'present') { artifacts[slot] = { state: 'unsafe-or-invalid', cleared: false }; failure = true; continue; }
      const snapshot = read.snapshot;
      const sealed = classifySnapshotExactOwnership(snapshot, canvasFilePath, owner) === 'owned'
        && normalizeJobAnalysisIdentifier(snapshot?.runId) === exactRunId
        && snapshot?.careerSnapshotId === authority.semanticBase.careerSnapshotId
        && authorityReceiptMatches(snapshotOperationAuthority(snapshot), authority)
        && scopedPublicationMatches(record, slot, read.serialized, authority);
      if (!sealed) { artifacts[slot] = { state: 'not-exact-cancelled-artifact', cleared: false }; continue; }
      const removal = await removeAnalysisArtifactIfUnchanged(filePath, read.identity);
      artifacts[slot] = removal;
      if (removal.cleared) retirePublications.push(slot);
      else if (removal.state !== 'missing') failure = true;
    }
    // The matching run ledger is part of the same authority transaction. It
    // may be absent after a crash; that is an idempotent success, never a
    // reason to reach into another hub's scoped manifest.
    const runCleanup = await discardOwnedJobRun(canvasFilePath, owner, exactRunId, {
      skipCheckpointCleanup: true,
    });
    if (runCleanup?.ok !== true) failure = true;
    return {
      value: {
        ok: !failure,
        cleared: retirePublications.length > 0 || runCleanup?.cleared === true,
        artifacts,
        runCleanup,
        retiredRun: exactRunId,
      },
      retirePublications,
    };
  }));
  if (!admitted.admitted) return { ok: false, cleared: false, operationAuthorityMismatch: true, operationSuperseded: true };
  const result = admitted.value;
  // Checkpoint/continuation cleanup uses their independently persisted exact
  // tuples.  It runs only after the authority transaction releases its lock,
  // avoiding inverted authority→artifact lock acquisition.
  if (result?.ok === true) {
    const checkpoint = await removeDescriptionRecoveryCheckpoint(canvasFilePath, owner, exactRunId);
    const continuations = await mutatePersistedRunContinuations({
      canvasFilePath, nodeId: owner, parentRunId: exactRunId, mode: 'clear',
      allowRevokedExactAuthority: true,
    });
    if (checkpoint?.reason === 'cleanup-failed' || continuations?.ok !== true) {
      return { ...result, ok: false, checkpointCleanup: checkpoint, continuationCleanup: continuations };
    }
    return { ...result, checkpointCleanup: checkpoint, continuationCleanup: continuations };
  }
  return result;
}

export async function __discardCancelledBoardRunArtifactsForTests(canvasFilePath, nodeId, runId, authority) {
  return discardCancelledBoardRunArtifacts(canvasFilePath, nodeId, runId, authority);
}

export async function __saveJobAnalysisSnapshotForTests(snapshot, { allowLegacyFixtureUpgrade = false } = {}) {
  // The production-shaped seam rejects a missing receipt. Historical fixtures
  // can opt into a real claim/publication transaction through the private
  // test-only option; neither production IPC nor direct authority tests may
  // silently upgrade an unauthorised snapshot.
  if (!snapshotOperationAuthority(snapshot)) {
    if (!allowLegacyFixtureUpgrade) {
      return { retired: true, reason: 'missing-operation-authority' };
    }
    const nodeId = jobAnalysisSnapshotOwner(snapshot);
    const canvasFilePath = typeof snapshot?.canvasFilePath === 'string' && snapshot.canvasFilePath.trim()
      ? snapshot.canvasFilePath
      : null;
    const runId = snapshot?.runId == null ? null : normalizeJobAnalysisIdentifier(snapshot?.runId);
    if (!nodeId || !canvasFilePath || (snapshot?.runId != null && !runId)) {
      return { retired: true, reason: 'missing-fixture-ownership' };
    }
    const careerSnapshotId = typeof snapshot?.careerSnapshotId === 'string' && /^[a-f0-9]{64}$/.test(snapshot.careerSnapshotId)
      ? snapshot.careerSnapshotId
      : 'a'.repeat(64);
    const analysisRevisionId = normalizeJobAnalysisIdentifier(snapshot?.snapshotContext?.analysisRevisionId);
    const operationId = `test-snapshot-${crypto.createHash('sha256')
      .update(`${canvasFilePath}\u0000${nodeId}\u0000${runId || ''}\u0000${analysisRevisionId || ''}`)
      .digest('hex').slice(0, 24)}`;
    const claimed = await claimJobAnalysisOperationAuthority({
      canvasFilePath,
      hubId: nodeId,
      operationId,
      semanticBase: {
        kind: 'test-snapshot', careerSnapshotId, runId, analysisRevisionId,
        fingerprint: null, continuationId: null, sourceArtifactFingerprint: null,
      },
    });
    if (!claimed.admitted) return { retired: true, reason: claimed.reason || 'operation-superseded' };
    snapshot = { ...snapshot, careerSnapshotId, operationAuthority: claimed.receipt };
  }
  return saveJobAnalysisSnapshot(snapshot);
}

export function __getJobAnalysisRetirementStateForTests() {
  return { ownerBoundaries: _retiredJobAnalysisSnapshots.size };
}

function hasExactDescriptionRecoveryOwnership(snapshot, nodeId, jobRunId) {
  return !!nodeId && !!jobRunId
    && snapshot?.sourceHubId === nodeId
    && snapshot?.nodeId === nodeId
    && snapshot?.runId === jobRunId;
}

// Deletion can arrive while the pre-score IPC is still writing the ordinary
// canvas-global analysis bundle, before it has queued its checkpoint write. A
// path lock alone cannot order an operation that has not reached the lock yet,
// so retain an exact-tuple tombstone for the lifetime of this process. Run IDs
// are unique, and evicting old entries by count would reopen the race for an
// unusually delayed writer. The eventual create observes the tombstone under
// the same checkpoint lock and cannot resurrect the deleted run.
const _retiredDescriptionRecoveryCheckpoints = new Set();

function descriptionRecoveryRetirementKey(checkpointPath, nodeId, jobRunId) {
  return `${checkpointPath || ''}\u0000${String(nodeId || '')}\u0000${String(jobRunId || '')}`;
}

function retireDescriptionRecoveryCheckpoint(checkpointPath, nodeId, jobRunId) {
  const key = descriptionRecoveryRetirementKey(checkpointPath, nodeId, jobRunId);
  _retiredDescriptionRecoveryCheckpoints.add(key);
}

export async function saveDescriptionRecoveryCheckpoint(snapshot, { create = false, stagePublication: suppliedStagePublication = null } = {}) {
  const checkpointPath = descriptionRecoveryCheckpointPath(snapshot?.canvasFilePath, snapshot?.runId);
  if (!checkpointPath || !hasExactDescriptionRecoveryOwnership(snapshot, snapshot?.nodeId, snapshot?.runId)) {
    return { saved: false, reason: 'missing-ownership', checkpointPath: null };
  }
  const authority = snapshotOperationAuthority(snapshot);
  const writeCheckpoint = stagePublication => withJobAnalysisSnapshotLock(checkpointPath, async () => {
    // A hash-keyed filename is not itself authority: retain the full ownership
    // check so a malformed caller can never poison a different run's sidecar.
    if (!hasExactDescriptionRecoveryOwnership(snapshot, snapshot.nodeId, snapshot.runId)) {
      return { saved: false, reason: 'missing-ownership', checkpointPath };
    }
    // A terminal cleanup can retire this exact tuple while a long-running
    // Solve is waiting for this lock.  Check for retirement for both create
    // and update writes: otherwise an already-open update could recreate an
    // old checkpoint after a successful newer terminal run has superseded it.
    if (_retiredDescriptionRecoveryCheckpoints.has(
      descriptionRecoveryRetirementKey(checkpointPath, snapshot.nodeId, snapshot.runId),
    )) {
      return { saved: false, reason: 'checkpoint-retired', checkpointPath };
    }
    if (!create) {
      let existing;
      try {
        existing = JSON.parse(await fs.promises.readFile(checkpointPath, 'utf8'));
      } catch (error) {
        return { saved: false, reason: error?.code === 'ENOENT' ? 'checkpoint-unavailable' : 'checkpoint-invalid', checkpointPath };
      }
      if (!hasExactDescriptionRecoveryOwnership(existing, snapshot.nodeId, snapshot.runId)) {
        return { saved: false, reason: 'ownership-mismatch', checkpointPath };
      }
    }
    await fs.promises.mkdir(path.dirname(checkpointPath), { recursive: true });
    // Reuse the snapshot writer's first-property `reportMetadata` envelope.
    // The payload is still the exact recovery snapshot, but a bounded reader
    // can now establish safe ownership/count metadata without parsing its job
    // bodies when a normal checkpoint grows past 512 KiB.
    const content = serializeJobAnalysisSnapshot(snapshot);
    const token = path.basename(checkpointPath).match(/description-recovery-([a-f0-9]{24})\.json$/)?.[1];
    if (!token) return { saved: false, reason: 'checkpoint-path-invalid', checkpointPath };
    await stagePublication({ publications: [{ slot: `checkpoint:${token}`, digest: jobAnalysisArtifactDigest(content) }] });
    await writeJobAnalysisFileAtomically(checkpointPath, content, { mode: 0o600 });
    return { saved: true, checkpointPath };
  });
  if (suppliedStagePublication) return writeCheckpoint(suppliedStagePublication);
  const transaction = await withCurrentJobAnalysisOperationAuthority({
    canvasFilePath: snapshot.canvasFilePath, hubId: snapshot.nodeId, ...authority,
  }, (_authority, stagePublication) => writeCheckpoint(stagePublication));
  return transaction.admitted
    ? transaction.value
    : { saved: false, reason: transaction.reason || 'operation-superseded', checkpointPath };
}

export async function loadDescriptionRecoveryCheckpoint(canvasFilePath, nodeId, jobRunId) {
  const checkpointPath = descriptionRecoveryCheckpointPath(canvasFilePath, jobRunId);
  if (!checkpointPath) throw Object.assign(new Error('No run-keyed description recovery checkpoint.'), { code: 'ENOENT' });
  let snapshot;
  let serialized;
  try {
    serialized = await fs.promises.readFile(checkpointPath, 'utf8');
    snapshot = JSON.parse(serialized);
  } catch (error) {
    throw Object.assign(error, { checkpointPath });
  }
  if (!hasExactDescriptionRecoveryOwnership(snapshot, nodeId, jobRunId)) {
    throw Object.assign(new Error('Description recovery checkpoint ownership mismatch.'), {
      code: 'EOWNERSHIP', checkpointPath,
    });
  }
  const checkpointToken = path.basename(checkpointPath).match(/description-recovery-([a-f0-9]{24})\.json$/)?.[1] || null;
  if (!checkpointToken || !await hasPublishedSnapshotOperationAuthority(snapshot, `checkpoint:${checkpointToken}`, serialized)) {
    throw Object.assign(new Error('Description recovery checkpoint belongs to a superseded operation.'), {
      code: 'EOPERATION', checkpointPath,
    });
  }
  return { snapshot, origin: 'current', checkpointPath };
}

export async function removeDescriptionRecoveryCheckpoint(canvasFilePath, nodeId, jobRunId) {
  const checkpointPath = descriptionRecoveryCheckpointPath(canvasFilePath, jobRunId);
  // A run token is not sufficient authority for destructive cleanup. It is
  // generated client-side and, while collisions are unlikely, a delayed or
  // misrouted terminal IPC must never be able to erase another hub's
  // checkpoint. Require the same hub+run tuple used for every read/update.
  if (!checkpointPath || !nodeId || !jobRunId) {
    return { removed: false, reason: 'missing-ownership' };
  }
  const removal = await withJobAnalysisSnapshotLock(checkpointPath, async () => {
    // Mark retirement before checking whether the file exists. The matching
    // pre-score create may still be awaiting the canvas-global snapshot write;
    // when it eventually reaches this lock it must fail closed.
    retireDescriptionRecoveryCheckpoint(checkpointPath, nodeId, jobRunId);
    try {
      const snapshot = JSON.parse(await fs.promises.readFile(checkpointPath, 'utf8'));
      const ownsCheckpoint = hasExactDescriptionRecoveryOwnership(snapshot, nodeId, jobRunId);
      if (!ownsCheckpoint) return { removed: false, reason: 'ownership-mismatch' };
      await fs.promises.unlink(checkpointPath);
      return { removed: true, checkpointPath };
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: false };
      throw error;
    }
  });
  // Keep authority retirement after releasing the artifact lock: writers take
  // authority before artifact, so reversing that order here would deadlock.
  if (removal?.removed) {
    const token = path.basename(checkpointPath).match(/description-recovery-([a-f0-9]{24})\.json$/)?.[1];
    if (token) await retireJobAnalysisOperationPublication({
      canvasFilePath, hubId: nodeId, slot: `checkpoint:${token}`,
    });
  }
  return removal;
}

function checkpointTimestamp(value) {
  const timestamp = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Date.parse(value)
      : NaN;
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

// Read just enough of a candidate to establish *exact* ownership before an
// automatic cleanup.  This is deliberately stricter than report discovery:
// an automatic delete requires the canonical canvas, the expected hash-derived
// path, and sourceHubId/nodeId equality, while diagnostics may safely describe
// a legacy bounded-prefix record as awaiting an explicit load.
async function readOwnedDescriptionRecoveryCheckpointForGc(filePath, canvasFilePath, nodeId, {
  expectedCheckpointPath = filePath,
} = {}) {
  const read = await readBoundedRegularCheckpoint(filePath);
  if (read.errorCode === 'TOO_LARGE') {
    const oversized = await oversizedCheckpointMetadata(filePath, canvasFilePath, read.size, {
      expectedCheckpointPath,
      includeIdentity: true,
    });
    const metadata = oversized?.metadata;
    if (!metadata || metadata.sourceHubId !== nodeId || metadata.nodeId !== nodeId) return null;
    // `oversizedCheckpointMetadata` has already verified its hash-derived
    // filename and canvas envelope/header. A legacy prefix can omit its
    // canvas field, but is still scoped by this saved canvas's canonical-path
    // namespace plus the exact run-hash filename; no unscoped/private-app-data
    // checkpoint reaches this terminal-success sweep. Its createdAt is the
    // only durable ordering evidence on a bounded legacy payload.
    return {
      runId: metadata.runId,
      createdAt: checkpointTimestamp(metadata.createdAt),
      updatedAt: oversized.updatedAt,
      identity: oversized.identity,
    };
  }
  if (read.errorCode) return null;
  let snapshot;
  try { snapshot = JSON.parse(read.text); } catch { return null; }
  if (!hasExactDescriptionRecoveryOwnership(snapshot, nodeId, snapshot?.runId)
    || !snapshotOwnedByCanvas(snapshot, canvasFilePath)
    || descriptionRecoveryCheckpointPath(canvasFilePath, snapshot.runId) !== expectedCheckpointPath) return null;
  return {
    runId: snapshot.runId,
    createdAt: checkpointTimestamp(snapshot.createdAt),
    updatedAt: checkpointTimestamp(read.updatedAt),
    identity: { dev: read.dev, ino: read.ino },
  };
}

function sameCheckpointIdentity(left, right) {
  return !!left && !!right
    && Number.isSafeInteger(left.dev) && Number.isSafeInteger(left.ino)
    && left.dev === right.dev && left.ino === right.ino;
}

function retiredCheckpointTombstonePath(filePath) {
  const token = crypto.randomBytes(18).toString('hex');
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.retiring-${token}`);
}

async function restoreUnverifiedCheckpointTombstone(tombstonePath, originalPath) {
  // `link` is an atomic no-replace restore. If a successor appeared while the
  // tombstone was being verified, do not overwrite it; leave the unverified
  // inode intact in the same parent for manual recovery rather than deleting
  // either object. This closes application-level rename/write races. A hostile
  // same-user process can still interleave syscalls at the filesystem layer;
  // there is no portable inode-conditional unlink in Node/POSIX.
  try {
    await fs.promises.link(tombstonePath, originalPath);
    await fs.promises.unlink(tombstonePath);
    return 'restored';
  } catch {
    return 'preserved-tombstone';
  }
}

/**
 * Retire only obsolete same-hub recovery checkpoints after a newer run has
 * durably completed. This is intentionally terminal-success-only: at run
 * start, a prior checkpoint can still be the user's only recoverable state.
 * Directory/candidate caps make this a bounded best-effort sweep, not an
 * exhaustive garbage collector; a later terminal completion can sweep a
 * different bounded window without risking an unbounded UI IPC.
 *
 * A candidate must prove all of the following under its own writer lock:
 * - canonical canvas + hash-derived run path;
 * - exact sourceHubId/nodeId ownership;
 * - a creation time strictly before the completed run started; and
 * - no write at/after the completed run's terminal receipt.
 *
 * The last condition is conservative by design. It preserves a concurrently
 * created/new checkpoint even if a legacy payload carries an old createdAt.
 */
export async function pruneSupersededDescriptionRecoveryCheckpoints(canvasFilePath, nodeId, terminalRunId, {
  terminalStartedAt = null,
  terminalCompletedAt = null,
} = {}) {
  const startedAt = checkpointTimestamp(terminalStartedAt);
  const completedAt = checkpointTimestamp(terminalCompletedAt);
  if (!canvasFilePath || !nodeId || !terminalRunId || !startedAt || !completedAt) {
    return { scanned: 0, removed: 0, preserved: 0, errors: 0, skipped: 'missing-terminal-ordering' };
  }
  const paths = analysisPathsForCanvas(canvasFilePath);
  const prefix = descriptionRecoveryCheckpointPrefix(canvasFilePath);
  let handle;
  try {
    handle = await fs.promises.opendir(paths.dir, { bufferSize: 16 });
  } catch (error) {
    if (error?.code === 'ENOENT') return { scanned: 0, removed: 0, preserved: 0, errors: 0 };
    return { scanned: 0, removed: 0, preserved: 0, errors: 1 };
  }
  const result = { scanned: 0, removed: 0, preserved: 0, errors: 0 };
  try {
    for (let inspected = 0; inspected < MAX_DESCRIPTION_RECOVERY_CHECKPOINT_DIRECTORY_ENTRIES; inspected += 1) {
      const entry = await handle.read();
      if (!entry) break;
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) continue;
      if (result.scanned >= MAX_DESCRIPTION_RECOVERY_CHECKPOINT_CANDIDATES) break;
      result.scanned += 1;
      const filePath = path.join(paths.dir, entry.name);
      const initial = await readOwnedDescriptionRecoveryCheckpointForGc(filePath, canvasFilePath, nodeId);
      if (!initial || initial.runId === terminalRunId || initial.createdAt == null || initial.createdAt >= startedAt) {
        result.preserved += 1;
        continue;
      }
      try {
        const removed = await withJobAnalysisSnapshotLock(filePath, async () => {
          // Re-read under the same lock used by checkpoint writes. A newer
          // checkpoint that won the race is preserved rather than judged from
          // its predecessor's metadata.
          const current = await readOwnedDescriptionRecoveryCheckpointForGc(filePath, canvasFilePath, nodeId);
          if (!current
            || current.runId === terminalRunId
            || current.createdAt == null
            || current.createdAt >= startedAt
            || current.updatedAt == null
            || current.updatedAt >= completedAt
            || !sameCheckpointIdentity(current.identity, initial.identity)) return false;
          const tombstonePath = retiredCheckpointTombstonePath(filePath);
          try {
            // A same-parent rename removes the public name atomically. We do
            // not retire the tuple yet: a substitution just before this rename
            // lands in the tombstone and must be restored, never deleted. A
            // process crash between rename and unlink can leave this uniquely
            // named, same-parent tombstone behind; it remains intact (never
            // retired/deleted) as a bounded best-effort cleanup residual.
            await fs.promises.rename(filePath, tombstonePath);
          } catch {
            return false;
          }
          const retired = await readOwnedDescriptionRecoveryCheckpointForGc(
            tombstonePath,
            canvasFilePath,
            nodeId,
            { expectedCheckpointPath: filePath },
          );
          if (!retired
            || retired.runId !== current.runId
            || retired.createdAt !== current.createdAt
            || retired.updatedAt == null
            || retired.updatedAt >= completedAt
            || !sameCheckpointIdentity(retired.identity, current.identity)) {
            await restoreUnverifiedCheckpointTombstone(tombstonePath, filePath);
            return false;
          }
          // The writer lock remains held until this callback returns, so a
          // queued writer cannot recreate the run between unlink and retirement.
          // Do not tombstone the tuple until the inode is actually gone: if a
          // filesystem unlink fails, restore/preserve it rather than hiding an
          // undeleted `.retiring-*` file behind a permanent in-memory block.
          try {
            await fs.promises.unlink(tombstonePath);
          } catch {
            await restoreUnverifiedCheckpointTombstone(tombstonePath, filePath);
            return false;
          }
          retireDescriptionRecoveryCheckpoint(filePath, nodeId, retired.runId);
          return true;
        });
        if (removed) {
          result.removed += 1;
          const token = entry.name.match(/description-recovery-([a-f0-9]{24})\.json$/)?.[1];
          if (token) await retireJobAnalysisOperationPublication({
            canvasFilePath, hubId: nodeId, slot: `checkpoint:${token}`,
          });
        }
        else result.preserved += 1;
      } catch {
        // A stale checkpoint is maintenance-only after a terminal success.
        // Never turn a valid completed application/search into an error state
        // because a filesystem cleanup could not settle.
        result.errors += 1;
      }
    }
  } finally {
    try { await handle.close(); } catch { /* descriptor already closed */ }
  }
  return result;
}

function descriptionRecoveryCheckpointMeta(snapshot, updatedAt = null) {
  // Checkpoints sit beside a user-controlled canvas. Their ownership IDs are
  // used operationally as exact opaque tokens, but the diagnostics reader must
  // never return arbitrary token text for interpolation into a Markdown report.
  // Keep this rule aligned with the terminal receipt/report token grammar.
  const safeIdentifier = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return /^[A-Za-z0-9_.:-]{1,180}$/.test(text) ? text : null;
  };
  const nonnegativeInteger = (value) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  };
  const recoveryJobs = Array.isArray(snapshot?.descriptionRecoveryJobs)
    ? snapshot.descriptionRecoveryJobs
    : (Array.isArray(snapshot?.jobs) ? snapshot.jobs : null);
  return {
    version: snapshot?.version ?? null,
    createdAt: snapshot?.createdAt ?? null,
    updatedAt: updatedAt || snapshot?.updatedAt || snapshot?.createdAt || null,
    sourceHubId: safeIdentifier(snapshot?.sourceHubId),
    nodeId: safeIdentifier(snapshot?.nodeId),
    runId: safeIdentifier(snapshot?.runId),
    gatheredJobCount: nonnegativeInteger(snapshot?.gatheredJobCount),
    sourceGatheredCount: nonnegativeInteger(snapshot?.sourceGatheredCount),
    scoreReadyCount: Array.isArray(snapshot?.jobs) ? snapshot.jobs.length : nonnegativeInteger(snapshot?.scoreReadyCount),
    descriptionRecoveryCount: recoveryJobs ? recoveryJobs.length : nonnegativeInteger(snapshot?.descriptionRecoveryCount),
  };
}

function skipJsonWhitespace(text, from) {
  let index = from;
  while (index < text.length && /[ \t\r\n]/.test(text[index])) index += 1;
  return index;
}

function jsonStringEnd(text, start) {
  if (text[start] !== '"') return -1;
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === '\\') { cursor += 1; continue; }
    if (text[cursor] === '"') return cursor;
  }
  return -1;
}

function reportMetadataPrefixObject(text) {
  if (typeof text !== 'string') return null;
  let index = 0;
  const skip = () => { index = skipJsonWhitespace(text, index); };
  const stringEnd = (start) => jsonStringEnd(text, start);
  const objectEnd = (start) => {
    if (text[start] !== '{') return -1;
    let depth = 0;
    let quoted = false;
    for (let cursor = start; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (quoted) {
        if (char === '\\') { cursor += 1; continue; }
        if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) return cursor + 1;
    }
    return -1;
  };
  skip();
  if (text[index++] !== '{') return null;
  skip();
  const keyStart = index;
  const keyEnd = stringEnd(keyStart);
  if (keyEnd < 0) return null;
  let key;
  try { key = JSON.parse(text.slice(keyStart, keyEnd + 1)); } catch { return null; }
  if (key !== 'reportMetadata') return null;
  index = keyEnd + 1;
  skip();
  if (text[index++] !== ':') return null;
  skip();
  const valueStart = index;
  const valueEnd = objectEnd(valueStart);
  if (valueEnd < 0) return null;
  try { return JSON.parse(text.slice(valueStart, valueEnd)); } catch { return null; }
}

// Read only consecutive scalar properties at the root of a JSON object. This
// is deliberately not a search: a legacy checkpoint can put an arbitrarily
// large jobs/payload object after its small header, but a lookalike field
// nested in that payload must never establish checkpoint ownership.
function rootScalarPrefixObject(text) {
  if (typeof text !== 'string') return null;
  let index = 0;
  const result = Object.create(null);
  const skip = () => { index = skipJsonWhitespace(text, index); };
  const stringEnd = (start) => jsonStringEnd(text, start);
  const parseString = () => {
    const end = stringEnd(index);
    if (end < 0) return { ok: false };
    try {
      const value = JSON.parse(text.slice(index, end + 1));
      index = end + 1;
      return { ok: true, value };
    } catch {
      return { ok: false };
    }
  };
  const scalar = () => {
    if (text[index] === '"') return parseString();
    const rest = text.slice(index);
    const literal = /^(true|false|null)(?=[\s,}])/.exec(rest);
    if (literal) {
      index += literal[1].length;
      return { ok: true, value: literal[1] === 'null' ? null : literal[1] === 'true' };
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?=[\s,}])/.exec(rest);
    if (!number) return { ok: false };
    index += number[0].length;
    return { ok: true, value: Number(number[0]) };
  };
  skip();
  if (text[index++] !== '{') return null;
  while (index < text.length) {
    skip();
    if (text[index] === '}') return result;
    const key = parseString();
    if (!key.ok || typeof key.value !== 'string' || Object.prototype.hasOwnProperty.call(result, key.value)) return null;
    skip();
    if (text[index++] !== ':') return null;
    skip();
    // Once a root collection begins, subsequent bytes can be both huge and
    // attacker-controlled. Return only the root header parsed so far.
    if (text[index] === '{' || text[index] === '[') return result;
    // A large legacy payload is commonly a root string. Its closing quote can
    // be beyond this bounded prefix; its *key* is root-scoped, but its body is
    // neither read nor trusted, so retain the preceding header only.
    if (text[index] === '"' && stringEnd(index) < 0) return result;
    const value = scalar();
    if (!value.ok) return null;
    result[key.value] = value.value;
    skip();
    if (text[index] === '}') return result;
    if (text[index++] !== ',') return null;
  }
  return null;
}

function checkpointMetadataOwnsCanvas(metadata, canvasFilePath, { allowMissing = false } = {}) {
  const hasCanvas = Object.prototype.hasOwnProperty.call(metadata, 'canvasFilePath');
  if (!hasCanvas) return allowMissing;
  if (typeof canvasFilePath !== 'string' || !canvasFilePath.trim()) return metadata.canvasFilePath == null;
  if (typeof metadata.canvasFilePath !== 'string' || !metadata.canvasFilePath.trim()) return false;
  try {
    return path.resolve(metadata.canvasFilePath) === path.resolve(canvasFilePath);
  } catch {
    return false;
  }
}

function boundedOversizedCheckpointMetadata(metadata, canvasFilePath, checkpointPath, checkpointBytes, {
  legacy = false,
  expectedCheckpointPath = checkpointPath,
} = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const safeId = value => normalizeJobAnalysisIdentifier(value);
  const sourceHubId = safeId(metadata.sourceHubId);
  const nodeId = safeId(metadata.nodeId);
  const runId = safeId(metadata.runId);
  const createdAt = typeof metadata.createdAt === 'string' && Number.isFinite(Date.parse(metadata.createdAt))
    ? metadata.createdAt
    : null;
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const gatheredJobCount = integer(metadata.gatheredJobCount);
  const scoreReadyCount = integer(metadata.candidatePoolJobCount);
  const descriptionRecoveryCount = integer(metadata.descriptionRecoveryJobCount);
  if (!sourceHubId || sourceHubId !== nodeId || !runId || !createdAt
    || !checkpointMetadataOwnsCanvas(metadata, canvasFilePath, { allowMissing: legacy })
    || (!legacy && (gatheredJobCount == null || descriptionRecoveryCount == null))
    || (!legacy && (metadata.schemaVersion !== JOB_ANALYSIS_REPORT_METADATA_VERSION || scoreReadyCount == null || gatheredJobCount > scoreReadyCount))
    || descriptionRecoveryCheckpointPath(canvasFilePath, runId) !== expectedCheckpointPath) return null;
  return {
    version: metadata.schemaVersion ?? null,
    createdAt,
    updatedAt: createdAt,
    sourceHubId,
    nodeId,
    runId,
    gatheredJobCount,
    // A legacy root header may encounter an earlier object (for example a
    // resume summary) before any count fields. Those fields are intentionally
    // unknown rather than inferred as zero; the user-authorized exact load
    // remains the point that validates the complete payload.
    sourceGatheredCount: legacy ? null : 0,
    scoreReadyCount: scoreReadyCount,
    descriptionRecoveryCount,
    state: legacy ? 'legacy-prefix' : 'metadata-only',
    actionable: true,
    checkpointBytes,
  };
}

function legacyOversizedCheckpointMetadata(text, canvasFilePath, checkpointPath, checkpointBytes, {
  expectedCheckpointPath = checkpointPath,
} = {}) {
  // Legacy checkpoint writers predate the envelope. Their root-level scalar
  // header is still enough to bind a path to its opaque run token, but the
  // result remains visibly legacy because no payload-wide count audit occurred.
  const prefix = typeof text === 'string' ? text.slice(0, MAX_DESCRIPTION_RECOVERY_CHECKPOINT_METADATA_BYTES) : '';
  const header = rootScalarPrefixObject(prefix);
  if (!header) return null;
  const string = name => typeof header[name] === 'string' ? header[name] : null;
  const count = name => Number.isSafeInteger(header[name]) && header[name] >= 0 ? header[name] : null;
  return boundedOversizedCheckpointMetadata({
    schemaVersion: null,
    ...(Object.prototype.hasOwnProperty.call(header, 'canvasFilePath') ? { canvasFilePath: header.canvasFilePath } : {}),
    sourceHubId: string('sourceHubId'),
    nodeId: string('nodeId'),
    runId: string('runId'),
    createdAt: string('createdAt'),
    gatheredJobCount: count('gatheredJobCount'),
    candidatePoolJobCount: count('candidatePoolJobCount'),
    descriptionRecoveryJobCount: count('descriptionRecoveryJobCount') ?? count('descriptionRecoveryCount'),
  }, canvasFilePath, checkpointPath, checkpointBytes, { legacy: true, expectedCheckpointPath });
}

async function oversizedCheckpointMetadata(filePath, canvasFilePath, checkpointBytes, {
  expectedCheckpointPath = filePath,
  includeIdentity = false,
} = {}) {
  const read = await readRegularCheckpointPrefix(filePath, MAX_DESCRIPTION_RECOVERY_CHECKPOINT_METADATA_BYTES);
  if (read.errorCode) return null;
  const envelope = boundedOversizedCheckpointMetadata(reportMetadataPrefixObject(read.text), canvasFilePath, filePath, checkpointBytes, { expectedCheckpointPath });
  const metadata = envelope || legacyOversizedCheckpointMetadata(read.text, canvasFilePath, filePath, checkpointBytes, { expectedCheckpointPath });
  if (!metadata) return null;
  return includeIdentity ? {
    metadata,
    identity: { dev: read.dev, ino: read.ino },
    updatedAt: checkpointTimestamp(read.updatedAt),
  } : metadata;
}

function oversizedCheckpointMetadataSync(filePath, canvasFilePath, checkpointBytes) {
  const read = readRegularCheckpointPrefixSync(filePath, MAX_DESCRIPTION_RECOVERY_CHECKPOINT_METADATA_BYTES);
  if (read.errorCode) return null;
  const envelope = boundedOversizedCheckpointMetadata(reportMetadataPrefixObject(read.text), canvasFilePath, filePath, checkpointBytes);
  return envelope || legacyOversizedCheckpointMetadata(read.text, canvasFilePath, filePath, checkpointBytes);
}

async function readRegularCheckpointPrefix(filePath, maxBytes) {
  const noFollow = fs.constants?.O_NOFOLLOW;
  const nonBlocking = fs.constants?.O_NONBLOCK;
  if (!Number.isInteger(noFollow) || !Number.isInteger(nonBlocking)) return { errorCode: 'UNSAFE_FILE' };
  let file;
  try {
    file = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
    const stat = await file.stat();
    if (!stat.isFile()) return { errorCode: 'UNSAFE_FILE' };
    const size = Math.max(0, Number(stat.size) || 0);
    const byteLength = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = byteLength > 0 ? await file.read(buffer, 0, byteLength, 0) : { bytesRead: 0 };
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      size,
      updatedAt: stat.mtime.toISOString(),
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch (error) {
    return { errorCode: error?.code === 'ENOENT' ? 'MISSING' : 'UNSAFE_FILE' };
  } finally {
    if (file) await file.close().catch(() => {});
  }
}

function readRegularCheckpointPrefixSync(filePath, maxBytes) {
  const noFollow = fs.constants?.O_NOFOLLOW;
  const nonBlocking = fs.constants?.O_NONBLOCK;
  if (!Number.isInteger(noFollow) || !Number.isInteger(nonBlocking)) return { errorCode: 'UNSAFE_FILE' };
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { errorCode: 'UNSAFE_FILE' };
    const size = Math.max(0, Number(stat.size) || 0);
    const byteLength = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(byteLength);
    const bytesRead = byteLength > 0 ? fs.readSync(fd, buffer, 0, byteLength, 0) : 0;
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), size };
  } catch (error) {
    return { errorCode: error?.code === 'ENOENT' ? 'MISSING' : 'UNSAFE_FILE' };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* descriptor already unusable */ }
    }
  }
}

export async function listDescriptionRecoveryCheckpoints(canvasFilePath) {
  const paths = analysisPathsForCanvas(canvasFilePath);
  const prefix = descriptionRecoveryCheckpointPrefix(canvasFilePath);
  let handle;
  try {
    handle = await fs.promises.opendir(paths.dir, { bufferSize: 16 });
  } catch (error) {
    if (error?.code === 'ENOENT') return {
      checkpoints: [],
      ignored: { malformed: 0, ownershipMismatch: 0, pathMismatch: 0, metadataInvalid: 0, oversized: 0, unsafe: 0 },
    };
    throw error;
  }
  const checkpoints = [];
  const ignored = { malformed: 0, ownershipMismatch: 0, pathMismatch: 0, metadataInvalid: 0, oversized: 0, unsafe: 0 };
  let candidates = 0;
  try {
    for (let scanned = 0; scanned < MAX_DESCRIPTION_RECOVERY_CHECKPOINT_DIRECTORY_ENTRIES; scanned++) {
      const entry = await handle.read();
      if (!entry) break;
      const name = entry.name;
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      if (candidates >= MAX_DESCRIPTION_RECOVERY_CHECKPOINT_CANDIDATES) break;
      candidates += 1;
      try {
        const filePath = path.join(paths.dir, name);
        const read = await readBoundedRegularCheckpoint(filePath);
      if (read.errorCode === 'TOO_LARGE') {
        const metadata = await oversizedCheckpointMetadata(filePath, canvasFilePath, read.size);
        // Prefix metadata is intentionally not a seal: no full-file digest
        // can be proven within this bounded discovery path.
        if (metadata) checkpoints.push({ ...metadata, actionable: false });
        else ignored.oversized += 1;
        continue;
      }
      if (read.errorCode) {
        if (read.errorCode !== 'MISSING') ignored.unsafe += 1;
        continue;
      }
      const snapshot = JSON.parse(read.text);
      const expectedPath = descriptionRecoveryCheckpointPath(canvasFilePath, snapshot?.runId);
      if (!hasExactDescriptionRecoveryOwnership(snapshot, snapshot?.nodeId, snapshot?.runId)) {
        ignored.ownershipMismatch += 1;
        continue;
      }
      if (expectedPath !== filePath) {
        ignored.pathMismatch += 1;
        continue;
      }
      const metadata = descriptionRecoveryCheckpointMeta(snapshot, read.updatedAt);
        if (metadata.sourceHubId && metadata.nodeId && metadata.runId) {
          const token = path.basename(filePath).match(/description-recovery-([a-f0-9]{24})\.json$/)?.[1];
          const authority = snapshotOperationAuthority(snapshot);
          const actionable = !!token && !!authority
            && await publishedJobAnalysisOperationAuthority({
              canvasFilePath, hubId: metadata.nodeId, slot: `checkpoint:${token}`,
              digest: jobAnalysisArtifactDigest(read.text), ...authority,
            })
            && await currentJobAnalysisOperationAuthority({ canvasFilePath, hubId: metadata.nodeId, ...authority });
          checkpoints.push({ ...metadata, state: 'parseable', actionable });
        }
        else ignored.metadataInvalid += 1;
      } catch {
        ignored.malformed += 1;
      }
    }
  } finally {
    try { await handle.close(); } catch { /* iterator/descriptor already closed */ }
  }
  checkpoints.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { checkpoints, ignored };
}

// Report assembly is intentionally synchronous. This mirrors the async IPC
// listing above but exposes metadata only, never checkpoint job content/paths.
async function readBoundedRegularCheckpoint(filePath, maxBytes = MAX_DESCRIPTION_RECOVERY_CHECKPOINT_BYTES) {
  const noFollow = fs.constants?.O_NOFOLLOW;
  const nonBlocking = fs.constants?.O_NONBLOCK;
  if (!Number.isInteger(noFollow) || !Number.isInteger(nonBlocking)) {
    return { errorCode: 'UNSAFE_FILE' };
  }
  let file;
  try {
    file = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
    const stat = await file.stat();
    if (!stat.isFile()) return { errorCode: 'UNSAFE_FILE' };
    const size = Math.max(0, Number(stat.size) || 0);
    if (size > maxBytes) return { errorCode: 'TOO_LARGE', size };
    const buffer = Buffer.alloc(size);
    const { bytesRead } = size > 0 ? await file.read(buffer, 0, size, 0) : { bytesRead: 0 };
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      updatedAt: stat.mtime.toISOString(),
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch (error) {
    return { errorCode: error?.code === 'ENOENT' ? 'MISSING' : 'UNSAFE_FILE' };
  } finally {
    if (file) {
      try { await file.close(); } catch { /* descriptor already unusable */ }
    }
  }
}

function readBoundedRegularCheckpointSync(filePath, maxBytes = MAX_DESCRIPTION_RECOVERY_CHECKPOINT_BYTES) {
  const noFollow = fs.constants?.O_NOFOLLOW;
  const nonBlocking = fs.constants?.O_NONBLOCK;
  // macOS and supported Linux builds expose both flags. Failing closed is
  // preferable to letting a report follow a link or block on a FIFO when a
  // future platform does not provide the required open semantics.
  if (!Number.isInteger(noFollow) || !Number.isInteger(nonBlocking)) {
    return { errorCode: 'UNSAFE_FILE' };
  }
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { errorCode: 'UNSAFE_FILE' };
    const size = Math.max(0, Number(stat.size) || 0);
    if (size > maxBytes) {
      return { errorCode: 'TOO_LARGE', size };
    }
    const buffer = Buffer.alloc(size);
    const bytesRead = size > 0 ? fs.readSync(fd, buffer, 0, size, 0) : 0;
    // Regular files can be replaced/truncated concurrently. A shorter read is
    // parseable only if it is a complete JSON document, which JSON.parse below
    // establishes; this is never a reason to retry an untrusted path.
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    return { errorCode: error?.code === 'ENOENT' ? 'MISSING' : 'UNSAFE_FILE' };
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* descriptor already unusable */ }
    }
  }
}

export function listDescriptionRecoveryCheckpointsSync(canvasFilePath) {
  const paths = analysisPathsForCanvas(canvasFilePath);
  const prefix = descriptionRecoveryCheckpointPrefix(canvasFilePath);
  const empty = () => ({
    checkpoints: [],
    ignored: { malformed: 0, ownershipMismatch: 0, pathMismatch: 0, metadataInvalid: 0, oversized: 0, unsafe: 0 },
    scanTruncated: false,
    candidateLimitReached: false,
  });
  let handle;
  try {
    handle = fs.opendirSync(paths.dir, { bufferSize: 16 });
  } catch {
    return empty();
  }
  const ignored = { malformed: 0, ownershipMismatch: 0, pathMismatch: 0, metadataInvalid: 0, oversized: 0, unsafe: 0 };
  const checkpoints = [];
  let scanTruncated = false;
  let candidateLimitReached = false;
  let candidates = 0;
  try {
    for (let scanned = 0; scanned < MAX_DESCRIPTION_RECOVERY_CHECKPOINT_DIRECTORY_ENTRIES; scanned++) {
      const entry = handle.readSync();
      if (!entry) break;
      const name = entry.name;
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      if (candidates >= MAX_DESCRIPTION_RECOVERY_CHECKPOINT_CANDIDATES) {
        candidateLimitReached = true;
        continue;
      }
      candidates += 1;
      const filePath = path.join(paths.dir, name);
      const read = readBoundedRegularCheckpointSync(filePath);
      if (read.errorCode === 'TOO_LARGE') {
        const metadata = oversizedCheckpointMetadataSync(filePath, canvasFilePath, read.size);
        if (metadata) checkpoints.push({ ...metadata, actionable: false });
        else ignored.oversized++;
        continue;
      }
      if (read.errorCode) {
        // A missing file is an ordinary read→unlink race. Do not render a
        // filename or OS error, and count every other irregular entry as an
        // unsafe sidecar rather than following it.
        if (read.errorCode !== 'MISSING') ignored.unsafe++;
        continue;
      }
      try {
        const snapshot = JSON.parse(read.text);
      if (!hasExactDescriptionRecoveryOwnership(snapshot, snapshot?.nodeId, snapshot?.runId)) {
        ignored.ownershipMismatch++;
      } else if (descriptionRecoveryCheckpointPath(canvasFilePath, snapshot.runId) !== filePath) {
        ignored.pathMismatch++;
      } else {
        // `updatedAt` comes from fstat on the no-follow descriptor above, so
        // a replacement symlink cannot affect even cosmetic report metadata.
        const metadata = descriptionRecoveryCheckpointMeta(snapshot, read.updatedAt);
        // Exact ownership can be true for opaque historic tokens containing
        // Markdown control characters. They remain a valid sidecar on disk,
        // but are not safe report metadata and must not cross this boundary.
        if (!metadata.sourceHubId || !metadata.nodeId || !metadata.runId) {
          ignored.metadataInvalid++;
        } else {
          // Synchronous report assembly cannot acquire/check the durable
          // authority sidecar without blocking or following a mutable path.
          // It may describe a parseable checkpoint, but never advertise it as
          // live-actionable; the async IPC listing proves the seal.
          checkpoints.push({ ...metadata, state: 'parseable', actionable: false });
        }
      }
      } catch {
        ignored.malformed++;
      }
    }
    // Do one bounded extra read only to disclose that the directory safety
    // ceiling was reached; never enumerate the rest merely to compute a count.
    scanTruncated = !!handle.readSync();
  } finally {
    try { handle.closeSync(); } catch { /* already closed/unusable */ }
  }
  checkpoints.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { checkpoints, ignored, scanTruncated, candidateLimitReached };
}

// A long-running Solve can outlive Reset/re-run. Re-check the *current* record
// while holding the same bundle lock immediately before writing, so an old
// recovery transaction never resurrects its snapshot over the replacement run.
export async function saveDescriptionRecoverySnapshotIfCurrent(snapshot, { nodeId, jobRunId, continuation = null, sender = null } = {}) {
  const authority = snapshotOperationAuthority(snapshot);
  const paths = analysisPathsForCanvas(
    snapshot.canvasFilePath,
    null,
    nodeId,
  );
  const { dir, jsonPath, lastSuccessJsonPath, promptPath } = paths;
  // The saved scrape's collection record is copied onto every Solve rewrite.
  // Copy it BEFORE the continuation digest below is taken: that digest must
  // name the exact bytes this save writes. Taken from the object without the
  // record, it named bytes that never reach disk, so the continuation refused
  // its own next save in the same pass ("checkpoint failed") and the recovered
  // rows were withheld from the card.
  if (!(snapshot?.collectionEvidence?.runId === snapshot?.runId && snapshot?.runId)) {
    try {
      const carried = collectionEvidenceForSnapshot(
        snapshot, null, JSON.parse(await fs.promises.readFile(jsonPath, 'utf8')),
      );
      if (carried) snapshot = { ...snapshot, collectionEvidence: carried };
    } catch { /* no readable saved scrape: the publish step reports that */ }
  }
  const publish = async (stagePublication, authorityRecord) => {
    const checkpoint = await saveDescriptionRecoveryCheckpoint(snapshot, { stagePublication });
    if (!checkpoint.saved) return checkpoint;
    return withJobAnalysisSnapshotLock(jsonPath, async () => {
    let current;
    try {
      current = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
    } catch (error) {
      return { saved: true, globalSaved: false, checkpointPath: checkpoint.checkpointPath, reason: 'current-snapshot-unavailable', error };
    }
    if (!hasExactDescriptionRecoveryOwnership(current, nodeId, jobRunId)) {
      return { saved: true, globalSaved: false, checkpointPath: checkpoint.checkpointPath, reason: 'superseded' };
    }
    if (!snapshot.canvasFilePath) await fs.promises.mkdir(dir, { recursive: true });
    // A Solve rewrites the same run's saved scrape: keep its collection record.
    const carriedEvidence = collectionEvidenceForSnapshot(snapshot, null, current);
    if (carriedEvidence) snapshot = { ...snapshot, collectionEvidence: carriedEvidence };
    const { snapshot: persisted, serialized } = prepareJobAnalysisSnapshotForWrite(snapshot);
    const rotationPlan = await planSuccessfulJobAnalysisGenerations(paths, snapshot, serialized, authorityRecord);
    await stagePublication({
      publications: [
        { slot: 'current', digest: jobAnalysisArtifactDigest(serialized) },
        ...(rotationPlan ? [{ slot: 'success:1', digest: jobAnalysisArtifactDigest(serialized) }] : []),
      ],
      ...(rotationPlan ? { retainedSuccessfulPublications: rotationPlan.retainedPublications } : {}),
    });
    await writeJobAnalysisFileAtomically(jsonPath, serialized);
    await rotateSuccessfulJobAnalysisGenerations(rotationPlan);
    await writeJobAnalysisFileAtomically(promptPath, formatPromptFile(persisted));
      return { saved: true, globalSaved: true, checkpointPath: checkpoint.checkpointPath, jsonPath, lastSuccessJsonPath, promptPath };
    });
  };
  if (continuation) {
    return publishJobContinuationParentUpdate(snapshot.canvasFilePath, {
      ...continuation,
      nodeId,
      parentRunId: jobRunId,
      careerSnapshotId: snapshot.careerSnapshotId,
      operationAuthority: authority,
      nextParentArtifactFingerprint: jobAnalysisArtifactDigest(serializeJobAnalysisSnapshot(snapshot)),
    }, { sender }, publish);
  }
  const transaction = await withCurrentJobAnalysisOperationAuthority({
    canvasFilePath: snapshot.canvasFilePath, hubId: nodeId, ...authority,
  }, (current, stagePublication) => publish(stagePublication, current));
  return transaction.admitted ? transaction.value : { saved: false, globalSaved: false, reason: transaction.reason || 'operation-superseded' };
}

// The update-only checkpoint writer deliberately returns a value (rather than
// throwing) when Reset/terminal cleanup won the race. Callers that enriched
// rows must not mistake that for persistence: doing so would report success
// while the next Solve reloads the old pool and repeats the same work.
export function requireDescriptionRecoveryCheckpointPersisted(result) {
  if (result?.saved) return result;
  const superseded = ['checkpoint-unavailable', 'checkpoint-retired', 'ownership-mismatch', 'missing-ownership'].includes(result?.reason);
  throw Object.assign(
    new Error(superseded
      ? 'Description recovery checkpoint was removed or replaced by a newer run.'
      : `Description recovery checkpoint was not saved (${result?.reason || 'unknown'}).`),
    { code: superseded ? 'DESCRIPTION_RECOVERY_SUPERSEDED' : 'DESCRIPTION_RECOVERY_PERSIST_FAILED', persistence: result },
  );
}

export function descriptionRecoveryPersistenceWarning(sourceLabel, error, evidence) {
  if (error?.code === 'DESCRIPTION_RECOVERY_SUPERSEDED') {
    return descriptionRecoveryNotReadyWarning(sourceLabel, 'current-snapshot-unavailable');
  }
  return {
    code: 'description-recovery-persist-failed', severity: 'block',
    evidence,
    suggestion: 'Click Solve again after verifying the canvas folder is writable. If this was Reset or a newer run, use that current source card instead.',
  };
}

export async function __saveDescriptionRecoverySnapshotIfCurrentForTests(snapshot, ownership) {
  // Older test fixtures pass a fresh object after checkpoint creation, so the
  // real receipt persisted in that checkpoint is not present on the update
  // object.  Adopt it only in this named test seam, and only by loading the
  // exact owned, host-sealed checkpoint.  Production callers must supply their
  // receipt and never take this compatibility route.
  if (!snapshotOperationAuthority(snapshot)) {
    let sealedParentFailure = null;
    try {
      const checkpoint = await loadDescriptionRecoveryCheckpoint(
        snapshot?.canvasFilePath,
        ownership?.nodeId,
        ownership?.jobRunId,
      );
      const authority = snapshotOperationAuthority(checkpoint.snapshot);
      if (authority) {
        snapshot = {
          ...snapshot,
          careerSnapshotId: snapshot?.careerSnapshotId || checkpoint.snapshot.careerSnapshotId,
          operationAuthority: authority,
        };
      }
    } catch (error) {
      // Preserve the ordinary update-only result taxonomy while keeping the
      // compatibility lookup out of production IPC.
      sealedParentFailure = error?.code === 'EOWNERSHIP'
        ? 'ownership-mismatch'
        : error?.code === 'ENOENT'
          ? 'checkpoint-unavailable'
          : 'checkpoint-invalid';
    }
    if (!snapshotOperationAuthority(snapshot) && sealedParentFailure) {
      return { saved: false, globalSaved: false, reason: sealedParentFailure };
    }
  }
  return saveDescriptionRecoverySnapshotIfCurrent(snapshot, ownership);
}

export async function __createDescriptionRecoveryCheckpointForTests(snapshot) {
  // This named test seam is the only place where old checkpoint fixtures may
  // be upgraded automatically. Production creation always receives the
  // renderer/main-issued immutable pin and receipt. Keeping the fixture
  // authority real (rather than bypassing saveDescriptionRecoveryCheckpoint)
  // exercises the same publication transaction as production.
  if (!snapshotOperationAuthority(snapshot)) {
    const nodeId = typeof snapshot?.nodeId === 'string' ? snapshot.nodeId : null;
    const canvasFilePath = typeof snapshot?.canvasFilePath === 'string' ? snapshot.canvasFilePath : null;
    const runId = typeof snapshot?.runId === 'string' ? snapshot.runId : null;
    if (!nodeId || !canvasFilePath || !runId) return { saved: false, reason: 'missing-ownership' };
    const careerSnapshotId = typeof snapshot.careerSnapshotId === 'string' && /^[a-f0-9]{64}$/.test(snapshot.careerSnapshotId)
      ? snapshot.careerSnapshotId
      : 'a'.repeat(64);
    const operationId = `test-checkpoint-${crypto.createHash('sha256').update(`${canvasFilePath}\u0000${nodeId}\u0000${runId}`).digest('hex').slice(0, 24)}`;
    const claimed = await claimJobAnalysisOperationAuthority({
      canvasFilePath,
      hubId: nodeId,
      operationId,
      semanticBase: {
        kind: 'test-checkpoint', careerSnapshotId, runId,
        analysisRevisionId: null, fingerprint: null, continuationId: null, sourceArtifactFingerprint: null,
      },
    });
    if (!claimed.admitted) return { saved: false, reason: claimed.reason || 'operation-superseded' };
    snapshot = { ...snapshot, careerSnapshotId, operationAuthority: claimed.receipt };
  }
  return saveDescriptionRecoveryCheckpoint(snapshot, { create: true });
}

export async function __removeDescriptionRecoveryCheckpointForTests(canvasFilePath, nodeId, jobRunId) {
  return removeDescriptionRecoveryCheckpoint(canvasFilePath, nodeId, jobRunId);
}

export async function __pruneSupersededDescriptionRecoveryCheckpointsForTests(
  canvasFilePath,
  nodeId,
  terminalRunId,
  ordering,
) {
  return pruneSupersededDescriptionRecoveryCheckpoints(canvasFilePath, nodeId, terminalRunId, ordering);
}

export async function __loadDescriptionRecoveryCheckpointForTests(canvasFilePath, nodeId, jobRunId) {
  return loadDescriptionRecoveryCheckpoint(canvasFilePath, nodeId, jobRunId);
}

export async function __listDescriptionRecoveryCheckpointsForTests(canvasFilePath) {
  return (await listDescriptionRecoveryCheckpoints(canvasFilePath)).checkpoints;
}

export async function discardOwnedJobRun(canvasFilePath, nodeId, runId, { trashItem = null, skipCheckpointCleanup = false } = {}) {
  if (!nodeId || !runId) {
    return { ok: true, cleared: false, absent: true, reason: 'missing-ownership', checkpointCleanup: { removed: false, reason: 'missing-ownership' } };
  }
  // Unsaved canvases intentionally have no crash-recovery manifest, but their
  // pre-score checkpoints live in the private app-data fallback directory and
  // still contain the full recovery/profile payload. Let manifest cleanup no-op
  // while retiring that exact node+run checkpoint just like a saved canvas.
  const runCleanup = canvasFilePath
    ? await clearRunWithResult(canvasFilePath, {
        trashItem,
        expectedRunId: runId,
        expectedNodeId: nodeId,
      })
    : { ok: true, cleared: false, absent: true, reason: 'unsaved-canvas' };
  let checkpointCleanup;
  if (skipCheckpointCleanup) {
    return { ...runCleanup, checkpointCleanup: { removed: false, deferred: true }, reason: runCleanup.reason || null };
  }
  try {
    checkpointCleanup = await removeDescriptionRecoveryCheckpoint(canvasFilePath, nodeId, runId);
  } catch (error) {
    checkpointCleanup = { removed: false, reason: 'cleanup-failed', error: error?.message || String(error) };
  }
  const checkpointFailed = checkpointCleanup?.reason === 'cleanup-failed';
  return {
    ...runCleanup,
    ok: runCleanup.ok === true && !checkpointFailed,
    checkpointCleanup,
    reason: runCleanup.ok !== true
      ? (runCleanup.reason || 'cleanup-failed')
      : checkpointFailed
        ? 'checkpoint-cleanup-failed'
        : runCleanup.reason || null,
  };
}

export async function __discardOwnedJobRunForTests(canvasFilePath, nodeId, runId) {
  return discardOwnedJobRun(canvasFilePath, nodeId, runId);
}

// Legacy manifests written before hub ownership existed cannot be safely
// attributed to whichever current hub happens to see their banner. Give the
// user an explicit Clear career data path, but bind it atomically to both the run
// token and the manifest still having no owner; it cannot clear a modern hub.
export async function discardUnknownOwnerJobRun(canvasFilePath, runId, { trashItem = null } = {}) {
  if (!canvasFilePath || !runId) return { ok: true, cleared: false, reason: 'missing-run-token' };
  const cleanup = await clearRunWithResult(canvasFilePath, {
    trashItem,
    expectedRunId: runId,
    expectedOwnerUnknown: true,
  });
  return { ...cleanup, legacyOwnerUnknown: true };
}

export async function loadJobAnalysisSnapshot(canvasFilePath, nodeId = null, jobRunId = null) {
  const owner = normalizeJobAnalysisIdentifier(nodeId);
  const ownerRequested = nodeId != null && nodeId !== '';
  const requestedRunId = jobRunId == null || jobRunId === '' ? null : normalizeJobAnalysisIdentifier(jobRunId);
  if ((ownerRequested && !owner) || (jobRunId != null && jobRunId !== '' && !requestedRunId)) {
    throw Object.assign(new Error('Invalid job analysis ownership.'), { code: 'ENOENT' });
  }
  const paths = analysisPathsForCanvas(canvasFilePath, null, owner);
  // `jsonPath` and `promptPath` leave the main process through the recovery
  // IPC metadata. They must identify the exact artifact we loaded, rather
  // than the normal write destination. In particular, a legacy JSON may be
  // ownership-verified while its directory-scoped prompt was overwritten by a
  // sibling canvas, so it deliberately has no prompt companion.
  const resultPaths = ({ jsonPath, lastSuccessJsonPath = null, promptPath = null }) => ({
    jsonPath,
    lastSuccessJsonPath,
    promptPath,
  });
  const readJson = async (filePath) => {
    try {
      const serialized = await fs.promises.readFile(filePath, 'utf8');
      return { kind: 'ok', snapshot: JSON.parse(serialized), serialized };
    } catch (error) {
      if (error?.code === 'ENOENT') return { kind: 'missing', error };
      if (error instanceof SyntaxError) return { kind: 'malformed', error };
      return { kind: 'error', error };
    }
  };
  const hasRequestedOwnership = async (snapshot, slot, serialized) => {
    if (owner && classifySnapshotExactOwnership(snapshot, canvasFilePath, owner) !== 'owned') return false;
    if (requestedRunId && normalizeJobAnalysisIdentifier(snapshot?.runId) !== requestedRunId) return false;
    // A parseable historical artifact is not a capability.  Require the
    // durable operation receipt on every recovery/read path as well as writes.
    return hasPublishedSnapshotOperationAuthority(snapshot, slot, serialized);
  };
  const recordFallbackSelection = async (snapshot, origin, generation = null) => {
    if (origin === 'current') return;
    await recordAnalysisRecoveryLifecycle({
      operation: 'fallback-select', result: 'selected',
      reason: origin.startsWith('legacy') ? 'legacy-fallback' : (readCurrent.kind === 'malformed' ? 'corrupt-current' : 'current-unavailable'),
      canvasFilePath, ownerId: owner || jobAnalysisSnapshotOwner(snapshot), runId: snapshot?.runId,
      generation,
      gatheredJobCount: snapshot?.gatheredJobCount,
      candidatePoolJobCount: Array.isArray(snapshot?.jobs) ? snapshot.jobs.length : null,
    });
  };
  const readCurrent = await readJson(paths.jsonPath);
  // A valid empty current snapshot is meaningful: it says the latest run had
  // no eligible jobs, and must never be silently replaced with older results.
  if (readCurrent.kind === 'ok' && await hasRequestedOwnership(readCurrent.snapshot, 'current', readCurrent.serialized)) {
    return {
      snapshot: readCurrent.snapshot,
      paths: resultPaths({
        jsonPath: paths.jsonPath,
        lastSuccessJsonPath: paths.lastSuccessJsonPath,
        promptPath: await verifiedPromptPathForSnapshot(paths.promptPath, readCurrent.snapshot),
      }),
      origin: 'current',
    };
  }
  if (readCurrent.kind === 'error') throw readCurrent.error;

  // A missing/malformed current namespaced record may fall back to this
  // canvas's durable populated copy. This is still isolated from sibling
  // canvases in the same folder.
  const successfulGenerationPaths = paths.lastSuccessJsonPaths || [paths.lastSuccessJsonPath];
  let firstLastSuccessRead = null;
  for (const [index, successfulPath] of successfulGenerationPaths.entries()) {
    const readLastSuccess = await readJson(successfulPath);
    if (index === 0) firstLastSuccessRead = readLastSuccess;
    // Successful-generation files must never resurrect an empty or partial
    // run.  The path is only advisory; exact owner/canvas proof and populated
    // payload validity are required for every newest-to-oldest fallback.
    if (readLastSuccess.kind === 'ok'
      && await hasRequestedOwnership(readLastSuccess.snapshot, `success:${index + 1}`, readLastSuccess.serialized)
      && isPopulatedSuccessfulJobAnalysisSnapshot(readLastSuccess.snapshot)) {
      const origin = index === 0 ? 'last-success' : `last-success-${index + 1}`;
      await recordFallbackSelection(readLastSuccess.snapshot, origin, index + 1);
      return {
        snapshot: readLastSuccess.snapshot,
        // The current prompt can belong to a newer failed/empty run. There is
        // no independently-bound generation prompt, so never expose a file
        // whose contents could disagree with the recovered JSON.
        paths: resultPaths({
          jsonPath: successfulPath,
          lastSuccessJsonPath: paths.lastSuccessJsonPath,
        }),
        origin,
      };
    }
    if (readLastSuccess.kind === 'error') throw readLastSuccess.error;
  }

  // Compatibility proceeds in chronological path order: old canvas-only
  // hashes, then pre-namespace directory files. Owner-aware callers require
  // both the exact canvas and source hub in every fallback snapshot; otherwise
  // a neighboring hub's old bundle could be incorrectly resumed.
  for (const [legacyPath] of [
    [paths.legacyCanvasJsonPath, 'legacy-canvas-current'],
    [paths.legacyCanvasLastSuccessJsonPath, 'legacy-canvas-last-success'],
    [paths.legacyJsonPath, 'legacy-current'],
    [paths.legacyLastSuccessJsonPath, 'legacy-last-success'],
  ]) {
    if (!legacyPath) continue;
    const legacy = await readJson(legacyPath);
    // Old artifacts lack a main-process operation receipt. They remain on
    // disk for non-destructive migration/diagnostics, but are never readable
    // as an admissible recovery input after this authority fence ships.
    if (legacy.kind === 'error') throw legacy.error;
  }

  // Preserve the public no-snapshot contract. Prefer the current error so a
  // caller receives ENOENT for an absent record rather than an implementation
  // detail about the optional recovery copy.
  throw readCurrent.error || firstLastSuccessRead?.error || Object.assign(new Error('No saved job analysis snapshot.'), { code: 'ENOENT' });
}

// Test seam for the current-vs-last-success recovery contract. Kept separate
// from the renderer's hub/canvas ownership checks, which intentionally belong
// at the IPC caller.
export async function __loadJobAnalysisSnapshotForTests(canvasFilePath, nodeId = null, jobRunId = null) {
  return loadJobAnalysisSnapshot(canvasFilePath, nodeId, jobRunId);
}

/**
 * A description-recovery Solve is allowed to use only the active canvas
 * snapshot for the exact Job Search run that produced the source card.  In
 * particular, `loadJobAnalysisSnapshot` is intentionally allowed to fall back
 * to a last-successful snapshot for ordinary recovery/read-only diagnostics;
 * that fallback is unsafe for a live Solve because it can belong to another
 * hub or a completed predecessor run.
 */
export function assessDescriptionRecoverySnapshotOwnership({ snapshot, origin, nodeId, jobRunId, careerSnapshotId = null, operationAuthority = null } = {}) {
  if (!jobRunId) return { ok: false, reason: 'missing-run-id' };
  if (origin !== 'current') return { ok: false, reason: 'current-snapshot-unavailable' };
  const sourceHubId = typeof snapshot?.sourceHubId === 'string' ? snapshot.sourceHubId : '';
  const snapshotNodeId = typeof snapshot?.nodeId === 'string' ? snapshot.nodeId : '';
  const snapshotRunId = typeof snapshot?.runId === 'string' ? snapshot.runId : '';
  if (!sourceHubId || !snapshotNodeId || !snapshotRunId) return { ok: false, reason: 'missing-ownership' };
  if (sourceHubId !== nodeId || snapshotNodeId !== nodeId) return { ok: false, reason: 'hub-mismatch' };
  if (snapshotRunId !== jobRunId) return { ok: false, reason: 'run-mismatch' };
  if (careerSnapshotId != null && snapshot?.careerSnapshotId !== careerSnapshotId) return { ok: false, reason: 'career-snapshot-mismatch' };
  if (operationAuthority != null) {
    const expected = jobAnalysisOperationAuthorityReceipt(operationAuthority);
    const actual = snapshotOperationAuthority(snapshot);
    if (!expected || !actual || expected.operationId !== actual.operationId || expected.revision !== actual.revision
      || JSON.stringify(expected.semanticBase) !== JSON.stringify(actual.semanticBase)) return { ok: false, reason: 'operation-authority-mismatch' };
  }
  return { ok: true, reason: null };
}

export function isLiveDescriptionRecoveryRun(manifest, nodeId, jobRunId, { careerSnapshotId = null, operationAuthority = null } = {}) {
  return ['searching', 'gathered'].includes(manifest?.stage)
    && manifest?.runId === jobRunId
    && manifest?.inputs?.nodeId === nodeId
    && (careerSnapshotId == null || manifest?.inputs?.careerSnapshotId === careerSnapshotId)
    && (operationAuthority == null || (() => {
      const expected = jobAnalysisOperationAuthorityReceipt(operationAuthority);
      const actual = jobAnalysisOperationAuthorityReceipt(manifest?.inputs?.operationAuthority);
      return !!expected && !!actual && expected.operationId === actual.operationId && expected.revision === actual.revision
        && JSON.stringify(expected.semanticBase) === JSON.stringify(actual.semanticBase);
    })());
}

export async function assessDescriptionRecoveryCheckpoint({ snapshot, origin, nodeId, jobRunId, canvasFilePath } = {}) {
  // Production Solve always binds to the exact manifest pin + host receipt.
  // There is no legacy fallback here: an old parseable checkpoint is not an
  // authority to resume live enrichment after a career/operation change.
  const state = await readRunState(canvasFilePath, Date.now(), { nodeId });
  const careerSnapshotId = normalizeCareerSnapshotIdentifier(state?.manifest?.inputs?.careerSnapshotId);
  const operationAuthority = jobAnalysisOperationAuthorityReceipt(state?.manifest?.inputs?.operationAuthority);
  if (!careerSnapshotId || !operationAuthority) return { ok: false, reason: 'manifest-operation-authority-missing' };
  if (!await currentJobAnalysisOperationAuthority({ canvasFilePath, hubId: nodeId, ...operationAuthority })) {
    return { ok: false, reason: 'manifest-operation-superseded' };
  }
  const ownership = assessDescriptionRecoverySnapshotOwnership({
    snapshot, origin, nodeId, jobRunId, careerSnapshotId, operationAuthority,
  });
  if (ownership.ok || !['hub-mismatch', 'run-mismatch'].includes(ownership.reason)) return ownership;
  // The current analysis snapshot is written after gathering finishes. During a
  // live run it can still legitimately describe a prior hub/run; use the
  // manifest (the durable unfinished-run authority) to distinguish that
  // expected checkpoint gap from an actual stale source-card request. `gathered`
  // remains unfinished until the renderer writes its pre-score snapshot.
  if (state?.resumable === true && isLiveDescriptionRecoveryRun(state?.manifest, nodeId, jobRunId, {
    careerSnapshotId, operationAuthority,
  })) {
    return { ok: false, reason: 'live-run-checkpoint-not-ready' };
  }
  return ownership;
}

// A Google/LinkedIn Solve rewrites the whole current-run recovery universe.
// Serializing only the final file write is insufficient: two source cards can
// both read the same pre-recovery universe, then the later write drops the
// other source's freshly enriched rows. Keep the lock scoped to one canvas /
// hub / run so independent searches never block each other.
export function createDescriptionRecoveryMutex() {
  const tails = new Map();
  const throwIfAborted = (signal) => {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error('Description recovery aborted'), { name: 'AbortError' });
  };
  return {
    async run(key, signal, fn) {
      throwIfAborted(signal);
      const previous = tails.get(key) || Promise.resolve();
      const result = previous.then(async () => {
        throwIfAborted(signal);
        return fn();
      }, async () => {
        throwIfAborted(signal);
        return fn();
      });
      const tail = result.then(() => {}, () => {});
      tails.set(key, tail);
      return result.finally(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
    },
    size: () => tails.size,
  };
}

const descriptionRecoveryMutex = createDescriptionRecoveryMutex();

function descriptionRecoveryMutexKey(canvasFilePath, nodeId, jobRunId) {
  const resolvedCanvasPath = canvasFilePath
    ? path.resolve(canvasFilePath)
    : `(unsaved-canvas:${unsavedAnalysisScopeForCurrentRequest(canvasFilePath) || 'legacy'})`;
  return `${resolvedCanvasPath}\u0000${String(nodeId || '')}\u0000${String(jobRunId || '')}`;
}

export function withDescriptionRecoveryLock({ canvasFilePath, nodeId, jobRunId, signal }, fn) {
  return descriptionRecoveryMutex.run(
    descriptionRecoveryMutexKey(canvasFilePath, nodeId, jobRunId),
    signal,
    fn,
  );
}

export function descriptionRecoveryNotReadyWarning(sourceLabel, reason) {
  const label = sourceLabel || 'This source';
  const evidence = reason === 'missing-run-id'
    ? `${label} Solve is not attached to an active search run, so it cannot safely use saved recovery data.`
    : reason === 'current-snapshot-unavailable'
      ? `The current-run ${label} recovery checkpoint is not ready. An earlier completed-run snapshot was found, but it was not used.`
    : reason === 'missing-ownership'
        ? `The current ${label} recovery snapshot is missing required hub/run ownership metadata, so it was not used.`
        : reason === 'live-run-checkpoint-not-ready'
          ? `This ${label} search is still running, and its current-run recovery checkpoint has not been written yet. An earlier snapshot was not used.`
        : `${label} Solve needs the current run's recovery checkpoint before it can safely continue.`;
  return {
    code: 'description-recovery-not-ready',
    severity: 'block',
    evidence,
    suggestion: 'Wait for this search to reach its recovery checkpoint, then retry Solve from the current source card. If the search has ended, run it again before retrying.',
  };
}

/** Test seam for the deterministic prompt/snapshot binding contract. */
export function __formatJobAnalysisPromptForTests(snapshot) {
  return formatPromptFile(snapshot);
}

/** Test seam for the durable-write size ladder (prompts, then omitted jobs). */
export function __prepareJobAnalysisSnapshotForWriteForTests(snapshot, options) {
  return prepareJobAnalysisSnapshotForWrite(snapshot, options);
}

// Human-readable stage-error text per renderer-supplied cancel cause. Every
// node-scoped abort shares one sentinel message ("Node deleted") because that
// string is a load-bearing IPC/control-flow contract; these labels are what the
// bug report shows instead, so a user's Reset never reads as a deleted node.
export const CANCEL_CAUSE_LABELS = {
  'user-stopped': 'Stopped by user — saved checkpoint retained for Resume',
  'job-source-card-removed': 'Source card removed — saved checkpoint retained for Resume',
  'user-reset': 'Cancelled by user — clicked Reset on this hub',
  'career-files-cleared': 'Cancelled by user — cleared the career files on this hub',
  'reanalysis-cancelled': 'Cancelled by user — stopped saved-result re-analysis',
  'board-cleared': 'Cancelled by user — cleared the connected Job Board',
  'board-unmounted': 'Cancelled — the Job Board node left the canvas',
  'node-deleted': 'Cancelled — this node was deleted from the canvas',
  'manual-ai-cancelled': 'Cancelled by user — dismissed the manual AI copy/paste prompt',
};

// These are intentional pauses, not ownership-ending resets.  Their staging
// sidecar stays intact so a later Resume continues the exact original run.
export const CHECKPOINT_PRESERVING_ABORT_CAUSES = new Set([
  'user-stopped',
  'job-source-card-removed',
]);

// Every node-scoped cancellation uses the same sentinel error message for the
// IPC/control-flow contract.  The explicit cause is therefore what separates
// a destructive abandon (clear/reset/delete) from a deliberate pause.  Stop
// and removal of an active source card keep the exact manifest and staging
// ledger so Resume continues the original run rather than manufacturing a scan.
export function shouldDiscardJobRunAfterAbort(reason) {
  return reason?.message === 'Node deleted'
    && !CHECKPOINT_PRESERVING_ABORT_CAUSES.has(reason?.cancelCause);
}
