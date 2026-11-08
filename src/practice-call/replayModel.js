// Pure positioning helpers for the practice call replay view. Times are
// integer ms on the practice helper timeline (see
// docs/interview-practice-call-build.md, "Time base").

const asNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.round(asNumber(ms) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function chapterBounds(chapter, fallbackDurationMs) {
  const startMs = Math.max(0, asNumber(chapter?.startMs));
  const declared = Number(chapter?.endMs);
  const endMs = Number.isFinite(declared) && declared > startMs ? declared : asNumber(fallbackDurationMs, startMs);
  return { startMs, endMs };
}

// Index of the chapter that covers ms, else the closest earlier chapter.
export function chapterAt(chapters, ms) {
  const list = Array.isArray(chapters) ? chapters : [];
  const at = asNumber(ms);
  let preceding = -1;
  for (let index = 0; index < list.length; index += 1) {
    const { startMs, endMs } = chapterBounds(list[index], list[index]?.endMs);
    if (at >= startMs && at < endMs) return index;
    if (startMs <= at) preceding = index;
  }
  return preceding;
}

// One block per chapter, positioned as percentages of the whole recording.
export function segmentStyles(chapters, durationMs) {
  const total = asNumber(durationMs);
  if (!(total > 0)) return [];
  const list = Array.isArray(chapters) ? chapters : [];
  return list.map((chapter, index) => {
    const startMs = Math.min(Math.max(0, asNumber(chapter?.startMs)), total);
    const declaredEnd = Number(chapter?.endMs);
    const endMs = Number.isFinite(declaredEnd) && declaredEnd > startMs ? Math.min(declaredEnd, total) : startMs;
    return {
      index,
      title: String(chapter?.title || `Chapter ${index + 1}`),
      startMs,
      endMs,
      leftPct: (startMs / total) * 100,
      widthPct: ((endMs - startMs) / total) * 100,
      markers: Array.isArray(chapter?.markers) ? chapter.markers : [],
    };
  });
}

// Index of the transcript turn that contains ms (final turn stays current
// until the end of the recording) or -1 when nothing covers it.
export function turnAt(transcript, ms) {
  const list = Array.isArray(transcript) ? transcript : [];
  const at = asNumber(ms);
  let current = -1;
  for (let index = 0; index < list.length; index += 1) {
    const startMs = list[index]?.startMs;
    if (typeof startMs !== "number" || !Number.isFinite(startMs)) continue;
    if (startMs > at) break;
    current = index;
  }
  return current;
}

export const MARKER_TONES = Object.freeze({
  tone: 'bg-sky-300/80',
  pause: 'bg-amber-300/80',
  interruption: 'bg-rose-300/80',
  filler: 'bg-fuchsia-300/80',
  moment: 'bg-emerald-300/80',
  chat: 'bg-violet-300/80',
});

export const markerTone = kind => MARKER_TONES[kind] || 'bg-white/40';
