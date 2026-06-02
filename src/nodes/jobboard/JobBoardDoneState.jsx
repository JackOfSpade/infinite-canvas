import React, { useState } from 'react';
import { JOB_SOURCE_BY_ID } from '../../utils/constants';
import { SlidersHorizontal, X, RefreshCw, Trash2, Layers } from 'lucide-react';

/**
 * Done-state UI for the Job Board Module — the display half that used to live on
 * the Job Search Module. Shows the combined result count + the cascade filter
 * controls (score slider, per-source pills) plus Re-combine / Clear. Search-only
 * controls (résumé, location, look-back, re-run) deliberately live on the Job
 * Search Module, not here.
 */
export function JobBoardDoneState({
  resultCount = 0,
  moduleCount = 0,
  locked = false,
  // Score filter
  scoreThreshold = 0,
  setScoreThreshold,
  scoreRangeMin = 0,
  scoreRangeMax = 100,
  // Source filter
  sourceFilter = null,
  toggleSourceFilter,
  sourceCounts = {},
  // Actions
  onRecombine,
  onClear,
  combining = false,
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);

  const sliderUsable = scoreRangeMax > scoreRangeMin;
  const sliderActive = sliderUsable && scoreThreshold > scoreRangeMin;
  const hasActiveFilters = sliderActive || sourceFilter;
  const sources = Object.keys(sourceCounts || {}).sort();

  return (
    <div className="flex flex-col items-center py-5 px-3 w-full gap-1">

      {/* Combined result count */}
      <div className="text-emerald-400 text-2xl font-bold">{resultCount || 0}</div>
      <p className="text-white/40 text-xs">jobs combined</p>

      {moduleCount > 0 && (
        <p className="flex items-center gap-1 text-white/25 text-[10px] mt-0.5">
          <Layers size={9} className="shrink-0" />
          from {moduleCount} search {moduleCount === 1 ? 'module' : 'modules'}
        </p>
      )}

      {/* Active filter summary pills */}
      <div className="flex flex-wrap justify-center gap-1 mt-1 min-h-[18px]">
        {sourceFilter && (
          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400/80 text-[9px]">
            {JOB_SOURCE_BY_ID[sourceFilter]?.name || sourceFilter}
            {!locked && (
              <button onClick={() => toggleSourceFilter?.(sourceFilter)} onPointerDown={(e) => e.stopPropagation()}>
                <X size={8} />
              </button>
            )}
          </span>
        )}
        {sliderActive && (
          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-white/10 text-white/50 text-[9px]">
            ≥{scoreThreshold}%
            {!locked && (
              <button onClick={() => setScoreThreshold?.(scoreRangeMin)} onPointerDown={(e) => e.stopPropagation()}>
                <X size={8} />
              </button>
            )}
          </span>
        )}
      </div>

      {!locked && (
        <div className="flex gap-1 mt-2 w-full">
          <button
            onClick={onRecombine}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={combining}
            className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-full bg-indigo-500/15 text-indigo-300/90 hover:bg-indigo-500/25 disabled:opacity-50 text-[10px] transition-colors border border-indigo-500/15"
            title="Re-pull all connected Job Search modules and rebuild the combined board"
          >
            <RefreshCw size={9} className={combining ? 'animate-spin' : ''} />
            {combining ? 'Combining…' : 'Re-combine'}
          </button>
          <button
            onClick={onClear}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={combining}
            className="nodrag flex items-center justify-center gap-1 px-2 py-1 rounded-full bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70 disabled:opacity-50 text-[10px] transition-colors"
            title="Clear the combined board (keeps the connected search modules)"
          >
            <Trash2 size={9} />
          </button>
        </div>
      )}

      {/* Filter toggle */}
      {!locked && (sliderUsable || sources.length > 1) && (
        <button
          onClick={() => setFiltersOpen(o => !o)}
          onPointerDown={(e) => e.stopPropagation()}
          className={`nodrag mt-2 flex items-center gap-1 px-2 py-1 rounded-full text-[10px] transition-colors ${
            hasActiveFilters
              ? 'bg-blue-500/20 text-blue-400/90 border border-blue-500/20'
              : 'bg-white/5 text-white/35 hover:bg-white/10 hover:text-white/60'
          }`}
        >
          <SlidersHorizontal size={9} />
          {hasActiveFilters ? 'Filters active' : 'Filter cards'}
        </button>
      )}

      {/* Filter panel */}
      {filtersOpen && !locked && (
        <div className="nodrag w-full mt-2 space-y-3 px-1" onPointerDown={(e) => e.stopPropagation()}>

          {sliderUsable && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-white/40">Min score</span>
                <span className="text-white/60 font-medium">
                  {sliderActive ? `≥${scoreThreshold}%` : 'All'}
                </span>
              </div>
              <input
                type="range"
                min={scoreRangeMin}
                max={scoreRangeMax}
                step={1}
                value={scoreThreshold}
                onChange={(e) => setScoreThreshold?.(Number(e.target.value))}
                className="w-full h-1 accent-blue-400 cursor-pointer"
              />
              <div className="flex justify-between text-[8px] text-white/20">
                <span>{scoreRangeMin}%</span>
                <span>{scoreRangeMax}%</span>
              </div>
            </div>
          )}

          {sources.length > 1 && (
            <div className="space-y-1">
              <span className="text-white/40 text-[10px]">Source</span>
              <div className="flex flex-wrap gap-1">
                {sources.map((sid) => (
                  <button
                    key={sid}
                    onClick={() => toggleSourceFilter?.(sid)}
                    onPointerDown={(e) => e.stopPropagation()}
                    className={`px-1.5 py-0.5 rounded-full text-[9px] transition-colors border ${
                      sourceFilter === sid
                        ? 'bg-blue-500/20 text-blue-400/90 border-blue-500/30'
                        : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10 hover:text-white/70'
                    }`}
                  >
                    {JOB_SOURCE_BY_ID[sid]?.name || sid} ({sourceCounts[sid]})
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
