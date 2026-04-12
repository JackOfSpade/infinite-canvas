import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * Reusable context menu component.
 *
 * Props:
 *   x, y        — viewport coordinates to render at
 *   items       — array of { label, onClick?, submenu?: items[], divider?: boolean }
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
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [onClose]);

  // Ensure menu stays within viewport
  const adjustedStyle = { left: x, top: y };

  return createPortal(
    <div ref={menuRef} className="fixed z-[9999]" style={adjustedStyle}>
      <div className="bg-[#1a1a1a] border border-white/10 rounded-md shadow-2xl py-1 min-w-[160px] text-white/90 text-sm">
        {items.map((item, i) => {
          if (item.divider) {
            return <div key={i} className="border-t border-white/10 my-1" />;
          }

          const hasSubmenu = item.submenu && item.submenu.length > 0;

          return (
            <div
              key={i}
              className="relative"
              onMouseEnter={() => hasSubmenu && setActiveSubmenu(i)}
              onMouseLeave={() => hasSubmenu && setActiveSubmenu(null)}
            >
              <button
                className="w-full text-left px-4 py-2 hover:bg-white/10 flex items-center justify-between gap-4"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (!hasSubmenu && item.onClick) {
                    item.onClick();
                    onClose();
                  }
                }}
              >
                <span>{item.label}</span>
                {hasSubmenu && <span className="text-white/40 text-xs">▸</span>}
              </button>

              {/* Sub-menu */}
              {hasSubmenu && activeSubmenu === i && (
                <div className="absolute left-full top-0 ml-0.5 bg-[#1a1a1a] border border-white/10 rounded-md shadow-2xl py-1 min-w-[180px] text-white/90 text-sm">
                  {item.submenu.map((sub, j) => {
                    if (sub.divider) {
                      return <div key={j} className="border-t border-white/10 my-1" />;
                    }
                    return (
                      <button
                        key={j}
                        className={`w-full text-left px-4 py-2 hover:bg-white/10 ${sub.disabled ? 'opacity-40 cursor-default' : ''}`}
                        disabled={sub.disabled}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          if (sub.onClick && !sub.disabled) {
                            sub.onClick();
                            onClose();
                          }
                        }}
                      >
                        {sub.label}
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
