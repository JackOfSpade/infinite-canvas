import React, { useSyncExternalStore } from 'react';
import { useStore } from '@xyflow/react';
import { Loader2 } from 'lucide-react';
import { isAutosaveActive, subscribeAutosaveActive } from '../utils/saveActivity';

const zoomSelector = (s) => s.transform[2];

/**
 * Minimal status bar: the current zoom level, plus a spinner while an
 * auto-save runs so a brief pause on a large canvas has a visible reason.
 * Optimized via useStore selector to avoid re-rendering 60 times a second during panning.
 */
export const StatusBar = React.memo(function StatusBar() {
  const zoom = useStore(zoomSelector);
  const zoomPercent = Math.round(zoom * 100);
  const saving = useSyncExternalStore(subscribeAutosaveActive, isAutosaveActive);

  return (
    <div className="absolute bottom-2 left-16 z-[60] flex items-center gap-2 select-none">
      <div className="flex items-center px-3 py-1.5 rounded-full bg-black/30 border border-white/5">
        <span className="text-[10px] text-white/25 font-mono">{zoomPercent}%</span>
      </div>
      {saving && (
        <div
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/60 border border-white/10"
          data-testid="autosave-indicator"
          role="status"
        >
          <Loader2 size={12} className="animate-spin text-emerald-400" />
          <span className="text-[10px] text-white/70">Saving… the canvas may pause for a moment</span>
        </div>
      )}
    </div>
  );
});
