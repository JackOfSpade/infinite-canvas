import React from 'react';
import { useViewport } from '@xyflow/react';
import { HelpCircle } from 'lucide-react';

/**
 * Subtle status bar at the bottom-left of the canvas showing node count, zoom level,
 * and a help button for keyboard shortcuts.
 */
export const StatusBar = React.memo(function StatusBar({ nodeCount, edgeCount, onHelpClick }) {
  const { zoom } = useViewport();
  const zoomPercent = Math.round(zoom * 100);

  return (
    <div className="absolute bottom-2 left-16 z-10 flex items-center gap-3 px-3 py-1.5 rounded-full bg-black/30 border border-white/5 select-none">
      <span className="text-[10px] text-white/25 font-mono">
        {nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}
      </span>
      {edgeCount > 0 && (
        <>
          <span className="text-white/10">·</span>
          <span className="text-[10px] text-white/25 font-mono">
            {edgeCount} {edgeCount === 1 ? 'edge' : 'edges'}
          </span>
        </>
      )}
      <span className="text-white/10">·</span>
      <span className="text-[10px] text-white/25 font-mono">{zoomPercent}%</span>
      <button
        onClick={onHelpClick}
        className="text-white/15 hover:text-white/40 transition-colors"
        title="Keyboard shortcuts (?)"
      >
        <HelpCircle size={12} />
      </button>
    </div>
  );
});
