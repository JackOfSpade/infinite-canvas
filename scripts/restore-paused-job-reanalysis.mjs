#!/usr/bin/env node
/**
 * Create a non-destructive canvas copy that exposes a paused saved-job
 * re-analysis for an explicit Continue action.
 *
 * This intentionally does not touch job-run sidecars.  If a fresh accidental
 * scrape has a manifest/staging pair beside the canvas, archive those files
 * separately before opening the restored copy; otherwise startup recovery can
 * correctly prefer that exact provider checkpoint over this score-only marker.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dedupJobsAcrossSources } from '../src/utils/jobIdentity.js';

export const REANALYZE_SAVED_JOBS_RECOVERY_MODE = 'reanalyze-saved-jobs';

function usage() {
  return `Usage: node scripts/restore-paused-job-reanalysis.mjs --canvas <canvas.json> --hub <jobhub-id> --output <restored.json> [--write] [--recovery-run-id <id>]

Creates a copy only. Dry-run is the default; pass --write to create --output.
The command refuses to overwrite either the input canvas or an existing output.`;
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--write') {
      values.write = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      values.help = true;
      continue;
    }
    if (!['--canvas', '--hub', '--output', '--recovery-run-id'].includes(token)) {
      throw new Error(`Unknown argument: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    values[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  if (values.help) return values;
  for (const key of ['canvas', 'hub', 'output']) {
    if (typeof values[key] !== 'string' || !values[key].trim()) {
      throw new Error(`Missing required --${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} argument.`);
    }
  }
  return values;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
}

function findJobHubs(value, hubId, found = [], seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return found;
  if (seen.has(value)) return found;
  seen.add(value);
  if (
    !Array.isArray(value)
    && value.type === 'jobhub'
    && value.id === hubId
    && Object.prototype.hasOwnProperty.call(value, 'data')
  ) found.push(value);
  for (const child of Object.values(value)) findJobHubs(child, hubId, found, seen);
  return found;
}

function normalizedBrief(data) {
  const candidates = [data?.jobPreferences, data?.activeJobPreferences];
  return candidates.find(value => typeof value === 'string' && value.trim()) || '';
}

function effectiveReanalysisCandidates(data) {
  const pool = Array.isArray(data?.preferenceCandidatePool) ? data.preferenceCandidatePool : [];
  const scored = Array.isArray(data?.scoredJobs) ? data.scoredJobs : [];
  if (pool.length === 0 && scored.length === 0) return null;
  if (pool.length === 0) {
    return { source: 'scoredJobs', candidates: scored };
  }
  if (scored.length === 0) {
    return { source: 'preferenceCandidatePool', candidates: pool };
  }
  // This exactly mirrors handleReanalyze: the durable pool comes first so its
  // preference audit wins whenever it duplicates a displayed score row.
  return {
    source: 'preferenceCandidatePool+scoredJobs',
    candidates: dedupJobsAcrossSources([...pool, ...scored]),
  };
}

function makeRecoveryRunId(hubId, recoveryRunId = null) {
  if (recoveryRunId != null) {
    if (typeof recoveryRunId !== 'string' || !recoveryRunId.trim() || recoveryRunId.length > 240) {
      throw new Error('--recovery-run-id must be a non-empty identifier no longer than 240 characters.');
    }
    return recoveryRunId.trim();
  }
  return `job-search:${hubId}:recovered-reanalysis:${crypto.randomUUID()}`;
}

function jobSidecarRecommendations(canvasPath, hubId) {
  const resolved = path.resolve(canvasPath);
  const directory = path.dirname(resolved);
  const base = path.basename(resolved).replace(/\.json$/i, '');
  const canvasHash = sha256(resolved).slice(0, 24);
  const ownerHash = sha256(hubId).slice(0, 24);
  const scoped = `.${canvasHash}.${ownerHash}`;
  return {
    manifest: path.join(directory, `${base}.jobs-run${scoped}.json`),
    staging: path.join(directory, `${base}.jobs-staging${scoped}.jsonl`),
    terminalReceipt: path.join(directory, `${base}.jobs-last-run${scoped}.json`),
  };
}

function clearTransientAccidentalRunUi(data) {
  // Keep durable corpus, profile, brief, prior result metadata, and all
  // collection evidence. These are renderer-only in-flight affordances that
  // would otherwise make a restored copy look as though the accidental scrape
  // were still active.
  for (const key of [
    'queuedModuleRun', 'errorMessage', 'retryOperation', 'retryOperationFor',
    'rerunOutcome', 'rerunNotice', 'pendingJobs', 'pendingTargetRole',
    'pendingCareerData', 'pendingJobPreferences', 'pendingJobPreferencePlan',
    'pendingJobPreferencesInterpretation',
  ]) data[key] = null;
}

/**
 * Validate and transform parsed canvas JSON. Exported so this can be tested
 * without ever running it against a person's saved workspace.
 */
export function buildPausedReanalysisRestore(canvas, {
  hubId,
  recoveryRunId = null,
  now = Date.now(),
} = {}) {
  assertPlainObject(canvas, 'Canvas JSON must be an object.');
  if (typeof hubId !== 'string' || !hubId.trim()) throw new Error('A non-empty Job Search hub id is required.');
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid restoration timestamp.');

  const restored = JSON.parse(JSON.stringify(canvas));
  const hubs = findJobHubs(restored, hubId.trim());
  if (hubs.length !== 1) {
    throw new Error(`Expected exactly one jobhub with id ${hubId.trim()}, found ${hubs.length}.`);
  }
  const data = hubs[0].data;
  assertPlainObject(data, 'The matching jobhub has invalid data.');
  const effective = effectiveReanalysisCandidates(data);
  if (!effective || effective.candidates.length === 0) {
    throw new Error('The matching jobhub has neither a saved preferenceCandidatePool nor scoredJobs to re-analyze.');
  }
  if (!data.resumeProfile || typeof data.resumeProfile !== 'object' || Array.isArray(data.resumeProfile)
    || Object.keys(data.resumeProfile).length === 0) {
    throw new Error('The matching jobhub has no usable saved resumeProfile.');
  }
  if (!normalizedBrief(data)) {
    throw new Error('The matching jobhub has no saved Search Brief (jobPreferences or activeJobPreferences).');
  }
  if (data.manualAiResume && !data.manualAiResume.retirementPending) {
    throw new Error('The matching jobhub already has a saved manual-AI recovery marker; refusing to replace it.');
  }
  if (data.manualAiResume?.retirementPending || data.terminalFinalizationRecovery) {
    throw new Error('The matching jobhub has unfinished cleanup/recovery; finish it before preparing a restored copy.');
  }

  const poolBefore = JSON.stringify(data.preferenceCandidatePool);
  const scoredBefore = JSON.stringify(data.scoredJobs);
  const runId = makeRecoveryRunId(hubId.trim(), recoveryRunId);
  clearTransientAccidentalRunUi(data);
  data.hubState = 'done';
  // The retained pool is the complete downstream universe, while this
  // particular paused run was filtered by its new brief before any score rows
  // could be emitted.  Restore that terminal presentation coherently: callers
  // should see a saved, preference-filtered result rather than an ambiguous
  // empty hub that could invite a fresh scrape.
  const isVerifiedAllFilteredPool = Array.isArray(data.preferenceCandidatePool)
    && data.preferenceCandidatePool.length > 0
    && (!Array.isArray(data.scoredJobs) || data.scoredJobs.length === 0)
    && data.preferenceFilteredCount === data.preferenceCandidatePool.length;
  if (isVerifiedAllFilteredPool) {
    data.resultDisposition = 'preference-filtered';
    data.resultCount = 0;
    data.totalScoredCount = 0;
    data.scrapedCount = 0;
  }
  data.manualAiResume = {
    runId,
    task: 'job-preference-evaluation',
    recoveryMode: REANALYZE_SAVED_JOBS_RECOVERY_MODE,
    pausedByUser: true,
    updatedAt: now,
    // Helpful audit-only metadata. The renderer uses recoveryMode + runId as
    // authority and validates its live hub before it resumes.
    recoveredBy: 'restore-paused-job-reanalysis',
    recoveredCandidateSource: effective.source,
    recoveredEffectiveCandidateCount: effective.candidates.length,
  };
  if (JSON.stringify(data.preferenceCandidatePool) !== poolBefore || JSON.stringify(data.scoredJobs) !== scoredBefore) {
    throw new Error('Internal safety check failed: saved candidate rows changed during restore preparation.');
  }
  return {
    restored,
    summary: {
      hubId: hubId.trim(),
      recoveryRunId: runId,
      candidateSource: effective.source,
      effectiveCandidateCount: effective.candidates.length,
      effectiveCandidateSha256: sha256(JSON.stringify(effective.candidates)),
      preferenceCandidatePoolCount: Array.isArray(data.preferenceCandidatePool) ? data.preferenceCandidatePool.length : 0,
      scoredJobsCount: Array.isArray(data.scoredJobs) ? data.scoredJobs.length : 0,
      terminalStateNormalized: isVerifiedAllFilteredPool,
      hubState: data.hubState,
      recoveryMode: data.manualAiResume.recoveryMode,
      preservedCandidatePool: true,
    },
  };
}

async function readRegularFile(filePath, label) {
  const stat = await fs.promises.lstat(filePath).catch(error => {
    throw new Error(`Could not read ${label}: ${error.message}`);
  });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file.`);
  return fs.promises.readFile(filePath);
}

async function writeNewFileAtomically(outputPath, content) {
  const directory = path.dirname(outputPath);
  const directoryStat = await fs.promises.stat(directory).catch(() => null);
  if (!directoryStat?.isDirectory()) throw new Error(`Output directory does not exist: ${directory}`);
  const existing = await fs.promises.lstat(outputPath).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) throw new Error(`Refusing to overwrite existing output: ${outputPath}`);

  const temporaryPath = path.join(directory, `.${path.basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    // link(2) is fail-if-exists, unlike rename(2), so an output appearing in
    // the narrow race cannot be overwritten.
    await fs.promises.link(temporaryPath, outputPath);
    await fs.promises.unlink(temporaryPath);
    // The output must be durable before --write reports success.  Syncing the
    // directory commits the newly linked name as well as the file contents
    // synced above.
    const directoryHandle = await fs.promises.open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function restorePausedJobReanalysis({
  canvasPath,
  hubId,
  outputPath,
  write = false,
  recoveryRunId = null,
  now = Date.now(),
} = {}) {
  if (!canvasPath || !hubId || !outputPath) throw new Error('canvasPath, hubId, and outputPath are required.');
  const input = path.resolve(canvasPath);
  const output = path.resolve(outputPath);
  if (input === output) throw new Error('Output path must be different from the input canvas path.');
  const inputBytes = await readRegularFile(input, 'input canvas');
  let canvas;
  try {
    canvas = JSON.parse(inputBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Input canvas is not valid JSON: ${error.message}`);
  }
  const { restored, summary } = buildPausedReanalysisRestore(canvas, { hubId, recoveryRunId, now });
  const serialized = `${JSON.stringify(restored, null, 2)}\n`;
  const outputExists = await fs.promises.lstat(output).then(() => true, error => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (outputExists) throw new Error(`Refusing to overwrite existing output: ${output}`);
  if (write) await writeNewFileAtomically(output, serialized);
  return {
    mode: write ? 'written' : 'dry-run',
    inputPath: input,
    outputPath: output,
    inputSha256: sha256(inputBytes),
    outputSha256: sha256(serialized),
    outputBytes: Buffer.byteLength(serialized),
    ...summary,
    archiveRecommendations: {
      copyInputCanvasBeforeOpeningOutput: input,
      archiveAccidentalRunSidecarsAsOneBundle: jobSidecarRecommendations(input, hubId.trim()),
      warning: 'Do not copy accidental-run sidecars beside the restored output. Archive them separately first; opening them beside a canvas can correctly trigger provider-run recovery.',
    },
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const result = await restorePausedJobReanalysis({
      canvasPath: args.canvas,
      hubId: args.hub,
      outputPath: args.output,
      write: args.write === true,
      recoveryRunId: args.recoveryRunId || null,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`restore-paused-job-reanalysis: ${error?.message || String(error)}\n`);
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
