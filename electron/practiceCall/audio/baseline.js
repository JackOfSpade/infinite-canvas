// Candidate voice baseline: median prosody over the user's own turns.
// Pure: accumulates numbers, never touches the filesystem.
const round = (value, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finiteOrNull(value) { return Number.isFinite(value) ? value : null; }

export function createVoiceBaseline({ minSpeechMs = 20000 } = {}) {
  const speech = [];
  const tones = [];
  let sampledSpeechMs = 0;

  const medians = () => ({
    turns: speech.length,
    speechMs: median(speech.map(turn => turn.speechMs)),
    wordsPerMinute: median(speech.map(turn => turn.wordsPerMinute)),
    pauseCount: median(speech.map(turn => turn.pauseCount)),
    longestPauseMs: median(speech.map(turn => turn.longestPauseMs)),
    pitchMedianHz: median(speech.map(turn => turn.pitchMedianHz)),
    pitchRangeSt: median(speech.map(turn => turn.pitchRangeSt)),
    loudnessDb: median(speech.map(turn => turn.loudnessDb)),
    arousal: median(tones.map(tone => tone.arousal)),
    dominance: median(tones.map(tone => tone.dominance)),
    valence: median(tones.map(tone => tone.valence)),
  });

  const ready = () => speech.length > 0 && sampledSpeechMs >= minSpeechMs;

  return {
    add(prosody, tone) {
      if (!prosody || typeof prosody !== 'object') return;
      speech.push({
        speechMs: finiteOrNull(prosody.speechMs) ?? 0,
        wordsPerMinute: finiteOrNull(prosody.wordsPerMinute),
        pauseCount: finiteOrNull(prosody.pauseCount) ?? 0,
        longestPauseMs: finiteOrNull(prosody.longestPauseMs) ?? 0,
        pitchMedianHz: finiteOrNull(prosody.pitchMedianHz),
        pitchRangeSt: finiteOrNull(prosody.pitchRangeSt),
        loudnessDb: finiteOrNull(prosody.loudnessDb),
      });
      sampledSpeechMs += finiteOrNull(prosody.speechMs) ?? 0;
      if (tone && ['arousal', 'dominance', 'valence'].some(key => Number.isFinite(tone[key]))) tones.push(tone);
    },
    ready,
    minSpeechMs,
    speechMs() { return sampledSpeechMs; },
    snapshot() { return speech.length ? medians() : null; },
    relative(prosody, tone) {
      const empty = {
        rateRatio: null, pauseRatio: null, pitchRangeDeltaSt: null, loudnessDeltaDb: null,
        arousalDelta: null, dominanceDelta: null, valenceDelta: null, restarts: null,
      };
      if (!ready() || !prosody) return empty;
      const base = medians();
      const rateRatio = Number.isFinite(prosody.wordsPerMinute) && base.wordsPerMinute > 0
        ? round(prosody.wordsPerMinute / base.wordsPerMinute, 3) : null;
      // Smoothed count ratio keeps zero-pause baselines finite.
      const pauseRatio = Number.isFinite(prosody.pauseCount)
        ? round((1 + prosody.pauseCount) / (1 + base.pauseCount), 3) : null;
      const pitchRangeDeltaSt = Number.isFinite(prosody.pitchRangeSt) && base.pitchRangeSt !== null
        ? round(prosody.pitchRangeSt - base.pitchRangeSt, 2) : null;
      const loudnessDeltaDb = Number.isFinite(prosody.loudnessDb) && base.loudnessDb !== null
        ? round(prosody.loudnessDb - base.loudnessDb, 2) : null;
      const toneDelta = key => (tone && Number.isFinite(tone[key]) && base[key] !== null)
        ? round(tone[key] - base[key], 3) : null;
      return {
        rateRatio,
        pauseRatio,
        pitchRangeDeltaSt,
        loudnessDeltaDb,
        arousalDelta: toneDelta('arousal'),
        dominanceDelta: toneDelta('dominance'),
        valenceDelta: toneDelta('valence'),
        restarts: Number.isFinite(prosody.restarts) ? prosody.restarts : null,
      };
    },
  };
}

export default createVoiceBaseline;
