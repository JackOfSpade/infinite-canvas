import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CALL_THRESHOLDS } from '../../electron/interviewPracticeCallEngine.js';
import {
  runScenario, runSweep, chooseBest, formatSweep, createLognormal, mulberry32, PHASE0, percentile,
  createVirtualClock, createFakeHelper, DEFAULT_SMART_TURN_ACCURACY,
} from '../interview-practice-simulate.mjs';
import { getScenario, SCENARIOS, AMI_PAUSES } from '../fixtures/interview-practice-call-scenarios.mjs';

// Synthetic data only: scenarios, latencies and candidates are simulated, never recorded.

const SEEDS = [1, 2, 3, 4, 5];
const suite = [];
const test = (name, run) => suite.push({ name: `interview practice simulation: ${name}`, run });

const cmds = (result, type) => result.commands.filter(command => command.type === type);
const lastMain = result => result.mainMessages[result.mainMessages.length - 1];
const silentMessages = result => result.mainMessages.filter(message => message.includes('[candidate silent 10s]'));
const untimed = entries => entries.map(({ startMs, endMs, ...rest }) => { assert(Number.isInteger(startMs) && startMs === endMs, `chat entry carries helper-timeline timing: ${JSON.stringify({ startMs, endMs })}`); return rest; });
const interviewerLines = result => result.transcript.filter(entry => entry.speaker === 'interviewer' && entry.channel !== 'chat');

/** Words the fake voice had played before the cancel position (the voice and helper are the ground truth). */
function heardBefore(result, cancel) {
  const voice = result.voice.find(item => item.utteranceId === cancel.utteranceId);
  assert(voice, 'cancelled utterance has a voice record');
  return voice.words.filter(word => word.endMs <= cancel.positionMs).map(word => word.word).join(' ');
}

async function eachSeed(name, check) {
  const scenario = getScenario(name);
  assert.equal(scenario.synthetic, true, `${name} is labelled synthetic`);  for (const seed of SEEDS) {
    const result = await runScenario(scenario, { thresholds: DEFAULT_CALL_THRESHOLDS, seed });
    assert.equal(result.incomplete, false, `${name} seed ${seed}: the scripted candidate finished`);
    check(result, `${name} seed ${seed}`);
  }
}

/** Ear-on scenarios: the scenario must be labelled synthetic and must have opted into the fake ear. */
async function eachEarSeed(name, check) {
  const scenario = getScenario(name);
  assert.equal(scenario.synthetic, true, `${name} is labelled synthetic`);
  assert.equal(scenario.ear, true, `${name} is an ear-on scenario`);
  for (const seed of SEEDS) await check(scenario, seed, `${name} seed ${seed}`);
}

function assertInterruption(result, label, typedMessage) {
  const cancels = cmds(result, 'cancel');
  assert.equal(cancels.length, 1, `${label}: one cancel`);
  const heard = heardBefore(result, cancels[0]);
  const full = result.voice.find(item => item.utteranceId === cancels[0].utteranceId).texts.join(' ');
  assert(heard.length > 0 && heard.length < full.length, `${label}: heard is a non-empty strict prefix of what was sent`);
  assert(lastMain(result).includes(`[You were interrupted after saying: '${heard}'. The rest was not heard.]`), `${label}: interruption note carries the played words`);
  const trimmed = interviewerLines(result).filter(entry => entry.interrupted === true);
  assert.equal(trimmed.length, 1, `${label}: one trimmed interviewer line`);
  assert.equal(trimmed[0].text, heard);
  assert.equal(trimmed[0].heardText, heard);
  assert.deepEqual(result.events.filter(event => event.type === 'interrupted').map(event => event.heardText), [heard]);
  if (typedMessage) assert(lastMain(result).includes(typedMessage), `${label}: typed turn sent`);
}

test('scenarios are labelled synthetic and carry machine-checkable expectations', () => {
  assert.equal(SCENARIOS.length, 16);
  for (const scenario of SCENARIOS) {
    assert.equal(scenario.synthetic, true, scenario.name);
    assert.equal(typeof scenario.expect, 'object', scenario.name);
    assert(Object.keys(scenario.expect).length > 0, scenario.name);
  }
});

test('fake latencies are lognormal fits of the Phase 0 p50/p95, sampled deterministically', () => {
  for (const [kind, spec] of Object.entries(PHASE0)) {
    const sample = createLognormal(mulberry32(7), spec);
    const values = Array.from({ length: 20000 }, sample);
    const p50 = percentile(values, 0.5);
    const p95 = percentile(values, 0.95);
    assert(Math.abs(p50 - spec.p50) / spec.p50 < 0.02, `${kind} p50 ${p50} vs ${spec.p50}`);
    assert(Math.abs(p95 - spec.p95) / spec.p95 < 0.03, `${kind} p95 ${p95} vs ${spec.p95}`);
    const again = createLognormal(mulberry32(7), spec);
    assert.deepEqual(Array.from({ length: 5 }, again), values.slice(0, 5));
  }
  assert.deepEqual(PHASE0.opener, { p50: 700, p95: 1170 });
  assert.deepEqual(PHASE0.main, { p50: 1398, p95: 2040 });
  assert.deepEqual(PHASE0.classifier, { p50: 900, p95: 1087 });
  assert.deepEqual(PHASE0.voice, { p50: 546, p95: 574 });
});

test('a run is deterministic for a seed and differs between seeds', async () => {
  const scenario = getScenario('ack-mid-sentence');
  const one = await runScenario(scenario, { seed: 3 });
  const two = await runScenario(scenario, { seed: 3 });
  const other = await runScenario(scenario, { seed: 4 });
  assert.deepEqual(one.commands, two.commands);
  assert.deepEqual(one.mainMessages, two.mainMessages);
  assert.notDeepEqual(one.commands.map(command => command.at), other.commands.map(command => command.at));
});

test('ack-mid-sentence: acknowledgements neither cancel nor get a reply, and are listed in the next main message', () => eachSeed('ack-mid-sentence', (result, label) => {
  assert.equal(cmds(result, 'cancel').length, 0, `${label}: no cancel`);
  assert.equal(cmds(result, 'play').length, 3, `${label}: greeting, one reply, one follow-up reply`);
  assert.equal(result.mainMessages.length, 3, `${label}: the acknowledgements triggered no main call`);
  const acks = result.transcript.filter(entry => entry.acknowledgement === true).map(entry => entry.text);
  assert.deepEqual(acks, ['right', 'gotcha'], label);
  assert(lastMain(result).includes('[Candidate acknowledgements while you spoke: "right", "gotcha"]'), label);
  assert(result.mainMessages.slice(0, -1).every(message => !message.includes('acknowledgements')), label);
  assert.equal(result.transcript.filter(entry => entry.text === 'right' && !entry.acknowledgement).length, 0, label);
  assert.equal(interviewerLines(result).every(entry => entry.interrupted !== true), true, label);
}));

test('clarification-interrupt: cancel, interruption note equals the words played, interviewer line trimmed', () => eachSeed('clarification-interrupt', (result, label) => {
  assertInterruption(result, label);
  assert(lastMain(result).includes("Candidate: 'sorry, do you mean the API layer?'"), label);
}));

test('short-interrupt-classifier: a short interrupt is classified first, then cancels', () => eachSeed('short-interrupt-classifier', (result, label) => {
  assert.equal(result.classifierCalls.length, 1, `${label}: classifier called once`);
  assert(result.classifierCalls[0].message.includes("Candidate's words: 'no,"), label);
  const cancels = cmds(result, 'cancel');
  assert.equal(cancels.length, 1, label);
  assert(cancels[0].at > result.classifierCalls[0].at, `${label}: cancel after the classifier call`);
  assertInterruption(result, label);
}));

test('thinking-pause: no play command during a 1500 ms within-answer pause at default thresholds', () => eachSeed('thinking-pause', (result, label) => {
  assert.equal(result.pauseWindows.length, 1, label);
  const [window] = result.pauseWindows;
  assert.equal(Math.round(window.end - window.start), 1500, `${label}: the scripted pause is 1500 ms`);
  const plays = cmds(result, 'play');
  assert.equal(plays.filter(play => play.at >= window.start && play.at < window.end).length, 0, `${label}: no play inside the pause`);
  assert.equal(result.cutIns, 0, label);
  assert.equal(plays.length, 2, `${label}: greeting plus one reply to the finished answer`);
  assert(plays[1].at >= window.end, `${label}: the reply starts after the answer resumed and ended`);
  assert.equal(result.mainMessages.filter(message => message.includes('I would start with the data model and then')).length, 1, label);
}));

test('silence-10s: exactly one silence message after 10 s of quiet', () => eachSeed('silence-10s', (result, label) => {
  assert.equal(silentMessages(result).length, 1, label);
  assert.equal(result.mainMessages.length, 2, `${label}: greeting plus the silence prompt only`);
  assert(cmds(result, 'play').length === 2, label);
}));

test('hang-up: ends as candidate, cancels the playing utterance, sends nothing afterwards', () => eachSeed('hang-up', (result, label) => {
  assert.equal(result.ended.reason, 'candidate', label);
  const plays = cmds(result, 'play');
  const cancels = cmds(result, 'cancel');
  assert.equal(cancels.length, 1, label);
  assert.equal(cancels[0].utteranceId, plays[plays.length - 1].utteranceId, `${label}: cancel targets the playing utterance`);
  assert(cancels[0].positionMs > 0, `${label}: it was mid-playback`);
  assert.equal(result.commands[result.commands.length - 1].type, 'cancel', label);
  assert.equal(result.commands.filter(command => command.at > result.ended.atClockMs).length, 0, `${label}: no commands after the end`);
}));

test('session-crash: main fails once, the session restarts, the turn is re-sent and the call continues', () => eachSeed('session-crash', (result, label) => {
  assert.deepEqual(result.restarts.map(item => item.kind), ['main'], label);
  assert.equal(result.mainMessages.length, 4, `${label}: greeting, failed turn, re-sent turn, next turn`);
  assert.equal(result.mainMessages[1], result.mainMessages[2], `${label}: the same turn message was re-sent`);
  assert.notEqual(result.mainMessages[2], result.mainMessages[3], label);
  assert.equal(cmds(result, 'play').length, 3, label);
  const lines = interviewerLines(result);
  assert.equal(lines.length, 3, label);
  assert(lines[1].text.endsWith('Thanks, that is clear. What was the hardest part?'), label);
  assert(lines[2].text.endsWith('I see, and how did you measure the result?'), `${label}: the call continued to the next reply`);
  assert.equal(result.ended, null, label);
}));

test('end-call: ended as interviewer only after the final utterance finished playing', () => eachSeed('end-call', (result, label) => {
  const ends = result.events.filter(event => event.type === 'ended');
  assert.equal(ends.length, 1, label);
  assert.equal(ends[0].reason, 'interviewer', label);
  const plays = cmds(result, 'play');
  const lastId = plays[plays.length - 1].utteranceId;
  const finished = result.helperLog.find(item => item.state === 'finished' && item.utteranceId === lastId);
  assert(finished, `${label}: the last utterance finished`);
  assert(ends[0].atClockMs >= finished.at, `${label}: ended at ${ends[0].atClockMs} not before finished at ${finished.at}`);
  assert.equal(cmds(result, 'cancel').length, 0, label);
  assert(!interviewerLines(result).some(entry => entry.text.includes('<end-call/>')), label);
}));

test('chat-typed-turn: a message typed while listening is a typed turn on the chat channel', () => eachSeed('chat-typed-turn', (result, label) => {
  assert(lastMain(result).includes("Candidate (typed in chat): 'I would start with the data model'"), label);
  assert.deepEqual(untimed(result.transcript.filter(entry => entry.speaker === 'candidate')),
    [{ speaker: 'candidate', channel: 'chat', text: 'I would start with the data model' }], label);
  assert.equal(cmds(result, 'play').length, 2, label);
}));

test('chat-typing-pauses-silence: no silence message while the candidate is typing', () => eachSeed('chat-typing-pauses-silence', (result, label) => {
  assert.equal(silentMessages(result).length, 0, label);
  assert(result.mainMessages.some(message => message.includes('[candidate is typing in chat]')), `${label}: typing was reported`);
  assert(lastMain(result).includes("Candidate (typed in chat): 'def add(a, b): return a + b'"), label);
  assert(!lastMain(result).includes('[candidate is typing in chat]'), `${label}: typing ended with the send`);
  assert.equal(cmds(result, 'play').length, 3, label);
}));

test('chat-type-over-interviewer: a 6-word typed message cancels, notes the interruption and is a typed turn', () => eachSeed('chat-type-over-interviewer', (result, label) => {
  assert.equal(result.classifierCalls.length, 0, `${label}: more than interruptWords words need no classifier`);
  assertInterruption(result, label, "Candidate (typed in chat): 'I will write it in chat'");
  assert.deepEqual(result.transcript.filter(entry => entry.channel === 'chat').map(entry => entry.text), ['I will write it in chat'], label);
}));

test('interviewer-chat-post: a <chat> block becomes a chat event and is never sent to the voice', () => eachSeed('interviewer-chat-post', (result, label) => {
  const problem = getScenario('interviewer-chat-post').expect.chatText;
  assert.deepEqual(result.events.filter(event => event.type === 'chat').map(event => ({ from: event.from, text: event.text })),
    [{ from: 'interviewer', text: problem }], label);
  const spoken = result.voice.flatMap(item => item.texts);
  assert(spoken.includes('Here is the problem.'), `${label}: the spoken sentences were sent`);
  assert(spoken.every(text => !text.includes('merge all overlapping') && !text.includes('<chat>')), `${label}: chat text never reaches the voice`);
  assert.deepEqual(untimed(result.transcript.filter(entry => entry.channel === 'chat')), [{ speaker: 'interviewer', channel: 'chat', text: problem }], label);
}));

test('pause-heavy-answers: synthetic multi-pause answers run to completion at default thresholds', async () => {
  const scenario = getScenario('pause-heavy-answers');
  const result = await runScenario(scenario, { seed: 1 });
  assert.equal(result.incomplete, false);
  assert.equal(result.answers.length, scenario.expect.answers);
  assert(result.pauseWindows.length >= 2 * result.answers.length);
  const real = new Set(AMI_PAUSES.pausesMs);
  assert(result.pauseWindows.every(window => real.has(Math.round(window.end - window.start))), 'every pause is a real AMI duration');
});

test('chooseBest picks the lowest p95 among rows meeting the rule, else the lowest cut-in rate', () => {
  const row = (speculateMs, commitMs, falseCutInRate, p95Ms) => ({ speculateMs, commitMs, falseCutInRate, p95Ms });
  const rows = [row(400, 900, 0.2, 1500), row(600, 1200, 0.02, 2300), row(700, 1400, 0.01, 2100), row(800, 1800, 0, 2600), row(500, 1000, 0.01, 2400)];
  assert.deepEqual(chooseBest(rows), { qualified: true, row: row(700, 1400, 0.01, 2100) });
  const none = [row(400, 900, 0.3, 1800), row(600, 1200, 0.05, 2000), row(800, 1800, 0.04, 2900)];
  assert.deepEqual(chooseBest(none), { qualified: false, row: row(800, 1800, 0.04, 2900) });
});

test('reduced sweep: table shape and the best pair follow the rule on the computed rows', async () => {
  const sweep = await runSweep({ seeds: 2, speculateMs: [400, 600, 800], commitMs: [900, 1200, 1800], voiceGateMs: [0], listenAccuracy: [1.0] });
  assert.deepEqual(sweep.seeds, [1, 2]);
  assert.equal(sweep.rows.length, 9);
  for (const row of sweep.rows) {
    assert(row.commitMs > row.speculateMs);
    assert.equal(row.answers, 12);
    for (const key of ['falseCutInRate', 'discardRate']) assert(row[key] >= 0 && Number.isFinite(row[key]), key);
    assert(row.samples > 0 && row.p50Ms > 0 && row.p95Ms >= row.p50Ms, `${row.speculateMs}/${row.commitMs}`);
    assert.equal(row.falseCutInRate, row.cutIns / row.answers);
  }
  const eligible = sweep.rows.filter(row => row.falseCutInRate <= 0.02 && row.p95Ms <= 2500);
  if (eligible.length) {
    const lowest = Math.min(...eligible.map(row => row.p95Ms));
    assert.equal(sweep.best.qualified, true);
    assert.equal(sweep.best.row.p95Ms, lowest);
    assert(eligible.includes(sweep.best.row));
  } else {
    assert.equal(sweep.best.qualified, false);
    assert.equal(sweep.best.row.falseCutInRate, Math.min(...sweep.rows.map(row => row.falseCutInRate)));
  }
  const text = formatSweep(sweep);
  assert.equal(text.split('\n').filter(line => /^\d{3}\s+\d{3,4}\s/.test(line)).length, 9);
  assert(text.includes(sweep.best.qualified ? 'Best pair:' : 'No pair meets the rule'));
});

test('sweep reads the AMI fixture; cut-in rate rises as listenAccuracy falls (same seeds and thresholds)', async () => {
  const onDisk = JSON.parse(readFileSync(new URL('../fixtures/ami-within-turn-pauses.json', import.meta.url), 'utf8'));
  assert.deepEqual(AMI_PAUSES.pausesMs, onDisk.pausesMs, 'the scenario module loaded the fixture file');
  const real = new Set(onDisk.pausesMs);
  const scenario = getScenario('pause-heavy-answers');
  const seeds = [1, 2, 3, 4, 5];
  let drawn = 0;
  for (const seed of seeds) {
    for (const action of scenario.actions(seed).filter(item => item.type === 'say')) {
      assert(action.pausesMs.length >= 2 && action.pausesMs.length <= 5, `seed ${seed}: 2-5 pauses per answer`);
      for (const ms of action.pausesMs) { assert(real.has(ms), `seed ${seed}: ${ms} ms is in pausesMs`); drawn += 1; }
    }
  }
  assert(drawn >= 2 * 6 * seeds.length);
  const sweep = await runSweep({ seeds, speculateMs: [400], commitMs: [1200], voiceGateMs: [0], listenAccuracy: [1.0, 0.8] });
  assert.equal(sweep.pauseSource.file, 'scripts/fixtures/ami-within-turn-pauses.json');
  assert(sweep.pauseSource.line.includes(onDisk.source), 'the harness output names the pause source');
  assert(formatSweep(sweep).includes(onDisk.source));
  assert.equal(sweep.rows.length, 2);
  const [perfect, noisy] = sweep.rows;
  assert.deepEqual([perfect.listenAccuracy, noisy.listenAccuracy], [1.0, 0.8]);
  assert.equal(perfect.answers, noisy.answers);
  assert(noisy.cutInRate >= perfect.cutInRate, `cut-in ${noisy.cutInRate} at 0.8 vs ${perfect.cutInRate} at 1.0`);
  assert(noisy.cutInRate > 0, 'some cut-ins at listenAccuracy 0.8');
  assert(noisy.cutIns > 0 && noisy.talkOverMsMean >= 0 && noisy.wastedVoiceCharsPerAnswer >= perfect.wastedVoiceCharsPerAnswer);
  const run = await runScenario(scenario, { seed: 1, listenAccuracy: 0.8, thresholds: { speculateMs: 400, commitMs: 1200 } });
  assert(run.pauseWindows.every(window => real.has(Math.round(window.end - window.start))), 'run pauses are AMI members');
});

test('the fake helper freezes playback while paused and continues from the paused position on resume', async () => {
  const clock = createVirtualClock();
  const helperEvents = [];
  const world = {
    clock, commands: [], helperLog: [], playbackStarts: [], plays: 0, utterancesEnded: 0,
    engine: { helperEvent: event => helperEvents.push(event) }, latency: { cancelLagMs: () => 5 }, touch() {},
  };
  const helper = createFakeHelper(world);
  helper.audio.play('utt1', 24000);
  helper.audio.pushAudio('utt1', Buffer.alloc(24000 * 2 * 2)); // two seconds of 16-bit mono audio
  await clock.advanceTo(700);
  const playing = world.helperLog.filter(item => item.state === 'position').at(-1).positionMs;
  assert(playing > 400 && playing < 700, `playing at ${playing} ms`);
  helper.audio.pause('utt1');
  await clock.advanceTo(1600);
  const paused = world.helperLog.filter(item => item.state === 'paused');
  assert.equal(paused.length, 1, 'one paused event');
  assert(paused[0].positionMs >= playing, 'the paused event reports the position it reached');
  assert.equal(world.helperLog.filter(item => item.at > 700 && item.state === 'position').length, 0, 'no position events while paused');
  helper.audio.resume('utt1');
  const resumed = world.helperLog.filter(item => item.state === 'resumed');
  assert.equal(resumed.length, 1, 'one resumed event');
  assert.equal(resumed[0].positionMs, paused[0].positionMs, 'resume reports the frozen position');
  await clock.advanceTo(2000);
  const after = world.helperLog.filter(item => item.at > 1600 && item.state === 'position').at(-1);
  assert.equal(after.positionMs - paused[0].positionMs, 400, 'playback continues from where it stopped');
  assert.deepEqual(world.commands.map(command => command.type), ['play', 'pushAudio', 'pause', 'resume']);
  assert.deepEqual(helperEvents.filter(event => event.type === 'playback' && event.state === 'paused').length, 1);
  assert.deepEqual(helperEvents.filter(event => event.type === 'playback' && event.state === 'resumed').length, 1);
});

test('ear on: floorBid pauses an interrupt overlap at a word boundary, then the cancel follows', () => eachEarSeed('interrupt-overlap-ear', async (scenario, seed, label) => {
  const result = await runScenario(scenario, { seed, ear: { smartTurnAccuracy: DEFAULT_SMART_TURN_ACCURACY } });
  assert.equal(result.earOn, true, `${label}: the ear was installed`);
  assert.equal(cmds(result, 'pause').length, 1, `${label}: one pause command`);
  assert.equal(cmds(result, 'resume').length, 0, `${label}: the paused reply is never resumed`);
  const paused = result.helperLog.filter(item => item.state === 'paused');
  assert.equal(paused.length, 1, `${label}: one paused playback event`);
  const voice = result.voice.find(item => item.utteranceId === paused[0].utteranceId);
  assert(voice.words.some(word => Math.abs(word.endMs - paused[0].positionMs) < 1), `${label}: paused on a word boundary`);
  assertInterruption(result, label);
  const cancel = cmds(result, 'cancel')[0];
  assert(cancel.at > paused[0].at, `${label}: the cancel comes after the pause`);
  assert.equal(result.earAnswers.filter(answer => answer.probability === 0.2 || answer.probability === 0.8).length, result.earAnswers.length);
}));

test('ear on: an acknowledgement overlap neither pauses nor stops the reply', () => eachEarSeed('ack-overlap-ear', async (scenario, seed, label) => {
  const result = await runScenario(scenario, { seed, ear: { smartTurnAccuracy: DEFAULT_SMART_TURN_ACCURACY } });
  assert.equal(result.earOn, true, `${label}: the ear was installed`);
  assert.equal(cmds(result, 'pause').length, 0, `${label}: no pause`);
  assert.equal(cmds(result, 'resume').length, 0, `${label}: no resume`);
  assert.equal(result.helperLog.filter(item => item.state === 'paused').length, 0, `${label}: playback never paused`);
  assert.equal(cmds(result, 'cancel').length, 0, `${label}: nothing cancelled`);
  assert.equal(cmds(result, 'play').length, 3, `${label}: greeting and two replies played`);
  assert(lastMain(result).includes('[Candidate acknowledgements while you spoke: "right"]'), `${label}: ack listed`);
  assert(result.transcript.some(entry => entry.text === 'right' && entry.acknowledgement === true), `${label}: ack labelled`);
}));

test('smart turn hold keeps a reply out of a within-answer pause that the ear-off schedule cuts into', async () => {
  const scenario = getScenario('smart-turn-hold-pause');
  const thresholds = { speculateMs: 600, commitMs: 1200, voiceGateMs: 0, holdSpeculateMs: 6000, holdCommitMs: 7000 };
  const off = [];
  const on = [];
  for (const seed of SEEDS) {
    off.push(await runScenario(scenario, { seed, thresholds, listenAccuracy: 0 }));
    on.push(await runScenario(scenario, { seed, thresholds, listenAccuracy: 0, ear: { smartTurnAccuracy: 1 } }));
  }
  assert(off.some(result => result.cutIns > 0), 'without the ear a reply starts inside the within-answer pause');
  assert(on.every(result => result.cutIns === 0), 'with the ear the hold keeps every reply out of the pause');
  assert(on.every(result => result.earAnswers.some(answer => answer.held === true)), 'the ear held a within-answer pause');
  assert(on.every(result => result.earAnswers.every(answer => answer.probability === 0.2 || answer.probability === 0.8)), 'only 0.2/0.8 verdicts');
  assert(on.every(result => result.smartTurnAccuracy === 1), 'the run recorded the ear accuracy it was given');
  assert(on.every(result => result.pauseWindows.length === 1), 'each run had one within-answer pause');
});

test('runSweep with ear [false, true] reports ear-off and ear-on rows', async () => {
  const sweep = await runSweep({
    seeds: 1, scenario: getScenario('pause-heavy-answers'), speculateMs: [600], commitMs: [1200], voiceGateMs: [0],
    listenAccuracy: [1.0], ear: [false, true],
  });
  assert.equal(sweep.rows.length, 2);
  assert.deepEqual(sweep.rows.map(row => row.ear), [false, true]);
  assert(sweep.rows.every(row => row.answers > 0));
  assert.deepEqual(sweep.summary.map(group => group.ear), [false, true]);
  assert.deepEqual(sweep.summary.map(group => group.listenAccuracy), [1.0, 1.0]);
  const text = formatSweep(sweep);
  assert(text.includes('(ear off)') && text.includes('(ear on)'), 'the summary names both ear settings');
  assert.equal(text.split('\n').filter(line => /^\d{3}\s+\d{3,4}\s/.test(line)).length, 2, 'one table row per setting');
});

test('runSweep keeps the ear off when no ear option is given', async () => {
  const sweep = await runSweep({ seeds: 1, speculateMs: [600], commitMs: [1200], voiceGateMs: [0], listenAccuracy: [1.0] });
  assert.equal(sweep.rows.length, 1);
  assert.equal(sweep.rows[0].ear, false);
});

export default suite;
