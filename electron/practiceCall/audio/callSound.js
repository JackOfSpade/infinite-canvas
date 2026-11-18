// Interviewer audio arrives as studio-clean text-to-speech. This turns it into "a person in a small
// room, heard by a laptop microphone and levelled by the call software": early reflections, a short
// reverberant tail, band-limiting, a levelling compressor and a limiter. No noise is added.
// A pure streaming processor over 16-bit mono PCM. The room (how much and how long it rings) is
// chosen per interviewer by roomFor(seed), so voices do not all share one acoustic.

const DEFAULT_ROOM = Object.freeze({
  rt60Ms: 350, directToReverbDb: 9, highPassHz: 100, lowPassHz: 7900, gainDb: 0, earlyMs: [3, 7],
});
const THRESHOLD_DB = -22;
const RATIO = 3;
const KNEE_DB = 6;
const MAKE_UP_DB = 5;
const ATTACK_MS = 10;
const RELEASE_MS = 200;
const LIMIT_START = 0.85; // above this the limiter pulls the gain down and a soft knee rounds the rest
const LIMIT_CEILING = 0.98;
const LIMIT_ATTACK_MS = 0.2;
const LIMIT_RELEASE_MS = 80;
// Reverb comb delays (ms at scale 1). Mutually unrelated lengths avoid a metallic ring.
const COMB_MS = Object.freeze([11.3, 14.7, 17.9, 21.1]);
const ALLPASS_MS = Object.freeze([4.3, 1.9]);
const ALLPASS_GAIN = 0.6;
const DAMPING = 0.25; // one-pole low-pass inside each comb: high frequencies die sooner, as in a real room
const EARLY_SHARE = 0.25; // share of the non-direct energy carried by the early reflections
const LAG_BYTES = 2; // one sample: lets any chunking, odd byte counts included, keep the byte count
const TINY = 1e-18;

// A fully dry voice sounds synthetic, so the processor always leaves a slight room: this is the
// driest it will go (barely noticeable unless listened for), whatever a caller asks for.
const MIN_RT60_MS = 160;
const MAX_DIRECT_TO_REVERB_DB = 15;
const MAX_RT60_MS = 480;
const MIN_DIRECT_TO_REVERB_DB = 6;

const clampNumber = (value, low, high, fallback) => (Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback);

// Butterworth sections: a 4th-order filter is two biquads with these Q values.
const BUTTER4_Q = Object.freeze([0.5411961, 1.3065630]);

function biquad(type, hz, q, sampleRate) {
  const w = 2 * Math.PI * Math.min(hz, sampleRate * 0.45) / sampleRate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const high = type === 'high';
  const b0 = (high ? (1 + cos) / 2 : (1 - cos) / 2) / a0;
  const b1 = (high ? -(1 + cos) : 1 - cos) / a0;
  return { b0, b1, b2: b0, a1: -2 * cos / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function runBiquad(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
  return y;
}

// Schroeder reverberator: parallel damped combs into two all-pass diffusers.
// Each comb's feedback is g = 10^(-3 d / rt60) for its own delay d, which makes that comb's echoes
// fall 60 dB in exactly rt60; the sum of equal-slope decays therefore falls 60 dB in rt60 as well.
// The delays scale with rt60 (0.8x to 1.2x across 180 to 480 ms) so bigger rooms have longer gaps.
// Measured on the finished chain the tail came out about a third shorter than asked for (the
// damping in each loop and the filters after it take energy the formula does not count), so the
// loops are tuned to a proportionally longer time and the heard decay matches the room asked for.
const RT60_COMPENSATION = 1.45;
function createReverb(rate, rt60Ms) {
  const rt60 = (rt60Ms * RT60_COMPENSATION) / 1000;
  const scale = 0.8 + 0.4 * clampNumber((rt60Ms - 180) / 300, 0, 1, 0.5);
  const combs = COMB_MS.map(ms => {
    const length = Math.max(2, Math.round(rate * ms * scale / 1000));
    return { buf: new Float64Array(length), at: 0, lp: 0, g: 10 ** (-3 * (length / rate) / rt60) };
  });
  const allpasses = ALLPASS_MS.map(ms => ({ buf: new Float64Array(Math.max(2, Math.round(rate * ms / 1000))), at: 0 }));
  return {
    run(x) {
      let sum = 0;
      for (const c of combs) {
        const delayed = c.buf[c.at];
        c.lp = (1 - DAMPING) * delayed + DAMPING * c.lp;
        if (c.lp < TINY && c.lp > -TINY) c.lp = 0;
        c.buf[c.at] = x + c.g * c.lp;
        c.at = c.at + 1 === c.buf.length ? 0 : c.at + 1;
        sum += delayed;
      }
      for (const a of allpasses) {
        const d = a.buf[a.at];
        const v = sum + ALLPASS_GAIN * d;
        a.buf[a.at] = v > TINY || v < -TINY ? v : 0;
        sum = d - ALLPASS_GAIN * v;
        a.at = a.at + 1 === a.buf.length ? 0 : a.at + 1;
      }
      return sum;
    },
  };
}

// Scale that makes the tail's total energy equal 'share' times the energy of a unit impulse.
function tailGainFor(rate, rt60Ms, share) {
  const probe = createReverb(rate, rt60Ms);
  const length = Math.ceil(rate * rt60Ms / 1000 * 2.5) + 64;
  let energy = 0;
  for (let i = 0; i < length; i += 1) { const y = probe.run(i === 0 ? 1 : 0); energy += y * y; }
  return energy > 0 ? Math.sqrt(share / energy) : 0;
}

function normalizeRoom(room) {
  const source = room && typeof room === 'object' ? room : {};
  const early = Array.isArray(source.earlyMs) && source.earlyMs.length >= 2 ? source.earlyMs : DEFAULT_ROOM.earlyMs;
  return {
    rt60Ms: clampNumber(source.rt60Ms, MIN_RT60_MS, 2000, DEFAULT_ROOM.rt60Ms),
    directToReverbDb: clampNumber(source.directToReverbDb, 0, MAX_DIRECT_TO_REVERB_DB, DEFAULT_ROOM.directToReverbDb),
    highPassHz: clampNumber(source.highPassHz, 20, 1000, DEFAULT_ROOM.highPassHz),
    lowPassHz: clampNumber(source.lowPassHz, 2000, 11000, DEFAULT_ROOM.lowPassHz),
    gainDb: clampNumber(source.gainDb, -12, 12, DEFAULT_ROOM.gainDb),
    earlyMs: [clampNumber(early[0], 0.5, 30, DEFAULT_ROOM.earlyMs[0]), clampNumber(early[1], 0.5, 30, DEFAULT_ROOM.earlyMs[1])],
  };
}

function createCallSound({ sampleRate = 24000, room } = {}) {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000;
  const r = normalizeRoom(room);
  const attack = Math.exp(-1 / (rate * ATTACK_MS / 1000));
  const release = Math.exp(-1 / (rate * RELEASE_MS / 1000));
  const limitAttack = Math.exp(-1 / (rate * LIMIT_ATTACK_MS / 1000));
  const limitRelease = Math.exp(-1 / (rate * LIMIT_RELEASE_MS / 1000));
  const slope = 1 / RATIO - 1;
  const makeUp = 10 ** ((MAKE_UP_DB + r.gainDb) / 20);

  // Everything that is not the direct sound carries energy 10^(-directToReverbDb/10) of it.
  const reverbEnergy = 10 ** (-r.directToReverbDb / 10);
  const earlyEnergy = reverbEnergy * EARLY_SHARE;
  const early = r.earlyMs.map((ms, i) => ({
    delay: Math.max(1, Math.round(rate * ms / 1000)),
    gain: (i % 2 ? -1 : 1) * Math.sqrt(earlyEnergy * (i ? 0.4 : 0.6)),
  }));
  const tailGain = tailGainFor(rate, r.rt60Ms, reverbEnergy - earlyEnergy);
  const reverb = createReverb(rate, r.rt60Ms);
  const lineLength = Math.max(...early.map(e => e.delay)) + 1;
  const line = new Float64Array(lineLength);

  const highs = BUTTER4_Q.map(q => biquad('high', r.highPassHz, q, rate));
  const lows = BUTTER4_Q.map(q => biquad('low', r.lowPassHz, q, rate));

  let env = 0;
  let limitGain = 1;
  let write = 0;
  let carry = -1; // a low byte whose high byte has not arrived yet
  let pending = Buffer.alloc(LAG_BYTES);

  function sample(input) {
    const x = input / 32768;
    let mixed = x + tailGain * reverb.run(x);
    for (const e of early) mixed += e.gain * line[(write - e.delay + lineLength) % lineLength];
    line[write] = x;
    write = write + 1 === lineLength ? 0 : write + 1;

    let filtered = mixed;
    for (const f of highs) filtered = runBiquad(f, filtered);
    for (const f of lows) filtered = runBiquad(f, filtered);

    const level = Math.abs(filtered);
    env = level > env ? attack * env + (1 - attack) * level : release * env + (1 - release) * level;
    const over = (env > 1e-6 ? 20 * Math.log10(env) : -120) - THRESHOLD_DB;
    let reduction = 0;
    if (over > KNEE_DB / 2) reduction = slope * over;
    else if (over > -KNEE_DB / 2) reduction = slope * (over + KNEE_DB / 2) ** 2 / (2 * KNEE_DB);
    let y = filtered * makeUp * (reduction === 0 ? 1 : 10 ** (reduction / 20));

    // Limiter: fast gain pull-down for peaks, slow recovery, then a soft knee so nothing flat-tops.
    const peak = Math.abs(y);
    const need = peak > LIMIT_START ? LIMIT_START / peak : 1;
    limitGain = need < limitGain ? limitAttack * limitGain + (1 - limitAttack) * need : limitRelease * limitGain + (1 - limitRelease) * need;
    y *= limitGain;
    const mag = Math.abs(y);
    if (mag > LIMIT_START) {
      const span = LIMIT_CEILING - LIMIT_START;
      y = Math.sign(y) * (LIMIT_START + span * Math.tanh((mag - LIMIT_START) / span));
    }
    const out = Math.round(y * 32768);
    return out > 32767 ? 32767 : out < -32768 ? -32768 : out;
  }

  function resetState() {
    for (const f of [...highs, ...lows]) { f.x1 = f.x2 = f.y1 = f.y2 = 0; }
    line.fill(0);
    reverb.run = createReverb(rate, r.rt60Ms).run;
    env = 0; limitGain = 1; write = 0; carry = -1;
    pending = Buffer.alloc(LAG_BYTES);
  }

  function process(buffer) {
    if (!buffer || !buffer.length) return Buffer.alloc(0);
    const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength ?? buffer.length);
    const total = input.length + (carry >= 0 ? 1 : 0);
    const whole = total >> 1;
    const made = Buffer.allocUnsafe(whole * 2);
    let at = 0;
    let read = 0;
    if (carry >= 0) {
      made.writeInt16LE(sample(((carry | (input[0] << 8)) << 16) >> 16), 0);
      at = 2; read = 1; carry = -1;
    }
    for (; at < made.length; at += 2, read += 2) made.writeInt16LE(sample(input.readInt16LE(read)), at);
    if (read < input.length) carry = input[read];
    const queue = Buffer.concat([pending, made]);
    pending = Buffer.from(queue.subarray(input.length));
    return queue.subarray(0, input.length);
  }

  return { process, reset: resetState };
}

// 32-bit string hash and a small seeded generator: the only source of variation between rooms.
function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A room for one interviewer: same seed, same room; every value inside a realistic range.
// amount (0..1, how much of the room is heard) sets the reverb length and level when given; 0 is the
// slight floor, 1 a bare echoey room. The other values always come from the seed. The seeded draws
// happen in the same order either way so those other values do not change with the amount.
function roomFor(seed, amount) {
  const next = seededRandom(hashSeed(String(seed ?? '')));
  const between = (low, high) => low + (high - low) * next();
  const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;
  const seededRt60 = Math.round(between(MIN_RT60_MS, MAX_RT60_MS));
  const seededD2r = round(between(MIN_DIRECT_TO_REVERB_DB, MAX_DIRECT_TO_REVERB_DB), 1);
  const given = typeof amount === 'number' && Number.isFinite(amount);
  const a = given ? Math.min(1, Math.max(0, amount)) : 0;
  return {
    rt60Ms: given ? Math.round(MIN_RT60_MS + (MAX_RT60_MS - MIN_RT60_MS) * a) : seededRt60,
    directToReverbDb: given ? round(MAX_DIRECT_TO_REVERB_DB + (MIN_DIRECT_TO_REVERB_DB - MAX_DIRECT_TO_REVERB_DB) * a, 1) : seededD2r,
    highPassHz: Math.round(between(80, 140)),
    lowPassHz: Math.round(between(6800, 7900)),
    gainDb: round(between(-2, 2), 1),
    earlyMs: [round(between(2.4, 3.8), 2), round(between(6, 8.5), 2)],
  };
}

export { createCallSound, roomFor };
export default createCallSound;
