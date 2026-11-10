import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { recalibrationBannerText, recalibrationPrompt } from '../utils/modelRecalibration';

// A Claude answer from a model id we never calibrated means every model/effort
// choice needs re-measuring. The bar covers the top of the window and cannot be
// dismissed: only updating CALIBRATED_MODELS in code clears it.
export function ModelRecalibrationBanner() {
  const [status, setStatus] = useState(null);
  const [copyState, setCopyState] = useState('idle');
  const resetTimer = useRef(null);

  useEffect(() => {
    let live = true;
    let unsubscribe = null;
    try {
      const pending = window.electronAPI?.getModelCalibrationStatus?.();
      if (pending && typeof pending.then === 'function') {
        pending.then((next) => { if (live) setStatus(next || null); }, () => {});
      }
    } catch { /* the banner simply stays hidden */ }
    try {
      const result = window.electronAPI?.onModelCalibrationChanged?.((next) => { if (live) setStatus(next || null); });
      if (typeof result === 'function') unsubscribe = result;
    } catch { /* live updates are best-effort */ }
    return () => {
      live = false;
      try { unsubscribe?.(); } catch { /* already gone */ }
    };
  }, []);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const banner = recalibrationBannerText(status);
  if (!banner) return null;

  const copy = async () => {
    try {
      const prompt = recalibrationPrompt(status);
      if (!prompt) return;
      await navigator.clipboard.writeText(prompt);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState('idle'), 2000);
  };

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[2147483000] flex items-start gap-3 bg-red-700 px-4 py-2 text-white shadow-lg"
    >
      <AlertTriangle size={20} className="mt-0.5 shrink-0 text-red-100" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-white">{banner.headline}</div>
        {banner.lines.map((line, index) => (
          <div key={`${index}-${line}`} className="mt-0.5 text-xs leading-snug text-red-50">{line}</div>
        ))}
        <div className="mt-1 text-[11px] leading-snug text-red-100/90">{banner.footer}</div>
      </div>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md border border-white/40 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white hover:bg-white/20"
      >
        {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy prompt'}
      </button>
    </div>
  );
}

export default ModelRecalibrationBanner;
