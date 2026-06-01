import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { updateModalCount } from './modalStack';

/**
 * Reusable floating dialog.
 * - No dark backdrop overlay — canvas stays fully visible.
 * - Clicking outside the dialog closes it (invisible backdrop catch).
 * - Draggable by header; clamped to window bounds so it can't be dragged off-screen.
 * - Escape key closes it.
 *
 * Props:
 *   title    — dialog title string
 *   children — dialog body content
 *   onClose  — called when Escape pressed or outside clicked
 */
export function Dialog({ title, children, onClose }) {
  // null = centered via CSS transform; once dragged, holds { x, y } top-left
  const [pos, setPos] = useState(null);
  const dialogRef = useRef(null);

  const closingRef = useRef(false);

  useEffect(() => {
    updateModalCount(1);
    return () => updateModalCount(-1);
  }, []);

  useEffect(() => {
    const handleKey = (e) => { 
      if (e.key === 'Escape') {
        if (closingRef.current) return;
        closingRef.current = true;
        onClose(); 
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // ── Drag-to-move, clamped to window ──────────────────────────────────────
  const dragListenersRef = useRef(null);
  
  useEffect(() => {
    return () => {
      if (dragListenersRef.current) {
        window.removeEventListener('pointermove', dragListenersRef.current.onMove);
        window.removeEventListener('pointerup', dragListenersRef.current.onUp);
      }
    };
  }, []);

  const handleHeaderPointerDown = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = dialogRef.current?.getBoundingClientRect();
    if (!rect) return;
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;

    const onMove = (ev) => {
      const dRect = dialogRef.current?.getBoundingClientRect();
      const dW = dRect?.width  || 0;
      const dH = dRect?.height || 0;
      const x = Math.max(0, Math.min(window.innerWidth  - dW, ev.clientX - offX));
      const y = Math.max(0, Math.min(window.innerHeight - dH, ev.clientY - offY));
      setPos({ x, y });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onUp);
      dragListenersRef.current = null;
    };
    
    dragListenersRef.current = { onMove, onUp };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup',   onUp);
  };

  const dialogStyle = pos
    ? { position: 'fixed', left: pos.x, top: pos.y, zIndex: 10000 }
    : { position: 'fixed', zIndex: 10000, top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };

  return createPortal(
    <>
      {/* Invisible backdrop — captures outside clicks to dismiss, no visual overlay */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9999 }}
        onPointerDown={(e) => { 
          e.stopPropagation(); 
          if (closingRef.current) return;
          closingRef.current = true;
          onClose(); 
        }}
      />

      {/* Dialog panel */}
      <div
        ref={dialogRef}
        style={dialogStyle}
        className="bg-neutral-900 border border-white/20 rounded-xl shadow-2xl flex flex-col min-w-[220px]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* ── Draggable header ─────────────────────────────────────────────── */}
        {title && (
          <div
            className="px-3 py-2 border-b border-white/10
                       cursor-grab active:cursor-grabbing select-none rounded-t-xl"
            onPointerDown={handleHeaderPointerDown}
          >
            <h3 className="text-white font-medium text-sm">{title}</h3>
          </div>
        )}

        {/* ── Body ─────────────────────────────────────────────────────────── */}
        <div className="p-3 flex flex-col gap-3">
          {children}
        </div>
      </div>
    </>,
    document.body
  );
}
