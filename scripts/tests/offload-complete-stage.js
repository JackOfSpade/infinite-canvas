import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_HANDOFF_SYSTEM_PROMPT, ClaudeRunnerError } from '../../electron/ipc/claudeApplicationRunner.js';
import { createOffloadCompleteStage, offloadFailure, removeOffloadSessions, runOffloadComplete } from '../../electron/ipc/offloadCompleteStage.js';
import { handoffMessages, offloadTextCall } from '../../electron/ipc/offloadTextCall.js';
import {
  AI_CALL_PROVIDERS, OFFLOAD_REASONING_LEVELS, applicationStageProviders, offloadReasoning, offloadStagesDisabled, routedCall, taskEntry,
} from '../../electron/ipc/aiCallProviders.js';
import { APPLICATION_STAGE_PROFILES, CAREER_WRITING_DEFAULT_PROFILE } from '../../electron/ipc/careerWritingCore.js';

const OK = (text, extra = {}) => JSON.stringify({
  version: 1, ok: true, text, finishReason: 'stop', model: 'deepseek-v-test',
  usage: { inputTokens: 100, cacheHitTokens: 60, cacheMissTokens: 40, outputTokens: 7, reasoningTokens: 3 },
  costUsd: 0.0012, latencyMs: 321, ...extra,
});
const FAIL = (code, extra = {}) => JSON.stringify({
  version: 1, ok: false, error: { code, message: `failure ${code}`, retryable: code === 'rate_limited', httpStatus: 402, providerRequestId: 'req-1' },
  latencyMs: 55, ...extra,
});

// Each call to the fake CLI consumes the next canned reply: stdout text or a function of the request.
function fakeSpawn(replies) {
  const calls = [];
  const spawnImpl = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = [];
    child.stdinText = '';
    const call = { binary, args, options, child };
    calls.push(call);
    child.stdin.on('data', chunk => { child.stdinText += chunk.toString('utf8'); });
    child.stdin.on('end', () => {
      call.request = JSON.parse(child.stdinText);
      const reply = replies.length ? replies.shift() : '';
      const spec = typeof reply === 'function' ? reply(call.request, child) : reply;
      if (spec === 'hang') return;
      const { stdout = '', code = 0 } = typeof spec === 'string' ? { stdout: `${spec}\n` } : spec;
      setImmediate(() => { if (stdout) child.stdout.write(stdout); child.emit('close', code, null); });
    });
    child.kill = signal => {
      child.kills.push(signal);
      setImmediate(() => { child.stdout.write(`${FAIL('cancelled')}\n`); child.emit('close', null, signal); });
      return true;
    };
    return child;
  };
  return { calls, spawnImpl };
}

function setup(replies, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offload-stage-test-'));
  const transcriptDir = path.join(dir, 'sessions');
  const spawn = fakeSpawn(replies);
  const run = createOffloadCompleteStage({ binPath: '/fake/offload', spawnImpl: spawn.spawnImpl, transcriptDir, route: 'deepseek-flash', ...options });
  return { dir, transcriptDir, run, ...spawn };
}

async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected a rejection');
}

const SESSION = '11111111-1111-4111-8111-111111111111';

export default [
  {
    name: 'offload stage: request carries route, caller, tag, reasoning and ends on a user turn',
    async run() {
      const t = setup([OK('first answer')]);
      const result = await t.run({ text: 'Hello prompt', pageImages: [], stage: 'convert', sessionId: SESSION, resume: false });
      assert.equal(t.calls.length, 1);
      assert.equal(t.calls[0].binary, '/fake/offload');
      assert.deepEqual(t.calls[0].args, ['complete']);
      const request = t.calls[0].request;
      assert.equal(request.version, 1);
      assert.equal(request.route, 'deepseek-flash');
      assert.equal(request.caller, 'infinite-canvas');
      assert.equal(request.tag, 'convert');
      assert.equal(request.maxTokens, 32000);
      assert.equal(request.timeoutMs, 900000);
      assert.deepEqual(request.reasoning, { enabled: true, effort: 'high' });
      assert.deepEqual(request.messages, [
        { role: 'system', content: CLAUDE_HANDOFF_SYSTEM_PROMPT },
        { role: 'user', content: 'Hello prompt' },
      ]);
      assert.equal(request.messages.at(-1).role, 'user');
      assert.equal(result.text, 'first answer');
      assert.equal(result.model, 'deepseek-v-test');
      assert.equal(result.durationMs, 321);
      assert.equal(result.costUsd, 0.0012);
      assert.deepEqual(result.usage, {
        input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 7, reasoning_tokens: 3,
        provider_usage: { inputTokens: 100, cacheHitTokens: 60, cacheMissTokens: 40, outputTokens: 7, reasoningTokens: 3 },
      });
      assert.equal(result.summaryCount, 0);
      assert.equal(result.summaryChars, 0);
      assert.equal(result.thinkingDisplay, 'omitted');
      assert.equal(result.provider, 'offload');
      assert.equal(result.route, 'deepseek-flash');
    },
  },
  {
    name: 'offload stage: a large career catalog moves to the system message like the Claude path',
    async run() {
      // splitCareerCatalog only recognises '## ' lines, and only past 20k chars.
      const catalog = Array.from({ length: 400 }, (_, i) => `## Role Engineer ${i} ${'x'.repeat(60)}`).join('\n');
      const t = setup([OK('ok')]);
      await t.run({ text: `Task intro.\n\n${catalog}\n\nOutput JSON.`, stage: 'requirements', sessionId: SESSION, resume: false });
      const [system, user] = t.calls[0].request.messages;
      assert.equal(system.content, `${CLAUDE_HANDOFF_SYSTEM_PROMPT}\n\nAPPROVED CAREER CATALOG:\n${catalog}`);
      assert.equal(user.content.includes('Role Engineer 5 '), false, 'the user turn keeps only the pointer');
      assert.match(user.content, /approved career catalog entries belong here/iu);
      assert.match(user.content, /Task intro\./u);
    },
  },
  {
    name: 'offload stage: resume replays the stored turns byte-identically and appends the assistant only on success',
    async run() {
      const t = setup([OK('answer one'), OK('answer two')]);
      await t.run({ text: 'turn one', stage: 'convert', sessionId: SESSION, resume: false });
      const stored = JSON.parse(fs.readFileSync(path.join(t.transcriptDir, `${SESSION}.json`), 'utf8'));
      assert.deepEqual(stored.map(m => m.role), ['system', 'user', 'assistant']);
      await t.run({ text: 'fix it', stage: 'convert', sessionId: SESSION, resume: true });
      const second = t.calls[1].request.messages;
      assert.deepEqual(second.map(m => m.role), ['system', 'user', 'assistant', 'user']);
      assert.equal(second[0].content, t.calls[0].request.messages[0].content);
      assert.deepEqual(second.slice(0, 3), stored);
      assert.equal(second[3].content, 'fix it');
      const after = JSON.parse(fs.readFileSync(path.join(t.transcriptDir, `${SESSION}.json`), 'utf8'));
      assert.deepEqual(after.map(m => m.role), ['system', 'user', 'assistant', 'user', 'assistant']);
      assert.equal(after[4].content, 'answer two');
    },
  },
  {
    name: 'offload stage: a failed turn never extends the stored session',
    async run() {
      const t = setup([OK('answer one'), FAIL('provider_error'), OK('answer three')]);
      await t.run({ text: 'turn one', stage: 'convert', sessionId: SESSION, resume: false });
      const file = path.join(t.transcriptDir, `${SESSION}.json`);
      const before = fs.readFileSync(file, 'utf8');
      const error = await rejection(t.run({ text: 'fix', stage: 'convert', sessionId: SESSION, resume: true }));
      assert.equal(error.code, 'OFFLOAD_PROVIDER_ERROR');
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      await t.run({ text: 'fix again', stage: 'convert', sessionId: SESSION, resume: true });
      const replayed = t.calls[2].request.messages;
      assert.deepEqual(replayed.map(m => m.content), [CLAUDE_HANDOFF_SYSTEM_PROMPT, 'turn one', 'answer one', 'fix again']);
    },
  },
  {
    name: 'offload stage: resuming a missing or corrupt session file fails with OFFLOAD_SESSION_MISSING without calling the CLI',
    async run() {
      const t = setup([OK('never used')]);
      const missing = await rejection(t.run({ text: 'x', stage: 'convert', sessionId: SESSION, resume: true }));
      assert.ok(missing instanceof ClaudeRunnerError);
      assert.equal(missing.code, 'OFFLOAD_SESSION_MISSING');
      fs.mkdirSync(t.transcriptDir, { recursive: true });
      fs.writeFileSync(path.join(t.transcriptDir, `${SESSION}.json`), '{not json');
      const corrupt = await rejection(t.run({ text: 'x', stage: 'convert', sessionId: SESSION, resume: true }));
      assert.equal(corrupt.code, 'OFFLOAD_SESSION_MISSING');
      assert.equal(t.calls.length, 0);
    },
  },
  {
    name: 'offload stage: provider failure codes map to OFFLOAD_<CODE> with detail, and cancelled maps to CLAUDE_CANCELLED',
    async run() {
      const codes = ['invalid_request', 'credit_exhausted', 'auth_failed', 'rate_limited', 'provider_error', 'truncated', 'refused', 'timeout', 'budget_cap', 'unpriced_model', 'brand_new_code'];
      for (const code of codes) {
        const t = setup([FAIL(code, { costUsd: 0.5 })]);
        const error = await rejection(t.run({ text: 'x', stage: 'convert', sessionId: SESSION, resume: false }));
        assert.ok(error instanceof ClaudeRunnerError, code);
        assert.equal(error.code, `OFFLOAD_${code.toUpperCase()}`);
        assert.equal(error.message, `failure ${code}`);
        assert.deepEqual(error.detail, { offloadCode: code, retryable: code === 'rate_limited', httpStatus: 402, providerRequestId: 'req-1', latencyMs: 55, costUsd: 0.5 });
        assert.equal(fs.existsSync(path.join(t.transcriptDir, `${SESSION}.json`)), false, 'no session file after a failure');
      }
      const cancelled = setup([FAIL('cancelled')]);
      const error = await rejection(cancelled.run({ text: 'x', stage: 'convert', sessionId: SESSION, resume: false }));
      assert.equal(error.code, 'CLAUDE_CANCELLED');
    },
  },
  {
    name: 'offload stage: an empty ok answer is OFFLOAD_EMPTY',
    async run() {
      const t = setup([OK('   ')]);
      const error = await rejection(t.run({ text: 'x', stage: 'convert', sessionId: SESSION, resume: false }));
      assert.equal(error.code, 'OFFLOAD_EMPTY');
      assert.equal(fs.existsSync(path.join(t.transcriptDir, `${SESSION}.json`)), false);
    },
  },
  {
    name: 'offload stage: non-JSON output, a spawn error and a missing binary are OFFLOAD_UNAVAILABLE',
    async run() {
      const garbage = setup(['definitely not json']);
      assert.equal((await rejection(garbage.run({ text: 'x', stage: 'convert', sessionId: SESSION, resume: false }))).code, 'OFFLOAD_UNAVAILABLE');
      const silent = setup([{ stdout: '', code: 1 }]);
      assert.equal((await rejection(silent.run({ text: 'x', stage: 'convert', sessionId: SESSION, resume: false }))).code, 'OFFLOAD_UNAVAILABLE');
      const throwing = setup([], { spawnImpl: () => { throw Object.assign(new Error('spawn offload ENOENT'), { code: 'ENOENT' }); } });
      assert.equal((await rejection(throwing.run({ text: 'x', stage: 'convert', sessionId: SESSION, resume: false }))).code, 'OFFLOAD_UNAVAILABLE');
      const emitting = setup([], { spawnImpl: () => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
        return child;
      } });
      assert.equal((await rejection(emitting.run({ text: 'x', stage: 'convert', sessionId: SESSION, resume: false }))).code, 'OFFLOAD_UNAVAILABLE');
    },
  },
  {
    name: 'offload stage: aborting the signal sends SIGTERM and surfaces the cancelled result',
    async run() {
      const t = setup(['hang']);
      const controller = new AbortController();
      const promise = t.run({ text: 'x', stage: 'convert', sessionId: SESSION, resume: false, signal: controller.signal });
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(t.calls[0].child.kills.length, 0);
      controller.abort();
      const error = await rejection(promise);
      assert.deepEqual(t.calls[0].child.kills, ['SIGTERM']);
      assert.equal(error.code, 'CLAUDE_CANCELLED');
    },
  },
  {
    name: 'offload stage: page images are rejected before any process starts',
    async run() {
      const t = setup([OK('never')]);
      const error = await rejection(t.run({ text: 'x', pageImages: [{ data: 'abc' }], stage: 'convert', sessionId: SESSION, resume: false }));
      assert.equal(error.code, 'OFFLOAD_UNSUPPORTED');
      assert.equal(t.calls.length, 0);
    },
  },
  {
    name: 'offload stage: transcript files are private and removeOffloadSessions deletes them',
    async run() {
      const other = '22222222-2222-4222-8222-222222222222';
      const t = setup([OK('a'), OK('b')]);
      await t.run({ text: 'one', stage: 'convert', sessionId: SESSION, resume: false });
      await t.run({ text: 'two', stage: 'convert', sessionId: other, resume: false });
      assert.equal(fs.statSync(t.transcriptDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(t.transcriptDir, `${SESSION}.json`)).mode & 0o777, 0o600);
      assert.deepEqual(fs.readdirSync(t.transcriptDir).sort(), [`${SESSION}.json`, `${other}.json`]);
      await removeOffloadSessions(t.transcriptDir, [SESSION, '../escape'], fs.promises);
      assert.deepEqual(fs.readdirSync(t.transcriptDir), [`${other}.json`]);
    },
  },
  {
    // A Finder-launched app has no node on PATH, so the `#!/usr/bin/env node`
    // launcher cannot start; with nodePath the resolved script runs under it.
    name: 'offload stage: nodePath runs the resolved CLI script under that interpreter as Node',
    async run() {
      const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offload-bin-test-'));
      const script = path.join(scriptDir, 'offload.mjs');
      fs.writeFileSync(script, '// fake CLI entry\n');
      const link = path.join(scriptDir, 'offload');
      fs.symlinkSync(script, link);
      const t = setup([OK('answer')], { binPath: link, nodePath: '/fake/Electron' });
      await t.run({ text: 'prompt', stage: 'convert', sessionId: SESSION, resume: false });
      assert.equal(t.calls[0].binary, '/fake/Electron');
      assert.deepEqual(t.calls[0].args, [fs.realpathSync(script), 'complete']);
      assert.equal(t.calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
      const plain = setup([OK('answer')]);
      await plain.run({ text: 'prompt', stage: 'convert', sessionId: SESSION, resume: false });
      assert.equal(plain.calls[0].options.env, undefined, 'without nodePath the launcher runs with the inherited environment');
    },
  },
  {
    name: 'offload stage: reasoning off sends enabled false with no effort key',
    async run() {
      const t = setup([OK('answer')]);
      await t.run({ text: 'prompt', stage: 'convert', sessionId: SESSION, resume: false, reasoning: 'off' });
      assert.deepEqual(t.calls[0].request.reasoning, { enabled: false });
      assert.equal('effort' in t.calls[0].request.reasoning, false);
    },
  },
  {
    name: 'offload stage: reasoning low sends its effort and an omitted level defaults to high',
    async run() {
      const t = setup([OK('one'), OK('two')]);
      await t.run({ text: 'prompt', stage: 'convert', sessionId: SESSION, resume: false, reasoning: 'low' });
      assert.deepEqual(t.calls[0].request.reasoning, { enabled: true, effort: 'low' });
      await t.run({ text: 'prompt', stage: 'convert', sessionId: SESSION, resume: false });
      assert.deepEqual(t.calls[1].request.reasoning, { enabled: true, effort: 'high' });
    },
  },
  {
    name: 'offload stage: an invalid reasoning level rejects with OFFLOAD_INVALID_REQUEST and never spawns',
    async run() {
      const t = setup([OK('never used')]);
      const error = await rejection(t.run({ text: 'prompt', stage: 'convert', sessionId: SESSION, resume: false, reasoning: 'extreme' }));
      assert.ok(error instanceof ClaudeRunnerError);
      assert.equal(error.code, 'OFFLOAD_INVALID_REQUEST');
      assert.equal(t.calls.length, 0);
      assert.equal(fs.existsSync(path.join(t.transcriptDir, `${SESSION}.json`)), false);
    },
  },
  {
    name: 'runOffloadComplete: returns the parsed result line from the CLI',
    async run() {
      const spawn = fakeSpawn([OK('direct answer')]);
      const request = { version: 1, route: 'deepseek-pro', messages: [{ role: 'user', content: 'hi' }] };
      const result = await runOffloadComplete({ request, binPath: '/fake/offload', spawnImpl: spawn.spawnImpl });
      assert.equal(result.ok, true);
      assert.equal(result.text, 'direct answer');
      assert.equal(result.costUsd, 0.0012);
      assert.equal(spawn.calls[0].binary, '/fake/offload');
      assert.deepEqual(spawn.calls[0].args, ['complete']);
      assert.deepEqual(spawn.calls[0].request, request);
    },
  },
  {
    name: 'offloadReasoning: maps levels and throws on an unknown one',
    async run() {
      assert.deepEqual(OFFLOAD_REASONING_LEVELS, ['off', 'low', 'medium', 'high', 'max']);
      assert.deepEqual(offloadReasoning('off'), { enabled: false });
      for (const level of ['low', 'medium', 'high', 'max']) assert.deepEqual(offloadReasoning(level), { enabled: true, effort: level });
      assert.throws(() => offloadReasoning('xhigh'));
      assert.throws(() => offloadReasoning(undefined));
    },
  },
  {
    name: 'aiCallProviders: every application entry names route, reasoning, Claude fallback, date and rationale',
    async run() {
      const keys = Object.keys(AI_CALL_PROVIDERS);
      assert.deepEqual(keys, ['application:requirements-audit']);
      for (const key of keys) {
        const entry = AI_CALL_PROVIDERS[key];
        assert.equal(entry.provider, 'offload', key);
        assert.equal(entry.route, 'deepseek-flash', key);
        assert.equal(entry.reasoning, 'off', key);
        assert.equal(typeof entry.claude.model, 'string', key);
        assert.equal(typeof entry.claude.effort, 'string', key);
        assert.match(entry.decided, /^\d{4}-\d{2}-\d{2}$/u, key);
        assert.ok(entry.why.length > 0, key);
        assert.equal(Object.isFrozen(entry), true, key);
      }
      assert.deepEqual(AI_CALL_PROVIDERS['application:requirements-audit'].claude, CAREER_WRITING_DEFAULT_PROFILE);
      for (const stage of ['requirements', 'requirements-adjudication', 'convert', 'verify-correction', 'fit-correction', 'write', 'editorial-plan', 'pick', 'fact-check', 'fact-correction', 'fact-recheck']) {
        assert.equal(Object.hasOwn(AI_CALL_PROVIDERS, `application:${stage}`), false, stage);
      }
    },
  },
  {
    name: 'aiCallProviders: routedCall applies env overrides, ignores invalid ones and returns null when off or unknown',
    async run() {
      const key = 'application:requirements-audit';
      assert.equal(routedCall(key, { env: { INFINITE_CANVAS_OFFLOAD_STAGES: 'off' } }), null);
      assert.equal(offloadStagesDisabled({ INFINITE_CANVAS_OFFLOAD_STAGES: 'off' }), true);
      assert.equal(offloadStagesDisabled({}), false);
      assert.equal(routedCall('application:nope', { env: {} }), null);
      assert.equal(routedCall(key, { env: {}, table: { [key]: { provider: 'claude' } } }), null);
      const plain = routedCall(key, { env: {} });
      assert.equal(plain.route, 'deepseek-flash');
      assert.equal(plain.reasoning, 'off');
      const overridden = routedCall(key, { env: { INFINITE_CANVAS_OFFLOAD_ROUTE: 'deepseek-pro', INFINITE_CANVAS_OFFLOAD_REASONING: 'max' } });
      assert.equal(overridden.route, 'deepseek-pro');
      assert.equal(overridden.reasoning, 'max');
      assert.equal(overridden.decided, AI_CALL_PROVIDERS[key].decided);
      const offReasoning = routedCall(key, { env: { INFINITE_CANVAS_OFFLOAD_REASONING: 'off' } });
      assert.equal(offReasoning.reasoning, 'off');
      const invalid = routedCall(key, { env: { INFINITE_CANVAS_OFFLOAD_ROUTE: 'gpt-9', INFINITE_CANVAS_OFFLOAD_REASONING: 'extreme' } });
      assert.equal(invalid.route, 'deepseek-flash');
      assert.equal(invalid.reasoning, 'off');
      assert.equal(Object.hasOwn(plain, 'maxRejections'), false, 'the shipped table sets no maxRejections');
      const limited = routedCall(key, { env: {}, table: { [key]: { provider: 'offload', route: 'deepseek-flash', reasoning: 'off', maxRejections: 3 } } });
      assert.equal(limited.maxRejections, 3, 'routedCall preserves maxRejections from a table entry');
    },
  },
  {
    name: 'aiCallProviders: applicationStageProviders maps stage names, applies env and is empty when off',
    async run() {
      const stages = applicationStageProviders({ env: { INFINITE_CANVAS_OFFLOAD_REASONING: 'low' } });
      assert.deepEqual(Object.keys(stages), ['requirements-audit']);
      for (const value of Object.values(stages)) assert.equal(value.reasoning, 'low');
      assert.deepEqual(applicationStageProviders({ env: { INFINITE_CANVAS_OFFLOAD_STAGES: 'off' } }), {});
      const table = { 'application:write': { provider: 'offload', route: 'deepseek-pro', reasoning: 'off' }, 'task:x': { provider: 'offload', route: 'deepseek-flash', reasoning: 'high' } };
      assert.deepEqual(applicationStageProviders({ env: {}, table }), { write: { provider: 'offload', route: 'deepseek-pro', reasoning: 'off' } });
    },
  },
  {
    name: 'offloadTextCall: handoffMessages builds the system and user turns, with the shared reference appended',
    run() {
      assert.deepEqual(handoffMessages({ text: 'T' }), [
        { role: 'system', content: CLAUDE_HANDOFF_SYSTEM_PROMPT },
        { role: 'user', content: 'T' },
      ]);
      assert.equal(handoffMessages({ text: 'T', systemAppend: 'SHARED REFERENCE:\nX' })[0].content, `${CLAUDE_HANDOFF_SYSTEM_PROMPT}\n\nSHARED REFERENCE:\nX`);
    },
  },
  {
    name: 'offloadTextCall: success sends the request statelessly and maps the Claude-shaped result',
    async run() {
      const spawn = fakeSpawn([OK('the answer')]);
      const messages = handoffMessages({ text: 'Hello' });
      const result = await offloadTextCall({ messages, route: 'deepseek-pro', reasoning: 'medium', tag: 'job-scoring', binPath: '/fake/offload', nodePath: null, spawnImpl: spawn.spawnImpl });
      assert.equal(spawn.calls.length, 1);
      assert.deepEqual(spawn.calls[0].args, ['complete']);
      const request = spawn.calls[0].request;
      assert.equal(request.route, 'deepseek-pro');
      assert.equal(request.tag, 'job-scoring');
      assert.equal(request.caller, 'infinite-canvas');
      assert.equal(request.maxTokens, 32000);
      assert.equal(request.timeoutMs, 900000);
      assert.deepEqual(request.reasoning, { enabled: true, effort: 'medium' });
      assert.deepEqual(request.messages, messages);
      assert.equal(result.text, 'the answer');
      assert.equal(result.model, 'deepseek-v-test');
      assert.equal(result.durationMs, 321);
      assert.equal(result.costUsd, 0.0012);
      assert.equal(result.provider, 'offload');
      assert.equal(result.route, 'deepseek-pro');
      assert.equal(result.reasoning, 'medium');
      assert.equal(result.usage.input_tokens, 40);
      assert.equal(result.usage.cache_read_input_tokens, 60);
      assert.equal(result.usage.output_tokens, 7);
      assert.equal(result.usage.reasoning_tokens, 3);
      assert.deepEqual(result.usage.provider_usage, { inputTokens: 100, cacheHitTokens: 60, cacheMissTokens: 40, outputTokens: 7, reasoningTokens: 3 });
      const shadow = fakeSpawn([OK('x')]);
      await offloadTextCall({ messages, route: 'deepseek-flash', reasoning: 'off', tag: 'shadow-x', caller: 'infinite-canvas-shadow', binPath: '/fake/offload', nodePath: null, spawnImpl: shadow.spawnImpl });
      assert.equal(shadow.calls[0].request.caller, 'infinite-canvas-shadow');
      assert.deepEqual(shadow.calls[0].request.reasoning, { enabled: false });
    },
  },
  {
    name: 'offloadTextCall: failures map to OFFLOAD_ codes; credit exhaustion, empty text and cancel are distinguished',
    async run() {
      const messages = handoffMessages({ text: 'Hello' });
      const call = (reply, extra = {}) => offloadTextCall({ messages, route: 'deepseek-flash', reasoning: 'high', tag: 't', binPath: '/fake/offload', nodePath: null, spawnImpl: fakeSpawn([reply]).spawnImpl, ...extra });
      const credit = await rejection(call(FAIL('credit_exhausted')));
      assert(credit instanceof ClaudeRunnerError);
      assert.equal(credit.code, 'OFFLOAD_CREDIT_EXHAUSTED');
      assert.equal(offloadFailure({ ok: false, error: { code: 'credit_exhausted', message: 'm' } }).code, 'OFFLOAD_CREDIT_EXHAUSTED');
      const limited = await rejection(call(FAIL('rate_limited')));
      assert.equal(limited.code, 'OFFLOAD_RATE_LIMITED');
      assert.equal(limited.detail.retryable, true);
      assert.equal((await rejection(call(OK('   ')))).code, 'OFFLOAD_EMPTY');
      assert.equal((await rejection(call(FAIL('cancelled')))).code, 'CLAUDE_CANCELLED');
      assert.equal((await rejection(call('not json at all'))).code, 'OFFLOAD_UNAVAILABLE');
      assert.equal((await rejection(call(OK('x'), { reasoning: 'extreme' }))).code, 'OFFLOAD_INVALID_REQUEST');
      const controller = new AbortController();
      controller.abort();
      const spawn = fakeSpawn([OK('x')]);
      const cancelled = await rejection(offloadTextCall({ messages, route: 'deepseek-flash', reasoning: 'high', tag: 't', binPath: '/fake/offload', nodePath: null, spawnImpl: spawn.spawnImpl, signal: controller.signal }));
      assert.equal(cancelled.code, 'CLAUDE_CANCELLED');
      assert.equal(spawn.calls.length, 0, 'an already cancelled call never starts the CLI');
    },
  },
  {
    name: 'offloadTextCall web tools: the request carries the exact tools and toolLoop, and only when webTools is given',
    async run() {
      const messages = handoffMessages({ text: 'Hello' });
      const base = { messages, route: 'deepseek-flash', reasoning: 'high', tag: 'job-research', binPath: '/fake/offload', nodePath: null };
      const plainSpawn = fakeSpawn([OK('a')]);
      const plain = await offloadTextCall({ ...base, spawnImpl: plainSpawn.spawnImpl });
      assert.deepEqual(Object.keys(plainSpawn.calls[0].request).sort(),
        ['caller', 'maxTokens', 'messages', 'reasoning', 'route', 'tag', 'timeoutMs', 'version']);
      assert.equal(Object.hasOwn(plain, 'webTools'), false);
      const spawn = fakeSpawn([OK('web answer', { toolLoop: { id: 'x', turn: 4, maxTurns: 16, final: true, toolCalls: 6, maxToolCalls: 64, costUsd: 0.01, maxUsd: 0.5 }, newMessages: [{ role: 'assistant', content: 'SECRET-TURN' }] })]);
      const result = await offloadTextCall({ ...base, webTools: {}, spawnImpl: spawn.spawnImpl });
      const request = spawn.calls[0].request;
      assert.deepEqual(request.tools, [{ builtin: 'web_search', count: 5 }, { builtin: 'web_fetch', maxChars: 20000 }]);
      const { id, ...loop } = request.toolLoop;
      assert.deepEqual(loop, { maxTurns: 16, maxToolCallsPerTurn: 8, maxToolCalls: 64, maxUsd: 0.5 });
      assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
      assert(id.startsWith('job-research-'));
      assert.equal(result.text, 'web answer');
      assert.deepEqual(result.webTools, { turns: 4, toolCalls: 6 });
      assert(!JSON.stringify(result).includes('SECRET-TURN'), 'newMessages are never returned');
      const custom = fakeSpawn([OK('b'), OK('c')]);
      const customResult = await offloadTextCall({
        ...base, tag: '  weird tag / with spaces and a very very long name that exceeds the limit ', spawnImpl: custom.spawnImpl,
        webTools: { searchCount: 2, fetchMaxChars: 1000, maxTurns: 3, maxToolCalls: 9, maxUsd: 0.1 },
      });
      const tools = custom.calls[0].request;
      assert.deepEqual(tools.tools, [{ builtin: 'web_search', count: 2 }, { builtin: 'web_fetch', maxChars: 1000 }]);
      assert.deepEqual({ ...tools.toolLoop, id: null }, { id: null, maxTurns: 3, maxToolCallsPerTurn: 8, maxToolCalls: 9, maxUsd: 0.1 });
      assert.match(tools.toolLoop.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
      assert.deepEqual(customResult.webTools, { turns: null, toolCalls: null });
      assert.notEqual(tools.toolLoop.id, request.toolLoop.id);
    },
  },
  {
    name: 'offloadTextCall web tools: finishReason tool_calls is an OFFLOAD_UNSUPPORTED failure',
    async run() {
      const messages = handoffMessages({ text: 'Hello' });
      const error = await rejection(offloadTextCall({
        messages, route: 'deepseek-flash', reasoning: 'high', tag: 't', binPath: '/fake/offload', nodePath: null, webTools: {},
        spawnImpl: fakeSpawn([OK('partial text', { finishReason: 'tool_calls' })]).spawnImpl,
      }));
      assert(error instanceof ClaudeRunnerError);
      assert.equal(error.code, 'OFFLOAD_UNSUPPORTED');
    },
  },
  {
    name: 'aiCallProviders: taskEntry builds a task entry with the task Claude profile and leaves the table unchanged',
    run() {
      const entry = taskEntry('job-compensation-research-batch', 'deepseek-pro', 'low', 'because', { maxRejections: 3, webTools: { maxUsd: 0.2 } });
      assert.equal(entry.provider, 'offload');
      assert.equal(entry.route, 'deepseek-pro');
      assert.equal(entry.reasoning, 'low');
      assert.equal(entry.why, 'because');
      assert.equal(entry.maxRejections, 3);
      assert.deepEqual(entry.webTools, { maxUsd: 0.2 });
      assert(Object.isFrozen(entry) && Object.isFrozen(entry.webTools));
      assert.equal(entry.claude.tools, 'WebSearch,WebFetch');
      const bare = taskEntry('job-scoring');
      assert.equal(Object.hasOwn(bare, 'webTools'), false);
      assert.equal(Object.hasOwn(bare, 'maxRejections'), false);
      assert.equal(Object.keys(AI_CALL_PROVIDERS).some(key => key.startsWith('task:') && AI_CALL_PROVIDERS[key].webTools), false, 'no table entry carries webTools yet');
    },
  },
];
