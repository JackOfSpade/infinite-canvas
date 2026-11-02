import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { createInterviewAiMatcher as createPooledMatcher, parseInterviewAiSelection, interviewAiMatcherConfigFromEnv, INTERVIEW_AI_MATCH_DEFAULTS } from '../../electron/interviewAiMatcher.js';
// These existing lifecycle tests intentionally exercise one warm session.
// Pool concurrency and the production default are covered in speculative-pool.
const createInterviewAiMatcher = options => createPooledMatcher({ ...options, config: { ...options?.config, poolSize: 1 } });
import { createInterviewAiTransport } from '../../electron/interviewAiTransports.js';
import { CLAUDE_MAX_OUTPUT_TOKENS } from '../../electron/ipc/claudeApplicationRunner.js';

// Synthetic fixtures only; no CLI or model request is made by this suite.
const bank = { cards: [
  { id: 'project', question: 'Describe a project.', headline: { text: 'I built a garden watering timer.' } },
  { id: 'team', question: 'Describe working with others.', headline: { text: 'We divided community garden tasks.' } },
] };
const answer = (cardId = 'project', kind = 'question', confidence = 0.95) => JSON.stringify({ kind, cardId, confidence });
function stub(extra = {}) {
  const calls = { starts: [], matches: [], closes: 0 };
  const matcher = createInterviewAiMatcher({ bank, transportFactory: async () => ({
    async start(value) { calls.starts.push(value); },
    async match(value) { calls.matches.push(value); return answer(); },
    close() { calls.closes += 1; }, ...extra,
  }) });
  return { matcher, calls };
}
const HELP = '--print --model --output-format --tools --system-prompt --no-session-persistence --strict-mcp-config --mcp-config --safe-mode --effort --input-format --verbose --include-partial-messages';
function fakeCli({ malformedEvent, matchResults = [], deferMatches = false } = {}) {
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
    child.stdin.end = () => {
      if (args.includes('--help')) emit(HELP);
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
    const matcher = createInterviewAiMatcher({ bank, config: { claudeBin: 'claude-test' },
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
  { name: 'interview AI transports: children get the output-token limit and no ANTHROPIC_ or provider-switch variables', async run() {
    const saved = {};
    const injected = { ANTHROPIC_API_KEY: 'synthetic-key', ANTHROPIC_BASE_URL: 'https://synthetic.invalid', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1' };
    for (const [key, value] of Object.entries(injected)) { saved[key] = process.env[key]; process.env[key] = value; }
    const fake = fakeCli();
    const transport = await createInterviewAiTransport({ claudeBin: 'claude-test' }, { spawn: fake.spawn });
    try {
      await transport.start({ instructions: 'synthetic cards' });
      assert(fake.children.length > 0, 'the transport spawned at least one child');
      for (const { options } of fake.children) {
        assert.equal(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, CLAUDE_MAX_OUTPUT_TOKENS);
        assert.deepEqual(Object.keys(options.env).filter(key => key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_USE_')), []);
        assert.equal(options.env.CLAUDECODE, undefined);
        assert.equal(options.env.CLAUDE_CODE_ENTRYPOINT, undefined);
      }
    } finally {
      await transport.close();
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  } },
  { name: 'interview AI transports: cancelling a queued warm question never sends it or retires the process', async run() {
    const fake = fakeCli({ deferMatches: true });
    const transport = await createInterviewAiTransport({ claudeBin: 'claude-test' }, { spawn: fake.spawn });
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
    const fake = fakeCli({ matchResults: [answer('none', 'follow-up')] });
    const transport = await createInterviewAiTransport({ claudeBin: 'claude-test' }, { spawn: fake.spawn });
    try {
      await transport.start({ instructions: 'synthetic cards' });
      await transport.match({ question: 'What was the result of that?', previousPlanLocked: true, previousQuestion: 'Tell me about leading a team.' });
      assert.deepEqual(JSON.parse(fake.writes[1].message.content), { question: 'What was the result of that?', previousPlanLocked: true, previousQuestion: 'Tell me about leading a team.' });
    } finally { await transport.close(); }
  } },
  { name: 'interview AI matcher: a queued bank retains the explicit old locked id only for follow-ups', async run() {
    const calls = [];
    let kind = 'follow-up';
    const matcher = createInterviewAiMatcher({ bank, transportFactory: async () => ({
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
    assert.deepEqual(INTERVIEW_AI_MATCH_DEFAULTS, { model: 'opus', effort: 'default',
      timeoutMs: 2500, initTimeoutMs: 10000, latencyThresholdMs: 2500, minConfidence: 0.55 });
    const configs = [];
    for (const config of [{}, { model: 'synthetic-model', effort: 'low' }]) {
      const matcher = createInterviewAiMatcher({ bank, config, transportFactory: async settings => {
        configs.push(settings); return { start: async () => {}, match: async () => answer(), close() {} };
      } });
      try { assert.equal((await matcher.match('Describe a project.')).source, 'ai'); }
      finally { await matcher.close(); }
    }
    assert.deepEqual(configs.map(({ model, effort }) => ({ model, effort })), [
      { model: 'opus', effort: 'default' },
      { model: 'synthetic-model', effort: 'low' },
    ]);
  } },
  { name: 'interview AI matcher: a failed warm initialization or question reports Approximate for that turn and restarts the warm process', async run() {
    for (const stage of ['start', 'match']) {
      let creations = 0; const calls = []; const closed = [];
      const matcher = createInterviewAiMatcher({ bank, transportFactory: async () => {
        const index = ++creations;
        return { start: async value => {
          calls.push(`${index}:start`); assert.match(value.instructions, /garden watering/u);
          if (index === 1 && stage === 'start') throw new Error('missing warm capability');
        }, match: async value => {
          calls.push(`${index}:match`); assert.equal(value.question, 'Describe a project.');
          if (index === 1) throw new Error('process exited');
          return answer('team');
        }, close() { closed.push(index); } };
      } });
      try {
        const result = await matcher.match('Describe a project.');
        assert.equal(result.source, 'approximate'); assert.equal(result.reason, 'unavailable'); assert.equal(result.approximate, true);
        assert.equal(creations, 1, 'the failed turn does not open a second route');
        for (let attempts = 0; attempts < 100 && creations < 2; attempts += 1) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(creations, 2, 'the warm process restarts during idle time');
        assert.deepEqual(closed, [1]);
        const next = await matcher.match('Describe a project.');
        assert.equal(next.source, 'ai'); assert.equal(next.cardId, 'team'); assert.equal(creations, 2);
        assert.deepEqual(calls, stage === 'start' ? ['1:start', '2:start', '2:match'] : ['1:start', '1:match', '2:start', '2:match']);
      } finally { await matcher.close(); }
    }
  } },
  { name: 'interview AI matcher: a failed Claude turn uses conservative labelled Approximate', async run() {
    for (const question of ['Can you describe a project?', 'Can you describe a project? Describe working with others.']) {
      let creations = 0;
      const matcher = createInterviewAiMatcher({ bank, transportFactory: async () => {
        creations += 1;
        return { start: async () => {}, match: async () => { throw new Error('unavailable'); }, close() {} };
      } });
      try {
        const result = await matcher.match(question);
        assert.equal(creations, 1);
        assert.equal(result.source, 'approximate'); assert.equal(result.confidence, 0); assert.match(result.label, /Approximate/u);
        assert.equal(result.cardId, question === 'Can you describe a project?' ? 'project' : 'none');
      } finally { await matcher.close(); }
    }
  } },
  { name: 'interview AI matcher: successful abstention never overrides confidence', async run() {
    for (const selection of [answer('none'), answer('project', 'question', 0.1)]) {
      let creations = 0;
      const matcher = createInterviewAiMatcher({ bank, transportFactory: async () => {
        creations += 1; return { start: async () => {}, match: async () => selection, close() {} };
      } });
      try {
        const result = await matcher.match('Describe a project.');
        assert.equal(result.cardId, 'none'); assert.equal(result.source, 'ai'); assert.equal(creations, 1);
      } finally { await matcher.close(); }
    }
  } },
  { name: 'interview AI matcher: closing waits for the transport to finish cleanup exactly once', async run() {
    let entered; let finishCleanup; let closeCalls = 0; let fullyClosed = false;
    const began = new Promise(resolve => { entered = resolve; });
    const cleanup = new Promise(resolve => { finishCleanup = resolve; });
    const matcher = createInterviewAiMatcher({ bank, transportFactory: async () => ({
      start: async () => {}, match: async () => { entered(); return new Promise(() => {}); },
      close() { closeCalls += 1; return cleanup; },
    }) });
    const pending = matcher.match('Describe a project.');
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    try {
      await began;
      const closing = matcher.close().then(() => { fullyClosed = true; });
      await cancelled; await Promise.resolve();
      assert.equal(fullyClosed, false, 'close must join the process termination and temporary-directory cleanup');
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
    assert.deepEqual(interviewAiMatcherConfigFromEnv({ INTERVIEW_MATCH_MODEL: 'synthetic-model',
      INTERVIEW_MATCH_EFFORT: 'low', INTERVIEW_MATCH_TIMEOUT_MS: '2000', INTERVIEW_MATCH_INIT_TIMEOUT_MS: '6000', INTERVIEW_MATCH_LATENCY_THRESHOLD_MS: '2500' }),
    { model: 'synthetic-model', effort: 'low', timeoutMs: 2000, initTimeoutMs: 6000, latencyThresholdMs: 2500 });
    assert.deepEqual(interviewAiMatcherConfigFromEnv({ INTERVIEW_MATCH_TIMEOUT_MS: '-1', INTERVIEW_MATCH_MODEL: 'bad\nmodel' }), {});
  } },
  { name: 'interview AI transports: warm stream-json retains one process and sends context once', async run() {
    const fake = fakeCli();
    const matcher = createInterviewAiMatcher({ bank, config: { model: 'synthetic-model', effort: 'low', claudeBin: 'claude-test' },
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
  { name: 'interview AI matcher: an invalid selection reports Approximate for that turn and preserves the healthy warm process', async run() {
    const fake = fakeCli({ matchResults: ['not a selection', answer('unknown'), answer('team')] });
    const matcher = createInterviewAiMatcher({ bank, config: { claudeBin: 'claude-test' },
      transportFactory: (config, options) => createInterviewAiTransport(config, { ...options, spawn: fake.spawn }) });
    try {
      for (let turn = 0; turn < 2; turn += 1) {
        const fallback = await matcher.match('Describe a project.');
        assert.equal(fallback.source, 'approximate'); assert.equal(fallback.reason, 'invalid'); assert.equal(fallback.confidence, 0);
        assert.deepEqual(fake.children[1].child.signals, []);
      }
      const result = await matcher.match('What did you do with others?');
      assert.equal(result.source, 'ai'); assert.equal(result.cardId, 'team'); assert.equal(fake.children.length, 2, 'capability probe and one warm process only');
      assert.equal(fake.writes.filter(message => message.message.content.includes('Reply only READY.')).length, 1);
      const args = fake.children[1].args;
      assert.equal(args[args.indexOf('--model') + 1], 'opus');
      assert.equal(args.includes('--effort'), false, 'default effort must leave Claude effort selection at its default');
    } finally { await matcher.close(); }
  } },
  { name: 'interview AI matcher: protocol failures retire the process before a later turn recovers', async run() {
    let creations = 0; let closes = 0;
    const matcher = createInterviewAiMatcher({ bank, transportFactory: async () => {
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
      const transport = await createInterviewAiTransport({ claudeBin: 'claude-test' }, { spawn: fake.spawn });
      try {
        await transport.start({ instructions: 'SYNTHETIC CARDS' });
        await assert.rejects(transport.match({ question: 'Describe a project.' }), /TRANSPORT_INVALID_RESPONSE/u);
      } finally { await transport.close(); }
    }
  } },
  { name: 'interview AI transports: warm tool events are rejected before selecting a card', async run() {
    const fake = fakeCli({ malformedEvent: { type: 'assistant', message: { content: [{ type: 'tool_use' }] } } });
    const transport = await createInterviewAiTransport({ claudeBin: 'claude-test' }, { spawn: fake.spawn });
    try {
      await transport.start({ instructions: 'cards' });
      await assert.rejects(transport.match({ question: 'What did you build?' }), /TRANSPORT_TOOL_USE/u);
    } finally { await transport.close(); }
  } },
  { name: 'interview AI transports: partial-aware per-turn message shares one context prefix across pooled warm processes', async run() {
    const fake = fakeCli();
    const matcher = createPooledMatcher({ bank, config: { poolSize: 2, claudeBin: 'claude-test' },
      transportFactory: (config, options) => createInterviewAiTransport(config, { ...options, spawn: fake.spawn }) });
    try {
      await matcher.start();
      await matcher.select({ text: 'Tell me about projects', partial: true });
      await matcher.select({ text: 'Tell me about projects.' });
      const contents = fake.writes.map(message => message.message.content);
      const prefixes = contents.filter(content => content.includes('Reply only READY.'));
      assert.equal(prefixes.length, 2); assert.equal(prefixes[0], prefixes[1]);
      assert.match(prefixes[0], /When the user message has partial: true, the interviewer is still mid-sentence:/u);
      const messages = contents.filter(content => !content.includes('Reply only READY.')).map(content => JSON.parse(content));
      assert.equal(messages.length, 2);
      assert.equal(messages.find(message => message.question === 'Tell me about projects').partial, true);
      assert.equal(Object.hasOwn(messages.find(message => message.question === 'Tell me about projects.'), 'partial'), false);
    } finally { await matcher.close(); }
  } },
];
