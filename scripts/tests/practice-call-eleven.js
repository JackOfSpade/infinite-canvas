import assert from 'node:assert/strict';
import { readElevenLabsKey, KEYCHAIN_SERVICE, SECURITY_BIN } from '../../electron/practiceCall/eleven/elevenKey.js';
import {
  createDialogueVoiceFactory, fetchSubscriptionTier, wordsFromAlignment, KEEP_ALIVE_MS, PAID_RATE, FREE_RATE,
} from '../../electron/practiceCall/eleven/dialogueVoice.js';
import { listConversationalVoices, pickPersonaVoice, accentPoolKey } from '../../electron/practiceCall/eleven/voiceCatalog.js';
import { NAME_POOLS, DIVERSE_POOL } from '../../electron/practiceCall/eleven/voiceNames.js';
import { transcribeVerbatim } from '../../electron/practiceCall/eleven/scribe.js';

const KEY = 'sk-test-key-do-not-leak-123';
const flush = async () => { for (let step = 0; step < 12; step += 1) await Promise.resolve(); };

// A WebSocket stand-in that records every frame and lets the test play server frames.
class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.frames = [];
    FakeSocket.instances.push(this);
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; }
  open() { this.onopen?.({}); }
  play(frames) { for (const frame of [].concat(frames)) this.frames.push(frame); }
  message(payload) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }
  fail(message) { this.onerror?.({ message }); }
  shut(code, reason = '') { this.onclose?.({ code, reason }); }
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1];

function fakeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { seq += 1; timers.set(seq, { fn, ms }); return seq; },
    clearTimeout(id) { timers.delete(id); },
    delays: () => [...timers.values()].map(timer => timer.ms),
    fire() {
      const due = [...timers.values()];
      timers.clear();
      for (const timer of due) timer.fn();
    },
  };
}

function paidFactory({ tier = 'creator', clock = fakeClock(), websocket = FakeSocket } = {}) {
  FakeSocket.instances = [];
  return { factory: createDialogueVoiceFactory({ key: KEY, voiceId: 'voice-river', tier, WebSocket: websocket, clock }), clock };
}

const pcm = bytes => Buffer.alloc(bytes).toString('base64');

const alignment = (chars, starts, durations) => ({ chars, char_start_times_ms: starts, char_durations_ms: durations });

const responses = body => ({ ok: true, status: 200, json: async () => body });

export default [
  {
    name: 'practice call eleven: reads the key only through the keychain lookup',
    async run() {
      const calls = [];
      const execFile = (file, args, callback) => {
        calls.push({ file, args });
        callback(null, `  ${KEY}\n`, '');
      };
      const key = await readElevenLabsKey({ execFile, user: 'test-user' });
      assert.equal(key, KEY);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].file, SECURITY_BIN);
      assert.equal(calls[0].file, '/usr/bin/security');
      assert.deepEqual(calls[0].args, [
        'find-generic-password', '-a', 'test-user', '-s', KEYCHAIN_SERVICE, '-w',
      ]);
      const returned = await readElevenLabsKey({ execFile, user: 'test-user' });
      assert.equal(typeof returned, 'string');
      assert.equal(returned, KEY);
    },
  },
  {
    name: 'practice call eleven: keychain failures never carry the secret',
    async run() {
      const noisy = (file, args, callback) => {
        callback(Object.assign(new Error(`security exited 44 for ${KEY} ${SECURITY_BIN}`), { code: 44 }), KEY, KEY);
      };
      await assert.rejects(readElevenLabsKey({ execFile: noisy, user: 'test-user' }), error => {
        assert.equal(error.code, 'voice-auth');
        assert.equal(JSON.stringify(error.message).includes(KEY), false);
        assert.equal(String(error.stack).includes(KEY), false);
        return true;
      });
      const empty = (file, args, callback) => callback(null, '   ', '');
      await assert.rejects(readElevenLabsKey({ execFile: empty, user: 'test-user' }), error => error.code === 'voice-auth');
    },
  },
  {
    name: 'practice call eleven: paid subscription selects 44.1 kHz PCM for one registered voice',
    async run() {
      const requests = [];
      const tier = await fetchSubscriptionTier({ fetch: async (url, options) => { requests.push({ url, options }); return responses({ tier: 'creator' }); }, key: KEY });
      assert.equal(tier, 'creator');
      const { factory } = paidFactory();
      const stream = factory.open({ utteranceId: 'utterance-1' });
      assert.equal(stream.sampleRate, PAID_RATE);
      const socket = latest();
      const url = new URL(socket.url);
      assert.equal(url.protocol, 'wss:');
      assert.equal(url.pathname, '/v1/text-to-dialogue/stream-input');
      assert.equal(url.searchParams.get('model_id'), 'eleven_v4_turbo');
      assert.equal(url.searchParams.get('output_format'), 'pcm_44100');
      assert.equal(url.searchParams.get('sync_alignment'), 'true');
      assert.equal(socket.sent.length, 0);
      socket.open();
      assert.deepEqual(socket.sent, [{ voices: ['voice-river'], xi_api_key: KEY }]);
      assert.equal(JSON.stringify(Object.values(stream)).includes(KEY), false);
    },
  },
  {
    name: 'practice call eleven: sendText sends inputs with the registered voice and one new_turn',
    async run() {
      const { factory } = paidFactory();
      const stream = factory.open({ utteranceId: 'utterance-2' });
      const socket = latest();
      assert.equal(stream.sendText('Hello'), true);
      assert.equal(socket.sent.length, 0);
      socket.open();
      stream.sendText('there.');
      const inputs = socket.sent.filter(frame => frame.inputs);
      assert.deepEqual(inputs, [
        { inputs: [{ text: 'Hello', voice_id: 'voice-river', new_turn: true }] },
        { inputs: [{ text: 'there.', voice_id: 'voice-river' }] },
      ]);
      assert.equal(stream.sendText(''), false);
      assert.equal(stream.sendText(null), false);
    },
  },
  {
    name: 'practice call eleven: finish flushes, closes the socket and waits for the final message',
    async run() {
      const { factory } = paidFactory();
      const stream = factory.open({ utteranceId: 'utterance-3' });
      const socket = latest();
      socket.open();
      stream.sendText('One sentence.');
      let resolved = false;
      const done = stream.finish().then(result => { resolved = true; return result; });
      await flush();
      assert.equal(resolved, false);
      assert.deepEqual(socket.sent.slice(-2), [{ flush: true }, { close_socket: true }]);
      socket.message({ audio: pcm(882), is_final: false });
      await flush();
      assert.equal(resolved, false);
      socket.message({ is_final: true });
      const result = await done;
      assert.equal(resolved, true);
      assert.deepEqual(result, { ok: true });
    },
  },
  {
    name: 'practice call eleven: character alignment becomes cumulative word timings',
    async run() {
      const { factory } = paidFactory();
      const stream = factory.open({ utteranceId: 'utterance-4' });
      const socket = latest();
      socket.open();
      const words = [];
      const audio = [];
      stream.onWords(list => words.push(...list));
      stream.onAudio(buffer => audio.push(buffer));
      socket.message({ audio: pcm(4410), alignment: alignment(['h', 'i', ' '], [0, 10, 20], [10, 10, 0]) });
      socket.message({ audio: pcm(8820), alignment: alignment(['y', 'o', 'u'], [0, 10, 20], [10, 10, 10]) });
      assert.deepEqual(words, [
        { word: 'hi', startMs: 0, endMs: 20 },
        { word: 'you', startMs: 50, endMs: 80 },
      ]);
      assert.equal(audio.length, 2);
      assert.equal(audio[0].length, 4410);
      assert.equal(audio[1].length, 8820);
      assert.deepEqual(wordsFromAlignment(alignment(['a', 'b', ' ', 'c'], [5, 5, 5, 25], [5, 5, 5, 5]), 100), [
        { word: 'ab', startMs: 105, endMs: 110 },
        { word: 'c', startMs: 125, endMs: 130 },
      ]);
    },
  },
  {
    name: 'practice call eleven: free tier speaks 24 kHz and exposes the rate before audio',
    async run() {
      const tier = await fetchSubscriptionTier({ fetch: async () => responses({ tier: 'free' }), key: KEY });
      assert.equal(tier, 'free');
      const { factory } = paidFactory({ tier: 'free' });
      const stream = factory.open({ utteranceId: 'utterance-5' });
      assert.equal(stream.sampleRate, FREE_RATE);
      const socket = latest();
      assert.equal(new URL(socket.url).searchParams.get('output_format'), 'pcm_24000');
    },
  },
  {
    name: 'practice call eleven: a rejected 44.1 kHz stream falls back to 24 kHz once',
    async run() {
      const { factory } = paidFactory();
      const stream = factory.open({ utteranceId: 'utterance-6' });
      const first = latest();
      first.open();
      stream.sendText('Take a breath.');
      first.shut(1008, 'output_format pcm_44100 is not allowed on your plan');
      const second = latest();
      assert.notEqual(second, first);
      assert.equal(new URL(second.url).searchParams.get('output_format'), 'pcm_24000');
      assert.equal(stream.sampleRate, FREE_RATE);
      assert.equal(factory.sampleRate, FREE_RATE);
      second.open();
      assert.deepEqual(second.sent, [
        { voices: ['voice-river'], xi_api_key: KEY },
        { inputs: [{ text: 'Take a breath.', voice_id: 'voice-river', new_turn: true }] },
      ]);
      const next = factory.open({ utteranceId: 'utterance-7' });
      assert.equal(next.sampleRate, FREE_RATE);
      assert.equal(new URL(latest().url).searchParams.get('output_format'), 'pcm_24000');
      const errors = [];
      stream.onError(error => errors.push(error.code));
      const pending = stream.finish().catch(error => error);
      second.shut(1008, 'output_format pcm_24000 rejected');
      const failure = await pending;
      assert.equal(failure.code, 'voice-protocol');
      assert.deepEqual(errors, ['voice-protocol']);
    },
  },
  {
    name: 'practice call eleven: idle sockets are kept alive below the 20 s limit',
    async run() {
      const { factory, clock } = paidFactory();
      const stream = factory.open({ utteranceId: 'utterance-8' });
      const socket = latest();
      socket.open();
      assert.equal(KEEP_ALIVE_MS < 20000, true);
      assert.equal(socket.sent.some(frame => frame.keep_alive), false);
      clock.fire();
      assert.deepEqual(socket.sent.at(-1), { keep_alive: true });
      clock.fire();
      assert.equal(socket.sent.filter(frame => frame.keep_alive).length, 2);
      stream.cancel();
      assert.equal(clock.delays().length, 0);
    },
  },
  {
    name: 'practice call eleven: cancel closes the socket and silences every callback',
    async run() {
      const { factory, clock } = paidFactory();
      const stream = factory.open({ utteranceId: 'utterance-9' });
      const socket = latest();
      socket.open();
      const audio = [];
      const words = [];
      stream.onAudio(buffer => audio.push(buffer));
      stream.onWords(list => words.push(...list));
      const done = stream.finish();
      stream.cancel();
      assert.equal(socket.closed, true);
      assert.equal(clock.delays().length, 0);
      socket.message({ audio: pcm(441), alignment: alignment(['x'], [0], [10]) });
      socket.message({ is_final: true });
      assert.deepEqual(audio, []);
      assert.deepEqual(words, []);
      assert.deepEqual(await done, { cancelled: true });
      assert.equal(stream.sendText('late'), false);
    },
  },
  {
    name: 'practice call eleven: open honours an AbortSignal',
    async run() {
      const { factory } = paidFactory();
      const deadSignal = new AbortController();
      deadSignal.abort();
      const dead = factory.open({ utteranceId: 'utterance-10', signal: deadSignal.signal });
      assert.equal(FakeSocket.instances.length, 0);
      assert.deepEqual(await dead.finish(), { cancelled: true });
      const live = new AbortController();
      const stream = factory.open({ utteranceId: 'utterance-11', signal: live.signal });
      const socket = latest();
      socket.open();
      const audio = [];
      stream.onAudio(buffer => audio.push(buffer));
      live.abort();
      assert.equal(socket.closed, true);
      socket.message({ audio: pcm(441) });
      assert.deepEqual(audio, []);
    },
  },
  {
    name: 'practice call eleven: failures map to the four voice error codes without the key',
    async run() {
      const failures = [];
      const collect = () => {
        const { factory } = paidFactory();
        const stream = factory.open({ utteranceId: 'utterance-12' });
        const socket = latest();
        socket.open();
        const seen = [];
        stream.onError(error => seen.push(error));
        return { socket, seen };
      };
      const auth = collect();
      auth.socket.shut(1008, `invalid api key ${KEY}`);
      failures.push(auth.seen[0]);
      const quota = collect();
      quota.socket.message({ message: 'quota exceeded for this month', error: 'quota_exceeded', code: 'quota_exceeded' });
      failures.push(quota.seen[0]);
      const network = collect();
      network.socket.fail('connection reset');
      network.socket.shut(1006, '');
      failures.push(network.seen[0]);
      const protocol = collect();
      protocol.socket.message('{not json');
      failures.push(protocol.seen[0]);
      assert.deepEqual(failures.map(error => error.code), ['voice-auth', 'voice-quota', 'voice-network', 'voice-protocol']);
      for (const error of failures) {
        assert.equal(String(error.message).includes(KEY), false);
        assert.equal(String(error.stack).includes(KEY), false);
      }
    },
  },
  {
    name: 'practice call eleven: the voice catalogue pages and keeps conversational gendered voices',
    async run() {
      const calls = [];
      const pages = [
        {
          voices: [
            { voice_id: 'v-roger', name: 'Roger', labels: { gender: 'male', use_case: 'conversational', accent: 'american', age: 'middle_aged' } },
            { voice_id: 'v-narrator', name: 'Narrator', labels: { gender: 'male', use_case: 'narrative', accent: 'british' } },
          ],
          has_more: true,
          next_page_token: 'page-2',
        },
        {
          voices: [
            { voice_id: 'v-river', name: 'River', labels: { gender: 'neutral', use_case: 'Conversational, Social media', accent: 'american', age: 'young' } },
            { voice_id: 'v-unlabeled', name: 'Unlabeled', labels: { use_case: 'conversational' } },
          ],
          has_more: false,
          next_page_token: null,
        },
      ];
      const voices = await listConversationalVoices({
        key: KEY,
        fetch: async (url, options) => {
          calls.push({ url: new URL(url), options });
          return responses(pages[calls.length - 1]);
        },
      });
      assert.deepEqual(voices.map(voice => voice.voiceId), ['v-roger', 'v-river']);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url.pathname, '/v2/voices');
      assert.equal(calls[0].url.searchParams.get('page_size'), '100');
      assert.equal(calls[0].url.searchParams.has('next_page_token'), false);
      assert.equal(calls[1].url.searchParams.get('next_page_token'), 'page-2');
      assert.equal(calls[0].options.headers['xi-api-key'], KEY);
      assert.equal(voices[1].gender, 'neutral');
      assert.equal(voices[1].accent, 'american');
    },
  },
  {
    name: 'practice call eleven: personas pick the voice first, then a fitting name',
    async run() {
      const voices = [
        { voiceId: 'v-indian', voiceName: 'Anika Voice', gender: 'female', age: 'young', accent: 'indian', useCases: ['conversational'] },
        { voiceId: 'v-british', voiceName: 'Rowan Voice', gender: 'neutral', age: 'middle_aged', accent: 'british', useCases: ['conversational'] },
        { voiceId: 'v-american', voiceName: 'Marcus Voice', gender: 'male', age: 'old', accent: 'american', useCases: ['conversational'] },
      ];
      const indian = pickPersonaVoice({ voices, random: () => 0 });
      assert.equal(indian.voiceId, 'v-indian');
      assert.equal(indian.voiceName, 'Anika Voice');
      assert.equal(indian.accent, 'indian');
      assert.equal(indian.gender, 'female');
      assert.equal(indian.name, `${NAME_POOLS.indian.female[0]} ${NAME_POOLS.indian.last[0]}`);
      assert.equal(NAME_POOLS.indian.female.includes(indian.name.split(' ')[0]), true);
      const neutral = pickPersonaVoice({ voices, random: () => 0.5, temperament: 'tough' });
      assert.equal(neutral.voiceId, 'v-british');
      assert.equal(neutral.gender, 'neutral');
      assert.equal(neutral.name.split(' ')[0], DIVERSE_POOL.neutral[4]);
      assert.equal(neutral.name.split(' ')[1], DIVERSE_POOL.last[4]);
      assert.equal(neutral.temperament, 'tough');
      assert.equal(accentPoolKey('South African'), 'south african');
      assert.equal(accentPoolKey('british'), null);
      assert.deepEqual(pickPersonaVoice({ voices, random: () => 0 }), { ...indian });
    },
  },
  {
    name: 'practice call eleven: Scribe posts the recording verbatim and returns word timings',
    async run() {
      const calls = [];
      const fs = { promises: { readFile: async path => { calls.push({ path }); return Buffer.from('RIFF....WAVE'); } } };
      const result = await transcribeVerbatim({
        path: '/tmp/take-1.wav',
        fs,
        key: KEY,
        fetch: async (url, options) => {
          calls.push({ url, options });
          return responses({
            text: 'Um, hello there.',
            words: [
              { text: 'Um,', start: 0.12, end: 0.4, type: 'word' },
              { text: ' ', start: 0.4, end: 0.42, type: 'spacing' },
              { text: 'hello', start: 0.5, end: 0.9, type: 'word' },
              { text: '(laughter)', start: null, end: null, type: 'audio_event' },
            ],
          });
        },
      });
      assert.equal(calls[0].path, '/tmp/take-1.wav');
      const { url, options } = calls[1];
      assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['xi-api-key'], KEY);
      const form = options.body;
      assert.equal(form.get('model_id'), 'scribe_v2');
      assert.equal(form.get('timestamps_granularity'), 'word');
      assert.equal(form.get('tag_audio_events'), 'false');
      assert.equal(form.get('no_verbatim'), 'false');
      assert.equal(form.get('file').name, 'take-1.wav');
      assert.deepEqual(result.words, [
        { text: 'Um,', startMs: 120, endMs: 400, type: 'word' },
        { text: ' ', startMs: 400, endMs: 420, type: 'spacing' },
        { text: 'hello', startMs: 500, endMs: 900, type: 'word' },
        { text: '(laughter)', startMs: null, endMs: null, type: 'audio_event' },
      ]);
      assert.equal(result.text, 'Um, hello there.');
    },
  },
  {
    name: 'practice call eleven: Scribe maps failures and never echoes the key',
    async run() {
      const fs = { readFileSync: () => Buffer.from('data') };
      await assert.rejects(
        transcribeVerbatim({
          path: '/tmp/take-2.wav',
          fs,
          key: KEY,
          fetch: async () => ({ ok: false, status: 401, json: async () => ({ detail: `invalid api key ${KEY}` }) }),
        }),
        error => {
          assert.equal(error.code, 'voice-auth');
          assert.equal(String(error.message).includes(KEY), false);
          return true;
        },
      );
      await assert.rejects(
        transcribeVerbatim({
          path: '/tmp/take-2.wav',
          fs,
          key: KEY,
          fetch: async () => { throw new Error(`socket died ${KEY}`); },
        }),
        error => error.code === 'voice-network' && String(error.message).includes(KEY) === false,
      );
      await assert.rejects(
        transcribeVerbatim({
          path: '/tmp/take-2.wav',
          fs,
          key: KEY,
          fetch: async () => ({ ok: false, status: 429, json: async () => ({ detail: 'rate limit' }) }),
        }),
        error => error.code === 'voice-quota',
      );
    },
  },
  {
    name: "practice call eleven: an in-band rate rejection falls back and restarts alignment",
    async run() {
      const { factory } = paidFactory();
      const stream = factory.open({ utteranceId: "utterance-rate-frame" });
      const first = latest();
      first.open();
      const words = [];
      stream.onWords(list => words.push(...list));
      first.message({ audio: pcm(4410), alignment: alignment(["h", "i"], [0, 10], [10, 10]) });
      first.message({ message: "output_format pcm_44100 is not supported", error: "bad_rate", code: 1003 });
      const second = latest();
      assert.notEqual(second, first);
      assert.equal(new URL(second.url).searchParams.get("output_format"), "pcm_24000");
      assert.equal(stream.sampleRate, FREE_RATE);
      second.open();
      second.message({ alignment: alignment(["y", "o", "u"], [0, 10, 20], [10, 10, 10]) });
      assert.deepEqual(words.at(-1), { word: "you", startMs: 0, endMs: 30 });
      const done = stream.finish();
      second.message({ is_final: true });
      assert.deepEqual(await done, { ok: true });
      assert.equal(stream.closed, true);
    },
  },

];
