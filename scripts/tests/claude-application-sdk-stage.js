import assert from 'node:assert/strict';
import { runClaudeSdkStage } from '../../electron/ipc/claudeApplicationSdkStage.js';
import { CLAUDE_HANDOFF_SYSTEM_PROMPT, CLAUDE_STAGE_TIMEOUT_MS } from '../../electron/ipc/claudeApplicationRunner.js';

const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const SAFE_SUMMARY = 'Use a concrete example for the opening paragraph.';

function assistant(content = [{ type: 'text', text: 'answer' }], model = SONNET, extra = {}) {
  return { type: 'assistant', parent_tool_use_id: null, message: { model, content, stop_reason: 'end_turn' }, ...extra };
}

function result(extra = {}) {
  return { type: 'result', subtype: 'success', is_error: false, result: 'answer', duration_ms: 42, modelUsage: { [SONNET]: {} }, ...extra };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fakeQuery(messages = [assistant(), result()]) {
  const calls = [];
  const queryImpl = options => {
    const call = { ...options, closed: false };
    calls.push(call);
    const generator = typeof messages === 'function'
      ? messages(call)
      : (async function* produce() { yield* messages; }());
    generator.close = () => { call.closed = true; };
    return generator;
  };
  return { calls, queryImpl };
}

function stage(queryImpl, options = {}) {
  return runClaudeSdkStage({
    text: 'private prompt', binary: '/bin/claude', env: { PATH: '/bin' }, cwd: '/tmp/application', queryImpl, ...options,
  });
}

async function rejected(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

export default [
  {
    name: 'claude SDK: uses the native summarized display with restricted prompt-only options and no fallback',
    async run() {
      const fake = fakeQuery();
      const value = await stage(fake.queryImpl);
      assert.deepEqual(value, { text: 'answer', model: SONNET, durationMs: 42, summaryCount: 0, summaryChars: 0, thinkingDisplay: 'summarized' });
      const { prompt, options, closed } = fake.calls[0];
      assert.equal(prompt, 'private prompt');
      assert.equal(closed, true);
      assert.deepEqual(options.thinking, { type: 'adaptive', display: 'summarized' });
      assert.deepEqual(options.tools, []);
      assert.deepEqual(options.mcpServers, {});
      assert.deepEqual(options.settingSources, []);
      assert.deepEqual(options.extraArgs, { restricted: null });
      assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code', append: CLAUDE_HANDOFF_SYSTEM_PROMPT });
      assert.equal(options.strictMcpConfig, true);
      assert.equal(options.persistSession, true);
      assert.equal(options.maxTurns, 1);
      assert.equal(options.pathToClaudeCodeExecutable, '/bin/claude');
      assert.equal(options.cwd, '/tmp/application');
      assert.deepEqual(options.env, { PATH: '/bin' });
      assert.equal('fallbackModel' in options, false);
      assert.equal('sessionId' in options, false);
      assert.equal('resume' in options, false);
    },
  },
  {
    name: 'claude SDK: sends images as one SDK user message and starts the specified persistent session',
    async run() {
      const fake = fakeQuery();
      const sessionId = '22222222-2222-4222-8222-222222222222';
      const pageImages = [{ candidateId: 'A', document: 'resume', mimeType: 'image/jpeg', data: 'ZmFrZQ==' }];
      await stage(fake.queryImpl, { pageImages, sessionId });
      const sent = [];
      for await (const message of fake.calls[0].prompt) sent.push(message);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'user');
      assert.equal(sent[0].message.role, 'user');
      assert.equal(sent[0].parent_tool_use_id, null);
      assert.equal(sent[0].session_id, sessionId);
      assert.equal(sent[0].client_composed, true);
      assert.deepEqual(sent[0].message.content, [
        { type: 'text', text: 'private prompt' },
        { type: 'text', text: 'Page image 1: candidate A, resume' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZQ==' } },
      ]);
      assert.equal(fake.calls[0].options.sessionId, sessionId);
      assert.equal('resume' in fake.calls[0].options, false);
    },
  },
  {
    name: 'claude SDK: corrections resume the same session without sending mutually exclusive sessionId',
    async run() {
      const fake = fakeQuery([assistant(undefined, OPUS), result({ modelUsage: { [OPUS]: {} } })]);
      await stage(fake.queryImpl, { sessionId: 'resume-session', resume: true, model: 'opus', effort: 'xhigh' });
      assert.equal(fake.calls[0].options.resume, 'resume-session');
      assert.equal('sessionId' in fake.calls[0].options, false);
      assert.equal(fake.calls[0].options.model, 'opus');
      assert.equal(fake.calls[0].options.effort, 'xhigh');
    },
  },
  {
    name: 'claude SDK: awaits each readable summary before consuming the next message or completing',
    async run() {
      const entered = deferred();
      const release = deferred();
      const summaries = [];
      let consumedAfterSummary = false;
      let finished = false;
      const fake = fakeQuery(async function* produce() {
        yield assistant([{ type: 'thinking', thinking: SAFE_SUMMARY }]);
        consumedAfterSummary = true;
        yield assistant([{ type: 'thinking', thinking: 'Second summary.' }]);
        yield assistant();
        yield result();
      });
      const pending = stage(fake.queryImpl, { onThinkingSummary: async row => {
        summaries.push(row);
        if (summaries.length === 1) { entered.resolve(); await release.promise; }
      } }).then(value => { finished = true; return value; });
      await entered.promise;
      assert.equal(finished, false);
      assert.equal(consumedAfterSummary, false);
      release.resolve();
      const value = await pending;
      assert.deepEqual(summaries, [
        { text: SAFE_SUMMARY, model: SONNET, index: 1, thinkingDisplay: 'summarized' },
        { text: 'Second summary.', model: SONNET, index: 2, thinkingDisplay: 'summarized' },
      ]);
      assert.equal(value.summaryCount, 2);
      assert.equal(value.summaryChars, SAFE_SUMMARY.length + 'Second summary.'.length);
      assert.equal(value.text, 'answer');
    },
  },
  {
    name: 'claude SDK: never reads signatures, redacted data, raw stream events or unrelated agent summaries',
    async run() {
      const summaryBlock = { type: 'thinking', thinking: SAFE_SUMMARY };
      Object.defineProperty(summaryBlock, 'signature', { get() { throw new Error('signature was read'); }, enumerable: true });
      const redacted = { type: 'redacted_thinking' };
      Object.defineProperty(redacted, 'data', { get() { throw new Error('redacted data was read'); }, enumerable: true });
      const raw = { type: 'stream_event' };
      Object.defineProperty(raw, 'event', { get() { throw new Error('raw event was read'); }, enumerable: true });
      const fake = fakeQuery([
        raw,
        assistant([redacted, summaryBlock]),
        assistant([{ type: 'thinking', thinking: 'PRIVATE SUBAGENT DATA' }], OPUS, { parent_tool_use_id: 'subagent' }),
        assistant([{ type: 'thinking', thinking: 'PRIVATE AGENT DATA' }], OPUS, { agent_id: 'agent' }),
        assistant(), result(),
      ]);
      const rows = [];
      const value = await stage(fake.queryImpl, { onThinkingSummary: async row => { rows.push(row); } });
      assert.equal(rows.length, 1);
      assert.equal(value.summaryCount, 1);
      assert.equal(JSON.stringify({ rows, value }).includes('PRIVATE'), false);
    },
  },
  {
    name: 'claude SDK: empty and unverified-model summaries are not logged',
    async run() {
      const fake = fakeQuery([
        assistant([{ type: 'thinking', thinking: '   ' }]),
        assistant([{ type: 'thinking', thinking: 'unverified summary' }], undefined, { message: { content: [{ type: 'thinking', thinking: 'unverified summary' }] } }),
        assistant(), result(),
      ]);
      const rows = [];
      const value = await stage(fake.queryImpl, { onThinkingSummary: async row => { rows.push(row); } });
      assert.equal(rows.length, 0);
      assert.equal(value.summaryCount, 0);
    },
  },
  {
    name: 'claude SDK: summary log failures terminate the query without returning a partial answer',
    async run() {
      let continued = false;
      const fake = fakeQuery(async function* produce() {
        yield assistant([{ type: 'thinking', thinking: SAFE_SUMMARY }]);
        continued = true;
        yield assistant(); yield result();
      });
      const error = await rejected(stage(fake.queryImpl, { onThinkingSummary: async () => { throw new Error('disk full'); } }), 'CLAUDE_LOG_ERROR');
      assert.equal(continued, false);
      assert.equal(fake.calls[0].closed, true);
      assert.equal(error.detail.cause, 'disk full');
      assert.equal('result' in error, false);
    },
  },
  {
    name: 'claude SDK: provider error result retains only plain result and structured metadata',
    async run() {
      const fake = fakeQuery([
        assistant([{ type: 'thinking', thinking: SAFE_SUMMARY }]),
        result({ is_error: true, result: 'API Error: overloaded', api_error_status: 503, errors: ['Try again later'] }),
      ]);
      const rows = [];
      const error = await rejected(stage(fake.queryImpl, { onThinkingSummary: async row => { rows.push(row); } }), 'CLAUDE_ERROR');
      assert.equal(rows.length, 1);
      assert.equal(error.result, 'API Error: overloaded');
      assert.equal(error.detail.apiErrorStatus, 503);
      assert.deepEqual(error.detail.errors, ['Try again later']);
      assert.equal(error.detail.summaryCount, 1);
      assert.equal(JSON.stringify(error).includes(SAFE_SUMMARY), false);
    },
  },
  {
    name: 'claude SDK: successful CLI subtype cannot turn a safeguard provider error into an answer',
    async run() {
      const providerMessage = "Opus 5.5's safeguards flagged this message. Details: `[reasoning_extraction]`";
      const fake = fakeQuery([assistant([{ type: 'text', text: providerMessage }]), result({ result: providerMessage })]);
      const error = await rejected(stage(fake.queryImpl), 'CLAUDE_SAFEGUARD_BLOCKED');
      assert.equal(error.result, providerMessage);
      assert.equal(error.detail.refusalCategory, 'reasoning_extraction');
    },
  },
  {
    name: 'claude SDK: thrown plain safeguard messages retain diagnostic IDs beyond a short display excerpt',
    async run() {
      const providerMessage = [
        "Sonnet 5.5's safeguards flagged this message.",
        'This is a synthetic provider explanation for a diagnostic retention test. '.repeat(8).trim(),
        'Details: `[reasoning_extraction]`',
        'Request ID: req_longProvider12345678',
        'Message ID: msg_longProvider87654321',
      ].join('\n');
      assert.ok(providerMessage.indexOf('Details:') > 300);
      const fake = fakeQuery(async function* produce() {
        yield assistant();
        throw new Error(providerMessage);
      });
      const error = await rejected(stage(fake.queryImpl), 'CLAUDE_SAFEGUARD_BLOCKED');
      assert.equal(error.result, providerMessage);
      assert.equal(error.detail.refusalCategory, 'reasoning_extraction');
      assert.equal(error.detail.requestId, 'req_longProvider12345678');
      assert.equal(error.detail.messageId, 'msg_longProvider87654321');
      assert.equal(fake.calls[0].closed, true);
    },
  },
  {
    name: 'claude SDK: thrown safeguard diagnostics exclude appended raw signature and redacted stream records',
    async run() {
      const providerMessage = [
        "API Error: Sonnet 5.5's safeguards flagged this message.",
        'This is a synthetic plain explanation that must remain available in the private audit. '.repeat(6).trim(),
        'Details: `[reasoning_extraction]`',
        'Request ID: req_safePrefix12345678',
        'Message ID: msg_safePrefix87654321',
      ].join('\n');
      const rawRecord = JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'thinking', thinking: 'DO_NOT_COPY_RAW_THINKING', signature: 'DO_NOT_COPY_SIGNATURE' },
        { type: 'redacted_thinking', data: 'DO_NOT_COPY_REDACTED_DATA' },
      ] } });
      const fake = fakeQuery(async function* produce() {
        yield assistant();
        const failure = new Error(`${providerMessage}\n${rawRecord}\nDO_NOT_COPY_RAW_TRAILER`);
        Object.defineProperty(failure, 'rawStream', { get() { throw new Error('raw transport field was read'); }, enumerable: true });
        throw failure;
      });
      const error = await rejected(stage(fake.queryImpl), 'CLAUDE_SAFEGUARD_BLOCKED');
      assert.equal(error.result, providerMessage);
      assert.equal(error.detail.refusalCategory, 'reasoning_extraction');
      assert.equal(error.detail.requestId, 'req_safePrefix12345678');
      assert.equal(error.detail.messageId, 'msg_safePrefix87654321');
      assert.doesNotMatch(JSON.stringify(error), /DO_NOT_COPY|rawStream/u);
      assert.equal(fake.calls[0].closed, true);
    },
  },
  {
    name: 'claude SDK: stop_reason refusal rejects otherwise successful answer',
    async run() {
      const fake = fakeQuery([assistant(undefined, SONNET, { message: { model: SONNET, stop_reason: 'refusal', content: [{ type: 'text', text: 'declined' }] } }), result({ result: 'declined' })]);
      const error = await rejected(stage(fake.queryImpl), 'CLAUDE_SAFEGUARD_BLOCKED');
      assert.equal(error.result, 'declined');
      assert.deepEqual(error.detail.assistantStopReasons, ['refusal']);
    },
  },
  {
    name: 'claude SDK: structured no-fallback refusal preserves category without raw provider event',
    async run() {
      const fake = fakeQuery([
        { type: 'system', subtype: 'model_refusal_no_fallback', request_id: 'req_123456789', api_refusal_category: 'reasoning_extraction', content: 'RAW EVENT SHOULD NOT BE LOGGED' },
        result({ is_error: true, result: 'Request declined.' }),
      ]);
      const error = await rejected(stage(fake.queryImpl), 'CLAUDE_SAFEGUARD_BLOCKED');
      assert.equal(error.detail.refusalCategory, 'reasoning_extraction');
      assert.equal(error.detail.requestId, 'req_123456789');
      assert.equal(error.result, 'Request declined.');
      assert.equal(JSON.stringify(error).includes('RAW EVENT'), false);
    },
  },
  {
    name: 'claude SDK: a main model fallback event stops the run before its answer is accepted',
    async run() {
      let continued = false;
      const fake = fakeQuery(async function* produce() {
        yield { type: 'system', subtype: 'model_refusal_fallback', scope: 'session', api_refusal_category: 'reasoning_extraction' };
        continued = true;
        yield assistant(); yield result();
      });
      await rejected(stage(fake.queryImpl), 'CLAUDE_SAFEGUARD_BLOCKED');
      assert.equal(continued, false);
      assert.equal(fake.calls[0].closed, true);
    },
  },
  {
    name: 'claude SDK: terminal refusal stop_reason is fatal',
    async run() {
      const fake = fakeQuery([assistant(), result({ stop_reason: 'refusal' })]);
      await rejected(stage(fake.queryImpl), 'CLAUDE_SAFEGUARD_BLOCKED');
    },
  },
  {
    name: 'claude SDK: modelUsage cannot verify a different main answering model',
    async run() {
      const fake = fakeQuery([assistant(undefined, OPUS), result({ modelUsage: { [SONNET]: {}, [OPUS]: {} } })]);
      const error = await rejected(stage(fake.queryImpl), 'CLAUDE_WRONG_MODEL');
      assert.deepEqual(error.detail.models, [OPUS]);
      assert.deepEqual(error.detail.usageModels, [SONNET, OPUS]);
      assert.equal(error.result, 'answer');
    },
  },
  {
    name: 'claude SDK: requested-family thinking without a verified main text answer cannot prove the answering model',
    async run() {
      const fake = fakeQuery([assistant([{ type: 'thinking', thinking: SAFE_SUMMARY }]), result()]);
      await rejected(stage(fake.queryImpl), 'CLAUDE_WRONG_MODEL');
    },
  },
  {
    name: 'claude SDK: correct subagent modelUsage cannot verify missing main assistant frames',
    async run() {
      const fake = fakeQuery([assistant(undefined, SONNET, { parent_tool_use_id: 'agent-tool' }), result()]);
      await rejected(stage(fake.queryImpl), 'CLAUDE_WRONG_MODEL');
    },
  },
  {
    name: 'claude SDK: a missing model on main text fails even if earlier thinking has a matching model',
    async run() {
      const fake = fakeQuery([
        assistant([{ type: 'thinking', thinking: SAFE_SUMMARY }]),
        { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'answer' }] } }, result(),
      ]);
      await rejected(stage(fake.queryImpl), 'CLAUDE_WRONG_MODEL');
    },
  },
  {
    name: 'claude SDK: errors on assistant frames reject successful terminal results',
    async run() {
      const fake = fakeQuery([assistant(undefined, '<synthetic>', { error: 'authentication_failed' }), result()]);
      const error = await rejected(stage(fake.queryImpl), 'CLAUDE_NOT_SIGNED_IN');
      assert.deepEqual(error.detail.assistantErrors, ['authentication_failed']);
    },
  },
  {
    name: 'claude SDK: structured terminal errors fail even when subtype says success',
    async run() {
      const fake = fakeQuery([assistant(), result({ errors: ['rate_limit'] })]);
      const error = await rejected(stage(fake.queryImpl), 'CLAUDE_USAGE_LIMIT');
      assert.deepEqual(error.detail.errors, ['rate_limit']);
    },
  },
  {
    name: 'claude SDK: a thrown startup failure is classified and query resources close',
    async run() {
      const fake = fakeQuery(async function* produce() { yield await Promise.reject(new Error('not logged in')); });
      await rejected(stage(fake.queryImpl), 'CLAUDE_NOT_SIGNED_IN');
      assert.equal(fake.calls[0].closed, true);
      const missing = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
      await rejected(stage(missing), 'CLAUDE_CLI_MISSING');
    },
  },
  {
    name: 'claude SDK: absent terminal result and empty successful answers fail without using partial text',
    async run() {
      for (const messages of [[assistant()], [assistant(), result({ result: '  ' })]]) {
        const error = await rejected(stage(fakeQuery(messages).queryImpl), 'CLAUDE_ERROR');
        assert.notEqual(error.result, 'answer');
      }
    },
  },
  {
    name: 'claude SDK: cancellation before launch never calls the SDK',
    async run() {
      const controller = new AbortController();
      controller.abort();
      const fake = fakeQuery();
      await rejected(stage(fake.queryImpl, { signal: controller.signal }), 'CLAUDE_CANCELLED');
      assert.equal(fake.calls.length, 0);
    },
  },
  {
    name: 'claude SDK: cancellation settles and closes a query whose next() never resolves',
    async run() {
      const controller = new AbortController();
      const entered = deferred();
      const fake = fakeQuery(async function* produce() { entered.resolve(); yield await new Promise(() => {}); });
      const pending = stage(fake.queryImpl, { signal: controller.signal });
      const observed = rejected(pending, 'CLAUDE_CANCELLED');
      await entered.promise;
      controller.abort();
      await observed;
      assert.equal(fake.calls[0].closed, true);
      assert.equal(fake.calls[0].options.abortController.signal.aborted, true);
    },
  },
  {
    name: 'claude SDK: timeout settles hanging queries and clears its timer',
    async run() {
      const entered = deferred();
      const fake = fakeQuery(async function* produce() { entered.resolve(); yield await new Promise(() => {}); });
      const timers = [];
      const cleared = [];
      const pending = stage(fake.queryImpl, {
        setTimeoutImpl: (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.push(timer); return timer; },
        clearTimeoutImpl: timer => { cleared.push(timer); },
      });
      const observed = rejected(pending, 'CLAUDE_TIMEOUT');
      await entered.promise;
      assert.equal(timers[0].ms, CLAUDE_STAGE_TIMEOUT_MS);
      timers[0].callback();
      await observed;
      assert.deepEqual(cleared, [timers[0]]);
      assert.equal(fake.calls[0].closed, true);
      assert.equal(fake.calls[0].options.abortController.signal.aborted, true);
    },
  },
  {
    name: 'claude SDK: cancellation during a summary write prevents later answer consumption',
    async run() {
      const controller = new AbortController();
      const entered = deferred();
      const release = deferred();
      let continued = false;
      const fake = fakeQuery(async function* produce() {
        yield assistant([{ type: 'thinking', thinking: SAFE_SUMMARY }]);
        continued = true;
        yield assistant(); yield result();
      });
      const pending = stage(fake.queryImpl, { signal: controller.signal, onThinkingSummary: async () => { entered.resolve(); await release.promise; } });
      const observed = rejected(pending, 'CLAUDE_CANCELLED');
      await entered.promise;
      controller.abort();
      await observed;
      release.resolve();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(continued, false);
      assert.equal(fake.calls[0].closed, true);
    },
  },
  {
    name: 'claude SDK: the output cap measures UTF-8 bytes before any oversized summary is logged',
    async run() {
      let logged = false;
      const fake = fakeQuery([assistant([{ type: 'thinking', thinking: 'é'.repeat(8 * 1024 * 1024 + 1) }])]);
      const error = await rejected(stage(fake.queryImpl, { onThinkingSummary: async () => { logged = true; } }), 'CLAUDE_ERROR');
      assert.match(error.message, /16 MB/u);
      assert.equal(logged, false);
      assert.equal(fake.calls[0].closed, true);
      assert.equal('result' in error, false);
    },
  },
  {
    name: 'claude SDK: accumulated assistant plus terminal output cannot exceed the cap',
    async run() {
      const large = 'x'.repeat(9 * 1024 * 1024);
      const fake = fakeQuery([assistant([{ type: 'text', text: large }]), result({ result: large })]);
      const error = await rejected(stage(fake.queryImpl), 'CLAUDE_ERROR');
      assert.match(error.message, /16 MB/u);
      assert.equal('result' in error, false);
    },
  },
];
