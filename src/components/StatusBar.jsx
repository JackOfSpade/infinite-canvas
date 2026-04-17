import React from 'react';
import { useStore } from '@xyflow/react';

const zoomSelector = (s) => s.transform[2];

/**
 * Minimal status bar showing only the current zoom level.
 * Optimized via useStore selector to avoid re-rendering 60 times a second during panning.
 */
export const StatusBar = React.memo(function StatusBar() {
  const zoom = useStore(zoomSelector);
  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="absolute bottom-2 left-16 z-[60] flex items-center px-3 py-1.5 rounded-full bg-black/30 border border-white/5 select-none">
      <span className="text-[10px] text-white/25 font-mono">{zoomPercent}%</span>
    </div>
  );
});
