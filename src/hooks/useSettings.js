import { useState, useCallback, useMemo, useRef } from 'react';

const STORAGE_KEY = 'infiniteCanvas.settings';

export const DEFAULT_SHORTCUTS = {
  undo:    { meta: true,  shift: false, alt: false, key: 'z', label: 'Undo' },
  redo:    { meta: true,  shift: true,  alt: false, key: 'z', label: 'Redo' },
  redoAlt: { meta: true,  shift: false, alt: false, key: 'y', label: 'Redo (alt)' },
  search:  { meta: true,  shift: false, alt: false, key: 'f', label: 'Search' },
  selectTool: { meta: false, shift: false, alt: false, key: 'v', label: 'Select Tool' },
  textTool:   { meta: false, shift: false, alt: false, key: 't', label: 'Text Tool' },
  linkTool:   { meta: false, shift: false, alt: false, key: 'l', label: 'Link Tool' },
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
 * Returns { settings, updateSetting, updateShortcut, resetShortcuts, animationDuration }.
 *
 * Persistence runs outside React state updaters so those updaters remain pure
 * (concurrent/Strict Mode may invoke an updater more than once).
 */
export function useSettings() {
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return DEFAULT_SETTINGS;
      const parsed = JSON.parse(saved);
      const savedSettings = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      const savedShortcuts = savedSettings.shortcuts
        && typeof savedSettings.shortcuts === 'object'
        && !Array.isArray(savedSettings.shortcuts)
        ? savedSettings.shortcuts
        : {};
      // Deep-merge shortcuts so new keys added to DEFAULT_SHORTCUTS get the default value
      return {
        ...DEFAULT_SETTINGS,
        ...savedSettings,
        shortcuts: { ...DEFAULT_SHORTCUTS, ...savedShortcuts },
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  // Keep an eagerly-updated source of truth for batched same-tick changes.
  // Persist immediately (rather than in a passive effect) so a setting changed
  // just before the window closes is not lost.
  const settingsRef = useRef(settings);
  const commitSettings = useCallback((updater) => {
    const next = updater(settingsRef.current);
    settingsRef.current = next;
    setSettings(next);
    persist(next);
  }, []);

  const updateSetting = useCallback((key, value) => {
    commitSettings(prev => ({ ...prev, [key]: value }));
  }, [commitSettings]);

  /** Update a single shortcut binding. */
  const updateShortcut = useCallback((id, binding) => {
    commitSettings(prev => ({
      ...prev,
      shortcuts: { ...prev.shortcuts, [id]: { ...prev.shortcuts[id], ...binding } },
    }));
  }, [commitSettings]);

  /** Reset all shortcuts back to factory defaults. */
  const resetShortcuts = useCallback(() => {
    commitSettings(prev => ({ ...prev, shortcuts: DEFAULT_SHORTCUTS }));
  }, [commitSettings]);

  const animationDuration = useMemo(() => {
    return ANIMATION_DURATIONS[settings.animationSpeed] || ANIMATION_DURATIONS.balanced;
  }, [settings.animationSpeed]);

  return { settings, updateSetting, updateShortcut, resetShortcuts, animationDuration };
}
