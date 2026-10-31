import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBenchmark, scoreResults, renderMarkdown, renderCsv } from '../interview-match-benchmark.mjs';
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
const cold = { id: 'safe-cold', transport: 'claude-cold', model: 'synthetic-model', effort: 'low' };

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
        ttftMs: config.transport === 'claude-warm' ? 200 : null,
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

export default [
  {
    name: 'interview AI benchmark: stub transport scores fixed cases and renders reviewable tables',
    async run() {
      return withOutput(async outDir => {
        const calls = [];
        const configs = [cold, { ...cold, id: 'unsafe-fast' }];
        const summary = await runBenchmark({ cards, cases, configs, outDir, createTransport: stubFactory(calls) });
        const safe = summary.rows.find(row => row.configId === cold.id);
        const unsafe = summary.rows.find(row => row.configId === 'unsafe-fast');
        assert.equal(calls.length, cases.length * configs.length);
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
        assert.equal(summary.recommendation.configId, cold.id, 'a faster confident false card must not win');
        const markdown = renderMarkdown(summary);
        const csv = renderCsv(summary);
        assert(markdown.includes(cold.id) && markdown.includes('unsafe-fast') && markdown.includes('|'));
        assert(csv.includes('p50Ms') && csv.includes('nonePrecision') && csv.includes('kindAccuracy') && csv.includes(cold.id));
        return { calls: calls.length, recommended: summary.recommendation.configId };
      });
    },
  },
  {
    name: 'interview AI benchmark: parse failures remain in accuracy and cannot hide unsafe none results',
    run() {
      const records = cases.map(item => ({
        configId: cold.id, pass: 1, caseId: item.id, status: item.kind === 'none' ? 'parse-error' : 'ok',
        prediction: item.kind === 'none' ? undefined : { cardId: item.label, confidence: 0.97, kind: expectedTurnKind(item) },
        latencyMs: 1_000,
      }));
      const summary = scoreResults({ cases, records, configs: [cold] });
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
        const config = { ...cold, id: 'safe-warm', transport: 'claude-warm' };
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
        const config = { ...cold, id: 'resume-warm', transport: 'claude-warm' };
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
      const records = cases.map(item => ({ configId: cold.id, pass: 1, caseId: item.id, status: 'ok', latencyMs: 100,
        prediction: { cardId: item.label, confidence: 0.97, kind: item.kind === 'not-question' ? 'question' : expectedTurnKind(item) } }));
      const [row] = scoreResults({ cases, records, configs: [cold] }).rows;
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
        const broken = { ...cold, id: 'unsupported-model' };
        const factory = async config => config.id === broken.id ? {
          async request() { calls.push({ configId: config.id }); throw Object.assign(new Error('Synthetic model rejection'), { code: 'MODEL_UNSUPPORTED' }); },
          async close() {},
        } : stubFactory(calls)(config);
        const summary = await runBenchmark({ cards, cases, configs: [broken, cold], outDir, createTransport: factory });
        assert.equal(calls.filter(call => call.configId === broken.id).length, 1);
        assert.equal(calls.filter(call => call.configId === cold.id).length, cases.length);
        const failed = summary.rows.find(row => row.configId === broken.id);
        assert.equal(failed.completed, 1);
        assert.equal(failed.callFailures, 1);
        assert.equal(failed.eligible, false);
        assert.equal(summary.recommendation.configId, cold.id);
      });
      await withOutput(async outDir => {
        let creations = 0;
        const summary = await runBenchmark({ cards, cases, configs: [cold], outDir,
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
      const config = { ...cold, id: 'drifted-warm', transport: 'claude-warm' };
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
    name: 'interview AI benchmark: one-shot timeouts close before recreation and never retry the failed case',
    async run() {
      for (const transport of ['claude-cold', 'codex']) await withOutput(async outDir => {
        const config = { ...cold, id: `timeout-${transport}`, transport };
        const events = [];
        let creations = 0;
        let open = false;
        const factory = async () => {
          assert.equal(open, false, 'close the old transport before creating another');
          open = true;
          const generation = ++creations;
          let closed = false;
          events.push(`create-${generation}`);
          return {
            async request(prompt) {
              const item = cases.find(testCase => prompt.includes(JSON.stringify(testCase.utterance)));
              assert(item);
              events.push(item.id);
              if (item.id === cases[0].id) throw Object.assign(new Error('Synthetic timeout'), { code: 'MATCH_TIMEOUT' });
              return { text: answer(item.label, expectedTurnKind(item)), latencyMs: 500, ttftMs: null };
            },
            async close() {
              if (!closed) { closed = true; open = false; events.push(`close-${generation}`); }
            },
          };
        };
        const summary = await runBenchmark({ cards, cases, configs: [config], outDir, createTransport: factory });
        assert.equal(creations, 2);
        assert.deepEqual(events.slice(0, 4), ['create-1', cases[0].id, 'close-1', 'create-2']);
        for (const item of cases) assert.equal(events.filter(event => event === item.id).length, 1);
        assert.equal(open, false);
        assert.equal(summary.rows[0].completed, cases.length);
        assert.equal(summary.rows[0].callFailures, 1);
        assert.equal(summary.rows[0].eligible, false);
        const samples = (await fs.readFile(path.join(outDir, 'results.jsonl'), 'utf8')).trimEnd().split('\n')
          .map(line => JSON.parse(line)).filter(record => record.type === 'sample');
        assert.equal(samples.length, cases.length);
        assert.equal(samples.filter(record => record.caseId === cases[0].id).length, 1);
        assert.equal(samples[0].status, 'call-error');
      });
    },
  },
];
