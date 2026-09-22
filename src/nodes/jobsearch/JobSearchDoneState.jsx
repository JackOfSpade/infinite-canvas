import React, { useId } from 'react';
import { RefreshCw, LayoutGrid } from 'lucide-react';
import { useToast } from '../../components/ToastProvider';
import { ScrapeWarningsPanel } from '../../components/ScrapeWarningsPanel';
import { JobCollectionLimitsControl } from '../../components/JobCollectionLimitsControl';
import { JobPlatformSelectionControl } from '../../components/JobPlatformSelectionControl';
import { JobSearchLocationFields } from '../../components/JobSearchLocationFields';
import { formatCompletionTimestamp } from '../../utils/completionTimestamp';
import { hasGlassdoorCountryScopeCaveat } from '../../utils/jobCollectionScopeCaveats';

// Maps a settingConflict's `setting` value (a literal data.* field name — see
// JOB_PREFERENCE_PLAN_SCHEMA.settingConflicts) to the human label of the
// dedicated control that actually governs it, so the advisory can tell the
// user "this belongs in X" without a second lookup table living elsewhere.
// Keys are exhaustive against the 5-value enum the interpreter is constrained
// to; an unrecognized key (schema drift) falls back to the raw field name
// rather than throwing, since this is advisory-only and must never crash the
// render (see settingConflicts' fail-open normalization contract).
const SETTING_CONTROL_LABELS = {
  searchLocation: 'Search location',
  remoteResidences: 'Remote salary residences',
  maxAgeDays: 'Look back (days)',
  collectionLimits: 'Jobs / platform & Browser pages / search',
  enabledSourceIds: 'Job platforms',
};

// Renders the locked Search Brief plan's advisory fields — `settingConflicts`
// (brief prose that restates a setting with its own dedicated control, e.g.
// "LOCATION: Toronto only" while the structured Search location says Denver)
// and `warnings` (ambiguity/self-contradiction within the brief itself).
// Both are pure advisory: they never block, cancel, or retry a search, which
// is why this is styled amber/neutral "status" rather than HubErrorBanner's
// red "alert" — a failed run is a different, more urgent thing than "you may
// have meant something else". Renders nothing when both are empty (the
// normal case) — no empty container, no "no issues" filler line.
// Exported so both render states (this file's done state and JobSearchNode's
// empty/draft state) share one implementation instead of two copies that can
// drift — these advisories matter MOST before the first run, since every
// setting they'd help you catch freezes the moment that run starts.
export function SearchBriefAdvisories({ searchBriefPlan }) {
  const settingConflicts = Array.isArray(searchBriefPlan?.settingConflicts)
    ? searchBriefPlan.settingConflicts
    : [];
  const warnings = Array.isArray(searchBriefPlan?.warnings) ? searchBriefPlan.warnings : [];
  if (settingConflicts.length === 0 && warnings.length === 0) return null;

  return (
    <div className="w-full flex flex-col gap-1">
      {/* Conflicts are the actionable half (a specific control to go fix) —
          amber like this module's other non-blocking notices (e.g. the
          Glassdoor scope caveat below), never red/alert like a failed run. */}
      {settingConflicts.length > 0 && (
        <div
          className="rounded-md border border-amber-400/25 bg-amber-400/5 px-2 py-1.5 text-[9px] leading-snug text-amber-100/80"
          role="status"
        >
          <p className="font-medium text-amber-200/85 mb-1">
            Brief may conflict with your settings
          </p>
          <ul className="space-y-1">
            {settingConflicts.map((conflict, index) => (
              // No stable id in the schema (free-text AI output); the list
              // only ever fully replaces on the next resolve, so pairing the
              // index with the conflicted setting is a fine key.
              <li key={`${conflict.setting}-${index}`}>
                <span className="text-amber-100/70">&ldquo;{conflict.wrote}&rdquo;</span>
                {' — '}
                <span className="text-amber-200/60">
                  {SETTING_CONTROL_LABELS[conflict.setting] || conflict.setting}
                </span>
                {' governs this. '}
                {conflict.resolution}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Warnings are ambiguity observed WITHIN the brief, not tied to any
          control — kept visually secondary (dimmer, no bold header, grouped
          under the conflicts) since it's the less actionable of the two. */}
      {warnings.length > 0 && (
        <div
          className="rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-[9px] leading-snug text-white/35"
          role="status"
        >
          <ul className="list-disc pl-3 space-y-0.5">
            {warnings.map((warning, index) => (
              // Warning text itself has no guaranteed uniqueness (the AI could
              // repeat phrasing), so fold the index into the key regardless.
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function JobSearchDoneState({
  resultCount,
  scrapedCount,
  gatheredCount,
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
  // A disconnected Board can retain a durable recovery plan while it finishes
  // cancellation or rollback. It owns launch actions, but is deliberately not
  // presented as a live connection.
  boardRecoveryPending = false,
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
  // Search Brief — free text the AI reads to determine which roles to
  // search plus directions, preferences, and deal-breakers. Field/prop name
  // stays `jobPreferences` (wire-compatible with the backend and IPC arg);
  // only the user-facing label changed. Surfaces on the done state so the
  // user can tweak it before re-running without going back to empty state.
  jobPreferences = '',
  setJobPreferences,
  // SETTINGS LOCKING: the durable, once-ever resolved role list (data.resolvedRoles
  // on the hub). Non-empty means the brief has been resolved and EVERY
  // user-configurable setting on this hub — brief, location, remote
  // residences, look-back window, depth, and platforms — is now PERMANENTLY
  // read-only, so a re-scan reproduces the exact same search. This is
  // distinct from `locked` above, which is the hub's transient "busy right
  // now" lock (a queued run, a hub lock) and clears on its own. Do NOT fold
  // settingsFrozen into `locked` — a future merge would let settings reopen
  // the moment a queued run finishes, defeating reproducibility. This one
  // only clears via Clear career files (or a career-data-wiping Reset),
  // never on a timer or a completed run.
  resolvedRoles = [],
  // The actual lock-existence sentinel — see the inline `settingsFrozen`
  // derivation below for why this (not `resolvedRoles.length`) is what
  // decides the freeze.
  resolvedRolesMeta = null,
  // The LOCKED plan (data.searchBriefPlan) — distinct from `jobPreferencePlan`
  // below, which is the plan used to evaluate/filter THIS run's results and
  // may be re-derived per re-scan. searchBriefPlan is resolved exactly once
  // and carries the settingConflicts/warnings advisories rendered here.
  searchBriefPlan = null,
  preferenceMatchedCount = null,
  preferenceFilteredCount = null,
  jobPreferencePlan = null,
  preferenceEvaluation = null,
  // Anti-bot signals collected during the search pipeline
  scrapeWarnings = [],
  // Non-gating source limitations carried with completed results. These remain
  // visible after source cards are reaped and must not be confused with a
  // warning that pauses or skips scoring.
  collectionScopeCaveats = [],
  // A completed run with no eligible results replaces the old result set.
  rerunOutcome = null,
  reanalysisNotice = null,
  resultDisposition = null,
  lastCompletedRunAt = null,
}) {
  const { addToast } = useToast();
  const preferencesHelpId = useId();
  // FIX 2 (defence-in-depth): `resolvedRoles.length > 0` used to be the lock-
  // existence sentinel here. A resolution that legitimately yields ZERO
  // titles (a valid outcome) still WRITES `resolvedRoles: []`, which that
  // sentinel cannot distinguish from "this hub has never locked" — the
  // settings would render editable while the durable lock is engaged and a
  // re-scan ignores any edit. `resolvedRolesMeta` is written IFF a
  // resolution actually ran, so it is the sentinel that is true exactly when
  // the lock exists, empty result or not. This mirrors
  // `hasResolvedRoleLock` in JobSearchNode.jsx (the canonical definition,
  // duplicated here rather than imported to avoid a circular import between
  // the two modules — JobSearchNode.jsx already imports this file).
  const settingsFrozen = !!(resolvedRolesMeta && typeof resolvedRolesMeta === 'object');
  const lastCompletedRunAtText = formatCompletionTimestamp(lastCompletedRunAt);
  // `testMode` is retained only for old persisted hubs. New runs record the
  // actual scoring behavior through `aiSkipped` / `collectionOnly`.
  const skippedAi = aiSkipped || collectionOnly || testMode;
  const count = skippedAi ? (scrapedCount ?? 0) : (resultCount || 0);
  const noNewResults = rerunOutcome === 'no-new-results';
  const glassdoorCountryScopeUnenforced = hasGlassdoorCountryScopeCaveat(collectionScopeCaveats);
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
          Last scraped: {lastCompletedRunAtText}
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

      {/* The results cascade now lives on the Job Board Module — point the user there. */}
      {count > 0 && (
        <div className="flex items-start gap-1.5 mt-2 px-2 py-1.5 rounded-md bg-indigo-500/10 border border-indigo-500/15 w-full">
          <LayoutGrid size={11} className="text-indigo-300/70 shrink-0 mt-0.5" />
          <p className="text-indigo-200/70 text-[10px] leading-snug">
            {boardRecoveryPending
              ? <>A previous <span className="font-medium">Job Board</span> recovery is settling. Results stay available; direct search actions return when it finishes or is cancelled.</>
              : managedByJobBoard
              ? <>Use the connected <span className="font-medium">Job Board Module</span> to reuse and merge these completed results. To search again, manually clear career data and import fresh files in Job Search first.</>
              : <>Connect a <span className="font-medium">Job Board Module</span> to view & merge these results.</>}
          </p>
        </div>
      )}

      {glassdoorCountryScopeUnenforced && (
        <div className="w-full mt-1 rounded-md border border-amber-400/25 bg-amber-400/5 px-2 py-1.5 text-[9px] leading-snug text-amber-100/80" role="status">
          <span className="font-medium">Glassdoor country scope was not enforceable.</span> Its country-level results may follow this machine&apos;s browsing region. Set a city, state, or province to scope Glassdoor results.
        </div>
      )}

      {reanalysisNotice && (
        <div className="w-full mt-1 rounded-md border border-amber-400/20 bg-amber-400/5 px-2 py-1.5 text-[9px] leading-snug text-amber-100/75" role="status">
          Saved-job re-evaluation did not finish. Your existing results are still available to the Job Board. Try re-evaluating again when ready.
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
              The connected Job Board reuses these completed results. To start a fresh search, manually choose Clear career data and import fresh files in Job Search first; the Board can then start it.
            </p>
          ) : boardRecoveryPending ? (
            <p className="px-2 py-1 text-center text-[10px] leading-snug text-blue-200/55">
              A previous Job Board recovery is settling. Direct search actions return when it finishes or is cancelled.
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

      {/* Search Brief + Look back — both feed the next coordinated search. */}
      {!locked && (
        <div className="nodrag w-full mt-2 flex flex-col items-stretch gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
          <label className="flex flex-col gap-1 text-[10px] text-white/40">
            <span>Search Brief <span className="text-white/25">(optional)</span></span>
            <textarea
              data-native-undo="true"
              value={jobPreferences}
              onChange={(e) => setJobPreferences?.(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="E.g. Senior Product Manager roles — or: help me pivot away from web development; large established companies only."
              aria-describedby={preferencesHelpId}
              // settingsFrozen is PERMANENT (see the prop comment above) —
              // reusing `disabled` (not just readOnly) borrows the same
              // disabled-control look this module already uses elsewhere, so
              // a locked brief reads as intentional rather than a stray bug.
              disabled={settingsFrozen}
              className="w-full resize-y px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-1 focus:outline-none focus:border-purple-400/50 placeholder:text-white/25 leading-snug disabled:cursor-not-allowed disabled:opacity-50"
            />
            {/* One explanation for the whole frozen settings group, not a
                per-control repeat: every setting below (location, look-back,
                depth, platforms) shares this same lock and unlock path. */}
            <span id={preferencesHelpId} className="text-[9px] leading-snug text-white/25">
              {settingsFrozen
                ? 'All settings — brief, location, look-back window, search depth, and platforms — locked after your first search, so every re-scan is reproducible. Clear career data to unlock them and start over.'
                : managedByJobBoard
                ? 'AI determines which roles to search from this brief; saved-job re-evaluation uses it too. For a fresh Board search, manually choose Clear career data and import fresh files in Job Search first; the Board then starts it. Location, look-back window, search depth, and platforms are set by the controls below, not by this text.'
                : 'AI determines which roles to search from what you write here — explicit titles, a general direction, or nothing about roles at all. Applies on the next re-run and saved-job re-evaluation. Tell it what to prioritize, avoid, or independently verify; “must,” “only,” and “no” are strict. Location, look-back window, search depth, and platforms are set by the controls below, not by this text.'}
            </span>
            {/* Trusting one AI decision for every future scan deserves to be
                visible, not just implied by the disabled textarea. */}
            {/* A lock with ZERO roles is real, not a bug: an empty brief
                short-circuits before any AI call and still locks (that is the
                whole point of keying the sentinel on resolvedRolesMeta rather
                than resolvedRoles.length). Rendering the label anyway would
                print a dangling "Locked roles:" with nothing after the colon,
                which reads as a load failure. Say what actually happened. */}
            {settingsFrozen && (
              <p className="text-[9px] leading-snug text-emerald-300/55">
                {resolvedRoles.length > 0
                  ? `Locked roles: ${resolvedRoles.join(', ')}`
                  : 'Locked with no specific roles — your brief named none, so searches are not narrowed to a role list.'}
              </p>
            )}
            <SearchBriefAdvisories searchBriefPlan={searchBriefPlan} />
          </label>
          <JobSearchLocationFields
            searchLocation={searchLocation}
            setSearchLocation={setSearchLocation}
            remoteResidences={remoteResidences}
            setRemoteResidence={setRemoteResidence}
            compact
            disabled={settingsFrozen}
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
              disabled={settingsFrozen}
              className="w-10 text-center bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-0.5 focus:outline-none focus:border-blue-400/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span>days</span>
          </label>
          <JobCollectionLimitsControl
            collectionLimits={collectionLimits}
            setCollectionLimits={setCollectionLimits}
            disabled={settingsFrozen}
          />
          <JobPlatformSelectionControl
            enabledSourceIds={enabledSourceIds}
            setEnabledSourceIds={setEnabledSourceIds}
            collectionLimits={collectionLimits}
            availableSourceIds={availableSourceIds}
            searchLocation={searchLocation}
            disabled={settingsFrozen}
          />
        </div>
      )}
    </div>
  );
}
