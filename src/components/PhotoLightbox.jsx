import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { toLocalFilePreviewUrl } from '../utils/fileDisplayUtils';
import { updateModalCount } from './modalStack';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

/**
 * Full-viewport image viewer rendered via a portal so it escapes ReactFlow's
 * transformed/clipped node containers. Used by PhotoStrip to let the user
 * inspect product photos at full size and page through the set.
 *
 * Interactions: arrow keys + chevron buttons navigate; ESC or backdrop click
 * closes. Loading is briefly indicated because HEIC files are transcoded to
 * JPEG on demand by the local-file:// protocol handler (a few hundred ms).
 */
export function PhotoLightbox({ imagePaths, initialIndex = 0, onClose }) {
  const total = imagePaths?.length || 0;
  const [index, setIndex] = useState(
    Math.max(0, Math.min(initialIndex, total - 1))
  );
  const [loading, setLoading] = useState(true);
  // The source list can shrink while the lightbox is open. Derive a bounded
  // render index instead of synchronously resetting state in an effect; that
  // keeps the frame valid without causing an extra render. PhotoStrip only
  // mounts this component when the list is non-empty.
  const currentIndex = Math.max(0, Math.min(index, total - 1));

  // Register with the global modal stack (the parent only mounts this while
  // open — see PhotoStrip.jsx's `{lightboxIndex !== null && ...}`). The capture-
  // phase keydown handler below calls preventDefault(), not stopPropagation(),
  // so canvas-level bubble-phase listeners (undo/redo, WASD, tool shortcuts)
  // still receive the same event afterward — this is what actually silences them.
  useEffect(() => {
    updateModalCount(1);
    return () => updateModalCount(-1);
  }, []);

  const prev = useCallback(() => {
    if (total === 0) return;
    setLoading(true);
    setIndex(i => (Math.max(0, Math.min(i, total - 1)) - 1 + total) % total);
  }, [total]);

  const next = useCallback(() => {
    if (total === 0) return;
    setLoading(true);
    setIndex(i => (Math.max(0, Math.min(i, total - 1)) + 1) % total);
  }, [total]);

  // Keyboard nav. Capture-phase so ReactFlow's deleteKeyCode (Backspace/Delete)
  // and Cmd+S handlers don't fire while the lightbox is open.
  useEscapeToClose((e) => { e.preventDefault(); onClose(); }, { capture: true, enabled: total > 0 });
  useEffect(() => {
    if (total <= 1) return undefined;
    const handler = (e) => {
      if (e.key === 'ArrowLeft')       { e.preventDefault(); prev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [prev, next, total]);

  if (total === 0) return null;
  const currentPath = imagePaths[currentIndex];
  const fileName = currentPath?.split('/').pop() || '';

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] bg-black/85 backdrop-blur-sm flex items-center justify-center"
      onClick={onClose}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Counter */}
      <div className="absolute top-4 left-4 text-white/80 text-xs font-mono bg-black/50 border border-white/10 px-3 py-1.5 rounded-full pointer-events-none">
        {currentIndex + 1} / {total}
      </div>

      {/* Close */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        className="absolute top-4 right-4 text-white/70 hover:text-white p-2 rounded-full bg-black/40 hover:bg-black/60 border border-white/10 transition-colors"
        title="Close (Esc)"
      >
        <X size={20} />
      </button>

      {/* Prev / Next */}
      {total > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); prev(); }}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white p-3 rounded-full bg-black/40 hover:bg-black/60 border border-white/10 transition-colors"
            title="Previous (←)"
          >
            <ChevronLeft size={24} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); next(); }}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-white/70 hover:text-white p-3 rounded-full bg-black/40 hover:bg-black/60 border border-white/10 transition-colors"
            title="Next (→)"
          >
            <ChevronRight size={24} />
          </button>
        </>
      )}

      {/* File name */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/60 text-xs font-mono bg-black/50 border border-white/10 px-3 py-1.5 rounded-full max-w-[80vw] truncate pointer-events-none">
        {fileName}
      </div>

      {/* Image */}
      <div
        className="max-w-[90vw] max-h-[90vh] flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {loading && (
          <div className="text-white/40 text-xs animate-pulse">Loading…</div>
        )}
        <img
          src={toLocalFilePreviewUrl(currentPath, { maxDimension: 2400 })}
          alt={`Photo ${currentIndex + 1} of ${total}`}
          className={`max-w-[90vw] max-h-[90vh] object-contain rounded ${loading ? 'hidden' : ''}`}
          onLoad={() => setLoading(false)}
          onError={() => setLoading(false)}
          decoding="async"
          draggable={false}
        />
      </div>
    </div>,
    document.body
  );
}
