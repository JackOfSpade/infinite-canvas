import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildUrl, buildInitMessage, buildTextMessage, buildCloseMessage, audioMsFromBytes,
  inspectServerMessage, percentile, summarizeTrials, parseArgs, scrub, main,
  DEFAULT_VOICE_ID, DEFAULT_VOICE_SETTINGS,
} from './voice-latency.mjs';

test('buildUrl has model, pcm_16000 and sync_alignment params', () => {
  const url = new URL(buildUrl('abc123'));
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.host, 'api.elevenlabs.io');
  assert.equal(url.pathname, '/v1/text-to-speech/abc123/stream-input');
  assert.equal(url.searchParams.get('model_id'), 'eleven_flash_v2_5');
  assert.equal(url.searchParams.get('output_format'), 'pcm_16000');
  assert.equal(url.searchParams.get('sync_alignment'), 'true');
  assert.ok(buildUrl().includes(DEFAULT_VOICE_ID));
});

test('init message is a single space with voice settings and key', () => {
  const msg = buildInitMessage('k-123');
  assert.equal(msg.text, ' ');
  assert.deepEqual(msg.voice_settings, DEFAULT_VOICE_SETTINGS);
  assert.equal(msg.xi_api_key, 'k-123');
});

test('text message adds trailing space and flush; close message is empty text', () => {
  assert.deepEqual(buildTextMessage('Hello there.'), { text: 'Hello there. ', flush: true });
  assert.deepEqual(buildTextMessage('Hi ', { flush: false }), { text: 'Hi ' });
  assert.deepEqual(buildCloseMessage(), { text: '' });
});

test('audioMsFromBytes: 32000 bytes of 16 kHz s16 mono = 1000 ms', () => {
  assert.equal(audioMsFromBytes(32000), 1000);
  assert.equal(audioMsFromBytes(0), 0);
});

test('inspectServerMessage detects audio bytes, alignment, final and errors', () => {
  const audio = Buffer.alloc(640).toString('base64');
  const a = inspectServerMessage({ audio, alignment: { chars: ['H', 'i'], charStartTimesMs: [0, 10], charDurationsMs: [10, 10] } });
  assert.equal(a.audioBytes, 640);
  assert.equal(a.hasAlignment, true);
  assert.equal(a.isFinal, false);
  const b = inspectServerMessage({ audio: null, alignment: null, normalizedAlignment: { chars: ['x'] } });
  assert.equal(b.audioBytes, 0);
  assert.equal(b.hasAlignment, true);
  assert.equal(inspectServerMessage({ audio: '', alignment: { chars: [] } }).hasAlignment, false);
  assert.equal(inspectServerMessage({ isFinal: true }).isFinal, true);
  assert.equal(inspectServerMessage({ error: 'bad voice' }).error, 'bad voice');
});

test('percentile uses nearest-rank', () => {
  const v = [50, 10, 40, 20, 30];
  assert.equal(percentile(v, 50), 30);
  assert.equal(percentile(v, 95), 50);
  assert.equal(percentile(v, 0), 10);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(twenty, 95), 19);
});

test('summarizeTrials computes p50/p95 over successful trials and counts failures', () => {
  const trials = [
    { ttfaMs: 100, connectMs: 50, finalMs: 400, alignment: true, audioMs: 3000, error: null },
    { ttfaMs: 200, connectMs: 60, finalMs: 500, alignment: true, audioMs: 3000, error: null },
    { ttfaMs: 300, connectMs: 70, finalMs: 600, alignment: false, audioMs: 3000, error: null },
    { ttfaMs: null, connectMs: null, finalMs: null, alignment: false, audioMs: 0, error: 'timeout' },
  ];
  const s = summarizeTrials(trials);
  assert.equal(s.trials, 4);
  assert.equal(s.succeeded, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.ttfaMs.p50, 200);
  assert.equal(s.ttfaMs.p95, 300);
  assert.equal(s.alignmentArrivedInTrials, 2);
  assert.deepEqual(s.errors, ['timeout']);
});

test('parseArgs defaults and validation', () => {
  assert.deepEqual(parseArgs([]), { trials: 5, voice: DEFAULT_VOICE_ID });
  assert.deepEqual(parseArgs(['--trials', '10', '--voice', 'AbC9']), { trials: 10, voice: 'AbC9' });
  assert.throws(() => parseArgs(['--trials', '0']));
  assert.throws(() => parseArgs(['--voice', '../x']));
  assert.throws(() => parseArgs(['--bogus']));
});

test('scrub removes the key from strings', () => {
  assert.equal(scrub('failed with key sk-secret here', 'sk-secret'), 'failed with key [redacted] here');
  assert.equal(scrub('no key', ''), 'no key');
});

test('main refuses to run without ELEVENLABS_API_KEY (no network)', async () => {
  const code = await main([], {});
  assert.equal(code, 2);
});

test('CLI exits non-zero without key and prints no key material', () => {
  const script = fileURLToPath(new URL('./voice-latency.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.ELEVENLABS_API_KEY;
  const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ELEVENLABS_API_KEY is not set/);
  assert.equal(r.stdout, '');
});
