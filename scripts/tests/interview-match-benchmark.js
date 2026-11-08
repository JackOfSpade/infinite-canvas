import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { configurations, parseArguments, runBenchmark, scoreResults, renderMarkdown, renderCsv } from '../interview-match-benchmark.mjs';
import { createTransport } from '../interview-match-transports.mjs';
import { buildCaseSlots, materializeCases } from '../interview-match-cases.mjs';
import { casePrompt, expectedTurnKind, normalizeBank, parsePrediction, validateCases } from '../interview-match-shared.mjs';

// Synthetic data only. Never turn the private sealed interview bank into a fixture.
const cards = [
  { id: 'project', question: 'Describe a project.', headline: 'I built a garden watering timer.' },
  { id: 'team', question: 'Describe working with others.', headline: 'We shared tasks for a community garden.' },
];
const cases = [
  { id: 'p1', kind: 'paraphrase', utterance: 'So, um, what have you made from start to finish?', label: 'project' },
  { id: 'p2', kind: 'paraphrase', utterance: 'How did you divide the work with other people?', label: 'team' },
  { id: 'm1', kind: 'multi-part', utterance: 'First tell me about something you made, then how you planned it.', label: 'project' },
  { id: 'f1', kind: 'follow-up', utterance: 'And what happened afterward?', label: 'project', previousCardId: 'project', previousUtterance: 'Describe something you built.' },
  { id: 'n1', kind: 'none', utterance: 'Which day could you begin?', label: 'none' },
  { id: 'a1', kind: 'noisy', utterance: 'howd you split up those garden jobs', label: 'team' },
  { id: 'l1', kind: 'lead-in', utterance: 'Great, that is helpful. Tell me about working with others.', label: 'team', previousCardId: 'project', previousUtterance: 'Describe a project.' },
  { id: 'r1', kind: 'not-question', utterance: "Great. So a bit about the team: we're about twelve engineers.", label: 'none', previousCardId: 'project', previousUtterance: 'Describe a project.' },
];
const baseConfig = { id: 'safe', model: 'synthetic-model', effort: 'low' };

function answer(cardId, kind = 'question', confidence = 0.97) {
  return JSON.stringify({ kind, cardId, confidence });
}

function stubFactory(calls) {
  return async config => ({
    async request(prompt) {
      calls.push({ configId: config.id, prompt });
      const item = cases.find(testCase => prompt.includes(JSON.stringify(testCase.utterance)));
      if (!item) return { text: 'READY', latencyMs: 4_000, ttftMs: 3_000 };
      const unsafe = config.id === 'unsafe-fast' && item.kind === 'none';
      return {
        text: answer(unsafe ? 'project' : item.label, expectedTurnKind(item)),
        latencyMs: config.id === 'unsafe-fast' ? 100 : 1_000 + cases.indexOf(item) * 100,
        ttftMs: 200,
      };
    },
    async close() {},
  });
}

async function withOutput(run) {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interview-match-unit-'));
  try { return await run(outDir); }
  finally { await fs.rm(outDir, { recursive: true, force: true }); }
}

const DEEPSEEK_COST = 0.001;

// Fake `node <offload> complete`: never touches a real provider. `behave(request)` returns { line, code }.
function fakeOffloadSpawn(captured, behave) {
  return (command, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = '';
    child.stdin.on('data', chunk => { input += chunk; });
    child.stdin.on('end', () => {
      const request = JSON.parse(input);
      captured.push({ command, args, env: spawnOptions.env, request });
      const reply = behave(request);
      setImmediate(() => {
        child.stdout.write(`${reply.line}\n`);
        child.stdout.end();
        setImmediate(() => child.emit('close', reply.code ?? 0, null));
      });
    });
    return child;
  };
}

function cannedOffload(request) {
  const user = request.messages.at(-1).content;
  const item = cases.find(testCase => user.includes(JSON.stringify(testCase.utterance)));
  return { line: JSON.stringify({ ok: true, text: item ? answer(item.label, expectedTurnKind(item)) : 'READY',
    model: 'deepseek-synthetic', usage: { inputTokens: 100, cacheHitTokens: 90, cacheMissTokens: 10, outputTokens: 20, reasoningTokens: 0 },
    costUsd: DEEPSEEK_COST, latencyMs: 12 }) };
}

const offloadConfig = { id: 'offload-deepseek-flash-off', provider: 'offload', route: 'deepseek-flash', reasoning: 'off', model: 'deepseek-flash', effort: 'off' };

export default [
  {
    name: 'interview AI benchmark: stub transport scores fixed cases and renders reviewable tables',
    async run() {
      return withOutput(async outDir => {
        const calls = [];
        const configs = [baseConfig, { ...baseConfig, id: 'unsafe-fast' }];
        const summary = await runBenchmark({ cards, cases, configs, outDir, createTransport: stubFactory(calls) });
        const safe = summary.rows.find(row => row.configId === baseConfig.id && row.pass === 1);
        const unsafe = summary.rows.find(row => row.configId === 'unsafe-fast' && row.pass === 1);
        assert.equal(calls.length, (1 + cases.length * 2) * configs.length, 'each configuration initializes once and runs two passes');
        assert.equal(safe.accuracy, 1);
        assert.equal(safe.clearAccuracy, 1);
        assert.equal(safe.kindAccuracy, 1);
        assert.equal(safe.leadInAccuracy, 1);
        assert.equal(safe.notQuestionPrecision, 1);
        assert.equal(safe.notQuestionRecall, 1);
        assert.equal(safe.nonePrecision, 1);
        assert.equal(safe.noneRecall, 1);
        assert.equal(safe.followUpAccuracy, 1);
        assert.equal(safe.parseFailureRate, 0);
        assert.equal(safe.eligible, true);
        assert.equal(unsafe.falseConfidentNone, 1);
        assert.equal(unsafe.eligible, false);
        assert.equal(summary.recommendation.configId, baseConfig.id, 'a faster confident false card must not win');
        const markdown = renderMarkdown(summary);
        const csv = renderCsv(summary);
        assert(markdown.includes(baseConfig.id) && markdown.includes('unsafe-fast') && markdown.includes('|'));
        assert(csv.includes('p50Ms') && csv.includes('nonePrecision') && csv.includes('kindAccuracy') && csv.includes(baseConfig.id));
        return { calls: calls.length, recommended: summary.recommendation.configId };
      });
    },
  },
  {
    name: 'interview AI benchmark: parse failures remain in accuracy and cannot hide unsafe none results',
    run() {
      const records = cases.map(item => ({
        configId: baseConfig.id, pass: 1, caseId: item.id, status: item.kind === 'none' ? 'parse-error' : 'ok',
        prediction: item.kind === 'none' ? undefined : { cardId: item.label, confidence: 0.97, kind: expectedTurnKind(item) },
        latencyMs: 1_000,
      }));
      const summary = scoreResults({ cases, records, configs: [baseConfig] });
      const [row] = summary.rows;
      assert.equal(row.accuracy, (cases.length - 1) / cases.length);
      assert.equal(row.clearAccuracy, 1);
      assert.equal(row.noneRecall, 1 / 2);
      assert.equal(row.parseFailures, 1);
      assert.equal(row.parseFailureRate, 1 / cases.length);
      assert.equal(row.eligible, false, 'unparsed none cases cannot establish safe abstention');
      assert.equal(summary.recommendation, null);
    },
  },
  {
    name: 'interview AI benchmark: warm passes exclude initialization and completed resumes spend nothing',
    async run() {
      return withOutput(async outDir => {
        const calls = [];
        const config = { ...baseConfig, id: 'safe-warm' };
        const options = { cards, cases, configs: [config], outDir, createTransport: stubFactory(calls) };
        const summary = await runBenchmark(options);
        assert.equal(calls.length, 1 + cases.length * 2, 'one initialization and two sequential passes share the warm process');
        assert.equal(summary.rows.length, 2);
        assert.deepEqual(summary.rows.map(row => row.pass), [1, 2]);
        for (const row of summary.rows) {
          assert.equal(row.completed, cases.length);
          assert(row.p95Ms < 4_000, 'initialization is separate from measured utterance latency');
          assert.equal(row.ttftP50Ms, 200);
        }
        const beforeResume = calls.length;
        const resumed = await runBenchmark(options);
        assert.equal(calls.length, beforeResume, 'a fully completed resume must not initialize a transport');
        assert.equal(resumed.rows.length, 2);
        assert.deepEqual(resumed.rows.map(row => row.correct), [cases.length, cases.length]);
        return { measuredTurns: cases.length * 2, initializationTurns: 1 };
      });
    },
  },
  {
    name: 'interview AI benchmark: partial warm resume replays context and preserves durable measurements',
    async run() {
      return withOutput(async outDir => {
        const calls = [];
        const config = { ...baseConfig, id: 'resume-warm' };
        const options = { cards, cases, configs: [config], outDir, createTransport: stubFactory(calls) };
        await runBenchmark(options);
        const journalFile = path.join(outDir, 'results.jsonl');
        const original = (await fs.readFile(journalFile, 'utf8')).trimEnd().split('\n');
        const prefix = original.slice(0, 3); // Setup plus two durable samples.
        await fs.writeFile(journalFile, prefix.join('\n') + '\n{"type":"sample"');
        calls.length = 0;
        const resumed = await runBenchmark(options);
        assert.equal(resumed.replays, 2);
        assert.equal(calls.length, 1 + cases.length * 2, 'one initialization, two replays, and the remaining new scored requests');
        assert.deepEqual(resumed.rows.map(row => row.completed), [cases.length, cases.length]);
        const rewritten = (await fs.readFile(journalFile, 'utf8')).trimEnd().split('\n');
        assert.deepEqual(rewritten.slice(0, prefix.length), prefix, 'resume must retain existing sample records byte for byte');
        assert(rewritten.every(line => JSON.parse(line)), 'a torn final append must be removed before new records');
        const sampleRecords = rewritten.map(line => JSON.parse(line)).filter(record => record.type === 'sample');
        assert.equal(sampleRecords.length, cases.length * 2, 'replays must never duplicate measured samples');
        const beforeChangedInput = calls.length;
        await assert.rejects(runBenchmark({ ...options, cases: [{ ...cases[0], utterance: 'A different question.' }, ...cases.slice(1)] }), /changed/);
        assert.equal(calls.length, beforeChangedInput, 'changed inputs must be rejected before any transport request');
      });
    },
  },
  {
    name: 'interview AI benchmark: generator assigns all 81 synthetic slot labels independently of output order',
    run() {
      const syntheticBank = normalizeBank({ version: 1, recordId: 'synthetic-seal', bank: {
        cards: Array.from({ length: 13 }, (_, index) => ({
          id: `synthetic-${index}`, question: `Explain synthetic topic ${index}.`,
          headline: { text: `I worked on synthetic topic ${index}.`, evidenceIds: ['synthetic-evidence'] },
          bullets: [{ text: 'Synthetic answer details stay out of matching.' }], variants: ['Unused canonical variant.'],
        })),
      } });
      assert.deepEqual(Object.keys(syntheticBank[0]), ['id', 'question', 'headline']);
      const slots = buildCaseSlots(syntheticBank);
      const generated = { utterances: slots.map(slot => ({ id: slot.id, utterance: `A synthetic spoken question for ${slot.id}?` })).reverse() };
      const materialized = materializeCases(slots, generated, syntheticBank);
      assert.equal(materialized.length, 81);
      assert.deepEqual(Object.fromEntries(['paraphrase', 'lead-in', 'multi-part', 'follow-up', 'none', 'not-question', 'noisy'].map(kind => [kind, materialized.filter(item => item.kind === kind).length])),
        { paraphrase: 39, 'lead-in': 10, 'multi-part': 6, 'follow-up': 6, none: 8, 'not-question': 8, noisy: 4 });
      for (const [index, item] of materialized.entries()) {
        assert.equal(item.label, ['none', 'not-question'].includes(item.kind) ? 'none' : slots[index].sourceCardId);
        if (item.kind === 'lead-in') assert(item.utterance.startsWith(slots[index].prefix + ' '));
        if (item.kind === 'not-question') assert.equal(item.utterance, slots[index].utterance, 'host fixes the non-question label from the exact remark');
        if (item.kind === 'follow-up') {
          assert.equal(item.previousCardId, item.label);
          assert(materialized.some(previous => previous.kind === 'paraphrase' && previous.label === item.label && previous.utterance === item.previousUtterance));
        }
      }
      const tampered = structuredClone(generated);
      tampered.utterances[0].label = 'model-invented-label';
      assert.throws(() => materializeCases(slots, tampered, syntheticBank), /invalid/);
    },
  },
  {
    name: 'interview AI benchmark: malformed output cannot masquerade as a valid prediction',
    run() {
      assert.deepEqual(parsePrediction(answer('project', 'question', 0.5), cards), { kind: 'question', cardId: 'project', confidence: 0.5 });
      assert.deepEqual(parsePrediction(answer('project', 'follow-up'), cards, 'project'), { kind: 'follow-up', cardId: 'project', confidence: 0.97 });
      assert.equal(parsePrediction(answer('none', 'not-question'), cards, 'project').kind, 'not-question');
      assert.equal(parsePrediction(answer('none'), cards).kind, 'question', 'a real unmatched question is distinct from a remark');
      for (const invalid of [
        'null', '42', '[]',
        JSON.stringify({ cardId: 'project', confidence: 0.9 }),
        JSON.stringify({ kind: 'question', confidence: 0.9 }),
        JSON.stringify({ kind: 'question', cardId: 'project' }),
        answer('project', 'follow-up'),
        answer('none', 'follow-up'),
        answer('project', 'not-question'),
        '```json\n' + answer('project') + '\n```',
        JSON.stringify({ cardId: 'unknown', confidence: 0.9, kind: 'question' }),
        JSON.stringify({ cardId: 'project', confidence: '0.9', kind: 'question' }),
        JSON.stringify({ cardId: 'project', confidence: 1.1, kind: 'question' }),
        JSON.stringify({ cardId: 'project', confidence: 0.9, kind: 'unknown' }),
        JSON.stringify({ cardId: 'project', confidence: 0.9, kind: 'question', explanation: 'extra output' }),
      ]) assert.throws(() => parsePrediction(invalid, cards), /MATCH_(JSON|SCHEMA)_INVALID/);
      assert.throws(() => parsePrediction(answer('team', 'follow-up'), cards, 'project'), /MATCH_SCHEMA_INVALID/);
      assert.throws(() => parsePrediction(answer('unknown', 'follow-up'), cards, 'unknown'), /MATCH_SCHEMA_INVALID/);
    },
  },
  {
    name: 'interview AI benchmark: explicit locked-card context accompanies new questions and non-questions without exposing labels',
    run() {
      const validated = validateCases(cases, cards);
      for (const item of validated.filter(item => item.previousCardId)) {
        const prompt = JSON.parse(casePrompt(item, cards));
        assert.deepEqual(prompt, { question: item.utterance, previousCardId: item.previousCardId,
          previousQuestion: item.previousUtterance, previousCardQuestion: cards.find(card => card.id === item.previousCardId).question });
        assert.equal(Object.hasOwn(prompt, 'kind'), false);
        assert.equal(Object.hasOwn(prompt, 'label'), false);
      }
      assert.throws(() => validateCases([{ ...cases[0], previousCardId: 'missing', previousUtterance: 'Prior question?' }], cards), /context/);
    },
  },
  {
    name: 'interview AI benchmark: correct card abstention cannot conceal incorrect turn classification',
    run() {
      const records = cases.map(item => ({ configId: baseConfig.id, pass: 1, caseId: item.id, status: 'ok', latencyMs: 100,
        prediction: { cardId: item.label, confidence: 0.97, kind: item.kind === 'not-question' ? 'question' : expectedTurnKind(item) } }));
      const [row] = scoreResults({ cases, records, configs: [baseConfig] }).rows;
      assert.equal(row.noneRecall, 1, 'all none cards are still correct');
      assert.equal(row.kindAccuracy, (cases.length - 1) / cases.length);
      assert.equal(row.accuracy, row.kindAccuracy, 'joint selection accuracy includes the turn classification');
      assert.equal(row.notQuestionRecall, 0);
      assert.equal(row.eligible, false, 'a model that advances on interviewer remarks cannot win');
    },
  },
  {
    name: 'interview AI benchmark: a call failure stops one configuration and unavailable CLI spends nothing',
    async run() {
      await withOutput(async outDir => {
        const calls = [];
        const broken = { ...baseConfig, id: 'unsupported-model' };
        const factory = async config => config.id === broken.id ? {
          async request(prompt) {
            calls.push({ configId: config.id });
            if (!prompt.startsWith('{')) return { text: 'READY', latencyMs: 4_000, ttftMs: 3_000 };
            throw Object.assign(new Error('Synthetic model rejection'), { code: 'MODEL_UNSUPPORTED' });
          },
          async close() {},
        } : stubFactory(calls)(config);
        const summary = await runBenchmark({ cards, cases, configs: [broken, baseConfig], outDir, createTransport: factory });
        assert.equal(calls.filter(call => call.configId === broken.id).length, 2, 'initialization and the one failed case');
        assert.equal(calls.filter(call => call.configId === baseConfig.id).length, 1 + cases.length * 2);
        const failed = summary.rows.find(row => row.configId === broken.id && row.pass === 1);
        assert.equal(failed.completed, 1);
        assert.equal(failed.callFailures, 1);
        assert.equal(failed.eligible, false);
        assert.equal(summary.recommendation.configId, baseConfig.id);
      });
      await withOutput(async outDir => {
        let creations = 0;
        const summary = await runBenchmark({ cards, cases, configs: [baseConfig], outDir,
          cliMetadata: { claude: { available: false, error: 'SYNTHETIC_CLI_UNAVAILABLE' } },
          createTransport: async () => { creations += 1; throw new Error('Must not create a transport'); },
        });
        assert.equal(creations, 0);
        assert.equal(summary.rows[0].completed, 0);
        assert.equal(summary.rows[0].eligible, false);
        assert.equal(summary.setupErrors[0].code, 'SYNTHETIC_CLI_UNAVAILABLE');
      });
    },
  },
  {
    name: 'interview AI benchmark: changed warm replay predictions veto otherwise perfect measurements',
    run() {
      const config = { ...baseConfig, id: 'drifted-warm' };
      const records = [1, 2].flatMap(pass => cases.map(item => ({
        type: 'sample', configId: config.id, pass, caseId: item.id, status: 'ok', latencyMs: 100,
        prediction: { cardId: item.label, confidence: 0.97, kind: expectedTurnKind(item) },
      })));
      records.push({ type: 'replay', configId: config.id, pass: 1, caseId: cases[0].id, drift: true });
      const summary = scoreResults({ cases, records, configs: [config] });
      assert(summary.rows.every(row => row.accuracy === 1 && row.replayDrifts === 1 && !row.eligible));
      assert.equal(summary.recommendation, null);
    },
  },
  {
    name: 'interview AI benchmark: offload flags build named configs after Claude configs and reject bad input',
    run() {
      const parsed = parseArguments(['--no-claude', '--offload-routes', 'deepseek-flash', '--offload-reasoning', 'off,max', '--offload-bin', '/fake/offload']);
      assert.deepEqual(parsed, { '--no-claude': true, '--offload-routes': 'deepseek-flash', '--offload-reasoning': 'off,max', '--offload-bin': '/fake/offload' });
      assert.throws(() => parseArguments(['--offload-routes', 'deepseek-flash', '--offload-routes', 'deepseek-pro']), /duplicate/);
      assert.throws(() => parseArguments(['--offload-bin']), /Missing value/);
      const offloadOnly = configurations({ '--no-claude': true, '--offload-routes': 'deepseek-flash,deepseek-pro', '--offload-reasoning': 'off,high' }, '');
      assert.deepEqual(offloadOnly.map(config => config.id), ['offload-deepseek-flash-off', 'offload-deepseek-flash-high', 'offload-deepseek-pro-off', 'offload-deepseek-pro-high']);
      assert.deepEqual(offloadOnly[1], { id: 'offload-deepseek-flash-high', provider: 'offload', route: 'deepseek-flash', reasoning: 'high', model: 'deepseek-flash', effort: 'high' });
      const claudeOnly = configurations({}, '');
      assert.deepEqual(claudeOnly.map(config => config.id), ['haiku/default', 'sonnet/default', 'opus/default']);
      assert(claudeOnly.every(config => config.provider === undefined), 'Claude configs keep their original shape');
      const mixed = configurations({ '--claude-models': 'haiku', '--claude-efforts': 'low', '--offload-routes': 'deepseek-pro' }, '');
      assert.deepEqual(mixed.map(config => config.id), ['haiku/low', 'offload-deepseek-pro-off'], 'offload configs are appended and reasoning defaults to off');
      for (const bad of [
        { '--offload-routes': 'deepseek-nope' }, { '--offload-routes': 'deepseek-flash', '--offload-reasoning': 'extreme' },
        { '--offload-reasoning': 'low' }, { '--no-claude': true },
        { '--no-claude': true, '--claude-models': 'haiku', '--offload-routes': 'deepseek-flash' },
      ]) assert.throws(() => configurations(bad, ''), Error);
    },
  },
  {
    name: 'interview AI benchmark: offload transport sends a stateless request with an identical system message every turn',
    async run() {
      const captured = [];
      const spawnImpl = fakeOffloadSpawn(captured, cannedOffload);
      const saved = process.env.ELECTRON_RUN_AS_NODE;
      process.env.ELECTRON_RUN_AS_NODE = '1';
      try {
        const transport = await createTransport(offloadConfig, { spawnImpl, offloadBin: '/fake/offload', timeoutMs: 5_000, initialization: 'BANK-TEXT-MARKER' });
        assert.equal(captured.length, 0, 'creating the transport makes no provider call');
        const first = await transport.request(casePrompt(cases[0], cards));
        const second = await transport.request(casePrompt(cases[1], cards));
        await transport.close();
        assert.equal(captured.length, 2);
        assert.equal(captured[0].command, process.execPath);
        assert.deepEqual(captured[0].args, ['/fake/offload', 'complete']);
        assert.equal(Object.hasOwn(captured[0].env, 'ELECTRON_RUN_AS_NODE'), false);
        const [one, two] = captured.map(call => call.request);
        assert.deepEqual({ ...one, messages: undefined }, { version: 1, route: 'deepseek-flash', messages: undefined, maxTokens: 400,
          reasoning: { enabled: false }, timeoutMs: 5_000, caller: 'infinite-canvas-bench', tag: 'interview-match' });
        assert.equal(one.messages.length, 2);
        assert.equal(one.messages[0].role, 'system');
        assert(one.messages[0].content.includes('BANK-TEXT-MARKER'));
        assert.deepEqual(one.messages[0], two.messages[0], 'the system message is identical on every turn');
        assert.deepEqual(one.messages[1], { role: 'user', content: casePrompt(cases[0], cards) });
        assert.deepEqual(two.messages.map(message => message.role), ['system', 'user'], 'earlier turns are not accumulated');
        assert.deepEqual(two.messages[1], { role: 'user', content: casePrompt(cases[1], cards) });
        assert.equal(parsePrediction(first.text, cards).cardId, 'project');
        assert.equal(second.costUsd, DEEPSEEK_COST);
        assert.equal(second.resolvedModel, 'deepseek-synthetic');
        assert.equal(second.usage.cacheHitTokens, 90);
        assert(Number.isFinite(second.latencyMs) && second.latencyMs >= 0);
        const reasoned = [];
        for (const [reasoning, expected] of [['low', { enabled: true, effort: 'low' }], ['max', { enabled: true, effort: 'max' }]]) {
          const calls = [];
          const withReasoning = await createTransport({ ...offloadConfig, route: 'deepseek-pro', reasoning }, { spawnImpl: fakeOffloadSpawn(calls, cannedOffload), offloadBin: '/fake/offload' });
          await withReasoning.request('{}');
          reasoned.push([calls[0].request.route, calls[0].request.reasoning]);
          assert.deepEqual(calls[0].request.reasoning, expected);
        }
        assert.deepEqual(reasoned.map(([route]) => route), ['deepseek-pro', 'deepseek-pro']);
        await assert.rejects(createTransport({ ...offloadConfig, route: 'other' }, { spawnImpl }), { code: 'INVALID_OFFLOAD_CONFIG' });
      } finally {
        if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = saved;
      }
    },
  },
  {
    name: 'interview AI benchmark: failed offload results map to coded call errors',
    async run() {
      const attempt = async behave => {
        const transport = await createTransport(offloadConfig, { spawnImpl: fakeOffloadSpawn([], behave), offloadBin: '/fake/offload' });
        return transport.request('{}');
      };
      await assert.rejects(attempt(() => ({ code: 1, line: JSON.stringify({ ok: false, error: { code: 'rate_limited', message: 'slow down', retryable: true }, latencyMs: 3 }) })),
        { code: 'OFFLOAD_RATE_LIMITED', retryable: true });
      await assert.rejects(attempt(() => ({ code: 1, line: 'not json' })), { code: 'OFFLOAD_PROCESS_FAILED' });
      await assert.rejects(attempt(() => ({ code: 0, line: 'not json' })), { code: 'OFFLOAD_INVALID_RESULT' });
      await assert.rejects(attempt(() => ({ code: 0, line: JSON.stringify({ ok: true }) })), { code: 'OFFLOAD_INVALID_RESULT' });
      await withOutput(async outDir => {
        const factory = (config, options) => createTransport(config, { ...options, offloadBin: '/fake/offload',
          spawnImpl: fakeOffloadSpawn([], () => ({ code: 1, line: JSON.stringify({ ok: false, error: { code: 'upstream_error', message: 'x', retryable: false } }) })) });
        const summary = await runBenchmark({ cards, cases, configs: [offloadConfig], outDir, createTransport: factory });
        const row = summary.rows.find(candidate => candidate.pass === 1);
        assert.equal(row.callFailures, 1);
        assert.equal(row.completed, 1, 'a failed call stops the configuration like the warm transports');
        assert.equal(row.eligible, false);
        assert.deepEqual(summary.callErrors, [{ configId: offloadConfig.id, pass: 1, caseId: cases[0].id, code: 'OFFLOAD_UPSTREAM_ERROR' }]);
        assert.equal(row.costUsd, null, 'failed calls report no cost');
      });
    },
  },
  {
    name: 'interview AI benchmark: offload run aggregates cost, skips warm setup and resumes without replay',
    async run() {
      await withOutput(async outDir => {
        const captured = [];
        const factory = (config, options) => createTransport(config, { ...options, spawnImpl: fakeOffloadSpawn(captured, cannedOffload) });
        const options = { cards, cases, configs: [offloadConfig, { ...baseConfig, id: 'claude-like' }], outDir, offloadBin: '/fake/offload',
          createTransport: (config, transportOptions) => config.provider === 'offload' ? factory(config, transportOptions) : stubFactory([])(config) };
        const summary = await runBenchmark(options);
        assert.equal(captured.length, cases.length * 2, 'no initialization call: only the measured turns reach the provider');
        assert.equal(summary.warmSetups.length, 1, 'only the Claude-like config has a warm setup');
        assert(captured.every(call => call.args[0] === '/fake/offload'));
        assert.equal(new Set(captured.map(call => JSON.stringify(call.request.messages[0]))).size, 1);
        for (const row of summary.rows.filter(candidate => candidate.configId === offloadConfig.id)) {
          assert.equal(row.completed, cases.length);
          assert.equal(row.accuracy, 1);
          assert.equal(row.costUsd, DEEPSEEK_COST * cases.length);
          assert.equal(row.meanCostUsd, DEEPSEEK_COST);
          assert.deepEqual(row.resolvedModels, ['deepseek-synthetic']);
        }
        for (const row of summary.rows.filter(candidate => candidate.configId === 'claude-like')) {
          assert.equal(row.costUsd, null);
          assert.equal(row.meanCostUsd, null);
        }
        const markdown = renderMarkdown(summary);
        const csvLines = renderCsv(summary).trim().split('\n');
        assert(markdown.includes('| $0.008000/$0.001000 |'));
        assert(markdown.includes('| no | —/— |') || markdown.includes('| yes | —/— |'), 'unknown costs render as a dash');
        const header = csvLines[0].split(',');
        const offloadCsv = csvLines.find(line => line.startsWith(`"${offloadConfig.id}"`)).split('","');
        assert.equal(offloadCsv[header.indexOf('costUsd')], '0.008');
        assert.equal(offloadCsv[header.indexOf('meanCostUsd')].replace(/"$/, ''), '0.001');
        const journal = path.join(outDir, 'results.jsonl');
        const lines = (await fs.readFile(journal, 'utf8')).trimEnd().split('\n');
        const offloadSamples = lines.map(line => JSON.parse(line)).filter(record => record.configId === offloadConfig.id);
        assert(offloadSamples.every(record => record.type === 'sample' && record.costUsd === DEEPSEEK_COST));
        // Keep only the first three offload samples, then resume: no replay, only the remaining cases.
        const keep = lines.filter(line => JSON.parse(line).configId !== offloadConfig.id);
        const kept = lines.filter(line => JSON.parse(line).configId === offloadConfig.id).slice(0, 3);
        await fs.writeFile(journal, [...kept, ...keep].join('\n') + '\n');
        captured.length = 0;
        const resumed = await runBenchmark(options);
        assert.equal(captured.length, cases.length * 2 - 3);
        assert.equal(resumed.replays, 0);
        assert.equal(resumed.rows.find(row => row.configId === offloadConfig.id && row.pass === 1).costUsd, DEEPSEEK_COST * cases.length);
      });
    },
  },
];
