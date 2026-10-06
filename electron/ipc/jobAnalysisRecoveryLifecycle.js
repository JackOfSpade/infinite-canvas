/**
 * Bounded, content-free lifecycle receipts for Job Search analysis recovery.
 *
 * Snapshot files deliberately contain private career and listing evidence. This
 * side journal must survive their removal, while retaining only the facts that
 * explain why a recovery point was saved, selected, rotated, or discarded.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const JOB_ANALYSIS_RECOVERY_LIFECYCLE_SCHEMA = 1;
export const JOB_ANALYSIS_RECOVERY_LIFECYCLE_CAP = 48;

const OPERATIONS = new Set(['snapshot-save', 'generation-rotate', 'fallback-select', 'discard', 'reanalysis-score-complete']);
const RESULTS = new Set(['saved', 'rotated', 'selected', 'discarded', 'completed', 'partial', 'retired', 'failed']);
const RECOVERY_MODES = new Set(['automatic', 'manual', 'direct', 'restart', 'reanalyze-saved-jobs', 'unknown']);
const REASONS = new Set([
  'normal-save', 'reanalysis-save', 'description-recovery-save', 'current-unavailable',
  'corrupt-current', 'legacy-fallback', 'career-data-clear', 'node-delete',
  'run-discard', 'cleanup-failed', 'retired-before-write', 'reanalysis-score-complete', 'unknown',
]);
const tails = new Map();

function opaque(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return `#${crypto.createHash('sha256').update(value.trim()).digest('hex').slice(0, 10)}`;
}

function persistedOpaque(value, source) {
  if (typeof value === 'string' && /^#[a-f0-9]{10}$/.test(value)) return value;
  return opaque(source);
}

function finiteCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000
    ? value
    : null;
}

function enumValue(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function safeGeneration(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 3
    ? value
    : null;
}

function safeSnapshotCreatedAtMs(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && Number.isFinite(new Date(value).getTime()) ? value : null;
}

function normalizeEvent(input = {}, { persisted = false } = {}) {
  const operation = enumValue(input.operation, OPERATIONS, null);
  if (!operation) return null;
  const recordedAt = typeof input.at === 'number' && Number.isSafeInteger(input.at) && input.at > 0
    && Number.isFinite(new Date(input.at).getTime()) ? input.at : null;
  // Never manufacture a fresh timestamp while reading a persisted journal:
  // it could turn corrupt old evidence into an apparently current completion.
  if (persisted && recordedAt == null) return null;
  const at = recordedAt ?? Date.now();
  const event = {
    at,
    operation,
    result: enumValue(input.result, RESULTS, 'failed'),
    reason: enumValue(input.reason, REASONS, 'unknown'),
    canvas: persistedOpaque(input.canvas, input.canvasFilePath),
    owner: persistedOpaque(input.owner, input.ownerId),
    run: persistedOpaque(input.run, input.runId),
    recoveryMode: enumValue(input.recoveryMode, RECOVERY_MODES, 'unknown'),
  };
  const generation = safeGeneration(input.generation);
  const retainedGenerations = safeGeneration(input.retainedGenerations);
  const gathered = finiteCount(input.gatheredJobCount);
  const candidates = finiteCount(input.candidatePoolJobCount);
  const discarded = finiteCount(input.discardedArtifacts);
  const scoringInput = finiteCount(input.scoringInputCount);
  const scored = finiteCount(input.scoredJobCount);
  const placeholders = finiteCount(input.placeholderCount);
  const unscored = finiteCount(input.unscoredJobCount);
  const failedBatches = finiteCount(input.failedBatchCount);
  const revision = persistedOpaque(input.analysisRevision, input.analysisRevisionId);
  const snapshotCreatedAt = safeSnapshotCreatedAtMs(input.snapshotCreatedAtMs);
  if (operation === 'reanalysis-score-complete'
    && (event.recoveryMode !== 'reanalyze-saved-jobs' || !revision
      || !['completed', 'partial'].includes(event.result)
      || scoringInput == null || scored == null || placeholders == null || unscored == null
      || failedBatches == null || candidates == null
      // Legacy rows are retained for audit, but a newly-written scoring
      // receipt must identify the exact snapshot it completed.
      || (!persisted && snapshotCreatedAt == null))) return null;
  if (generation != null) event.generation = generation;
  if (retainedGenerations != null) event.retainedGenerations = retainedGenerations;
  if (gathered != null) event.gatheredJobCount = gathered;
  if (candidates != null) event.candidatePoolJobCount = candidates;
  if (discarded != null) event.discardedArtifacts = discarded;
  if (revision) event.analysisRevision = revision;
  if (scoringInput != null) event.scoringInputCount = scoringInput;
  if (scored != null) event.scoredJobCount = scored;
  if (placeholders != null) event.placeholderCount = placeholders;
  if (unscored != null) event.unscoredJobCount = unscored;
  if (failedBatches != null) event.failedBatchCount = failedBatches;
  if (snapshotCreatedAt != null) event.snapshotCreatedAtMs = snapshotCreatedAt;
  return event;
}

function normalizeJournal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { schemaVersion: JOB_ANALYSIS_RECOVERY_LIFECYCLE_SCHEMA, events: [] };
  const events = Array.isArray(value.events) ? value.events.map(event => normalizeEvent(event, { persisted: true })).filter(Boolean).slice(-JOB_ANALYSIS_RECOVERY_LIFECYCLE_CAP) : [];
  return { schemaVersion: JOB_ANALYSIS_RECOVERY_LIFECYCLE_SCHEMA, events };
}

async function writeAtomically(filePath, journal) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    // The journal is the only explanation left after an explicit clear moves
    // the snapshots to Trash. Flush the file before publication, then flush
    // the directory after rename so an immediate app quit cannot acknowledge
    // a receipt that only existed in the OS cache.
    const handle = await fs.promises.open(tempPath, 'w', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tempPath, filePath);
    const directory = await fs.promises.open(path.dirname(filePath), 'r').catch(() => null);
    if (directory) {
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

async function readJournal(filePath) {
  try { return normalizeJournal(JSON.parse(await fs.promises.readFile(filePath, 'utf8'))); }
  catch { return { schemaVersion: JOB_ANALYSIS_RECOVERY_LIFECYCLE_SCHEMA, events: [] }; }
}

/** Record a metadata-only event. A failed journal write never changes recovery. */
export async function recordJobAnalysisRecoveryLifecycle(filePath, input) {
  const event = normalizeEvent(input);
  if (!filePath || !event) return false;
  const prior = tails.get(filePath) || Promise.resolve();
  const task = prior.then(async () => {
    const journal = await readJournal(filePath);
    journal.events = [...journal.events, event].slice(-JOB_ANALYSIS_RECOVERY_LIFECYCLE_CAP);
    await writeAtomically(filePath, journal);
    return true;
  }, async () => {
    const journal = await readJournal(filePath);
    journal.events = [...journal.events, event].slice(-JOB_ANALYSIS_RECOVERY_LIFECYCLE_CAP);
    await writeAtomically(filePath, journal);
    return true;
  });
  tails.set(filePath, task.then(() => {}, () => {}));
  try { return await task; } catch { return false; }
}

/** Sync, bounded report reader. It never returns paths, IDs, prompts, or rows. */
export function readJobAnalysisRecoveryLifecycle(filePath, { canvasFilePath = null, ownerIds = null } = {}) {
  if (!filePath) return { exists: false, events: [] };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { return { exists: error?.code !== 'ENOENT', invalid: error?.code !== 'ENOENT', events: [] }; }
  const journal = normalizeJournal(parsed);
  const canvas = opaque(canvasFilePath);
  const owners = new Set((ownerIds instanceof Set ? [...ownerIds] : Array.isArray(ownerIds) ? ownerIds : [])
    .map(opaque).filter(Boolean));
  const scoped = journal.events.filter(event => (!canvas || event.canvas === canvas)
    && (owners.size === 0 || owners.has(event.owner)));
  return { exists: true, events: scoped.slice(-16).reverse(), retained: journal.events.length };
}

export function formatJobAnalysisRecoveryLifecycleMarkdown(snapshot) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  if (snapshot?.invalid) return '\n## Job Analysis Recovery Lifecycle\n> Metadata-only, cross-restart lifecycle receipt.\n\n- ⚠️ lifecycle journal is unreadable; no snapshot contents were inspected.\n';
  const rows = events.map(event => {
    const when = new Date(event.at).toISOString();
    const ids = [event.canvas ? `canvas ${event.canvas}` : null, event.owner ? `hub ${event.owner}` : null, event.run ? `run ${event.run}` : null].filter(Boolean).join(' · ');
    const counts = [event.gatheredJobCount != null ? `${event.gatheredJobCount} score-ready` : null, event.candidatePoolJobCount != null ? `${event.candidatePoolJobCount} candidates` : null, event.scoringInputCount != null ? `${event.scoringInputCount} scoring input` : null, event.scoredJobCount != null ? `${event.scoredJobCount} scored` : null, event.placeholderCount != null ? `${event.placeholderCount} placeholders` : null, event.unscoredJobCount != null ? `${event.unscoredJobCount} unscored` : null, event.failedBatchCount != null ? `${event.failedBatchCount} failed batches` : null, event.discardedArtifacts != null ? `${event.discardedArtifacts} artifacts removed` : null, event.generation != null ? `generation ${event.generation}` : null, event.retainedGenerations != null ? `${event.retainedGenerations} retained` : null].filter(Boolean).join(' · ');
    return `- ${when} · \`${event.operation}\` → **${event.result}** · reason \`${event.reason}\` · mode \`${event.recoveryMode}\`${event.analysisRevision ? ` · revision ${event.analysisRevision}` : ''}${ids ? ` · ${ids}` : ''}${counts ? ` · ${counts}` : ''}`;
  });
  return `\n## Job Analysis Recovery Lifecycle\n> Bounded, cross-restart metadata-only receipt. IDs are stable one-way digests; job listings, profile data, prompts, URLs, and filesystem paths are never retained.\n\n${rows.length ? rows.join('\n') : '- No matching lifecycle events are retained for the Job Search hubs in this canvas.'}\n`;
}
