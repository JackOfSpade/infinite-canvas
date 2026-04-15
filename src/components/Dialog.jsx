import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Reusable floating dialog — no backdrop overlay, draggable by header.
 *
 * Props:
 *   title    — dialog title string
 *   children — dialog body content
 *   onClose  — called when Escape pressed or × clicked
 */
export function Dialog({ title, children, onClose }) {
  // null = centered via CSS transform; once dragged, holds absolute {x,y}
  const [pos, setPos] = useState(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // ── Drag-to-move via header ───────────────────────────────────────────────
  const handleHeaderPointerDown = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = dialogRef.current?.getBoundingClientRect();
    if (!rect) return;
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;

    const onMove = (ev) => {
      setPos({ x: ev.clientX - offX, y: ev.clientY - offY });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const dialogStyle = pos
    ? { position: 'fixed', left: pos.x, top: pos.y, zIndex: 10000 }
    : { position: 'fixed', zIndex: 10000, top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };

  return createPortal(
    <div
      ref={dialogRef}
      style={dialogStyle}
      className="bg-neutral-900 border border-white/20 rounded-xl shadow-2xl flex flex-col min-w-[240px]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* ── Draggable header ─────────────────────────────────────────────── */}
      {title && (
        <div
          className="flex items-center justify-between px-4 py-2.5 border-b border-white/10
                     cursor-grab active:cursor-grabbing select-none rounded-t-xl"
          onPointerDown={handleHeaderPointerDown}
        >
          <h3 className="text-white font-medium text-sm">{title}</h3>
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="text-white/40 hover:text-white/80 transition-colors ml-4 text-base leading-none"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="p-4 flex flex-col gap-4">
        {children}
      </div>
    </div>,
    document.body
  );
}
