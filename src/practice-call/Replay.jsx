import React, { useRef, useState } from 'react';
import { AlertTriangle, Pause, Play, Trash2 } from 'lucide-react';
import { FeedbackView } from '../components/InterviewPracticePanel.jsx';
import { formatTime, markerTone, segmentStyles, turnAt } from './replayModel.js';
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

export function Scrubber({ chapters, durationMs, positionMs, onSeek }) {
  const segments = segmentStyles(chapters, durationMs);
  const percent = durationMs > 0 ? Math.min(100, Math.max(0, (positionMs / durationMs) * 100)) : 0;
  const nudge = event => {
    const delta = event.key === 'ArrowRight' ? 5000 : event.key === 'ArrowLeft' ? -5000 : 0;
    if (!delta) return;
    event.preventDefault();
    onSeek(Math.min(Math.max(0, positionMs + delta), durationMs));
  };
  const pick = event => {
    const rect = event.currentTarget.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0) || !(durationMs > 0)) return;
    onSeek(Math.min(Math.max(0, ((event.clientX - rect.left) / rect.width) * durationMs), durationMs));
  };
  return <div role="slider" tabIndex={0} aria-label="Replay position" aria-valuemin={0} aria-valuemax={durationMs} aria-valuenow={Math.round(positionMs)} aria-valuetext={formatTime(positionMs)}
    className="relative h-6 w-full cursor-pointer rounded bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-300" onKeyDown={nudge} onClick={pick}>
    <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded bg-white/10">
      {segments.map(segment => <div key={segment.index} data-chapter={segment.index} title={`${segment.title} · ${formatTime(segment.startMs)}`} className="absolute top-0 h-full border-r border-black/50 bg-violet-400/25 last:border-r-0" style={{ left: `${segment.leftPct}%`, width: `${segment.widthPct}%` }} />)}
    </div>
    {segments.flatMap(segment => segment.markers.map((marker, markerIndex) => {
      const raw = Number(marker?.atMs);
      if (!(durationMs > 0) || !Number.isFinite(raw)) return [];
      const atMs = Math.min(Math.max(0, raw), durationMs);
      return <span key={`${segment.index}-${markerIndex}`} data-marker-kind={marker?.kind} title={`${marker?.label || marker?.kind} · ${formatTime(atMs)}`} className={`absolute top-0 h-6 w-0.5 ${markerTone(marker?.kind)}`} style={{ left: `${(atMs / durationMs) * 100}%` }} />;
    }))}
    <div aria-hidden="true" className="absolute top-0 h-6 w-px bg-white" style={{ left: `${percent}%` }} />
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
    <div className="flex justify-between text-[10px] text-white/45"><span>{formatTime(positionMs)}</span><span>{formatTime(durationMs)}</span></div>
    <div className="grid gap-2 md:grid-cols-2">
      <section aria-label="Chapters" className="rounded-md border border-white/10 bg-black/20 p-2">
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
