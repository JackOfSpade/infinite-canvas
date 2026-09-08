import React, { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { useReactFlow, NodeResizer } from '@xyflow/react';
import { Minimize2, Play, AudioLines, AlertTriangle, RefreshCw, FileText, ZoomIn, ZoomOut } from 'lucide-react';
import { renderMarkdown } from '../utils/markdownRenderer';
import { getFileCategoryInfo, THEME_COLORS, toLocalFileUrl } from '../utils/fileDisplayUtils';
import { EventLogger } from '../utils/EventLogger';
import { textDocumentSessions, textDocumentToTextarea } from '../utils/textDocumentSessions';
import { NodeHandles } from './_shared/NodeHandles';
import { LockBadge } from './_shared/LockBadge';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Human-readable labels for HTMLMediaElement.error.code values. */
const MEDIA_ERROR_LABELS = { 1: 'Aborted', 2: 'Network error', 3: 'Decode error', 4: 'Not supported' };

const MARKDOWN_DEFAULT_WIDTH = 720;
const MARKDOWN_DEFAULT_HEIGHT = 400;
const MARKDOWN_MIN_WIDTH = 560;
const MARKDOWN_MIN_HEIGHT = 180;

const toPixelNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return NaN;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

// ── Shared sub-components ──────────────────────────────────────────────────────

/**
 * Shared expanded-preview shell used by video, audio, and text nodes.
 * Renders the outer container (badge, collapse button, hover state) and
 * delegates the inner content to `children`.
 */
const ExpandedPreviewShell = React.memo(function ExpandedPreviewShell({
  badge, filename, onCollapse, onHoverChange, children,
}) {
  return (
    <>
      <div
        className="relative rounded overflow-hidden flex flex-col flex-1 w-full h-full items-center justify-center bg-black/50 pt-8 pb-3 px-3 group/media"
        onMouseEnter={() => onHoverChange(true)}
        onMouseLeave={() => onHoverChange(false)}
      >
        {/* Collapse button */}
        <button
          onClick={onCollapse}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag absolute top-1 right-1 p-1.5 hover:bg-white/10 rounded-lg text-white/70 hover:text-white transition-colors z-10"
          title="Collapse Preview"
        >
          <Minimize2 size={16} />
        </button>

        {/* Badge pill */}
        <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/60 text-white/90 text-[10px] font-bold tracking-wider z-10 pointer-events-none backdrop-blur-sm border border-white/10">
          {badge}
        </div>

        {children}
      </div>

      {/* Filename footer */}
      <div className="px-2 text-white font-medium truncate text-sm w-full text-center shrink-0">
        {filename}
      </div>
    </>
  );
});

// ── Media fade-in/out (Web Audio) ─────────────────────────────────────────────
// Routes the media element through a MediaElementAudioSourceNode → GainNode and
// ramps gain on play/pause/seek transitions. Eliminates the audible pop produced
// by macOS CoreAudio device wake-up and the discontinuity at sample boundaries
// when restarting playback from t=0 repeatedly. Cached per-element via WeakMap
// because MediaElementAudioSourceNode can only be created once per HTMLMediaElement.

const FADE_IN_SECONDS  = 0.04;
const FADE_OUT_SECONDS = 0.01;
const audioGraphCache = new WeakMap();

function useMediaFade(mediaRef, isActive) {
  useEffect(() => {
    if (!isActive) return;
    const el = mediaRef.current;
    if (!el) return;

    let graph = audioGraphCache.get(el);
    if (!graph) {
      try {
        const ctx  = new AudioContext();
        const src  = ctx.createMediaElementSource(el);
        const gain = ctx.createGain();
        gain.gain.value = 0; // start muted; fade in on first play
        src.connect(gain);
        gain.connect(ctx.destination);
        graph = { ctx, gain };
        audioGraphCache.set(el, graph);
      } catch {
        return; // Web Audio unavailable or element already owned by another context
      }
    }
    const { ctx, gain } = graph;

    const fadeTo = (target, seconds) => {
      if (ctx.state !== 'running') ctx.resume().catch(() => { /* user-gesture-gated */ });
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(target, now + seconds);
    };
    const fadeIn  = () => fadeTo(1, FADE_IN_SECONDS);
    const fadeOut = () => fadeTo(0, FADE_OUT_SECONDS);
    const onSeeked = () => { if (!el.paused) fadeIn(); };

    el.addEventListener('play',    fadeIn);
    el.addEventListener('playing', fadeIn);
    el.addEventListener('pause',   fadeOut);
    el.addEventListener('seeking', fadeOut);
    el.addEventListener('seeked',  onSeeked);
    el.addEventListener('ended',   fadeOut);
    return () => {
      el.removeEventListener('play',    fadeIn);
      el.removeEventListener('playing', fadeIn);
      el.removeEventListener('pause',   fadeOut);
      el.removeEventListener('seeking', fadeOut);
      el.removeEventListener('seeked',  onSeeked);
      el.removeEventListener('ended',   fadeOut);
      // ctx persists in audioGraphCache — element may be reused across hook re-runs.
    };
  // mediaRef is stable; only re-run when isActive flips.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);
}

// ── Media event logger hook ────────────────────────────────────────────────────

/** Attaches media event listeners that log playback lifecycle to the EventLogger. */
function useMediaEventLogger(mediaRef, nodeId, isActive) {
  useEffect(() => {
    if (!isActive) return;
    const el = mediaRef.current;
    if (!el) return;

    const shortId = nodeId.slice(0, 8);
    const onPlay = () => EventLogger.log(`media play    id=${shortId}`);
    const onPause = () => EventLogger.log(`media pause   id=${shortId} t=${el.currentTime?.toFixed(2)}s`);
    const onEnded = () => EventLogger.log(`media ended   id=${shortId}`);
    const onError = () => EventLogger.log(`media error   id=${shortId} code=${el.error?.code} msg=${el.error?.message}`);
    const onStall = () => EventLogger.log(`media stall   id=${shortId} t=${el.currentTime?.toFixed(2)}s`);
    const onSeeked = () => EventLogger.log(`media seeked  id=${shortId} t=${el.currentTime?.toFixed(2)}s`);

    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    el.addEventListener('stalled', onStall);
    el.addEventListener('seeked', onSeeked);
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
      el.removeEventListener('stalled', onStall);
      el.removeEventListener('seeked', onSeeked);
    };
    // Re-attach if the active flag or nodeId changes; mediaRef itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, nodeId]);
}

// ── Video Player ───────────────────────────────────────────────────────────────

/**
 * Stable video element wrapper. Kept as a separate component so React never
 * unmounts/remounts the <video> element due to conditional render branches in
 * the parent — only prop changes flow through. This prevents playback from
 * being interrupted by parent re-renders during resize.
 */
const VideoPlayer = React.memo(function VideoPlayer({ mediaRef, src, hoveringMedia, onLoadedMetadata, nodeId }) {
  useMediaEventLogger(mediaRef, nodeId, true);

  // errorInfo: { src, label } — pinned to the src that caused the error so the
  // overlay auto-clears when the src changes, without setState inside an effect.
  const [errorInfo, setErrorInfo] = useState(null);
  const decodeError = errorInfo?.src === src ? errorInfo.label : null;

  const handleError = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    const code = el.error?.code;
    if (code) setErrorInfo({ src, label: MEDIA_ERROR_LABELS[code] ?? 'Playback error' });
  }, [mediaRef, src]);

  const handleRetry = useCallback((e) => {
    e.stopPropagation();
    const el = mediaRef.current;
    if (!el) return;
    setErrorInfo(null);
    // Some MP4/AAC files have encoder-priming packets at negative timestamps
    // (e.g. -46ms preroll). Chromium's audio decoder can hit PIPELINE_ERROR_DECODE
    // when re-entering those packets after a previous play (notably after `ended`).
    // After load(), seek past the priming offset before play so the decoder
    // never receives the negative-timestamp packet on retry.
    const onMeta = () => {
      el.removeEventListener('loadedmetadata', onMeta);
      try { el.currentTime = 0.05; } catch { /* ignore — element may have been unmounted */ }
      el.play().catch(() => { /* ignore AbortError on quick retries */ });
    };
    el.addEventListener('loadedmetadata', onMeta, { once: true });
    el.load();
  }, [mediaRef]);

  return (
    <div className="relative w-full h-full flex-1 flex">
      <video
        ref={mediaRef}
        controls
        title=""
        src={src}
        className={`nodrag w-full h-full object-contain rounded-md shadow-inner bg-black/40 flex-1 ${hoveringMedia ? 'media-controls-visible' : 'media-controls-hidden'
          }`}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onLoadedMetadata={onLoadedMetadata}
        onError={handleError}
      />

      {/* Decode-error overlay */}
      {decodeError && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3
                     bg-black/70 backdrop-blur-sm rounded-md z-10"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <AlertTriangle className="w-8 h-8 text-red-400 shrink-0" />
          <div className="flex flex-col items-center gap-1 text-center px-4">
            <span className="text-white/90 text-sm font-semibold">{decodeError}</span>
            <span className="text-white/50 text-xs leading-snug">
              This video couldn&rsquo;t be decoded.<br />
              Try restarting the app if the issue persists.
            </span>
          </div>
          <button
            onClick={handleRetry}
            className="nodrag flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                       bg-white/10 hover:bg-white/20 border border-white/15
                       text-white/80 text-xs font-medium transition-colors"
          >
            <RefreshCw size={12} />
            Retry
          </button>
        </div>
      )}
    </div>
  );
});

// ── Audio Player ───────────────────────────────────────────────────────────────

/** Stable audio element wrapper — mirrors VideoPlayer for the same stability reasons. */
const AudioPlayer = React.memo(function AudioPlayer({ mediaRef, src, themeText, hoveringMedia, nodeId }) {
  useMediaEventLogger(mediaRef, nodeId, true);
  useMediaFade(mediaRef, true);
  return (
    <div className="w-full h-full mt-2 px-6 py-4 bg-black/20 rounded-lg border border-white/5 flex flex-col flex-1 items-center justify-center gap-4 shadow-inner">
      <AudioLines className={`w-12 h-12 ${themeText} opacity-80 shrink-0 ${hoveringMedia ? 'text-white' : ''} transition-colors`} />
      <audio
        ref={mediaRef}
        controls
        title=""
        src={src}
        className="w-full outline-none shrink-0"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    </div>
  );
});

// ── Text / Markdown Preview ─────────────────────────

// Absolute-positioned save-status dot. Rendered with fixed dimensions in every state
// so toggling between idle/dirty/saving/saved/error never reflows the editor and the
// textarea doesn't jump up/down. The clean state is a subtle gray dot (still visible).
const STATUS_INDICATORS = {
  saving: { color: 'bg-sky-400', pulse: true, label: 'Saving…' },
  saved: { color: 'bg-emerald-400', pulse: false, label: 'Saved' },
  error: { color: 'bg-red-400', pulse: true, label: 'Save failed' },
  dirty: { color: 'bg-amber-400', pulse: false, label: 'Unsaved changes' },
  clean: { color: 'bg-white/25', pulse: false, label: 'Saved' },
};

const StatusIndicator = React.memo(function StatusIndicator({ saveStatus, isDirty, className = 'absolute top-1.5 right-6 z-20 pointer-events-none' }) {
  let key = 'clean';
  if (saveStatus === 'saving') key = 'saving';
  else if (saveStatus === 'saved') key = 'saved';
  else if (saveStatus === 'error') key = 'error';
  else if (isDirty) key = 'dirty';
  const { color, pulse, label } = STATUS_INDICATORS[key];
  return (
    <div
      className={className}
      title={label}
      aria-label={label}
    >
      <span
        className={`block w-2.5 h-2.5 rounded-full ring-1 ring-black/40 shadow-[0_0_4px_rgba(0,0,0,0.4)] transition-colors duration-300 ${color} ${pulse ? 'animate-pulse' : ''}`}
      />
    </div>
  );
});

/**
 * A view onto the per-file session. Two duplicated nodes therefore receive the
 * same snapshot and dispatch edits into the same debounce/write lane.
 */
const TextPreview = React.memo(function TextPreview({ filePath, filename, isLocked, initialFontSize, onFontSizeChange }) {
  const isMd = String(filename ?? '').toLowerCase().endsWith('.md');
  const [sessionState, setSessionState] = useState(() => textDocumentSessions.getSnapshot(filePath));
  const [fontSize, setFontSizeLocal] = useState(initialFontSize || 12);

  useEffect(() => textDocumentSessions.attach(filePath, setSessionState), [filePath]);

  const setFontSize = useCallback((updater) => {
    setFontSizeLocal(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      onFontSizeChange?.(next);
      return next;
    });
  }, [onFontSizeChange]);
  const handleZoomIn = useCallback((e) => { e?.stopPropagation(); setFontSize(prev => Math.min(prev + 2, 48)); }, [setFontSize]);
  const handleZoomOut = useCallback((e) => { e?.stopPropagation(); setFontSize(prev => Math.max(prev - 2, 8)); }, [setFontSize]);
  const handleWheel = useCallback((e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.stopPropagation();
    if (e.deltaY < 0) setFontSize(prev => Math.min(prev + 1, 48));
    else if (e.deltaY > 0) setFontSize(prev => Math.max(prev - 1, 8));
  }, [setFontSize]);

  const handleChange = useCallback((e) => {
    if (!isLocked) {
      textDocumentSessions.editFromTextarea(filePath, e.target.value);
    }
  }, [filePath, isLocked]);
  const handleReloadFromDisk = useCallback(() => { void textDocumentSessions.reloadFromDisk(filePath); }, [filePath]);
  const handleKeepEdits = useCallback(() => {
    if (!isLocked) textDocumentSessions.keepMine(filePath);
  }, [filePath, isLocked]);
  const handleRetrySave = useCallback(() => {
    if (!isLocked) textDocumentSessions.retrySave(filePath);
  }, [filePath, isLocked]);

  const { status, content: draftContent, diskContent, saveStatus, externalChange, error } = sessionState;
  const textareaContent = textDocumentToTextarea(draftContent);
  const isDirty = draftContent !== null && draftContent !== diskContent;
  const deferredPreviewSource = useDeferredValue(draftContent);
  const renderedMarkdown = React.useMemo(() => renderMarkdown(deferredPreviewSource), [deferredPreviewSource]);
  const textareaBaseClass = 'nodrag nowheel min-h-0 flex-1 w-full resize-none p-3 text-white/85 font-mono leading-relaxed outline-none transition-colors ';
  const textareaStateClass = isLocked ? 'cursor-not-allowed opacity-60' : 'cursor-text';
  const textareaClass = `${textareaBaseClass}rounded-md bg-black/20 border border-white/5 shadow-inner focus:border-sky-500/40 focus:bg-black/30 ${textareaStateClass}`;
  const markdownTextareaClass = `${textareaBaseClass}border border-white/10 bg-black/10 rounded-md focus:border-sky-500/40 focus:bg-black/20 ${textareaStateClass}`;
  const zoomControls = (
    <div className="absolute bottom-3 right-5 flex items-center gap-1.5 bg-black/40 backdrop-blur-md rounded px-1.5 py-1 border border-white/10 z-20">
      <button onClick={handleZoomOut} onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} className="nodrag cursor-pointer p-1 text-white/50 hover:text-white transition-colors" title="Zoom Out"><ZoomOut size={16} /></button>
      <button onClick={handleZoomIn} onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} className="nodrag cursor-pointer p-1 text-white/50 hover:text-white transition-colors" title="Zoom In"><ZoomIn size={16} /></button>
    </div>
  );
  const externalChangeBanner = externalChange ? (
    <div className="flex items-center gap-2 px-2 py-1.5 bg-amber-500/15 border-b border-amber-500/20 text-amber-300 text-[10px] shrink-0">
      <AlertTriangle size={11} className="shrink-0" />
      <span className="flex-1">{error ? 'Couldn\'t reread file; keeping your draft' : 'File changed on disk'}</span>
      <button
        onClick={handleReloadFromDisk}
        className="nodrag px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/35 transition-colors text-[10px]"
      >
        Reload
      </button>
      <button
        onClick={handleKeepEdits}
        disabled={isLocked}
        className={`nodrag px-1.5 py-0.5 rounded transition-colors text-[10px] text-white/50 ${
          isLocked ? 'cursor-not-allowed opacity-40' : 'hover:bg-white/10'
        }`}
      >
        Keep mine
      </button>
    </div>
  ) : null;
  // A generic IPC failure (not a CAS conflict) used to be visible only as a
  // red status dot. Keep the conflict decision above unchanged, while making
  // actionable failures such as the hard-link atomicity rejection readable
  // and safely retryable with the session's existing CAS baseline.
  const saveErrorBanner = saveStatus === 'error' && !externalChange && error ? (
    <div className="flex items-center gap-2 px-2 py-1.5 bg-red-500/15 border-b border-red-500/20 text-red-200 text-[10px] shrink-0">
      <AlertTriangle size={11} className="shrink-0" />
      <span className="flex-1 min-w-0">{error}</span>
      <button
        onClick={handleRetrySave}
        disabled={isLocked}
        className={`nodrag px-1.5 py-0.5 rounded transition-colors text-[10px] ${
          isLocked ? 'cursor-not-allowed opacity-40' : 'bg-red-500/20 hover:bg-red-500/35'
        }`}
      >
        Retry
      </button>
    </div>
  ) : null;

  if (status === 'error') return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-4">
      <AlertTriangle className="w-7 h-7 text-red-400 shrink-0" /><span className="text-white/70 text-xs">Couldn&rsquo;t load file</span><span className="text-white/30 text-[10px] font-mono">{error}</span>
    </div>
  );
  if (status === 'loading' || draftContent === null) return <div className="flex-1 flex items-center justify-center"><div className="w-5 h-5 rounded-full border-2 border-t-transparent border-sky-400 animate-spin opacity-60" /></div>;

  if (!isMd) return (
    <div className="relative flex-1 flex flex-col w-full h-full gap-0 overflow-hidden">
      {externalChangeBanner}
      {saveErrorBanner}
      <textarea className={textareaClass} style={{ fontSize: `${fontSize}px` }} value={textareaContent} onChange={handleChange} readOnly={isLocked} onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onWheel={handleWheel} spellCheck={false} />
      <StatusIndicator saveStatus={saveStatus} isDirty={isDirty} />
      {zoomControls}
    </div>
  );

  return (
    <div className="relative flex-1 flex flex-col w-full h-full gap-0 overflow-hidden">
      {externalChangeBanner}
      {saveErrorBanner}
      <div className="flex flex-1 min-h-0 w-full gap-1.5 pt-1 overflow-hidden">
        <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-white/5 bg-black/20 shadow-inner" aria-label={`Markdown editor for ${filename}`}>
          <div className="flex h-7 shrink-0 items-center border-b border-white/5 px-3 text-[10px] font-medium text-white/60">Edit</div>
          <textarea className={markdownTextareaClass} style={{ fontSize: `${fontSize}px` }} value={textareaContent} onChange={handleChange} readOnly={isLocked} onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onWheel={handleWheel} spellCheck={false} autoFocus={!isLocked} aria-label={`Edit ${filename}`} />
          <StatusIndicator saveStatus={saveStatus} isDirty={isDirty} className="absolute top-2 right-3 z-20 pointer-events-none" />
        </section>
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-white/5 bg-black/20 shadow-inner" aria-label={`Markdown preview for ${filename}`}>
          <div className="flex h-7 shrink-0 items-center border-b border-white/5 px-3 text-[10px] font-medium text-white/60">Preview</div>
          <div className="nodrag nowheel min-h-0 flex-1 w-full overflow-auto p-3 text-preview-md" style={{ fontSize: `${fontSize}px` }} onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onWheel={handleWheel} dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />
        </section>
      </div>
      {zoomControls}
    </div>
  );
});

// ── DocumentNode ──────────────────────────────────────────────────────────────

export const DocumentNode = React.memo(function DocumentNode({ id, data, selected, width, height }) {
  const imgVersionRef = useRef(0);
  const imgRef = useRef(null);
  const mediaRef = useRef(null);

  const isExpanded = !!data.isExpanded;
  const [hoveringMedia, setHoveringMedia] = useState(false);
  const { updateNodeData, setNodes } = useReactFlow();

  const handleFontSizeChange = useCallback((size) => {
    updateNodeData(id, { editorFontSize: size });
  }, [id, updateNodeData]);

  const { category, label, color, badge, Icon } = getFileCategoryInfo(data.filename);
  const theme = THEME_COLORS[color];
  const isImage = category === 'image';
  const isVideo = category === 'video';
  const isAudio = category === 'audio';
  const isText = category === 'text';   // .md / .txt — expandable text preview
  const isMarkdown = isText && String(data.filename || data.filePath || '').toLowerCase().endsWith('.md');
  const isMedia = isVideo || isAudio;    // has an HTMLMediaElement
  const isExpandable = isMedia || isText; // can enter the expanded-preview state

  // ── File-watch (live image reload / text change notification) ────────────
  useEffect(() => {
    if (!data.filePath || !window.electronAPI) return;
    window.electronAPI.startFileWatch(data.filePath);
    const removeListener = window.electronAPI.onFileChanged((changedPath, notificationId) => {
      if (changedPath !== data.filePath) return;
      if (isImage && imgRef.current) {
        imgVersionRef.current += 1;
        imgRef.current.src = `${toLocalFileUrl(data.filePath)}?v=${imgVersionRef.current}`;
      }
      // Every expanded duplicate shares one per-file reconciliation session.
      // Calling this from each node is intentional: the registry deduplicates
      // the renderer broadcast into one read/classification pass.
      if (isText) void textDocumentSessions.notifyFileChanged(data.filePath, notificationId);
    });
    return () => {
      removeListener();
      window.electronAPI.stopFileWatch(data.filePath);
    };
  }, [data.filePath, isImage, isText]);

  // ── Customize dialog trigger ───────────────────────────────────────────────

  // ── Media src management ───────────────────────────────────────────────────
  // Effect 1: Enforce src on mount / file-change (fixes React 18 StrictMode quirk).
  // Must NOT include a cleanup that removes src — that was the root cause of video
  // stopping mid-playback when the component re-evaluated during resize.
  useEffect(() => {
    if (!isExpanded || !isMedia || !data.filePath) return;
    const el = mediaRef.current;
    if (el && el.src !== toLocalFileUrl(data.filePath)) {
      el.src = toLocalFileUrl(data.filePath);
    }
  }, [isExpanded, isMedia, data.filePath]);

  // ── Interactions ───────────────────────────────────────────────────────────
  const handleDoubleClick = useCallback(async () => {
    if (data.locked) return;
    if (data.filePath && window.electronAPI) {
      try { await window.electronAPI.openFile(data.filePath); }
      catch (err) { EventLogger.error('Error opening file:', err); }
    }
  }, [data.locked, data.filePath]);

  const handleCollapse = useCallback((e) => {
    e.stopPropagation();
    // Must release synchronously here, before the collapsed-branch render
    // unmounts the <video>/<audio> element — React detaches mediaRef during
    // commit, strictly before any useEffect could observe the isExpanded flip.
    if (mediaRef.current) {
      mediaRef.current.pause();
      mediaRef.current.removeAttribute('src');
      mediaRef.current.load();
    }
    setNodes((nds) => nds.map((n) => {
      if (n.id !== id) return n;
      const measuredWidth = toPixelNumber(n.width) || toPixelNumber(n.style?.width);
      const measuredHeight = toPixelNumber(n.height) || toPixelNumber(n.style?.height);
      return {
        ...n,
        width: undefined, height: undefined,
        style: { ...n?.style, width: undefined, height: undefined },
        data: {
          ...n.data,
          isExpanded: false,
          expandedWidth: isMarkdown
            ? Math.max(measuredWidth || MARKDOWN_DEFAULT_WIDTH, MARKDOWN_MIN_WIDTH)
            : n.width,
          expandedHeight: isMarkdown
            ? Math.max(measuredHeight || MARKDOWN_DEFAULT_HEIGHT, MARKDOWN_MIN_HEIGHT)
            : n.height,
        },
      };
    }));
  }, [id, isMarkdown, setNodes]);

  const handleExpand = useCallback((e) => {
    e.stopPropagation();
    setNodes((nds) => nds.map((n) => {
      if (n.id !== id) return n;
      const expandedWidth = isMarkdown
        ? Math.max(toPixelNumber(n.data.expandedWidth) || MARKDOWN_DEFAULT_WIDTH, MARKDOWN_MIN_WIDTH)
        : n.data.expandedWidth || n.width;
      const expandedHeight = isMarkdown
        ? Math.max(toPixelNumber(n.data.expandedHeight) || MARKDOWN_DEFAULT_HEIGHT, MARKDOWN_MIN_HEIGHT)
        : n.data.expandedHeight || n.height;
      return {
        ...n,
        width: expandedWidth,
        height: expandedHeight,
        style: {
          ...n?.style,
          width: expandedWidth,
          height: expandedHeight,
        },
        data: { ...n.data, isExpanded: true },
      };
    }));
  }, [id, isMarkdown, setNodes]);

  const handleVideoMetadata = useCallback((e) => {
    if (!width && !data.expandedWidth && e.target.videoWidth && e.target.videoHeight) {
      const ratio = e.target.videoWidth / e.target.videoHeight;
      const defaultW = 400;
      const calculatedH = Math.round(defaultW / ratio) + 88;
      setNodes((nds) => nds.map((n) => n.id === id
        ? { ...n, width: defaultW, height: calculatedH, style: { ...n?.style, width: defaultW, height: calculatedH } }
        : n
      ));
    }
  }, [id, width, data.expandedWidth, setNodes]);

  // ── Layout & sizing ────────────────────────────────────────────────────────
  const selectedClass = selected
    ? 'border-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.5)]'
    : 'border-white/10';

  let wrapperClassName = `glass-card rounded-xl flex transition-[border-color,box-shadow] relative group ${selectedClass}`;

  const isCollapsed = !isImage && !(isExpanded && isExpandable);
  const currentWidth = width || data.expandedWidth;
  const currentHeight = height || data.expandedHeight;

  // Default expanded sizes per type
  const defaultExpandedW = isVideo ? 400 : isMarkdown ? MARKDOWN_DEFAULT_WIDTH : isText ? 380 : 320;
  const defaultExpandedH = isVideo ? 313 : isMarkdown ? MARKDOWN_DEFAULT_HEIGHT : isText ? 320 : 200;

  const nodeWidth = isCollapsed ? 'auto' : (currentWidth || (isImage ? 250 : defaultExpandedW));
  const nodeHeight = isCollapsed ? 'auto' : (currentHeight || (isExpanded ? defaultExpandedH : 'auto'));

  const containerStyle = {
    width: nodeWidth,
    height: nodeHeight,
    minWidth: isImage ? 150 : isExpanded && isMarkdown ? MARKDOWN_MIN_WIDTH : isExpanded && isExpandable ? 280 : 'auto',
    minHeight: isImage ? 150 : isExpanded && isExpandable ? MARKDOWN_MIN_HEIGHT : 'auto',
  };

  // ── Render branches ────────────────────────────────────────────────────────
  let innerContent;

  if (isImage) {
    // ── Image: always-expanded, resizable ────────────────────────────────────
    wrapperClassName += ' p-2 flex-col items-center gap-2';
    innerContent = (
      <>
        {data.locked && <LockBadge />}
        <div className="relative rounded overflow-hidden flex flex-1 w-full h-full items-center justify-center bg-black/40">
          <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/60 text-white/90 text-[9px] font-bold tracking-wider z-10 pointer-events-none backdrop-blur-sm border border-white/10">
            {badge}
          </div>
          <img
            ref={imgRef}
            src={toLocalFileUrl(data.filePath)}
            alt={data.filename}
            className="object-contain w-full h-full"
          />
        </div>
        <div className="px-1 text-white font-medium truncate text-xs w-full text-center">
          {data.filename}
        </div>
      </>
    );

  } else if (isExpanded && isExpandable) {
    // ── Expanded media / text preview ─────────────────────────────────────────
    wrapperClassName += ' p-2 flex-col items-center gap-2 shadow-2xl';
    innerContent = (
      <>
        {data.locked && <LockBadge />}
        <ExpandedPreviewShell
          badge={badge}
          filename={data.filename}
          onCollapse={handleCollapse}
          onHoverChange={setHoveringMedia}
        >
          {isVideo && (
            <VideoPlayer
              mediaRef={mediaRef}
              src={toLocalFileUrl(data.filePath)}
              hoveringMedia={hoveringMedia}
              onLoadedMetadata={handleVideoMetadata}
              nodeId={id}
            />
          )}
          {isAudio && (
            <AudioPlayer
              mediaRef={mediaRef}
              src={toLocalFileUrl(data.filePath)}
              themeText={theme.text}
              hoveringMedia={hoveringMedia}
              nodeId={id}
            />
          )}
          {isText && (
            <TextPreview
              filePath={data.filePath}
              filename={data.filename}
              isLocked={!!data.locked}
              initialFontSize={data.editorFontSize}
              onFontSizeChange={handleFontSizeChange}
            />
          )}
        </ExpandedPreviewShell>
      </>
    );

  } else {
    // ── Collapsed pill (all non-image, non-expanded types) ────────────────────
    wrapperClassName += ' p-3 items-center gap-3 w-64';
    innerContent = (
      <>
        {data.locked && <LockBadge />}
        <div className={`w-10 h-10 rounded ${theme.bg} flex items-center justify-center shrink-0 relative overflow-hidden`}>
          <Icon className={`w-5 h-5 ${theme.text} ${isExpandable ? 'group-hover:opacity-0 transition-opacity' : ''}`} />
          {isExpandable && (
            <button
              onClick={handleExpand}
              onPointerDown={(e) => e.stopPropagation()}
              className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40 hover:bg-black/60"
              title={isText ? 'Preview File' : 'Play Media'}
            >
              {isText
                ? <FileText className="w-5 h-5 text-white" />
                : <Play className="w-5 h-5 text-white ml-0.5 fill-white" />
              }
            </button>
          )}
        </div>

        <div className="flex flex-col min-w-0 overflow-hidden relative flex-1">
          <span className="text-white font-medium truncate text-sm">
            {data.filename || 'Unknown File'}
          </span>
          <span className="text-gray-400 truncate text-xs">{label}</span>
        </div>

        <div className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider shrink-0 ${theme.text} ${theme.bg}`}>
          {badge}
        </div>
      </>
    );
  }

  // ── Output ──────────────────────────────────────────────────────────────────
  const bgColor = data.backgroundColor || (selected && (isImage || isExpanded) ? 'rgba(59,130,246,0.1)' : undefined);
  const showResizer = isImage || (isExpanded && isExpandable);

  return (
    <div
      className={wrapperClassName}
      onDoubleClick={handleDoubleClick}
      title={data.filePath}
      style={{ backgroundColor: bgColor, ...containerStyle }}
    >
      {showResizer && (
        <NodeResizer
          minWidth={isImage ? 150 : isMarkdown ? MARKDOWN_MIN_WIDTH : 240}
          minHeight={isImage ? 150 : isExpanded && isExpandable ? MARKDOWN_MIN_HEIGHT : 160}
          isVisible={selected && !data.locked}
          color="#3b82f6"
          handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        />
      )}
      <NodeHandles className="w-3 h-3 bg-blue-400" />
      {innerContent}
    </div>
  );
});
