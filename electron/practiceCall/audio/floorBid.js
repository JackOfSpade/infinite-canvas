// FLOOR BID: should the interviewer keep the floor while the candidate makes a
// small backchannel noise, or pause because they have taken a real turn?
// Pure acoustics plus counts: no vocabulary, no state beyond the baseline.
export const FLOOR_BID_THRESHOLDS = Object.freeze({
  quietBelowBaselineDb: 8,
  absoluteQuietDb: -38,
  shortMs: 300,
  onsetWindowMs: 120,
  onsetFrameMs: 20,
  onsetSharpDb: 12,
  maxWords: 1,
});

const SILENCE_DB = -120;
const ONSET_FLOOR_DB = -55;

const dbOf = rms => (rms > 0 ? 20 * Math.log10(rms) : SILENCE_DB);

function frameSeries(samples, sampleRate, frameMs, maxFrames = Infinity) {
  const size = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const count = Math.min(maxFrames, Math.floor(samples.length / size));
  const out = [];
  for (let frame = 0; frame < count; frame += 1) {
    let sum = 0;
    for (let i = 0; i < size; i += 1) {
      const value = samples[frame * size + i];
      sum += value * value;
    }
    out.push(dbOf(Math.sqrt(sum / size)));
  }
  return out;
}

function medianDb(frames) {
  const active = frames.filter(db => db > -60).sort((a, b) => a - b);
  const pool = active.length ? active : frames.slice().sort((a, b) => a - b);
  if (!pool.length) return SILENCE_DB;
  const middle = Math.floor(pool.length / 2);
  return pool.length % 2 ? pool[middle] : (pool[middle - 1] + pool[middle]) / 2;
}

function onsetRiseDb(samples, sampleRate, thresholds) {
  const frameMs = thresholds.onsetFrameMs ?? 20;
  const maxFrames = Math.max(2, Math.ceil((thresholds.onsetWindowMs ?? 120) / frameMs));
  const frames = frameSeries(samples, sampleRate, frameMs, maxFrames)
    .map(db => Math.max(ONSET_FLOOR_DB, db));
  if (frames.length < 2) return 0;
  return Math.max(...frames) - Math.min(...frames);
}

export function createFloorBidDetector({ baseline = null, thresholds = FLOOR_BID_THRESHOLDS } = {}) {
  const quietThreshold = () => {
    const snapshot = typeof baseline?.ready === 'function' && baseline.ready() ? baseline.snapshot() : null;
    const speechDb = snapshot && Number.isFinite(snapshot.loudnessDb) ? snapshot.loudnessDb : null;
    const quietDb = speechDb !== null ? speechDb - thresholds.quietBelowBaselineDb : thresholds.absoluteQuietDb;
    return { quietDb, reference: speechDb !== null ? 'baseline' : 'absolute' };
  };

  return {
    assess({ samples, sampleRate, overlapMs = 0, wordCount = 0 } = {}) {
      const pcm = samples instanceof Float32Array ? samples : Float32Array.from(samples ?? []);
      if (!(sampleRate > 0)) throw new Error('floorBid: sampleRate must be positive');
      const { quietDb, reference } = quietThreshold();
      const loudnessDb = Math.round(medianDb(frameSeries(pcm, sampleRate, 20)) * 10) / 10;
      const onsetRise = Math.round(onsetRiseDb(pcm, sampleRate, thresholds) * 10) / 10;
      const durationMs = Math.round((pcm.length * 1000) / sampleRate);
      const features = {
        loudnessDb,
        quietDb: Math.round(quietDb * 10) / 10,
        quietReference: reference,
        overlapMs,
        durationMs,
        onsetRiseDb: onsetRise,
        wordCount,
      };
      const reasons = [];
      if (!(loudnessDb < quietDb)) reasons.push('loud');
      if (!(overlapMs < thresholds.shortMs)) reasons.push('long');
      if (onsetRise > thresholds.onsetSharpDb) reasons.push('sharp-onset');
      if (!(wordCount <= thresholds.maxWords)) reasons.push('words');
      return reasons.length
        ? { decision: 'pause', reason: reasons.join('+'), features }
        : { decision: 'continue', reason: 'quiet-short-overlap', features };
    },
  };
}

export default createFloorBidDetector;
