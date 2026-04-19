import React from 'react';
import { Handle, Position } from '@xyflow/react';

export function HubContainer({ 
  hubState, 
  theme = 'blue', // 'blue' | 'amber' 
  width = 260, 
  height, 
  minHeight = 140,
  onDrop,
  interactiveStates = [],
  extras,
  children 
}) {
  const isProcessing = !['empty', 'done', 'priced', 'error'].includes(hubState);

  const getContainerClasses = () => {
    let classes = 'relative z-10 rounded-xl border-2 transition-all duration-500 ease-in-out pointer-events-auto ';

    if (hubState === 'empty') {
      classes += 'border-dashed border-white/15 bg-[#111]/90 ';
      if (theme === 'blue') classes += 'hover:border-blue-500/30 hover:bg-blue-500/5';
      if (theme === 'amber') classes += 'hover:border-emerald-500/30 hover:bg-emerald-500/5';
    } else if (hubState === 'error') {
      classes += 'border-solid border-red-500/30 bg-[#1a1a1a]';
    } else if (hubState === 'done' || hubState === 'priced') {
      classes += 'border-solid border-emerald-500/30 bg-[#1a1a1a]';
    } else {
      // Processing states — animated gradient border
      classes += 'border-solid bg-[#1a1a1a] ';
      if (theme === 'blue') classes += 'border-blue-500/30';
      if (theme === 'amber') classes += 'border-amber-500/30';
    }

    return classes;
  };

  return (
    <div className="relative group" style={{ overflow: 'visible' }}>
      <Handle type="target" position={Position.Left} className={`w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity ${theme === 'blue' ? 'bg-blue-400' : 'bg-emerald-400'}`} />

      {/* Animated glow ring during processing */}
      {isProcessing && (
        <div
          className="absolute -inset-[2px] rounded-xl processing-border opacity-50 -z-10"
          style={{ filter: 'blur(4px)' }}
        />
      )}

      <div 
        className={getContainerClasses()}
        style={{ width, height, minHeight: height ? undefined : minHeight }}
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onPointerDown={(e) => { if (interactiveStates.includes(hubState)) e.stopPropagation(); }}
      >
        {children}
      </div>
      {extras}
      <Handle type="source" position={Position.Right} className={`w-2 h-2 opacity-0 group-hover:opacity-100 transition-opacity ${theme === 'blue' ? 'bg-blue-400' : 'bg-emerald-400'}`} />
    </div>
  );
}
