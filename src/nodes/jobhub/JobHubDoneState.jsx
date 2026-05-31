import React, { useState } from 'react';
import { JOB_SOURCE_BY_ID } from '../../utils/constants';
import { SlidersHorizontal, X, RefreshCw, Target, MapPin, Bot } from 'lucide-react';
import { useToast } from '../../components/ToastProvider';
import { ScrapeWarningsPanel } from '../../components/ScrapeWarningsPanel';

// e.g. "claude-opus-4-7" → "Opus 4.7", "claude-haiku-4-5-20251001" → "Haiku 4.5"
function formatModelName(model) {
  if (!model || typeof model !== 'string') return null;
  const stripped = model.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
  const parts = stripped.split('-');
  if (parts.length < 2) return stripped;
  const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const version = parts.slice(1).join('.');
  return `${family} ${version}`;
}

export function JobHubDoneState({
  resultCount,
  scrapedCount,
  gatheredCount,
  queryModel = null,
  testMode = false,
  targetCount = 0,
  otherCount = 0,
  sourceFilter,
  toggleSourceFilter,
  resumeSummary,
  locked = false,
  // Filter props
  scoreThreshold = 0,
  setScoreThreshold,
  scoreRangeMin = 0,
  scoreRangeMax = 100,
  // Action props
  onRerun,
  // Search controls (passed back to the hub for next run)
  maxAgeDays = 21,
  setMaxAgeDays,
  preferredLocation = '',
  setPreferredLocation,
  // Target/pivot role input — surfaces on the done state so the user can
  // tweak it before re-running without going back to empty state.
  targetRole = '',
  setTargetRole,
  // Anti-bot signals collected during the search pipeline
  scrapeWarnings = [],
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const { addToast } = useToast();

  // Slider is "active" when the user has nudged it above the dynamic minimum.
  // When min === max, the slider is a no-op and we hide it entirely.
  const sliderUsable = scoreRangeMax > scoreRangeMin;
  const sliderActive = sliderUsable && scoreThreshold > scoreRangeMin;
  const hasActiveFilters = sliderActive || sourceFilter;

  return (
    <div className="flex flex-col items-center py-5 px-3 w-full gap-1">

      {/* Result count */}
      <div className="text-emerald-400 text-2xl font-bold">{testMode ? (scrapedCount ?? 0) : (resultCount || 0)}</div>
      <p className="text-white/40 text-xs">{testMode ? 'jobs collected' : 'jobs matched'}</p>

      {/* Scraped → kept funnel */}
      {(gatheredCount > 0 || scrapedCount > 0) && (
        <p className="text-white/25 text-[10px] mt-0.5">
          {gatheredCount > 0 && scrapedCount != null && gatheredCount !== scrapedCount
            ? `${gatheredCount} scraped → ${scrapedCount} kept`
            : `${gatheredCount || scrapedCount} scraped`}
        </p>
      )}

      {/* AI model used for query generation */}
      {queryModel && (
        <p className="flex items-center gap-1 text-white/20 text-[9px] mt-0.5">
          <Bot size={8} className="shrink-0" />
          {formatModelName(queryModel)}
        </p>
      )}

      {(targetCount > 0 || otherCount > 0) && (
        <p className="text-white/30 text-[10px] mt-0.5">
          {targetCount > 0 && <><span className="text-purple-300/80">{targetCount} target</span></>}
          {targetCount > 0 && otherCount > 0 && <span className="text-white/20"> · </span>}
          {otherCount > 0 && <><span className="text-blue-300/80">{otherCount} other</span></>}
        </p>
      )}

      {/* Anti-bot / throttle warnings collected during the search pipeline. */}
      {scrapeWarnings.length > 0 && (
        <div className="w-full mt-2">
          <ScrapeWarningsPanel warnings={scrapeWarnings} addToast={addToast} />
        </div>
      )}

      {/* Active filter summary pills */}
      <div className="flex flex-wrap justify-center gap-1 mt-1 min-h-[18px]">
        {sourceFilter && (
          <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400/80 text-[9px]">
            {JOB_SOURCE_BY_ID[sourceFilter]?.name || sourceFilter}
            {!locked && (
              <button onClick={() => toggleSourceFilter(sourceFilter)} onPointerDown={(e) => e.stopPropagation()}>
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

      {resumeSummary && (
        <p className="text-white/20 text-[10px] text-center mt-1">{resumeSummary}</p>
      )}

      {!locked && (
        <div className="flex mt-2 w-full">
          <button
            onClick={onRerun}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-full bg-blue-500/15 text-blue-400/80 hover:bg-blue-500/25 text-[10px] transition-colors border border-blue-500/15"
            title="Clear old cards and re-run the search with the same resume"
          >
            <RefreshCw size={9} />
            Re-run Search
          </button>
        </div>
      )}

      {/* Target role + Look back — both feed the next Re-run Search */}
      {!locked && (
        <div className="nodrag w-full mt-2 flex flex-col items-stretch gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5 text-[10px] text-white/40">
            <Target size={10} className="text-purple-300/70 shrink-0" />
            <input
              type="text"
              value={targetRole}
              onChange={(e) => setTargetRole?.(e.target.value)}
              placeholder="Target role (optional)"
              className="flex-1 min-w-0 px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-0.5 focus:outline-none focus:border-purple-400/50 placeholder:text-white/25"
              title="Set or change the role to pivot into. Applies on next Re-run Search."
            />
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-white/40">
            <MapPin size={10} className="text-blue-300/70 shrink-0" />
            <input
              type="text"
              value={preferredLocation}
              onChange={(e) => setPreferredLocation?.(e.target.value)}
              placeholder="Preferred location (optional)"
              className="flex-1 min-w-0 px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-0.5 focus:outline-none focus:border-blue-400/50 placeholder:text-white/25"
              title="Free-text location preference for the next search, e.g. Chicago, remote, Midwest, hybrid in Denver."
            />
          </div>
          <div
            className="flex items-center justify-center gap-1.5 text-[10px] text-white/40"
            title="Maximum posting age (in days) to consider on the next search"
          >
            <span>Look back</span>
            <input
              type="number"
              min={1}
              max={180}
              value={maxAgeDays}
              onChange={(e) => setMaxAgeDays?.(e.target.value)}
              className="w-10 text-center bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-0.5 focus:outline-none focus:border-blue-400/50"
            />
            <span>days</span>
          </div>
        </div>
      )}

      {/* Filter toggle button */}
      {!locked && (
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

          {/* Score threshold — dynamic range based on actually-spawned scores.
              Bottom = "show everything"; top = "show only the highest match".
              Hidden when min===max (single-job lists, or all jobs scored
              identically — a no-op slider would just be noise). */}
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
        </div>
      )}
    </div>
  );
}
