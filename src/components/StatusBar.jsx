import React from 'react';
import { useViewport } from '@xyflow/react';

/**
 * Minimal status bar showing only the current zoom level.
 */
export const StatusBar = React.memo(function StatusBar() {
  const { zoom } = useViewport();
  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="absolute bottom-2 left-16 z-[60] flex items-center px-3 py-1.5 rounded-full bg-black/30 border border-white/5 select-none">
      <span className="text-[10px] text-white/25 font-mono">{zoomPercent}%</span>
    </div>
  );
});
