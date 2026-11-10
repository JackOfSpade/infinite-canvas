import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  parseConfigs, childEnvFor, allowedIdsFromPlannerPrompt, captureEditorialRecords, runLadder,
  summarizeResults, createCaptureCallText, main, baselineKeyFor, parseOnlyRecords, ladderTasksFrom,
  parseLadderArgs, DEFAULT_LADDER_TASKS, parseProfileOverrides, captureCareerCommand, auditRoundCount,
  captureStageRecords, compareResults, pickCandidateIdsFromPrompt, pickTopCandidateId, validatePickRanking,
  captureArchiveRecords, ladderJournalRows,
} from './claude-effort-ladder.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ANSWER_SENTINEL = 'ANSWER-SENTINEL-3f9c';
const PROMPT_SENTINEL = 'PROMPT-SENTINEL-77ab';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `claude-effort-ladder-${prefix}-`));
}

function writeLines(file, rows) {
  fs.writeFileSync(file, rows.map(row => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const fakeStageContext = () => async () => ({ binary: '/fake/claude', env: { PATH: '/usr/bin' }, cwd: '/tmp/ladder-cwd' });

test('parseConfigs builds model:effort pairs for every allowed model and effort', () => {
  assert.deepEqual(parseConfigs('opus:xhigh,opus:high,sonnet:medium'), [
    { id: 'opus:xhigh', model: 'opus', effort: 'xhigh' },
    { id: 'opus:high', model: 'opus', effort: 'high' },
    { id: 'sonnet:medium', model: 'sonnet', effort: 'medium' },
  ]);
  assert.deepEqual(parseConfigs('haiku:low, sonnet:low,opus:medium'), [
    { id: 'haiku:low', model: 'haiku', effort: 'low' },
    { id: 'sonnet:low', model: 'sonnet', effort: 'low' },
    { id: 'opus:medium', model: 'opus', effort: 'medium' },
  ]);
});

test('parseConfigs rejects max, fable, unknown values and an empty list', () => {
  assert.throws(() => parseConfigs('opus:max'), /Unknown ladder effort max/u);
  assert.throws(() => parseConfigs('fable:high'), /Unknown ladder model fable/u);
  assert.throws(() => parseConfigs('opus:turbo'), /Unknown ladder effort turbo/u);
  assert.throws(() => parseConfigs('gpt:high'), /Unknown ladder model gpt/u);
  assert.throws(() => parseConfigs(''), /lists no ladder configs/u);
  assert.throws(() => parseConfigs(' , '), /lists no ladder configs/u);
  assert.throws(() => parseConfigs('opus'), /expected <model>:<effort>/u);
  assert.throws(() => parseConfigs('opus:high:extra'), /expected <model>:<effort>/u);
});

test('childEnvFor removes every CLAUDE*/ANTHROPIC* variable and ELECTRON_RUN_AS_NODE', () => {
  const env = {
    PATH: '/usr/bin', HOME: '/home/tester', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_EFFORT_LADDER: 'x', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'http://example.test',
    ELECTRON_RUN_AS_NODE: '1',
  };
  const clean = childEnvFor(env);
  assert.deepEqual(clean, { PATH: '/usr/bin', HOME: '/home/tester' });
  assert.equal(env.CLAUDECODE, '1', 'the parent environment is not mutated');
});

// ---- Editorial planner capture --------------------------------------------

const PLANNER_PROMPT = [
  'EDITORIAL PLANNING DELIVERABLE',
  'Copy every evidence ID exactly from the FULL APPROVED CATALOG.',
  '',
  'FULL APPROVED CATALOG (2 items; every ID and full quote):',
  '[host.career.role.r1.1] Role one — "did the thing"',
  '[host.career.skill.s1.1] Skill one — "knew the thing"',
  'INDEX-ELIGIBLE SKILLS (exact item names and their only permitted skill-group citation IDs):',
  '- Skill one -> s1',
].join('\n');

function planAnswer(evidenceIds = ['host.career.role.r1.1']) {
  return JSON.stringify({
    thesis: 'Lead with the migration.', paragraphs: [{ point: 'p', jobNeed: 'n', evidenceIds, editorialNote: 'why' }],
    omissions: [], qualification: 'No further qualification.',
  });
}

function plannerRun(runId, jobId, at, { resume = false, answer = planAnswer(), costUsd } = {}) {
  const started = { stage: 'editorial-plan', event: 'started', runId, jobId, resume, requestedModel: 'sonnet', requestedEffort: 'high', prompt: PLANNER_PROMPT, at };
  const response = { stage: 'editorial-plan', event: 'response', runId, answer, model: 'sonnet', durationMs: 120 + at, ...(costUsd === undefined ? {} : { costUsd }) };
  return [started, response];
}

test('allowedIdsFromPlannerPrompt reads the catalog the planner prompt printed', () => {
  assert.deepEqual(allowedIdsFromPlannerPrompt(PLANNER_PROMPT), ['host.career.role.r1.1', 'host.career.skill.s1.1']);
  assert.throws(() => allowedIdsFromPlannerPrompt('no catalog here'), /one unambiguous full-approved-catalog boundary/u);
});

test('captureEditorialRecords pairs first attempts by runId and describes the baseline', async () => {
  const runsDir = tempDir('runs-pair');
  writeLines(path.join(runsDir, 'run.jsonl'), [
    ...plannerRun('r1', 'job-a', 1000, { costUsd: 0.02 }),
    ...plannerRun('r2', 'job-b', 2000, { resume: true }),
    ...plannerRun('r3', 'job-c', 3000, { answer: planAnswer(['host.career.role.r9.9']) }),
  ]);
  const { records, stats } = await captureEditorialRecords(runsDir);
  assert.deepEqual(records.map(record => record.id), ['editorial-plan:job-a']);
  assert.equal(stats.resumedStarts, 1);
  assert.equal(stats.invalidPlan, 1);
  const [record] = records;
  assert.equal(record.task, 'editorial-plan');
  assert.equal(record.text, PLANNER_PROMPT);
  assert.equal(record.systemAppend, '');
  assert.equal(record.responseSchema, null);
  assert.equal(record.baseline.text, planAnswer());
  assert.equal(record.baseline.model, 'sonnet');
  assert.equal(record.baseline.effort, 'high');
  assert.equal(record.baseline.costUsd, 0.02);
  assert.equal(record.baseline.durationMs, 1120);
});

test('captureEditorialRecords keeps the newest run per jobId and only the newest N jobs', async () => {
  const runsDir = tempDir('runs-newest');
  writeLines(path.join(runsDir, 'a.jsonl'), [
    ...plannerRun('old-b', 'job-b', 1000, { answer: planAnswer() }),
    ...plannerRun('new-b', 'job-b', 5000, { answer: planAnswer(['host.career.skill.s1.1']) }),
    ...plannerRun('c1', 'job-c1', 2000),
  ]);
  writeLines(path.join(runsDir, 'b.jsonl'), [
    ...plannerRun('c2', 'job-c2', 3000),
    ...plannerRun('c3', 'job-c3', 4000),
  ]);
  const { records } = await captureEditorialRecords(runsDir, { limit: 2 });
  assert.deepEqual(records.map(record => record.id), ['editorial-plan:job-c3', 'editorial-plan:job-b']);
  assert.equal(records[1].baseline.text, planAnswer(['host.career.skill.s1.1']), 'the newest run for a jobId wins');
  const all = await captureEditorialRecords(runsDir, { limit: 6 });
  assert.equal(all.records.length, 4);
  await assert.rejects(() => captureEditorialRecords(runsDir, { limit: 0 }), /positive integer/u);
});

// ---- Ladder execution ------------------------------------------------------

test('runLadder calls the injected runner once per record x config x rep with the handoff and setting', async () => {
  const outDir = tempDir('run-args');
  const stageContext = async () => ({ binary: '/fake/claude', env: { PATH: '/usr/bin', HOME: '/home/tester' }, cwd: '/tmp/ladder-cwd' });
  const calls = [];
  const runStage = async args => {
    calls.push(args);
    return { text: 'ok', model: args.model, durationMs: 3, usage: { input_tokens: 2 }, costUsd: 0.01 };
  };
  const records = [
    { id: 'editorial-plan:a', task: 'editorial-plan', text: PROMPT_SENTINEL, systemAppend: '', responseSchema: null },
    { id: 'career-profile-compile:1', task: 'career-profile-compile', text: 'PAGE TEXT', systemAppend: 'CACHED PREFIX', responseSchema: { type: 'object' } },
  ];
  const configs = parseConfigs('opus:xhigh,sonnet:medium');
  const stats = await runLadder({ records, configs, reps: 2, runStage, validate: () => {}, outDir, stageContext, concurrency: 3 });
  assert.equal(calls.length, 8);
  assert.equal(stats.planned, 8);
  const combos = new Map();
  for (const call of calls) {
    assert.equal(call.persistSession, false, 'measurement stages never persist a session');
    assert.equal(call.binary, '/fake/claude');
    assert.equal(call.cwd, '/tmp/ladder-cwd');
    const combo = `${call.text}\u0000${call.systemAppend}\u0000${call.model}\u0000${call.effort}`;
    combos.set(combo, (combos.get(combo) || 0) + 1);
    assert.equal(call.env.PATH, '/usr/bin');
    if (call.systemAppend) assert.equal('DISABLE_PROMPT_CACHING' in call.env, false, 'a cached prefix keeps prompt caching on');
    else assert.equal(call.env.DISABLE_PROMPT_CACHING, '1', 'an uncached prompt disables prompt caching');
  }
  assert.deepEqual([...combos.entries()].sort(), [
    [`${PROMPT_SENTINEL}\u0000\u0000opus\u0000xhigh`, 2],
    [`${PROMPT_SENTINEL}\u0000\u0000sonnet\u0000medium`, 2],
    ['PAGE TEXT\u0000CACHED PREFIX\u0000opus\u0000xhigh', 2],
    ['PAGE TEXT\u0000CACHED PREFIX\u0000sonnet\u0000medium', 2],
  ].sort());
});

test('runLadder writes documented rows, marks invalid answers and thrown errors, and resumes', async () => {
  const outDir = tempDir('run-rows');
  const validate = (record, text) => {
    if (record.task === 'editorial-plan' && text !== 'good answer') throw new Error('planner rejected the answer');
  };
  const runStage = async ({ model, text }) => {
    if (text === 'THROWS') throw new Error('runner exploded');
    return { text: model === 'sonnet' ? 'bad answer' : 'good answer', model, durationMs: 11, costUsd: 0.25, usage: { output_tokens: 4 } };
  };
  const records = [
    { id: 'editorial-plan:a', task: 'editorial-plan', text: 'PROMPT', systemAppend: '', responseSchema: null },
    { id: 'editorial-plan:b', task: 'editorial-plan', text: 'THROWS', systemAppend: '', responseSchema: null },
  ];
  const configs = parseConfigs('opus:high,sonnet:low');
  const stats = await runLadder({ records, configs, reps: 1, runStage, validate, outDir, stageContext: fakeStageContext() });
  assert.equal(stats.planned, 4);
  const resultsFile = path.join(outDir, 'results.jsonl');
  const rows = readLines(resultsFile);
  assert.equal(rows.length, 4);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['config', 'costUsd', 'durationMs', 'error', 'key', 'model', 'ok', 'recordId', 'rep', 'task', 'text', 'usage', 'valid']);
  const opusA = rows.find(row => row.recordId === 'editorial-plan:a' && row.config === 'opus:high');
  assert.deepEqual(opusA, {
    recordId: 'editorial-plan:a', key: baselineKeyFor('PROMPT', ''), task: 'editorial-plan', config: 'opus:high', rep: 1, ok: true, valid: true, error: null,
    costUsd: 0.25, usage: { output_tokens: 4 }, durationMs: 11, model: 'opus', text: 'good answer',
  });
  const sonnetA = rows.find(row => row.recordId === 'editorial-plan:a' && row.config === 'sonnet:low');
  assert.equal(sonnetA.ok, true, 'the call itself succeeded');
  assert.equal(sonnetA.valid, false, 'the validator refused the answer');
  assert.equal(sonnetA.error, 'planner rejected the answer');
  for (const row of rows.filter(entry => entry.recordId === 'editorial-plan:b')) {
    assert.equal(row.ok, false);
    assert.equal(row.valid, false);
    assert.equal(row.error, 'runner exploded');
    assert.equal(row.text, '');
    assert.equal(row.costUsd, null);
  }
  // A second run skips every combination that already has an ok:true row.
  const resumed = await runLadder({ records, configs, reps: 1, runStage, validate, outDir, stageContext: fakeStageContext() });
  assert.equal(resumed.skipped, 2);
  assert.equal(resumed.planned, 2);
  const after = readLines(resultsFile);
  assert.equal(after.length, 6);
  assert.equal((fs.statSync(resultsFile).mode & 0o777), 0o600, 'results are owner-only');
});

test('runLadder refuses an output directory inside the repository before calling the runner', async () => {
  const calls = [];
  const runStage = async args => { calls.push(args); return { text: 'x' }; };
  await assert.rejects(() => runLadder({
    records: [{ id: 'editorial-plan:a', task: 'editorial-plan', text: 'PROMPT', systemAppend: '', responseSchema: null }],
    configs: parseConfigs('opus:high'), reps: 1, runStage, validate: () => {},
    outDir: path.join(REPO_ROOT, 'tmp-effort-ladder-results'), stageContext: fakeStageContext(),
  }), /outside the repository/u);
  assert.equal(calls.length, 0);
});

test('summarizeResults groups by task and config with n, valid rate and costs', () => {
  const rows = [
    { task: 'editorial-plan', config: 'opus:high', ok: true, valid: true, costUsd: 0.50, durationMs: 100 },
    { task: 'editorial-plan', config: 'opus:high', ok: true, valid: false, costUsd: 0.25, durationMs: 300 },
    { task: 'editorial-plan', config: 'sonnet:low', ok: false, valid: false, costUsd: null, durationMs: 50 },
  ];
  assert.deepEqual(summarizeResults(rows), [
    { task: 'editorial-plan', config: 'opus:high', n: 2, validRate: 0.5, failed: 0, totalCostUsd: 0.75, meanCostUsd: 0.375, meanDurationMs: 200 },
    { task: 'editorial-plan', config: 'sonnet:low', n: 1, validRate: 0, failed: 1, totalCostUsd: 0, meanCostUsd: null, meanDurationMs: 50 },
  ]);
});

test('summarize prints counts and costs but never prompt or answer text', async () => {
  const outDir = tempDir('run-summary');
  writeLines(path.join(outDir, 'results.jsonl'), [{
    recordId: 'editorial-plan:a', task: 'editorial-plan', config: 'opus:high', rep: 1, ok: true, valid: true, error: null,
    costUsd: 0.42, usage: null, durationMs: 500, model: 'opus', text: ANSWER_SENTINEL,
  }]);
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => { chunks.push(String(chunk)); return true; };
  try {
    assert.equal(await main(['summarize', '--out', outDir]), 0);
  } finally {
    process.stdout.write = original;
  }
  const output = chunks.join('');
  assert.ok(output.includes('editorial-plan\topus:high\tn=1\tvalid=100%'), `unexpected summary output: ${output}`);
  assert.ok(output.includes('$0.4200'), 'the cost is printed');
  assert.ok(!output.includes(ANSWER_SENTINEL), 'no answer text reaches stdout');
  assert.ok(!output.includes(PROMPT_SENTINEL), 'no prompt text reaches stdout');
});

// ---- Career capture --------------------------------------------------------

const SHARD_SCHEMA = { type: 'object', required: ['shard'], properties: { shard: { type: 'string' } } };

test('createCaptureCallText uses the production profile, records the baseline and ladders the first-attempt text', async () => {
  const outDir = tempDir('capture-ladder');
  const calls = [];
  const runStage = async args => {
    calls.push(args);
    return {
      text: args.effort === 'high' ? 'not json at all' : '{"shard":"ok"}',
      model: args.model, durationMs: 9, costUsd: 0.05, usage: { input_tokens: 1 },
    };
  };
  const capture = createCaptureCallText({
    runStage, profileFor: () => ({ model: 'opus', effort: 'xhigh', tools: '' }), ladderTasks: ['career-profile-compile'],
    configs: parseConfigs('opus:high,sonnet:low'), reps: 1, outDir, concurrency: 2, stageContext: fakeStageContext(),
  });
  const value = await capture.callText('COMPILE THIS PAGE', {
    task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: parsed => parsed,
  });
  assert.deepEqual(value, { shard: 'ok' }, 'the parsed baseline value is returned to the pipeline');
  assert.equal(calls[0].model, 'opus');
  assert.equal(calls[0].effort, 'xhigh');
  assert.equal(calls[0].persistSession, false);
  assert.equal(calls[0].env.DISABLE_PROMPT_CACHING, '1');
  const [baseline] = readLines(path.join(outDir, 'baseline.jsonl'));
  assert.deepEqual(Object.keys(baseline).sort(),
    ['answer', 'attempts', 'costUsd', 'effort', 'key', 'model', 'recordId', 'responseSchema', 'systemAppend', 'task', 'text', 'usage', 'valid']);
  assert.equal(baseline.recordId, 'career-profile-compile:1');
  assert.equal(baseline.text, calls[0].text);
  assert.equal(baseline.systemAppend, '');
  assert.equal(baseline.answer, '{"shard":"ok"}');
  assert.equal(baseline.valid, true);
  assert.equal(baseline.attempts, 1);
  assert.equal(baseline.costUsd, 0.05);
  assert.deepEqual(baseline.usage, { input_tokens: 1 });
  assert.equal(baseline.model, 'opus');
  assert.equal(baseline.effort, 'xhigh');
  assert.equal((fs.statSync(path.join(outDir, 'baseline.jsonl')).mode & 0o777), 0o600);
  const ladderCalls = calls.slice(1);
  assert.equal(ladderCalls.length, 2, 'every config x rep runs for a ladder task');
  for (const call of ladderCalls) {
    assert.equal(call.text, calls[0].text, 'the ladder measures the identical first-attempt text');
    assert.equal(call.systemAppend, '');
    assert.equal(call.persistSession, false);
  }
  assert.deepEqual(ladderCalls.map(call => `${call.model}:${call.effort}`).sort(), ['opus:high', 'sonnet:low']);
  const ladder = readLines(path.join(outDir, 'results.jsonl'))
    .map(row => [row.recordId, row.config, row.ok, row.valid, row.text]).sort();
  assert.deepEqual(ladder, [
    ['career-profile-compile:1', 'opus:high', true, false, 'not json at all'],
    ['career-profile-compile:1', 'sonnet:low', true, true, '{"shard":"ok"}'],
  ]);
});

test('createCaptureCallText ladders only the --ladder-tasks', async () => {
  const outDir = tempDir('capture-nonladder');
  const calls = [];
  const runStage = async args => {
    calls.push(args);
    return { text: '{"shard":"ok"}', model: args.model, durationMs: 3, costUsd: 0.01 };
  };
  const capture = createCaptureCallText({
    runStage, profileFor: () => ({ model: 'sonnet', effort: 'medium' }), ladderTasks: ['career-profile-compile'],
    configs: parseConfigs('opus:high,sonnet:low'), reps: 2, outDir, stageContext: fakeStageContext(),
  });
  await capture.callText('REPAIR THIS PAGE', { task: 'career-profile-repair', responseSchema: SHARD_SCHEMA, responseValidator: parsed => parsed });
  assert.equal(calls.length, 1, 'a non-ladder task answers the baseline only');
  assert.equal(readLines(path.join(outDir, 'baseline.jsonl')).length, 1);
  assert.equal(fs.existsSync(path.join(outDir, 'results.jsonl')), false, 'no ladder rows for a non-ladder task');
});

test('createCaptureCallText repairs a rejected answer with the rejection message and ladders the first-attempt text', async () => {
  const outDir = tempDir('capture-repair');
  const calls = [];
  const runStage = async args => {
    calls.push(args);
    if (args.model !== 'sonnet') return { text: '{"shard":"right"}', model: args.model, durationMs: 4, costUsd: 0.02 };
    const attempt = calls.filter(call => call.model === 'sonnet').length;
    return { text: JSON.stringify({ shard: attempt === 1 ? 'wrong' : 'right' }), model: args.model, durationMs: 4, costUsd: 0.02 };
  };
  const validate = parsed => {
    if (parsed.shard !== 'right') throw new Error('shard must be right');
    return parsed;
  };
  const capture = createCaptureCallText({
    runStage, profileFor: () => ({ model: 'sonnet', effort: 'medium' }), ladderTasks: ['career-profile-compile'],
    configs: parseConfigs('opus:high'), reps: 1, outDir, stageContext: fakeStageContext(),
  });
  const value = await capture.callText('PAGE', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: validate });
  assert.deepEqual(value, { shard: 'right' });
  const baselineCalls = calls.filter(call => call.model === 'sonnet');
  assert.equal(baselineCalls.length, 2, 'one rejection buys exactly one repair');
  assert.ok(baselineCalls[1].text.startsWith(baselineCalls[0].text), 'the correction is appended to the same prompt');
  assert.ok(baselineCalls[1].text.includes('shard must be right'), 'the correction carries the rejection message');
  const [baseline] = readLines(path.join(outDir, 'baseline.jsonl'));
  assert.equal(baseline.attempts, 2);
  assert.equal(baseline.valid, true);
  assert.equal(baseline.costUsd, 0.04, 'the baseline cost covers every attempt');
  const [ladderCall] = calls.filter(call => call.model === 'opus');
  assert.equal(ladderCall.text, baselineCalls[0].text, 'the ladder runs on the first-attempt text, not the repaired one');
  const [ladderRow] = readLines(path.join(outDir, 'results.jsonl'));
  assert.equal(ladderRow.recordId, 'career-profile-compile:1');
  assert.equal(ladderRow.valid, true);
  assert.equal(ladderRow.text, '{"shard":"right"}');
});

test('createCaptureCallText stops repairing after two extra attempts and reports the rejection', async () => {
  const outDir = tempDir('capture-rejected');
  const calls = [];
  const runStage = async args => {
    calls.push(args);
    return { text: '{"shard":"never"}', model: args.model, durationMs: 1, costUsd: 0.01 };
  };
  const capture = createCaptureCallText({
    runStage, profileFor: () => ({ model: 'sonnet', effort: 'medium' }), ladderTasks: [],
    configs: parseConfigs('opus:high'), reps: 1, outDir, stageContext: fakeStageContext(),
  });
  await assert.rejects(() => capture.callText('PAGE', {
    task: 'career-profile-compile', responseSchema: SHARD_SCHEMA,
    responseValidator: () => { throw new Error('always wrong'); },
  }), /always wrong/u);
  assert.equal(calls.length, 3, 'the first answer plus at most two repairs');
  const [baseline] = readLines(path.join(outDir, 'baseline.jsonl'));
  assert.equal(baseline.attempts, 3);
  assert.equal(baseline.valid, false);
  assert.equal(baseline.answer, '{"shard":"never"}');
});

test('createCaptureCallText stops cleanly at --max-calls', async () => {
  const outDir = tempDir('capture-maxcalls');
  const runStage = async args => ({ text: '{"shard":"ok"}', model: args.model, durationMs: 1, costUsd: 0.01 });
  const capture = createCaptureCallText({
    runStage, profileFor: () => ({ model: 'sonnet', effort: 'medium' }), ladderTasks: [],
    configs: parseConfigs('opus:high'), reps: 1, outDir, maxCalls: 1, stageContext: fakeStageContext(),
  });
  await capture.callText('FIRST', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: parsed => parsed });
  await assert.rejects(
    () => capture.callText('SECOND', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: parsed => parsed }),
    error => error.code === 'LADDER_MAX_CALLS',
  );
  assert.equal(capture.stats.baselineCalls, 1);
  assert.equal(readLines(path.join(outDir, 'baseline.jsonl')).length, 1);
});

// ---- Baseline replay, --only-records and the --ladder-tasks edge ------------

const SONNET_PROFILE = () => ({ model: 'sonnet', effort: 'medium' });
const sha256Hex = (text, systemAppend = '') => crypto.createHash('sha256').update(`${text}\u0000${systemAppend}`, 'utf8').digest('hex');
const SHARD_OK = '{"shard":"ok"}';
const accept = parsed => parsed;

test('createCaptureCallText writes a sha256 key on every baseline row and replays stored answers without a live baseline call', async () => {
  const sourceDir = tempDir('replay-source');
  const liveCalls = [];
  const live = createCaptureCallText({
    runStage: async args => {
      liveCalls.push(args);
      return { text: SHARD_OK, model: args.model, durationMs: 4, costUsd: 0.03, usage: { input_tokens: 2 } };
    },
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: sourceDir, stageContext: fakeStageContext(),
  });
  assert.deepEqual(await live.callText('COMPILE THIS PAGE', {
    task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept,
  }), { shard: 'ok' });
  assert.equal(liveCalls.length, 1, 'the first capture pays for the baseline');
  const [liveRow] = readLines(path.join(sourceDir, 'baseline.jsonl'));
  assert.equal(liveRow.costUsd, 0.03);
  assert.equal(liveRow.key, sha256Hex(liveRow.text, liveRow.systemAppend), 'every baseline row carries sha256(text + NUL + systemAppend)');
  assert.equal(liveRow.key, baselineKeyFor(liveRow.text, liveRow.systemAppend));
  assert.equal(liveRow.key.length, 64);

  const replayDir = tempDir('replay-target');
  const replayCalls = [];
  const replay = createCaptureCallText({
    runStage: async args => {
      replayCalls.push(args);
      return { text: SHARD_OK, model: args.model, durationMs: 3, costUsd: 0.05 };
    },
    profileFor: SONNET_PROFILE, ladderTasks: ['career-profile-compile'], configs: parseConfigs('opus:high'), reps: 1,
    outDir: replayDir, baselineFrom: sourceDir, stageContext: fakeStageContext(),
  });
  assert.deepEqual(await replay.callText('COMPILE THIS PAGE', {
    task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept,
  }), { shard: 'ok' }, 'the stored answer is returned to the pipeline');
  assert.equal(replayCalls.length, 1, 'only the ladder cell reaches the runner; the baseline is replayed');
  assert.equal(replayCalls[0].model, 'opus');
  assert.equal(replayCalls[0].effort, 'high');
  assert.equal(replayCalls[0].text, liveCalls[0].text, 'the ladder still measures the identical materialized handoff');
  const [replayedRow] = readLines(path.join(replayDir, 'baseline.jsonl'));
  assert.equal(replayedRow.recordId, 'career-profile-compile:1');
  assert.equal(replayedRow.answer, SHARD_OK);
  assert.equal(replayedRow.valid, true);
  assert.equal(replayedRow.replayed, true, 'a replayed baseline is marked as a replay');
  assert.equal(replayedRow.costUsd, 0, 'a replayed baseline is not new spend');
  assert.equal(replayedRow.key, liveRow.key, 'the replay row is indexed by the same key');
  assert.equal(replay.stats.baselineReplayed, 1);
  assert.equal(replay.stats.baselineMisses, 0);
  assert.equal(replay.stats.baselineCostUsd, 0, 'replayed rows never add to stats.baselineCostUsd');
});

test('createCaptureCallText throws LADDER_BASELINE_MISS for a call whose key is not in --baseline-from', async () => {
  const sourceDir = tempDir('miss-source');
  const source = createCaptureCallText({
    runStage: async args => ({ text: '{"shard":"other"}', model: args.model, durationMs: 1, costUsd: 0.01 }),
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: sourceDir, stageContext: fakeStageContext(),
  });
  await source.callText('A DIFFERENT PAGE', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });

  const replayDir = tempDir('miss-target');
  const calls = [];
  const replay = createCaptureCallText({
    runStage: async args => { calls.push(args); return { text: SHARD_OK, model: args.model }; },
    profileFor: SONNET_PROFILE, ladderTasks: ['career-profile-compile'], configs: parseConfigs('opus:high'), reps: 1,
    outDir: replayDir, baselineFrom: sourceDir, stageContext: fakeStageContext(),
  });
  await assert.rejects(
    () => replay.callText('THE PAGE THAT WAS NEVER CAPTURED', {
      task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept,
    }),
    error => error.code === 'LADDER_BASELINE_MISS',
  );
  assert.equal(calls.length, 0, 'a baseline miss never falls back to a live call');
  assert.equal(replay.stats.baselineMisses, 1, 'the miss is counted');
  assert.equal(replay.stats.baselineReplayed, 0);
  assert.equal(readLines(path.join(replayDir, 'baseline.jsonl')).length, 0, 'a miss writes no baseline row');
  assert.equal(replay.stats.ladderCalls, 0, 'a miss stops before the ladder');
});

test('createCaptureCallText throws LADDER_BASELINE_MISS when the live validator rejects the stored answer', async () => {
  const sourceDir = tempDir('invalid-source');
  const source = createCaptureCallText({
    runStage: async args => ({ text: '{"shard":"loose"}', model: args.model, durationMs: 1, costUsd: 0.01 }),
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: sourceDir, stageContext: fakeStageContext(),
  });
  await source.callText('COMPILE THIS PAGE', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });

  const replayDir = tempDir('invalid-target');
  const calls = [];
  const replay = createCaptureCallText({
    runStage: async args => { calls.push(args); return { text: SHARD_OK, model: args.model }; },
    profileFor: SONNET_PROFILE, ladderTasks: ['career-profile-compile'], configs: parseConfigs('opus:high'), reps: 1,
    outDir: replayDir, baselineFrom: sourceDir, stageContext: fakeStageContext(),
  });
  await assert.rejects(
    () => replay.callText('COMPILE THIS PAGE', {
      task: 'career-profile-compile', responseSchema: SHARD_SCHEMA,
      responseValidator: parsed => {
        if (parsed.shard !== 'strict') throw new Error('shard must be strict');
        return parsed;
      },
    }),
    error => error.code === 'LADDER_BASELINE_MISS' && /shard must be strict/u.test(error.message),
  );
  assert.equal(calls.length, 0, 'a rejected stored answer is never re-asked live');
  assert.equal(replay.stats.baselineMisses, 1);
  assert.equal(replay.stats.baselineReplayed, 0);
  assert.equal(replay.stats.baselineValid, 0);
});

test('--only-records limits the ladder cells to the listed recordIds while every pipeline call still runs', async () => {
  const outDir = tempDir('only-record-ids');
  const calls = [];
  const capture = createCaptureCallText({
    runStage: async args => {
      calls.push(args);
      return { text: SHARD_OK, model: args.model, durationMs: 2, costUsd: 0.01 };
    },
    profileFor: SONNET_PROFILE, ladderTasks: ['career-profile-compile'], configs: parseConfigs('opus:high'), reps: 1,
    outDir, onlyRecords: 'career-profile-compile:2', stageContext: fakeStageContext(),
  });
  await capture.callText('PAGE ONE', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });
  await capture.callText('PAGE TWO', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });
  assert.equal(calls.length, 3, 'both baselines run, plus one ladder cell');
  const ladder = calls.filter(call => call.model === 'opus');
  assert.equal(ladder.length, 1, 'only recordId 2 climbs the ladder');
  assert.equal(ladder[0].text, calls[1].text, 'the ladder cell belongs to the second pipeline call');
  assert.equal(capture.stats.baselineCalls, 2);
  const rows = readLines(path.join(outDir, 'results.jsonl'));
  assert.deepEqual(rows.map(row => row.recordId), ['career-profile-compile:2']);
  assert.match(rows[0].key, /^[0-9a-f]{64}$/u, 'every results row carries the sha256 key');
});

test('--only-records accepts a sha256 key prefix of at least 12 hex chars and the key survives a second run', async () => {
  const firstDir = tempDir('only-prefix-source');
  const first = createCaptureCallText({
    runStage: async args => ({ text: SHARD_OK, model: args.model, durationMs: 2, costUsd: 0.01 }),
    profileFor: SONNET_PROFILE, ladderTasks: ['career-profile-compile'], configs: parseConfigs('opus:high'), reps: 1,
    outDir: firstDir, stageContext: fakeStageContext(),
  });
  await first.callText('PAGE ONE', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });
  await first.callText('PAGE TWO', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });
  const firstRows = readLines(path.join(firstDir, 'results.jsonl'));
  const target = firstRows.find(row => row.recordId === 'career-profile-compile:1');
  assert.equal(target.key, sha256Hex(readLines(path.join(firstDir, 'baseline.jsonl'))[0].text, ''), 'the results key is the baseline key');

  const secondDir = tempDir('only-prefix-target');
  const calls = [];
  const second = createCaptureCallText({
    runStage: async args => {
      calls.push(args);
      return { text: SHARD_OK, model: args.model, durationMs: 2, costUsd: 0.01 };
    },
    profileFor: SONNET_PROFILE, ladderTasks: ['career-profile-compile'], configs: parseConfigs('opus:high'), reps: 1,
    outDir: secondDir, onlyRecords: target.key.slice(0, 12), stageContext: fakeStageContext(),
  });
  await second.callText('PAGE ONE', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });
  await second.callText('PAGE TWO', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });
  const ladder = calls.filter(call => call.model === 'opus');
  assert.equal(ladder.length, 1, 'only the call whose key matches the prefix climbs the ladder');
  assert.equal(ladder[0].text, calls[0].text);
  const secondRows = readLines(path.join(secondDir, 'results.jsonl'));
  assert.deepEqual(secondRows.map(row => row.recordId), ['career-profile-compile:1']);
  assert.equal(secondRows[0].key, target.key, 'recordIds are positional but the key is stable across runs');
});

test('an explicitly empty --ladder-tasks runs no ladder cells while an absent flag keeps the default tasks', async () => {
  assert.deepEqual(ladderTasksFrom(''), [], 'an explicitly empty value ladders nothing');
  assert.deepEqual(ladderTasksFrom(' , '), []);
  assert.deepEqual(ladderTasksFrom(undefined), [...DEFAULT_LADDER_TASKS], 'an absent flag keeps the defaults');
  assert.deepEqual(ladderTasksFrom(null), [...DEFAULT_LADDER_TASKS]);
  assert.deepEqual(ladderTasksFrom('career-profile-compile, career-profile-audit-skills'),
    ['career-profile-compile', 'career-profile-audit-skills']);

  const empty = parseLadderArgs(['capture-career', '--source', 's.md', '--out', 'o', '--configs', 'opus:high', '--ladder-tasks', '']);
  assert.equal(empty.opts.ladderTasks, '');
  assert.deepEqual(ladderTasksFrom(empty.opts.ladderTasks), []);
  const absent = parseLadderArgs(['capture-career', '--source', 's.md', '--out', 'o', '--configs', 'opus:high']);
  assert.deepEqual(ladderTasksFrom(absent.opts.ladderTasks), [...DEFAULT_LADDER_TASKS]);

  const outDir = tempDir('empty-ladder-tasks');
  const calls = [];
  const capture = createCaptureCallText({
    runStage: async args => {
      calls.push(args);
      return { text: SHARD_OK, model: args.model, durationMs: 1, costUsd: 0.01 };
    },
    profileFor: SONNET_PROFILE, ladderTasks: ladderTasksFrom(''), configs: parseConfigs('opus:high,sonnet:low'), reps: 2,
    outDir, stageContext: fakeStageContext(),
  });
  await capture.callText('COMPILE THIS PAGE', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });
  assert.equal(calls.length, 1, 'only the baseline is captured');
  assert.equal(capture.stats.ladderCalls, 0);
  assert.equal(fs.existsSync(path.join(outDir, 'results.jsonl')), false, 'no ladder rows are written');
  assert.equal(readLines(path.join(outDir, 'baseline.jsonl')).length, 1);
});

test('parseLadderArgs passes --baseline-from and --only-records through and parseOnlyRecords splits ids from key prefixes', () => {
  const parsed = parseLadderArgs(['capture-career', '--source', 's.md', '--out', 'o', '--configs', 'opus:high',
    '--baseline-from', '/tmp/previous-capture', '--only-records', 'career-profile-compile:1,abcdef0123456789']);
  assert.equal(parsed.opts.baselineFrom, '/tmp/previous-capture');
  assert.equal(parsed.opts.onlyRecords, 'career-profile-compile:1,abcdef0123456789');
  assert.deepEqual(parseOnlyRecords(parsed.opts.onlyRecords), {
    ids: ['career-profile-compile:1'], prefixes: ['abcdef0123456789'],
  });
  assert.deepEqual(parseOnlyRecords('ABCDEF012345'), { ids: [], prefixes: ['abcdef012345'] }, 'prefixes match case-insensitively');
  assert.throws(() => parseOnlyRecords('abcdef01234'), /neither a recordId/u, 'a key prefix shorter than 12 hex chars is refused');
  assert.throws(() => parseOnlyRecords(''), /lists no recordIds/u);
  assert.throws(() => parseOnlyRecords(' , '), /lists no recordIds/u);
});

// ---- --max-repairs and --live-on-miss --------------------------------------

const strictShard = parsed => {
  if (parsed.shard !== 'strict') throw new Error('shard must be strict');
  return parsed;
};

test('--max-repairs 4 allows four corrections while the default stays at two', async () => {
  const answers = ['{"shard":"loose"}', '{"shard":"loose"}', '{"shard":"loose"}', '{"shard":"loose"}', '{"shard":"strict"}'];
  const calls = [];
  const four = createCaptureCallText({
    runStage: async args => {
      calls.push(args);
      return { text: answers[calls.length - 1] ?? '{"shard":"loose"}', model: args.model, costUsd: 0.01 };
    },
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: tempDir('max-repairs-four'), maxRepairs: 4, stageContext: fakeStageContext(),
  });
  assert.deepEqual(await four.callText('COMPILE THIS PAGE', {
    task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: strictShard,
  }), { shard: 'strict' }, 'the fifth attempt is accepted after four corrections');
  assert.equal(calls.length, 5, 'one first answer plus four corrections');
  assert.equal(four.stats.retries, 4);
  assert.equal(four.stats.baselineCalls, 1, 'corrections are part of the same baseline call');
  const [fixedRow] = readLines(four.baselineFile);
  assert.equal(fixedRow.attempts, 5);
  assert.equal(fixedRow.valid, true);

  const defaultCalls = [];
  const fallback = createCaptureCallText({
    runStage: async args => {
      defaultCalls.push(args);
      return { text: '{"shard":"loose"}', model: args.model };
    },
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: tempDir('max-repairs-default'), stageContext: fakeStageContext(),
  });
  await assert.rejects(
    () => fallback.callText('COMPILE THIS PAGE', {
      task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: strictShard,
    }),
    /shard must be strict/u,
  );
  assert.equal(defaultCalls.length, 3, 'the default is one answer plus two corrections');
  assert.equal(fallback.stats.retries, 2);
});

test('--live-on-miss answers a missing key live with the production profile and counts it in stats.baselineLive', async () => {
  const sourceDir = tempDir('live-miss-source');
  const source = createCaptureCallText({
    runStage: async args => ({ text: '{"shard":"other"}', model: args.model, durationMs: 1, costUsd: 0.01 }),
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: sourceDir, stageContext: fakeStageContext(),
  });
  await source.callText('A DIFFERENT PAGE', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });

  const liveDir = tempDir('live-miss-target');
  const calls = [];
  const live = createCaptureCallText({
    runStage: async args => { calls.push(args); return { text: SHARD_OK, model: args.model, durationMs: 2, costUsd: 0.02 }; },
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: liveDir, baselineFrom: sourceDir, liveOnMiss: true, stageContext: fakeStageContext(),
  });
  assert.deepEqual(await live.callText('THE PAGE THAT WAS NEVER CAPTURED', {
    task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept,
  }), { shard: 'ok' }, 'the miss is answered live');
  assert.equal(calls.length, 1, 'exactly one live baseline call answers the miss');
  assert.equal(calls[0].model, 'sonnet', 'the live fallback uses the production model');
  assert.equal(calls[0].effort, 'medium', 'the live fallback uses the production effort');
  assert.equal(live.stats.baselineLive, 1, 'the live fallback is counted separately');
  assert.equal(live.stats.baselineMisses, 0, 'an answered miss is not a miss');
  assert.equal(live.stats.baselineReplayed, 0);
  assert.equal(live.stats.baselineValid, 1);
  assert.equal(live.stats.baselineCostUsd, 0.02, 'the live fallback is real spend');
  const [row] = readLines(live.baselineFile);
  assert.equal(row.recordId, 'career-profile-compile:1');
  assert.equal(row.answer, SHARD_OK);
  assert.equal(row.valid, true);
  assert.equal(row.attempts, 1);
  assert.equal(row.costUsd, 0.02);
  assert.equal(row.replayed, undefined, 'a live fallback is a real row, not a replay');

  const offDir = tempDir('live-miss-off');
  const offCalls = [];
  const off = createCaptureCallText({
    runStage: async args => { offCalls.push(args); return { text: SHARD_OK, model: args.model, costUsd: 0.02 }; },
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: offDir, baselineFrom: sourceDir, stageContext: fakeStageContext(),
  });
  await assert.rejects(
    () => off.callText('THE PAGE THAT WAS NEVER CAPTURED', {
      task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept,
    }),
    error => error.code === 'LADDER_BASELINE_MISS',
  );
  assert.equal(offCalls.length, 0, 'without the flag a miss never runs live');
  assert.equal(off.stats.baselineLive, 0);
  assert.equal(off.stats.baselineMisses, 1);
  assert.equal(readLines(off.baselineFile).length, 0, 'a refused miss writes no baseline row');
});

test('--live-on-miss answers a stored valid:false row live while a stored valid answer is still replayed', async () => {
  const invalidSource = tempDir('live-invalid-source');
  const invalidSourceCall = createCaptureCallText({
    runStage: async args => ({ text: '{"shard":"loose"}', model: args.model, durationMs: 1, costUsd: 0.01 }),
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: invalidSource, stageContext: fakeStageContext(),
  });
  await assert.rejects(
    () => invalidSourceCall.callText('COMPILE THIS PAGE', {
      task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: strictShard,
    }),
    /shard must be strict/u,
  );
  const [storedInvalid] = readLines(invalidSourceCall.baselineFile);
  assert.equal(storedInvalid.valid, false, 'the source row is stored as valid:false');

  const invalidTargetDir = tempDir('live-invalid-target');
  const invalidCalls = [];
  const invalidTarget = createCaptureCallText({
    runStage: async args => { invalidCalls.push(args); return { text: '{"shard":"strict"}', model: args.model, costUsd: 0.03 }; },
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: invalidTargetDir, baselineFrom: invalidSource, liveOnMiss: true, stageContext: fakeStageContext(),
  });
  assert.deepEqual(await invalidTarget.callText('COMPILE THIS PAGE', {
    task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: strictShard,
  }), { shard: 'strict' }, 'the valid:false row is answered live');
  assert.equal(invalidCalls.length, 1);
  assert.equal(invalidTarget.stats.baselineLive, 1);
  assert.equal(invalidTarget.stats.baselineReplayed, 0, 'a valid:false row is never replayed');
  assert.equal(readLines(invalidTarget.baselineFile)[0].valid, true);

  const validSource = tempDir('live-valid-source');
  const validSourceCall = createCaptureCallText({
    runStage: async args => ({ text: SHARD_OK, model: args.model, durationMs: 1, costUsd: 0.01 }),
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: validSource, stageContext: fakeStageContext(),
  });
  await validSourceCall.callText('COMPILE THIS PAGE', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });

  const replayDir = tempDir('live-valid-target');
  const replayCalls = [];
  const replay = createCaptureCallText({
    runStage: async args => { replayCalls.push(args); return { text: SHARD_OK, model: args.model }; },
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: replayDir, baselineFrom: validSource, liveOnMiss: true, stageContext: fakeStageContext(),
  });
  assert.deepEqual(await replay.callText('COMPILE THIS PAGE', {
    task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept,
  }), { shard: 'ok' });
  assert.equal(replayCalls.length, 0, 'a stored valid answer is replayed with no runStage call');
  assert.equal(replay.stats.baselineReplayed, 1);
  assert.equal(replay.stats.baselineLive, 0);
  const [replayedRow] = readLines(replay.baselineFile);
  assert.equal(replayedRow.replayed, true);
  assert.equal(replayedRow.costUsd, 0);

  const rejectedDir = tempDir('live-rejected-target');
  const rejectedCalls = [];
  const rejected = createCaptureCallText({
    runStage: async args => { rejectedCalls.push(args); return { text: '{"shard":"strict"}', model: args.model, costUsd: 0.04 }; },
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: rejectedDir, baselineFrom: validSource, liveOnMiss: true, stageContext: fakeStageContext(),
  });
  assert.deepEqual(await rejected.callText('COMPILE THIS PAGE', {
    task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: strictShard,
  }), { shard: 'strict' }, 'a stored answer the live validator rejects is answered live');
  assert.equal(rejectedCalls.length, 1);
  assert.equal(rejected.stats.baselineLive, 1);
  assert.equal(rejected.stats.baselineReplayed, 0);
});

test('parseLadderArgs reads --live-on-miss as a value-less flag while every other flag still needs a value', () => {
  const bare = parseLadderArgs(['capture-career', '--source', 's.md', '--out', 'o', '--configs', 'opus:high', '--live-on-miss']);
  assert.equal(bare.opts.liveOnMiss, true, 'the flag parses as true');
  assert.equal(bare.opts.source, 's.md');
  assert.equal(bare.opts.configs, 'opus:high');

  const mixed = parseLadderArgs(['capture-career', '--live-on-miss', '--source', 's.md', '--max-repairs', '4', '--out', 'o']);
  assert.equal(mixed.opts.liveOnMiss, true, 'the value-less flag consumes no argv slot');
  assert.equal(mixed.opts.source, 's.md', 'the next argv item is still a flag');
  assert.equal(mixed.opts.out, 'o');
  assert.equal(mixed.opts.maxRepairs, '4', '--max-repairs takes a value');
  assert.equal(parseLadderArgs(['capture-career', '--source', 's.md']).opts.liveOnMiss, undefined, 'the flag is absent by default');

  assert.throws(() => parseLadderArgs(['capture-career', '--max-repairs']), /--max-repairs needs a value/u);
  assert.throws(() => parseLadderArgs(['capture-career', '--live-on-miss', 'true']), /Unknown argument true/u);
  assert.throws(() => parseLadderArgs(['capture-career', '--source']), /--source needs a value/u);
});

// ---- --profile-override and an uncapped --max-calls ------------------------

test('a --profile-override task is answered live at the override even when a stored baseline row exists', async () => {
  const sourceDir = tempDir('override-source');
  const source = createCaptureCallText({
    runStage: async args => ({ text: SHARD_OK, model: args.model, durationMs: 1, costUsd: 0.01 }),
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: sourceDir, stageContext: fakeStageContext(),
  });
  await source.callText('AUDIT THIS PAGE', { task: 'career-profile-audit-skills', responseSchema: SHARD_SCHEMA, responseValidator: accept });
  await source.callText('COMPILE THIS PAGE', { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });
  assert.equal(readLines(path.join(sourceDir, 'baseline.jsonl')).length, 2, 'both tasks have a stored baseline row');

  const overrides = new Map([['career-profile-audit-skills', { model: 'opus', effort: 'xhigh' }]]);
  const targetDir = tempDir('override-target');
  const calls = [];
  const target = createCaptureCallText({
    runStage: async args => {
      calls.push({ model: args.model, effort: args.effort });
      return { text: SHARD_OK, model: args.model, durationMs: 2, costUsd: 0.05 };
    },
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir: targetDir, baselineFrom: sourceDir, overrides, stageContext: fakeStageContext(),
  });
  assert.deepEqual(await target.callText('AUDIT THIS PAGE', {
    task: 'career-profile-audit-skills', responseSchema: SHARD_SCHEMA, responseValidator: accept,
  }), { shard: 'ok' });
  assert.equal(calls.length, 1, 'the stored audit answer is never replayed');
  assert.equal(calls[0].model, 'opus', 'the override model answers the call');
  assert.equal(calls[0].effort, 'xhigh', 'the override effort answers the call');
  assert.equal(target.stats.baselineReplayed, 0);
  assert.equal(target.stats.baselineOverrideLive, 1);
  assert.equal(target.stats.baselineLive, 0, 'an override is not a miss fallback');
  assert.equal(target.stats.baselineCostUsd, 0.05, 'the live override is real spend');
  const auditRow = readLines(target.baselineFile).find(row => row.task === 'career-profile-audit-skills');
  assert.equal(auditRow.replayed, undefined, 'the override row is a live row, not a replay');
  assert.equal(auditRow.model, 'opus', 'the baseline row records the override model');
  assert.equal(auditRow.effort, 'xhigh', 'the baseline row records the override effort');
  assert.equal(auditRow.costUsd, 0.05, 'the baseline row records the real cost');
  assert.equal(auditRow.answer, SHARD_OK);

  // The non-overridden task keeps its production profile and still replays.
  assert.deepEqual(await target.callText('COMPILE THIS PAGE', {
    task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept,
  }), { shard: 'ok' });
  assert.equal(calls.length, 1, 'the replay adds no live call');
  assert.equal(target.stats.baselineReplayed, 1);
  const compileRow = readLines(target.baselineFile).find(row => row.task === 'career-profile-compile');
  assert.equal(compileRow.replayed, true, 'the non-overridden task still replays');
  assert.equal(compileRow.costUsd, 0);
  assert.equal(compileRow.model, 'sonnet', 'the replay keeps the production model');
  assert.equal(compileRow.effort, 'medium', 'the replay keeps the production effort');

  assert.deepEqual([...parseProfileOverrides(['career-profile-audit-skills=opus:xhigh']).entries()],
    [...overrides.entries()], 'the CLI string form parses into the same Map the option accepts');
});

test('parseLadderArgs collects repeated --profile-override values and rejects malformed ones', () => {
  const parsed = parseLadderArgs([
    'capture-career', '--source', 's.md', '--out', 'o',
    '--profile-override', 'career-profile-audit-skills=opus:xhigh',
    '--profile-override', 'career-profile-compile=sonnet:low',
  ]);
  assert.deepEqual(parsed.opts.profileOverrides,
    ['career-profile-audit-skills=opus:xhigh', 'career-profile-compile=sonnet:low'], 'the flag repeats into an array');
  assert.equal(parsed.opts.source, 's.md');
  assert.equal(parsed.opts.out, 'o');
  assert.deepEqual(parseLadderArgs(['capture-career', '--profile-override', 'a1=haiku:low']).opts.profileOverrides,
    ['a1=haiku:low'], 'a single override is still an array');
  assert.equal(parseLadderArgs(['capture-career']).opts.profileOverrides, undefined, 'the flag is absent by default');

  assert.throws(() => parseLadderArgs(['capture-career', '--profile-override']), /--profile-override needs a value/u);
  assert.throws(() => parseLadderArgs(['capture-career', '--profile-override', 'career-profile-compile']),
    /expected <task>=<model>:<effort>/u);
  assert.throws(() => parseLadderArgs(['capture-career', '--profile-override', 'career-profile-compile=opus']),
    /expected <model>:<effort>/u);
  assert.throws(() => parseLadderArgs(['capture-career', '--profile-override', 'career-profile-compile=fable:high']),
    /Unknown ladder model fable/u);
  assert.throws(() => parseLadderArgs(['capture-career', '--profile-override', 'career-profile-compile=opus:max']),
    /Unknown ladder effort max/u);
  assert.throws(() => parseLadderArgs(['capture-career', '--profile-override', 'Career=opus:high']),
    /Unknown profile override task/u);

  assert.deepEqual([...parseProfileOverrides(['a1=haiku:low', 'b2=opus:xhigh']).entries()],
    [['a1', { model: 'haiku', effort: 'low' }], ['b2', { model: 'opus', effort: 'xhigh' }]]);
  assert.deepEqual([...parseProfileOverrides({ a1: { model: 'opus', effort: 'high' } }).entries()],
    [['a1', { model: 'opus', effort: 'high' }]], 'the object form is accepted');
  assert.equal(parseProfileOverrides(null).size, 0, 'no overrides means an empty Map');
  assert.throws(() => parseProfileOverrides('career-profile-compile'), /expected <task>=<model>:<effort>/u,
    'a value with no "=" throws');
  assert.throws(() => parseProfileOverrides('career-profile-compile=opus:high,opus:low'), /exactly one/u,
    'a value naming two ladder configs throws');
  assert.throws(() => parseProfileOverrides('career-profile-compile=opus:high:extra'), /expected <model>:<effort>/u);
  assert.throws(() => parseProfileOverrides({ 'Bad Task': { model: 'opus', effort: 'high' } }), /Unknown profile override task/u);
});

test('createCaptureCallText treats --max-calls 0 as no cap at all', async () => {
  const outDir = tempDir('capture-no-cap');
  const calls = [];
  const capture = createCaptureCallText({
    runStage: async args => { calls.push(args); return { text: SHARD_OK, model: args.model, costUsd: 0.01 }; },
    profileFor: SONNET_PROFILE, ladderTasks: [], configs: parseConfigs('opus:high'), reps: 1,
    outDir, maxCalls: 0, stageContext: fakeStageContext(),
  });
  for (let index = 0; index < 6; index += 1) {
    await capture.callText(`PAGE NUMBER ${index}`, { task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept });
  }
  assert.equal(calls.length, 6, 'a zero cap stops nothing');
  assert.equal(capture.stats.baselineCalls, 6);
  assert.equal(readLines(capture.baselineFile).length, 6, 'every uncapped call writes its baseline row');

  assert.throws(() => createCaptureCallText({
    runStage: async () => ({ text: SHARD_OK }), profileFor: SONNET_PROFILE, ladderTasks: [],
    configs: parseConfigs('opus:high'), reps: 1, outDir: tempDir('capture-bad-cap'), maxCalls: -1,
    stageContext: fakeStageContext(),
  }), /--max-calls must be a non-negative integer/u, 'a negative cap is still rejected');
});

function careerCompileFor({ snapshot = null, failure = null } = {}) {
  return async ({ callText }) => {
    await callText(PROMPT_SENTINEL, {
      task: 'career-profile-audit-skills', responseSchema: SHARD_SCHEMA, responseValidator: accept,
    });
    await callText('COMPILE PAGE TEXT', {
      task: 'career-profile-compile', responseSchema: SHARD_SCHEMA, responseValidator: accept,
    });
    if (failure) throw failure;
    return snapshot;
  };
}

function careerSourceFile(prefix) {
  const file = path.join(tempDir(prefix), 'career.md');
  fs.writeFileSync(file, '# Career source\n', { mode: 0o600 });
  return file;
}

test('capture-career prints per-task counts and costs, the total, rounds reached and approval', async () => {
  const runCareer = async (prefix, extra) => {
    const lines = [];
    const calls = [];
    const code = await captureCareerCommand({
      source: careerSourceFile(`${prefix}-source`), out: tempDir(prefix),
      configs: 'opus:high', ladderTasks: '', maxCalls: '0', ...extra,
    }, {
      compile: careerCompileFor({ snapshot: { auditHistory: [{ kind: 'folded', roundCount: 3 }, { kind: 'detailed' }] } }),
      say: line => lines.push(line),
      stageContext: fakeStageContext(),
      runStage: async args => {
        calls.push({ model: args.model, effort: args.effort });
        return { text: SHARD_OK, model: args.model, costUsd: 0.02, durationMs: 1 };
      },
    });
    return { code, output: lines.join('\n'), calls };
  };
  // The production profiles come from the real app; the override run must keep them
  // for every task except the overridden one.
  const production = await runCareer('career-production', {});
  const overridden = await runCareer('career-report', {
    profileOverrides: ['career-profile-audit-skills=haiku:low'],
  });
  assert.equal(overridden.code, 0);
  const output = overridden.output;
  const profileOf = call => `${call.model}:${call.effort}`;
  assert.equal(overridden.calls.length, 2, 'both tasks are answered once and no ladder cell runs');
  assert.equal(profileOf(overridden.calls[0]), 'haiku:low', 'the overridden task answers at the override profile');
  assert.notEqual(profileOf(production.calls[0]), 'haiku:low', 'the override differs from the production profile');
  assert.equal(profileOf(overridden.calls[1]), profileOf(production.calls[1]),
    'the other task keeps its production profile');
  assert.ok(output.includes('career-profile-audit-skills\tcalls=1\treplayed=0\tcost=$0.0200'), output);
  assert.ok(output.includes('career-profile-compile\tcalls=1\treplayed=0\tcost=$0.0200'), output);
  assert.ok(output.includes('total cost: $0.0400'), output);
  assert.ok(output.includes('rounds reached: 4'), `folded roundCount 3 plus one detailed round: ${output}`);
  assert.ok(output.includes('outcome: approved'), output);
  assert.equal(auditRoundCount({ auditHistory: [{ kind: 'folded', roundCount: 2 }, { kind: 'detailed' }, { kind: 'detailed' }] }), 4);
  assert.equal(auditRoundCount({}), null, 'no auditHistory means no round line');
  assert.ok(!output.includes(PROMPT_SENTINEL), 'no prompt text reaches stdout');
  assert.ok(!output.includes(SHARD_OK), 'no answer text reaches stdout');
});

test('capture-career prints the thrown error code only, never the error text', async () => {
  const lines = [];
  const failure = new Error(`rejected answer ${ANSWER_SENTINEL}`);
  failure.code = 'E_CAREER_REJECTED';
  await assert.rejects(() => captureCareerCommand({
    source: careerSourceFile('career-threw-source'), out: tempDir('career-threw'),
    configs: 'opus:high', ladderTasks: '', maxCalls: '0',
  }, {
    compile: careerCompileFor({ failure }),
    say: line => lines.push(line),
    stageContext: fakeStageContext(),
    runStage: async args => ({ text: SHARD_OK, model: args.model, costUsd: 0.01, durationMs: 1 }),
  }), error => error === failure, 'the compile error is rethrown after the report');
  const output = lines.join('\n');
  assert.ok(output.includes('outcome: threw E_CAREER_REJECTED'), output);
  assert.ok(!output.includes('rounds reached'), 'a throw returns no snapshot');
  assert.ok(!output.includes(ANSWER_SENTINEL), 'no error or answer text reaches stdout');
});

// ---- Generic stage capture and pick validation ------------------------------

const PICK_PROMPT = [
  'RANK THE ACCEPTED CANDIDATES',
  'Order every candidate of this round from strongest to weakest.',
  '',
  'CANDIDATES:',
  'candidate-1:',
  'WRITER TEXT:',
  'Dear hiring manager, I led the migration.',
  'candidate-2:',
  'WRITER TEXT:',
  'Hello team, the migration shipped.',
  '',
  'Echo the APPLICATION V2 HANDOFF fields at the top level.',
].join('\n');

function pickAnswer(order = ['candidate-1', 'candidate-2']) {
  return JSON.stringify({ ranking: order.map(id => ({ id, reason: `Place for ${id} because it is strongest there.` })) });
}

function stageRun(runId, jobId, at, {
  stage = 'judge-fit', resume = false, prompt = PICK_PROMPT, answer = pickAnswer(),
  accepted = true, validationErrors = [], costUsd, submission = true,
} = {}) {
  const started = { event: 'started', stage, runId, jobId, resume, requestedModel: 'sonnet', requestedEffort: 'high', prompt, at };
  const response = { event: 'response', stage, runId, answer, model: 'sonnet', durationMs: 500 + at, ...(costUsd === undefined ? {} : { costUsd }) };
  if (!submission) return [started, response];
  return [started, response, { event: 'submission', stage, runId, submit: { accepted, validationErrors } }];
}

test('pickCandidateIdsFromPrompt reads the candidate ids the judge prompt printed', () => {
  assert.deepEqual(pickCandidateIdsFromPrompt(PICK_PROMPT), ['candidate-1', 'candidate-2']);
  assert.throws(() => pickCandidateIdsFromPrompt('CANDIDATES:\nnothing else'), /at least one candidate id/u);
  assert.throws(() => pickCandidateIdsFromPrompt('no candidates section'), /one CANDIDATES section/u);
});

test('validatePickRanking accepts a well-formed ranking and rejects malformed ones', async () => {
  const verify = await import('../electron/ipc/applicationWriteVerify.js');
  assert.deepEqual(validatePickRanking(verify, PICK_PROMPT, pickAnswer(['candidate-2', 'candidate-1'])), ['candidate-2', 'candidate-1']);
  const fenced = `\`\`\`json\n${pickAnswer()}\n\`\`\``;
  assert.deepEqual(validatePickRanking(verify, PICK_PROMPT, fenced), ['candidate-1', 'candidate-2']);
  // A dropped candidate breaks the set rule the app enforces.
  assert.throws(() => validatePickRanking(verify, PICK_PROMPT, pickAnswer(['candidate-1'])), /judge-ranking-set: The ranking lists 1 places for 2 candidates; missing candidate-2/u);
  // An id the prompt never printed is not a candidate of the round.
  assert.throws(() => validatePickRanking(verify, PICK_PROMPT, pickAnswer(['candidate-9', 'candidate-1'])), /not candidates of this round "candidate-9"/u);
  // A place without a reason is rejected the same way the app rejects it.
  assert.throws(() => validatePickRanking(verify, PICK_PROMPT, JSON.stringify({ ranking: [{ id: 'candidate-1', reason: 'ok' }, { id: 'candidate-2' }] })), /judge-ranking-reason: place 2 \("candidate-2"\) has no reason/u);
  assert.throws(() => validatePickRanking(verify, PICK_PROMPT, 'not json at all'), /pick-ranking-shape: the judge reply is not JSON/u);
});

test('pickTopCandidateId reads the top place of a judge answer and tolerates junk', () => {
  assert.equal(pickTopCandidateId(pickAnswer(['candidate-2', 'candidate-1'])), 'candidate-2');
  assert.equal(pickTopCandidateId('not json'), null);
});

test('captureStageRecords pairs started, response and submission by runId and drops resume starts', () => {
  const runsDir = tempDir('runs-stage-pair');
  writeLines(path.join(runsDir, 'run.jsonl'), [
    ...stageRun('run-a-111111', 'job-a', 1000, { costUsd: 0.03 }),
    ...stageRun('run-b-222222', 'job-b', 2000, { resume: true, prompt: 'CORRECTION ONLY', accepted: false }),
    ...stageRun('run-c-333333', 'job-c', 3000, { accepted: false, validationErrors: ['e1', 'e2'] }),
    ...stageRun('run-d-444444', 'job-d', 4000, { stage: 'editorial-plan', prompt: PLANNER_PROMPT }),
    ...stageRun('run-f-666666', 'job-f', 6000, { submission: false }),
    { event: 'started', stage: 'judge-fit', runId: 'run-e-555555', jobId: 'job-e', resume: false, requestedModel: 'sonnet', requestedEffort: 'high', prompt: PICK_PROMPT, at: 5000 },
  ]);
  const { records, stats } = captureStageRecords(runsDir, { stage: 'judge-fit', limit: 6 });
  assert.deepEqual(records.map(record => record.id), [
    'judge-fit:job-a:run-a-11', 'judge-fit:job-c:run-c-33', 'judge-fit:job-f:run-f-66',
  ]);
  assert.equal(stats.resumedStarts, 1);
  assert.equal(stats.unpaired, 1);
  assert.equal(stats.submitted, 2);
  assert.equal(stats.rejected, 1);
  assert.equal(stats.validationErrors, 2);
  const [acceptedRecord, rejected, unsubmitted] = records;
  assert.equal(acceptedRecord.task, 'judge-fit');
  assert.equal(acceptedRecord.text, PICK_PROMPT);
  assert.equal(acceptedRecord.systemAppend, '');
  assert.equal(acceptedRecord.responseSchema, null);
  assert.deepEqual(acceptedRecord.baseline, {
    text: pickAnswer(), model: 'sonnet', effort: 'high', costUsd: 0.03, durationMs: 1500, accepted: true,
  });
  assert.equal(rejected.baseline.accepted, false);
  assert.equal(rejected.baseline.costUsd, null);
  assert.equal(unsubmitted.baseline.accepted, null, 'no submission event leaves the verdict unknown');
});

test('captureStageRecords keeps the newest run per jobId, the newest N jobs and only accepted ones when asked', () => {
  const runsDir = tempDir('runs-stage-newest');
  writeLines(path.join(runsDir, 'a.jsonl'), [
    ...stageRun('run-oldb-0001', 'job-b', 1000),
    ...stageRun('run-newb-0002', 'job-b', 5000, { answer: pickAnswer(['candidate-2', 'candidate-1']) }),
    ...stageRun('run-c1--0003', 'job-c1', 2000),
  ]);
  writeLines(path.join(runsDir, 'b.jsonl'), [
    ...stageRun('run-c2--0004', 'job-c2', 3000),
    ...stageRun('run-c3--0005', 'job-c3', 4000, { accepted: false }),
  ]);
  const { records } = captureStageRecords(runsDir, { stage: 'judge-fit', limit: 2 });
  assert.deepEqual(records.map(record => record.id), ['judge-fit:job-c3:run-c3--', 'judge-fit:job-b:run-newb']);
  assert.equal(records[1].baseline.text, pickAnswer(['candidate-2', 'candidate-1']), 'the newest run for a jobId wins');
  const all = captureStageRecords(runsDir, { stage: 'judge-fit', limit: 6 });
  assert.equal(all.records.length, 4);
  const acceptedOnly = captureStageRecords(runsDir, { stage: 'judge-fit', acceptedOnly: true });
  assert.deepEqual(acceptedOnly.records.map(record => record.id), [
    'judge-fit:job-c1:run-c1--', 'judge-fit:job-c2:run-c2--', 'judge-fit:job-b:run-newb',
  ]);
  assert.equal(acceptedOnly.stats.notAccepted, 1);
  assert.throws(() => captureStageRecords(runsDir, { stage: 'Judge Fit' }), /lowercase stage name/u);
  assert.throws(() => captureStageRecords(runsDir, { stage: 'judge-fit', limit: 0 }), /positive integer/u);
});

test('capture-stage writes owner-only records outside the repository and honors --accepted-only', async () => {
  const runsDir = tempDir('runs-stage-cli');
  writeLines(path.join(runsDir, 'run.jsonl'), [
    ...stageRun('run-a-111111', 'job-a', 1000, { costUsd: 0.02 }),
    ...stageRun('run-b-222222', 'job-b', 2000, { accepted: false, validationErrors: ['bad'] }),
  ]);
  const outDir = tempDir('stage-out');
  const out = path.join(outDir, 'pick-records.jsonl');
  assert.equal(await main(['capture-stage', '--runs-dir', runsDir, '--stage', 'judge-fit', '--out', out, '--limit', '3']), 0);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const written = readLines(out);
  assert.deepEqual(written.map(record => record.id), ['judge-fit:job-a:run-a-11', 'judge-fit:job-b:run-b-22']);
  assert.equal(written[1].baseline.accepted, false);
  const acceptedOut = path.join(outDir, 'accepted-records.jsonl');
  assert.equal(await main(['capture-stage', '--runs-dir', runsDir, '--stage', 'judge-fit', '--out', acceptedOut, '--accepted-only']), 0);
  const acceptedWritten = readLines(acceptedOut);
  assert.deepEqual(acceptedWritten.map(record => record.id), ['judge-fit:job-a:run-a-11']);
  assert.equal(acceptedWritten[0].baseline.accepted, true);
  await assert.rejects(
    () => main(['capture-stage', '--runs-dir', runsDir, '--out', path.join(outDir, 'x.jsonl')]),
    /--stage <name> is required/u,
  );
});

test('compareResults reports per-config top-1 agreement for pick and only validity and cost elsewhere', () => {
  const records = [
    { id: 'pick:job-a:run-a-11', task: 'pick', baseline: { text: pickAnswer(['candidate-1', 'candidate-2']) } },
    { id: 'pick:job-b:run-b-22', task: 'pick', baseline: { text: pickAnswer(['candidate-2', 'candidate-1']) } },
    { id: 'editorial-plan:job-c', task: 'editorial-plan', baseline: { text: planAnswer() } },
  ];
  const rows = [
    { recordId: 'pick:job-a:run-a-11', task: 'pick', config: 'opus:high', valid: true, costUsd: 0.4, text: pickAnswer(['candidate-1', 'candidate-2']) },
    { recordId: 'pick:job-b:run-b-22', task: 'pick', config: 'opus:high', valid: true, costUsd: 0.2, text: pickAnswer(['candidate-2', 'candidate-1']) },
    { recordId: 'pick:job-a:run-a-11', task: 'pick', config: 'sonnet:low', valid: true, costUsd: 0.1, text: pickAnswer(['candidate-2', 'candidate-1']) },
    { recordId: 'pick:job-b:run-b-22', task: 'pick', config: 'sonnet:low', valid: false, costUsd: 0.1, text: pickAnswer(['candidate-1', 'candidate-2']) },
    { recordId: 'pick:job-a:run-a-11', task: 'pick', config: 'haiku:low', valid: false, costUsd: 0.05, text: 'not json' },
    { recordId: 'editorial-plan:job-c', task: 'editorial-plan', config: 'opus:high', valid: false, costUsd: 1.5, text: 'whatever' },
  ];
  const byKey = new Map(compareResults(rows, records).map(group => [`${group.task}|${group.config}`, group]));
  // Both opus rows pick the baseline's top candidate; both sonnet rows pick the other one.
  assert.deepEqual(byKey.get('pick|opus:high').top1Agreement, { n: 2, agree: 2, rate: 1, unparsed: 0, missingBaseline: 0 });
  assert.deepEqual(byKey.get('pick|sonnet:low').top1Agreement, { n: 2, agree: 0, rate: 0, unparsed: 0, missingBaseline: 0 });
  // An unparseable answer is counted apart instead of silently agreeing.
  assert.deepEqual(byKey.get('pick|haiku:low').top1Agreement, { n: 0, agree: 0, rate: null, unparsed: 1, missingBaseline: 0 });
  assert.equal(byKey.get('pick|sonnet:low').validRate, 0.5);
  assert.equal(byKey.get('pick|opus:high').totalCostUsd, 0.6000000000000001);
  // Other tasks report validity and cost only: no top-1 agreement is invented.
  assert.equal(byKey.get('editorial-plan|opus:high').top1Agreement, null);
  assert.equal(byKey.get('editorial-plan|opus:high').validRate, 0);
  assert.equal(byKey.get('editorial-plan|opus:high').totalCostUsd, 1.5);
  // A row whose record never landed in the capture is reported, not scored.
  const missing = compareResults(
    [{ recordId: 'pick:job-z:run-z-99', task: 'pick', config: 'opus:high', valid: true, costUsd: 0.2, text: pickAnswer() }],
    records,
  );
  assert.deepEqual(missing[0].top1Agreement, { n: 0, agree: 0, rate: null, unparsed: 0, missingBaseline: 1 });
});

test('ladderJournalRows puts validity, failures, cost and pick top-1 agreement in the run log', () => {
  const records = [
    { id: 'pick:a', task: 'pick', baseline: { text: pickAnswer(['candidate-1', 'candidate-2']) } },
    { id: 'pick:b', task: 'pick', baseline: { text: pickAnswer(['candidate-2', 'candidate-1']) } },
  ];
  const rows = [
    { recordId: 'pick:a', task: 'pick', config: 'opus:low', ok: true, valid: true, costUsd: 0.25, text: pickAnswer(['candidate-1', 'candidate-2']) },
    { recordId: 'pick:b', task: 'pick', config: 'opus:low', ok: true, valid: true, costUsd: 0.25, text: pickAnswer(['candidate-1', 'candidate-2']) },
    { recordId: 'pick:a', task: 'pick', config: 'sonnet:high', ok: false, valid: false, costUsd: null, text: '' },
  ];
  const [opus, sonnet] = ladderJournalRows(rows, records);
  assert.deepEqual(opus, { arm: 'pick opus:low', n: 2, valid: 2, failed: 0, costUsd: 0.5, notes: 'top-1 agreement with baseline 1/2 (50%)' });
  assert.equal(sonnet.arm, 'pick sonnet:high');
  assert.equal(sonnet.failed, 1);
  assert.equal(sonnet.notes, 'top-1 agreement with baseline n/a, 1 unparsed');
});

test('runLadder hands the journal every landed row and a final forced update', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-journal-'));
  const updates = [];
  const journal = { update: (patch, opts) => updates.push({ n: patch.rows.reduce((sum, row) => sum + row.n, 0), force: opts?.force === true }) };
  await runLadder({
    records: [{ id: 'r1', task: 'demo', text: 'T1' }, { id: 'r2', task: 'demo', text: 'T2' }],
    configs: 'haiku:low', outDir, concurrency: 1, journal,
    runStage: async () => ({ text: 'ok', costUsd: 0.01 }), validate: async () => {}, stageContext: async () => ({ binary: 'x', env: {}, cwd: outDir }),
  });
  assert.deepEqual(updates.map(update => update.n), [1, 2, 2]);
  assert.equal(updates.at(-1).force, true);
});

// ---- capture-archive: laddering 'pick' offline from the evidence archive ----

const ARCHIVE_PROMPT = 'PICK THIS PAGE: rank the candidate page images exactly once.';
const ARCHIVE_ANSWER = '{"ranking":[{"id":"candidate-1","reason":"the closest fit"}]}';
const ARCHIVE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/ZTKQwAAAABJRU5ErkJggg==';
const ARCHIVE_PAGE_IMAGES = [
  { candidateId: 'candidate-1', document: 'page-1.json', mimeType: 'image/png', data: ARCHIVE_PNG },
];

function writeArchiveFile(dir, prefix, stage, kind, content, sha = 'deadbeef') {
  const file = path.join(dir, `${prefix}-${stage}-${kind}-${sha}.json`);
  fs.writeFileSync(file, JSON.stringify({
    stage, revision: 1, kind, candidateId: content.candidateId ?? null, content,
  }), { mode: 0o600 });
  return file;
}

// One job directory: a paired pick prompt/reply, an unpaired pick prompt, a pick
// candidate file, and a write prompt/reply pair that pick capture must ignore.
function buildPickArchive() {
  const archiveDir = tempDir('archive');
  const jobDir = path.join(archiveDir, 'job-a');
  fs.mkdirSync(jobDir, { recursive: true });
  writeArchiveFile(jobDir, '00001', 'pick', 'prompt', { prompt: ARCHIVE_PROMPT, pageImages: ARCHIVE_PAGE_IMAGES });
  writeArchiveFile(jobDir, '00001', 'pick', 'reply', { response: ARCHIVE_ANSWER }, 'cafebabe');
  writeArchiveFile(jobDir, '00002', 'pick', 'prompt', { prompt: 'UNPAIRED PICK PROMPT', pageImages: [] }, 'feedface');
  writeArchiveFile(jobDir, '00002', 'pick', 'candidate', { prompt: 'CANDIDATE PROMPT', pageImages: [] }, 'f00dbabe');
  writeArchiveFile(jobDir, '00003', 'write', 'prompt', { prompt: 'WRITE PROMPT', pageImages: [] }, '0badf00d');
  writeArchiveFile(jobDir, '00003', 'write', 'reply', { response: 'WRITE REPLY' }, 'deadc0de');
  return { archiveDir, jobDir };
}

test('captureArchiveRecords pairs a pick prompt with its reply and skips unpaired and other-stage files', () => {
  const { archiveDir } = buildPickArchive();
  const { records, stats } = captureArchiveRecords(archiveDir, { stage: 'pick' });
  assert.equal(records.length, 1, 'one paired pick record; the unpaired prompt and the write pair are dropped');
  assert.deepEqual(records[0], {
    id: 'pick:job-a:00001',
    task: 'pick',
    text: ARCHIVE_PROMPT,
    systemAppend: '',
    responseSchema: null,
    pageImages: ARCHIVE_PAGE_IMAGES,
    baseline: { text: ARCHIVE_ANSWER, model: null, effort: null, costUsd: null, durationMs: null },
  });
  assert.equal(stats.jobs, 1);
  assert.equal(stats.prompts, 2, 'only the pick prompts are considered');
  assert.equal(stats.unpaired, 1);
  assert.equal(stats.paired, 1);
  assert.equal(stats.kept, 1);
  assert.equal(stats.unreadable, 0);

  const write = captureArchiveRecords(archiveDir, { stage: 'write' });
  assert.deepEqual(write.records.map(record => record.id), ['write:job-a:00003'], 'each stage pairs from its own files');
  assert.deepEqual(write.records[0].pageImages, [], 'a prompt without pageImages still carries an empty array');
});

test('captureArchiveRecords sorts by jobId then NNNNN and caps the records at --limit', () => {
  const archiveDir = tempDir('archive-order');
  for (const [jobId, prefix] of [['job-b', '00002'], ['job-a', '00003'], ['job-a', '00001']]) {
    const jobDir = path.join(archiveDir, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    writeArchiveFile(jobDir, prefix, 'pick', 'prompt', { prompt: `${jobId} ${prefix}`, pageImages: [] });
    writeArchiveFile(jobDir, prefix, 'pick', 'reply', { response: '{"ranking":[]}' }, 'cafebabe');
  }
  assert.deepEqual(captureArchiveRecords(archiveDir, { stage: 'pick' }).records.map(record => record.id),
    ['pick:job-a:00001', 'pick:job-a:00003', 'pick:job-b:00002']);
  assert.deepEqual(captureArchiveRecords(archiveDir, { stage: 'pick', limit: 2 }).records.map(record => record.id),
    ['pick:job-a:00001', 'pick:job-a:00003'], '--limit keeps the first records in sorted order');
  assert.throws(() => captureArchiveRecords(archiveDir, { stage: 'pick', limit: 0 }), /positive integer/u);
  assert.throws(() => captureArchiveRecords(archiveDir, { stage: 'Pick' }), /lowercase stage name/u);
});

test('capture-archive writes owner-only records outside the repository and prints counts only', async () => {
  const { archiveDir } = buildPickArchive();
  const outDir = tempDir('archive-out');
  const out = path.join(outDir, 'pick-records.jsonl');
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => { chunks.push(String(chunk)); return true; };
  try {
    assert.equal(await main(['capture-archive', '--archive-dir', archiveDir, '--stage', 'pick', '--out', out]), 0);
  } finally {
    process.stdout.write = original;
  }
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const written = readLines(out);
  assert.deepEqual(written.map(record => record.id), ['pick:job-a:00001']);
  assert.equal(written[0].text, ARCHIVE_PROMPT);
  assert.deepEqual(written[0].pageImages, ARCHIVE_PAGE_IMAGES);
  const output = chunks.join('');
  assert.match(output, /pick records: 1 of 2 archived prompts in 1 jobs \(limit none\)/u);
  assert.equal(output.includes(ARCHIVE_PROMPT), false, 'prompt text never reaches stdout');
  assert.equal(output.includes(ARCHIVE_ANSWER), false, 'answer text never reaches stdout');
  await assert.rejects(
    () => main(['capture-archive', '--archive-dir', archiveDir, '--stage', 'pick', '--out', path.join(REPO_ROOT, 'archive-records.jsonl')]),
    /must be outside the repository/u,
  );
  await assert.rejects(
    () => main(['capture-archive', '--archive-dir', archiveDir, '--out', out]),
    /--stage <name> is required/u,
  );
});

test('run forwards record pageImages to the stage runner and never writes them into results rows', async () => {
  const outDir = tempDir('run-page-images');
  const calls = [];
  const runStage = async args => {
    calls.push(args);
    return { text: '{"ranking":[]}', model: args.model, durationMs: 4, costUsd: 0.02 };
  };
  const records = [
    { id: 'pick:job-a:00001', task: 'pick', text: 'RANK THE PAGES', systemAppend: '', responseSchema: null, pageImages: ARCHIVE_PAGE_IMAGES },
    { id: 'pick:job-b:00001', task: 'pick', text: 'NO IMAGES', systemAppend: '', responseSchema: null },
  ];
  const stats = await runLadder({
    records, configs: parseConfigs('opus:high'), reps: 1, runStage, validate: () => {}, outDir, stageContext: fakeStageContext(),
  });
  assert.equal(stats.planned, 2);
  assert.equal(calls.length, 2);
  const withImages = calls.filter(call => call.text === 'RANK THE PAGES');
  assert.equal(withImages.length, 1);
  assert.deepEqual(withImages[0].pageImages, ARCHIVE_PAGE_IMAGES, 'the pick call carries the archived page images');
  const withoutImages = calls.filter(call => call.text === 'NO IMAGES');
  assert.equal(withoutImages.length, 1);
  assert.equal(withoutImages[0].pageImages, undefined, 'a record with no images passes undefined');
  const rows = readLines(path.join(outDir, 'results.jsonl'));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal('pageImages' in row, false, 'the results row never stores image data');
    assert.equal(JSON.stringify(row).includes(ARCHIVE_PNG), false, 'no base64 image data reaches results.jsonl');
  }
});
