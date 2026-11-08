// Post-call deterministic metrics from the timed transcript. Pure: no I/O,
// no word lists; only counts, durations and prosody numbers already measured.
const round = (value, digits = 1) => {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
const finite = value => typeof value === 'number' && Number.isFinite(value);
const median = values => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function countWords(text) {
  return String(text ?? '').split(/\s+/)
    .map(piece => piece.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean).length;
}

function prosodyFor(source, index) {
  if (!source) return [];
  if (source instanceof Map) return [source.get(index)].flat().filter(Boolean);
  if (Array.isArray(source)) return [source[index]].flat().filter(Boolean);
  return [source[index]].flat().filter(Boolean);
}

// Uniform word positions across the answer; deterministic without Scribe words.
function wordPositions(wordCount, startMs, endMs) {
  const duration = Math.max(1, endMs - startMs);
  const positions = [];
  for (let i = 0; i < wordCount; i += 1) positions.push(startMs + ((i + 0.5) * duration) / wordCount);
  return positions;
}

function fastestWindowWpm(wordCount, startMs, endMs, windowMs = 20000) {
  const duration = endMs - startMs;
  if (wordCount <= 0 || !(duration > 0)) return 0;
  if (duration <= windowMs) return round((wordCount / duration) * 60000, 1);
  const positions = wordPositions(wordCount, startMs, endMs);
  let best = 0;
  let end = 0;
  for (let start = 0; start < positions.length; start += 1) {
    if (end < start) end = start;
    while (end < positions.length && positions[end] - positions[start] < windowMs) end += 1;
    best = Math.max(best, end - start);
  }
  return round((best / windowMs) * 60000, 1);
}

function interviewerRuns(entries) {
  // Contiguous interviewer entries are one question; the run end is when it finished.
  const runs = [];
  let current = null;
  entries.forEach((entry, index) => {
    if (entry.speaker !== 'interviewer') return;
    if (!current || current.lastIndex !== index - 1) {
      current = { firstIndex: index, lastIndex: index, startMs: entry.startMs, endMs: entry.endMs };
      runs.push(current);
    } else {
      current.lastIndex = index;
      current.startMs = Math.min(current.startMs, entry.startMs);
      current.endMs = Math.max(current.endMs, entry.endMs);
    }
  });
  return runs;
}

export function callMetrics({ transcript = [], candidateProsodyByTurn = null, baselineSnapshot = null } = {}) {
  const entries = Array.isArray(transcript) ? transcript : [];
  const groups = [];
  const typedAnswers = [];
  let group = null;
  entries.forEach((entry, index) => {
    if (entry?.channel === 'chat') {
      typedAnswers.push({ startMs: entry.startMs, endMs: entry.endMs, wordCount: countWords(entry.text), text: String(entry.text ?? '') });
      return;
    }
    if (entry?.speaker === 'interviewer') { group = null; return; }
    if (entry?.speaker !== 'candidate') { group = null; return; }
    if (!group) { group = { turnIndexes: [], startMs: entry.startMs, endMs: entry.endMs, words: 0 }; groups.push(group); }
    group.turnIndexes.push(index);
    group.startMs = Math.min(group.startMs, entry.startMs);
    group.endMs = Math.max(group.endMs, entry.endMs);
    group.words += countWords(entry.text);
  });

  const answers = groups.map((answer, answerIndex) => {
    const prosody = answer.turnIndexes.flatMap(index => prosodyFor(candidateProsodyByTurn, index));
    const pauses = prosody.flatMap(item => item.pauses ?? []);
    const speechMs = prosody.reduce((sum, item) => sum + (finite(item.speechMs) ? item.speechMs : 0), 0);
    const durationMs = Math.max(0, answer.endMs - answer.startMs);
    const pitchRangeSt = median(prosody.map(item => item.pitchRangeSt));
    const prior = answer.turnIndexes[0] - 1;
    let responseLatencyMs = null;
    for (let i = prior; i >= 0; i -= 1) {
      if (entries[i]?.speaker === 'interviewer') { responseLatencyMs = Math.max(0, answer.startMs - entries[i].endMs); break; }
    }
    return {
      index: answerIndex,
      turnIndexes: answer.turnIndexes.slice(),
      startMs: answer.startMs,
      endMs: answer.endMs,
      durationMs,
      wordCount: answer.words,
      speechMs,
      wordsPerMinute: round(speechMs > 0 ? (answer.words / speechMs) * 60000 : (durationMs > 0 ? (answer.words / durationMs) * 60000 : 0), 1),
      fastest20sWindowWpm: fastestWindowWpm(answer.words, answer.startMs, answer.endMs),
      pauseCount: pauses.length,
      pausesOver1s: pauses.filter(pause => pause.endMs - pause.startMs > 1000).length,
      pausesOver2s: pauses.filter(pause => pause.endMs - pause.startMs > 2000).length,
      longestPauseMs: pauses.reduce((longest, pause) => Math.max(longest, pause.endMs - pause.startMs), 0),
      responseLatencyMs,
      longAnswer: durationMs > 120000,
      pitchRangeSt,
      pitchRangeDeltaSt: finite(pitchRangeSt) && finite(baselineSnapshot?.pitchRangeSt) ? round(pitchRangeSt - baselineSnapshot.pitchRangeSt, 2) : null,
      loudnessDeltaDb: finite(median(prosody.map(item => item.loudnessDb))) && finite(baselineSnapshot?.loudnessDb)
        ? round(median(prosody.map(item => item.loudnessDb)) - baselineSnapshot.loudnessDb, 2) : null,
    };
  });

  const runs = interviewerRuns(entries);
  const candidateInterruptions = [];
  entries.forEach((entry, index) => {
    if (entry?.speaker !== 'candidate' || entry.channel === 'chat' || entry.acknowledgement) return;
    const run = runs.find(item => entry.startMs > item.startMs && entry.startMs < item.endMs);
    if (!run) return;
    candidateInterruptions.push({
      turnIndex: index,
      atMs: entry.startMs,
      interviewerFirstIndex: run.firstIndex,
      interviewerEndMs: run.endMs,
      overlapMs: Math.max(0, run.endMs - entry.startMs),
      beforeQuestionFinished: entry.startMs < run.endMs,
    });
  });

  const candidateTalkMs = answers.reduce((sum, answer) => sum + (answer.speechMs > 0 ? answer.speechMs : answer.durationMs), 0);
  const interviewerTalkMs = entries.filter(entry => entry.speaker === 'interviewer')
    .reduce((sum, entry) => sum + Math.max(0, (entry.endMs ?? 0) - (entry.startMs ?? 0)), 0);
  const totalTalkMs = candidateTalkMs + interviewerTalkMs;

  return {
    answers,
    typedAnswers,
    answerCount: answers.length,
    typedAnswerCount: typedAnswers.length,
    candidateTalkMs,
    interviewerTalkMs,
    talkRatio: totalTalkMs > 0 ? round(candidateTalkMs / totalTalkMs, 3) : 0,
    candidateInterruptions,
    interruptionCount: candidateInterruptions.length,
    responseLatencyMs: median(answers.map(answer => answer.responseLatencyMs)),
    longAnswerCount: answers.filter(answer => answer.longAnswer).length,
    pausesOver1s: answers.reduce((sum, answer) => sum + answer.pausesOver1s, 0),
    pausesOver2s: answers.reduce((sum, answer) => sum + answer.pausesOver2s, 0),
    fastest20sWindowWpm: answers.reduce((best, answer) => Math.max(best, answer.fastest20sWindowWpm), 0),
  };
}

export default callMetrics;
