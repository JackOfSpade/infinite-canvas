import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Settings, Zap, Scale, Sparkles,
  Grid3x3, Map, Keyboard, RotateCcw, Check
} from 'lucide-react';
import { ANIMATION_DURATIONS, DEFAULT_SHORTCUTS } from '../hooks/useSettings';

const SPEED_OPTIONS = [
  { key: 'snappy',   label: 'Snappy',   desc: `${ANIMATION_DURATIONS.snappy}ms`,   icon: Zap,      color: 'text-amber-400' },
  { key: 'balanced', label: 'Balanced', desc: `${ANIMATION_DURATIONS.balanced}ms`, icon: Scale,    color: 'text-blue-400' },
  { key: 'dramatic', label: 'Dramatic', desc: `${ANIMATION_DURATIONS.dramatic}ms`, icon: Sparkles, color: 'text-purple-400' },
];

const BG_OPTIONS = [
  { key: 'dots',  label: 'Dots' },
  { key: 'lines', label: 'Grid' },
  { key: 'none',  label: 'None' },
];

const isMac = navigator.platform?.includes('Mac');

/** Format a shortcut binding into a human-readable string like ⌘⇧Z */
function formatBinding(binding) {
  if (!binding) return '—';
  const parts = [];
  if (binding.meta)  parts.push(isMac ? '⌘' : 'Ctrl');
  if (binding.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (binding.alt)   parts.push(isMac ? '⌥' : 'Alt');
  parts.push(binding.key.toUpperCase());
  return parts.join(isMac ? '' : '+');
}

/** Inline key-capture widget for a single shortcut. */
function ShortcutRow({ id, binding, onSave, isCapturing, onStartCapture, onCancelCapture }) {
  const label = DEFAULT_SHORTCUTS[id]?.label ?? id;

  // While capturing, listen for the next key combination
  useEffect(() => {
    if (!isCapturing) return;
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Ignore bare modifier presses
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
      onSave(id, {
        meta:  e.metaKey || e.ctrlKey,
        shift: e.shiftKey,
        alt:   e.altKey,
        key:   e.key.toLowerCase(),
        label,
      });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isCapturing, id, label, onSave]);

  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-white/60 text-xs">{label}</span>
      <div className="flex items-center gap-1.5">
        {isCapturing ? (
          <>
            <span className="text-[10px] text-blue-400 animate-pulse font-medium">Press shortcut…</span>
            <button
              onClick={onCancelCapture}
              className="text-white/30 hover:text-white/60 transition p-0.5"
            >
              <X size={12} />
            </button>
          </>
        ) : (
          <button
            onClick={() => onStartCapture(id)}
            className="text-[10px] text-white/40 bg-white/5 border border-white/10 rounded px-2 py-0.5
                       font-mono hover:bg-white/10 hover:text-white/70 transition-all"
          >
            {formatBinding(binding)}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Application settings panel.
 * Sections: Animation Speed, View (background + mini-map), Keyboard Shortcuts.
 */
export function SettingsPanel({ isOpen, onClose, settings, updateSetting, updateShortcut, resetShortcuts }) {
  const [capturingId, setCapturingId] = useState(null);

  // Close on Escape (also cancels capturing)
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        if (capturingId) { setCapturingId(null); return; }
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose, capturingId]);

  // Reset capturing when panel closes
  useEffect(() => { if (!isOpen) setCapturingId(null); }, [isOpen]);

  const handleSaveShortcut = useCallback((id, newBinding) => {
    updateShortcut(id, newBinding);
    setCapturingId(null);
  }, [updateShortcut]);

  if (!isOpen) return null;

  const shortcuts = settings.shortcuts ?? DEFAULT_SHORTCUTS;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm confirm-overlay-enter"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-h-[85vh] bg-neutral-900/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden onboarding-panel flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5">
            <Settings size={18} className="text-blue-400" />
            <h2 className="text-white text-sm font-semibold">Settings</h2>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/70 transition-colors p-1">
            <X size={16} />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="px-6 py-5 space-y-6 overflow-y-auto custom-scrollbar flex-1">

          {/* ── Animation Speed ─────────────────────────────────────── */}
          <div>
            <div className="text-white/30 text-[10px] font-semibold uppercase tracking-wider mb-3">
              Animation Speed
            </div>
            <div className="text-white/40 text-[11px] mb-3">
              Controls nested canvas dive-in / dive-out speed.
            </div>
            <div className="space-y-1.5">
              {SPEED_OPTIONS.map(opt => {
                const Icon = opt.icon;
                const isSelected = settings.animationSpeed === opt.key;
                return (
                  <button
                    key={opt.key}
                    onClick={() => updateSetting('animationSpeed', opt.key)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all ${
                      isSelected
                        ? 'bg-white/10 border border-white/15'
                        : 'bg-white/[0.02] border border-transparent hover:bg-white/[0.06] hover:border-white/10'
                    }`}
                  >
                    <div className={`p-1.5 rounded-md ${isSelected ? 'bg-white/10' : 'bg-white/5'}`}>
                      <Icon size={14} className={isSelected ? opt.color : 'text-white/30'} />
                    </div>
                    <div className="flex-1 text-left">
                      <div className={`text-xs font-medium ${isSelected ? 'text-white' : 'text-white/50'}`}>
                        {opt.label}
                      </div>
                    </div>
                    <span className={`text-[10px] font-mono ${isSelected ? 'text-white/50' : 'text-white/20'}`}>
                      {opt.desc}
                    </span>
                    {isSelected && <div className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="w-full h-px bg-white/[0.06]" />

          {/* ── View ────────────────────────────────────────────────── */}
          <div>
            <div className="text-white/30 text-[10px] font-semibold uppercase tracking-wider mb-3">
              View
            </div>

            {/* Background Pattern */}
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <Grid3x3 size={13} className="text-white/30" />
                <span className="text-white/50 text-xs">Background Pattern</span>
              </div>
              <div className="flex gap-1.5">
                {BG_OPTIONS.map(opt => {
                  const isSelected = (settings.bgVariant ?? 'dots') === opt.key;
                  return (
                    <button
                      key={opt.key}
                      onClick={() => updateSetting('bgVariant', opt.key)}
                      className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                        isSelected
                          ? 'bg-indigo-500/30 border border-indigo-500/50 text-indigo-300'
                          : 'bg-white/[0.03] border border-white/[0.06] text-white/35 hover:bg-white/[0.07] hover:text-white/60'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* MiniMap */}
            <button
              onClick={() => updateSetting('showMiniMap', !(settings.showMiniMap ?? true))}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all ${
                (settings.showMiniMap ?? true)
                  ? 'bg-white/10 border border-white/15'
                  : 'bg-white/[0.02] border border-transparent hover:bg-white/[0.06] hover:border-white/10'
              }`}
            >
              <Map size={14} className={(settings.showMiniMap ?? true) ? 'text-indigo-400' : 'text-white/30'} />
              <div className="flex-1 text-left">
                <div className={`text-xs font-medium ${(settings.showMiniMap ?? true) ? 'text-white' : 'text-white/50'}`}>
                  Show MiniMap
                </div>
              </div>
              {(settings.showMiniMap ?? true) && <div className="w-2 h-2 rounded-full bg-indigo-400 shrink-0" />}
            </button>
          </div>

          <div className="w-full h-px bg-white/[0.06]" />

          {/* ── Keyboard Shortcuts ───────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Keyboard size={13} className="text-white/30" />
                <span className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">
                  Keyboard Shortcuts
                </span>
              </div>
              <button
                onClick={resetShortcuts}
                className="flex items-center gap-1 text-[10px] text-white/30 hover:text-white/60 transition-colors px-2 py-0.5 rounded border border-white/10 hover:border-white/20"
              >
                <RotateCcw size={10} />
                Reset
              </button>
            </div>

            <div className="text-white/30 text-[11px] mb-3">
              Click a shortcut key to rebind it. Press the new key combination to save.
            </div>

            {/* Customizable shortcuts */}
            <div className="space-y-0.5 mb-4">
              {Object.keys(DEFAULT_SHORTCUTS).map(id => (
                <ShortcutRow
                  key={id}
                  id={id}
                  binding={shortcuts[id]}
                  isCapturing={capturingId === id}
                  onStartCapture={setCapturingId}
                  onCancelCapture={() => setCapturingId(null)}
                  onSave={handleSaveShortcut}
                />
              ))}
            </div>

            {/* Read-only reference shortcuts */}
            <div className="text-white/20 text-[10px] font-semibold uppercase tracking-wider mb-2">
              System Shortcuts
            </div>
            <div className="space-y-0.5">
              {[
                { keys: 'Double-click',            desc: 'Add text node' },
                { keys: 'Right-click',             desc: 'Context menu' },
                { keys: 'Delete / ⌫',             desc: 'Delete selected' },
                { keys: 'Escape',                  desc: 'Cancel placement' },
                { keys: `${isMac ? '⌘' : 'Ctrl+'}S`, desc: 'Save canvas' },
                { keys: `${isMac ? '⌘' : 'Ctrl+'}O`, desc: 'Open canvas' },
                { keys: `${isMac ? '⌘⇧' : 'Ctrl+Shift+'}E`, desc: 'Export PNG' },
                { keys: `${isMac ? '⌘' : 'Ctrl+'}F`, desc: 'Search' },
                { keys: '?',                       desc: 'Open settings' },
              ].map(s => (
                <div key={s.desc} className="flex items-center justify-between py-1">
                  <span className="text-white/40 text-xs">{s.desc}</span>
                  <kbd className="text-[10px] text-white/30 bg-white/5 border border-white/10 rounded px-2 py-0.5 font-mono">
                    {s.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-white/10 flex items-center justify-center shrink-0">
          <span className="text-white/20 text-[10px]">Settings are saved automatically</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
