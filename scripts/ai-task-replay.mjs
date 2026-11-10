#!/usr/bin/env node
// Offline replay of two worker tasks (job-preference-evaluation, job-scoring)
// on Claude vs DeepSeek configurations, using the app's own prompts, schemas and
// validators. Electron is never launched. The canvas it reads is private, so
// nothing from it is printed (counts only) and everything is written outside the
// repository with owner-only permissions.
//
//   node --import ./scripts/test-stubs/register.mjs scripts/ai-task-replay.mjs \
//     --task job-scoring --canvas <file> --user-data <dir> --out <dir> [--dry-run]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDurableOutDir, createRunJournal, takeEphemeralFlag, tallyRows } from './ai-test-journal.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TASKS = ['job-preference-evaluation', 'job-scoring', 'job-official-posting-research', 'job-official-posting-match',
  'job-compensation-research-batch', 'job-preference-research-batch'];
// Tasks whose worker profile carries web tools: raw (unschematized) grounded research answers.
export const RESEARCH_TASKS = ['job-official-posting-research', 'job-compensation-research-batch', 'job-preference-research-batch'];
// Tasks that cannot be replayed faithfully from stored data. --task stops with this one-line, evidenced reason.
export const UNREPLAYABLE_TASKS = {
  'job-compensation-research-batch': 'electron/ipc/jobs.js runFreshCompensationPipeline calls the module-level callLLMRaw (no caller seam) with cohorts built live from the profile and earlier grounded role-band/location lookups (researchParameters via compensationResearchParametersForGroup); board rows persist none of roleFamily, experienceBand or seniority.',
};
export const REASONING_LEVELS = ['off', 'low', 'medium', 'high', 'max'];
// Claude at an explicit model/effort (cheapest-first ladders); `max` is a DeepSeek-only reasoning level.
export const CLAUDE_SETTING_MODELS = ['haiku', 'sonnet', 'opus'];
export const CLAUDE_SETTING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
export const DEFAULT_CONFIGS = ['claude', ...['flash', 'pro'].flatMap(model => REASONING_LEVELS.map(level => `${model}:${level}`))].join(',');
const ROUTES = { flash: 'deepseek-flash', pro: 'deepseek-pro' };
const RESEARCH_MAX_TURNS = 16;

export class StopCapture extends Error {
  constructor() { super('capture complete'); this.name = 'StopCapture'; }
}

function positiveInt(name, value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
}

export function parseConfigs(list) {
  const configs = [];
  for (const raw of String(list || '').split(',').map(part => part.trim()).filter(Boolean)) {
    if (raw === 'claude') { configs.push({ id: 'claude', kind: 'claude' }); continue; }
    if (raw.startsWith('claude:')) {
      // claude:<model>:<effort> runs the same Claude stage as the baseline with a cheaper or stronger setting.
      const [family, model, effort, extra] = raw.split(':');
      if (family !== 'claude' || !CLAUDE_SETTING_MODELS.includes(model) || !CLAUDE_SETTING_EFFORTS.includes(effort) || extra !== undefined) {
        throw new Error(`Unknown config ${raw}.`);
      }
      configs.push({ id: raw, kind: 'claude-setting', model, effort });
      continue;
    }
    const [model, reasoning, extra] = raw.split(':');
    if (!ROUTES[model] || !REASONING_LEVELS.includes(reasoning) || extra !== undefined) throw new Error(`Unknown config ${raw}.`);
    configs.push({ id: raw, kind: 'offload', route: ROUTES[model], reasoning });
  }
  if (!configs.length) throw new Error('--configs lists no configs.');
  // Claude is the baseline the flow itself needs, so it always runs.
  if (!configs.some(config => config.kind === 'claude')) configs.unshift({ id: 'claude', kind: 'claude' });
  return configs;
}

export function parseArgs(argv) {
  const opts = { task: null, canvas: null, userData: null, out: null, batches: 6, reps: 3, claudeReps: 3, concurrency: 4, configs: DEFAULT_CONFIGS, dryRun: false };
  const valueFlags = { '--task': 'task', '--canvas': 'canvas', '--user-data': 'userData', '--out': 'out', '--configs': 'configs',
    '--batches': 'batches', '--reps': 'reps', '--claude-reps': 'claudeReps', '--concurrency': 'concurrency' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') { opts.dryRun = true; continue; }
    if (!valueFlags[flag]) throw new Error(`Unknown argument ${flag}.`);
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value.`);
    opts[valueFlags[flag]] = argv[++i];
  }
  if (!TASKS.includes(opts.task)) throw new Error(`--task must be one of ${TASKS.join(', ')}.`);
  if (!opts.canvas) throw new Error('--canvas <path> is required.');
  if (!opts.out) throw new Error('--out <dir> is required.');
  if (opts.task === 'job-scoring' && !opts.userData) throw new Error('--user-data <dir> is required for job-scoring.');
  for (const name of ['batches', 'reps', 'claudeReps', 'concurrency']) opts[name] = positiveInt(`--${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, opts[name]);
  opts.configs = parseConfigs(opts.configs);
  return opts;
}

function resolveReal(target) {
  let current = path.resolve(target);
  const rest = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  let real = current;
  try { real = fs.realpathSync(current); } catch { /* keep the resolved path */ }
  return path.join(real, ...rest);
}

/** The results hold private data, so a directory inside the repository is refused outright. */
export function assertOutsideRepo(outDir, repoRoot = REPO_ROOT) {
  const out = resolveReal(outDir);
  const root = resolveReal(repoRoot);
  const rel = path.relative(root, out);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('--out must be outside the repository: replay results contain private data.');
  }
  return out;
}

export function prepareOutDir(outDir) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outDir, 0o700);
  const texts = path.join(outDir, 'texts');
  fs.mkdirSync(texts, { recursive: true, mode: 0o700 });
  fs.chmodSync(texts, 0o700);
}

export const resultKey = (task, batch, config, rep) => `${task}\u0000${batch}\u0000${config}\u0000${rep}`;

export function loadResults(outDir) {
  const done = new Map();
  let text = '';
  try { text = fs.readFileSync(path.join(outDir, 'results.jsonl'), 'utf8'); } catch { return done; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row && typeof row.task === 'string' && Number.isInteger(row.batch) && typeof row.config === 'string' && Number.isInteger(row.rep)) {
      done.set(resultKey(row.task, row.batch, row.config, row.rep), row);
    }
  }
  return done;
}

function writePrivate(file, content, { append = false } = {}) {
  if (append) fs.appendFileSync(file, content, { mode: 0o600 });
  else fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active -= 1; pump(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

// ---- Selection -----------------------------------------------------------

const STAMP_PATHS = [
  row => row?.preferenceAssessment?.evaluatedAt, row => row?.scoringEvidenceReceipt?.scoredAt, row => row?.scoredAt,
  row => row?.evaluatedAt, row => row?.foundAt, row => row?.scrapedAt, row => row?.addedAt,
];

export function rowStamp(row) {
  let best = 0;
  for (const read of STAMP_PATHS) {
    const time = Date.parse(read(row));
    if (Number.isFinite(time) && time > best) best = time;
  }
  return best;
}

const hasPreferenceResult = row => Array.isArray(row?.preferenceAssessment?.matches) && row.preferenceAssessment.matches.length > 0;
const rowScore = row => (Number.isFinite(row?.matchScore) ? row.matchScore : Number.isFinite(row?.score) ? row.score : null);
const hasScoreResult = row => rowScore(row) !== null;
const hasOfficialPostingResult = row => Boolean(row?.officialPosting) && typeof row.officialPosting === 'object' && typeof row.officialPosting.outcome === 'string';
const POSTING_URL = /^https:\/\/[^\s]+$/iu;

/**
 * The https URLs a stored official-posting result points at (source, apply destination, cited alternatives), deduplicated.
 * They stand in for the research step's candidates so the match flow needs no research call.
 */
export function storedPostingUrls(row) {
  const posting = row?.officialPosting;
  if (!posting || typeof posting !== 'object') return [];
  const urls = [];
  const add = (value) => {
    const url = typeof value === 'string' ? value.trim() : '';
    if (POSTING_URL.test(url) && !urls.includes(url)) urls.push(url);
  };
  add(posting.sourceUrl);
  add(posting.officialApplyUrl);
  for (const alternative of Array.isArray(posting.alternatives) ? posting.alternatives : []) add(alternative?.url);
  return urls;
}

const hasMatchSource = row => hasOfficialPostingResult(row) && storedPostingUrls(row).length > 0;
const isCompanyCriterion = match => Boolean(match?.strict) && ['company', 'perk'].includes(match?.category);
/** A stored strict company/perk match that research already resolved (confirmed/conflicts). */
const hasResearchedPreference = row => (Array.isArray(row?.preferenceAssessment?.matches) ? row.preferenceAssessment.matches : [])
  .some(match => isCompanyCriterion(match) && ['confirmed', 'conflicts'].includes(match.outcome));

/** Puts researched strict company/perk matches back to the pending state the app researches from. */
export function resetResearchedMatches(row) {
  const matches = row.preferenceAssessment.matches.map((match) => {
    if (!isCompanyCriterion(match) || !['confirmed', 'conflicts'].includes(match.outcome)) return match;
    const rest = { ...match };
    for (const key of ['evidenceQuote', 'sourceUrls', 'evidence', 'source', 'sources', 'reason']) delete rest[key];
    return { ...rest, outcome: 'unverified' };
  });
  return { ...row, preferenceAssessment: { ...row.preferenceAssessment, matches } };
}

/** Rows that already carry a Claude result for the task, most recent first (later array position wins ties). */
export function selectRowsForTask(task, rows) {
  const eligible = task === 'job-scoring' ? hasScoreResult
    : task === 'job-official-posting-research' ? hasOfficialPostingResult
      : task === 'job-official-posting-match' ? hasMatchSource
      : task === 'job-preference-research-batch' ? hasResearchedPreference : hasPreferenceResult;
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row && typeof row === 'object' && eligible(row))
    .sort((a, b) => rowStamp(b.row) - rowStamp(a.row) || b.index - a.index)
    .map(({ row }) => row);
}

export function snapshotIdOf(row) {
  const id = row?.scoringEvidenceReceipt?.careerSnapshotId || row?.careerSnapshotId;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** One career record per scoring flow: the most recent eligible row's snapshot and every eligible row on it. */
export function selectScoringGroup(rows) {
  const ordered = selectRowsForTask('job-scoring', rows).filter(row => snapshotIdOf(row));
  if (!ordered.length) return null;
  const careerSnapshotId = snapshotIdOf(ordered[0]);
  return { careerSnapshotId, jobs: ordered.filter(row => snapshotIdOf(row) === careerSnapshotId) };
}

/** The first node whose data has a preference plan and rows/jobs arrays, searching nested groups too. */
export function findBoardNode(root) {
  const seen = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 24) return null;
    seen.add(value);
    const data = value.data;
    if (data && typeof data === 'object' && data.preferenceEvaluation?.preferencePlan && (Array.isArray(data.rows) || Array.isArray(data.jobs) || Array.isArray(data.scoredJobs))) return value;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(root, 0);
}

// ---- Replay core (every outside effect is injected) ------------------------

const sha = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const codeOf = error => (typeof error?.code === 'string' && error.code) || error?.name || 'ERROR';
const safeName = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * Runs the app flow with an injected caller. The caller materializes each call,
 * answers it with Claude (so the flow can proceed) and stops the flow after
 * `batches` calls; every other config x rep is then run on the captured calls.
 *
 *   startFlow(caller)             drives evaluateJobPreferences / scoreRowsOnCareerRecord
 *   materialize(prompt, opts, n)  -> { prompt, cachedPrefix, responseSchema, responseValidator, itemCount, task }
 *   execute({ config, rep, call }) -> { text, costUsd, durationMs, model, usage }
 *   validate(call, text)          -> parsed value, throwing when invalid
 */
export async function replayTask({ task, outDir, startFlow, materialize, execute, validate, configs, reps, claudeReps, batches, concurrency, dryRun = false, log = () => {}, journal = null }) {
  const done = loadResults(outDir);
  // journal: validity and cost per config in docs/ai-test-runs.md, rewritten as rows land.
  const recordJournal = force => journal?.update({ rows: replayJournalRows([...done.values()]) }, { force });
  // Only the plain claude baseline drives the flow; a claude-setting config is measured like an offload one.
  const claude = configs.find(config => config.kind === 'claude');
  const limit = createLimiter(concurrency);
  const calls = [];
  const inflight = [];
  let fatal = null;
  let stop = null;
  const repsFor = config => (config.kind === 'claude' ? claudeReps : reps);

  const runCell = (call, config, rep) => {
    const key = resultKey(task, call.batch, config.id, rep);
    if (done.has(key)) return Promise.resolve(done.get(key));
    return limit(async () => {
      if (fatal) return null;
      const started = Date.now();
      const base = { task, batch: call.batch, config: config.id, rep, promptSha: call.promptSha };
      let row;
      try {
        const reply = await execute({ config, rep, call });
        const text = typeof reply?.text === 'string' ? reply.text : '';
        writePrivate(path.join(outDir, 'texts', `${call.batch}-${safeName(config.id)}-${rep}.txt`), text);
        let answer = null;
        let code = null;
        try { answer = validate(call, text); } catch (error) { code = codeOf(error); }
        row = { ...base, ok: true, valid: code === null, code, costUsd: Number.isFinite(reply?.costUsd) ? reply.costUsd : null,
          latencyMs: Number.isFinite(reply?.durationMs) ? reply.durationMs : Date.now() - started,
          model: reply?.model ?? null, usage: reply?.usage ?? null, ...(reply?.webTools ? { webTools: reply.webTools } : {}),
          answer: code === null ? answer : null };
      } catch (error) {
        if (error?.code === 'OFFLOAD_CREDIT_EXHAUSTED') { fatal = error; return null; }
        row = { ...base, ok: false, valid: false, code: codeOf(error), costUsd: Number.isFinite(error?.costUsd) ? error.costUsd : null,
          latencyMs: Date.now() - started, model: null, usage: null, answer: null };
      }
      writePrivate(path.join(outDir, 'results.jsonl'), `${JSON.stringify(row)}\n`, { append: true });
      done.set(resultKey(task, call.batch, config.id, rep), row);
      recordJournal(false);
      return row;
    });
  };

  const answerFlow = async call => {
    const existing = Array.from({ length: claudeReps }, (_, i) => done.get(resultKey(task, call.batch, claude.id, i + 1)));
    for (const row of existing) {
      if (row && row.promptSha && row.promptSha !== call.promptSha) {
        stop = new Error(`Batch ${call.batch} no longer matches the recorded run; use a new --out directory.`);
        throw stop;
      }
    }
    if (dryRun) {
      const recorded = existing.find(row => row?.valid === true && row.answer !== null && row.answer !== undefined);
      if (recorded) return recorded.answer;
      throw new StopCapture();
    }
    const rows = await Promise.all(Array.from({ length: claudeReps }, (_, i) => runCell(call, claude, i + 1)));
    if (fatal) throw fatal;
    const first = rows.find(row => row?.valid === true && row.answer !== null && row.answer !== undefined);
    if (!first) {
      stop = new Error(`No valid Claude answer for batch ${call.batch}; stopping.`);
      throw stop;
    }
    return first.answer;
  };

  const caller = (prompt, opts = {}) => {
    const batch = calls.length + 1;
    if (batch > batches) return Promise.reject(new StopCapture());
    const call = { ...materialize(prompt, opts, batch), batch, task };
    call.promptChars = call.prompt.length;
    call.promptSha = sha(`${call.prompt}\u0000${call.cachedPrefix || ''}`);
    calls.push(call);
    const work = answerFlow(call);
    inflight.push(work);
    return work;
  };

  let flowError = null;
  try { await startFlow(caller); } catch (error) { flowError = error; }
  await Promise.allSettled(inflight);
  if (fatal) throw fatal;
  if (stop) throw Object.assign(stop, { userFacing: true });
  if (flowError && !(flowError instanceof StopCapture)) {
    if (!calls.length) throw flowError;
    log(`flow ended early (${codeOf(flowError)}) after capturing ${calls.length} call(s)`);
  }
  if (!dryRun) {
    const cells = [];
    for (const call of calls) for (const config of configs) for (let rep = 1; rep <= repsFor(config); rep += 1) cells.push(runCell(call, config, rep));
    await Promise.all(cells);
    if (fatal) throw fatal;
  }
  return { calls, results: done.size };
}

// ---- Real app wiring --------------------------------------------------------

async function loadApp() {
  const ipc = rel => import(new URL(`../electron/ipc/${rel}`, import.meta.url).href);
  const [nonApi, worker, offload, profiles, sdk, runner] = await Promise.all([
    ipc('nonApiAi.js'), ipc('claudeTaskWorker.js'), ipc('offloadTextCall.js'), ipc('claudeTaskProfiles.js'),
    ipc('claudeApplicationSdkStage.js'), ipc('claudeApplicationRunner.js'),
  ]);
  return { ...nonApi, ...worker, ...offload, ...profiles, ...sdk, ...runner };
}

/** The same prompt/cachedPrefix pair requestNonApiAi hands a worker. */
export function appMaterialize(app) {
  return (prompt, opts) => {
    const { task, responseSchema, cachedPrefix, grounding } = opts;
    return {
      prompt: app.materializeNonApiPrompt({ prompt, cachedPrefix, task, responseSchema, grounding }),
      cachedPrefix: cachedPrefix ? (responseSchema ? app.hardenStructuredTaskPrompt(task, cachedPrefix) : String(cachedPrefix)) : '',
      responseSchema, responseValidator: opts.responseValidator, itemCount: opts.hints?.itemCount ?? null,
    };
  };
}

export function appValidate(app) {
  return (call, text) => {
    const value = app.validateNonApiAiSubmission({ response: text, responseSchema: call.responseSchema, responseValidator: call.responseValidator,
      task: call.task, expectedHandoffCode: null, requireHandoffCode: false });
    // Raw grounded research is fed back to the flow (and scored) as its own text.
    return call.responseSchema ? value : text;
  };
}

/**
 * The child environment without this process's own Claude Code session and Electron launcher: every name starting with
 * CLAUDE or ANTHROPIC plus ELECTRON_RUN_AS_NODE is dropped before claudeChildEnv shapes the child's.
 */
export function replayChildEnv(env) {
  const keep = ([name]) => !name.startsWith('CLAUDE') && !name.startsWith('ANTHROPIC') && name !== 'ELECTRON_RUN_AS_NODE';
  return Object.fromEntries(Object.entries(env || {}).filter(keep));
}

/** Mirrors claudeTaskWorker.serve(): Claude through the SDK stage, DeepSeek through offloadTextCall. */
export function appExecute(app, task, signal) {
  const profile = app.claudeTaskProfile(task);
  // Same as claudeTaskWorker.serve(): a profile with tools gets them plus the research turn budget.
  const tools = profile.tools ? String(profile.tools).split(',') : [];
  return async ({ config, call }) => {
    const cached = app.cachedPromptParts(call.prompt, call.cachedPrefix);
    if (config.kind === 'offload') {
      // REPLAY_MAX_TOKENS measures a larger output cap than the app's default.
      const maxTokens = Number(process.env.REPLAY_MAX_TOKENS) || undefined;
      return app.offloadTextCall({ messages: app.handoffMessages(cached), route: config.route, reasoning: config.reasoning, tag: task, signal,
        ...(maxTokens ? { maxTokens } : {}), ...(tools.length ? { webTools: {} } : {}) });
    }
    // This tool runs inside a Claude Code session, and its CLAUDE*/ANTHROPIC* (plus Electron) env must not reach the child.
    const binary = app.resolveClaudeBinary({ env: process.env, homedir: os.homedir() });
    const stage = { binary, env: app.claudeChildEnv(replayChildEnv(process.env), path.dirname(binary)), cwd: os.tmpdir() };
    // A claude-setting config is the baseline call with its own model/effort; the baseline keeps the task profile's.
    const setting = config.kind === 'claude-setting' ? { model: config.model, effort: config.effort } : { model: profile.model, effort: profile.effort };
    return app.runClaudeSdkStage({
      ...stage, ...cached, env: cached.systemAppend ? stage.env : { ...stage.env, DISABLE_PROMPT_CACHING: '1' },
      pageImages: [], signal, ...setting, persistSession: false,
      ...(tools.length ? { tools, maxTurns: RESEARCH_MAX_TURNS } : {}),
    });
  };
}

// Counts per eligible row cap: enough rows for the requested batches, never the whole pool.
const ROWS_PER_BATCH = { 'job-preference-evaluation': 60, 'job-scoring': 40, 'job-official-posting-research': 30, 'job-official-posting-match': 2, 'job-preference-research-batch': 40 };

function chooseRows(task, data) {
  const arrays = [data.scoredJobs, data.rows, data.jobs].filter(Array.isArray);
  let best = { rows: [], eligible: 0 };
  for (const rows of arrays) {
    const eligible = task === 'job-scoring' ? (selectScoringGroup(rows)?.jobs.length || 0) : selectRowsForTask(task, rows).length;
    if (eligible > best.eligible) best = { rows, eligible };
  }
  return { ...best, total: arrays.reduce((sum, rows) => sum + rows.length, 0) };
}

/**
 * job-official-posting-match: the app's own resolveOfficialPostings on stored rows. Pages are re-downloaded through
 * fetchPosting (no rendering), the research step is answered from the row's stored URLs with no AI call (and so never
 * recorded as a batch), and only the judge requests (callMatch) are captured through caller. The store is in memory.
 */
export function matchFlow({ service, requestId, fetchPosting, rows, signal }) {
  const jobs = rows.map((row) => { const rest = { ...row }; delete rest.officialPosting; delete rest.postedBy; return rest; });
  const candidateUrlsByRow = rows.map(storedPostingUrls);
  const ids = jobs.map(job => requestId(job));
  const saved = [];
  // Never the user's store: nothing is read, and saves stay in this array.
  const store = { find: async () => null, save: async (job, payload) => { saved.push(payload); return { ...payload }; } };
  const answerResearch = async (prompt) => ids.filter(id => String(prompt).includes(id))
    .map(id => `BEGIN OFFICIAL POSTING RESEARCH ${id}\nNOT FOUND\nEND OFFICIAL POSTING RESEARCH ${id}`).join('\n');
  return {
    itemCount: jobs.length, meta: { task: 'job-official-posting-match', research: 'stored URLs, no AI call', store: 'in-memory' }, saved,
    startFlow: caller => service.resolveOfficialPostings(jobs, { signal, callRaw: answerResearch, callMatch: caller, store, bypassCache: true,
      candidateUrlsByRow, snapshotFetch: (...args) => fetchPosting(...args), snapshotRender: null }),
  };
}

async function buildFlow({ task, opts, node, rows, signal }) {
  const cap = opts.batches * ROWS_PER_BATCH[task];
  if (task === 'job-official-posting-match') {
    const ipc = file => import(new URL(`../electron/ipc/${file}`, import.meta.url).href);
    const [service, resolver, fetcher] = await Promise.all([ipc('officialPostingService.js'), ipc('officialPostingResolver.js'), ipc('officialPostingFetch.js')]);
    return matchFlow({ service, requestId: resolver.officialPostingRequestId, fetchPosting: fetcher.fetchOfficialPosting,
      rows: selectRowsForTask(task, rows).slice(0, cap), signal });
  }
  if (task === 'job-preference-evaluation') {
    const { evaluateJobPreferences } = await import(new URL('../electron/ipc/jobPreferences.js', import.meta.url).href);
    const { normalizeJobPreferencePlan } = await import(new URL('../electron/ipc/jobPreferences.js', import.meta.url).href);
    const plan = node.data.preferenceEvaluation.preferencePlan;
    const jobs = selectRowsForTask(task, rows).slice(0, cap).map(row => { const rest = { ...row }; delete rest.preferenceAssessment; return rest; });
    const strictPreferenceIds = normalizeJobPreferencePlan(plan).strictRequirements.map(item => item.id);
    return {
      itemCount: jobs.length, meta: { task, strictPreferenceIds },
      startFlow: caller => evaluateJobPreferences({ jobs, jobPreferences: node.data.jobPreferences, preferencePlan: plan, signal,
        callText: caller, callRaw: async () => { throw new Error('Company research is deferred in replay.'); },
        deferCompanyResearch: true, checkFits: async () => ({ fits: true }) }),
    };
  }
  if (task === 'job-official-posting-research') {
    const service = await import(new URL('../electron/ipc/officialPostingService.js', import.meta.url).href);
    const jobs = selectRowsForTask(task, rows).slice(0, cap).map(row => { const rest = { ...row }; delete rest.officialPosting; delete rest.postedBy; return rest; });
    // Offline: no store reads/writes, no page downloads; only the finder (research) prompts are captured.
    const store = { find: async () => null, save: async () => { throw new Error('Replay never writes the posting store.'); } };
    return {
      itemCount: jobs.length, meta: { task },
      startFlow: caller => service.resolveOfficialPostings(jobs, { signal, callRaw: caller, callMatch: async () => { throw new StopCapture(); },
        store, bypassCache: true, snapshotFetch: async () => { throw new Error('Page downloads are disabled in replay.'); }, snapshotRender: null }),
    };
  }
  if (task === 'job-preference-research-batch') {
    const prefs = await import(new URL('../electron/ipc/jobPreferences.js', import.meta.url).href);
    const jobs = selectRowsForTask(task, rows).slice(0, cap).map(resetResearchedMatches);
    return {
      itemCount: jobs.length, meta: { task },
      // The structured assessment that follows the grounded research is a different task and is not replayed.
      startFlow: caller => prefs.researchDeferredJobPreferences({ jobs, signal, callRaw: caller, callText: async () => { throw new StopCapture(); } }),
    };
  }
  const jobsModule = await import(new URL('../electron/ipc/jobs.js', import.meta.url).href);
  const { careerSnapshotStorageRoot } = await import(new URL('../electron/ipc/careerSnapshot.js', import.meta.url).href);
  const group = selectScoringGroup(rows);
  const root = careerSnapshotStorageRoot(path.resolve(opts.userData));
  const jobs = group.jobs.slice(0, cap);
  return {
    itemCount: jobs.length, meta: { task },
    startFlow: caller => jobsModule.__scoreRowsOnCareerRecordForReplay({ jobs, careerSnapshotId: group.careerSnapshotId, nodeId: String(node.id ?? 'replay'), signal,
      callScore: caller, runGapReview: async () => undefined,
      readPinned: ({ careerSnapshotId }) => jobsModule.resolveCompensationCareerInput({ careerSnapshotId, root }) }),
  };
}

/** Journal rows for a replay: validity and cost per config (agreement comes from ai-task-replay-score.mjs). */
export function replayJournalRows(rows = []) {
  return tallyRows(rows, row => row.config).map(group => ({ ...group, notes: 'agreement: run ai-task-replay-score.mjs --out <dir>' }));
}

export async function main(argv, deps = {}) {
  let opts;
  let outDir;
  try {
    opts = parseArgs(argv);
    outDir = assertOutsideRepo(opts.out);
    // Only the CLI entry sets requireDurable; tests call main() without it.
    if (deps.requireDurable && !opts.dryRun) assertDurableOutDir(outDir, { allowEphemeral: deps.allowEphemeral === true });
  } catch (error) { console.error(error.message); return 2; }
  const journal = !opts.dryRun && deps.journalFactory ? deps.journalFactory({
    tool: 'ai-task-replay', task: opts.task, label: opts.configs.map(config => config.id).join(', '), outDir, command: deps.command ?? '',
  }) : null;
  try {
    const code = await replayMain(opts, outDir, journal);
    journal?.finish(code === 0 ? 'finished' : `stopped with exit code ${code}`);
    return code;
  } catch (error) {
    journal?.finish(`failed: ${codeOf(error)}`);
    throw error;
  }
}

async function replayMain(opts, outDir, journal) {
  const { task } = opts;
  if (UNREPLAYABLE_TASKS[task]) { console.error(`Replay stopped: ${task} cannot be replayed faithfully: ${UNREPLAYABLE_TASKS[task]}`); return 1; }
  try {
    const { parseWorkspaceText, restoreWorkspaceContent } = await import(new URL('../electron/ipc/workspaceContentPool.js', import.meta.url).href);
    // A pooled canvas keeps repeated values as $canvasRef entries; restore them first.
    const parsed = parseWorkspaceText(fs.readFileSync(opts.canvas, 'utf8'));
    const canvas = restoreWorkspaceContent(parsed) ?? parsed;
    const node = findBoardNode(canvas);
    if (!node) throw Object.assign(new Error('No Job Board/Search node with a preference plan and rows was found in the canvas.'), { userFacing: true });
    const { rows, eligible, total } = chooseRows(task, node.data);
    console.log(`board node ${node.type ?? '?'} ${node.id ?? '?'}: ${total} rows, ${eligible} with a Claude ${task} result`);
    if (!eligible) throw new Error('No row carries a Claude result for this task.');
    prepareOutDir(outDir);
    const app = await loadApp();
    const controller = new AbortController();
    const flow = await buildFlow({ task, opts, node, rows, app, signal: controller.signal });
    writePrivate(path.join(outDir, 'meta.json'), `${JSON.stringify(flow.meta)}\n`);
    const { calls, results } = await replayTask({
      task, outDir, startFlow: flow.startFlow, materialize: appMaterialize(app), execute: appExecute(app, task, controller.signal), validate: appValidate(app),
      configs: opts.configs, reps: opts.reps, claudeReps: opts.claudeReps, batches: opts.batches, concurrency: opts.concurrency, dryRun: opts.dryRun, log: line => console.log(line),
      journal,
    });
    const profile = app.claudeTaskProfile(task);
    if (opts.dryRun) {
      for (const call of calls) console.log(`batch ${call.batch}: prompt ${call.promptChars} chars, ${call.itemCount ?? '?'} items, profile ${profile.model}/${profile.effort}`);
      console.log(`dry run: ${calls.length} batch(es) captured, no AI call made`);
    } else {
      console.log(`captured ${calls.length} batch(es); ${results} result rows in ${path.join(outDir, 'results.jsonl')}`);
    }
    return 0;
  } catch (error) {
    if (error?.code === 'OFFLOAD_CREDIT_EXHAUSTED') {
      console.error('DeepSeek credit is exhausted. Add credit and re-run with the same --out directory to resume.');
      return 3;
    }
    console.error(`Replay stopped: ${codeOf(error)}${error?.userFacing ? `: ${error.message}` : ''}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cliArgs, allowEphemeral] = takeEphemeralFlag(process.argv.slice(2));
  main(cliArgs, { requireDurable: true, allowEphemeral, journalFactory: allowEphemeral ? null : createRunJournal,
    command: `node scripts/ai-task-replay.mjs ${cliArgs.join(' ')}` }).then(code => { process.exitCode = code; });
}
