import React, { useState } from 'react';
import { JOB_SOURCE_BY_ID } from '../../utils/constants';
import { SlidersHorizontal, X, RefreshCw, Trash2, Layers, AlertTriangle } from 'lucide-react';

function summaryCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Done-state summary and cascade filters for the Job Board Module. Search-run
 * selection and queue controls are rendered by the board directly above this
 * summary; source-specific résumé/location/platform settings remain on each
 * connected Job Search module.
 */
export function JobBoardDoneState({
  resultCount = 0,
  moduleCount = 0,
  totalIncoming = 0,
  duplicatesRemoved = 0,
  preferenceFilteredSkipped = 0,
  locationPostingsCollapsed = 0,
  locationVariantGroups = 0,
  stale = false,
  staleReason = '',
  canReplaceWithEmpty = false,
  locked = false,
  // Hiring-fit filter
  scoreThreshold = 0,
  setScoreThreshold,
  scoreRangeMin = 0,
  scoreRangeMax = 100,
  // Source filter
  sourceFilter = null,
  toggleSourceFilter,
  sourceCounts = {},
  // Review bucket: unscored placeholders and scores the evidence-gap rule
  // pulled from above the slider to below it stay visible unless switched off.
  showReviewCards = true,
  setShowReviewCards,
  // Actions
  onRecombine,
  onClear,
  combining = false,
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);

  // The merge counts preference exclusions separately, before totalIncoming.
  const mergeInputPostings = summaryCount(totalIncoming);
  const preferenceExcluded = Math.min(summaryCount(preferenceFilteredSkipped), Number.MAX_SAFE_INTEGER - mergeInputPostings);
  const collectedPostings = mergeInputPostings + preferenceExcluded;
  const duplicatePostings = Math.min(summaryCount(duplicatesRemoved), mergeInputPostings);
  const distinctPostings = mergeInputPostings - duplicatePostings;
  const groupedPostings = Math.min(summaryCount(locationPostingsCollapsed), distinctPostings);
  const locationGroups = Math.min(summaryCount(locationVariantGroups), distinctPostings);

  const sliderUsable = scoreRangeMax > scoreRangeMin;
  const sliderActive = sliderUsable && scoreThreshold > scoreRangeMin;
  const reviewCardsHidden = showReviewCards === false;
  const hasActiveFilters = sliderActive || sourceFilter || reviewCardsHidden;
  const sources = Object.keys(sourceCounts || {}).sort();

  return (
    <div className="flex flex-col items-center py-5 px-3 w-full gap-1">

      {stale ? (
        <>
          {/* Connections changed since the last combine — results are hidden. */}
          <div className="text-white/25 text-2xl font-bold line-through">{resultCount || 0}</div>
          <p className="flex items-center gap-1 text-amber-400/90 text-[11px] font-semibold mt-0.5">
            <AlertTriangle size={11} className="shrink-0" />
            Inputs changed
          </p>
          <p className="text-white/40 text-[10px] text-center leading-snug px-1 mt-0.5">
            {canReplaceWithEmpty
              ? 'Completed searches have no current jobs — clear the old board'
              : `${staleReason ? `${staleReason} — ` : ''}re-combine to update the board`}
          </p>
        </>
      ) : (
        <>
          {/* One card can retain several distinct posting targets. */}
          <div className="text-emerald-400 text-2xl font-bold">{resultCount || 0}</div>
          <p className="text-white/40 text-xs">job cards</p>

          {moduleCount > 0 && (
            <p className="flex items-center gap-1 text-white/25 text-[10px] mt-0.5">
              <Layers size={9} className="shrink-0" />
              from {moduleCount} search {moduleCount === 1 ? 'module' : 'modules'}
            </p>
          )}

          {/* Source targets, preference exclusions, and merge duplicates precede location grouping. */}
          {collectedPostings > 0 && (
            <p className="text-white/25 text-[10px]">
              {collectedPostings} posting target{collectedPostings === 1 ? '' : 's'} collected · {duplicatePostings > 0
                ? `${duplicatePostings} duplicate${duplicatePostings === 1 ? '' : 's'} removed`
                : 'no duplicates'}
              {preferenceExcluded > 0 ? ` · ${preferenceExcluded} excluded by preferences` : ''}
            </p>
          )}
          {groupedPostings > 0 && (
            <p className="text-center text-white/30 text-[10px] leading-snug" data-summary="location-consolidation">
              {distinctPostings} distinct posting targets · {groupedPostings} additional location posting{groupedPostings === 1 ? '' : 's'} grouped
              {locationGroups > 0 ? ` in ${locationGroups} group${locationGroups === 1 ? '' : 's'}` : ''}
            </p>
          )}
        </>
      )}

      {/* Active filter summary pills (irrelevant while stale — cards are hidden) */}
      <div className="flex flex-wrap justify-center gap-1 mt-1 min-h-[18px]">
        {!stale && sourceFilter && (
          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400/80 text-[9px]">
            {JOB_SOURCE_BY_ID[sourceFilter]?.name || sourceFilter}
            {!locked && (
              <button onClick={() => toggleSourceFilter?.(sourceFilter)} onPointerDown={(e) => e.stopPropagation()}>
                <X size={8} />
              </button>
            )}
          </span>
        )}
        {!stale && sliderActive && (
          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-white/10 text-white/50 text-[9px]">
            Hiring fit ≥{scoreThreshold}/100
            {!locked && (
              <button onClick={() => setScoreThreshold?.(scoreRangeMin)} onPointerDown={(e) => e.stopPropagation()}>
                <X size={8} />
              </button>
            )}
          </span>
        )}
        {!stale && reviewCardsHidden && (
          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300/80 text-[9px]">
            Review cards hidden
            {!locked && (
              <button onClick={() => setShowReviewCards?.(true)} onPointerDown={(e) => e.stopPropagation()} aria-label="Show review cards">
                <X size={8} />
              </button>
            )}
          </span>
        )}
      </div>

      {!locked && (
        <div className="flex gap-1 mt-2 w-full">
          {typeof onRecombine === 'function' && (
            <button
              onClick={onRecombine}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={combining}
              className={`nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-full disabled:opacity-50 text-[10px] transition-colors border ${
                stale
                  ? 'bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 border-amber-500/30'
                  : 'bg-indigo-500/15 text-indigo-300/90 hover:bg-indigo-500/25 border-indigo-500/15'
              }`}
              title={canReplaceWithEmpty
                ? 'Replace the hidden previous results with the completed searches’ empty result'
                : 'Reuse saved scored searches, refresh salary research, and rebuild the board without scraping or scoring again'}
            >
              <RefreshCw size={9} className={combining ? 'animate-spin' : ''} />
              {combining ? 'Combining…' : (canReplaceWithEmpty ? 'Clear stale results' : 'Re-combine')}
            </button>
          )}
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
      {!locked && !stale && (sliderUsable || sources.length > 1) && (
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
      {filtersOpen && !locked && !stale && (
        <div className="nodrag w-full mt-2 space-y-3 px-1" onPointerDown={(e) => e.stopPropagation()}>

          {sliderUsable && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-white/40">Min hiring fit</span>
                <span className="text-white/60 font-medium">
                  {sliderActive ? `≥${scoreThreshold}/100` : 'All'}
                </span>
              </div>
              <input
                type="range"
                min={scoreRangeMin}
                max={scoreRangeMax}
                step={1}
                value={scoreThreshold}
                aria-label="Minimum hiring fit"
                onChange={(e) => setScoreThreshold?.(Number(e.target.value))}
                className="w-full h-1 accent-blue-400 cursor-pointer"
              />
              <div className="flex justify-between text-[8px] text-white/20">
                <span>{scoreRangeMin}/100</span>
                <span>{scoreRangeMax}/100</span>
              </div>
            </div>
          )}

          {/* Review bucket. The slider compares one number; these two kinds of
              card carry a number that does not mean "assessed and found low". */}
          <label
            className="flex items-start gap-1.5 text-[10px] text-white/50 cursor-pointer"
            title="Keep two kinds of card visible even below the minimum: jobs the AI never returned a usable score for (shown as Unscored), and jobs whose AI-assigned score was at or above the minimum before the evidence-gap rule lowered it below (shown as Capped). Both carry a badge on the card."
          >
            <input
              type="checkbox"
              className="mt-0.5 accent-amber-400 cursor-pointer"
              checked={showReviewCards !== false}
              aria-label="Keep review cards visible below the minimum"
              onChange={(e) => setShowReviewCards?.(e.target.checked)}
            />
            <span>Keep review cards (Unscored / Capped) visible below the minimum</span>
          </label>

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
