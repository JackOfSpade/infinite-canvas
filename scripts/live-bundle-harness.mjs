// Live end-to-end check of application generation on the local Claude Code
// runner. Launches the real app (rebuilt bundles) against a throwaway Electron
// profile and a scratch canvas, queues real postings copied from existing job
// inputs, lets the app's own runner drive every stage, then collects result.json,
// the private run logs, plans and writer notes for review.
//
//   node scripts/live-bundle-harness.mjs --job <input.json> [--job <input.json>] [--candidates N] [--max-minutes 240]
//     [--out tmp/claude-e2e/runs/<name>] [--retry <jobId>] [--ephemeral]
//
// Build first (npm run build:compile). An arm under test is set with
// INFINITE_CANVAS_STAGE_PROFILES='<stage>=<model>:<effort>,...' (honored only
// because the harness sets INFINITE_CANVAS_E2E=1). The run copies its --job
// inputs into <out>/inputs/ and records itself in docs/ai-test-runs.md while it
// runs (scripts/ai-test-journal.mjs), so its results survive the session that
// started it. --out must be durable: a session scratchpad or temp folder is refused.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { readFileSync } from 'node:fs';
import { assertDurableOutDir, createRunJournal, takeEphemeralFlag } from './ai-test-journal.mjs';

const [argv, allowEphemeral] = takeEphemeralFlag(process.argv.slice(2));
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const jobInputs = argv.flatMap((arg, i) => (arg === '--job' ? [argv[i + 1]] : []));
// --retry <jobId> resumes a failed job in an existing --out run through the runner's own Retry.
const retryIds = argv.flatMap((arg, i) => (arg === '--retry' ? [argv[i + 1]] : []));
if (!jobInputs.length && !retryIds.length) throw new Error('Pass at least one --job <input.json> or --retry <jobId>.');
const candidateCount = option('candidates') ? Number(option('candidates')) : undefined;
const maxMs = Number(option('max-minutes', '240')) * 60_000;
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const runRoot = path.resolve(option('out', path.join('tmp', 'claude-e2e', 'runs', stamp)));
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'infinite-canvas');
const userDataDir = path.join(runRoot, 'profile');
const canvasDir = path.join(runRoot, 'canvas');
const canvasFilePath = path.join(canvasDir, 'Live Test.json');
assertDurableOutDir(runRoot, { allowEphemeral });
// The stage overrides are the arm under test; record them with the run.
const arm = process.env.INFINITE_CANVAS_STAGE_PROFILES || 'production (no stage overrides)';

await fs.mkdir(userDataDir, { recursive: true, mode: 0o700 });
await fs.mkdir(canvasDir, { recursive: true, mode: 0o700 });
// Read-only use of the approved career snapshots; nothing is written back to the real profile.
await fs.cp(path.join(realUserData, 'career-snapshot-store'), path.join(userDataDir, 'career-snapshot-store'), { recursive: true });
if (!(await fs.stat(canvasFilePath).catch(() => null))) {
  await fs.writeFile(canvasFilePath, JSON.stringify({ schemaVersion: 1, nodes: [], edges: [], drawings: [] }), { mode: 0o600 });
}

// Copy every job input into the run so it never depends on a session scratchpad.
const inputsDir = path.join(runRoot, 'inputs');
await fs.mkdir(inputsDir, { recursive: true, mode: 0o700 });
const localInputs = [];
for (const [index, inputPath] of jobInputs.entries()) {
  const copy = path.join(inputsDir, `${String(index + 1).padStart(2, '0')}-${path.basename(inputPath)}`);
  if (path.resolve(inputPath) !== copy) await fs.copyFile(inputPath, copy);
  localInputs.push(copy);
}

const progressPath = path.join(runRoot, 'progress.jsonl');
function log(record) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...record });
  console.log(line);
  fs.appendFile(progressPath, `${line}\n`).catch(() => {});
}

// The production app is launched from Finder with none of these. Strip the
// session's own Claude Code / Anthropic variables so the spawned CLI sees a
// clean environment, and drop the Node-mode switch Playwright cannot use.
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(?:CLAUDE|ANTHROPIC|ELECTRON_RUN_AS_NODE)/u.test(key)) continue;
  env[key] = value;
}
env.INFINITE_CANVAS_E2E = '1';
env.INFINITE_CANVAS_E2E_BACKGROUND = '1';

log({ event: 'launching', runRoot, canvasFilePath, jobs: localInputs, sourceInputs: jobInputs, arm, candidateCount: candidateCount ?? 'default' });
const journal = createRunJournal({
  tool: 'live bundle harness', task: 'application bundles', label: arm, outDir: runRoot, exitOnSignal: false,
  command: `INFINITE_CANVAS_STAGE_PROFILES=${process.env.INFINITE_CANVAS_STAGE_PROFILES || ''} node scripts/live-bundle-harness.mjs ${argv.join(' ')}`,
  facts: { Jobs: jobInputs.length + retryIds.length, Candidates: candidateCount ?? 'default' },
});
const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env, timeout: 180_000 });
const child = app.process();
child.stderr?.on('data', chunk => fs.appendFile(path.join(runRoot, 'electron-stderr.log'), chunk).catch(() => {}));
child.stdout?.on('data', chunk => fs.appendFile(path.join(runRoot, 'electron-stdout.log'), chunk).catch(() => {}));
let closing = false;
async function shutdown(reason) {
  if (closing) return;
  closing = true;
  log({ event: 'closing', reason });
  try { await app.close(); } catch (error) { log({ event: 'close-error', message: String(error?.message || error) }); }
}
process.on('SIGINT', () => { shutdown('SIGINT').finally(() => process.exit(130)); });
process.on('SIGTERM', () => { shutdown('SIGTERM').finally(() => process.exit(143)); });

const jobs = [];
const SCORED_STAGES = ['requirements', 'convert', 'verify-correction', 'fit-correction', 'pick'];
/** Cost and per-stage calls of one bundle, from the app's own run log. */
function bundleTotals(jobId) {
  const totals = { costUsd: 0, stages: {} };
  let text = '';
  try { text = readFileSync(path.join(canvasDir, '.local-ai', 'claude-runs', `${jobId}.jsonl`), 'utf8'); } catch { return totals; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (Number.isFinite(event.costUsd)) totals.costUsd += event.costUsd;
    if (!SCORED_STAGES.includes(event.stage)) continue;
    const stage = totals.stages[event.stage] ??= { calls: 0, accepted: 0, model: null };
    if (event.event === 'response') { stage.calls += 1; stage.model = event.model ?? stage.model; }
    if (event.event === 'submission' && event.submit?.accepted) stage.accepted += 1;
  }
  return totals;
}
function recordJournal(force) {
  const rows = jobs.map(job => {
    const totals = bundleTotals(job.jobId);
    const stages = Object.entries(totals.stages).map(([name, s]) => `${name} ${s.accepted}/${s.calls}${s.model ? ` ${s.model.replace(/^claude-/u, '')}` : ''}`).join('; ');
    const finished = job.finishedStatus === 'bundle finished';
    return { arm: job.company || job.jobId, n: 1, valid: finished ? 1 : 0, failed: job.finishedStatus?.startsWith('failed') ? 1 : 0, costUsd: totals.costUsd,
      notes: `${job.finishedStatus ?? 'running'}; accepted/calls: ${stages || 'none yet'}` };
  });
  const finishedCount = jobs.filter(job => job.finishedStatus === 'bundle finished').length;
  journal.update({ rows, facts: { 'Bundles finished': `${finishedCount} of ${jobs.length} queued` } }, { force });
}
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('load');
  await page.waitForFunction(() => typeof window.electronAPI?.queueLocalApplication === 'function'
    && typeof window.electronAPI?.claudeApplicationEnsure === 'function'
    && typeof window.electronAPI?.claudeApplicationRetry === 'function', null, { timeout: 120_000 });
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) fs.appendFile(path.join(runRoot, 'renderer-console.log'), `${message.type()} ${message.text()}\n`).catch(() => {}); });

  for (const jobId of retryIds) {
    const input = JSON.parse(await fs.readFile(path.join(canvasDir, '.local-ai', 'jobs', jobId, 'input.json'), 'utf8'));
    const retried = await page.evaluate(value => window.electronAPI.claudeApplicationRetry(value), { jobId, canvasFilePath });
    log({ event: 'retried', jobId, title: input.job.title, company: input.job.company, retried });
    jobs.push({ jobId, title: input.job.title, company: input.job.company, done: false, lastSignature: '' });
  }
  for (const inputPath of localInputs) {
   // A job the app refuses to queue (for example an unverified official posting) is skipped, not fatal.
   try {
    const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
    // Generate now requires a fresh official-posting lookup before queueing.
    const prepared = await page.evaluate(value => window.electronAPI.prepareOfficialPostingForGeneration(value),
      { job: input.job, nodeId: input.nodeId, cardId: input.nodeId, manualAiRunId: `harness-${Date.now()}` });
    log({ event: 'official-posting-prepared', ok: Boolean(prepared?.resolutionId ?? prepared?.data?.resolutionId),
      keys: Object.keys(prepared || {}), lookup: prepared?.lookup ?? prepared?.data?.lookup ?? null });
    const resolutionId = prepared?.resolutionId ?? prepared?.data?.resolutionId;
    if (!resolutionId) throw new Error(`official posting prepare failed: ${JSON.stringify(prepared).slice(0, 600)}`);
    const args = {
      resolutionId,
      nodeId: input.nodeId, canvasFilePath, priorLocalApplicationId: null, transport: 'paste', job: input.job,
      careerSnapshotId: input.careerSnapshotId, additionalNotes: input.additionalNotes || '',
      reasoning: input.reasoning, matchScore: input.matchScore,
      ...(candidateCount ? { candidateCount } : {}),
    };
    const queued = await page.evaluate(value => window.electronAPI.queueLocalApplication(value), args);
    if (!queued?.success || !queued.localJob?.id) throw new Error(`queue-local-application failed: ${queued?.error || JSON.stringify(queued)}`);
    const jobId = queued.localJob.id;
    const ensured = await page.evaluate(value => window.electronAPI.claudeApplicationEnsure(value), { jobId, canvasFilePath });
    log({ event: 'queued', jobId, title: input.job.title, company: input.job.company, localJob: queued.localJob, ensured });
    jobs.push({ jobId, input: path.basename(inputPath), title: input.job.title, company: input.job.company, done: false, lastSignature: '' });
   } catch (error) {
    log({ event: 'queue-skipped', input: path.basename(inputPath), message: String(error?.message || error).slice(0, 400) });
   }
  }

  const started = Date.now();
  recordJournal(true);
  while (jobs.some(job => !job.done) && Date.now() - started < maxMs) {
    await new Promise(resolve => setTimeout(resolve, 30_000));
    const states = await page.evaluate(value => window.electronAPI.claudeApplicationStatus(value), { jobIds: jobs.map(job => job.jobId) });
    for (const job of jobs) {
      if (job.done) continue;
      const runner = states?.states?.[job.jobId] || null;
      const local = await page.evaluate(value => window.electronAPI.getLocalApplicationStatus(value), { jobId: job.jobId, canvasFilePath });
      const localJob = local?.localJob || null;
      const signature = JSON.stringify([runner?.status, runner?.stage, runner?.code, localJob?.status, localJob?.revision, localJob?.stage]);
      if (signature !== job.lastSignature) {
        job.lastSignature = signature;
        log({ event: 'state', jobId: job.jobId, minutes: Math.round((Date.now() - started) / 6000) / 10, runner,
          local: localJob ? { status: localJob.status, revision: localJob.revision, stage: localJob.stage, logCount: localJob.logCount, message: localJob.message } : null });
      }
      if (['done', 'failed', 'needs-review'].includes(runner?.status) || ['paste-completed', 'failed'].includes(localJob?.status)) {
        job.done = true;
        job.runner = runner;
        job.local = localJob;
        job.finishedStatus = runner?.status === 'failed' || localJob?.status === 'failed'
          ? `failed at ${runner?.stage ?? localJob?.stage ?? '?'}${runner?.code ? ` (${runner.code})` : ''}` : 'bundle finished';
        recordJournal(true);
      }
    }
    recordJournal(false);
  }

  for (const job of jobs) {
    const dir = path.join(canvasDir, '.local-ai', 'jobs', job.jobId);
    const resultText = await fs.readFile(path.join(dir, 'result.json'), 'utf8').catch(() => null);
    job.resultPresent = Boolean(resultText);
    if (resultText) {
      const result = JSON.parse(resultText);
      job.coverLetter = result.coverLetter ?? null;
      job.resume = result.resume ?? null;
      await fs.writeFile(path.join(runRoot, `${job.jobId}.result.json`), resultText, { mode: 0o600 });
    }
    if (job.runner?.status === 'done') {
      // Exercise the renderer-side import (page rendering and the measured fit check) as the card would.
      try {
        const imported = await page.evaluate(value => window.electronAPI.importLocalApplication(value), { jobId: job.jobId, canvasFilePath, expectedResultSha256: '' });
        const { localApplication, ...rest } = imported || {};
        job.import = { ...rest, localApplication: localApplication ? { status: localApplication.status, fitMessage: localApplication.fitMessage ?? null,
          keys: Object.keys(localApplication), htmlChars: typeof localApplication.html === 'string' ? localApplication.html.length : null } : null };
        if (typeof localApplication?.html === 'string') await fs.writeFile(path.join(runRoot, `${job.jobId}.Application.html`), localApplication.html, { mode: 0o600 });
      } catch (error) {
        job.import = { error: String(error?.message || error) };
      }
    }
    log({ event: 'finished', jobId: job.jobId, title: job.title, runner: job.runner, local: job.local, resultPresent: job.resultPresent, import: job.import ?? null });
  }
  await fs.writeFile(path.join(runRoot, 'summary.json'), JSON.stringify({ runRoot, canvasFilePath, jobs }, null, 2), { mode: 0o600 });
  recordJournal(true);
  journal.finish(jobs.every(job => job.done) ? 'finished' : `stopped at --max-minutes ${maxMs / 60_000} with ${jobs.filter(job => !job.done).length} bundle(s) unfinished`);
} catch (error) {
  log({ event: 'harness-error', message: String(error?.stack || error) });
  journal.finish(`harness error: ${String(error?.message || error).slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  await shutdown('finished');
}
