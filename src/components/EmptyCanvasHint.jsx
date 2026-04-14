import React from 'react';
import { MousePointerClick, Type, PenTool, Briefcase, Camera } from 'lucide-react';

/**
 * Shows subtle contextual hints when the canvas is empty.
 * Disappears once nodes or drawings exist.
 */
export const EmptyCanvasHint = React.memo(function EmptyCanvasHint({ nodeCount, drawingCount }) {
  if (nodeCount > 0 || drawingCount > 0) return null;

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[1]">
      <div className="flex flex-col items-center gap-5 opacity-40 select-none">
        <MousePointerClick size={36} className="text-white/40" />
        <div className="text-center space-y-1.5">
          <p className="text-white/50 text-sm font-medium">Your canvas is empty</p>
          <p className="text-white/30 text-xs max-w-xs leading-relaxed">
            Double-click to add text · Right-click for menu · Drop files from Finder
          </p>
        </div>
        <div className="flex gap-6 mt-2">
          {[
            { icon: Type, label: 'Text', color: 'text-white/30' },
            { icon: PenTool, label: 'Draw', color: 'text-blue-400/30' },
            { icon: Briefcase, label: 'Jobs', color: 'text-blue-400/30' },
            { icon: Camera, label: 'Sell', color: 'text-emerald-400/30' },
          ].map(({ icon, label, color }) => {
            const IconComponent = icon;
            return (
              <div key={label} className="flex flex-col items-center gap-1">
                <IconComponent size={18} className={color} />
                <span className="text-[9px] text-white/20">{label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
