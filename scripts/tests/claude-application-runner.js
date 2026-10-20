import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  answeringModel,
  CLAUDE_MAX_RUNS_PER_JOB,
  CLAUDE_STAGE_PROFILES,
  CLAUDE_STAGE_TIMEOUT_MS,
  claudeStageProfile,
  ClaudeRunnerError,
  buildClaudeInputMessage,
  claudeChildEnv,
  claudeCliArgs,
  classifyClaudeFailure,
  createClaudeApplicationRunner,
  parseClaudeStreamOutput,
  resolveClaudeBinary,
  runClaudeStage,
} from '../../electron/ipc/claudeApplicationRunner.js';

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
    name: 'claude runner: CLI args are exactly the headless, tool-less latest-Sonnet invocation',
    run() {
      assert.deepEqual(claudeCliArgs(), [
        '-p', '--model', 'sonnet', '--effort', 'high', '--restricted', '--strict-mcp-config',
        '--tools', '', '--input-format', 'stream-json',
        '--output-format', 'stream-json', '--verbose',
      ]);
      assert.equal(claudeCliArgs().includes('--no-session-persistence'), false);
    },
  },
  {
    name: 'claude runner: CLI args start a session with --session-id or continue it with --resume right after -p',
    run() {
      const tail = ['--model', 'opus', '--effort', 'xhigh', '--restricted', '--strict-mcp-config',
        '--tools', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
      assert.deepEqual(claudeCliArgs({ model: 'opus', effort: 'xhigh', sessionId: 'S', resume: false }), ['-p', '--session-id', 'S', ...tail]);
      assert.deepEqual(claudeCliArgs({ model: 'opus', effort: 'xhigh', sessionId: 'S', resume: true }), ['-p', '--resume', 'S', ...tail]);
      assert.deepEqual(claudeCliArgs({ model: 'opus', effort: 'xhigh', resume: true }), ['-p', ...tail]);
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
        { jobId: 'job-happy', canvasFilePath: '/c.canvas', handoffCode: 'code-1', response: 'answer to prompt one' },
        { jobId: 'job-happy', canvasFilePath: '/c.canvas', handoffCode: 'code-2', response: 'answer to prompt two' },
      ]);
      assert.deepEqual(notes.filter(n => n.status === 'running' && n.stage).map(n => n.stage), ['draft', 'verify']);
      assert.deepEqual(runner.ensure({ jobId: '', canvasFilePath: '/c.canvas' }), { status: 'invalid' });
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
      assert.deepEqual(texts, ['prompt one', 'fix draft']);
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
        { jobId: 'job-par', canvasFilePath: '/c.canvas', matchTaskId: 't1', handoffCode: 'code-t1', response: 'answer-prompt-t1' },
        { jobId: 'job-par', canvasFilePath: '/c.canvas', matchTaskId: 't2', handoffCode: 'code-t2', response: 'answer-prompt-t2' },
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
        { text: 'Do not start over; fix it', sessionId: calls[0].sessionId, resume: true },
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
];
