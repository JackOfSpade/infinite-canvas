// Recording that lets every Claude call be re-measured offline later: the
// sample module's file layout and limits, the task worker's and interview
// transport's per-attempt samples, and the spend report's annualization.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureAiRecording, recordAiReplaySample, recordAiUsage } from '../electron/ipc/aiReplaySamples.js';
import { createClaudeTaskWorker } from '../electron/ipc/claudeTaskWorker.js';
import { createInterviewClaudeTransport } from '../electron/ipc/interviewClaudeTransport.js';
import { summarizeAiSpend } from './ai-spend-report.mjs';

const sampleHash = (text, systemAppend) => crypto.createHash('sha256')
  .update(`${text}\u0000${systemAppend}`, 'utf8').digest('hex').slice(0, 12);

function tempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-replay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sampleFiles(root, task) {
  const dir = path.join(root, 'ai-replay-samples', task);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort();
}

function readSample(root, task, name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'ai-replay-samples', task, name), 'utf8'));
}

async function until(check) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition was not reached in time');
}

test('ai replay samples: recording is a no-op until configured', (t) => {
  const root = tempUserData(t);
  configureAiRecording({});
  assert.equal(recordAiReplaySample({ task: 'job-scoring', text: 'PROMPT', systemAppend: '' }), null);
  assert.equal(recordAiUsage({ task: 'job-scoring', model: 'claude-x', effort: 'low', costUsd: 1 }), null);
  assert.deepEqual(fs.readdirSync(root), [], 'nothing is written without a configured root');
});

test('ai replay samples: writes a 0600 sample under the task directory', (t) => {
  const root = tempUserData(t);
  configureAiRecording({ userData: root });
  const file = recordAiReplaySample({
    at: '2026-01-02T03:04:05.678Z',
    task: 'job-scoring',
    stage: null,
    attempt: 2,
    text: 'PROMPT TEXT',
    systemAppend: 'SHARED REFERENCE:\nSHARED',
    model: 'claude-resolved-1',
    requestedModel: 'claude-requested-1',
    effort: 'medium',
    tools: 'WebSearch',
    costUsd: 0.125,
    usage: { input_tokens: 12, output_tokens: 3 },
    durationMs: 4321,
    answer: 'ANSWER TEXT',
    outcome: 'accepted',
    validationCode: null,
  });
  const expectedName = `2026-01-02T03-04-05-678Z-${sampleHash('PROMPT TEXT', 'SHARED REFERENCE:\nSHARED')}.json`;
  assert.equal(file, path.join(root, 'ai-replay-samples', 'job-scoring', expectedName));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the sample file is readable only by its owner');
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700, 'the task directory is private');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    at: '2026-01-02T03:04:05.678Z',
    task: 'job-scoring',
    stage: null,
    attempt: 2,
    text: 'PROMPT TEXT',
    systemAppend: 'SHARED REFERENCE:\nSHARED',
    model: 'claude-resolved-1',
    requestedModel: 'claude-requested-1',
    effort: 'medium',
    tools: 'WebSearch',
    costUsd: 0.125,
    usage: { input_tokens: 12, output_tokens: 3 },
    durationMs: 4321,
    answer: 'ANSWER TEXT',
    outcome: 'accepted',
    validationCode: null,
  });
});

test('ai replay samples: keeps only the newest 24 samples per task', (t) => {
  const root = tempUserData(t);
  configureAiRecording({ userData: root });
  for (let index = 0; index < 30; index += 1) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    recordAiReplaySample({ at, task: 'job-scoring', text: `prompt-${index}`, systemAppend: '', answer: `answer-${index}`, outcome: 'accepted' });
    // Another task's samples are never pruned by this one.
    if (index === 29) recordAiReplaySample({ at, task: 'job-matching', text: 'other', systemAppend: '' });
  }
  const files = sampleFiles(root, 'job-scoring');
  assert.equal(files.length, 24);
  const kept = files.map(name => readSample(root, 'job-scoring', name).text).sort();
  const expected = Array.from({ length: 24 }, (_, index) => `prompt-${index + 6}`).sort();
  assert.deepEqual(kept, expected, 'the six oldest samples were deleted');
  assert.equal(sampleFiles(root, 'job-matching').length, 1);
});

test('ai replay samples: a task name that is not a safe directory name is skipped', (t) => {
  const root = tempUserData(t);
  configureAiRecording({ userData: root });
  for (const task of ['Bad Task', '../escape', 'job_scoring', '', 'a'.repeat(81)]) {
    assert.equal(recordAiReplaySample({ task, text: 'PROMPT', systemAppend: '' }), null);
  }
  assert.equal(fs.existsSync(path.join(root, 'ai-replay-samples')), false, 'no directory was created');
  assert.equal(recordAiReplaySample({ task: 'job-scoring', text: 'PROMPT', systemAppend: '' }) !== null, true);
});

test('ai replay samples: usage rows append to the worker usage log one per line', (t) => {
  const root = tempUserData(t);
  configureAiRecording({ userData: root });
  const first = { at: '2026-03-01T00:00:00.000Z', task: 'job-scoring', model: 'claude-a', effort: 'low', usage: { input_tokens: 1 }, costUsd: 0.01, provider: 'claude' };
  recordAiUsage(first);
  recordAiUsage({ task: 'interview-brief-assessment', stage: 'qa-brief', model: 'claude-b', effort: 'high', costUsd: 0.02, provider: 'claude' });
  const file = path.join(root, 'claude-task-usage.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], first, 'the first row is written unchanged');
  assert.equal(rows[1].stage, 'qa-brief', 'an interview row keeps its stage');
  assert.equal(typeof rows[1].at, 'string', 'a row without a time gets one');
});

function taskWorker({ prompt = 'HEAD\nSHARED BLOCK\nTAIL', cachedPrefix = 'SHARED BLOCK', submit = { outcome: 'accepted' }, reply } = {}) {
  const request = { requestId: 'r1', handoffCode: 'h1', task: 'job-scoring', hasAttachments: false, rejections: 2 };
  const state = { pending: new Map([[request.requestId, request]]), stages: [], submits: [], timers: [] };
  const seam = {
    list: () => ({ handoffs: [...state.pending.values()], settlingRequestIds: [], retryAfterMs: 0 }),
    read: () => ({ ok: true, prompt, cachedPrefix }),
    assigned: () => true,
    attachments: async () => ({ attachments: [] }),
    submit: async (args) => {
      state.submits.push(args);
      // The handoff is settled either way, so the pump does not serve it again.
      state.pending.delete(args.requestId);
      return submit;
    },
    returnToPerson: () => true,
    fail: () => true,
    onEvent: () => () => {},
  };
  const worker = createClaudeTaskWorker({
    seam,
    runStage: async (options) => { state.stages.push(options); return reply; },
    profileFor: () => ({ model: 'claude-requested-9', effort: 'medium' }),
    binding: () => ({ binary: 'claude', env: {}, cwd: '/tmp' }),
    routeFor: () => null,
    now: () => Date.UTC(2026, 4, 1),
    setTimer: (fn, ms) => { const timer = { fn, ms }; state.timers.push(timer); return timer; },
    clearTimer: (timer) => { state.timers = state.timers.filter(item => item !== timer); },
    shadow: { enabled: false, measure: () => {} },
    recordUsage: () => {},
    tavily: { readKey: async () => '', plainLeads: async () => [] },
    onActivityChange: null,
    isHeld: () => false,
  });
  return { worker, state };
}

test('claude task worker: records the exact request and the submit outcome after a Claude answer', async (t) => {
  const root = tempUserData(t);
  configureAiRecording({ userData: root });
  const { worker, state } = taskWorker({
    submit: { outcome: 'rejected', validationCode: 'SCHEMA_REJECTED' },
    reply: { text: 'ANSWER TEXT', model: 'claude-resolved-9', usage: { input_tokens: 12 }, costUsd: 0.05, durationMs: 1234 },
  });
  t.after(() => worker.stop());
  worker.start();
  await until(() => sampleFiles(root, 'job-scoring').length === 1);
  const [name] = sampleFiles(root, 'job-scoring');
  const sample = readSample(root, 'job-scoring', name);
  assert.equal(state.submits.length, 1);
  assert.equal(state.submits[0].response, 'ANSWER TEXT', 'the submitted answer is the reply text');
  assert.equal(state.stages.length, 1);
  assert.equal(sample.task, 'job-scoring');
  assert.equal(sample.stage, null);
  assert.equal(sample.attempt, 2, 'entry.rejections is the attempt already refused');
  assert.equal(sample.text, state.stages[0].text, 'the sample holds the exact text Claude received');
  assert.equal(sample.systemAppend, 'SHARED REFERENCE:\nSHARED BLOCK');
  assert.equal(sample.model, 'claude-resolved-9', 'the model recorded is the one the reply resolved to');
  assert.equal(sample.requestedModel, 'claude-requested-9');
  assert.equal(sample.effort, 'medium');
  assert.equal(sample.tools, null);
  assert.equal(sample.costUsd, 0.05);
  assert.deepEqual(sample.usage, { input_tokens: 12 });
  assert.equal(sample.durationMs, 1234);
  assert.equal(sample.answer, 'ANSWER TEXT');
  assert.equal(sample.outcome, 'rejected', 'the submit outcome is recorded');
  assert.equal(sample.validationCode, 'SCHEMA_REJECTED');
  assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{12}\.json$/u);
});

test('interview transport: records a sample and a usage row for every Claude attempt', async () => {
  const samples = [];
  const usages = [];
  const stages = [];
  const replies = [
    { text: 'not json', model: 'claude-resolved-x', usage: { input_tokens: 3 }, costUsd: 0.02, durationMs: 5 },
    { text: '{"ok":true}', model: 'claude-resolved-y', usage: { input_tokens: 4 }, costUsd: 0.03, durationMs: 6 },
  ];
  const profile = (await import('../electron/ipc/careerWritingCore.js')).careerWritingStageProfile('qa-brief');
  const transport = createInterviewClaudeTransport({
    runStage: async (options) => { stages.push(options); return replies[stages.length - 1]; },
    resolveBinary: () => '/usr/local/bin/claude',
    env: {},
    cwd: '/tmp',
    routeFor: () => null,
    shadow: { enabled: false, measure: () => {} },
    now: () => Date.parse('2026-02-01T00:00:00.000Z'),
    recordSample: sample => samples.push(sample),
    recordUsage: row => usages.push(row),
  });
  const value = await transport.callText('PROMPT ONE', { task: 'interview-brief-assessment' });
  assert.deepEqual(value, { ok: true });
  assert.equal(samples.length, 2, 'one sample per Claude attempt');
  assert.equal(usages.length, 2, 'one usage row per Claude attempt');
  assert.equal(samples[0].task, 'interview-brief-assessment');
  assert.equal(samples[0].stage, 'qa-brief');
  assert.equal(samples[0].attempt, 0);
  assert.equal(samples[0].text, 'PROMPT ONE');
  assert.equal(samples[0].systemAppend, '');
  assert.equal(samples[0].model, 'claude-resolved-x');
  assert.equal(samples[0].requestedModel, profile.model);
  assert.equal(samples[0].effort, profile.effort);
  assert.equal(samples[0].tools, null);
  assert.equal(samples[0].costUsd, 0.02);
  assert.deepEqual(samples[0].usage, { input_tokens: 3 });
  assert.equal(samples[0].answer, 'not json');
  assert.equal(samples[0].outcome, 'rejected');
  assert.equal(samples[0].validationCode, 'invalid');
  assert.equal(samples[1].attempt, 1);
  assert.equal(samples[1].text, stages[1].text, 'the retry sample holds the correction text Claude received');
  assert.equal(samples[1].answer, '{"ok":true}');
  assert.equal(samples[1].outcome, 'accepted');
  assert.equal(samples[1].validationCode, null);
  assert.deepEqual(usages[0], {
    at: '2026-02-01T00:00:00.000Z',
    task: 'interview-brief-assessment',
    stage: 'qa-brief',
    model: 'claude-resolved-x',
    effort: profile.effort,
    usage: { input_tokens: 3 },
    costUsd: 0.02,
    provider: 'claude',
  });
  assert.deepEqual(usages[1], {
    at: '2026-02-01T00:00:00.000Z',
    task: 'interview-brief-assessment',
    stage: 'qa-brief',
    model: 'claude-resolved-y',
    effort: profile.effort,
    usage: { input_tokens: 4 },
    costUsd: 0.03,
    provider: 'claude',
  });
});

test('spend report: annualizes each call over the shared window of its log', () => {
  const summary = summarizeAiSpend({
    now: Date.UTC(2026, 1, 1),
    usageRows: [
      { at: '2026-01-01T00:00:00.000Z', task: 'job-scoring', model: 'claude-a', effort: 'low', costUsd: 1, provider: 'claude' },
      { at: '2026-01-11T00:00:00.000Z', task: 'job-scoring', model: 'claude-a', effort: 'low', costUsd: 3, provider: 'claude' },
      { at: '2026-01-05T00:00:00.000Z', task: 'interview-brief-assessment', stage: 'qa-brief', model: 'claude-b', effort: 'high', costUsd: 2, provider: 'claude' },
      // No cost is recorded, but the call still happened.
      { at: '2026-01-05T00:00:00.000Z', task: 'job-matching', model: 'claude-a', effort: 'low' },
      null,
      'not a row',
    ],
    runRows: [
      { at: '2026-01-01T00:00:00.000Z', stage: 'cover-letter', costUsd: 0.5, model: 'claude-c', effort: 'medium' },
      { at: '2026-01-06T00:00:00.000Z', stage: 'cover-letter', costUsd: 0.5 },
      // A run event without a numeric cost is no call, but it still dates the
      // stage; a row without a stage is neither a call nor part of the window.
      { at: '2026-01-06T00:00:00.000Z', stage: 'cover-letter', event: 'failed' },
      { at: '2026-01-06T00:00:00.000Z', costUsd: 9 },
    ],
  });
  assert.deepEqual(summary.calls.map(call => call.id), [
    'job-scoring',
    'interview-brief-assessment/qa-brief',
    'stage:cover-letter',
    'job-matching',
  ], 'sorted by annualized cost');
  const byId = Object.fromEntries(summary.calls.map(call => [call.id, call]));
  assert.deepEqual(byId['job-scoring'], { id: 'job-scoring', calls: 2, totalCostUsd: 4, windowDays: 10, annualCostUsd: 146 });
  assert.deepEqual(byId['interview-brief-assessment/qa-brief'],
    { id: 'interview-brief-assessment/qa-brief', calls: 1, totalCostUsd: 2, windowDays: 10, annualCostUsd: 73 });
  // Two costed calls mean 0.5 each; the failed row is no call but shares the
  // 5-day window (Jan 1 to Jan 6), so the annualized figure is unchanged.
  assert.deepEqual(byId['stage:cover-letter'],
    { id: 'stage:cover-letter', calls: 2, totalCostUsd: 1, windowDays: 5, annualCostUsd: 73, costedCalls: 2 });
  assert.deepEqual(byId['job-matching'], { id: 'job-matching', calls: 1, totalCostUsd: 0, windowDays: 10, annualCostUsd: 0 });
  assert.deepEqual(summary.models, ['claude-a / low', 'claude-b / high', 'claude-c / medium']);
  assert.deepEqual(summarizeAiSpend({}), { calls: [], models: [] });
});

test('ai replay samples: recording never throws on unusable input', (t) => {
  const root = tempUserData(t);
  configureAiRecording({ userData: root });
  const cyclic = { task: 'job-scoring' };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => recordAiUsage(cyclic), 'an unserializable usage row is dropped, not thrown');
  const hostile = { get task() { throw new Error('boom'); } };
  assert.equal(recordAiReplaySample(hostile), null);
  assert.doesNotThrow(() => recordAiReplaySample(null), 'a missing sample is ignored');
  assert.equal(sampleFiles(root, 'job-scoring').length, 0);
});
