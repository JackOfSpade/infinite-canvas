// Turn-level prosody on synthetic-friendly acoustic measures. Pure: no I/O.
// Pause times are on the helper timeline (turn startMs plus frame offset).
import { trackPitch } from './pitch.js';

const FRAME_MS = 20;
const PAUSE_MIN_MS = 300;
const SPEECH_FLOOR_DB = -50;
const SPEECH_MARGIN_DB = 10;
const SILENCE_DB = -120;

const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

const median = sorted => percentile(sorted, 0.5);

// 20 ms non-overlapping frames of RMS in dBFS.
function frameDb(samples, sampleRate) {
  const size = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const count = Math.floor((samples?.length ?? 0) / size);
  const db = new Float64Array(Math.max(0, count));
  for (let frame = 0; frame < count; frame += 1) {
    let sum = 0;
    for (let i = 0; i < size; i += 1) {
      const value = samples[frame * size + i];
      sum += value * value;
    }
    const rms = Math.sqrt(sum / size);
    db[frame] = rms > 0 ? 20 * Math.log10(rms) : SILENCE_DB;
  }
  return { db, frameMs: (size * 1000) / sampleRate };
}

function speechFlags(db) {
  if (!db.length) return { flags: new Uint8Array(0), floorDb: SPEECH_FLOOR_DB };
  const sorted = Array.from(db).sort((a, b) => a - b);
  const floorDb = Math.max(SPEECH_FLOOR_DB, percentile(sorted, 0.1) + SPEECH_MARGIN_DB);
  const flags = new Uint8Array(db.length);
  for (let i = 0; i < db.length; i += 1) flags[i] = db[i] > floorDb ? 1 : 0;
  return { flags, floorDb };
}

// Runs of non-speech strictly between the first and last speech frame.
function findPauses(flags, frameMs, startMs) {
  let first = flags.indexOf(1);
  if (first < 0) return [];
  let last = flags.length - 1;
  while (last > first && !flags[last]) last -= 1;
  const pauses = [];
  let runStart = -1;
  for (let i = first; i <= last; i += 1) {
    if (flags[i]) { runStart = -1; continue; }
    if (runStart < 0) runStart = i;
    const isEnd = i === last || flags[i + 1];
    if (!isEnd) continue;
    const durationMs = (i - runStart + 1) * frameMs;
    if (durationMs > PAUSE_MIN_MS) {
      pauses.push({
        startMs: Math.round(startMs + runStart * frameMs),
        endMs: Math.round(startMs + (i + 1) * frameMs),
      });
    }
    runStart = -1;
  }
  return pauses;
}

function tokenise(words) {
  const tokens = [];
  for (const word of words ?? []) {
    for (const piece of String(word?.text ?? '').toLowerCase().split(/\s+/)) {
      const token = piece.replace(/[^\p{L}\p{N}]/gu, '');
      if (token) tokens.push(token);
    }
  }
  return tokens;
}

// Immediately repeated tokens or adjacent token pairs; no vocabulary lists.
function countRestarts(tokens) {
  let restarts = 0;
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i] === tokens[i - 1]) { restarts += 1; continue; }
    if (i + 1 < tokens.length && tokens[i] === tokens[i - 2] && tokens[i + 1] === tokens[i - 1]) {
      restarts += 1;
      i += 1;
    }
  }
  return restarts;
}

function pitchSummary(samples, sampleRate) {
  const { f0 } = trackPitch(samples, sampleRate, {});
  const voiced = [];
  for (const hz of f0) if (hz > 0) voiced.push(hz);
  if (!voiced.length) return { pitchMedianHz: 0, pitchRangeSt: 0 };
  voiced.sort((a, b) => a - b);
  const low = percentile(voiced, 0.1);
  const high = percentile(voiced, 0.9);
  const rangeSt = low > 0 && high > 0 ? 12 * Math.log2(high / low) : 0;
  return { pitchMedianHz: round(median(voiced), 1), pitchRangeSt: round(rangeSt, 2) };
}

function wordsInsideTurn(words, startMs, endMs) {
  const outside = words ?? [];
  const inside = outside.filter(word => {
    const midpoint = ((word?.startMs ?? 0) + (word?.endMs ?? 0)) / 2;
    return midpoint >= startMs && midpoint < endMs;
  });
  return inside;
}

export function turnProsody({ samples, sampleRate, startMs = 0, words = [] }) {
  const pcm = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
  if (!(sampleRate > 0)) throw new Error('turnProsody: sampleRate must be positive');
  const { db, frameMs } = frameDb(pcm, sampleRate);
  const { flags } = speechFlags(db);
  const pauses = findPauses(flags, frameMs, startMs);

  let speechFrames = 0;
  const speechDb = [];
  for (let i = 0; i < flags.length; i += 1) {
    if (!flags[i]) continue;
    speechFrames += 1;
    speechDb.push(db[i]);
  }
  const speechMs = Math.round(speechFrames * frameMs);
  const durationMs = Math.round((pcm.length * 1000) / sampleRate);
  const turnWords = wordsInsideTurn(words, startMs, startMs + durationMs);
  const wordsPerMinute = speechMs > 0 ? round((turnWords.length / speechMs) * 60000, 1) : 0;
  speechDb.sort((a, b) => a - b);
  const { pitchMedianHz, pitchRangeSt } = pitchSummary(pcm, sampleRate);

  return {
    speechMs,
    wordsPerMinute,
    pauses,
    pauseCount: pauses.length,
    longestPauseMs: pauses.reduce((longest, pause) => Math.max(longest, pause.endMs - pause.startMs), 0),
    pitchMedianHz,
    pitchRangeSt,
    loudnessDb: speechDb.length ? round(median(speechDb), 1) : SILENCE_DB,
    restarts: countRestarts(tokenise(turnWords)),
    wordCount: turnWords.length,
  };
}

export default turnProsody;
