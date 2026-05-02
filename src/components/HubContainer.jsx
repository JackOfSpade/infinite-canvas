import React, { useState, useRef, useCallback } from 'react';
import { Handle, Position } from '@xyflow/react';

export function HubContainer({ 
  hubState, 
  theme = 'blue', // 'blue' | 'amber' 
  width = 260, 
  height, 
  minHeight = 140,
  onDrop,
  extras,
  children 
}) {
  const isProcessing = !['empty', 'done', 'priced', 'error'].includes(hubState);

  // Counter-based drag tracking: prevents flickering when cursor moves over child elements,
  // since each child fires its own dragenter/dragleave events.
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    dragCounterRef.current = 0;
    setIsDragOver(false);
    onDrop?.(e);
  }, [onDrop]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const getContainerClasses = () => {
    let classes = 'relative z-10 rounded-xl border-2 transition-all duration-300 ease-in-out pointer-events-auto ';

    if (isDragOver) {
      // Drag-over: highlight border + subtle tinted background
      classes += 'border-solid ';
      if (theme === 'blue')  classes += 'border-blue-400/80 bg-blue-500/10';
      if (theme === 'amber') classes += 'border-amber-400/80 bg-amber-500/10';
      return classes;
    }

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

  const isBlue  = theme === 'blue';
  const chipLabel = isBlue ? 'Drop resume' : 'Drop photos';
  const chipIcon  = isBlue ? '📄' : '📷';

  return (
    <div className="relative group" style={{ overflow: 'visible' }}>
      <Handle type="target" position={Position.Top} id="top" className={`w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity ${isBlue ? 'bg-blue-400' : 'bg-emerald-400'}`} />
      <Handle type="target" position={Position.Left} id="left" className={`w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity ${isBlue ? 'bg-blue-400' : 'bg-emerald-400'}`} />

      {/* Animated glow ring during processing */}
      {isProcessing && (
        <div
          className="absolute -inset-[2px] rounded-xl processing-border opacity-50 -z-10"
          style={{ filter: 'blur(4px)' }}
        />
      )}

      {/* Drag-over outer glow halo */}
      {isDragOver && (
        <div
          className="absolute -inset-[3px] rounded-[14px] -z-10 pointer-events-none"
          style={{
            boxShadow: isBlue
              ? '0 0 0 2px rgba(96,165,250,0.7), 0 0 28px rgba(96,165,250,0.25)'
              : '0 0 0 2px rgba(251,191,36,0.7),  0 0 28px rgba(251,191,36,0.25)',
          }}
        />
      )}

      <div 
        className={getContainerClasses()}
        style={{ width, height, minHeight: height ? undefined : minHeight }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
      >
        {/* Floating drop chip — visible only while dragging over */}
        {isDragOver && (
          <div className="absolute inset-x-0 top-0 z-50 flex justify-center -translate-y-1/2 pointer-events-none">
            <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold border backdrop-blur-md shadow-lg ${
              isBlue
                ? 'bg-blue-500/30 border-blue-400/50 text-blue-100'
                : 'bg-amber-500/30 border-amber-400/50 text-amber-100'
            }`}>
              <span>{chipIcon}</span>
              <span>{chipLabel}</span>
            </div>
          </div>
        )}
        {children}
      </div>
      {extras}
      <Handle type="source" position={Position.Right} id="right" className={`w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity ${isBlue ? 'bg-blue-400' : 'bg-emerald-400'}`} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={`w-2 h-2 pointer-events-none group-hover:pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity ${isBlue ? 'bg-blue-400' : 'bg-emerald-400'}`} />
    </div>
  );
}
