import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Settings, Zap, Scale, Sparkles } from 'lucide-react';
import { ANIMATION_DURATIONS } from '../hooks/useSettings';

const SPEED_OPTIONS = [
  { key: 'snappy', label: 'Snappy', desc: `${ANIMATION_DURATIONS.snappy}ms`, icon: Zap, color: 'text-amber-400' },
  { key: 'balanced', label: 'Balanced', desc: `${ANIMATION_DURATIONS.balanced}ms`, icon: Scale, color: 'text-blue-400' },
  { key: 'dramatic', label: 'Dramatic', desc: `${ANIMATION_DURATIONS.dramatic}ms`, icon: Sparkles, color: 'text-purple-400' },
];

/**
 * Application settings panel.
 * Currently contains: animation speed for nested canvas transitions.
 * Styled to match the KeyboardShortcutsPanel aesthetic.
 */
export function SettingsPanel({ isOpen, onClose, settings, updateSetting }) {
  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm confirm-overlay-enter"
      onClick={onClose}
    >
      <div
        className="w-[380px] bg-neutral-900/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden onboarding-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <Settings size={18} className="text-blue-400" />
            <h2 className="text-white text-sm font-semibold">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="text-white/30 hover:text-white/70 transition-colors p-1"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-5">
          {/* Animation Speed */}
          <div>
            <div className="text-white/30 text-[10px] font-semibold uppercase tracking-wider mb-3">
              Animation Speed
            </div>
            <div className="text-white/40 text-[11px] mb-3">
              Controls the speed of nested canvas dive-in / dive-out transitions.
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
                    {isSelected && (
                      <div className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-white/10 flex items-center justify-center">
          <span className="text-white/20 text-[10px]">Settings are saved automatically</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
