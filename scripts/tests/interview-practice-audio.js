import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPracticeAudioHelper, PRACTICE_AUDIO_MESSAGES, practiceAudioHelperPath } from '../../electron/interviewPracticeAudio.js';

const RECORDING = '/tmp/synthetic-practice-call.wav';
const ERROR_CODES = ['permission-denied', 'unsupported-locale', 'speech-assets', 'unsupported-platform', 'helper-unavailable',
  'capture-failed', 'recognition-failed', 'playback-failed', 'recording-failed'];

function harness(extra = {}) {
  const children = []; const events = []; const timers = []; const calls = [];
  const helper = createPracticeAudioHelper({
    helperPath: '/tmp/synthetic-practice-helper', platform: 'darwin', arch: 'arm64',
    onEvent: event => events.push(event),
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      if (extra.throwOnSpawn) throw new Error('/private/synthetic/path');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = { resumed: 0, resume() { this.resumed += 1; } };
      child.stdin = new EventEmitter();
      child.stdin.lines = []; child.stdin.accept = true; child.stdin.ended = false;
      child.stdin.write = line => { child.stdin.lines.push(line); return child.stdin.accept; };
      child.stdin.end = () => { child.stdin.ended = true; };
      child.signals = [];
      child.kill = signal => { child.signals.push(signal); return true; };
      children.push(child);
      return child;
    },
    setTimeoutFn: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() { this.unrefd = true; } }; timers.push(timer); return timer; },
    clearTimeoutFn: timer => { timer.cleared = true; },
    ...extra.options,
  });
  return { helper, children, events, timers, calls,
    send(value, child = children.at(-1)) { child.stdout.emit('data', Buffer.from(`${JSON.stringify(value)}\n`)); },
    raw(text, child = children.at(-1)) { child.stdout.emit('data', Buffer.isBuffer(text) ? text : Buffer.from(text)); },
    sent(child = children.at(-1)) { return child.stdin.lines.map(line => JSON.parse(line)); },
  };
}
const started = extra => { const h = harness(extra); assert.deepEqual(h.helper.start({ recordingPath: RECORDING }), { ok: true }); return h; };
const pcm = bytes => { const buffer = Buffer.alloc(bytes); for (let i = 0; i < bytes; i += 1) buffer[i] = (i * 7 + 3) & 0xff; return buffer; };

export default [
  {
    name: 'interview practice audio: helper path resolves packaged and development bundles',
    run() {
      assert.equal(practiceAudioHelperPath({ packaged: true, resourcesPath: '/tmp/resources' }),
        '/tmp/resources/practice-audio/Practice Audio Helper.app/Contents/MacOS/practice-audio-helper');
      assert.equal(practiceAudioHelperPath({ projectDir: '/tmp/project' }),
        '/tmp/project/native/practice-audio/build/Practice Audio Helper.app/Contents/MacOS/practice-audio-helper');
    },
  },
  {
    name: 'interview practice audio: every error code has a plain user-facing message',
    run() {
      assert.deepEqual(Object.keys(PRACTICE_AUDIO_MESSAGES).sort(), [...ERROR_CODES].sort());
      for (const code of ERROR_CODES) assert(PRACTICE_AUDIO_MESSAGES[code].length > 20 && PRACTICE_AUDIO_MESSAGES[code].length < 220, code);
      assert.match(PRACTICE_AUDIO_MESSAGES['permission-denied'], /System Settings → Privacy & Security → Microphone/u);
      assert.match(PRACTICE_AUDIO_MESSAGES['unsupported-platform'], /Apple Silicon and macOS 26 or later/u);
      assert.throws(() => { PRACTICE_AUDIO_MESSAGES['capture-failed'] = 'x'; }, TypeError);
    },
  },
  {
    name: 'interview practice audio: start spawns the helper with exact args and refuses bad platforms, paths and double starts',
    run() {
      const h = harness();
      assert.equal(h.helper.state().status, 'idle');
      assert.deepEqual(h.helper.start({ recordingPath: RECORDING }), { ok: true });
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].command, '/tmp/synthetic-practice-helper');
      assert.deepEqual(h.calls[0].args, ['--parent-pid', String(process.pid), '--locale', 'en-US', '--recording', RECORDING]);
      assert.equal(h.calls[0].options.shell, false);
      assert.deepEqual(h.calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
      assert.equal(h.helper.state().status, 'starting');
      assert.deepEqual(h.helper.start({ recordingPath: RECORDING }), { ok: false, code: 'already-running' });
      assert.equal(h.calls.length, 1);
      h.helper.stop();
      for (const [platform, arch] of [['linux', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
        const bad = harness({ options: { platform, arch } });
        assert.deepEqual(bad.helper.start({ recordingPath: RECORDING }), { ok: false, code: 'unsupported-platform' });
        assert.equal(bad.calls.length, 0);
      }
      for (const recordingPath of ['relative/call.wav', '/tmp/call.mp3', '/tmp/call.wav.txt', '', undefined, 42, '/tmp/call\n.wav']) {
        const bad = harness();
        assert.deepEqual(bad.helper.start({ recordingPath }), { ok: false, code: 'recording-failed' });
        assert.equal(bad.calls.length, 0);
      }
      assert.deepEqual(harness().helper.start(), { ok: false, code: 'recording-failed' });
    },
  },
  {
    name: 'interview practice audio: a spawn throw or child error maps to helper-unavailable without leaking the path',
    run() {
      const thrown = harness({ throwOnSpawn: true });
      assert.deepEqual(thrown.helper.start({ recordingPath: RECORDING }), { ok: false, code: 'helper-unavailable' });
      assert.equal(thrown.helper.state().errorCode, 'helper-unavailable');
      assert.equal(thrown.helper.state().message, PRACTICE_AUDIO_MESSAGES['helper-unavailable']);
      const h = started();
      h.children[0].emit('error', new Error('/private/synthetic/path'));
      assert.equal(h.helper.state().status, 'error');
      assert.equal(h.helper.state().errorCode, 'helper-unavailable');
      assert(!h.helper.state().message.includes('/private'));
      assert.deepEqual(h.events, [{ type: 'error', code: 'helper-unavailable' }]);
      assert.deepEqual(h.children[0].signals, ['SIGTERM']);
      // A new start works after an error.
      assert.deepEqual(h.helper.start({ recordingPath: RECORDING }), { ok: true });
      assert.equal(h.children.length, 2);
    },
  },
  {
    name: 'interview practice audio: valid helper events are forwarded as fresh objects with only the listed fields and update state',
    run() {
      const h = started();
      const inputs = [
        { type: 'status', state: 'preparing' },
        { type: 'status', state: 'ready' },
        { type: 'level', rms: 0.25, atMs: 100 },
        { type: 'level', rms: 0, atMs: 0 },
        { type: 'level', rms: 1, atMs: 200 },
        { type: 'vad', speaking: true, atMs: 300 },
        { type: 'transcript', text: 'Synthetic words.', segmentId: 's1', final: false, startMs: 10, endMs: 10 },
        { type: 'transcript', text: 'x'.repeat(4000), segmentId: 's2', final: true, startMs: 10, endMs: 900 },
        { type: 'playback', utteranceId: 'utt_1-A', state: 'started', positionMs: 0, atMs: 5 },
        { type: 'playback', utteranceId: 'utt_1-A', state: 'position', positionMs: 50, atMs: 55 },
        { type: 'playback', utteranceId: 'utt_1-A', state: 'finished', positionMs: 90, atMs: 95 },
        { type: 'playback', utteranceId: 'utt_1-A', state: 'cancelled', positionMs: 60, atMs: 65 },
        { type: 'recording', state: 'closed', durationMs: 1234 },
      ];
      for (const input of inputs) {
        h.send({ ...input, extra: 'ignored', path: '/private/synthetic/recording.wav' });
        if (input.state === 'ready') assert.equal(h.helper.state().status, 'ready');
        if (input.state === 'preparing') assert.equal(h.helper.state().status, 'starting');
      }
      assert.deepEqual(h.events, inputs);
      assert(h.events.every(event => !('extra' in event) && !('path' in event)));
      const source = { type: 'vad', speaking: false, atMs: 1 };
      h.raw(`${JSON.stringify(source)}\n`);
      assert.notEqual(h.events.at(-1), source);
    },
  },
  {
    name: 'interview practice audio: malformed, unknown and out-of-range helper events are dropped',
    run() {
      const h = started();
      const bad = [
        { type: 'status', state: 'listening' }, { type: 'status' },
        { type: 'level', rms: 1.01, atMs: 1 }, { type: 'level', rms: -0.1, atMs: 1 }, { type: 'level', rms: '0.5', atMs: 1 },
        { type: 'level', rms: 0.5, atMs: -1 }, { type: 'level', rms: 0.5, atMs: 1.5 }, { type: 'level', rms: 0.5 },
        { type: 'vad', speaking: 'yes', atMs: 1 }, { type: 'vad', speaking: true, atMs: -5 },
        { type: 'transcript', text: '', segmentId: 's', final: true, startMs: 0, endMs: 1 },
        { type: 'transcript', text: 'x'.repeat(4001), segmentId: 's', final: true, startMs: 0, endMs: 1 },
        { type: 'transcript', text: 'ok', segmentId: 7, final: true, startMs: 0, endMs: 1 },
        { type: 'transcript', text: 'ok', segmentId: 's', final: 'true', startMs: 0, endMs: 1 },
        { type: 'transcript', text: 'ok', segmentId: 's', final: true, startMs: 5, endMs: 4 },
        { type: 'transcript', text: 'ok', segmentId: 's', final: true, startMs: -1, endMs: 4 },
        { type: 'transcript', text: 'ok', segmentId: 's', final: true, startMs: 0 },
        { type: 'transcript', text: 42, segmentId: 's', final: true, startMs: 0, endMs: 1 },
        { type: 'playback', utteranceId: 'bad id', state: 'started', positionMs: 0, atMs: 0 },
        { type: 'playback', utteranceId: 'a'.repeat(65), state: 'started', positionMs: 0, atMs: 0 },
        { type: 'playback', utteranceId: 'a', state: 'restarted', positionMs: 0, atMs: 0 },
        { type: 'playback', utteranceId: 'a', state: 'started', positionMs: -1, atMs: 0 },
        { type: 'playback', utteranceId: 'a', state: 'started', positionMs: 0 },
        { type: 'recording', state: 'open', durationMs: 1 }, { type: 'recording', state: 'closed', durationMs: -1 },
        { type: 'recording', state: 'closed' },
        { type: 'mystery', state: 'ready' }, { state: 'ready' }, { type: 5 },
      ];
      for (const value of bad) h.send(value);
      for (const text of ['null', '[]', '7', '"status"', 'not json', '{"type":"status"', '', '   ', '{"type":"vad","speaking":true,"atMs":1']) h.raw(`${text}\n`);
      assert.deepEqual(h.events, []);
      assert.equal(h.helper.state().status, 'starting');
      // The helper still works after garbage.
      h.send({ type: 'vad', speaking: true, atMs: 9 });
      assert.deepEqual(h.events, [{ type: 'vad', speaking: true, atMs: 9 }]);
    },
  },
  {
    name: 'interview practice audio: oversized stdout lines are dropped and parsing resumes after the next newline',
    run() {
      const h = started();
      const good = { type: 'vad', speaking: true, atMs: 1 };
      const padded = size => JSON.stringify({ ...good, pad: 'p'.repeat(size - JSON.stringify({ ...good, pad: '' }).length) });
      assert.equal(Buffer.byteLength(padded(16384)), 16384);
      h.raw(`${padded(16384)}\n`);
      assert.equal(h.events.length, 1, 'a line of exactly 16384 bytes is accepted');
      h.raw(`${padded(16385)}\n`);
      assert.equal(h.events.length, 1, 'a line of 16385 bytes is dropped');
      // Oversized line arriving over several chunks, followed by a good line in the chunk that ends it.
      h.raw(Buffer.alloc(10000, 0x61)); h.raw(Buffer.alloc(10000, 0x61)); h.raw(Buffer.alloc(100000, 0x61));
      h.raw(`${'a'.repeat(50)}\n${JSON.stringify({ type: 'vad', speaking: false, atMs: 2 })}\n`);
      assert.deepEqual(h.events.at(-1), { type: 'vad', speaking: false, atMs: 2 });
      assert.equal(h.events.length, 2);
      // Lines split across chunks, several lines in one chunk, and multibyte text counted in bytes.
      const line = `${JSON.stringify({ type: 'transcript', text: 'héllo wörld', segmentId: 's', final: true, startMs: 0, endMs: 5 })}\n`;
      const bytes = Buffer.from(line);
      h.raw(bytes.subarray(0, 40)); h.raw(bytes.subarray(40));
      assert.equal(h.events.at(-1).text, 'héllo wörld');
      h.raw(Buffer.concat([bytes, bytes]));
      assert.equal(h.events.length, 5);
      const multibyte = JSON.stringify({ ...good, pad: 'é'.repeat(9000) });
      assert(multibyte.length < 16384 && Buffer.byteLength(multibyte) > 16384);
      h.raw(`${multibyte}\n`);
      assert.equal(h.events.length, 5, 'the cap counts bytes, not characters');
      h.raw(`${JSON.stringify(good)}\n`);
      assert.equal(h.events.length, 6);
    },
  },
  {
    name: 'interview practice audio: commands are exact one-line JSON and invalid arguments throw TypeError',
    run() {
      const h = harness();
      assert.equal(h.helper.play('u1', 24000), false, 'commands before start are no-ops');
      assert.equal(h.helper.mute(true), false);
      assert.throws(() => h.helper.play('bad id', 24000), TypeError);
      h.helper.start({ recordingPath: RECORDING });
      const child = h.children[0];
      assert.equal(h.helper.play('u1', 24000), true);
      assert.equal(h.helper.pushAudio('u1', Buffer.from([1, 0, 255, 127])), true);
      assert.equal(h.helper.endUtterance('u1'), true);
      assert.equal(h.helper.cancel('u1'), true);
      assert.equal(h.helper.mute(true), true);
      assert.equal(h.helper.mute(false), true);
      assert.equal(h.helper.play('Utt_2-x', 44100), true);
      assert.deepEqual(child.stdin.lines, [
        '{"type":"play","utteranceId":"u1","sampleRate":24000}\n',
        '{"type":"audio","utteranceId":"u1","pcm":"AQD/fw=="}\n',
        '{"type":"end","utteranceId":"u1"}\n',
        '{"type":"cancel","utteranceId":"u1"}\n',
        '{"type":"mute","muted":true}\n',
        '{"type":"mute","muted":false}\n',
        '{"type":"play","utteranceId":"Utt_2-x","sampleRate":44100}\n',
      ]);
      const before = child.stdin.lines.length;
      for (const id of ['', 'a b', 'a'.repeat(65), 'ü', 7, null, undefined, 'a\n']) {
        assert.throws(() => h.helper.play(id, 24000), TypeError, String(id));
        assert.throws(() => h.helper.pushAudio(id, Buffer.alloc(2)), TypeError);
        assert.throws(() => h.helper.endUtterance(id), TypeError);
        assert.throws(() => h.helper.cancel(id), TypeError);
      }
      for (const rate of [16000, 48000, '24000', 0, undefined, 24000.5]) assert.throws(() => h.helper.play('u3', rate), TypeError, String(rate));
      for (const value of ['true', 1, null, undefined]) assert.throws(() => h.helper.mute(value), TypeError);
      assert.throws(() => h.helper.pushAudio('u1', Buffer.alloc(3)), TypeError);
      assert.throws(() => h.helper.pushAudio('u1', new Uint8Array(4)), TypeError);
      assert.throws(() => h.helper.pushAudio('u1', 'AAAA'), TypeError);
      assert.equal(child.stdin.lines.length, before, 'rejected calls write nothing');
    },
  },
  {
    name: 'interview practice audio: pushAudio splits at 96000 bytes on sample boundaries and every line stays far under the stdin cap',
    run() {
      const h = started();
      h.helper.play('u1', 24000);
      const source = pcm(250000);
      h.helper.pushAudio('u1', source);
      const audio = h.sent().filter(message => message.type === 'audio');
      const chunks = audio.map(message => Buffer.from(message.pcm, 'base64'));
      assert.deepEqual(chunks.map(chunk => chunk.length), [96000, 96000, 58000]);
      assert(chunks.every(chunk => chunk.length % 2 === 0));
      assert.deepEqual(Buffer.concat(chunks), source);
      for (const line of h.children[0].stdin.lines) assert(Buffer.byteLength(line) < 262144 / 2, 'lines stay far under the cap');
      const odd = pcm(96002);
      h.helper.pushAudio('u1', odd);
      const next = h.sent().filter(message => message.type === 'audio').slice(3).map(message => Buffer.from(message.pcm, 'base64').length);
      assert.deepEqual(next, [96000, 2]);
      const total = h.children[0].stdin.lines.length;
      assert.equal(h.helper.pushAudio('u1', Buffer.alloc(0)), true);
      assert.equal(h.children[0].stdin.lines.length, total, 'empty audio writes nothing');
    },
  },
  {
    name: 'interview practice audio: backpressure queues lines in order and flushes on drain',
    run() {
      const h = started();
      const child = h.children[0];
      child.stdin.accept = false;
      h.helper.play('a', 24000);
      h.helper.pushAudio('a', pcm(200000));
      h.helper.endUtterance('a');
      h.helper.mute(true);
      assert.deepEqual(h.sent().map(message => message.type), ['play'], 'nothing is written while the pipe is full');
      child.stdin.accept = true;
      child.stdin.emit('drain');
      assert.deepEqual(h.sent().map(message => message.type), ['play', 'audio', 'audio', 'audio', 'end', 'mute']);
      // A drain followed by another full pipe keeps the rest queued.
      child.stdin.accept = false;
      h.helper.mute(false); // written directly, pipe now full
      h.helper.mute(true); h.helper.mute(false);
      assert.equal(child.stdin.lines.length, 7);
      child.stdin.emit('drain');
      assert.equal(child.stdin.lines.length, 8, 'a refused write blocks the remaining queue again');
      child.stdin.accept = true;
      child.stdin.emit('drain');
      assert.deepEqual(h.sent().slice(6).map(message => message.muted), [false, true, false]);
      assert.deepEqual(h.events, []);
    },
  },
  {
    name: 'interview practice audio: queue over 4 MB cancels the active utterance, drops its audio, keeps controls and reports locally',
    run() {
      const h = started();
      const child = h.children[0];
      child.stdin.accept = false;
      h.helper.play('a', 24000);
      h.helper.mute(true);
      assert.equal(h.helper.pushAudio('a', pcm(4_500_000)), false, 'the push is abandoned once the queue overflows');
      assert.deepEqual(h.events, [{ type: 'playback', utteranceId: 'a', state: 'cancelled', reason: 'backpressure' }]);
      assert.equal(h.helper.pushAudio('a', pcm(96000)), false);
      assert.equal(h.helper.endUtterance('a'), false);
      h.helper.mute(false);
      child.stdin.accept = true;
      child.stdin.emit('drain');
      assert.deepEqual(h.sent(), [
        { type: 'play', utteranceId: 'a', sampleRate: 24000 },
        { type: 'mute', muted: true },
        { type: 'cancel', utteranceId: 'a' },
        { type: 'mute', muted: false },
      ]);
      assert.equal(h.events.length, 1);
      assert.equal(h.helper.play('b', 24000), true);
      assert.equal(h.helper.pushAudio('b', pcm(100)), true);
      assert.deepEqual(h.sent().slice(4).map(message => message.type), ['play', 'audio']);
    },
  },
  {
    name: 'interview practice audio: cancel and mute are never dropped and cancel discards that utterance\'s queued audio',
    run() {
      const h = started();
      const child = h.children[0];
      child.stdin.accept = false;
      h.helper.play('a', 24000);
      h.helper.pushAudio('a', pcm(1000));
      h.helper.mute(true);
      h.helper.cancel('a');
      h.helper.mute(false);
      h.helper.play('b', 44100);
      h.helper.pushAudio('b', pcm(1000));
      h.helper.play('c', 44100);
      child.stdin.accept = true;
      child.stdin.emit('drain');
      assert.deepEqual(h.sent().map(message => `${message.type}:${message.utteranceId ?? message.muted}`), [
        'play:a', 'mute:true', 'cancel:a', 'mute:false', 'play:b', 'play:c',
      ]);
    },
  },
  {
    name: 'interview practice audio: helper error codes map to fixed messages, unknown codes become capture-failed, and the helper is stopped',
    run() {
      for (const code of ERROR_CODES) {
        const h = started();
        h.helper.play('a', 24000);
        h.send({ type: 'error', code, message: '/private/synthetic/transcript text' });
        assert.deepEqual(h.helper.state(), { status: 'error', errorCode: code, message: PRACTICE_AUDIO_MESSAGES[code] });
        assert.deepEqual(h.events, [{ type: 'error', code }]);
        assert.equal(h.children[0].stdin.ended, true);
        assert.deepEqual(h.children[0].signals, ['SIGTERM']);
        assert.deepEqual(h.sent().at(-1), { type: 'stop' });
        h.send({ type: 'vad', speaking: true, atMs: 1 });
        h.children[0].emit('exit', 1);
        assert.equal(h.events.length, 1, `${code}: nothing is reported after the error`);
        assert.equal(h.helper.state().errorCode, code);
      }
      for (const value of [{ code: 'weird-code' }, {}, { code: 7 }, { code: '__proto__' }, { code: 'toString' }]) {
        const h = started();
        h.send({ type: 'error', ...value });
        assert.equal(h.helper.state().errorCode, 'capture-failed');
        assert.equal(h.helper.state().message, PRACTICE_AUDIO_MESSAGES['capture-failed']);
        assert.deepEqual(h.events, [{ type: 'error', code: 'capture-failed' }]);
      }
      const h = started();
      h.raw(`${JSON.stringify({ type: 'error', code: 'playback-failed' })}\n${JSON.stringify({ type: 'vad', speaking: true, atMs: 1 })}\n`);
      assert.deepEqual(h.events, [{ type: 'error', code: 'playback-failed' }], 'lines after an error in the same chunk are ignored');
    },
  },
  {
    name: 'interview practice audio: helper exit without stop or error is a capture-failed crash',
    run() {
      const h = started();
      h.send({ type: 'status', state: 'ready' });
      h.children[0].emit('exit', 139, null);
      assert.deepEqual(h.helper.state(), { status: 'error', errorCode: 'capture-failed', message: PRACTICE_AUDIO_MESSAGES['capture-failed'] });
      assert.deepEqual(h.events, [{ type: 'status', state: 'ready' }, { type: 'error', code: 'capture-failed' }]);
      assert.deepEqual(h.children[0].signals, [], 'an exited child is not signalled');
      assert.equal(h.helper.play('a', 24000), false);
      assert.deepEqual(h.helper.start({ recordingPath: RECORDING }), { ok: true }, 'a crash allows a fresh start');
      // Exit after an explicit stop is expected and silent.
      const stopped = started();
      stopped.helper.stop();
      stopped.children[0].emit('exit', 0, null);
      assert.deepEqual(stopped.events, []);
      assert.equal(stopped.helper.state().status, 'stopped');
    },
  },
  {
    name: 'interview practice audio: stop is idempotent, escalates to SIGKILL after 750 ms and clears the timer on exit',
    run() {
      const h = started();
      const child = h.children[0];
      h.helper.play('a', 24000);
      assert.deepEqual(h.helper.stop(), { status: 'stopped', errorCode: null, message: '' });
      assert.deepEqual(h.sent().at(-1), { type: 'stop' });
      assert.equal(h.sent().filter(message => message.type === 'stop').length, 1);
      assert.equal(child.stdin.ended, true);
      assert.deepEqual(child.signals, ['SIGTERM']);
      assert.equal(h.timers.length, 1);
      assert.equal(h.timers[0].ms, 750);
      assert.equal(h.timers[0].unrefd, true);
      assert.equal(h.timers[0].cleared, false);
      h.timers[0].fn();
      assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
      h.helper.stop(); h.helper.stop();
      assert.equal(child.stdin.lines.length, 2, 'repeat stops write nothing');
      assert.equal(h.timers.length, 1, 'repeat stops arm no timers');
      assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
      assert.equal(h.helper.state().status, 'stopped');
      child.emit('exit', 0, 'SIGTERM');
      assert.equal(h.timers[0].cleared, true);
      // A prompt exit cancels the escalation.
      const prompt = started();
      prompt.helper.stop(); prompt.children[0].emit('exit', 0);
      assert.equal(prompt.timers[0].cleared, true);
      // Stop before start is harmless.
      const idle = harness();
      assert.equal(idle.helper.stop().status, 'idle');
      assert.equal(idle.timers.length, 0);
    },
  },
  {
    name: 'interview practice audio: stop sends queued controls but drops queued audio',
    run() {
      const h = started();
      h.children[0].stdin.accept = false;
      h.helper.play('a', 24000);
      h.helper.pushAudio('a', pcm(5000));
      h.helper.mute(true);
      h.helper.stop();
      assert.deepEqual(h.sent(), [{ type: 'play', utteranceId: 'a', sampleRate: 24000 }, { type: 'mute', muted: true }, { type: 'stop' }]);
      assert.equal(h.children[0].stdin.ended, true);
    },
  },
  {
    name: 'interview practice audio: events after stop and from a replaced child are fenced by generation',
    run() {
      const h = started();
      const first = h.children[0];
      h.send({ type: 'vad', speaking: true, atMs: 1 });
      assert.equal(h.events.length, 1);
      h.helper.stop();
      h.send({ type: 'vad', speaking: false, atMs: 2 }, first);
      h.send({ type: 'error', code: 'permission-denied' }, first);
      assert.equal(h.events.length, 1);
      assert.equal(h.helper.state().status, 'stopped');
      assert.deepEqual(h.helper.start({ recordingPath: RECORDING }), { ok: true });
      const second = h.children[1];
      assert.notEqual(second, first);
      h.send({ type: 'status', state: 'ready' }, first);
      h.send({ type: 'error', code: 'capture-failed' }, first);
      first.emit('exit', 1, null);
      assert.equal(h.helper.state().status, 'starting', 'a replaced child cannot affect the new session');
      assert.equal(h.events.length, 1);
      first.stdin.emit('drain');
      h.send({ type: 'status', state: 'ready' }, second);
      assert.equal(h.helper.state().status, 'ready');
      assert.deepEqual(h.events.at(-1), { type: 'status', state: 'ready' });
      h.helper.play('a', 24000);
      assert.equal(first.stdin.lines.filter(line => line.includes('"play"')).length, 0);
      assert.equal(second.stdin.lines.length, 1);
    },
  },
  {
    name: 'interview practice audio: a stopping session still delivers its recording close and fences the rest',
    run() {
      const h = started();
      const first = h.children[0];
      h.helper.stop();
      h.send({ type: 'recording', state: 'closed', durationMs: 1000 }, first);
      h.send({ type: 'vad', speaking: true, atMs: 3 }, first);
      h.send({ type: 'error', code: 'permission-denied' }, first);
      assert.deepEqual(h.events, [{ type: 'recording', state: 'closed', durationMs: 1000 }]);
      assert.equal(h.helper.state().status, 'stopped');
    },
  },
  {
    name: 'interview practice audio: stderr is drained and ignored and nothing is logged',
    run() {
      const methods = ['log', 'info', 'warn', 'error', 'debug'];
      const original = Object.fromEntries(methods.map(name => [name, console[name]]));
      const logged = [];
      for (const name of methods) console[name] = (...args) => { logged.push(args); };
      try {
        const h = started();
        const child = h.children[0];
        assert.equal(child.stderr.resumed, 1);
        h.send({ type: 'transcript', text: 'Synthetic private words.', segmentId: 's', final: true, startMs: 0, endMs: 5 });
        h.raw('garbage with /private/synthetic/recording.wav\n');
        h.raw(Buffer.alloc(40000, 0x62));
        h.raw('\n');
        h.helper.play('a', 24000);
        h.helper.pushAudio('a', pcm(100));
        h.send({ type: 'error', code: 'recording-failed', message: 'Synthetic private words.' });
        child.stdin.emit('error', new Error('EPIPE /private/synthetic/recording.wav'));
        h.helper.stop();
        assert(!JSON.stringify(h.helper.state()).includes('private'));
      } finally {
        for (const name of methods) console[name] = original[name];
      }
      assert.deepEqual(logged, []);
    },
  },
  {
    name: 'interview practice audio: pause and resume are exact one-line JSON with validated ids',
    run() {
      const h = harness();
      assert.equal(h.helper.pause('u1'), false, 'pause before start is a no-op');
      assert.equal(h.helper.resume('u1'), false, 'resume before start is a no-op');
      assert.throws(() => h.helper.pause('bad id'), TypeError);
      assert.throws(() => h.helper.resume('bad id'), TypeError);
      h.helper.start({ recordingPath: RECORDING });
      const child = h.children[0];
      assert.equal(h.helper.play('u1', 24000), true);
      assert.equal(h.helper.pause('u1'), true);
      assert.equal(h.helper.resume('u1'), true);
      assert.deepEqual(child.stdin.lines, [
        '{"type":"play","utteranceId":"u1","sampleRate":24000}\n',
        '{"type":"pause","utteranceId":"u1"}\n',
        '{"type":"resume","utteranceId":"u1"}\n',
      ]);
      const before = child.stdin.lines.length;
      for (const id of ['', 'a b', 'a'.repeat(65), 'ü', 7, null, undefined, 'a\n']) {
        assert.throws(() => h.helper.pause(id), TypeError, String(id));
        assert.throws(() => h.helper.resume(id), TypeError, String(id));
      }
      assert.equal(child.stdin.lines.length, before, 'rejected pause and resume write nothing');
    },
  },
  {
    name: 'interview practice audio: pause and resume controls survive a backpressure overflow',
    run() {
      const h = started();
      const child = h.children[0];
      child.stdin.accept = false;
      h.helper.play('a', 24000);
      assert.equal(h.helper.pause('a'), true, 'pause is accepted while the pipe is full');
      assert.equal(h.helper.resume('a'), true);
      assert.equal(h.helper.pushAudio('a', pcm(4_500_000)), false, 'the push is abandoned once the queue overflows');
      assert.equal(h.helper.pause('a'), true, 'pause is still accepted for the abandoned utterance');
      assert.equal(h.helper.resume('a'), true);
      assert.deepEqual(h.events, [{ type: 'playback', utteranceId: 'a', state: 'cancelled', reason: 'backpressure' }]);
      child.stdin.accept = true;
      child.stdin.emit('drain');
      assert.deepEqual(child.stdin.lines.map(line => JSON.parse(line)), [
        { type: 'play', utteranceId: 'a', sampleRate: 24000 },
        { type: 'pause', utteranceId: 'a' },
        { type: 'resume', utteranceId: 'a' },
        { type: 'cancel', utteranceId: 'a' },
        { type: 'pause', utteranceId: 'a' },
        { type: 'resume', utteranceId: 'a' },
      ]);
    },
  },
  {
    name: 'interview practice audio: paused and resumed playback events validate while an unknown state is dropped',
    run() {
      const h = started();
      h.send({ type: 'playback', utteranceId: 'a', state: 'paused', positionMs: 120, atMs: 200, extra: 'ignored' });
      h.send({ type: 'playback', utteranceId: 'a', state: 'resumed', positionMs: 120, atMs: 900 });
      assert.deepEqual(h.events, [
        { type: 'playback', utteranceId: 'a', state: 'paused', positionMs: 120, atMs: 200 },
        { type: 'playback', utteranceId: 'a', state: 'resumed', positionMs: 120, atMs: 900 },
      ]);
      for (const value of [
        { type: 'playback', utteranceId: 'a', state: 'interrupted', positionMs: 120, atMs: 950 },
        { type: 'playback', utteranceId: 'a', state: 'paused', positionMs: -1, atMs: 950 },
        { type: 'playback', utteranceId: 'a', state: 'resumed', positionMs: 120 },
        { type: 'playback', utteranceId: 'bad id', state: 'paused', positionMs: 120, atMs: 950 },
        { type: 'playback', utteranceId: 'a', state: 'paused', positionMs: 120.5, atMs: 950 },
      ]) h.send(value);
      assert.equal(h.events.length, 2, 'unknown states and bad fields are dropped');
    },
  },
];
