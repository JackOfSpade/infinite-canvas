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

const bare = entry => { const rest = { ...entry }; delete rest.startMs; delete rest.endMs; return rest; };

export function makeRig({ thresholds, restartFails = false, ear = null, panel, speakerVoice = false, overlayVoice = speakerVoice, gapVoice = true, createParser, formatTurn, prepared } = {}) {
  const clock = fakeClock();
  const events = [];
  const ops = [];
  const sessions = { opener: fakeSession('opener'), main: fakeSession('main'), classifier: fakeSession('classifier') };
  const streams = [];
  const opens = [];
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
    open(options) {
      const { utteranceId, signal } = options;
      opens.push(options);
      if (rig.failOpen) throw new Error('voice unavailable');
      const stream = { utteranceId, signal, texts: [], log: [], finished: false, cancelled: false, sampleRate: 24000 };
      stream.sendText = text => { stream.texts.push(text); stream.log.push({ text }); };
      // Records how many texts had been sent when the engine asked the voice to speak now.
      stream.flushes = [];
      stream.flush = () => { stream.flushes.push(stream.texts.length); return true; };
      if (speakerVoice) {
        // A panel voice stream: setSpeaker and onSpeaker exist, and the log keeps their order against the texts.
        stream.setSpeaker = (id, options) => { stream.log.push(options ? { speaker: id, options } : { speaker: id }); return true; };
        stream.onSpeaker = callback => { stream.speakerCb = callback; };
      }
      if (overlayVoice) {
        // A remark spoken over the current speaker: the request is logged in order with the texts; onOverlay reports its start.
        stream.overlays = [];
        stream.overlay = request => { stream.overlays.push(request); stream.log.push({ overlay: request }); return true; };
        stream.onOverlay = callback => { stream.overlayCb = callback; };
      }
      if (gapVoice) stream.gap = ms => { stream.log.push({ gap: ms }); return true; };
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
    clock, sessions: { ...sessions }, restartSession, audio, voice, ear, thresholds: { speculateMs: 600, ...thresholds }, ...(panel ? { panel } : {}), ...(createParser ? { createParser } : {}), ...(formatTurn ? { formatTurn } : {}), ...(prepared ? { prepared } : {}), // the rig pins the 600 ms speculation point its timings assume; defaults are tested separately
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
  const rig = { clock, events, ops, opens, sessions, streams, restarts, engine, h: helper, live: sessions, failOpen: false, gate: null };
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
    speculateMs: 500, commitMs: 1200, interruptWords: 2, interruptMs: 700, silencePromptMs: 20000, typingExpireMs: 6000, padIdleMs: 12000, padProgressMs: 25000, turnTimeoutMs: 20000, classifierTimeoutMs: 2500,
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
  assert.deepEqual(rig.engine.state().transcript.map(bare), [{ speaker: 'interviewer', text: 'Hello, welcome.' }]);
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
  // The candidate resumed at once: still one thought, so the first words join the next.
  assert(message.endsWith("Candidate: 'I built a scheduler so the rest was'"), message);
});

test('listen from main after a finished line: the opener reaction is not spoken, nothing plays, the line stays unconsumed', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } }); // gate open at speculation
  await greet(rig);
  await speculate(rig);
  rig.sessions.main.answer('<listen/>');
  await flush();
  assert.equal(rig.engine.state().phase, 'speculating', 'waits for the opener before deciding');
  rig.sessions.opener.answer('Mm, okay.');
  rig.streams[1].audio(400);
  await flush();
  assert(rig.streams[1].cancelled, 'the reaction that had not started playing is dropped');
  assert.equal(rig.engine.state().phase, 'listening');
  await rig.clock.advance(600);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer']);

  const quiet = makeRig();
  await greet(quiet);
  await speculate(quiet);
  quiet.sessions.main.answer('<listen/>');
  quiet.sessions.opener.answer('<listen/>');
  await flush();
  assert.equal(quiet.engine.state().phase, 'listening');
  assert.equal(quiet.opsOf('play').filter(item => item.id === 'utt2').length, 0);
});

test('pass to a finished line: kept as its own entry at once, never joined to later speech, even soon after', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'okay', 'a');
  rig.sessions.opener.answer('<pass/>');
  rig.sessions.main.answer('<pass/>');
  await flush();
  assert.deepEqual(rig.engine.state().transcript.map(entry => [entry.speaker, entry.text]), [['interviewer', 'Hello, welcome to the call.'], ['candidate', 'okay']]);
  assert.equal(rig.sessions.main.calls.length, 2);
  assert(rig.sessions.main.calls[1].signal.aborted);
  await rig.clock.advance(1500);
  await speak(rig, 'now the real answer', 'b');
  await rig.clock.advance(600);
  assert(rig.sessions.opener.calls[1].message.endsWith("Candidate: 'now the real answer'"), rig.sessions.opener.calls[1].message);
  assert(!rig.sessions.opener.calls[1].message.includes('okay'));
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Go on.');
  rig.streams.at(-1).audio(1000);
  await flush();
  await rig.clock.advance(700);
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.text), ['Hello, welcome to the call.', 'okay', 'now the real answer', 'Go on.']);
});

test('pass to a finished line: a bare voice blip afterwards does not resend it', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'thanks', 'a');
  rig.sessions.opener.answer('<pass/>');
  rig.sessions.main.answer('<pass/>');
  await flush();
  const calls = rig.sessions.opener.calls.length;
  rig.h.vad(true);
  await rig.clock.advance(150);
  rig.h.vad(false);
  await rig.clock.advance(3000);
  assert.equal(rig.sessions.opener.calls.length, calls, 'no new turn from a blip');
  assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => entry.text), ['thanks']);
});

test('listen to a finished line: nothing is kept; the words join the next speech after 6 s, however long the pause', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'I built a scheduler', 'a');
  rig.sessions.opener.answer('<listen/>');
  await flush();
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer'], 'not in the transcript yet');
  await rig.clock.advance(6000);
  await speak(rig, 'and then I tested it', 'b');
  await rig.clock.advance(600);
  assert(rig.sessions.opener.calls.at(-1).message.endsWith("Candidate: 'I built a scheduler and then I tested it'"), rig.sessions.opener.calls.at(-1).message);
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer'], 'one thought, not two entries');
});

test('pass to a finished line: a typed message right after does not carry the line again', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'okay', 'a');
  rig.sessions.opener.answer('<pass/>');
  rig.sessions.main.answer('<pass/>');
  await flush();
  rig.engine.typed('here is the code');
  await flush();
  const message = rig.sessions.main.calls.at(-1).message;
  assert(!message.includes('okay'), message);
  assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => entry.text), ['okay']);
});

test('opener pass with a real main reply: the reply is spoken, nothing is discarded, the line is kept once', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'Going well, thanks for asking.', 'a');
  rig.sessions.opener.answer('<pass/>');
  await flush();
  assert.equal(rig.of('discarded').length, 0, 'the opener pass does not discard');
  rig.sessions.main.answer('Good to hear. Tell me about your last role.');
  rig.streams.at(-1).audio(1000);
  await flush();
  await rig.clock.advance(700);
  assert.equal(rig.of('discarded').length, 0);
  assert(rig.engine.state().transcript.some(entry => entry.speaker === 'interviewer' && /last role/.test(entry.text)), 'the reply is in the transcript');
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'the reply is played');
  assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => entry.text), ['Going well, thanks for asking.']);
});

test('opener pass before or after the main pass: nothing spoken, one discarded pass, the line kept once', async () => {
  for (const openerFirst of [true, false]) {
    const rig = makeRig();
    await greet(rig);
    await speculate(rig, 'okay', 'a');
    if (openerFirst) rig.sessions.opener.answer('<pass/>');
    rig.sessions.main.answer('<pass/>');
    await flush();
    if (!openerFirst) rig.sessions.opener.answer('<pass/>');
    await flush();
    assert.equal(rig.engine.state().phase, 'listening', `openerFirst=${openerFirst}`);
    assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
    assert.equal(rig.of('discarded').length, 1, JSON.stringify(rig.of('discarded')));
    assert.equal(rig.of('discarded')[0].reason, 'pass');
    assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => entry.text), ['okay']);
  }
});

test('opener pass does not restart or resend the main turn (its "reaction already playing" note is fixed when it is sent)', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'Going well, thanks.', 'a');
  const before = rig.sessions.main.calls.length;
  const sent = rig.sessions.main.calls.at(-1).message;
  rig.sessions.opener.answer('<pass/>');
  await flush();
  assert.equal(rig.sessions.main.calls.length, before, 'main is not sent again');
  assert(!rig.sessions.main.calls.at(-1).signal.aborted, 'main is not cancelled');
  assert.equal(rig.sessions.main.calls.at(-1).message, sent);
});

test('a typed message answered with pass ends silent with the typed entry kept', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('thanks');
  await flush();
  rig.sessions.main.answer('<pass/>');
  rig.sessions.opener.answer('<pass/>');
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => [entry.channel, entry.text]), [['chat', 'thanks']]);
});

const chatEntries = rig => rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').map(entry => [entry.channel, entry.text]);

test('typed okay, main pass first and the opener reaction not yet committed: nothing is spoken, the entry is kept once, discarded pass', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('okay');
  await flush();
  rig.sessions.main.answer('<pass/>');
  await flush();
  rig.sessions.opener.answer('Mm-hm.');
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0, 'nothing played');
  assert.deepEqual(chatEntries(rig), [['chat', 'okay']], 'kept once, on the chat channel');
  assert.equal(rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').length, 1, 'no reaction in the transcript');
  assert(rig.of('discarded').some(item => item.reason === 'pass'), JSON.stringify(rig.of('discarded')));
});

test('typed okay, opener pass first: the same silent, kept-once result', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('okay');
  await flush();
  rig.sessions.opener.answer('<pass/>');
  await flush();
  assert.equal(rig.engine.state().phase, 'speculating', 'the opener pass alone decides nothing');
  rig.sessions.main.answer('<pass/>');
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert.deepEqual(chatEntries(rig), [['chat', 'okay']]);
  assert(rig.of('discarded').some(item => item.reason === 'pass'));
});

test('typed okay with main pass after the opener reaction was already committed: the reaction finishes, the entry is kept once', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('okay');
  await flush();
  rig.sessions.opener.answer('Okay.');
  rig.streams[1].audio(300);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'the reaction is playing');
  rig.sessions.main.answer('<pass/>');
  await flush();
  assert.deepEqual(chatEntries(rig), [['chat', 'okay']]);
});

test('typed listen is treated as pass: nothing spoken, entry kept, never resent', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('let me think');
  await flush();
  rig.sessions.main.answer('<listen/>');
  rig.sessions.opener.answer('<listen/>');
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  assert.deepEqual(chatEntries(rig), [['chat', 'let me think']], 'kept, not joined to later words');
  assert(rig.of('discarded').some(item => item.reason === 'pass'), 'reported as pass');
  rig.engine.typed('here is the answer');
  await flush();
  assert(!rig.sessions.main.calls.at(-1).message.includes('let me think'), 'the passed line is not resent');
  assert.deepEqual(chatEntries(rig), [['chat', 'let me think']].concat([]), 'the new message is not committed until answered');
});

test('a typed pass restarts the silence check and the next message does not carry the line again', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('thanks');
  await flush();
  rig.sessions.main.answer('<pass/>');
  rig.sessions.opener.answer('<pass/>');
  await flush();
  const calls = rig.sessions.main.calls.length;
  await rig.clock.advance(19000);
  assert.equal(rig.sessions.main.calls.length, calls, 'the wait restarted from the pass');
  await rig.clock.advance(1100);
  assert(rig.sessions.main.calls.length > calls, 'the silence check came after the wait');
  assert.match(rig.sessions.main.calls.at(-1).message, /candidate silent/);
});

test('a normal typed answer is still replied to out loud', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('I would shard by tenant because writes are skewed');
  await flush();
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Why tenant and not region?');
  rig.streams[1].audio(300);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1);
  assert(rig.engine.state().transcript.some(entry => entry.speaker === 'interviewer' && /region/.test(entry.text)));
  assert.equal(rig.of('discarded').filter(item => item.reason === 'pass').length, 0);
});

test('a pass to a finished line keeps the interviewer wait and restarts the silence check from now', async () => {
  const options = [];
  const rig = makeRig({ createParser: patienceParser, formatTurn: option => { options.push(option); return '[turn]'; } });
  await greet(rig);
  await deliver(rig, 'Go ahead.<wait s="30"/>');
  await speak(rig, 'okay', 'k');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('<pass/>');
  rig.sessions.main.answer('<pass/>', { chunks: ['<pass/>'] });
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  assert.deepEqual(rig.engine.state().transcript.slice(-1).map(entry => entry.text), ['okay']);
  const calls = rig.sessions.main.calls.length;
  await rig.clock.advance(29000);
  assert.equal(rig.sessions.main.calls.length, calls, 'the 30 s wait still holds');
  await rig.clock.advance(1100);
  assert.equal(rig.sessions.main.calls.length, calls + 1, 'then the silence check');
});

test('a pass reply alone (no reaction) to a finished line leaves the next message free of the old line', async () => {
  const options = [];
  const rig = makeRig({ formatTurn: option => { options.push(option); return '[turn]'; } });
  await greet(rig);
  await speculate(rig, 'okay', 'a');
  rig.sessions.main.answer('<pass/>');
  rig.sessions.opener.answer('<pass/>');
  await flush();
  await rig.clock.advance(5000);
  await speculate(rig, 'now the real answer', 'b');
  const last = options.at(-1);
  assert.equal(last.candidateText, 'now the real answer');
});

test('a reaction already playing finishes when the main reply is listen; the line is in the transcript once', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Mm.');
  rig.streams[1].audio(400);
  await flush();
  await rig.clock.advance(700);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1);
  rig.sessions.main.answer('<listen/>');
  await flush();
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 800);
  await flush();
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer', 'candidate', 'interviewer']);
  assert.equal(rig.engine.state().phase, 'listening');
});

test('pass from main after a finished line: the opener reaction is discarded with reason pass, the line is kept, nothing plays', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(rig);
  await speculate(rig);
  rig.sessions.main.answer('<pass/>');
  await flush();
  rig.sessions.opener.answer('Mm, okay.');
  rig.streams[1].audio(400);
  await flush();
  assert(rig.streams[1].cancelled);
  assert.equal(rig.engine.state().phase, 'listening');
  await rig.clock.advance(600);
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 0);
  assert.deepEqual(rig.engine.state().transcript.map(entry => entry.speaker), ['interviewer', 'candidate']);
  assert(rig.of('discarded').some(item => item.reason === 'pass'), JSON.stringify(rig.of('discarded')));
});

const REPLY_WORDS = words('Right,', 'got', 'it.', 'Tell', 'me', 'about', 'the', 'design.', 'What', 'was', 'hard?');

/** A reply (utt2) is playing: three sentences, words 300 ms apart (word i ends at i*300+280). */
async function toPlaying(rig, { opener = 'Right, got it.', main = 'Tell me about the design. What was hard?', wordList = REPLY_WORDS } = {}) {
  await speculate(rig);
  rig.sessions.opener.answer(opener);
  await flush();
  rig.sessions.main.answer(main);
  rig.streams[1].words(wordList);
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
  assert.deepEqual(bare(interviewer), { speaker: 'interviewer', text: 'Right, got it.', interrupted: true, heardText: 'Right, got it.' });
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
  await rig.clock.advance(19999);
  assert.equal(rig.sessions.main.calls.length, 1);
  await rig.clock.advance(1);
  // Nothing was said, so no acknowledgement is spoken before a silence check-in.
  assert.equal(rig.sessions.opener.calls.length, 0);
  assert.equal(rig.sessions.main.calls[1].message, '[elapsed 00:20] [candidate silent 20s, check 1 of 3]');
  rig.sessions.main.answer('Still with me?');
  rig.streams[1].audio(500);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'a silence turn commits without waiting');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 800);
  await rig.clock.advance(19999);
  assert.equal(rig.sessions.main.calls.length, 2);
  await rig.clock.advance(1);
  assert.equal(rig.sessions.main.calls.length, 3, 'the timer restarts after each interviewer utterance, 20 s later with the default patience');
  assert.match(rig.sessions.main.calls[2].message, /\[candidate silent 40s, check 2 of 3\]/, 'the real cumulative silence is reported');

  const quiet = makeRig();
  await greet(quiet);
  quiet.engine.typing(true);
  await quiet.clock.advance(5000);
  quiet.engine.typing(true); // a refresh keeps it alive
  await quiet.clock.advance(5000);
  assert.equal(quiet.sessions.main.calls.length, 1, 'typing pauses the silence prompt');
  quiet.engine.typing(false);
  await quiet.clock.advance(19999);
  assert.equal(quiet.sessions.main.calls.length, 1);
  await quiet.clock.advance(1);
  assert.equal(quiet.sessions.main.calls.length, 2);
});

test('pause blocks every check-in and the silence ending, however long the clock runs', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.setPaused(true);
  await rig.clock.advance(10 * 60 * 1000);
  assert.equal(rig.sessions.main.calls.length, 1, 'no check-in while paused');
  assert.equal(rig.of('ended').length, 0);
  assert.equal(rig.engine.state().phase, 'listening');
  assert.equal(rig.clock.pending(), 0, 'no silence timer is left armed');
});

test('pause also holds the silence ending after the checks were already used', async () => {
  const rig = makeRig();
  await greet(rig);
  for (let check = 1; check <= 3; check += 1) {
    await rig.clock.advance(check === 3 ? 30000 : 20000); // the gaps widen: 20 s, 20 s, 30 s
    rig.sessions.main.answer('Still there?');
    rig.streams[check].audio(300);
    await flush();
    rig.h.playback(`utt${check + 1}`, 'started');
    rig.h.playback(`utt${check + 1}`, 'finished', 500);
    await flush();
    if (check === 3) break;
  }
  rig.engine.setPaused(true);
  await rig.clock.advance(5 * 60 * 1000);
  assert.equal(rig.of('ended').length, 0, 'the line does not drop while paused');
  rig.engine.setPaused(false);
  await rig.clock.advance(60 * 1000);
  assert.equal(rig.of('ended').length, 1);
  assert.equal(rig.of('ended')[0].cause, 'silence');
});

test('elapsed time in the next turn message excludes paused time, the helper timeline is not shifted', async () => {
  const rig = makeRig();
  await greet(rig);
  await rig.clock.advance(5000);
  rig.engine.setPaused(true);
  assert.equal(rig.engine.state().elapsedMs, 5000, 'elapsed so far');
  await rig.clock.advance(120000);
  assert.equal(rig.engine.state().elapsedMs, 5000, 'elapsed stands still while paused');
  assert.equal(rig.engine.state().pausedMs, 120000);
  rig.engine.setPaused(false); // only the shortcut resumes
  rig.engine.typed('here is my answer');
  await flush();
  assert.equal(rig.engine.state().paused, false);
  assert.match(rig.sessions.main.calls[1].message, /^\[elapsed 00:05\]/);
  assert.equal(rig.engine.state().pausedMs, 120000);
  assert.equal(rig.engine.state().elapsedMs, 5000 + 0, 'still the unpaused elapsed time right after the turn');
});

test('resume re-arms the silence wait from zero with the same patience and keeps the check count', async () => {
  const rig = makeRig();
  await greet(rig);
  await rig.clock.advance(20000);
  assert.equal(rig.sessions.main.calls.length, 2, 'check 1 sent');
  rig.sessions.main.answer('Still with me?');
  rig.streams[1].audio(300);
  await flush();
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 500);
  await flush();
  await rig.clock.advance(15000); // part of the second wait is used up
  rig.engine.setPaused(true);
  await rig.clock.advance(60000);
  rig.engine.setPaused(false);
  await rig.clock.advance(19999);
  assert.equal(rig.sessions.main.calls.length, 2, 'the wait restarted from zero');
  await rig.clock.advance(1);
  assert.equal(rig.sessions.main.calls.length, 3);
  assert.match(rig.sessions.main.calls[2].message, /check 2 of 3/, 'the count of checks already made is kept');
});

test('only the shortcut resumes: speech and chat neither resume nor start a turn', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.setPaused(true);
  await speak(rig, 'I would start with a queue', 'a');
  await rig.clock.advance(5000);
  assert.equal(rig.engine.state().paused, true, 'speech does not resume');
  assert.equal(rig.sessions.opener.calls.length, 0, 'speech during a pause speculates nothing');
  assert.equal(rig.sessions.main.calls.length, 1, 'and starts no turn');
  assert.equal(rig.engine.typed('typed during the pause'), false, 'chat is refused');
  rig.engine.setPadText('const a = 1;');
  rig.engine.typing(true);
  rig.engine.typing(false);
  await flush();
  assert.equal(rig.engine.state().paused, true, 'pad text and typing signals resume nothing');
  assert.equal(rig.sessions.main.calls.length, 1);
  assert.equal(rig.engine.state().transcript.filter(entry => entry.speaker === 'candidate').length, 0, 'nothing from the pause is kept as a turn');
  rig.engine.setPaused(false);
  assert.equal(rig.engine.state().paused, false);
  assert.equal(rig.engine.typed('typed after resuming'), true);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2);
  assert.match(rig.sessions.main.calls[1].message, /typed after resuming/);
});

test('speech from a pause never reaches the first turn after resume, even when its words arrive late', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.setPaused(true);
  rig.h.vad(true);
  rig.h.transcript('secret pause words', 'p1', rig.clock.now(), false, rig.clock.now() + 300);
  await rig.clock.advance(300);
  rig.engine.setPaused(false);
  rig.h.transcript('secret pause words continued', 'p1', rig.clock.now() - 300, true, rig.clock.now());
  rig.h.vad(false);
  await rig.clock.advance(2000);
  assert.equal(rig.sessions.opener.calls.length, 0, 'no turn starts from pause speech');
  await speak(rig, 'a fresh answer', 'b');
  await rig.clock.advance(600);
  const sent = [...rig.sessions.opener.calls, ...rig.sessions.main.calls].map(call => call.message).join('\n');
  assert.match(sent, /a fresh answer/);
  assert(!sent.includes('secret pause words'), sent);
});

test('typed is refused while paused and works after the shortcut resumes', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.setPaused(true);
  assert.equal(rig.engine.typed('hello'), false);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1);
  rig.engine.setPaused(false);
  assert.equal(rig.engine.typed('after'), true);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'a typed message is a normal turn after resume');
  assert(!/hello/.test(rig.sessions.main.calls[1].message), 'the refused message is not delivered later');
});

test('an interruption attempt during a pause does not cut the reply that is finishing', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 650);
  rig.engine.setPaused(true);
  rig.h.vad(true);
  rig.h.transcript('wait what do you mean', 'o1', rig.clock.now());
  await rig.clock.advance(1000);
  rig.h.vad(false);
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'the reply is not cut');
  assert.equal(rig.sessions.classifier.calls.length, 0, 'the classifier is not asked');
  assert.equal(rig.engine.state().phase, 'playing');
  rig.h.playback('utt2', 'finished', 3000);
  await flush();
  await rig.clock.advance(5000);
  assert.equal(rig.sessions.main.calls.length, 2, 'still no new turn while paused');
});

test('a reply paused by an overlap plays on when the call pauses mid-overlap', async () => {
  const ear = makeEar({ floorBid: () => ({ decision: 'pause' }) });
  const rig = makeRig({ ear });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  await floorBidOverlap(rig, 'right');
  await rig.clock.advance(200);
  assert.equal(rig.opsOf('pause').filter(item => item.id === 'utt2').length, 1);
  rig.engine.setPaused(true);
  assert.equal(rig.opsOf('resume').filter(item => item.id === 'utt2').length, 1, 'the reply resumes and finishes');
  rig.h.vad(false);
  await flush();
  assert.equal(rig.sessions.classifier.calls.length, 0);
  assert.equal(cancelsOf(rig, 'utt2'), 0);
});

test('a reply already being spoken when the pause starts still finishes', async () => {
  const rig = makeRig();
  rig.engine.start({ greeting: true });
  await flush();
  rig.h.level();
  rig.sessions.main.answer('Welcome to the interview.');
  rig.streams[0].audio(3200);
  await flush();
  rig.h.playback('utt1', 'started');
  rig.engine.setPaused(true);
  await rig.clock.advance(1000);
  assert.equal(rig.opsOf('cancel').length, 0, 'the pause does not cancel playback');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
  await rig.clock.advance(5 * 60 * 1000);
  assert.equal(rig.sessions.main.calls.length, 1, 'and no check-in follows while paused');
});

test('pausing twice or resuming when not paused does nothing, and the event fires on change only', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.setPaused(false);
  assert.equal(rig.of('paused').length, 0);
  assert.equal(rig.engine.state().paused, false);
  rig.engine.setPaused(true);
  await rig.clock.advance(1000);
  rig.engine.setPaused(true);
  assert.equal(rig.of('paused').length, 1);
  assert.deepEqual(rig.of('paused')[0], { type: 'paused', paused: true });
  assert.equal(rig.engine.state().paused, true);
  rig.engine.setPaused(false);
  rig.engine.setPaused(false);
  assert.equal(rig.of('paused').length, 2);
  assert.deepEqual(rig.of('paused')[1], { type: 'paused', paused: false });
  assert.equal(rig.engine.state().pausedMs, 1000);
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
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'the reply runs on to the next word boundary');
  await rig.clock.advance(300);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  assert.equal(rig.sessions.opener.calls.length, 1, 'the typed turn waits for the cancelled event');
  rig.h.playback('utt2', 'cancelled', 900);
  await flush();
  assert.match(rig.sessions.opener.calls[1].message,
    /\[You were interrupted after saying: 'Right, got it\.'\. The rest was not heard\.\] Candidate \(typed in chat\): 'wait what is that'$/);
});

test('a short typed message over the reply never goes to the classifier: it stops the reply and becomes one typed turn', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.engine.typed('ok sure');
  await flush();
  assert.equal(rig.sessions.classifier.calls.length, 0, 'typed text is never judged as an acknowledgement');
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'stops at the next word boundary, not before');
  await rig.clock.advance(280);
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  rig.h.playback('utt2', 'cancelled', 280);
  await flush();
  assert(rig.sessions.opener.calls[1].message.endsWith("Candidate (typed in chat): 'ok sure'"));
  assert(!rig.engine.state().transcript.some(entry => entry.acknowledgement), 'no acknowledgement entry');
});

test('chat blocks are parsed out of the spoken stream, posted when playback reaches them and recorded, never sent to the voice', async () => {
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
  assert.equal(rig.of('chat').length, 0, 'nor when it commits: playback has not reached it');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 900);
  await flush();
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
  await rig.clock.advance(600); // the reply commits
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 900); // the chat is delivered when playback gets there
  await flush();
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
  await rig.clock.advance(300);
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
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 900);
  await flush();
  assert.deepEqual(rig.of('chat'), [{ type: 'chat', from: 'interviewer', text: 'Write a sum.' }], 'the chat is posted once');
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
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 900);
  await flush();
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

  const quiet = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(quiet);
  await speculate(quiet);
  quiet.sessions.opener.answer('Right.');
  quiet.sessions.main.answer('Goodbye.');
  await flush();
  assert.equal(quiet.of('error').length, 1);
  const before = quiet.sessions.main.calls.length;
  await quiet.clock.advance(20000);
  assert.equal(quiet.sessions.main.calls.length, before + 1, 'silence is armed again');

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
  await rig.clock.advance(20000);
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
  assert.deepEqual(bare(unfinished.engine.state().transcript.pop()),
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
  assert.deepEqual(bare(whole.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').pop()),
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
  await rig.clock.advance(230 + 499);
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
  assert.deepEqual(bare(rig.engine.state().transcript.pop()),
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
  await blip.clock.advance(1200 + 19999);
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
  await acked.clock.advance(19999);
  assert.equal(acked.sessions.main.calls.length, 2);
  await acked.clock.advance(1);
  assert.equal(acked.sessions.main.calls.length, 3);

  const listened = makeRig();
  await greet(listened);
  await listened.clock.advance(20000);
  assert.equal(listened.sessions.main.calls.length, 2);
  listened.sessions.main.answer('<listen/>');
  await flush();
  assert.equal(listened.engine.state().phase, 'listening');
  await listened.clock.advance(19999);
  assert.equal(listened.sessions.main.calls.length, 2);
  await listened.clock.advance(1);
  assert.equal(listened.sessions.main.calls.length, 3, 'listen to a silence prompt arms the next one');
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
  await silent.clock.advance(20000);
  silent.sessions.main.answer('Still with me?');
  await flush();
  assert.deepEqual(silent.streams[1].texts, ['Still with me?']);
  assert.equal(silent.of('discarded').length, 0);
});

// ---- panel calls --------------------------------------------------------------
const PANEL = () => ({ leadId: 'A', speakers: [
  { id: 'A', name: 'Priya', present: true }, { id: 'B', name: 'John', present: true }, { id: 'C', name: 'Mei', present: false },
] });
const panelRig = options => makeRig({ panel: PANEL(), speakerVoice: true, ...options });
const spoken = (id, base, ...list) => list.map((word, index) => ({ word, speakerId: id, startMs: base + index * 300, endMs: base + index * 300 + 280 }));
const HELLO_WORDS = [...spoken('A', 0, 'Hello,', 'I', 'am', 'Priya.'), ...spoken('B', 1200, 'And', 'I', 'am', 'John.')];

/** Greeting whose reply switches from the lead to a colleague; the voice reports both speakers. */
async function panelGreeting(rig, reply = 'Hello, I am Priya. <speaker id="B"/>And I am John.') {
  rig.engine.start();
  await flush();
  rig.h.level();
  rig.sessions.main.answer(reply);
  rig.streams[0].audio(3200);
  rig.streams[0].words(HELLO_WORDS);
  rig.streams[0].speakerCb({ speakerId: 'A', startMs: 0 });
  rig.streams[0].speakerCb({ speakerId: 'B', startMs: 1200 });
  await flush();
}

/** The candidate speaks, both sessions answer and the reply (one audio chunk) plays to the end. */
async function answerTurn(rig, mainText, openerText = 'Right.') {
  await speak(rig, 'I built a scheduler', `t${rig.streams.length}`);
  await rig.clock.advance(1200);
  rig.sessions.opener.answer(openerText);
  rig.sessions.main.answer(mainText);
  const stream = rig.streams[rig.streams.length - 1];
  stream.audio(3200);
  await rig.clock.advance(1200);
  const id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 1500);
  await flush();
  return stream;
}

test('panel: a speaker tag switches the voice between the same sentences, with segments, speaker ids and speaker events', async () => {
  const rig = panelRig();
  await panelGreeting(rig);
  assert.deepEqual(rig.opens, [{ utteranceId: 'utt1', signal: rig.streams[0].signal, speakerId: 'A' }]);
  assert.deepEqual(rig.streams[0].log, [{ text: 'Hello, I am Priya.' }, { speaker: 'B' }, { text: 'And I am John.' }], 'setSpeaker sits between the texts');
  rig.h.playback('utt1', 'started');
  assert.deepEqual(rig.of('speaker'), [{ type: 'speaker', speakerId: 'A' }], 'the first segment is shown at playback start');
  rig.h.playback('utt1', 'position', 1000);
  assert.equal(rig.of('speaker').length, 1, 'no event before the second segment reaches the playback position');
  rig.h.playback('utt1', 'position', 1250);
  assert.deepEqual(rig.of('speaker').map(event => event.speakerId), ['A', 'B']);
  rig.h.playback('utt1', 'position', 1400);
  assert.equal(rig.of('speaker').length, 2, 'the same speaker is not announced twice');
  const captions = rig.of('caption');
  assert.equal(captions[captions.length - 1].speakerId, 'B', 'the caption names the speaker of the newest text');
  rig.h.playback('utt1', 'finished', 2400);
  await flush();
  const entry = rig.engine.state().transcript[0];
  assert.deepEqual(bare(entry), {
    speaker: 'interviewer', text: 'Hello, I am Priya. And I am John.', speakerId: 'A',
    segments: [{ speakerId: 'A', text: 'Hello, I am Priya.' }, { speakerId: 'B', text: 'And I am John.' }],
  });
  assert.equal(rig.of('caption').pop().final, true);
  assert.equal(rig.of('caption').pop().speakerId, 'B');
});

test('panel: a reply from one interviewer has a speaker id but no segments', async () => {
  const rig = panelRig();
  await panelGreeting(rig, 'Hello there.');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(bare(rig.engine.state().transcript[0]), { speaker: 'interviewer', text: 'Hello there.', speakerId: 'A' });
});

test('panel: a tag for an id that was never cast drops what follows it, from the voice and the transcript', async () => {
  const rig = panelRig();
  rig.engine.start();
  await flush();
  rig.sessions.main.answer('Hi. <speaker id="Y"/>Hello there. <speaker id="Z"/>Still me.');
  rig.streams[0].audio(640);
  await flush();
  assert.deepEqual(rig.streams[0].log, [{ text: 'Hi.' }], 'nothing is spoken in the name of an id that is not on the call');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(bare(rig.engine.state().transcript[0]), { speaker: 'interviewer', text: 'Hi.', speakerId: 'A' });
});

test('panel: a cut-in switch passes { cutIn: true } to setSpeaker, directly and through the queue; ordinary switches pass nothing', async () => {
  const rig = panelRig({ createParser: tagParser });
  rig.engine.start();
  await flush();
  rig.sessions.main.answer('<speaker id="A"/>One. <speaker id="B" cut/>Two. <speaker id="A"/>Three.');
  await flush();
  assert.deepEqual(rig.streams[0].log, [
    { text: 'One.' }, { speaker: 'B', options: { cutIn: true } }, { text: 'Two.' }, { speaker: 'A' }, { text: 'Three.' }]);
});

test('panel: a queued cut-in switch keeps its flag', async () => {
  const rig = panelRig({ createParser: tagParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.main.answer('Fine. <speaker id="B" cut/>Why?');
  await flush();
  await rig.clock.advance(700);
  assert.deepEqual(rig.streams[1].log, [{ text: 'Fine.' }, { speaker: 'B', options: { cutIn: true } }, { text: 'Why?' }]);
});

test('panel: a voice whose setSpeaker ignores a second argument still works with a cut-in', async () => {
  const rig = panelRig({ createParser: tagParser });
  rig.engine.start();
  await flush();
  const stream = rig.streams[0];
  const seen = [];
  stream.setSpeaker = id => { seen.push(id); return true; };
  rig.sessions.main.answer('<speaker id="A"/>One. <speaker id="B" cut/>Two.');
  await flush();
  assert.deepEqual(seen, ['B']);
  assert.deepEqual(stream.texts, ['One.', 'Two.']);
});

test('panel: a repeated tag for the speaker already talking does not call setSpeaker', async () => {
  const rig = panelRig();
  rig.engine.start();
  await flush();
  rig.sessions.main.answer('<speaker id="A"/>One. <speaker id="B"/>Two. <speaker id="B"/>Three.');
  await flush();
  assert.deepEqual(rig.streams[0].log, [{ text: 'One.' }, { speaker: 'B' }, { text: 'Two.' }, { text: 'Three.' }]);
});

test('panel: with a gated voice the speaker switch is queued in order with the texts', async () => {
  const rig = panelRig();
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.main.answer('Fine. <speaker id="B"/>Why?');
  await flush();
  assert.deepEqual(rig.streams[1].log, [], 'nothing reaches the voice before the gate opens');
  await rig.clock.advance(700);
  assert.deepEqual(rig.streams[1].log, [{ text: 'Fine.' }, { speaker: 'B' }, { text: 'Why?' }]);
});

test('panel: participantJoined adds one marker to the next opener and main messages only, and never starts a turn', async () => {
  const rig = panelRig();
  await greet(rig);
  const before = rig.sessions.main.calls.length;
  rig.engine.participantJoined('C');
  rig.engine.participantJoined('C');
  rig.engine.participantJoined('Z');
  await rig.clock.advance(5000);
  assert.equal(rig.sessions.main.calls.length, before, 'joining alone sends nothing to the model');
  assert.equal(rig.of('phase').pop().phase, 'listening', 'joining does not start a turn');
  await answerTurn(rig, 'Welcome Mei. Question?');
  const marker = '[Mei has joined the call and is listening. They have not been introduced yet.]';
  assert.equal(rig.sessions.opener.calls[0].message.split(marker).length, 2, 'once in the opener message');
  const main = rig.sessions.main.calls[1].message;
  assert.equal(main.split(marker).length, 2, 'once in the main message');
  assert(main.indexOf(marker) < main.indexOf("Candidate: '"), 'before the candidate line');
  await answerTurn(rig, 'Next one.');
  assert(!rig.sessions.main.calls[2].message.includes('has joined'), 'the next message carries no marker');
  assert(!rig.sessions.opener.calls[1].message.includes('has joined'));
});

test('panel: a colleague who joined can then speak, and the marker survives a reply that was never committed', async () => {
  const rig = panelRig();
  await greet(rig);
  rig.engine.participantJoined('C');
  await speak(rig, 'I built', 'a');
  await rig.clock.advance(600);
  assert(rig.sessions.main.calls[1].message.includes('Mei has joined'));
  rig.h.vad(true); // the candidate resumed: the speculative reply is dropped before it was committed
  rig.h.transcript('I built a scheduler', 'a', rig.clock.now());
  await rig.clock.advance(300);
  rig.h.vad(false);
  await rig.clock.advance(1200);
  assert(rig.sessions.main.calls[2].message.includes('Mei has joined'), 'still announced: the earlier message was never spoken');
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Mei, over to you. <speaker id="C"/>Thanks.');
  const stream = rig.streams[rig.streams.length - 1];
  stream.audio(640);
  await rig.clock.advance(1300);
  assert.deepEqual(stream.log.filter(item => item.speaker), [{ speaker: 'C' }], 'Mei may speak now');
});

test('panel: the floor carries to the next reply and opens its voice stream', async () => {
  const rig = panelRig();
  await panelGreeting(rig);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 2400);
  await flush();
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  assert.equal(rig.opens[1].speakerId, 'B', 'John spoke last, so he holds the floor');
  assert.equal(rig.opens[0].speakerId, 'A');
});

test('panel: an interruption during the second speaker keeps the first segment whole and trims the second', async () => {
  const rig = panelRig();
  await panelGreeting(rig);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 1800);
  rig.engine.typed('wait');
  rig.h.playback('utt1', 'cancelled', 1800);
  await flush();
  const entry = rig.engine.state().transcript.find(item => item.speaker === 'interviewer');
  assert.deepEqual(bare(entry), {
    speaker: 'interviewer', text: 'Hello, I am Priya. And I', speakerId: 'A', interrupted: true, heardText: 'Hello, I am Priya. And I',
    segments: [{ speakerId: 'A', text: 'Hello, I am Priya.' }, { speakerId: 'B', text: 'And I' }],
  });
  rig.sessions.main.answer('Sure.');
  assert.equal(rig.opens[1].speakerId, 'B', 'the floor is the last speaker who was heard');
});

test('panel: an interruption inside the first segment leaves one segment and the lead on the floor', async () => {
  const rig = panelRig();
  await panelGreeting(rig);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 400);
  rig.engine.typed('wait');
  await rig.clock.advance(180); // the word in progress ends at 580 ms, where the stop lands
  rig.h.playback('utt1', 'cancelled', 600);
  await flush();
  assert.deepEqual(bare(rig.engine.state().transcript.find(item => item.speaker === 'interviewer')), {
    speaker: 'interviewer', text: 'Hello, I', speakerId: 'A', interrupted: true, heardText: 'Hello, I',
  });
});

test('solo: no panel option sends the old messages, opens the voice without speakerId and adds no fields or events', async () => {
  const rig = makeRig({ speakerVoice: true });
  rig.engine.participantJoined?.('C');
  rig.engine.start();
  await flush();
  assert.equal(rig.sessions.main.calls[0].message, '[elapsed 00:00] [call connected]');
  rig.sessions.main.answer('Hello. <speaker id="B"/>Hi again.');
  rig.streams[0].audio(640);
  rig.streams[0].words(spoken('A', 0, 'Hello.', 'Hi', 'again.'));
  await flush();
  assert.deepEqual(rig.opens, [{ utteranceId: 'utt1', signal: rig.streams[0].signal }], 'exactly today\'s open arguments');
  assert.equal('speakerId' in rig.opens[0], false);
  assert.deepEqual(rig.streams[0].log, [{ text: 'Hello.' }], 'text written for someone not on the call is not spoken');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(rig.engine.state().transcript.map(bare), [{ speaker: 'interviewer', text: 'Hello.' }]);
  assert.deepEqual(rig.of('speaker'), []);
  assert(rig.of('caption').every(event => !('speakerId' in event)));
  await answerTurn(rig, 'Next.');
  assert(!rig.sessions.main.calls[1].message.includes('joined'));
  assert.equal('speakerId' in rig.opens[1], false);
});

// Heard in the first live calls: the one-word acknowledgement was silent until the reply's first
// sentence arrived, because the voice service waits for about 40 characters before it speaks.
test('the acknowledgement is flushed to the voice at once, and free-form delivery tags never reach captions or the transcript', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('Here is my answer');
  await flush();
  rig.sessions.opener.answer('[thoughtful] Mm.');
  await flush();
  const stream = rig.streams[1];
  assert.deepEqual(stream.texts, ['[thoughtful] Mm.'], 'the tag goes to the voice');
  assert.deepEqual(stream.flushes, [1], 'asked to speak as soon as the acknowledgement was sent');
  rig.sessions.main.answer('[Warm, faint amusement] That is a LOT of devices. [curious] How did you test it?');
  stream.audio(500);
  await flush();
  assert.deepEqual(stream.flushes, [1], 'the reply itself is not flushed sentence by sentence');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 900);
  await flush();
  const captions = rig.of('caption').filter(item => item.speaker === 'interviewer').map(item => item.text);
  assert.equal(captions.at(-1), 'Mm. That is a LOT of devices. How did you test it?');
  const said = rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').at(-1);
  assert.equal(said.text, 'Mm. That is a LOT of devices. How did you test it?');
});

// Heard in a live call: the acknowledgement came back as "Oh, totally understandable. Got it." and
// the reply then said the same thing again.
test('an acknowledgement longer than three words is not spoken, and the reply still is', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('A little nervous, honestly');
  await flush();
  rig.sessions.opener.answer('[warmly] Oh, totally understandable. Got it.');
  await flush();
  const stream = rig.streams[1];
  assert.deepEqual(stream.texts, [], 'nothing of the long acknowledgement reaches the voice');
  assert.deepEqual(stream.flushes, []);
  rig.sessions.main.answer('That is normal. Tell me about your background.');
  await flush();
  assert.deepEqual(stream.texts, ['That is normal.', 'Tell me about your background.']);

  const short = makeRig();
  await greet(short);
  short.engine.typed('Here is my answer');
  await flush();
  short.sessions.opener.answer('[warmly] Oh, okay.');
  await flush();
  assert.deepEqual(short.streams[1].texts, ['[warmly] Oh, okay.'], 'a tag does not count as a word');
});

test('a bare delivery tag is not an acknowledgement and nothing is sent to the voice for it', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('Here is my answer');
  await flush();
  rig.sessions.opener.answer('[warmly]');
  await flush();
  assert.deepEqual(rig.streams[1].texts, []);
  assert.deepEqual(rig.streams[1].flushes, []);
});

// On a spoken turn the acknowledgement waits behind the voice gate. It is flushed when the gate
// opens only if nothing else is waiting with it.
test('behind the voice gate, the acknowledgement is flushed when the gate opens unless the reply is already queued', async () => {
  const alone = makeRig();
  await greet(alone);
  await speculate(alone, 'I built the hub');
  alone.sessions.opener.answer('Right.');
  await flush();
  const first = alone.streams[1];
  assert.deepEqual(first.texts, [], 'held behind the gate');
  assert.deepEqual(first.flushes, []);
  await alone.clock.advance(700);
  assert.deepEqual(first.texts, ['Right.']);
  assert.deepEqual(first.flushes, [1], 'flushed as the gate opens');

  const together = makeRig();
  await greet(together);
  await speculate(together, 'I built the hub');
  together.sessions.opener.answer('Right.');
  await flush();
  together.sessions.main.answer('Tell me more about it.');
  await flush();
  await together.clock.advance(700);
  const second = together.streams[1];
  assert.deepEqual(second.texts, ['Right.', 'Tell me more about it.']);
  assert.deepEqual(second.flushes, [], 'the reply is already there, so nothing needs forcing');
});

// ---- shared screen and coding pad --------------------------------------------
// A stub parser: tokens [[screen:Title|Content]], [[stop]], [[pad-open:lang]], [[pad-close]], [[spk:B]] become items in order,
// everything else is split into sentences, so these tests do not depend on the real parser.
function screenParser() {
  const run = text => {
    const items = [];
    for (const piece of text.split(/(\[\[[^\]]*\]\])/).filter(Boolean)) {
      const token = piece.match(/^\[\[([a-z-]+)(?::([^\]]*))?\]\]$/);
      if (!token) { for (const sentence of piece.match(/[^.!?]+[.!?]/g) ?? []) items.push({ sentence: sentence.trim() }); continue; }
      const [, kind, arg = ''] = token;
      if (kind === 'screen') {
        // An optional last part '#4' is the delay in seconds.
        const [title, ...rest] = arg.split('|');
        const last = rest.length > 1 ? rest[rest.length - 1].match(/^#(.+)$/) : null;
        if (last) rest.pop();
        items.push({ screen: { title, content: rest.join('|'), delaySeconds: last ? Number(last[1]) : null } });
      }
      else if (kind === 'stop') items.push({ screenStop: true });
      else if (kind === 'pad-open') items.push({ pad: { open: true, lang: arg } });
      else if (kind === 'pad-close') items.push({ pad: { open: false } });
      else if (kind === 'spk') items.push({ speaker: arg });
      else if (kind === 'pause') items.push({ pause: Number(arg) });
    }
    return { chats: [], sentences: items.filter(item => item.sentence).map(item => item.sentence), items, control: null, endCall: false };
  };
  return { push: run, end: () => ({ chats: [], sentences: [], items: [], control: null, endCall: false }) };
}

async function deliver(rig, text) {
  await speak(rig, 'I built a scheduler', `s${rig.streams.length}`);
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer(text);
  rig.streams[rig.streams.length - 1].audio(1000);
  await flush();
  await rig.clock.advance(700);
  const id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 1500);
  await flush();
}

test('screen and pad items are applied only when the reply is delivered, in order, with events and state', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  assert.deepEqual(rig.engine.state().screen, null);
  assert.deepEqual(rig.engine.state().pad, { open: false, lang: '' });
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Look at my screen.[[screen:Sum|Add two numbers.]] Write it in the pad.[[pad-open:python]]');
  rig.streams[1].audio(1000);
  await flush();
  assert.equal(rig.of('screen').length, 0, 'nothing before the commit');
  assert.equal(rig.engine.state().screen, null);
  await rig.clock.advance(700);
  assert.equal(rig.of('screen').length, 0, 'committed but not yet playing: still nothing');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 1500); // no word timings: everything is delivered when the reply finishes
  await flush();
  assert.deepEqual(rig.of('screen').map(event => ({ type: event.type, title: event.title, content: event.content, speakerId: event.speakerId })), [{ type: 'screen', title: 'Sum', content: 'Add two numbers.', speakerId: 'A' }]);
  assert(Number.isFinite(rig.of('screen')[0].atMs));
  assert.deepEqual(rig.of('pad').map(event => ({ type: event.type, open: event.open, lang: event.lang })), [{ type: 'pad', open: true, lang: 'python' }]);
  assert.deepEqual(rig.engine.state().screen, { title: 'Sum', content: 'Add two numbers.', speakerId: 'A' });
  assert.deepEqual(rig.engine.state().pad, { open: true, lang: 'python' });
  assert(!rig.streams[1].texts.join(' ').includes('Add two'), 'screen content is never spoken');
  await deliver(rig, 'Next part.[[screen:Part two|Now sort them.]][[pad-open:]]');
  assert.deepEqual(rig.engine.state().screen, { title: 'Part two', content: 'Now sort them.', speakerId: 'A' }, 'replaces what was shown');
  assert.deepEqual(rig.engine.state().pad, { open: true, lang: 'python' }, 'reopening keeps the label');
  await deliver(rig, 'Done.[[stop]][[pad-close]]');
  assert.equal(rig.engine.state().screen, null);
  assert.deepEqual(rig.engine.state().pad, { open: false, lang: 'python' });
  assert.equal(rig.of('screen-stop').length, 1);
  assert.equal(rig.of('pad').length, 3);
});

test('screen delayMs: first share clamps 2000..20000 (default 6000), a replacement 0..3000 (default 400), a stop resets', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  const delays = () => rig.of('screen').map(event => event.delayMs);
  await deliver(rig, 'A.[[screen:T|c]]');
  await deliver(rig, 'B.[[stop]]');
  await deliver(rig, 'C.[[screen:T|c|#4]]');
  await deliver(rig, 'D.[[stop]]');
  await deliver(rig, 'E.[[screen:T|c|#0.2]]');
  await deliver(rig, 'F.[[stop]]');
  await deliver(rig, 'G.[[screen:T|c|#60]]');
  assert.deepEqual(delays(), [6000, 4000, 2000, 20000]);
  await deliver(rig, 'H.[[screen:T2|c]]');
  await deliver(rig, 'I.[[screen:T3|c|#1]]');
  await deliver(rig, 'J.[[screen:T4|c|#9]]');
  assert.deepEqual(delays().slice(4), [400, 1000, 3000]);
  await deliver(rig, 'K.[[stop]]');
  await deliver(rig, 'L.[[screen:T5|c]]');
  assert.equal(delays()[7], 6000, 'after a stop the next share is a first share');
});

test('a discarded speculative reply never shows or hides the screen', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.main.answer('Look.[[screen:Hidden|Nope.]][[pad-open:go]]');
  await flush();
  rig.h.vad(true);
  rig.h.transcript('and also', 'b');
  await flush();
  assert.deepEqual(rig.of('screen'), []);
  assert.deepEqual(rig.of('pad'), []);
  assert.equal(rig.engine.state().screen, null);
});

test('panel: the screen records the interviewer speaking at that point of the reply', async () => {
  const rig = panelRig({ createParser: screenParser });
  await panelGreeting(rig, 'Hello.[[spk:B]][[screen:Task|Do it.]]');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.of('screen')[0].speakerId, 'B');
  assert.equal(rig.engine.state().screen.speakerId, 'B');
  const lead = panelRig({ createParser: screenParser });
  await panelGreeting(lead, '[[screen:Task|Do it.]]Hello.[[spk:B]]Hi.');
  lead.h.playback('utt1', 'started');
  lead.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(lead.of('screen')[0].speakerId, 'A');
  const absent = panelRig({ createParser: screenParser });
  await panelGreeting(absent, '[[spk:Z]][[screen:Task|Do it.]]Hello.');
  absent.h.playback('utt1', 'started');
  absent.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(absent.of('screen'), [], 'a screen written inside the segment of an id never cast is dropped');
});

test('a cut-off reply keeps only the screen and pad whose position playback had reached', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Look.[[screen:Keep|Stay.]] Then more.[[pad-open:go]]');
  rig.streams[1].audio(1000);
  rig.streams[1].words(words('Right.', 'Look.', 'Then', 'more.'));
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'position', 700); // 'Right.' and 'Look.' have been heard
  rig.h.vad(true);
  rig.h.transcript('one two three four', 'z', rig.clock.now(), false, rig.clock.now() + 900);
  await flush();
  assert.deepEqual(rig.engine.state().screen, { title: 'Keep', content: 'Stay.', speakerId: 'A' });
  assert.deepEqual(rig.of('pad'), [], 'the pad tag came after words that were never heard');
});

test('screen title and content are capped', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await deliver(rig, `Look.[[screen:${'t'.repeat(300)}|${'c'.repeat(9000)}]]`);
  const shown = rig.engine.state().screen;
  assert.equal(shown.title.length, 120);
  assert.equal(shown.content.length, 6000);
});

test('pad text rides with the next turn only when it changed since the main session last received it', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  rig.engine.setPadText('x = PADCODE_ONE');
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  const first = rig.sessions.main.calls[1].message;
  assert(first.includes('PADCODE_ONE'), 'changed pad text is attached');
  assert(!rig.sessions.opener.calls[0].message.includes('PADCODE_ONE'), 'the opener never carries the pad');
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Okay.');
  rig.streams[1].audio(1000);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 1500);
  await flush();
  await speak(rig, 'and then', 'b');
  await rig.clock.advance(600);
  assert(!rig.sessions.main.calls[2].message.includes('PADCODE_ONE'), 'unchanged pad text is not repeated');
  rig.sessions.opener.answer('Mm.');
  rig.sessions.main.answer('Fine.');
  rig.streams[2].audio(1000);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt3', 'started');
  rig.h.playback('utt3', 'finished', 1500);
  await flush();
  rig.engine.setPadText('x = PADCODE_TWO');
  rig.engine.typed('done');
  await flush();
  assert(rig.sessions.main.calls[3].message.includes('PADCODE_TWO'), 'a typed turn carries the changed pad');
});

test('a discarded turn does not mark the pad as received', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  rig.engine.setPadText('PADCODE_KEEP');
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.h.vad(true);
  rig.h.transcript('and also', 'b');
  await flush();
  rig.h.vad(false);
  await rig.clock.advance(2500);
  const last = rig.sessions.main.calls[rig.sessions.main.calls.length - 1].message;
  assert(last.includes('PADCODE_KEEP'), 'the retried turn still carries the pad');
});

// The pad idle message: the interviewer watches the pad, so one look is sent after the candidate stops typing in it.
const PAD_IDLE = DEFAULT_CALL_THRESHOLDS.padIdleMs;
function padRig(extra = {}) {
  const options = [];
  const rig = makeRig({ createParser: screenParser, formatTurn: option => { options.push(option); return `[turn pad=${option.padText ?? '-'} idle=${option.padProgress?.idleMs ?? '-'} silence=${option.silenceCheck ?? '-'}]`; }, ...extra });
  rig.options = options;
  return rig;
}
const idleTurns = rig => rig.options.filter(option => option.padProgress !== undefined);

test('pad idle: a pad edit followed by quiet sends one message with the text and the idle time, with no opener', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('PADCODE_IDLE');
  await rig.clock.advance(PAD_IDLE - 1);
  assert.equal(rig.sessions.main.calls.length, 1, 'nothing before the idle time');
  await rig.clock.advance(1);
  assert.equal(rig.sessions.main.calls.length, 2);
  assert.equal(rig.sessions.opener.calls.length, 0, 'nothing is acknowledged first');
  assert.equal(rig.sessions.classifier.calls.length, 0);
  const turns = idleTurns(rig);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].padText, 'PADCODE_IDLE');
  assert.equal(turns[0].padProgress.idleMs, PAD_IDLE);
  assert.equal(turns[0].padProgress.typing, false);
  assert.equal(turns[0].silenceCheck, undefined, 'it is not a silence check');
  assert.equal(turns[0].silenceMs ?? null, null);
  rig.sessions.main.answer('Take your time.');
  rig.streams[1].audio(500);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1, 'it commits without waiting');
});

test('pad idle: each edit restarts the idle time, and an unchanged text is not an edit', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 100000 } });
  await greet(rig);
  rig.engine.setPadText('a');
  await rig.clock.advance(PAD_IDLE - 1000);
  rig.engine.setPadText('ab');
  await rig.clock.advance(PAD_IDLE - 1000);
  rig.engine.setPadText('ab'); // same text: the timer is not restarted
  await rig.clock.advance(1000);
  assert.equal(idleTurns(rig).length, 1);
  assert.equal(idleTurns(rig)[0].padText, 'ab');
  assert.equal(idleTurns(rig)[0].padProgress.idleMs, PAD_IDLE);
});

test('pad idle: the pad text going out with a spoken turn before the idle time means no idle message follows', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('PADCODE_SPOKEN');
  await rig.clock.advance(5000);
  await speak(rig, 'here is my approach', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Good.');
  rig.streams[rig.streams.length - 1].audio(1000);
  await flush();
  await rig.clock.advance(700);
  const spoken = rig.options.filter(option => option.padText === 'PADCODE_SPOKEN');
  assert(spoken.length >= 1, 'the spoken turn carries the pad text');
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 1500);
  await flush();
  await rig.clock.advance(PAD_IDLE * 2);
  assert.equal(idleTurns(rig).length, 0, 'no idle message');
});

test('pad idle: a typed chat turn before the idle time carries the pad and no idle message follows', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('PADCODE_CHAT');
  await rig.clock.advance(3000);
  rig.engine.typed('done');
  await flush();
  assert.equal(rig.options.filter(option => option.padText === 'PADCODE_CHAT').length, 1);
  rig.sessions.opener.answer('Ok.');
  rig.sessions.main.answer('Fine.');
  rig.streams[1].audio(500);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 800);
  await flush();
  await rig.clock.advance(PAD_IDLE * 2);
  assert.equal(idleTurns(rig).length, 0);
});

test('pad idle: after a listen reply there is no second idle message, silence checks proceed, and a new edit allows a new one', async () => {
  const rig = padRig({ createParser: patienceParser });
  await greet(rig);
  rig.engine.setPadText('PADCODE_ONE');
  await rig.clock.advance(PAD_IDLE);
  assert.equal(idleTurns(rig).length, 1);
  rig.sessions.main.answer('<listen/>', { chunks: ['<listen/>'] });
  await flush();
  await rig.clock.advance(PAD_IDLE * 3);
  assert.equal(idleTurns(rig).length, 1, 'no second idle message without new edits');
  const checks = rig.options.filter(option => option.silenceCheck !== undefined);
  assert.equal(checks.length, 1, 'the silence wait started from zero after the idle message');
  assert.equal(checks[0].silenceCheck, 1, 'the idle message did not count toward the three');
  rig.sessions.main.answer('<listen/>', { chunks: ['<listen/>'] });
  await flush();
  rig.engine.setPadText('PADCODE_TWO');
  await rig.clock.advance(PAD_IDLE);
  assert.equal(idleTurns(rig).length, 2, 'a new burst allows a new idle message');
});

test('pad idle: the silence wait starts from zero after the idle message, with the reply wait', async () => {
  const rig = padRig({ createParser: patienceParser });
  await greet(rig);
  rig.engine.setPadText('PADCODE_WAIT');
  await rig.clock.advance(PAD_IDLE);
  rig.sessions.main.answer('<listen/><wait s="60"/>', { chunks: ['<listen/><wait s="60"/>'] });
  await flush();
  await rig.clock.advance(59000);
  assert.equal(rig.options.filter(option => option.silenceCheck !== undefined).length, 0);
  await rig.clock.advance(1000);
  assert.equal(rig.options.filter(option => option.silenceCheck !== undefined).length, 1);
});

test('pad idle: while the interviewer is speaking it waits, then goes out when the reply is over', async () => {
  const rig = padRig();
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Let me explain a long thing.');
  rig.streams[1].audio(24000 * 2 * 40); // 40 s of audio, so the playback watchdog stays quiet
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.engine.setPadText('PADCODE_SPEAKING');
  await rig.clock.advance(PAD_IDLE + 3000);
  assert.equal(idleTurns(rig).length, 0, 'not sent while the interviewer is speaking');
  rig.h.playback('utt2', 'finished', 1500);
  await flush();
  assert.equal(idleTurns(rig).length, 1, 'sent once the reply is over, the idle time having passed');
  assert.equal(idleTurns(rig)[0].padText, 'PADCODE_SPEAKING');
  assert(idleTurns(rig)[0].padProgress.idleMs >= PAD_IDLE + 3000);
});

test('pad idle: typing in the pad holds it until the typing signal lapses', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('PADCODE_TYPING');
  rig.engine.typing(true);
  await rig.clock.advance(PAD_IDLE - 1000);
  rig.engine.typing(true); // refreshed: still typing
  await rig.clock.advance(2000);
  assert.equal(idleTurns(rig).length, 0, 'held while typing is signalled');
  rig.engine.typing(false);
  assert.equal(idleTurns(rig).length, 1, 'sent as soon as typing stops, the idle time having passed');
});

test('pad idle: a pause during the idle wait stops it, and resuming restarts the wait from zero', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('PADCODE_PAUSE');
  await rig.clock.advance(5000);
  rig.engine.setPaused(true);
  await rig.clock.advance(PAD_IDLE * 3);
  assert.equal(idleTurns(rig).length, 0);
  assert.equal(rig.clock.pending(), 0, 'no timer is left armed during the pause');
  rig.engine.setPadText('PADCODE_PAUSE_MORE'); // an edit during a pause opens no new wait
  await rig.clock.advance(PAD_IDLE * 3);
  assert.equal(idleTurns(rig).length, 0);
  rig.engine.setPaused(false);
  await rig.clock.advance(PAD_IDLE - 1);
  assert.equal(idleTurns(rig).length, 0);
  await rig.clock.advance(1);
  assert.equal(idleTurns(rig).length, 1);
  assert.equal(idleTurns(rig)[0].padText, 'PADCODE_PAUSE_MORE');
});

test('pad idle: an edit made only during a pause opens no burst', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPaused(true);
  rig.engine.setPadText('PADCODE_ONLY_PAUSED');
  rig.engine.setPaused(false);
  await rig.clock.advance(PAD_IDLE * 2);
  assert.equal(idleTurns(rig).length, 0);
});

test('pad idle: hanging up during the idle wait sends nothing and leaves no timer', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('PADCODE_HANGUP');
  await rig.clock.advance(5000);
  rig.engine.hangUp();
  assert.equal(rig.clock.pending(), 0);
  await rig.clock.advance(PAD_IDLE * 2);
  assert.equal(idleTurns(rig).length, 0);
  assert.equal(rig.sessions.main.calls.length, 1);
  rig.engine.setPadText('late edit');
  assert.equal(rig.clock.pending(), 0, 'a pad edit after the call ended arms nothing');
});

test('pad idle: an unchanged-since-received or emptied pad sends nothing', async () => {
  const rig = padRig();
  await greet(rig);
  rig.engine.setPadText('x');
  rig.engine.setPadText('');
  await rig.clock.advance(PAD_IDLE * 2);
  assert.equal(idleTurns(rig).length, 0, 'an empty pad has nothing to show');
});

// Pad progress: periodic looks while the pad keeps changing.
const PAD_PROGRESS = DEFAULT_CALL_THRESHOLDS.padProgressMs;
const listenReply = async rig => { rig.sessions.main.answer('<listen/>', { chunks: ['<listen/>'] }); await flush(); };

test('pad progress: steady typing for 80 s gives messages at about 25, 50 and 75 s, each marked as still typing', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 1000000 } });
  await greet(rig);
  const times = [];
  for (let t = 0; t < 80000; t += 2000) {
    rig.engine.setPadText(`PADCODE_STEADY_${t}`);
    await rig.clock.advance(2000);
    if (idleTurns(rig).length > times.length) { times.push(t + 2000); await listenReply(rig); }
  }
  assert.deepEqual(times, [26000, 52000, 78000]);
  assert(idleTurns(rig).every(option => option.padProgress.typing === true));
  assert(idleTurns(rig).every(option => option.candidateText === '' && option.silenceCheck === undefined));
});

test('pad progress: writing in the pad holds the silence checks by itself, with no typing signal', async () => {
  const rig = padRig({});
  await greet(rig);
  // Four minutes of steady edits and only silent replies: no silence check may fire and the call stays up.
  for (let t = 0; t < 240000; t += 3000) {
    rig.engine.setPadText(`PADCODE_HOLD_${t}`);
    await rig.clock.advance(3000);
    if (idleTurns(rig).length && rig.engine.state().phase !== 'ended') await listenReply(rig).catch(() => {});
  }
  assert.equal(rig.options.filter(option => option.silenceCheck !== undefined).length, 0, 'no silence check while the candidate writes');
  assert.notEqual(rig.engine.state().phase, 'ended');
});

test('pad progress: typing for 10 s then stopping gives one message 12 s after the last edit, and none after', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 1000000 } });
  await greet(rig);
  for (let t = 0; t < 10000; t += 2000) { rig.engine.setPadText(`PADCODE_STOP_${t}`); await rig.clock.advance(2000); }
  await rig.clock.advance(PAD_IDLE - 2000 - 1); // 12 s after the last edit minus 1 ms
  assert.equal(idleTurns(rig).length, 0);
  await rig.clock.advance(1);
  assert.equal(idleTurns(rig).length, 1);
  assert.deepEqual(idleTurns(rig)[0].padProgress, { typing: false, idleMs: PAD_IDLE });
  await listenReply(rig);
  await rig.clock.advance(PAD_PROGRESS * 4);
  assert.equal(idleTurns(rig).length, 1, 'nothing changed since the interviewer last had it');
});

test('pad progress: a listen reply leaves no trace, no check is counted, and the next silence check is number 1', async () => {
  const rig = padRig({ createParser: patienceParser });
  await greet(rig);
  for (let i = 0; i < 4; i += 1) {
    rig.engine.setPadText(`PADCODE_QUIET_${i}`);
    await rig.clock.advance(PAD_IDLE);
    assert.equal(idleTurns(rig).length, i + 1);
    await listenReply(rig);
  }
  assert.equal(rig.opsOf('play').filter(item => item.id !== 'utt1').length, 0, 'nothing was spoken');
  await rig.clock.advance(DEFAULT_CALL_THRESHOLDS.silencePromptMs);
  const checks = rig.options.filter(option => option.silenceCheck !== undefined);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].silenceCheck, 1);
});

test('pad progress: a spoken turn carrying the pad restarts the 25 s clock', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 1000000 } });
  await greet(rig);
  for (let t = 0; t < 20000; t += 2000) { rig.engine.setPadText(`PADCODE_CLOCK_0_${t}`); await rig.clock.advance(2000); }
  assert.equal(idleTurns(rig).length, 0, 'typing steadily for 20 s: not yet');
  rig.engine.typed('quick question');
  await flush();
  rig.sessions.opener.answer('Sure.');
  rig.sessions.main.answer('Go on.');
  rig.streams[1].audio(500);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 800);
  await flush();
  const carried = rig.options.filter(option => option.padText === 'PADCODE_CLOCK_0_18000' && option.padProgress === undefined);
  assert.equal(carried.length >= 1, true);
  for (let t = 0; t < 20000; t += 2000) { rig.engine.setPadText(`PADCODE_CLOCK_${t + 1}`); await rig.clock.advance(2000); }
  assert.equal(idleTurns(rig).length, 0, 'about 20 s after the turn: not yet');
  for (let t = 0; t < 6000; t += 2000) { rig.engine.setPadText(`PADCODE_CLOCK_B${t}`); await rig.clock.advance(2000); }
  assert.equal(idleTurns(rig).length, 1, 'about 25 s after the turn');
});

test('pad progress: held while the interviewer speaks, typing does not cut the comment, and at most one goes out afterwards', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 1000000 } });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Let me explain a long thing.');
  rig.streams[1].audio(24000 * 2 * 100);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  for (let t = 0; t < 70000; t += 2000) { rig.engine.setPadText(`PADCODE_HELD_${t}`); await rig.clock.advance(2000); }
  assert.equal(idleTurns(rig).length, 0, 'nothing while the interviewer is speaking');
  assert.equal(rig.opsOf('cancel').length, 0, 'typing did not cut the interviewer off');
  rig.h.playback('utt2', 'finished', 1500);
  await flush();
  assert.equal(idleTurns(rig).length, 1, 'one message when the comment is over, not a burst');
  await listenReply(rig);
  assert.equal(idleTurns(rig).length, 1);
});

test('pad progress: held while the candidate speaks and while a reply is being made', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 1000000 } });
  await greet(rig);
  rig.engine.setPadText('PADCODE_VOICE');
  rig.h.vad(true);
  await rig.clock.advance(PAD_PROGRESS * 2);
  assert.equal(idleTurns(rig).length, 0, 'the candidate is speaking');
  rig.h.vad(false);
  rig.h.vad(true); // leave the voice state as speaking until a transcript completes the turn
  rig.h.vad(false);
  await rig.clock.advance(100);
  rig.h.transcript('here is my idea', 'a');
  await flush();
  await rig.clock.advance(2000);
  assert(rig.sessions.main.calls.length >= 2, 'a turn is being made');
  const before = idleTurns(rig).length;
  rig.engine.setPadText('PADCODE_VOICE_2');
  await rig.clock.advance(PAD_PROGRESS * 2);
  assert.equal(idleTurns(rig).length, before, 'not while a reply is being generated');
});

test('pad progress: a spoken reply to a progress message is delivered like any other', async () => {
  const rig = padRig({ thresholds: { silencePromptMs: 1000000 } });
  await greet(rig);
  rig.engine.setPadText('PADCODE_COMMENT');
  await rig.clock.advance(PAD_IDLE);
  rig.sessions.main.answer('Why a hash map there?');
  rig.streams[1].audio(500);
  await flush();
  assert.equal(rig.opsOf('play').filter(item => item.id === 'utt2').length, 1);
  rig.engine.setPadText('PADCODE_COMMENT_MORE'); // typing while it speaks
  assert.equal(rig.opsOf('cancel').length, 0);
});

test('pad progress: hanging up clears the timers', async () => {
  const rig = padRig();
  await greet(rig);
  for (let t = 0; t < 10000; t += 2000) { rig.engine.setPadText(`PADCODE_END_${t}`); await rig.clock.advance(2000); }
  rig.engine.hangUp();
  assert.equal(rig.clock.pending(), 0);
  await rig.clock.advance(PAD_PROGRESS * 3);
  assert.equal(idleTurns(rig).length, 0);
});

test('the Ready button is gone from the engine', () => {
  const rig = makeRig();
  assert.equal(rig.engine.submitPad, undefined);
});

test('pad activity: typing in the pad holds back silence check-ins', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  rig.engine.typing(true);
  const calls = rig.sessions.main.calls.length;
  await rig.clock.advance(DEFAULT_CALL_THRESHOLDS.silencePromptMs - 1000);
  assert.equal(rig.sessions.main.calls.length, calls);
});

test('setPadText caps the text and the engine ignores pad calls after the call ended', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  rig.engine.setPadText('q'.repeat(30000));
  rig.engine.typed('done');
  await flush();
  const message = rig.sessions.main.calls[1].message;
  assert(!message.includes('q'.repeat(7000)), 'the message cuts the pad');
  rig.engine.hangUp();
  const calls = rig.sessions.main.calls.length;
  rig.engine.typed('late chat');
  rig.engine.setPadText('late');
  await flush();
  assert.equal(rig.sessions.main.calls.length, calls);
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

test('every spoken entry carries integer helper-timeline start and end: candidate by words, interviewer by playback', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(rig);
  const t0 = rig.clock.now();
  rig.h.vad(true);
  rig.h.transcript('I built a scheduler', 'a', t0, false, t0 + 900);
  await rig.clock.advance(900);
  rig.h.vad(false);
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right, got it.');
  await flush();
  rig.sessions.main.answer('Tell me about the design. What was hard?');
  rig.streams[1].audio(1000);
  await rig.clock.advance(600);
  rig.h.playback('utt2', 'started');
  const startedAt = rig.clock.now();
  await rig.clock.advance(1500);
  rig.h.playback('utt2', 'finished', 3300);
  await flush();
  const entries = rig.engine.state().transcript;
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert(Number.isInteger(entry.startMs) && Number.isInteger(entry.endMs) && entry.endMs >= entry.startMs, JSON.stringify(entry));
  }
  assert.deepEqual([entries[1].startMs, entries[1].endMs], [t0 - HELPER_OFFSET, t0 + 900 - HELPER_OFFSET], 'first word start to last word end');
  assert.deepEqual([entries[2].startMs, entries[2].endMs], [startedAt - HELPER_OFFSET, startedAt + 1500 - HELPER_OFFSET], 'playback start to playback end');
});

test('an interrupted interviewer entry ends at the cut point and an acknowledgement entry spans the words', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  const startedAt = rig.clock.now();
  await shortOverlap(rig, 'right');
  rig.sessions.classifier.answer('acknowledgement');
  await flush();
  const ack = rig.engine.state().transcript.find(entry => entry.acknowledgement);
  assert(Number.isInteger(ack.startMs) && Number.isInteger(ack.endMs) && ack.endMs >= ack.startMs, JSON.stringify(ack));
  assert.equal(ack.startMs, startedAt - HELPER_OFFSET);
  const stoppingRig = makeRig();
  await greet(stoppingRig);
  await toPlaying(stoppingRig);
  stoppingRig.h.playback('utt2', 'position', 650);
  await stoppingRig.clock.advance(650);
  stoppingRig.h.playback('utt2', 'cancelled', 1300);
  await flush();
  const cut = stoppingRig.engine.state().transcript.pop();
  assert.equal(cut.endMs - cut.startMs, 650, 'the entry ends where playback was cut');
});

test('a wordless noise that paused the reply resumes it after maxPausedMs instead of cutting it for good', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  rig.h.vad(true); // no transcript word: a cough or a bump
  await rig.clock.advance(400);
  rig.h.vad(false);
  await rig.clock.advance(200); // the boundary pause lands
  assert.equal(rig.opsOf('pause').filter(item => item.id === 'utt2').length, 1);
  await rig.clock.advance(2600); // past maxPausedMs
  assert.equal(cancelsOf(rig, 'utt2'), 0, 'the reply is not cut');
  assert.equal(rig.opsOf('resume').filter(item => item.id === 'utt2').length, 1);
  rig.h.playback('utt2', 'finished', 3300);
  await flush();
  assert.equal(rig.engine.state().phase, 'listening');
});

test('a paused reply cut by maxPausedMs for a long noise re-arms the silence prompt', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  rig.h.vad(true);
  await rig.clock.advance(1000); // longer than interruptMs, still no words
  rig.h.vad(false);
  await rig.clock.advance(3500); // past maxPausedMs
  assert.equal(cancelsOf(rig, 'utt2'), 1, 'a long noise is still treated as an interruption');
  rig.h.playback('utt2', 'cancelled', 300);
  await flush();
  const before = rig.sessions.main.calls.length;
  await rig.clock.advance(20000);
  assert(rig.sessions.main.calls.slice(before).some(call => /candidate silent 20s/.test(call.message)), 'the call does not go quiet for good');
});

test('listen from opener or main on a typed turn counts as pass: kept once, nothing spoken', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('3 years at Acme, mostly Go');
  await flush();
  rig.sessions.opener.answer('<listen/>');
  await flush();
  assert.equal(rig.of('discarded').length, 0, 'a typed-line listen from the opener is only "no reaction"');
  rig.sessions.main.answer('<listen/>');
  await flush();
  assert(rig.of('discarded').every(item => item.reason === 'pass'), JSON.stringify(rig.of('discarded')));
  assert.equal(rig.of('discarded').length, 1);
  const entries = rig.engine.state().transcript;
  assert.equal(entries.filter(entry => entry.channel === 'chat' && entry.text === '3 years at Acme, mostly Go').length, 1, 'the typed line is in the transcript once');
});

test('typing expires six seconds after the last refresh and re-arms the silence prompt', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typing(true);
  await rig.clock.advance(5000);
  rig.engine.typing(true);
  await rig.clock.advance(5999);
  assert.equal(rig.sessions.main.calls.length, 1);
  await rig.clock.advance(1); // 6 s after the last refresh
  assert.equal(rig.sessions.main.calls.length, 1);
  await rig.clock.advance(19999);
  assert.equal(rig.sessions.main.calls.length, 1);
  await rig.clock.advance(1);
  assert.equal(rig.sessions.main.calls.length, 2, 'the silence prompt returns once typing lapsed');
  assert(!/candidate is typing/.test(rig.sessions.main.calls[1].message));
});

test('spoken words not yet answered are kept when a typed message arrives, ahead of the typed turn', async () => {
  const rig = makeRig();
  await greet(rig);
  await speculate(rig, 'I built a scheduler', 'a'); // speculating: opener and main running, not committed
  rig.engine.typed('here is the link');
  await flush();
  const entries = rig.engine.state().transcript;
  assert.equal(entries.length, 1, 'nothing committed yet');
  const last = rig.sessions.main.calls[rig.sessions.main.calls.length - 1];
  assert(last.message.includes("Candidate: 'I built a scheduler'"), last.message);
  assert(last.message.includes("Candidate (typed in chat): 'here is the link'"), last.message);
  assert(last.message.indexOf("Candidate: 'I built") < last.message.indexOf('Candidate (typed'));
  rig.sessions.opener.answer('Okay.');
  rig.sessions.main.answer('Thanks.');
  rig.streams[rig.streams.length - 1].audio(300);
  await flush();
  const turn = rig.engine.state().transcript.slice(1, 3);
  assert.deepEqual(turn.map(entry => [entry.speaker, entry.channel, entry.text]), [
    ['candidate', undefined, 'I built a scheduler'],
    ['candidate', 'chat', 'here is the link'],
  ]);
  assert(Number.isInteger(turn[0].startMs) && turn[0].endMs >= turn[0].startMs);
});

test('typed text over a committed spoken reply does not re-send the words that reply already answered', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.engine.typed('wait what is that');
  await rig.clock.advance(300);
  rig.h.playback('utt2', 'cancelled', 900);
  await flush();
  const message = rig.sessions.opener.calls[1].message;
  assert(!message.includes("Candidate: 'I built a scheduler'"), message);
});

test('a main restart after a cut-off reply carries the candidate answer the reply was for', async () => {
  const rig = makeRig({ thresholds: { voiceGateMs: 600 } });
  await greet(rig);
  await speculate(rig, 'I built a scheduler', 'a');
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.calls[1].onDelta('Tell me more. ');
  await flush();
  rig.sessions.main.fail();
  await flush();
  assert.equal(rig.restarts.length, 1);
  assert.equal(rig.restarts[0].kind, 'main');
  assert(rig.restarts[0].transcriptText.includes("Candidate: 'I built a scheduler'"), rig.restarts[0].transcriptText);
});

test('a main turn that produces nothing for 20 s is restarted and resent once, then ends the call', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('Here is my code');
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2);
  await rig.clock.advance(19999);
  assert.equal(rig.restarts.length, 0);
  await rig.clock.advance(1);
  assert(rig.restarts.some(item => item.kind === 'main'));
  assert.equal(rig.sessions.main.calls.length, 1, 'the fresh session got the resent turn');
  assert.match(rig.sessions.main.calls[0].message, /Candidate \(typed in chat\): 'Here is my code'/);
  await rig.clock.advance(20000);
  assert.deepEqual(rig.of('ended').map(event => event.reason), ['session-error']);
});

test('a turn that keeps streaming is not timed out, and one that stalls mid-stream is cut off after 20 s', async () => {
  const rig = makeRig();
  await greet(rig);
  rig.engine.typed('Here is my code');
  await flush();
  const stalled = rig.sessions.main.calls[1];
  stalled.onDelta('Sure. ');
  for (let step = 0; step < 6; step += 1) {
    await rig.clock.advance(10000);
    rig.sessions.main.calls[1].onDelta('And more. ');
  }
  assert.equal(rig.restarts.length, 0, 'every delta restarts the deadline');
  await rig.clock.advance(19999);
  assert.equal(rig.restarts.length, 0);
  await rig.clock.advance(1);
  assert(rig.restarts.some(item => item.kind === 'main'), 'the stalled main is restarted like any cut-off main');
  assert(stalled.signal.aborted);
});

test('a typed message sent during the last word of a reply is answered when the reply finishes on its own', async () => {
  const rig = makeRig();
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 3100); // inside the last word, which ends at 3280
  rig.engine.typed('one more thing');
  await flush();
  assert.equal(rig.sessions.opener.calls.length, 1, 'the stop waits for the word boundary');
  rig.h.playback('utt2', 'finished', 3280);
  await flush();
  assert.equal(rig.sessions.opener.calls.length, 2, 'the typed turn starts without another message');
  assert(rig.sessions.opener.calls[1].message.endsWith(typedMessage('one more thing')));
});

test('a typed message sent while an overlap has paused the reply is answered when that overlap stops the reply', async () => {
  const rig = makeRig({ ear: makeEar({ floorBid: () => ({ decision: 'pause' }) }) });
  await greet(rig);
  await toPlaying(rig);
  rig.h.playback('utt2', 'position', 100);
  rig.h.vad(true);
  await rig.clock.advance(600); // the boundary pause lands
  assert.equal(rig.opsOf('pause').filter(item => item.id === 'utt2').length, 1);
  rig.engine.typed('wait a second');
  await flush();
  rig.h.transcript('wait what do you mean', 'o1', rig.clock.now());
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1);
  rig.h.playback('utt2', 'cancelled', 280);
  await flush();
  assert(rig.sessions.opener.calls.some(call => call.message.includes(typedMessage('wait a second'))), 'the queued typed text is answered');
});

test('repeated wordless noise does not reset the silence count, but a spoken word does', async () => {
  const rig = makeRig();
  await greet(rig);
  const finishPrompt = async () => {
    rig.sessions.main.answer('Still there?');
    rig.streams[rig.streams.length - 1].audio(300);
    await flush();
    const id = `utt${rig.streams.length}`;
    rig.h.playback(id, 'started');
    rig.h.playback(id, 'finished', 600);
    await flush();
  };
  const lastSilence = () => rig.sessions.main.calls[rig.sessions.main.calls.length - 1].message.match(/candidate silent (\d+)s/)?.[1];
  await rig.clock.advance(20000);
  assert.equal(lastSilence(), '20');
  await finishPrompt();
  rig.h.vad(true); // a cough
  await rig.clock.advance(200);
  rig.h.vad(false);
  await rig.clock.advance(32000);
  assert.equal(lastSilence(), '40', 'the cough did not start the count over');
});

test('silence prompts back off, report the real cumulative silence, and reset when the candidate speaks', async () => {
  const rig = makeRig();
  await greet(rig);
  const silentRuns = [];
  const finishPrompt = async () => {
    rig.sessions.main.answer('Still there?');
    rig.streams[rig.streams.length - 1].audio(300);
    await flush();
    const id = `utt${rig.streams.length}`;
    rig.h.playback(id, 'started');
    rig.h.playback(id, 'finished', 600);
    await flush();
  };
  for (const wait of [20000, 20000, 30000]) {
    await rig.clock.advance(wait - 1);
    const before = rig.sessions.main.calls.length;
    await rig.clock.advance(1);
    assert.equal(rig.sessions.main.calls.length, before + 1, `prompt after ${wait} ms`);
    silentRuns.push(rig.sessions.main.calls[rig.sessions.main.calls.length - 1].message.match(/candidate silent (\d+)s/)?.[1]);
    await finishPrompt();
  }
  assert.deepEqual(silentRuns, ['20', '40', '70']);
  rig.h.vad(true);
  rig.h.transcript('here', 'r1');
  rig.h.vad(false);
  await rig.clock.advance(1200);
  rig.sessions.opener.answer('Good.');
  rig.sessions.main.answer('Great.');
  rig.streams[rig.streams.length - 1].audio(300);
  await rig.clock.advance(1200);
  const replyId = `utt${rig.streams.length}`;
  rig.h.playback(replyId, 'started');
  rig.h.playback(replyId, 'finished', 600);
  await flush();
  const calls = rig.sessions.main.calls.length;
  await rig.clock.advance(20000);
  assert(rig.sessions.main.calls.length > calls, 'after the candidate spoke, the first prompt is back to 20 s');
});

// ---- asked marker ------------------------------------------------------------
// A stub parser that turns <asked n="N"/> into { asked: N } items, so these tests do not depend on the real parser.
function askedParser() {
  const real = createReplyStreamParser();
  const pending = [];
  const strip = text => text.replace(/<asked n="([^"]*)"\/>/g, (_, n) => { pending.push(Number(n)); return ''; });
  const merge = snapshot => {
    const items = [...pending.splice(0).map(asked => ({ asked })), ...(snapshot.items ?? snapshot.sentences.map(sentence => ({ sentence })))];
    return { ...snapshot, items };
  };
  return { push: text => merge(real.push(strip(text))), end: () => merge(real.end()) };
}

async function askedReply(rig, text) {
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer(text);
  rig.streams[rig.streams.length - 1].audio(1000);
  await flush();
  await rig.clock.advance(700);
}

test('asked marker: counted when the reply is delivered, once per number, in first-asked order', async () => {
  const rig = makeRig({ createParser: askedParser });
  await greet(rig);
  assert.deepEqual(rig.engine.state().askedQuestions, []);
  await askedReply(rig, '<asked n="3"/>Tell me about a scheduler you built.');
  assert.deepEqual(rig.engine.state().askedQuestions, [3]);
  assert.deepEqual(rig.of('question-asked').map(event => event.number), [3]);
  assert.equal(rig.of('question-asked')[0].kind, 'question-asked');
  const id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 1500);
  await flush();
  await askedReply(rig, '<asked n="1"/>Next one. <asked n="3"/>And again. <asked n="0"/><asked n="2.5"/><asked n="7"/>Last.');
  assert.deepEqual(rig.engine.state().askedQuestions, [3, 1, 7], 'repeats and non-positive or fractional numbers are ignored');
  assert.deepEqual(rig.of('question-asked').map(event => event.number), [3, 1, 7]);
});

test('asked marker: a speculative reply discarded because the candidate kept talking counts nothing', async () => {
  const rig = makeRig({ createParser: askedParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.main.answer('<asked n="4"/>Why a scheduler?');
  await flush();
  rig.h.vad(true);
  rig.h.transcript('and also', 'b');
  await flush();
  assert.deepEqual(rig.engine.state().askedQuestions, [], 'not committed, not counted');
  assert.deepEqual(rig.of('question-asked'), []);
});

test('asked marker: engine reports an empty list when nothing was asked, and ids B to E are not special', async () => {
  const rig = makeRig({ createParser: askedParser });
  await greet(rig);
  assert.deepEqual(rig.engine.state().askedQuestions, []);
  const source = fs.readFileSync(new URL('../../electron/interviewPracticeCallEngine.js', import.meta.url), 'utf8');
  assert(!/['"]C['"]/.test(source), 'no hard-coded colleague ids in the engine');
});


// ---- pause patience (<wait>) and overlays (<over>) --------------------------------
// A stub parser for the new tags, so these tests do not depend on the real parser: <wait s="N"/>, <over id="X">text</over>,
// <speaker id="X"/>; everything between the tags is one sentence piece.
function tagParser() {
  const run = text => {
    const items = [];
    for (const part of text.split(/(<wait s="\d+"\/>|<over id="[A-Z]">[^<]*<\/over>|<speaker id="[A-Z]"(?: cut)?\/>)/)) {
      const wait = part.match(/^<wait s="(\d+)"\/>$/);
      const over = part.match(/^<over id="([A-Z])">([^<]*)<\/over>$/);
      const spk = part.match(/^<speaker id="([A-Z])"(?: cut)?\/>$/);
      if (wait) items.push({ wait: Number(wait[1]) });
      else if (over) items.push({ over: { speakerId: over[1], text: over[2] } });
      else if (spk) items.push(part.includes('cut') ? { speaker: spk[1], cutIn: true } : { speaker: spk[1] });
      else if (part.trim()) items.push({ sentence: part.trim() });
    }
    return { chats: [], sentences: items.filter(item => item.sentence).map(item => item.sentence), items, control: null, endCall: false };
  };
  return { push: run, end: () => ({ chats: [], sentences: [], items: [], control: null, endCall: false }) };
}

async function playOut(rig) {
  const id = `utt${rig.streams.length}`;
  rig.h.playback(id, 'started');
  rig.h.playback(id, 'finished', 1500);
  await flush();
}

/** Advance to just before and then to a check-in; returns the cumulative silence it reports. */
async function checkInAt(rig, seconds, label) {
  const before = rig.sessions.main.calls.length;
  await rig.clock.advance(seconds * 1000 - 1);
  assert.equal(rig.sessions.main.calls.length, before, `${label}: not before ${seconds} s`);
  await rig.clock.advance(1);
  assert.equal(rig.sessions.main.calls.length, before + 1, `${label}: check-in after ${seconds} s`);
  return Number(rig.sessions.main.calls[before].message.match(/candidate silent (\d+)s/)?.[1]);
}

async function answerCheckIn(rig, text) {
  rig.sessions.main.answer(text);
  rig.streams[rig.streams.length - 1].audio(300);
  await flush();
  await playOut(rig);
}

test('wait tag: the last delivered reply sets the first check-in, then gaps of clamp(W,12,30) and clamp(1.5W,20,45)', async () => {
  const rig = makeRig({ createParser: tagParser });
  await greet(rig);
  await deliver(rig, '<wait s="10"/>Take your time with it.<wait s="90"/>');
  assert.equal(await checkInAt(rig, 90, 'first'), 90, 'the last wait of the reply counts');
  await answerCheckIn(rig, 'Still there?');
  assert.equal(await checkInAt(rig, 30, 'second'), 120, 'gap2 = clamp(90, 12, 30)');
  await answerCheckIn(rig, 'Can you hear me?');
  assert.equal(await checkInAt(rig, 45, 'third'), 165, 'gap3 = clamp(135, 20, 45)');
});

test('wait tag: a short wait gives short gaps, bounds are 6..300 s, and no tag means the 20/40/70 default', async () => {
  const short = makeRig({ createParser: tagParser });
  await greet(short);
  await deliver(short, 'Hi.<wait s="2"/>');
  assert.equal(await checkInAt(short, 6, 'clamped up'), 6);
  await answerCheckIn(short, 'Hello?');
  assert.equal(await checkInAt(short, 12, 'gap2 floor'), 18);
  await answerCheckIn(short, 'Can you hear me?');
  assert.equal(await checkInAt(short, 20, 'gap3 floor'), 38);

  const long = makeRig({ createParser: tagParser });
  await greet(long);
  await deliver(long, 'Solve it.<wait s="900"/>');
  assert.equal(await checkInAt(long, 300, 'clamped down'), 300);

  const plain = makeRig({ createParser: tagParser });
  await greet(plain);
  await deliver(plain, 'Tell me more.');
  assert.equal(await checkInAt(plain, 20, 'first'), 20);
  await answerCheckIn(plain, 'Still there?');
  assert.equal(await checkInAt(plain, 20, 'second'), 40);
  await answerCheckIn(plain, 'Hello?');
  assert.equal(await checkInAt(plain, 30, 'third'), 70);
});

test('wait tag: a check-in reply that carries its own wait sets the gap to the next check-in', async () => {
  const rig = makeRig({ createParser: tagParser });
  await greet(rig);
  await deliver(rig, 'Go ahead.<wait s="40"/>');
  assert.equal(await checkInAt(rig, 40, 'first'), 40);
  await answerCheckIn(rig, 'Need a minute?<wait s="100"/>');
  assert.equal(await checkInAt(rig, 100, 'own wait'), 140);
  await answerCheckIn(rig, 'Still here?');
  assert.equal(await checkInAt(rig, 45, 'back to the schedule: gap3 = clamp(60, 20, 45)'), 185);
});

test('wait tag: a reply that is never delivered counts for nothing, and the candidate speaking resets it', async () => {
  const rig = makeRig({ createParser: tagParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.main.answer('Why a scheduler?<wait s="200"/>');
  await flush();
  rig.h.vad(true);
  rig.h.transcript('and also', 'b');
  await flush();
  await deliver(rig, 'Okay.');
  assert.equal(await checkInAt(rig, 20, 'default'), 20, 'the discarded wait left no trace');
});

test('wait tag: typing in the chat still holds the check-ins', async () => {
  const rig = makeRig({ createParser: tagParser });
  await greet(rig);
  await deliver(rig, 'Write it out.<wait s="30"/>');
  rig.engine.typing(true);
  await rig.clock.advance(5000);
  rig.engine.typing(true);
  await rig.clock.advance(30000);
  const calls = rig.sessions.main.calls.length;
  await rig.clock.advance(1000);
  assert.equal(rig.sessions.main.calls.length, calls, 'no check-in while typing');
});

const overGreeting = async (rig, text) => {
  rig.engine.start();
  await flush();
  rig.h.level();
  rig.sessions.main.answer(text);
  rig.streams[0].audio(3200);
  await flush();
};

test('overlay: a remark by a colleague is sent to the voice at the tag point and emitted, recorded and captioned when it plays', async () => {
  const rig = panelRig({ createParser: tagParser });
  await overGreeting(rig, 'I am Priya,<over id="B">Hi Jack.</over> and I lead the team.');
  const stream = rig.streams[0];
  assert.deepEqual(stream.texts, ['I am Priya,', 'and I lead the team.'], 'the lead sentence is not split by the remark');
  assert.deepEqual(stream.overlays, [{ speakerId: 'B', text: 'Hi Jack.', afterChars: 'I am Priya,'.replace(/\s/g, '').length }]);
  assert.deepEqual(stream.log.map(item => Object.keys(item)[0]), ['text', 'overlay', 'text'], 'the overlay request sits between the texts');
  stream.overlayCb({ speakerId: 'B', text: 'Hi Jack.', offsetMs: 900 });
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 500);
  await flush();
  assert.deepEqual(rig.of('overlay'), [], 'not before playback reaches it');
  rig.h.playback('utt1', 'position', 1000);
  await flush();
  const [event] = rig.of('overlay');
  assert.deepEqual({ type: event.type, speakerId: event.speakerId, text: event.text }, { type: 'overlay', speakerId: 'B', text: 'Hi Jack.' });
  assert(Number.isFinite(event.atMs));
  const entry = rig.engine.state().transcript.find(item => item.overlay);
  assert.deepEqual({ speaker: entry.speaker, speakerId: entry.speakerId, text: entry.text, overlay: entry.overlay }, { speaker: 'interviewer', speakerId: 'B', text: 'Hi Jack.', overlay: true });
  assert(rig.of('caption').some(item => item.speakerId === 'B' && item.text === 'Hi Jack.'));
  assert.equal(rig.engine.state().transcript.find(item => !item.overlay && item.speaker === 'interviewer').text, 'I am Priya, and I lead the team.');
  rig.h.playback('utt1', 'position', 1100);
  await flush();
  assert.equal(rig.of('overlay').length, 1, 'once');
});

test('overlay: a finished utterance shows an overlay whose position event never arrived', async () => {
  const rig = panelRig({ createParser: tagParser });
  await overGreeting(rig, 'Welcome.<over id="B">Hi.</over> Glad to have you.');
  rig.streams[0].overlayCb({ speakerId: 'B', text: 'Hi.', offsetMs: 400 });
  await playOut(rig);
  assert.equal(rig.of('overlay').length, 1);
});

test('overlay: an uncast id, the current speaker, a second remark or a missing id produce nothing', async () => {
  const rig = panelRig({ createParser: tagParser });
  await overGreeting(rig, 'One.<over id="Z">Hi.</over> Two.<over id="A">Self.</over> Three.<over id="B">First.</over><over id="B">Second.</over> Four.');
  assert.deepEqual(rig.streams[0].overlays.map(item => item.text), ['First.'], 'only the first valid remark, once');
  const solo = makeRig({ createParser: tagParser });
  await overGreeting(solo, 'Welcome.<over id="B">Hi.</over> Go on.');
  assert.deepEqual(solo.streams[0].texts, ['Welcome.', 'Go on.'], 'a call with no panel ignores the tag, never speaking it');
});

test('overlay: a voice without overlay support speaks the main text untouched and emits nothing', async () => {
  const rig = panelRig({ createParser: tagParser, overlayVoice: false });
  await overGreeting(rig, 'Welcome.<over id="B">Hi.</over> Go on.');
  assert.deepEqual(rig.streams[0].texts, ['Welcome.', 'Go on.']);
  await playOut(rig);
  assert.deepEqual(rig.of('overlay'), []);
  assert(!rig.engine.state().transcript.some(item => item.overlay));
});

test('overlay: a reply that is cancelled before it plays produces nothing', async () => {
  const rig = panelRig({ createParser: tagParser });
  await overGreeting(rig, 'Welcome.<over id="B">Hi.</over> Go on.');
  rig.engine.hangUp();
  rig.streams[0].overlayCb?.({ speakerId: 'B', text: 'Hi.', offsetMs: 0 });
  rig.h.playback('utt1', 'position', 500);
  await flush();
  assert.deepEqual(rig.of('overlay'), []);
  assert(!rig.engine.state().transcript.some(item => item.overlay));
});

test('cut-in: a sentence that ends in a dash before a speaker switch is spoken, captioned and attributed like any other', async () => {
  const rig = panelRig({ createParser: tagParser });
  await overGreeting(rig, 'So the main thing we look for is\u2014<speaker id="B"/>Sorry, one quick thing.<speaker id="A"/>As I was saying, the main thing is ownership.');
  assert.deepEqual(rig.streams[0].log, [
    { text: 'So the main thing we look for is\u2014' }, { speaker: 'B' }, { text: 'Sorry, one quick thing.' }, { speaker: 'A' },
    { text: 'As I was saying, the main thing is ownership.' },
  ]);
  const entry = rig.engine.state().transcript[0];
  assert.deepEqual(entry.segments.map(item => item.speakerId), ['A', 'B', 'A']);
  assert.equal(entry.segments[0].text, 'So the main thing we look for is\u2014');
});

// ---- silence bound, late waits, overlay unit and captions ---------------------------
// Stub parser: <wait s="N"/>, <listen/> (no items), <over id="X" after="N" spoken="...">text</over>, plain text as one sentence.
function patienceParser() {
  const run = text => {
    const items = [];
    for (const part of text.split(/(<wait s="\d+"\/>|<listen\/>|<pass\/>|<over [^>]*>[^<]*<\/over>)/)) {
      const wait = part.match(/^<wait s="(\d+)"\/>$/);
      const over = part.match(/^<over id="([A-Z])"(?: after="(\d+)")?(?: spoken="([^"]*)")?>([^<]*)<\/over>$/);
      if (wait) items.push({ wait: Number(wait[1]) });
      else if (over) items.push({ over: { speakerId: over[1], text: over[4], ...(over[2] !== undefined ? { afterChars: Number(over[2]) } : {}), ...(over[3] !== undefined ? { spoken: over[3] } : {}) } });
      else if (part.trim() && part !== '<listen/>' && part !== '<pass/>') items.push({ sentence: part.trim() });
    }
    return { chats: [], sentences: items.filter(item => item.sentence).map(item => item.sentence), items, control: null, endCall: false };
  };
  return { push: run, end: () => ({ chats: [], sentences: [], items: [], control: null, endCall: false }) };
}

test('wait tag: a wait that arrives after the reply was committed still counts', async () => {
  const rig = makeRig({ createParser: patienceParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'late');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  const call = rig.sessions.main.calls[rig.sessions.main.calls.length - 1];
  call.onDelta('Tell me more.');
  rig.streams[rig.streams.length - 1].audio(1000);
  await flush();
  await rig.clock.advance(700);
  call.onDelta('<wait s="50"/>'); // written last, after the first audio
  rig.sessions.main.answer('', { chunks: [] });
  await flush();
  await playOut(rig);
  assert.equal(await checkInAt(rig, 50, 'first'), 50);
});

test('silence: a check-in answered with listen still counts, its wait sets the next gap, and the engine ends the call after check 3', async () => {
  const options = [];
  const rig = makeRig({ createParser: patienceParser, formatTurn: option => { options.push(option); return `[candidate silent ${Math.round((option.silenceMs ?? 0) / 1000)}s]`; } });
  await greet(rig);
  await deliver(rig, 'Go ahead.<wait s="30"/>');
  assert.equal(await checkInAt(rig, 30, 'first'), 30);
  rig.sessions.main.answer('<listen/><wait s="100"/>', { chunks: ['<listen/><wait s="100"/>'] });
  await flush();
  assert.equal(await checkInAt(rig, 100, 'listen reply wait'), 130);
  await answerCheckIn(rig, 'Still there?');
  assert.deepEqual(options.filter(item => item.silenceMs !== null && item.silenceMs !== undefined).map(item => item.silenceCheck), [1, 2]);
  assert.equal(await checkInAt(rig, 45, 'third'), 175);
  assert.equal(options.filter(item => item.silenceCheck === 3).length, 1);
  await answerCheckIn(rig, 'Hello?');
  assert.deepEqual(rig.of('ended'), []);
  await rig.clock.advance(120000);
  assert.deepEqual(rig.of('ended'), [{ type: 'ended', reason: 'interviewer', cause: 'silence' }]);
  assert.equal(rig.engine.state().phase, 'ended');
  assert.equal(rig.sessions.main.calls.length, 5, 'no fourth check-in message');
});

test('silence: the candidate speaking resets the check count', async () => {
  const options = [];
  const rig = makeRig({ createParser: patienceParser, formatTurn: option => { options.push(option); return `[candidate silent ${Math.round((option.silenceMs ?? 0) / 1000)}s]`; } });
  await greet(rig);
  await deliver(rig, 'Go ahead.');
  await checkInAt(rig, 20, 'first');
  await answerCheckIn(rig, 'Still there?');
  await deliver(rig, 'Fine.');
  await checkInAt(rig, 20, 'after reset');
  assert.equal(options[options.length - 1].silenceCheck, 1);
});

test('overlay: the position adds the acknowledgement already sent on the segment, in non-whitespace characters', async () => {
  const rig = panelRig({ createParser: patienceParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'ov');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Got it ok.'); // 8 non-whitespace characters
  await flush(); // the acknowledgement is sent before the main text arrives
  rig.sessions.main.answer('Tell me.<over id="B" after="7">Hmm.</over>', { chunks: ['Tell me.<over id="B" after="7">Hmm.</over>'] });
  rig.streams[rig.streams.length - 1].audio(1000);
  await flush();
  await rig.clock.advance(700);
  assert.deepEqual(rig.streams[rig.streams.length - 1].overlays, [{ speakerId: 'B', text: 'Hmm.', afterChars: 15 }]);
});

test('overlay: without afterChars the engine counts non-whitespace characters sent, acknowledgement included', async () => {
  const rig = panelRig({ createParser: patienceParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'ov2');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Got it ok.');
  await flush();
  rig.sessions.main.answer('Tell me.<over id="B">Hmm.</over>', { chunks: ['Tell me.<over id="B">Hmm.</over>'] });
  rig.streams[rig.streams.length - 1].audio(1000);
  await flush();
  await rig.clock.advance(700);
  assert.deepEqual(rig.streams[rig.streams.length - 1].overlays, [{ speakerId: 'B', text: 'Hmm.', afterChars: 15 }]);
});

test('overlay: captions and transcript show the spoken field, else the text without delivery tags; the voice gets the text', async () => {
  const withSpoken = panelRig({ createParser: patienceParser });
  await overGreeting(withSpoken, 'Hello there.<over id="B" after="3" spoken="Nice one.">[laughs] Nice one.</over>');
  const stream = withSpoken.streams[0];
  assert.equal(stream.overlays[0].text, '[laughs] Nice one.');
  stream.overlayCb({ speakerId: 'B', text: '[laughs] Nice one.', offsetMs: 100 });
  withSpoken.h.playback('utt1', 'started');
  withSpoken.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(withSpoken.of('overlay')[0].text, 'Nice one.');
  assert.equal(withSpoken.engine.state().transcript.find(item => item.overlay).text, 'Nice one.');

  const plain = panelRig({ createParser: patienceParser });
  await overGreeting(plain, 'Hello there.<over id="B" after="3">[softly] Right.</over>');
  plain.streams[0].overlayCb({ speakerId: 'B', text: '[softly] Right.', offsetMs: 100 });
  plain.h.playback('utt1', 'started');
  plain.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(plain.of('overlay')[0].text, 'Right.');
  assert.equal(plain.of('caption').find(item => item.overlay).text, 'Right.');
});

// ---- controls take effect when playback reaches their position ------------------
// Word timings: 300 ms per word, so word i ends at i * 300 + 280. Texts below are written so that the words match the sentences.
async function openReply(rig, text, wordList = null, audioSamples = 3200) {
  rig.engine.start();
  await flush();
  rig.h.level();
  rig.sessions.main.answer(text);
  rig.streams[0].audio(audioSamples);
  if (wordList) rig.streams[0].words(wordList);
  await flush();
}
const eventTypes = rig => rig.events.filter(event => ['screen', 'screen-stop', 'pad'].includes(event.type)).map(event => (event.type === 'pad' ? `pad-${event.open ? 'open' : 'close'}` : event.type));

test('controls: a screen tag after two sentences is delivered once they have been heard, with that moment as atMs', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, 'One two. Three four.[[screen:Sum|Add.]] Five six.', words('One', 'two.', 'Three', 'four.', 'Five', 'six.'));
  assert.equal(rig.of('screen').length, 0, 'not at commit');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 500);
  rig.h.playback('utt1', 'position', 1000); // 'four.' ends at 1180
  assert.equal(rig.of('screen').length, 0, 'not at playback start nor before the second sentence has been heard');
  assert.equal(rig.engine.state().screen, null);
  await rig.clock.advance(300);
  assert.equal(rig.of('screen').length, 0, 'no position event has reached the end of the last word before the tag');
  rig.h.playback('utt1', 'position', 1200); // 'four.' ends at 1180
  assert.equal(rig.of('screen').length, 1, 'delivered when a position event reaches the end of the last word');
  assert.equal(rig.of('screen')[0].atMs, rig.clock.now() - HELPER_OFFSET, 'the event carries the moment it was heard');
  assert.equal(rig.engine.state().screen.title, 'Sum');
  rig.h.playback('utt1', 'position', 1500);
  assert.equal(rig.of('screen').length, 1, 'once');
});

test('controls: a tag before any text takes effect at playback start, not before', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, '[[screen:Sum|Add.]][[pad-open:go]]One two.', words('One', 'two.'));
  assert.deepEqual(eventTypes(rig), []);
  rig.h.playback('utt1', 'started');
  assert.deepEqual(eventTypes(rig), ['screen', 'pad-open'], 'both sit at the very start');
});

test('controls: without word timings a tag is placed in proportion to its characters, and a tag at the end waits for the finish', async () => {
  const rig = makeRig({ createParser: screenParser });
  // 17 of 25 characters precede the screen tag; 48000 bytes at 24 kHz is 1000 ms of audio, so it falls at 680 ms.
  await openReply(rig, 'One two. Three four.[[screen:Sum|Add.]] Five six.[[pad-open:go]]', null, 48000);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 500);
  assert.deepEqual(eventTypes(rig), []);
  rig.h.playback('utt1', 'position', 700);
  assert.deepEqual(eventTypes(rig), ['screen']);
  rig.h.playback('utt1', 'position', 990);
  assert.deepEqual(eventTypes(rig), ['screen'], 'the end tag sits at the very end of the audio');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(eventTypes(rig), ['screen', 'pad-open']);
});

test('controls: a tag whose position is never confirmed is delivered at finish', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, 'One two.[[pad-open:go]]');
  rig.h.playback('utt1', 'started');
  assert.deepEqual(eventTypes(rig), []);
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(eventTypes(rig), ['pad-open']);
});

test('controls: late word timings release a waiting control', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, 'One two.[[screen:Sum|Add.]] Three four.', null, 480000);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 900);
  assert.deepEqual(eventTypes(rig), []);
  rig.streams[0].words(words('One', 'two.', 'Three', 'four.'));
  assert.deepEqual(eventTypes(rig), ['screen']);
});

test('controls: an interruption before the position means the tag never takes effect', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, 'One two. Three four.[[screen:Hidden|No.]] Five six.', words('One', 'two.', 'Three', 'four.', 'Five', 'six.'));
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 600);
  rig.h.vad(true);
  rig.h.transcript('one two three four', 'z', rig.clock.now(), false, rig.clock.now() + 900);
  await flush();
  rig.h.playback('utt1', 'cancelled', 650);
  rig.h.playback('utt1', 'position', 5000);
  await flush();
  assert.deepEqual(eventTypes(rig), []);
  assert.equal(rig.engine.state().screen, null);
});

test('controls: several controls arrive in order, each when its own position is reached', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, '[[pad-open:go]]One two.[[screen:T|c]] Three four.[[stop]] Five six.[[pad-close]]', words('One', 'two.', 'Three', 'four.', 'Five', 'six.'));
  rig.h.playback('utt1', 'started');
  assert.deepEqual(eventTypes(rig), ['pad-open']);
  rig.h.playback('utt1', 'position', 600);
  assert.deepEqual(eventTypes(rig), ['pad-open', 'screen']);
  rig.h.playback('utt1', 'position', 1200);
  assert.deepEqual(eventTypes(rig), ['pad-open', 'screen', 'screen-stop'], 'nothing holds the controls behind a screen');
  rig.h.playback('utt1', 'finished', 1800);
  await flush();
  assert.deepEqual(eventTypes(rig), ['pad-open', 'screen', 'screen-stop', 'pad-close']);
});

test('controls: a reply with no audio delivers its controls at finish', async () => {
  const rig = makeRig({ createParser: screenParser });
  rig.engine.start();
  await flush();
  rig.sessions.main.answer('[[screen:Sum|Add.]][[pad-open:go]]');
  await flush();
  assert.deepEqual(eventTypes(rig), ['screen', 'pad-open']);
});

test('controls: the acknowledgement spoken first shifts the position of the main reply\'s tags', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush(); // the acknowledgement is spoken before the main reply starts to arrive
  rig.sessions.main.answer('One two.[[screen:Sum|Add.]] Three.');
  rig.streams[1].audio(1000);
  rig.streams[1].words(words('Right.', 'One', 'two.', 'Three.'));
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'position', 600); // 'Right.' and 'One' heard
  assert.deepEqual(eventTypes(rig), [], 'the tag follows "two.", which has not been heard');
  rig.h.playback('utt2', 'position', 900);
  assert.deepEqual(eventTypes(rig), ['screen']);
});

test('controls: a switch to a colleague already on the call emits no participant event', async () => {
  const rig = panelRig({ createParser: tagParser });
  rig.engine.start();
  await flush();
  rig.h.level();
  rig.sessions.main.answer('Hello, I am Priya. <speaker id="B"/>And I am John.<over id="A">Mm.</over>');
  rig.streams[0].audio(3200);
  rig.streams[0].words(HELLO_WORDS);
  await flush();
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 1100);
  rig.h.playback('utt1', 'position', 2000);
  assert.deepEqual(rig.events.filter(event => /^participant/.test(event.type)), [], 'the engine never announces a participant itself');
});

// ---- a colleague who has not joined: the lead is told who is here, and nothing is said in an absent colleague's name ----
// Stub parser: <speaker id/>, <over id>, [[screen:T|C]], [[pad-open:lang]], [[chat:text]] become items in order; the rest is sentences.
function richParser() {
  const run = text => {
    const items = [];
    for (const part of text.split(/(<over id="[A-Z]">[^<]*<\/over>|<speaker id="[A-Z]"\/>|\[\[[^\]]*\]\])/)) {
      const over = part.match(/^<over id="([A-Z])">([^<]*)<\/over>$/);
      const spk = part.match(/^<speaker id="([A-Z])"\/>$/);
      const token = part.match(/^\[\[([a-z-]+):([^\]]*)\]\]$/);
      if (over) items.push({ over: { speakerId: over[1], text: over[2] } });
      else if (spk) items.push({ speaker: spk[1] });
      else if (token) {
        if (token[1] === 'screen') { const [title, content] = token[2].split('|'); items.push({ screen: { title, content, delaySeconds: null } }); }
        else if (token[1] === 'pad-open') items.push({ pad: { open: true, lang: token[2] } });
        else if (token[1] === 'chat') items.push({ chat: token[2] });
      } else if (part.trim()) for (const sentence of part.match(/[^.!?]+[.!?]/g) ?? []) items.push({ sentence: sentence.trim() });
    }
    return { chats: [], sentences: items.filter(item => item.sentence).map(item => item.sentence), items, control: null, endCall: false };
  };
  return { push: run, end: () => ({ chats: [], sentences: [], items: [], control: null, endCall: false }) };
}

function absentRig(extra = {}) {
  const options = [];
  const rig = panelRig({ createParser: richParser, formatTurn: option => { options.push(option); return `[turn ${JSON.stringify(option.candidateText ?? '')}]`; }, ...extra });
  rig.options = options;
  return rig;
}
const MEI_ABSENT = { here: ['Priya', 'John'], notJoined: ['Mei'] };

/** Start the call and let the lead's first reply arrive; `wordList` are the voice's word timings. */
async function absentStart(rig, reply, wordList = []) {
  rig.engine.start();
  await flush();
  rig.h.level();
  rig.sessions.main.answer(reply);
  rig.streams[0].audio(3200);
  if (wordList.length) rig.streams[0].words(wordList);
  await flush();
}

test('presence: the connect message names who is on the call and who has not joined; with nobody missing it is unchanged', async () => {
  const rig = absentRig();
  rig.engine.start();
  await flush();
  assert.equal(rig.sessions.main.calls[0].message, '[elapsed 00:00] [call connected] [On the call: Priya, John. Not joined yet: Mei.]');
  const everyone = makeRig({ panel: { leadId: 'A', speakers: [{ id: 'A', name: 'Priya', present: true }, { id: 'B', name: 'John', present: true }] }, speakerVoice: true });
  everyone.engine.start();
  await flush();
  assert.equal(everyone.sessions.main.calls[0].message, '[elapsed 00:00] [call connected]');
});

test('presence: candidate turns, check-ins and pad progress carry it, and it changes once the colleague joins', async () => {
  const rig = absentRig();
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  assert.deepEqual(rig.options.at(-1).presence, MEI_ABSENT, 'a spoken turn');
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Okay.');
  rig.streams[1].audio(500);
  await rig.clock.advance(700);
  await playOut(rig);
  rig.engine.typed('typed words');
  await flush();
  assert.deepEqual(rig.options.at(-1).presence, MEI_ABSENT, 'a typed turn');
  assert.deepEqual(rig.options.at(-1).presence, MEI_ABSENT);
  rig.sessions.opener.answer('Mm.');
  rig.sessions.main.answer('Go on.');
  rig.streams[2].audio(500);
  await rig.clock.advance(700);
  await playOut(rig);
  const before = rig.options.length;
  await rig.clock.advance(DEFAULT_CALL_THRESHOLDS.silencePromptMs + 100);
  assert.equal(rig.options.length, before + 1);
  assert(rig.options.at(-1).silenceCheck !== undefined, 'a check-in');
  assert.deepEqual(rig.options.at(-1).presence, MEI_ABSENT);
  rig.sessions.main.answer('Still there?');
  rig.streams[3].audio(500);
  await flush();
  await playOut(rig);
  rig.engine.setPadText('x = 1');
  await rig.clock.advance(DEFAULT_CALL_THRESHOLDS.padIdleMs + 100);
  assert(rig.options.at(-1).padProgress !== undefined, 'pad progress');
  assert.deepEqual(rig.options.at(-1).presence, MEI_ABSENT);
  rig.sessions.main.answer('Take your time.');
  rig.streams[4].audio(500);
  await flush();
  await playOut(rig);
  rig.engine.participantJoined('C');
  rig.engine.typed('after the join');
  await flush();
  const last = rig.options.at(-1);
  assert.deepEqual(last.joined, ['Mei'], 'the existing note about the arrival still appears');
  assert.equal(last.presence, undefined, 'nobody is missing any more');
});

test('absent colleague: their sentences reach no voice, caption or transcript; the lead\'s words before and after still play', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hello, I am Priya. <speaker id="C"/>Hi, I am Mei. Meera asks first. <speaker id="A"/>Over to me.',
    [...spoken('A', 0, 'Hello,', 'I', 'am', 'Priya.'), ...spoken('A', 1200, 'Over', 'to', 'me.')]);
  assert.deepEqual(rig.streams[0].log, [{ text: 'Hello, I am Priya.' }, { text: 'Over to me.' }], 'no sentence of hers and no voice switch at all');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 2400);
  await flush();
  assert.deepEqual(bare(rig.engine.state().transcript[0]), { speaker: 'interviewer', text: 'Hello, I am Priya. Over to me.', speakerId: 'A' });
  assert(!rig.of('caption').some(event => /Mei|Meera/.test(event.text)));
  assert.deepEqual(rig.of('speaker').map(event => event.speakerId), ['A']);
});

test('absent colleague: one follow-up turn starts after playback, with the note, no acknowledgement and no silence check', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hello, I am Priya. <speaker id="C"/>Hi, I am Mei.', spoken('A', 0, 'Hello,', 'I', 'am', 'Priya.'));
  assert.equal(rig.sessions.main.calls.length, 1, 'not while the reply is still playing');
  rig.h.playback('utt1', 'started');
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1);
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'the follow-up turn');
  const turn = rig.options.at(-1);
  assert.deepEqual(turn.absentHandover, ['Mei']);
  assert.deepEqual(turn.presence, MEI_ABSENT);
  assert.equal(turn.silenceCheck, undefined, 'not a silence check');
  assert.equal(turn.padProgress, undefined);
  assert.deepEqual(turn.acknowledgements, []);
  assert.equal(rig.sessions.opener.calls.length, 0, 'nothing is acknowledged before it');
  rig.sessions.main.answer('Sorry, Mei is not here yet. Let me carry on.');
  rig.streams[1].audio(800);
  await flush();
  await playOut(rig);
  assert.equal(rig.sessions.main.calls.length, 2, 'sent once, however the follow-up ends');
  assert.equal(rig.options.filter(option => option.absentHandover).length, 1);
});

test('absent colleague: a reply with nothing spoken starts the follow-up at once', async () => {
  const rig = absentRig();
  rig.engine.start();
  await flush();
  rig.sessions.main.answer('<speaker id="C"/>Mei speaking.');
  await flush();
  assert.deepEqual(rig.streams[0].texts, []);
  assert.equal(rig.of('caption').length, 0);
  assert.equal(rig.engine.state().transcript.length, 0);
  assert.equal(rig.sessions.main.calls.length, 2);
  assert.deepEqual(rig.options.at(-1).absentHandover, ['Mei']);
});

test('absent colleague: the follow-up is not sent when the candidate has started to type; their turn carries the note', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hello, I am Priya. <speaker id="C"/>Hi, I am Mei.', spoken('A', 0, 'Hello,', 'I', 'am', 'Priya.'));
  rig.h.playback('utt1', 'started');
  rig.engine.typing(true);
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1, 'no follow-up while they are writing');
  rig.engine.typing(false);
  rig.engine.typed('Hello Priya');
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2);
  const turn = rig.options.at(-1);
  assert.equal(turn.candidateText, 'Hello Priya');
  assert.deepEqual(turn.absentHandover, ['Mei']);
  rig.sessions.opener.answer('Hi.');
  rig.sessions.main.answer('Welcome.');
  rig.streams[1].audio(500);
  await flush();
  await playOut(rig);
  assert.equal(rig.sessions.main.calls.length, 2, 'the note was given once');
});

test('absent colleague: a message typed while the reply plays carries the note instead of a separate follow-up', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hello, I am Priya. <speaker id="C"/>Hi, I am Mei.', spoken('A', 0, 'Hello,', 'I', 'am', 'Priya.'));
  rig.h.playback('utt1', 'started');
  rig.engine.typed('Hello Priya');
  await flush();
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'the greeting and the candidate\'s turn: no separate follow-up');
  assert.equal(rig.options.at(-1).candidateText, 'Hello Priya');
  assert.deepEqual(rig.options.at(-1).absentHandover, ['Mei']);
});

test('absent colleague: an over remark by them is dropped and triggers the same note', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Welcome.<over id="C">Hi.</over> Go on.', words('Welcome.', 'Go', 'on.'));
  assert.deepEqual(rig.streams[0].overlays, []);
  assert.deepEqual(rig.streams[0].texts, ['Welcome.', 'Go on.']);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(rig.of('overlay'), []);
  assert.deepEqual(rig.options.at(-1).absentHandover, ['Mei']);
});

test('absent colleague: a screen or pad tag inside their segment is dropped; the lead\'s own tags still count', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hello. <speaker id="C"/>[[screen:Theirs|Nope.]][[pad-open:go]] Look here. <speaker id="A"/>Mine.[[screen:Mine|Yes.]]',
    words('Hello.', 'Mine.'));
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.deepEqual(rig.of('screen').map(event => event.title), ['Mine']);
  assert.deepEqual(rig.of('pad'), []);
});

test('a speaker id never cast: its text is dropped everywhere and the lead gets one follow-up with unknownSpeaker', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hi. <speaker id="Y"/>Hello there. <over id="Z">No.</over>');
  assert.deepEqual(rig.streams[0].log, [{ text: 'Hi.' }]);
  assert.deepEqual(rig.streams[0].overlays, []);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'one follow-up turn');
  assert.equal(rig.options.at(-1).unknownSpeaker, true);
  assert.equal(rig.options.at(-1).absentHandover, undefined);
  assert.deepEqual(rig.of('caption').map(event => event.text).filter(text => /Hello|No\./.test(text)), []);
  assert.equal(JSON.stringify(rig.engine.state().transcript).includes('Hello there'), false);
});

test('a speaker id never cast: the follow-up is not chained', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hi. <speaker id="Y"/>Hello there.');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  rig.sessions.main.answer('<speaker id="Y"/>Again.');
  rig.streams[1]?.audio?.(640);
  await flush();
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'the follow-up reply does not start another follow-up');
});

test('a speaker id never cast and a cast colleague who has not joined in one reply: names and the flag both reach the lead', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hi. <speaker id="C"/>Hello, Mei here. <speaker id="Y"/>Me too. <speaker id="A"/>Back.');
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2);
  assert.deepEqual(rig.options.at(-1).absentHandover, ['Mei']);
  assert.equal(rig.options.at(-1).unknownSpeaker, true);
});

test('a speaker id never cast: a message typed while the reply plays carries the flag', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hi. <speaker id="Y"/>Hello there.');
  rig.h.playback('utt1', 'started');
  rig.engine.typed('Hello Priya');
  await flush();
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 2, 'no separate follow-up');
  assert.equal(rig.options.at(-1).candidateText, 'Hello Priya');
  assert.equal(rig.options.at(-1).unknownSpeaker, true);
});

async function soloReply(main) {
  const options = [];
  const rig = makeRig({ createParser: richParser, formatTurn: option => { options.push(option); return '[turn]'; } });
  rig.options = options;
  await greet(rig);
  await deliver(rig, main);
  return rig;
}

test('solo call: a tag other than the lead\'s own drops its text and triggers one follow-up with unknownSpeaker', async () => {
  const rig = await soloReply('Fine. <speaker id="B"/>Theirs. <over id="C">Hm.</over>');
  assert.deepEqual(rig.streams[1].log.filter(item => item.text !== undefined).map(item => item.text), ['Fine.']);
  assert.equal(rig.options.at(-1).unknownSpeaker, true);
  assert.equal(JSON.stringify(rig.engine.state().transcript).includes('Theirs'), false);
});

test('solo call: the lead\'s own tag is harmless', async () => {
  const rig = await soloReply('Fine. <speaker id="A"/>Mine.');
  assert.deepEqual(rig.streams[1].log.filter(item => item.text !== undefined).map(item => item.text), ['Fine.', 'Mine.']);
  assert.equal(rig.options.some(option => option.unknownSpeaker), false);
});

test('absent colleague: when they join before the follow-up, nothing is sent about them', async () => {
  const rig = absentRig();
  await absentStart(rig, 'Hello, I am Priya. <speaker id="C"/>Hi, I am Mei.', spoken('A', 0, 'Hello,', 'I', 'am', 'Priya.'));
  rig.h.playback('utt1', 'started');
  rig.engine.participantJoined('C');
  rig.h.playback('utt1', 'finished', 1500);
  await flush();
  assert.equal(rig.sessions.main.calls.length, 1);
});

test('the early-join patch is gone from the engine', () => {
  const source = fs.readFileSync(new URL('../../electron/interviewPracticeCallEngine.js', import.meta.url), 'utf8');
  assert(!/early-join|ensureJoined|earlyPending|serviceJoined/.test(source));
});

test('chat items are delivered when playback reaches them, and not when the reply is cut off before', async () => {
  const rig = makeRig({ createParser: richParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Look.[[chat:First note.]] Then more.[[chat:Second note.]]');
  rig.streams[1].audio(1000);
  rig.streams[1].words(words('Right.', 'Look.', 'Then', 'more.'));
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  assert.deepEqual(rig.of('chat'), [], 'not when the reply starts to play');
  rig.h.playback('utt2', 'position', 500);
  assert.deepEqual(rig.of('chat'), []);
  rig.h.playback('utt2', 'position', 700);
  assert.deepEqual(rig.of('chat').map(event => event.text), ['First note.']);
  rig.h.vad(true);
  rig.h.transcript('one two three four', 'z', rig.clock.now(), false, rig.clock.now() + 900);
  await flush();
  rig.h.playback('utt2', 'cancelled', 750);
  await flush();
  assert.deepEqual(rig.of('chat').map(event => event.text), ['First note.'], 'the second note was never reached');
  assert.deepEqual(rig.engine.state().transcript.filter(entry => entry.channel === 'chat' && entry.speaker === 'interviewer').map(entry => entry.text), ['First note.']);
});

test('a cancel reporting a heard position past the last position event delivers the controls inside the heard text, none beyond', async () => {
  const rig = makeRig({ createParser: richParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  // 'Then.' is a whole sentence: the stub parser drops an unterminated fragment, which the old punctuation-inclusive count tolerated by accident.
  rig.sessions.main.answer('Look.[[screen:Keep|Stay.]] Then.[[chat:Hear.]] More.[[pad-open:go]]');
  rig.streams[1].audio(1000);
  rig.streams[1].words(words('Right.', 'Look.', 'Then.', 'More.'));
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'position', 300); // only 'Right.' is known to be heard
  rig.h.vad(true);
  rig.h.transcript('one two three four', 'z', rig.clock.now(), false, rig.clock.now() + 900);
  await flush();
  assert.equal(rig.engine.state().screen, null);
  rig.h.playback('utt2', 'cancelled', 900); // 'Right.', 'Look.' and 'Then' were in fact heard
  await flush();
  assert.deepEqual(rig.engine.state().screen, { title: 'Keep', content: 'Stay.', speakerId: 'A' });
  assert.deepEqual(rig.of('chat').map(event => event.text), ['Hear.']);
  assert.deepEqual(rig.of('pad'), [], 'the pad tag follows words that were not heard');
});

test('when the voice fails part way, controls after the words that were never spoken are dropped', async () => {
  const rig = makeRig({ createParser: richParser });
  await greet(rig);
  await speak(rig, 'I built a scheduler', 'a');
  await rig.clock.advance(600);
  rig.sessions.opener.answer('Right.');
  await flush();
  rig.sessions.main.answer('Look.[[screen:Keep|Stay.]] Then more.[[pad-open:go]][[chat:Late note.]]');
  rig.streams[1].audio(1000);
  rig.streams[1].words(words('Right.', 'Look.')); // the voice stopped after these
  rig.streams[1].finish = () => Promise.reject(new Error('voice dropped'));
  await flush();
  await rig.clock.advance(700);
  rig.h.playback('utt2', 'started');
  rig.h.playback('utt2', 'finished', 1500);
  await flush();
  assert.deepEqual(rig.of('error').map(event => event.code), ['voice-failed']);
  assert.deepEqual(rig.engine.state().screen, { title: 'Keep', content: 'Stay.', speakerId: 'A' });
  assert.deepEqual(rig.of('pad'), []);
  assert.deepEqual(rig.of('chat'), []);
});

// ---- a share being set up is silence between two segments --------------------
const SHARE_MAIN = 'Tell me about the design.[[screen:Doc|Body text.|#6]] What was hard?';
// "Tell me about the design." ends at 2380 ms; "What was hard?" is heard after that.
const shareRig = async (main = SHARE_MAIN, options = {}, wordList = REPLY_WORDS) => {
  const rig = makeRig({ createParser: screenParser, ...options });
  await greet(rig);
  await toPlaying(rig, { main, wordList });
  return rig;
};
const gapsOf = (rig, index = 1) => rig.streams[index].log.filter(item => item.gap !== undefined).map(item => item.gap);

test('share gap: a first-share screen tag between two sentences gives gap(6000) between them in the voice log', async () => {
  const rig = await shareRig();
  assert.deepEqual(rig.streams[1].log, [{ text: 'Right, got it.' }, { text: 'Tell me about the design.' }, { gap: 6000 }, { text: 'What was hard?' }]);
});

test('share gap: the queued path keeps the order of texts, switches and the gap', async () => {
  const rig = panelRig({ createParser: screenParser });
  await panelGreeting(rig, 'Hello.[[spk:B]]Look.[[screen:Doc|Body.|#6]]Next.');
  const log = rig.streams[rig.streams.length - 1].log;
  const at = log.findIndex(item => item.gap !== undefined);
  assert(at > 0, JSON.stringify(log));
  assert.deepEqual(log[at], { gap: 6000 });
  assert.deepEqual(log[at - 1], { text: 'Look.' });
  assert.deepEqual(log[at + 1], { text: 'Next.' });
  assert(log.findIndex(item => item.speaker === 'B') < at, 'the switch stays ahead of the gap');
});

test('share gap: while the voice gate is closed the gap is queued and sent in order when it opens', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await speculate(rig);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('One.[[screen:Doc|Body.|#6]] Two.');
  await flush();
  assert.deepEqual(rig.streams[1].log, [], 'nothing reaches the voice before the gate opens');
  await rig.clock.advance(600);
  assert.deepEqual(rig.streams[1].log.slice(-3), [{ text: 'One.' }, { gap: 6000 }, { text: 'Two.' }]);
});

test('share gap: a tag value of 9 gives gap(9000), and the screen event carries the same value', async () => {
  const rig = await shareRig('Look.[[screen:Doc|Body.|#9]] Then.');
  assert.deepEqual(gapsOf(rig), [9000]);
  rig.h.playback('utt2', 'position', 1500);
  await flush();
  assert.equal(rig.of('screen')[0].delayMs, 9000);
});

test('share gap: a replacement of a shown screen gets no gap', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await deliver(rig, 'A.[[screen:T|c]]');
  const before = rig.streams.length;
  await deliver(rig, 'B.[[screen:T2|c|#0.4]] C.');
  assert.deepEqual(rig.streams.slice(before).flatMap(stream => stream.log.filter(item => item.gap !== undefined)), [], 'a shown screen: a swap is quick');
});

test('share gap: a second screen tag in one reply is a replacement unless a stop came between', async () => {
  const twice = await shareRig('One.[[screen:A|a|#6]] Two.[[screen:B|b|#0.4]] Three.');
  assert.deepEqual(gapsOf(twice), [6000]);
  const stopped = await shareRig('One.[[screen:A|a|#6]] Two.[[stop]] Three.[[screen:B|b|#7]] Four.');
  assert.deepEqual(gapsOf(stopped), [6000, 7000]);
});

test('share gap: a screen already shown before the reply is judged at the time the item is read', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await deliver(rig, 'A.[[screen:T|c]]');
  const before = rig.streams.length;
  await deliver(rig, 'B.[[stop]] C.[[screen:T3|c|#5]] D.');
  assert.deepEqual(rig.streams.slice(before).flatMap(stream => stream.log.filter(item => item.gap !== undefined)), [{ gap: 5000 }]);
});

test('share gap: a screen tag before any text gives the gap first', async () => {
  const rig = await shareRig('[[screen:Doc|Body.|#6]]Welcome.');
  const log = rig.streams[1].log;
  assert.deepEqual(gapsOf(rig), [6000]);
  assert(log.findIndex(item => item.gap !== undefined) <= log.findIndex(item => item.text === 'Welcome.'));
});

test('share gap: the screen control is delivered once, when playback reaches the end of the last word before the tag', async () => {
  const rig = await shareRig();
  rig.h.playback('utt2', 'position', 2300);
  await flush();
  assert.equal(rig.of('screen').length, 0, 'not before the word ends');
  rig.h.playback('utt2', 'position', 2400);
  rig.h.playback('utt2', 'position', 2500);
  await flush();
  assert.equal(rig.of('screen').length, 1);
});

test('share gap: a pad control after the tag waits for its position after the silence, and nothing is paused', async () => {
  // The words after the tag are timed with the 6 s silence included.
  const silent = [...REPLY_WORDS.slice(0, 8), { word: 'What', startMs: 8400, endMs: 8700 }, { word: 'was', startMs: 8700, endMs: 8900 }, { word: 'hard?', startMs: 8900, endMs: 9300 }];
  const rig = await shareRig('Tell me about the design.[[screen:Doc|Body text.|#6]] What was hard?[[pad-open:go]]', {}, silent);
  rig.h.playback('utt2', 'position', 2400);
  await flush();
  assert.equal(rig.of('screen').length, 1);
  assert.equal(rig.of('pad').length, 0, 'not during the silence');
  rig.h.playback('utt2', 'position', 5000);
  await flush();
  assert.equal(rig.of('pad').length, 0, 'the silence is not speech');
  rig.h.playback('utt2', 'position', 9400);
  await flush();
  assert.equal(rig.of('pad').length, 1);
  assert.equal(rig.opsOf('pause').length + rig.opsOf('resume').length, 0, 'no pause or resume for a share');
});

test('share gap: a voice without a gap method still works', async () => {
  const rig = await shareRig(SHARE_MAIN, { gapVoice: false });
  assert.deepEqual(rig.streams[1].log, [{ text: 'Right, got it.' }, { text: 'Tell me about the design.' }, { text: 'What was hard?' }]);
  rig.h.playback('utt2', 'position', 2400);
  await flush();
  assert.equal(rig.of('screen').length, 1);
});

test('share gap: the overlay anchor counts characters from the start of the segment after the gap', async () => {
  const rig = panelRig({ createParser: screenParser });
  await panelGreeting(rig, 'Hello.[[screen:Doc|Body.|#6]]Hi.[[spk:B]]');
  assert.deepEqual(rig.streams[rig.streams.length - 1].log.filter(item => item.gap !== undefined), [{ gap: 6000 }]);
});

test('pause tag: gives gap(ms) in order with the text, on the direct and the queued path', async () => {
  const direct = await shareRig('One.[[pause:4]] Two.', {}, REPLY_WORDS);
  assert.deepEqual(direct.streams[1].log, [{ text: 'Right, got it.' }, { text: 'One.' }, { gap: 4000 }, { text: 'Two.' }]);
  const queued = makeRig({ createParser: screenParser });
  await greet(queued);
  await speculate(queued);
  queued.sessions.opener.answer('Right.');
  queued.sessions.main.answer('One.[[pause:4]] Two.');
  await flush();
  assert.deepEqual(queued.streams[1].log, []);
  await queued.clock.advance(600);
  assert.deepEqual(queued.streams[1].log.slice(-3), [{ text: 'One.' }, { gap: 4000 }, { text: 'Two.' }]);
});

test('pause tag: clamped to 300..15000 ms', async () => {
  assert.deepEqual(gapsOf(await shareRig('One.[[pause:0.01]] Two.')), [300]);
  assert.deepEqual(gapsOf(await shareRig('One.[[pause:120]] Two.')), [15000]);
});

test('pause tag: a filler between a pause and a screen gap gives sentence, gap, sentence, gap, sentence', async () => {
  const rig = await shareRig('Let me set this up.[[pause:4]] Nearly there.[[screen:Doc|Body.|#4]] Here it is.');
  assert.deepEqual(rig.streams[1].log.slice(1), [{ text: 'Let me set this up.' }, { gap: 4000 }, { text: 'Nearly there.' }, { gap: 4000 }, { text: 'Here it is.' }]);
});

test('pause tag: inside the segment of someone not on the call it is dropped', async () => {
  const rig = panelRig({ createParser: screenParser });
  await panelGreeting(rig, 'Hello.[[spk:Z]]Hi.[[pause:4]]More.[[spk:A]]Back.');
  assert.deepEqual(lastStream(rig).log.filter(item => item.gap !== undefined), []);
});

test('controls: text punctuation that differs from the timed words does not shift the position', async () => {
  const rig = makeRig({ createParser: screenParser });
  await openReply(rig, 'Jack, I\'m here.[[screen:Doc|Body.|#6]] Next.', [
    { word: 'Jack', startMs: 0, endMs: 200 }, { word: 'I', startMs: 300, endMs: 400 }, { word: 'm', startMs: 400, endMs: 500 },
    { word: 'here', startMs: 600, endMs: 800 }, { word: 'Next', startMs: 1200, endMs: 1400 },
  ]);
  rig.h.playback('utt1', 'started');
  rig.h.playback('utt1', 'position', 700);
  await flush();
  assert.equal(rig.of('screen').length, 0, 'not before "here" has ended');
  rig.h.playback('utt1', 'position', 850);
  await flush();
  assert.equal(rig.of('screen').length, 1, 'reached when "here" ends although the characters differ');
});

// ---- the share silence: interruptions, overlay anchors and stranded delivery tags -------------
// Stub parser: [[screen:T|c|#6]], [[spk:B]] and [[over:B:N:text]] (N is the parser's own afterChars) become items in order;
// plain text is split into sentences, a trailing piece without punctuation (a bare delivery tag) included.
function gapParser() {
  const run = text => {
    const items = [];
    for (const piece of text.split(/(\[\[[^\]]*\]\])/).filter(Boolean)) {
      const token = piece.match(/^\[\[([a-z]+):([^\]]*)\]\]$/);
      if (!token) { for (const sentence of piece.match(/[^.!?]+[.!?]|[^.!?]+$/g) ?? []) if (sentence.trim()) items.push({ sentence: sentence.trim() }); continue; }
      const [, kind, arg] = token;
      if (kind === 'screen') {
        const [title, content, delay] = arg.split('|');
        items.push({ screen: { title, content, delaySeconds: Number(delay.slice(1)) } });
      } else if (kind === 'spk') items.push({ speaker: arg });
      else if (kind === 'over') { const [id, after, ...rest] = arg.split(':'); items.push({ over: { speakerId: id, text: rest.join(':'), afterChars: Number(after) } }); }
    }
    return { chats: [], sentences: items.filter(item => item.sentence).map(item => item.sentence), items, control: null, endCall: false };
  };
  return { push: run, end: () => ({ chats: [], sentences: [], items: [], control: null, endCall: false }) };
}
const lastStream = rig => rig.streams[rig.streams.length - 1];

test('share gap: an interruption during the silence is acted on at once, not after the first word that follows it', async () => {
  const later = [8400, 8700, 9000].map((startMs, index) => ({ word: ['What', 'was', 'hard?'][index], startMs, endMs: startMs + 280 }));
  const rig = await shareRig(SHARE_MAIN, {}, [...REPLY_WORDS.slice(0, 8), ...later]);
  rig.h.playback('utt2', 'position', 4000); // after "design." (2380 ms), 4.4 s before "What"
  await shortOverlap(rig, 'right');
  rig.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 1, 'the silence has no word to wait for');
});

test('share gap: inside a word the stop still waits for the word to end', async () => {
  const later = [8400, 8700, 9000].map((startMs, index) => ({ word: ['What', 'was', 'hard?'][index], startMs, endMs: startMs + 280 }));
  const rig = await shareRig(SHARE_MAIN, {}, [...REPLY_WORDS.slice(0, 8), ...later]);
  rig.h.playback('utt2', 'position', 100);
  await shortOverlap(rig, 'right');
  rig.sessions.classifier.answer('interruption');
  await flush();
  assert.equal(cancelsOf(rig, 'utt2'), 0);
});

test('share gap: a pause decided during the silence pauses at once at the current position', async () => {
  const later = [8400, 8700, 9000].map((startMs, index) => ({ word: ['What', 'was', 'hard?'][index], startMs, endMs: startMs + 280 }));
  const ear = makeEar({ floorBid: () => ({ decision: 'pause' }) });
  const rig = await shareRig(SHARE_MAIN, { ear }, [...REPLY_WORDS.slice(0, 8), ...later]);
  rig.h.playback('utt2', 'position', 4000);
  await floorBidOverlap(rig, 'right');
  assert.equal(rig.opsOf('pause').length, 1, 'paused without waiting for "What"');
});

const overAfter = async (reply, options = {}) => {
  const rig = panelRig({ createParser: gapParser, ...options });
  await panelGreeting(rig, reply);
  return lastStream(rig).overlays;
};

test('share gap: an <over> remark after the gap is anchored from the start of the segment after it', async () => {
  // The parser counts "Hello there." (11) and "Next bit." (7, the remark after 4 of them): 15 from the speaker tag.
  assert.deepEqual(await overAfter('Hello there.[[screen:Doc|Body.|#6]]Next bit.[[over:B:15:Hmm.]]'), [{ speakerId: 'B', text: 'Hmm.', afterChars: 4 }]);
});

test('share gap: an <over> remark before the gap keeps the parser count', async () => {
  assert.deepEqual(await overAfter('Hello there.[[over:B:5:Hmm.]][[screen:Doc|Body.|#6]]Next bit.'), [{ speakerId: 'B', text: 'Hmm.', afterChars: 5 }]);
});

test('share gap: an <over> remark after a speaker switch that follows a gap keeps the parser count', async () => {
  assert.deepEqual(await overAfter('Hello there.[[screen:Doc|Body.|#6]]Next bit.[[spk:B]]Over here.[[over:A:3:Hmm.]]'), [{ speakerId: 'A', text: 'Hmm.', afterChars: 3 }]);
});

test('share gap: a gap near a screen tag never takes the anchor below zero', async () => {
  assert.deepEqual(await overAfter('Hello there.[[screen:Doc|Body.|#6]]Next bit.[[over:B:2:Hmm.]]'), [{ speakerId: 'B', text: 'Hmm.', afterChars: 0 }]);
});

const ownText = stream => stream.log.filter(item => item.text !== undefined).map(item => item.text);

test('share gap: a delivery tag just before the screen tag is spoken with the sentence after the silence', async () => {
  const rig = makeRig({ createParser: gapParser });
  await greet(rig);
  await toPlaying(rig, { main: 'Let me pull it up. [softly] [[screen:T|x|#8]] Can you see it?' });
  assert.deepEqual(rig.streams[1].log, [{ text: 'Right, got it.' }, { text: 'Let me pull it up.' }, { gap: 8000 }, { text: '[softly] Can you see it?' }]);
});

test('share gap: a delivery tag with no later text is never sent, and the transcript has no trace of it', async () => {
  const rig = makeRig({ createParser: gapParser });
  await greet(rig);
  await toPlaying(rig, { main: 'Let me pull it up. [softly]' });
  assert.deepEqual(ownText(rig.streams[1]), ['Right, got it.', 'Let me pull it up.']);
  assert.equal(rig.engine.state().transcript.filter(entry => entry.speaker === 'interviewer').pop().text, 'Right, got it. Let me pull it up.');
});

test('share gap: a held delivery tag is dropped when the speaker changes first', async () => {
  const rig = panelRig({ createParser: gapParser });
  await panelGreeting(rig, 'Hello there. [softly] [[spk:B]]And I am John.');
  assert.deepEqual(ownText(lastStream(rig)), ['Hello there.', 'And I am John.']);
});

test('share gap: a held tag is counted with the segment it is sent in, so a later remark keeps its anchor', async () => {
  // Parser: "Hello there."(11) + "[softly]"(8) + "Next bit."(8, remark after 4 of them) = 23; sent after the gap: "[softly] Next bit." so 8 + 4.
  assert.deepEqual(await overAfter('Hello there. [softly] [[screen:Doc|Body.|#6]]Next bit.[[over:B:23:Hmm.]]'), [{ speakerId: 'B', text: 'Hmm.', afterChars: 12 }]);
});

// ---- prepared screens and dropped pauses -------------------------------------
function refParser() {
  const base = screenParser();
  const run = text => {
    const out = [];
    for (const piece of text.split(/(\[\[ref:[^\]]*\]\])/).filter(Boolean)) {
      const token = piece.match(/^\[\[ref:([^\]|]*)(?:\|#(.+))?\]\]$/);
      if (token) out.push({ screen: { ref: token[1], delaySeconds: token[2] ? Number(token[2]) : null } });
      else out.push(...base.push(piece).items);
    }
    return { chats: [], sentences: out.filter(item => item.sentence).map(item => item.sentence), items: out, control: null, endCall: false };
  };
  return { push: run, end: () => ({ chats: [], sentences: [], items: [], control: null, endCall: false }) };
}
const PREPARED = { p1: { parts: [{ title: 'Task', content: 'Add two numbers.' }, { title: 'Follow-up', content: 'Now sort them.' }] } };
function preparedRig(extra = {}) {
  const options = [];
  const rig = makeRig({ createParser: refParser, formatTurn: option => { options.push(option); return '[turn]'; }, prepared: PREPARED, ...extra });
  rig.options = options;
  return rig;
}

test('prepared screen: a reference resolves to the part title and content; p1 is part 1 and p1.2 part 2', async () => {
  const rig = preparedRig();
  await greet(rig);
  await deliver(rig, 'Look.[[ref:p1]] Done.');
  assert.deepEqual(rig.engine.state().screen, { title: 'Task', content: 'Add two numbers.', speakerId: 'A' });
  await deliver(rig, 'Next.[[ref:p1.2|#1]]');
  assert.deepEqual(rig.engine.state().screen, { title: 'Follow-up', content: 'Now sort them.', speakerId: 'A' });
  assert.equal(rig.of('screen')[0].delayMs, 6000, 'first share keeps the default set-up time');
  assert.equal(rig.of('screen')[1].delayMs, 1000, 'a swap takes the delay the interviewer wrote');
});

test('prepared screen: the first share gives the setup gap in the voice log, like a written screen', async () => {
  const rig = preparedRig();
  await greet(rig);
  await toPlaying(rig, { main: 'Tell me about the design.[[ref:p1|#6]] What was hard?' });
  assert.deepEqual(rig.streams[1].log, [{ text: 'Right, got it.' }, { text: 'Tell me about the design.' }, { gap: 6000 }, { text: 'What was hard?' }]);
});

test('prepared screen: an unknown reference or part is dropped and reported once in the next message', async () => {
  const rig = preparedRig();
  await greet(rig);
  await deliver(rig, 'Look.[[ref:p9]][[ref:p1.7]] Done.');
  assert.equal(rig.engine.state().screen, null);
  assert.deepEqual(rig.of('screen'), []);
  await speak(rig, 'ok sure', 'u1');
  await rig.clock.advance(600);
  assert.deepEqual(rig.options.at(-1).unknownScreen, ['p9', 'p1.7']);
  rig.sessions.opener.answer('Right.');
  rig.sessions.main.answer('Good.');
  rig.streams.at(-1).audio(1000);
  await flush();
  await rig.clock.advance(700);
  rig.h.playback(`utt${rig.streams.length}`, 'started');
  rig.h.playback(`utt${rig.streams.length}`, 'finished', 1500);
  await flush();
  await speak(rig, 'and another thing', 'u2');
  await rig.clock.advance(600);
  assert.equal(rig.options.at(-1).unknownScreen, undefined, 'told once');
});

test('prepared screen: the opener message never carries the unknown-screen note', async () => {
  const rig = preparedRig();
  await greet(rig);
  await deliver(rig, 'Look.[[ref:nope]] Done.');
  await speak(rig, 'ok sure', 'u1');
  await rig.clock.advance(600);
  const forOpener = rig.options.filter(option => option.unknownScreen === undefined);
  assert(forOpener.length >= 1);
  assert.equal(rig.options.filter(option => option.unknownScreen).length, 1, 'only the main message');
});

const pauseRig = async main => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await toPlaying(rig, { main });
  return rig;
};

test('pause: a pause between spoken words becomes one gap', async () => {
  const rig = await pauseRig('One.[[pause:4]] Two.');
  assert.deepEqual(gapsOf(rig), [4000]);
  assert.deepEqual(rig.streams[1].log, [{ text: 'Right, got it.' }, { text: 'One.' }, { gap: 4000 }, { text: 'Two.' }]);
});

test('pause: one with no words before it in the reply is dropped', async () => {
  const rig = makeRig({ createParser: screenParser });
  await greet(rig);
  await deliver(rig, '[[pause:4]]Two.');
  // the opener reaction counts as spoken before it, so look at a main-only greeting instead
  const solo = makeRig({ createParser: screenParser });
  solo.engine.start({ greeting: true });
  await flush();
  solo.sessions.main.answer('[[pause:4]]Hello.');
  await flush();
  assert.deepEqual(gapsOf(solo, 0), []);
  assert.deepEqual(solo.streams[0].log, [{ text: 'Hello.' }]);
});

test('pause: one with nothing spoken after it by the end of the reply is never sent to the voice', async () => {
  const rig = await pauseRig('One.[[pause:4]]');
  assert.deepEqual(gapsOf(rig), []);
  const queued = makeRig({ createParser: screenParser });
  await greet(queued);
  await speculate(queued);
  queued.sessions.opener.answer('Right.');
  queued.sessions.main.answer('One.[[pause:4]]');
  await flush();
  await queued.clock.advance(700);
  assert.deepEqual(gapsOf(queued), []);
});

test('pause: two pauses in a row keep the first only, and a pause before a speaker switch stays ahead of it', async () => {
  const rig = await pauseRig('One.[[pause:2]][[pause:5]] Two.');
  assert.deepEqual(gapsOf(rig), [2000]);
  const panel = panelRig({ createParser: screenParser });
  await panelGreeting(panel, 'Hello.[[pause:3]][[spk:B]]Hi.');
  const log = lastStream(panel).log;
  const at = log.findIndex(item => item.gap !== undefined);
  assert(at > 0, JSON.stringify(log));
  assert(log.findIndex(item => item.speaker === 'B') > at, 'the gap stays ahead of the switch');
});
