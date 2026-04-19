import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * Reusable context menu component.
 *
 * Props:
 *   x, y        — viewport coordinates to render at
 *   items       — array of { label, onClick?, icon?, submenu?: items[], divider?: boolean, danger?: boolean }
 *   onClose     — called when menu should close
 *
 * Submenu hover fix: instead of hiding the submenu the instant the mouse leaves
 * the parent row (which it does when crossing the gap to the submenu panel),
 * we delay the close by 120 ms and cancel it if the mouse enters the submenu.
 */
export function ContextMenu({ x, y, items, onClose }) {
  const [activeSubmenu, setActiveSubmenu] = useState(null);
  const menuRef = useRef(null);
  const closeTimerRef = useRef(null);

  // ── Global dismissal ──────────────────────────────────────────────────────
  useEffect(() => {
    const handlePointerDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // ── Viewport clamping ─────────────────────────────────────────────────────
  const [adjustedPos, setAdjustedPos] = useState({ left: x, top: y });
  const [submenuDirection, setSubmenuDirection] = useState('right');
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const newPos = { left: x, top: y };
      if (rect.right > window.innerWidth)  newPos.left = window.innerWidth  - rect.width  - 8;
      if (rect.bottom > window.innerHeight) newPos.top = window.innerHeight - rect.height - 8;
      // Open submenus to the left when not enough room on the right (submenu ~180px)
      const spaceOnRight = window.innerWidth - (newPos.left + rect.width);
      const rafId = requestAnimationFrame(() => {
        setSubmenuDirection(spaceOnRight >= 192 ? 'right' : 'left');
        setAdjustedPos(newPos);
      });
      return () => cancelAnimationFrame(rafId);
    }
  }, [x, y]);

  // ── Submenu hover helpers (with gap-crossing delay) ───────────────────────
  const openSubmenu = (i) => {
    clearTimeout(closeTimerRef.current);
    setActiveSubmenu(i);
  };
  const scheduleClose = () => {
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setActiveSubmenu(null), 120);
  };
  const cancelClose = () => clearTimeout(closeTimerRef.current);

  useEffect(() => () => clearTimeout(closeTimerRef.current), []);

  // ── Render ────────────────────────────────────────────────────────────────
  return createPortal(
    <div 
      ref={menuRef} 
      className="fixed z-[9999] context-menu-enter" 
      style={{
        ...adjustedPos,
        maxHeight: 'calc(100vh - 20px)',
        overflowY: 'auto'
      }}
    >
      <div className="bg-[#1a1a1a]/95 backdrop-blur-md border border-white/10 rounded-lg shadow-2xl py-1 min-w-[180px] text-white/90 text-sm">
        {items.map((item, i) => {
          if (item.divider) {
            return <div key={i} className="border-t border-white/8 my-1" />;
          }

          const hasSubmenu = item.submenu && item.submenu.length > 0;
          const isDanger = item.label === 'Delete' || item.label === 'Clear Canvas' || item.danger;

          return (
            <div
              key={i}
              className="relative"
              onMouseEnter={() => hasSubmenu && openSubmenu(i)}
              onMouseLeave={() => hasSubmenu && scheduleClose()}
            >
              <button
                className={`w-full text-left px-3 py-1.5 hover:bg-white/8 flex items-center justify-between gap-4 transition-colors ${
                  isDanger ? 'text-red-400 hover:text-red-300' : ''
                } ${item.disabled ? 'opacity-40 cursor-default' : ''}`}
                disabled={item.disabled}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (!hasSubmenu && item.onClick && !item.disabled) {
                    item.onClick();
                    onClose();
                  }
                }}
              >
                <span className="text-[13px]">{item.label}</span>
                {item.shortcut && (
                  <span className="text-white/25 text-[10px] font-mono">{item.shortcut}</span>
                )}
                {hasSubmenu && <span className="text-white/40 text-xs">▸</span>}
              </button>

              {/* Sub-menu — opens right when there is room, left otherwise.
                  onMouseEnter cancels the close timer so moving from parent row
                  into the submenu across the small gap keeps it open. */}
              {hasSubmenu && activeSubmenu === i && (
                <SubmenuPanel
                  items={item.submenu}
                  direction={submenuDirection}
                  onMouseEnter={cancelClose}
                  onMouseLeave={scheduleClose}
                  onClose={onClose}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>,
    document.body
  );
}

/** Internal component to handle sub-menu positioning and clamping */
function SubmenuPanel({ items, direction, onMouseEnter, onMouseLeave, onClose }) {
  const ref = useRef(null);
  const [measured, setMeasured] = useState(false);
  const [verticalOffset, setVerticalOffset] = useState(0);

  useEffect(() => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      let vOffset = 0;
      const overflow = rect.bottom - window.innerHeight;
      if (overflow > 0) {
        // Shift up by the overflow amount plus a small padding
        vOffset = -overflow - 8;
      }
      // Safeguard against shifting off the top of the screen
      if (rect.top + vOffset < 8) {
        vOffset = -rect.top + 8;
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVerticalOffset(vOffset);
      setMeasured(true);
    }
  }, []);

  return (
    <div
      ref={ref}
      className={`absolute top-0 ${direction === 'right' ? 'left-full ml-0.5' : 'right-full mr-0.5'} bg-[#1a1a1a]/95 backdrop-blur-md border border-white/10 rounded-lg shadow-2xl py-1 min-w-[180px] text-white/90 text-sm`}
      style={{ 
        transform: `translateY(${verticalOffset}px)`, 
        opacity: measured ? 1 : 0,
        maxHeight: 'calc(100vh - 20px)',
        overflowY: 'auto'
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {items.map((sub, j) => {
        if (sub.divider) {
          return <div key={j} className="border-t border-white/8 my-1" />;
        }
        return (
          <button
            key={j}
            className={`w-full text-left px-3 py-1.5 hover:bg-white/8 transition-colors ${sub.disabled ? 'opacity-40 cursor-default' : ''}`}
            disabled={sub.disabled}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (sub.onClick && !sub.disabled) {
                sub.onClick();
                onClose();
              }
            }}
          >
            <span className="text-[13px]">{sub.label}</span>
          </button>
        );
      })}
    </div>
  );
}
