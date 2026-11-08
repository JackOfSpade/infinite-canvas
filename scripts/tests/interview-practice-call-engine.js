import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPracticeCallEngine, DEFAULT_CALL_THRESHOLDS } from '../../electron/interviewPracticeCallEngine.js';
import { createReplyStreamParser } from '../../electron/interviewPracticeCallPrompt.js';

// Synthetic data only: every name, sentence and word below is invented for the tests.

export function fakeClock() {
  let time = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) { seq += 1; timers.set(seq, { fn, due: time + Math.max(0, ms), seq }); return seq; },
    clearTimeout(handle) { timers.delete(handle); },
    pending: () => timers.size,
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, item]) => item.due <= target)
          .sort((a, b) => a[1].due - b[1].due || a[1].seq - b[1].seq)[0];
        if (!next) break;
        timers.delete(next[0]);
        time = Math.max(time, next[1].due);
        next[1].fn();
        await flush();
      }
      time = target;
      await flush();
    },
  };
}

export async function flush() { for (let step = 0; step < 25; step += 1) await Promise.resolve(); }

const cancelError = () => Object.assign(new Error('CANCELLED'), { name: 'AbortError', code: 'CANCELLED' });

function fakeSession(kind) {
  const session = { kind, calls: [], closed: false };
  session.close = () => { session.closed = true; };
  session.turn = (message, { signal, onDelta } = {}) => new Promise((resolve, reject) => {
    const call = { message, signal, onDelta, resolve, reject, settled: false };
    session.calls.push(call);
    signal?.addEventListener('abort', () => { if (!call.settled) { call.settled = true; reject(cancelError()); } });
  });
  session.answer = (text, { chunks = [text], index = session.calls.length - 1 } = {}) => {
    const call = session.calls[index];
    for (const chunk of chunks) call.onDelta?.(chunk);
    const parser = createReplyStreamParser();
    const sentences = [...chunks.flatMap(chunk => parser.push(chunk).sentences)];
    const last = parser.end();
    sentences.push(...last.sentences);
    call.settled = true;
    call.resolve({ text, control: last.control, endCall: last.endCall, sentences });
  };
  session.fail = (index = session.calls.length - 1) => { const call = session.calls[index]; call.settled = true; call.reject(new Error('boom')); };
  return session;
}

export const HELPER_OFFSET = 5000;

export function makeRig({ thresholds, restartFails = false, ear = null } = {}) {
  const clock = fakeClock();
  const events = [];
  const ops = [];
  const sessions = { opener: fakeSession('opener'), main: fakeSession('main'), classifier: fakeSession('classifier') };
  const streams = [];
  const restarts = [];
  const audio = {
    play: (id, rate) => ops.push({ op: 'play', id, rate }),
    pushAudio: (id, buffer) => ops.push({ op: 'push', id, size: buffer.length }),
    endUtterance: id => ops.push({ op: 'end', id }),
    cancel: id => ops.push({ op: 'cancel', id }),
    pause: id => ops.push({ op: 'pause', id }),
    resume: id => ops.push({ op: 'resume', id }),
    mute: muted => ops.push({ op: 'mute', muted }),
  };
  const voice = {
    open({ utteranceId, signal }) {
      if (rig.failOpen) throw new Error('voice unavailable');
      const stream = { utteranceId, signal, texts: [], finished: false, cancelled: false, sampleRate: 24000 };
      stream.sendText = text => stream.texts.push(text);
      stream.finish = () => { stream.finished = true; return Promise.resolve(); };
      stream.cancel = () => { stream.cancelled = true; };
      stream.onAudio = callback => { stream.audioCb = callback; };
      stream.onWords = callback => { stream.wordsCb = callback; };
      stream.audio = size => stream.audioCb(Buffer.alloc(size));
      stream.words = list => stream.wordsCb(list);
      streams.push(stream);
      return stream;
    },
  };
  let counter = 0;
  const restartSession = async (kind, info) => {
    restarts.push({ kind, ...info });
    if (rig.gate) await rig.gate.promise; // a test can hold a restart in flight
    if (restartFails) throw new Error('no restart');
    const fresh = fakeSession(kind);
    sessions[kind] = fresh;
    return fresh;
  };
  const engine = createPracticeCallEngine({
    clock, sessions: { ...sessions }, restartSession, audio, voice, ear, thresholds: { speculateMs: 600, ...thresholds }, // the rig pins the 600 ms speculation point its timings assume; defaults are tested separately
    onEvent: event => events.push(event), newId: () => `utt${++counter}`,
  });
  // The helper's clock is not the engine clock: helper atMs = clock ms - HELPER_OFFSET. Callers pass clock times.
  const helper = {
    vad: speaking => engine.helperEvent({ type: 'vad', speaking, atMs: clock.now() - HELPER_OFFSET }),
    transcript: (text, segmentId, startMs = clock.now(), final = false, endMs = clock.now()) =>
      engine.helperEvent({ type: 'transcript', text, segmentId, final, startMs: startMs - HELPER_OFFSET, endMs: endMs - HELPER_OFFSET }),
    playback: (utteranceId, state, positionMs = 0) =>
      engine.helperEvent({ type: 'playback', utteranceId, state, positionMs, atMs: clock.now() - HELPER_OFFSET }),
    level: () => engine.helperEvent({ type: 'level', rms: 0.1, atMs: clock.now() - HELPER_OFFSET }),
  };
  const rig = { clock, events, ops, sessions, streams, restarts, engine, h: helper, live: sessions, failOpen: false, gate: null };
  rig.hold = () => {
    let release;
    rig.gate = { promise: new Promise(resolve => { release = resolve; }) };
    return () => { rig.gate = null; release(); };
  };
  rig.of = type => events.filter(event => event.type === type);
  rig.opsOf = op => ops.filter(item => item.op === op);
  return rig;
}

/** Answer the greeting and play it to the end; leaves the engine listening. */
export async function greet(rig, text = 'Hello, welcome to the call.') {
  rig.engine.start({ greeting: true });
  await flush();
  rig.h.level();
  rig.sessions.main.answer(text);
  rig.streams[0].audio(3200);
  await flush();
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
}

/** The candidate says `text`, then goes quiet. */
export async function speak(rig, text, segmentId) {
  rig.h.vad(true);
  rig.h.transcript(text, segmentId, rig.clock.now(), false, rig.clock.now() + 300);
  await rig.clock.advance(300);
  rig.h.vad(false);
}

const words = (...list) => list.map((word, index) => ({ word, startMs: index * 300, endMs: index * 300 + 280 }));

/** Candidate speaks and the turn is speculated (t = 600 ms after the last word). */
async function speculate(rig, text = 'I built a scheduler', segmentId = 'a') {
  await speak(rig, text, segmentId);
  await rig.clock.advance(600);
}

const suite = [];
const test = (name, run) => suite.push({ name: `interview practice engine: ${name}`, run });

test('exports the default thresholds and does no direct timing or I/O', () => {
  assert.deepEqual({ ...DEFAULT_CALL_THRESHOLDS }, {
    speculateMs: 500, commitMs: 1200, interruptWords: 2, interruptMs: 700, silencePromptMs: 10000, classifierTimeoutMs: 2500,
    voiceGateMs: 1200,
    smartTurnHoldBelow: 0.5, smartTurnTimeoutMs: 300, holdSpeculateMs: 1500, holdCommitMs: 2500,
    floorBidAfterMs: 250, resumeDelayMs: 250, maxResumePauseMs: 1200, maxPausedMs: 2500, voiceNoteTimeoutMs: 150,
  });
  assert(Object.isFrozen(DEFAULT_CALL_THRESHOLDS));
  const source = fs.readFileSync(new URL('../../electron/interviewPracticeCallEngine.js', import.meta.url), 'utf8');
  assert(!/Date\.now|performance\.now|console\./.test(source));
  assert(!/(^|[^.\w])setTimeout\(/.test(source), 'only clock.setTimeout may be used');
  assert(!/from 'node:/.test(source) && !/require\(/.test(source));
});

test('start sends only the connect message to main and speaks its reply without an opener', async () => {
  const rig = makeRig();
  assert.equal(rig.engine.state().phase, 'connecting');
  rig.engine.start({ greeting: true });
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1);
  assert.equal(rig.sessions.main.calls[0].message, '[elapsed 00:00] [call connected]');
  assert.equal(rig.sessions.opener.calls.length, 0);
  rig.sessions.main.answer('Hello, welcome.');
  rig.streams[0].audio(640);
  await flush();
  assert.deepEqual(rig.ops.map(item => item.op), ['play', 'push', 'end']);
  assert.equal(rig.engine.state().phase, 'committed');
  rig.h.playback('utt1', 'started');
  assert.equal(rig.engine.state().phase, 'playing');
  assert.deepEqual(rig.engine.state().transcript, [{ speaker: 'interviewer', text: 'Hello, welcome.' }]);
});

test('speculation runs opener and main in parallel and only plays at the commit threshold', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation: this test is about commit timing
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(599);
  assert.equal(rig.sessions.opener.calls.length, 0, 'nothing is sent before speculateMs');
  await rig.clock.advance(1);
  assert.equal(rig.sessions.opener.calls.length, 1);
  assert.equal(rig.sessions.main.calls.length, 2);
  assert.equal(rig.sessions.opener.calls[0].message, "[elapsed 00:00] [You last said: 'Hello, welcome to the call.'] Candidate: 'I built a scheduler'");
  assert.equal(rig.sessions.main.calls[1].message, "[elapsed 00:00] [A short spoken reaction is already playing before your reply.] Candidate: 'I built a scheduler'");
  assert.equal(rig.streams.length, 2, 'one voice stream per reply');
  assert.equal(rig.engine.state().phase, 'speculating');
  rig.sessions.opener.answer('Right, got it.');
  await flush();
  assert.deepEqual(rig.streams[1].texts, ['Right, got it.']);
  rig.sessions.main.answer('Tell me about the design. What was hard?', { chunks: ['Tell me about ', 'the design. What was hard?'] });
  rig.streams[1].audio(1000);
  await flush();
  assert.deepEqual(rig.streams[1].texts, ['Right, got it.', 'Tell me about the design.', 'What was hard?']);
  assert(rig.streams[1].finished);
  await rig.clock.advance(599);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0, 'audio is buffered until commit');
  assert.equal(rig.engine.state().phase, 'speculating');
  await rig.clock.advance(1);
  const after = rig.ops.filter(item => item.id === 'utt2').map(item => item.op);
  assert.deepEqual(after, ['play', 'push', 'end']);
  assert.equal(rig.opsOf('play').pop().rate, 24000);
  assert.equal(rig.engine.state().phase, 'committed');
});

test('candidate speech before speculation only cancels the timers', async () => {
  const rig = makeRig();
  await greet(rig);
  await speak(rig, 'well', 'a');
  await rig.clock.advance(300);
  rig.h.vad(true);
  await flush();
  assert.equal(rig.sessions.opener.calls.length, 0);
  assert.equal(rig.clock.pending(), 0, 'speculation, commit and silence timers are all cleared');
});

test('candidate speech after speculation aborts both sessions and the voice and the next turn carries the note', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  const opener = rig.sessions.opener.calls[0];
  const main = rig.sessions.main.calls[1];
  rig.streams[1].audio(500);
  rig.h.vad(true);
  await flush();
  assert(opener.signal.aborted && main.signal.aborted);
  assert(rig.streams[1].cancelled && rig.streams[1].signal.aborted);
  assert.equal(rig.engine.state().phase, 'listening');
  await rig.clock.advance(5000);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0, 'buffered audio is dropped');
  rig.h.transcript('and I tested it', 'b', rig.clock.now());
  await rig.clock.advance(200);
  rig.h.vad(false);
  await rig.clock.advance(600);
  const expectedText = "Candidate: 'I built a scheduler and I tested it'";
  const openerMessage = rig.sessions.opener.calls[1].message;
  const mainMessage = rig.sessions.main.calls[2].message;
  assert.match(openerMessage, /^\[elapsed \d\d:\d\d\] \[Your previous reply was not spoken: the candidate was still talking\.\] \[You last said: 'Hello, welcome to the call\.'\] Candidate: 'I built a scheduler and I tested it'$/);
  assert.match(mainMessage, /^\[elapsed \d\d:\d\d\] \[Your previous reply was not spoken: the candidate was still talking\.\] \[A short spoken reaction is already playing before your reply\.\] Candidate: 'I built a scheduler and I tested it'$/);
  assert(openerMessage.endsWith(expectedText));
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer'], 'a discarded turn leaves no transcript entry');
});

test('listen from the opener discards the reply with no playback and no not-spoken note', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  assert(rig.sessions.main.calls[1].signal.aborted);
  assert(rig.streams[1].cancelled);
  assert.equal(rig.engine.state().phase, 'listening');
  await rig.clock.advance(1300);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert.equal(rig.sessions.opener.calls.length, 1, 'the commit timer must not start a second speculation');
  rig.h.vad(true);
  rig.h.transcript('so the rest was', 'b', rig.clock.now());
  await rig.clock.advance(200);
  rig.h.vad(false);
  await rig.clock.advance(600);
  const message = rig.sessions.opener.calls[1].message;
  assert(!message.includes('not spoken'));
  assert(message.endsWith("Candidate: 'I built a scheduler so the rest was'"));
});

test('listen from main with an opener reaction speaks only the reaction; with nothing spoken it discards', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation
  await greet(rig);
  await speculate(rig);
  rig.sessions.main.answer('<listen/>');
  await flush();
  assert.equal(rig.engine.state().phase, 'speculating', 'waits for the opener before deciding');
  rig.sessions.opener.answer('Mm, okay.');
  rig.streams[1].audio(400);
  await flush();
  assert.deepEqual(rig.streams[1].texts, ['Mm, okay.']);
  assert(rig.streams[1].finished);
  await rig.clock.advance(600);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1);

  const quiet = makeRig();
  await greet(quiet);
  await speculate(quiet);
  quiet.sessions.main.answer('<listen/>');
  quiet.sessions.opener.answer('<listen/>');
  await flush();
  assert.equal(quiet.engine.state().phase, 'listening');
  assert.equal(quiet.opsOf('play').filter(item => item.id === 'utt2').length, 0);
});

const REPLY_WORDS = words('Right,', 'got', 'it.', 'Tell', 'me', 'about', 'the', 'design.', 'What', 'was', 'hard?');

/** A reply (utt2) is playing: three sentences, words 300 ms apart (word i ends at i*300+280). */
async function toPlaying(rig, { opener = 'Right, got it.', main = 'Tell me about the design. What was hard?' } = {}) {
  await speculate(rig);
  rig.sessions.opener.answer(opener);
  await flush();
  rig.sessions.main.answer(main);
  rig.streams[1].words(REPLY_WORDS);
  rig.streams[1].audio(1000);
  await rig.clock.advance(600);
  rig.h.playback('utt2', 'started');
  await flush();
  return rig.streams[1];
}

/** The candidate talks over the reply for `text` and stops after 200 ms. */
async function shortOverlap(rig, text = 'right', segmentId = 'o1') {
  rig.h.vad(true);
  rig.h.transcript(text, segmentId, rig.clock.now());
  await rig.clock.advance(200);
  rig.h.vad(false);
  await flush();
}

const cancelsOf = (rig, id) => rig.opsOf('cancel').filter(item => item.id === id).length;

test('a candidate answer that starts talking over the reply with more words than allowed stops it at once and notes what was heard', async () => {
  const rig = makeRig();
  await greet(rig);
  const stream = await toPlaying(rig);
  assert.equal(rig.engine.state().phase, 'playing');
  rig.h.playback('utt2', 'position', 650);
  rig.h.vad(true);
  rig.h.transcript('wait what do', 'o1', rig.clock.now());
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert(stream.cancelled && rig.sessions.main.calls[1].signal.aborted);
  assert.equal(rig.engine.state().phase, 'listening');
  rig.h.playback('utt2', 'cancelled', 900);
  await flush();
  assert.deepEqual(rig.of('interrupted'), [{ type: 'interrupted', heardText: 'Right, got it.' }]);
  const interviewer = rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').pop();
  assert.deepEqual(interviewer, { speaker: 'interviewer', text: 'Right, got it.', interrupted: true, heardText: 'Right, got it.' });
  rig.h.transcript('wait what do you mean', 'o1', rig.clock.now());
  await rig.clock.advance(100);
  rig.h.vad(false);
  await rig.clock.advance(600);
  const message = rig.sessions.opener.calls[1].message;
  assert.match(message, /\[You were interrupted after saying: 'Right, got it\.'\. The rest was not heard\.\] Candidate: 'wait what do you mean'$/);
  assert(!message.includes('I built a scheduler'), 'the earlier answer is not repeated');
});

test('speech talking over the reply for longer than the limit stops it once a transcript word was counted', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.vad(true);
  rig.h.transcript('um', 'o1', rig.clock.now()); // F9: the duration rule needs at least one counted word
  await rig.clock.advance(700);
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'exactly the limit is not more than the limit');
  await rig.clock.advance(1);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert.equal(rig.sessions.classifier.calls.length, 0);
  assert.equal(rig.engine.state().phase, 'listening');
});

test('a short overlap goes to the classifier and an acknowledgement verdict keeps playing and rides on the next turn', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  await shortOverlap(rig, 'right');
  assert.equal(rig.sessions.classifier.calls.length, 1);
  const asked = rig.sessions.classifier.calls[0].message;
  assert(asked.includes("Interviewer sentence being spoken: 'Right, got it.'"));
  assert(asked.includes("Candidate's words: 'right'"));
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'nothing stops while the classifier thinks');
  rig.sessions.classifier.answer('Acknowledgement');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.engine.state().phase, 'playing');
  assert.deepEqual(rig.of('acknowledgement'), [{ type: 'acknowledgement', text: 'right' }]);
  assert(rig.engine.state().transcript.some(entry => entry.acknowledgement === true && entry.text === 'right'));
  await rig.clock.advance(500);
  rig.h.playback('utt2', 'finished', 3000);
  await flush();
  await speak(rig, 'okay next topic', 'c');
  await rig.clock.advance(600);
  assert.match(rig.sessions.opener.calls[1].message, /\[Candidate acknowledgements while you spoke: "right"\] Candidate: 'okay next topic'$/);
  assert.match(rig.sessions.main.calls[2].message, /\[Candidate acknowledgements while you spoke: "right"\] Candidate: 'okay next topic'$/);
});

test('an interruption verdict stops at the next word boundary, and past the last word stops now', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  await shortOverlap(rig, 'right');
  rig.h.playback('utt2', 'position', 100); // F11: the live position is estimated from the last position event
  rig.sessions.classifier.answer('interruption.');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'the word in progress ends at 280 ms');
  await rig.clock.advance(179);
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  await rig.clock.advance(1);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  rig.h.playback('utt2', 'cancelled', 280);
  await flush();
  assert.equal(rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').pop().heardText, 'Right,');
  await rig.clock.advance(700);
  assert.match(rig.sessions.opener.calls[1].message, /\[You were interrupted after saying: 'Right,'\. The rest was not heard\.\] Candidate: 'right'$/);

  const late = makeRig();
  await greet(late);
  await toPlaying(late);
  late.h.playback('utt2', 'position', 5000);
  await shortOverlap(late, 'right');
  late.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(late, 'utt2'), 1, 'already past every word: cancel now');
});

test('classifier timeout means acknowledgement and a late verdict is ignored', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  await shortOverlap(rig, 'right');
  const call = rig.sessions.classifier.calls[0];
  await rig.clock.advance(2499);
  assert.equal(rig.of('acknowledgement').length, 0);
  await rig.clock.advance(1);
  assert.equal(rig.of('acknowledgement').length, 1);
  assert(call.signal.aborted);
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.engine.state().phase, 'playing');
  call.resolve({ text: 'interruption' });
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.of('acknowledgement').length, 1);
});

test('an overlap with no transcript words is ignored', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.vad(true);
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(3000);
  assert.equal(rig.sessions.classifier.calls.length, 0);
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.engine.state().phase, 'playing');
});

test('race: the classifier answers interruption after playback already finished, so it is an ordinary turn', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  await shortOverlap(rig, 'sorry?');
  await rig.clock.advance(100);
  rig.h.playback('utt2', 'finished', 3000);
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  rig.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'nothing left to stop');
  await rig.clock.advance(600);
  assert.equal(rig.sessions.opener.calls.length, 2);
  assert(rig.sessions.opener.calls[1].message.endsWith("Candidate: 'sorry?'"));
});

test('race: playback finishing while the candidate is still talking turns the overlap into a normal turn', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.vad(true);
  rig.h.transcript('hold on', 'o1', rig.clock.now());
  await rig.clock.advance(100);
  rig.h.playback('utt2', 'finished', 3000);
  await flush();
  await rig.clock.advance(100);
  rig.h.vad(false);
  await rig.clock.advance(600);
  assert(rig.sessions.opener.calls[1].message.endsWith("Candidate: 'hold on'"));
  assert.equal(rig.sessions.classifier.calls.length, 0);
});

test('silence prompt fires after the limit, restarts after each interviewer utterance, and typing pauses it', async () => {
  const rig = makeRig();
  await greet(rig);
  await rig.clock.advance(9999);
  assert.equal(rig.sessions.main.calls.length, 1);
  await rig.clock.advance(1);
  assert.equal(rig.sessions.opener.calls[0].message, "[elapsed 00:10] [You last said: 'Hello, welcome to the call.'] [candidate silent 10s]");
  assert.equal(rig.sessions.main.calls[1].message, '[elapsed 00:10] [A short spoken reaction is already playing before your reply.] [candidate silent 10s]');
  rig.sessions.opener.answer('Mm.');
  rig.sessions.main.answer('Still with me?');
  rig.streams[1].audio(500);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'a silence turn commits without waiting');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 800);
  await rig.clock.advance(9999);
  assert.equal(rig.sessions.main.calls.length, 2);
  await rig.clock.advance(1);
  assert.equal(rig.sessions.main.calls.length, 3, 'the timer restarts after each interviewer utterance');

  const quiet = makeRig();
  await greet(quiet);
  quiet.engine.typing(true);
  await quiet.clock.advance(60000);
  assert.equal(quiet.sessions.main.calls.length, 1, 'typing pauses the silence prompt');
  quiet.engine.typing(false);
  await quiet.clock.advance(9999);
  assert.equal(quiet.sessions.main.calls.length, 1);
  await quiet.clock.advance(1);
  assert.equal(quiet.sessions.main.calls.length, 2);
});

test('candidate speech cancels the silence prompt', async () => {
  const rig = makeRig();
  await greet(rig);
  await rig.clock.advance(9000);
  rig.h.vad(true);
  await rig.clock.advance(5000);
  assert.equal(rig.sessions.main.calls.length, 1);
});

test('typing while a turn is pending is reported in that message', async () => {
  const rig = makeRig();
  await greet(rig);
  await speak(rig, 'let me write that down', 'a');
  rig.engine.typing(true);
  await rig.clock.advance(600);
  assert.equal(rig.sessions.main.calls[1].message,
    "[elapsed 00:00] [A short spoken reaction is already playing before your reply.] [candidate is typing in chat] Candidate: 'let me write that down'");
});

test('a typed turn while listening is sent at once and committed as soon as audio is ready', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('Here is my code');
  await flush();
  assert.equal(rig.sessions.main.calls[1].message,
    "[elapsed 00:00] [A short spoken reaction is already playing before your reply.] Candidate (typed in chat): 'Here is my code'");
  assert.equal(rig.sessions.opener.calls[0].message,
    "[elapsed 00:00] [You last said: 'Hello, welcome to the call.'] Candidate (typed in chat): 'Here is my code'");
  rig.sessions.opener.answer('Okay.');
  rig.sessions.main.answer('Walk me through it.');
  rig.streams[1].audio(300);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'no speculation delay');
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker + (entry.channel ? `:${entry.channel}` : '')),
    ['interviewer', 'candidate:chat', 'interviewer']);
  assert.equal(rig.engine.state().transcript[1].text, 'Here is my code');
});

test('typing more than the word limit over the reply interrupts with the heard-text note', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 650);
  rig.engine.typed('wait what is that');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert.equal(rig.sessions.opener.calls.length, 1, 'the typed turn waits for the cancelled event');
  rig.h.playback('utt2', 'cancelled', 900);
  await flush();
  assert.match(rig.sessions.opener.calls[1].message,
    /\[You were interrupted after saying: 'Right, got it\.'\. The rest was not heard\.\] Candidate \(typed in chat\): 'wait what is that'$/);
});

test('a short typed message over the reply goes to the classifier', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.engine.typed('ok sure');
  await flush();
  assert(rig.sessions.classifier.calls[0].message.includes("Candidate's words: 'ok sure'"));
  rig.sessions.classifier.answer('acknowledgement');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert(rig.engine.state().transcript.some(entry => entry.acknowledgement && entry.channel === 'chat' && entry.text === 'ok sure'));

  const second = makeRig();
  await greet(second);
  await toPlaying(second);
  second.engine.typed('ok sure');
  await flush();
  second.sessions.classifier.answer('Interruption');
  await flush();
  assert.equal(cancelsOf(second, 'utt2'), 0, 'stops at the next word boundary, not before');
  await second.clock.advance(280);
  assert.equal(cancelsOf(second, 'utt2'), 1);
  second.h.playback('utt2', 'cancelled', 280);
  await flush();
  assert(second.sessions.opener.calls[1].message.endsWith("Candidate (typed in chat): 'ok sure'"));
});

test('chat blocks are parsed out of the spoken stream, posted at commit and recorded, never sent to the voice', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Sure.');
  await flush();
  rig.sessions.main.answer('x', { chunks: ['Here is the problem. <ch', 'at>Write a function ', 'that adds two numbers.</ch', 'at> Take a look.'] });
  rig.streams[1].audio(400);
  await flush();
  assert.deepEqual(rig.streams[1].texts, ['Sure.', 'Here is the problem.', 'Take a look.']);
  assert.equal(rig.of('chat').length, 0, 'nothing is posted before the reply commits');
  await rig.clock.advance(600);
  assert.deepEqual(rig.of('chat'), [{ type: 'chat', from: 'interviewer', text: 'Write a function that adds two numbers.' }]);
  assert(rig.engine.state().transcript.some(entry => entry.speaker === 'interviewer' && entry.channel === 'chat'
    && entry.text === 'Write a function that adds two numbers.'));

  const dropped = makeRig();
  await greet(dropped);
  await speculate(dropped);
  dropped.sessions.opener.answer('Sure.');
  dropped.sessions.main.answer('x', { chunks: ['Look. <chat>Hidden text.</chat> Go.'] });
  await flush();
  dropped.h.vad(true);
  await dropped.clock.advance(3000);
  assert.equal(dropped.of('chat').length, 0, 'a discarded reply drops its chat posts');
});

test('chat transcript entries carry helper-timeline timing for replay and chapters', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Sure.');
  await flush();
  rig.sessions.main.answer('x', { chunks: ['Look. <chat>Open the file.</chat> Go.'] });
  rig.streams[1].audio(400);
  await flush();
  await rig.clock.advance(600); // the reply commits and the chat is delivered now
  const chatClock = rig.clock.now();
  const posted = rig.engine.state().transcript.find(entry => entry.speaker === 'interviewer' && entry.channel === 'chat');
  assert(posted, 'the interviewer chat entry reached the transcript');
  assert.equal(posted.text, 'Open the file.');
  assert(Number.isFinite(posted.startMs) && Number.isFinite(posted.endMs), `chat entry carries timing: ${JSON.stringify(posted)}`);
  assert.equal(posted.startMs, posted.endMs);
  assert.equal(posted.startMs, chatClock - HELPER_OFFSET, 'helper ms = clock ms - offset');

  const typedRig = makeRig();
  await greet(typedRig);
  const typedClock = typedRig.clock.now();
  typedRig.engine.typed('Here is my code');
  await flush();
  typedRig.sessions.opener.answer('Okay.');
  typedRig.sessions.main.answer('Walk me through it.');
  typedRig.streams[1].audio(300);
  await flush();
  const typed = typedRig.engine.state().transcript.find(entry => entry.speaker === 'candidate' && entry.channel === 'chat');
  assert(typed, 'the typed entry reached the transcript');
  assert.equal(typed.text, 'Here is my code');
  assert(Number.isFinite(typed.startMs) && Number.isFinite(typed.endMs), `typed entry carries timing: ${JSON.stringify(typed)}`);
  assert.equal(typed.startMs, typed.endMs);
  assert.equal(typed.startMs, typedClock - HELPER_OFFSET, 'helper ms = clock ms - offset');

  // With no helper event yet the offset is unknown, so the elapsed call time stands in.
  // Nothing on this rig reports a helper time, so the engine never learns the offset.
  const fresh = makeRig();
  fresh.engine.start();
  await flush();
  await fresh.clock.advance(450); // no helper event has arrived, so the offset is still unknown
  const elapsedClock = fresh.clock.now();
  fresh.engine.typed('I am a developer');
  await flush();
  fresh.sessions.opener.answer('Sure.');
  fresh.sessions.main.answer('Go on.');
  fresh.streams.at(-1).audio(300);
  await flush();
  const fallback = fresh.engine.state().transcript.find(entry => entry.speaker === 'candidate' && entry.channel === 'chat');
  assert(fallback, 'the typed entry reached the transcript with no offset known');
  assert.equal(fallback.text, 'I am a developer');
  assert(Number.isFinite(fallback.startMs) && Number.isFinite(fallback.endMs), `fallback entry carries timing: ${JSON.stringify(fallback)}`);
  assert.equal(fallback.startMs, elapsedClock, 'no offset yet: elapsed call ms');
  assert.equal(fallback.endMs, fallback.startMs);
});

test('end-call ends the call only after the final reply has finished playing', async () => {
  const rig = makeRig();
  await greet(rig);
  const stream = await toPlaying(rig, { main: 'Thanks for your time. Goodbye.<end-call/>' });
  assert.deepEqual(stream.texts, ['Right, got it.', 'Thanks for your time.', 'Goodbye.']);
  assert.equal(rig.engine.state().phase, 'playing');
  assert.equal(rig.of('ended').length, 0);
  rig.h.playback('utt2', 'finished', 3000);
  await flush();
  assert.equal(rig.engine.state().phase, 'ended');
  assert.deepEqual(rig.of('ended'), [{ type: 'ended', reason: 'interviewer' }]);
  assert.equal(rig.clock.pending(), 0, 'all timers cleared');
  rig.engine.typed('anything');
  rig.h.vad(true);
  await flush();
  assert.equal(rig.sessions.opener.calls.length, 1, 'later input is ignored');
});

test('hangUp ends at once from playing, speculating and listening', async () => {
  const playing = makeRig();
  await greet(playing);
  await toPlaying(playing);
  playing.engine.hangUp();
  assert.equal(cancelsOf(playing, 'utt2'), 1);
  assert(playing.sessions.main.calls[1].signal.aborted && playing.streams[1].cancelled);
  assert.deepEqual(playing.of('ended'), [{ type: 'ended', reason: 'candidate' }]);
  assert.equal(playing.clock.pending(), 0);

  const speculating = makeRig();
  await greet(speculating);
  await speculate(speculating);
  speculating.engine.hangUp();
  assert(speculating.sessions.opener.calls[0].signal.aborted && speculating.streams[1].cancelled);
  assert.equal(speculating.engine.state().phase, 'ended');
  assert.equal(speculating.clock.pending(), 0);
  speculating.engine.hangUp();
  assert.equal(speculating.of('ended').length, 1, 'ending twice reports once');

  const listening = makeRig();
  await greet(listening);
  listening.engine.hangUp();
  assert.equal(listening.engine.state().phase, 'ended');
  assert.equal(listening.clock.pending(), 0);
});

test('a helper error ends the call with the audio-error reason and the code', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.helperEvent({ type: 'error', code: 'capture-failed' });
  assert.deepEqual(rig.of('ended'), [{ type: 'ended', reason: 'audio-error', code: 'capture-failed' }]);
  assert.equal(rig.clock.pending(), 0);
});

test('a session failure during speculation restarts from the transcript, re-sends once and recovers', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  const message = rig.sessions.main.calls[1].message;
  rig.sessions.main.fail();
  await flush();
  assert.deepEqual(rig.restarts, [{ kind: 'main', transcriptText: "Interviewer: 'Hello, welcome to the call.'" }]);
  assert.deepEqual(rig.of('session-restart'), [{ type: 'session-restart', kind: 'main' }]);
  assert.equal(rig.sessions.main.calls.length, 1);
  assert.equal(rig.sessions.main.calls[0].message, message, 'the same turn is re-sent');
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Why that design?');
  rig.streams[1].audio(300);
  await rig.clock.advance(600);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1);
  assert.equal(rig.of('ended').length, 0);
  assert.deepEqual(rig.streams[1].texts, ['Right.', 'Why that design?']);
});

test('a second failure in the same turn ends the call with a session error', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.main.fail();
  await flush();
  rig.sessions.main.fail();
  await flush();
  assert.deepEqual(rig.of('ended'), [{ type: 'ended', reason: 'session-error' }]);
  assert.equal(rig.clock.pending(), 0);

  const noRestart = makeRig({ restartFails: true });
  await greet(noRestart);
  await speculate(noRestart);
  noRestart.sessions.main.fail();
  await flush();
  assert.equal(noRestart.of('ended')[0].reason, 'session-error');
});

test('a cancel is not a failure, and a stale failure after the candidate resumed is dropped', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.main.fail();
  rig.h.vad(true);
  await flush();
  assert.equal(rig.restarts.length, 0);
  assert.equal(rig.of('ended').length, 0);
  assert.equal(rig.engine.state().phase, 'listening');
  rig.streams[1].audio(300);
  await flush();
  assert.equal(rig.ops.filter(item => item.id === 'utt2').length, 0, 'stale voice audio is dropped');
});

test('an opener failure is retried once and then the reply is main only; a faster main skips the opener', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  const message = rig.sessions.opener.calls[0].message;
  rig.sessions.opener.fail();
  await flush();
  assert.equal(rig.restarts[0].kind, 'opener');
  assert.equal(rig.sessions.opener.calls[0].message, message);
  rig.sessions.opener.fail();
  await flush();
  rig.sessions.main.answer('Tell me more. Why?');
  rig.streams[1].audio(300);
  await rig.clock.advance(600);
  assert.deepEqual(rig.streams[1].texts, ['Tell me more.', 'Why?']);
  assert.equal(rig.of('ended').length, 0);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1);

  const fast = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation
  await greet(fast);
  await speculate(fast);
  fast.sessions.main.answer('Here is a question. Next?');
  await flush();
  assert(fast.sessions.opener.calls[0].signal.aborted, 'main was ready first, so the opener is skipped');
  assert.deepEqual(fast.streams[1].texts, ['Here is a question.', 'Next?']);
});

test('timing events carry the helper-timeline measurements including last word to first sound', async () => {
  const rig = makeRig();
  await greet(rig);
  const greeting = rig.of('timing')[0];
  assert.equal(greeting.lastWordAt, null);
  assert.equal(greeting.lastWordToFirstSoundMs, null);
  await speak(rig, 'I built a scheduler', 'a');
  const last = rig.clock.now();
  await rig.clock.advance(600);
  await rig.clock.advance(100);
  rig.sessions.opener.answer('Right, got it.');
  await rig.clock.advance(150);
  rig.sessions.main.answer('Why this design?');
  rig.streams[1].audio(800);
  await rig.clock.advance(350);
  await rig.clock.advance(50);
  rig.h.playback('utt2', 'started');
  const timing = rig.of('timing')[1];
  assert.deepEqual(timing, {
    type: 'timing', lastWordAt: last, speculatedAt: last + 600, openerFirstDeltaMs: 100, mainFirstSentenceMs: 250,
    firstAudioAt: last + 850, playbackStartedAt: last + 1250, lastWordToFirstSoundMs: 1250,
    voiceCharsSent: 'Right, got it.'.length + 'Why this design?'.length,
  });
  assert.equal(rig.engine.state().elapsedMs, rig.clock.now());
});

test('race: resuming one millisecond before commit discards the reply; resuming at commit is an overlap', async () => {
  const before = makeRig();
  await greet(before);
  await speculate(before);
  before.sessions.opener.answer('Right.');
  before.sessions.main.answer('Why?');
  before.streams[1].audio(300);
  await before.clock.advance(599);
  before.h.vad(true);
  await before.clock.advance(5);
  assert.equal(before.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert(before.sessions.main.calls[1].signal.aborted);

  const at = makeRig();
  await greet(at);
  await speculate(at);
  at.sessions.opener.answer('Right.');
  at.sessions.main.answer('Why?');
  at.streams[1].audio(300);
  await at.clock.advance(600);
  assert.equal(at.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'the commit timer fired first');
  at.h.vad(true);
  at.h.transcript('um', 'o1', at.clock.now());
  await flush();
  assert(!at.sessions.main.calls[1].signal.aborted, 'speech at commit is an overlap, not a discard');
  assert.equal(cancelsOf(at, 'utt2'), 0);
  await at.clock.advance(701);
  assert.equal(cancelsOf(at, 'utt2'), 1, 'the overlap then stops it by duration');
});

const typedMessage = text => `Candidate (typed in chat): '${text}'`;

test('F12/G1: delayed helper delivery only adds to the offset, and a stray transcript never latches it', async () => {
  const delayed = makeRig();
  await greet(delayed);
  delayed.h.vad(true);
  delayed.h.transcript('I built a scheduler', 'a', 0, false, 0);
  await delayed.clock.advance(300);
  // The vad end was really at clock 100 but arrives 200 ms late: the engine must not trust the older offset.
  delayed.engine.helperEvent({ type: 'vad', speaking: false, atMs: delayed.clock.now() - 200 - HELPER_OFFSET });
  await delayed.clock.advance(599);
  assert.equal(delayed.sessions.opener.calls.length, 0, 'speculation waits a full speculateMs after the latest-offset end');
  await delayed.clock.advance(1);
  assert.equal(delayed.sessions.opener.calls.length, 1);

  const stray = makeRig();
  stray.engine.start({ greeting: true });
  await flush();
  stray.engine.helperEvent({ type: 'transcript', text: 'stray', segmentId: 's0', final: true, startMs: -6000, endMs: -2000 });
  stray.h.level();
  stray.sessions.main.answer('Hello there.');
  stray.streams[0].audio(3200);
  await flush();
  stray.h.playback('utt1', 'started');
  stray.h.playback('utt1', 'finished', 1500);
  await flush();
  await speak(stray, 'I built a scheduler', 'a');
  await stray.clock.advance(599);
  assert.equal(stray.sessions.opener.calls.length, 0, 'the offset comes from the level event, not the transcript end');
  await stray.clock.advance(1);
  assert.equal(stray.sessions.opener.calls.length, 1);
});

test('F1: a typed message before the earlier typed reply commits is merged, in order, into one typed turn', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('first message here');
  await flush();
  rig.engine.typed('second one');
  await flush();
  assert.equal(rig.sessions.opener.calls.length, 2);
  assert(rig.sessions.opener.calls[0].signal.aborted, 'the first typed reply was discarded');
  assert.match(rig.sessions.opener.calls[1].message,
    /^\[elapsed \d\d:\d\d\] \[Your previous reply was not spoken: the candidate was still talking\.\] \[You last said: 'Hello, welcome to the call\.'\] Candidate \(typed in chat\): 'first message here\nsecond one'$/);
  assert.equal(rig.sessions.main.calls[2].message.split('Candidate (typed in chat): ')[1], "'first message here\nsecond one'");
  rig.sessions.opener.answer('Okay.');
  rig.sessions.main.answer('Walk me through it.');
  rig.streams[2].audio(300);
  await flush();
  assert.deepEqual(rig.engine.state().transcript.map(entry => `${entry.speaker}:${entry.channel ?? '-'}:${entry.text}`), [
    'interviewer:-:Hello, welcome to the call.', 'candidate:chat:first message here', 'candidate:chat:second one',
    'interviewer:-:Walk me through it.',
  ]);
  rig.h.playback('utt3', 'started');
  rig.h.playback('utt3', 'finished', 900);
  await flush();
  rig.engine.typed('after the reply');
  await flush();
  assert(rig.sessions.opener.calls[2].message.endsWith(typedMessage('after the reply')), 'pending typed texts were cleared at commit');
});

test('F5: typed while a cancel is pending queues into ONE typed turn and never starts a parallel reply', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 650);
  rig.engine.typed('wait what is that');
  rig.engine.typed('and one more thing');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert.equal(rig.streams.length, 2, 'no parallel reply while the cancel is pending');
  assert.equal(rig.sessions.opener.calls.length, 1);
  rig.h.playback('utt2', 'cancelled', 900);
  await flush();
  assert.equal(rig.streams.length, 3, 'exactly one typed reply started');
  assert.equal(rig.sessions.opener.calls.length, 2);
  assert(rig.sessions.opener.calls[1].message.endsWith(typedMessage('wait what is that\nand one more thing')));
  assert.equal(rig.sessions.main.calls.length, 3);
});

test('F6: a typed reply that commits while the candidate is speaking starts an overlap at commit', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.h.vad(true);
  rig.engine.typed('Here is my code');
  await flush();
  rig.sessions.opener.answer('Okay.');
  rig.sessions.main.answer('Walk me through it.');
  rig.streams[1].audio(300);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'typed replies commit at once');
  rig.h.transcript('um', 'o1', rig.clock.now());
  await rig.clock.advance(700);
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  await rig.clock.advance(1);
  assert.equal(cancelsOf(rig, 'utt2'), 1, 'the overlap that began at commit stops it by duration');
  assert.equal(rig.engine.state().phase, 'listening');
});

test('F7: more words at commit than at speculation discard the reply and re-speculate at once', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Why?');
  rig.streams[1].audio(300);
  await flush();
  rig.h.transcript('I built a scheduler and tested it', 'a', 0, true, 300);
  await rig.clock.advance(600);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0, 'the stale reply is not played');
  assert(rig.sessions.main.calls[1].signal.aborted);
  assert.equal(rig.sessions.opener.calls.length, 2);
  assert.match(rig.sessions.opener.calls[1].message, /\[Your previous reply was not spoken: the candidate was still talking\.\].*Candidate: 'I built a scheduler and tested it'$/);
  rig.sessions.opener.answer('Good.');
  rig.sessions.main.answer('What next?');
  rig.streams[2].audio(300);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt3').length, 1, 'no new speculation delay');
  rig.h.playback('utt3', 'started');
  assert.equal(rig.of('timing').pop().respeculated, 1);
  assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => entry.text),
    ['I built a scheduler and tested it']);
});

test('F3/G3: main failing after forwarded sentences and a chat finishes truncated, no re-send, and the next turn carries a cut-off note', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.calls[1].onDelta('Here is the problem. <chat>Write a sum.</chat> Next sen');
  rig.streams[1].audio(300);
  rig.sessions.main.fail();
  await flush();
  assert.deepEqual(rig.restarts.map(item => item.kind), ['main']);
  assert.equal(rig.sessions.main.calls.length, 0, 'the turn is not re-sent on the fresh session');
  assert.deepEqual(rig.streams[1].texts, ['Right.', 'Here is the problem.']);
  assert.equal(rig.of('ended').length, 0);
  await rig.clock.advance(600);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'the spoken part plays');
  assert.deepEqual(rig.of('chat'), [{ type: 'chat', from: 'interviewer', text: 'Write a sum.' }], 'the chat is posted once');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 900);
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  await speak(rig, 'okay then', 'b');
  await rig.clock.advance(600);
  assert.equal(rig.sessions.main.calls.length, 1, 'the next turn uses the restarted session');
  assert(rig.sessions.main.calls[0].message.startsWith(
    "[Your previous reply was cut off by a connection problem after: 'Here is the problem.'.] [elapsed "));
  rig.sessions.main.answer('Fine.');
  rig.streams[2].audio(300);
  await rig.clock.advance(600);
  rig.h.playback('utt3', 'started');
  rig.h.playback('utt3', 'finished', 900);
  await flush();
  await speak(rig, 'one more', 'c');
  await rig.clock.advance(600);
  assert(rig.sessions.main.calls[1].message.startsWith('[elapsed '), 'the note rides on one message only');
});

test('F3: chats are de-duplicated per reply by exact text', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Sure.');
  rig.sessions.main.answer('x', { chunks: ['Look. <chat>Same text.</chat> <chat>Same text.</chat> <chat>Other.</chat>'] });
  rig.streams[1].audio(300);
  await rig.clock.advance(600);
  assert.deepEqual(rig.of('chat').map(event => event.text), ['Same text.', 'Other.']);
});

test('F4/G2: a voice stream that finishes without audio means the reply was not spoken', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation: finish() is not deferred
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Goodbye.<end-call/>');
  await flush();
  assert.deepEqual(rig.of('error'), [{ type: 'error', code: 'voice-failed' }]);
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.of('ended').length, 0, 'end-call is not honoured for an unspoken reply');
  await rig.clock.advance(2000);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer'], 'no interviewer entry for it');
  await speak(rig, 'hello again', 'b');
  await rig.clock.advance(600);
  assert.match(rig.sessions.opener.calls[1].message, /\[Your previous reply was not spoken: the candidate was still talking\.\]/);
  await rig.clock.advance(20000);
  assert.equal(rig.sessions.main.calls.length >= 3, true, 'silence is armed again');

  const failing = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(failing);
  await speculate(failing);
  failing.streams[1].finish = () => Promise.reject(new Error('voice dropped'));
  failing.sessions.opener.answer('Right.');
  failing.sessions.main.answer('Why?');
  await flush();
  assert.deepEqual(failing.of('error'), [{ type: 'error', code: 'voice-failed' }]);
  assert.equal(failing.engine.state().phase, 'listening');
  assert.equal(failing.opsOf('play').filter(item => item.id === 'utt2').length, 0);

  const chatOnly = makeRig();
  await greet(chatOnly);
  await speculate(chatOnly);
  chatOnly.sessions.opener.answer('');
  chatOnly.sessions.main.answer('<chat>Just a note.</chat>');
  await flush();
  await chatOnly.clock.advance(600);
  assert.equal(chatOnly.of('error').length, 0, 'a reply with no spoken parts keeps the silent path');
  assert.deepEqual(chatOnly.of('chat').map(event => event.text), ['Just a note.']);
});

test('G2: voice.open throwing reports an error, returns to listening and keeps the call alive', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.failOpen = true;
  await speculate(rig);
  assert.deepEqual(rig.of('error'), [{ type: 'error', code: 'voice-open-failed' }]);
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.sessions.opener.calls.length, 0);
  await rig.clock.advance(10000);
  assert.equal(rig.of('error').length >= 1, true);
  assert.equal(rig.of('ended').length, 0);
});

test('F2: a restart that finishes after the reply was discarded is still adopted; one that finishes after the call ended is closed', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  const release = rig.hold();
  const original = rig.sessions.main;
  rig.sessions.main.fail();
  await flush();
  rig.h.vad(true);
  await flush();
  release();
  await flush();
  assert.notEqual(rig.sessions.main, original);
  rig.h.transcript('and more', 'b', rig.clock.now());
  await rig.clock.advance(200);
  rig.h.vad(false);
  await rig.clock.advance(600);
  assert.equal(rig.sessions.main.calls.length, 1, 'the next turn goes to the adopted session');
  assert.equal(original.calls.length, 2, 'the failed session is not used again');

  const ended = makeRig();
  await greet(ended);
  await speculate(ended);
  const free = ended.hold();
  ended.sessions.main.fail();
  await flush();
  ended.engine.hangUp();
  free();
  await flush();
  assert.equal(ended.sessions.main.closed, true, 'a session created during an ended call is closed');
  assert.equal(ended.of('ended').length, 1);
});

test('F10: typed() clears the typing state so the message and the silence prompt are not suppressed', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typing(true);
  rig.engine.typed('hello there friend');
  await flush();
  assert.equal(rig.sessions.main.calls[1].message,
    `[elapsed 00:00] [A short spoken reaction is already playing before your reply.] ${typedMessage('hello there friend')}`);
  rig.sessions.main.answer('Go on.');
  rig.streams[1].audio(300);
  await flush();
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 600);
  await rig.clock.advance(10000);
  assert.equal(rig.sessions.main.calls.length, 3, 'the silence prompt is armed again');
});

test('F11: the word boundary is computed from the live playback position, capped at the utterance length', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  await shortOverlap(rig, 'right'); // 200 ms pass: the live position is about 300, inside the second word
  rig.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  await rig.clock.advance(279);
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'the second word ends at 580, so 280 ms from the live position');
  await rig.clock.advance(1);
  assert.equal(cancelsOf(rig, 'utt2'), 1);

  const capped = makeRig();
  await greet(capped);
  await toPlaying(capped);
  capped.h.playback('utt2', 'position', 3270);
  await shortOverlap(capped, 'right');
  capped.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(capped, 'utt2'), 1, 'past the utterance length the stop is immediate');
});

test('F8: overlap words may start up to 250 ms before the VAD onset, and a late transcript is awaited for 600 ms', async () => {
  const early = makeRig();
  await greet(early);
  await toPlaying(early);
  early.h.vad(true);
  early.h.transcript('wait what do', 'o1', early.clock.now() - 200);
  await flush();
  assert.equal(cancelsOf(early, 'utt2'), 1, 'words that began just before the VAD onset count');

  const late = makeRig();
  await greet(late);
  await toPlaying(late);
  const t0 = late.clock.now();
  late.h.vad(true);
  await late.clock.advance(200);
  late.h.vad(false);
  await late.clock.advance(300);
  assert.equal(late.sessions.classifier.calls.length, 0);
  late.h.transcript('right', 'o1', t0);
  await flush();
  assert.equal(late.sessions.classifier.calls.length, 1, 'a segment within the wait applies the normal rules');

  const tooLate = makeRig();
  await greet(tooLate);
  await toPlaying(tooLate);
  const t1 = tooLate.clock.now();
  tooLate.h.vad(true);
  await tooLate.clock.advance(200);
  tooLate.h.vad(false);
  await tooLate.clock.advance(601);
  tooLate.h.transcript('right', 'o1', t1);
  await flush();
  assert.equal(tooLate.sessions.classifier.calls.length, 0, 'after 600 ms the overlap is ignored');
  assert.equal(cancelsOf(tooLate, 'utt2'), 0);

  const many = makeRig();
  await greet(many);
  await toPlaying(many);
  const t2 = many.clock.now();
  many.h.vad(true);
  await many.clock.advance(200);
  many.h.vad(false);
  await many.clock.advance(300);
  many.h.transcript('hold on please', 'o1', t2);
  await flush();
  assert.equal(cancelsOf(many, 'utt2'), 1, 'more than the word limit stops at once');
  assert.equal(many.sessions.classifier.calls.length, 0);
});

test('F9: the duration rule waits for a transcript word; echo residue with no words never stops playback', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.vad(true);
  await rig.clock.advance(701);
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'duration alone, with no words, does not stop');
  rig.h.transcript('um', 'o1', rig.clock.now());
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1, 'the first word stops it while the overlap is still speaking');

  const ending = makeRig();
  await greet(ending);
  await toPlaying(ending);
  const t0 = ending.clock.now();
  ending.h.vad(true);
  await ending.clock.advance(800);
  ending.h.vad(false);
  await ending.clock.advance(100);
  assert.equal(cancelsOf(ending, 'utt2'), 0);
  ending.h.transcript('um', 'o1', t0);
  await flush();
  assert.equal(cancelsOf(ending, 'utt2'), 1, 'a word found at the overlap end after a long overlap stops it');

  const echo = makeRig();
  await greet(echo);
  await toPlaying(echo);
  echo.h.vad(true);
  await echo.clock.advance(800);
  echo.h.vad(false);
  await echo.clock.advance(3000);
  assert.equal(cancelsOf(echo, 'utt2'), 0);
  assert.equal(echo.sessions.classifier.calls.length, 0);
  assert.equal(echo.engine.state().phase, 'playing');
});

test('F13: a playback that never starts, or never finishes, is reported and finished as heard-up-to-position', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Why?');
  rig.streams[1].audio(300);
  await flush();
  await rig.clock.advance(600);
  assert.equal(rig.engine.state().phase, 'committed');
  await rig.clock.advance(2999);
  assert.equal(rig.of('error').length, 0);
  await rig.clock.advance(1);
  assert.deepEqual(rig.of('error'), [{ type: 'error', code: 'playback-stalled' }]);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert.equal(rig.engine.state().phase, 'listening');
  assert.deepEqual(rig.of('interrupted'), [{ type: 'interrupted', heardText: '' }]);
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer', 'candidate']);

  const unfinished = makeRig();
  await greet(unfinished);
  await toPlaying(unfinished);
  unfinished.h.playback('utt2', 'position', 650);
  await unfinished.clock.advance(5629);
  assert.equal(unfinished.of('error').length, 0, 'remaining audio (2630 ms) plus 3000 ms');
  await unfinished.clock.advance(1);
  assert.deepEqual(unfinished.of('error'), [{ type: 'error', code: 'playback-stalled' }]);
  assert.equal(cancelsOf(unfinished, 'utt2'), 1);
  assert.equal(unfinished.engine.state().phase, 'listening');
  assert.deepEqual(unfinished.engine.state().transcript.pop(),
    { speaker: 'interviewer', text: 'Right, got', interrupted: true, heardText: 'Right, got' });
});

test('F14: the opener restarts at most once, an empty heard text leaves no entry, and finished while cancelling is fully heard', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.fail();
  await flush();
  rig.sessions.opener.fail();
  await flush();
  assert.equal(rig.restarts.filter(item => item.kind === 'opener').length, 1, 'one restart at most');

  const empty = makeRig();
  await greet(empty);
  await toPlaying(empty);
  empty.h.vad(true);
  empty.h.transcript('wait what do', 'o1', empty.clock.now());
  await flush();
  empty.h.playback('utt2', 'cancelled', 0);
  await flush();
  assert.deepEqual(empty.of('interrupted'), [{ type: 'interrupted', heardText: '' }]);
  assert.deepEqual(empty.engine.state().transcript.map(entry => entry.text), ['Hello, welcome to the call.', 'I built a scheduler']);
  empty.h.transcript('wait what do you mean', 'o1', empty.clock.now());
  await empty.clock.advance(100);
  empty.h.vad(false);
  await empty.clock.advance(600);
  assert(empty.sessions.opener.calls[1].message.includes("[You last said: 'Hello, welcome to the call.']"));

  const whole = makeRig();
  await greet(whole);
  await toPlaying(whole);
  whole.h.playback('utt2', 'position', 650);
  whole.h.vad(true);
  whole.h.transcript('wait what do', 'o1', whole.clock.now());
  await flush();
  assert.equal(cancelsOf(whole, 'utt2'), 1);
  whole.h.playback('utt2', 'finished', 3300);
  await flush();
  assert.equal(whole.of('interrupted').length, 0, 'it was not interrupted');
  const spoken = 'Right, got it. Tell me about the design. What was hard?';
  assert.deepEqual(whole.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').pop(),
    { speaker: 'interviewer', text: spoken });
  whole.h.transcript('wait what do you mean', 'o1', whole.clock.now());
  await whole.clock.advance(100);
  whole.h.vad(false);
  await whole.clock.advance(600);
  assert.match(whole.sessions.opener.calls[1].message,
    /^\[elapsed \d\d:\d\d\] \[You last said: 'Right, got it\. Tell me about the design\. What was hard\?'\] Candidate: 'wait what do you mean'$/);
});

test('G5: the cancel fallback timer resolves a stop when the helper never reports cancelled', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 650);
  rig.engine.typed('wait what is that');
  await flush();
  await rig.clock.advance(499);
  assert.equal(rig.of('interrupted').length, 0);
  assert.equal(rig.sessions.opener.calls.length, 1);
  await rig.clock.advance(1);
  assert.deepEqual(rig.of('interrupted'), [{ type: 'interrupted', heardText: 'Right, got' }]);
  assert.equal(rig.sessions.opener.calls.length, 2);
  assert(rig.sessions.opener.calls[1].message.endsWith(typedMessage('wait what is that')));
});

test('G5: a helper-initiated cancelled trims the reply to what was heard and the next turn carries the note', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 650);
  rig.h.playback('utt2', 'cancelled', 650);
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'the engine did not ask for it');
  assert.deepEqual(rig.of('interrupted'), [{ type: 'interrupted', heardText: 'Right, got' }]);
  assert.equal(rig.engine.state().phase, 'listening');
  assert.deepEqual(rig.engine.state().transcript.pop(),
    { speaker: 'interviewer', text: 'Right, got', interrupted: true, heardText: 'Right, got' });
  await speak(rig, 'sorry what', 's1');
  await rig.clock.advance(600);
  assert.match(rig.sessions.opener.calls[1].message,
    /\[You were interrupted after saying: 'Right, got'\. The rest was not heard\.\] Candidate: 'sorry what'$/);
});

test('G5: hangUp from committed-not-started, cancelling, classifier in flight and restart in flight', async () => {
  const committed = makeRig();
  await greet(committed);
  await speculate(committed);
  committed.sessions.opener.answer('Right.');
  committed.sessions.main.answer('Why?');
  committed.streams[1].audio(300);
  await committed.clock.advance(600);
  assert.equal(committed.engine.state().phase, 'committed');
  committed.engine.hangUp();
  assert.equal(cancelsOf(committed, 'utt2'), 1);
  assert.deepEqual(committed.of('ended'), [{ type: 'ended', reason: 'candidate' }]);
  assert.equal(committed.clock.pending(), 0);

  const stopping = makeRig();
  await greet(stopping);
  await toPlaying(stopping);
  stopping.engine.typed('wait what is that');
  await flush();
  stopping.engine.hangUp();
  stopping.h.playback('utt2', 'cancelled', 650);
  await stopping.clock.advance(5000);
  assert.equal(stopping.of('ended').length, 1);
  assert.equal(stopping.sessions.opener.calls.length, 1, 'the queued typed turn never starts');
  assert.equal(stopping.clock.pending(), 0);

  const asking = makeRig();
  await greet(asking);
  await toPlaying(asking);
  await shortOverlap(asking, 'right');
  const call = asking.sessions.classifier.calls[0];
  assert(!call.signal.aborted);
  asking.engine.hangUp();
  assert(call.signal.aborted, 'the classifier request is aborted');
  assert.equal(asking.clock.pending(), 0);
  call.resolve({ text: 'interruption' });
  await flush();
  assert.equal(cancelsOf(asking, 'utt2'), 1, 'only the hang-up cancelled it');

  const restarting = makeRig();
  await greet(restarting);
  await speculate(restarting);
  const release = restarting.hold();
  restarting.sessions.main.fail();
  await flush();
  restarting.engine.hangUp();
  release();
  await flush();
  assert.equal(restarting.of('ended').length, 1);
  assert.equal(restarting.clock.pending(), 0);
});

test('G5: a helper error while speculating or playing ends the call and stops everything', async () => {
  const speculating = makeRig();
  await greet(speculating);
  await speculate(speculating);
  speculating.engine.helperEvent({ type: 'error', code: 'device-lost' });
  assert.deepEqual(speculating.of('ended'), [{ type: 'ended', reason: 'audio-error', code: 'device-lost' }]);
  assert(speculating.sessions.opener.calls[0].signal.aborted && speculating.streams[1].cancelled);
  assert.equal(speculating.clock.pending(), 0);

  const playing = makeRig();
  await greet(playing);
  await toPlaying(playing);
  playing.engine.helperEvent({ type: 'error', code: 'device-lost' });
  assert.equal(cancelsOf(playing, 'utt2'), 1);
  assert.equal(playing.of('ended')[0].reason, 'audio-error');
  assert.equal(playing.clock.pending(), 0);
});

test('G6: the silence prompt re-arms after a blip, after an acknowledgement and after listen to a silence prompt', async () => {
  const blip = makeRig();
  await greet(blip);
  blip.h.vad(true);
  await blip.clock.advance(100);
  blip.h.vad(false);
  await blip.clock.advance(1200 + 9999);
  assert.equal(blip.sessions.main.calls.length, 1);
  await blip.clock.advance(1);
  assert.equal(blip.sessions.main.calls.length, 2, 'a vad blip with no words still ends in a silence prompt');

  const acked = makeRig();
  await greet(acked);
  await toPlaying(acked);
  await shortOverlap(acked, 'right');
  acked.sessions.classifier.answer('acknowledgement');
  await flush();
  acked.h.playback('utt2', 'finished', 3300);
  await flush();
  await acked.clock.advance(9999);
  assert.equal(acked.sessions.main.calls.length, 2);
  await acked.clock.advance(1);
  assert.equal(acked.sessions.main.calls.length, 3);

  const listened = makeRig();
  await greet(listened);
  await listened.clock.advance(10000);
  assert.equal(listened.sessions.opener.calls.length, 1);
  listened.sessions.opener.answer('<listen/>');
  await flush();
  assert.equal(listened.engine.state().phase, 'listening');
  await listened.clock.advance(9999);
  assert.equal(listened.sessions.opener.calls.length, 1);
  await listened.clock.advance(1);
  assert.equal(listened.sessions.opener.calls.length, 2, 'listen to a silence prompt arms the next one');
});

test('G6: resuming one millisecond before commit returns to listening and the next message notes it was not spoken', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Why?');
  rig.streams[1].audio(300);
  await rig.clock.advance(599);
  rig.h.vad(true);
  await rig.clock.advance(5);
  assert.equal(rig.engine.state().phase, 'listening');
  rig.h.transcript('and tested it', 'b', rig.clock.now());
  await rig.clock.advance(200);
  rig.h.vad(false);
  await rig.clock.advance(600);
  assert.match(rig.sessions.opener.calls[1].message,
    /^\[elapsed \d\d:\d\d\] \[Your previous reply was not spoken: the candidate was still talking\.\] \[You last said: 'Hello, welcome to the call\.'\] Candidate: 'I built a scheduler and tested it'$/);
});

const lengthOf = list => list.reduce((sum, text) => sum + text.length, 0);

test('voice gate: a spoken turn sends no text before voiceGateMs, then flushes in order and only then finishes', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig); // 600 ms of silence: the voice is opened, nothing is sent
  assert.equal(rig.streams.length, 2, 'voice.open still happens at speculation');
  rig.sessions.opener.answer('Right, got it.');
  await flush();
  rig.sessions.main.answer('Tell me about the design. What was hard?', { chunks: ['Tell me about ', 'the design. What was hard?'] });
  rig.streams[1].audio(1000);
  await flush();
  assert.deepEqual(rig.streams[1].texts, [], 'text is queued, not sent');
  assert.equal(rig.streams[1].finished, false, 'finish waits for the flush');
  await rig.clock.advance(599); // 1199 ms of silence
  assert.deepEqual(rig.streams[1].texts, []);
  assert.equal(rig.streams[1].finished, false);
  await rig.clock.advance(1); // 1200 ms: the gate opens
  const sent = ['Right, got it.', 'Tell me about the design.', 'What was hard?'];
  assert.deepEqual(rig.streams[1].texts, sent, 'flushed in order');
  assert.equal(rig.streams[1].finished, true, 'finish only after the flush');
  rig.h.playback('utt2', 'started');
  assert.equal(rig.of('timing').pop().voiceCharsSent, lengthOf(sent));
});

test('voice gate: text produced after the gate is sent directly, and the gate honours a custom voiceGateMs', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 900 } });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Mm.');
  await flush();
  assert.deepEqual(rig.streams[1].texts, []);
  await rig.clock.advance(299);
  assert.deepEqual(rig.streams[1].texts, []);
  await rig.clock.advance(1);
  assert.deepEqual(rig.streams[1].texts, ['Mm.']);
  rig.sessions.main.answer('Why that design?');
  await flush();
  assert.deepEqual(rig.streams[1].texts, ['Mm.', 'Why that design?'], 'sent at once once the gate is open');
  assert.equal(rig.streams[1].finished, true);
});

test('voice gate: resuming between speculation and the gate sends zero characters and reports a resumed discard', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right, got it.');
  rig.sessions.main.answer('Why that design?');
  rig.streams[1].audio(300);
  await flush();
  await rig.clock.advance(300); // 900 ms of silence, before the gate
  rig.h.vad(true);
  await flush();
  assert.deepEqual(rig.of('discarded'), [{ type: 'discarded', voiceCharsSent: 0, reason: 'resumed' }]);
  await rig.clock.advance(5000);
  assert.deepEqual(rig.streams[1].texts, [], 'the queue died with the reply');
  assert.equal(rig.streams[1].cancelled, true);
  assert.equal(rig.of('discarded').length, 1);
});

test('voice gate: resuming after the gate but before commit reports the characters already sent', async () => {
  const rig = makeRig({ thresholds: { commitMs: 2000 } });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Why?');
  rig.streams[1].audio(300);
  await flush();
  await rig.clock.advance(600); // 1200 ms: the gate opened, commit is still 800 ms away
  assert.deepEqual(rig.streams[1].texts, ['Right.', 'Why?']);
  await rig.clock.advance(300);
  rig.h.vad(true);
  await flush();
  assert.deepEqual(rig.of('discarded'), [{ type: 'discarded', voiceCharsSent: 'Right.'.length + 'Why?'.length, reason: 'resumed' }]);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
});

test('voice gate: a listen verdict before the gate discards with zero characters sent', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('<listen/>');
  await flush();
  assert.deepEqual(rig.of('discarded'), [{ type: 'discarded', voiceCharsSent: 0, reason: 'listen' }]);
  await rig.clock.advance(3000);
  assert.deepEqual(rig.streams[1].texts, []);
  assert.equal(rig.of('discarded').length, 1);
});

test('voice gate: an F7 re-speculation reports a respeculated discard and the new reply sends at once', async () => {
  const rig = makeRig({ thresholds: { commitMs: 2000 } });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Why?');
  rig.streams[1].audio(300);
  await flush();
  await rig.clock.advance(600); // gate open, 'Right.' and 'Why?' sent
  rig.h.transcript('I built a scheduler and tested it', 'a', 0, true, 300);
  await rig.clock.advance(800); // commit finds more words than at speculation
  assert.deepEqual(rig.of('discarded'), [{ type: 'discarded', voiceCharsSent: 'Right.'.length + 'Why?'.length, reason: 'respeculated' }]);
  assert.equal(rig.streams.length, 3);
  rig.sessions.opener.answer('Good.');
  await flush();
  assert.deepEqual(rig.streams[2].texts, ['Good.'], 'the new reply starts with the gate open');
});

test('voice gate: typed, silence and greeting turns send immediately', async () => {
  const greeting = makeRig();
  greeting.engine.start({ greeting: true });
  await flush();
  greeting.sessions.main.answer('Hello, welcome.');
  await flush();
  assert.deepEqual(greeting.streams[0].texts, ['Hello, welcome.']);
  assert.equal(greeting.streams[0].finished, true);

  const typed = makeRig();
  await greet(typed);
  typed.engine.typed('Here is my code');
  await flush();
  typed.sessions.opener.answer('Okay.');
  await flush();
  assert.deepEqual(typed.streams[1].texts, ['Okay.']);
  typed.sessions.main.answer('Walk me through it.');
  await flush();
  assert.deepEqual(typed.streams[1].texts, ['Okay.', 'Walk me through it.']);
  assert.equal(typed.streams[1].finished, true);

  const silent = makeRig();
  await greet(silent);
  await silent.clock.advance(10000);
  silent.sessions.opener.answer('Mm.');
  await flush();
  assert.deepEqual(silent.streams[1].texts, ['Mm.']);
  silent.sessions.main.answer('Still with me?');
  await flush();
  assert.deepEqual(silent.streams[1].texts, ['Mm.', 'Still with me?']);
  assert.equal(silent.of('discarded').length, 0);
});

export default suite;

/** A fake ear: every dependency is optional, every call is recorded, and the answers are per-test. */
function makeEar({ endOfTurn = () => 0.8, floorBid = () => ({ decision: 'continue', reason: 'test' }), voiceNote = () => null } = {}) {
  const calls = { endOfTurn: [], floorBid: [], voiceNote: [] };
  return {
    calls,
    endOfTurn: async atMs => { calls.endOfTurn.push(atMs); return endOfTurn(atMs); },
    floorBid: async args => { calls.floorBid.push(args); return floorBid(args); },
    voiceNote: async args => { calls.voiceNote.push(args); return voiceNote(args); },
  };
}

test('smart turn hold pushes speculation and commit out from the vad end and flags the opener only', async () => {
  const ear = makeEar({ endOfTurn: () => 0.2 });
  const rig = makeRig({ ear });
  await greet(rig);
  await speak(rig, 'I built a scheduler');
  await flush(); // the ear answers in a microtask, well inside smartTurnTimeoutMs
  await rig.clock.advance(300); // 300 ms after the vad end
  await flush();
  assert.deepEqual(rig.of('turn-model').map(event => [event.probability, event.held]), [[0.2, true]]);
  await rig.clock.advance(300); // 600 ms after the vad end: the normal speculation point
  assert.equal(rig.sessions.opener.calls.length, 0, 'held speculation moved to holdSpeculateMs');
  await rig.clock.advance(900); // 1500 ms
  assert.equal(rig.sessions.opener.calls.length, 1);
  const opener = rig.sessions.opener.calls[0].message;
  assert(opener.includes('[audio: sounds unfinished]'), opener);
  assert(opener.indexOf('[audio: sounds unfinished]') < opener.indexOf('Candidate:'), 'the hint follows the elapsed tag');
  assert(!rig.sessions.main.calls[0].message.includes('[audio: sounds unfinished]'), 'the main message gets no audio hint');
  rig.sessions.opener.answer('Okay.');
  await flush(); // the opener sentence reaches the voice before the main's first delta
  rig.sessions.main.answer('Tell me more.');
  rig.streams[1].audio(1000); // the held reply only has audio once its text reaches the voice
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0, 'nothing plays at the held speculation');
  await rig.clock.advance(1000); // 2500 ms
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'commit at holdCommitMs');
});

test('smart turn high probability, timeout, null or error keep the normal timers', async () => {
  const answers = [() => 0.8, () => new Promise(() => {}), () => null, () => { throw new Error('ear down'); }];
  for (const endOfTurn of answers) {
    const rig = makeRig({ ear: makeEar({ endOfTurn }) });
    await greet(rig);
    await speak(rig, 'I built a scheduler');
    await rig.clock.advance(600);
    assert.equal(rig.sessions.opener.calls.length, 1, 'speculation stays at speculateMs');
    assert(!rig.sessions.opener.calls[0].message.includes('[audio: sounds unfinished]'));
    const held = rig.of('turn-model').map(event => event.held);
    assert.deepEqual(held, [false]);
  }
});

test('smart turn answering after speculation already ran leaves the fast path alone', async () => {
  let release;
  const late = new Promise(resolve => { release = resolve; });
  const rig = makeRig({ ear: makeEar({ endOfTurn: () => late }) });
  await greet(rig);
  await speak(rig, 'I wrote the migration');
  await rig.clock.advance(600);
  assert.equal(rig.sessions.opener.calls.length, 1, 'speculation ran on the normal timer');
  release(0.1);
  await flush();
  assert.deepEqual(rig.of('turn-model').map(event => event.held), [false]);
  assert(!rig.sessions.opener.calls[0].message.includes('[audio: sounds unfinished]'));
});

test('smart turn answering after the candidate resumed is ignored', async () => {
  let release;
  const late = new Promise(resolve => { release = resolve; });
  const rig = makeRig({ ear: makeEar({ endOfTurn: () => late }) });
  await greet(rig);
  await speak(rig, 'I built a scheduler');
  rig.h.vad(true); // the candidate resumed before the ear answered
  await flush();
  release(0.1);
  await flush();
  assert.deepEqual(rig.of('turn-model').map(event => event.held), [false]);
  assert(!rig.engine.state().transcript.some(entry => String(entry.text ?? '').includes('[audio:')));
});

test('a voice note from the ear decorates the main message only', async () => {
  const ear = makeEar({ voiceNote: () => 'sounded tired and hesitant' });
  const rig = makeRig({ ear });
  await greet(rig);
  await speculate(rig, 'I built a scheduler');
  await flush();
  assert.equal(ear.calls.voiceNote.length, 1);
  const { startMs, endMs } = ear.calls.voiceNote[0];
  assert(endMs >= startMs);
  const main = rig.sessions.main.calls.at(-1).message;
  assert(main.includes('[voice: sounded tired and hesitant]'), main);
  assert(!rig.sessions.opener.calls[0].message.includes('[voice:'));
  assert(main.indexOf('[voice:') > main.indexOf('[elapsed '), 'the note follows the elapsed tag');
});

test('a voice note that is too slow is dropped and the main still runs', async () => {
  const rig = makeRig({ ear: makeEar({ voiceNote: () => new Promise(() => {}) }) });
  await greet(rig);
  await speak(rig, 'I built a scheduler');
  await rig.clock.advance(600);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1);
  assert(!rig.sessions.main.calls[0].message.includes('[voice:'));
});

/** The candidate talks over the reply and the floor bid answers at floorBidAfterMs while still speaking. */
async function floorBidOverlap(rig, text = 'ok', segmentId = 'o1') {
  rig.h.vad(true);
  rig.h.transcript(text, segmentId, rig.clock.now());
  await rig.clock.advance(250);
  await flush();
  await rig.clock.advance(100); // the boundary pause lands while the overlap is still open
  await flush();
}

test('pause-then-decide: an acknowledgement pauses at the word boundary and resumes after resumeDelayMs', async () => {
  const ear = makeEar({ floorBid: () => ({ decision: 'pause', reason: 'short sound' }) });
  const rig = makeRig({ ear });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  await floorBidOverlap(rig, 'right');
  assert.equal(ear.calls.floorBid.length, 1);
  assert.equal(ear.calls.floorBid[0].wordCount, 1);
  assert(ear.calls.floorBid[0].overlapMs >= 250);
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  await rig.clock.advance(200); // the word in progress ends 180 ms after the bid
  assert.equal(rig.opsOf('pause').filter(item => item.id === 'utt2').length, 1);
  assert.equal(rig.engine.state().phase, 'playing', 'the phase stays playing while paused');
  rig.h.vad(false);
  await flush();
  assert.equal(rig.sessions.classifier.calls.length, 1);
  rig.sessions.classifier.answer('acknowledgement');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.engine.state().transcript.filter(entry => entry.acknowledgement).length, 1);
  await rig.clock.advance(250); // resumeDelayMs
  assert.equal(rig.opsOf('resume').filter(item => item.id === 'utt2').length, 1);
});

test('pause-then-decide: an interruption classifier answer while paused cancels', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 400);
  await floorBidOverlap(rig, 'ok');
  await rig.clock.advance(200);
  assert.equal(rig.opsOf('pause').length, 1);
  rig.h.vad(false);
  await flush();
  rig.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1);
});

test('pause-then-decide: a clear interruption while paused cancels from the paused position', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 400);
  await floorBidOverlap(rig, 'ok');
  await rig.clock.advance(200);
  assert.equal(rig.opsOf('pause').length, 1);
  rig.h.transcript('wait what is this', 'o1', rig.clock.now());
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1);
});

test('pause-then-decide: an acknowledgement after a long pause cancels and tells main where it stopped', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }), thresholds: { maxResumePauseMs: 100, resumeDelayMs: 50 } });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  await floorBidOverlap(rig, 'ok');
  await rig.clock.advance(260); // the boundary pause landed in the advance above: past maxResumePauseMs, still inside interruptMs
  rig.h.vad(false);
  await flush();
  rig.sessions.classifier.answer('acknowledgement');
  await flush();
  rig.h.playback('utt2', 'cancelled', 300);
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  const message = rig.sessions.main.calls.at(-1).message;
  assert(message.includes("[You paused because the candidate made a short sound; it was only an acknowledgement. Continue naturally from where you stopped after: 'ok']"), message);
  assert(!message.includes('Candidate:'), message);
  assert(!message.includes('[audio: sounds unfinished]'));
});

test('pause-then-decide: no decision after maxPausedMs counts as an interruption', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }), thresholds: { maxPausedMs: 100 } });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 400);
  await floorBidOverlap(rig, 'ok');
  await rig.clock.advance(200);
  assert.equal(rig.opsOf('pause').length, 1);
  await rig.clock.advance(150); // past maxPausedMs
  assert.equal(cancelsOf(rig, 'utt2'), 1);
});

test('pause-then-decide: continue keeps playing until the existing duration rule stops the reply', async () => {
  const ear = makeEar({ floorBid: () => ({ decision: 'continue' }) });
  const rig = makeRig({ ear });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  await floorBidOverlap(rig, 'ok');
  assert.equal(ear.calls.floorBid.length, 1);
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'nothing stops at the floor bid');
  assert.equal(rig.opsOf('pause').length, 0);
  await rig.clock.advance(500); // past interruptMs with a word counted
  assert.equal(cancelsOf(rig, 'utt2'), 1);
});

test('pause-then-decide: continue keeps a short acknowledgement playing and stores it', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'continue' }) }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.vad(true);
  rig.h.transcript('right', 'o1', rig.clock.now());
  await rig.clock.advance(250);
  await flush();
  rig.h.vad(false);
  await flush();
  rig.sessions.classifier.answer('acknowledgement');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.opsOf('pause').length, 0);
  assert.equal(rig.engine.state().transcript.filter(entry => entry.acknowledgement).length, 1);
});

test('pause-then-decide: a floor bid answering after the overlap ended still applies', async () => {
  let release;
  const late = new Promise(resolve => { release = resolve; });
  const rig = makeRig({ ear: makeEar({ floorBid: () => late }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.vad(true);
  rig.h.transcript('right', 'o1', rig.clock.now());
  await rig.clock.advance(250);
  rig.h.vad(false); // the overlap ends before the ear answers
  await flush();
  release({ decision: 'continue' });
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
  assert.equal(rig.sessions.classifier.calls.length, 1, 'the ended overlap is classified by the late decision');
});

test('pause-then-decide: a classifier answer after maxPausedMs cannot resume the cancelled reply', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }), thresholds: { maxPausedMs: 100 } });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 400);
  await floorBidOverlap(rig, 'ok');
  await rig.clock.advance(200);
  rig.h.vad(false);
  await flush();
  await rig.clock.advance(150); // maxPausedMs fires first
  rig.h.playback('utt2', 'cancelled', 500);
  await flush();
  rig.sessions.classifier.answer('acknowledgement');
  await flush();
  await rig.clock.advance(300);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert.equal(rig.opsOf('resume').length, 0);
});

test('bracketed audio tags reach the voice but never captions, transcript or heard text', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('[sighs] Right, got it.');
  await flush();
  rig.sessions.main.answer('[laughs] Tell me about the design. What was hard?');
  rig.streams[1].words(REPLY_WORDS);
  rig.streams[1].audio(1000);
  await rig.clock.advance(1200);
  await flush();
  const spoken = rig.streams[1].texts.join(' ');
  assert(spoken.includes('[sighs]') || spoken.includes('[laughs]'), spoken);
  const interviewerCaptions = rig.of('caption').filter(event => event.speaker === 'interviewer').map(event => event.text);
  assert.equal(interviewerCaptions.filter(text => /\[[a-z][a-z -]{0,30}\]/.test(text)).length, 0);
  const stored = rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').map(entry => entry.text);
  assert.equal(stored.filter(text => /\[[a-z][a-z -]{0,30}\]/.test(text)).length, 0);
});
