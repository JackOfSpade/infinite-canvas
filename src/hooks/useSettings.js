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
  lastOpenedWorkspace: null,
  shortcuts:      DEFAULT_SHORTCUTS,
};

export const ANIMATION_DURATIONS = {
  snappy:   200,
  balanced: 400,
  dramatic: 600,
};

/** Persist settings to localStorage without throwing. */
function persist(settings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* noop */ }
}

/**
 * Manages persistent application settings via localStorage.
 * Returns { settings, updateSetting, updateShortcut, resetShortcuts, getAnimationDuration }.
 *
 * NOTE: localStorage writes happen inside state updaters. This is intentional —
 * `persist` uses try/catch and is idempotent (same input → same localStorage state),
 * so React Strict Mode's double-invocation of updaters is harmless here.
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
      persist(next);
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
      persist(next);
      return next;
    });
  }, []);

  /** Reset all shortcuts back to factory defaults. */
  const resetShortcuts = useCallback(() => {
    setSettings(prev => {
      const next = { ...prev, shortcuts: DEFAULT_SHORTCUTS };
      persist(next);
      return next;
    });
  }, []);

  const getAnimationDuration = useCallback(() => {
    return ANIMATION_DURATIONS[settings.animationSpeed] || ANIMATION_DURATIONS.balanced;
  }, [settings.animationSpeed]);

  return { settings, updateSetting, updateShortcut, resetShortcuts, getAnimationDuration };
}
