import { useState, useCallback } from 'react';

const STORAGE_KEY = 'infiniteCanvas.settings';

export const DEFAULT_SHORTCUTS = {
  undo:    { meta: true,  shift: false, alt: false, key: 'z', label: 'Undo' },
  redo:    { meta: true,  shift: true,  alt: false, key: 'z', label: 'Redo' },
  redoAlt: { meta: true,  shift: false, alt: false, key: 'y', label: 'Redo (alt)' },
  search:  { meta: true,  shift: false, alt: false, key: 'f', label: 'Search' },
};

const DEFAULT_SETTINGS = {
  animationSpeed: 'balanced', // 'snappy' | 'balanced' | 'dramatic'
  bgVariant:      'dots',     // 'dots' | 'lines' | 'none'
  showMiniMap:    true,
  penSize:        3,          // stroke width in flow-space pixels
  eraserSize:     15,         // eraser radius in flow-space pixels
  shortcuts:      DEFAULT_SHORTCUTS,
};

export const ANIMATION_DURATIONS = {
  snappy:   200,
  balanced: 400,
  dramatic: 600,
};

/**
 * Manages persistent application settings via localStorage.
 * Returns { settings, updateSetting, resetShortcuts, getAnimationDuration }.
 */
export function useSettings() {
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return DEFAULT_SETTINGS;
      const parsed = JSON.parse(saved);
      // Deep-merge shortcuts so new keys added to DEFAULT_SHORTCUTS get the default value
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        shortcuts: { ...DEFAULT_SHORTCUTS, ...(parsed.shortcuts || {}) },
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const updateSetting = useCallback((key, value) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  }, []);

  /** Update a single shortcut binding. */
  const updateShortcut = useCallback((id, binding) => {
    setSettings(prev => {
      const next = {
        ...prev,
        shortcuts: { ...prev.shortcuts, [id]: { ...prev.shortcuts[id], ...binding } },
      };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  }, []);

  /** Reset all shortcuts back to factory defaults. */
  const resetShortcuts = useCallback(() => {
    setSettings(prev => {
      const next = { ...prev, shortcuts: DEFAULT_SHORTCUTS };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  }, []);

  const getAnimationDuration = useCallback(() => {
    return ANIMATION_DURATIONS[settings.animationSpeed] || ANIMATION_DURATIONS.balanced;
  }, [settings.animationSpeed]);

  return { settings, updateSetting, updateShortcut, resetShortcuts, getAnimationDuration };
}
