import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { createInterviewAiMatcher as createPooledMatcher, parseInterviewAiSelection, interviewAiMatcherConfigFromEnv, INTERVIEW_AI_MATCH_DEFAULTS } from '../../electron/interviewAiMatcher.js';
// These existing lifecycle tests intentionally exercise one warm session.
// Pool concurrency and the production default are covered in speculative-pool.
const createInterviewAiMatcher = options => createPooledMatcher({ ...options, config: { ...options?.config, poolSize: 1 } });
import { createInterviewAiTransport } from '../../electron/interviewAiTransports.js';

// Synthetic fixtures only; no CLI or bridge/model request is made by this suite.
const bank = { cards: [
  { id: 'project', question: 'Describe a project.', headline: { text: 'I built a garden watering timer.' } },
  { id: 'team', question: 'Describe working with others.', headline: { text: 'We divided community garden tasks.' } },
] };
const answer = (cardId = 'project', kind = 'question', confidence = 0.95) => JSON.stringify({ kind, cardId, confidence });
function stub(extra = {}) {
  const calls = { starts: [], matches: [], closes: 0 };
  const matcher = createInterviewAiMatcher({ bank, config: { transport: 'chatgpt-bridge' }, transportFactory: async () => ({
    async start(value) { calls.starts.push(value); },
    async match(value) { calls.matches.push(value); return answer(); },
    close() { calls.closes += 1; }, ...extra,
  }) });
  return { matcher, calls };
}
const HELP = '--print --model --output-format --tools --system-prompt --no-session-persistence --strict-mcp-config --mcp-config --safe-mode --effort --input-format --verbose --include-partial-messages --sandbox --config --json --skip-git-repo-check --ignore-user-config --ephemeral --ignore-rules';
function fakeCli({ codexTool = false, malformedEvent, matchResults = [], deferMatches = false } = {}) {
  const children = [];
  const writes = [];
  const pendingMatches = [];
  let matchIndex = 0;
  function spawn(binary, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.signals = [];
    const record = { binary, args, options, child }; children.push(record);
    const emit = value => queueMicrotask(() => child.stdout.emit('data', value));
    child.kill = signal => { child.signals.push(signal); child.emit('close', 0); };
    child.stdin.end = input => {
      if (args.includes('--help')) emit(HELP);
      else {
        writes.push(input);
        emit(binary === 'codex-test' ? [
          ...(codexTool ? [{ type: 'item.completed', item: { type: 'command_execution' } }] : []),
          { type: 'item.completed', item: { type: 'agent_message', text: answer() } }, { type: 'turn.completed' },
        ].map(value => JSON.stringify(value)).join('\n') : JSON.stringify({ type: 'result', subtype: 'success', result: answer() }));
      }
      queueMicrotask(() => child.emit('close', 0));
    };
    child.stdin.write = (input, callback) => {
      const message = JSON.parse(input); writes.push(message);
      const result = message.message.content.includes('Reply only READY.') ? 'READY' : matchResults[matchIndex++] ?? answer();
      if (result !== 'READY' && malformedEvent !== undefined) emit(`${JSON.stringify(malformedEvent)}\n`);
      const line = JSON.stringify({ type: 'result', subtype: 'success', session_id: 'synthetic-session', user_message_uuid: message.uuid, result }) + '\n';
      const reply = () => { emit(line.slice(0, 14)); emit(line.slice(14)); };
      if (deferMatches && result !== 'READY') pendingMatches.push(reply);
      else reply();
      callback?.();
    };
    return child;
  }
  return { spawn, children, writes, pendingMatches };
}

export default [
  { name: 'interview AI matcher: saved-evidence locks accept AI follow-up none with the prior question', async run() {
    const calls = [];
    const matcher = createInterviewAiMatcher({ bank, transportFactory: async () => ({
      async start() {}, async match(input) { calls.push(input); return answer('none', 'follow-up'); }, async close() {},
    }) });
    try {
      const previousQuestion = 'Tell me about leading a team.';
      const result = await matcher.match('What was the result of that?', { previousPlanLocked: true, previousQuestion });
      assert.equal(result.kind, 'follow-up'); assert.equal(result.cardId, 'none'); assert.equal(result.source, 'ai');
      assert.equal(calls.length, 1); assert.equal(calls[0].previousPlanLocked, true); assert.equal(calls[0].previousQuestion, previousQuestion);
      assert.throws(() => parseInterviewAiSelection(answer('none', 'follow-up'), bank.cards), /INVALID_SELECTION/u);
      assert.throws(() => parseInterviewAiSelection(answer('project', 'follow-up'), bank.cards, null, true), /INVALID_SELECTION/u);
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: cancelled warm callers detach while their turn drains before the next question', async run() {
    const fake = fakeCli({ deferMatches: true, matchResults: [answer('team'), answer('project')] });
    const matcher = createInterviewAiMatcher({ bank, config: { transport: 'claude-warm', claudeBin: 'claude-test' },
      transportFactory: (config, options) => createInterviewAiTransport(config, { ...options, spawn: fake.spawn }) });
    const waitFor = async condition => {
      for (let attempts = 0; attempts < 100 && !condition(); attempts += 1) await new Promise(resolve => setImmediate(resolve));
      assert.ok(condition(), 'the synthetic transport reached the expected request');
    };
    try {
      await matcher.start();
      const abort = new AbortController();
      const first = matcher.match('Describe working with others.', { signal: abort.signal });
      await waitFor(() => fake.pendingMatches.length === 1);
      abort.abort(); await assert.rejects(first, { name: 'AbortError' });
      const second = matcher.match('Describe a project.');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(fake.writes.length, 2, 'the next question waits behind the orphaned UUID');
      assert.deepEqual(fake.children[1].child.signals, []);
      fake.pendingMatches.shift()();
      await waitFor(() => fake.pendingMatches.length === 1);
      fake.pendingMatches.shift()();
      const selected = await second;
      assert.equal(selected.source, 'ai'); assert.equal(selected.cardId, 'project');
      assert.equal(fake.children.length, 2, 'capability probe and one warm process only');
      assert.equal(fake.writes.length, 3); assert.deepEqual(fake.children[1].child.signals, []);
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI transports: cancelling a queued warm question never sends it or retires the process', async run() {
    const fake = fakeCli({ deferMatches: true });
    const transport = await createInterviewAiTransport({ transport: 'claude-warm', claudeBin: 'claude-test' }, { spawn: fake.spawn });
    try {
      await transport.start({ instructions: 'synthetic cards' });
      const first = transport.match({ question: 'Describe a project.' });
      const abort = new AbortController();
      const queued = transport.match({ question: 'This queued question is cancelled.', signal: abort.signal });
      abort.abort(); await assert.rejects(queued, { name: 'AbortError' });
      fake.pendingMatches.shift()(); await first;
      assert.equal(fake.writes.length, 2); assert.deepEqual(fake.children[1].child.signals, []);
    } finally { await transport.close(); }
  } },
  { name: 'interview AI matcher: timed-out sessions rewarm during idle before the next question deadline', async run() {
    let creations = 0; let closes = 0; let recovered;
    const ready = new Promise(resolve => { recovered = resolve; });
    const matcher = createInterviewAiMatcher({ bank, config: { timeoutMs: 15, initTimeoutMs: 500 }, transportFactory: async () => {
      const current = ++creations;
      return { async start() {
        if (current > 1) { await new Promise(resolve => setTimeout(resolve, 40)); recovered(); }
      }, match: () => current === 1 ? new Promise(() => {}) : Promise.resolve(answer()), close() { closes += 1; } };
    } });
    try {
      await matcher.start();
      assert.equal((await matcher.match('Describe a project.')).reason, 'timeout');
      await ready;
      assert.equal(creations, 2, 'a replacement initializes without waiting for another question');
      assert.equal(closes, 1);
      assert.equal((await matcher.match('Describe a project.')).source, 'ai');
      assert.equal(creations, 2);
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: failed background recovery retries once and closes without a respawn loop', async run() {
    let creations = 0;
    const matcher = createInterviewAiMatcher({ bank, transportFactory: async () => {
      creations += 1;
      return { async start() { throw new Error('provider unavailable'); }, async close() {} };
    } });
    try {
      await assert.rejects(matcher.start(), /provider unavailable/u);
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(creations, 2, 'one initial attempt and one idle recovery attempt');
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI transports: saved-evidence lock includes the prior question without inventing a card id', async run() {
    const calls = [];
    const transport = await createInterviewAiTransport({ transport: 'chatgpt-bridge' }, { request: async input => {
      calls.push(input); return JSON.parse(answer('none', 'follow-up'));
    } });
    try {
      await transport.start({ instructions: 'synthetic cards' });
      await transport.match({ question: 'What was the result of that?', previousPlanLocked: true, previousQuestion: 'Tell me about leading a team.' });
      assert.deepEqual(JSON.parse(calls[0].prompt), { question: 'What was the result of that?', previousPlanLocked: true, previousQuestion: 'Tell me about leading a team.' });
    } finally { await transport.close(); }
  } },
  { name: 'interview AI matcher: a queued bank retains the explicit old locked id only for follow-ups', async run() {
    const calls = [];
    let kind = 'follow-up';
    const matcher = createInterviewAiMatcher({ bank, config: { transport: 'chatgpt-bridge' }, transportFactory: async () => ({
      async start() {}, async match(input) { calls.push(input); return answer('old-locked', kind); }, async close() {},
    }) });
    const context = { previousCardId: 'old-locked', previousCardQuestion: 'The original locked prepared question?', previousQuestion: 'The prior spoken turn?' };
    try {
      const followUp = await matcher.match('And what happened next?', context);
      assert.equal(followUp.kind, 'follow-up'); assert.equal(followUp.cardId, 'old-locked'); assert.equal(followUp.source, 'ai');
      assert.equal(calls[0].previousCardQuestion, context.previousCardQuestion);
      kind = 'question';
      const invalid = await matcher.match('Why Discord?', context);
      assert.equal(invalid.source, 'approximate'); assert.equal(invalid.reason, 'invalid'); assert.equal(invalid.cardId, 'none');
      assert.equal(calls.length, 2, 'new questions cannot select a retired bank card or add a classification call');
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: benchmark defaults select warm Opus with independent startup and question deadlines', async run() {
    assert.deepEqual(INTERVIEW_AI_MATCH_DEFAULTS, { transport: 'claude-warm', model: 'opus', effort: 'default',
      timeoutMs: 2500, initTimeoutMs: 10000, latencyThresholdMs: 2500, minConfidence: 0.55 });
    const configs = [];
    for (const config of [{}, { transport: 'chatgpt-bridge' }, { transport: 'codex', model: 'synthetic-codex', effort: 'low' }]) {
      const matcher = createInterviewAiMatcher({ bank, config, transportFactory: async settings => {
        configs.push(settings); return { start: async () => {}, match: async () => answer(), close() {} };
      } });
      try { assert.equal((await matcher.match('Describe a project.')).source, 'ai'); }
      finally { await matcher.close(); }
    }
    assert.deepEqual(configs.map(({ transport, model, effort }) => ({ transport, model, effort })), [
      { transport: 'claude-warm', model: 'opus', effort: 'default' },
      { transport: 'chatgpt-bridge', model: null, effort: null },
      { transport: 'codex', model: 'synthetic-codex', effort: 'low' },
    ]);
  } },
  { name: 'interview AI matcher: failed warm initialization or question retries cold Opus before Approximate', async run() {
    for (const stage of ['start', 'match']) {
      const calls = []; const configs = []; const closed = [];
      const matcher = createInterviewAiMatcher({ bank, transportFactory: async config => {
        const kind = config.transport; configs.push(config);
        return { start: async value => {
          calls.push(`${kind}:start`); assert.match(value.instructions, /garden watering/u);
          if (kind === 'claude-warm' && stage === 'start') throw new Error('missing warm capability');
        }, match: async value => {
          calls.push(`${kind}:match`); assert.equal(value.question, 'Describe a project.');
          if (kind === 'claude-warm') throw new Error('process exited');
          return answer('team');
        }, close() { closed.push(kind); } };
      } });
      try {
        const result = await matcher.match('Describe a project.');
        assert.equal(result.source, 'ai'); assert.equal(result.cardId, 'team'); assert.equal(result.approximate, false);
        assert.deepEqual(configs.map(({ transport, model, effort }) => ({ transport, model, effort })), [
          { transport: 'claude-warm', model: 'opus', effort: 'default' },
          { transport: 'claude-cold', model: 'opus', effort: 'default' },
        ]);
        assert.deepEqual(calls, stage === 'start' ? ['claude-warm:start', 'claude-cold:start', 'claude-cold:match']
          : ['claude-warm:start', 'claude-warm:match', 'claude-cold:start', 'claude-cold:match']);
        assert.deepEqual(closed, ['claude-warm', 'claude-cold']);
      } finally { await matcher.close(); }
    }
  } },
  { name: 'interview AI matcher: both Claude routes failing uses conservative labelled Approximate without bridge', async run() {
    for (const question of ['Can you describe a project?', 'Can you describe a project? Describe working with others.']) {
      const routes = [];
      const matcher = createInterviewAiMatcher({ bank, transportFactory: async config => {
        routes.push(config.transport);
        return { start: async () => {}, match: async () => { throw new Error('unavailable'); }, close() {} };
      } });
      try {
        const result = await matcher.match(question);
        assert.deepEqual(routes, ['claude-warm', 'claude-cold']);
        assert.equal(result.source, 'approximate'); assert.equal(result.confidence, 0); assert.match(result.label, /Approximate/u);
        assert.equal(result.cardId, question === 'Can you describe a project?' ? 'project' : 'none');
      } finally { await matcher.close(); }
    }
  } },
  { name: 'interview AI matcher: successful warm abstention never retries cold or overrides confidence', async run() {
    for (const selection of [answer('none'), answer('project', 'question', 0.1)]) {
      const routes = [];
      const matcher = createInterviewAiMatcher({ bank, transportFactory: async config => {
        routes.push(config.transport); return { start: async () => {}, match: async () => selection, close() {} };
      } });
      try {
        const result = await matcher.match('Describe a project.');
        assert.equal(result.cardId, 'none'); assert.equal(result.source, 'ai'); assert.deepEqual(routes, ['claude-warm']);
      } finally { await matcher.close(); }
    }
  } },
  { name: 'interview AI matcher: cold retry shares the question deadline and cancellation closes it', async run() {
    for (const cancel of [false, true]) {
      const abort = new AbortController(); let entered; let coldSignal; const closed = [];
      const began = new Promise(resolve => { entered = resolve; });
      const matcher = createInterviewAiMatcher({ bank, config: { timeoutMs: 40 }, transportFactory: async config => ({
        start: async () => {}, match: async ({ signal }) => {
          if (config.transport === 'claude-warm') throw new Error('warm failed');
          coldSignal = signal; entered(); return new Promise(() => {});
        }, close() { closed.push(config.transport); },
      }) });
      try {
        const pending = matcher.match('Describe a project.', { signal: abort.signal });
        await began;
        if (cancel) { abort.abort(); await assert.rejects(pending, { name: 'AbortError' }); }
        else { assert.equal((await pending).reason, 'timeout'); }
        assert.equal(coldSignal.aborted, true); assert.deepEqual(closed, ['claude-warm', 'claude-cold']);
      } finally { await matcher.close(); }
    }
  } },
  { name: 'interview AI matcher: closing waits for cold fallback resources to finish cleanup exactly once', async run() {
    let entered; let finishCleanup; let closeCalls = 0; let fullyClosed = false;
    const began = new Promise(resolve => { entered = resolve; });
    const cleanup = new Promise(resolve => { finishCleanup = resolve; });
    const matcher = createInterviewAiMatcher({ bank, transportFactory: async config => ({
      start: async () => {}, match: async () => {
        if (config.transport === 'claude-warm') throw new Error('warm failed');
        entered(); return new Promise(() => {});
      }, close() { if (config.transport === 'claude-cold') { closeCalls += 1; return cleanup; } },
    }) });
    const pending = matcher.match('Describe a project.');
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    try {
      await began;
      const closing = matcher.close().then(() => { fullyClosed = true; });
      await cancelled; await Promise.resolve();
      assert.equal(fullyClosed, false, 'close must join the cold process termination and temporary-directory cleanup');
      finishCleanup(); await closing; await matcher.close();
      assert.equal(closeCalls, 1); assert.equal(fullyClosed, true);
    } finally { finishCleanup(); await matcher.close(); }
  } },
  { name: 'interview AI matcher: semantic pick does not depend on lexical similarity', async run() {
    const { matcher, calls } = stub();
    try {
      const result = await matcher.match('What did you create from beginning to end?');
      assert.equal(result.cardId, 'project'); assert.equal(result.source, 'ai'); assert.equal(result.approximate, false);
      assert.equal(calls.matches.length, 1); assert.equal(calls.starts.length, 1);
      assert.deepEqual(calls.starts[0].cards[0], { id: 'project', question: bank.cards[0].question, headline: bank.cards[0].headline.text });
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: AI none and low confidence abstain without lexical override', async run() {
    for (const response of [answer('none'), answer('project', 'question', 0.1)]) {
      const { matcher } = stub({ match: async () => response });
      try {
        const result = await matcher.match('Describe a project.');
        assert.equal(result.cardId, 'none'); assert.equal(result.kind, 'question'); assert.equal(result.source, 'ai'); assert.equal(result.approximate, false);
      } finally { await matcher.close(); }
    }
  } },
  { name: 'interview AI matcher: contextual follow-up keeps only the explicit previous card', async run() {
    const { matcher, calls } = stub({ async match(value) { calls.matches.push(value); return answer('team', 'follow-up'); } });
    try {
      const result = await matcher.match('And what did you learn?', { previousCardId: 'team', previousQuestion: 'How did the team divide work?' });
      assert.equal(result.cardId, 'team'); assert.equal(result.kind, 'follow-up');
      assert.equal(calls.matches.length, 1, 'classification and selection share a single request');
      assert.equal(calls.matches[0].previousCardId, 'team');
      assert.equal(calls.matches[0].previousCardQuestion, bank.cards[1].question);
      assert.equal(calls.matches[0].previousQuestion, 'How did the team divide work?');
      assert.throws(() => parseInterviewAiSelection(answer('project', 'follow-up'), bank.cards, 'team'), /INVALID_SELECTION/u);
      assert.throws(() => parseInterviewAiSelection(answer('team', 'follow-up'), bank.cards), /INVALID_SELECTION/u);
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: one response classifies company talk and unmatched real questions without a second call', async run() {
    for (const kind of ['not-question', 'question']) {
      const { matcher, calls } = stub({ async match(value) { calls.matches.push(value); return answer('none', kind); } });
      try {
        const question = kind === 'not-question' ? "Great. So a bit about the team: we're about twelve engineers." : 'Why Discord?';
        const result = await matcher.match(question, { previousCardId: 'team', previousQuestion: 'Tell me about teamwork.' });
        assert.equal(result.kind, kind); assert.equal(result.cardId, 'none'); assert.equal(result.source, 'ai');
        assert.equal(calls.matches.length, 1); assert.equal(calls.matches[0].question, question);
        assert.equal(calls.matches[0].previousCardQuestion, bank.cards[1].question);
        assert.match(calls.starts[0].instructions, /not-question/u); assert.match(calls.starts[0].instructions, /follow-up/u);
      } finally { await matcher.close(); }
    }
  } },
  { name: 'interview AI matcher: uncertain follow-up retains the current card through not-question classification', async run() {
    const { matcher, calls } = stub({ async match(value) { calls.matches.push(value); return answer('team', 'follow-up', 0.1); } });
    try {
      const result = await matcher.match('And what changed after that?', { previousCardId: 'team' });
      assert.equal(result.kind, 'not-question'); assert.equal(result.cardId, 'none'); assert.equal(result.source, 'ai');
      assert.equal(result.approximate, false); assert.equal(calls.matches.length, 1);
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: selection parser requires exactly kind cardId confidence and a locked follow-up card', run() {
    const valid = JSON.parse(answer());
    for (const key of ['kind', 'cardId', 'confidence']) {
      const missing = { ...valid }; delete missing[key];
      assert.throws(() => parseInterviewAiSelection(missing, bank.cards), /INVALID_SELECTION/u, `missing ${key}`);
    }
    for (const value of [
      { ...valid, extra: true }, { ...valid, isFollowUp: false }, { ...valid, kind: 'unknown' },
      { ...valid, kind: null }, { ...valid, confidence: NaN }, { ...valid, confidence: -0.1 },
      { ...valid, cardId: '' }, { cardId: 'project', confidence: 0.9, isFollowUp: false },
      JSON.parse(answer('project', 'not-question')), JSON.parse(answer('none', 'follow-up')),
      JSON.parse(answer('team', 'follow-up')),
    ]) assert.throws(() => parseInterviewAiSelection(value, bank.cards), /INVALID_SELECTION/u);
    assert.throws(() => parseInterviewAiSelection(answer('team', 'follow-up'), bank.cards, 'project'), /INVALID_SELECTION/u);
    assert.throws(() => parseInterviewAiSelection(answer('unknown', 'follow-up'), bank.cards, 'unknown'), /INVALID_SELECTION/u);
    assert.deepEqual(parseInterviewAiSelection(answer('none', 'not-question'), bank.cards, 'team'), JSON.parse(answer('none', 'not-question')));
    assert.deepEqual(parseInterviewAiSelection(answer('none', 'question'), bank.cards), JSON.parse(answer('none', 'question')));
    assert.deepEqual(parseInterviewAiSelection(answer('team', 'follow-up'), bank.cards, 'team'), JSON.parse(answer('team', 'follow-up')));
  } },
  { name: 'interview AI matcher: unavailable AI uses only accepted conservative detector turns', async run() {
    const { matcher } = stub({ match: async () => { throw new Error('unavailable'); } });
    try {
      for (const question of ["Great. So a bit about the team: we're about twelve engineers.",
        'The project is about the garden timer.', 'Why Discord?', 'Can you describe a project? Describe working with others.']) {
        const result = await matcher.match(question);
        assert.equal(result.cardId, 'none', question); assert.equal(result.approximate, true); assert.match(result.label, /Approximate/u);
      }
      const leadIn = await matcher.match('Alright. Cool. Thanks for that. Can you describe a project?');
      assert.equal(leadIn.kind, 'question'); assert.equal(leadIn.cardId, 'project'); assert.equal(leadIn.approximate, true);
      const followUp = await matcher.match('Thanks. What did you learn?', { previousCardId: 'project' });
      assert.equal(followUp.cardId, 'none', 'offline continuation must disclose evidence gaps rather than reuse the authored card');
      assert.equal(followUp.approximate, true);
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: fenced and prose-wrapped selections extract the first balanced JSON object', run() {
    for (const raw of [' \n' + answer() + '\t ', '```json\n' + answer() + '\n```', 'Chosen answer:\n' + answer() + '\nDone.',
      answer() + '\n' + answer('team')]) {
      assert.deepEqual(parseInterviewAiSelection(raw, bank.cards), JSON.parse(answer()));
    }
    const id = 'card-{"quoted":"\\\\}"}';
    assert.equal(parseInterviewAiSelection('Result: ' + answer(id) + ' trailing', [{ id }]).cardId, id);
  } },
  { name: 'interview AI matcher: tolerant parsing still rejects invalid schemas and never skips an invalid first object', run() {
    for (const raw of ['invented prose', '{}\n' + answer(), '{"cardId":"project"', answer('unknown'), JSON.stringify({ cardId: 'project', confidence: 1.1, kind: 'question' }),
      JSON.stringify({ cardId: 'project', confidence: 0.9, kind: 'question', explanation: 'extra' }),
      '```json\n' + JSON.stringify({ cardId: 'project', confidence: 0.9, kind: 'question', extra: { text: '}' } }) + '\n```',
      JSON.stringify({ cardId: 'project', confidence: '0.9', kind: 'question' }), JSON.stringify([JSON.parse(answer())])]) {
      assert.throws(() => parseInterviewAiSelection(raw, bank.cards), /INVALID_SELECTION/u);
    }
  } },
  { name: 'interview AI matcher: question deadlines preserve slow initialization for later questions', async run() {
    let ready; let initialization; let creations = 0; let closes = 0; let matches = 0;
    const waiting = new Promise(resolve => { ready = resolve; });
    const matcher = createInterviewAiMatcher({ bank, config: { timeoutMs: 10, initTimeoutMs: 500 }, transportFactory: async () => {
      creations += 1;
      return { start: value => { initialization = value; return waiting; }, match: async () => { matches += 1; return answer(); }, close: () => { closes += 1; } };
    } });
    try {
      const warming = matcher.start();
      for (let turn = 0; turn < 2; turn += 1) {
        assert.equal((await matcher.match('Describe a project.')).reason, 'timeout');
        assert.equal(initialization.signal.aborted, false); assert.equal(closes, 0); assert.equal(creations, 1); assert.equal(matches, 0);
      }
      ready(); await warming;
      assert.equal((await matcher.match('What did you create?')).source, 'ai');
      assert.equal(matches, 1); assert.equal(creations, 1); assert.equal(closes, 0);
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: slow initialization still expires under its own deadline and can recover', async run() {
    let initialization; let creations = 0; let closes = 0;
    const matcher = createInterviewAiMatcher({ bank, config: { timeoutMs: 10, initTimeoutMs: 50 }, transportFactory: async () => {
      const current = ++creations;
      return { start: value => { initialization = value; return current === 1 ? new Promise(() => {}) : Promise.resolve(); },
        match: async () => answer(), close: () => { closes += 1; } };
    } });
    try {
      const warming = matcher.start();
      assert.equal((await matcher.match('Describe a project.')).reason, 'timeout');
      assert.equal(initialization.signal.aborted, false); assert.equal(closes, 0);
      await assert.rejects(warming, /MATCH_TIMEOUT/u);
      assert.equal(initialization.signal.aborted, true); assert.equal(closes, 1);
      assert.equal((await matcher.match('Describe a project.')).source, 'ai'); assert.equal(creations, 2);
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: timeout falls back instantly with the approximate label and closes the transport', async run() {
    let closes = 0;
    const matcher = createInterviewAiMatcher({ bank, config: { timeoutMs: 15 }, transportFactory: async () => ({
      start: async () => {}, match: () => new Promise(() => {}), close: () => { closes += 1; },
    }) });
    try {
      const result = await matcher.match('Can you describe a project?');
      assert.equal(result.cardId, 'project'); assert.equal(result.source, 'approximate'); assert.equal(result.approximate, true);
      assert.match(result.label, /Approximate/u); assert.equal(result.reason, 'timeout'); assert.ok(closes >= 1);
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: unavailable and malformed AI use labelled deterministic fallback only', async run() {
    for (const match of [async () => { throw new Error('unavailable'); }, async () => 'invented prose']) {
      const { matcher } = stub({ match });
      try {
        const result = await matcher.match('Can you describe a project?');
        assert.equal(result.cardId, 'project'); assert.equal(result.approximate, true); assert.equal(result.confidence, 0);
        assert.ok(['invalid', 'unavailable'].includes(result.reason));
      } finally { await matcher.close(); }
    }
  } },
  { name: 'interview AI matcher: timed-out warm state is discarded and the next question opens a fresh session', async run() {
    let creations = 0; let closes = 0;
    const matcher = createInterviewAiMatcher({ bank, config: { timeoutMs: 10 }, transportFactory: async () => {
      const current = ++creations;
      return { start: async () => {}, match: () => current === 1 ? new Promise(() => {}) : Promise.resolve(answer()), close: () => { closes += 1; } };
    } });
    try {
      assert.equal((await matcher.match('Describe a project.')).reason, 'timeout');
      assert.equal((await matcher.match('Describe a project.')).source, 'ai');
      assert.equal(creations, 2); assert.equal(closes, 1);
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: approximate fallback abstains on conflicting multipart questions', async run() {
    const { matcher } = stub({ match: async () => { throw new Error('unavailable'); } });
    try {
      for (const question of ['Can you describe a project? Describe working with others.', 'Describe working with others. What is your expected salary?']) {
        const result = await matcher.match(question);
        assert.equal(result.cardId, 'none'); assert.equal(result.approximate, true);
      }
      assert.equal((await matcher.match('Can you describe a project?')).cardId, 'project');
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: late transport factory cannot warm a superseded session', async run() {
    let resolveFactory; let starts = 0; let closes = 0;
    const matcher = createInterviewAiMatcher({ bank, config: { timeoutMs: 10 }, transportFactory: () => new Promise(resolve => { resolveFactory = resolve; }) });
    assert.equal((await matcher.match('Describe a project.')).reason, 'timeout');
    await matcher.close();
    resolveFactory({ start: async () => { starts += 1; }, close: () => { closes += 1; } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(starts, 0); assert.equal(closes, 1); await matcher.close();
  } },
  { name: 'interview AI matcher: initialization timeout closes a late factory before it sends context', async run() {
    let resolveFactory; let starts = 0; let closes = 0;
    const matcher = createInterviewAiMatcher({ bank, config: { initTimeoutMs: 10 }, transportFactory: () => new Promise(resolve => { resolveFactory = resolve; }) });
    await assert.rejects(matcher.start(), /MATCH_TIMEOUT/u);
    resolveFactory({ start: async () => { starts += 1; }, close: () => { closes += 1; } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(starts, 0); assert.equal(closes, 1); await matcher.close();
  } },
  { name: 'interview AI matcher: window lifecycle initializes once with extension context and cancels close', async run() {
    const extensions = { project: [{ id: 'extension-1', text: 'I tested the timer with the garden team.', exampleHook: 'Garden timer' }] };
    let starts = 0; let closes = 0; let initialization;
    const matcher = createInterviewAiMatcher({ bank, context: { extensions }, transportFactory: async () => ({
      async start(value) { starts += 1; initialization = value; }, match: async () => answer(), close: () => { closes += 1; },
    }) });
    await Promise.all([matcher.start(), matcher.start()]);
    await matcher.match('Describe a project.'); await matcher.match('Describe a project.');
    assert.equal(starts, 1); assert.deepEqual(initialization.extensions, extensions);
    assert.match(initialization.instructions, /extension-1/u);
    assert.match(initialization.instructions, /Garden timer/u);
    await matcher.close(); await matcher.close(); assert.equal(closes, 1);
    await assert.rejects(matcher.match('Describe a project.'), { name: 'AbortError' });
  } },
  { name: 'interview AI matcher: close and superseding cancellation cannot publish an approximate result', async run() {
    let entered;
    const began = new Promise(resolve => { entered = resolve; });
    const { matcher } = stub({ match: () => { entered(); return new Promise(() => {}); } });
    const abort = new AbortController();
    const pending = matcher.match('Describe a project.', { signal: abort.signal });
    await began; abort.abort(); await assert.rejects(pending, { name: 'AbortError' }); await matcher.close();
    let attempts = 0;
    const empty = createInterviewAiMatcher({ bank: null, transportFactory: () => { attempts += 1; } });
    await assert.rejects(empty.start(), /NO_PREPARED_CARDS/u); assert.equal(attempts, 0); await empty.close();
  } },
  { name: 'interview AI matcher: measured rolling p50 controls continuation layout at configurable threshold', async run() {
    let time = 0; let duration = 3000;
    const matcher = createInterviewAiMatcher({ bank, now: () => time, config: { latencyThresholdMs: 2500 }, transportFactory: async () => ({
      start: async () => {}, match: async () => { time += duration; return answer(); }, close() {},
    }) });
    try {
      assert.equal(matcher.getLatency().latencyMode, 'recall');
      assert.equal((await matcher.match('Describe a project.')).latencyMode, 'continuation');
      duration = 500;
      const result = await matcher.match('Describe a project.');
      assert.equal(result.p50Ms, 1750); assert.equal(result.latencyMode, 'recall');
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: environment configuration overrides benchmark defaults explicitly', run() {
    assert.deepEqual(interviewAiMatcherConfigFromEnv({}), {});
    assert.deepEqual(interviewAiMatcherConfigFromEnv({ INTERVIEW_MATCH_TRANSPORT: 'claude-warm', INTERVIEW_MATCH_MODEL: 'synthetic-model',
      INTERVIEW_MATCH_EFFORT: 'low', INTERVIEW_MATCH_TIMEOUT_MS: '2000', INTERVIEW_MATCH_INIT_TIMEOUT_MS: '6000', INTERVIEW_MATCH_LATENCY_THRESHOLD_MS: '2500' }),
    { transport: 'claude-warm', model: 'synthetic-model', effort: 'low', timeoutMs: 2000, initTimeoutMs: 6000, latencyThresholdMs: 2500 });
    assert.deepEqual(interviewAiMatcherConfigFromEnv({ INTERVIEW_MATCH_TIMEOUT_MS: '-1', INTERVIEW_MATCH_MODEL: 'bad\nmodel' }), {});
  } },
  { name: 'interview AI transports: warm stream-json retains one process and sends context once', async run() {
    const fake = fakeCli();
    const matcher = createInterviewAiMatcher({ bank, config: { transport: 'claude-warm', model: 'synthetic-model', effort: 'low', claudeBin: 'claude-test' },
      context: { extensions: { project: [{ id: 'extension-1', text: 'Checked the timer in the garden.', exampleHook: 'Garden timer' }] } },
      transportFactory: (config, options) => createInterviewAiTransport(config, { ...options, spawn: fake.spawn }) });
    await matcher.start(); await matcher.match('Describe a project.'); await matcher.match('What did you make?');
    await matcher.match('And what happened next?', { previousCardId: 'project', previousQuestion: 'What did you make?' });
    assert.equal(fake.children.length, 2); // capability help + one warm process
    const processRecord = fake.children[1];
    assert.equal(processRecord.options.shell, false); assert.notEqual(processRecord.options.cwd, process.cwd());
    assert.ok(processRecord.args.includes('--no-session-persistence')); assert.ok(processRecord.args.includes('--strict-mcp-config'));
    assert.equal(fake.writes.filter(message => message.message.content.includes('extension-1')).length, 1);
    assert.equal(fake.writes.filter(message => message.message.content.includes('Garden timer')).length, 1, 'the example hook is sent only with initialization, never repeated per question');
    assert.equal(fake.writes[1].session_id, 'synthetic-session');
    assert.deepEqual(Object.keys(JSON.parse(fake.writes[1].message.content)), ['question']);
    assert.deepEqual(JSON.parse(fake.writes[3].message.content), { question: 'And what happened next?',
      previousCardId: 'project', previousQuestion: 'What did you make?', previousCardQuestion: bank.cards[0].question });
    await matcher.close(); assert.deepEqual(processRecord.child.signals, ['SIGTERM']);
    await assert.rejects(fs.stat(processRecord.options.cwd), { code: 'ENOENT' });
  } },
  { name: 'interview AI matcher: invalid selection retries cold for one turn and preserves the healthy warm process', async run() {
    const fake = fakeCli({ matchResults: ['not a selection', answer('unknown'), answer('team')] });
    const matcher = createInterviewAiMatcher({ bank, config: { transport: 'claude-warm', claudeBin: 'claude-test' },
      transportFactory: (config, options) => createInterviewAiTransport(config, { ...options, spawn: fake.spawn }) });
    try {
      for (let turn = 0; turn < 2; turn += 1) {
        const fallback = await matcher.match('Describe a project.');
        assert.equal(fallback.cardId, 'project'); assert.equal(fallback.source, 'ai'); assert.equal(fallback.reason, null);
        assert.deepEqual(fake.children[1].child.signals, []);
      }
      const result = await matcher.match('What did you do with others?');
      assert.equal(result.source, 'ai'); assert.equal(result.cardId, 'team'); assert.equal(fake.children.length, 6);
      assert.equal(fake.writes.filter(message => typeof message === 'object' && message.message.content.includes('Reply only READY.')).length, 1);
      const providerCalls = fake.children.filter(child => !child.args.includes('--help'));
      assert.equal(providerCalls.length, 3, 'one warm process and two cold retries must use the production defaults');
      for (const { args } of providerCalls) {
        assert.equal(args[args.indexOf('--model') + 1], 'opus');
        assert.equal(args.includes('--effort'), false, 'default effort must leave Claude effort selection at its default');
      }
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: protocol failures retire the process before a later turn recovers', async run() {
    let creations = 0; let closes = 0;
    const matcher = createInterviewAiMatcher({ bank, config: { transport: 'chatgpt-bridge' }, transportFactory: async () => {
      const current = ++creations;
      return { start: async () => {}, match: async () => {
        if (current === 1) throw Object.assign(new Error('broken protocol'), { code: 'TRANSPORT_INVALID_RESPONSE' });
        return answer();
      }, close: () => { closes += 1; } };
    } });
    try {
      assert.equal((await matcher.match('Describe a project.')).reason, 'unavailable'); assert.equal(closes, 1);
      assert.equal((await matcher.match('Describe a project.')).source, 'ai'); assert.equal(creations, 2);
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI transports: malformed warm assistant events reject the pending request without crashing main', async run() {
    for (const malformedEvent of [null, { type: 'assistant', message: { content: 'not an array' } },
      { type: 'assistant', message: { content: {} } }, { type: 'assistant', message: { content: [null] } }]) {
      const fake = fakeCli({ malformedEvent });
      const transport = await createInterviewAiTransport({ transport: 'claude-warm', claudeBin: 'claude-test' }, { spawn: fake.spawn });
      try {
        await transport.start({ instructions: 'SYNTHETIC CARDS' });
        await assert.rejects(transport.match({ question: 'Describe a project.' }), /TRANSPORT_INVALID_RESPONSE/u);
      } finally { await transport.close(); }
    }
  } },
  ...['claude-cold', 'codex'].map(kind => ({ name: `interview AI transports: ${kind} uses tool-free isolated one-shot calls`, async run() {
    const fake = fakeCli();
    const transport = await createInterviewAiTransport({ transport: kind, model: 'synthetic-model', effort: 'low', claudeBin: 'claude-test', codexBin: 'codex-test' }, { spawn: fake.spawn });
    try {
      await transport.start({ instructions: 'SYNTHETIC CARDS', signal: new AbortController().signal });
      assert.equal(parseInterviewAiSelection(await transport.match({ question: 'What did you build?' }), bank.cards).cardId, 'project');
      assert.match(fake.writes[0], /SYNTHETIC CARDS/u); assert.equal(fake.children[1].options.shell, false);
      assert.ok(fake.children[1].args.includes(kind === 'codex' ? '--ignore-user-config' : '--no-session-persistence'));
    } finally { await transport.close(); }
  } })),
  { name: 'interview AI transports: Codex tool events are rejected before selecting a card', async run() {
    const fake = fakeCli({ codexTool: true });
    const transport = await createInterviewAiTransport({ transport: 'codex', codexBin: 'codex-test' }, { spawn: fake.spawn });
    try {
      await transport.start({ instructions: 'cards' });
      await assert.rejects(transport.match({ question: 'What did you build?' }), /TRANSPORT_TOOL_USE/u);
    } finally { await transport.close(); }
  } },
  { name: 'interview AI transports: bridge uses nonApiAi structured selection and propagates cancellation', async run() {
    const calls = [];
    const transport = await createInterviewAiTransport({ transport: 'chatgpt-bridge' }, { request: async options => { calls.push(options); return JSON.parse(answer()); } });
    try {
      const abort = new AbortController(); await transport.start({ instructions: 'compact prepared cards' });
      const result = await transport.match({ question: 'What did you create?', previousCardId: 'team',
        previousQuestion: 'Tell me about teamwork.', previousCardQuestion: bank.cards[1].question, signal: abort.signal });
      assert.equal(result.cardId, 'project'); assert.equal(calls[0].task, 'interview-live-match');
      assert.equal(calls[0].cachedPrefix, 'compact prepared cards'); assert.equal(calls[0].signal, abort.signal);
      assert.deepEqual(JSON.parse(calls[0].prompt), { question: 'What did you create?', previousCardId: 'team',
        previousQuestion: 'Tell me about teamwork.', previousCardQuestion: bank.cards[1].question });
      assert.deepEqual(calls[0].responseSchema.required, ['kind', 'cardId', 'confidence']);
      assert.equal(calls[0].responseSchema.additionalProperties, false);
      assert.deepEqual(calls[0].responseSchema.properties.kind.enum, ['question', 'follow-up', 'not-question']);
    } finally { await transport.close(); }
  } },
];
