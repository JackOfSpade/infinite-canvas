import React, { useState } from 'react';
import { JOB_SOURCE_BY_ID } from '../../utils/constants';
import { SlidersHorizontal, X, RefreshCw, Trash2, Layers, AlertTriangle } from 'lucide-react';
import { BOARD_STAGES } from './boardStageRerun';

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
  closedCardCount = 0,
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
  scanning = false,
  onRefreshOfficialPostings,
  onRetryIncompleteOfficialPostings,
  incompleteOfficialLookups = 0,
  onCancelOfficialPostingRefresh,
  officialPostingRefreshing = false,
  officialPostingProgress = null,
  brokenSourceNotices = [],
  researchRemoved,
  boardPreferenceChecked,
  boardPreferenceRemoved,
  onRerunStage,
  onCancelStageRerun,
  stageRerunning = false,
  stageRerunProgress = null,
  salaryNeedsRefresh = false,
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const actionsBusy = combining || scanning || officialPostingRefreshing || stageRerunning;

  // The merge counts preference exclusions separately, before totalIncoming.
  const mergeInputPostings = summaryCount(totalIncoming);
  const legacyExcluded = Math.min(summaryCount(preferenceFilteredSkipped), Number.MAX_SAFE_INTEGER - mergeInputPostings);
  const mergeDuplicates = Math.min(summaryCount(duplicatesRemoved), mergeInputPostings);
  const distinctPostings = mergeInputPostings - mergeDuplicates;
  // Board preferences check every Search's saved candidates, counted once per job, so that total opens the summary
  // and what's left after its removals are the distinct rows the merge produced.
  const boardChecked = summaryCount(boardPreferenceChecked);
  const preferenceExcluded = boardChecked ? Math.min(summaryCount(boardPreferenceRemoved), boardChecked) : legacyExcluded;
  const collectedPostings = boardChecked || mergeInputPostings + legacyExcluded;
  const duplicatePostings = boardChecked ? Math.max(0, boardChecked - preferenceExcluded - distinctPostings) : mergeDuplicates;
  const removedByResearch = summaryCount(researchRemoved);
  const retryableLookups = summaryCount(incompleteOfficialLookups);
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
          <div className="text-emerald-400 text-2xl font-bold">{Math.max(0, (resultCount || 0) - closedCardCount)}</div>
          <p className="text-white/40 text-xs">job cards</p>
          {closedCardCount > 0 && (
            <p className="text-white/25 text-[10px] mt-0.5">{closedCardCount} closed {closedCardCount === 1 ? 'job' : 'jobs'} hidden</p>
          )}

          {moduleCount > 0 && (
            <p className="flex items-center gap-1 text-white/25 text-[10px] mt-0.5">
              <Layers size={9} className="shrink-0" />
              from {moduleCount} search {moduleCount === 1 ? 'module' : 'modules'}
            </p>
          )}

          {/* Source targets, preference exclusions, and merge duplicates precede location grouping. */}
          {collectedPostings > 0 && (
            <p className="text-white/25 text-[10px]">
              {collectedPostings} posting target{collectedPostings === 1 ? '' : 's'} collected{duplicatePostings > 0
                ? ` · ${duplicatePostings} duplicate${duplicatePostings === 1 ? '' : 's'} removed`
                : boardChecked ? '' : ' · no duplicates'}
              {preferenceExcluded > 0 ? ` · ${preferenceExcluded} excluded by preferences` : ''}
              {removedByResearch > 0 ? ` · ${removedByResearch} removed after research` : ''}
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

      {brokenSourceNotices.map(notice => (
        <div key={notice} role="alert" className="mt-2 w-full rounded-md border border-red-400/40 bg-red-500/10 px-2 py-1.5 text-[10px] leading-snug text-red-200">
          <span className="font-semibold">Search results look broken.</span> {notice}. This Board may be missing jobs from that site. Send a bug report.
        </div>
      ))}

      {!locked && !stale && !officialPostingRefreshing && onRetryIncompleteOfficialPostings && retryableLookups > 0 && (
        <button
          onClick={() => onRetryIncompleteOfficialPostings()}
          onPointerDown={event => event.stopPropagation()}
          disabled={actionsBusy}
          className="nodrag mt-2 w-full rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-1 text-[10px] text-amber-200/90 hover:bg-amber-500/25 disabled:opacity-50"
          title="Check only the cards whose official posting lookup is unfinished, in place. Keeps finished lookups, applications, notes and scores, and does not rebuild the board. Re-combine applies any score or duplicate changes afterwards. A job with no conclusion after two full lookups is finished and no longer counts here; Recheck all or the card's Check again tries it anyway."
        >
          Retry {retryableLookups} incomplete lookup{retryableLookups === 1 ? '' : 's'}
        </button>
      )}

      {!locked && (onRefreshOfficialPostings || officialPostingRefreshing) && (
        <div className="mt-2 flex w-full items-center gap-1">
          <button
            onClick={() => onRefreshOfficialPostings()}
            onPointerDown={event => event.stopPropagation()}
            disabled={actionsBusy}
            className="nodrag flex-1 rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-1 text-[10px] text-sky-200/90 hover:bg-sky-500/20 disabled:opacity-50"
            title="Research every eligible card's official posting again, including finished lookups, jobs with no confirmed posting and collapsed cards. Keeps applications, notes and scores."
          >
            {officialPostingRefreshing
              ? officialPostingProgress?.recovering ? 'Lookup needs cancellation'
                : officialPostingProgress?.stopping ? 'Stopping lookup…'
                : officialPostingProgress?.queued ? 'Lookup queued…'
                  : `Checking postings ${officialPostingProgress?.completed || 0}/${officialPostingProgress?.total || 0}`
              : 'Recheck all official postings'}
          </button>
          {officialPostingRefreshing && (
            <button onClick={onCancelOfficialPostingRefresh} onPointerDown={event => event.stopPropagation()}
              disabled={officialPostingProgress?.stopping}
              className="nodrag rounded-full bg-white/10 px-2 py-1 text-[10px] text-white/60 disabled:opacity-50">
              Cancel
            </button>
          )}
        </div>
      )}

      {/* A running step keeps its Cancel even if the board turns stale or locked meanwhile. */}
      {(stageRerunning || (!locked && !stale && onRerunStage)) && (
        <div className="mt-2 w-full">
          <div className="mb-1 text-center text-[9px] uppercase tracking-wider text-white/30">Redo one step only</div>
          {stageRerunning ? (
            <div className="flex w-full items-center gap-1">
              <div className="flex-1 truncate rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-1 text-center text-[10px] text-violet-200/90">
                {stageRerunProgress?.recovering ? `${BOARD_STAGES[stageRerunProgress.stage]?.label || 'Board step'} still running`
                  : stageRerunProgress?.stopping ? 'Stopping…'
                  : stageRerunProgress?.queued ? 'Queued…'
                    : stageRerunProgress?.total ? `${BOARD_STAGES[stageRerunProgress.stage]?.progressLabel || 'Working'} ${stageRerunProgress.completed || 0}/${stageRerunProgress.total}`
                      : stageRerunProgress?.label || `${BOARD_STAGES[stageRerunProgress?.stage]?.progressLabel || 'Working'}…`}
              </div>
              <button onClick={onCancelStageRerun} onPointerDown={event => event.stopPropagation()}
                disabled={stageRerunProgress?.stopping}
                className="nodrag rounded-full bg-white/10 px-2 py-1 text-[10px] text-white/60 disabled:opacity-50">
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex w-full gap-1">
              {[
                ['compensation', salaryNeedsRefresh,
                  'Redo only the salary research and desired-salary guidance on the current cards. Use after a career-data or salary-method change. Official postings, listing checks, scores and grouping stay as they are.'],
                ['listings', false,
                  'Redo only the listing checks on the current cards: closed listings, duplicates of the same official posting, a rescore where the official text changed, and company preference research. Removes closed or duplicate cards (never ones with an application) and regroups only if something moved. Does not look up official postings again or redo salary.'],
                ['regroup', false,
                  'Redo only the grouping into hiring-fit, salary and role groups for the current cards. Card contents are not changed.'],
              ].map(([stage, highlight, title]) => (
                <button key={stage}
                  onClick={() => onRerunStage(stage)}
                  onPointerDown={event => event.stopPropagation()}
                  disabled={actionsBusy}
                  title={title}
                  className={`nodrag flex-1 rounded-full border px-1.5 py-1 text-[10px] disabled:opacity-50 ${highlight
                    ? 'border-amber-500/30 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                    : 'border-violet-500/20 bg-violet-500/10 text-violet-200/90 hover:bg-violet-500/20'}`}
                >
                  {BOARD_STAGES[stage].button}
                </button>
              ))}
            </div>
          )}
          {salaryNeedsRefresh && !stageRerunning && (
            <div className="mt-1 text-center text-[9px] text-amber-200/70">Salary analysis is out of date. Redo Salary instead of a full Re-combine.</div>
          )}
        </div>
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
              disabled={actionsBusy}
              className={`nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-full disabled:opacity-50 text-[10px] transition-colors border ${
                stale
                  ? 'bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 border-amber-500/30'
                  : 'bg-indigo-500/15 text-indigo-300/90 hover:bg-indigo-500/25 border-indigo-500/15'
              }`}
              title={canReplaceWithEmpty
                ? 'Replace the hidden previous results with the completed searches’ empty result'
                : 'Reuse saved scored searches, recheck outdated official postings, refresh salary research, and rebuild the board without another job-board search or scoring pass'}
            >
              <RefreshCw size={9} className={combining || scanning ? 'animate-spin' : ''} />
              {combining ? 'Combining…' : scanning ? 'Scanning…' : (canReplaceWithEmpty ? 'Clear stale results' : 'Re-combine')}
            </button>
          )}
          <button
            onClick={onClear}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={actionsBusy}
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
