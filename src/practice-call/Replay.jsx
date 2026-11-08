import React, { useRef, useState } from 'react';
import { AlertTriangle, Pause, Play, Trash2 } from 'lucide-react';
import { FeedbackView } from '../components/InterviewPracticePanel.jsx';
import { bubbleLeftPx, chapterIndexAt, formatTime, markerTone, nearestMarker, positionToMs, scrubberKeyTarget, segmentFill, segmentLayout, turnAt } from './replayModel.js';
import { describeDeliveryValue, humanizeKey } from './callModel.js';

export function DeliverySection({ delivery }) {
  const entries = delivery && typeof delivery === 'object' && !Array.isArray(delivery)
    ? Object.entries(delivery).map(([key, value]) => [key, describeDeliveryValue(value)]).filter(([, text]) => text)
    : [];
  if (!entries.length) return null;
  return <section aria-label="Delivery" className="rounded-md border border-white/10 bg-black/20 p-2">
    <p className="text-[10px] font-semibold uppercase text-white/45">Delivery</p>
    <ul className="mt-1 space-y-0.5">{entries.map(([key, text]) => <li key={key} className="text-[11px] text-white/75"><span className="capitalize text-violet-200">{humanizeKey(key)}</span>: {text}</li>)}</ul>
  </section>;
}

// Width used for the hover bubble until it has been measured in the DOM.
const BUBBLE_ESTIMATE_PX = 96;

// Every moment marker on the timeline, with the pixel geometry the bar needs.
function chapterMarkers(chapters, durationMs) {
  const ticks = [];
  (Array.isArray(chapters) ? chapters : []).forEach((chapter, chapterIndex) => {
    const markers = Array.isArray(chapter?.markers) ? chapter.markers : [];
    markers.forEach((marker, markerIndex) => {
      const raw = Number(marker?.atMs);
      if (!Number.isFinite(raw)) return;
      const atMs = durationMs > 0 ? Math.min(Math.max(0, raw), durationMs) : Math.max(0, raw);
      ticks.push({
        key: `${chapterIndex}-${markerIndex}`,
        kind: marker?.kind,
        label: String(marker?.label || marker?.kind || 'Moment'),
        atMs,
        leftPct: durationMs > 0 ? (atMs / durationMs) * 100 : 0,
      });
    });
  });
  return ticks;
}

// Chaptered seek bar: a 5px rail that grows under the pointer, a chapter bubble
// that replaces native tooltips, and one committed seek per pointer gesture.
export function Scrubber({ chapters, durationMs, positionMs, onSeek }) {
  const total = Math.max(0, Number(durationMs) || 0);
  const chapterList = Array.isArray(chapters) ? chapters : [];
  const layout = segmentLayout(chapterList, total);
  const segments = layout.length ? layout : [{ index: 0, title: '', startMs: 0, endMs: total, leftPct: 0, widthPct: 100 }];
  const markers = chapterMarkers(chapterList, total);
  const [pointer, setPointer] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [dragMs, setDragMs] = useState(0);
  const [touchMode, setTouchMode] = useState(false);
  const [bubbleWidth, setBubbleWidth] = useState(0);
  const bubbleRef = useRef(null);

  const displayMs = dragging ? dragMs : Math.min(Math.max(0, Number(positionMs) || 0), total);
  const percent = total > 0 ? Math.min(100, Math.max(0, (displayMs / total) * 100)) : 0;
  const currentIndex = chapterIndexAt(chapterList, total > 0 ? Math.min(displayMs, total - 1) : displayMs);
  const currentTitle = currentIndex >= 0 ? String(chapterList[currentIndex]?.title || `Chapter ${currentIndex + 1}`) : '';
  const pointerMs = pointer && total > 0 ? positionToMs(pointer.x, pointer.width, total) : null;
  const hoverMs = pointerMs === null ? null : Math.min(pointerMs, Math.max(0, total - 1));
  const hoverIndex = hoverMs === null ? -1 : chapterIndexAt(chapterList, hoverMs);
  const hoverTitle = hoverIndex >= 0 ? String(chapterList[hoverIndex]?.title || `Chapter ${hoverIndex + 1}`) : '';
  const active = Boolean(pointer) || dragging;
  const markerHint = pointerMs === null ? null : nearestMarker(markers, pointerMs, total, pointer.width);
  const bubbleTitle = markerHint ? markerHint.label : hoverTitle;
  const bubbleMs = markerHint ? markerHint.atMs : pointerMs;
  const bubblePx = pointer ? Math.min(pointer.width, bubbleWidth > 0 ? bubbleWidth : BUBBLE_ESTIMATE_PX) : 0;
  const bubbleLeft = pointer ? bubbleLeftPx(pointer.x, pointer.width, bubblePx) : 0;

  const readPointer = event => {
    const rect = event.currentTarget.getBoundingClientRect?.();
    const width = rect && rect.width > 0 ? rect.width : 0;
    if (!(width > 0)) return null;
    return { x: Math.min(Math.max(0, Number(event.clientX) - rect.left), width), width };
  };
  const previewAt = next => positionToMs(next.x, next.width, total);
  const onPointerDown = event => {
    if (event.pointerType === 'touch') setTouchMode(true);
    const next = readPointer(event);
    if (!next || !(total > 0)) return;
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* capture is best effort */ }
    setPointer(next);
    setDragMs(previewAt(next));
    setDragging(true);
  };
  const onPointerMove = event => {
    if (event.pointerType === 'touch') setTouchMode(true);
    const next = readPointer(event);
    if (!next) return;
    setPointer(next);
    if (dragging) setDragMs(previewAt(next));
    const measured = bubbleRef.current?.offsetWidth;
    if (measured > 0 && measured !== bubbleWidth) setBubbleWidth(measured);
  };
  const finishDrag = event => {
    if (event.pointerType === 'touch') setTouchMode(true);
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
    if (!dragging) return;
    const next = event.type === 'pointercancel' ? null : readPointer(event);
    const target = next ? previewAt(next) : dragMs;
    setDragging(false);
    setPointer(event.pointerType === 'mouse' && next ? next : null);
    onSeek(Math.min(Math.max(0, target), total));
  };
  const onPointerLeave = () => { if (!dragging) setPointer(null); };
  const onKeyDown = event => {
    const target = scrubberKeyTarget(event.key, { altKey: event.altKey }, displayMs, total, chapterList);
    if (target === null) return;
    event.preventDefault();
    onSeek(target);
  };

  return <div role="slider" tabIndex={0} aria-label="Replay position" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(displayMs)}
    aria-valuetext={`${formatTime(displayMs)} of ${formatTime(total)}${currentTitle ? `, ${currentTitle}` : ''}`} data-scrubber="true"
    onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finishDrag} onPointerCancel={finishDrag} onPointerLeave={onPointerLeave}
    style={{ paddingTop: touchMode ? 17 : 6, paddingBottom: touchMode ? 17 : 6 }}
    className="relative w-full cursor-pointer touch-none select-none rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-300">
    <div className="relative h-[5px] w-full">
      {segments.map((segment, position) => {
        const fill = segmentFill(segment, displayMs);
        const reach = hoverMs === null ? fill : segmentFill(segment, hoverMs);
        // With no chapters the single fallback segment is the whole bar, so it grows whenever the bar is active.
        const grown = active && (layout.length === 0 || segment.index === hoverIndex);
        const scaleY = active ? (grown ? 1.8 : 1) : 0.6;
        const last = position === segments.length - 1;
        return <div key={`segment-${segment.index}`} data-chapter={segment.index}
          className="absolute bottom-0 h-[5px] origin-bottom transition-transform duration-100 ease-out"
          style={{ left: `${segment.leftPct}%`, width: last ? `${segment.widthPct}%` : `calc(${segment.widthPct}% - 2px)`, transform: `scaleY(${scaleY})` }}>
          <div aria-hidden="true" className="absolute inset-0 bg-white/20" />
          <div aria-hidden="true" className="absolute inset-y-0 left-0 bg-violet-400" style={{ width: `${fill * 100}%` }} />
          {reach > fill && <div aria-hidden="true" className="absolute inset-y-0 bg-white/40" style={{ left: `${fill * 100}%`, width: `${(reach - fill) * 100}%` }} />}
        </div>;
      })}
      {markers.map(marker => <span key={`marker-${marker.key}`} aria-hidden="true" data-marker-kind={marker.kind}
        className={`absolute bottom-[5px] h-1 w-0.5 ${markerTone(marker.kind)}`} style={{ left: `${marker.leftPct}%` }} />)}
      <div aria-hidden="true" className="absolute inset-y-0 w-px bg-violet-200/80" style={{ left: `${percent}%` }} />
      <div data-scrubber-knob="true" aria-hidden="true"
        className="pointer-events-none absolute top-1/2 h-[13px] w-[13px] rounded-full bg-violet-400 ring-1 ring-violet-200/40 transition-transform duration-100 ease-out"
        style={{ left: `${percent}%`, transform: `translate(-50%, -50%) scale(${dragging ? 1.4 : active || touchMode ? 1 : 0})` }} />
      {pointer && bubbleMs !== null && <div ref={bubbleRef} aria-hidden="true" data-scrubber-bubble="true"
        className="pointer-events-none absolute z-20 max-w-[160px] rounded bg-black/85 px-1.5 py-1 text-[10px] leading-tight text-white shadow-lg"
        style={{ left: `${bubbleLeft}px`, bottom: 'calc(100% + 8px)' }}>
        {bubbleTitle ? <p className="truncate text-white/90">{bubbleTitle}</p> : null}
        <p className="font-mono text-[9px] text-white/60">{formatTime(bubbleMs)}</p>
      </div>}
    </div>
  </div>;
}

function TurnList({ transcript, currentTurn, onSeek }) {
  if (!transcript.length) return <p className="text-[11px] text-white/40">No transcript for this call.</p>;
  return <ol aria-label="Call transcript" className="max-h-56 space-y-1 overflow-y-auto pr-1">
    {transcript.map((turn, index) => {
      const startMs = turn?.startMs;
      const timed = typeof startMs === 'number' && Number.isFinite(startMs);
      const current = index === currentTurn;
      const mine = (turn?.speaker ?? turn?.role) === 'candidate';
      return <li key={`turn-${index}`}>
        {timed ? <button type="button" onClick={() => onSeek(startMs)} aria-current={current ? 'true' : undefined} data-current-turn={current ? 'true' : 'false'}
          aria-label={`Seek to ${turn?.text || (mine ? 'your turn' : 'interviewer turn')} at ${formatTime(startMs)}`}
          className={`block w-full rounded px-1.5 py-1 text-left text-[11px] ${current ? 'bg-violet-500/25 text-violet-50 ring-1 ring-violet-300/40' : 'text-white/70 hover:bg-white/5'}`}>
          <span className="mr-1 text-[9px] uppercase text-white/45">{mine ? 'You' : 'Interviewer'} · {formatTime(startMs)}</span>{turn?.text}
        </button> : <div data-untimed-turn="true" data-current-turn="false" className="block w-full rounded px-1.5 py-1 text-left text-[11px] text-white/40">
          <span className="mr-1 text-[9px] uppercase text-white/45">{mine ? 'You' : 'Interviewer'}</span>{turn?.text}
        </div>}
      </li>;
    })}
  </ol>;
}

export default function Replay({ replay, api, initialPositionMs = 0 }) {
  const durationMs = Math.max(0, Number(replay?.durationMs) || 0);
  const chapters = Array.isArray(replay?.chapters) ? replay.chapters : [];
  const transcript = Array.isArray(replay?.transcript) ? replay.transcript : [];
  const [positionMs, setPositionMs] = useState(Math.max(0, Number(initialPositionMs) || 0));
  const [playing, setPlaying] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const audioRef = useRef(null);
  const chaptersRef = useRef(null);
  const pendingSeekRef = useRef(null);
  const audioUrl = !deleted && replay?.audioUrl ? replay.audioUrl : null;
  const analysis = replay?.analysis || null;
  const seek = ms => {
    const raw = Math.max(0, Number(ms) || 0);
    const target = durationMs > 0 ? Math.min(raw, durationMs) : raw;
    setPositionMs(target);
    const audio = audioRef.current;
    let ready = false;
    if (audio) {
      try { ready = audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0; } catch { ready = false; }
      if (ready) { try { audio.currentTime = target / 1000; } catch { ready = false; } }
    }
    pendingSeekRef.current = ready ? null : target;
  };
  const applyPendingSeek = () => {
    const pending = pendingSeekRef.current;
    const audio = audioRef.current;
    if (pending === null || !audio) return;
    try { audio.currentTime = pending / 1000; } catch { return; }
    pendingSeekRef.current = null;
    setPositionMs(pending);
  };
  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { try { audio.pause?.(); } catch { /* detached */ } setPlaying(false); return; }
    try {
      const started = audio.play?.();
      if (started && typeof started.catch === 'function') started.catch(() => setPlaying(false));
      setPlaying(true);
    } catch { setPlaying(false); }
  };
  const confirmDelete = async () => {
    if (typeof api?.deleteRecording === 'function') {
      try { await api.deleteRecording(); }
      catch (error) {
        setDeleteError(error?.message || 'The recording could not be deleted.');
        setConfirmingDelete(false);
        return;
      }
    }
    setDeleteError(null);
    setDeleted(true);
    setConfirmingDelete(false);
    setPlaying(false);
  };
  const currentTurn = turnAt(transcript, positionMs);
  const currentChapterIndex = chapterIndexAt(chapters, positionMs);
  const currentChapterTitle = currentChapterIndex >= 0 ? String(chapters[currentChapterIndex]?.title || `Chapter ${currentChapterIndex + 1}`) : '';
  const showChapters = () => chaptersRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  return <main className="min-h-screen space-y-2 bg-[#111018] p-3 text-violet-50" aria-label="Practice call replay">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-1.5">
      <h1 className="text-sm font-semibold text-violet-100">Practice call replay</h1>
      <div className="flex items-center gap-1">
        <button type="button" aria-label={playing ? 'Pause recording' : 'Play recording'} onClick={togglePlay} disabled={!audioUrl}
          className="flex items-center gap-1 rounded-md border border-white/10 bg-black/25 px-2 py-1 text-[11px] text-violet-100 hover:bg-white/5 disabled:opacity-40">
          {playing ? <Pause size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}{playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" aria-label="Delete recording" onClick={() => setConfirmingDelete(true)} disabled={!replay?.audioUrl && !deleted}
          className="flex items-center gap-1 rounded-md border border-red-400/30 bg-red-500/15 px-2 py-1 text-[11px] text-red-100 hover:bg-red-500/25 disabled:opacity-40">
          <Trash2 size={12} aria-hidden="true" />Delete recording
        </button>
      </div>
    </header>
    <audio ref={audioRef} src={audioUrl || undefined} preload="metadata" aria-label="Call recording"
      onLoadedMetadata={applyPendingSeek}
      onTimeUpdate={event => { if (pendingSeekRef.current === null) setPositionMs((Number(event.currentTarget.currentTime) || 0) * 1000); }}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
    {!audioUrl && <p role="status" aria-label="Recording unavailable" className="rounded-md border border-white/10 bg-black/20 p-2 text-[11px] text-white/55">
      {deleted ? 'Recording deleted. The transcript, chapters and feedback are kept.' : 'The recording for this call is not available. The transcript and feedback are kept.'}
    </p>}
    {analysis?.status === 'analyzing' && <p role="status" aria-label="Analysis status" className="rounded-md border border-amber-400/25 bg-amber-500/10 p-2 text-[11px] text-amber-100">Analysis is still running. Chapters and feedback may be incomplete.</p>}
    {analysis?.status === 'failed' && <p role="alert" aria-label="Analysis failed" className="flex items-start gap-1 rounded-md border border-red-400/30 bg-red-500/15 p-2 text-[11px] text-red-100">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />Analysis failed{analysis.error ? `: ${analysis.error}` : ''}. The transcript and recording are still available.
    </p>}
    {deleteError && <p role="alert" aria-label="Delete failed" className="rounded-md border border-red-400/30 bg-red-500/15 p-2 text-[11px] text-red-100">{deleteError}</p>}
    <Scrubber chapters={chapters} durationMs={durationMs} positionMs={positionMs} onSeek={seek} />
    <div className="flex min-w-0 items-baseline gap-2 text-[10px] text-white/45">
      <span className="font-mono">{formatTime(positionMs)} / {formatTime(durationMs)}</span>
      {currentChapterTitle
        ? <button type="button" aria-label={`Current chapter: ${currentChapterTitle}. Show chapters`} onClick={showChapters}
          className="flex min-w-0 items-center gap-1 rounded px-1 text-left text-violet-200/80 hover:bg-white/5 hover:text-violet-100">
          <span aria-hidden="true">·</span><span className="truncate">{currentChapterTitle}</span><span aria-hidden="true">›</span>
        </button>
        : null}
    </div>
    <div className="grid gap-2 md:grid-cols-2">
      <section aria-label="Chapters" ref={chaptersRef} className="rounded-md border border-white/10 bg-black/20 p-2">
        <p className="text-[10px] font-semibold uppercase text-white/45">Chapters</p>
        {chapters.length === 0 && <p className="text-[11px] text-white/40">No chapters yet.</p>}
        <ol className="mt-1 space-y-1">{chapters.map((chapter, index) => {
          const markers = Array.isArray(chapter?.markers) ? chapter.markers : [];
          const startMs = Number(chapter?.startMs) || 0;
          const title = chapter?.title || `Chapter ${index + 1}`;
          return <li key={`chapter-${index}`}>
            <button type="button" onClick={() => seek(startMs)} aria-label={`Seek to ${title} at ${formatTime(startMs)}`}
              className="flex w-full items-baseline justify-between gap-2 rounded px-1 text-left text-[11px] text-white/80 hover:bg-white/5">
              <span>{title}</span><span className="font-mono text-[10px] text-white/45">{formatTime(startMs)}</span>
            </button>
            {markers.length > 0 && <ul aria-label={`Moments in ${title}`} className="ml-2 mt-0.5 space-y-0.5">{markers.map((marker, markerIndex) => {
              const raw = Number(marker?.atMs) || 0;
              const atMs = durationMs > 0 ? Math.min(Math.max(0, raw), durationMs) : Math.max(0, raw);
              const label = marker?.label || marker?.kind || 'Moment';
              return <li key={`marker-${index}-${markerIndex}`}>
                <button type="button" onClick={() => seek(atMs)} aria-label={`Seek to ${label} at ${formatTime(atMs)}`}
                  className="flex w-full items-center gap-1 rounded px-1 text-left text-[10px] text-white/65 hover:bg-white/5">
                  <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${markerTone(marker?.kind)}`} />{label}<span className="ml-auto font-mono text-white/40">{formatTime(atMs)}</span>
                </button>
              </li>;
            })}</ul>}
          </li>;
        })}</ol>
      </section>
      <section aria-label="Transcript" className="rounded-md border border-white/10 bg-black/20 p-2">
        <p className="text-[10px] font-semibold uppercase text-white/45">Transcript</p>
        <TurnList transcript={transcript} currentTurn={currentTurn} onSeek={seek} />
      </section>
    </div>
    {confirmingDelete && <div role="alertdialog" aria-label="Delete recording" className="space-y-1 rounded-md border border-red-400/30 bg-red-500/10 p-2 text-[11px] text-red-100">
      <p>Delete the recording for this call? The transcript, chapters and feedback are kept.</p>
      <div className="flex gap-1">
        <button type="button" onClick={confirmDelete} aria-label="Confirm delete recording" className="rounded border border-red-400/40 bg-red-500/25 px-2 py-1 hover:bg-red-500/35">Delete</button>
        <button type="button" onClick={() => setConfirmingDelete(false)} className="rounded border border-white/15 px-2 py-1 text-white/70 hover:bg-white/5">Keep recording</button>
      </div>
    </div>}
    {replay?.feedback && <section aria-label="Feedback" className="space-y-2">
      <FeedbackView feedback={replay.feedback} />
      <DeliverySection delivery={replay.feedback.delivery} />
    </section>}
  </main>;
}

export { Replay };
