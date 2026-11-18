import assert from 'node:assert/strict';
import { createCallSound, roomFor } from '../../electron/practiceCall/audio/callSound.js';

const cases = [];
const test = (name, run) => cases.push({ name: `practice call sound: ${name}`, run });
const RATE = 24000;
const ROOM = Object.freeze({ rt60Ms: 350, directToReverbDb: 9, highPassHz: 100, lowPassHz: 7900, gainDb: 0, earlyMs: [3, 7] });

function seeded(seed = 7) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function tone(hz, amp, ms) {
  const n = Math.round(RATE * ms / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) b.writeInt16LE(Math.round(amp * 32767 * Math.sin(2 * Math.PI * hz * i / RATE)), i * 2);
  return b;
}
function noise(ms, amp, seed = 3) {
  const rand = seeded(seed);
  const n = Math.round(RATE * ms / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) b.writeInt16LE(Math.round((rand() * 2 - 1) * amp * 32767), i * 2);
  return b;
}
function rms(buffer, from = 0.5) {
  const start = Math.floor(buffer.length * from / 2) * 2;
  let sum = 0; let n = 0;
  for (let i = start; i + 1 < buffer.length; i += 2) { const v = buffer.readInt16LE(i); sum += v * v; n += 1; }
  return Math.sqrt(sum / n);
}
const db = (a, b) => 20 * Math.log10(a / b);
const fresh = (room = ROOM) => createCallSound({ sampleRate: RATE, room });
function inChunks(input, size, room = ROOM) {
  const sound = fresh(room);
  const parts = [];
  for (let at = 0; at < input.length; at += size) parts.push(sound.process(input.subarray(at, at + size)));
  return Buffer.concat(parts);
}
function impulse(seconds, amp = 0.3) {
  const b = Buffer.alloc(Math.round(RATE * seconds) * 2);
  b.writeInt16LE(Math.round(amp * 32767), 0);
  return b;
}
function samples(buffer) {
  const out = new Float64Array(buffer.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = buffer.readInt16LE(i * 2);
  return out;
}

test('byte count and output are identical for chunk sizes 1, 3, 7, 480 and one huge chunk', () => {
  const input = Buffer.concat([tone(300, 0.3, 200), noise(100, 0.2)]);
  const whole = fresh().process(input);
  assert.equal(whole.length, input.length);
  for (const size of [1, 3, 7, 480, input.length + 5]) {
    const out = inChunks(input, size);
    assert.equal(out.length, input.length, `size ${size}`);
    assert.deepEqual(out, whole, `size ${size}`);
  }
});

test('an odd byte count is preserved and a second run is identical', () => {
  const input = tone(440, 0.3, 100).subarray(0, 1001);
  assert.equal(fresh().process(input).length, 1001);
  assert.deepEqual(fresh().process(input), fresh().process(input));
  const sound = fresh();
  const first = sound.process(input);
  sound.reset();
  assert.deepEqual(sound.process(input), first);
});

test('an impulse decays 60 dB at rt60 (within 30%) with the set direct-to-reverb ratio', () => {
  for (const [rt60Ms, d2r] of [[350, 9], [200, 13], [470, 7]]) {
    const out = samples(fresh({ ...ROOM, rt60Ms, directToReverbDb: d2r }).process(impulse(rt60Ms / 1000 * 3 + 0.5)));
    const direct = Math.round(RATE * 0.0015);
    const after = Math.round(RATE * 0.0018);
    let directEnergy = 0; let tail = 0;
    for (let i = 0; i < out.length; i += 1) { if (i < direct) directEnergy += out[i] ** 2; else if (i >= after) tail += out[i] ** 2; }
    const ratio = 10 * Math.log10(directEnergy / tail);
    assert.ok(Math.abs(ratio - d2r) < 3, `rt ${rt60Ms}: direct-to-reverb ${ratio.toFixed(2)} dB vs ${d2r}`);
    // Schroeder backward integration: time for the energy to fall from -5 to -35 dB, doubled.
    const edc = new Float64Array(out.length);
    let acc = 0;
    for (let i = out.length - 1; i >= 0; i -= 1) { acc += out[i] ** 2; edc[i] = acc; }
    const total = edc[after];
    const at = level => { for (let i = after; i < edc.length; i += 1) if (10 * Math.log10(edc[i] / total) <= level) return i; return edc.length; };
    const measured = 2 * (at(-35) - at(-5)) / RATE * 1000;
    assert.ok(Math.abs(measured - rt60Ms) <= rt60Ms * 0.3, `rt60 ${measured.toFixed(0)} ms vs ${rt60Ms}`);
  }
});

test('1 kHz is kept while 50 Hz and 10 kHz are clearly reduced', () => {
  const level = hz => rms(fresh().process(tone(hz, 0.05, 1500)), 0.4);
  const mid = level(1000);
  const change = db(mid, rms(tone(1000, 0.05, 1500), 0.4));
  assert.ok(change > 0 && change < 10, `1 kHz change ${change}`); // make-up gain, no loss
  for (const hz of [50, 10000]) {
    const drop = db(level(hz), mid);
    assert.ok(drop < -8, `${hz} Hz is ${drop} dB against 1 kHz`);
  }
});

test('a loud burst is levelled without flat-topping', () => {
  const input = tone(1000, 1, 400);
  const output = fresh().process(input);
  const values = samples(output);
  const peak = Math.max(...values.map(Math.abs));
  assert.ok(peak <= 32767);
  let run = 0; let longest = 0;
  for (const v of values) { run = Math.abs(v) >= peak * 0.98 ? run + 1 : 0; longest = Math.max(longest, run); }
  assert.ok(longest < 6, `longest run near the peak ${longest}`);
  assert.ok(rms(output) < rms(input) * 0.8);
});

test('silence in gives exact silence out', () => {
  const output = fresh().process(Buffer.alloc(RATE * 2));
  assert.ok(output.every(byte => byte === 0));
});

test('60 s of noise stays finite and bounded', () => {
  const sound = fresh();
  let largest = 0;
  for (let second = 0; second < 60; second += 1) {
    const out = sound.process(noise(1000, 0.8, second + 1));
    for (let i = 0; i < out.length; i += 2) largest = Math.max(largest, Math.abs(out.readInt16LE(i)));
  }
  assert.ok(Number.isFinite(largest) && largest <= 32767);
  assert.ok(largest > 1000);
  const tail = sound.process(Buffer.alloc(RATE * 2 * 3));
  assert.ok(Number.isFinite(rms(tail)));
  assert.ok(rms(tail, 0.9) < 2, 'the tail dies away after the input stops');
});

test('60 s of 24 kHz audio processes well under a second', () => {
  const input = noise(60000, 0.3);
  const sound = fresh();
  const start = process.hrtime.bigint();
  const out = sound.process(input);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`practice call sound: 60 s of audio processed in ${ms.toFixed(0)} ms`);
  assert.equal(out.length, input.length);
  assert.ok(ms < 1000, `${ms} ms`);
});

test('roomFor is deterministic, in range for 200 seeds, and different seeds differ', () => {
  assert.deepEqual(roomFor('voice-a'), roomFor('voice-a'));
  assert.notDeepEqual(roomFor('voice-a'), roomFor('voice-b'));
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const room = roomFor(`synthetic-voice-${i}`);
    assert.ok(room.rt60Ms >= 160 && room.rt60Ms <= 480, `rt60 ${room.rt60Ms}`);
    assert.ok(room.directToReverbDb >= 6 && room.directToReverbDb <= 15);
    assert.ok(room.highPassHz >= 80 && room.highPassHz <= 140);
    assert.ok(room.lowPassHz >= 6800 && room.lowPassHz <= 7900);
    assert.ok(room.gainDb >= -2 && room.gainDb <= 2);
    assert.ok(room.earlyMs.length === 2 && room.earlyMs[0] < room.earlyMs[1]);
    seen.add(JSON.stringify(room));
  }
  assert.ok(seen.size > 190);
});

test('roomFor(seed, amount) maps the amount to the stated ends and keeps the seeded rest', () => {
  for (const seed of ['voice-a', 'voice-b', 'voice-c']) {
    const base = roomFor(seed);
    const rest = room => ({ ...room, rt60Ms: 0, directToReverbDb: 0 });
    const zero = roomFor(seed, 0);
    const one = roomFor(seed, 1);
    const mid = roomFor(seed, 0.5);
    assert.equal(zero.rt60Ms, 160);
    assert.equal(zero.directToReverbDb, 15);
    assert.equal(one.rt60Ms, 480);
    assert.equal(one.directToReverbDb, 6);
    assert.equal(mid.rt60Ms, 320);
    assert.equal(mid.directToReverbDb, 10.5);
    for (const room of [zero, one, mid]) assert.deepEqual(rest(room), rest(base));
    assert.deepEqual(roomFor(seed, -3), zero);
    assert.deepEqual(roomFor(seed, 7), one);
    assert.deepEqual(roomFor(seed, null), base);
    assert.deepEqual(roomFor(seed, undefined), base);
    assert.deepEqual(roomFor(seed, 0.5), roomFor(seed, 0.5));
  }
});

test('the processor never goes fully dry: amount 0 still has a measurable room and drier requests clamp', () => {
  const ratioOf = room => {
    const out = samples(fresh(room).process(impulse(1.5)));
    const direct = Math.round(RATE * 0.0015);
    const after = Math.round(RATE * 0.0018);
    let d = 0; let tail = 0;
    for (let i = 0; i < out.length; i += 1) { if (i < direct) d += out[i] ** 2; else if (i >= after) tail += out[i] ** 2; }
    return { ratio: 10 * Math.log10(d / tail), out };
  };
  const slight = roomFor('voice-a', 0);
  const { ratio } = ratioOf(slight);
  assert.ok(Math.abs(ratio - 15) < 3, `direct-to-reverb ${ratio.toFixed(2)} dB`);
  const atClamp = fresh({ ...slight, directToReverbDb: 15, rt60Ms: 160 }).process(impulse(1.5));
  const drier = fresh({ ...slight, directToReverbDb: 40, rt60Ms: 20 }).process(impulse(1.5));
  assert.deepEqual(drier, atClamp);
});

test('different rooms sound different on the same input', () => {
  const input = Buffer.concat([tone(300, 0.3, 200), Buffer.alloc(RATE)]);
  const a = fresh(roomFor('voice-a')).process(input);
  const b = fresh(roomFor('voice-b')).process(input);
  assert.notDeepEqual(a, b);
});

export default cases;
