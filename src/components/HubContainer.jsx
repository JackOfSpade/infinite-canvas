import React, { useState, useRef, useCallback } from 'react';
import { NodeHandles } from '../nodes/_shared/NodeHandles';
import { resolveHubDropCue } from '../utils/hubDropCue';

export function HubContainer({
  hubState,
  theme = 'blue', // 'blue' | 'amber'
  width = 260,
  height,
  minHeight = 140,
  onDrop,
  dropsBlocked = false,
  verifyProgress = null, // { done: number, total: number } — drives the progress bar while dropsBlocked
  dragHover = null, // { kind: 'accept' | 'reject', label: string } — canvas-node drag feedback
  dropBlockedLabel = null, // short reason shown while dropsBlocked, e.g. 'Already started'
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
    // Bail BEFORE consuming the event. preventDefault/stopPropagation used to
    // run above this check, so a drop that did reach a blocked hub was consumed
    // by a handler that then refused it — the canvas's own handler, which turns
    // any unclaimed file into a plain document node, never saw it and the file
    // vanished outright. A hub that will not take the drop must not eat it
    // either; let it bubble and land as an ordinary node.
    if (dropsBlocked) return;
    e.preventDefault();
    e.stopPropagation(); // prevent canvas from also processing this drop
    onDrop?.(e);
  }, [dropsBlocked, onDrop]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation(); // prevent canvas from overriding our dropEffect
    e.dataTransfer.dropEffect = dropsBlocked ? 'none' : 'copy';
  }, [dropsBlocked]);

  const isBlue  = theme === 'blue';
  const chipIcon  = isBlue ? '📄' : '📷';

  // The one cue this drag paints — border, halo and chip all read it, so they
  // can never disagree about whether the drop will be taken. The accept/refuse
  // policy itself lives in hubDropCue.js, where it is unit-testable.
  const cue = resolveHubDropCue({ dragHover, isDragOver, dropsBlocked, dropBlockedLabel });
  const cueRejects = cue?.kind === 'reject';

  const getContainerClasses = () => {
    let classes = 'relative z-10 rounded-xl border-2 transition-all duration-300 ease-in-out pointer-events-auto ';

    if (cue) {
      classes += 'border-solid ';
      classes += cueRejects
        ? 'border-red-400/80 bg-red-500/10'
        : (isBlue ? 'border-blue-400/80 bg-blue-500/10' : 'border-amber-400/80 bg-amber-500/10');
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

  const chipLabel = cue?.label || (isBlue ? 'Drop career files' : 'Drop photos');

  return (
    <div className="relative group" style={{ overflow: 'visible' }}>
      <NodeHandles className={`w-2 h-2 ${isBlue ? 'bg-blue-400' : 'bg-emerald-400'}`} />

      {/* Animated glow ring during processing */}
      {isProcessing && (
        <div
          className="absolute -inset-[2px] rounded-xl processing-border opacity-50 -z-10"
          style={{ filter: 'blur(4px)' }}
        />
      )}

      {/* Drag-over outer glow halo — red when the drop will be refused */}
      {cue && (
        <div
          className="absolute -inset-[3px] rounded-[14px] -z-10 pointer-events-none"
          style={{
            boxShadow: cueRejects
              ? '0 0 0 2px rgba(248,113,113,0.7), 0 0 28px rgba(248,113,113,0.25)'
              : isBlue
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
        {/* Floating drop chip — states the verdict, including a refusal */}
        {cue && (
          <div className="absolute inset-x-0 top-0 z-50 flex justify-center -translate-y-1/2 pointer-events-none">
            <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold border backdrop-blur-md shadow-lg transition-colors ${
              cueRejects
                ? 'bg-red-500/30 border-red-400/50 text-red-100'
                : isBlue
                  ? 'bg-blue-500/30 border-blue-400/50 text-blue-100'
                  : 'bg-amber-500/30 border-amber-400/50 text-amber-100'
            }`}>
              <span>{cueRejects ? '✕' : chipIcon}</span>
              <span>{chipLabel}</span>
            </div>
          </div>
        )}
        {/* Verification progress bar — thin strip at bottom, animates as each platform clears */}
        {dropsBlocked && verifyProgress && verifyProgress.total > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden rounded-b-xl">
            <div
              className="h-full bg-white/25 transition-[width] duration-500 ease-out"
              style={{ width: `${Math.round((verifyProgress.done / verifyProgress.total) * 100)}%` }}
            />
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
