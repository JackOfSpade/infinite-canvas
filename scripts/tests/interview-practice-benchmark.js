import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createInterviewerSession } from '../../electron/interviewPracticeTransport.js';
import {
  assertExternalOutput, buildConfigs, buildJudgePackets, percentile, runBenchmark, shuffleForScenario, summarize,
} from '../interview-practice-benchmark.mjs';
import {
  CLASSIFIER_CASES, SCENARIOS, SYNTHETIC_BRIEF, SYNTHETIC_HISTORY, SYNTHETIC_PLAN, classifierMessage,
} from '../fixtures/interview-practice-scenarios.mjs';

// Synthetic stubs only: no process is spawned and no model is called.
const MARKERS = { haiku: 'Marker-Hh', opus: 'Marker-Oo', sonnet: 'Marker-Ss' };
const BASE_MS = { haiku: 500, opus: 1000, sonnet: 2000 };
const LISTEN_PROBE = 'um, we first looked at the, hmm, the';
const totalTurns = SCENARIOS.reduce((sum, scenario) => sum + scenario.turns.length, 0);

function stubFactory(counts = { sessions: 0, turns: 0 }, { neverListen = [], failOn = {} } = {}) {
  return async config => {
    counts.sessions += 1;
    let seen = 0;
    return {
      async start() {},
      async turn(message) {
        counts.turns += 1;
        seen += 1;
        if (failOn[config.model] === seen) throw Object.assign(new Error('stub'), { code: 'BOOM' });
        const base = BASE_MS[config.model];
        if (message.includes(LISTEN_PROBE) && !neverListen.includes(config.model)) {
          // firstSentenceMs is deliberately huge: a listen turn must never reach the first-sentence percentiles.
          return { text: '<listen/>', control: 'listen', endCall: false, firstSentenceMs: 99_999, firstDeltaMs: null, totalMs: 400, costUsd: 0.01 };
        }
        return { text: `${MARKERS[config.model]} reaction. Follow-up question?`, control: null, endCall: false,
          firstSentenceMs: base, firstDeltaMs: 100, totalMs: base + 300, costUsd: 0.01, usage: { output_tokens: 9 }, model: config.model };
      },
      async close() {},
    };
  };
}

async function withOutput(run) {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'interview-practice-unit-'));
  try { return await run(outDir); } finally { await fs.rm(outDir, { recursive: true, force: true }); }
}
const cfg = (model, effort = 'low') => ({ model, effort });
const readJournal = async outDir => (await fs.readFile(path.join(outDir, 'results.jsonl'), 'utf8')).trimEnd().split('\n');
const closeTo = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`);

const HELP = ['--print', '--output-format', '--tools', '--system-prompt', '--no-session-persistence', '--strict-mcp-config', '--mcp-config',
  '--model', '--effort', '--safe-mode', '--permission-mode dontAsk', '--no-chrome', '--input-format', '--verbose', '--include-partial-messages'].join('\n');

function fakeSpawn({ replies = [], refuse = false } = {}) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit('close', null)); return true; };
    child.stdin = new Writable({
      write(chunk, encoding, callback) {
        const message = JSON.parse(String(chunk).trim());
        const reply = replies.shift();
        if (!reply) { callback(); return; }
        setImmediate(() => {
          const emit = event => child.stdout.write(`${JSON.stringify(event)}\n`);
          for (const delta of reply.deltas || []) emit({ type: 'stream_event', event: { type: 'content_block_delta', delta } });
          emit({ type: 'assistant', message: { model: 'stub-model-id', content: [{ type: 'text', text: reply.text }] } });
          emit({ type: 'result', subtype: 'success', is_error: false, result: reply.text, total_cost_usd: reply.total,
            usage: { output_tokens: 7 }, user_message_uuid: message.uuid, session_id: 's1' });
        });
        callback();
      },
    });
    if (args[0] === '--help') setImmediate(() => { child.stdout.write(HELP); setImmediate(() => child.emit('close', 0)); });
    else if (refuse) setImmediate(() => child.emit('close', 1));
    return child;
  };
  return { spawn, calls };
}
const text = value => ({ type: 'text_delta', text: value });

export default [
  {
    name: 'interview practice transport: fable, unknown aliases and effort max are rejected before any process starts',
    async run() {
      const { spawn, calls } = fakeSpawn();
      for (const config of [{ model: 'fable', effort: 'low' }, { model: 'claude-opus-4', effort: 'low' }, { model: 'opus', effort: 'max' }, { effort: 'low' }]) {
        await assert.rejects(createInterviewerSession(config, { spawn }), { code: 'CONFIG_REJECTED' });
      }
      assert.equal(calls.length, 0);
      for (const model of ['opus', 'sonnet', 'haiku']) await createInterviewerSession({ model, effort: 'high' }, { spawn });
      assert.throws(() => buildConfigs('fable', 'low'), { code: 'CONFIG_REJECTED' });
      assert.throws(() => buildConfigs('opus,fable', 'low'), { code: 'CONFIG_REJECTED' });
      assert.throws(() => buildConfigs('opus', 'low,max'), { code: 'CONFIG_REJECTED' });
      assert.equal(buildConfigs('haiku,opus', 'low,high').length, 4);
      await withOutput(async outDir => {
        let created = 0;
        await assert.rejects(runBenchmark({ outDir, interviewerConfigs: [cfg('fable')], createSession: async () => { created += 1; } }), { code: 'CONFIG_REJECTED' });
        assert.equal(created, 0);
      });
    },
  },
  {
    name: 'interview practice transport: warm session streams text deltas, times the first sentence and splits cumulative cost',
    async run() {
      const { spawn, calls } = fakeSpawn({ replies: [
        { text: 'READY', total: 0.01 },
        { text: 'Mm-hm, that makes sense. What came next?', total: 0.03,
          deltas: [{ type: 'thinking_delta', thinking: 'hidden reasoning.' }, text('Mm-hm, '), text('that makes sense. '), text('What came next?')] },
        { text: '<listen/>', total: 0.035, deltas: [text('<listen/>')] },
      ] });
      const session = await createInterviewerSession({ model: 'sonnet', effort: 'low', claudeBin: 'stub-claude' }, { spawn });
      await session.start({ instructions: 'Instructions. Reply only READY now.' });
      const deltas = [];
      const first = await session.turn("[elapsed 01:00] Candidate: 'hello'", { onDelta: delta => deltas.push(delta) });
      assert.deepEqual(deltas, ['Mm-hm, ', 'that makes sense. ', 'What came next?']);
      assert.equal(first.text, 'Mm-hm, that makes sense. What came next?');
      assert.deepEqual(first.sentences, ['Mm-hm, that makes sense.', 'What came next?']);
      assert(Number.isFinite(first.firstDeltaMs) && Number.isFinite(first.firstSentenceMs));
      assert(first.firstDeltaMs <= first.firstSentenceMs && first.firstSentenceMs <= first.totalMs);
      closeTo(first.costUsd, 0.02);
      assert.equal(first.model, 'stub-model-id');
      assert.deepEqual(first.usage, { output_tokens: 7 });
      const second = await session.turn('[elapsed 02:00] Candidate: \'um, so\'');
      assert.equal(second.control, 'listen');
      assert.equal(second.firstSentenceMs, null);
      closeTo(second.costUsd, 0.005);
      const [, main] = calls;
      assert.equal(calls.length, 2, 'one capability probe and one warm process');
      assert.equal(main.bin, 'stub-claude');
      assert.equal(main.opts.shell, false);
      const flag = name => main.args[main.args.indexOf(name) + 1];
      assert.equal(flag('--tools'), '');
      assert.equal(flag('--model'), 'sonnet');
      assert.equal(flag('--effort'), 'low');
      assert.equal(flag('--permission-mode'), 'dontAsk');
      assert(main.args.includes('--safe-mode') && main.args.includes('--include-partial-messages') && main.args.includes('--no-chrome'));
      assert(!main.args.some(arg => /ultracode/i.test(arg)), 'ultracode must stay off');
      await session.close();
    },
  },
  {
    name: 'interview practice transport: a CLI refusal is a failure, never a substitution',
    async run() {
      const { spawn, calls } = fakeSpawn({ refuse: true });
      const session = await createInterviewerSession({ model: 'haiku', effort: 'xhigh' }, { spawn });
      await assert.rejects(session.start({ instructions: 'x' }), { code: 'TRANSPORT_UNAVAILABLE' });
      await session.close();
      assert.equal(calls.length, 2);
      assert(calls[1].args.includes('xhigh') && !calls[1].args.includes('low'), 'the requested effort is passed through untouched');
    },
  },
  {
    name: 'interview practice fixtures: seven synthetic scenarios and 24 balanced classifier cases',
    run() {
      assert.deepEqual(SCENARIOS.map(scenario => scenario.name.slice(0, 1)), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
      for (const scenario of SCENARIOS) {
        assert(scenario.turns.length >= 1 && scenario.persona.name);
        for (const item of scenario.turns) assert(/^\[elapsed \d+:\d\d\]/.test(item.message) && item.expect.length > 20);
      }
      const byName = Object.fromEntries(SCENARIOS.map(scenario => [scenario.name.slice(0, 1), scenario]));
      assert(byName.c.turns.some(item => item.message.includes('You were interrupted after saying')));
      assert(byName.d.turns[0].expectControl === 'listen' && byName.d.turns[1].expectControl === undefined);
      assert(byName.e.turns[0].message.includes('[candidate silent 10s]'));
      assert.equal(SYNTHETIC_HISTORY.split('\n').filter(line => line.includes('Interviewer:')).length, 40);
      assert.equal(byName.g.turns.length, 3);
      assert(byName.g.turns.some(item => item.message.startsWith('[elapsed 46:00]')));
      assert.equal(byName.g.history, SYNTHETIC_HISTORY);
      assert.equal(SYNTHETIC_PLAN.length, 10);
      assert(!/salary|compensation|equity|remote|office/i.test(JSON.stringify(SYNTHETIC_BRIEF)), 'the off-brief probe facts must be absent from the brief');
      assert.equal(CLASSIFIER_CASES.length, 24);
      assert.equal(new Set(CLASSIFIER_CASES.map(item => item.id)).size, 24);
      assert.equal(CLASSIFIER_CASES.filter(item => item.label === 'ack').length, 12);
      assert.equal(CLASSIFIER_CASES.filter(item => item.label === 'interrupt').length, 12);
      assert(CLASSIFIER_CASES.some(item => item.candidateOverlap === 'no, wait' && item.label === 'interrupt'));
      assert(CLASSIFIER_CASES.some(item => item.candidateOverlap === 'mm-hm' && item.label === 'ack'));
    },
  },
  {
    name: 'interview practice benchmark: first-sentence percentiles exclude listen turns and cost projects to 60 turns',
    async run() {
      assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
      assert.equal(percentile([], 0.95), null);
      await withOutput(async outDir => {
        const counts = { sessions: 0, turns: 0 };
        const { summary } = await runBenchmark({ outDir, runs: 1, only: 'interviewer', interviewerConfigs: [cfg('haiku'), cfg('sonnet')],
          createSession: stubFactory(counts, { neverListen: ['sonnet'] }) });
        assert.equal(counts.sessions, SCENARIOS.length * 2, 'a fresh session per scenario per config');
        assert.equal(counts.turns, totalTurns * 2);
        const haiku = summary.interviewer.find(row => row.config === 'haiku/low');
        const sonnet = summary.interviewer.find(row => row.config === 'sonnet/low');
        assert.equal(haiku.listenTurns, 1);
        assert.equal(haiku.spokenTurns, totalTurns - 1);
        assert.equal(haiku.p50FirstSentenceMs, 500);
        assert.equal(haiku.p95FirstSentenceMs, 500, 'the 99999 ms listen turn must not leak into the percentile');
        assert.equal(haiku.p50ListenMs, 400);
        assert.equal(haiku.p95ListenMs, 400);
        assert.equal(haiku.keepListeningAccuracy, 1);
        assert.equal(sonnet.keepListeningAccuracy, 0.5, 'never listening misses the unfinished turn');
        assert.equal(sonnet.listenTurns, 0);
        closeTo(haiku.meanCostPerTurnUsd, 0.01);
        closeTo(haiku.projectedCostPerCallUsd, 0.6);
        assert.equal(haiku.eligible, true);
        assert.equal(sonnet.eligible, false, 'p95 2000 ms is above the 1500 ms gate');
        assert.deepEqual(summary.ranking, ['haiku/low']);
        const markdown = await fs.readFile(path.join(outDir, 'summary.md'), 'utf8');
        assert(markdown.includes('1500') && markdown.includes('(to be filled)') && markdown.includes('600'));
        const transcript = await fs.readFile(path.join(outDir, 'transcripts', 'haiku-low', `${SCENARIOS[0].name}.md`), 'utf8');
        assert(transcript.includes(MARKERS.haiku) && transcript.includes(SCENARIOS[0].turns[0].message));
        for (const name of ['summary.json', 'results.jsonl', 'judge-key.json']) await fs.access(path.join(outDir, name));
        assert.equal(JSON.parse(await fs.readFile(path.join(outDir, 'summary.json'), 'utf8')).interviewer.length, 2);
      });
    },
  },
  {
    name: 'interview practice benchmark: the journal resumes without repeating completed scenarios',
    async run() {
      await withOutput(async outDir => {
        const counts = { sessions: 0, turns: 0 };
        const options = { outDir, runs: 1, only: 'interviewer', interviewerConfigs: [cfg('haiku')], createSession: stubFactory(counts) };
        await runBenchmark(options);
        const before = await readJournal(outDir);
        assert.equal(before.length, totalTurns);
        await runBenchmark(options);
        assert.equal(counts.sessions, SCENARIOS.length, 'a complete journal creates no session');
        assert.deepEqual(await readJournal(outDir), before, 'completed records are kept byte for byte');
        const lastScenarioTurns = SCENARIOS[SCENARIOS.length - 1].turns.length;
        await fs.writeFile(path.join(outDir, 'results.jsonl'), before.slice(0, before.length - lastScenarioTurns).join('\n') + '\n{"type":"turn","kin');
        counts.sessions = 0; counts.turns = 0;
        const resumed = await runBenchmark(options);
        assert.equal(counts.sessions, 1, 'only the missing scenario is rerun');
        assert.equal(counts.turns, lastScenarioTurns);
        const after = await readJournal(outDir);
        assert.equal(after.length, totalTurns);
        assert(after.every(line => JSON.parse(line)), 'the torn tail is removed before new records');
        assert.deepEqual(after.slice(0, before.length - lastScenarioTurns), before.slice(0, before.length - lastScenarioTurns));
        assert.equal(resumed.summary.interviewer[0].turns, totalTurns);
      });
    },
  },
  {
    name: 'interview practice benchmark: judge packets hide configs and the separate key maps letters back',
    async run() {
      await withOutput(async outDir => {
        const { key, records } = await runBenchmark({ outDir, runs: 1, only: 'interviewer', interviewerConfigs: [cfg('haiku'), cfg('opus')], createSession: stubFactory() });
        const fileKey = JSON.parse(await fs.readFile(path.join(outDir, 'judge-key.json'), 'utf8'));
        assert.deepEqual(fileKey, key);
        assert.deepEqual(Object.keys(fileKey), SCENARIOS.map(scenario => scenario.name));
        for (const scenario of SCENARIOS) {
          const packet = await fs.readFile(path.join(outDir, 'judge-packets', `${scenario.name}.md`), 'utf8');
          assert(!/haiku|opus|sonnet|\/low/i.test(packet), 'packets must not name a model or effort');
          assert(!packet.includes('judge-key'));
          assert(packet.includes('Reacts to the specific content') && packet.includes('Correct keep-listening call'));
          assert(packet.includes(scenario.turns[0].expect));
          const letters = Object.keys(fileKey[scenario.name]);
          assert.deepEqual(letters, ['A', 'B']);
          assert.deepEqual(Object.values(fileKey[scenario.name]).sort(), ['haiku/low', 'opus/low']);
          for (const letter of letters) {
            const section = packet.split(`## Transcript ${letter}`)[1].split('## Transcript ')[0];
            const model = fileKey[scenario.name][letter].split('/')[0];
            assert(section.includes(MARKERS[model]), `transcript ${letter} must be the ${model} transcript`);
            for (const other of Object.keys(MARKERS).filter(name => name !== model)) assert(!section.includes(MARKERS[other]));
          }
        }
        const reversed = buildJudgePackets({ records: [...records].reverse() });
        assert.deepEqual(reversed.key, key, 'letter assignment must not depend on record order');
        assert.deepEqual(shuffleForScenario(['a', 'b', 'c', 'd'], 'x'), shuffleForScenario(['d', 'c', 'b', 'a'], 'x'));
        assert.deepEqual([...shuffleForScenario(['a', 'b', 'c', 'd'], 'x')].sort(), ['a', 'b', 'c', 'd']);
      });
    },
  },
  {
    name: 'interview practice benchmark: an output directory inside the repository is refused',
    async run() {
      const repoRoot = path.resolve(import.meta.dirname, '..', '..');
      const inside = path.join(repoRoot, '.practice-benchmark-test-output');
      await assert.rejects(assertExternalOutput(inside), /outside the repository/);
      await assert.rejects(assertExternalOutput(repoRoot), /outside the repository/);
      await assert.rejects(assertExternalOutput(path.join(repoRoot, 'scripts', 'nested', 'deeper')), /outside the repository/);
      let created = 0;
      await assert.rejects(runBenchmark({ outDir: inside, interviewerConfigs: [cfg('haiku')], createSession: async () => { created += 1; } }), /outside the repository/);
      assert.equal(created, 0);
      await assert.rejects(fs.access(inside), { code: 'ENOENT' });
      await withOutput(async outDir => { await assertExternalOutput(path.join(outDir, 'child')); });
    },
  },
  {
    name: 'interview practice benchmark: classifier accuracy, percentiles and the 600 ms gate are computed from the journal',
    async run() {
      const cases = [['ack', 'right'], ['ack', 'mm-hm'], ['ack', 'yeah'], ['interrupt', 'no, wait'], ['interrupt', 'hold on'], ['interrupt', 'sorry?']]
        .map(([label, overlap], index) => ({ id: `t${index}`, interviewerPartial: 'Partial', candidateOverlap: overlap, label }));
      const wrong = new Set(['t2', 't4']);
      const times = { t0: 100, t1: 200, t2: 300, t3: 400, t4: 500, t5: 700 };
      const factory = async () => ({
        async start() {},
        async turn(message) {
          const item = cases.find(candidate => classifierMessage(candidate) === message);
          const answer = wrong.has(item.id) ? (item.label === 'ack' ? 'Interrupt' : 'ack.') : item.label.toUpperCase();
          return { text: answer, totalMs: times[item.id] };
        },
        async close() {},
      });
      await withOutput(async outDir => {
        const { summary } = await runBenchmark({ outDir, runs: 1, only: 'classifier', classifierConfigs: [cfg('haiku')], classifierCases: cases, createSession: factory });
        const [row] = summary.classifier;
        assert.equal(row.cases, 6);
        assert.equal(row.correct, 4);
        closeTo(row.accuracy, 4 / 6);
        assert.equal(row.p50Ms, 300);
        assert.equal(row.p95Ms, 700);
        assert.equal(row.passesGate, false);
        const journal = (await readJournal(outDir)).map(line => JSON.parse(line));
        assert.deepEqual(journal.filter(record => !record.correct).map(record => record.caseId), ['t2', 't4']);
        assert.equal(journal.find(record => record.caseId === 't2').answer, 'interrupt');
      });
      const quick = summarize({ records: cases.map(() => ({ type: 'case', kind: 'classifier', config: 'x/low', correct: true, totalMs: 600 })), classifierConfigs: [] });
      assert.equal(quick.classifier[0].passesGate, true, 'p95 exactly 600 ms meets the gate');
      assert.equal(quick.classifier[0].accuracy, 1);
    },
  },
  {
    name: 'interview practice benchmark: a failure stops only that configuration and is never retried',
    async run() {
      await withOutput(async outDir => {
        const counts = { sessions: 0, turns: 0 };
        const options = { outDir, runs: 1, only: 'interviewer', interviewerConfigs: [cfg('opus'), cfg('haiku')], createSession: stubFactory(counts, { failOn: { opus: 2 } }) };
        const { summary } = await runBenchmark(options);
        const opus = summary.interviewer.find(row => row.config === 'opus/low');
        const haiku = summary.interviewer.find(row => row.config === 'haiku/low');
        assert.equal(opus.turns, 1, 'the turn before the failure is kept');
        assert.deepEqual(opus.failures, [{ scenario: SCENARIOS[0].name, turnIndex: 1, code: 'BOOM' }]);
        assert.equal(opus.eligible, false);
        assert.equal(haiku.turns, totalTurns);
        assert.equal(haiku.failures.length, 0);
        assert.equal(counts.sessions, 1 + SCENARIOS.length, 'the failed config opened one session and no replacement');
        const sessionsBefore = counts.sessions;
        await runBenchmark(options);
        assert.equal(counts.sessions, sessionsBefore, 'resume does not retry a failed configuration');
        const markdown = await fs.readFile(path.join(outDir, 'summary.md'), 'utf8');
        assert(markdown.includes('BOOM'));
      });
      await withOutput(async outDir => {
        const failing = async config => ({ async start() { if (config.model === 'sonnet') throw Object.assign(new Error('x'), { code: 'TRANSPORT_UNAVAILABLE' }); }, async turn() { return { text: 'ack', totalMs: 50 }; }, async close() {} });
        const { summary } = await runBenchmark({ outDir, runs: 1, only: 'classifier', classifierConfigs: [cfg('sonnet'), cfg('haiku')],
          classifierCases: CLASSIFIER_CASES.slice(0, 4), createSession: failing });
        assert.equal(summary.classifier.find(row => row.config === 'sonnet/low').cases, 0);
        assert.equal(summary.classifier.find(row => row.config === 'sonnet/low').failures[0].code, 'TRANSPORT_UNAVAILABLE');
        assert.equal(summary.classifier.find(row => row.config === 'haiku/low').cases, 4);
      });
    },
  },
  {
    name: 'interview practice benchmark: report-only rebuilds reports without any session',
    async run() {
      await withOutput(async outDir => {
        await assert.rejects(runBenchmark({ outDir, reportOnly: true, createSession: async () => { throw new Error('must not run'); } }), /No existing run/);
        await runBenchmark({ outDir, runs: 1, only: 'interviewer', interviewerConfigs: [cfg('haiku')], createSession: stubFactory() });
        await fs.rm(path.join(outDir, 'summary.md'));
        await fs.rm(path.join(outDir, 'judge-packets'), { recursive: true });
        let created = 0;
        const { summary } = await runBenchmark({ outDir, reportOnly: true, createSession: async () => { created += 1; throw new Error('must not run'); } });
        assert.equal(created, 0);
        assert.equal(summary.interviewer[0].config, 'haiku/low');
        await fs.access(path.join(outDir, 'summary.md'));
        await fs.access(path.join(outDir, 'judge-packets', `${SCENARIOS[0].name}.md`));
      });
    },
  },
];
