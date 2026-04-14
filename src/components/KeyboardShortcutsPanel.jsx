import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Keyboard } from 'lucide-react';

const isMac = navigator.platform?.includes('Mac');
const mod = isMac ? '⌘' : 'Ctrl';

const SHORTCUT_GROUPS = [
  {
    title: 'Canvas',
    shortcuts: [
      { keys: `Double-click`, desc: 'Add text node' },
      { keys: `Right-click`, desc: 'Context menu' },
      { keys: `Shift + drag`, desc: 'Box select' },
      { keys: `Scroll`, desc: 'Zoom in/out' },
      { keys: `Delete / ⌫`, desc: 'Delete selected' },
      { keys: `Escape`, desc: 'Cancel placement / exit editing' },
    ],
  },
  {
    title: 'File',
    shortcuts: [
      { keys: `${mod} + S`, desc: 'Save workspace' },
      { keys: `${mod} + O`, desc: 'Open workspace' },
    ],
  },
  {
    title: 'Edit',
    shortcuts: [
      { keys: `${mod} + Z`, desc: 'Undo' },
      { keys: `${mod} + Shift + Z`, desc: 'Redo' },
      { keys: `${mod} + Y`, desc: 'Redo (alt)' },
    ],
  },
  {
    title: 'Search',
    shortcuts: [
      { keys: `Enter`, desc: 'Find next match (in search bar)' },
    ],
  },
];

/**
 * Keyboard shortcuts reference panel.
 * Toggled with the "?" key or via the help button in the toolbar.
 */
export function KeyboardShortcutsPanel({ isOpen, onClose }) {
  // Close on Escape when panel is open
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKey);
      return () => window.removeEventListener('keydown', handleKey);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[420px] bg-neutral-900/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <Keyboard size={18} className="text-blue-400" />
            <h2 className="text-white text-sm font-semibold">Keyboard Shortcuts</h2>
          </div>
          <button
            onClick={onClose}
            className="text-white/30 hover:text-white/70 transition-colors p-1"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-5 max-h-[60vh] overflow-y-auto custom-scrollbar">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="text-white/30 text-[10px] font-semibold uppercase tracking-wider mb-2">
                {group.title}
              </div>
              <div className="space-y-1.5">
                {group.shortcuts.map((s) => (
                  <div key={s.desc} className="flex items-center justify-between py-1">
                    <span className="text-white/60 text-xs">{s.desc}</span>
                    <kbd className="text-[10px] text-white/40 bg-white/5 border border-white/10 rounded px-2 py-0.5 font-mono">
                      {s.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-white/10 flex items-center justify-center">
          <span className="text-white/20 text-[10px]">
            Press <kbd className="text-white/30 bg-white/5 border border-white/10 rounded px-1.5 py-0.5 font-mono text-[10px] mx-1">?</kbd> to toggle this panel
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * Hook to manage keyboard shortcuts panel state.
 * Returns { isOpen, toggle, open, close } + listens for "?" key to toggle.
 */
export function useKeyboardShortcuts() {
  const [isOpen, setIsOpen] = useState(false);

  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    const handleKey = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return { isOpen, toggle, open, close };
}
