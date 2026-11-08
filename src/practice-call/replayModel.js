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

// ---------------------------------------------------------------------------
// Chaptered seek bar geometry. Everything here is pure so the scrubber's
// behaviour can be unit-tested without a DOM.

const clampMsValue = (value, durationMs) => {
  const total = Math.max(0, asNumber(durationMs));
  return Math.min(Math.max(0, asNumber(value)), total);
};

// Pointer x (px, relative to the bar) as a clamped timeline position.
export function positionToMs(x, width, durationMs) {
  const barWidth = asNumber(width);
  const total = asNumber(durationMs);
  if (!(barWidth > 0) || !(total > 0)) return 0;
  const fraction = asNumber(x) / barWidth;
  return Math.min(Math.max(0, fraction * total), total);
}

function chapterEndMs(list, index, startMs) {
  const next = list[index + 1];
  const nextStart = next ? Math.max(startMs, asNumber(next?.startMs)) : Infinity;
  const declared = Number(list[index]?.endMs);
  const declaredEnd = Number.isFinite(declared) && declared > startMs ? declared : Infinity;
  return Math.min(nextStart, declaredEnd);
}

// Index of the chapter covering ms, or -1 when no chapter does.
export function chapterIndexAt(chapters, ms) {
  const list = Array.isArray(chapters) ? chapters : [];
  const at = asNumber(ms);
  for (let index = 0; index < list.length; index += 1) {
    const startMs = Math.max(0, asNumber(list[index]?.startMs));
    if (at < startMs) return -1;
    if (at < chapterEndMs(list, index, startMs)) return index;
  }
  return -1;
}

// Segment geometry as percentages of the whole recording.
export function segmentLayout(chapters, durationMs) {
  const total = asNumber(durationMs);
  const list = Array.isArray(chapters) ? chapters : [];
  if (!(total > 0) || !list.length) return [];
  return list.map((chapter, index) => {
    const startMs = Math.min(Math.max(0, asNumber(chapter?.startMs)), total);
    const next = list[index + 1];
    const nextStart = next ? Math.min(total, Math.max(startMs, asNumber(next?.startMs))) : total;
    const declared = Number(chapter?.endMs);
    const declaredEnd = Number.isFinite(declared) && declared > startMs ? Math.min(declared, total) : nextStart;
    const endMs = Math.max(startMs, Math.min(declaredEnd, nextStart));
    return {
      index,
      title: String(chapter?.title || `Chapter ${index + 1}`),
      startMs,
      endMs,
      leftPct: (startMs / total) * 100,
      widthPct: ((endMs - startMs) / total) * 100,
    };
  });
}

// Played fraction (0..1) of one segment at ms.
export function segmentFill(segment, ms) {
  const startMs = asNumber(segment?.startMs);
  const endMs = asNumber(segment?.endMs, startMs);
  if (!(endMs > startMs)) return 0;
  const at = asNumber(ms);
  if (at <= startMs) return 0;
  if (at >= endMs) return 1;
  return (at - startMs) / (endMs - startMs);
}

// Left offset (px) for a bubble centred on x and kept inside the bar.
export function bubbleLeftPx(x, barWidth, bubbleWidth) {
  const bar = asNumber(barWidth);
  const bubble = asNumber(bubbleWidth);
  if (!(bar > 0) || !(bubble > 0)) return 0;
  const room = bar - bubble;
  if (!(room > 0)) return 0;
  return Math.min(Math.max(0, asNumber(x) - bubble / 2), room);
}

// Closest marker tick within maxPx of ms, else null.
export function nearestMarker(markers, ms, durationMs, barWidth, maxPx = 6) {
  const list = Array.isArray(markers) ? markers : [];
  const total = asNumber(durationMs);
  const width = asNumber(barWidth);
  if (!list.length || !(total > 0) || !(width > 0)) return null;
  const at = asNumber(ms);
  let best = null;
  let bestPx = Infinity;
  list.forEach((marker, index) => {
    const raw = Number(marker?.atMs);
    if (!Number.isFinite(raw)) return;
    const markerMs = Math.min(Math.max(0, raw), total);
    const distancePx = (Math.abs(markerMs - at) / total) * width;
    if (distancePx < bestPx) {
      bestPx = distancePx;
      best = { ...marker, atMs: markerMs, index, label: String(marker?.label || marker?.kind || 'Moment') };
    }
  });
  if (!best) return null;
  return bestPx <= Math.max(0, asNumber(maxPx, 6)) ? best : null;
}

// 'Previous track': restarting the current chapter, or skipping back one when
// we are barely into it.
export function prevChapterStart(chapters, ms, graceMs = 1000) {
  const list = Array.isArray(chapters) ? chapters : [];
  const at = asNumber(ms);
  const grace = Math.max(0, asNumber(graceMs, 1000));
  let index = -1;
  for (let position = 0; position < list.length; position += 1) {
    if (Math.max(0, asNumber(list[position]?.startMs)) > at) break;
    index = position;
  }
  if (index < 0) return 0;
  const startMs = Math.max(0, asNumber(list[index]?.startMs));
  if (at - startMs > grace) return startMs;
  return index > 0 ? Math.max(0, asNumber(list[index - 1]?.startMs)) : 0;
}

// Start of the following chapter, or the end of the recording.
export function nextChapterStart(chapters, ms, durationMs) {
  const list = Array.isArray(chapters) ? chapters : [];
  const at = asNumber(ms);
  for (let index = 0; index < list.length; index += 1) {
    const startMs = Math.max(0, asNumber(list[index]?.startMs));
    if (startMs > at) return startMs;
  }
  return Math.max(0, asNumber(durationMs));
}

// Keyboard target for the focused slider, or null for a key we do not handle.
export function scrubberKeyTarget(key, modifiers, ms, durationMs, chapters) {
  const total = Math.max(0, asNumber(durationMs));
  const at = clampMsValue(ms, total);
  const list = Array.isArray(chapters) ? chapters : [];
  const altKey = Boolean(modifiers && modifiers.altKey);
  let target;
  switch (key) {
    case 'ArrowLeft': target = altKey ? prevChapterStart(list, at) : at - 5000; break;
    case 'ArrowRight': target = altKey ? nextChapterStart(list, at, total) : at + 5000; break;
    case 'j': case 'J': target = at - 10000; break;
    case 'l': case 'L': target = at + 10000; break;
    case 'Home': target = 0; break;
    case 'End': target = total; break;
    case 'PageUp': target = prevChapterStart(list, at); break;
    case 'PageDown': target = nextChapterStart(list, at, total); break;
    default: return null;
  }
  return clampMsValue(target, total);
}
