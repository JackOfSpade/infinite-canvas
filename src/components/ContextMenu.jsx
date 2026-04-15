import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * Reusable context menu component.
 *
 * Props:
 *   x, y        — viewport coordinates to render at
 *   items       — array of { label, onClick?, icon?, submenu?: items[], divider?: boolean, danger?: boolean }
 *   onClose     — called when menu should close
 */
export function ContextMenu({ x, y, items, onClose }) {
  const [activeSubmenu, setActiveSubmenu] = useState(null);
  const menuRef = useRef(null);

  useEffect(() => {
    const handlePointerDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
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

  // Clamp menu within viewport bounds; also track which side has room for submenus.
  const [adjustedPos, setAdjustedPos] = useState({ left: x, top: y });
  const [submenuDirection, setSubmenuDirection] = useState('right');
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const newPos = { left: x, top: y };
      if (rect.right > window.innerWidth) {
        newPos.left = window.innerWidth - rect.width - 8;
      }
      if (rect.bottom > window.innerHeight) {
        newPos.top = window.innerHeight - rect.height - 8;
      }
      // Open submenus to the LEFT when there isn't enough room on the right
      // (submenu min-width is ~180px; use 192 as a safe threshold).
      const spaceOnRight = window.innerWidth - (newPos.left + rect.width);
      setSubmenuDirection(spaceOnRight >= 192 ? 'right' : 'left');
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAdjustedPos(newPos);
    }
  }, [x, y]);

  return createPortal(
    <div ref={menuRef} className="fixed z-[9999] context-menu-enter" style={adjustedPos}>
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
              onMouseEnter={() => hasSubmenu && setActiveSubmenu(i)}
              onMouseLeave={() => hasSubmenu && setActiveSubmenu(null)}
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

              {/* Sub-menu — opens right when space allows, left otherwise */}
              {hasSubmenu && activeSubmenu === i && (
                <div className={`absolute top-0 ${submenuDirection === 'right' ? 'left-full ml-0.5' : 'right-full mr-0.5'} bg-[#1a1a1a]/95 backdrop-blur-md border border-white/10 rounded-lg shadow-2xl py-1 min-w-[180px] text-white/90 text-sm`}>
                  {item.submenu.map((sub, j) => {
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
              )}
            </div>
          );
        })}
      </div>
    </div>,
    document.body
  );
}
