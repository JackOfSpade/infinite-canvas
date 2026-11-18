import assert from 'node:assert/strict';
import { createPanelVoiceFactory, GAP_MAX_MS, CUT_IN_OVERLAP_MS, CUT_IN_FADE_MS, CUT_IN_TRAILING_ALLOWANCE_MS, CUT_IN_LEVEL_WINDOW_MS, CUT_IN_SPEECH_FLOOR, CUT_IN_SPEECH_RATIO } from '../../electron/practiceCall/eleven/panelVoice.js';

const flush = async () => { for (let step = 0; step < 12; step += 1) await Promise.resolve(); };

// 200 bytes of 16-bit PCM at 1000 Hz is 100 ms.
const chunk = (ms = 100) => Buffer.alloc(ms * 2);

// A voice stream whose audio, words and end the test drives by hand.
function fakeStream(info) {
  const audio = []; const words = []; const errors = [];
  const stream = {
    ...info,
    sampleRate: info.rate ?? 1000,
    sent: [], finishCalls: 0, cancelCalls: 0,
    sendText(text) { stream.sent.push(text); return true; },
    finish() {
      stream.finishCalls += 1;
      stream.finishPromise ??= new Promise((resolve, reject) => { stream.resolve = resolve; stream.reject = reject; });
      return stream.finishPromise;
    },
    cancel() { stream.cancelCalls += 1; },
    onAudio(cb) { audio.push(cb); return () => {}; },
    onWords(cb) { words.push(cb); return () => {}; },
    onError(cb) { errors.push(cb); return () => {}; },
    play: (ms = 100) => { for (const cb of audio) cb(chunk(ms)); },
    push: buffer => { for (const cb of audio) cb(buffer); },
    say: list => { for (const cb of words) cb(list); },
    end: () => { stream.finish(); stream.resolve({ ok: true }); },
    break: error => { for (const cb of errors) cb(error); stream.finish(); stream.reject(error); },
  };
  return stream;
}

function setup({ ids = ['A', 'B', 'C'], rates = {}, clock } = {}) {
  const made = [];
  const factories = {};
  for (const id of ids) {
    factories[id] = { open: ({ utteranceId, signal }) => { const s = fakeStream({ id, utteranceId, signal, rate: rates[id] }); made.push(s); return s; } };
  }
  const panel = createPanelVoiceFactory({ factories, ...(clock ? { clock } : {}) });
  return { panel, made };
}

function listen(stream) {
  const log = { audio: [], words: [], speakers: [] };
  stream.onAudio(buffer => log.audio.push(buffer.length));
  stream.onWords(words => log.words.push(...words));
  stream.onSpeaker(event => log.speakers.push(event));
  return log;
}

const baseTests = [
  {
    name: 'panel voice: a second speaker is held until the first has finished, then plays in order',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'u1' });
      const log = listen(stream);
      stream.sendText('Hello there.');
      assert.equal(stream.setSpeaker('B'), true);
      stream.sendText('Over to me.');
      assert.deepEqual(made.map(s => `${s.id}:${s.utteranceId}`), ['A:u1-s0', 'B:u1-s1'], 'each segment has its own stream and id');
      assert.deepEqual(made[1].sent, ['Over to me.'], 'text is forwarded at once so segments generate in parallel');
      made[1].play(100);
      made[1].say([{ word: 'Over', startMs: 0, endMs: 50 }]);
      await flush();
      assert.deepEqual(log.audio, [], 'the later speaker waits for the earlier one');
      assert.deepEqual(log.words, []);
      made[0].play(300);
      made[0].say([{ word: 'Hello', startMs: 10, endMs: 200 }]);
      assert.deepEqual(log.audio, [600], 'the first speaker plays straight away');
      made[0].end();
      await flush();
      assert.deepEqual(log.audio, [600, 200], 'the held audio follows once the first segment is done');
      made[1].play(100);
      assert.deepEqual(log.audio, [600, 200, 200], 'later audio of the active segment is not held');
      assert.deepEqual(log.words.map(w => [w.word, w.startMs, w.endMs, w.speakerId]), [
        ['Hello', 10, 200, 'A'],
        ['Over', 300, 350, 'B'],
      ], 'word times are offset to the whole utterance and carry the speaker');
      made[1].end();
      stream.sendText('');
      await stream.finish();
    },
  },
  {
    name: 'panel voice: onSpeaker fires with the segment offset at its first audio, including the first segment',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'u2' });
      const log = listen(stream);
      stream.sendText('One.');
      stream.setSpeaker('B');
      stream.sendText('Two.');
      stream.setSpeaker('A');
      stream.sendText('Three.');
      assert.deepEqual(log.speakers, [], 'nothing fires before audio');
      made[0].play(200); made[0].play(100);
      assert.deepEqual(log.speakers, [{ speakerId: 'A', startMs: 0 }], 'fires once per segment');
      made[0].end(); made[1].play(50); await flush();
      assert.deepEqual(log.speakers.at(-1), { speakerId: 'B', startMs: 300 });
      made[1].end(); made[2].play(50); await flush();
      assert.deepEqual(log.speakers.at(-1), { speakerId: 'A', startMs: 350 }, 'the same speaker again is a new segment');
      assert.equal(log.speakers.length, 3);
      made[2].end();
      await stream.finish();
    },
  },
  {
    name: 'panel voice: words that arrive for a waiting segment are offset when it is released',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'u3' });
      const log = listen(stream);
      stream.sendText('a'); stream.setSpeaker('C'); stream.sendText('b');
      made[1].say([{ word: 'b', startMs: 20, endMs: 40 }]);
      made[0].play(100); made[0].end(); await flush();
      assert.deepEqual(log.words.map(w => [w.startMs, w.endMs, w.speakerId]), [[120, 140, 'C']]);
      made[1].end();
      await stream.finish();
    },
  },
  {
    name: 'panel voice: a segment that got no text is dropped silently',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'u4' });
      const log = listen(stream);
      assert.equal(stream.setSpeaker('B'), true, 'switching before any text');
      assert.equal(stream.setSpeaker('C'), true);
      stream.sendText('Only C speaks.');
      assert.deepEqual(made.map(s => s.id), ['A', 'C'], 'the silent speaker never opens a stream');
      assert.equal(made[0].cancelCalls, 1, 'the empty first stream is cancelled');
      made[1].play(100); await flush();
      assert.deepEqual(log.speakers, [{ speakerId: 'C', startMs: 0 }]);
      stream.setSpeaker('A');
      made[1].end();
      const done = stream.finish();
      await done;
      assert.deepEqual(log.audio, [200]);
      assert.equal(made.length, 2, 'a trailing empty segment opens nothing');
    },
  },
  {
    name: 'panel voice: finish rejects with the first segment error and still releases later audio',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'u5' });
      const log = listen(stream);
      const seen = [];
      stream.onError(error => seen.push(error));
      stream.sendText('a'); stream.setSpeaker('B'); stream.sendText('b');
      const boom = Object.assign(new Error('quota'), { code: 'voice-quota' });
      made[0].break(boom);
      made[1].play(100); made[1].end(); await flush();
      assert.deepEqual(log.audio, [200], 'a failed segment does not strand the next one');
      assert.deepEqual(seen, [boom], 'the error is reported once');
      await assert.rejects(stream.finish(), error => error === boom);
    },
  },
  {
    name: 'panel voice: an error from a later segment rejects finish too',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'u6' });
      stream.sendText('a'); stream.setSpeaker('B'); stream.sendText('b');
      made[0].end();
      const boom = new Error('network');
      made[1].break(boom);
      await assert.rejects(stream.finish(), error => error === boom);
    },
  },
  {
    name: 'panel voice: cancel stops every segment, drops held audio and finish resolves',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'u7' });
      const log = listen(stream);
      stream.sendText('a'); stream.setSpeaker('B'); stream.sendText('b');
      made[1].play(100);
      stream.cancel();
      assert.deepEqual(made.map(s => s.cancelCalls), [1, 1]);
      made[0].play(100); made[0].end(); await flush();
      assert.deepEqual(log.audio, [], 'nothing plays after cancel');
      assert.equal(stream.sendText('late'), false);
      assert.equal(stream.setSpeaker('C'), false);
      assert.deepEqual(await stream.finish(), { cancelled: true });
      assert.equal(stream.closed, true);
    },
  },
  {
    name: 'panel voice: an aborted signal cancels every segment',
    async run() {
      const { panel, made } = setup();
      const controller = new AbortController();
      const stream = panel.open({ utteranceId: 'u8', signal: controller.signal });
      stream.sendText('a'); stream.setSpeaker('B'); stream.sendText('b');
      assert.equal(made[1].signal, controller.signal, 'the signal reaches every segment stream');
      controller.abort();
      assert.deepEqual(made.map(s => s.cancelCalls), [1, 1]);
      assert.deepEqual(await stream.finish(), { cancelled: true });
    },
  },
  {
    name: 'panel voice: with one speaker it passes the plain stream through',
    async run() {
      const { panel, made } = setup({ rates: { A: 24000 } });
      const stream = panel.open({ utteranceId: 'solo' });
      const log = listen(stream);
      assert.equal(stream.sampleRate, 24000, 'the lead stream rate');
      assert.equal(stream.sendText('Hi.'), true);
      assert.deepEqual(made.length, 1);
      assert.equal(made[0].utteranceId, 'solo-s0');
      made[0].say([{ word: 'Hi.', startMs: 5, endMs: 90 }]);
      made[0].play(100);
      assert.deepEqual(log.audio, [200]);
      assert.deepEqual(log.words, [{ word: 'Hi.', startMs: 5, endMs: 90, speakerId: 'A' }]);
      assert.deepEqual(log.speakers, [{ speakerId: 'A', startMs: 0 }]);
      const finished = stream.finish();
      assert.equal(made[0].finishCalls, 1);
      made[0].end();
      assert.deepEqual(await finished, { ok: true });
      assert.equal(stream.finish(), finished, 'finish is idempotent');
    },
  },
  {
    name: 'panel voice: the stream opens for the given speaker, defaulting to the lead',
    async run() {
      const { panel, made } = setup();
      panel.open({ utteranceId: 'x' });
      panel.open({ utteranceId: 'y', speakerId: 'B' });
      assert.deepEqual(made.map(s => s.id), ['A', 'B']);
    },
  },
  {
    name: 'panel voice: setSpeaker returns false for an unknown id or the current speaker',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'u9' });
      stream.sendText('a');
      assert.equal(stream.setSpeaker('A'), false, 'already speaking');
      assert.equal(stream.setSpeaker('Z'), false, 'unknown id');
      assert.equal(stream.setSpeaker(undefined), false);
      assert.equal(made[0].finishCalls, 0, 'a refused switch leaves the segment open');
      assert.equal(stream.setSpeaker('B'), true);
      assert.equal(stream.setSpeaker('B'), false);
      assert.equal(made[0].finishCalls, 1, 'a real switch finishes the earlier segment');
      stream.sendText('b'); made[0].end(); made[1].end();
      await stream.finish();
    },
  },
  {
    name: 'panel voice: a factory that fails to open a later segment is reported, not thrown',
    async run() {
      const made = [];
      const factories = {
        A: { open: info => { const s = fakeStream({ id: 'A', ...info }); made.push(s); return s; } },
        B: { open: () => { throw Object.assign(new Error('no voice'), { code: 'voice-auth' }); } },
      };
      const stream = createPanelVoiceFactory({ factories }).open({ utteranceId: 'u10' });
      stream.sendText('a'); stream.setSpeaker('B');
      assert.equal(stream.sendText('b'), false);
      made[0].end();
      await assert.rejects(stream.finish(), error => error.code === 'voice-auth');
    },
  },
  {
    name: 'panel voice: a factory for the lead is required',
    async run() {
      assert.throws(() => createPanelVoiceFactory({ factories: { B: { open() {} } } }), /lead/u);
    },
  },

  {
    // Every utterance of a call shares the call's abort signal: a stream that is over must not
    // stay registered on it.
    name: 'panel voice: the abort listener is removed once the stream finishes or is cancelled',
    async run() {
      for (const ending of ['finish', 'cancel']) {
        const listeners = new Set();
        const signal = { aborted: false, addEventListener: (name, fn) => listeners.add(fn), removeEventListener: (name, fn) => listeners.delete(fn) };
        const { panel, made } = setup();
        const stream = panel.open({ utteranceId: `u-${ending}`, signal });
        assert.equal(listeners.size, 1);
        stream.sendText('Hello.');
        if (ending === 'cancel') stream.cancel();
        else { const done = stream.finish(); made[0].end(); await done; }
        assert.equal(listeners.size, 0, `no listener is left after ${ending}`);
      }
    },
  },

];

// ---- overlay (a remark heard over the current speaker) ----

// 16-bit LE PCM from a list of sample values.
const pcm = values => { const b = Buffer.alloc(values.length * 2); values.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; };
const flat = (count, value) => pcm(new Array(count).fill(value));
const samples = buffer => { const out = []; for (let i = 0; i + 1 < buffer.length; i += 2) out.push(buffer.readInt16LE(i)); return out; };
const fakeClock = () => {
  const timers = new Map(); let next = 1;
  return {
    timers,
    setTimeout: (fn, ms) => { timers.set(next, { fn, ms }); return next++; },
    clearTimeout: handle => { timers.delete(handle); },
    fire: () => { for (const [handle, timer] of [...timers]) { timers.delete(handle); timer.fn(); } },
  };
};
function collect(stream) {
  const log = { chunks: [], overlays: [] };
  stream.onAudio(buffer => log.chunks.push(Buffer.from(buffer)));
  stream.onOverlay(event => log.overlays.push(event));
  Object.defineProperty(log, 'all', { get: () => Buffer.concat(log.chunks) });
  return log;
}

export const overlayTests = [
  {
    name: 'panel voice overlay: the remark is mixed at 0.85 gain from the word after the tag, with clipping',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'o1' });
      const log = collect(stream);
      stream.sendText('Hello world there.');
      assert.equal(stream.overlay({ speakerId: 'B', text: 'Hi Jack.', afterChars: 5 }), true);
      assert.equal(made[1].utteranceId, 'o1-o', 'the remark has its own stream on that interviewer');
      assert.deepEqual(made[1].sent, ['Hi Jack.']);
      assert.equal(made[1].finishCalls, 1);
      made[1].push(pcm([1000, 1000, -32768, 32767]));
      made[1].end();
      made[0].say([{ word: 'Hello', startMs: 0, endMs: 90 }, { word: 'world', startMs: 100, endMs: 190 }]);
      made[0].push(pcm([...new Array(100).fill(5), 100, 100, -30000, 30000, ...new Array(96).fill(100)]));
      made[0].end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 200, 'same length as the main speech');
      assert.equal(out[99], 5, 'untouched before the point');
      assert.equal(out[100], 100 + 850, 'sample-wise sum at 0.85');
      assert.equal(out[101], 100 + 850);
      assert.equal(out[102], -32768, 'clipped low');
      assert.equal(out[103], 32767, 'clipped high');
      assert.equal(out[104], 100, 'untouched after the remark');
      assert.deepEqual(log.overlays, [{ speakerId: 'B', text: 'Hi Jack.', offsetMs: 100 }]);
    },
  },
  {
    name: 'panel voice overlay: the start follows the segment offset when the host speaks after another segment',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'o2' });
      const log = collect(stream);
      stream.sendText('First.');
      stream.setSpeaker('C');
      stream.sendText('Second part here.');
      assert.equal(stream.overlay({ speakerId: 'B', text: 'Yes.', afterChars: 6 }), true);
      made[0].push(flat(50, 1)); made[0].end();
      const remark = made.find(s => s.id === 'B');
      remark.push(flat(10, 1000)); remark.end();
      const host = made.find(s => s.id === 'C');
      host.say([{ word: 'Second', startMs: 0, endMs: 40 }, { word: 'part', startMs: 40, endMs: 60 }]);
      host.push(flat(100, 0)); host.end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out[50 + 40], 850, 'offset 50 ms (first segment) plus 40 ms into the second');
      assert.equal(out[50 + 39], 0);
      assert.equal(log.overlays[0].offsetMs, 90);
    },
  },
  {
    name: 'panel voice overlay: a remark that is late holds the main speech briefly, then mixes at the point',
    async run() {
      const clock = fakeClock();
      const { panel, made } = setup({ clock });
      const stream = panel.open({ utteranceId: 'o3' });
      const log = collect(stream);
      stream.sendText('One two three.');
      stream.overlay({ speakerId: 'B', text: 'Right.', afterChars: 3 });
      made[0].say([{ word: 'One', startMs: 0, endMs: 50 }, { word: 'two', startMs: 60, endMs: 100 }]);
      made[0].push(flat(300, 100));
      assert.equal(log.all.length, 120, 'output stops at the start point while the remark is not ready');
      assert.equal(clock.timers.size, 1);
      assert.equal([...clock.timers.values()][0].ms, 250, 'the wait is bounded at 250 ms');
      // The remark arrives in two pieces: the speech keeps waiting for all of it, so it lands whole at the point.
      made[1].push(flat(10, 200));
      assert.equal(log.all.length, 120, 'a first piece of the remark does not release the speech');
      assert.equal(clock.timers.size, 1);
      made[1].push(flat(10, 200));
      made[1].end();
      await Promise.resolve(); await Promise.resolve();
      assert.equal(clock.timers.size, 0, 'the timer is cleared once the whole remark is in');
      assert.equal(log.all.length, 600, 'the held speech is released');
      const out = samples(log.all);
      assert.equal(out[59], 100); assert.equal(out[60], 100 + 170); assert.equal(out[79], 270); assert.equal(out[80], 100);
      made[0].end();
      await stream.finish();
      assert.deepEqual(log.overlays.map(e => e.offsetMs), [60]);
    },
  },
  {
    name: 'panel voice overlay: after 250 ms the speech goes on and the remark mixes in from the moment it arrives',
    async run() {
      const clock = fakeClock();
      const { panel, made } = setup({ clock });
      const stream = panel.open({ utteranceId: 'o4' });
      const log = collect(stream);
      stream.sendText('One two three.');
      stream.overlay({ speakerId: 'B', text: 'Right.', afterChars: 3 });
      made[0].say([{ word: 'One', startMs: 0, endMs: 50 }, { word: 'two', startMs: 60, endMs: 100 }]);
      made[0].push(flat(200, 100));
      assert.equal(log.all.length, 120, 'held at 60 samples');
      clock.fire();
      assert.equal(log.all.length, 400, 'released without the remark');
      assert.deepEqual(log.overlays, []);
      made[0].push(flat(100, 100));
      made[1].push(flat(10, 200));
      made[0].push(flat(100, 100));
      const out = samples(log.all);
      assert.equal(out[299], 100, 'nothing mixed into what already played');
      assert.equal(out[300], 270, 'mixed into the next audio, from the arrival');
      assert.equal(out[309], 270); assert.equal(out[310], 100);
      assert.equal(log.overlays.length, 1);
      assert.equal(log.overlays[0].offsetMs, 300);
      made[1].end(); made[0].end();
      await stream.finish();
    },
  },
  {
    name: 'panel voice overlay: a remark longer than the remaining speech is appended, not dropped',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'o5' });
      const log = collect(stream);
      stream.sendText('Hello world.');
      stream.overlay({ speakerId: 'B', text: 'Good morning to you all.', afterChars: 5 });
      made[1].push(flat(300, 1000)); made[1].end();
      made[0].say([{ word: 'Hello', startMs: 0, endMs: 90 }, { word: 'world.', startMs: 100, endMs: 190 }]);
      made[0].push(flat(200, 100)); made[0].end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 400, 'start at 100 ms plus 300 ms of remark');
      assert.equal(out[100], 950);
      assert.equal(out[199], 950);
      assert.equal(out[200], 850, 'the tail is the remark alone at 0.85');
      assert.equal(out[399], 850);
    },
  },
  {
    name: 'panel voice overlay: a remark tagged after the last word starts where the host segment ends',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'o6' });
      const log = collect(stream);
      stream.sendText('Welcome.');
      stream.overlay({ speakerId: 'C', text: 'Hi.', afterChars: 8 });
      made[0].say([{ word: 'Welcome.', startMs: 0, endMs: 90 }]);
      made[0].push(flat(100, 7)); made[0].end();
      const remark = made.find(s => s.id === 'C');
      remark.push(flat(40, 500)); remark.end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 140);
      assert.equal(out[99], 7);
      assert.equal(out[100], 425);
      assert.deepEqual(log.overlays, [{ speakerId: 'C', text: 'Hi.', offsetMs: 100 }]);
    },
  },
  {
    name: 'panel voice overlay: odd chunk sizes give the same audio as whole chunks',
    async run() {
      const mainValues = Array.from({ length: 300 }, (_, i) => (i * 37) % 2000 - 1000);
      const remarkValues = Array.from({ length: 80 }, (_, i) => (i * 91) % 3000 - 1500);
      const expected = mainValues.map((v, i) => (i >= 120 && i < 200 ? v + Math.round(remarkValues[i - 120] * 0.85) : v));
      for (const sizes of [[600], [101, 99, 1, 3, 200, 196], [7, 593], [1, 1, 598]]) {
        const { panel, made } = setup();
        const stream = panel.open({ utteranceId: 'o7' });
        const log = collect(stream);
        stream.sendText('Alpha beta gamma.');
        stream.overlay({ speakerId: 'B', text: 'Yep.', afterChars: 5 });
        const remark = pcm(remarkValues);
        made[1].push(remark.subarray(0, 51)); made[1].push(remark.subarray(51)); made[1].end();
        made[0].say([{ word: 'Alpha', startMs: 0, endMs: 100 }, { word: 'beta', startMs: 120, endMs: 200 }]);
        const mainBytes = pcm(mainValues);
        let at = 0;
        for (const size of sizes) { made[0].push(mainBytes.subarray(at, at + size)); at += size; }
        made[0].end();
        await stream.finish();
        assert.deepEqual(samples(log.all), expected, `chunks ${sizes.join(',')}`);
        assert.equal(log.all.length, 600);
      }
    },
  },
  {
    name: 'panel voice overlay: cancel closes the remark stream and its timer, and nothing more plays',
    async run() {
      const clock = fakeClock();
      const { panel, made } = setup({ clock });
      const stream = panel.open({ utteranceId: 'o8' });
      const log = collect(stream);
      stream.sendText('One two three.');
      stream.overlay({ speakerId: 'B', text: 'Right.', afterChars: 3 });
      made[0].say([{ word: 'One', startMs: 0, endMs: 50 }, { word: 'two', startMs: 60, endMs: 100 }]);
      made[0].push(flat(200, 100));
      assert.equal(clock.timers.size, 1);
      stream.cancel();
      assert.equal(made[1].cancelCalls, 1);
      assert.equal(clock.timers.size, 0);
      made[1].push(flat(10, 5));
      clock.fire();
      assert.equal(log.all.length, 120, 'the held speech is dropped with the cancel');
      assert.deepEqual(await stream.finish(), { cancelled: true });
      assert.equal(stream.overlay({ speakerId: 'C', text: 'Late.', afterChars: 1 }), false);
    },
  },
  {
    name: 'panel voice overlay: a failing remark stream leaves the main speech untouched and does not fail it',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'o9' });
      const log = collect(stream);
      const errors = [];
      stream.onError(error => errors.push(error));
      stream.sendText('One two three.');
      stream.overlay({ speakerId: 'B', text: 'Right.', afterChars: 3 });
      made[0].say([{ word: 'One', startMs: 0, endMs: 50 }, { word: 'two', startMs: 60, endMs: 100 }]);
      made[0].push(flat(200, 100));
      assert.equal(log.all.length, 120, 'held while the remark is pending');
      made[1].break(new Error('remark failed'));
      assert.equal(log.all.length, 400, 'released at once');
      made[0].end();
      assert.deepEqual(await stream.finish(), { ok: true });
      assert.deepEqual(samples(log.all), new Array(200).fill(100));
      assert.deepEqual(errors, []);
      assert.deepEqual(log.overlays, []);
    },
  },
  {
    name: 'panel voice overlay: unequal sample rates, single speaker panels, and repeats are refused',
    async run() {
      const mixed = setup({ rates: { B: 24000 } });
      const a = mixed.panel.open({ utteranceId: 'o10' });
      a.sendText('Hello.');
      assert.equal(a.overlay({ speakerId: 'B', text: 'Hi.', afterChars: 3 }), false, 'rates differ');
      assert.equal(mixed.made[1].cancelCalls, 1, 'the refused stream is closed');
      const solo = setup({ ids: ['A'] });
      const b = solo.panel.open({ utteranceId: 'o11' });
      b.sendText('Hello.');
      assert.equal(b.overlay({ speakerId: 'A', text: 'Hi.', afterChars: 3 }), false, 'nobody else to speak');
      assert.equal(b.overlay({ speakerId: 'B', text: 'Hi.', afterChars: 3 }), false, 'not on the call');
      const two = setup();
      const c = two.panel.open({ utteranceId: 'o12' });
      c.sendText('Hello there.');
      assert.equal(c.overlay({ speakerId: 'B', text: '', afterChars: 3 }), false, 'empty text');
      assert.equal(c.overlay({ speakerId: 'B', text: 'Hi.', afterChars: 3 }), true);
      assert.equal(c.overlay({ speakerId: 'C', text: 'Hey.', afterChars: 4 }), false, 'one remark per utterance');
      c.cancel();
    },
  },
  {
    name: 'panel voice overlay: afterChars counts non-whitespace characters, so spaces and newlines never shift the anchor',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'o13' });
      const log = collect(stream);
      stream.sendText('Alpha  \n beta');
      stream.sendText(' gamma delta.');
      // "Alpha" + "beta" + "gamma" = 14 non-space characters before "delta."
      assert.equal(stream.overlay({ speakerId: 'B', text: 'Ok.', afterChars: 14 }), true);
      made[1].push(flat(10, 1000)); made[1].end();
      made[0].say([
        { word: 'Alpha', startMs: 0, endMs: 40 }, { word: 'beta', startMs: 50, endMs: 90 },
        { word: 'gamma', startMs: 100, endMs: 140 }, { word: 'delta.', startMs: 150, endMs: 190 },
      ]);
      made[0].push(flat(200, 0)); made[0].end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out[149], 0);
      assert.equal(out[150], 850);
      assert.equal(out[159], 850);
      assert.equal(out[160], 0);
      assert.deepEqual(log.overlays.map(e => e.offsetMs), [150]);
    },
  },
  {
    name: 'panel voice overlay: a remark arriving in several chunks plays whole and in order from the anchor',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'o14' });
      const log = collect(stream);
      stream.sendText('One two three.');
      stream.overlay({ speakerId: 'B', text: 'Right.', afterChars: 3 });
      made[0].say([{ word: 'One', startMs: 0, endMs: 50 }, { word: 'two', startMs: 60, endMs: 100 }]);
      made[0].push(flat(300, 0));
      assert.equal(log.all.length, 120, 'held at the start point');
      const remark = Array.from({ length: 90 }, (_, i) => i + 1);
      made[1].push(pcm(remark.slice(0, 10)));
      made[0].push(flat(100, 0));
      made[1].push(pcm(remark.slice(10, 40)));
      made[0].push(flat(100, 0));
      made[1].push(pcm(remark.slice(40)));
      made[1].end();
      made[0].push(flat(200, 0)); made[0].end();
      await stream.finish();
      const out = samples(log.all);
      const mixed = out.filter(v => v !== 0);
      assert.deepEqual(mixed, remark.map(v => Math.round(v * 0.85)), 'every remark sample once, in order');
      assert.equal(out.length, 700);
      assert.equal(out.indexOf(mixed[0]), 60, 'the first chunk starts at the anchor');
    },
  },
  {
    name: 'panel voice overlay: output length is exactly max(main, anchor + remark) for odd and 1-byte chunking',
    async run() {
      const mainBytes = Buffer.from(Array.from({ length: 601 }, (_, i) => (i * 13) % 251));
      const remarkBytes = Buffer.from(Array.from({ length: 81 }, (_, i) => (i * 7) % 200));
      const cases = [
        { name: 'in the middle', rem: remarkBytes },
        { name: 'runs past the end', rem: Buffer.from(Array.from({ length: 701 }, (_, i) => (i * 5) % 120)) },
      ];
      for (const { rem } of cases) {
        const reference = [];
        for (const sizes of [[601], [1], [3, 7, 590, 1], [200, 401]]) {
          const { panel, made } = setup();
          const stream = panel.open({ utteranceId: 'o15' });
          const log = collect(stream);
          stream.sendText('Alpha beta gamma.');
          stream.overlay({ speakerId: 'B', text: 'Yep.', afterChars: 5 });
          const rsize = sizes[0] === 1 ? 1 : 33;
          for (let at = 0; at < rem.length; at += rsize) made[1].push(rem.subarray(at, at + rsize));
          made[1].end();
          made[0].say([{ word: 'Alpha', startMs: 0, endMs: 100 }, { word: 'beta', startMs: 120, endMs: 200 }]);
          let at = 0;
          const step = sizes[0] === 601 ? [601] : sizes;
          let i = 0;
          while (at < mainBytes.length) {
            const size = sizes[0] === 1 ? 1 : step[i++ % step.length];
            made[0].push(mainBytes.subarray(at, at + size)); at += size;
          }
          made[0].end();
          await stream.finish();
          const out = log.all;
          assert.equal(out.length, Math.max(601, 240 + rem.length), `length for chunks ${sizes[0]}`);
          assert.deepEqual(out.subarray(0, 240), mainBytes.subarray(0, 240), 'identical before the anchor');
          reference.push(out);
        }
        for (const out of reference) assert.deepEqual(out, reference[0], 'chunking never changes the audio');
      }
      // Nothing outside the mixed range changes.
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'o16' });
      const log = collect(stream);
      stream.sendText('Alpha beta.');
      stream.overlay({ speakerId: 'B', text: 'Yep.', afterChars: 5 });
      made[1].push(remarkBytes); made[1].end();
      made[0].say([{ word: 'Alpha', startMs: 0, endMs: 100 }, { word: 'beta.', startMs: 120, endMs: 200 }]);
      made[0].push(mainBytes); made[0].end();
      await stream.finish();
      assert.deepEqual(log.all.subarray(240 + 82), mainBytes.subarray(240 + 82), 'identical after the remark');
    },
  },
  {
    name: 'panel voice overlay: finish does not resolve before the remark tail is emitted',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'o17' });
      const log = collect(stream);
      stream.sendText('Hello world.');
      stream.overlay({ speakerId: 'B', text: 'Long remark.', afterChars: 5 });
      made[0].say([{ word: 'Hello', startMs: 0, endMs: 90 }, { word: 'world.', startMs: 100, endMs: 190 }]);
      made[0].push(flat(200, 1)); made[0].end();
      let resolved = false;
      const done = stream.finish().then(() => { resolved = true; });
      await flush();
      assert.equal(resolved, false, 'the remark is still coming');
      made[1].push(flat(300, 1000)); made[1].end();
      await done;
      assert.equal(samples(log.all).length, 400, 'the tail was emitted before finish resolved');
    },
  },
  {
    name: 'panel voice overlay: cancel with a held start leaves no timer, and without an overlay the audio is untouched',
    async run() {
      const clock = fakeClock();
      const { panel, made } = setup({ clock });
      const stream = panel.open({ utteranceId: 'o18' });
      stream.sendText('One two three.');
      stream.overlay({ speakerId: 'B', text: 'Right.', afterChars: 3 });
      made[0].say([{ word: 'One', startMs: 0, endMs: 50 }, { word: 'two', startMs: 60, endMs: 100 }]);
      made[0].push(flat(200, 100));
      stream.cancel();
      assert.equal(clock.timers.size, 0);
      assert.equal(made[1].cancelCalls, 1);
      assert.equal(made[0].cancelCalls, 1);
      const plain = setup();
      const second = plain.panel.open({ utteranceId: 'o19' });
      const log = collect(second);
      second.sendText('Hi.');
      const raw = Buffer.from(Array.from({ length: 7 }, (_, i) => i + 1));
      plain.made[0].push(raw.subarray(0, 3)); plain.made[0].push(raw.subarray(3)); plain.made[0].end();
      await second.finish();
      assert.deepEqual(log.chunks, [raw.subarray(0, 3), raw.subarray(3)], 'chunks pass through as they came');
    },
  },
];

// ---- cut-ins (an interrupter starts under the end of the interrupted SPEECH) ----

// At 1000 Hz: overlap 700 samples, fade 120, level window 20, held end 700 + 1200 samples.
const OVERLAP = 700;
const FADE = 120;
// Pushes a buffer to a fake stream in pieces of `size` bytes.
const pushIn = (stream, buffer, size) => { for (let at = 0; at < buffer.length; at += size) stream.push(buffer.subarray(at, at + size)); };
// The gain the interrupted voice has on the k-th of its last `n` samples.
const gain = (k, n) => 1 - (k + 1) / n;
const faded = (value, k, n) => Math.round(value * gain(k, n));
const tone = (count, value) => new Array(count).fill(value);
const quiet = count => new Array(count).fill(0);

// A says `aSamples`, cut in on by B who says `bSamples`; B's audio arrives before or after A's end.
async function runCut(aSamples, bSamples, size, { bFirst = false, words = [{ word: 'Sorry', startMs: 250, endMs: 450 }] } = {}) {
  const { panel, made } = setup();
  const stream = panel.open({ utteranceId: 'c' });
  const log = collect(stream);
  const spoken = []; const heard = [];
  stream.onSpeaker(event => spoken.push(event));
  stream.onWords(list => heard.push(...list));
  stream.sendText('I was saying that --');
  assert.equal(stream.setSpeaker('B', { cutIn: true }), true);
  stream.sendText('Sorry to jump in.');
  made[1].say(words);
  if (bFirst) pushIn(made[1], pcm(bSamples), size);
  pushIn(made[0], pcm(aSamples), size);
  made[0].end();
  await flush();
  if (!bFirst) pushIn(made[1], pcm(bSamples), size);
  made[1].end();
  await stream.finish();
  return { out: samples(log.all), bytes: log.all, spoken, words: heard };
}

// Tone, then 400 ms of silence; B has 150 ms of leading silence, then speech.
const toneA = (tail = 1500) => [...tone(tail, 100), ...quiet(400)];
const toneB = () => [...quiet(150), ...tone(1000, 50)];

export const cutInTests = [
  {
    name: 'panel voice cut-in: constants are exported with the owner-tuned values',
    async run() {
      assert.equal(CUT_IN_OVERLAP_MS, 700);
      assert.equal(CUT_IN_FADE_MS, 120);
      assert.equal(CUT_IN_TRAILING_ALLOWANCE_MS, 1200);
      assert.equal(CUT_IN_LEVEL_WINDOW_MS, 20);
      assert.ok(CUT_IN_SPEECH_FLOOR > 0 && CUT_IN_SPEECH_RATIO > 0 && CUT_IN_SPEECH_RATIO < 1);
    },
  },
  {
    name: 'panel voice cut-in: the interrupter starts 700 ms before the END OF THE SPEECH, trailing silence is dropped, the old voice fades, leading silence is skipped',
    async run() {
      for (const tail of [1500, 3000]) { // the second: more audio than the held end, so the head plays early
        const { out, spoken, words } = await runCut(toneA(tail), toneB(), 1 << 20);
        const start = tail - OVERLAP;
        assert.equal(out.length, start + 1000, `total is what was emitted (${tail})`);
        assert.ok(out.slice(0, start).every(v => v === 100), 'the interrupted voice alone first');
        assert.ok(out.slice(start, tail - FADE).every(v => v === 150), 'both voices at full level, the interrupter already speaking');
        for (let k = 0; k < FADE; k += 1) assert.equal(out[tail - FADE + k], faded(100, k, FADE) + 50, `fade sample ${k}`);
        assert.equal(out[tail - 1], 50, 'the old voice is silent at its speech end');
        assert.ok(out.slice(tail).every(v => v === 50), 'the interrupter alone after, no trailing silence in between');
        assert.deepEqual(spoken, [{ speakerId: 'A', startMs: 0 }, { speakerId: 'B', startMs: start }]);
        // B said the word at 250..450 ms of its own audio, of which 150 ms of silence was skipped.
        assert.deepEqual(words.map(w => [w.speakerId, w.startMs, w.endMs]), [['B', start + 100, start + 300]]);
      }
    },
  },
  {
    name: 'panel voice cut-in: the same result for chunk sizes 1, 3, 7 and one huge chunk, and when the new speaker is ready first',
    async run() {
      const reference = await runCut(toneA(), toneB(), 1 << 20);
      for (const size of [1, 3, 7]) {
        for (const bFirst of [false, true]) {
          const got = await runCut(toneA(), toneB(), size, { bFirst });
          assert.deepEqual(got.out, reference.out, `chunks of ${size}, bFirst ${bFirst}`);
          assert.deepEqual(got.spoken, reference.spoken);
          assert.deepEqual(got.words, reference.words);
        }
      }
      assert.deepEqual((await runCut(toneA(), toneB(), 1 << 20, { bFirst: true })).out, reference.out);
    },
  },
  {
    name: 'panel voice cut-in: a skipped leading silence is chunk independent also when it ends mid window and mid sample',
    async run() {
      for (const lead of [0, 1, 19, 20, 21, 333]) {
        const b = [...quiet(lead), ...tone(900, 50)];
        const ref = await runCut(toneA(), b, 1 << 20);
        assert.equal(ref.out.length, 800 + 900, `lead ${lead}`);
        assert.equal(ref.out[800], 150);
        for (const size of [1, 5]) assert.deepEqual((await runCut(toneA(), b, size)).out, ref.out, `lead ${lead}, chunks of ${size}`);
      }
    },
  },
  {
    name: 'panel voice cut-in: overlapping samples are clipped to 16 bits',
    async run() {
      // A: speech with two loud samples at 100 and 101, ends at 600, then 100 of silence.
      const a = [...tone(100, 1000), 30000, -30000, ...tone(498, 1000), ...quiet(100)];
      const b = [...tone(100, 20), 30000, -30000, 7, ...tone(697, 20)];
      const { out } = await runCut(a, b, 1 << 20);
      assert.equal(out.length, 800, 'B starts with A and outlasts it');
      assert.equal(out[100], 32767, 'clipped high');
      assert.equal(out[101], -32768, 'clipped low');
      assert.equal(out[102], 1007, 'a plain sum');
      assert.equal(out[700], 20, 'the interrupter alone after the old voice ends');
    },
  },
  {
    name: 'panel voice cut-in: an interrupted segment with less speech than the overlap is overlapped whole, trailing silence dropped',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'c3' });
      const log = collect(stream);
      const spoken = []; stream.onSpeaker(event => spoken.push(event));
      stream.sendText('a --'); stream.setSpeaker('B', { cutIn: true }); stream.sendText('b');
      made[0].push(pcm([...tone(200, 100), ...quiet(400)])); made[0].end();
      made[1].push(flat(500, 10)); made[1].end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 500);
      assert.ok(out.slice(0, 80).every(v => v === 110));
      for (let k = 0; k < FADE; k += 1) assert.equal(out[80 + k], faded(100, k, FADE) + 10);
      assert.ok(out.slice(200).every(v => v === 10));
      assert.deepEqual(spoken.map(e => e.startMs), [0, 0]);
    },
  },
  {
    name: 'panel voice cut-in: an interrupted segment that is all silence falls back to a plain switch (nothing dropped, nothing skipped)',
    async run() {
      const b = [...quiet(50), ...tone(400, 30)];
      const { out, spoken, words } = await runCut(quiet(500), b, 1 << 20);
      assert.equal(out.length, 500 + 450);
      assert.ok(out.slice(0, 500).every(v => v === 0));
      assert.deepEqual(out.slice(500), b, 'the interrupter plays whole, leading silence included');
      assert.deepEqual(spoken.map(e => e.startMs), [0, 500]);
      assert.deepEqual(words.map(w => w.startMs), [750]);
    },
  },
  {
    name: 'panel voice cut-in: an interrupter shorter than the overlap leaves the rest of the old speech playing alone',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'c4' });
      const log = collect(stream);
      stream.sendText('a --'); stream.setSpeaker('B', { cutIn: true }); stream.sendText('b');
      made[0].push(flat(1000, 100)); made[0].end();
      made[1].push(flat(100, 20)); made[1].end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 1000, 'total is 1000 + 100 - 100');
      assert.ok(out.slice(0, 300).every(v => v === 100));
      assert.ok(out.slice(300, 400).every(v => v === 120));
      assert.ok(out.slice(400, 880).every(v => v === 100));
      for (let k = 0; k < FADE; k += 1) assert.equal(out[880 + k], faded(100, k, FADE), 'the uncovered rest still fades out');
    },
  },
  {
    name: 'panel voice cut-in: a cut-in straight after a cut-in, and a switch back after the interrupter has no overlap',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'c5' });
      const log = collect(stream);
      const spoken = []; stream.onSpeaker(event => spoken.push(event));
      stream.sendText('a --'); stream.setSpeaker('B', { cutIn: true });
      stream.sendText('b --'); stream.setSpeaker('C', { cutIn: true });
      stream.sendText('c.'); stream.setSpeaker('A');
      stream.sendText('resume');
      made[3].push(flat(100, 400)); made[3].end();
      made[2].push(flat(600, 300)); made[2].end();
      made[1].push(flat(800, 200)); made[1].end();
      made[0].push(flat(1000, 100)); made[0].end();
      await stream.finish();
      const out = samples(log.all);
      // A ends at 1000: B starts at 300 and ends at 1100; B ends at 1100: C starts at 400; C ends at 1000.
      assert.deepEqual(spoken.map(e => e.startMs), [0, 300, 400, 1100]);
      assert.equal(out.length, 1200);
      assert.ok(out.slice(0, 300).every(v => v === 100));
      assert.ok(out.slice(300, 400).every(v => v === 300), 'A + B');
      assert.ok(out.slice(400, 880).every(v => v === 600), 'A + B + C');
      assert.ok(out.slice(1100).every(v => v === 400), 'the resume follows without overlap');
    },
  },
  {
    name: 'panel voice cut-in: a switch without the flag stays strictly sequential, byte for byte, trailing silence included',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'c6' });
      const log = collect(stream);
      stream.sendText('a'); stream.setSpeaker('B', {}); stream.sendText('b');
      const a = pcm([...tone(300, 100), ...quiet(400)]);
      made[0].push(a);
      assert.equal(samples(log.all).length, 700, 'nothing is withheld without a cut-in');
      made[0].end();
      const b = pcm([...quiet(30), ...tone(70, 20)]);
      made[1].push(b); made[1].end();
      await stream.finish();
      assert.deepEqual(log.all, Buffer.concat([a, b]));
    },
  },
  {
    name: 'panel voice cut-in: the end of a last segment is flushed whole by finish, and nothing is played after cancel',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'c7' });
      const log = collect(stream);
      stream.sendText('a --'); stream.setSpeaker('B', { cutIn: true });
      made[0].push(pcm([...tone(800, 9), ...quiet(200)]));
      assert.equal(samples(log.all).length, 0, 'the end is held while the cut-in is expected');
      made[0].end();
      await stream.finish();
      assert.equal(samples(log.all).length, 1000, 'an interrupter that never speaks costs nothing: the end is flushed whole');
      const cancelled = setup();
      const second = cancelled.panel.open({ utteranceId: 'c8' });
      const log2 = collect(second);
      second.sendText('a --'); second.setSpeaker('B', { cutIn: true }); second.sendText('b');
      cancelled.made[0].push(flat(3000, 9));
      assert.equal(samples(log2.all).length, 1100, 'all but the held end has left');
      second.cancel();
      cancelled.made[0].push(flat(100, 9)); cancelled.made[1].push(flat(100, 9));
      await second.finish();
      assert.equal(samples(log2.all).length, 1100, 'only what had left before the cancel');
    },
  },
  {
    name: 'panel voice cut-in: combined with a remark in the same utterance, the length is the cut-in total',
    async run() {
      const { panel, made } = setup({ ids: ['A', 'B', 'C'] });
      const stream = panel.open({ utteranceId: 'c9' });
      const log = collect(stream);
      stream.sendText('Hello world there --');
      assert.equal(stream.overlay({ speakerId: 'C', text: 'Hi.', afterChars: 5 }), true);
      stream.setSpeaker('B', { cutIn: true });
      stream.sendText('Sorry.');
      made[0].say([{ word: 'Hello', startMs: 0, endMs: 90 }, { word: 'world', startMs: 100, endMs: 190 }]);
      made[1].push(flat(10, 1000)); made[1].end(); // the remark (opened first)
      made[0].push(flat(1000, 100)); made[0].end();
      made[2].push(flat(400, 50)); made[2].end(); // the interrupter
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 1000, 'the interrupter starts at 300 and is shorter than the overlap');
      assert.equal(out[99], 100);
      assert.equal(out[100], 100 + 850, 'the remark is mixed where it was asked for');
      assert.equal(out[300], 150);
    },
  },
  {
    name: 'panel voice cut-in: every chunking keeps every byte, also when the interrupted voice is shorter than the overlap',
    async run() {
      for (const aLen of [200, 301, 349, 350]) {
        for (const bLen of [800, 801]) {
          const aSamples = Array.from({ length: aLen }, (_, i) => 1000 + i);
          const bSamples = Array.from({ length: bLen }, (_, i) => 5000 + i);
          const fade = Math.min(FADE, aLen); // the interrupted voice fades over its last stretch
          for (const size of [1, 3, 5, 7, 9]) {
            for (const bFirst of [false, true]) {
              const { out, bytes } = await runCut([...aSamples, ...quiet(100)], bSamples, size, { bFirst });
              const label = `A ${aLen}, B ${bLen}, chunks of ${size}, ${bFirst ? 'B first' : 'B after'}`;
              assert.equal(bytes.length, bLen * 2, label);
              for (let i = 0; i < out.length; i += 1) {
                const a = i < aLen ? (i >= aLen - fade ? faded(aSamples[i], i - (aLen - fade), fade) : aSamples[i]) : 0;
                assert.equal(out[i], a + bSamples[i], `${label} sample ${i}`);
              }
            }
          }
        }
      }
    },
  },
  {
    name: 'panel voice cut-in: a slow interrupter does not leave a gap, the whole end plays alone after the budget and timings are not shifted',
    async run() {
      const clock = fakeClock();
      let now = 0;
      clock.now = () => now;
      const { panel, made } = setup({ clock });
      const stream = panel.open({ utteranceId: 'slow' });
      const log = collect(stream);
      const spoken = []; const words = [];
      stream.onSpeaker(event => spoken.push(event));
      stream.onWords(list => words.push(...list));
      stream.sendText('a --'); stream.setSpeaker('B', { cutIn: true }); stream.sendText('b');
      pushIn(made[0], pcm([...tone(2600, 100), ...quiet(400)]), 1 << 20); made[0].end();
      await flush();
      assert.equal(log.all.length, 1100 * 2, 'the held end is withheld while the interrupter is awaited');
      assert.equal(clock.timers.size, 1);
      // 1100 ms were handed out at time 0, so 1100 - 200 ms of speech is still queued for playback.
      assert.equal([...clock.timers.values()][0].ms, 1100 - 200);
      now = 450;
      clock.fire();
      assert.equal(log.all.length, 3000 * 2, 'the whole end plays on its own, trailing silence included');
      assert.equal(clock.timers.size, 0);
      made[1].say([{ word: 'Sorry', startMs: 0, endMs: 200 }]);
      pushIn(made[1], pcm([...quiet(40), ...tone(600, 50)]), 1 << 20); made[1].end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 3640, 'no overlap and no skip');
      assert.ok(out.slice(0, 2600).every(v => v === 100));
      assert.ok(out.slice(2600, 3000).every(v => v === 0));
      assert.ok(out.slice(3040).every(v => v === 50));
      assert.deepEqual(spoken, [{ speakerId: 'A', startMs: 0 }, { speakerId: 'B', startMs: 3000 }]);
      assert.deepEqual(words.map(w => [w.startMs, w.endMs]), [[3000, 3200]]);
    },
  },
  {
    name: 'panel voice cut-in: no wait at all when nothing is queued ahead, and the timer goes when the interrupter speaks, finishes or is cancelled',
    async run() {
      const clock = fakeClock();
      let now = 0;
      clock.now = () => now;
      const start = () => {
        const { panel, made } = setup({ clock });
        const stream = panel.open({ utteranceId: 'w' });
        const log = collect(stream);
        stream.sendText('a --'); stream.setSpeaker('B', { cutIn: true }); stream.sendText('b');
        return { stream, made, log };
      };
      // Everything already played: the budget is zero, the end goes out at once.
      const run1 = start();
      pushIn(run1.made[0], flat(3000, 100), 1 << 20);
      now = 5000;
      run1.made[0].end();
      await flush();
      assert.equal(clock.timers.size, 0);
      assert.equal(run1.log.all.length, 6000);
      run1.made[1].end(); await run1.stream.finish();
      // The interrupter speaks in time: mixed, and the timer is gone.
      now = 0;
      const run2 = start();
      pushIn(run2.made[0], flat(3000, 100), 1 << 20); run2.made[0].end();
      await flush();
      assert.equal(clock.timers.size, 1);
      pushIn(run2.made[1], flat(600, 50), 1 << 20);
      assert.equal(clock.timers.size, 0);
      run2.made[1].end(); await run2.stream.finish();
      assert.equal(run2.log.all.length, 3000 * 2, 'starts at 2300 and the rest of the old voice plays on');
      // Cancelled while waiting.
      const run3 = start();
      pushIn(run3.made[0], flat(3000, 100), 1 << 20); run3.made[0].end();
      await flush();
      assert.equal(clock.timers.size, 1);
      run3.stream.cancel();
      assert.equal(clock.timers.size, 0);
      // The interrupter ends without any audio: the end plays and the timer goes.
      const run4 = start();
      pushIn(run4.made[0], flat(3000, 100), 1 << 20); run4.made[0].end();
      await flush();
      run4.made[1].end(); await run4.stream.finish();
      assert.equal(clock.timers.size, 0);
      assert.equal(run4.log.all.length, 6000);
    },
  },
  {
    name: 'panel voice cut-in: a rate mismatch known only when the interrupter opens falls back to a sequential switch',
    async run() {
      const { panel, made } = setup({ rates: { B: 2000 } });
      const stream = panel.open({ utteranceId: 'rate' });
      const log = collect(stream);
      stream.sendText('a --'); stream.setSpeaker('B', { cutIn: true });
      // The interrupter has no stream yet (no text sent), so the rate cannot be compared at the switch.
      pushIn(made[0], pcm([...tone(900, 100), ...quiet(100)]), 1 << 20); made[0].end();
      await flush();
      stream.sendText('b');
      pushIn(made[1], flat(600, 50), 1 << 20); made[1].end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 1600, 'no overlap, nothing dropped');
      assert.ok(out.slice(0, 900).every(v => v === 100));
      assert.ok(out.slice(900, 1000).every(v => v === 0));
      assert.ok(out.slice(1000).every(v => v === 50));
    },
  },
];

// ---- gap (real silence between two separately synthesised segments) ----

const hasOnly = (out, from, to, value) => out.slice(from, to).every(v => v === value);

// A says 300 samples, gap 500, A again says 200. `order` decides when the second segment's audio arrives.
async function runGap(size, order) {
  const { panel, made } = setup();
  const stream = panel.open({ utteranceId: 'g' });
  const log = collect(stream);
  const spoken = []; const heard = [];
  stream.onSpeaker(event => spoken.push(event));
  stream.onWords(list => heard.push(...list));
  stream.sendText('First part.');
  assert.equal(stream.gap(500), true);
  stream.sendText('Second part.');
  assert.equal(made.length, 2, 'the text after the gap is a new stream on the same voice');
  assert.equal(made[1].id, 'A');
  assert.deepEqual(made[0].sent, ['First part.']);
  assert.deepEqual(made[1].sent, ['Second part.']);
  assert.equal(made[0].finishCalls, 1, 'the first segment is finished so its audio plays out whole');
  const second = pcm(new Array(200).fill(50));
  if (order === 'before') pushIn(made[1], second, size);
  if (order === 'mid') pushIn(made[1], second.subarray(0, 100), size);
  made[1].say([{ word: 'Second', startMs: 10, endMs: 90 }]);
  pushIn(made[0], flat(300, 100), size);
  made[0].say([{ word: 'First', startMs: 0, endMs: 200 }]);
  made[0].end();
  await flush();
  if (order === 'mid') pushIn(made[1], second.subarray(100), size);
  if (order === 'after') pushIn(made[1], second, size);
  made[1].end();
  await stream.finish();
  return { out: samples(log.all), spoken, heard, log };
}

export const gapTests = [
  ...[1, 3, 7, 480, 1 << 20].flatMap(size => ['before', 'mid', 'after'].map(order => ({
    name: `panel voice gap: audio, exact zero samples, audio (chunk ${size} bytes, second segment audio ${order})`,
    async run() {
      const { out, spoken, heard, log } = await runGap(size, order);
      assert.equal(out.length, 300 + 500 + 200);
      assert.ok(hasOnly(out, 0, 300, 100));
      assert.ok(hasOnly(out, 300, 800, 0), 'exactly the gap of silence');
      assert.ok(hasOnly(out, 800, 1000, 50));
      assert.ok(log.chunks.every(chunk => chunk.length <= 200 || chunk.length === size || size > 200 || chunk.length <= 7), 'silence is not one huge buffer');
      assert.deepEqual(heard.map(w => [w.word, w.startMs, w.endMs]), [['First', 0, 200], ['Second', 810, 890]]);
      assert.deepEqual(spoken, [{ speakerId: 'A', startMs: 0 }, { speakerId: 'A', startMs: 800 }]);
    },
  }))),
  {
    name: 'panel voice gap: silence leaves in modest chunks',
    async run() {
      const { out, log } = await runGap(1 << 20, 'after');
      assert.equal(out.length, 1000);
      assert.ok(Math.max(...log.chunks.map(c => c.length)) <= 600, 'the silence of 500 samples is split, the longest chunk is the segment audio');
      assert.ok(log.chunks.filter(c => c.length === 200).length >= 5, 'silence goes out in 100 sample chunks');
    },
  },
  {
    name: 'panel voice gap: works in a single-speaker factory',
    async run() {
      const { panel, made } = setup({ ids: ['A'] });
      const stream = panel.open({ utteranceId: 'g1' });
      const log = collect(stream);
      stream.sendText('One.'); stream.gap(100); stream.sendText('Two.');
      made[0].push(flat(50, 7)); made[0].end(); made[1].push(flat(50, 9)); made[1].end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 200);
      assert.ok(hasOnly(out, 0, 50, 7) && hasOnly(out, 50, 150, 0) && hasOnly(out, 150, 200, 9));
    },
  },
  {
    name: 'panel voice gap: followed by a speaker switch, offsets stack',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'g2' });
      const log = collect(stream);
      const spoken = []; const heard = [];
      stream.onSpeaker(event => spoken.push(event));
      stream.onWords(list => heard.push(...list));
      stream.sendText('One.'); stream.gap(200); stream.sendText('Two.'); stream.setSpeaker('B'); stream.sendText('Three.');
      made[2].push(flat(30, 3)); made[2].say([{ word: 'Three', startMs: 5, endMs: 20 }]);
      made[1].push(flat(40, 2)); made[1].say([{ word: 'Two', startMs: 0, endMs: 30 }]);
      made[0].push(flat(100, 1)); made[0].end(); made[1].end(); made[2].end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 100 + 200 + 40 + 30);
      assert.ok(hasOnly(out, 100, 300, 0) && hasOnly(out, 300, 340, 2) && hasOnly(out, 340, 370, 3));
      assert.deepEqual(heard.map(w => [w.word, w.startMs, w.speakerId]), [['Two', 300, 'A'], ['Three', 345, 'B']]);
      assert.deepEqual(spoken, [{ speakerId: 'A', startMs: 0 }, { speakerId: 'A', startMs: 300 }, { speakerId: 'B', startMs: 340 }]);
    },
  },
  {
    name: 'panel voice gap: a remark anchored in the second segment counts characters from the gap',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'g3' });
      const log = collect(stream);
      stream.sendText('Before words.'); stream.gap(300); stream.sendText('Hello world there.');
      assert.equal(stream.overlay({ speakerId: 'B', text: 'Hi.', afterChars: 5 }), true);
      const remark = made.find(item => item.id === 'B');
      remark.push(flat(40, 1000)); remark.end();
      made[0].push(flat(100, 10)); made[0].end();
      made[1].push(flat(400, 100));
      made[1].say([{ word: 'Hello', startMs: 0, endMs: 100 }, { word: 'world', startMs: 200, endMs: 300 }]);
      made[1].end();
      await stream.finish();
      const out = samples(log.all);
      const at = 100 + 300 + 200;
      assert.equal(out.length, 800);
      assert.ok(hasOnly(out, at - 1, at, 100) && out[at] === 100 + 850 && out[at + 39] === 950 && out[at + 40] === 100);
      assert.equal(log.overlays[0].offsetMs, 600);
    },
  },
  {
    name: 'panel voice gap: a remark running into the start of the silence plays whole',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'g4' });
      const log = collect(stream);
      stream.sendText('Hello world.');
      stream.overlay({ speakerId: 'B', text: 'Yes.', afterChars: 5 });
      stream.gap(300); stream.sendText('Next.');
      made[0].say([{ word: 'Hello', startMs: 0, endMs: 50 }, { word: 'world', startMs: 60, endMs: 100 }]);
      made[0].push(flat(100, 10));
      const remark = made.find(item => item.id === 'B');
      remark.push(flat(160, 1000)); remark.end(); // outlasts the 40 samples left of segment 1
      made[0].end();
      made[2].push(flat(20, 5)); made[2].end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 100 + 300 + 20);
      assert.equal(out[60], 10 + 850);
      assert.ok(hasOnly(out, 100, 220, 850), 'the remark continues over the silence');
      assert.ok(hasOnly(out, 220, 400, 0) && hasOnly(out, 400, 420, 5));
    },
  },
  {
    name: 'panel voice gap: silence counts as buffered audio for the remark hold',
    async run() {
      const clock = fakeClock();
      let now = 0; clock.now = () => now;
      const { panel, made } = setup({ clock });
      const stream = panel.open({ utteranceId: 'g5' });
      const log = collect(stream);
      stream.sendText('Hello world.');
      stream.overlay({ speakerId: 'B', text: 'Yes.', afterChars: 5 });
      stream.gap(2000); stream.sendText('Next.');
      made[0].say([{ word: 'Hello', startMs: 0, endMs: 50 }, { word: 'world', startMs: 60, endMs: 100 }]);
      made[0].push(flat(10, 10)); made[0].push(flat(90, 10)); // first audio out: 10 samples; the rest waits for the remark
      made[0].end(); made[2].push(flat(10, 5)); made[2].end();
      await flush();
      const hold = [...clock.timers.values()][0];
      assert.ok(hold && hold.ms >= 250, 'the main speech waits for the remark');
      made.find(item => item.id === 'B').push(flat(30, 1000)); made.find(item => item.id === 'B').end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 100 + 2000 + 10);
      assert.equal(clock.timers.size, 0);
    },
  },
  {
    name: 'panel voice gap: gap(0), NaN and a missing value do nothing and the output is byte-identical',
    async run() {
      const run = async withCalls => {
        const { panel, made } = setup();
        const stream = panel.open({ utteranceId: 'g6' });
        const log = collect(stream);
        stream.sendText('One.');
        if (withCalls) for (const value of [0, NaN, undefined, -5, Infinity * 0, 'x']) assert.equal(stream.gap(value), false);
        stream.sendText('Two.');
        made[0].push(flat(60, 4)); made[0].end();
        await stream.finish();
        return { bytes: log.all, count: made.length };
      };
      const a = await run(false); const b = await run(true);
      assert.equal(b.count, 1, 'no new segment');
      assert.ok(a.bytes.equals(b.bytes));
    },
  },
  {
    name: 'panel voice gap: clamped to 20 seconds',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'g7' });
      const log = collect(stream);
      stream.sendText('One.'); stream.gap(1e9);
      made[0].push(flat(10, 4)); made[0].end();
      await stream.finish();
      assert.equal(log.all.length / 2, 10 + GAP_MAX_MS);
    },
  },
  {
    name: 'panel voice gap: finish waits for a trailing gap, and it is emitted',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'g8' });
      const log = collect(stream);
      stream.sendText('One.'); stream.gap(400);
      let done = false;
      const finishing = stream.finish().then(() => { done = true; });
      await flush();
      assert.equal(done, false, 'the first segment is still speaking');
      made[0].push(flat(50, 4)); made[0].end();
      await finishing;
      const out = samples(log.all);
      assert.equal(out.length, 450);
      assert.ok(hasOnly(out, 50, 450, 0));
    },
  },
  {
    name: 'panel voice gap: before any text it is leading silence, also after a cut-in switch',
    async run() {
      const { panel, made } = setup();
      const stream = panel.open({ utteranceId: 'g9' });
      const log = collect(stream);
      stream.gap(100);
      stream.sendText('One.');
      made[0].push(flat(50, 4)); made[0].end();
      stream.setSpeaker('B', { cutIn: true });
      stream.gap(200);
      stream.sendText('Two.');
      made[1].push(flat(30, 6)); made[1].end();
      await stream.finish();
      const out = samples(log.all);
      assert.equal(out.length, 100 + 50 + 200 + 30);
      assert.ok(hasOnly(out, 0, 100, 0) && hasOnly(out, 100, 150, 4) && hasOnly(out, 150, 350, 0) && hasOnly(out, 350, 380, 6), 'the cut-in becomes a plain switch');
    },
  },
  {
    name: 'panel voice gap: cancel during the gap emits nothing more and leaves no timers',
    async run() {
      const clock = fakeClock();
      const { panel, made } = setup({ clock });
      const stream = panel.open({ utteranceId: 'g10' });
      const log = collect(stream);
      let total = 0;
      stream.onAudio(buffer => { total += buffer.length; if (total >= 120 * 2) stream.cancel(); });
      stream.sendText('One.'); stream.gap(1000); stream.sendText('Two.');
      made[0].push(flat(50, 4)); made[0].end();
      made[1].push(flat(50, 5)); made[1].end();
      await flush();
      const emitted = log.all.length;
      assert.ok(emitted >= 240 && emitted < (50 + 1000 + 50) * 2, 'stopped part way through the silence');
      assert.deepEqual(await stream.finish(), { cancelled: true });
      assert.equal(log.all.length, emitted);
      assert.equal(clock.timers.size, 0);
      assert.equal(stream.gap(100), false);
    },
  },
];

export default [...baseTests, ...overlayTests, ...cutInTests, ...gapTests];
