import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  answeringModel,
  CLAUDE_ACTIVITY_EMIT_INTERVAL_MS,
  CLAUDE_HANDOFF_SYSTEM_PROMPT,
  CLAUDE_MAX_RUNS_PER_JOB,
  CLAUDE_STAGE_PROFILES,
  CLAUDE_STAGE_TIMEOUT_MS,
  claudeStageProfile,
  ClaudeRunnerError,
  buildClaudeInputMessage,
  claudeChildEnv,
  claudeCliArgs,
  classifyClaudeFailure,
  createClaudeApplicationRunner as createRunner,
  parseClaudeStreamOutput,
  resolveClaudeBinary,
  runClaudeStage,
} from '../../electron/ipc/claudeApplicationRunner.js';

const REJECTED_INTRO = n => `\n\nYour previous response to this handoff was rejected by the app. Fix ${n === 1 ? 'this item' : `these ${n} items`} and reply again with the complete corrected response:\n`;
const FENCE_CORRECTION = 'Paste one valid JSON object (a single JSON code fence is also accepted).';

// Most driver fixtures use a fake canvas at /c.canvas. Audit tests below opt
// into an actual private temporary log rather than writing beside that path.
function createClaudeApplicationRunner(options = {}) {
  return createRunner({ runLogPath: null, capturePrompts: false, ...options });
}

function readRunLog(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function textsSentFor(handoffs) {
  const script = sequenceApi(handoffs);
  const texts = [];
  const runner = createClaudeApplicationRunner({
    api: script.api, stateFile: tempStateFile(), logger: quietLogger(), homedir: '',
    runStage: async ({ text }) => { texts.push(text); return { text: '{}' }; },
  });
  const jobId = `job-text-${Math.random().toString(36).slice(2)}`;
  runner.ensure({ jobId, canvasFilePath: '/c.canvas' });
  await waitFor(() => runner.status([jobId])[jobId]?.status === 'done', 'done');
  await runner.shutdown();
  return texts;
}

const USAGE_MESSAGE = 'Claude usage limit reached. Retry this application after your limit resets.';
const LOGIN_MESSAGE = 'Claude Code is not signed in. Run claude in a terminal and sign in with your Claude subscription, then retry.';

function resultLine({ result = 'final answer', isError = false, subtype = 'success', models = ['claude-sonnet-5-5'], apiErrorStatus } = {}) {
  const modelUsage = Object.fromEntries(models.map(model => [model, { inputTokens: 1 }]));
  return JSON.stringify({
    type: 'result', subtype, is_error: isError, result, session_id: 's1', duration_ms: 42, modelUsage,
    ...(apiErrorStatus !== undefined ? { api_error_status: apiErrorStatus } : {}),
  });
}

function fakeSpawnFactory() {
  const calls = [];
  const spawnImpl = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = [];
    child.kill = signal => { child.kills.push(signal); return true; };
    child.stdinText = '';
    child.stdin.on('data', chunk => { child.stdinText += chunk.toString('utf8'); });
    calls.push({ binary, args, options, child });
    return child;
  };
  return { calls, spawnImpl };
}

function finishChild(child, { stdout = '', stderr = '', code = 0 } = {}) {
  if (stdout) child.stdout.write(stdout);
  if (stderr) child.stderr.write(stderr);
  setImmediate(() => child.emit('close', code, null));
}

async function stageWith(output, profile = {}) {
  const { calls, spawnImpl } = fakeSpawnFactory();
  const promise = runClaudeStage({ text: 'secret prompt', pageImages: [], binary: '/bin/claude', env: { PATH: '/bin' }, cwd: '/tmp/ws', spawnImpl, ...profile });
  await new Promise(resolve => setImmediate(resolve));
  finishChild(calls[0].child, output);
  return { promise, calls };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function waitFor(predicate, label = 'condition', timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

function tempStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runner-test-'));
  return path.join(dir, 'nested', 'state.json');
}

function quietLogger() {
  const errors = [];
  const warns = [];
  return { errors, warns, error: message => errors.push(message), warn: message => warns.push(message), info() {}, log() {} };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runner-home-'));
}

// Like the app: the new-chat fields are non-enumerable properties of the handoff.
function withFresh(handoff, required, key) {
  Object.defineProperty(handoff, 'freshContextRequired', { value: required, enumerable: false });
  if (key !== undefined) Object.defineProperty(handoff, 'freshContextKey', { value: key, enumerable: false });
  return handoff;
}

// Each submit advances to the next handoff (returned as the same object, so its
// non-enumerable fields survive); the last submit completes the job.
function sequenceApi(handoffs) {
  let index = 0;
  return {
    handoffs,
    api: {
      async getHandoff() {
        return index >= handoffs.length ? { completed: true, handoff: null } : { handoff: handoffs[index] };
      },
      async submitHandoff() {
        index += 1;
        return { accepted: true, completed: index >= handoffs.length };
      },
      subscribeDiscards: () => () => {},
    },
  };
}

// A scripted single-job application: a list of main handoffs advanced on accepted submits.
function scriptedApi(stages, { rejectFirst = false } = {}) {
  let index = 0;
  let rejected = false;
  const submits = [];
  const reads = [];
  let discardListener = null;
  return {
    submits,
    reads,
    discard: event => discardListener?.(event),
    api: {
      async getHandoff(args) {
        reads.push(args);
        if (index >= stages.length) return { completed: true, handoff: null };
        if (rejected) return { handoff: { ...stages[index], handoffCode: `${stages[index].handoffCode}-r`, corrections: ['too vague'], correctionPrompt: `fix ${stages[index].stage}` } };
        return { handoff: stages[index] };
      },
      async submitHandoff(args) {
        submits.push(args);
        if (rejectFirst && !rejected && submits.length === 1) {
          rejected = true;
          return { accepted: false, validationErrors: ['too vague'], handoff: stages[index] };
        }
        rejected = false;
        index += 1;
        return { accepted: true, completed: index >= stages.length };
      },
      subscribeDiscards(listener) { discardListener = listener; return () => { discardListener = null; }; },
    },
  };
}

export default [
  {
    name: 'claude runner driver: returned handoffs are offered to the host read with fresh-context metadata intact',
    async run() {
      const first = withFresh({ revision: 1, handoffCode: 'one', stage: 'convert', prompt: 'First conversion.' }, true, 'first-context');
      const next = withFresh({ revision: 2, handoffCode: 'two', stage: 'pick', prompt: 'Rank verified pages.',
        pageImages: [{ candidateId: 'synthetic', document: 'resume', mimeType: 'image/png', data: 'c3ludGhldGlj' }] }, true, 'next-context');
      let revision = 1;
      let reads = 0;
      let reused = 0;
      const calls = [];
      const runner = createClaudeApplicationRunner({
        api: {
          getHandoff: async args => {
            reads++;
            if (revision === 1) { assert.equal(args.reuseHandoff, undefined); return { handoff: first }; }
            assert.equal(args.reuseHandoff, next, 'the exact host-owned record reaches the authoritative read');
            assert.equal(args.reuseHandoff.revision, revision);
            assert.equal(args.reuseHandoff.freshContextRequired, true);
            assert.equal(args.reuseHandoff.freshContextKey, 'next-context');
            assert.equal(Object.keys(args.reuseHandoff).includes('freshContextKey'), false);
            reused++;
            return { handoff: args.reuseHandoff };
          },
          submitHandoff: async () => {
            if (revision === 1) { revision = 2; return { accepted: true, completed: false, localJob: { revision }, handoff: next }; }
            return { accepted: true, completed: true };
          },
        },
        stateFile: tempStateFile(), logger: quietLogger(), homedir: '',
        runStage: async args => { calls.push(args); return { text: '{}' }; },
      });
      try {
        runner.ensure({ jobId: 'returned-handoff', canvasFilePath: '/c.canvas' });
        await waitFor(() => runner.status(['returned-handoff'])['returned-handoff']?.status === 'done', 'reused handoff done');
        assert.equal(reads, 2, 'every stage still passes through a current host read');
        assert.equal(reused, 1);
        assert.deepEqual(calls.map(call => call.text), [first.prompt, next.prompt]);
        assert.equal(calls[1].pageImages, next.pageImages);
        assert.notEqual(calls[0].sessionId, calls[1].sessionId, 'reuse preserves the required independent context');
      } finally { await runner.shutdown(); }
    },
  },
  {
    name: 'claude runner driver: a changed host revision supersedes the returned handoff before another provider call',
    async run() {
      const stale = { revision: 2, handoffCode: 'stale', stage: 'convert', prompt: 'Stale conversion.' };
      const fresh = { revision: 3, handoffCode: 'fresh', stage: 'convert', prompt: 'Current conversion.' };
      let reads = 0;
      let submits = 0;
      const texts = [];
      const runner = createClaudeApplicationRunner({
        api: {
          getHandoff: async args => {
            reads++;
            if (reads === 1) return { handoff: { revision: 1, handoffCode: 'first', stage: 'convert', prompt: 'First conversion.' } };
            assert.equal(args.reuseHandoff, stale);
            assert.notEqual(args.reuseHandoff.revision, fresh.revision);
            return { handoff: fresh }; // The authoritative host rejects the obsolete reuse candidate.
          },
          submitHandoff: async args => {
            submits++;
            if (submits === 1) return { accepted: true, completed: false, localJob: { revision: 2 }, handoff: stale };
            assert.equal(args.handoffCode, fresh.handoffCode);
            return { accepted: true, completed: true };
          },
        },
        stateFile: tempStateFile(), logger: quietLogger(), homedir: '',
        runStage: async ({ text }) => { texts.push(text); return { text: '{}' }; },
      });
      try {
        runner.ensure({ jobId: 'stale-returned-handoff', canvasFilePath: '/c.canvas' });
        await waitFor(() => runner.status(['stale-returned-handoff'])['stale-returned-handoff']?.status === 'done', 'fresh revision done');
        assert.deepEqual(texts, ['First conversion.', fresh.prompt]);
        assert.equal(reads, 2);
      } finally { await runner.shutdown(); }
    },
  },
  {
    name: 'claude runner driver: host-only render retry can offer its next handoff without another provider repair',
    async run() {
      const next = { revision: 2, handoffCode: 'after-render', stage: 'convert', prompt: 'Next conversion.' };
      let reads = 0;
      let renders = 0;
      let providerCalls = 0;
      const runner = createClaudeApplicationRunner({
        api: {
          getHandoff: async args => {
            if (reads++ === 0) return { handoff: { handoffCode: 'held', stage: 'convert', prompt: 'Held content.', renderHold: {} } };
            assert.equal(args.reuseHandoff, next);
            return { handoff: next };
          },
          submitHandoff: async args => {
            if (args.renderRetry) { renders++; return { accepted: true, completed: false, localJob: { revision: 2 }, handoff: next }; }
            assert.equal(args.handoffCode, next.handoffCode);
            return { accepted: true, completed: true };
          },
        },
        stateFile: tempStateFile(), logger: quietLogger(), homedir: '',
        runStage: async () => { providerCalls++; return { text: '{}' }; },
      });
      try {
        runner.ensure({ jobId: 'returned-render-handoff', canvasFilePath: '/c.canvas' });
        await waitFor(() => runner.status(['returned-render-handoff'])['returned-render-handoff']?.status === 'done', 'render retry done');
        assert.equal(renders, 1);
        assert.equal(providerCalls, 1, 'the held content is retried solely by the host');
      } finally { await runner.shutdown(); }
    },
  },
  {
    name: 'claude runner run log: queued success and failure retain injected-clock queue and wall timings',
    async run() {
      for (const fails of [false, true]) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-queue-timing-'));
        const logFile = path.join(dir, 'runs.jsonl');
        let clock = 1000;
        let releaseFirst;
        const firstFinished = new Promise(resolve => { releaseFirst = resolve; });
        let firstStarted = false;
        const runner = createClaudeApplicationRunner({
          api: {
            getHandoff: async ({ jobId }) => ({ handoff: { handoffCode: jobId, stage: 'convert', prompt: jobId } }),
            submitHandoff: async () => ({ accepted: true, completed: true }),
          },
          concurrency: 1, now: () => clock, stateFile: path.join(dir, 'state.json'),
          logger: quietLogger(), homedir: dir, runLogPath: () => logFile,
          runStage: async ({ text, onThinkingSummary }) => {
            if (text === 'first') {
              firstStarted = true;
              await firstFinished;
            } else {
              clock = 1300;
              await onThinkingSummary({ text: 'Synthetic conversion summary.', model: 'claude-sonnet-5-5', thinkingDisplay: 'summarized' });
              if (fails) throw new ClaudeRunnerError('CLAUDE_ERROR', 'Synthetic provider failure.');
            }
            return { text: '{}', model: 'claude-sonnet-5-5', durationMs: 7 };
          },
        });
        try {
          runner.ensure({ jobId: 'first', canvasFilePath: '/c.canvas' });
          await waitFor(() => firstStarted, 'first provider started');
          runner.ensure({ jobId: 'queued', canvasFilePath: '/c.canvas' });
          await waitFor(() => runner.status(['queued']).queued?.activity === 'waiting', 'queued provider waiting');
          assert.equal(readRunLog(logFile).some(row => row.jobId === 'queued'), false, 'started remains after semaphore admission');
          clock = 1250;
          releaseFirst();
          await waitFor(() => runner.status(['first']).first?.status === 'done', 'first done');
          await waitFor(() => runner.status(['queued']).queued?.status === (fails ? 'failed' : 'done'), 'queued terminal');
          await runner.shutdown();
          const rows = readRunLog(logFile);
          const queued = rows.filter(row => row.jobId === 'queued');
          assert.deepEqual(queued.map(row => row.event), fails
            ? ['started', 'thinking-summary', 'failed'] : ['started', 'thinking-summary', 'response', 'submission']);
          for (const row of queued) {
            assert.equal(row.queuedAt, new Date(1000).toISOString());
            assert.equal(row.queueWaitMs, 250);
          }
          const terminal = queued.find(row => row.event === (fails ? 'failed' : 'response'));
          assert.equal(terminal.wallMs, 300, 'wall time includes queue wait and local provider work');
          if (!fails) assert.equal(terminal.durationMs, 7, 'provider-reported duration remains separate');
          const first = rows.filter(row => row.jobId === 'first');
          assert(first.every(row => row.queueWaitMs === 0 && row.queuedAt === new Date(1000).toISOString()));
          assert.equal(first.find(row => row.event === 'response').wallMs, 250);
        } finally {
          releaseFirst();
          await runner.shutdown();
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  },
  {
    name: 'claude runner run log: injected clock corrections cannot produce negative queue or wall timings',
    async run() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-clock-timing-'));
      const logFile = path.join(dir, 'runs.jsonl');
      let clock = 1000;
      const runner = createClaudeApplicationRunner({
        api: {
          getHandoff: async () => ({ handoff: { handoffCode: 'clock', stage: 'convert', prompt: 'Synthetic conversion.' } }),
          submitHandoff: async () => ({ accepted: true, completed: true }),
        },
        now: () => clock, notify: state => { if (state.activity === 'waiting') clock = 900; },
        stateFile: path.join(dir, 'state.json'), logger: quietLogger(), homedir: dir, runLogPath: () => logFile,
        runStage: async () => { clock = 800; return { text: '{}' }; },
      });
      try {
        runner.ensure({ jobId: 'clock', canvasFilePath: '/c.canvas' });
        await waitFor(() => runner.status(['clock']).clock?.status === 'done', 'clock done');
        await runner.shutdown();
        const rows = readRunLog(logFile);
        assert(rows.every(row => row.queueWaitMs === 0 && row.queuedAt === new Date(1000).toISOString()));
        assert.equal(rows.find(row => row.event === 'response').wallMs, 0);
      } finally {
        await runner.shutdown();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'claude runner progress: a queued sibling cannot hide active work or reset its action clock',
    async run() {
      let clock = 1000, releaseFirst, firstStarted = false;
      const finished = new Set();
      const runner = createClaudeApplicationRunner({ concurrency: 1, stateFile: tempStateFile(), logger: quietLogger(),
        now: () => clock++, api: {
          getHandoff: async ({ matchTaskId }) => {
            if (!matchTaskId) return finished.size === 2 ? { completed: true } : { handoff: { stage: 'match-wave', parallelTasks: [{ id: 'one' }, { id: 'two' }] } };
            if (finished.has(matchTaskId)) return { completed: true };
            if (matchTaskId === 'two') await waitFor(() => firstStarted);
            return { handoff: { stage: 'requirements-audit', handoffCode: matchTaskId, prompt: matchTaskId } };
          },
          submitHandoff: async ({ matchTaskId }) => { finished.add(matchTaskId); return { accepted: true, completed: true }; },
          subscribeDiscards: () => () => {},
        }, runStage: async ({ text, onActivity }) => {
          if (text === 'one') { onActivity(); firstStarted = true; await new Promise(resolve => { releaseFirst = resolve; }); }
          return { text: '{}' };
        },
      });
      try {
        runner.ensure({ jobId: 'parallel-progress', canvasFilePath: '/c.canvas' });
        await waitFor(() => runner.status(['parallel-progress'])['parallel-progress']?.waitingCalls === 1);
        const current = runner.status(['parallel-progress'])['parallel-progress'];
        assert.equal(current.activity, 'running'); assert.equal(current.activeCalls, 1); assert.equal(current.waitingCalls, 1);
        assert(Number.isFinite(current.lastActivityAt), 'sibling queue retains provider activity');
        const started = current.updatedAt;
        clock += 100;
        assert.equal(runner.status(['parallel-progress'])['parallel-progress'].updatedAt, started, 'current action start stays stable');
        releaseFirst();
        await waitFor(() => runner.status(['parallel-progress'])['parallel-progress']?.status === 'done');
      } finally { releaseFirst?.(); await runner.shutdown(); }
    },
  },
  {
    name: 'claude runner progress: host candidate counts survive queue provider and validation transitions',
    async run() {
      let clock = 1000;
      const progress = { workflow: 'write-verify', startedAt: 100, candidate: 2, candidateCount: 5, checked: 1, ready: 0, rejected: 1 };
      const script = sequenceApi([{ handoffCode: 'progress-code', stage: 'write', prompt: 'synthetic writer', progress }]);
      const notes = [];
      const runner = createClaudeApplicationRunner({ api: script.api, stateFile: tempStateFile(), logger: quietLogger(),
        now: () => clock++, notify: note => notes.push(note),
        runStage: async () => ({ text: 'synthetic answer' }),
      });
      runner.ensure({ jobId: 'progress-job', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['progress-job'])['progress-job']?.status === 'done');
      const actions = notes.filter(note => note.status === 'running' && note.progress);
      assert.deepEqual(actions.map(note => [note.stage, note.activity]), [
        ['write', 'waiting'], ['write', 'running'], ['host-verification', 'running'],
      ]);
      assert(actions.every(note => note.startedAt === actions[0].startedAt), 'driver start never resets on a handoff');
      assert(actions.every(note => JSON.stringify(note.progress) === JSON.stringify(progress)), 'frozen job start and counts remain attached');
      assert(actions[2].updatedAt > actions[1].updatedAt, 'host validation gets its own action clock');
      await runner.shutdown();
    },
  },
  {
    name: 'claude runner driver: held render replays without a provider call and retry replays again',
    async run() {
      let providerCalls = 0, submissions = 0;
      const runner = createClaudeApplicationRunner({ stateFile: tempStateFile(), logger: quietLogger(), homedir: '',
        api: { getHandoff: async () => ({ handoff: { stage: 'convert', handoffCode: 'h', prompt: 'p', renderHold: { stage: 'convert' } } }),
          submitHandoff: async args => {
            assert.equal(args.renderRetry, true); assert.equal(args.response, ''); assert.equal(args.route, 'claude-runner');
            if (++submissions === 1) throw Object.assign(new Error('Application v2 could not verify page layout: synthetic renderer unavailable.'), { code: 'APPLICATION_V2_RENDER_UNAVAILABLE' });
            return { accepted: true, completed: true };
          }, subscribeDiscards: () => () => {} },
        runStage: async () => { providerCalls++; return { text: 'must not run' }; } });
      try {
        runner.ensure({ jobId: 'held-job', canvasFilePath: '/c.canvas' });
        await waitFor(() => runner.status(['held-job'])['held-job']?.status === 'failed');
        assert.match(runner.status(['held-job'])['held-job'].message, /could not verify page layout/);
        runner.ensure({ jobId: 'held-job', canvasFilePath: '/c.canvas' }); assert.equal(submissions, 1);
        await runner.retry({ jobId: 'held-job', canvasFilePath: '/c.canvas' });
        await waitFor(() => runner.status(['held-job'])['held-job']?.status === 'done');
        assert.equal(submissions, 2); assert.equal(providerCalls, 0);
      } finally { await runner.shutdown(); }
    },
  },

  {
    name: 'claude runner driver: needs-review diagnostics are best effort and malformed run counts are ignored',
    async run() {
      for (const rejectLog of [false, true]) {
        const stateFile = tempStateFile(); fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify({ failed: {}, sessions: {}, runs: { 'job-stop': 'private text' } }));
        const logFile = path.join(path.dirname(stateFile), 'runs.jsonl');
        let calls = 0;
        const runner = createClaudeApplicationRunner({ stateFile, runLogPath: () => logFile, logger: quietLogger(), homedir: '', maxRunsPerJob: 1,
          fsImpl: { ...fs.promises, appendFile: async (...args) => {
            if (rejectLog && JSON.parse(args[1]).event === 'needs-review') throw new Error('synthetic log failure');
            return fs.promises.appendFile(...args);
          } },
          api: { getHandoff: async () => ({ handoff: { stage: 'draft', handoffCode: 'c', prompt: 'p' } }),
            submitHandoff: async () => ({ accepted: false }), stopHandoff: async () => ({ stopped: true, stop: { reason: 'run-budget', stage: 'draft' } }),
            subscribeDiscards: () => () => {} },
          runStage: async () => { calls++; return { text: 'answer' }; } });
        await runner.load(); runner.ensure({ jobId: 'job-stop', canvasFilePath: '/c.canvas' });
        await waitFor(() => ['needs-review', 'failed'].includes(runner.status(['job-stop'])['job-stop']?.status));
        await runner.shutdown();
        assert.equal(calls, 1); assert.equal(runner.status(['job-stop'])['job-stop'].status, 'needs-review');
        assert.equal(runner.status(['job-stop'])['job-stop'].reason, 'run-budget');
        const rows = readRunLog(logFile);
        assert.equal(rows.filter(row => row.event === 'needs-review').length, rejectLog ? 0 : 1);
        assert.equal(rows.find(row => row.event === 'response').runsCompleted, 1);
        assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { failed: {}, sessions: {} });
      }
    },
  },

  {
    name: 'claude runner driver: the run count survives Retry and a restart',
    async run() {
      const stateFile = tempStateFile(); let calls = 0; const stops = [];
      const api = {
        getHandoff: async () => ({ handoff: { handoffCode: 'c', stage: 'draft', prompt: 'p' } }),
        submitHandoff: async () => ({ accepted: false, validationErrors: ['x'], handoff: {} }),
        stopHandoff: async args => { stops.push(args); return { stopped: true, stop: { reason: 'run-budget', stage: 'draft' } }; },
        subscribeDiscards: () => () => {},
      };
      const first = createClaudeApplicationRunner({ api, stateFile, maxRunsPerJob: 4, logger: quietLogger(), homedir: '',
        runStage: async () => { if (++calls > 2) throw new ClaudeRunnerError('CLAUDE_USAGE_LIMIT', USAGE_MESSAGE); return { text: 'a' }; } });
      first.ensure({ jobId: 'job-r1', canvasFilePath: '/c.canvas' });
      await waitFor(() => first.status(['job-r1'])['job-r1']?.status === 'failed');
      await first.shutdown();
      assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).runs?.['job-r1'], 2);
      let answers = 0;
      const second = createClaudeApplicationRunner({ api, stateFile, maxRunsPerJob: 4, logger: quietLogger(), homedir: '',
        runStage: async () => { answers++; return { text: 'a' }; } });
      try {
        await second.load(); await second.retry({ jobId: 'job-r1', canvasFilePath: '/c.canvas' });
        await waitFor(() => ['needs-review', 'failed'].includes(second.status(['job-r1'])['job-r1']?.status));
        assert.equal(answers, 2);
        assert.deepEqual(stops, [{ jobId: 'job-r1', canvasFilePath: '/c.canvas', reason: 'run-budget', runs: 4, limit: 4 }]);
        assert.equal(second.status(['job-r1'])['job-r1'].status, 'needs-review');
        assert.equal(second.status(['job-r1'])['job-r1'].reason, 'run-budget');
      } finally { await second.shutdown(); }
    },
  },
  {
    name: 'claude runner driver: a completed human stop needs review',
    async run() {
      let calls = 0;
      const runner = createClaudeApplicationRunner({ stateFile: tempStateFile(), logger: quietLogger(), homedir: '',
        api: { getHandoff: async () => ({ completed: true, terminal: true, handoff: null, stop: { reason: 'same-rule-repeat', stage: 'requirements', subject: 'e0-l0-u0', ruleId: 'requirements-schema-coverage', count: 5 } }),
          submitHandoff: async () => ({}), subscribeDiscards: () => () => {} },
        runStage: async () => { calls++; return { text: 'a' }; } });
      try {
        runner.ensure({ jobId: 'job-r2', canvasFilePath: '/c.canvas' });
        await waitFor(() => ['done', 'needs-review'].includes(runner.status(['job-r2'])['job-r2']?.status));
        assert.equal(runner.status(['job-r2'])['job-r2'].status, 'needs-review');
        assert.equal(runner.status(['job-r2'])['job-r2'].reason, 'same-rule-repeat');
        assert.equal(calls, 0);
      } finally { await runner.shutdown(); }
    },
  },

  {
    name: 'claude runner: CLI args are exactly the headless, tool-less latest-Sonnet invocation',
    run() {
      assert.deepEqual(claudeCliArgs(), [
        '-p', '--model', 'sonnet', '--effort', 'high', '--append-system-prompt', CLAUDE_HANDOFF_SYSTEM_PROMPT, '--restricted', '--strict-mcp-config',
        '--tools', '', '--input-format', 'stream-json',
        '--output-format', 'stream-json', '--verbose',
      ]);
      assert.equal(claudeCliArgs().includes('--no-session-persistence'), false);
    },
  },
  {
    name: 'claude runner: CLI args start a session with --session-id or continue it with --resume right after -p',
    run() {
      const tail = ['--model', 'opus', '--effort', 'xhigh', '--append-system-prompt', CLAUDE_HANDOFF_SYSTEM_PROMPT, '--restricted', '--strict-mcp-config',
        '--tools', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
      assert.deepEqual(claudeCliArgs({ model: 'opus', effort: 'xhigh', sessionId: 'S', resume: false }), ['-p', '--session-id', 'S', ...tail]);
      assert.deepEqual(claudeCliArgs({ model: 'opus', effort: 'xhigh', sessionId: 'S', resume: true }), ['-p', '--resume', 'S', ...tail]);
      assert.deepEqual(claudeCliArgs({ model: 'opus', effort: 'xhigh', resume: true }), ['-p', ...tail]);
    },
  },
  {
    name: 'claude runner: every CLI invocation appends the handoff reply-format system prompt right after the effort pair',
    run() {
      assert.equal(CLAUDE_HANDOFF_SYSTEM_PROMPT, 'You are answering a structured handoff from a desktop application. When the message asks for a JSON object, reply with only that JSON object, optionally inside one json code fence, with no text before or after it. When it asks for plain text, reply with only the requested text.');
      for (const options of [{}, { sessionId: 'S', resume: false }, { sessionId: 'S', resume: true }]) {
        const args = claudeCliArgs({ model: 'sonnet', effort: 'medium', ...options });
        const at = args.indexOf('--effort');
        assert.deepEqual(args.slice(at, at + 5), ['--effort', 'medium', '--append-system-prompt', CLAUDE_HANDOFF_SYSTEM_PROMPT, '--restricted']);
        assert.equal(args.filter(arg => arg === '--append-system-prompt').length, 1);
      }
    },
  },
  {
    name: 'claude runner driver: a correction prompt equal to the prompt still carries the numbered correction',
    async run() {
      const texts = await textsSentFor([
        { handoffCode: 'f1', stage: 'fact-check', prompt: 'FACT PROMPT' },
        { handoffCode: 'f1-r', stage: 'fact-check', prompt: 'FACT PROMPT', corrections: [FENCE_CORRECTION], correctionPrompt: 'FACT PROMPT' },
      ]);
      assert.equal(texts.length, 2);
      assert.equal(texts[0], 'FACT PROMPT');
      assert.equal(texts[1].startsWith('FACT PROMPT\n\n'), true);
      assert.equal(texts[1].endsWith(`\n1. ${FENCE_CORRECTION}`), true);
      assert.equal(texts[1], `FACT PROMPT${REJECTED_INTRO(1)}1. ${FENCE_CORRECTION}`);
    },
  },
  {
    name: 'claude runner driver: a correction prompt that already contains every correction is sent unchanged',
    async run() {
      const correctionPrompt = 'Fix these 2 items.\n1. alpha is missing\n2. beta is too long';
      const texts = await textsSentFor([
        { handoffCode: 'c1', stage: 'draft', prompt: 'P', corrections: ['alpha is missing', 'beta is too long'], correctionPrompt },
      ]);
      assert.deepEqual(texts, [correctionPrompt]);
    },
  },
  {
    name: 'claude runner driver: only corrections missing from a distinct correction prompt are appended, renumbered',
    async run() {
      const texts = await textsSentFor([
        { handoffCode: 'c1', stage: 'draft', prompt: 'P', corrections: ['alpha is missing', 'beta is too long'], correctionPrompt: 'Please fix: alpha is missing' },
      ]);
      assert.deepEqual(texts, [`Please fix: alpha is missing${REJECTED_INTRO(1)}1. beta is too long`]);
    },
  },
  {
    name: 'claude runner driver: two missing corrections are numbered and very long items are clipped head and tail',
    async run() {
      const long = `H${'a'.repeat(3000)}T`;
      const texts = await textsSentFor([
        { handoffCode: 'c1', stage: 'draft', prompt: 'P', corrections: ['', 'first', long, 7], correctionPrompt: 'P' },
      ]);
      const clipped = `${long.slice(0, 975)}…${long.slice(-524)}`;
      assert.equal(clipped.length, 1500);
      assert.deepEqual(texts, [`P${REJECTED_INTRO(2)}1. first\n2. ${clipped}`]);
    },
  },
  {
    name: 'claude runner driver: without corrections the prompt is sent unchanged',
    async run() {
      const texts = await textsSentFor([
        { handoffCode: 'c1', stage: 'draft', prompt: 'Plain prompt', correctionPrompt: 'ignored' },
        { handoffCode: 'c2', stage: 'draft', prompt: 'Second prompt', corrections: [], correctionPrompt: 'ignored too' },
      ]);
      assert.deepEqual(texts, ['Plain prompt', 'Second prompt']);
    },
  },
  {
    name: 'claude runner: a resumed stage spawns the CLI with --resume and the session id',
    async run() {
      const { promise, calls } = await stageWith({ stdout: `${resultLine({ models: ['claude-sonnet-5-5', 'claude-opus-5-5'] })}\n` }, { sessionId: 'abc', resume: true });
      assert.deepEqual(await promise, { text: 'final answer', model: 'claude-sonnet-5-5', durationMs: 42 });
      assert.deepEqual(calls[0].args.slice(0, 3), ['-p', '--resume', 'abc']);
    },
  },
  {
    name: 'claude runner: the default run guard is 120 runs per job',
    async run() {
      assert.equal(CLAUDE_MAX_RUNS_PER_JOB, 120);
      let runs = 0;
      const api = {
        async getHandoff() { return { handoff: { handoffCode: 'c', stage: 'draft', prompt: 'p', corrections: ['x'], correctionPrompt: 'again' } }; },
        async submitHandoff() { return { accepted: false, validationErrors: ['x'], handoff: {} }; },
        subscribeDiscards: () => () => {},
      };
      const runner = createClaudeApplicationRunner({
        api, stateFile: tempStateFile(), logger: quietLogger(), homedir: '',
        runStage: async () => { runs += 1; return { text: 'nope' }; },
      });
      runner.ensure({ jobId: 'job-guard', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-guard'])['job-guard']?.status === 'failed', 'failed', 10000);
      assert.equal(runs, 120);
      assert.equal(runner.status(['job-guard'])['job-guard'].message, 'Stopped after 120 Claude runs without finishing this application.');
      await runner.shutdown();
    },
  },
  {
    name: 'claude runner: child env strips ANTHROPIC_* and CLAUDE_CODE_USE_* and prefixes PATH',
    run() {
      const env = claudeChildEnv({
        ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1',
        HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg', PATH: '/usr/bin',
      }, '/opt/claude/bin');
      assert.deepEqual(env, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg', PATH: `/opt/claude/bin${path.delimiter}/usr/bin` });
    },
  },
  {
    name: 'claude runner: binary resolution walks PATH then fallbacks, and reports a missing CLI',
    run() {
      const found = resolveClaudeBinary({ env: { PATH: ['/a', '/b'].join(path.delimiter) }, homedir: '/home/me', isExecutable: p => p === path.join('/b', 'claude') });
      assert.equal(found, path.join('/b', 'claude'));
      const home = resolveClaudeBinary({ env: { PATH: '/a' }, homedir: '/home/me', isExecutable: p => p === path.join('/home/me', '.local', 'bin', 'claude') });
      assert.equal(home, path.join('/home/me', '.local', 'bin', 'claude'));
      assert.throws(() => resolveClaudeBinary({ env: { PATH: '/a' }, homedir: '/home/me', isExecutable: () => false }), error => {
        assert.equal(error.code, 'CLAUDE_CLI_MISSING');
        assert.equal(error.message, 'Claude Code is not installed or not on PATH. Install it and sign in with your Claude subscription, then retry.');
        return true;
      });
    },
  },
  {
    name: 'claude runner: input message carries the text then each page image in order',
    run() {
      const line = buildClaudeInputMessage({
        text: 'Review these pages',
        pageImages: [
          { candidateId: 'c1', document: 'resume', mimeType: 'image/png', data: 'AAA' },
          { candidateId: 'c2', document: 'cover-letter', data: 'BBB' },
        ],
      });
      assert.equal(line.endsWith('\n'), true);
      assert.equal(line.indexOf('\n'), line.length - 1);
      assert.deepEqual(JSON.parse(line), {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Review these pages' },
            { type: 'text', text: 'Page image 1: candidate c1, resume' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
            { type: 'text', text: 'Page image 2: candidate c2, cover-letter' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBB' } },
          ],
        },
      });
    },
  },
  {
    name: 'claude runner: stream parsing picks the last result line',
    run() {
      const text = [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        resultLine({ result: 'first' }),
        'not json',
        JSON.stringify({ type: 'assistant', message: {} }),
        resultLine({ result: 'second', models: ['claude-sonnet-5-5', 'claude-haiku'] }),
        '',
      ].join('\n');
      assert.deepEqual(parseClaudeStreamOutput(text), {
        isError: false, subtype: 'success', result: 'second', apiErrorStatus: null,
        models: ['claude-sonnet-5-5', 'claude-haiku'], sessionId: 's1', durationMs: 42,
      });
      assert.equal(parseClaudeStreamOutput(JSON.stringify({ type: 'assistant' })), null);
      assert.equal(parseClaudeStreamOutput(resultLine({ subtype: 'error_during_execution' })).isError, true);
    },
  },
  {
    name: 'claude runner: a stage spawns the CLI with the exact args, writes the input and returns the result',
    async run() {
      const { promise, calls } = await stageWith({ stdout: `${JSON.stringify({ type: 'system' })}\n${resultLine({ result: '{"ok":true}' })}\n` });
      const value = await promise;
      assert.deepEqual(value, { text: '{"ok":true}', model: 'claude-sonnet-5-5', durationMs: 42 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].binary, '/bin/claude');
      assert.deepEqual(calls[0].args, claudeCliArgs());
      assert.deepEqual(calls[0].options, { cwd: '/tmp/ws', env: { PATH: '/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
      assert.equal(calls[0].child.stdinText, buildClaudeInputMessage({ text: 'secret prompt', pageImages: [] }));
    },
  },
  {
    name: 'claude runner: an answer from another model is CLAUDE_WRONG_MODEL',
    async run() {
      const { promise } = await stageWith({ stdout: `${resultLine({ models: ['claude-opus-4-1'] })}\n` });
      const error = await rejection(promise);
      assert.equal(error instanceof ClaudeRunnerError, true);
      assert.equal(error.code, 'CLAUDE_WRONG_MODEL');
      assert.equal(error.message, 'Claude answered with claude-opus-4-1 instead of Sonnet.');
    },
  },
  {
    name: 'claude runner: Opus writes (xhigh) and judges (high); Sonnet converts (medium) and repairs and fact-checks (high)',
    run() {
      assert.deepEqual(JSON.parse(JSON.stringify(CLAUDE_STAGE_PROFILES)), {
        'editorial-plan': { model: 'opus', effort: 'xhigh' },
        write: { model: 'opus', effort: 'xhigh' },
        pick: { model: 'opus', effort: 'high' },
        convert: { model: 'sonnet', effort: 'medium' },
        'verify-correction': { model: 'sonnet', effort: 'high' },
        'fit-correction': { model: 'sonnet', effort: 'high' },
        'fact-check': { model: 'sonnet', effort: 'high' },
        'fact-correction': { model: 'sonnet', effort: 'high' },
        'fact-recheck': { model: 'sonnet', effort: 'high' },
      });
      // A stage the table does not name runs on the Sonnet high default.
      assert.deepEqual(claudeStageProfile('requirements-audit'), { model: 'sonnet', effort: 'high' });
      assert.deepEqual(claudeCliArgs(claudeStageProfile('write')).slice(0, 5), ['-p', '--model', 'opus', '--effort', 'xhigh']);
    },
  },
  {
    name: 'claude runner: an Opus stage spawns Opus and rejects a Sonnet answer as CLAUDE_WRONG_MODEL',
    async run() {
      const opus = claudeStageProfile('pick');
      const ok = await stageWith({ stdout: `${resultLine({ models: ['claude-opus-5-5'] })}\n` }, opus);
      assert.deepEqual(await ok.promise, { text: 'final answer', model: 'claude-opus-5-5', durationMs: 42 });
      assert.deepEqual(ok.calls[0].args, claudeCliArgs(opus));
      const wrong = await stageWith({ stdout: `${resultLine({ models: ['claude-sonnet-5-5'] })}\n` }, opus);
      const error = await rejection(wrong.promise);
      assert.equal(error.code, 'CLAUDE_WRONG_MODEL');
      assert.equal(error.message, 'Claude answered with claude-sonnet-5-5 instead of Opus.');
    },
  },
  {
    name: 'claude runner: the latest-model aliases accept any release of their own line and nothing else',
    run() {
      assert.equal(answeringModel('sonnet', ['claude-sonnet-5-5']), 'claude-sonnet-5-5');
      assert.equal(answeringModel('sonnet', ['claude-haiku-5-5', 'claude-sonnet-6-0']), 'claude-sonnet-6-0');
      assert.equal(answeringModel('opus', ['claude-opus-7-1']), 'claude-opus-7-1');
      assert.equal(answeringModel('opus', ['claude-sonnet-5-5']), null);
      assert.equal(answeringModel('sonnet', ['claude-opus-5-5', 'claude-haiku-5-5']), null);
      assert.equal(answeringModel('sonnet', []), null);
    },
  },
  {
    name: 'claude runner: api status 429 is CLAUDE_USAGE_LIMIT',
    async run() {
      const { promise } = await stageWith({ stdout: `${resultLine({ result: 'API Error 429', isError: true, apiErrorStatus: 429 })}\n`, code: 1 });
      const error = await rejection(promise);
      assert.equal(error.code, 'CLAUDE_USAGE_LIMIT');
      assert.equal(error.message, `${USAGE_MESSAGE} (API Error 429)`);
      assert.equal(error.message.includes('secret prompt'), false);
    },
  },
  {
    name: 'claude runner: usage-limit text is CLAUDE_USAGE_LIMIT; login text is CLAUDE_NOT_SIGNED_IN',
    async run() {
      const usage = await rejection((await stageWith({ stdout: `${resultLine({ result: "You've hit your limit · resets 5pm", isError: true })}\n`, code: 1 })).promise);
      assert.equal(usage.code, 'CLAUDE_USAGE_LIMIT');
      assert.equal(usage.message, `${USAGE_MESSAGE} (You've hit your limit · resets 5pm)`);
      const login = await rejection((await stageWith({ stdout: `${resultLine({ result: 'Not logged in · Please run /login', isError: true })}\n`, code: 1 })).promise);
      assert.equal(login.code, 'CLAUDE_NOT_SIGNED_IN');
      assert.equal(login.message, LOGIN_MESSAGE);
      const generic = classifyClaudeFailure({ parsed: null, stderr: 'segfault', exitCode: 2 });
      assert.equal(generic.code, 'CLAUDE_ERROR');
      assert.equal(generic.message, 'Claude Code failed (exit 2): segfault');
    },
  },
  {
    name: 'claude runner: only explicit provider error phrasing is classified as a safeguard block',
    async run() {
      const result = "API Error: Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations.\nDetails: `[reasoning_extraction]`\nRequest ID: req_011CgE69C2EX1378K7bDBwD2\nMessage ID: msg_011CgE69CGrrrez7psX9N3ji";
      const error = await rejection((await stageWith({ stdout: resultLine({ result, models: ['claude-opus-5-5'] }), code: 1 }, claudeStageProfile('write'))).promise);
      assert.equal(error.code, 'CLAUDE_SAFEGUARD_BLOCKED');
      assert.equal(error.result, result);
      assert.equal(error.detail.exitCode, 1);
      assert.equal(error.detail.subtype, 'success', 'nonzero CLI exit still establishes transport failure');
      assert.equal(error.detail.refusalCategory, 'reasoning_extraction');
      assert.equal(error.detail.requestId, 'req_011CgE69C2EX1378K7bDBwD2');
      assert.equal(error.detail.messageId, 'msg_011CgE69CGrrrez7psX9N3ji');
      const blocked = classifyClaudeFailure({ parsed: { result: 'Your request was blocked by our safeguards.' }, exitCode: 1 });
      assert.equal(blocked.code, 'CLAUDE_SAFEGUARD_BLOCKED');
      for (const mention of ['Please explain the safeguards in this system.', 'The user quoted “safeguards flagged this message” in a bug report.', 'A discussion of a blocked request and safeguards is not a provider rejection.']) {
        assert.equal(classifyClaudeFailure({ parsed: { result: mention }, exitCode: 1 }).code, 'CLAUDE_ERROR');
      }
      const normal = await stageWith({ stdout: resultLine({ result: 'Your request was blocked by our safeguards.' }) });
      assert.equal((await normal.promise).text, 'Your request was blocked by our safeguards.', 'a successful answer is not reclassified by its subject');
    },
  },
  {
    name: 'claude runner: timeout kills the child (TERM then KILL) and reports CLAUDE_TIMEOUT',
    async run() {
      const { calls, spawnImpl } = fakeSpawnFactory();
      const timers = [];
      const promise = runClaudeStage({
        text: 't', binary: '/bin/claude', env: {}, cwd: '/tmp', spawnImpl, timeoutMs: 3 * 60_000,
        setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeoutImpl: () => {},
      });
      assert.equal(timers.length, 1);
      assert.equal(timers[0].ms, 180_000);
      timers[0].fn();
      const error = await rejection(promise);
      assert.equal(error.code, 'CLAUDE_TIMEOUT');
      assert.equal(error.message, 'Claude did not finish this stage within 3 minutes.');
      assert.deepEqual(calls[0].child.kills, ['SIGTERM']);
      assert.equal(timers[1].ms, 5000);
      timers[1].fn();
      assert.deepEqual(calls[0].child.kills, ['SIGTERM', 'SIGKILL']);
    },
  },
  {
    name: 'claude runner: the default stage timeout is 45 minutes',
    run() {
      assert.equal(CLAUDE_STAGE_TIMEOUT_MS, 45 * 60_000);
    },
  },
  {
    name: 'claude runner driver: two stages then completed, each submitted with its code and the CLI text',
    async run() {
      const script = scriptedApi([
        { handoffCode: 'code-1', stage: 'draft', prompt: 'prompt one' },
        { handoffCode: 'code-2', stage: 'verify', prompt: 'prompt two' },
      ]);
      const texts = [];
      const stages = [];
      const notes = [];
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile: tempStateFile(), logger: quietLogger(), notify: n => notes.push(n),
        runStage: async ({ text, stage }) => { texts.push(text); stages.push(stage); return { text: `answer to ${text}` }; },
      });
      assert.deepEqual(runner.ensure({ jobId: 'job-happy', canvasFilePath: '/c.canvas' }), { status: 'running', stage: null });
      await waitFor(() => runner.status(['job-happy'])['job-happy']?.status === 'done', 'done');
      assert.deepEqual(texts, ['prompt one', 'prompt two']);
      // The runner tells runStage which stage it answers, so the stage picks its model.
      assert.deepEqual(stages, ['draft', 'verify']);
      assert.deepEqual(script.submits, [
        { jobId: 'job-happy', canvasFilePath: '/c.canvas', handoffCode: 'code-1', response: 'answer to prompt one', route: 'claude-runner' },
        { jobId: 'job-happy', canvasFilePath: '/c.canvas', handoffCode: 'code-2', response: 'answer to prompt two', route: 'claude-runner' },
      ]);
      assert.deepEqual(notes.filter(n => n.status === 'running' && n.stage).map(n => [n.stage, n.activity]),
        [['draft', 'waiting'], ['draft', 'running'], ['host-verification', 'running'],
          ['verify', 'waiting'], ['verify', 'running'], ['host-verification', 'running']]);
      assert.deepEqual(runner.ensure({ jobId: '', canvasFilePath: '/c.canvas' }), { status: 'invalid' });
    },
  },
  {
    name: 'claude runner driver: repeated discovery after completion never reopens a job during bundle cleanup',
    async run() {
      let reads = 0;
      let cleaned = false;
      const runner = createClaudeApplicationRunner({
        api: {
          getHandoff: async () => {
            reads += 1;
            if (cleaned) throw Object.assign(new Error('Private job manifest disappeared during save'), { code: 'LOCAL_AI_JOB_INTEGRITY' });
            return { completed: true };
          },
        },
        stateFile: tempStateFile(), logger: quietLogger(),
      });
      try {
        runner.ensure({ jobId: 'job-completed-cleanup', canvasFilePath: '/c.canvas' });
        await waitFor(() => runner.status(['job-completed-cleanup'])['job-completed-cleanup']?.status === 'done', 'completed job');
        cleaned = true;
        for (let index = 0; index < 3; index++) {
          assert.equal(runner.ensure({ jobId: 'job-completed-cleanup', canvasFilePath: '/c.canvas' }).status, 'done');
        }
        assert.equal(reads, 1);
        assert.equal(runner.status(['job-completed-cleanup'])['job-completed-cleanup'].status, 'done');
        // A deliberate retry may re-open host work; background discovery may not.
        cleaned = false;
        await runner.retry({ jobId: 'job-completed-cleanup', canvasFilePath: '/c.canvas' });
        await waitFor(() => reads === 2 && runner.status(['job-completed-cleanup'])['job-completed-cleanup']?.status === 'done', 'explicit retry');
      } finally { await runner.shutdown(); }
    },
  },
  {
    name: 'claude runner driver: a rejection resends the correction prompt, then acceptance completes',
    async run() {
      const script = scriptedApi([{ handoffCode: 'code-1', stage: 'draft', prompt: 'prompt one' }], { rejectFirst: true });
      const texts = [];
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile: tempStateFile(), logger: quietLogger(),
        runStage: async ({ text }) => { texts.push(text); return { text: `a${texts.length}` }; },
      });
      runner.ensure({ jobId: 'job-reject', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-reject'])['job-reject']?.status === 'done', 'done');
      assert.deepEqual(texts, ['prompt one', `fix draft${REJECTED_INTRO(1)}1. too vague`]);
      assert.deepEqual(script.submits.map(s => [s.handoffCode, s.response]), [['code-1', 'a1'], ['code-1-r', 'a2']]);
    },
  },
  {
    name: 'claude runner driver: the human review stop is needs-review and runs nothing',
    async run() {
      const script = scriptedApi([{ handoffCode: 'h', stage: 'write-verify-human-stop', prompt: 'p' }]);
      let runs = 0;
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile: tempStateFile(), logger: quietLogger(),
        runStage: async () => { runs += 1; return { text: 'x' }; },
      });
      runner.ensure({ jobId: 'job-human', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-human'])['job-human']?.status === 'needs-review', 'needs-review');
      assert.equal(runs, 0);
      assert.equal(script.submits.length, 0);
    },
  },
  {
    name: 'claude runner driver: a usage-limit failure persists, is never re-run by ensure, survives reload, and retry re-runs',
    async run() {
      const stateFile = tempStateFile();
      const script = scriptedApi([{ handoffCode: 'code-1', stage: 'draft', prompt: 'prompt one' }]);
      let runs = 0;
      let failNext = true;
      const logger = quietLogger();
      const runStage = async () => {
        runs += 1;
        if (failNext) { failNext = false; throw new ClaudeRunnerError('CLAUDE_USAGE_LIMIT', USAGE_MESSAGE); }
        return { text: 'fine' };
      };
      const runner = createClaudeApplicationRunner({ api: script.api, stateFile, logger, runStage });
      runner.ensure({ jobId: 'job-usage-1', canvasFilePath: '/c.canvas' });
      await waitFor(() => fs.existsSync(stateFile), 'state file');
      const state = runner.status(['job-usage-1'])['job-usage-1'];
      assert.equal(state.status, 'failed');
      assert.equal(state.code, 'CLAUDE_USAGE_LIMIT');
      assert.equal(state.stage, 'draft');
      assert.equal(state.message, USAGE_MESSAGE);
      const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.deepEqual(Object.keys(persisted), ['failed', 'sessions']);
      assert.deepEqual(Object.keys(persisted.failed), ['job-usage-1']);
      assert.equal(persisted.failed['job-usage-1'].code, 'CLAUDE_USAGE_LIMIT');
      assert.equal(persisted.failed['job-usage-1'].status, 'failed');
      assert.deepEqual(logger.errors, ['[ClaudeRunner] job=job-usag stage=draft code=CLAUDE_USAGE_LIMIT']);

      const again = runner.ensure({ jobId: 'job-usage-1', canvasFilePath: '/c.canvas' });
      assert.equal(again.status, 'failed');
      assert.equal(again.code, 'CLAUDE_USAGE_LIMIT');
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(runs, 1);
      assert.equal(script.submits.length, 0);

      const reloaded = createClaudeApplicationRunner({ api: script.api, stateFile, logger: quietLogger(), runStage: async () => { throw new Error('must not run'); } });
      await reloaded.load();
      const restored = reloaded.status(['job-usage-1'])['job-usage-1'];
      assert.equal(restored.status, 'failed');
      assert.equal(restored.code, 'CLAUDE_USAGE_LIMIT');
      assert.equal(reloaded.ensure({ jobId: 'job-usage-1', canvasFilePath: '/c.canvas' }).status, 'failed');

      const retried = await runner.retry({ jobId: 'job-usage-1', canvasFilePath: '/c.canvas' });
      assert.equal(retried.status, 'running');
      await waitFor(() => runner.status(['job-usage-1'])['job-usage-1']?.status === 'done', 'done after retry');
      assert.equal(runs, 2);
      assert.deepEqual(script.submits.map(s => s.response), ['fine']);
      await runner.shutdown();
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { failed: {}, sessions: {} });
    },
  },
  {
    name: 'claude runner driver: a bridge-laned job is left to the bridge',
    async run() {
      const script = scriptedApi([{ handoffCode: 'c', stage: 'draft', prompt: 'p' }]);
      let runs = 0;
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile: tempStateFile(), logger: quietLogger(), isBridgeLaned: id => id === 'job-bridge',
        runStage: async () => { runs += 1; return { text: 'x' }; },
      });
      assert.deepEqual(runner.ensure({ jobId: 'job-bridge', canvasFilePath: '/c.canvas' }), { status: 'bridge' });
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(runs, 0);
      assert.equal(script.reads.length, 0);
    },
  },
  {
    name: 'claude runner driver: a discard aborts the running stage and records no failure',
    async run() {
      const script = scriptedApi([{ handoffCode: 'c', stage: 'draft', prompt: 'p' }]);
      const logger = quietLogger();
      const notes = [];
      let seenSignal = null;
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile: tempStateFile(), logger, notify: n => notes.push(n),
        runStage: ({ signal }) => new Promise((_resolve, reject) => {
          seenSignal = signal;
          signal.addEventListener('abort', () => reject(new ClaudeRunnerError('CLAUDE_CANCELLED', 'cancelled')));
        }),
      });
      runner.ensure({ jobId: 'job-discard', canvasFilePath: '/c.canvas' });
      await waitFor(() => seenSignal !== null, 'stage start');
      script.discard({ jobId: 'job-discard', canvasFilePath: '/c.canvas', cause: 'bundle_discarded' });
      assert.equal(seenSignal.aborted, true);
      await runner.shutdown();
      assert.deepEqual(runner.status(['job-discard']), {});
      assert.equal(notes.at(-1).status, 'done');
      assert.deepEqual(logger.errors, []);
      assert.equal(script.submits.length, 0);
    },
  },
  {
    name: 'claude runner driver: shutdown cancels a run without recording a failure',
    async run() {
      const stateFile = tempStateFile();
      const script = scriptedApi([{ handoffCode: 'c', stage: 'draft', prompt: 'p' }]);
      const logger = quietLogger();
      let started = false;
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile, logger,
        runStage: ({ signal }) => new Promise((_resolve, reject) => {
          started = true;
          signal.addEventListener('abort', () => reject(new ClaudeRunnerError('CLAUDE_CANCELLED', 'cancelled')));
        }),
      });
      runner.ensure({ jobId: 'job-shutdown', canvasFilePath: '/c.canvas' });
      await waitFor(() => started, 'stage start');
      await runner.shutdown();
      assert.notEqual(runner.status(['job-shutdown'])['job-shutdown']?.status, 'failed');
      assert.equal(fs.existsSync(stateFile), false);
      assert.deepEqual(logger.errors, []);
    },
  },
  {
    name: 'claude runner driver: concurrency never exceeds the limit across jobs',
    async run() {
      let active = 0;
      let maxActive = 0;
      let total = 0;
      const apis = new Map();
      const api = {
        async getHandoff({ jobId }) {
          return apis.get(jobId) ? { completed: true } : { handoff: { handoffCode: `code-${jobId}`, stage: 'draft', prompt: `p-${jobId}` } };
        },
        async submitHandoff({ jobId }) { apis.set(jobId, true); return { accepted: true, completed: true }; },
        subscribeDiscards: () => () => {},
      };
      const runner = createClaudeApplicationRunner({
        api, stateFile: tempStateFile(), logger: quietLogger(), concurrency: 2,
        runStage: async () => {
          active += 1; total += 1; maxActive = Math.max(maxActive, active);
          await new Promise(resolve => setTimeout(resolve, 5));
          active -= 1;
          return { text: 'ok' };
        },
      });
      const ids = ['j1', 'j2', 'j3', 'j4', 'j5'];
      for (const id of ids) runner.ensure({ jobId: id, canvasFilePath: '/c.canvas' });
      await waitFor(() => ids.every(id => runner.status([id])[id]?.status === 'done'), 'all done');
      assert.equal(total, 5);
      assert.equal(maxActive, 2);
    },
  },
  {
    name: 'claude runner driver: parallel tasks are each answered with their matchTaskId',
    async run() {
      const done = new Set();
      const submits = [];
      const reads = [];
      const api = {
        async getHandoff({ matchTaskId }) {
          reads.push(matchTaskId ?? null);
          if (matchTaskId) {
            return done.has(matchTaskId) ? { completed: true } : { handoff: { handoffCode: `code-${matchTaskId}`, stage: 'match', prompt: `prompt-${matchTaskId}` } };
          }
          if (done.has('t1') && done.has('t2')) return { completed: true };
          return { handoff: { handoffCode: 'main', stage: 'match-wave', prompt: 'unused', parallelTasks: [{ id: 't1' }, { id: 't2' }] } };
        },
        async submitHandoff(args) {
          submits.push(args);
          done.add(args.matchTaskId);
          return { accepted: true, completed: true };
        },
        subscribeDiscards: () => () => {},
      };
      const texts = [];
      const runner = createClaudeApplicationRunner({
        api, stateFile: tempStateFile(), logger: quietLogger(),
        runStage: async ({ text }) => { texts.push(text); return { text: `answer-${text}` }; },
      });
      runner.ensure({ jobId: 'job-par', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-par'])['job-par']?.status === 'done', 'done');
      assert.deepEqual([...texts].sort(), ['prompt-t1', 'prompt-t2']);
      assert.deepEqual([...submits].sort((a, b) => a.matchTaskId.localeCompare(b.matchTaskId)), [
        { jobId: 'job-par', canvasFilePath: '/c.canvas', matchTaskId: 't1', handoffCode: 'code-t1', response: 'answer-prompt-t1', route: 'claude-runner' },
        { jobId: 'job-par', canvasFilePath: '/c.canvas', matchTaskId: 't2', handoffCode: 'code-t2', response: 'answer-prompt-t2', route: 'claude-runner' },
      ]);
      assert.equal(texts.includes('unused'), false);
    },
  },
  {
    name: 'claude runner driver: exceeding maxRunsPerJob fails with CLAUDE_TOO_MANY_RUNS',
    async run() {
      let runs = 0;
      const api = {
        async getHandoff() { return { handoff: { handoffCode: 'c', stage: 'draft', prompt: 'p', corrections: ['x'], correctionPrompt: 'again' } }; },
        async submitHandoff() { return { accepted: false, validationErrors: ['x'], handoff: {} }; },
        subscribeDiscards: () => () => {},
      };
      const runner = createClaudeApplicationRunner({
        api, stateFile: tempStateFile(), logger: quietLogger(), maxRunsPerJob: 3,
        runStage: async () => { runs += 1; return { text: 'nope' }; },
      });
      runner.ensure({ jobId: 'job-loop', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-loop'])['job-loop']?.status === 'failed', 'failed');
      const state = runner.status(['job-loop'])['job-loop'];
      assert.equal(runs, 3);
      assert.equal(state.code, 'CLAUDE_TOO_MANY_RUNS');
      assert.equal(state.message, 'Stopped after 3 Claude runs without finishing this application.');
      await runner.shutdown();
    },
  },
  {
    name: 'claude runner driver: an application error is APPLICATION_ERROR with the error code in detail-free state',
    async run() {
      const api = {
        async getHandoff() { const error = new Error('Job integrity fault'); error.code = 'EINTEGRITY'; throw error; },
        async submitHandoff() { throw new Error('unreachable'); },
        subscribeDiscards: () => () => {},
      };
      const runner = createClaudeApplicationRunner({ api, stateFile: tempStateFile(), logger: quietLogger(), runStage: async () => ({ text: 'x' }) });
      runner.ensure({ jobId: 'job-apperr', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-apperr'])['job-apperr']?.status === 'failed', 'failed');
      const state = runner.status(['job-apperr'])['job-apperr'];
      assert.equal(state.code, 'APPLICATION_ERROR');
      assert.equal(state.message, 'Job integrity fault');
      await runner.shutdown();
    },
  },
  {
    name: 'claude runner sessions: a correction round resumes the same Claude session',
    async run() {
      const script = sequenceApi([
        { handoffCode: 'r1', stage: 'requirements', prompt: 'full schema prompt' },
        { handoffCode: 'r1-fix', stage: 'requirements', prompt: 'full schema prompt', corrections: ['bad json'], correctionPrompt: 'Do not start over; fix it' },
      ]);
      const calls = [];
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile: tempStateFile(), logger: quietLogger(), homedir: tempHome(),
        runStage: async ({ text, sessionId, resume }) => { calls.push({ text, sessionId, resume }); return { text: '{}' }; },
      });
      runner.ensure({ jobId: 'job-correct', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-correct'])['job-correct']?.status === 'done', 'done');
      await runner.shutdown();
      assert.equal(calls.length, 2);
      assert.match(calls[0].sessionId, UUID_RE);
      assert.deepEqual(calls, [
        { text: 'full schema prompt', sessionId: calls[0].sessionId, resume: false },
        { text: `Do not start over; fix it${REJECTED_INTRO(1)}1. bad json`, sessionId: calls[0].sessionId, resume: true },
      ]);
    },
  },
  {
    name: 'claude runner sessions: the bridge new-chat rule decides fresh sessions by key, then by stage',
    async run() {
      const script = sequenceApi([
        withFresh({ handoffCode: 'h1', stage: 'a', prompt: 'p1' }, true, 'k1'),
        withFresh({ handoffCode: 'h2', stage: 'a', prompt: 'p2' }, true, 'k2'),
        withFresh({ handoffCode: 'h3', stage: 'b', prompt: 'p3' }, true, 'k2'),
        withFresh({ handoffCode: 'h4', stage: 'c', prompt: 'p4' }, true),
        withFresh({ handoffCode: 'h5', stage: 'c', prompt: 'p5' }, true),
        { handoffCode: 'h6', stage: 'd', prompt: 'p6' },
      ]);
      // The app's fields are non-enumerable: a spread does not carry them.
      assert.equal({ ...script.handoffs[0] }.freshContextRequired, undefined);
      assert.equal(script.handoffs[0].freshContextRequired, true);
      const calls = [];
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile: tempStateFile(), logger: quietLogger(), homedir: tempHome(),
        runStage: async ({ sessionId, resume }) => { calls.push({ sessionId, resume }); return { text: 'ok' }; },
      });
      runner.ensure({ jobId: 'job-fresh', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-fresh'])['job-fresh']?.status === 'done', 'done');
      await runner.shutdown();
      assert.equal(calls.length, 6);
      const [s1, s2, s3] = [calls[0].sessionId, calls[1].sessionId, calls[3].sessionId];
      assert.equal(new Set([s1, s2, s3]).size, 3);
      for (const id of [s1, s2, s3]) assert.match(id, UUID_RE);
      assert.deepEqual(calls, [
        { sessionId: s1, resume: false },
        { sessionId: s2, resume: false }, // new key
        { sessionId: s2, resume: true }, // same key keeps the chat although the stage changed
        { sessionId: s3, resume: false }, // no key, changed stage
        { sessionId: s3, resume: true }, // no key, same stage
        { sessionId: s3, resume: true }, // no fresh requirement
      ]);
    },
  },
  {
    name: 'claude runner sessions: a first run that fails is never resumed; retry starts a new session',
    async run() {
      const script = sequenceApi([{ handoffCode: 'h1', stage: 'draft', prompt: 'p1' }]);
      const calls = [];
      let failNext = true;
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile: tempStateFile(), logger: quietLogger(), homedir: tempHome(),
        runStage: async ({ sessionId, resume }) => {
          calls.push({ sessionId, resume });
          if (failNext) { failNext = false; throw new ClaudeRunnerError('CLAUDE_USAGE_LIMIT', USAGE_MESSAGE); }
          return { text: 'ok' };
        },
      });
      runner.ensure({ jobId: 'job-first-fail', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-first-fail'])['job-first-fail']?.status === 'failed', 'failed');
      await runner.retry({ jobId: 'job-first-fail', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-first-fail'])['job-first-fail']?.status === 'done', 'done');
      await runner.shutdown();
      assert.equal(calls.length, 2);
      assert.match(calls[0].sessionId, UUID_RE);
      assert.match(calls[1].sessionId, UUID_RE);
      assert.notEqual(calls[1].sessionId, calls[0].sessionId);
      assert.deepEqual(calls.map(c => c.resume), [false, false]);
    },
  },
  {
    name: 'claude runner sessions: retry after a failure in a started chat resumes it, also across a reload',
    async run() {
      const stateFile = tempStateFile();
      const home = tempHome();
      const correctionScript = () => sequenceApi([
        { handoffCode: 'r1', stage: 'requirements', prompt: 'p' },
        { handoffCode: 'r1-fix', stage: 'requirements', prompt: 'p', corrections: ['x'], correctionPrompt: 'fix' },
      ]);
      const scripts = { 'job-same': correctionScript(), 'job-reload': correctionScript() };
      const api = {
        getHandoff: args => scripts[args.jobId].api.getHandoff(args),
        submitHandoff: args => scripts[args.jobId].api.submitHandoff(args),
        subscribeDiscards: () => () => {},
      };
      const calls = { 'job-same': [], 'job-reload': [] };
      const makeRunner = (jobId, failSecond) => createClaudeApplicationRunner({
        api, stateFile, logger: quietLogger(), homedir: home,
        runStage: async ({ sessionId, resume, text }) => {
          calls[jobId].push({ sessionId, resume, text });
          if (failSecond && calls[jobId].length === 2) throw new ClaudeRunnerError('CLAUDE_USAGE_LIMIT', USAGE_MESSAGE);
          return { text: 'ok' };
        },
      });

      const same = makeRunner('job-same', true);
      same.ensure({ jobId: 'job-same', canvasFilePath: '/c.canvas' });
      await waitFor(() => same.status(['job-same'])['job-same']?.status === 'failed', 'same failed');
      await same.retry({ jobId: 'job-same', canvasFilePath: '/c.canvas' });
      await waitFor(() => same.status(['job-same'])['job-same']?.status === 'done', 'same done');
      await same.shutdown();
      const sameId = calls['job-same'][0].sessionId;
      assert.match(sameId, UUID_RE);
      assert.deepEqual(calls['job-same'], [
        { sessionId: sameId, resume: false, text: 'p' },
        { sessionId: sameId, resume: true, text: 'fix' },
        { sessionId: sameId, resume: true, text: 'fix' },
      ]);

      const first = makeRunner('job-reload', true);
      first.ensure({ jobId: 'job-reload', canvasFilePath: '/c.canvas' });
      await waitFor(() => first.status(['job-reload'])['job-reload']?.status === 'failed', 'reload failed');
      await first.shutdown();
      const reloadId = calls['job-reload'][0].sessionId;
      assert.match(reloadId, UUID_RE);
      const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.deepEqual(persisted.sessions, {
        'job-reload': { main: { sessionId: reloadId, started: true, contextKey: null, stage: 'requirements' } },
      });
      assert.equal(persisted.failed['job-reload'].code, 'CLAUDE_USAGE_LIMIT');

      const second = makeRunner('job-reload', false);
      await second.load();
      assert.equal(second.status(['job-reload'])['job-reload'].status, 'failed');
      await second.retry({ jobId: 'job-reload', canvasFilePath: '/c.canvas' });
      await waitFor(() => second.status(['job-reload'])['job-reload']?.status === 'done', 'reload done');
      await second.shutdown();
      assert.deepEqual(calls['job-reload'], [
        { sessionId: reloadId, resume: false, text: 'p' },
        { sessionId: reloadId, resume: true, text: 'fix' },
        { sessionId: reloadId, resume: true, text: 'fix' },
      ]);
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { failed: {}, sessions: {} });
    },
  },
  {
    name: 'claude runner sessions: an old-format state file still loads; a malformed one loads empty with a warning',
    async run() {
      const stateFile = tempStateFile();
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const old = { jobId: 'job-old', canvasFilePath: '/c.canvas', status: 'failed', stage: 'draft', code: 'CLAUDE_USAGE_LIMIT', message: USAGE_MESSAGE, updatedAt: 5 };
      fs.writeFileSync(stateFile, JSON.stringify({ 'job-old': old }));
      const runner = createClaudeApplicationRunner({ api: sequenceApi([]).api, stateFile, logger: quietLogger(), homedir: tempHome(), runStage: async () => { throw new Error('must not run'); } });
      await runner.load();
      assert.deepEqual(runner.status(['job-old']), { 'job-old': old });
      assert.equal(runner.ensure({ jobId: 'job-old', canvasFilePath: '/c.canvas' }).status, 'failed');

      const badFile = tempStateFile();
      fs.mkdirSync(path.dirname(badFile), { recursive: true });
      fs.writeFileSync(badFile, JSON.stringify({ failed: [], sessions: {} }));
      const logger = quietLogger();
      const bad = createClaudeApplicationRunner({ api: sequenceApi([]).api, stateFile: badFile, logger, homedir: tempHome(), runStage: async () => ({ text: 'x' }) });
      await bad.load();
      assert.deepEqual(logger.warns, ['[ClaudeRunner] ignoring malformed runner state file']);
    },
  },
  {
    name: 'claude runner sessions: a done job removes only its own transcripts and its persisted sessions',
    async run() {
      const home = tempHome();
      const projA = path.join(home, '.claude', 'projects', 'projA');
      const projB = path.join(home, '.claude', 'projects', 'projB');
      fs.mkdirSync(projA, { recursive: true });
      fs.mkdirSync(projB, { recursive: true });
      fs.writeFileSync(path.join(projA, 'other.jsonl'), '{}\n');
      const stateFile = tempStateFile();
      const script = sequenceApi([{ handoffCode: 'h1', stage: 'draft', prompt: 'p1' }]);
      const seen = [];
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile, logger: quietLogger(), homedir: home,
        runStage: async ({ sessionId }) => {
          seen.push(sessionId);
          fs.writeFileSync(path.join(projA, `${sessionId}.jsonl`), '{}\n');
          fs.mkdirSync(path.join(projB, sessionId, 'subagents'), { recursive: true });
          return { text: 'ok' };
        },
      });
      runner.ensure({ jobId: 'job-clean', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-clean'])['job-clean']?.status === 'done', 'done');
      await runner.shutdown();
      assert.equal(seen.length, 1);
      assert.match(seen[0], UUID_RE);
      assert.equal(fs.existsSync(path.join(projA, `${seen[0]}.jsonl`)), false);
      assert.equal(fs.existsSync(path.join(projB, seen[0])), false);
      assert.deepEqual(fs.readdirSync(projA), ['other.jsonl']);
      assert.equal(fs.readFileSync(path.join(projA, 'other.jsonl'), 'utf8'), '{}\n');
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { failed: {}, sessions: {} });
    },
  },
  {
    name: 'claude runner sessions: a replaced lane session loses its transcript when the fresh session starts',
    async run() {
      const home = tempHome();
      const projA = path.join(home, '.claude', 'projects', 'projA');
      fs.mkdirSync(projA, { recursive: true });
      fs.writeFileSync(path.join(projA, 'other.jsonl'), '{}\n');
      const stateFile = tempStateFile();
      const script = sequenceApi([
        withFresh({ handoffCode: 'h1', stage: 'write', prompt: 'p1' }, true, 'cand-1'),
        withFresh({ handoffCode: 'h2', stage: 'write', prompt: 'p2' }, true, 'cand-2'),
        { handoffCode: 'h3', stage: 'write', prompt: 'p3' },
      ]);
      const calls = [];
      const observed = [];
      const file = id => path.join(projA, `${id}.jsonl`);
      const logger = quietLogger();
      const runner = createClaudeApplicationRunner({ runLogPath: null,
        api: script.api, stateFile, logger, homedir: home,
        runStage: async ({ sessionId, resume }) => {
          calls.push({ sessionId, resume });
          if (calls.length === 2) {
            // The replaced first session's transcript goes away while the second session runs.
            await waitFor(() => !fs.existsSync(file(calls[0].sessionId)), 'replaced transcript removed');
          }
          if (!resume) fs.writeFileSync(file(sessionId), '{}\n');
          observed.push({ first: fs.existsSync(file(calls[0].sessionId)), current: fs.existsSync(file(sessionId)) });
          return { text: 'ok' };
        },
      });
      runner.ensure({ jobId: 'job-replace', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-replace'])['job-replace']?.status === 'done', 'done');
      await runner.shutdown();
      assert.equal(calls.length, 3);
      const [s1, s2] = [calls[0].sessionId, calls[1].sessionId];
      assert.match(s1, UUID_RE);
      assert.match(s2, UUID_RE);
      assert.notEqual(s1, s2);
      assert.deepEqual(calls, [
        { sessionId: s1, resume: false },
        { sessionId: s2, resume: false },
        { sessionId: s2, resume: true },
      ]);
      // Before completion: the first file was there during its run, gone once the
      // second session started; the second session's file survived until done.
      assert.deepEqual(observed, [
        { first: true, current: true },
        { first: false, current: true },
        { first: false, current: true },
      ]);
      assert.equal(fs.existsSync(file(s1)), false);
      assert.equal(fs.existsSync(file(s2)), false);
      assert.deepEqual(fs.readdirSync(projA), ['other.jsonl']);
      assert.deepEqual(logger.warns, []);
    },
  },
  {
    name: 'claude runner sessions: a failing transcript removal for a replaced session is logged and never fails the run',
    async run() {
      const home = tempHome();
      fs.mkdirSync(path.join(home, '.claude', 'projects', 'projA'), { recursive: true });
      const realFs = fs.promises;
      const fsImpl = {
        mkdir: (...args) => realFs.mkdir(...args),
        writeFile: (...args) => realFs.writeFile(...args),
        rename: (...args) => realFs.rename(...args),
        readFile: (...args) => realFs.readFile(...args),
        readdir: (...args) => realFs.readdir(...args),
        rm: async () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; },
      };
      const script = sequenceApi([
        withFresh({ handoffCode: 'h1', stage: 'write', prompt: 'SECRET-PROMPT-1' }, true, 'cand-1'),
        withFresh({ handoffCode: 'h2', stage: 'write', prompt: 'SECRET-PROMPT-2' }, true, 'cand-2'),
      ]);
      const logger = quietLogger();
      const calls = [];
      const runner = createClaudeApplicationRunner({ runLogPath: null,
        api: script.api, stateFile: tempStateFile(), logger, homedir: home, fsImpl,
        runStage: async ({ sessionId, resume }) => { calls.push({ sessionId, resume }); return { text: 'ok' }; },
      });
      runner.ensure({ jobId: 'job-rm-fail', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-rm-fail'])['job-rm-fail']?.status === 'done', 'done');
      await runner.shutdown();
      assert.equal(calls.length, 2);
      assert.notEqual(calls[0].sessionId, calls[1].sessionId);
      assert.deepEqual(logger.errors, []);
      assert.equal(logger.warns.length > 0, true);
      for (const warn of logger.warns) {
        assert.equal(warn, '[ClaudeRunner] could not remove a Claude session transcript: EACCES');
      }
    },
  },
  {
    name: 'claude runner run log: correlated start, response and verdict events are durable before submit and completion',
    async run() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runlog-'));
      const logFile = path.join(dir, 'runs.jsonl');
      const handoffs = [
        { handoffCode: 'code-1', stage: 'requirements', prompt: 'prompt one' },
        { handoffCode: 'code-1', stage: 'requirements', prompt: 'prompt one', corrections: ['Fix item A.'], correctionPrompt: 'prompt one' },
      ];
      let reads = 0;
      const submits = [];
      const api = {
        getHandoff: async () => (reads < 2 ? { handoff: handoffs[reads++] } : { completed: true }),
        submitHandoff: async (args) => {
          // The returned answer is on disk before any application mutation.
          const latest = readRunLog(logFile).at(-1);
          assert.equal(latest.event, 'response');
          assert.equal(latest.answer, args.response);
          submits.push(args);
          return submits.length === 1 ? { accepted: false, validationErrors: ['Fix item A.'] } : { accepted: true, completed: true };
        },
      };
      const runner = createClaudeApplicationRunner({
        api, stateFile: path.join(dir, 'state.json'), logger: quietLogger(), homedir: dir,
        runLogPath: (jobId, canvasFilePath) => { assert.equal(jobId, 'job-log'); assert.equal(canvasFilePath, '/c.canvas'); return logFile; },
        runStage: async ({ text }) => ({ text: `answer to ${text.length}`, model: 'claude-sonnet-5-5', durationMs: 7 }),
      });
      runner.ensure({ jobId: 'job-log', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-log'])['job-log']?.status === 'done', 'done');
      assert.equal(readRunLog(logFile).at(-1).event, 'submission', 'completion waits for the final app verdict append');
      await runner.shutdown();
      const rows = readRunLog(logFile);
      assert.deepEqual(rows.map(row => row.event), ['started', 'response', 'submission', 'started', 'response', 'submission']);
      const [first, second] = [rows.slice(0, 3), rows.slice(3)];
      for (const group of [first, second]) {
        assert.match(group[0].runId, UUID_RE);
        assert.equal(new Set(group.map(row => row.runId)).size, 1);
        assert.equal(new Set(group.map(row => row.handoffSha256)).size, 1);
        for (const row of group) {
          assert.deepEqual([row.version, row.stage, row.requestedModel, row.requestedEffort], [2, 'requirements', 'sonnet', 'high']);
          assert.match(row.handoffSha256, /^[0-9a-f]{64}$/);
          assert.match(row.promptSha256, /^[0-9a-f]{64}$/);
          assert.equal(Number.isFinite(Date.parse(row.at)), true);
        }
      }
      assert.notEqual(first[0].runId, second[0].runId);
      assert.deepEqual([first[1].model, first[1].durationMs, first[1].resume], ['claude-sonnet-5-5', 7, false]);
      assert.deepEqual([second[1].model, second[1].durationMs, second[1].resume], ['claude-sonnet-5-5', 7, true]);
      assert.equal(first[0].sessionId, second[0].sessionId);
      assert.deepEqual(first[2].submit, { accepted: false, completed: false, validationErrors: ['Fix item A.'] });
      assert.deepEqual(second[2].submit, { accepted: true, completed: true });
      assert.equal(first[1].answer, `answer to ${'prompt one'.length}`);
      assert.equal(first[0].promptChars, 'prompt one'.length);
      // The second prompt carried the rejection: its text differs from the first.
      assert.notEqual(second[0].promptSha256, first[0].promptSha256);
    },
  },
  {
    name: 'claude runner run log: a failed Claude run is recorded with its error code',
    async run() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runlog-'));
      const logFile = path.join(dir, 'runs.jsonl');
      const api = { getHandoff: async () => ({ handoff: { handoffCode: 'c', stage: 'write', prompt: 'p' } }), submitHandoff: async () => ({ accepted: true, completed: true }) };
      const runner = createClaudeApplicationRunner({
        api, stateFile: path.join(dir, 'state.json'), logger: quietLogger(), homedir: dir, runLogPath: () => logFile,
        runStage: async () => { throw new ClaudeRunnerError('CLAUDE_USAGE_LIMIT', 'Claude usage limit reached.'); },
      });
      runner.ensure({ jobId: 'job-fail-log', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-fail-log'])['job-fail-log']?.status === 'failed', 'failed');
      await runner.shutdown();
      const rows = readRunLog(logFile);
      assert.deepEqual(rows.map(row => row.event), ['started', 'failed']);
      assert.equal(rows[0].runId, rows[1].runId);
      assert.deepEqual([rows[1].stage, rows[1].error], ['write', { code: 'CLAUDE_USAGE_LIMIT', message: 'Claude usage limit reached.' }]);
      assert.deepEqual([rows[0].requestedModel, rows[0].requestedEffort], ['opus', 'xhigh']);
      assert.equal('answer' in rows[1], false);
    },
  },
  {
    name: 'claude runner run log: terminal provider errors retain complete plain results and only whitelisted metadata',
    async run() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runlog-'));
      const logFile = path.join(dir, 'runs.jsonl');
      const result = `Provider request failed. ${'More explicit error context. '.repeat(40)}END OF RESULT`;
      const stream = [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' }] } }),
        resultLine({ result, isError: true, subtype: 'error_during_execution', apiErrorStatus: 403 }),
      ].join('\n');
      const failure = await rejection((await stageWith({ stdout: stream, code: 1 })).promise);
      assert.equal(failure.result, result);
      // Future transport metadata must never pass through by object spread.
      Object.assign(failure.detail, { rawStream: stream, thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE', secret: 'PRIVATE_SECRET' });
      let submits = 0;
      const runner = createClaudeApplicationRunner({
        api: {
          getHandoff: async () => ({ handoff: { handoffCode: 'c', stage: 'convert', prompt: 'PRIVATE_PROMPT' } }),
          submitHandoff: async () => { submits += 1; return { accepted: true, completed: true }; },
        },
        stateFile: path.join(dir, 'state.json'), logger: quietLogger(), homedir: dir, runLogPath: () => logFile,
        runStage: async () => { throw failure; },
      });
      runner.ensure({ jobId: 'job-provider-error', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-provider-error'])['job-provider-error']?.status === 'failed', 'failed');
      await runner.shutdown();
      const rows = readRunLog(logFile);
      assert.deepEqual(rows.map(row => row.event), ['started', 'failed']);
      assert.equal(rows[1].result, result);
      assert.deepEqual(rows[1].error.detail, { exitCode: 1, subtype: 'error_during_execution', apiErrorStatus: 403, models: ['claude-sonnet-5-5'], durationMs: 42 });
      assert.equal(submits, 0);
      assert.doesNotMatch(fs.readFileSync(logFile, 'utf8'), /PRIVATE_(?:THINKING|SIGNATURE|SECRET|PROMPT)|rawStream/u);
    },
  },
  {
    name: 'claude runner run log: a safeguard error emitted only on stderr retains its plain message without stream records',
    async run() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runlog-'));
      const logFile = path.join(dir, 'runs.jsonl');
      const providerMessage = "API Error: Opus 5.5's safeguards flagged this message.\n\nDetails: `[reasoning_extraction]`\nRequest ID: req_011CgE69C2EX1378K7bDBwD2\nMessage ID: msg_011CgE69CGrrrez7psX9N3ji";
      const privateStream = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' }] } });
      const failure = await rejection((await stageWith({ stdout: privateStream, stderr: `${providerMessage}\n${privateStream}\n`, code: 1 }, claudeStageProfile('write'))).promise);
      assert.equal(failure.code, 'CLAUDE_SAFEGUARD_BLOCKED');
      assert.equal(failure.result, providerMessage);
      const script = scriptedApi([{ handoffCode: 'c', stage: 'write', prompt: 'PRIVATE_PROMPT' }]);
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile: path.join(dir, 'state.json'), logger: quietLogger(), homedir: dir, runLogPath: () => logFile,
        runStage: async () => { throw failure; },
      });
      runner.ensure({ jobId: 'job-stderr-safeguard', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-stderr-safeguard'])['job-stderr-safeguard']?.status === 'failed', 'failed');
      await runner.shutdown();
      const rows = readRunLog(logFile);
      assert.deepEqual(rows.map(row => row.event), ['started', 'failed']);
      assert.equal(rows[1].result, providerMessage);
      assert.equal(rows[1].error.detail.refusalCategory, 'reasoning_extraction');
      assert.equal(rows[1].error.detail.requestId, 'req_011CgE69C2EX1378K7bDBwD2');
      assert.equal(rows[1].error.detail.messageId, 'msg_011CgE69CGrrrez7psX9N3ji');
      assert.equal(script.submits.length, 0);
      assert.doesNotMatch(fs.readFileSync(logFile, 'utf8'), /PRIVATE_(?:THINKING|SIGNATURE|PROMPT)|"type":"assistant"/u);
    },
  },
  {
    name: 'claude runner run log: cancellation after a model response retains the answer and terminal outcome',
    async run() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runlog-'));
      const logFile = path.join(dir, 'runs.jsonl');
      const script = scriptedApi([{ handoffCode: 'c', stage: 'write', prompt: 'p' }]);
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile: path.join(dir, 'state.json'), logger: quietLogger(), homedir: dir, runLogPath: () => logFile,
        runStage: async () => { script.discard('job-cancel-response'); return { text: 'Complete returned answer', model: 'claude-opus-5-5' }; },
      });
      runner.ensure({ jobId: 'job-cancel-response', canvasFilePath: '/c.canvas' });
      await waitFor(() => fs.existsSync(logFile) && readRunLog(logFile).some(row => row.event === 'cancelled'), 'cancelled log');
      await runner.shutdown();
      const rows = readRunLog(logFile);
      assert.deepEqual(rows.map(row => row.event), ['started', 'response', 'cancelled']);
      assert.equal(new Set(rows.map(row => row.runId)).size, 1);
      assert.equal(rows[1].answer, 'Complete returned answer');
      assert.equal(rows[2].error.code, 'CLAUDE_CANCELLED');
      assert.equal(script.submits.length, 0);
    },
  },
  {
    name: 'claude runner run log: a failed start or response append stops the job without submitting',
    async run() {
      for (const failedEvent of ['started', 'response']) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runlog-'));
        const logFile = path.join(dir, 'runs.jsonl');
        const script = scriptedApi([{ handoffCode: 'c', stage: 'write', prompt: 'p' }]);
        let modelRuns = 0;
        const logger = quietLogger();
        const runner = createClaudeApplicationRunner({
          api: script.api, stateFile: path.join(dir, 'state.json'), logger, homedir: dir, runLogPath: () => logFile,
          fsImpl: {
            ...fs.promises,
            appendFile: async (file, line, options) => {
              if (JSON.parse(line).event === failedEvent) throw Object.assign(new Error('Contains private path details'), { code: 'ENOSPC' });
              await fs.promises.appendFile(file, line, options);
            },
          },
          runStage: async () => { modelRuns += 1; return { text: 'Unrecorded answer' }; },
        });
        const jobId = `job-log-fails-${failedEvent}`;
        runner.ensure({ jobId, canvasFilePath: '/c.canvas' });
        await waitFor(() => runner.status([jobId])[jobId]?.status === 'failed', 'failed');
        assert.equal(runner.status([jobId])[jobId].code, 'CLAUDE_LOG_ERROR');
        assert.equal(script.submits.length, 0);
        assert.equal(modelRuns, failedEvent === 'started' ? 0 : 1);
        assert.deepEqual(logger.warns, ['[ClaudeRunner] could not write the Claude run log: ENOSPC']);
        assert.doesNotMatch(runner.status([jobId])[jobId].message, /private path details/u);
        await runner.shutdown();
      }
    },
  },
  {
    name: 'claude runner run log: an unwritable app verdict cannot report successful completion',
    async run() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runlog-'));
      const logFile = path.join(dir, 'runs.jsonl');
      const script = scriptedApi([{ handoffCode: 'c', stage: 'convert', prompt: 'p' }]);
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile: path.join(dir, 'state.json'), logger: quietLogger(), homedir: dir, runLogPath: () => logFile,
        fsImpl: { ...fs.promises, appendFile: async (file, line, options) => {
          if (JSON.parse(line).event === 'submission') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          return fs.promises.appendFile(file, line, options);
        } },
        runStage: async () => ({ text: 'Returned answer' }),
      });
      runner.ensure({ jobId: 'job-verdict-log-fails', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-verdict-log-fails'])['job-verdict-log-fails']?.status === 'failed', 'failed');
      await runner.shutdown();
      assert.equal(runner.status(['job-verdict-log-fails'])['job-verdict-log-fails'].code, 'CLAUDE_LOG_ERROR');
      assert.equal(script.submits.length, 1);
      assert.deepEqual(readRunLog(logFile).map(row => row.event), ['started', 'response']);
    },
  },
  {
    name: 'claude runner run log: default private paths reject symlink redirects and nonregular files before invoking Claude',
    async run() {
      for (const kind of ['root-link', 'directory-link', 'file-link', 'nonregular-file']) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-private-log-'));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-private-outside-'));
        const untouched = path.join(outside, 'untouched.jsonl');
        fs.writeFileSync(untouched, 'Unmodified private data');
        const localRoot = path.join(dir, '.local-ai');
        const logDir = path.join(localRoot, 'claude-runs');
        const jobId = `job-private-${kind}`;
        if (kind === 'root-link') fs.symlinkSync(outside, localRoot, 'dir');
        else {
          fs.mkdirSync(localRoot);
          if (kind === 'directory-link') fs.symlinkSync(outside, logDir, 'dir');
          else {
            fs.mkdirSync(logDir);
            const logFile = path.join(logDir, `${jobId}.jsonl`);
            if (kind === 'file-link') fs.symlinkSync(untouched, logFile);
            else fs.mkdirSync(logFile);
          }
        }
        let modelRuns = 0;
        const script = scriptedApi([{ handoffCode: 'c', stage: 'write', prompt: 'p' }]);
        const runner = createRunner({
          api: script.api, stateFile: path.join(dir, 'state.json'), logger: quietLogger(), homedir: dir,
          runStage: async () => { modelRuns += 1; return { text: 'answer' }; },
        });
        runner.ensure({ jobId, canvasFilePath: path.join(dir, 'test.canvas') });
        await waitFor(() => runner.status([jobId])[jobId]?.status === 'failed', 'failed');
        await runner.shutdown();
        assert.equal(runner.status([jobId])[jobId].code, 'CLAUDE_LOG_ERROR', kind);
        assert.equal(modelRuns, 0, kind);
        assert.equal(script.submits.length, 0, kind);
        assert.equal(fs.readFileSync(untouched, 'utf8'), 'Unmodified private data', kind);
        assert.deepEqual(fs.readdirSync(outside), ['untouched.jsonl'], 'even directory creation stays inside the canvas');
      }
    },
  },
  {
    name: 'claude runner run log: existing default log files become private and preserve prior events',
    async run() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-private-log-'));
      const logDir = path.join(dir, '.local-ai', 'claude-runs');
      fs.mkdirSync(logDir, { recursive: true, mode: 0o755 });
      const logFile = path.join(logDir, 'job-private-success.jsonl');
      fs.writeFileSync(logFile, `${JSON.stringify({ event: 'old-event' })}\n`, { mode: 0o644 });
      const script = scriptedApi([{ handoffCode: 'c', stage: 'write', prompt: 'p' }]);
      const runner = createRunner({
        api: script.api, stateFile: path.join(dir, 'state.json'), logger: quietLogger(), homedir: dir,
        runStage: async () => ({ text: 'answer' }),
      });
      runner.ensure({ jobId: 'job-private-success', canvasFilePath: path.join(dir, 'test.canvas') });
      await waitFor(() => runner.status(['job-private-success'])['job-private-success']?.status === 'done', 'done');
      await runner.shutdown();
      assert.deepEqual(readRunLog(logFile).map(row => row.event), ['old-event', 'started', 'response', 'submission']);
      assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(logDir).mode & 0o777, 0o700);
    },
  },
  {
    name: 'claude runner run log: parallel queued stages retain their own model profile and audit identity',
    async run() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-runlog-'));
      const logFile = path.join(dir, 'runs.jsonl');
      const done = new Set();
      const api = {
        getHandoff: async ({ matchTaskId }) => {
          if (!matchTaskId) return done.size === 2 ? { completed: true } : { handoff: { stage: 'match-wave', parallelTasks: [{ id: 'writer' }, { id: 'converter' }] } };
          return done.has(matchTaskId) ? { completed: true } : { handoff: { handoffCode: matchTaskId, prompt: matchTaskId, stage: matchTaskId === 'writer' ? 'write' : 'convert' } };
        },
        submitHandoff: async ({ matchTaskId }) => { done.add(matchTaskId); return { accepted: true, completed: true }; },
      };
      const profiles = [];
      const runner = createClaudeApplicationRunner({
        api, concurrency: 1, stateFile: path.join(dir, 'state.json'), logger: quietLogger(), homedir: dir, runLogPath: () => logFile,
        runStage: async ({ stage, model, effort }) => { profiles.push([stage, model, effort]); return { text: 'answer' }; },
      });
      runner.ensure({ jobId: 'job-parallel-log', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-parallel-log'])['job-parallel-log']?.status === 'done', 'done');
      await runner.shutdown();
      assert.deepEqual(profiles, [['write', 'opus', 'xhigh'], ['convert', 'sonnet', 'medium']]);
      const rows = readRunLog(logFile);
      for (const [matchTaskId, stage, model, effort] of [['writer', 'write', 'opus', 'xhigh'], ['converter', 'convert', 'sonnet', 'medium']]) {
        const group = rows.filter(row => row.matchTaskId === matchTaskId);
        assert.deepEqual(group.map(row => row.event), ['started', 'response', 'submission']);
        assert.equal(new Set(group.map(row => row.runId)).size, 1);
        for (const row of group) assert.deepEqual([row.stage, row.requestedModel, row.requestedEffort], [stage, model, effort]);
      }
      assert.equal(new Set(rows.map(row => row.runId)).size, 2);
    },
  },
  {
    name: 'claude runner activity: onActivity emits lastActivityAt throttled per job, keeping updatedAt as the stage start',
    async run() {
      assert.equal(CLAUDE_ACTIVITY_EMIT_INTERVAL_MS, 5000);
      const script = scriptedApi([{ handoffCode: 'code-1', stage: 'draft', prompt: 'prompt one' }]);
      let clock = 1000;
      const notes = [];
      let savedActivity = null;
      let stageStart = null;
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile: tempStateFile(), logger: quietLogger(), homedir: '',
        now: () => clock,
        notify: n => notes.push({ ...n }),
        runStage: async ({ onActivity }) => {
          savedActivity = onActivity;
          stageStart = notes.filter(n => n.status === 'running' && n.stage === 'draft').at(-1).updatedAt;
          clock = 3000; onActivity();
          clock = 4000; onActivity();
          clock = 7999; onActivity();
          clock = 8000; onActivity();
          return { text: 'answer' };
        },
      });
      runner.ensure({ jobId: 'job-activity', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-activity'])['job-activity']?.status === 'done', 'done');
      assert.equal(stageStart, 1000);
      const activity = notes.filter(n => 'lastActivityAt' in n);
      assert.deepEqual(activity.map(n => [n.status, n.stage, n.updatedAt, n.lastActivityAt]), [
        ['running', 'draft', 1000, 3000],
        ['running', 'draft', 1000, 8000],
      ]);
      const before = notes.length;
      clock = 20000;
      savedActivity();
      assert.equal(notes.length, before, 'activity after the job left running emits nothing');
      await runner.shutdown();
    },
  },
  {
    name: 'claude runner activity: a new stage drops lastActivityAt and the persisted failure has none',
    async run() {
      const stateFile = tempStateFile();
      const script = scriptedApi([{ handoffCode: 'code-1', stage: 'draft', prompt: 'prompt one' }]);
      let clock = 500;
      const notes = [];
      let savedActivity = null;
      const runner = createClaudeApplicationRunner({
        api: script.api, stateFile, logger: quietLogger(), homedir: '',
        now: () => clock,
        notify: n => notes.push({ ...n }),
        runStage: async ({ onActivity }) => {
          savedActivity = onActivity;
          clock = 900; onActivity();
          throw new ClaudeRunnerError('CLAUDE_USAGE_LIMIT', USAGE_MESSAGE);
        },
      });
      runner.ensure({ jobId: 'job-activity-fail', canvasFilePath: '/c.canvas' });
      await waitFor(() => runner.status(['job-activity-fail'])['job-activity-fail']?.status === 'failed', 'failed');
      assert.deepEqual(notes.filter(n => 'lastActivityAt' in n).map(n => [n.status, n.lastActivityAt]), [['running', 900]]);
      const failedNote = notes.at(-1);
      assert.equal(failedNote.status, 'failed');
      assert.equal('lastActivityAt' in failedNote, false);
      assert.equal('lastActivityAt' in runner.status(['job-activity-fail'])['job-activity-fail'], false);
      const before = notes.length;
      savedActivity();
      assert.equal(notes.length, before, 'a failed job ignores activity');
      await waitFor(() => {
        try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')).failed?.['job-activity-fail']?.status === 'failed'; } catch { return false; }
      }, 'persisted failure');
      await runner.shutdown();
      const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8')).failed['job-activity-fail'];
      assert.equal('lastActivityAt' in persisted, false);
      assert.equal(persisted.code, 'CLAUDE_USAGE_LIMIT');
      assert.equal(persisted.updatedAt, 900);
    },
  },
];
