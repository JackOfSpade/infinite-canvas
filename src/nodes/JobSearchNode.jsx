import React, { useRef, useEffect, useCallback, useContext, useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import { usePlatformsVerifyingProgress } from '../contexts/useSessionStatus';
import { HubContainer } from '../components/HubContainer';
import { Briefcase, Clock } from 'lucide-react';
import { JOB_SOURCE_BY_ID, ACTIVE_JOB_SOURCES } from '../utils/constants';
import { isJobSourceEnabledInScope, JOB_SEARCH_TEST_MODE } from '../utils/jobSourceScope';
// Same-run merges use dedupJobsAcrossSources/uniqueJobsAcrossSources — the
// backend's location-aware cross-source dedup — so a posting that arrives
// late (post-Solve resolve, background USAJobs) collapses against the copy
// another board already returned, exactly as it would have in the main
// gather, without over-collapsing distinct same-title/company reqs in
// different cities. See the policy note in jobIdentity.js.
import { dedupJobsAcrossSources, uniqueJobsAcrossSources } from '../utils/jobIdentity';
import { getJobAuthPreflightSourceIds } from '../utils/jobAuthPreflight';
import { mergeResolvedSourceItems } from '../utils/jobSourceResolveMerge';
import { radialRadius, fitViewDuration } from '../utils/layoutGeometry';
import { EventLogger } from '../utils/EventLogger';
import { useToast } from '../components/ToastProvider';
import { getHubDropLockReason } from '../utils/hubDropEligibility';
import { filesToDropPayloads, summarizeFileExtensions } from '../utils/fileDropUtils';
import { filterHandledJobSourceWarnings, isJobSourceWarningGating } from '../utils/jobSourceWarningPolicy';

import { JobSearchProcessingState } from './jobsearch/JobSearchProcessingState';
import { JobSearchDoneState } from './jobsearch/JobSearchDoneState';
import { JobSearchSourcesReadyState } from './jobsearch/JobSearchSourcesReadyState';
import { HubErrorBanner } from '../components/HubErrorBanner';
import { useUnmountEffect } from '../hooks/useUnmountEffect';
import { useEpochCancellation, isNodeDeletedAbort } from '../hooks/useEpochCancellation';
import { useSourceProgress } from '../hooks/useSourceProgress';
import { useIsMountedRef } from '../hooks/useIsMountedRef';
import { pickEdgeHandles, structuralEdge } from './_shared/edgeHelpers';
import { deleteChildrenByHubId } from './_shared/hubChildCleanup';
import { JobCollectionLimitsControl } from '../components/JobCollectionLimitsControl';
import { normalizeJobCollectionLimits } from '../utils/jobCollectionLimits';
import { normalizeLocationInput } from '../utils/jobLocation';

// ─── TESTING: optionally skip AI scoring after collection ────────────────────
// Collection limits are always user-controlled; this switch affects scoring only.
const SKIP_AI_FOR_TESTING = JOB_SEARCH_TEST_MODE.enabled && JOB_SEARCH_TEST_MODE.skipAI;
// ─────────────────────────────────────────────────────────────────────────────

// A scrape warning "gates" the pipeline — pauses it in 'sources-ready' until the
// user Solves or Skips — when it's a hard block/paste (captcha, login wall) OR a
// LinkedIn guest rate-limit. The rate-limit is technically a 'throttle', but a
// Solve (switch VPN → re-enrich the missing descriptions) recovers real data, so
// we hold scoring rather than burn AI tokens on description-less LinkedIn jobs;
// the user can still Skip to score with what we have. Everything else (info,
// transient throttles on other sources) flows straight through to scoring.
// Job freshness window (days). Default mirrors electron DEFAULT_MAX_AGE_DAYS;
// the cap bounds the user-set slider. NOTE: auto-widening this on thin results
// would need a search refetch (filterJobsByAge runs post-fetch, so date-param
// sources won't already have older jobs in the pool) — left as a follow-up.
const JOB_DEFAULT_AGE_DAYS   = 21;
const JOB_MAX_AGE_DAYS_LIMIT = 180;

const STATE_LABELS = {
  empty: null,
  parsing: 'Reading resume...',
  querying: 'Planning search strategy...',
  searching: 'Searching for jobs...',
  scoring: 'AI scoring matches...',
  queued: 'Waiting to run...',
  'sources-ready': null,
  done: null,
};

const PROCESSING_STATES = ['queued', 'parsing', 'querying', 'searching', 'scoring'];
const SOURCE_CARD_DISMISS_GRACE_MS = 10_000;
const TERMINAL_SOURCE_STATUSES = new Set(['done', 'error', 'skipped']);

// The results cascade (likelihood/salary/role tree) is no longer spawned here —
// the Job Search Module scrapes + scores + STORES its scored jobs, and a Job
// Board Module (connected by the user) does the bucketing + display. See
// JobBoardNode.jsx and buildJobTree.js (the shared, hubId-agnostic builder).

function buildResumeSummary(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const skills = Array.isArray(profile.skills) ? profile.skills.slice(0, 3).join(', ') : '';
  return `${skills}${profile.experience_years ? `${skills ? ' · ' : ''}${profile.experience_years}y exp` : ''}`.trim();
}

function buildQueryCacheKey({ resumeFingerprint, targetRole, preferredLocation }) {
  return JSON.stringify({
    resumeFingerprint: String(resumeFingerprint || ''),
    targetRole: String(targetRole || '').trim(),
    preferredLocation: String(preferredLocation || '').trim(),
  });
}

function getSavedAnalysisWarning(meta, currentHubId, currentCanvasFilePath) {
  if (!meta) return '';
  if (meta.canvasFilePath && currentCanvasFilePath && meta.canvasFilePath !== currentCanvasFilePath) {
    return 'Saved from a different canvas file.';
  }
  if (meta.sourceHubId && currentHubId && meta.sourceHubId !== currentHubId) {
    return 'Saved from a different job search hub.';
  }
  return '';
}

/**
 * JobSearchNode — draggable canvas module for job search.
 * Phase 2: Per-source independent status tracking + source filtering.
 *
 * data.hubState: 'empty' | 'parsing' | 'querying' | 'searching' | 'scoring' |
 *                'scoring-batch' | 'sources-ready' | 'done'
 *                'scoring-batch' = opt-in async Batch-API scoring submitted;
 *                  parked here (with data.pendingBatch) until the poll completes
 *                  it (survives app restarts).
 *                'sources-ready' = paused after search because one or more
 *                sources hit block-severity warnings (captcha, login wall).
 *                The user must resolve or skip them before scoring runs.
 *                Failures set data.errorMessage (surfaced via HubErrorBanner)
 *                but stay in the logical step rather than wiping to an error wall.
 * data.filePath: string (set when auto-created from canvas file drop)
 * data.resultCount: number
 * data.errorMessage: string
 * data.resumeSummary: string
 * data.sourceFilter: string | null — if set, only show jobs from this source
 */
export const JobSearchNode = React.memo(function JobSearchNode({ id, data }) {

  // id is stable for this component's lifetime — ReactFlow never reuses
  // instances with different ids, so we can safely close over it in callbacks.
  const { updateNodeData, getNode, getNodes, getEdges, addNodes, addEdges, deleteElements, fitView } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const addElementsGlobally = nav?.addElementsGlobally;
  const canvasFilePath = nav?.currentFile || null;
  const moduleRunQueue = useModuleRunQueue();
  const processingRef = useRef(false);
  const initialDropAcceptedRef = useRef(false);
  const pendingUSAJobsRefreshRef = useRef(false);
  const scrapeWarningsRef = useRef(data.scrapeWarnings);
  const hubStateRef = useRef(data.hubState);
  const pendingJobsRef = useRef(data.pendingJobs);
  const jobRunIdRef = useRef(data.jobRunId || null);
  // Running total of applied-jobs suppressed for this hub's current run.
  // Captured once at initial search completion (search-jobs/resume-job-search),
  // then ADDED to by each job-source-resolved event (resolve/resume-job-source
  // also filter through filterOutApplied — see electron/ipc/jobs.js) so a
  // Solve/Continue mid-run doesn't silently drop its own hiddenApplied count on
  // the floor. Read synchronously (like pendingJobsRef) by resumeScoring, which
  // can fire before the next render lands.
  const hiddenAppliedRef = useRef(data.hiddenApplied || 0);
  // Sources resolved or explicitly skipped/dismissed WHILE the search was
  // running (cleared at each run start). The backend doesn't know about these;
  // use this to avoid restoring stale warnings when its final result arrives.
  const handledDuringSearchRef = useRef(new Set());
  const resumeScoringRef = useRef(null);
  const isMountedRef = useIsMountedRef();
  const settingsDebounceTimerRef = useRef(null);
  const sourceDismissTimerRef = useRef(null);
  const epoch = useEpochCancellation();
  const { addToast } = useToast();
  const [savedAnalysisMeta, setSavedAnalysisMeta] = useState(null);
  const [savedAnalysisLoading, setSavedAnalysisLoading] = useState(false);
  // Normalize before any renderer-to-main call. Existing canvases may not have
  // this newer node field, but the backend still needs explicit production
  // defaults for reproducible collection telemetry.
  const jobsPerPlatform = data.collectionLimits?.jobsPerPlatform;
  const pagesPerPlatform = data.collectionLimits?.pagesPerPlatform;
  const collectionLimits = useMemo(
    () => normalizeJobCollectionLimits({ jobsPerPlatform, pagesPerPlatform }),
    [jobsPerPlatform, pagesPerPlatform],
  );
  const setCollectionLimits = useCallback((limits) => {
    updateGlobal(id, { collectionLimits: normalizeJobCollectionLimits(limits) });
  }, [id, updateGlobal]);
  useEffect(() => {
    return () => {
      if (settingsDebounceTimerRef.current) {
        clearTimeout(settingsDebounceTimerRef.current);
      }
      if (sourceDismissTimerRef.current) {
        clearTimeout(sourceDismissTimerRef.current);
      }
    };
  }, []);
  // Stable ref to startProcessing so handleDrop can call it without a stale closure.
  const startProcessingRef = useRef(null);
  // Persists the last file path(s) dropped this session so retry works even when
  // the login-gate fires before the files are parsed (at which point neither
  // data.filePath nor data.resumeProfile are set yet). Holds an array — a drop
  // can be one or many files.
  const lastDroppedPathsRef = useRef(null);

  const hubState = data.hubState || 'empty';
  const dropLockReason = getHubDropLockReason({ type: 'jobhub', data });
  const inputDropsBlocked = !!dropLockReason;
  const { verifying: platformsVerifying, done: verifyDone, total: verifyTotal } = usePlatformsVerifyingProgress(['indeed', 'glassdoor', 'ziprecruiter']);

  useEffect(() => {
    if (data.inputLocked || data.careerData || data.resumeProfile || data.filePath) {
      initialDropAcceptedRef.current = true;
    }
  }, [data.inputLocked, data.careerData, data.resumeProfile, data.filePath]);

  // Chrome manual-launch overlay — shown when the app couldn't auto-launch
  // Chrome with the debug port and the user needs to do it via Terminal.
  // Payload: { terminalCommand, port } or null.
  const [chromeLaunchInfo, setChromeLaunchInfo] = useState(null);

  useEffect(() => {
    if (!window.electronAPI?.onChromeLaunchNeeded) return;
    const c1 = window.electronAPI.onChromeLaunchNeeded((payload) => setChromeLaunchInfo(payload));
    const c2 = window.electronAPI.onChromeLaunchConnected?.(() => setChromeLaunchInfo(null));
    const c3 = window.electronAPI.onChromeLaunchDismissed?.(() => setChromeLaunchInfo(null));
    return () => { c1?.(); c2?.(); c3?.(); };
  }, []);
  const statusLabel = STATE_LABELS[hubState];

  useEffect(() => {
    scrapeWarningsRef.current = data.scrapeWarnings;
    hubStateRef.current = data.hubState;
    pendingJobsRef.current = data.pendingJobs;
    hiddenAppliedRef.current = data.hiddenApplied || 0;
    jobRunIdRef.current = data.jobRunId || null;
  }, [data.scrapeWarnings, data.hubState, data.pendingJobs, data.hiddenApplied, data.jobRunId]);

  // Per-source progress state populated by backend `job-source-progress`
  // events. Reset via `resetSourceProgress` before each fresh run so stale
  // counts from the previous run don't bleed into the new pipeline.
  const {
    progress: sourceProgress,
    lastActive: lastActiveSource,
    reset: resetSourceProgress,
  } = useSourceProgress(window.electronAPI?.onJobSourceProgress, id);

  // Live AI-scoring progress (real-time path). The backend emits `scoring-progress`
  // once per scored batch; we surface a determinate "N / M" counter in the 'scoring'
  // state. Filtered by nodeId so concurrent hubs don't cross-update each other.
  // Cleared to null at each scoring-phase entry (see the scoreJobs call sites) so a
  // finished run's final count never lingers; the render gate (hubState==='scoring')
  // also hides it outside the scoring phase.
  const [scoringProgress, setScoringProgress] = useState(null);
  useEffect(() => {
    if (!window.electronAPI?.onScoringProgress) return undefined;
    return window.electronAPI.onScoringProgress((payload) => {
      if (payload?.nodeId && payload.nodeId !== id) return;
      setScoringProgress({ scored: payload.scored ?? 0, total: payload.total ?? 0 });
    });
  }, [id]);

  const scheduleCleanSourceCardDismiss = useCallback((reason = 'all-sources-terminal') => {
    if (sourceDismissTimerRef.current) return;
    sourceDismissTimerRef.current = setTimeout(() => {
      sourceDismissTimerRef.current = null;
      document.dispatchEvent(new CustomEvent('job-source-dismiss-clean', {
        detail: { hubId: id, reason },
      }));
    }, SOURCE_CARD_DISMISS_GRACE_MS);
  }, [id]);

  const cancelCleanSourceCardDismiss = useCallback(() => {
    if (!sourceDismissTimerRef.current) return;
    clearTimeout(sourceDismissTimerRef.current);
    sourceDismissTimerRef.current = null;
  }, []);

  useEffect(() => {
    const sourceCards = getNodes().filter(n => n.type === 'jobsourcecard' && n.data?.hubId === id);
    if (sourceCards.length === 0) {
      cancelCleanSourceCardDismiss();
      return;
    }

    const allVisibleCardsTerminal = sourceCards.every(node => {
      const live = sourceProgress[node.data?.sourceId];
      const persisted = node.data?.persistedProgress;
      const persistedCleanTerminal =
        (persisted?.status === 'done' || persisted?.status === 'skipped') && !persisted.warning;
      const effective = live?.status === 'searching'
        ? live
        : persistedCleanTerminal
          ? persisted
          : (live || persisted);
      return !!effective && TERMINAL_SOURCE_STATUSES.has(effective.status);
    });

    if (allVisibleCardsTerminal) {
      scheduleCleanSourceCardDismiss();
    } else {
      cancelCleanSourceCardDismiss();
    }
  }, [sourceProgress, id, getNodes, scheduleCleanSourceCardDismiss, cancelCleanSourceCardDismiss]);

  const getPrimaryQuery = useCallback(() => {
    const q = data.queries;
    if (!q) return '';
    const {
      targetRoleQueries = [], titleQueries = [], suggestedRoleQueries = [], skillsOnlyQueries = []
    } = q;
    const all = [...targetRoleQueries, ...titleQueries, ...suggestedRoleQueries, ...skillsOnlyQueries];
    return all[0] || '';
  }, [data.queries]);

  // Background-streamed scored jobs (the late USAJobs refresh) used to spawn cards
  // straight into the done canvas. Now the Job Search Module only STORES its
  // scored jobs — a connected Job Board Module does the display — so this merges
  // the fresh set into data.scoredJobs (deduped) and updates the summary counts.
  // The board picks them up on its next Combine / Re-combine.
  const appendJobsToDoneCanvas = useCallback(({ scoredJobs, filteredWarnings, gatheredDelta = 0 }) => {
    const fresh = Array.isArray(scoredJobs) ? scoredJobs : [];
    const existing = Array.isArray(data.scoredJobs) ? data.scoredJobs : [];
    const added = uniqueJobsAcrossSources(existing, fresh);
    const nextScored = added.length ? [...existing, ...added] : existing;

    const finalSourceCounts = { ...data.finalSourceCounts };
    added.forEach(job => { finalSourceCounts[job.source] = (finalSourceCounts[job.source] || 0) + 1; });

    const allScores = nextScored.map(j => j.matchScore || 0);
    const scoreRangeMin = allScores.length ? Math.min(...allScores) : (data.scoreRangeMin ?? 0);
    const scoreRangeMax = allScores.length ? Math.max(...allScores) : (data.scoreRangeMax ?? 100);

    updateGlobal(id, {
      hubState: 'done',
      scoredJobs: nextScored,
      resultCount: nextScored.length,
      totalScoredCount: nextScored.length,
      // Keep the "scraped → kept" funnel in sync after a background append.
      gatheredCount: (data.gatheredCount || 0) + gatheredDelta,
      scrapedCount: (data.scrapedCount || 0) + added.length,
      finalSourceCounts,
      scoreRangeMin,
      scoreRangeMax,
      scrapeWarnings: Array.isArray(filteredWarnings) ? filteredWarnings : (data.scrapeWarnings || []),
    });
  }, [id, data.scoredJobs, data.finalSourceCounts, data.gatheredCount, data.scrapedCount, data.scoreRangeMin, data.scoreRangeMax, data.scrapeWarnings, updateGlobal]);

  const triggerUSAJobsBackgroundSearch = useCallback(async () => {
    if (processingRef.current) return;
    if (!isJobSourceEnabledInScope('usajobs')) {
      EventLogger.log(`[JobSearch][${id}] USAJobs background search skipped by job source test-mode scope.`);
      return;
    }

    const query = getPrimaryQuery();
    if (!query) {
      EventLogger.log(`[JobSearch][${id}] No stored queries found to run USAJobs background search.`);
      return;
    }

    processingRef.current = true;
    const currentId = id;
    const cancelled = epoch.start();

    try {
      EventLogger.log(`[JobSearch][${id}] Starting USAJobs background search for query: "${query}"`);
      
      const res = await window.electronAPI.searchJobsSingleSource({
        query,
        sourceId: 'usajobs',
        // Read straight off `data` rather than the `maxAgeDays` const, which is
        // declared further down the component body — referencing it here (and in
        // this callback's deps) would hit the temporal dead zone on every render
        // and crash the node. Mirrors runPipeline's `data.maxAgeDays || 21`.
        maxAgeDays: data.maxAgeDays || 21,
        collectionLimits,
        canvasFilePath,
        nodeId: currentId,
        // Prefer the query-gen-normalized location (typo-safe) over the raw input
        // — USAJobs LocationName is an exact-ish match and won't tolerate "denvr".
        preferredLocation: (data.canonicalLocation || data.preferredLocation || '').trim(),
      });

      if (cancelled()) return;

      if (!res.success) {
        throw new Error(res.error || 'Failed to search USAJobs');
      }

      const freshJobs = res.jobs || [];
      const newWarning = res.warning || null;

      const filteredWarnings = (scrapeWarningsRef.current || []).filter(
        w => w.sourceId !== 'usajobs'
      );
      if (newWarning) {
        filteredWarnings.push({ sourceId: 'usajobs', ...newWarning });
      }

      const currentState = hubStateRef.current;

      if (currentState === 'sources-ready') {
        const prevPending = Array.isArray(pendingJobsRef.current) ? pendingJobsRef.current : [];
        const fresh = uniqueJobsAcrossSources(prevPending, freshJobs);
        const mergedPending = [...prevPending, ...fresh];
        pendingJobsRef.current = mergedPending;
        scrapeWarningsRef.current = filteredWarnings;

        updateGlobal(currentId, {
          pendingJobs: mergedPending,
          jobCount: mergedPending.length,
          scrapeWarnings: filteredWarnings,
        });

        const remainingBlocks = filteredWarnings.filter(isJobSourceWarningGating);
        if (remainingBlocks.length === 0 && mergedPending.length > 0) {
          EventLogger.log(`[JobSearch][${id}] Auto-resuming scoring from sources-ready state.`);
          processingRef.current = false;
          await resumeScoringRef.current?.();
        }
      } else if (currentState === 'done') {
        if (freshJobs.length > 0) {
          setScoringProgress(null); // clear prior counter; backend re-paints "0 / M"
          updateGlobal(currentId, {
            hubState: 'scoring',
            scrapeWarnings: filteredWarnings,
          });

          const profile = data.resumeProfile;
          const activeTargetRole = (data.targetRole || '').trim();

          const scoreResult = await window.electronAPI.scoreJobs({
            jobs: freshJobs,
            profile,
            nodeId: currentId,
            targetRole: activeTargetRole,
            snapshotContext: {
              sourceHubId: currentId,
              canvasFilePath,
              resumeSummary: buildResumeSummary(profile),
            },
          });

          if (cancelled()) return;

          if (!scoreResult.success) {
            throw new Error(scoreResult.error || 'Failed to score background USAJobs');
          }

          appendJobsToDoneCanvas({
            scoredJobs: scoreResult.scoredJobs,
            filteredWarnings,
            gatheredDelta: freshJobs.length,
          });
        } else {
          updateGlobal(currentId, {
            hubState: 'done',
            scrapeWarnings: filteredWarnings,
          });
        }
      }
    } catch (err) {
      if (cancelled() || isNodeDeletedAbort(err)) return;
      EventLogger.error(`[JobSearch][${id}] USAJobs background search/integrate failed:`, err);
      addToast({
        title: 'USAJobs Refresh Failed',
        description: err?.message || String(err),
        type: 'error',
      });
      updateGlobal(currentId, {
        hubState: hubStateRef.current === 'scoring' ? 'done' : hubStateRef.current,
        errorMessage: err?.message || String(err),
      });
    } finally {
      if (isMountedRef.current) {
        processingRef.current = false;
        pendingUSAJobsRefreshRef.current = false;
      }
    }
  }, [id, data.maxAgeDays, collectionLimits, data.preferredLocation, data.canonicalLocation, canvasFilePath, getPrimaryQuery, epoch, updateGlobal, addToast, data.resumeProfile, data.targetRole, appendJobsToDoneCanvas, isMountedRef]);

  const handleJobsSettingsChange = useCallback(async () => {
    if (settingsDebounceTimerRef.current) {
      clearTimeout(settingsDebounceTimerRef.current);
    }
    settingsDebounceTimerRef.current = setTimeout(async () => {
      try {
        const settings = await window.electronAPI.getSettings();
        const usajobsKey = settings?.jobs?.usajobsApiKey;
        const usajobsEmail = settings?.jobs?.usajobsEmail;
        if (!usajobsKey || !usajobsEmail) {
          return;
        }

        const hasConfigOrApiWarning = (data.scrapeWarnings || []).some(
          w => w.sourceId === 'usajobs' && (
            w.code === 'config-missing' ||
            w.code === 'api-failed' ||
            w.code === 'scrape-failed'
          )
        );

        if (hasConfigOrApiWarning) {
          EventLogger.log(`[JobSearch][${id}] USAJobs credentials detected/updated. Refreshing USAJobs...`);
          if (processingRef.current) {
            pendingUSAJobsRefreshRef.current = true;
            EventLogger.log(`[JobSearch][${id}] Pipeline is currently active. Queued USAJobs background refresh.`);
          } else {
            triggerUSAJobsBackgroundSearch();
          }
        }
      } catch (err) {
        EventLogger.error(`[JobSearch][${id}] Error handling jobs settings change:`, err);
      }
    }, 1000);
  }, [id, data.scrapeWarnings, triggerUSAJobsBackgroundSearch]);

  // React to settings changes. We log them for bug report telemetry but do NOT
  // auto-clear the error or revert the state without explicit user action.
  useEffect(() => {
    if (!window.electronAPI?.onSettingsChanged) return;
    const cleanup = window.electronAPI.onSettingsChanged((payload) => {
      if (payload?.changedSections?.includes('ai')) {
        if (data.errorMessage) {
          EventLogger.log(`[JobSearch][${id}] Settings changed with active error; keeping error banner open for explicit user action`);
        }
      }
      if (payload?.changedSections?.includes('jobs')) {
        handleJobsSettingsChange();
      }
    });
    return () => cleanup?.();
  }, [id, data.errorMessage, handleJobsSettingsChange]);

  // (Results-cascade filters — score slider + per-source — moved to the Job Board
  // Module, which now owns the displayed cards. The Job Search Module has no cards
  // to filter.)

  // How far back to look for postings on each search. Persisted on node data
  // so it survives saves and applies to re-runs. 21 days = three weeks; sits
  // between the "freshest" applicant pool and the ~30-day mark where ~43% of
  // postings have been filled (see job-listing-age research notes).
  const maxAgeDays = data.maxAgeDays || 21;
  const setMaxAgeDays = useCallback((val) => {
    const n = Math.max(1, Math.min(JOB_MAX_AGE_DAYS_LIMIT, Math.floor(Number(val) || JOB_DEFAULT_AGE_DAYS)));
    updateGlobal(id, { maxAgeDays: n });
  }, [id, updateGlobal]);

  // Optional target/pivot role. Free text — the ONLY effect is adding
  // target-specific queries to the generated set (see generate-job-queries);
  // scoring, display, and categorization are identical to a no-target run.
  // Persisted so it survives saves and re-runs.
  // Role / location are edited through LOCAL draft state, not bound straight to
  // data.* . React Flow feeds node data via an external store (useSyncExternalStore);
  // re-renders from an external store bypass React's controlled-input caret
  // restoration, so a value={data.targetRole} input jumps the caret to the end on
  // every mid-text edit (backspace/insert). Mirroring locally keeps the value update
  // inside React's own event flow (caret preserved); onChange writes through to the
  // store, and the render-time reconcile picks up EXTERNAL store changes (canvas load
  // / reset) — React's "adjust state when a prop changes" pattern (no effect, so it
  // doesn't trip react-hooks/set-state-in-effect).
  const storeRole = data.targetRole || '';
  const storeLocation = data.preferredLocation || '';
  const [targetRole, setRoleDraft] = useState(storeRole);
  const [lastStoreRole, setLastStoreRole] = useState(storeRole);
  if (storeRole !== lastStoreRole) { setLastStoreRole(storeRole); setRoleDraft(storeRole); }
  const [preferredLocation, setLocationDraft] = useState(storeLocation);
  const [lastStoreLocation, setLastStoreLocation] = useState(storeLocation);
  if (storeLocation !== lastStoreLocation) { setLastStoreLocation(storeLocation); setLocationDraft(storeLocation); }
  const setTargetRole = useCallback((val) => {
    const v = typeof val === 'string' ? val : '';
    setRoleDraft(v);                                  // synchronous local update → caret preserved
    updateGlobal(id, { targetRole: v });              // write through to the persisted store
  }, [id, updateGlobal]);
  const setPreferredLocation = useCallback((val) => {
    const v = typeof val === 'string' ? val : '';
    setLocationDraft(v);
    // The canonical value belongs to the previous input. Clear it immediately so
    // a Continue/background-source action cannot reuse Canada after the user has
    // edited the field to USA (or vice versa) before the next full rerun.
    updateGlobal(id, { preferredLocation: v, canonicalLocation: null });
  }, [id, updateGlobal]);
  // Opt-in "economy" scoring via the provider Batch API: ~50% cheaper but async
  // (results within 24h, not instant). Chosen before the run; only takes effect
  // on paid Claude (free Gemini is already $0) and never in test mode — see the
  // batch-eligibility gate in the scoring path. Real-time is the default.
  const setBatchScoring = useCallback((on) => {
    updateGlobal(id, { batchScoring: !!on });
  }, [id, updateGlobal]);

  // Cascade-delete every spawned child on hub unmount. Only source cards: the
  // results cascade (jobcard/jobgroup) is spawned and owned by the Job Board
  // Module — no card ever carries this hub's id as hubId (the legacy pre-split
  // cascades are healed away by the v2 load migration).
  const cleanupAllJobChildren = useCallback(() => {
    EventLogger.log(`[JobSearch][${id}] Cleaning up source cards`);
    deleteChildrenByHubId({
      getNodes, getEdges, deleteElements, hubId: id,
      childTypes: ['jobsourcecard'],
    });
  }, [id, getNodes, getEdges, deleteElements]);

  useUnmountEffect(cleanupAllJobChildren);
  useUnmountEffect(() => {
    moduleRunQueue.cancelQueuedRunsForNode(id);
  });

  // ── Job-source platform cards (persistent, one per ACTIVE_JOB_SOURCE) ─────
  // Replaces the orbital ring with real canvas nodes connected by edges. Cards
  // are laid out in a circle around the hub — matches the SellHub →
  // CompSourceCard pattern so edges fan to each card's nearest hub side
  // instead of all bunching on one side. The user can drag any card anywhere
  // afterward. Each card subscribes to its own progress events and falls back
  // to the hub's `finalSourceCounts` between runs so the last-known count is
  // shown. Shared by `ensureSourceCards` (idle spawn) and
  // `ensureBlockedSourceCards` (post-run re-spawn for sources missing a card).
  const spawnSourceCardsAround = useCallback((items, edgeColor) => {
    if (items.length === 0) return 0;
    const existing = getNodes().filter(n => n.type === 'jobsourcecard' && n.data?.hubId === id);
    const hubPos = getNode(id)?.position || { x: 0, y: 0 };
    const HUB_W = 260, HUB_H = 140, CARD_W = 140, CARD_H = 50;
    const cx = hubPos.x + HUB_W / 2;
    const cy = hubPos.y + HUB_H / 2;
    const total = existing.length + items.length;
    const stamp = Date.now();
    // Radius scales with card count so cards never overlap as the source list
    // grows (replaces a fixed 320 that only worked for ~12 sources).
    const RADIUS = radialRadius({ count: total, cardW: CARD_W, cardH: CARD_H, hubW: HUB_W, hubH: HUB_H });

    const newNodes = items.map(({ source, persistedProgress }, i) => {
      // Angle the card across the full circle; first card at top (-π/2).
      const angle = ((existing.length + i) / total) * 2 * Math.PI - Math.PI / 2;
      return {
        id: `js-${id}-${source.id}-${stamp}`,
        type: 'jobsourcecard',
        position: {
          x: cx + Math.cos(angle) * RADIUS - CARD_W / 2,
          y: cy + Math.sin(angle) * RADIUS - CARD_H / 2,
        },
        data: {
          sourceId: source.id,
          name:     source.name,
          letter:   source.letter,
          color:    source.color,
          domain:   source.domain,
          hubId:    id,
          ...(persistedProgress ? { persistedProgress } : {}),
        },
      };
    });

    // pickEdgeHandles routes each hub→card edge to the hub's nearest side so
    // edges don't all bunch on one side. Both ends render NodeHandles slots.
    const newEdges = newNodes.map(n => ({
      id: `edge-${id}-${n.id}`,
      source: id,
      target: n.id,
      ...pickEdgeHandles(
        { x: n.position.x + CARD_W / 2, y: n.position.y + CARD_H / 2 },
        { x: cx,                        y: cy                       },
      ),
      ...structuralEdge(edgeColor),
    }));

    if (addElementsGlobally) {
      addElementsGlobally(id, newNodes, newEdges, 'sibling');
    } else {
      addNodes(newNodes);
      addEdges(newEdges);
    }
    return total;
  }, [id, getNode, getNodes, addElementsGlobally, addNodes, addEdges]);

  const pruneDisabledSourceCards = useCallback(() => {
    const allowedSourceIds = new Set(ACTIVE_JOB_SOURCES);
    const staleCards = getNodes().filter(
      n => n.type === 'jobsourcecard' && n.data?.hubId === id && !allowedSourceIds.has(n.data?.sourceId),
    );
    if (staleCards.length === 0) return;
    deleteElements({ nodes: staleCards.map(n => ({ id: n.id })) });
  }, [id, getNodes, deleteElements]);

  useEffect(() => {
    pruneDisabledSourceCards();
  }, [pruneDisabledSourceCards]);

  const ensureSourceCards = useCallback(({ frameSourceCards = true } = {}) => {
    const existingCards = getNodes().filter(n => n.type === 'jobsourcecard' && n.data?.hubId === id);
    const allowedSourceIds = new Set(ACTIVE_JOB_SOURCES);
    const staleCards = existingCards.filter(n => !allowedSourceIds.has(n.data?.sourceId));
    if (staleCards.length > 0) {
      deleteElements({ nodes: staleCards.map(n => ({ id: n.id })) });
    }
    const existingSourceIds = new Set(
      existingCards
        .filter(n => allowedSourceIds.has(n.data?.sourceId))
        .map(n => n.data?.sourceId),
    );
    const missing = ACTIVE_JOB_SOURCES
      .map(sid => JOB_SOURCE_BY_ID[sid])
      .filter(s => s && !existingSourceIds.has(s.id));
    if (missing.length === 0) return;

    const total = spawnSourceCardsAround(
      missing.map(source => ({ source })),
      'rgba(96,165,250,0.5)',
    );

    // requestAnimationFrame gives ReactFlow one tick to register the new nodes;
    // a synchronous fitView would frame only the hub.
    if (frameSourceCards) {
      requestAnimationFrame(() => {
        fitView({ duration: fitViewDuration(total), padding: 0.2 });
      });
    }
  }, [id, getNodes, deleteElements, spawnSourceCardsAround, fitView]);

  // Guarantee every blocked source has a visible, actionable card when we pause
  // in 'sources-ready'. The block decision is finalized only at search END, but
  // source cards come and go DURING the (now long, deep-paginating) run — a card
  // can be gone by the time we pause, leaving "1 source blocked but nothing to
  // Solve." For any blocked source missing a card, spawn one SEEDED with the
  // failure (the live progress event already fired before this card existed, so
  // the reason + Solve target must come from persisted state). A blocked source
  // that still HAS its card already carries the live warning — leave it.
  const ensureBlockedSourceCards = useCallback((blockingWarnings) => {
    const blocks = (blockingWarnings || []).filter(w => isJobSourceWarningGating(w) && w.sourceId);
    if (blocks.length === 0) return;
    const allowedSourceIds = new Set(ACTIVE_JOB_SOURCES);
    const existingSourceIds = new Set(
      getNodes()
        .filter(n => n.type === 'jobsourcecard' && n.data?.hubId === id)
        .map(n => n.data?.sourceId),
    );
    const missing = blocks.filter(w => allowedSourceIds.has(w.sourceId) && !existingSourceIds.has(w.sourceId));
    if (missing.length === 0) return;

    const items = missing.map(w => ({
      source: JOB_SOURCE_BY_ID[w.sourceId] ||
        { id: w.sourceId, name: w.sourceId, letter: (w.sourceId[0] || '?').toUpperCase(), color: '#ef4444', domain: '' },
      persistedProgress: {
        status:  'error',
        // Spread the FULL warning so the re-spawned card keeps resumeState (Indeed
        // 'Continue' resumes instead of full re-scrape), openSecondTab (Glassdoor
        // 2-tab solve), and shortLabel (friendly chip) — not just the 4 base fields.
        warning: { ...w },
        url:     w.url || null,
        count:   0,
      },
    }));
    spawnSourceCardsAround(items, 'rgba(239,68,68,0.6)');
    EventLogger.log(`[JobSearch][${id}] Re-spawned ${missing.length} blocked source card(s) to resolve: ${missing.map(w => w.sourceId).join(', ')}`);
  }, [id, getNodes, spawnSourceCardsAround]);

  // (Result-card filter re-apply + height-driven re-flow moved to the Job Board
  // Module along with the displayed cascade.)

  /**
   * Steps 4-5 of the pipeline: scoring → bucketing → spawn → set 'done'.
   * Extracted so the resume-after-pause path (user cleared their last block
   * warning) can re-enter scoring without re-fetching the resume + search.
   *
   * The caller is responsible for: setting processingRef true, capturing the
   * cancellation epoch, finally-clearing processingRef. Mirrors the marketplace
   * synthesizeAndPrice pattern.
   */
  // Post-scoring: STORE the scored jobs + summary counts → mark done. The Job
  // Search Module no longer buckets or spawns the results cascade — that moved to
  // the Job Board Module, which reads data.scoredJobs from each connected search
  // module, re-buckets the union, and displays the merged tree. Shared by the
  // real-time path (runScoringAndSpawn) and the async batch path (the poll
  // effect) so both leave the hub in the same done summary state. (`profile`,
  // `originalPos`, `activeTargetRole` are still passed by callers but no longer
  // needed here.)
  const finishScoringAndSpawn = useCallback(async ({
    scoredJobs, gatheredCount, scrapedCount, scrapeWarnings = [],
    aiSkipped = false, collectionOnly = false, testMode = false, hiddenApplied = 0,
    jobRunId = null, cancelled = () => false,
  }) => {
    if (cancelled()) return;
    const displayed = Array.isArray(scoredJobs) ? scoredJobs : [];

    const finalSourceCounts = {};
    displayed.forEach(job => { finalSourceCounts[job.source] = (finalSourceCounts[job.source] || 0) + 1; });

    const scores = displayed.map(j => j.matchScore || 0);
    const scoreRangeMin = scores.length ? Math.min(...scores) : 0;
    const scoreRangeMax = scores.length ? Math.max(...scores) : 100;

    if (canvasFilePath && displayed.length > 0) {
      const historyRows = displayed.map(j => ({
        source: j.source, company: j.company, title: j.title, location: j.location, url: j.url,
      }));
      // Search-jobs has already awaited the authoritative pre-scoring write.
      // This serialized follow-up is needed only for jobs that arrived later
      // through a captcha/paste resolve while scoring was pending; existing rows
      // dedupe to a no-op. Awaiting removes the old fire-and-forget race and
      // records this outcome in the FULL diagnostics snapshot.
      const historyResult = await window.electronAPI.appendJobsHistory({
        canvasFilePath, jobs: historyRows, nodeId: id, historyStage: 'postScoring',
      });
      if (!historyResult?.success || historyResult?.error) {
        EventLogger.error('[JobSearch] Post-scoring history append failed:', historyResult?.error || 'unknown error');
      }
    }

    updateGlobal(id, {
      hubState: 'done',
      scoredJobs: displayed, // read by a connected Job Board Module on Combine
      resultCount: displayed.length,
      totalScoredCount: displayed.length,
      scrapedCount: scrapedCount ?? displayed.length,
      gatheredCount: gatheredCount ?? scrapedCount ?? displayed.length,
      // Keep testMode as a legacy alias for old saved canvases only.
      aiSkipped: !!aiSkipped,
      collectionOnly: !!collectionOnly,
      testMode: !!testMode,
      hiddenApplied,
      finalSourceCounts,
      scoreRangeMin,
      scoreRangeMax,
      pendingJobs: null,
      pendingBatch: null,
      scrapeWarnings: Array.isArray(scrapeWarnings) ? scrapeWarnings : [],
    });

    window.electronAPI?.completeJobRun?.({ canvasFilePath, runId: jobRunId }).catch(() => {});
  }, [id, updateGlobal, canvasFilePath]);

  const runScoringAndSpawn = useCallback(async ({
    profile, jobs, gatheredCount, scrapeWarnings, activeTargetRole, originalPos,
    hiddenApplied = 0, jobRunId = null, cancelled,
  }) => {
    const currentId = id;

    // Step 4: Scoring
    setScoringProgress(null); // clear any prior run's counter; backend re-paints "0 / M"
    updateGlobal(currentId, { hubState: 'scoring', jobCount: jobs.length });
    const scoreResult = await window.electronAPI.scoreJobs({
      jobs,
      profile,
      nodeId: currentId,
      targetRole: activeTargetRole,
      // Opt-in async Batch-API scoring (the score-jobs handler ignores this on
      // Gemini / in test mode / without a saved canvas — see its gate).
      batchScoring: !!data.batchScoring,
      snapshotContext: {
        sourceHubId: currentId,
        canvasFilePath,
        resumeSummary: buildResumeSummary(profile),
      },
    });
    if (cancelled()) return;
    if (!scoreResult.success) {
      const err = new Error(scoreResult.error || 'Failed to score jobs');
      if (scoreResult.isRateLimit) err.isRateLimit = true;
      throw err;
    }

    // Batch path: scoring is async — park in 'scoring-batch' and let the poll
    // effect finish the run when results land (survives an app restart).
    if (scoreResult.batchPending) {
      updateGlobal(currentId, {
        hubState: 'scoring-batch',
        jobCount: jobs.length,
        pendingBatch: {
          batchId: scoreResult.batchId,
          startedAt: Date.now(),
          count: scoreResult.batchCount,
          selectedForScoring: scoreResult.selectedForScoring,
          jobRunId,
          // Carried through the async park so pollBatchOnce can still surface
          // it once results land — hiddenApplied is known at search time, long
          // before the batch resolves, and would otherwise be lost.
          hiddenApplied,
        },
      });
      return;
    }

    await finishScoringAndSpawn({
      scoredJobs: scoreResult.scoredJobs,
      profile,
      gatheredCount,
      scrapedCount: jobs.length,
      scrapeWarnings,
      activeTargetRole,
      originalPos,
      aiSkipped: !!scoreResult.aiSkipped,
      collectionOnly: !!scoreResult.collectionOnly,
      testMode: !!scoreResult.testMode,
      hiddenApplied,
      jobRunId,
      cancelled,
    });
  }, [id, updateGlobal, canvasFilePath, finishScoringAndSpawn, data.batchScoring]);

  // ── Batch-scoring poll: complete the run when async results land ───────────
  // Active only while parked in 'scoring-batch'. Polls immediately on mount (so
  // reopening the app resumes a pending batch) then every 45s. Re-entrancy-
  // guarded so two ticks can't both spawn; completing flips hubState→'done',
  // which tears the effect down.
  const batchCompletingRef = useRef(false);
  const pollBatchOnce = useCallback(async () => {
    if (batchCompletingRef.current) return;
    if (!canvasFilePath || !window.electronAPI?.pollJobBatch) return;
    // Capture cancellation epoch at start, like every other pipeline entry
    // point in this file — without it, a Reset that lands while this poll's
    // pollJobBatch/finishScoringAndSpawn is in flight can still apply the
    // abandoned run's results, silently reviving a hub the user just
    // discarded (the server-side discardJobBatch fired on reset only stops
    // the NEXT poll, not this in-flight one).
    const cancelled = epoch.start();
    let res;
    try { res = await window.electronAPI.pollJobBatch({ canvasFilePath, nodeId: id }); }
    catch (e) { EventLogger.log(`[JobSearch][${id}] batch poll failed: ${e?.message || e}`); return; }
    if (cancelled()) return;
    if (!res?.found) {
      // This hub's batch entry is gone (completed/discarded). If we're still parked
      // in 'scoring-batch' it vanished without delivering — flip to a recoverable
      // terminal rather than spin forever (the poll effect tears down on null).
      const live = getNode(id)?.data?.hubState;
      updateGlobal(id, live === 'scoring-batch'
        ? {
            pendingBatch: null, pendingJobs: null, hubState: 'done',
            scoredJobs: [], finalSourceCounts: {}, resultCount: 0, totalScoredCount: 0,
            scrapedCount: 0, gatheredCount: 0, scoreRangeMin: 0, scoreRangeMax: 100, scoreThreshold: 0,
          }
        : { pendingBatch: null });
      if (live === 'scoring-batch') {
        window.electronAPI?.completeJobRun?.({ canvasFilePath, runId: data.pendingBatch?.jobRunId || data.jobRunId || null }).catch(() => {});
      }
      return;
    }
    // Defense-in-depth: never apply a batch that belongs to a different hub. The
    // per-nodeId sidecar keying already scopes the read; this also guards a legacy
    // single-entry sidecar whose nodeId isn't this hub.
    if (res.nodeId && res.nodeId !== id) return;
    if (res.done && Array.isArray(res.scoredJobs)) {
      if (batchCompletingRef.current) return;
      batchCompletingRef.current = true;
      try {
        await finishScoringAndSpawn({
          scoredJobs: res.scoredJobs,
          profile: data.resumeProfile,
          gatheredCount: res.gatheredCount,
          scrapedCount: res.selectedForScoring ?? res.scoredJobs.length,
          scrapeWarnings: data.scrapeWarnings || [],
          activeTargetRole: (res.targetRole || data.targetRole || '').trim(),
          originalPos: getNode(id)?.position || { x: 0, y: 0 },
          testMode: false,
          // Carried on pendingBatch since search time (runScoringAndSpawn) —
          // the batch result itself has no notion of applied-jobs filtering.
          hiddenApplied: data.pendingBatch?.hiddenApplied || 0,
          jobRunId: data.pendingBatch?.jobRunId || data.jobRunId || null,
          cancelled,
        });
      } finally {
        batchCompletingRef.current = false;
      }
    }
  }, [id, canvasFilePath, updateGlobal, finishScoringAndSpawn, getNode, data.resumeProfile, data.scrapeWarnings, data.targetRole, data.pendingBatch, data.jobRunId, epoch]);

  useEffect(() => {
    if (hubState !== 'scoring-batch' || !data.pendingBatch?.batchId) return undefined;
    pollBatchOnce(); // resume-on-mount + immediate check
    const iv = setInterval(pollBatchOnce, 45000);
    return () => clearInterval(iv);
  }, [hubState, data.pendingBatch?.batchId, pollBatchOnce]);

  // Abandon a pending batch: cancel it server-side and reset the hub to a fresh
  // empty state (the gathered jobs aren't held in the renderer, so this is a
  // start-over, not a switch-to-real-time).
  const cancelBatchScoring = useCallback(async () => {
    try { await window.electronAPI?.discardJobBatch?.({ canvasFilePath, nodeId: id }); } catch { /* best-effort */ }
    updateGlobal(id, { hubState: 'empty', pendingBatch: null, resumeProfile: null, careerData: null, filePath: null });
  }, [canvasFilePath, id, updateGlobal]);

  /**
   * Shared post-search disposition for the search + resume paths: pause in
   * 'sources-ready' when a gating warning blocks (so the user Solves/Skips before
   * we spend AI tokens), OR terminate 'done' when nothing was found. Returns
   * false in both of those terminal/paused cases, true when the caller should
   * proceed to score. The block-gate MUST precede the empty terminal: a run can
   * return 0 jobs *because* the only productive source was blocked, and those
   * jobs only get scored via the 'sources-ready' auto-resume after Solve.
   *
   * Each caller passes its OWN inputs so the deliberate per-path differences are
   * preserved: `warnings` (runPipeline passes already-resolved-filtered
   * effectiveWarnings; resume passes raw), and `canvasFilePath` (runPipeline's
   * live closure vs. resume's await-stable snapshot). The test-mode collect and
   * the score handoff (with each path's own gatheredCount) stay with the caller.
   */
  const handlePostSearchResult = useCallback(({
    currentId, foundJobs, warnings, blockingWarnings, profile, activeTargetRole, canvasFilePath: cfp,
    hiddenApplied = 0, jobRunId = null,
  }) => {
    // Persisted here (not just at the final 'done' write in finishScoringAndSpawn)
    // because a run that pauses on a blocking warning goes through THIS branch
    // instead — without writing it here, a search that hid N applied jobs but
    // also hit a captcha/rate-limit would show 0 hidden until Solve is clicked,
    // and resumeScoring's own hidden-applied reads (hiddenAppliedRef, synced
    // from data.hiddenApplied) would start from a false 0 instead of N.
    hiddenAppliedRef.current = hiddenApplied;
    jobRunIdRef.current = jobRunId;
    if (blockingWarnings.length > 0 && !SKIP_AI_FOR_TESTING) {
      // These refs are the synchronous source of truth for an immediate
      // Resolve/Skip click before React commits the update below.
      pendingJobsRef.current = foundJobs;
      scrapeWarningsRef.current = warnings;
      hubStateRef.current = 'sources-ready';
      updateGlobal(currentId, {
        hubState: 'sources-ready',
        pendingJobs: foundJobs,
        pendingTargetRole: activeTargetRole,
        jobCount: foundJobs.length,
        scrapeWarnings: warnings,
        hiddenApplied,
        jobRunId,
      });
      // Guarantee a Solve/Skip card for every blocked source — a card can be lost
      // during the long run, stranding the user with "blocked but nothing to resolve".
      ensureBlockedSourceCards(blockingWarnings);
      // A LinkedIn "Solve" re-enriches from the saved analysis snapshot (normally
      // written by score-jobs, which hasn't run yet) — persist it now so Solve has
      // jobs to work with instead of no-opping.
      if (blockingWarnings.some(w => w?.code === 'linkedin-rate-limited')) {
        window.electronAPI?.saveJobAnalysisSnapshot?.({
          jobs: foundJobs,
          profile,
          nodeId: currentId,
          targetRole: activeTargetRole,
          snapshotContext: { sourceHubId: currentId, canvasFilePath: cfp, resumeSummary: buildResumeSummary(profile) },
        }).catch(() => {});
      }
      return false;
    }

    if (foundJobs.length === 0) {
      // Genuinely empty — no blocked sources left to recover. Terminal 'done'.
      // Reset slider range + counts so the done-state UI doesn't show stale values.
      updateGlobal(currentId, {
        hubState: 'done',
        scoredJobs: [],
        finalSourceCounts: {},
        resultCount: 0,
        totalScoredCount: 0,
        scrapedCount: 0,
        gatheredCount: 0,
        scoreRangeMin: 0,
        scoreRangeMax: 100,
        scoreThreshold: 0,
        scrapeWarnings: warnings,
        hiddenApplied,
        pendingJobs: null,
        pendingBatch: null,
        jobRunId,
      });
      pendingJobsRef.current = null;
      scrapeWarningsRef.current = warnings;
      hubStateRef.current = 'done';
      window.electronAPI?.completeJobRun?.({ canvasFilePath: cfp, runId: jobRunId }).catch(() => {});
      return false;
    }

    return true;
  }, [updateGlobal, ensureBlockedSourceCards]);

  /**
   * Drives the full pipeline. Pass `filePath` for a fresh resume parse, or
   * `profile` to skip parsing and re-run from query construction onward.
   * `filePath` takes precedence when both are provided.
   */
  const runPipeline = useCallback(async ({
    filePath,
    filePaths,
    profile: providedProfile,
    frameSourceCards = true,
  } = {}) => {
    if (!window.electronAPI || processingRef.current) return;
    // Career data can come from one OR many dropped files; normalize to a list.
    // A single `filePath` (canvas-created hub) still works as a one-element list.
    const paths = (Array.isArray(filePaths) && filePaths.length)
      ? filePaths.filter(Boolean)
      : (filePath ? [filePath] : []);
    if (paths.length === 0 && !providedProfile) return;
    processingRef.current = true;
    const currentId = id;
    // Capture cancellation epoch at start; cancelled() returns true after
    // any reset/unmount so we can drop late settlements without mutating
    // freshly-reverted state.
    const cancelled = epoch.start();
    let lease = null;

    try {
      lease = await moduleRunQueue.acquireModuleRun({
        nodeId: currentId,
        kind: 'jobsearch',
        label: 'Job search',
        onQueued: ({ position }) => {
          updateGlobal(currentId, {
            hubState: 'queued',
            queuedModuleRun: { label: 'Job search', position },
            errorMessage: null,
            isRateLimit: false,
            testModeNote: null,
          });
        },
        onQueueUpdate: ({ position }) => {
          updateGlobal(currentId, { queuedModuleRun: { label: 'Job search', position } });
        },
        onStart: () => {
          if (cancelled()) throw new Error('Node deleted');
          updateGlobal(currentId, { queuedModuleRun: null });
        },
      });

      cancelCleanSourceCardDismiss();
      resetSourceProgress();
      // The hub-side reset above only clears OUR aggregate hook. Source cards hold
      // their own local count and a re-run keeps them on canvas, so broadcast a
      // reset to make every card drop the previous run's count now (else they paint
      // stale "{N} jobs" until each source's first fresh event arrives this run).
      document.dispatchEvent(new CustomEvent('job-source-progress-reset', { detail: { hubId: id } }));

      // Snapshot the node position so we can spawn siblings near it even if
      // the user navigates away and unmounts this layer of the canvas.
      const originalPos = getNode(currentId)?.position || { x: 0, y: 0 };

      updateGlobal(currentId, { errorMessage: null, isRateLimit: false, testModeNote: null });
      let profile = providedProfile;
      let resumeFingerprint = data.resumeFingerprint || '';

      // Pre-flight: check only sources that require a browser session before
      // expensive scraping starts. LinkedIn is intentionally excluded; its job
      // fetch + description enrichment are anonymous/public flows.
      const JOB_LOGIN_IDS = getJobAuthPreflightSourceIds();
      const notLoggedIn = (await Promise.all(
        JOB_LOGIN_IDS.map(async (platformId) => {
          const res = await window.electronAPI.checkJobPlatformAuth?.({ platformId });
          if (res?.connected) return null;
          return JOB_SOURCE_BY_ID[platformId]?.name || platformId;
        })
      )).filter(Boolean);
      if (notLoggedIn.length > 0) {
        throw Object.assign(
          new Error(`Log in to ${notLoggedIn.join(', ')} first (Settings → Job Platform Logins)`),
          { isLoginGate: true, notLoggedIn }
        );
      }

      // Spawn (or reuse) one platform card per active job source only after the
      // login gate passes. ensureSourceCards intentionally frames all source
      // cards, which must not replace the user's zoom/pan for a login request.
      ensureSourceCards({ frameSourceCards });

      // Step 1: Parse career data (only when fresh files were dropped). Any
      // number/type of files are transcribed + merged into one `careerData`
      // blob server-side; a structured `profile` is derived from the merge and
      // drives the rest of the pipeline exactly as the old single-resume profile
      // did. A re-drop always re-parses (it's an explicit user action); the
      // file-less re-search path below reuses the stored profile instead.
      if (paths.length > 0) {
        updateGlobal(currentId, { hubState: 'parsing' });
        const parseResult = await window.electronAPI.parseCareerData({ filePaths: paths, nodeId: currentId });
        if (cancelled()) return;
        if (!parseResult.success) {
          const err = new Error(parseResult.error || 'Failed to parse career files');
          if (parseResult.isRateLimit) err.isRateLimit = true;
          throw err;
        }
        profile = parseResult.profile;
        resumeFingerprint = String(parseResult.fingerprint || '');

        updateGlobal(currentId, {
          hubState: 'querying',
          resumeProfile: profile,
          careerData: parseResult.careerData,
          resumeSummary: buildResumeSummary(profile),
          resumeFingerprint,
          resumeContext: {
            skills: profile.skills,
            experience: profile.experience_years,
          },
        });
      } else {
        updateGlobal(currentId, { hubState: 'querying' });
      }

      // Step 2: Query construction
      const activeTargetRole = (data.targetRole || '').trim();
      const activePreferredLocation = (data.preferredLocation || '').trim();
      const queryCacheKey = buildQueryCacheKey({
        resumeFingerprint,
        targetRole: activeTargetRole,
        preferredLocation: activePreferredLocation,
      });
      const canReuseQueries = !!(
        profile &&
        data.queries &&
        data.queryCacheKey &&
        data.queryCacheKey === queryCacheKey
      );
      let queriesResult = null;
      if (canReuseQueries) {
        queriesResult = {
          success: true,
          queries: data.queries,
          queryModel: data.queryModel || null,
        };
        EventLogger.log(`[JobSearch][${currentId}] Resume/query inputs unchanged — reusing stored search queries`);
      } else {
        queriesResult = await window.electronAPI.generateJobQueries({
          profile, nodeId: currentId, targetRole: activeTargetRole, preferredLocation: activePreferredLocation,
        });
        if (cancelled()) return;
        if (!queriesResult.success) {
          const err = new Error(queriesResult.error || 'Failed to generate queries');
          if (queriesResult.isRateLimit) err.isRateLimit = true;
          throw err;
        }
      }
      const {
        titleQueries = [], suggestedRoleQueries = [], targetRoleQueries = [],
      } = queriesResult.queries || {};
      const allQueries = [...targetRoleQueries, ...titleQueries, ...suggestedRoleQueries];
      const queryModel = queriesResult.queryModel || null;
      // The query-gen LLM normalizes the free-form location (typos/abbreviations)
      // so the programmatic filters (USAJobs LocationName, Dice location, geoTerms)
      // don't choke on "denvr". On a cache hit we reuse the persisted canonical;
      // fall back to the raw input so this is never worse than before.
      const canonicalLocation =
        (canReuseQueries ? data.canonicalLocation : queriesResult.canonicalLocation)
        || activePreferredLocation;

      // Step 3: Search
      handledDuringSearchRef.current.clear();
      updateGlobal(currentId, {
        hubState: 'searching',
        queryCount: allQueries.length,
        queries: queriesResult.queries,
        // Keep the exact flattened role set that this run gave to search-jobs.
        // Source-card Solve can fire much later (or after a hot reload), when it
        // must apply the same final title-relevance policy to recovered rows.
        activeSearchQueries: allQueries,
        queryModel,
        queryCacheKey,
        canonicalLocation,
        resumeFingerprint,
      });
      const searchResult = await window.electronAPI.searchJobs({
        queries: allQueries,
        nodeId: currentId,
        maxAgeDays: data.maxAgeDays || 21,
        collectionLimits,
        canvasFilePath,
        preferredLocation: canonicalLocation,
        // The user's ORIGINAL free-form input (e.g. "denvr") — telemetry only, so
        // the bug report can show the typo-correction (denvr → Denver, CO) it
        // can't otherwise see (only the canonical is used for the actual search).
        rawLocation: activePreferredLocation,
        // Candidate's own locations — the keyword-less company-board sources
        // (Greenhouse/Lever/RemoteOK/WWR) must NOT treat the city baked into a
        // job title as role relevance, or a Denver cinematographer pulls in
        // every Denver SWE/sales posting at Datadog et al.
        profileLocations: profile?.locations || [],
      });
      if (cancelled()) return;

      // Dice API hard failure: retries exhausted on 5xx — abort entire pipeline.
      if (!searchResult.success && searchResult.diceApiDown) {
        throw new Error(searchResult.error || 'Dice API is unavailable — search cancelled');
      }

      // Backend login gate: if any browser-scraped platform isn't connected
      // the search handler returns early with notLoggedIn instead of running.
      if (!searchResult.success && Array.isArray(searchResult.notLoggedIn) && searchResult.notLoggedIn.length > 0) {
        const names = searchResult.notLoggedIn.map(loginId => JOB_SOURCE_BY_ID[loginId]?.name || loginId);
        throw Object.assign(
          new Error(`Log in to ${names.join(', ')} first (Settings → Job Platform Logins)`),
          { isLoginGate: true, notLoggedIn: searchResult.notLoggedIn }
        );
      }
      const searchWarnings = Array.isArray(searchResult.scrapeWarnings) ? searchResult.scrapeWarnings : [];
      // Filter warnings for sources the user already handled during the search.
      // The backend doesn't know about those mid-run resolves/dismissals and
      // returns its original warning list. Restoring that stale entry would undo
      // the user's decision and can re-block a source they already skipped.
      const alreadyHandled = handledDuringSearchRef.current;
      const effectiveWarnings = filterHandledJobSourceWarnings(searchWarnings, alreadyHandled);
      const blockingWarnings = effectiveWarnings.filter(isJobSourceWarningGating);

      // Merge backend's foundJobs with any jobs already resolved via paste during
      // the search — they're in pendingJobsRef but absent from the backend result.
      // Resolved items go FIRST: the dedup is first-wins, and on a collision the
      // resolved copy is the one carrying work the user paid for mid-run (a
      // LinkedIn Solve's enriched descriptions) while the backend copy of the
      // same posting is the pre-enrichment one.
      let foundJobs = (searchResult.success && Array.isArray(searchResult.jobs)) ? searchResult.jobs : [];
      const rawGatheredCount = searchResult.rawCount ?? foundJobs.length;
      const hiddenApplied = searchResult.hiddenApplied || 0;
      if (alreadyHandled.size > 0) {
        const prevPending = Array.isArray(pendingJobsRef.current) ? pendingJobsRef.current : [];
        const resolvedItems = prevPending.filter(j => alreadyHandled.has(j?.source));
        if (resolvedItems.length > 0) {
          foundJobs = dedupJobsAcrossSources([...resolvedItems, ...foundJobs]);
        }
      }

      // Disposition the search result: pause in 'sources-ready' on a gating
      // warning, or terminate 'done' when empty (block-gate MUST precede empty —
      // see handlePostSearchResult). Only proceed to score when neither fires.
      const shouldScore = handlePostSearchResult({
        currentId, foundJobs, warnings: effectiveWarnings, blockingWarnings,
        profile, activeTargetRole, canvasFilePath, hiddenApplied,
        jobRunId: searchResult.runId || null,
      });
      if (!shouldScore) return;

      if (SKIP_AI_FOR_TESTING) {
        try {
          await window.electronAPI?.saveJobAnalysisSnapshot?.({
            jobs: foundJobs,
            profile,
            nodeId: currentId,
            targetRole: activeTargetRole,
            snapshotContext: {
              sourceHubId: currentId,
              canvasFilePath,
              resumeSummary: buildResumeSummary(profile),
            },
          });
        } catch (err) {
          EventLogger.error(`[JobSearch][${currentId}] Failed to save test-mode prompt snapshot:`, err);
        }
        EventLogger.log(`[JobSearch][${currentId}] SKIP_AI_FOR_TESTING — ${foundJobs.length} jobs collected, stopping before AI scoring`);
        // search-jobs already awaited its authoritative pre-scoring history
        // write. `foundJobs` may additionally contain jobs merged from a
        // captcha/paste resolve while the search was running, however; this
        // collection-only branch bypasses finishScoringAndSpawn, so reconcile
        // those late arrivals here through the same serialized IPC write.
        if (canvasFilePath && foundJobs.length > 0) {
          const historyRows = foundJobs.map(j => ({
            source: j.source, company: j.company, title: j.title, location: j.location, url: j.url,
          }));
          const historyResult = await window.electronAPI.appendJobsHistory({
            canvasFilePath, jobs: historyRows, nodeId: currentId, historyStage: 'postScoring',
          });
          if (!historyResult?.success || historyResult?.error) {
            EventLogger.error('[JobSearch] Collection-only history reconciliation failed:', historyResult?.error || 'unknown error');
          }
        }
        updateGlobal(currentId, {
          hubState: 'done',
          scoredJobs: [],
          finalSourceCounts: {},
          resultCount: 0,
          scrapedCount: foundJobs.length,
          gatheredCount: rawGatheredCount,
          testMode: true,
          aiSkipped: true,
          collectionOnly: true,
          totalScoredCount: 0,
          scoreRangeMin: 0,
          scoreRangeMax: 100,
          scoreThreshold: 0,
          scrapeWarnings: effectiveWarnings,
          hiddenApplied,
          pendingJobs: null,
          pendingBatch: null,
          jobRunId: searchResult.runId || null,
          testModeNote: `[Test mode] ${foundJobs.length} jobs collected — AI scoring disabled`,
        });
        window.electronAPI?.completeJobRun?.({ canvasFilePath, runId: searchResult.runId || null }).catch(() => {});
        return;
      }

      await runScoringAndSpawn({
        profile,
        jobs: foundJobs,
        gatheredCount: rawGatheredCount,
        scrapeWarnings: effectiveWarnings,
        activeTargetRole,
        originalPos,
        hiddenApplied,
        jobRunId: searchResult.runId || null,
        cancelled,
      });
    } catch (error) {
      // User cancelled (Reset) OR deleted the hub mid-pipeline. The
      // Node-deleted branch handles the race where the backend abort
      // settles BEFORE the unmount effect has bumped the epoch — without
      // it, we'd write a useless errorMessage onto data that's about to
      // be discarded and log a misleading "pipeline failed" line.
      if (cancelled() || isNodeDeletedAbort(error)) return;
      if (!error?.isLoginGate) EventLogger.error('JobSearchNode pipeline failed:', error);
      // Revert to the logical step ('done' if any results exist on the
      // canvas, else 'empty') and surface the failure via errorMessage so
      // HubErrorBanner picks it up.
      // "Has results" = scored jobs are stored (the cascade now lives on a Job
      // Board Module, not as children of this hub), so a prior successful run
      // keeps 'done' on a later error; a never-completed hub falls back to 'empty'.
      const hubHasResults = (getNode(currentId)?.data?.scoredJobs?.length || 0) > 0;
      updateGlobal(currentId, {
        hubState: hubHasResults ? 'done' : 'empty',
        errorMessage: error?.message || String(error),
        isRateLimit: !!error?.isRateLimit,
      });
    } finally {
      lease?.release();
      if (isMountedRef.current) {
        processingRef.current = false;
        if (pendingUSAJobsRefreshRef.current) {
          pendingUSAJobsRefreshRef.current = false;
          setTimeout(() => {
            if (isMountedRef.current) {
              triggerUSAJobsBackgroundSearch();
            }
          }, 0);
        }
      }
    }
  }, [id, updateGlobal, getNode, canvasFilePath, data.maxAgeDays, collectionLimits, data.targetRole, data.preferredLocation, data.canonicalLocation, data.resumeFingerprint, data.queries, data.queryCacheKey, data.queryModel, ensureSourceCards, handlePostSearchResult, epoch, resetSourceProgress, runScoringAndSpawn, triggerUSAJobsBackgroundSearch, cancelCleanSourceCardDismiss, moduleRunQueue, isMountedRef]);

  const startProcessing = useCallback((fileOrFiles, { frameSourceCards = true } = {}) => {
    const filePaths = Array.isArray(fileOrFiles) ? fileOrFiles : (fileOrFiles ? [fileOrFiles] : []);
    return runPipeline({ filePaths, frameSourceCards });
  }, [runPipeline]);
  const startProcessingWithProfile = useCallback(
    (profile, { frameSourceCards = true } = {}) => runPipeline({ profile, frameSourceCards }),
    [runPipeline],
  );

  /**
   * Resume the pipeline from the paused 'sources-ready' state. Picks up the
   * partial search results stored in data.pendingJobs and re-enters scoring.
   * Called either:
   *  - automatically when the user has resolved or skipped every blocking
   *    warning (drained via the job-source-skip listener below), or
   *  - manually via the "Score current results" button on the paused-state
   *    UI, which also clears any remaining scrapeWarnings before resuming.
   */
  const resumeScoring = useCallback(async () => {
    if (processingRef.current) return;
    // Read the live refs, NOT data.pendingJobs/data.scrapeWarnings: onResolved
    // merges freshly-extracted items into pendingJobsRef and then calls this
    // synchronously, before React re-renders — so the data closure still holds
    // the pre-merge list. That was the "captcha resolve inline-extracted 15
    // jobs but only 1 got scored" bug (and why the cleared warnings weren't
    // persisted). The refs are updated on every render AND synchronously by the
    // resolve/skip handlers, so they're always at least as fresh as data.
    const pending = pendingJobsRef.current;
    const profile = data.resumeProfile;
    if (!pending || !Array.isArray(pending) || pending.length === 0) {
      // Nothing was collected (every blocked source got skipped, or a resolve
      // yielded no items) — finish in the terminal empty 'done' state instead
      // of leaving the hub stuck on the paused 'sources-ready' screen. Needed
      // now that a 0-jobs-but-blocked run pauses in 'sources-ready' with an
      // empty pendingJobs (see the block gate in runPipeline).
      updateGlobal(id, {
        hubState: 'done', scoredJobs: [], finalSourceCounts: {},
        resultCount: 0, totalScoredCount: 0, scrapedCount: 0, gatheredCount: 0,
        scoreRangeMin: 0, scoreRangeMax: 100, scoreThreshold: 0,
        pendingJobs: null,
        scrapeWarnings: Array.isArray(scrapeWarningsRef.current) ? scrapeWarningsRef.current : [],
        // Carry forward whatever was hidden during the original search/resolves
        // even though nothing survived to score — a run that hid every result
        // as already-applied should say so, not read as "0 jobs found" with no
        // explanation (design §6.2: filtering must never be silent).
        hiddenApplied: hiddenAppliedRef.current || 0,
      });
      window.electronAPI?.completeJobRun?.({ canvasFilePath, runId: data.jobRunId || null }).catch(() => {});
      return;
    }
    if (!profile) return;
    processingRef.current = true;
    const currentId = id;
    const cancelled = epoch.start();
    let lease = null;
    try {
      lease = await moduleRunQueue.acquireModuleRun({
        nodeId: currentId,
        kind: 'jobsearch',
        label: 'Job scoring',
        onQueued: ({ position }) => {
          updateGlobal(currentId, {
            hubState: 'queued',
            queuedModuleRun: { label: 'Scoring job results', position },
            errorMessage: null,
            isRateLimit: false,
          });
        },
        onQueueUpdate: ({ position }) => {
          updateGlobal(currentId, { queuedModuleRun: { label: 'Scoring job results', position } });
        },
        onStart: () => {
          if (cancelled()) throw new Error('Node deleted');
          updateGlobal(currentId, { queuedModuleRun: null });
        },
      });
      const originalPos = getNode(currentId)?.position || { x: 0, y: 0 };
      await runScoringAndSpawn({
        profile,
        jobs: pending,
        scrapeWarnings: Array.isArray(scrapeWarningsRef.current) ? scrapeWarningsRef.current : [],
        activeTargetRole: data.pendingTargetRole || data.targetRole || '',
        originalPos,
        // Without this, a run that paused in 'sources-ready' (hiddenApplied
        // written by handlePostSearchResult) or picked up more via a mid-pause
        // Solve (added by the job-source-resolved handler below) would report
        // hiddenApplied:0 at the final 'done' write — runScoringAndSpawn
        // defaults it to 0 when omitted, which this call was doing until now.
        hiddenApplied: hiddenAppliedRef.current || 0,
        jobRunId: data.jobRunId || null,
        cancelled,
      });
    } catch (error) {
      if (cancelled() || isNodeDeletedAbort(error)) return;
      EventLogger.error('[JobSearch] Resume scoring failed:', error);
      updateGlobal(currentId, {
        hubState: 'sources-ready',
        errorMessage: error?.message || String(error),
        isRateLimit: !!error?.isRateLimit,
      });
    } finally {
      lease?.release();
      if (isMountedRef.current) {
        processingRef.current = false;
        if (pendingUSAJobsRefreshRef.current) {
          pendingUSAJobsRefreshRef.current = false;
          setTimeout(() => {
            if (isMountedRef.current) {
              triggerUSAJobsBackgroundSearch();
            }
          }, 0);
        }
      }
    }
  }, [id, data.resumeProfile, data.pendingTargetRole, data.targetRole, data.jobRunId, canvasFilePath, epoch, getNode, runScoringAndSpawn, updateGlobal, triggerUSAJobsBackgroundSearch, moduleRunQueue, isMountedRef]);

  useEffect(() => {
    resumeScoringRef.current = resumeScoring;
  }, [resumeScoring]);

  // ── Crash/quit recovery: detect an incomplete prior run + offer to resume ────
  // On load (and whenever the canvas file changes) ask the main process whether a
  // recent, unfinished job run left staged jobs next to the canvas. If so, surface
  // a non-blocking banner; Resume recovers the staged jobs and continues scoring,
  // Dismiss clears the sidecars. See electron/ipc/jobRunStaging.js.
  const [resumeOffer, setResumeOffer] = useState(null);
  const activeResumeLocation = normalizeLocationInput(data.canonicalLocation || data.preferredLocation || '').boardReady;
  const offeredResumeLocation = normalizeLocationInput(resumeOffer?.canonicalLocation || '').boardReady;
  const canResumeOffer = !!resumeOffer?.locationRecorded && activeResumeLocation === offeredResumeLocation;
  useEffect(() => {
    if (!canvasFilePath || !window.electronAPI?.peekJobRun) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const info = await window.electronAPI.peekJobRun({ canvasFilePath });
        if (!cancelled) setResumeOffer(info?.found && info?.resumable ? info : null);
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [canvasFilePath]);

  const handleResumeRun = useCallback(async () => {
    const cfp = canvasFilePath;
    const offer = resumeOffer;
    setResumeOffer(null);
    if (processingRef.current || !offer) return;
    if (!canResumeOffer) {
      updateGlobal(id, {
        errorMessage: offer.locationRecorded
          ? `The unfinished run targeted ${offeredResumeLocation || 'no location'}, while this hub now targets ${activeResumeLocation || 'no location'}. Start fresh to keep locations separate.`
          : 'This unfinished run is missing location-safe resume metadata. Start fresh to keep locations separate.',
      });
      return;
    }
    const profile = data.resumeProfile;
    const queries = Array.isArray(offer.queries) ? offer.queries : [];
    // Need a profile (persists in node data across restarts) + the run's queries.
    if (!profile || queries.length === 0) {
      await window.electronAPI?.discardJobRun?.({ canvasFilePath: cfp }).catch(() => {});
      return;
    }
    processingRef.current = true;
    const currentId = id;
    const cancelled = epoch.start();
    const activeTargetRole = data.targetRole || '';
    let lease = null;
    try {
      lease = await moduleRunQueue.acquireModuleRun({
        nodeId: currentId,
        kind: 'jobsearch',
        label: 'Resume job search',
        onQueued: ({ position }) => {
          updateGlobal(currentId, {
            hubState: 'queued',
            queuedModuleRun: { label: 'Resuming job search', position },
            errorMessage: null,
            isRateLimit: false,
          });
        },
        onQueueUpdate: ({ position }) => {
          updateGlobal(currentId, { queuedModuleRun: { label: 'Resuming job search', position } });
        },
        onStart: () => {
          if (cancelled()) throw new Error('Node deleted');
          updateGlobal(currentId, { queuedModuleRun: null });
        },
      });

      const originalPos = getNode(currentId)?.position || { x: 0, y: 0 };
      updateGlobal(currentId, { hubState: 'searching' });
      // resume:true → search-jobs re-scrapes only the unfinished sources from their
      // last completed page and reuses staged jobs from finished sources.
      const searchResult = await window.electronAPI.searchJobs({
        queries,
        nodeId: currentId,
        maxAgeDays: data.maxAgeDays || 21,
        collectionLimits,
        canvasFilePath: cfp,
        preferredLocation: data.canonicalLocation || data.preferredLocation || '',
        rawLocation: data.preferredLocation || '',
        profileLocations: profile?.locations || [],
        resume: true,
      });
      if (cancelled()) return;
      const foundJobs = (searchResult?.success && Array.isArray(searchResult.jobs)) ? searchResult.jobs : [];
      const warnings = Array.isArray(searchResult?.scrapeWarnings) ? searchResult.scrapeWarnings : [];
      const blockingWarnings = warnings.filter(isJobSourceWarningGating);
      const hiddenApplied = searchResult?.hiddenApplied || 0;
      // Same post-search disposition as runPipeline (block-gate pause / empty terminal).
      const shouldScore = handlePostSearchResult({
        currentId, foundJobs, warnings, blockingWarnings,
        profile, activeTargetRole, canvasFilePath: cfp, hiddenApplied,
        jobRunId: searchResult?.runId || null,
      });
      if (!shouldScore) return;
      await runScoringAndSpawn({
        profile, jobs: foundJobs, gatheredCount: searchResult.rawCount ?? foundJobs.length,
        scrapeWarnings: warnings, activeTargetRole, originalPos,
        hiddenApplied, jobRunId: searchResult?.runId || null, cancelled,
      });
    } catch (error) {
      if (cancelled() || isNodeDeletedAbort(error)) return;
      EventLogger.error('[JobSearch] Resume run failed:', error);
      updateGlobal(currentId, { hubState: 'empty', errorMessage: error?.message || String(error), isRateLimit: !!error?.isRateLimit });
    } finally {
      lease?.release();
      if (isMountedRef.current) processingRef.current = false;
    }
  }, [canvasFilePath, resumeOffer, canResumeOffer, offeredResumeLocation, activeResumeLocation, id, data.resumeProfile, data.targetRole, data.maxAgeDays, collectionLimits, data.preferredLocation, data.canonicalLocation, epoch, getNode, updateGlobal, runScoringAndSpawn, handlePostSearchResult, moduleRunQueue, isMountedRef]);

  const handleDiscardResume = useCallback(async () => {
    setResumeOffer(null);
    try { await window.electronAPI?.discardJobRun?.({ canvasFilePath }); } catch { /* best-effort */ }
  }, [canvasFilePath]);

  // Listen for individual job-source skips dispatched from JobSourceCardNode.
  // Each event drops the matching warning from data.scrapeWarnings; once the
  // remaining list is empty AND we're in the paused 'sources-ready' state,
  // auto-resume scoring with whatever the partial search collected.
  useEffect(() => {
    const onSkip = (e) => {
      if (e.detail?.hubId !== id) return;
      const skippedSourceId = e.detail?.sourceId;
      if (!skippedSourceId) return;
      const warningAction = e.detail?.action === 'dismiss' ? 'dismiss' : 'skip';
      if (hubStateRef.current === 'searching') {
        // A decision made while the other sources are still running must survive
        // the backend's stale final warning list. Otherwise an early Skip can
        // reappear at search completion and pause the pipeline a second time.
        handledDuringSearchRef.current.add(skippedSourceId);
      }
      const remaining = (scrapeWarningsRef.current || []).filter(w => w.sourceId !== skippedSourceId);
      scrapeWarningsRef.current = remaining;
      updateGlobal(id, { scrapeWarnings: remaining });
      EventLogger.log(
        `[JobSearch][${id}] User ${warningAction === 'dismiss' ? 'dismissed non-blocking warning' : 'skipped blocked source'} ${skippedSourceId}`
        + ` code=${e.detail?.warningCode || 'unknown'} severity=${e.detail?.warningSeverity || 'unknown'}`
        + ` hubState=${hubStateRef.current || 'unknown'} pendingJobs=${Array.isArray(pendingJobsRef.current) ? pendingJobsRef.current.length : 0}`,
      );
      // Resume once no GATING warning remains (captcha/login walls + the LinkedIn
      // rate-limit; see isJobSourceWarningGating). info-severity warnings (e.g. USAJobs
      // config-missing, shown so the user knows why that source returned 0 but
      // not requiring action) and non-LinkedIn throttles should NOT keep the
      // resume from firing — the user already addressed every actionable block.
      const remainingBlocks = remaining.filter(isJobSourceWarningGating);
      if (
        remainingBlocks.length === 0 &&
        hubStateRef.current === 'sources-ready' &&
        !processingRef.current
      ) {
        scheduleCleanSourceCardDismiss('all-blocks-skipped');
        // resumeScoring scores pendingJobs, or finishes in empty 'done' when
        // none were collected — so skipping the last blocked source never
        // leaves the hub stuck on the paused screen.
        resumeScoringRef.current?.();
      }
    };
    document.addEventListener('job-source-skip', onSkip);
    return () => document.removeEventListener('job-source-skip', onSkip);
  }, [id, updateGlobal, scheduleCleanSourceCardDismiss]);

  // Listen for job-source-resolved dispatched after a successful Solve.
  // Carries `items` — jobs extracted inline from the visible browser session
  // that just cleared the bot challenge. Merge them into pendingJobs by
  // (title|company|url) fingerprint so a retry-of-a-retry doesn't double-
  // count, drop the source's warning, and auto-resume scoring if this was
  // the last block.
  useEffect(() => {
    const onResolved = (e) => {
      if (e.detail?.hubId !== id) return;
      // A Solve can outlive its originating paused run. Re-run clears the
      // renderer token synchronously, and a fresh search installs a new token;
      // either way, a late result from the old run is ignored.
      if ((e.detail?.jobRunId || null) !== (jobRunIdRef.current || null)) {
        EventLogger.log(`[JobSearch][${id}] Ignored stale source resolve for ${e.detail?.sourceId || 'unknown source'}`);
        return;
      }
      const resolvedSourceId = e.detail?.sourceId;
      if (!resolvedSourceId) return;
      const items = Array.isArray(e.detail?.items) ? e.detail.items : [];
      // Track sources resolved while the search is still running so the
      // search-completion handler can skip re-blocking them with the stale
      // backend warnings.
      if (hubStateRef.current === 'searching') {
        handledDuringSearchRef.current.add(resolvedSourceId);
      }
      // Merge new items into pendingJobs. LinkedIn re-fetch returns the full
      // source set and requests replacement; captcha/Continue flows return
      // incremental pages and keep already-captured same-source jobs.
      const prevPending = Array.isArray(pendingJobsRef.current) ? pendingJobsRef.current : [];
      const replaceSourceItems = !!e.detail?.replaceSourceItems;
      const { fresh, mergedPending, replacedExisting } = mergeResolvedSourceItems(
        prevPending,
        items,
        resolvedSourceId,
        { replaceSourceItems },
      );
      pendingJobsRef.current = mergedPending;
      // Drop the resolved source's warning — then re-add it if the resolve came
      // back STILL warned (LinkedIn re-enrich hit the per-IP guest ceiling again,
      // or the VPN switch hadn't taken so it's the same warm IP). This keeps the
      // done-state ScrapeWarningsPanel mirroring the card's actionable state
      // instead of clearing on every attempt regardless of outcome. Captcha /
      // resume resolves carry no warning, so they clear cleanly as before.
      const resolveWarning = e.detail?.warning || null;
      const remaining = (scrapeWarningsRef.current || []).filter(w => w.sourceId !== resolvedSourceId);
      if (resolveWarning) {
        remaining.push({ sourceId: resolvedSourceId, ...resolveWarning });
      }
      scrapeWarningsRef.current = remaining;
      // resolve-job-source/resume-job-source run the SAME filterOutApplied pass
      // as the initial search (electron/ipc/jobs.js) and return their own
      // hiddenApplied count on the result — JobSourceCardNode forwards it here
      // as e.detail.hiddenApplied. Without adding it in, a captcha Solve or an
      // Indeed pagination resume that itself suppressed already-applied jobs
      // would leave the hub's hiddenApplied stuck at whatever the initial
      // (pre-Solve) search saw, silently undercounting the funnel.
      const resolvedHiddenApplied = Number(e.detail?.hiddenApplied) || 0;
      const nextHiddenApplied = (hiddenAppliedRef.current || 0) + resolvedHiddenApplied;
      hiddenAppliedRef.current = nextHiddenApplied;
      updateGlobal(id, {
        pendingJobs: mergedPending,
        jobCount: mergedPending.length,
        scrapeWarnings: remaining,
        hiddenApplied: nextHiddenApplied,
      });
      // Auto-resume on no remaining GATING warnings (info / non-LinkedIn throttle stays).
      const remainingBlocks = remaining.filter(isJobSourceWarningGating);
      // Report the actual merge outcome back to the main process so the bug
      // report can show "net pendingJobs change" rather than just the IPC-side
      // "kept" count. The IPC side doesn't know the renderer dropped same-source
      // existing jobs first (replace-and-dedup), so without this the report says
      // "new: 11" when the actual net change may be 0 (11 replaced 11).
      window.electronAPI.recordResolveMerge?.({
        sourceId: resolvedSourceId,
        replacedExisting,
        fresh: fresh.length,
        pendingBefore: prevPending.length,
        pendingAfter: mergedPending.length,
      });
      EventLogger.log(`[JobSearch][${id}] Resolved ${resolvedSourceId}: received ${items.length} item(s), +${fresh.length} new → pendingJobs ${prevPending.length}→${mergedPending.length}; ${remainingBlocks.length} block warning(s) remain`);
      if (
        remainingBlocks.length === 0 &&
        hubStateRef.current === 'sources-ready' &&
        !processingRef.current
      ) {
        scheduleCleanSourceCardDismiss('all-blocks-resolved');
        // resumeScoring scores the merged jobs, or finishes in empty 'done' if
        // the resolve cleared the last block but yielded nothing to score.
        resumeScoringRef.current?.();
      }
    };
    document.addEventListener('job-source-resolved', onResolved);
    return () => document.removeEventListener('job-source-resolved', onResolved);
  }, [id, updateGlobal, scheduleCleanSourceCardDismiss]);

  // Optimistic counterpart to onResolved: JobSourceCardNode dispatches this the
  // instant the user clicks Solve (before the resolve runs). Drop the matching
  // non-blocking warning so the done-state "N throttled" panel reflects the
  // in-flight retry immediately instead of sitting stale through a multi-minute
  // re-fetch — onResolved re-adds it if the attempt comes back still-warned.
  // Gating warnings (block/paste AND the LinkedIn rate-limit) are intentionally
  // left untouched: they gate the paused 'sources-ready' state, and dropping one
  // here could mis-fire auto-resume before the block is actually cleared.
  useEffect(() => {
    const onRetryStart = (e) => {
      if (e.detail?.hubId !== id) return;
      const sid = e.detail?.sourceId;
      if (!sid) return;
      const current = scrapeWarningsRef.current || [];
      const w = current.find(x => x.sourceId === sid);
      if (!w || isJobSourceWarningGating(w)) return;
      const remaining = current.filter(x => x.sourceId !== sid);
      scrapeWarningsRef.current = remaining;
      updateGlobal(id, { scrapeWarnings: remaining });
    };
    document.addEventListener('job-source-retry-start', onRetryStart);
    return () => document.removeEventListener('job-source-retry-start', onRetryStart);
  }, [id, updateGlobal]);

  // "Score current results" button on the paused-state UI: clear all
  // remaining warnings (user chose to proceed without resolving) and resume.
  const handleScoreCurrentResults = useCallback(() => {
    if (data.hubState !== 'sources-ready') return;
    scrapeWarningsRef.current = [];
    updateGlobal(id, { scrapeWarnings: [] });
    scheduleCleanSourceCardDismiss('score-current-results');
    resumeScoring();
  }, [id, data.hubState, updateGlobal, resumeScoring, scheduleCleanSourceCardDismiss]);

  // Keep the ref up-to-date so handleDrop always calls the latest version.
  useEffect(() => {
    startProcessingRef.current = startProcessing;
  }, [startProcessing]);

  // Auto-start when drop-created (must come after startProcessing is declared
  // — referencing it earlier would hit the const TDZ on first render).
  useEffect(() => {
    if (data.filePath && hubState === 'empty' && !processingRef.current) {
      startProcessing(data.filePath);
    }
  }, [data.filePath, hubState, startProcessing]);

  // Handle file drops directly onto this node. Any NUMBER and TYPE of files are
  // accepted — they're merged into one "career data" blob downstream (résumé,
  // portfolio, project notes, brag doc, …). App bundles are filtered with a
  // clear message; everything else flows to the backend, which reads PDFs/DOCX
  // inline, images via vision, and falls back to utf8 text.
  const acceptCareerFiles = useCallback((paths, names = []) => {
    // Each hub is permanently bound to its INITIAL career-data upload. Once that
    // exists, further drops are refused — re-running a search reuses the same
    // résumé, and searching with different career data means a NEW hub.
    if (initialDropAcceptedRef.current || dropLockReason || processingRef.current) {
      EventLogger.log(`[JobSearch][${id}] Drop rejected: hub already started`);
      addToast({
        title: 'Career data is locked',
        description: 'This job search is tied to your original career files. Create a new job search to use different ones.',
        type: 'info',
      });
      return;
    }
    const valid = [];
    paths.forEach((p, i) => {
      const nm = names[i] || p || '';
      if (!p) return;
      if (/\.app$/i.test(nm)) {
        EventLogger.log(`[JobSearch][${id}] Drop skipped: app bundle (${nm})`);
        return;
      }
      valid.push(p);
    });
    if (valid.length === 0) {
      addToast({
        title: 'No usable files',
        description: 'Drop PDF, DOCX, TXT, or image files of your career history (macOS apps are not accepted).',
        type: 'error',
      });
      return;
    }
    initialDropAcceptedRef.current = true;
    lastDroppedPathsRef.current = valid;
    EventLogger.log(`[JobSearch][${id}] Drop accepted: ${valid.length} file(s)`);
    updateGlobal(id, { inputLocked: true });
    startProcessingRef.current?.(valid);
  }, [addToast, dropLockReason, id, updateGlobal]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (data.locked) return;
    if (platformsVerifying || inputDropsBlocked) return;
    if (PROCESSING_STATES.includes(hubState)) return;

    const files = Array.from(e.dataTransfer?.files || []);
    const exts = summarizeFileExtensions(files);
    EventLogger.log(`[JobSearch][${id}] Drop attempt: ${files.length} file(s) ext=[${exts.join(', ') || 'none'}]`);
    if (files.length === 0) return;

    const payloads = filesToDropPayloads(files);
    acceptCareerFiles(payloads.map(file => file.path), payloads.map(file => file.name));
  }, [acceptCareerFiles, data.locked, hubState, id, inputDropsBlocked, platformsVerifying]);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.hubId !== id) return;
      if (data.locked) return;
      if (platformsVerifying || inputDropsBlocked) return;
      if (PROCESSING_STATES.includes(hubStateRef.current)) return;
      const droppedFiles = (e.detail?.files || []).filter(f => f?.filePath);
      if (droppedFiles.length === 0) return;
      EventLogger.log(`[JobSearch][${id}] Document-node drop received: ${droppedFiles.length} file(s)`);
      acceptCareerFiles(droppedFiles.map(f => f.filePath), droppedFiles.map(f => f.filename));
    };
    document.addEventListener('canvas-file-nodes-dropped-on-hub', handler);
    return () => document.removeEventListener('canvas-file-nodes-dropped-on-hub', handler);
  }, [acceptCareerFiles, data.locked, id, inputDropsBlocked, platformsVerifying]);

  const resetHandler = useCallback((e) => {
    e?.stopPropagation();
    if (data.locked) return;

    EventLogger.log(`[JobSearch][${id}] User clicked Reset`);

    // Bump the epoch so any in-flight runPipeline step that settles after
    // this point sees a mismatch and bails (doesn't overwrite the freshly-
    // reverted state or spawn orphan nodes).
    epoch.bump();
    moduleRunQueue.cancelQueuedRunsForNode(id);

    // Actually abort the backend — without this the AbortControllers registered
    // against this nodeId keep running and finish a few seconds later, often
    // bouncing the UI back to a "done" state the user just dismissed.
    window.electronAPI?.cancelNodeTask?.(id);

    // Also clear filePath. The auto-start effect re-fires runPipeline whenever
    // `data.filePath && hubState === 'empty' && !processingRef.current`, so
    // leaving filePath set after a reset to 'empty' would immediately re-parse
    // the same resume — the user clicked Reset, not Retry. They can drop the
    // resume again or click Try Again on the error state.
    lastDroppedPathsRef.current = null;
    // Cancel + clean up any pending async batch scoring (best-effort).
    if (data.pendingBatch?.batchId) window.electronAPI?.discardJobBatch?.({ canvasFilePath, nodeId: id }).catch(() => {});
    // Drop stale results too: an 'empty' hub must not keep scoredJobs from a prior
    // run — otherwise a connected Job Board could still read them (defense-in-depth
    // with the board's hubState!=='done' gate). Résumé/careerData are kept (the
    // hub is locked to its initial résumé — see project memory).
    updateGlobal(id, {
      hubState: 'empty', queuedModuleRun: null, filePath: null, errorMessage: null, isRateLimit: false, testModeNote: null, pendingBatch: null,
      scoredJobs: null, resultCount: 0, totalScoredCount: 0, scoreThreshold: 0, jobRunId: null,
    });
    jobRunIdRef.current = null;
    cancelCleanSourceCardDismiss();
    resetSourceProgress();
    cleanupAllJobChildren();
    processingRef.current = false;
  }, [data.locked, id, updateGlobal, epoch, resetSourceProgress, cleanupAllJobChildren, cancelCleanSourceCardDismiss, data.pendingBatch, canvasFilePath, moduleRunQueue]);

  const handleRerun = useCallback(({ frameSourceCards = true } = {}) => {
    if (data.locked || processingRef.current) return;
    const droppedPaths = lastDroppedPathsRef.current;
    const effectivePaths = (Array.isArray(droppedPaths) && droppedPaths.length)
      ? droppedPaths
      : (data.filePath ? [data.filePath] : []);
    if (effectivePaths.length === 0 && !data.resumeProfile) {
      addToast({ title: 'No Career Files', description: 'Drop your career files onto the hub to search again.', type: 'error' });
      return;
    }

    // (No result tree to remove — the cascade lives on the Job Board Module,
    // which detects this hub's new data via its staleness signature and
    // prompts a re-combine. Source-card tiles persist across re-runs.)

    // Clear any paused-pipeline buffer so the new run doesn't accidentally
    // resume the previous attempt's partial results. Also wipe the prior run's
    // scrape warnings so the "N throttled" panel doesn't linger if this re-run
    // errors out before its completion handler can overwrite them with the new
    // run's outcome.
    scrapeWarningsRef.current = [];
    pendingJobsRef.current = null;
    jobRunIdRef.current = null;
    updateGlobal(id, { pendingJobs: null, pendingTargetRole: null, scrapeWarnings: [], jobRunId: null });
    cancelCleanSourceCardDismiss();
    resetSourceProgress();
    // Reset the persisting source cards the instant Re-run is clicked, before the
    // async re-parse — startProcessingWithProfile re-broadcasts at scrape start,
    // but this clears the stale counts immediately so they don't linger.
    document.dispatchEvent(new CustomEvent('job-source-progress-reset', { detail: { hubId: id } }));
    if (effectivePaths.length > 0) {
      // Files still accessible — re-parse for freshness then run full pipeline
      startProcessingRef.current?.(effectivePaths, { frameSourceCards });
    } else {
      // Files gone but profile is persisted — run from query step onward
      addToast({ title: 'Re-running Search', description: 'Using stored career profile — original files not needed.', type: 'info' });
      startProcessingWithProfile(data.resumeProfile, { frameSourceCards });
    }
  }, [data.locked, data.filePath, data.resumeProfile, id, addToast, startProcessingWithProfile, resetSourceProgress, updateGlobal, cancelCleanSourceCardDismiss]);

  const isProcessing = PROCESSING_STATES.includes(hubState);

  // Compute running total from per-source progress
  const totalSourceJobs = Object.values(sourceProgress).reduce((sum, p) => sum + (p.count || 0), 0);

  const clearSessionBtnRef = useRef(null);
  const handleClearBrowserSession = useCallback(async () => {
    EventLogger.log(`[JobSearch][${id}] User cleared browser session`);
    const btn = clearSessionBtnRef.current;
    if (btn) btn.textContent = 'Clearing…';
    await window.electronAPI?.clearBrowserSession?.();
    if (btn) {
      btn.textContent = 'Session cleared';
      setTimeout(() => { if (clearSessionBtnRef.current) clearSessionBtnRef.current.textContent = 'Reset browser session'; }, 2000);
    }
  }, [id]);

  useEffect(() => {
    // The "Resume saved scrape" banner is a skip-AI testing affordance — only
    // that mode ever creates the snapshot (scrape now, AI-score later). In
    // full/normal runs never surface it, even if a stale snapshot file is left
    // over from prior testing: a full run produces fresh results that supersede
    // it (and trashes the file on start), so offering to resume it would mislead.
    // (savedAnalysisMeta is only ever set below, so an early return keeps it at
    // its initial null in full mode — no synchronous setState in the effect.)
    if (!SKIP_AI_FOR_TESTING) return;
    if (!['empty', 'done', 'sources-ready'].includes(hubState)) return;
    let cancelled = false;
    void (async () => {
      if (!window.electronAPI?.getLastJobAnalysisSnapshot) {
        if (!cancelled) setSavedAnalysisMeta(null);
        return;
      }
      try {
        const res = await window.electronAPI.getLastJobAnalysisSnapshot({ canvasFilePath });
        if (cancelled) return;
        if (
          res?.success &&
          res.exists &&
          res.meta &&
          Array.isArray(res.snapshot?.jobs) &&
          res.snapshot.jobs.length > 0 &&
          res.snapshot?.profile
        ) {
          setSavedAnalysisMeta(res.meta);
        } else {
          setSavedAnalysisMeta(null);
        }
      } catch {
        if (!cancelled) setSavedAnalysisMeta(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hubState, canvasFilePath]);

  const handleOpenSavedPrompt = useCallback(async () => {
    if (!savedAnalysisMeta?.promptPath) return;
    try {
      await window.electronAPI?.openFile?.(savedAnalysisMeta.promptPath);
    } catch (err) {
      addToast({
        title: 'Could Not Open Saved Prompt',
        description: err?.message || String(err),
        type: 'error',
      });
    }
  }, [savedAnalysisMeta, addToast]);

  const handleResumeSavedScrape = useCallback(async () => {
    if (data.locked || processingRef.current || platformsVerifying) return;
    if (!window.electronAPI?.getLastJobAnalysisSnapshot) return;

    setSavedAnalysisLoading(true);
    try {
      const res = await window.electronAPI.getLastJobAnalysisSnapshot({ canvasFilePath });
      const snapshot = res?.success && res.exists ? res.snapshot : null;
      const savedJobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
      const profile = snapshot?.profile;
      if (!snapshot || !profile || savedJobs.length === 0) {
        addToast({
          title: 'No Saved Scrape',
          description: 'No saved scrape data is available to resume.',
          type: 'error',
        });
        setSavedAnalysisMeta(null);
        return;
      }

      EventLogger.log(`[JobSearch][${id}] Resuming from saved scrape (${savedJobs.length} job(s))`);
      processingRef.current = true;
      cancelCleanSourceCardDismiss();
      resetSourceProgress();
      const currentId = id;
      const cancelled = epoch.start();
      const originalPos = getNode(currentId)?.position || { x: 0, y: 0 };
      const activeTargetRole = String(snapshot.targetRole || '').trim();
      updateGlobal(currentId, {
        errorMessage: null,
        isRateLimit: false,
        testModeNote: null,
        pendingJobs: null,
        pendingTargetRole: null,
        resumeProfile: profile,
        resumeSummary: buildResumeSummary(profile),
        resumeContext: {
          skills: profile.skills,
          experience: profile.experience_years,
        },
        targetRole: activeTargetRole,
      });

      try {
        await runScoringAndSpawn({
          profile,
          jobs: savedJobs,
          gatheredCount: snapshot.gatheredJobCount ?? savedJobs.length,
          scrapeWarnings: [],
          activeTargetRole,
          originalPos,
          cancelled,
        });
      } catch (error) {
        if (cancelled() || isNodeDeletedAbort(error)) return;
        EventLogger.error('[JobSearch] Resume from saved scrape failed:', error);
        const hubHasResults = (getNode(currentId)?.data?.scoredJobs?.length || 0) > 0;
        updateGlobal(currentId, {
          hubState: hubHasResults ? 'done' : 'empty',
          errorMessage: error?.message || String(error),
          isRateLimit: !!error?.isRateLimit,
        });
      } finally {
        if (isMountedRef.current) processingRef.current = false;
      }
    } finally {
      if (isMountedRef.current) setSavedAnalysisLoading(false);
    }
  }, [addToast, cancelCleanSourceCardDismiss, canvasFilePath, data.locked, epoch, getNode, id, platformsVerifying, resetSourceProgress, runScoringAndSpawn, updateGlobal, isMountedRef]);

  const handleDismissError = useCallback(() => {
    EventLogger.log(`[JobSearch][${id}] User clicked Dismiss Error`);
    updateGlobal(id, { errorMessage: null, isRateLimit: false, testModeNote: null });
    // Cleanup orphaned platform cards if this hub never produced results (the
    // results cascade lives on a Job Board Module now, so "has results" = stored
    // scoredJobs rather than on-canvas job cards).
    const hubHasResults = (getNode(id)?.data?.scoredJobs?.length || 0) > 0;
    if (!hubHasResults) {
      EventLogger.log(`[JobSearch][${id}] Dismissing error with no stored results; cleaning up orphaned source cards`);
      cleanupAllJobChildren();
    }
  }, [id, updateGlobal, getNode, cleanupAllJobChildren]);

  const handleRetryFailed = useCallback(() => {
    if (data.locked) return;
    EventLogger.log(`[JobSearch][${id}] User clicked Try Again on error banner`);
    updateGlobal(id, { errorMessage: null, isRateLimit: false, testModeNote: null });
    handleRerun({ frameSourceCards: false });
  }, [data.locked, id, updateGlobal, handleRerun]);

  const savedAnalysisWarning = getSavedAnalysisWarning(savedAnalysisMeta, id, canvasFilePath);
  const savedAnalysisPanel = savedAnalysisMeta ? (
    <div className="mt-2 w-full rounded-md border border-white/10 bg-white/5 px-2 py-2 text-left">
      <div className="text-[9px] uppercase tracking-[0.14em] text-white/25">Saved Scrape</div>
      <div className="mt-1 text-[10px] text-white/65">
        {savedAnalysisMeta.gatheredJobCount} scraped
        {savedAnalysisMeta.selectedJobCount ? ` • ${savedAnalysisMeta.selectedJobCount} selected for AI` : ''}
      </div>
      {!!savedAnalysisMeta.targetRole && (
        <div className="text-[9px] text-white/35">{savedAnalysisMeta.targetRole}</div>
      )}
      <div className="text-[9px] text-white/30">
        {savedAnalysisMeta.createdAt ? new Date(savedAnalysisMeta.createdAt).toLocaleString() : 'Saved locally'}
      </div>
      {!!savedAnalysisMeta.resumeSummary && (
        <div className="mt-1 text-[9px] text-white/25">{savedAnalysisMeta.resumeSummary}</div>
      )}
      {!!savedAnalysisWarning && (
        <div className="mt-1 text-[9px] text-amber-300/80">{savedAnalysisWarning}</div>
      )}
      <div className="mt-2 flex gap-1.5">
        <button
          className="nodrag flex-1 rounded border border-blue-400/30 bg-blue-400/10 px-2 py-1 text-[9px] text-blue-100 hover:bg-blue-400/15 disabled:cursor-default disabled:opacity-50"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleResumeSavedScrape}
          disabled={savedAnalysisLoading}
        >
          {savedAnalysisLoading ? 'Resuming…' : 'Resume saved scrape'}
        </button>
        <button
          className="nodrag rounded border border-white/10 bg-white/5 px-2 py-1 text-[9px] text-white/55 hover:bg-white/10"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleOpenSavedPrompt}
          type="button"
        >
          Open prompt
        </button>
      </div>
    </div>
  ) : null;

  // Non-blocking "resume an unfinished run?" banner — only in idle states so it
  // never overlays a live pipeline. Resume recovers staged jobs and scores them.
  const resumeBanner = (resumeOffer && (hubState === 'empty' || hubState === 'done')) ? (
    <div className="m-2 p-2 rounded-md bg-amber-500/10 border border-amber-500/30" onPointerDown={(e) => e.stopPropagation()}>
      <div className="text-amber-200/90 text-[11px] font-medium leading-snug">Unfinished job search found</div>
      <div className="text-amber-200/60 text-[10px] leading-snug mt-0.5">
        {resumeOffer.gatheredCount} job(s) gathered from {resumeOffer.doneSources}/{resumeOffer.totalSources} source(s){resumeOffer.stage ? ` · stopped at ${resumeOffer.stage}` : ''}.
        {canResumeOffer
          ? ' Resume to continue it, or start fresh.'
          : ` Start fresh — this run targeted ${resumeOffer.locationRecorded ? (offeredResumeLocation || 'no location') : 'an unrecorded legacy location'}, not the current ${activeResumeLocation || 'no location'}.`}
      </div>
      <div className="flex gap-1.5 mt-1.5">
        {canResumeOffer && <button
          className="px-2 py-0.5 rounded text-[10px] font-medium bg-amber-500/80 text-black hover:bg-amber-400"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleResumeRun}
        >Resume</button>}
        <button
          className="px-2 py-0.5 rounded text-[10px] font-medium bg-white/5 text-white/60 hover:bg-white/10"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleDiscardResume}
        >Start fresh</button>
      </div>
    </div>
  ) : null;

  const banner = (
    <>
      {resumeBanner}
      {data.errorMessage ? (
        <HubErrorBanner
          errorMessage={data.errorMessage}
          isRateLimit={!!data.isRateLimit}
          locked={!!data.locked}
          onRetry={handleRetryFailed}
          onDismiss={handleDismissError}
        />
      ) : data.testModeNote ? (
        <div className="m-2 p-2 rounded-md bg-blue-500/10 border border-blue-500/20" onPointerDown={(e) => e.stopPropagation()}>
          <div className="text-blue-300/80 text-[10px] leading-snug">{data.testModeNote}</div>
        </div>
      ) : null}
    </>
  );

  return (
    <HubContainer
      hubState={hubState}
      theme="blue"
      width={260}
      height={undefined}
      minHeight={hubState === 'empty' ? 140 : 100}
      onDrop={handleDrop}
      dropsBlocked={platformsVerifying || inputDropsBlocked}
      verifyProgress={platformsVerifying ? { done: verifyDone, total: verifyTotal } : null}
      dragHover={data.dragHover || null}
    >
        {/* Empty state — drop zone (+ banner if a prior attempt failed) */}
        {hubState === 'empty' && (
          <>
            {banner}
            <div className="flex flex-col items-center justify-center py-8 px-4 cursor-pointer">
              <Briefcase size={28} className="text-blue-400/40 mb-3" />
              {platformsVerifying ? (
                <p className="text-white/40 text-sm font-medium">Checking connections…</p>
              ) : inputDropsBlocked ? (
                <>
                  <p className="text-white/40 text-sm font-medium">Career files locked</p>
                  <p className="text-white/25 text-[10px] mt-1 text-center">Create a new job search module for different files</p>
                </>
              ) : (
                <>
                  <p className="text-white/40 text-sm font-medium">Drop your career files</p>
                  <p className="text-white/25 text-[10px] mt-1 text-center">Résumé, portfolio, project notes — any number of files</p>
                </>
              )}
              {!platformsVerifying && <div
                className="nodrag mt-4 w-full flex flex-col items-stretch gap-1.5 text-[10px] text-white/40"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <input
                  type="text"
                  data-native-undo="true"
                  value={targetRole}
                  onChange={(e) => setTargetRole(e.target.value)}
                  placeholder="Target role (optional) — e.g. Product Manager"
                  className="w-full px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-1 focus:outline-none focus:border-blue-400/50 placeholder:text-white/25"
                />
                <input
                  type="text"
                  data-native-undo="true"
                  value={preferredLocation}
                  onChange={(e) => setPreferredLocation(e.target.value)}
                  placeholder="One search area — e.g. Canada or Denver, Colorado, USA"
                  className="w-full px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-1 focus:outline-none focus:border-blue-400/50 placeholder:text-white/25"
                />
                <div className="flex items-center justify-center gap-1.5">
                  <span>Look back</span>
                  <input
                    type="number"
                    data-native-undo="true"
                    min={1}
                    max={180}
                    value={maxAgeDays}
                    onChange={(e) => setMaxAgeDays(e.target.value)}
                    className="w-10 text-center bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-0.5 focus:outline-none focus:border-blue-400/50"
                  />
                  <span>days</span>
                </div>
                {!data.locked && (
                  <JobCollectionLimitsControl
                    collectionLimits={collectionLimits}
                    setCollectionLimits={setCollectionLimits}
                  />
                )}
                <label
                  className="flex items-center justify-between gap-2 mt-0.5 cursor-pointer select-none"
                  title="Economy scoring: score this run with the Batch API (~50% cheaper) instead of in real time. Results arrive within 24 hours rather than instantly, and the hub keeps the run alive (even across restarts) until they're ready. Only applies on paid Claude — ignored on the free Gemini tier and in test mode. Choose this before dropping your files."
                >
                  <span className="leading-tight">Economy scoring <span className="text-white/25">(batch · up to 24h · ~50% cheaper)</span></span>
                  <input
                    type="checkbox"
                    checked={!!data.batchScoring}
                    onChange={(e) => setBatchScoring(e.target.checked)}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="accent-blue-400 cursor-pointer shrink-0"
                  />
                </label>
                <button
                  ref={clearSessionBtnRef}
                  className="nodrag mt-1 w-full text-[9px] text-white/20 hover:text-white/45 transition-colors bg-transparent border-0 cursor-pointer py-0.5"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={handleClearBrowserSession}
                >
                  Reset browser session
                </button>
                {savedAnalysisPanel}
              </div>}
            </div>
          </>
        )}

        {/* Processing state */}
        {isProcessing && (
          <JobSearchProcessingState
            statusLabel={statusLabel}
            hubState={hubState}
            totalSourceJobs={totalSourceJobs}
            scoringProgress={scoringProgress}
            resumeSummary={data.resumeSummary}
            activeSourceId={lastActiveSource}
            onReset={resetHandler}
            chromeLaunchInfo={chromeLaunchInfo}
            queuedRun={data.queuedModuleRun || null}
          />
        )}

        {/* Async batch scoring submitted — parked until the poll completes it. */}
        {hubState === 'scoring-batch' && (
          <>
            {banner}
            <div className="flex flex-col items-center py-6 px-4 gap-2 text-center" onPointerDown={(e) => e.stopPropagation()}>
              <Clock size={24} className="text-blue-400/50 animate-pulse" />
              <p className="text-white/70 text-sm font-medium">Economy scoring in progress</p>
              <p className="text-white/35 text-[10px] leading-relaxed">
                {(data.pendingBatch?.selectedForScoring || data.jobCount || 0)} jobs queued via the Batch API (~50% cheaper).
                Results arrive within 24h — you can close the app and this hub picks them up when they&apos;re ready.
              </p>
              {!data.locked && (
                <div className="nodrag flex items-center gap-2 mt-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); pollBatchOnce(); }}
                    className="px-2 py-1 rounded-full bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 text-[10px] border border-blue-500/20 transition-colors"
                  >
                    Check now
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); cancelBatchScoring(); }}
                    className="px-2 py-1 rounded-full bg-white/5 text-white/40 hover:bg-red-500/15 hover:text-red-300 text-[10px] border border-white/10 transition-colors"
                    title="Cancel the batch and start over — the gathered jobs aren't kept in memory, so this re-runs from scratch."
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* Paused on blocked sources — show the resolve/skip decision UI.
            Banner stays visible above (e.g. if a prior scoring attempt
            failed and we reverted here). */}
        {hubState === 'sources-ready' && (
          <>
            {banner}
            <JobSearchSourcesReadyState
              // Count DISTINCT blocked sources, not raw warnings: a source can
              // hit a captcha on several queries (indeed-0, indeed-1, …) and
              // store one warning each, but the canvas shows one card per
              // source — so counting warnings made it say "2 sources blocked"
              // with only one Indeed card visible. Skip/resolve already filters
              // warnings by sourceId, so distinct-source count is the truth.
              blockedCount={new Set((data.scrapeWarnings || []).filter(isJobSourceWarningGating).map(w => w.sourceId)).size}
              jobsAvailable={Array.isArray(data.pendingJobs) ? data.pendingJobs.length : (data.jobCount || 0)}
              resumeSummary={data.resumeSummary}
              locked={!!data.locked}
              onScoreCurrent={handleScoreCurrentResults}
            />
            {savedAnalysisPanel && (
              <div className="w-full px-3 pb-3" onPointerDown={(e) => e.stopPropagation()}>
                {savedAnalysisPanel}
              </div>
            )}
          </>
        )}

        {/* Done state — shows stale results + banner above when a re-run failed */}
        {hubState === 'done' && (
          <>
            {banner}
            <JobSearchDoneState
              resultCount={data.resultCount}
              scrapedCount={data.scrapedCount}
              gatheredCount={data.gatheredCount}
              queryModel={data.queryModel || null}
              testMode={!!data.testMode}
              aiSkipped={!!data.aiSkipped}
              collectionOnly={!!data.collectionOnly}
              resumeSummary={data.resumeSummary}
              locked={!!data.locked}
              onRerun={handleRerun}
              maxAgeDays={maxAgeDays}
              setMaxAgeDays={setMaxAgeDays}
              collectionLimits={collectionLimits}
              setCollectionLimits={setCollectionLimits}
              preferredLocation={preferredLocation}
              setPreferredLocation={setPreferredLocation}
              targetRole={targetRole}
              setTargetRole={setTargetRole}
              scrapeWarnings={data.scrapeWarnings || []}
              hiddenApplied={data.hiddenApplied || 0}
            />
            {savedAnalysisPanel && (
              <div className="w-full px-3 pb-3" onPointerDown={(e) => e.stopPropagation()}>
                {savedAnalysisPanel}
              </div>
            )}
          </>
        )}
      </HubContainer>
  );
});
