// Sparse, relative tone note: at most three phrases, only past a threshold.
// No word lists anywhere: every trigger is a measured ratio, delta or count.
export const VOICE_NOTE_THRESHOLDS = Object.freeze({
  rateRatioFast: 1.2,
  rateRatioSlow: 0.8,
  pauseRatio: 1.6,
  dominanceDelta: -0.08,
  arousalDelta: 0.08,
  pitchRangeDeltaSt: -2,
  restartsMin: 3,
  maxPhrases: 3,
});

const PHRASES = Object.freeze({
  faster: 'faster than your usual pace',
  slower: 'slower than your usual pace',
  pauses: 'more long pauses than usual',
  confidence: 'less confident than your usual',
  energy: 'more tense/energetic than usual',
  flat: 'flatter than usual',
  restarts: 'restarted several times',
});

const isNumber = value => typeof value === 'number' && Number.isFinite(value);

// Salience = how far past its threshold the measure sits (1 = exactly at it).
function candidates(relative, thresholds) {
  const found = [];
  const push = (key, salience, measure) => {
    if (isNumber(salience) && Number.isFinite(salience)) found.push({ key, salience, measure });
  };
  const { rateRatio, pauseRatio, pitchRangeDeltaSt, dominanceDelta, arousalDelta, restarts } = relative ?? {};
  if (isNumber(rateRatio)) {
    if (rateRatio >= thresholds.rateRatioFast) push('faster', rateRatio / thresholds.rateRatioFast, rateRatio);
    else if (rateRatio > 0 && rateRatio <= thresholds.rateRatioSlow) push('slower', thresholds.rateRatioSlow / rateRatio, rateRatio);
  }
  if (isNumber(pauseRatio) && pauseRatio >= thresholds.pauseRatio) {
    push('pauses', pauseRatio / thresholds.pauseRatio, pauseRatio);
  }
  if (isNumber(dominanceDelta) && dominanceDelta <= thresholds.dominanceDelta) {
    push('confidence', dominanceDelta / thresholds.dominanceDelta, dominanceDelta);
  }
  if (isNumber(arousalDelta) && arousalDelta >= thresholds.arousalDelta) {
    push('energy', arousalDelta / thresholds.arousalDelta, arousalDelta);
  }
  if (isNumber(pitchRangeDeltaSt) && pitchRangeDeltaSt <= thresholds.pitchRangeDeltaSt) {
    push('flat', pitchRangeDeltaSt / thresholds.pitchRangeDeltaSt, pitchRangeDeltaSt);
  }
  if (isNumber(restarts) && restarts >= thresholds.restartsMin) {
    push('restarts', restarts / thresholds.restartsMin, restarts);
  }
  return found.sort((a, b) => b.salience - a.salience);
}

export function composeVoiceNote(relative, thresholds = VOICE_NOTE_THRESHOLDS) {
  if (!relative || typeof relative !== 'object') return null;
  const limit = Number.isFinite(thresholds.maxPhrases) ? thresholds.maxPhrases : 3;
  const phrases = candidates(relative, thresholds).slice(0, Math.max(0, limit)).map(item => PHRASES[item.key]);
  return phrases.length ? phrases.join('; ') : null;
}

export default composeVoiceNote;
