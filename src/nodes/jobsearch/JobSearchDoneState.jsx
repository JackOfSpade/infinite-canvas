import React from 'react';
import { RefreshCw, Target, Bot, LayoutGrid } from 'lucide-react';
import { useToast } from '../../components/ToastProvider';
import { ScrapeWarningsPanel } from '../../components/ScrapeWarningsPanel';
import { JobCollectionLimitsControl } from '../../components/JobCollectionLimitsControl';
import { JobPlatformSelectionControl } from '../../components/JobPlatformSelectionControl';
import { JobSearchLocationFields } from '../../components/JobSearchLocationFields';

// e.g. "claude-opus-4-8" → "Opus 4.8", "claude-haiku-4-5-20251001" → "Haiku 4.5"
function formatModelName(model) {
  if (!model || typeof model !== 'string') return null;
  const stripped = model.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
  const parts = stripped.split('-');
  if (parts.length < 2) return stripped;
  const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const version = parts.slice(1).join('.');
  return `${family} ${version}`;
}

export function JobSearchDoneState({
  resultCount,
  scrapedCount,
  gatheredCount,
  queryModel = null,
  aiSkipped = false,
  collectionOnly = false,
  testMode = false,
  resumeSummary,
  locked = false,
  // Action props
  onRerun,
  // Reassesses the saved listings only; it does not scrape or run the
  // duplicate/seen-job search path again.
  onReanalyze = null,
  // Optional: drop the hub's career files (keeping its search settings) so fresh
  // ones can be dropped on the same module. The hub rests here after every
  // successful run, so without this the action is only reachable by burning a
  // full Re-run + Reset just to get back to the empty state.
  onClearCareerFiles = null,
  // Search controls (passed back to the hub for next run)
  maxAgeDays = 21,
  setMaxAgeDays,
  collectionLimits,
  setCollectionLimits,
  enabledSourceIds,
  setEnabledSourceIds,
  availableSourceIds,
  searchLocation,
  setSearchLocation,
  remoteResidences,
  setRemoteResidence,
  // Target/pivot role input — surfaces on the done state so the user can
  // tweak it before re-running without going back to empty state.
  targetRole = '',
  setTargetRole,
  // Anti-bot signals collected during the search pipeline
  scrapeWarnings = [],
  // A completed run with no eligible results replaces the old result set.
  rerunOutcome = null,
}) {
  const { addToast } = useToast();
  // `testMode` is retained only for old persisted hubs. New runs record the
  // actual scoring behavior through `aiSkipped` / `collectionOnly`.
  const skippedAi = aiSkipped || collectionOnly || testMode;
  const count = skippedAi ? (scrapedCount ?? 0) : (resultCount || 0);
  const noNewResults = rerunOutcome === 'no-new-results';

  return (
    <div className="flex flex-col items-center py-5 px-3 w-full gap-1">

      {/* Result count */}
      <div className="text-emerald-400 text-2xl font-bold">{count}</div>
      <p className="text-white/40 text-xs">
        {noNewResults ? 'new jobs' : skippedAi ? 'jobs collected' : 'jobs scored'}
      </p>

      {/* Keep the current run's collection total visible even when no jobs
          survive into the new result set. */}
      {(gatheredCount > 0 || scrapedCount > 0) && (
        <p className="text-white/25 text-[10px] mt-0.5">
          {noNewResults
            ? `${gatheredCount || scrapedCount} scraped`
            : gatheredCount > 0 && scrapedCount != null && gatheredCount !== scrapedCount
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

      {/* The results cascade now lives on the Job Board Module — point the user there. */}
      {count > 0 && (
        <div className="flex items-start gap-1.5 mt-2 px-2 py-1.5 rounded-md bg-indigo-500/10 border border-indigo-500/15 w-full">
          <LayoutGrid size={11} className="text-indigo-300/70 shrink-0 mt-0.5" />
          <p className="text-indigo-200/70 text-[10px] leading-snug">
            Connect a <span className="font-medium">Job Board Module</span> to view & merge these results.
          </p>
        </div>
      )}

      {/* Anti-bot / throttle warnings collected during the search pipeline. */}
      {scrapeWarnings.length > 0 && (
        <div className="w-full mt-2">
          <ScrapeWarningsPanel warnings={scrapeWarnings} addToast={addToast} />
        </div>
      )}

      {resumeSummary && (
        <p className="text-white/20 text-[10px] text-center mt-1">{resumeSummary}</p>
      )}

      {!locked && (
        <div className="flex flex-col mt-2 w-full gap-1">
          {onReanalyze && (
            <button
              onClick={onReanalyze}
              onPointerDown={(e) => e.stopPropagation()}
              className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-full bg-violet-500/15 text-violet-300/90 hover:bg-violet-500/25 text-[10px] transition-colors border border-violet-500/20"
              title="Re-score the displayed jobs with the saved career profile; does not search or scrape again"
            >
              <RefreshCw size={9} />
              Re-analyze Hiring Fit
            </button>
          )}
          <button
            onClick={onRerun}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-full bg-blue-500/15 text-blue-400/80 hover:bg-blue-500/25 text-[10px] transition-colors border border-blue-500/15"
            title="Clear old results and re-run the search with the same resume"
          >
            <RefreshCw size={9} />
            Re-run Search
          </button>
        </div>
      )}

      {/* Deliberately a bare text link, not a second pill: clearing is the rare
          path and must not compete with Re-run for the click. */}
      {!locked && onClearCareerFiles && (
        <button
          onClick={onClearCareerFiles}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag mt-1 w-full text-[9px] text-white/20 hover:text-white/45 transition-colors bg-transparent border-0 cursor-pointer py-0.5"
          title="Clear career data and results — search settings are kept for fresh files"
        >
          Clear career files
        </button>
      )}

      {/* Target role + Look back — both feed the next Re-run Search */}
      {!locked && (
        <div className="nodrag w-full mt-2 flex flex-col items-stretch gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5 text-[10px] text-white/40">
            <Target size={10} className="text-purple-300/70 shrink-0" />
            <input
              type="text"
              data-native-undo="true"
              value={targetRole}
              onChange={(e) => setTargetRole?.(e.target.value)}
              placeholder="Target role (optional)"
              className="flex-1 min-w-0 px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-0.5 focus:outline-none focus:border-purple-400/50 placeholder:text-white/25"
              title="Blank: AI generates best-fit search variations. Set: skips variation generation and searches this exact role once. Applies on next Re-run Search."
            />
          </div>
          <JobSearchLocationFields
            searchLocation={searchLocation}
            setSearchLocation={setSearchLocation}
            remoteResidences={remoteResidences}
            setRemoteResidence={setRemoteResidence}
            compact
          />
          <div
            className="flex items-center justify-center gap-1.5 text-[10px] text-white/40"
            title="Maximum posting age (in days) to consider on the next search"
          >
            <span>Look back</span>
            <input
              type="number"
              data-native-undo="true"
              min={1}
              max={180}
              value={maxAgeDays}
              onChange={(e) => setMaxAgeDays?.(e.target.value)}
              className="w-10 text-center bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-0.5 focus:outline-none focus:border-blue-400/50"
            />
            <span>days</span>
          </div>
          <JobCollectionLimitsControl
            collectionLimits={collectionLimits}
            setCollectionLimits={setCollectionLimits}
          />
          <JobPlatformSelectionControl
            enabledSourceIds={enabledSourceIds}
            setEnabledSourceIds={setEnabledSourceIds}
            collectionLimits={collectionLimits}
            availableSourceIds={availableSourceIds}
            searchLocation={searchLocation}
          />
        </div>
      )}
    </div>
  );
}
