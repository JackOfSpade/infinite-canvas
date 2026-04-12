import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Reusable modal dialog component.
 *
 * Props:
 *   title     — dialog title string
 *   children  — dialog body content
 *   onClose   — called when dialog should close (backdrop click, Escape)
 *   width     — optional tailwind width class (default 'w-80')
 */
export function Dialog({ title, children, onClose, width = 'w-80' }) {
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50"
      onPointerDown={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className={`bg-neutral-900 border border-white/20 p-6 rounded-xl shadow-2xl flex flex-col gap-4 ${width}`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {title && <h3 className="text-white font-medium">{title}</h3>}
        {children}
      </div>
    </div>,
    document.body
  );
}
