import assert from 'node:assert/strict';
import { aggregateSpeculativeReplay, parseSpeculativeReplayOptions, replaySpeculativeCase, speculativeReplayMarkdown } from '../interview-speculative-replay.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const bank = { cards: [{ id: 'a', question: 'Describe a project.', headline: 'Prepared project' }, { id: 'b', question: 'Describe a team.', headline: 'Prepared team' }] };
export default [
  { name: 'interview speculative replay: pure aggregation has explicit denominators and interpolated quantiles', run() {
    const rows = [
      { poolSize: 3, expectedCardId: 'a', firstCorrectPreviewAt: 2000, endpointAt: 5000, wrongPreview: false, finalLatencyMs: 0, instant: true, calls: 4,
        perceivedLatencyMs: 1050, inflight: false, finalCardId: 'a', finalKind: 'question' },
      { poolSize: 3, expectedCardId: 'a', firstCorrectPreviewAt: 4000, endpointAt: 5000, wrongPreview: true, finalLatencyMs: 100, instant: false, calls: 3,
        perceivedLatencyMs: 1150, inflight: true, finalCardId: 'a', finalKind: 'follow-up' },
      { poolSize: 3, expectedCardId: 'a', firstCorrectPreviewAt: 5000, endpointAt: 5000, wrongPreview: false, finalLatencyMs: 900, instant: false, calls: 3,
        perceivedLatencyMs: 1950, inflight: false, finalCardId: 'b', finalKind: 'question' },
      { poolSize: 3, expectedCardId: 'none', firstCorrectPreviewAt: null, endpointAt: 5000, wrongPreview: true, finalLatencyMs: 1000, instant: false, calls: 2,
        perceivedLatencyMs: 2050, inflight: false, finalCardId: null, finalKind: 'not-question' },
      { poolSize: 1, expectedCardId: 'a', firstCorrectPreviewAt: null, endpointAt: 5000, wrongPreview: false, finalLatencyMs: 800, instant: false, calls: 1,
        perceivedLatencyMs: 1850, inflight: false, finalCardId: 'b', finalKind: 'question' },
    ];
    const summary = aggregateSpeculativeReplay(rows);
    assert.equal(summary.length, 2); assert.equal(summary[0].poolSize, 1);
    assert.deepEqual(summary[0], { poolSize: 1, questions: 1, answerable: 1, correctPreviewPercent: 0,
      leadTimeMedianMs: null, leadTimeP10Ms: null, wrongPreviewPercent: 0, finalLockMedianMs: 800,
      finalLockP90Ms: 800, instantLockPercent: 0, callsPerQuestion: 1,
      perceivedLockMedianMs: 1850, perceivedLockP90Ms: 1850, inflightLockPercent: 0,
      reusedLockPercent: 0, lockCorrectPercent: 0 });
    assert.equal(summary[1].correctPreviewPercent, 100 * 2 / 3);
    assert.equal(summary[1].leadTimeMedianMs, 2000); assert.equal(summary[1].leadTimeP10Ms, 1200);
    assert.equal(summary[1].wrongPreviewPercent, 50); assert.equal(summary[1].finalLockMedianMs, 500);
    assert.equal(summary[1].instantLockPercent, 25); assert.equal(summary[1].callsPerQuestion, 3);
    assert.equal(summary[1].finalLockP90Ms, 970);
    assert.equal(summary[1].perceivedLockMedianMs, 1550); assert.equal(summary[1].perceivedLockP90Ms, 2020);
    assert.equal(summary[1].inflightLockPercent, 25); assert.equal(summary[1].reusedLockPercent, 50);
    assert.equal(summary[1].reusedLockPercent, summary[1].instantLockPercent + summary[1].inflightLockPercent);
    assert.equal(summary[1].lockCorrectPercent, 75);
    assert.deepEqual(aggregateSpeculativeReplay([]), []);
    assert.deepEqual(rows.map(row => row.calls), [4, 3, 3, 2, 1], 'aggregation must not mutate input');
    assert.equal(speculativeReplayMarkdown(summary).split('\n').filter(line => /^\| [13] \|/u.test(line)).length, 2);
    assert.deepEqual(speculativeReplayMarkdown(summary).split('\n').filter(line => line.startsWith('|')), [
      '| Pool | Cases | Correct early / answerable | Lead median / p10 ms | Any wrong preview | Final median / p90 ms | Perceived lock median / p90 ms | Instant locks | Inflight locks | Reused locks | Lock correct | Calls / case |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 1 | 1 | 0.0% | — / — | 0.0% | 800.0 / 800.0 | 1850.0 / 1850.0 | 0.0% | 0.0% | 0.0% | 0.0% | 1.0 |',
      '| 3 | 4 | 66.7% | 2000.0 / 1200.0 | 50.0% | 500.0 / 970.0 | 1550.0 / 2020.0 | 25.0% | 25.0% | 50.0% | 75.0% | 3.0 |',
    ]);
  } },
  { name: 'interview speculative replay: fake matcher runs the real scheduler and measures early preview and instant lock', async run() {
    let time = 0; const calls = [];
    const matcher = { poolSize: 3, speculativeCapacity: 2, minConfidence: 0.55, select(input) {
      calls.push(input); return { kind: 'question', cardId: 'a', confidence: 0.7 };
    } };
    const record = await replaySpeculativeCase({ item: { id: 'case-1', kind: 'paraphrase', label: 'a', utterance: 'Describe a project you built' },
      bank, matcher, rate: 1, silenceMs: 0, now: () => time, sleep: async milliseconds => { await flush(); time += milliseconds; await flush(); } });
    assert.equal(record.endpointAt, 5000); assert.equal(record.firstCorrectPreviewAt, 2000);
    assert.equal(record.wrongPreview, false); assert.equal(record.instant, true); assert.equal(record.calls, 3);
    assert.equal(record.finalLatencyMs, 0); assert.equal(calls.every(call => call.partial === true), true);
    assert.equal(aggregateSpeculativeReplay([record])[0].leadTimeMedianMs, 3000);
    assert.equal(record.lastWordAt, 5000); assert.equal(record.perceivedLatencyMs, 0);
    assert.equal(record.inflight, false); assert.equal(aggregateSpeculativeReplay([record])[0].lockCorrectPercent, 100);
  } },
  { name: 'interview speculative replay: pool one measures normal final latency and explicit follow-up context', async run() {
    let time = 0; const calls = [];
    const matcher = { poolSize: 1, speculativeCapacity: 0, select(input) {
      calls.push(input); time += 120; return { kind: 'follow-up', cardId: 'a', confidence: 0.9 };
    } };
    const record = await replaySpeculativeCase({ item: { id: 'case-2', kind: 'follow-up', label: 'follow-up', previousCardId: 'a',
      previousUtterance: 'Describe the project.', utterance: 'What did you learn then' }, bank, matcher, rate: 1,
      now: () => time, sleep: async milliseconds => { time += milliseconds; } });
    assert.equal(record.expectedCardId, 'a'); assert.equal(record.firstCorrectPreviewAt, null);
    assert.equal(record.calls, 1); assert.equal(record.instant, false); assert.equal(record.finalLatencyMs, 120);
    assert.equal(calls[0].partial, false); assert.equal(calls[0].previousCardId, 'a');
    assert.equal(calls[0].previousQuestion, 'Describe the project.'); assert.equal(calls[0].previousCardQuestion, 'Describe a project.');
    await assert.rejects(replaySpeculativeCase({ item: {}, bank, matcher, rate: 0 }), /Speaking rate must be positive\./u);
    assert.equal(record.lastWordAt, 5000); assert.equal(record.endpointAt, 6050);
    assert.equal(record.perceivedLatencyMs, 1170); assert.equal(record.inflight, false);
    const summary = aggregateSpeculativeReplay([record])[0];
    assert.equal(summary.finalLockMedianMs, 120); assert.equal(summary.finalLockP90Ms, 120);
    assert.equal(summary.perceivedLockMedianMs, 1170); assert.equal(summary.perceivedLockP90Ms, 1170);
    assert.equal(summary.lockCorrectPercent, 100);
  } },
  { name: 'interview speculative replay: default silence lets the last speculative call complete before endpoint', async run() {
    let time = 0; let completeLast = null;
    const calls = []; const sleeps = [];
    const utterance = 'Describe a project you built';
    const matcher = { poolSize: 3, speculativeCapacity: 2, minConfidence: 0.55, select(input) {
      calls.push({ text: input.text, partial: input.partial, at: time });
      if (input.text !== utterance) return { kind: 'none', cardId: null, confidence: 0.9 };
      return new Promise(resolve => { completeLast = () => resolve({ kind: 'question', cardId: 'a', confidence: 0.7 }); });
    } };
    const record = await replaySpeculativeCase({ item: { id: 'silence', label: 'a', utterance }, bank, matcher, rate: 1,
      now: () => time, sleep: async milliseconds => {
        sleeps.push(milliseconds);
        await flush();
        const target = time + milliseconds;
        if (completeLast && time < 5300 && target >= 5300) {
          time = 5300; completeLast(); completeLast = null;
          await flush();
        }
        time = target;
        await flush();
      } });
    assert.deepEqual(sleeps, [1000, 1000, 1000, 1000, 1000, 1050]);
    assert.deepEqual(calls, [
      { text: 'Describe a project', partial: true, at: 2000 },
      { text: 'Describe a project you', partial: true, at: 3000 },
      { text: utterance, partial: true, at: 4000 },
    ]);
    assert.equal(record.lastWordAt, 5000); assert.equal(record.endpointAt, 6050);
    assert.equal(record.firstCorrectPreviewAt, 5300); assert.equal(record.wrongPreview, false);
    assert.equal(record.instant, true); assert.equal(record.inflight, false); assert.equal(record.calls, 3);
    assert.equal(record.finalLatencyMs, 0); assert.equal(record.perceivedLatencyMs, 1050);
    const summary = aggregateSpeculativeReplay([record])[0];
    assert.equal(summary.correctPreviewPercent, 100); assert.equal(summary.leadTimeMedianMs, 750);
    assert.equal(summary.instantLockPercent, 100); assert.equal(summary.inflightLockPercent, 0);
    assert.equal(summary.reusedLockPercent, 100); assert.equal(summary.lockCorrectPercent, 100);
  } },
  { name: 'interview speculative replay: zero silence reuses an identical inflight call and measures its remaining latency', async run() {
    let time = 0; let completeLast = null;
    const calls = []; const utterance = 'Describe a project you built';
    const matcher = { poolSize: 3, speculativeCapacity: 2, minConfidence: 0.55, select(input) {
      calls.push(input);
      if (input.text !== utterance) return { kind: 'question', cardId: 'a', confidence: 0.7 };
      return new Promise(resolve => { completeLast = () => resolve({ kind: 'question', cardId: 'a', confidence: 0.7 }); });
    } };
    const replay = replaySpeculativeCase({ item: { id: 'inflight', label: 'a', utterance }, bank, matcher, rate: 1, silenceMs: 0,
      now: () => time, sleep: async milliseconds => { await flush(); time += milliseconds; await flush(); } });
    for (let step = 0; step < 20 && time < 5000; step += 1) await flush();
    await flush();
    assert.equal(time, 5000); assert.equal(typeof completeLast, 'function');
    time += 175; completeLast();
    const record = await replay;
    assert.equal(record.lastWordAt, 5000); assert.equal(record.endpointAt, 5000);
    assert.equal(record.instant, false); assert.equal(record.inflight, true);
    assert.equal(record.calls, 3); assert.equal(calls.every(call => call.partial === true), true);
    assert.equal(record.finalLatencyMs, 175); assert.equal(record.perceivedLatencyMs, 175);
    const summary = aggregateSpeculativeReplay([record])[0];
    assert.equal(summary.instantLockPercent, 0); assert.equal(summary.inflightLockPercent, 100);
    assert.equal(summary.reusedLockPercent, 100); assert.equal(summary.lockCorrectPercent, 100);
  } },
  { name: 'interview speculative replay: lock accuracy checks final cards and both unanswerable verdicts', run() {
    const cases = [
      { expectedCardId: 'a', finalCardId: 'a', finalKind: 'question', correct: 100 },
      { expectedCardId: 'a', finalCardId: 'a', finalKind: 'follow-up', correct: 100 },
      { expectedCardId: 'a', finalCardId: 'b', finalKind: 'question', correct: 0 },
      { expectedCardId: 'a', finalCardId: null, finalKind: 'none', correct: 0 },
      { expectedCardId: 'none', finalCardId: 'none', finalKind: 'question', correct: 100 },
      { expectedCardId: 'none', finalCardId: 'a', finalKind: 'question', correct: 0 },
      { expectedCardId: 'none', finalCardId: null, finalKind: 'not-question', correct: 100 },
      { expectedCardId: 'none', finalCardId: 'a', finalKind: 'question', correct: 0 },
      { expectedCardId: 'none', finalCardId: null, finalKind: undefined, correct: 0 },
    ];
    for (const item of cases) {
      const row = { poolSize: 2, firstCorrectPreviewAt: null, endpointAt: 1050, wrongPreview: false,
        finalLatencyMs: 0, perceivedLatencyMs: 1050, instant: true, inflight: false, calls: 1, ...item };
      const summary = aggregateSpeculativeReplay([row])[0];
      assert.equal(summary.instantLockPercent, 100);
      assert.equal(summary.lockCorrectPercent, item.correct, JSON.stringify(item));
    }
  } },
  { name: 'interview speculative replay: silence CLI defaults to 1050, allows zero and rejects invalid delays', async run() {
    const required = ['--bank', 'bank.json', '--cases', 'cases.json', '--out', 'output'];
    assert.deepEqual(parseSpeculativeReplayOptions(required), {
      bank: 'bank.json', cases: 'cases.json', out: 'output', pools: [1, 2, 3], rate: 2.6, silenceMs: 1050,
    });
    assert.equal(parseSpeculativeReplayOptions([...required, '--silence-ms', '0']).silenceMs, 0);
    assert.equal(parseSpeculativeReplayOptions([...required, '--silence-ms', '800.5']).silenceMs, 800.5);
    assert.deepEqual(parseSpeculativeReplayOptions([...required, '--pool', '3,1,3', '--rate', '4', '--silence-ms', '250']), {
      bank: 'bank.json', cases: 'cases.json', out: 'output', pools: [3, 1], rate: 4, silenceMs: 250,
    });
    for (const value of ['-1', 'Infinity', 'NaN']) {
      assert.throws(() => parseSpeculativeReplayOptions([...required, '--silence-ms', value]), {
        name: 'Error', message: '--silence-ms must be non-negative milliseconds.',
      });
    }
    assert.throws(() => parseSpeculativeReplayOptions([...required, '--silence-ms']), {
      name: 'Error', message: 'Usage: --bank BANK.json --cases CASES.json --out DIRECTORY [--pool 1,2,3] [--rate 2.6] [--silence-ms 1050]',
    });
    for (const silenceMs of [-1, Infinity, NaN]) {
      await assert.rejects(replaySpeculativeCase({ item: {}, bank, matcher: {}, silenceMs }), {
        name: 'TypeError', message: 'Silence must be non-negative milliseconds.',
      });
    }
  } },
];
