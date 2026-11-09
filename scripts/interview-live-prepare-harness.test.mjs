import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { careerWritingStageProfile } from '../electron/ipc/careerWritingCore.js';
import { TAVILY_RESEARCH_TOOLS } from '../electron/ipc/tavily.js';
import {
  parseHarnessArgs, withUltracode, createCallRecorder, createMeasuredRunStage, workflowToolCalls,
  summarizeStageTotals, runHarness, createTavilyResearchCall, createResearchRouter, buildMergedResearchText,
  readResearchResponse, RESEARCH_MAX_CHARS, RESEARCH_SOURCE_LABELS,
} from './interview-live-prepare-harness.mjs';

const SNAPSHOT_ID = 'a'.repeat(64);
const harnessPath = fileURLToPath(new URL('./interview-live-prepare-harness.mjs', import.meta.url));

function argv(extra = [], { snapshot = SNAPSHOT_ID, out = '/tmp/interview-live-prep' } = {}) {
  return ['--user-data', '/tmp/harness-user-data', '--snapshot-id', snapshot, '--job-url', 'https://example.com/jobs/1',
    '--bundle-dir', '/tmp/harness-bundle', '--out', out, ...extra];
}

const invalidArguments = error => error?.code === 'INVALID_ARGUMENTS';

test('parseHarnessArgs defaults to the Claude transport with ultracode off', () => {
  const args = parseHarnessArgs(argv());
  assert.equal(args.transport, 'claude');
  assert.equal(args.ultracode, 'off');
  assert.equal(args['snapshot-id'], SNAPSHOT_ID);
  assert.equal(args.out, path.resolve('/tmp/interview-live-prep'));
});

test('parseHarnessArgs accepts explicit transport and ultracode settings', () => {
  assert.equal(parseHarnessArgs(argv(['--transport', 'claude', '--ultracode', 'off'])).transport, 'claude');
  const replay = parseHarnessArgs(argv(['--transport', 'replay', '--ultracode', 'on']));
  assert.equal(replay.transport, 'replay');
  assert.equal(replay.ultracode, 'on');
});

test('parseHarnessArgs rejects the removed codex transport and unknown transports', () => {
  assert.throws(() => parseHarnessArgs(argv(['--transport', 'codex'])), invalidArguments);
  assert.throws(() => parseHarnessArgs(argv(['--transport', 'Codex'])), invalidArguments);
  assert.throws(() => parseHarnessArgs(argv(['--transport', 'other'])), invalidArguments);
});

test('parseHarnessArgs rejects bad ultracode values, duplicates, relative paths and bad ids', () => {
  assert.throws(() => parseHarnessArgs(argv(['--ultracode', 'yes'])), invalidArguments);
  assert.throws(() => parseHarnessArgs(argv(['--ultracode', 'ON'])), invalidArguments);
  assert.throws(() => parseHarnessArgs(argv(['--ultracode', 'true'])), invalidArguments);
  assert.throws(() => parseHarnessArgs(argv(['--ultracode'])), invalidArguments);
  assert.throws(() => parseHarnessArgs(argv(['--transport', 'claude', '--transport', 'replay'])), invalidArguments);
  assert.throws(() => parseHarnessArgs(argv([], { out: 'relative/output' })), error => error.code === 'ABSOLUTE_DIRECTORIES_REQUIRED');
  assert.throws(() => parseHarnessArgs(argv([], { snapshot: 'not-a-sha256' })), invalidArguments);
  assert.throws(() => parseHarnessArgs(['--transport', 'claude']), error => error.code === 'MISSING_ARGUMENTS');
});

test('withUltracode sets opts.ultracode true only for an explicit on', () => {
  const seen = [];
  const call = (prompt, opts) => { seen.push({ prompt, opts }); return `reply:${prompt}`; };
  assert.equal(withUltracode(call, 'on')('first', { task: 'interview-brief-research', signal: null }), 'reply:first');
  withUltracode(call, 'off')('second', { task: 'interview-brief-assessment' });
  withUltracode(call, 'unexpected')('third');
  assert.deepEqual(seen[0].opts, { task: 'interview-brief-research', signal: null, ultracode: true });
  assert.equal(seen[1].opts.ultracode, false);
  assert.equal(seen[1].opts.task, 'interview-brief-assessment');
  assert.equal(seen[2].opts.ultracode, false);
});

test('withUltracode leaves the caller options object untouched and requires a callable', () => {
  const call = () => {};
  const opts = { task: 'interview-answer-bank' };
  withUltracode(call, 'on')('prompt', opts);
  assert.deepEqual(opts, { task: 'interview-answer-bank' });
  assert.throws(() => withUltracode(null, 'on'), error => error instanceof TypeError);
});

function fakeTranscripts() {
  const files = new Map();
  const lines = [];
  return {
    files, lines,
    save: async (name, text) => { files.set(name, String(text)); },
    append: async line => { lines.push(line); },
  };
}

test('workflowToolCalls counts only Workflow entries in tool events', () => {
  assert.equal(workflowToolCalls({ kind: 'tool', calls: [{ tool: 'Workflow' }, { tool: 'WebSearch' }] }), 1);
  assert.equal(workflowToolCalls({ kind: 'tool', calls: [{ tool: 'Workflow' }, { tool: 'Workflow' }] }), 2);
  assert.equal(workflowToolCalls({ kind: 'tool', calls: [{ tool: 'WebSearch' }] }), 0);
  assert.equal(workflowToolCalls({ kind: 'tool-progress', calls: [{ tool: 'Workflow' }] }), 0);
  assert.equal(workflowToolCalls({ kind: 'tool' }), 0);
  assert.equal(workflowToolCalls(null), 0);
});

test('the metrics recorder saves transcripts and records duration, cost, usage and Workflow launches', async () => {
  const io = fakeTranscripts();
  let clock = 1_000;
  const recorder = createCallRecorder({ save: io.save, append: io.append, now: () => clock });
  const context = { task: 'interview-answer-bank', stage: 'qa-write', attempts: 0 };
  const runStage = async args => {
    clock += 250;
    args.onActivity({ kind: 'tool', calls: [{ tool: 'Workflow', target: 'compare' }, { tool: 'WebSearch' }] });
    args.onActivity({ kind: 'tool', calls: [{ tool: 'Workflow' }] });
    args.onActivity({ kind: 'tool', calls: [{ tool: 'WebFetch' }] });
    args.onActivity({ kind: 'thinking' });
    return { text: `answer:${args.text}`, model: 'claude-opus-5', costUsd: 0.42, usage: { input_tokens: 10 }, durationMs: 200 };
  };
  const measured = createMeasuredRunStage({ runStage, recorder, currentCall: () => context });
  const reply = await measured({ text: 'the prompt' });
  assert.equal(reply.text, 'answer:the prompt');
  assert.equal(io.files.get('001.prompt.txt'), 'the prompt');
  assert.equal(io.files.get('001.response.txt'), 'answer:the prompt');
  assert.equal(io.lines.length, 1);
  const record = JSON.parse(io.lines[0]);
  assert.equal(record.number, '001');
  assert.equal(record.task, 'interview-answer-bank');
  assert.equal(record.stage, 'qa-write');
  assert.equal(record.attempt, 0);
  assert.equal(record.durationMs, 250);
  assert.equal(record.providerDurationMs, 200);
  assert.equal(record.costUsd, 0.42);
  assert.deepEqual(record.usage, { input_tokens: 10 });
  assert.equal(record.workflowCalls, 2);
  assert.equal(record.errorCode, null);
  assert.equal(record.outcome, 'ok');
  assert.equal(context.attempts, 1);
});

test('the metrics recorder numbers each attempt of one handoff and captures the error code', async () => {
  const io = fakeTranscripts();
  let clock = 0;
  const recorder = createCallRecorder({ save: io.save, append: io.append, now: () => clock });
  const context = { task: 'interview-brief-assessment', stage: 'qa-brief', attempts: 0 };
  const replies = [{ text: 'first' }, Object.assign(new Error('Claude Code timed out.'), { code: 'CLAUDE_TIMEOUT' })];
  const runStage = async args => {
    clock += 30;
    args.onActivity({ kind: 'tool', calls: [{ tool: 'Workflow' }] });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { ...next, costUsd: 0.1 };
  };
  const measured = createMeasuredRunStage({ runStage, recorder, currentCall: () => context });
  await measured({ text: 'prompt one' });
  await assert.rejects(measured({ text: 'prompt two' }), error => error.code === 'CLAUDE_TIMEOUT');
  const [first, second] = io.lines.map(line => JSON.parse(line));
  assert.equal(first.attempt, 0);
  assert.equal(second.attempt, 1);
  assert.equal(second.outcome, 'failed');
  assert.equal(second.errorCode, 'CLAUDE_TIMEOUT');
  assert.equal(second.durationMs, 30);
  assert.equal(second.costUsd, null);
  assert.equal(second.usage, null);
  assert.equal(second.workflowCalls, 1);
  assert.equal(io.files.get('002.prompt.txt'), 'prompt two');
  assert.equal(io.files.has('002.response.txt'), false, 'a failed attempt must not write a response transcript');
  assert.match(io.files.get('002.error.txt') ?? '', /^CLAUDE_TIMEOUT\nClaude Code timed out\.\n$/u);
  assert.equal(context.attempts, 2);
});

test('the measured runStage chains an existing onActivity and forwards every argument', async () => {
  const io = fakeTranscripts();
  const recorder = createCallRecorder({ save: io.save, append: io.append, now: () => 0 });
  const forwarded = [];
  const kinds = [];
  const runStage = async args => {
    forwarded.push(args);
    args.onActivity({ kind: 'tool', calls: [{ tool: 'Workflow' }] });
    return { text: 'reply' };
  };
  const measured = createMeasuredRunStage({
    runStage, recorder,
    currentCall: () => ({ task: 'interview-brief-research', stage: 'qa-research', attempts: 0 }),
  });
  const chained = event => kinds.push(event.kind);
  await measured({ text: 'research prompt', model: 'claude-opus-5', effort: 'xhigh', onActivity: chained });
  assert.equal(forwarded[0].model, 'claude-opus-5');
  assert.equal(forwarded[0].effort, 'xhigh');
  assert.deepEqual(kinds, ['tool'], 'the caller activity handler still receives the event');
  assert.equal(JSON.parse(io.lines[0]).workflowCalls, 1);
});

test('summarizeStageTotals adds per-stage attempts, calls, cost, duration, Workflow use and failures', () => {
  const summary = summarizeStageTotals({
    transportCalls: [{ stage: 'qa-research' }, { stage: 'qa-write' }, { stage: 'qa-write' }],
    calls: [
      { stage: 'qa-research', durationMs: 100, costUsd: 0.5, workflowCalls: 2, errorCode: null },
      { stage: 'qa-write', durationMs: 40, costUsd: 0.25, workflowCalls: 0, errorCode: null },
      { stage: 'qa-write', durationMs: 20, costUsd: null, workflowCalls: 1, errorCode: 'CLAUDE_TIMEOUT' },
    ],
  });
  assert.deepEqual(summary.stages['qa-research'], { calls: 1, attempts: 1, costUsd: 0.5, durationMs: 100, workflowCalls: 2, failures: 0 });
  assert.deepEqual(summary.stages['qa-write'], { calls: 2, attempts: 2, costUsd: 0.25, durationMs: 60, workflowCalls: 1, failures: 1 });
  assert.equal(summary.totals.attempts, 3);
  assert.equal(summary.totals.calls, 3);
  assert.equal(summary.totals.failures, 1);
  assert.equal(summary.totals.workflowCalls, 3);
  assert.equal(summary.totals.durationMs, 160);
});

test('importing the harness does not run it', () => {
  assert.equal(typeof runHarness, 'function');
  assert.notEqual(path.resolve(process.argv[1] ?? ''), path.resolve(harnessPath));
  assert.equal(process.exitCode ?? 0, 0);
});

test('parseHarnessArgs defaults research to native and stop-after to all', () => {
  const args = parseHarnessArgs(argv());
  assert.equal(args.research, 'native');
  assert.equal(args['stop-after'], 'all');
  assert.deepEqual(args.mergeFrom, []);
});

test('parseHarnessArgs accepts the research and stop-after modes', () => {
  assert.equal(parseHarnessArgs(argv(['--research', 'tavily'])).research, 'tavily');
  assert.equal(parseHarnessArgs(argv(['--research', 'native'])).research, 'native');
  assert.equal(parseHarnessArgs(argv(['--stop-after', 'brief']))['stop-after'], 'brief');
  assert.equal(parseHarnessArgs(argv(['--stop-after', 'all']))['stop-after'], 'all');
  const merged = parseHarnessArgs(argv(['--research', 'merged', '--merge-from', '/tmp/harness-a,/tmp/harness-b']));
  assert.equal(merged.research, 'merged');
  assert.deepEqual(merged.mergeFrom, [path.resolve('/tmp/harness-a'), path.resolve('/tmp/harness-b')]);
});

test('parseHarnessArgs rejects unknown research modes, stop-after values and merge-from misuse', () => {
  assert.throws(() => parseHarnessArgs(argv(['--research', 'claude'])), invalidArguments);
  assert.throws(() => parseHarnessArgs(argv(['--research', 'merged', '--merge-from'])), invalidArguments);
  assert.throws(() => parseHarnessArgs(argv(['--stop-after', 'answer-bank'])), invalidArguments);
  assert.throws(() => parseHarnessArgs(argv(['--research', 'merged'])), invalidArguments, 'merged needs --merge-from');
  assert.throws(() => parseHarnessArgs(argv(['--research', 'merged', '--merge-from', '/tmp/harness-a'])), invalidArguments);
  assert.throws(() => parseHarnessArgs(argv(['--research', 'merged', '--merge-from', '/tmp/harness-a,/tmp/harness-b,/tmp/harness-c'])), invalidArguments);
  assert.throws(() => parseHarnessArgs(argv(['--research', 'merged', '--merge-from', 'harness-a,/tmp/harness-b'])),
    error => error.code === 'ABSOLUTE_DIRECTORIES_REQUIRED');
  assert.throws(() => parseHarnessArgs(argv(['--research', 'native', '--merge-from', '/tmp/harness-a,/tmp/harness-b'])), invalidArguments);
});

test('buildMergedResearchText labels both sets in order and keeps them verbatim under the maximum', () => {
  const merged = buildMergedResearchText({ builtIn: 'built-in findings', tavily: 'tavily findings', maxLength: 1_000 });
  assert.equal(merged.text, 'SOURCE SET A (built-in web search):\nbuilt-in findings\n\nSOURCE SET B (Tavily search):\ntavily findings');
  assert.equal(merged.trimmed, false);
  assert.equal(merged.maxLength, 1_000);
  assert.deepEqual(merged.sets, [
    { source: 'built-in-web-search', label: RESEARCH_SOURCE_LABELS.builtIn, length: 17, kept: 17, dropped: 0 },
    { source: 'tavily', label: RESEARCH_SOURCE_LABELS.tavily, length: 15, kept: 15, dropped: 0 },
  ]);
});

test('buildMergedResearchText trims both sets proportionally to the validator maximum and flags it', () => {
  const builtIn = 'a'.repeat(60_000);
  const tavily = 'b'.repeat(60_000);
  const merged = buildMergedResearchText({ builtIn, tavily });
  assert.equal(merged.maxLength, RESEARCH_MAX_CHARS);
  assert.equal(RESEARCH_MAX_CHARS, 80_000);
  assert.equal(merged.trimmed, true);
  assert.ok(merged.text.length <= RESEARCH_MAX_CHARS);
  const [setA, setB] = merged.sets;
  assert.ok(setA.kept < builtIn.length && setB.kept < tavily.length);
  assert.equal(setA.dropped, setB.dropped, 'equal sources give up equal characters');
  assert.equal(merged.text, `${RESEARCH_SOURCE_LABELS.builtIn}:\n${builtIn.slice(0, setA.kept)}`
    + `\n\n${RESEARCH_SOURCE_LABELS.tavily}:\n${tavily.slice(0, setB.kept)}`);
  assert.equal(merged.text.length, RESEARCH_MAX_CHARS, 'the whole budget is used');
});

test('buildMergedResearchText gives the spare budget to an empty set and needs a positive maximum', () => {
  const short = buildMergedResearchText({ builtIn: '', tavily: 'b'.repeat(200), maxLength: 120 });
  assert.equal(short.sets[0].kept, 0);
  assert.equal(short.sets[1].kept, Math.min(200, 120 - (RESEARCH_SOURCE_LABELS.builtIn.length + RESEARCH_SOURCE_LABELS.tavily.length + 6)));
  assert.ok(short.text.length <= 120);
  assert.throws(() => buildMergedResearchText({ maxLength: 0 }), error => error instanceof TypeError);
});

test('readResearchResponse takes the accepted research response through calls.jsonl and its numbered file', async () => {
  const files = new Map([
    ['/tmp/harness-a/calls.jsonl', [
      JSON.stringify({ number: '001', task: 'interview-brief-research', stage: 'qa-research', outcome: 'failed', errorCode: 'CLAUDE_TIMEOUT' }),
      JSON.stringify({ number: '002', task: 'interview-brief-assessment', stage: 'qa-brief', outcome: 'ok' }),
      JSON.stringify({ number: '003', task: 'interview-brief-research', stage: 'qa-research', outcome: 'ok', model: 'opus' }),
    ].join('\n')],
    ['/tmp/harness-a/003.response.txt', 'the built-in search findings'],
  ]);
  const source = await readResearchResponse({ directory: '/tmp/harness-a', readFile: async file => {
    assert.ok(files.has(file), `unexpected read ${file}`);
    return files.get(file);
  } });
  assert.equal(source.callNumber, '003');
  assert.equal(source.text, 'the built-in search findings');
  assert.equal(source.length, 28);
  assert.equal(source.directory, '/tmp/harness-a');
  assert.equal(source.stage, 'qa-research');
  assert.equal(source.model, 'opus');
  await assert.rejects(readResearchResponse({ directory: '/tmp/harness-b',
    readFile: async () => JSON.stringify({ number: '001', task: 'interview-brief-assessment', outcome: 'ok' }) }),
  error => error.code === 'MERGE_RESEARCH_RESPONSE_MISSING');
});

test('the research router sends only interview-brief-research to the alternative path', async () => {
  const transport = [];
  const research = [];
  const routed = createResearchRouter({
    call: (prompt, opts) => { transport.push(opts?.task ?? null); return `transport:${prompt}`; },
    research: (prompt, opts) => { research.push(opts?.task ?? null); return `research:${prompt}`; },
  });
  assert.equal(await routed('r', { task: 'interview-brief-research', signal: null }), 'research:r');
  assert.equal(await routed('b', { task: 'interview-brief-assessment' }), 'transport:b');
  assert.equal(await routed('a', { task: 'interview-answer-bank' }), 'transport:a');
  assert.equal(await routed('u'), 'transport:u');
  assert.deepEqual(research, ['interview-brief-research']);
  assert.deepEqual(transport, ['interview-brief-assessment', 'interview-answer-bank', null]);
});

test('the native research router keeps the transport call and needs a callable', async () => {
  const seen = [];
  const routed = createResearchRouter({ call: (prompt, opts) => { seen.push(opts?.task); return `transport:${prompt}`; } });
  assert.equal(await routed('r', { task: 'interview-brief-research' }), 'transport:r');
  assert.deepEqual(seen, ['interview-brief-research']);
  assert.throws(() => createResearchRouter({ call: null }), error => error instanceof TypeError);
  assert.throws(() => createResearchRouter({ call: () => {}, research: 'tavily' }), error => error instanceof TypeError);
});

const TAVILY_TEST_KEY = 'tvly+test/secret-key';
const TAVILY_TEST_KEY_ENCODED = encodeURIComponent(TAVILY_TEST_KEY);
const qaResearchProfile = careerWritingStageProfile('qa-research');

test('the tavily research call passes the qa-research profile, Tavily tools/MCP, 24 turns and no ultracode', async () => {
  assert.deepEqual({ ...qaResearchProfile }, { model: 'opus', effort: 'xhigh' });
  const io = fakeTranscripts();
  let clock = 1_000;
  const recorder = createCallRecorder({ save: io.save, append: io.append, now: () => clock });
  const requests = [];
  const validated = [];
  const activities = [];
  const research = createTavilyResearchCall({
    runClaudeSdkStage: async request => {
      clock += 750;
      requests.push(request);
      request.onActivity({ kind: 'tool', calls: [{ tool: 'mcp__tavily__tavily_search' }, { tool: 'Workflow' }] });
      return { text: 'grounded research', model: 'claude-opus-5', costUsd: 0.75, usage: { input_tokens: 33 }, durationMs: 900 };
    },
    readKey: async () => `${TAVILY_TEST_KEY}\n`,
    profile: qaResearchProfile,
    recorder,
  });
  const text = await research('research prompt text', { task: 'interview-brief-research', signal: undefined,
    onActivity: event => { activities.push(event.kind); },
    responseValidator: value => { validated.push(value); } });
  assert.equal(text, 'grounded research');
  assert.deepEqual(validated, ['grounded research']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].text, 'research prompt text');
  assert.equal(requests[0].model, qaResearchProfile.model);
  assert.equal(requests[0].effort, qaResearchProfile.effort);
  assert.deepEqual(requests[0].tools, TAVILY_RESEARCH_TOOLS);
  assert.deepEqual(requests[0].mcpServers, { tavily: { type: 'http', url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_TEST_KEY_ENCODED}` } });
  assert.equal(requests[0].maxTurns, 24);
  assert.equal(requests[0].persistSession, false);
  assert.equal(Object.hasOwn(requests[0], 'ultracode'), true);
  assert.equal(requests[0].ultracode, false);
  assert.equal(io.files.get('001.prompt.txt'), 'research prompt text');
  assert.equal(io.files.get('001.response.txt'), 'grounded research');
  const record = JSON.parse(io.lines[0]);
  assert.equal(record.task, 'interview-brief-research');
  assert.equal(record.stage, 'qa-research');
  assert.equal(record.attempt, 0);
  assert.equal(record.outcome, 'ok');
  assert.equal(record.durationMs, 750);
  assert.equal(record.providerDurationMs, 900);
  assert.equal(record.costUsd, 0.75);
  assert.deepEqual(record.usage, { input_tokens: 33 });
  assert.equal(record.workflowCalls, 1);
  assert.equal(record.model, 'claude-opus-5');
  const saved = [...io.files.values(), ...io.lines].join('\n');
  assert.equal(saved.includes(TAVILY_TEST_KEY), false, 'the key is never saved');
  assert.equal(saved.includes(TAVILY_TEST_KEY_ENCODED), false, 'the encoded key is never saved');
  assert.deepEqual(activities, ['tool'], 'the caller activity handler still receives the event');
});

test('the tavily research call fails clearly without a key and never runs the SDK', async () => {
  let ran = false;
  for (const empty of ['', '   ', undefined]) {
    const research = createTavilyResearchCall({
      runClaudeSdkStage: async () => { ran = true; return { text: 'x' }; },
      readKey: async () => empty,
      profile: qaResearchProfile,
    });
    await assert.rejects(research('prompt', { task: 'interview-brief-research' }), error => error.code === 'TAVILY_KEY_MISSING');
  }
  const io = fakeTranscripts();
  const recorder = createCallRecorder({ save: io.save, append: io.append, now: () => 0 });
  const research = createTavilyResearchCall({ runClaudeSdkStage: async () => ({ text: 'x' }),
    readKey: async () => { throw new Error('keychain locked'); }, profile: qaResearchProfile, recorder });
  await assert.rejects(research('prompt', { task: 'interview-brief-research' }), error => error.code === 'TAVILY_KEY_MISSING');
  assert.equal(ran, false);
  assert.equal(io.files.size, 0, 'nothing is recorded for a call that never ran');
  assert.equal(io.lines.length, 0);
});

test('a tavily failure redacts the key from the thrown and recorded error', async () => {
  const io = fakeTranscripts();
  const recorder = createCallRecorder({ save: io.save, append: io.append, now: () => 0 });
  const failure = Object.assign(new Error(`MCP server https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_TEST_KEY_ENCODED} refused`),
    { code: 'CLAUDE_ERROR' });
  const research = createTavilyResearchCall({
    runClaudeSdkStage: async () => { throw failure; },
    readKey: async () => TAVILY_TEST_KEY,
    profile: qaResearchProfile,
    recorder,
  });
  await assert.rejects(research('prompt', { task: 'interview-brief-research' }), error => error.code === 'CLAUDE_ERROR'
    && error.message.includes('[REDACTED]')
    && !error.message.includes(TAVILY_TEST_KEY) && !error.message.includes(TAVILY_TEST_KEY_ENCODED));
  const record = JSON.parse(io.lines[0]);
  assert.equal(record.outcome, 'failed');
  assert.equal(record.errorCode, 'CLAUDE_ERROR');
  const saved = [...io.files.values(), ...io.lines].join('\n');
  assert.equal(saved.includes('[REDACTED]'), true);
  assert.equal(saved.includes(TAVILY_TEST_KEY), false);
  assert.equal(saved.includes(TAVILY_TEST_KEY_ENCODED), false);
});

test('the tavily research call rejects text the shared validator refuses and keeps the cost', async () => {
  const io = fakeTranscripts();
  const recorder = createCallRecorder({ save: io.save, append: io.append, now: () => 0 });
  const research = createTavilyResearchCall({
    runClaudeSdkStage: async () => ({ text: 'x'.repeat(80_001), model: 'claude-opus-5', costUsd: 0.5, durationMs: 400 }),
    readKey: async () => TAVILY_TEST_KEY,
    profile: qaResearchProfile,
    recorder,
  });
  await assert.rejects(research('prompt', {
    task: 'interview-brief-research',
    responseValidator: value => { if (value.length > RESEARCH_MAX_CHARS) throw Object.assign(new Error('text.too-long'), { code: 'VALIDATION_FAILED' }); },
  }), error => error.code === 'VALIDATION_FAILED');
  const record = JSON.parse(io.lines[0]);
  assert.equal(record.outcome, 'failed');
  assert.equal(record.errorCode, 'VALIDATION_FAILED');
  assert.equal(record.costUsd, 0.5);
  assert.equal(record.providerDurationMs, 400);
  assert.equal(io.files.has('001.response.txt'), false, 'refused research is not saved as a response');
});

test('the tavily research call needs the SDK stage, a key reader and the qa-research profile', () => {
  assert.throws(() => createTavilyResearchCall({ readKey: async () => TAVILY_TEST_KEY, profile: qaResearchProfile }),
    error => error instanceof TypeError);
  assert.throws(() => createTavilyResearchCall({ runClaudeSdkStage: async () => ({}), readKey: null, profile: qaResearchProfile }),
    error => error instanceof TypeError);
  assert.throws(() => createTavilyResearchCall({ runClaudeSdkStage: async () => ({}), readKey: async () => TAVILY_TEST_KEY, profile: {} }),
    error => error instanceof TypeError);
});
