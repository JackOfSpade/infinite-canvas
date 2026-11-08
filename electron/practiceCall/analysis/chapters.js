/**
 * Timeline chapters and markers for a finished practice call. Pure: transcript,
 * review anchors and metrics in, chapters out. No clock, no I/O, no word lists.
 *
 * Chapter shape matches analysis.json exactly:
 * { title, startMs, endMs, questionTurnIndex, markers: [{ atMs, kind, label }] }.
 *
 * Metrics are read defensively because callMetrics.js owns their exact shape:
 * pauses come from `pauses`, `longPauses` or `answers[].pauses`, and
 * interruptions from `interruptions`, `candidateInterruptions` or per-answer
 * lists. Each entry may be `{ startMs, endMs }` or `{ atMs, durationMs }`.
 */

const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const ms = value => number(value);
const list = value => (Array.isArray(value) ? value : []);
const label = value => (typeof value === 'string' ? value.trim() : '');
const isInterviewer = turn => turn?.speaker === 'interviewer';
const arrays = (metrics, keys) => keys.flatMap(key => list(metrics?.[key]));
const answerArrays = (metrics, key) => list(metrics?.answers).flatMap(answer => list(answer?.[key]));

function pauseMarkers(candidateProsodyByTurn) {
  const seen = new Set();
  const markers = [];
  for (const turn of Object.values(candidateProsodyByTurn ?? {})) {
    for (const entry of list(turn?.pauses)) {
      const startMs = ms(entry?.startMs);
      const endMs = ms(entry?.endMs);
      if (startMs === null || endMs === null || endMs - startMs < 2000) continue;
      const key = "pause:" + startMs;
      if (seen.has(key)) continue;
      seen.add(key);
      markers.push({ atMs: startMs, kind: "pause", label: "Long pause " + ((endMs - startMs) / 1000).toFixed(1) + "s" });
    }
  }
  return markers;
}

function interruptionMarkers(metrics) {
  const entries = [...arrays(metrics, ['interruptions', 'candidateInterruptions']), ...answerArrays(metrics, 'interruptions')];
  return entries.map(entry => {
    const atMs = ms(entry?.atMs) ?? ms(entry?.startMs);
    if (atMs === null) return null;
    const text = entry?.beforeQuestionFinished === false ? 'Talked over the interviewer' : 'Cut in before the question finished';
    return { atMs, kind: 'interruption', label: text };
  }).filter(Boolean);
}

/** The interview's farewell is the last interviewer turn after the last question. */
function closingIndex(transcript, questionIndices) {
  const lastQuestion = questionIndices.length ? Math.max(...questionIndices) : -1;
  for (let index = transcript.length - 1; index > lastQuestion; index -= 1) {
    if (isInterviewer(transcript[index])) return index;
  }
  return -1;
}

function chapterFor(chapters, atMs) {
  const containing = chapters.find(chapter => chapter.startMs <= atMs && atMs < chapter.endMs);
  if (containing) return containing;
  const last = chapters[chapters.length - 1] ?? null;
  return last && atMs >= last.endMs ? last : null;
}

export function buildChapters({ transcript = [], reviewChapters = [], moments = [], metrics = {}, toneNotes = [], candidateProsodyByTurn = {}, durationMs = 0 } = {}) {
  const turns = list(transcript);
  const total = ms(durationMs) ?? turns.reduce((max, turn) => Math.max(max, ms(turn?.endMs) ?? 0), 0);
  const anchors = [];
  const seenQuestions = new Set();
  for (const entry of list(reviewChapters)) {
    const index = number(entry?.questionTurnIndex);
    if (index === null || !Number.isInteger(index) || index < 0 || index >= turns.length) continue;
    if (!isInterviewer(turns[index]) || seenQuestions.has(index)) continue;
    seenQuestions.add(index);
    anchors.push({ index, startMs: ms(turns[index].startMs) ?? 0, title: label(entry?.title) || 'Interviewer question' });
  }
  anchors.sort((left, right) => left.startMs - right.startMs);
  const closing = closingIndex(turns, anchors.map(anchor => anchor.index));
  const closingStart = closing >= 0 ? ms(turns[closing].startMs) ?? total : total;

  const chapters = [];
  const firstQuestion = anchors[0]?.startMs ?? closingStart;
  if (firstQuestion > 0) chapters.push({ title: 'Opening', questionTurnIndex: null, startMs: 0, endMs: firstQuestion, markers: [] });
  anchors.forEach((anchor, position) => {
    const next = anchors[position + 1]?.startMs ?? closingStart;
    chapters.push({ title: anchor.title, questionTurnIndex: anchor.index, startMs: anchor.startMs, endMs: Math.max(anchor.startMs, next), markers: [] });
  });
  if (closing >= 0 && closingStart > (anchors.at(-1)?.startMs ?? 0)) {
    chapters.push({ title: 'Closing', questionTurnIndex: null, startMs: closingStart, endMs: Math.max(closingStart, total), markers: [] });
  }
  if (!chapters.length) chapters.push({ title: 'Call', questionTurnIndex: null, startMs: 0, endMs: total, markers: [] });
  chapters.forEach((chapter, position) => { chapter.endMs = Math.min(chapter.endMs, chapters[position + 1]?.startMs ?? Math.max(chapter.endMs, total)); });

  const markers = [
    ...pauseMarkers(candidateProsodyByTurn),
    ...interruptionMarkers(metrics),
    ...list(metrics?.fillerMoments).map(entry => ({ atMs: ms(entry?.atMs), kind: 'filler', label: label(entry?.label) || 'Filler' })),
    ...list(toneNotes).map(note => ({ atMs: ms(note?.atMs), kind: 'tone', label: label(note?.note) || 'Tone note' })),
    ...list(moments).map(moment => {
      const turn = turns[number(moment?.turnIndex)] ?? null;
      return { atMs: turn ? ms(turn.startMs) : null, kind: moment?.kind === 'filler' ? 'filler' : 'moment', label: label(moment?.label) || 'Flagged moment' };
    }),
    ...turns.filter(turn => turn?.channel === 'chat').map(turn => ({
      atMs: ms(turn.startMs),
      kind: 'chat',
      label: `${turn.speaker === 'candidate' ? 'Candidate' : 'Interviewer'} typed: ${label(turn.text).slice(0, 120)}`,
    })),
  ].filter(marker => marker.atMs !== null).map(marker => ({ ...marker, atMs: Math.max(0, Math.min(marker.atMs, total)) })).sort((left, right) => left.atMs - right.atMs);

  for (const marker of markers) chapterFor(chapters, marker.atMs)?.markers.push(marker);
  return chapters.filter(chapter => chapter.endMs > chapter.startMs || chapter.markers.length > 0);
}
