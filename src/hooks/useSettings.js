import { useState, useCallback } from 'react';

const STORAGE_KEY = 'infiniteCanvas.settings';

const DEFAULT_SETTINGS = {
  animationSpeed: 'balanced', // 'snappy' | 'balanced' | 'dramatic'
};

export const ANIMATION_DURATIONS = {
  snappy: 200,
  balanced: 400,
  dramatic: 600,
};

/**
 * Manages persistent application settings via localStorage.
 * Returns { settings, updateSetting, getAnimationDuration }.
 */
export function useSettings() {
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
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

  const getAnimationDuration = useCallback(() => {
    return ANIMATION_DURATIONS[settings.animationSpeed] || ANIMATION_DURATIONS.balanced;
  }, [settings.animationSpeed]);

  return { settings, updateSetting, getAnimationDuration };
}
