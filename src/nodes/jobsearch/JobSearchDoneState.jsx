import React from 'react';
import { RefreshCw, Target, MapPin, Bot, LayoutGrid } from 'lucide-react';
import { useToast } from '../../components/ToastProvider';
import { ScrapeWarningsPanel } from '../../components/ScrapeWarningsPanel';
import { JobCollectionLimitsControl } from '../../components/JobCollectionLimitsControl';

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
  // Search controls (passed back to the hub for next run)
  maxAgeDays = 21,
  setMaxAgeDays,
  collectionLimits,
  setCollectionLimits,
  preferredLocation = '',
  setPreferredLocation,
  // Target/pivot role input — surfaces on the done state so the user can
  // tweak it before re-running without going back to empty state.
  targetRole = '',
  setTargetRole,
  // Anti-bot signals collected during the search pipeline
  scrapeWarnings = [],
  // Jobs dropped from this search because they matched an existing entry in
  // the permanent applied-jobs store (docs/resume-achievement-mining-design.md
  // §6.2) — surfaced by electron/ipc/jobs.js's filterOutApplied at every
  // gather site. Filtering must never be silent: a job vanishing with no
  // explanation is indistinguishable from a scraper bug.
  hiddenApplied = 0,
}) {
  const { addToast } = useToast();
  // `testMode` is retained only for old persisted hubs. New runs record the
  // actual scoring behavior through `aiSkipped` / `collectionOnly`.
  const skippedAi = aiSkipped || collectionOnly || testMode;
  const count = skippedAi ? (scrapedCount ?? 0) : (resultCount || 0);

  return (
    <div className="flex flex-col items-center py-5 px-3 w-full gap-1">

      {/* Result count */}
      <div className="text-emerald-400 text-2xl font-bold">{count}</div>
      <p className="text-white/40 text-xs">{skippedAi ? 'jobs collected' : 'jobs scored'}</p>

      {/* Scraped → kept funnel */}
      {(gatheredCount > 0 || scrapedCount > 0) && (
        <p className="text-white/25 text-[10px] mt-0.5">
          {gatheredCount > 0 && scrapedCount != null && gatheredCount !== scrapedCount
            ? `${gatheredCount} scraped → ${scrapedCount} kept`
            : `${gatheredCount || scrapedCount} scraped`}
        </p>
      )}

      {/* Already-applied jobs dropped from this search — never silent, same
          style as the scraped→kept line above. */}
      {hiddenApplied > 0 && (
        <p
          className="text-white/25 text-[10px]"
          title="Jobs matching a posting you already marked applied are dropped from these results so they don't resurface"
        >
          {hiddenApplied} hidden (already applied)
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
        <div className="flex mt-2 w-full">
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
              title="Set or change the role to pivot into. Applies on next Re-run Search."
            />
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-white/40">
            <MapPin size={10} className="text-blue-300/70 shrink-0" />
            <input
              type="text"
              data-native-undo="true"
              value={preferredLocation}
              onChange={(e) => setPreferredLocation?.(e.target.value)}
              placeholder="One area — e.g. Canada or Toronto, Ontario, Canada"
              className="flex-1 min-w-0 px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-0.5 focus:outline-none focus:border-blue-400/50 placeholder:text-white/25"
              title="Use one area per run. Country, province/state, and city scopes are supported; use separate modules for Canada and the United States."
            />
          </div>
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
        </div>
      )}
    </div>
  );
}
