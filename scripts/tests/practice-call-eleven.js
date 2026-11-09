import assert from 'node:assert/strict';
import { readElevenLabsKey, KEYCHAIN_SERVICE, SECURITY_BIN } from '../../electron/practiceCall/eleven/elevenKey.js';
import {
  createDialogueVoiceFactory, fetchSubscriptionTier, rateForTier, wordsFromAlignment, KEEP_ALIVE_MS, PAID_RATE, FREE_RATE,
} from '../../electron/practiceCall/eleven/dialogueVoice.js';
import {
  listConversationalVoices, pickPersonaVoice, accentPoolKey, isEnglishVoice, isStandardPrice, normalizeGender, voiceCharacterOf,
} from '../../electron/practiceCall/eleven/voiceCatalog.js';
import { createVoicePoolStore, drawVoice } from '../../electron/practiceCall/eleven/voiceLibrary.js';
import { NAME_POOLS, DIVERSE_POOL, NEUTRAL_FIRST_NAMES } from '../../electron/practiceCall/eleven/voiceNames.js';
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

function paidFactory({ tier = 'pro', clock = fakeClock(), websocket = FakeSocket } = {}) {
  FakeSocket.instances = [];
  return { factory: createDialogueVoiceFactory({ key: KEY, voiceId: 'voice-river', tier, WebSocket: websocket, clock }), clock };
}

const pcm = bytes => Buffer.alloc(bytes).toString('base64');

const alignment = (chars, starts, durations) => ({ chars, char_start_times_ms: starts, char_durations_ms: durations });

const responses = body => ({ ok: true, status: 200, json: async () => body });

/** Small seeded PRNG so the name sweep is deterministic across runs. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A pool file held in memory: enough of node:fs/promises for the store. */
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const log = { mkdirs: [], writes: [], renames: [], reads: [] };
  return {
    files,
    log,
    async readFile(filePath) {
      log.reads.push(filePath);
      if (!files.has(filePath)) throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
      return files.get(filePath);
    },
    async mkdir(dir, options) { log.mkdirs.push({ dir, options }); },
    async writeFile(filePath, data, options) { log.writes.push({ filePath, data, options }); files.set(filePath, data); },
    async rename(from, to) { log.renames.push({ from, to }); files.set(to, files.get(from)); files.delete(from); },
  };
}

const candidate = (id, gender, extra = {}) => ({
  voice_id: id, public_owner_id: `owner-${id}`, name: `${id} voice`, gender, age: 'young', accent: 'american',
  use_case: 'conversational', language: 'en', rate: 1, category: 'professional', verified_languages: [{ language: 'en' }], ...extra,
});

/** A shared-voices fetch stand-in: serves pages from rows and records every request. */
function sharedVoicesFetch({ rows = [], total = null, fail = {} } = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const target = new URL(url);
    calls.push({ url: target, method: options.method ?? 'GET', options });
    if (target.pathname !== '/v1/shared-voices') return { ok: false, status: 404, json: async () => ({}) };
    const page = Number(target.searchParams.get('page') ?? 0);
    const size = Number(target.searchParams.get('page_size') ?? 100);
    if (fail[page]) return { ok: false, status: 500, json: async () => ({ detail: 'library down' }) };
    const voices = rows.slice(page * size, (page + 1) * size);
    return responses({
      voices, has_more: (page + 1) * size < rows.length, total_count: total ?? rows.length,
    });
  };
  return { fetch, calls };
}

export default [
  {
    name: 'practice call eleven: the pool store tolerates a corrupt file and saves atomically',
    async run() {
      const fs = memoryFs({ '/data/practice-voice-pool.json': '{ not json' });
      const store = createVoicePoolStore({ filePath: '/data/practice-voice-pool.json', fs });
      const empty = { version: 1, lastUsed: {} };
      assert.deepEqual(await store.load(), empty);
      const absent = createVoicePoolStore({ filePath: '/data/absent.json', fs });
      assert.deepEqual(await absent.load(), empty);
      const state = { version: 1, lastUsed: { 'voice-1': 9 } };
      await store.save(state);
      assert.equal(fs.log.mkdirs.length, 1);
      assert.deepEqual(fs.log.mkdirs[0], { dir: '/data', options: { recursive: true } });
      assert.equal(fs.log.writes.length, 1);
      assert.equal(fs.log.writes[0].filePath, '/data/practice-voice-pool.json.tmp');
      assert.equal(fs.log.writes[0].options.mode, 0o600);
      assert.deepEqual(fs.log.renames, [{ from: '/data/practice-voice-pool.json.tmp', to: '/data/practice-voice-pool.json' }]);
      assert.deepEqual(JSON.parse(fs.files.get('/data/practice-voice-pool.json')), state);
      const reread = await store.load();
      assert.deepEqual(reread, state);
    },
  },
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
      const tier = await fetchSubscriptionTier({ fetch: async (url, options) => { requests.push({ url, options }); return responses({ tier: 'pro' }); }, key: KEY });
      assert.equal(tier, 'pro');
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
    name: 'practice call eleven: plans below Pro never ask for 44.1 kHz',
    async run() {
      for (const tier of ['', 'free', 'starter', 'Creator']) assert.equal(rateForTier(tier), FREE_RATE, tier);
      for (const tier of ['pro', 'scale', 'business', 'enterprise']) assert.equal(rateForTier(tier), PAID_RATE, tier);
      const { factory } = paidFactory({ tier: 'starter' });
      factory.open({ utteranceId: 'utterance-starter' });
      assert.equal(new URL(latest().url).searchParams.get('output_format'), 'pcm_24000');
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
    name: 'practice call eleven: the voice character keeps descriptors and drops the voice\'s own name',
    run() {
      assert.deepEqual(voiceCharacterOf({ voiceName: 'Lauren - Friendly, Comforting and Soft', descriptive: 'Pleasant',
        description: 'Lauren B \u2013 a gentle, comforting voice.' }),
      { traits: 'Friendly, Comforting and Soft', descriptive: 'pleasant', about: 'B \u2013 a gentle, comforting voice.' });
      assert.deepEqual(voiceCharacterOf({ voiceName: 'Lyra Moon', description: 'Innocent but confident.' }),
        { traits: '', descriptive: '', about: 'Innocent but confident.' });
      assert.equal(voiceCharacterOf({ voiceName: 'Ann \u2014 Calm', description: 'x'.repeat(300) }).about.length, 200);
      const picked = pickPersonaVoice({ voices: [{ voiceId: 'v', voiceName: 'Roger - Laid-Back, Casual', gender: 'male', accent: 'american',
        useCases: ['conversational'], descriptive: 'classy', description: 'Easy going.' }], random: () => 0 });
      assert.deepEqual(picked.character, { traits: 'Laid-Back, Casual', descriptive: 'classy', about: 'Easy going.' });
      assert.equal(picked.temperament, null);
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
  {
    name: 'practice call eleven: the catalogue drops non-English and premium-priced voices',
    async run() {
      const page = {
        voices: [
          {
            voice_id: 'v-xin', name: 'Xin', category: 'professional',
            labels: { use_case: 'conversational', gender: 'male', language: 'zh', accent: 'beijing mandarin' },
            verified_languages: [{ language: 'zh', accent: 'mandarin' }],
          },
          {
            voice_id: 'v-premium', name: 'Premium', category: 'professional',
            labels: { use_case: 'conversational', gender: 'female', accent: 'american' },
            sharing: { rate: 2 },
          },
          {
            voice_id: 'v-roger', name: 'Roger', category: 'premade',
            labels: { use_case: 'conversational', gender: 'male', accent: 'american', age: 'middle_aged' },
            verified_languages: [],
          },
        ],
        has_more: false,
      };
      const voices = await listConversationalVoices({ key: KEY, fetch: async () => responses(page) });
      assert.deepEqual(voices.map(voice => voice.voiceId), ['v-roger']);
      assert.equal(voices[0].language, '');
      assert.equal(voices[0].rate, null);
      assert.deepEqual(voices[0].verifiedLanguages, []);
      assert.equal(isEnglishVoice({ labels: { language: 'zh' } }), false);
      assert.equal(isEnglishVoice({ verified_languages: [{ language: 'zh' }] }), false);
      assert.equal(isEnglishVoice({ fine_tuning: { language: 'zh' } }), false);
      assert.equal(isEnglishVoice({ labels: { language: 'en' }, verified_languages: [{ language: 'zh' }] }), false);
      assert.equal(isEnglishVoice({ language: 'en-GB' }), true);
      assert.equal(isEnglishVoice({ labels: { use_case: 'conversational' }, verified_languages: [] }), true);
      assert.equal(isStandardPrice({ rate: 2 }), false);
      assert.equal(isStandardPrice({ sharing: { rate: 1 } }), true);
      assert.equal(isStandardPrice({ sharing: { rate: 1.5 } }), false);
      assert.equal(isStandardPrice({}), true);
      assert.equal(isStandardPrice({ rate: null }), true);
    },
  },
  {
    name: 'practice call eleven: mandarin, cantonese and taiwanese accents use the chinese pool',
    async run() {
      assert.equal(accentPoolKey('beijing mandarin'), 'chinese');
      assert.equal(accentPoolKey('taiwan mandarin'), 'chinese');
      assert.equal(accentPoolKey('cantonese'), 'chinese');
      assert.equal(accentPoolKey('South African'), 'south african');
    },
  },
  {
    name: 'practice call eleven: the last used voice is avoided while another voice exists',
    async run() {
      const voices = [
        { voiceId: 'v-a', voiceName: 'A', gender: 'female', accent: 'british', age: 'young', useCases: ['conversational'] },
        { voiceId: 'v-b', voiceName: 'B', gender: 'male', accent: 'irish', age: 'old', useCases: ['conversational'] },
      ];
      for (let step = 0; step < 64; step += 1) {
        const picked = pickPersonaVoice({ voices, random: mulberry32(step + 1), avoidVoiceIds: ['v-a'] });
        assert.equal(picked.voiceId, 'v-b', `step ${step} ignored the avoided voice`);
        assert.equal(picked.language, '');
      }
      const only = pickPersonaVoice({ voices: [voices[0]], random: () => 0.5, avoidVoiceIds: ['v-a'] });
      assert.equal(only.voiceId, 'v-a');
      assert.equal(pickPersonaVoice({ voices, random: () => 0, avoidVoiceIds: [] }).voiceId, 'v-a');
      assert.equal(pickPersonaVoice({ voices, random: () => 0 }).voiceId, 'v-a');
    },
  },
  {
    name: 'practice call eleven: names always fit the chosen voice accent and gender',
    async run() {
      const fixtures = [];
      for (const key of Object.keys(NAME_POOLS)) {
        for (const gender of ['female', 'male', 'neutral']) {
          fixtures.push({
            voiceId: `v-${key.replace(/\s+/gu, '-')}-${gender}`, voiceName: `${key} ${gender}`, gender,
            accent: key, age: 'middle_aged', useCases: ['conversational'], language: 'en',
          });
        }
      }
      fixtures.push({ voiceId: 'v-american', voiceName: 'Diverse', gender: 'female', accent: 'american', age: 'young', useCases: ['conversational'], language: 'en' });
      fixtures.push({ voiceId: 'v-neutral', voiceName: 'Neutral', gender: 'neutral', accent: 'london', age: 'young', useCases: ['conversational'], language: 'en' });
      const seenVoices = new Set();
      const runs = 500;
      for (let step = 0; step < runs; step += 1) {
        const voiceAt = (step % fixtures.length) / fixtures.length + 0.5 / fixtures.length;
        const prng = mulberry32(step + 7);
        let first = true;
        const random = () => {
          if (first) { first = false; return voiceAt; }
          return prng();
        };
        const persona = pickPersonaVoice({ voices: fixtures, random });
        const voice = fixtures[step % fixtures.length];
        const key = accentPoolKey(voice.accent);
        const pool = key ? NAME_POOLS[key] : DIVERSE_POOL;
        const gendered = pool[persona.gender];
        const expectedFirst = persona.gender === 'neutral'
          ? (pool.neutral?.length ? pool.neutral : NEUTRAL_FIRST_NAMES)
          : (gendered?.length ? gendered : NEUTRAL_FIRST_NAMES);
        assert.equal(persona.voiceId, voice.voiceId);
        assert.equal(persona.gender, normalizeGender(voice.gender));
        const firstName = persona.name.split(' ')[0];
        const lastName = persona.name.slice(firstName.length + 1);
        assert.equal(expectedFirst.includes(firstName), true, `${persona.voiceId} picked the first name ${persona.name}`);
        assert.equal(pool.last.includes(lastName), true, `${persona.voiceId} picked the last name ${persona.name}`);
        assert.equal(persona.language, 'en');
        assert.equal(persona.temperament, null, 'only a requested temperament is set before Claude chooses');
        seenVoices.add(persona.voiceId);
        assert.equal(pickPersonaVoice({ voices: fixtures, random: mulberry32(step + 11), temperament: 'tough' }).temperament, 'tough');
      }
      assert.equal(seenVoices.size, fixtures.length);
    },
  },
  {
    name: 'practice call eleven: drawVoice only reads shared-voice pages over GET',
    async run() {
      const rows = Array.from({ length: 12 }, (_, index) => candidate(`lib-${index}`, index % 2 ? 'female' : 'male'));
      const harness = sharedVoicesFetch({ rows });
      const drawn = await drawVoice({ fetch: harness.fetch, key: KEY, random: () => 0, pageSize: 5 });
      assert.equal(drawn.source, 'library');
      assert.equal(drawn.voice.voiceId, 'lib-0');
      assert.equal(drawn.libraryTotal, 12);
      assert.equal(harness.calls.length, 1);
      assert.equal(harness.calls[0].method, 'GET');
      assert.equal(harness.calls[0].url.pathname, '/v1/shared-voices');
      assert.equal(harness.calls[0].url.searchParams.get('language'), 'en');
      assert.equal(harness.calls[0].url.searchParams.get('use_cases'), 'conversational');
      assert.equal(harness.calls[0].url.searchParams.get('page_size'), '5');
      assert.equal(harness.calls[0].url.searchParams.get('page'), '0');
      assert.equal(harness.calls[0].options.headers['xi-api-key'], KEY);

      const library = await drawVoice({ fetch: harness.fetch, key: KEY, random: () => 0.6, pageSize: 5 });
      assert.equal(library.source, 'library');
      assert.equal(library.voice.voiceId, 'lib-7');
      assert.deepEqual(harness.calls.map(call => call.url.searchParams.get('page')), ['0', '0', '1']);
      for (const call of harness.calls) {
        assert.equal(call.method, 'GET');
        assert.equal(call.url.pathname, '/v1/shared-voices');
        assert.equal(call.url.searchParams.get('language'), 'en');
        assert.equal(call.url.searchParams.get('use_cases'), 'conversational');
        assert.equal(call.url.searchParams.get('page_size'), '5');
      }
    },
  },
  {
    name: 'practice call eleven: drawVoice returns row 50 of page 1 with its descriptions',
    async run() {
      const rows = Array.from({ length: 100 }, (_, index) => candidate(`lib-${index}`, 'male'));
      rows.push(...Array.from({ length: 60 }, (_, index) => candidate(`lib-p1-${index}`, 'female')));
      rows[150] = candidate('lib-target', 'female', { descriptive: 'Smooth', description: ' Warm and clear. ' });
      const harness = sharedVoicesFetch({ rows, total: 3427 });
      const result = await drawVoice({
        fetch: harness.fetch, key: KEY, pageSize: 100, random: () => 0.043773,
      });
      assert.equal(result.source, 'library');
      assert.equal(result.attempts, 1);
      assert.equal(result.libraryTotal, 3427);
      assert.deepEqual(result.voice, {
        voiceId: 'lib-target', voiceName: 'lib-target voice', gender: 'female', age: 'young', accent: 'american',
        useCases: ['conversational'], category: 'professional', description: 'Warm and clear.', descriptive: 'smooth',
        language: 'en', rate: 1,
      });
      assert.deepEqual(harness.calls.map(call => call.url.searchParams.get('page')), ['0', '1']);
      assert.equal(harness.calls.length, 2);
    },
  },
  {
    name: 'practice call eleven: drawVoice reads page 0 only for a row on page 0',
    async run() {
      const rows = Array.from({ length: 100 }, (_, index) => candidate(`lib-${index}`, 'male'));
      const harness = sharedVoicesFetch({ rows, total: 100 });
      const result = await drawVoice({ fetch: harness.fetch, key: KEY, random: () => 0.01 });
      assert.equal(result.source, 'library');
      assert.equal(result.voice.voiceId, 'lib-1');
      assert.equal(result.attempts, 1);
      assert.equal(result.libraryTotal, 100);
      assert.deepEqual(harness.calls.map(call => call.url.searchParams.get('page')), ['0']);
    },
  },
  {
    name: 'practice call eleven: drawVoice never returns a voice from an account list',
    async run() {
      const rows = Array.from({ length: 5 }, (_, index) => candidate(`lib-${index}`, index % 2 ? 'female' : 'male'));
      const harness = sharedVoicesFetch({ rows, total: 5 });
      const account = [
        { voiceId: 'acc-1', voiceName: 'Ada', gender: 'male', useCases: ['conversational'], language: 'en' },
        { voiceId: 'acc-2', voiceName: 'Grace', gender: 'female', useCases: ['conversational'], language: 'en' },
      ];
      const random = mulberry32(20261108);
      const seen = new Set();
      for (let step = 0; step < 200; step += 1) {
        // A caller that still passes account voices must never get one back.
        const result = await drawVoice({ fetch: harness.fetch, key: KEY, accountVoices: account, random });
        assert.equal(result.source, 'library');
        assert.equal(String(result.voice.voiceId).startsWith('lib-'), true, `drew ${result.voice.voiceId}`);
        seen.add(result.voice.voiceId);
      }
      assert.equal(seen.size, 5);
      assert.equal(harness.calls.some(call => call.method !== 'GET'), false);
    },
  },
  {
    name: 'practice call eleven: drawVoice skips excluded and ineligible library rows',
    async run() {
      const rows = [
        candidate('lib-excluded', 'female'),
        candidate('lib-pricey', 'male', { rate: 2 }),
        candidate('lib-nogender', 'male', { gender: undefined }),
        candidate('lib-good', 'male', { descriptive: 'Warm' }),
      ];
      const harness = sharedVoicesFetch({ rows, total: 4 });
      const draws = [0, 0.3, 0.55, 0.8];
      let step = 0;
      const result = await drawVoice({
        fetch: harness.fetch, key: KEY, pageSize: 5,
        excludeVoiceIds: [' lib-excluded '], random: () => draws[step++],
      });
      assert.equal(result.voice.voiceId, 'lib-good');
      assert.equal(result.source, 'library');
      assert.equal(result.attempts, 4);
      assert.equal(result.libraryTotal, 4);
      assert.equal(step, 4);
      assert.deepEqual(harness.calls.map(call => call.url.searchParams.get('page')), ['0']);
    },
  },
  {
    name: 'practice call eleven: drawVoice fails when page 0 cannot be read',
    async run() {
      const rows = Array.from({ length: 3 }, (_, index) => candidate(`lib-${index}`, 'male'));
      const harness = sharedVoicesFetch({ rows, total: 3, fail: { 0: true } });
      await assert.rejects(
        drawVoice({ fetch: harness.fetch, key: KEY, random: () => 0.5 }),
        error => {
          assert.equal(error.code, 'voice-library-unavailable');
          assert.equal(error.message, 'The ElevenLabs voice library could not be read.');
          assert.equal(error.cause instanceof Error, true);
          return true;
        },
      );
      assert.equal(harness.calls.length, 1);
      assert.equal(harness.calls[0].method, 'GET');
      assert.equal(harness.calls[0].url.pathname, '/v1/shared-voices');
    },
  },
  {
    name: 'practice call eleven: drawVoice gives every eligible library voice a uniform share',
    async run() {
      const rows = Array.from({ length: 10 }, (_, index) => candidate(`lib-${index}`, index % 2 ? 'female' : 'male'));
      const harness = sharedVoicesFetch({ rows, total: 10 });
      const ids = rows.map(row => row.voice_id);
      assert.equal(ids.length, 10);
      const counts = new Map(ids.map(id => [id, 0]));
      const random = mulberry32(20261108);
      const draws = 7000;
      for (let step = 0; step < draws; step += 1) {
        const result = await drawVoice({ fetch: harness.fetch, key: KEY, pageSize: 5, random });
        assert.equal(counts.has(result.voice.voiceId), true, `unexpected voice ${result.voice.voiceId}`);
        counts.set(result.voice.voiceId, counts.get(result.voice.voiceId) + 1);
      }
      assert.equal([...counts.values()].reduce((total, count) => total + count, 0), draws);
      for (const [id, count] of counts) {
        const share = count / draws;
        assert.equal(share >= 0.07 && share <= 0.13, true, `${id} was drawn ${share}`);
      }
    },
  },
  {
    name: 'practice call eleven: exhausting the draws is voice-library-unavailable',
    async run() {
      const rows = [
        candidate('lib-pricey-1', 'male', { rate: 2 }),
        candidate('lib-pricey-2', 'female', { rate: 3 }),
      ];
      const harness = sharedVoicesFetch({ rows, total: 2 });
      await assert.rejects(
        drawVoice({
          fetch: harness.fetch, key: KEY, pageSize: 5, maxAttempts: 4, random: () => 0.8,
        }),
        error => {
          assert.equal(error.code, 'voice-library-unavailable');
          assert.equal(error.message, 'No usable voice was found in the ElevenLabs voice library.');
          return true;
        },
      );
      assert.deepEqual(harness.calls.map(call => call.url.searchParams.get('page')), ['0']);
    },
  },
  {
    name: 'practice call eleven: an unusable library is voice-library-unavailable',
    async run() {
      const ineligible = sharedVoicesFetch({ rows: [candidate('lib-pricey', 'male', { rate: 2 })], total: 1 });
      await assert.rejects(
        drawVoice({ fetch: ineligible.fetch, key: KEY, maxAttempts: 3, random: () => 0.5 }),
        error => {
          assert.equal(error.code, 'voice-library-unavailable');
          assert.equal(error.message, 'No usable voice was found in the ElevenLabs voice library.');
          return true;
        },
      );
      const empty = sharedVoicesFetch({ rows: [], total: 0 });
      await assert.rejects(
        drawVoice({ fetch: empty.fetch, key: KEY, maxAttempts: 2, random: () => 0.5 }),
        error => {
          assert.equal(error.code, 'voice-library-unavailable');
          assert.equal(error.message, 'The ElevenLabs voice library could not be read.');
          return true;
        },
      );
      const unreachable = sharedVoicesFetch({ rows: [], fail: { 0: true } });
      await assert.rejects(
        drawVoice({ fetch: unreachable.fetch, key: KEY, maxAttempts: 2, random: () => 0.5 }),
        error => {
          assert.equal(error.code, 'voice-library-unavailable');
          assert.equal(error.message, 'The ElevenLabs voice library could not be read.');
          return true;
        },
      );
      assert.equal(ineligible.calls.length, 1);
      assert.equal(unreachable.calls.length, 1);
      assert.equal(empty.calls.length, 1);
    },
  },
  {
    name: 'practice call eleven: the pool store keeps only the fifty most recent lastUsed entries',
    async run() {
      const filePath = '/data/practice-voice-pool.json';
      const lastUsed = {};
      for (let index = 0; index < 60; index += 1) lastUsed[`voice-${String(index).padStart(2, '0')}`] = index;
      lastUsed['voice-text'] = 'yesterday';
      const legacy = {
        version: 1,
        added: [{ voiceId: 'voice-old', sourceVoiceId: 'src', publicOwnerId: 'owner', name: 'Old', addedAt: 3 }],
        lastUsed,
        opsCost: { add: 1, remove: 0, observedAt: 9 },
      };
      const fs = memoryFs({ [filePath]: JSON.stringify(legacy) });
      const store = createVoicePoolStore({ filePath, fs });
      const loaded = await store.load();
      assert.deepEqual(Object.keys(loaded), ['version', 'lastUsed']);
      assert.equal(loaded.version, 1);
      assert.equal(Object.keys(loaded.lastUsed).length, 50);
      // The ten oldest readings and the malformed one are pruned; the newest fifty survive.
      assert.equal('voice-00' in loaded.lastUsed, false);
      assert.equal('voice-09' in loaded.lastUsed, false);
      assert.equal('voice-text' in loaded.lastUsed, false);
      assert.equal(loaded.lastUsed['voice-10'], 10);
      assert.equal(loaded.lastUsed['voice-59'], 59);
      assert.deepEqual(
        Object.keys(loaded.lastUsed).sort(),
        Array.from({ length: 50 }, (_, index) => `voice-${String(index + 10).padStart(2, '0')}`),
      );

      await store.save(legacy);
      const written = JSON.parse(fs.files.get(filePath));
      assert.deepEqual(Object.keys(written), ['version', 'lastUsed']);
      assert.equal(Object.keys(written.lastUsed).length, 50);
      assert.equal('added' in written, false);
      assert.equal('opsCost' in written, false);
      assert.deepEqual(await store.load(), written);
    },
  },
];
