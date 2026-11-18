import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCallCodec, OPUS_SET_MAX_BANDWIDTH_REQUEST, OPUS_BANDWIDTH_WIDEBAND } from '../../electron/practiceCall/audio/callCodec.js';

const cases = [];
const test = (name, run) => cases.push({ name: `practice call codec: ${name}`, run });
const RATE = 24000;

function tone(hz, amp, ms, rate = RATE) {
  const n = Math.round(rate * ms / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) b.writeInt16LE(Math.round(amp * 32767 * Math.sin(2 * Math.PI * hz * i / rate)), i * 2);
  return b;
}
function rms(buffer, fromMs, toMs) {
  const a = Math.floor(RATE * fromMs / 1000); const z = Math.min(Math.floor(RATE * toMs / 1000), buffer.length / 2);
  let sum = 0;
  for (let i = a; i < z; i += 1) { const v = buffer.readInt16LE(i * 2); sum += v * v; }
  return Math.sqrt(sum / (z - a));
}
// Magnitude of one frequency (Goertzel-free direct correlation), normalised to amplitude.
function level(buffer, hz, fromMs, toMs) {
  const a = Math.floor(RATE * fromMs / 1000); const z = Math.min(Math.floor(RATE * toMs / 1000), buffer.length / 2);
  let re = 0; let im = 0;
  for (let i = a; i < z; i += 1) {
    const v = buffer.readInt16LE(i * 2);
    re += v * Math.cos(2 * Math.PI * hz * i / RATE); im += v * Math.sin(2 * Math.PI * hz * i / RATE);
  }
  return 2 * Math.hypot(re, im) / (z - a);
}
function runChunks(codec, input, size) {
  const parts = [];
  for (let i = 0; i < input.length; i += size) parts.push(codec.process(input.subarray(i, i + size)));
  parts.push(codec.flush());
  return Buffer.concat(parts);
}
function makeCodec(extra = {}) { const errors = []; return { errors, codec: createCallCodec({ sampleRate: RATE, onError: e => errors.push(e), ...extra }) }; }

test('byte count out equals bytes in for any chunking', () => {
  const input = tone(300, 0.3, 1000);
  for (const size of [1, 3, 7, 480, 960, input.length]) {
    const { codec, errors } = makeCodec();
    const src = size === 1 ? input.subarray(0, 4000) : input;
    assert.equal(runChunks(codec, src, size).length, src.length, `chunk ${size}`);
    assert.equal(errors.length, 0);
  }
  const odd = input.subarray(0, 12345);
  const { codec } = makeCodec();
  assert.equal(runChunks(codec, odd, 777).length, 12345);
  assert.equal(makeCodec().codec.flush().length, 0);
});

test('a tone keeps its pitch and level; the delay is under 60 ms', () => {
  const input = tone(1000, 0.3, 1500);
  const { codec } = makeCodec();
  const out = runChunks(codec, input, 960);
  const inLevel = level(input, 1000, 500, 1200);
  // Find delay by cross-correlation over 0..60 ms.
  let best = 0; let bestLag = 0;
  for (let lag = 0; lag <= RATE * 0.06; lag += 1) {
    let c = 0;
    for (let i = 6000; i < 6000 + 2400; i += 4) c += input.readInt16LE(i * 2) * out.readInt16LE((i + lag) * 2);
    if (c > best) { best = c; bestLag = lag; }
  }
  const delayMs = bestLag * 1000 / RATE;
  console.log(`  codec delay: ${delayMs.toFixed(2)} ms`);
  assert.ok(delayMs < 60);
  const outLevel = level(out, 1000, 500, 1200);
  assert.ok(outLevel / inLevel > 0.7 && outLevel / inLevel < 1.3, `level ratio ${outLevel / inLevel}`);
  assert.ok(level(out, 1000, 500, 1200) > 8 * level(out, 2300, 500, 1200));
});

test('a 10 kHz tone is strongly reduced', () => {
  const input = tone(10000, 0.3, 1000);
  const { codec } = makeCodec();
  const out = runChunks(codec, input, 960);
  const ratio = rms(out, 300, 900) / rms(input, 300, 900);
  console.log(`  10 kHz residual ratio: ${ratio.toFixed(4)}`);
  assert.ok(ratio < 0.1, `ratio ${ratio}`);
});

test('wideband limit constants are the libopus ones', () => {
  assert.equal(OPUS_SET_MAX_BANDWIDTH_REQUEST, 4004);
  assert.equal(OPUS_BANDWIDTH_WIDEBAND, 1103);
});

test('a failing load is a byte-identical pass-through with one error', () => {
  const input = tone(500, 0.3, 300);
  const { codec, errors } = makeCodec({ load: () => { throw new Error('no package'); } });
  const out = runChunks(codec, input, 333);
  assert.deepEqual(out, input);
  assert.equal(errors.length, 1);
});

test('an unsupported rate passes through', () => {
  const errors = [];
  const codec = createCallCodec({ sampleRate: 44100, onError: e => errors.push(e) });
  const input = tone(500, 0.3, 200, 44100);
  assert.deepEqual(runChunks(codec, input, 500), input);
});

test('an encoder that throws mid-stream becomes pass-through without changing the byte count', () => {
  const input = tone(500, 0.3, 600);
  const errors = [];
  let calls = 0;
  const Real = createRequireOpus();
  function Flaky(...args) {
    const inner = new Real(...args);
    return {
      setBitrate: x => inner.setBitrate(x), encoderCTL: (a, b) => inner.encoderCTL(a, b),
      encode: (b, n) => { calls += 1; if (calls === 5) throw new Error('boom'); return inner.encode(b, n); },
      decode: p => inner.decode(p), delete: () => inner.delete(),
    };
  }
  Flaky.Application = Real.Application;
  const codec = createCallCodec({ sampleRate: RATE, onError: e => errors.push(e), load: () => Flaky });
  const out = runChunks(codec, input, 700);
  assert.equal(out.length, input.length);
  assert.equal(errors.length, 1);
});

test('60 s of audio processes in under 5 s', () => {
  const input = tone(440, 0.3, 60000);
  const { codec } = makeCodec();
  const t = process.hrtime.bigint();
  const out = runChunks(codec, input, 4800);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`  60 s of audio: ${ms.toFixed(0)} ms`);
  assert.equal(out.length, input.length);
  assert.ok(ms < 5000);
});

function createRequireOpus() { return createRequire(import.meta.url)('opusscript'); }

export default cases;
