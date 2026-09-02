import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { updateModalCount } from './modalStack';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

/**
 * Reusable context menu component.
 *
 * Props:
 *   x, y        — viewport coordinates to render at
 *   items       — array of { label, onClick?, icon?, divider?: boolean, danger?: boolean }
 *   onClose     — called when menu should close
 */
export function ContextMenu({ x, y, items, onClose }) {
  const menuRef = useRef(null);

  // Register with the global modal stack for as long as this menu is mounted
  // (the parent only mounts it while open — see Canvas.jsx's `{menu && ...}`).
  // Without this, e.g. Backspace to dismiss a context menu could simultaneously
  // delete the canvas selection underneath it.
  useEffect(() => {
    updateModalCount(1);
    return () => updateModalCount(-1);
  }, []);

  // ── Global dismissal ──────────────────────────────────────────────────────
  useEffect(() => {
    const handlePointerDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [onClose]);
  useEscapeToClose((e) => { e.preventDefault(); onClose(); });

  // ── Viewport clamping ─────────────────────────────────────────────────────
  const [adjustedPos, setAdjustedPos] = useState({ left: x, top: y });
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const newPos = { left: x, top: y };
      if (rect.right > window.innerWidth)  newPos.left = window.innerWidth  - rect.width  - 8;
      if (rect.bottom > window.innerHeight) newPos.top = window.innerHeight - rect.height - 8;
      const rafId = requestAnimationFrame(() => setAdjustedPos(newPos));
      return () => cancelAnimationFrame(rafId);
    }
  }, [x, y]);

  // ── Render ────────────────────────────────────────────────────────────────
  return createPortal(
    <div 
      ref={menuRef} 
      className="fixed z-[9999] context-menu-enter" 
      style={adjustedPos}
    >
      <div className="bg-[#1a1a1a]/95 backdrop-blur-md border border-white/10 rounded-lg shadow-2xl py-1 min-w-[180px] text-white/90 text-sm">
        {items.map((item, i) => {
          if (item.divider) {
            return <div key={`div-${i}`} className="border-t border-white/8 my-1" />;
          }

          const isDanger = !!item.danger;
          const itemKey = `${item.label ?? 'item'}-${i}`;

          return (
            <div key={itemKey}>
              <button
                className={`w-full text-left px-3 py-1.5 hover:bg-white/8 flex items-center justify-between gap-4 transition-colors ${
                  isDanger ? 'text-red-400 hover:text-red-300' : ''
                } ${item.disabled ? 'opacity-40 cursor-default' : ''}`}
                disabled={item.disabled}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (e.button !== 0) return;
                  if (item.onClick && !item.disabled) {
                    item.onClick();
                    onClose();
                  }
                }}
              >
                <span className="text-[13px]">{item.label}</span>
                {item.shortcut && (
                  <span className="text-white/25 text-[10px] font-mono">{item.shortcut}</span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>,
    document.body
  );
}
