#!/usr/bin/env node
// Offline effort ladder: replay real stored AI prompts on Claude at several
// model/effort settings so the cheapest setting that still passes the app's own
// validators can be chosen. Electron is never launched and the Claude CLI is
// never called from tests: every runner is injectable.
//
// The captured prompts and answers are private, so nothing but counts and costs
// is printed, output directories inside the repository are refused, and every
// written file is owner-only (0600, directories 0700).
//
//   node --import ./scripts/test-stubs/register.mjs scripts/claude-effort-ladder.mjs \
//     capture-editorial --runs-dir <dir> --out <records.jsonl> [--limit 6]
//   node --import ./scripts/test-stubs/register.mjs scripts/claude-effort-ladder.mjs \
//     capture-stage --runs-dir <dir> --stage <name> --out <records.jsonl> [--limit 12] [--accepted-only]
//   node --import ./scripts/test-stubs/register.mjs scripts/claude-effort-ladder.mjs \
//     capture-archive --archive-dir <dir> --stage <name> --out <records.jsonl> [--limit N]
//   node --import ./scripts/test-stubs/register.mjs scripts/claude-effort-ladder.mjs \
//     run --records <records.jsonl> --configs opus:xhigh,opus:high --reps 1 --out <dir> [--concurrency 4]
//   node --import ./scripts/test-stubs/register.mjs scripts/claude-effort-ladder.mjs \
//     capture-career --source <file.md> --out <dir> --ladder-tasks career-profile-compile,career-profile-audit-skills \
//     --configs <list> --reps 1 [--concurrency 4] [--max-calls N] \
//     [--baseline-from <previous capture dir>] [--only-records <recordId|sha256-prefix,...>] \
//     [--profile-override <task>=<model>:<effort> ...]
//
// --baseline-from replays the stored baseline answers of an earlier capture
// instead of paying for them again (a miss is an error, never a live call), and
// --only-records climbs the ladder for a subset of the captured calls.
// --profile-override is repeatable: that one task is answered live at the given
// model/effort (never replayed from --baseline-from, even when its row exists)
// while every other task keeps its production profile. --max-calls 0 means no
// cap.
//   node --import ./scripts/test-stubs/register.mjs scripts/claude-effort-ladder.mjs summarize --out <dir>
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOutsideRepo, prepareOutDir } from './ai-task-replay.mjs';
import { assertDurableOutDir, createRunJournal, takeEphemeralFlag } from './ai-test-journal.mjs';

export const LADDER_MODELS = Object.freeze(['haiku', 'sonnet', 'opus']);
export const LADDER_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
export const DEFAULT_EDITORIAL_LIMIT = 6;
export const DEFAULT_LADDER_TASKS = Object.freeze(['career-profile-compile', 'career-profile-audit-skills']);
// One first answer plus at most two corrections, as the durable worker does.
export const MAX_REPAIR_ATTEMPTS = 2;
export const DEFAULT_MAX_CALLS = 40;

/** `opus:xhigh,sonnet:medium` -> [{id, model, effort}]. Anything else is refused. */
export function parseConfigs(list) {
  const configs = [];
  const seen = new Set();
  for (const raw of String(list ?? '').split(',').map(part => part.trim()).filter(Boolean)) {
    const parts = raw.split(':');
    if (parts.length !== 2) throw new Error(`Unknown ladder config ${raw}; expected <model>:<effort>.`);
    const [model, effort] = parts;
    if (!LADDER_MODELS.includes(model)) throw new Error(`Unknown ladder model ${model} in ${raw}; allowed: ${LADDER_MODELS.join(', ')}.`);
    if (!LADDER_EFFORTS.includes(effort)) throw new Error(`Unknown ladder effort ${effort} in ${raw}; allowed: ${LADDER_EFFORTS.join(', ')}.`);
    if (seen.has(raw)) throw new Error(`Ladder config ${raw} is listed twice.`);
    seen.add(raw);
    configs.push({ id: raw, model, effort });
  }
  if (!configs.length) throw new Error('--configs lists no ladder configs; expected at least one <model>:<effort>.');
  return configs;
}

/**
 * The environment a Claude child may see. This script is launched from inside a
 * Claude Code session that exports CLAUDE* and ANTHROPIC* variables (which would make
 * the nested CLI reuse the parent session) and ELECTRON_RUN_AS_NODE.
 */
export function childEnvFor(env = {}) {
  const clean = {};
  for (const [name, value] of Object.entries(env || {})) {
    if (typeof value === 'undefined') continue;
    if (name.startsWith('CLAUDE') || name.startsWith('ANTHROPIC') || name === 'ELECTRON_RUN_AS_NODE') continue;
    clean[name] = value;
  }
  return clean;
}

let appPromise = null;

/**
 * The app modules, loaded lazily: importing this file (tests) must not pull the
 * Electron-side graph until something actually needs the real Claude stage.
 */
function loadApp() {
  if (!appPromise) {
    const ipc = rel => import(new URL(`../electron/ipc/${rel}`, import.meta.url).href);
    appPromise = Promise.all([
      ipc('nonApiAi.js'), ipc('claudeTaskWorker.js'), ipc('claudeTaskProfiles.js'),
      ipc('claudeApplicationSdkStage.js'), ipc('claudeApplicationRunner.js'),
      ipc('applicationEditorialPlan.js'), ipc('careerSnapshot.js'),
    ]).then(([nonApi, worker, profiles, sdk, runner, editorial, career]) => ({
      materializeNonApiPrompt: nonApi.materializeNonApiPrompt,
      hardenStructuredTaskPrompt: nonApi.hardenStructuredTaskPrompt,
      validateNonApiAiSubmission: nonApi.validateNonApiAiSubmission,
      cachedPromptParts: worker.cachedPromptParts,
      claudeTaskProfile: profiles.claudeTaskProfile,
      runClaudeSdkStage: sdk.runClaudeSdkStage,
      resolveClaudeBinary: runner.resolveClaudeBinary,
      claudeChildEnv: runner.claudeChildEnv,
      parseEditorialPlanResponse: editorial.parseEditorialPlanResponse,
      compileAuditedCareerSnapshot: career.compileAuditedCareerSnapshot,
      verbatimCareerTranscriptionAuditReceipt: career.verbatimCareerTranscriptionAuditReceipt,
    }));
  }
  return appPromise;
}

// ---- Editorial planner log capture -----------------------------------------

// applicationEditorialPlan.js keeps these two boundaries private and
// editorialPlanAllowedIds() needs the writer wrapper (approved-source and
// writer-output boundaries) that the archived planner prompt no longer has, so
// the same catalog/skills boundary logic is repeated here for the planner
// prompt. CATALOG_BOUNDARY and SKILLS_BOUNDARY are byte-identical to that
// module's, as is the row/id shape.
const CATALOG_BOUNDARY = /^FULL APPROVED CATALOG \(([0-9]+) items; every ID and full quote\):$/gmu;
const SKILLS_BOUNDARY = /^INDEX-ELIGIBLE SKILLS \(exact item names and their only permitted skill-group citation IDs\):$/gmu;
const CATALOG_ROW = /^\[(host\.career\.[a-z]+\.[a-z0-9-]+\.[0-9]+)\](?:[ \t]|$)/gmu;

function oneBoundary(text, pattern, label) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Editorial ladder capture requires one unambiguous ${label}.`);
  return matches[0];
}

/** The allowed catalog IDs of an archived `buildEditorialPlanPrompt()` prompt. */
export function allowedIdsFromPlannerPrompt(plannerPrompt) {
  if (typeof plannerPrompt !== 'string' || !plannerPrompt.trim()) throw new Error('Editorial ladder capture requires a planner prompt.');
  const catalog = oneBoundary(plannerPrompt, CATALOG_BOUNDARY, 'full-approved-catalog boundary');
  const skills = oneBoundary(plannerPrompt, SKILLS_BOUNDARY, 'skill-index boundary');
  if (skills.index <= catalog.index) throw new Error('Editorial ladder capture requires a bounded full approved catalog.');
  const body = plannerPrompt.slice(catalog.index + catalog[0].length, skills.index);
  const ids = [...body.matchAll(CATALOG_ROW)].map(match => match[1]);
  const expected = Number(catalog[1]);
  if (!Number.isSafeInteger(expected) || expected < 1 || ids.length !== expected || new Set(ids).size !== ids.length) {
    throw new Error('Editorial ladder capture requires every full approved catalog ID exactly once.');
  }
  return ids;
}

function readRunLogEvents(runsDir) {
  const dir = path.resolve(runsDir);
  const names = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort();
  if (!names.length) throw new Error(`No *.jsonl run logs in ${dir}.`);
  const events = [];
  let skippedLines = 0;
  for (const name of names) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try { event = JSON.parse(trimmed); } catch { skippedLines += 1; continue; }
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
      else skippedLines += 1;
    }
  }
  return { events, skippedLines };
}

const atOf = event => (Number.isFinite(event?.at) ? event.at : Date.parse(event?.at) || 0);

function editorialCost(runId, costs) {
  const value = costs.get(runId);
  return Number.isFinite(value) ? value : null;
}

/**
 * Pair first-attempt editorial-planner calls with their answers from the app's
 * run logs. Resume starts, unpaired runs and answers the planner validator
 * refuses are dropped; the newest run per jobId wins and only the newest
 * `limit` jobs are kept.
 */
export async function captureEditorialRecords(runsDir, { limit = DEFAULT_EDITORIAL_LIMIT, app = null } = {}) {
  const keep = Number(limit);
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('--limit must be a positive integer.');
  const modules = app || await loadApp();
  const { events, skippedLines } = readRunLogEvents(runsDir);
  const stats = { events: events.length, skippedLines, resumedStarts: 0, unpaired: 0, invalidPlan: 0, invalidPrompt: 0, jobs: 0, kept: 0 };
  const resumed = new Set();
  const starts = new Map();
  const answers = new Map();
  const costs = new Map();
  for (const event of events) {
    const runId = typeof event.runId === 'string' && event.runId ? event.runId : null;
    if (!runId) continue;
    if (Number.isFinite(event.costUsd)) costs.set(runId, event.costUsd);
    if (event.stage !== 'editorial-plan') continue;
    if (event.event === 'started') {
      if (event.resume === true) { stats.resumedStarts += 1; resumed.add(runId); continue; }
      if (typeof event.jobId !== 'string' || !event.jobId) continue;
      if (typeof event.prompt !== 'string' || !event.prompt.trim()) continue;
      const existing = starts.get(runId);
      if (!existing || atOf(event) <= atOf(existing)) starts.set(runId, event);
      continue;
    }
    if (event.event === 'response' && typeof event.answer === 'string') answers.set(runId, event);
  }
  const newestPerJob = new Map();
  for (const [runId, start] of starts) {
    if (resumed.has(runId)) continue;
    const response = answers.get(runId);
    if (!response) { stats.unpaired += 1; continue; }
    let allowed;
    try { allowed = allowedIdsFromPlannerPrompt(start.prompt); } catch { stats.invalidPrompt += 1; continue; }
    try { modules.parseEditorialPlanResponse(response.answer, allowed); } catch { stats.invalidPlan += 1; continue; }
    const record = {
      id: `editorial-plan:${start.jobId}`,
      task: 'editorial-plan',
      text: start.prompt,
      systemAppend: '',
      responseSchema: null,
      baseline: {
        text: response.answer,
        model: typeof response.model === 'string' && response.model ? response.model : (start.requestedModel ?? null),
        effort: start.requestedEffort ?? null,
        costUsd: editorialCost(runId, costs),
        durationMs: Number.isFinite(response.durationMs) ? response.durationMs : null,
      },
    };
    const previous = newestPerJob.get(start.jobId);
    if (!previous || atOf(start) >= atOf(previous.start)) newestPerJob.set(start.jobId, { start, record });
  }
  stats.jobs = newestPerJob.size;
  const chosen = [...newestPerJob.values()]
    .sort((a, b) => atOf(b.start) - atOf(a.start) || a.record.id.localeCompare(b.record.id))
    .slice(0, keep)
    .sort((a, b) => atOf(a.start) - atOf(b.start) || a.record.id.localeCompare(b.record.id))
    .map(entry => entry.record);
  stats.kept = chosen.length;
  return { records: chosen, stats };
}

// ---- Generic stage capture --------------------------------------------------

export const DEFAULT_STAGE_LIMIT = 12;
const STAGE_NAME = /^[a-z0-9-]+$/u;

/**
 * Pair every first-attempt (resume:false) call of one application stage with its
 * response and, when the app logged one, its submission verdict. A resume start
 * holds only correction text and cannot be replayed, so it is dropped; the newest
 * run per jobId wins, only the newest `limit` jobs are kept, and --accepted-only
 * keeps only jobs the app accepted.
 */
export function captureStageRecords(runsDir, { stage = '', limit = DEFAULT_STAGE_LIMIT, acceptedOnly = false } = {}) {
  const name = typeof stage === 'string' ? stage.trim() : '';
  if (!STAGE_NAME.test(name)) throw new Error(`--stage ${JSON.stringify(stage ?? '')} must be a lowercase stage name.`);
  const keep = Number(limit);
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('--limit must be a positive integer.');
  const { events, skippedLines } = readRunLogEvents(runsDir);
  const stats = {
    events: events.length, skippedLines, unreadableStarts: 0, resumedStarts: 0, unpaired: 0,
    submitted: 0, rejected: 0, validationErrors: 0, notAccepted: 0, jobs: 0, kept: 0,
  };
  const starts = new Map();
  const answers = new Map();
  const submissions = new Map();
  for (const event of events) {
    const runId = typeof event.runId === 'string' && event.runId ? event.runId : null;
    if (!runId) continue;
    if (event.event === 'started') {
      if (event.stage !== name) continue;
      if (event.resume === true) { stats.resumedStarts += 1; continue; }
      if (typeof event.jobId !== 'string' || !event.jobId || typeof event.prompt !== 'string' || !event.prompt.trim()) {
        stats.unreadableStarts += 1;
        continue;
      }
      const existing = starts.get(runId);
      if (!existing || atOf(event) <= atOf(existing)) starts.set(runId, event);
      continue;
    }
    if (event.event === 'response' && typeof event.answer === 'string') answers.set(runId, event);
    else if (event.event === 'submission') submissions.set(runId, event);
  }
  const newestPerJob = new Map();
  for (const [runId, start] of starts) {
    const response = answers.get(runId);
    if (!response) { stats.unpaired += 1; continue; }
    const submission = submissions.get(runId) ?? null;
    const verdict = submission?.submit && typeof submission.submit === 'object' ? submission.submit : submission;
    const accepted = typeof verdict?.accepted === 'boolean' ? verdict.accepted : null;
    if (submission) {
      stats.submitted += 1;
      if (accepted === false) stats.rejected += 1;
      if (Array.isArray(verdict?.validationErrors)) stats.validationErrors += verdict.validationErrors.length;
    }
    if (acceptedOnly && accepted !== true) { stats.notAccepted += 1; continue; }
    const record = {
      id: `${name}:${start.jobId}:${runId.slice(0, 8)}`,
      task: name,
      text: start.prompt,
      systemAppend: '',
      responseSchema: null,
      baseline: {
        text: response.answer,
        model: typeof response.model === 'string' && response.model ? response.model : (start.requestedModel ?? null),
        effort: start.requestedEffort ?? null,
        costUsd: Number.isFinite(response.costUsd) ? response.costUsd : null,
        durationMs: Number.isFinite(response.durationMs) ? response.durationMs : null,
        accepted,
      },
    };
    const previous = newestPerJob.get(start.jobId);
    if (!previous || atOf(start) >= atOf(previous.start)) newestPerJob.set(start.jobId, { start, record });
  }
  stats.jobs = newestPerJob.size;
  const chosen = [...newestPerJob.values()]
    .sort((a, b) => atOf(b.start) - atOf(a.start) || a.record.id.localeCompare(b.record.id))
    .slice(0, keep)
    .sort((a, b) => atOf(a.start) - atOf(b.start) || a.record.id.localeCompare(b.record.id))
    .map(entry => entry.record);
  stats.kept = chosen.length;
  return { records: chosen, stats };
}

// ---- Shared plumbing --------------------------------------------------------

/** Bounded-concurrency map that keeps the input order, as the app's schedulers do. */
export async function mapLimit(items, concurrency, work) {
  const list = [...items];
  const limit = Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await work(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return results;
}

function writePrivate(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Append rows one at a time so concurrent cells never interleave a line. */
function createAppender(file) {
  let chain = Promise.resolve();
  return row => {
    chain = chain.then(() => {
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    });
    return chain;
  };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* a torn final line is ignored */ }
  }
  return rows;
}

const errorMessage = error => (error instanceof Error ? error.message : String(error));

export const ladderKey = (recordId, configId, rep) => `${recordId}\u0000${configId}\u0000${rep}`;

/** Base env for the Claude child: CLAUDE*, ANTHROPIC* and ELECTRON_RUN_AS_NODE stripped, binary staged. */
export function createStageContext({ env = process.env, cwd = os.tmpdir(), app = null } = {}) {
  let resolved = null;
  return async () => {
    if (!resolved) {
      const modules = app || await loadApp();
      const base = childEnvFor(env);
      const binary = modules.resolveClaudeBinary({ env: base, homedir: os.homedir() });
      resolved = Object.freeze({
        binary,
        env: Object.freeze({ ...modules.claudeChildEnv(base, path.dirname(binary)) }),
        cwd,
      });
    }
    return resolved;
  };
}

/** Same rule as the background worker: caching is disabled only when nothing is cached. */
function envForCall(baseEnv, systemAppend) {
  const env = { ...baseEnv };
  if (systemAppend) delete env.DISABLE_PROMPT_CACHING;
  else env.DISABLE_PROMPT_CACHING = '1';
  return env;
}

/** The production Claude stage, exactly as the application runner drives it. */
export async function defaultRunStage({ binary, env, cwd, text, systemAppend, model, effort, tools = [], pageImages }) {
  const modules = await loadApp();
  return modules.runClaudeSdkStage({
    binary, env, cwd, text, systemAppend, model, effort, tools, pageImages, persistSession: false,
  });
}

/**
 * The handoff pair the worker would send: materializeNonApiPrompt() plus the same
 * cachedPrefix hardening, split into text/systemAppend by cachedPromptParts().
 */
export function stagePromptFor(modules, { prompt, cachedPrefix = '', task, responseSchema = null, grounding = false }) {
  const materialized = modules.materializeNonApiPrompt({ prompt, cachedPrefix, task, responseSchema, grounding });
  const staged = cachedPrefix
    ? (responseSchema ? modules.hardenStructuredTaskPrompt(task, cachedPrefix) : String(cachedPrefix))
    : '';
  return modules.cachedPromptParts(materialized, staged);
}

// ---- Pick (judge) validation ------------------------------------------------

// writeVerifyPrompt() prints each candidate of the round as `<id>:\nWRITER TEXT:`,
// so the accepted ids the app validates a judge ranking against are recoverable
// from the archived judge prompt alone.
const PICK_CANDIDATES_BOUNDARY = /^CANDIDATES:$/gmu;
const PICK_CANDIDATE_ID = /^([^\s:]+):$/u;
const PICK_WRITER_TEXT = 'WRITER TEXT:';

let writeVerifyPromise = null;

/** The app's write-verify validator, imported once and only when 'pick' needs it. */
function loadWriteVerify() {
  if (!writeVerifyPromise) {
    writeVerifyPromise = import(new URL('../electron/ipc/applicationWriteVerify.js', import.meta.url).href);
  }
  return writeVerifyPromise;
}

/** The candidate IDs an archived judge ('pick') prompt lists, in prompt order. */
export function pickCandidateIdsFromPrompt(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  const matches = [...text.matchAll(PICK_CANDIDATES_BOUNDARY)];
  if (matches.length !== 1) throw new Error('Pick ladder capture requires one CANDIDATES section in the judge prompt.');
  const lines = text.slice(matches[0].index + matches[0][0].length).split('\n');
  const ids = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const row = PICK_CANDIDATE_ID.exec(lines[index]);
    if (!row || lines[index + 1].trim() !== PICK_WRITER_TEXT) continue;
    ids.push(row[1]);
  }
  if (!ids.length) throw new Error('Pick ladder capture requires at least one candidate id in the judge prompt.');
  if (new Set(ids).size !== ids.length) throw new Error('Pick ladder capture requires every candidate id exactly once.');
  return ids;
}

/** The `{"ranking":[{id,reason}]}` rows of a judge answer (one fenced block allowed). */
export function parsePickRanking(answer) {
  const text = typeof answer === 'string' ? answer.trim() : '';
  const fenced = /^```[a-z]*[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(text);
  let parsed;
  try { parsed = JSON.parse(fenced ? fenced[1].trim() : text); } catch { throw new Error('pick-ranking-shape: the judge reply is not JSON.'); }
  if (!Array.isArray(parsed?.ranking)) throw new Error('pick-ranking-shape: the judge reply needs a "ranking" array of {"id","reason"} objects, best first.');
  return parsed.ranking;
}

/** The top-ranked candidate id of a judge answer, or null when it does not parse. */
export function pickTopCandidateId(answer) {
  try {
    const top = parsePickRanking(answer)[0];
    return top && typeof top === 'object' && typeof top.id === 'string' ? top.id : null;
  } catch { return null; }
}

/**
 * Judge a 'pick' answer exactly as the app does: same accepted ids, same
 * validateWriteVerifyRanking() set rules and the same per-place reason rule.
 * Throws on a malformed ranking and returns the ranked ids.
 */
export function validatePickRanking(verify, prompt, answer, acceptedIds = null) {
  if (typeof verify?.validateWriteVerifyRanking !== 'function') throw new Error('Pick validation requires applicationWriteVerify.validateWriteVerifyRanking().');
  const ids = Array.isArray(acceptedIds) && acceptedIds.length ? acceptedIds : pickCandidateIdsFromPrompt(prompt);
  const ranked = parsePickRanking(answer);
  const ranking = ranked.map(row => (row && typeof row === 'object' ? row.id : row));
  verify.validateWriteVerifyRanking(ranking, ids);
  const reasonErrors = typeof verify.writeVerifyRankingReasonErrors === 'function' ? verify.writeVerifyRankingReasonErrors(ranked) : [];
  if (reasonErrors.length) throw new Error(reasonErrors.join(' | '));
  return ranking;
}

/** Accept an answer the way the app does, returning the parsed value or throwing. */
async function acceptAnswer(modules, { task, answer, responseSchema = null, responseValidator = null, plannerPrompt = null }) {
  if (task === 'editorial-plan') {
    // The planner answer is judged against the catalog IDs its own prompt printed.
    return modules.parseEditorialPlanResponse(answer, allowedIdsFromPlannerPrompt(plannerPrompt));
  }
  if (task === 'pick' && typeof plannerPrompt === 'string' && plannerPrompt.trim()) {
    // Only a prompt that prints its own candidate ids can be judged as a pick;
    // an archived prompt without them falls back to the generic validator.
    let acceptedIds = null;
    try { acceptedIds = pickCandidateIdsFromPrompt(plannerPrompt); } catch { acceptedIds = null; }
    if (acceptedIds) {
      const verify = typeof modules.validateWriteVerifyRanking === 'function' ? modules : await loadWriteVerify();
      return validatePickRanking(verify, plannerPrompt, answer, acceptedIds);
    }
  }
  return modules.validateNonApiAiSubmission({
    response: answer, responseSchema, responseValidator, task, expectedHandoffCode: null, requireHandoffCode: false,
  });
}

// ---- The ladder -------------------------------------------------------------

/** The ladder's default validator: the planner validator, the app's schema validator, or non-empty text. */
export async function defaultValidate(record, text) {
  const modules = await loadApp();
  await acceptAnswer(modules, {
    task: record?.task, answer: text, responseSchema: record?.responseSchema ?? null,
    responseValidator: null, plannerPrompt: record?.text,
  });
  return text;
}

/**
 * Run every record x config x rep cell and append one row per call to
 * <out>/results.jsonl. Cells that already have an ok:true row are skipped, so a
 * second run only fills the gaps.
 */
export async function runLadder({
  records, configs, reps = 1, runStage = defaultRunStage, validate = defaultValidate,
  outDir, concurrency = 4, stageContext = null, journal = null,
} = {}) {
  if (!Array.isArray(records) || !records.length) throw new Error('The ladder needs at least one record.');
  const ladder = Array.isArray(configs) ? configs : parseConfigs(configs);
  if (!ladder.length) throw new Error('The ladder needs at least one config.');
  const repCount = Number(reps);
  if (!Number.isSafeInteger(repCount) || repCount < 1) throw new Error('--reps must be a positive integer.');
  if (!outDir) throw new Error('The ladder needs an output directory.');
  const dir = assertOutsideRepo(outDir);
  prepareOutDir(dir);
  const resultsFile = path.join(dir, 'results.jsonl');
  const priorRows = readJsonl(resultsFile);
  const done = new Set(priorRows
    .filter(row => row && row.ok === true)
    .map(row => ladderKey(row.recordId, row.config, row.rep)));
  // journal: the run's progress in docs/ai-test-runs.md, rewritten as rows land.
  const journalRows = priorRows.filter(row => row && typeof row === 'object');
  const recordJournal = force => journal?.update({ rows: ladderJournalRows(journalRows, records) }, { force });
  const stage = await (stageContext || createStageContext())();
  const cells = [];
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id) throw new Error('Every ladder record needs an id.');
    for (const config of ladder) {
      for (let rep = 1; rep <= repCount; rep += 1) {
        if (done.has(ladderKey(record.id, config.id, rep))) continue;
        cells.push({ record, config, rep });
      }
    }
  }
  const skipped = (records.length * ladder.length * repCount) - cells.length;
  const append = createAppender(resultsFile);
  const stats = { planned: cells.length, skipped, valid: 0, invalid: 0, failed: 0 };
  await mapLimit(cells, concurrency, async ({ record, config, rep }) => {
    const started = Date.now();
    const systemAppend = typeof record.systemAppend === 'string' ? record.systemAppend : '';
    let row;
    try {
      const reply = await runStage({
        binary: stage.binary, env: envForCall(stage.env, systemAppend), cwd: stage.cwd,
        text: record.text, systemAppend, model: config.model, effort: config.effort, persistSession: false,
        // Only the call carries the images; the row below never stores them.
        pageImages: Array.isArray(record.pageImages) ? record.pageImages : undefined,
      });
      const text = typeof reply?.text === 'string' ? reply.text : '';
      let valid = true;
      let error = null;
      try { await validate(record, text); } catch (failure) { valid = false; error = errorMessage(failure); }
      row = {
        recordId: record.id, key: baselineKeyFor(record.text, systemAppend), task: record.task ?? null, config: config.id, rep, ok: true, valid, error,
        costUsd: Number.isFinite(reply?.costUsd) ? reply.costUsd : null,
        usage: reply?.usage ?? null,
        durationMs: Number.isFinite(reply?.durationMs) ? reply.durationMs : Date.now() - started,
        model: reply?.model ?? null, text,
      };
    } catch (failure) {
      // A thrown runner error is still a measured cell: the call happened and was paid for.
      row = {
        recordId: record.id, key: baselineKeyFor(record.text, systemAppend), task: record.task ?? null, config: config.id, rep, ok: false, valid: false,
        error: errorMessage(failure), costUsd: Number.isFinite(failure?.costUsd) ? failure.costUsd : null,
        usage: null, durationMs: Date.now() - started, model: null, text: '',
      };
    }
    if (row.ok !== true) stats.failed += 1;
    else if (row.valid) stats.valid += 1;
    else stats.invalid += 1;
    await append(row);
    journalRows.push(row);
    recordJournal(false);
    return row;
  });
  recordJournal(true);
  return { ...stats, resultsFile };
}

/** Journal rows for a ladder: validity and cost per task x config, plus top-1 agreement for pick. */
export function ladderJournalRows(rows = [], records = []) {
  return compareResults(rows, records).map(group => {
    const top1 = group.top1Agreement;
    const failed = rows.filter(row => row && row.ok === false && (row.task ?? 'unknown') === group.task && (row.config ?? 'unknown') === group.config).length;
    return {
      arm: `${group.task} ${group.config}`,
      n: group.n,
      valid: Math.round(group.validRate * group.n),
      failed,
      costUsd: group.totalCostUsd,
      notes: top1 ? `top-1 agreement with baseline ${top1.n ? `${top1.agree}/${top1.n} (${Math.round(top1.rate * 1000) / 10}%)` : 'n/a'}${top1.unparsed ? `, ${top1.unparsed} unparsed` : ''}` : '',
    };
  });
}

/** Per task x config: n, valid rate, mean and total cost, mean duration. */
export function summarizeResults(rows = []) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const task = row.task ?? 'unknown';
    const config = row.config ?? 'unknown';
    const key = `${task}\u0000${config}`;
    let group = groups.get(key);
    if (!group) {
      group = { task, config, n: 0, valid: 0, failed: 0, costRows: 0, totalCostUsd: 0, durationRows: 0, totalDurationMs: 0 };
      groups.set(key, group);
    }
    group.n += 1;
    if (row.valid === true) group.valid += 1;
    if (row.ok === false) group.failed += 1;
    if (Number.isFinite(row.costUsd)) { group.costRows += 1; group.totalCostUsd += row.costUsd; }
    if (Number.isFinite(row.durationMs)) { group.durationRows += 1; group.totalDurationMs += row.durationMs; }
  }
  return [...groups.values()]
    .map(group => ({
      task: group.task,
      config: group.config,
      n: group.n,
      validRate: group.n ? group.valid / group.n : 0,
      failed: group.failed,
      totalCostUsd: group.totalCostUsd,
      meanCostUsd: group.costRows ? group.totalCostUsd / group.costRows : null,
      meanDurationMs: group.durationRows ? group.totalDurationMs / group.durationRows : null,
    }))
    .sort((a, b) => a.task.localeCompare(b.task) || a.config.localeCompare(b.config));
}

/**
 * Per task x config comparison of ladder rows against the captured baselines.
 * For 'pick' each config also reports how often its top-ranked candidate is the
 * baseline's top-ranked candidate (both rankings parsed by the validator's own
 * parser); every other task reports validity and cost only.
 */
export function compareResults(rows = [], records = []) {
  const baselineText = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record.id !== 'string') continue;
    if (typeof record.baseline?.text !== 'string') continue;
    baselineText.set(record.id, record.baseline.text);
  }
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const task = row.task ?? 'unknown';
    const config = row.config ?? 'unknown';
    const key = `${task}\u0000${config}`;
    let group = groups.get(key);
    if (!group) {
      group = { task, config, n: 0, valid: 0, totalCostUsd: 0, costRows: 0, baseRows: 0, agreed: 0, missingBaseline: 0, unparsed: 0 };
      groups.set(key, group);
    }
    group.n += 1;
    if (row.valid === true) group.valid += 1;
    if (Number.isFinite(row.costUsd)) { group.costRows += 1; group.totalCostUsd += row.costUsd; }
    if (task !== 'pick') continue;
    const answer = baselineText.get(row.recordId);
    if (typeof answer !== 'string') { group.missingBaseline += 1; continue; }
    const expected = pickTopCandidateId(answer);
    const actual = pickTopCandidateId(row.text);
    if (expected === null || actual === null) { group.unparsed += 1; continue; }
    group.baseRows += 1;
    if (expected === actual) group.agreed += 1;
  }
  return [...groups.values()]
    .map(group => ({
      task: group.task,
      config: group.config,
      n: group.n,
      validRate: group.n ? group.valid / group.n : 0,
      totalCostUsd: group.totalCostUsd,
      meanCostUsd: group.costRows ? group.totalCostUsd / group.costRows : null,
      top1Agreement: group.task === 'pick'
        ? {
          n: group.baseRows,
          agree: group.agreed,
          rate: group.baseRows ? group.agreed / group.baseRows : null,
          unparsed: group.unparsed,
          missingBaseline: group.missingBaseline,
        }
        : null,
    }))
    .sort((a, b) => a.task.localeCompare(b.task) || a.config.localeCompare(b.config));
}

// ---- Baseline replay and record filters -------------------------------------

export const BASELINE_MISS_CODE = 'LADDER_BASELINE_MISS';

/** sha256 of (handoff text + NUL + systemAppend): the identity of one baseline answer. */
export function baselineKeyFor(text, systemAppend = '') {
  const left = typeof text === 'string' ? text : '';
  const right = typeof systemAppend === 'string' ? systemAppend : '';
  return crypto.createHash('sha256').update(`${left}\u0000${right}`, 'utf8').digest('hex');
}

/**
 * Index a previous capture-career dir's baseline.jsonl by baselineKeyFor() of
 * every stored row, so a later run answers the identical handoff from the stored
 * answer instead of paying for the baseline again. Rows written before the key
 * field existed still match, and a stored row.key is indexed too.
 */
export function loadBaselineIndex(baselineFrom) {
  const resolved = path.resolve(String(baselineFrom));
  const file = path.join(resolved, 'baseline.jsonl');
  if (!fs.existsSync(file)) throw new Error(`--baseline-from ${resolved} holds no baseline.jsonl; capture the baseline first.`);
  const index = new Map();
  for (const row of readJsonl(file)) {
    if (!row || typeof row !== 'object' || typeof row.text !== 'string') continue;
    const key = baselineKeyFor(row.text, typeof row.systemAppend === 'string' ? row.systemAppend : '');
    if (!index.has(key)) index.set(key, row);
    if (typeof row.key === 'string' && /^[0-9a-f]{64}$/u.test(row.key) && !index.has(row.key)) index.set(row.key, row);
  }
  if (!index.size) throw new Error(`--baseline-from ${resolved} baseline.jsonl holds no stored answers.`);
  return index;
}

/** A replay never falls back to a live call: nothing to replay is an error. */
function baselineMissError(recordId, key, detail) {
  const miss = new Error(`${BASELINE_MISS_CODE}: no usable stored baseline for ${recordId} (sha256 ${key})${detail ? `; ${detail}` : ''}. Capture the baseline without --baseline-from.`);
  miss.code = BASELINE_MISS_CODE;
  return miss;
}

/** `--only-records` value -> exact recordIds plus sha256 key prefixes (>= 12 hex chars). */
export function parseOnlyRecords(value) {
  const ids = [];
  const prefixes = [];
  for (const part of (Array.isArray(value) ? value : String(value ?? '').split(','))) {
    const entry = String(part ?? '').trim();
    if (!entry) continue;
    if (/^[0-9a-f]{12,64}$/iu.test(entry)) { prefixes.push(entry.toLowerCase()); continue; }
    if (entry.includes(':')) { ids.push(entry); continue; }
    throw new Error(`--only-records entry ${entry} is neither a recordId (<task>:<n>) nor a sha256 key prefix of at least 12 hex characters.`);
  }
  if (!ids.length && !prefixes.length) throw new Error('--only-records lists no recordIds; expected <task>:<n> ids or sha256 key prefixes.');
  return { ids, prefixes };
}

/** `--ladder-tasks` value -> task names; an explicitly empty value ladders nothing. */
export function ladderTasksFrom(value) {
  if (typeof value === 'undefined' || value === null) return DEFAULT_LADDER_TASKS.slice();
  return String(value).split(',').map(part => part.trim()).filter(Boolean);
}

// ---- Career capture ---------------------------------------------------------

export const MAX_CALLS_CODE = 'LADDER_MAX_CALLS';

function correctionNote(message) {
  return `CORRECTION AFTER REJECTION: the previous answer to this same request was rejected by the application's own validator with: ${message}. Answer the same request again, correcting exactly that problem.`;
}

/**
 * The callText the career compiler runs on. It materializes the app's exact
 * handoff, answers it with the task's production profile, repairs up to
 * --max-repairs times (default MAX_REPAIR_ATTEMPTS), records the baseline
 * answer, and (for --ladder-tasks) measures every ladder config on the identical
 * first-attempt prompt before returning. With --baseline-from the baseline
 * answer is replayed from a previous capture; --live-on-miss answers a call live
 * instead of failing when its key has no usable stored row. A --profile-override
 * task is always answered live at its override profile -- never replayed -- so
 * its stored cost and latency measure that model/effort.
 */
export function createCaptureCallText({
  runStage = defaultRunStage,
  profileFor = null,
  ladderTasks = [],
  configs = [],
  reps = 1,
  outDir,
  concurrency = 4,
  stageContext = null,
  maxCalls = null,
  maxRepairs = MAX_REPAIR_ATTEMPTS,
  baselineFrom = null,
  onlyRecords = null,
  liveOnMiss = false,
  overrides = null,
  app = null,
} = {}) {
  if (!outDir) throw new Error('The career capture needs an output directory.');
  const dir = assertOutsideRepo(outDir);
  prepareOutDir(dir);
  const repCount = Number(reps);
  if (!Number.isSafeInteger(repCount) || repCount < 1) throw new Error('--reps must be a positive integer.');
  const requestedCap = maxCalls === null || typeof maxCalls === 'undefined' ? null : Number(maxCalls);
  if (requestedCap !== null && (!Number.isSafeInteger(requestedCap) || requestedCap < 0)) throw new Error('--max-calls must be a non-negative integer.');
  // --max-calls 0 disables the cap; only a positive number bounds the run.
  const callCap = requestedCap === 0 ? null : requestedCap;
  const repairBudget = maxRepairs === null || typeof maxRepairs === 'undefined' ? MAX_REPAIR_ATTEMPTS : Number(maxRepairs);
  if (!Number.isSafeInteger(repairBudget) || repairBudget < 0) throw new Error('--max-repairs must be a non-negative integer.');
  const ladder = Array.isArray(configs) ? configs : parseConfigs(configs);
  const overrideProfiles = parseProfileOverrides(overrides);
  const ladderTasksSet = new Set(ladderTasks);
  const baselineIndex = baselineFrom ? loadBaselineIndex(baselineFrom) : null;
  const onlyFilter = typeof onlyRecords === 'undefined' || onlyRecords === null ? null : parseOnlyRecords(onlyRecords);
  const baselineFile = path.join(dir, 'baseline.jsonl');
  const resultsFile = path.join(dir, 'results.jsonl');
  writePrivate(baselineFile, '');
  const appendBaseline = createAppender(baselineFile);
  const appendResult = createAppender(resultsFile);
  const counters = new Map();
  const stats = {
    baselineCalls: 0, baselineValid: 0, baselineInvalid: 0, retries: 0, baselineCostUsd: 0,
    baselineMisses: 0, baselineReplayed: 0, baselineLive: 0, baselineOverrideLive: 0,
    ladderCalls: 0, ladderValid: 0, ladderInvalid: 0, ladderFailed: 0, ladderCostUsd: 0,
    byTask: new Map(),
  };
  const context = stageContext || createStageContext({ app });
  const productionProfileFor = profileFor || (async task => (app || await loadApp()).claudeTaskProfile(task));
  // --profile-override answers that one task live at the override profile while
  // every other task keeps the production profile it would normally get.
  const resolveProfile = overrideProfiles.size === 0 ? productionProfileFor : async (task) => {
    const override = overrideProfiles.get(task);
    return override ? { ...override } : productionProfileFor(task);
  };

  const callText = async (prompt, opts = {}) => {
    const modules = app || await loadApp();
    const { task, responseSchema = null, responseValidator = null, cachedPrefix = '', grounding = false } = opts || {};
    if (typeof task !== 'string' || !task) throw new Error('The career capture needs a task name.');
    if (callCap !== null && stats.baselineCalls >= callCap) {
      const stop = new Error(`--max-calls ${callCap} reached; the ladder stops with what it already has.`);
      stop.code = MAX_CALLS_CODE;
      throw stop;
    }
    const index = (counters.get(task) || 0) + 1;
    counters.set(task, index);
    const recordId = `${task}:${index}`;
    const stage = await context();
    const handoff = stagePromptFor(modules, { prompt, cachedPrefix, task, responseSchema, grounding });
    const key = baselineKeyFor(handoff.text, handoff.systemAppend);
    // --only-records narrows which calls climb the ladder, never which ones run.
    const ladderSelected = !onlyFilter
      || onlyFilter.ids.includes(recordId) || onlyFilter.prefixes.some(prefix => key.startsWith(prefix));
    const profile = await resolveProfile(task);
    if (!profile || typeof profile.model !== 'string' || typeof profile.effort !== 'string') {
      throw new Error(`No production Claude profile for task ${task}; the ladder cannot replay it.`);
    }
    stats.baselineCalls += 1;
    if (!stats.byTask.has(task)) stats.byTask.set(task, { calls: 0, ladderCalls: 0, costUsd: 0, replayed: 0 });
    const taskStats = stats.byTask.get(task);
    taskStats.calls += 1;
    const overridden = overrideProfiles.has(task);
    const notes = [];
    let attempts = 1;
    let answer = '';
    let value = null;
    let rejection = null;
    let costUsd = null;
    let usage = null;
    // An overridden task records the override model, so its baseline row names
    // the setting that produced it even when the runner reports no model.
    let model = overridden ? profile.model : null;
    let effort = profile.effort;
    let valid = true;
    let replayed = false;
    if (baselineIndex && !overridden) {
      // A --profile-override task never takes this branch: replaying its stored
      // answer would measure the production profile, not the override.
      // Replay: the stored answer replaces the live baseline call, and it is
      // still judged by the caller's live validator exactly as a fresh answer is.
      // A stored row marked valid:false is never replayed either.
      const stored = baselineIndex.get(key);
      let missDetail = null;
      let storedAnswer = null;
      if (!stored || typeof stored.answer !== 'string') {
        missDetail = null;
      } else if (stored.valid === false) {
        missDetail = 'the stored row is marked valid:false';
      } else {
        try {
          value = await acceptAnswer(modules, { task, answer: stored.answer, responseSchema, responseValidator, plannerPrompt: prompt });
          storedAnswer = stored.answer;
        } catch (failure) {
          missDetail = `the live validator rejected the stored answer: ${errorMessage(failure)}`;
        }
      }
      if (storedAnswer !== null) {
        answer = storedAnswer;
        stats.baselineReplayed += 1;
        taskStats.replayed += 1;
        replayed = true;
        costUsd = 0;
        usage = stored.usage ?? null;
        model = typeof stored.model === 'string' && stored.model ? stored.model : profile.model;
        effort = typeof stored.effort === 'string' && stored.effort ? stored.effort : profile.effort;
      } else if (liveOnMiss) {
        // --live-on-miss: answer it live with the production profile exactly as
        // the non-replay path does -- same repairs, same baseline row, real cost.
        stats.baselineLive += 1;
        value = null;
      } else {
        stats.baselineMisses += 1;
        throw baselineMissError(recordId, key, missDetail);
      }
    } else if (baselineIndex) {
      // An overridden task is answered live even when its baseline row exists:
      // replaying it would measure the production profile, not the override.
      stats.baselineOverrideLive += 1;
    }
    for (let attempt = 1; !replayed && attempt <= repairBudget + 1; attempt += 1) {
      attempts = attempt;
      const text = notes.length ? `${handoff.text}\n\n${notes.join('\n\n')}` : handoff.text;
      const reply = await runStage({
        binary: stage.binary, env: envForCall(stage.env, handoff.systemAppend), cwd: stage.cwd,
        text, systemAppend: handoff.systemAppend, model: profile.model, effort: profile.effort, persistSession: false,
      });
      answer = typeof reply?.text === 'string' ? reply.text : '';
      if (Number.isFinite(reply?.costUsd)) costUsd = (costUsd ?? 0) + reply.costUsd;
      if (typeof reply?.usage !== 'undefined') usage = reply.usage ?? null;
      if (typeof reply?.model === 'string' && reply.model) model = reply.model;
      try {
        value = await acceptAnswer(modules, { task, answer, responseSchema, responseValidator, plannerPrompt: prompt });
        rejection = null;
        break;
      } catch (failure) {
        rejection = failure;
        value = null;
        if (attempt <= repairBudget) {
          stats.retries += 1;
          notes.push(correctionNote(errorMessage(failure)));
        }
      }
    }
    if (!replayed) {
      valid = rejection === null;
      if (valid) stats.baselineValid += 1;
      else stats.baselineInvalid += 1;
      stats.baselineCostUsd += costUsd ?? 0;
    }
    // Per-task totals cover baseline calls (live or replayed) and ladder cells.
    taskStats.costUsd += costUsd ?? 0;
    await appendBaseline({
      recordId, key, task, text: handoff.text, systemAppend: handoff.systemAppend, responseSchema,
      answer, valid, attempts, costUsd, usage, model, effort,
      ...(replayed ? { replayed: true } : {}),
    });

    if (ladderTasksSet.has(task) && ladderSelected) {
      // The identical first-attempt prompt, measured at every ladder setting.
      const cells = ladder.flatMap(config => Array.from({ length: repCount }, (_, offset) => ({ config, rep: offset + 1 })));
      await mapLimit(cells, concurrency, async ({ config, rep }) => {
        const started = Date.now();
        let row;
        try {
          const reply = await runStage({
            binary: stage.binary, env: envForCall(stage.env, handoff.systemAppend), cwd: stage.cwd,
            text: handoff.text, systemAppend: handoff.systemAppend,
            model: config.model, effort: config.effort, persistSession: false,
          });
          const text = typeof reply?.text === 'string' ? reply.text : '';
          let cellValid = true;
          let error = null;
          try { await acceptAnswer(modules, { task, answer: text, responseSchema, responseValidator }); } catch (failure) { cellValid = false; error = errorMessage(failure); }
          row = {
            recordId, key, task, config: config.id, rep, ok: true, valid: cellValid, error,
            costUsd: Number.isFinite(reply?.costUsd) ? reply.costUsd : null,
            usage: reply?.usage ?? null,
            durationMs: Number.isFinite(reply?.durationMs) ? reply.durationMs : Date.now() - started,
            model: reply?.model ?? null, text,
          };
        } catch (failure) {
          row = {
            recordId, key, task, config: config.id, rep, ok: false, valid: false, error: errorMessage(failure),
            costUsd: Number.isFinite(failure?.costUsd) ? failure.costUsd : null,
            usage: null, durationMs: Date.now() - started, model: null, text: '',
          };
        }
        stats.ladderCalls += 1;
        stats.ladderCostUsd += row.costUsd ?? 0;
        taskStats.ladderCalls += 1;
        taskStats.costUsd += row.costUsd ?? 0;
        if (row.ok !== true) stats.ladderFailed += 1;
        else if (row.valid) stats.ladderValid += 1;
        else stats.ladderInvalid += 1;
        await appendResult(row);
        return row;
      });
    }

    if (!valid) throw rejection;
    return value;
  };

  return { callText, stats, baselineFile, resultsFile };
}

// ---- CLI --------------------------------------------------------------------

const FLAGS = {
  '--runs-dir': 'runsDir', '--out': 'out', '--limit': 'limit', '--records': 'records',
  '--configs': 'configs', '--reps': 'reps', '--concurrency': 'concurrency', '--source': 'source',
  '--stage': 'stage', '--accepted-only': 'acceptedOnly', '--archive-dir': 'archiveDir',
  '--ladder-tasks': 'ladderTasks', '--max-calls': 'maxCalls', '--max-repairs': 'maxRepairs',
  '--baseline-from': 'baselineFrom', '--only-records': 'onlyRecords',
  '--live-on-miss': 'liveOnMiss', '--profile-override': 'profileOverrides',
};

/** Flags that take no value: they parse as `true` and consume no argv slot. */
const BOOLEAN_FLAGS = new Set(['--live-on-miss', '--accepted-only']);

/** Flags that may repeat; each occurrence is appended to an array. */
const REPEATABLE_FLAGS = new Set(['--profile-override']);

export function parseLadderArgs(argv = []) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const name = FLAGS[flag];
    if (!name) throw new Error(`Unknown argument ${flag}.`);
    if (BOOLEAN_FLAGS.has(flag)) { opts[name] = true; continue; }
    if (i + 1 >= rest.length) throw new Error(`${flag} needs a value.`);
    const value = rest[i + 1];
    i += 1;
    if (REPEATABLE_FLAGS.has(flag)) {
      // A malformed value fails here, next to the flag that carried it.
      parseProfileOverrides([value]);
      opts[name] = [...(Array.isArray(opts[name]) ? opts[name] : []), value];
      continue;
    }
    opts[name] = value;
  }
  return { command, opts };
}

/** A --profile-override task name has the same shape as the compiler's tasks. */
export const PROFILE_OVERRIDE_TASK = /^[a-z0-9-]+$/u;

function overrideTaskName(task) {
  const name = typeof task === 'string' ? task.trim() : '';
  if (!PROFILE_OVERRIDE_TASK.test(name)) {
    throw new Error(`Unknown profile override task ${JSON.stringify(name)}; expected <task>=<model>:<effort> with a task matching /^[a-z0-9-]+$/.`);
  }
  return name;
}

function overrideProfileFor(task, profile) {
  const model = profile && typeof profile === 'object' ? profile.model : null;
  const effort = profile && typeof profile === 'object' ? profile.effort : null;
  if (typeof model !== 'string' || typeof effort !== 'string'
    || !LADDER_MODELS.includes(model) || !LADDER_EFFORTS.includes(effort)) {
    throw new Error(`Unknown profile override ${task}=${String(model)}:${String(effort)}; allowed models: ${LADDER_MODELS.join(', ')}; allowed efforts: ${LADDER_EFFORTS.join(', ')}.`);
  }
  return { model, effort };
}

function addOverrideText(overrides, raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const equals = text.indexOf('=');
  if (equals < 0) throw new Error(`Unknown profile override ${JSON.stringify(text)}; expected <task>=<model>:<effort>.`);
  const task = overrideTaskName(text.slice(0, equals));
  const config = text.slice(equals + 1).trim();
  if (!config) throw new Error(`Unknown profile override ${text}; expected <task>=<model>:<effort>.`);
  let parsed;
  try {
    parsed = parseConfigs(config);
  } catch (error) {
    throw new Error(`Unknown profile override ${text}; ${errorMessage(error)}`);
  }
  if (parsed.length !== 1) throw new Error(`Unknown profile override ${text}; expected exactly one <model>:<effort>.`);
  overrides.set(task, { model: parsed[0].model, effort: parsed[0].effort });
}

/**
 * Parse --profile-override values into a Map of task -> { model, effort }.
 * Accepts the CLI strings `<task>=<model>:<effort>` (one or an array of them) and
 * an already-parsed Map or plain object of the same shape. Anything malformed
 * (missing '=' or ':', unknown model/effort, bad task name) throws.
 */
export function parseProfileOverrides(value) {
  const overrides = new Map();
  if (value === null || typeof value === 'undefined') return overrides;
  if (value instanceof Map) {
    for (const [task, profile] of value.entries()) overrides.set(overrideTaskName(task), overrideProfileFor(task, profile));
    return overrides;
  }
  if (Array.isArray(value)) {
    for (const entry of value) addOverrideText(overrides, entry);
    return overrides;
  }
  if (typeof value === 'object') {
    for (const [task, profile] of Object.entries(value)) overrides.set(overrideTaskName(task), overrideProfileFor(task, profile));
    return overrides;
  }
  addOverrideText(overrides, value);
  return overrides;
}

function positiveInt(name, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
}

function nonNegativeInt(name, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer.`);
  return number;
}

const money = value => (Number.isFinite(value) ? `$${value.toFixed(4)}` : 'n/a');
const percent = value => `${Math.round(value * 100)}%`;
const say = line => process.stdout.write(`${line}\n`);

async function captureEditorialCommand(opts) {
  if (!opts.runsDir) throw new Error('--runs-dir <dir> is required.');
  if (!opts.out) throw new Error('--out <records.jsonl> is required.');
  const outFile = path.resolve(opts.out);
  assertOutsideRepo(path.dirname(outFile));
  const limit = positiveInt('--limit', opts.limit ?? DEFAULT_EDITORIAL_LIMIT);
  const { records, stats } = await captureEditorialRecords(opts.runsDir, { limit });
  fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
  writePrivate(outFile, records.map(record => `${JSON.stringify(record)}\n`).join(''));
  const cost = records.reduce((sum, record) => sum + (Number.isFinite(record.baseline.costUsd) ? record.baseline.costUsd : 0), 0);
  say(`editorial records: ${stats.kept} of ${stats.jobs} jobs (limit ${limit})`);
  say(`dropped: ${stats.resumedStarts} resume starts, ${stats.unpaired} unpaired, ${stats.invalidPlan} invalid plans, ${stats.invalidPrompt} unreadable prompts`);
  say(`recorded baseline cost: ${money(cost)}`);
  return 0;
}

async function captureStageCommand(opts) {
  if (!opts.runsDir) throw new Error('--runs-dir <dir> is required.');
  if (!opts.stage) throw new Error('--stage <name> is required.');
  if (!opts.out) throw new Error('--out <records.jsonl> is required.');
  const outFile = path.resolve(opts.out);
  assertOutsideRepo(path.dirname(outFile));
  const limit = positiveInt('--limit', opts.limit ?? DEFAULT_STAGE_LIMIT);
  const { records, stats } = captureStageRecords(opts.runsDir, {
    stage: opts.stage, limit, acceptedOnly: opts.acceptedOnly === true,
  });
  fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
  writePrivate(outFile, records.map(record => `${JSON.stringify(record)}\n`).join(''));
  const cost = records.reduce((sum, record) => sum + (Number.isFinite(record.baseline.costUsd) ? record.baseline.costUsd : 0), 0);
  say(`${opts.stage} records: ${stats.kept} of ${stats.jobs} jobs (limit ${limit})`);
  say(`dropped: ${stats.resumedStarts} resume starts, ${stats.unpaired} unpaired, ${stats.unreadableStarts} unreadable starts, ${stats.notAccepted} not accepted`);
  say(`submissions: ${stats.submitted} logged, ${stats.rejected} rejected, ${stats.validationErrors} validation errors`);
  say(`recorded baseline cost: ${money(cost)}`);
  return 0;
}

// ---- Evidence archive -------------------------------------------------------

// The archive keeps one directory per job; each file is
// `<NNNNN>-<stage>-<kind>-<sha>.json` holding { stage, revision, kind, candidateId, content }.
// A stage name may itself contain '-', so the stage is matched literally rather
// than by a greedy pattern, and every other file (candidates, other stages) is ignored.
const ARCHIVE_STAGE_NAME = /^[a-z0-9][a-z0-9-]*$/u;

function archivePatterns(stage) {
  const literal = stage.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const suffix = '([0-9a-f]+)\\.json$';
  return {
    prompt: new RegExp(`^([0-9]+)-${literal}-prompt-${suffix}`, 'u'),
    reply: new RegExp(`^([0-9]+)-${literal}-reply-${suffix}`, 'u'),
  };
}

function readArchiveJson(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an archive object');
  return parsed;
}

/**
 * Pair every archived `<stage>` prompt with its reply (same NNNNN prefix, same job
 * directory) into ladder records. Unpaired prompts, unreadable files and any other
 * stage's files are counted in stats and skipped; nothing is ever printed here.
 */
export function captureArchiveRecords(archiveDir, { stage = '', limit = null } = {}) {
  const name = typeof stage === 'string' ? stage.trim() : '';
  if (!ARCHIVE_STAGE_NAME.test(name)) throw new Error(`--stage ${JSON.stringify(stage ?? '')} must be a lowercase stage name.`);
  const cap = limit === null || typeof limit === 'undefined' ? null : Number(limit);
  if (cap !== null && (!Number.isSafeInteger(cap) || cap < 1)) throw new Error('--limit must be a positive integer.');
  if (!archiveDir) throw new Error('--archive-dir <dir> is required.');
  const dir = path.resolve(String(archiveDir));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`--archive-dir ${dir} is not a directory.`);
  const patterns = archivePatterns(name);
  const stats = { jobs: 0, prompts: 0, paired: 0, unpaired: 0, unreadable: 0, ignored: 0, kept: 0 };
  const pairs = [];
  const jobIds = fs.readdirSync(dir)
    .filter(jobId => { try { return fs.statSync(path.join(dir, jobId)).isDirectory(); } catch { return false; } })
    .sort();
  for (const jobId of jobIds) {
    const jobDir = path.join(dir, jobId);
    const prompts = new Map();
    const replies = new Map();
    for (const fileName of fs.readdirSync(jobDir).sort()) {
      const asPrompt = patterns.prompt.exec(fileName);
      const asReply = asPrompt ? null : patterns.reply.exec(fileName);
      if (!asPrompt && !asReply) {
        if (fileName.endsWith('.json')) stats.ignored += 1;
        continue;
      }
      const prefix = asPrompt ? asPrompt[1] : asReply[1];
      const bucket = asPrompt ? prompts : replies;
      // One file per prefix keeps the pairing 1:1 even if the archive holds duplicates.
      if (!bucket.has(prefix)) bucket.set(prefix, path.join(jobDir, fileName));
    }
    stats.jobs += 1;
    for (const prefix of [...prompts.keys()].sort((left, right) => Number(left) - Number(right) || left.localeCompare(right))) {
      stats.prompts += 1;
      const replyFile = replies.get(prefix);
      if (!replyFile) { stats.unpaired += 1; continue; }
      let promptFile;
      let replyFileJson;
      try {
        promptFile = readArchiveJson(prompts.get(prefix));
        replyFileJson = readArchiveJson(replyFile);
      } catch { stats.unreadable += 1; continue; }
      const text = promptFile.content?.prompt;
      const response = replyFileJson.content?.response;
      if (typeof text !== 'string' || !text.trim() || typeof response !== 'string') { stats.unreadable += 1; continue; }
      const pageImages = Array.isArray(promptFile.content?.pageImages) ? promptFile.content.pageImages : [];
      pairs.push({
        jobId,
        prefix,
        record: {
          id: `${name}:${jobId}:${prefix}`,
          task: name,
          text,
          systemAppend: '',
          responseSchema: null,
          pageImages,
          baseline: { text: response, model: null, effort: null, costUsd: null, durationMs: null },
        },
      });
    }
  }
  // Deterministic order: jobId first, then the numeric NNNNN prefix.
  pairs.sort((left, right) => left.jobId.localeCompare(right.jobId)
    || Number(left.prefix) - Number(right.prefix) || left.prefix.localeCompare(right.prefix));
  const selected = cap === null ? pairs : pairs.slice(0, cap);
  stats.paired = pairs.length;
  stats.kept = selected.length;
  return { records: selected.map(pair => pair.record), stats };
}

export async function captureArchiveCommand(opts) {
  if (!opts.archiveDir) throw new Error('--archive-dir <dir> is required.');
  if (!opts.stage) throw new Error('--stage <name> is required.');
  if (!opts.out) throw new Error('--out <records.jsonl> is required.');
  const outFile = path.resolve(opts.out);
  assertOutsideRepo(path.dirname(outFile));
  const limit = typeof opts.limit === 'undefined' ? null : positiveInt('--limit', opts.limit);
  const { records, stats } = captureArchiveRecords(opts.archiveDir, { stage: opts.stage, limit });
  fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
  writePrivate(outFile, records.map(record => `${JSON.stringify(record)}\n`).join(''));
  say(`${opts.stage} records: ${stats.kept} of ${stats.prompts} archived prompts in ${stats.jobs} jobs (limit ${limit ?? 'none'})`);
  say(`skipped: ${stats.unpaired} unpaired, ${stats.unreadable} unreadable, ${stats.ignored} other-stage files`);
  return 0;
}

async function runCommand(opts, deps = {}) {
  if (!opts.records) throw new Error('--records <records.jsonl> is required.');
  if (!opts.out) throw new Error('--out <dir> is required.');
  const configs = parseConfigs(opts.configs ?? '');
  const reps = positiveInt('--reps', opts.reps ?? 1);
  const concurrency = positiveInt('--concurrency', opts.concurrency ?? 4);
  const records = readJsonl(path.resolve(opts.records));
  if (!records.length) throw new Error(`${opts.records} holds no records.`);
  const journal = deps.journalFactory?.({
    tool: 'claude-effort-ladder run', task: [...new Set(records.map(record => record.task).filter(Boolean))].join(', '),
    label: configs.map(config => config.id).join(', '), outDir: path.resolve(opts.out),
    command: deps.command ?? '', facts: { Records: `${records.length} from ${path.resolve(opts.records)}`, Reps: reps },
  }) ?? null;
  let stats;
  try {
    stats = await runLadder({ records, configs, reps, outDir: opts.out, concurrency, journal });
  } catch (error) {
    journal?.finish(`failed: ${errorMessage(error)}`);
    throw error;
  }
  journal?.finish('finished');
  say(`ladder cells: ran ${stats.planned}, skipped ${stats.skipped} already ok, ${stats.valid} valid, ${stats.invalid} invalid, ${stats.failed} failed calls`);
  const rows = readJsonl(stats.resultsFile);
  const spent = rows.reduce((sum, row) => sum + (Number.isFinite(row.costUsd) ? row.costUsd : 0), 0);
  say(`results rows: ${rows.length}; recorded cost: ${money(spent)}`);
  return 0;
}

/**
 * capture-career: compile the whole career profile in one run. --profile-override
 * answers that one task live at the override model/effort (never replayed), while
 * every other task keeps its production profile. deps lets tests inject the app
 * modules, the stage runner and the line writer.
 */
export async function captureCareerCommand(opts, deps = {}) {
  if (!opts.source) throw new Error('--source <file.md> is required.');
  if (!opts.out) throw new Error('--out <dir> is required.');
  const journal = deps.journalFactory?.({
    tool: 'claude-effort-ladder capture-career', task: String(opts.ladderTasks ?? DEFAULT_LADDER_TASKS.join(',')),
    label: String(opts.configs ?? ''), outDir: path.resolve(opts.out), command: deps.command ?? '',
  }) ?? null;
  try {
    return await captureCareerInner(opts, deps, journal);
  } catch (error) {
    journal?.finish(`failed: ${errorMessage(error)}`);
    throw error;
  }
}

/** One journal row per side of a career capture, from the capture's running stats. */
function careerJournalRows(stats) {
  return [
    { arm: 'production baseline', n: stats.baselineCalls, valid: stats.baselineValid, costUsd: stats.baselineCostUsd, notes: `${stats.retries} repairs` },
    { arm: 'ladder cells', n: stats.ladderCalls, valid: stats.ladderValid, failed: stats.ladderFailed, costUsd: stats.ladderCostUsd, notes: 'per-config rows: summarize --out' },
  ];
}

async function captureCareerInner(opts, deps, journal) {
  const loadAppFor = deps.loadApp || loadApp;
  const sayLine = deps.say || say;
  const configs = parseConfigs(opts.configs ?? '');
  const overrides = parseProfileOverrides(opts.profileOverrides ?? null);
  const reps = positiveInt('--reps', opts.reps ?? 1);
  const concurrency = positiveInt('--concurrency', opts.concurrency ?? 4);
  // --max-calls 0 disables the cap; it is handed to the capture as 0.
  const maxCalls = nonNegativeInt('--max-calls', opts.maxCalls ?? DEFAULT_MAX_CALLS);
  const maxRepairs = positiveInt('--max-repairs', opts.maxRepairs ?? MAX_REPAIR_ATTEMPTS);
  const ladderTasks = ladderTasksFrom(opts.ladderTasks);
  const modules = await loadAppFor();
  // deps.compile lets a test drive the whole compile without the real app driver.
  const compile = deps.compile || (async args => modules.compileAuditedCareerSnapshot(args));
  const sourcePath = path.resolve(opts.source);
  const text = fs.readFileSync(sourcePath, 'utf8');
  const sourceFiles = [{
    name: path.basename(sourcePath),
    contentHash: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
    legacyText: text,
    transcriptionAudit: modules.verbatimCareerTranscriptionAuditReceipt(),
  }];
  const capture = createCaptureCallText({
    ladderTasks, configs, reps, outDir: opts.out, concurrency, maxCalls, maxRepairs, app: modules,
    overrides, runStage: deps.runStage, stageContext: deps.stageContext,
    baselineFrom: opts.baselineFrom ?? null, onlyRecords: opts.onlyRecords ?? null,
    liveOnMiss: opts.liveOnMiss === true,
  });
  let snapshot = null;
  let failure = null;
  // The compile runs for a long time: record its running totals once a minute.
  const heartbeat = journal ? setInterval(() => journal.update({ rows: careerJournalRows(capture.stats) }, { force: true }), 60_000) : null;
  heartbeat?.unref?.();
  try {
    snapshot = await compile({
      sourceFiles, previousCompilation: null, callText: capture.callText, scheduler: mapLimit, workerCount: concurrency,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
  const stopped = failure !== null && errorCodeOf(failure) === MAX_CALLS_CODE;
  const { stats } = capture;
  journal?.update({ rows: careerJournalRows(stats) });
  sayLine(`baseline calls: ${stats.baselineCalls} (${stats.baselineValid} valid, ${stats.baselineInvalid} invalid, ${stats.retries} repairs)`);
  sayLine(`baseline cost: ${money(stats.baselineCostUsd)}`);
  if (opts.baselineFrom) sayLine(`replayed baselines: ${stats.baselineReplayed}; baseline misses: ${stats.baselineMisses}; answered live on miss: ${stats.baselineLive}`);
  if (stats.baselineOverrideLive) sayLine(`profile overrides answered live: ${stats.baselineOverrideLive}`);
  sayLine(`ladder cells: ${stats.ladderCalls} (${stats.ladderValid} valid, ${stats.ladderInvalid} invalid, ${stats.ladderFailed} failed calls); cost ${money(stats.ladderCostUsd)}`);
  if (stopped) sayLine(`stopped cleanly at --max-calls ${maxCalls}; everything measured so far is written`);
  const report = careerCaptureReport({
    stats, snapshot, failure: stopped ? null : failure, stopped, maxCalls,
  });
  for (const line of report) sayLine(line);
  if (failure && !stopped) throw failure;
  journal?.finish(stopped ? `stopped at --max-calls ${maxCalls}` : 'finished');
  return 0;
}

/** The rounds a compile reached: folded entries carry a roundCount, details count 1. */
export function auditRoundCount(snapshot) {
  const history = snapshot?.auditHistory;
  if (!Array.isArray(history)) return null;
  return history.reduce((total, entry) => {
    const roundCount = entry?.kind === 'folded' ? entry.roundCount : 1;
    return total + (Number.isSafeInteger(roundCount) && roundCount > 0 ? roundCount : 1);
  }, 0);
}

function errorCodeOf(error) {
  const code = error?.code ?? error?.cause?.code;
  return typeof code === 'string' && code ? code : 'unknown';
}

/**
 * The closing report: per-task call counts and costs, the total cost, the rounds
 * reached, and whether the compile returned (approved) or threw (code only).
 * Counts, costs and codes only -- no prompt or answer text ever reaches stdout.
 */
export function careerCaptureReport({ stats = {}, snapshot = null, failure = null, stopped = false } = {}) {
  const lines = [];
  const entries = stats.byTask instanceof Map ? [...stats.byTask.entries()] : Object.entries(stats.byTask || {});
  entries.sort(([left], [right]) => String(left).localeCompare(String(right)));
  for (const [task, entry] of entries) {
    const calls = Number.isFinite(entry?.calls) ? entry.calls : 0;
    const ladderCalls = Number.isFinite(entry?.ladderCalls) ? entry.ladderCalls : 0;
    const replayed = Number.isFinite(entry?.replayed) ? entry.replayed : 0;
    const costUsd = Number.isFinite(entry?.costUsd) ? entry.costUsd : 0;
    const ladderPart = ladderCalls ? ` ladderCalls=${ladderCalls}` : '';
    lines.push(`${task}\tcalls=${calls}${ladderPart}\treplayed=${replayed}\tcost=${money(costUsd)}`);
  }
  const totalCost = (Number.isFinite(stats.baselineCostUsd) ? stats.baselineCostUsd : 0)
    + (Number.isFinite(stats.ladderCostUsd) ? stats.ladderCostUsd : 0);
  lines.push(`total cost: ${money(totalCost)}`);
  const rounds = auditRoundCount(snapshot);
  if (rounds !== null) lines.push(`rounds reached: ${rounds}`);
  if (failure) lines.push(`outcome: threw ${errorCodeOf(failure)}`);
  else if (!stopped) lines.push('outcome: approved');
  return lines;
}

async function summarizeCommand(opts) {
  if (!opts.out) throw new Error('--out <dir> is required.');
  const dir = path.resolve(opts.out);
  const rows = readJsonl(path.join(dir, 'results.jsonl'));
  if (!rows.length) throw new Error(`No results.jsonl rows in ${dir}.`);
  for (const group of summarizeResults(rows)) {
    say(`${group.task}\t${group.config}\tn=${group.n}\tvalid=${percent(group.validRate)}\tmeanCost=${money(group.meanCostUsd)}\ttotalCost=${money(group.totalCostUsd)}\tmeanMs=${group.meanDurationMs === null ? 'n/a' : Math.round(group.meanDurationMs)}`);
  }
  // --records adds the baseline comparison: 'pick' gets top-1 agreement, the
  // other tasks keep validity and cost only.
  const records = opts.records ? readJsonl(path.resolve(opts.records)) : [];
  for (const group of (records.length ? compareResults(rows, records) : [])) {
    const top1 = group.top1Agreement;
    const top1Part = top1 ? `\ttop1=${top1.rate === null ? 'n/a' : `${percent(top1.rate)} (${top1.agree}/${top1.n})`}` : '';
    say(`${group.task}\t${group.config}\tn=${group.n}\tvalid=${percent(group.validRate)}\ttotalCost=${money(group.totalCostUsd)}${top1Part}`);
  }
  return 0;
}

/** Only counts and costs are ever written to stdout: prompts and answers stay on disk. */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const { command, opts } = parseLadderArgs(argv);
  // Only the CLI entry sets requireDurable and journalFactory; tests call main() without them.
  if (deps.requireDurable && opts.out && ['run', 'capture-career'].includes(command)) {
    assertDurableOutDir(opts.out, { allowEphemeral: deps.allowEphemeral === true });
  }
  // Captured records are what a later run replays: keep them beside the results, not in a scratchpad.
  if (deps.requireDurable && opts.out && command.startsWith('capture-') && command !== 'capture-career') {
    assertDurableOutDir(path.dirname(path.resolve(opts.out)), { allowEphemeral: deps.allowEphemeral === true });
  }
  switch (command) {
    case 'capture-editorial': return captureEditorialCommand(opts);
    case 'capture-stage': return captureStageCommand(opts);
    case 'capture-archive': return captureArchiveCommand(opts);
    case 'run': return runCommand(opts, deps);
    case 'capture-career': return captureCareerCommand(opts, deps);
    case 'summarize': return summarizeCommand(opts);
    default: throw new Error(`Unknown command ${command || '(none)'}; expected capture-editorial, capture-stage, capture-archive, run, capture-career or summarize.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cliArgs, allowEphemeral] = takeEphemeralFlag(process.argv.slice(2));
  main(cliArgs, {
    requireDurable: true, allowEphemeral,
    journalFactory: allowEphemeral ? null : createRunJournal,
    command: `node scripts/claude-effort-ladder.mjs ${cliArgs.join(' ')}`,
  }).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
