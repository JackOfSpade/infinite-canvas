import React, { useId } from 'react';
import { RefreshCw, Target, Bot, LayoutGrid } from 'lucide-react';
import { useToast } from '../../components/ToastProvider';
import { ScrapeWarningsPanel } from '../../components/ScrapeWarningsPanel';
import { JobCollectionLimitsControl } from '../../components/JobCollectionLimitsControl';
import { JobPlatformSelectionControl } from '../../components/JobPlatformSelectionControl';
import { JobSearchLocationFields } from '../../components/JobSearchLocationFields';
import { formatCompletionTimestamp } from '../../utils/completionTimestamp';

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
  platformsVerifying = false,
  verifyDone = 0,
  verifyTotal = 0,
  // A connected Job Board owns fresh-search admission and queueing. This card
  // remains the editor for its source/search settings and saved results.
  managedByJobBoard = false,
  // Action props
  onRerun = null,
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
  // Natural-language directions, preferences, and deal-breakers for the
  // AI. Kept separate from the literal target-role gate.
  jobPreferences = '',
  setJobPreferences,
  preferenceMatchedCount = null,
  preferenceFilteredCount = null,
  jobPreferencePlan = null,
  preferenceEvaluation = null,
  // Anti-bot signals collected during the search pipeline
  scrapeWarnings = [],
  // A completed run with no eligible results replaces the old result set.
  rerunOutcome = null,
  resultDisposition = null,
  lastCompletedRunAt = null,
}) {
  const { addToast } = useToast();
  const targetRoleHelpId = useId();
  const preferencesHelpId = useId();
  const lastCompletedRunAtText = formatCompletionTimestamp(lastCompletedRunAt);
  // `testMode` is retained only for old persisted hubs. New runs record the
  // actual scoring behavior through `aiSkipped` / `collectionOnly`.
  const skippedAi = aiSkipped || collectionOnly || testMode;
  const count = skippedAi ? (scrapedCount ?? 0) : (resultCount || 0);
  const noNewResults = rerunOutcome === 'no-new-results';
  const validCount = (value) => (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  );
  // A completed search cannot have fewer found listings than score-ready or
  // displayed results. New runs preserve that funnel; this reconciliation keeps
  // older canvases with a previously-corrupted gathered count understandable.
  const displayedGatheredCount = Math.max(
    0,
    ...[gatheredCount, scrapedCount, resultCount]
      .map(validCount)
      .filter((value) => value != null),
  );
  const scoreReadyCount = validCount(scrapedCount) ?? displayedGatheredCount;
  const matchedPreferenceCount = validCount(preferenceMatchedCount);
  const filteredPreferenceCount = validCount(preferenceFilteredCount);
  const preferencesFilteredRun = resultDisposition === 'preference-filtered';
  const preferencePlan = jobPreferences.trim()
    ? (preferenceEvaluation?.preferencePlan || jobPreferencePlan || null)
    : null;
  const preferenceSummary = typeof preferencePlan?.summary === 'string' ? preferencePlan.summary.trim() : '';
  const preferenceCounts = preferenceEvaluation?.counts || null;
  const filteredAudits = Array.isArray(preferenceEvaluation?.audits)
    ? preferenceEvaluation.audits.filter((audit) => audit?.status === 'filtered')
    : [];
  const jobsLabel = (value, singular, plural = `${singular}s`) => `${value} ${value === 1 ? singular : plural}`;
  const resultLabel = preferencesFilteredRun
    ? `${jobsLabel(count, 'job')} matched your preferences`
    : noNewResults
      ? jobsLabel(count, 'new job', 'new jobs')
      : skippedAi
        ? jobsLabel(count, 'job collected', 'jobs collected')
        : jobsLabel(count, 'job scored', 'jobs scored');

  return (
    <div className="flex flex-col items-center py-5 px-3 w-full gap-1">

      {/* Result count */}
      <div className="text-emerald-400 text-2xl font-bold">{count}</div>
      <p className="text-white/40 text-xs">
        {resultLabel}
      </p>
      {lastCompletedRunAtText && (
        <p className="text-white/35 text-[9px] mt-0.5">
          Last completed: {lastCompletedRunAtText}
        </p>
      )}

      {/* Keep the current run's found → score-ready funnel visible even when
          no jobs survive into the new result set. */}
      {(displayedGatheredCount > 0 || scoreReadyCount > 0) && (
        <p className="text-white/25 text-[10px] mt-0.5">
          {[
            `${jobsLabel(displayedGatheredCount, 'job')} found`,
            matchedPreferenceCount != null && `${jobsLabel(matchedPreferenceCount, 'job')} matched your preferences`,
            displayedGatheredCount !== scoreReadyCount && `${jobsLabel(scoreReadyCount, 'job')} ready to score`,
          ].filter(Boolean).join(' → ')}
        </p>
      )}
      {filteredPreferenceCount != null && filteredPreferenceCount > 0 && (
        <p className="text-white/25 text-[9px]">
          {jobsLabel(filteredPreferenceCount, 'job')} filtered by your preferences
        </p>
      )}

      {(preferenceSummary || filteredAudits.length > 0 || preferenceCounts) && (
        <details className="w-full mt-1 px-2 py-1 rounded border border-violet-500/15 bg-violet-500/5 text-[9px] text-white/40">
          <summary className="cursor-pointer text-violet-200/70">
            {preferenceSummary || 'Job Preferences evaluated'}
          </summary>
          <div className="mt-1 space-y-1 leading-snug">
            {preferenceCounts && (
              <p>
                {jobsLabel(preferenceCounts.accepted ?? matchedPreferenceCount ?? 0, 'job')} matched
                {Number.isFinite(preferenceCounts.filtered) && ` · ${jobsLabel(preferenceCounts.filtered, 'job')} filtered`}
              </p>
            )}
            {filteredAudits.length > 0 && (
              <div>
                <p className="text-white/30">Filtered reasons</p>
                <ul className="list-disc pl-3">
                  {filteredAudits.slice(0, 4).map((audit, index) => (
                    <li key={`${audit.title || 'job'}-${index}`}>
                      {audit.title || 'Job'}{audit.company ? ` — ${audit.company}` : ''}: {audit.summary || 'did not meet your preferences'}
                    </li>
                  ))}
                </ul>
                {filteredAudits.length > 4 && <p>+{filteredAudits.length - 4} more</p>}
              </div>
            )}
          </div>
        </details>
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
            {managedByJobBoard
              ? <>Use the connected <span className="font-medium">Job Board Module</span> to refresh and merge results.</>
              : <>Connect a <span className="font-medium">Job Board Module</span> to view & merge these results.</>}
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
              title="Re-evaluate saved jobs with your current Job Preferences and hiring fit; does not search or scrape again"
            >
              <RefreshCw size={9} />
              Re-evaluate Saved Jobs
            </button>
          )}
          {managedByJobBoard ? (
            <p className="px-2 py-1 text-center text-[10px] leading-snug text-blue-200/55">
              Fresh searches are queued from the connected Job Board.
            </p>
          ) : onRerun ? (
            <button
              onClick={onRerun}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={platformsVerifying}
              className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-full bg-blue-500/15 text-blue-400/80 hover:bg-blue-500/25 text-[10px] transition-colors border border-blue-500/15 disabled:cursor-wait disabled:opacity-50"
              title={platformsVerifying
                ? 'Waiting for the selected job platform connection check'
                : 'Clear old results and re-run the search with the same resume'}
            >
              <RefreshCw size={9} className={platformsVerifying ? 'animate-spin' : ''} />
              {platformsVerifying
                ? `Checking connections${verifyTotal > 0 ? ` (${verifyDone}/${verifyTotal})` : ''}…`
                : 'Re-run Search'}
            </button>
          ) : null}
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

      {/* Target role + Look back — both feed the next coordinated search. */}
      {!locked && (
        <div className="nodrag w-full mt-2 flex flex-col items-stretch gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
          <label className="flex flex-col gap-1 text-[10px] text-white/40">
            <span className="flex items-center gap-1.5"><Target size={10} aria-hidden="true" className="text-purple-300/70 shrink-0" />Target role <span className="text-white/25">(optional)</span></span>
            <input
              type="text"
              data-native-undo="true"
              value={targetRole}
              onChange={(e) => setTargetRole?.(e.target.value)}
              placeholder="Target role (optional)"
              aria-describedby={targetRoleHelpId}
              className="flex-1 min-w-0 px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-0.5 focus:outline-none focus:border-purple-400/50 placeholder:text-white/25"
            />
            <span id={targetRoleHelpId} className="text-[9px] leading-snug text-white/25">Leave blank to generate best-fit search variations. Set a role to search that exact role on the next {managedByJobBoard ? 'Board scan' : 're-run'}.</span>
          </label>
          <label className="flex flex-col gap-1 text-[10px] text-white/40">
            <span>Job Preferences <span className="text-white/25">(optional)</span></span>
            <textarea
              data-native-undo="true"
              value={jobPreferences}
              onChange={(e) => setJobPreferences?.(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="E.g. Help me pivot away from web development; large established companies only."
              aria-describedby={preferencesHelpId}
              className="w-full resize-y px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-1 focus:outline-none focus:border-purple-400/50 placeholder:text-white/25 leading-snug"
            />
            <span id={preferencesHelpId} className="text-[9px] leading-snug text-white/25">
              Applies on the next {managedByJobBoard ? 'Board scan' : 're-run'} and saved-job re-evaluation. Tell AI what to prioritize, avoid, or independently verify. “Must,” “only,” and “no” are strict.
            </span>
          </label>
          <JobSearchLocationFields
            searchLocation={searchLocation}
            setSearchLocation={setSearchLocation}
            remoteResidences={remoteResidences}
            setRemoteResidence={setRemoteResidence}
            compact
          />
          <label className="flex items-center justify-center gap-1.5 text-[10px] text-white/40">
            <span>Look back</span>
            <input
              type="number"
              data-native-undo="true"
              min={1}
              max={180}
              value={maxAgeDays}
              onChange={(e) => setMaxAgeDays?.(e.target.value)}
              aria-label="Maximum posting age in days"
              className="w-10 text-center bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-0.5 focus:outline-none focus:border-blue-400/50"
            />
            <span>days</span>
          </label>
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
