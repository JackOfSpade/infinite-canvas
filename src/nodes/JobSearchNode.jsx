import React, { useRef, useEffect, useCallback, useContext, useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import { usePlatformsVerifyingProgress } from '../contexts/useSessionStatus';
import { HubContainer } from '../components/HubContainer';
import { Briefcase } from 'lucide-react';
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
import { buildJobHubCareerClearPatch, getHubDropLockReason, hubHasAcceptedInitialDrop } from '../utils/hubDropEligibility';
import { filesToDropPayloads, summarizeFileExtensions } from '../utils/fileDropUtils';
import { filterHandledJobSourceWarnings, isJobSourceWarningGating } from '../utils/jobSourceWarningPolicy';
import { createRunOwnershipGuard } from '../utils/runOwnership';

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
import { JobPlatformSelectionControl } from '../components/JobPlatformSelectionControl';
import { normalizeJobCollectionLimits } from '../utils/jobCollectionLimits';
import { getRunnableJobSourceIds, normalizeEnabledJobSourceIds } from '../utils/jobPlatformSelection';
import { normalizeLocationInput } from '../utils/jobLocation';
import {
  getSearchLocation,
  hasRequiredLocations,
  locationToLegacyText,
  locationValidationMessage,
  normalizeRemoteResidences,
  normalizeStructuredLocation,
  writeLastRemoteResidences,
} from '../utils/jobSearchLocations';
import { buildExactTargetRoleQueryBundle, flattenJobSearchQueries } from '../utils/jobSearchQueries';
import { detectQueryOperators } from '../utils/jobTitleMatch';
import { JobSearchLocationFields } from '../components/JobSearchLocationFields';

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

// The results cascade (hiring-fit/salary/role tree) is no longer spawned here —
// the Job Search Module scrapes + scores + STORES its scored jobs, and a Job
// Board Module (connected by the user) does the bucketing + display. See
// JobBoardNode.jsx and buildJobTree.js (the shared, hubId-agnostic builder).

function buildResumeSummary(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const skills = Array.isArray(profile.skills) ? profile.skills.slice(0, 3).join(', ') : '';
  return `${skills}${profile.experience_years ? `${skills ? ' · ' : ''}${profile.experience_years}y exp` : ''}`.trim();
}

// Capture the whole done-state score summary before a re-analysis changes the
// visible state to queued/scoring. A failed or cancelled re-analysis restores
// this exact snapshot; success is the only path allowed to replace results.
function reanalysisRestorePatch(data) {
  return {
    scoredJobs: Array.isArray(data?.scoredJobs) ? data.scoredJobs : [],
    resultCount: data?.resultCount,
    totalScoredCount: data?.totalScoredCount,
    scrapedCount: data?.scrapedCount,
    gatheredCount: data?.gatheredCount,
    finalSourceCounts: data?.finalSourceCounts,
    scoreRangeMin: data?.scoreRangeMin,
    scoreRangeMax: data?.scoreRangeMax,
    scoreThreshold: data?.scoreThreshold,
    aiSkipped: data?.aiSkipped,
    collectionOnly: data?.collectionOnly,
    testMode: data?.testMode,
    scrapeWarnings: data?.scrapeWarnings,
    rerunOutcome: data?.rerunOutcome,
    rerunNotice: data?.rerunNotice,
    jobCount: data?.jobCount,
  };
}

function buildQueryCacheKey({ resumeFingerprint, targetRole, preferredLocation }) {
  return JSON.stringify({
    // v4: remote salary-comparison residences do not influence generated
    // search queries or whether a cached query bundle can be safely reused.
    strategyVersion: 4,
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

function isSavedAnalysisForCurrentHub(snapshot, meta, currentHubId, currentCanvasFilePath) {
  const sourceHubId = meta?.sourceHubId ?? snapshot?.sourceHubId ?? snapshot?.nodeId ?? null;
  const snapshotCanvasFilePath = meta?.canvasFilePath ?? snapshot?.canvasFilePath ?? null;
  return sourceHubId === currentHubId && snapshotCanvasFilePath === currentCanvasFilePath;
}

/**
 * JobSearchNode — draggable canvas module for job search.
 * Phase 2: Per-source independent status tracking + source filtering.
 *
 * data.hubState: 'empty' | 'parsing' | 'querying' | 'searching' | 'scoring' |
 *                'scoring-batch' | 'sources-ready' | 'done'
 *                'scoring-batch' is a legacy-only recovery state for a Batch API
 *                request submitted by an older version. New searches always use
 *                immediate scoring.
 *                'sources-ready' = paused after search because one or more
 *                sources hit block-severity warnings (captcha, login wall).
 *                The user must resolve or skip them before scoring runs.
 *                Failures set data.errorMessage (surfaced via HubErrorBanner)
 *                but stay in the logical step rather than wiping to an error wall.
 * data.filePath: string (set when auto-created from canvas file drop)
 * data.resultCount: number
 * data.errorMessage: string
 * data.resumeSummary: string
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
  const processingRunsRef = useRef(createRunOwnershipGuard());
  // Present only while the done-state re-analysis owns the run guard. It lets
  // either cancel route (the in-card X or Non-API AI dialog) restore the prior
  // scored results instead of treating this as a full search reset.
  const reanalysisRestoreRef = useRef(null);
  const initialDropAcceptedRef = useRef(false);
  const pendingUSAJobsRefreshRef = useRef(false);
  const scrapeWarningsRef = useRef(data.scrapeWarnings);
  const hubStateRef = useRef(data.hubState);
  const pendingJobsRef = useRef(data.pendingJobs);
  // The collection total is established before a blocked source pauses the
  // pipeline. Keep it in a ref beside pendingJobs so a same-tick Solve/Skip can
  // resume scoring before React commits the paused node data.
  const gatheredCountRef = useRef(data.gatheredCount ?? 0);
  const jobRunIdRef = useRef(data.jobRunId || null);
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
  // A missing allow-list is the saved-canvas-compatible "all platforms" default.
  // The effective list also excludes any platform temporarily unsafe under the
  // selected breadth settings; its persisted preference remains intact and
  // automatically returns when those settings become safe again.
  const enabledSourceIds = useMemo(
    () => normalizeEnabledJobSourceIds(data.enabledSourceIds),
    [data.enabledSourceIds],
  );
  const activeEnabledSourceIds = useMemo(
    () => getRunnableJobSourceIds(enabledSourceIds, ACTIVE_JOB_SOURCES, collectionLimits),
    [enabledSourceIds, collectionLimits],
  );
  const setEnabledSourceIds = useCallback((sourceIds) => {
    const previous = normalizeEnabledJobSourceIds(data.enabledSourceIds);
    const next = normalizeEnabledJobSourceIds(sourceIds);
    const added = next.filter(sourceId => !previous.includes(sourceId));
    const removed = previous.filter(sourceId => !next.includes(sourceId));
    if (added.length || removed.length) {
      EventLogger.log(
        `[JobSearch][${id}] Platform selection changed: ${previous.join(',') || '(none)'} → ${next.join(',') || '(none)'}`
        + `${added.length ? `; enabled=${added.join(',')}` : ''}${removed.length ? `; disabled=${removed.join(',')}` : ''}`,
      );
    }
    updateGlobal(id, { enabledSourceIds: next });
  }, [id, data.enabledSourceIds, updateGlobal]);
  // Same source list as runPipeline's hard login preflight (getJobAuthPreflightSourceIds)
  // — a hand-copied subset here would let the "Checking connections…" gate clear
  // while a platform's own startup verify (which seeds from this same list, see
  // getJobLoginPlatforms) is still in flight, unblocking drops on a stale cache.
  const enabledBrowserLoginSourceIds = useMemo(
    () => getJobAuthPreflightSourceIds(ids => ids.filter(sourceId => activeEnabledSourceIds.includes(sourceId))),
    [activeEnabledSourceIds],
  );
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
  // A cancelled run is rerunnable only once parsing has produced this persisted
  // profile. Before then, cancelling must return the hub to a true first-drop
  // state rather than leaving it locked with nothing usable to rerun.
  const hasReusableCareerProfile = !!(data.resumeProfile && typeof data.resumeProfile === 'object');
  // Whether the hub actually holds career identity (files/profile/lock), as
  // opposed to being drop-blocked for an unrelated reason such as `locked`.
  const hasCareerIdentity = hubHasAcceptedInitialDrop({ type: 'jobhub', data });
  const dropLockReason = getHubDropLockReason({ type: 'jobhub', data });
  const inputDropsBlocked = !!dropLockReason;
  const { verifying: platformsVerifying, done: verifyDone, total: verifyTotal } = usePlatformsVerifyingProgress(enabledBrowserLoginSourceIds);

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
    gatheredCountRef.current = data.gatheredCount ?? 0;
    jobRunIdRef.current = data.jobRunId || null;
  }, [data.scrapeWarnings, data.hubState, data.pendingJobs, data.gatheredCount, data.jobRunId]);

  // Per-source progress state populated by backend `job-source-progress`
  // events. Reset via `resetSourceProgress` before each fresh run so stale
  // counts from the previous run don't bleed into the new pipeline.
  const {
    progress: sourceProgress,
    lastActive: lastActiveSource,
    reset: resetSourceProgress,
  } = useSourceProgress(window.electronAPI?.onJobSourceProgress, id);

  // Live AI-scoring progress (real-time path). The backend emits `scoring-progress`
  // before/during every score attempt and once per completed batch; we surface a
  // determinate "N / M" counter plus in-flight batch context in the 'scoring'
  // state. Filtered by nodeId so concurrent hubs don't cross-update each other.
  // Cleared to null at each scoring-phase entry (see the scoreJobs call sites) so a
  // finished run's final count never lingers; the render gate (hubState==='scoring')
  // also hides it outside the scoring phase.
  const [scoringProgress, setScoringProgress] = useState(null);
  useEffect(() => {
    if (!window.electronAPI?.onScoringProgress) return undefined;
    return window.electronAPI.onScoringProgress((payload) => {
      if (payload?.nodeId && payload.nodeId !== id) return;
      setScoringProgress({
        scored: payload.scored ?? 0,
        total: payload.total ?? 0,
        batch: payload.batch ?? null,
        batchTotal: payload.batchTotal ?? null,
        phase: payload.phase || null,
        attemptSize: payload.attemptSize ?? null,
        detail: payload.detail || null,
      });
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
    const hasGatingWarning = (data.scrapeWarnings || []).some(isJobSourceWarningGating);
    if (hubState === 'sources-ready' || hasGatingWarning) {
      cancelCleanSourceCardDismiss();
      return;
    }
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
  }, [sourceProgress, hubState, data.scrapeWarnings, id, getNodes, scheduleCleanSourceCardDismiss, cancelCleanSourceCardDismiss]);

  const getPrimaryQuery = useCallback(() => {
    return flattenJobSearchQueries(data.queries)[0] || '';
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
      // A background refresh can add jobs after a zero-result run, so the
      // headline returns to the normal scored-jobs summary immediately.
      rerunOutcome: null,
      rerunNotice: null,
    });
  }, [id, data.scoredJobs, data.finalSourceCounts, data.gatheredCount, data.scrapedCount, data.scoreRangeMin, data.scoreRangeMax, data.scrapeWarnings, updateGlobal]);

  const triggerUSAJobsBackgroundSearch = useCallback(async () => {
    if (processingRunsRef.current.active) return;
    if (!isJobSourceEnabledInScope('usajobs') || !activeEnabledSourceIds.includes('usajobs')) {
      EventLogger.log(`[JobSearch][${id}] USAJobs background search skipped because its platform is disabled.`);
      return;
    }

    const query = getPrimaryQuery();
    if (!query) {
      EventLogger.log(`[JobSearch][${id}] No stored queries found to run USAJobs background search.`);
      return;
    }

    const processingToken = processingRunsRef.current.start();
    if (!processingToken) return;
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
        enabledSourceIds,
        canvasFilePath,
        nodeId: currentId,
        // Prefer the query-gen-normalized location (typo-safe) over the raw input
        // — USAJobs LocationName is an exact-ish match and won't tolerate "denvr".
        preferredLocation: (data.canonicalLocation || data.preferredLocation || '').trim(),
        // A pinned role gates this background refresh exactly as it gates the main
        // search, or USAJobs would be the one source able to ship off-role rows.
        targetRole: (data.targetRole || '').trim(),
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
        // This source completed after the main search paused. Its collected
        // volume belongs in the funnel even when every returned row collapses
        // against another source before scoring.
        gatheredCountRef.current = Math.max(
          0,
          (Number(gatheredCountRef.current) || 0) + freshJobs.length,
        );
        pendingJobsRef.current = mergedPending;
        scrapeWarningsRef.current = filteredWarnings;
        updateGlobal(currentId, {
          pendingJobs: mergedPending,
          jobCount: mergedPending.length,
          gatheredCount: gatheredCountRef.current,
          scrapeWarnings: filteredWarnings,
        });

        const remainingBlocks = filteredWarnings.filter(isJobSourceWarningGating);
        if (remainingBlocks.length === 0 && mergedPending.length > 0) {
          EventLogger.log(`[JobSearch][${id}] Auto-resuming scoring from sources-ready state.`);
          processingRunsRef.current.finish(processingToken);
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
          const locationSnapshot = data.locationSnapshot || {
            searchLocation: getSearchLocation({
              searchLocation: data.searchLocation,
              preferredLocation: data.preferredLocation,
              canonicalLocation: data.canonicalLocation,
            }),
            remoteResidences: normalizeRemoteResidences(data.remoteResidences),
          };

          const scoreResult = await window.electronAPI.scoreJobs({
            jobs: freshJobs,
            profile,
            careerData: data.careerData,
            nodeId: currentId,
            targetRole: activeTargetRole,
            searchLocation: locationSnapshot.searchLocation,
            remoteResidences: locationSnapshot.remoteResidences,
            snapshotContext: {
              sourceHubId: currentId,
              runId: jobRunIdRef.current,
              canvasFilePath,
              resumeSummary: buildResumeSummary(profile),
              sourceGatheredCount: (Number(data.gatheredCount) || 0) + freshJobs.length,
              searchLocation: locationSnapshot.searchLocation,
              remoteResidences: locationSnapshot.remoteResidences,
            },
          });

          if (cancelled()) return;

          if (!scoreResult.success) {
            throw new Error(scoreResult.error || 'Failed to score background USAJobs');
          }

          // `scoreJobs` saves its own prompt snapshot, but this background pass
          // scores only the new USAJobs subset. Replace that transient subset
          // snapshot with the same deduped union the done state is about to
          // expose, so Saved Scrape recovery never drops previously visible
          // results after a late source refresh.
          const existingScoredJobs = Array.isArray(data.scoredJobs) ? data.scoredJobs : [];
          const freshScoredJobs = Array.isArray(scoreResult.scoredJobs) ? scoreResult.scoredJobs : [];
          const addedScoredJobs = uniqueJobsAcrossSources(existingScoredJobs, freshScoredJobs);
          const combinedScoredJobs = addedScoredJobs.length
            ? [...existingScoredJobs, ...addedScoredJobs]
            : existingScoredJobs;
          const aggregateSourceGatheredCount = (Number(data.gatheredCount) || 0) + freshJobs.length;
          try {
            const saved = await window.electronAPI?.saveJobAnalysisSnapshot?.({
              jobs: combinedScoredJobs,
              profile,
              careerData: data.careerData,
              nodeId: currentId,
              targetRole: activeTargetRole,
              snapshotContext: {
                sourceHubId: currentId,
                runId: jobRunIdRef.current || null,
                canvasFilePath,
                resumeSummary: buildResumeSummary(profile),
                sourceGatheredCount: aggregateSourceGatheredCount,
                locationSnapshot,
                searchLocation: locationSnapshot.searchLocation,
                remoteResidences: locationSnapshot.remoteResidences,
              },
            });
            if (saved && !saved.saved) {
              EventLogger.error(`[JobSearch][${id}] Failed to save combined USAJobs snapshot: ${saved.error || 'unknown error'}`);
            }
          } catch (snapshotError) {
            // The append itself is already valid; a local recovery snapshot
            // failure must not turn a successful background refresh into an error.
            EventLogger.error(`[JobSearch][${id}] Failed to save combined USAJobs snapshot:`, snapshotError);
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
      if (isMountedRef.current && processingRunsRef.current.finish(processingToken)) {
        pendingUSAJobsRefreshRef.current = false;
      }
    }
  }, [id, data.maxAgeDays, data.gatheredCount, data.scoredJobs, collectionLimits, enabledSourceIds, activeEnabledSourceIds, data.searchLocation, data.preferredLocation, data.canonicalLocation, data.locationSnapshot, data.remoteResidences, data.careerData, canvasFilePath, getPrimaryQuery, epoch, updateGlobal, addToast, data.resumeProfile, data.targetRole, appendJobsToDoneCanvas, isMountedRef]);

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
          if (processingRunsRef.current.active) {
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

  // Optional target/pivot role. When set, it is the one literal scrape query;
  // variation generation is skipped. Scoring/display remain unchanged.
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
  const storeSearchLocation = getSearchLocation(data);
  const storeSearchLocationKey = JSON.stringify(storeSearchLocation);
  const storeRemoteResidences = normalizeRemoteResidences(data.remoteResidences);
  const storeRemoteResidencesKey = JSON.stringify(storeRemoteResidences);
  const [targetRole, setRoleDraft] = useState(storeRole);
  const [lastStoreRole, setLastStoreRole] = useState(storeRole);
  if (storeRole !== lastStoreRole) { setLastStoreRole(storeRole); setRoleDraft(storeRole); }
  const [searchLocation, setSearchLocationDraft] = useState(storeSearchLocation);
  const [lastStoreSearchLocation, setLastStoreSearchLocation] = useState(storeSearchLocationKey);
  if (storeSearchLocationKey !== lastStoreSearchLocation) {
    setLastStoreSearchLocation(storeSearchLocationKey);
    setSearchLocationDraft(storeSearchLocation);
  }
  const [remoteResidences, setRemoteResidencesDraft] = useState(storeRemoteResidences);
  const [lastStoreRemoteResidences, setLastStoreRemoteResidences] = useState(storeRemoteResidencesKey);
  if (storeRemoteResidencesKey !== lastStoreRemoteResidences) {
    setLastStoreRemoteResidences(storeRemoteResidencesKey);
    setRemoteResidencesDraft(storeRemoteResidences);
  }
  // Non-blocking advisory only — the typed text is always sent through
  // unchanged. Boolean syntax is unsafe to broadcast: measured across the seven
  // boards, negation is ignored (and count-INCREASING) on Glassdoor, LinkedIn
  // and ZipRecruiter, destructive on Google and USAJobs, and on ZipRecruiter it
  // inverts intent — "Controller NOT carpenter NOT superintendent" returned five
  // results, every one of them a carpenter or superintendent. None of that is
  // visible in the run report, so the warning has to happen at the input.
  const roleOperators = detectQueryOperators(targetRole);

  const setTargetRole = useCallback((val) => {
    const v = typeof val === 'string' ? val : '';
    setRoleDraft(v);                                  // synchronous local update → caret preserved
    updateGlobal(id, { targetRole: v });              // write through to the persisted store
  }, [id, updateGlobal]);
  const setSearchLocation = useCallback((next) => {
    const normalized = normalizeStructuredLocation(next);
    setSearchLocationDraft(normalized);
    // `preferredLocation` remains as a compatibility projection for saved
    // canvases and existing board adapters. It is never parsed from a new UI
    // value to decide country/subdivision semantics.
    updateGlobal(id, {
      searchLocation: normalized,
      preferredLocation: locationToLegacyText(normalized),
      canonicalLocation: null,
    });
  }, [id, updateGlobal]);
  const setRemoteResidence = useCallback((key, next) => {
    if (!['usa', 'canada', 'other'].includes(key)) return;
    const normalized = normalizeRemoteResidences({ ...remoteResidences, [key]: next });
    setRemoteResidencesDraft(normalized);
    writeLastRemoteResidences(normalized);
    updateGlobal(id, { remoteResidences: normalized });
  }, [id, remoteResidences, updateGlobal]);
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
    const allowedSourceIds = new Set(activeEnabledSourceIds);
    const staleCards = getNodes().filter(
      n => n.type === 'jobsourcecard' && n.data?.hubId === id && !allowedSourceIds.has(n.data?.sourceId),
    );
    if (staleCards.length === 0) return;
    deleteElements({ nodes: staleCards.map(n => ({ id: n.id })) });
  }, [id, getNodes, deleteElements, activeEnabledSourceIds]);

  useEffect(() => {
    pruneDisabledSourceCards();
  }, [pruneDisabledSourceCards]);

  const ensureSourceCards = useCallback(({ frameSourceCards = true } = {}) => {
    const existingCards = getNodes().filter(n => n.type === 'jobsourcecard' && n.data?.hubId === id);
    const allowedSourceIds = new Set(activeEnabledSourceIds);
    const staleCards = existingCards.filter(n => !allowedSourceIds.has(n.data?.sourceId));
    if (staleCards.length > 0) {
      deleteElements({ nodes: staleCards.map(n => ({ id: n.id })) });
    }
    const existingSourceIds = new Set(
      existingCards
        .filter(n => allowedSourceIds.has(n.data?.sourceId))
        .map(n => n.data?.sourceId),
    );
    const missing = activeEnabledSourceIds
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
  }, [id, getNodes, deleteElements, spawnSourceCardsAround, fitView, activeEnabledSourceIds]);

  // Guarantee every blocked source has a visible, actionable card when we pause
  // in 'sources-ready'. The block decision is finalized only at search END, but
  // source cards come and go DURING the (now long, deep-paginating) run — a card
  // can be gone by the time we pause, leaving "1 source blocked but nothing to
  // Solve." For any blocked source missing a card, spawn one SEEDED with the
  // failure (the live progress event already fired before this card existed, so
  // the reason + Solve target must come from persisted state). Existing cards
  // are synchronously promoted to the final derived warning; this matters when
  // their last source-progress event was a clean `done` before final QA ran.
  const ensureBlockedSourceCards = useCallback((blockingWarnings) => {
    const blocks = (blockingWarnings || []).filter(w => isJobSourceWarningGating(w) && w.sourceId);
    if (blocks.length === 0) return;
    const allowedSourceIds = new Set(activeEnabledSourceIds);
    const existingSourceIds = new Set(
      getNodes()
        .filter(n => n.type === 'jobsourcecard' && n.data?.hubId === id)
        .map(n => n.data?.sourceId),
    );
    blocks
      .filter(w => existingSourceIds.has(w.sourceId))
      .forEach(w => document.dispatchEvent(new CustomEvent('job-source-warning-sync', {
        detail: { hubId: id, sourceId: w.sourceId, warning: w },
      })));
    const missing = blocks.filter(w => allowedSourceIds.has(w.sourceId) && !existingSourceIds.has(w.sourceId));
    if (missing.length === 0) return;

    const items = missing.map(w => ({
      source: JOB_SOURCE_BY_ID[w.sourceId] ||
        { id: w.sourceId, name: w.sourceId, letter: (w.sourceId[0] || '?').toUpperCase(), color: '#ef4444', domain: '' },
      persistedProgress: {
        status:  'done',
        // Spread the FULL warning so the re-spawned card keeps resumeState (Indeed
        // 'Continue' resumes instead of full re-scrape), openSecondTab (Glassdoor
        // 2-tab solve), and shortLabel (friendly chip) — not just the 4 base fields.
        warning: { ...w },
        url:     w.url || null,
        count:   w.sourceJobCount || 0,
      },
    }));
    spawnSourceCardsAround(items, 'rgba(239,68,68,0.6)');
    EventLogger.log(`[JobSearch][${id}] Re-spawned ${missing.length} blocked source card(s) to resolve: ${missing.map(w => w.sourceId).join(', ')}`);
  }, [id, getNodes, spawnSourceCardsAround, activeEnabledSourceIds]);

  // (Result-card filter re-apply + height-driven re-flow moved to the Job Board
  // Module along with the displayed cascade.)

  /**
   * Steps 4-5 of the pipeline: scoring → bucketing → spawn → set 'done'.
   * Extracted so the resume-after-pause path (user cleared their last block
   * warning) can re-enter scoring without re-fetching the resume + search.
   *
   * The caller is responsible for: owning the processing guard, capturing the
   * cancellation epoch, and releasing only its own guard token. Mirrors the marketplace
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
    aiSkipped = false, collectionOnly = false, testMode = false,
    jobRunId = null, cancelled = () => false, completeRun = true,
  }) => {
    if (cancelled()) return;
    const displayed = Array.isArray(scoredJobs) ? scoredJobs : [];

    const finalSourceCounts = {};
    displayed.forEach(job => { finalSourceCounts[job.source] = (finalSourceCounts[job.source] || 0) + 1; });

    const scores = displayed.map(j => j.matchScore || 0);
    const scoreRangeMin = scores.length ? Math.min(...scores) : 0;
    const scoreRangeMax = scores.length ? Math.max(...scores) : 100;

    // Scoring alone does not expose results. The connected Job Board performs
    // the authoritative seen-history write only after it has added cards for
    // this result set to the canvas.
    // A batch poll can cross the user pressing Cancel while finishing. Do not
    // let that stale continuation restore a done state after the hub has
    // already been reset/re-run.
    if (cancelled()) return;

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
      finalSourceCounts,
      scoreRangeMin,
      scoreRangeMax,
      pendingJobs: null,
      pendingBatch: null,
      scrapeWarnings: Array.isArray(scrapeWarnings) ? scrapeWarnings : [],
      rerunOutcome: null,
      rerunNotice: null,
    });

    // Re-analysis deliberately has no search-run lifecycle or history sidecar
    // to complete. It only replaces the saved hiring-fit assessments.
    if (completeRun) {
      window.electronAPI?.completeJobRun?.({ canvasFilePath, runId: jobRunId }).catch(() => {});
    }
  }, [id, updateGlobal, canvasFilePath]);

  const runScoringAndSpawn = useCallback(async ({
    profile, careerData = data.careerData, jobs, gatheredCount,
    scrapedCount = Array.isArray(jobs) ? jobs.length : 0,
    scrapeWarnings, activeTargetRole, originalPos,
    jobRunId = null, cancelled, locationSnapshot = null, completeRun = true,
  }) => {
    const currentId = id;

    // Step 4: Scoring
    setScoringProgress(null); // clear any prior run's counter; backend re-paints "0 / M"
    updateGlobal(currentId, { hubState: 'scoring', jobCount: jobs.length });
    const effectiveLocationSnapshot = locationSnapshot || data.locationSnapshot || {
      searchLocation: getSearchLocation({
        searchLocation: data.searchLocation,
        preferredLocation: data.preferredLocation,
        canonicalLocation: data.canonicalLocation,
      }),
      remoteResidences: normalizeRemoteResidences(data.remoteResidences),
    };
    const scoreResult = await window.electronAPI.scoreJobs({
      jobs,
      profile,
      careerData,
      nodeId: currentId,
      targetRole: activeTargetRole,
      searchLocation: effectiveLocationSnapshot.searchLocation,
      remoteResidences: effectiveLocationSnapshot.remoteResidences,
      snapshotContext: {
        sourceHubId: currentId,
        runId: jobRunId,
        canvasFilePath,
        resumeSummary: buildResumeSummary(profile),
        sourceGatheredCount: gatheredCount,
        searchLocation: effectiveLocationSnapshot.searchLocation,
        remoteResidences: effectiveLocationSnapshot.remoteResidences,
      },
    });
    if (cancelled()) return;
    if (!scoreResult.success) {
      const err = new Error(scoreResult.error || 'Failed to score jobs');
      if (scoreResult.isRateLimit) err.isRateLimit = true;
      throw err;
    }

    // Only old app versions could submit a batch. New calls never ask for one;
    // retain this defensive recovery branch so an in-flight legacy request is
    // not discarded if a backend returns its already-persisted state.
    if (scoreResult.batchPending) {
      if (!completeRun) {
        // A saved-result re-analysis owns no job-run sidecar to poll. Keeping
        // the previous done state is safer than stranding it in a legacy batch
        // recovery state that cannot atomically replace those scores.
        throw new Error('Saved-job re-analysis returned an unsupported deferred scoring task. Your existing hiring-fit results were kept.');
      }
      updateGlobal(currentId, {
        hubState: 'scoring-batch',
        jobCount: jobs.length,
        pendingBatch: {
          batchId: scoreResult.batchId,
          startedAt: Date.now(),
          count: scoreResult.batchCount,
          selectedForScoring: scoreResult.selectedForScoring,
          jobRunId,
        },
      });
      return;
    }

    await finishScoringAndSpawn({
      scoredJobs: scoreResult.scoredJobs,
      profile,
      gatheredCount,
      scrapedCount,
      scrapeWarnings,
      activeTargetRole,
      originalPos,
      aiSkipped: !!scoreResult.aiSkipped,
      collectionOnly: !!scoreResult.collectionOnly,
      testMode: !!scoreResult.testMode,
      jobRunId,
      cancelled,
      completeRun,
    });
  }, [id, updateGlobal, canvasFilePath, finishScoringAndSpawn, data.locationSnapshot, data.searchLocation, data.preferredLocation, data.canonicalLocation, data.remoteResidences, data.careerData]);

  // ── Legacy Batch-API recovery ─────────────────────────────────────────────
  // A prior app version may have left an API batch sidecar. The main process
  // retires it locally without polling the provider, then this path restarts
  // from the saved analysis snapshot through the normal Non-API AI handoff.
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
    if (res?.retired) {
      batchCompletingRef.current = true;
      try {
        const recovered = await window.electronAPI.getLastJobAnalysisSnapshot?.({ canvasFilePath });
        if (cancelled()) return;
        const snapshot = recovered?.success === false ? null : recovered?.snapshot;
        const sourceHubId = snapshot?.sourceHubId || snapshot?.nodeId || null;
        if (!snapshot || !Array.isArray(snapshot.jobs) || snapshot.jobs.length === 0 || !snapshot.profile
          || (sourceHubId && sourceHubId !== id)) {
          throw new Error('A previous API scoring run was retired, but its matching saved job-analysis snapshot is unavailable. Your existing results were left unchanged; run the search again to score these jobs with Non-API AI.');
        }
        await runScoringAndSpawn({
          profile: snapshot.profile,
          careerData: typeof snapshot.careerData === 'string' ? snapshot.careerData : data.careerData,
          jobs: snapshot.jobs,
          gatheredCount: snapshot.sourceGatheredCount
            ?? snapshot.searchFunnel?.relevanceKept
            ?? snapshot.searchFunnel?.raw
            ?? snapshot.gatheredJobCount
            ?? snapshot.jobs.length,
          scrapeWarnings: data.scrapeWarnings || [],
          activeTargetRole: String(snapshot.targetRole || res.targetRole || data.targetRole || '').trim(),
          originalPos: getNode(id)?.position || { x: 0, y: 0 },
          jobRunId: snapshot.runId || data.pendingBatch?.jobRunId || data.jobRunId || null,
          cancelled,
          locationSnapshot: snapshot.locationSnapshot || null,
        });
      } catch (error) {
        if (!cancelled()) {
          updateGlobal(id, {
            pendingBatch: null,
            hubState: 'done',
            errorMessage: error?.message || String(error),
          });
        }
      } finally {
        batchCompletingRef.current = false;
      }
      return;
    }
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
          jobRunId: data.pendingBatch?.jobRunId || data.jobRunId || null,
          cancelled,
        });
      } finally {
        batchCompletingRef.current = false;
      }
    }
  }, [id, canvasFilePath, updateGlobal, finishScoringAndSpawn, runScoringAndSpawn, getNode, data.careerData, data.resumeProfile, data.scrapeWarnings, data.targetRole, data.pendingBatch, data.jobRunId, epoch]);

  useEffect(() => {
    if (hubState !== 'scoring-batch' || !data.pendingBatch?.batchId) return undefined;
    pollBatchOnce(); // retire/recover immediately; no provider polling loop
    return undefined;
  }, [hubState, data.pendingBatch?.batchId, pollBatchOnce]);

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
  const handlePostSearchResult = useCallback(async ({
    currentId, foundJobs, warnings, blockingWarnings, profile, activeTargetRole, canvasFilePath: cfp,
    jobRunId = null, locationSnapshot = null, descriptionRecoveryJobs = null,
    gatheredCount = null,
  }) => {
    jobRunIdRef.current = jobRunId;
    if (blockingWarnings.length > 0 && !SKIP_AI_FOR_TESTING) {
      cancelCleanSourceCardDismiss();
      // These refs are the synchronous source of truth for an immediate
      // Resolve/Skip click before React commits the update below.
      pendingJobsRef.current = foundJobs;
      scrapeWarningsRef.current = warnings;
      gatheredCountRef.current = gatheredCount ?? foundJobs.length;
      hubStateRef.current = 'sources-ready';
      updateGlobal(currentId, {
        hubState: 'sources-ready',
        pendingJobs: foundJobs,
        pendingTargetRole: activeTargetRole,
        jobCount: foundJobs.length,
        // Resume scoring must retain the source-card-aligned total from this
        // search instead of deriving it later from the history-deduped pending
        // rows.
        gatheredCount: gatheredCount ?? foundJobs.length,
        scrapeWarnings: warnings,
        jobRunId,
      });
      // Guarantee a Solve/Skip card for every blocked source — a card can be lost
      // during the long run, stranding the user with "blocked but nothing to resolve".
      ensureBlockedSourceCards(blockingWarnings);
      // Description-recovery Solve actions run before score-jobs writes its usual
      // snapshot. Persist the current run's full recovery universe now; otherwise
      // a Solve can load a prior same-hub snapshot or mistake the score-safe
      // subset for a completed source.
      //
      // Must list every source whose Solve targets stranded description rows —
      // i.e. JOB_SOURCE_RESOLVE_CONFIG's requiresDescriptionEnrichment set
      // (google, ziprecruiter, glassdoor) plus LinkedIn's guest-wall recovery.
      // Glassdoor earns its place now that a panel-429 blocks BEFORE scoring:
      // without it that run would pause with no snapshot on disk at all, and
      // its Solve would have nothing to target.
      const needsDescriptionRecoverySnapshot = blockingWarnings.some(w =>
        ['google', 'linkedin', 'glassdoor', 'ziprecruiter'].includes(w?.sourceId),
      );
      if (needsDescriptionRecoverySnapshot) {
        try {
          await window.electronAPI?.saveJobAnalysisSnapshot?.({
            jobs: foundJobs,
            descriptionRecoveryJobs,
            profile,
            careerData: data.careerData,
            nodeId: currentId,
            targetRole: activeTargetRole,
            snapshotContext: {
              sourceHubId: currentId,
              runId: jobRunId,
              canvasFilePath: cfp,
              resumeSummary: buildResumeSummary(profile),
              sourceGatheredCount: gatheredCount,
              locationSnapshot,
              searchLocation: locationSnapshot?.searchLocation || null,
              remoteResidences: locationSnapshot?.remoteResidences || null,
            },
          });
        } catch (err) {
          EventLogger.error(`[JobSearch][${currentId}] Failed to save pre-score description recovery snapshot:`, err);
        }
      }
      return false;
    }

    if (foundJobs.length === 0) {
      // No blocked sources left to recover. This run owns the terminal result:
      // replace any prior results and show a simple "0 new jobs" summary.
      // Replace the prior analysis snapshot before exposing this terminal state:
      // otherwise the bug reporter's snapshot-only snippet/salary diagnostics
      // silently describe the PREVIOUS non-empty run. Await this small local
      // write so a report opened immediately after the empty result is coherent.
      try {
        const saved = await window.electronAPI?.saveJobAnalysisSnapshot?.({
          jobs: [],
          profile,
          careerData: data.careerData,
          nodeId: currentId,
          targetRole: activeTargetRole,
          snapshotContext: {
            sourceHubId: currentId,
            runId: jobRunId,
            canvasFilePath: cfp,
            resumeSummary: buildResumeSummary(profile),
            sourceGatheredCount: gatheredCount,
            locationSnapshot,
            searchLocation: locationSnapshot?.searchLocation || null,
            remoteResidences: locationSnapshot?.remoteResidences || null,
          },
        });
        if (saved && !saved.saved) {
          EventLogger.error(`[JobSearch][${currentId}] Failed to save empty-run analysis snapshot: ${saved.error || 'unknown error'}`);
        }
      } catch (err) {
        // Saving diagnostics must not prevent a real empty result from
        // completing. The report's run-ID guard will suppress any older file.
        EventLogger.error(`[JobSearch][${currentId}] Failed to save empty-run analysis snapshot:`, err);
      }
      // Reset slider range + counts so the done-state UI doesn't show stale values.
      updateGlobal(currentId, {
        hubState: 'done',
        scoredJobs: [],
        finalSourceCounts: {},
        jobCount: 0,
        resultCount: 0,
        totalScoredCount: 0,
        scrapedCount: 0,
        // Preserve the backend funnel even when zero rows survive. Otherwise a
        // clean 88 fetched → 88 relevance-filtered run looks identical to a
        // source that returned no rows at all.
        gatheredCount: gatheredCount ?? 0,
        scoreRangeMin: 0,
        scoreRangeMax: 100,
        scoreThreshold: 0,
        scrapeWarnings: warnings,
        pendingJobs: null,
        pendingBatch: null,
        jobRunId,
        rerunOutcome: 'no-new-results',
        rerunNotice: null,
      });
      pendingJobsRef.current = null;
      scrapeWarningsRef.current = warnings;
      hubStateRef.current = 'done';
      window.electronAPI?.completeJobRun?.({ canvasFilePath: cfp, runId: jobRunId }).catch(() => {});
      return false;
    }

    return true;
  }, [updateGlobal, ensureBlockedSourceCards, cancelCleanSourceCardDismiss, data.careerData]);

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
    runOrigin = 'initial',
  } = {}) => {
    if (!window.electronAPI || processingRunsRef.current.active) return;
    // Capture these once per run. A user may edit fields while a long scrape is
    // in progress; compensation research must use the locations that were
    // explicitly configured when this run began, not a later edit.
    const liveData = getNode(id)?.data || data;
    const runLocationSnapshot = {
      searchLocation: getSearchLocation(liveData),
      remoteResidences: normalizeRemoteResidences(liveData.remoteResidences),
    };
    const locationProblem = locationValidationMessage(runLocationSnapshot.searchLocation);
    if (!hasRequiredLocations(runLocationSnapshot.searchLocation)) {
      updateGlobal(id, { errorMessage: locationProblem, isRateLimit: false, rerunOutcome: null, rerunNotice: null });
      addToast({ title: 'Complete job locations', description: locationProblem, type: 'error' });
      return;
    }
    if (activeEnabledSourceIds.length === 0) {
      const message = 'Select at least one job platform before running the search.';
      updateGlobal(id, { errorMessage: message, rerunOutcome: null, rerunNotice: null });
      addToast({ title: 'Choose a Job Platform', description: message, type: 'error' });
      return;
    }
    // Career data can come from one OR many dropped files; normalize to a list.
    // A single `filePath` (canvas-created hub) still works as a one-element list.
    const paths = (Array.isArray(filePaths) && filePaths.length)
      ? filePaths.filter(Boolean)
      : (filePath ? [filePath] : []);
    if (paths.length === 0 && !providedProfile) return;
    const processingToken = processingRunsRef.current.start();
    if (!processingToken) return;
    // This is a new top-level search, unlike a post-run source append. Reset
    // the source-card aggregate only after this run owns the processing token.
    gatheredCountRef.current = 0;
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
            rerunOutcome: null,
            rerunNotice: null,
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

      updateGlobal(currentId, {
        errorMessage: null,
        isRateLimit: false,
        rerunOutcome: null,
        rerunNotice: null,
        testModeNote: null,
        locationSnapshot: runLocationSnapshot,
      });
      let profile = providedProfile;
      let resumeFingerprint = data.resumeFingerprint || '';

      // Pre-flight: check only sources that require a browser session before
      // expensive scraping starts. LinkedIn is intentionally excluded; its job
      // fetch + description enrichment are anonymous/public flows.
      const JOB_LOGIN_IDS = getJobAuthPreflightSourceIds(
        ids => ids.filter(platformId => activeEnabledSourceIds.includes(platformId)),
      );
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
      const activePreferredLocation = locationToLegacyText(runLocationSnapshot.searchLocation);
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
      } else if (activeTargetRole) {
        // Do not pay a query-generation model to create work we do not want.
        // Location correction/country inference is a separate, location-only
        // operation; the scrape bundle itself is constructed deterministically.
        const locationResult = await window.electronAPI.resolveJobSearchLocation({
          profile,
          nodeId: currentId,
          preferredLocation: activePreferredLocation,
        });
        if (cancelled()) return;
        if (!locationResult.success) {
          const err = new Error(locationResult.error || 'Failed to resolve search location');
          if (locationResult.isRateLimit) err.isRateLimit = true;
          throw err;
        }
        queriesResult = {
          success: true,
          queries: buildExactTargetRoleQueryBundle(activeTargetRole),
          queryModel: null,
          canonicalLocation: locationResult.canonicalLocation,
          canonicalCountry: locationResult.canonicalCountry || '',
        };
        EventLogger.log(`[JobSearch][${currentId}] Target role set — skipping query variation generation and searching exactly "${activeTargetRole}"`);
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
      const allQueries = flattenJobSearchQueries(queriesResult.queries);
      const queryModel = queriesResult.queryModel || null;
      // The location resolver (or the exploratory query call when role is blank)
      // normalizes free-form locations so board filters do not receive a typo.
      // On a cache hit reuse the persisted canonical; raw input is the fallback.
      const canonicalLocation =
        (canReuseQueries ? data.canonicalLocation : queriesResult.canonicalLocation)
        || activePreferredLocation;
      // Survives a remote-only search, where canonicalLocation is deliberately
      // empty. Used only to pin a board's MARKET (never to narrow the search).
      // Fall through to the fresh result rather than short-circuiting on the
      // cache branch: a canvas created before canonicalCountry existed has none
      // stored, and `canReuseQueries ? data.x : y` would then yield '' forever,
      // silently un-pinning the market on every reused run.
      const canonicalCountry =
        (canReuseQueries ? data.canonicalCountry : '')
        || queriesResult.canonicalCountry
        || data.canonicalCountry
        || '';

      // Step 3: Search
      handledDuringSearchRef.current.clear();
      updateGlobal(currentId, {
        hubState: 'searching',
        queryCount: allQueries.length,
        queries: queriesResult.queries,
        queryModel,
        queryCacheKey,
        canonicalLocation,
        canonicalCountry,
        resumeFingerprint,
      });
      const searchResult = await window.electronAPI.searchJobs({
        queries: allQueries,
        nodeId: currentId,
        maxAgeDays: data.maxAgeDays || 21,
        collectionLimits,
        enabledSourceIds,
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
        // Enforced main-process side against every source's gathered rows: when a
        // role is pinned, a job is kept only if its TITLE contains every word the
        // user typed (see src/utils/jobTitleMatch.js).
        targetRole: activeTargetRole,
        // Country only, kept separate from preferredLocation so a remote-only
        // search still pins which country's market a board serves.
        countryScope: canonicalCountry,
        runOrigin,
        profileInputMode: paths.length > 0 ? 'fresh-files' : 'stored-profile',
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
      // Any other failure shape (e.g. noPlatformsSelected, or a bare thrown error
      // caught generically by handleSafe) must not fall through to foundJobs=[] —
      // that reads identically to a genuine zero-result search and the error is lost.
      if (!searchResult.success) {
        throw Object.assign(new Error(searchResult.error || 'Job search failed'), {
          isRateLimit: !!searchResult.isRateLimit,
        });
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
      // `gatheredCount` is the source-card-aligned collection total. `rawCount`
      // remains the broader provider funnel used only for diagnostics; retain it
      // as a backwards-compatible fallback for an older main-process response.
      const visibleGatheredCount = searchResult.gatheredCount ?? searchResult.rawCount ?? foundJobs.length;
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
      const shouldScore = await handlePostSearchResult({
        currentId, foundJobs, warnings: effectiveWarnings, blockingWarnings,
        profile, activeTargetRole, canvasFilePath,
        jobRunId: searchResult.runId || null,
        locationSnapshot: runLocationSnapshot,
        descriptionRecoveryJobs: Array.isArray(searchResult.descriptionRecoveryJobs)
          ? searchResult.descriptionRecoveryJobs
          : null,
        gatheredCount: visibleGatheredCount,
      });
      if (!shouldScore) return;

      if (SKIP_AI_FOR_TESTING) {
        try {
          await window.electronAPI?.saveJobAnalysisSnapshot?.({
            jobs: foundJobs,
            profile,
            careerData: data.careerData,
            nodeId: currentId,
            targetRole: activeTargetRole,
            snapshotContext: {
              sourceHubId: currentId,
              runId: searchResult.runId || null,
              canvasFilePath,
              resumeSummary: buildResumeSummary(profile),
              sourceGatheredCount: visibleGatheredCount,
              searchLocation: runLocationSnapshot.searchLocation,
              remoteResidences: runLocationSnapshot.remoteResidences,
            },
          });
        } catch (err) {
          EventLogger.error(`[JobSearch][${currentId}] Failed to save test-mode prompt snapshot:`, err);
        }
        EventLogger.log(`[JobSearch][${currentId}] SKIP_AI_FOR_TESTING — ${foundJobs.length} jobs collected, stopping before AI scoring`);
        // Collection-only runs do not create board cards, so they must not
        // enter seen-history. A normal scored run is recorded by the Job Board
        // only after its results have been displayed.
        updateGlobal(currentId, {
          hubState: 'done',
          scoredJobs: [],
          finalSourceCounts: {},
          resultCount: 0,
          scrapedCount: foundJobs.length,
          gatheredCount: visibleGatheredCount,
          testMode: true,
          aiSkipped: true,
          collectionOnly: true,
          totalScoredCount: 0,
          scoreRangeMin: 0,
          scoreRangeMax: 100,
          scoreThreshold: 0,
          scrapeWarnings: effectiveWarnings,
          pendingJobs: null,
          pendingBatch: null,
          jobRunId: searchResult.runId || null,
          testModeNote: `[Test mode] ${foundJobs.length} jobs collected — AI scoring disabled`,
          rerunOutcome: null,
          rerunNotice: null,
        });
        window.electronAPI?.completeJobRun?.({ canvasFilePath, runId: searchResult.runId || null }).catch(() => {});
        return;
      }

      await runScoringAndSpawn({
        profile,
        jobs: foundJobs,
        gatheredCount: visibleGatheredCount,
        scrapeWarnings: effectiveWarnings,
        activeTargetRole,
        originalPos,
        jobRunId: searchResult.runId || null,
        cancelled,
        locationSnapshot: runLocationSnapshot,
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
        rerunOutcome: null,
        rerunNotice: null,
      });
    } finally {
      lease?.release();
      if (isMountedRef.current && processingRunsRef.current.finish(processingToken)) {
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
  }, [id, updateGlobal, getNode, canvasFilePath, data, collectionLimits, enabledSourceIds, activeEnabledSourceIds, ensureSourceCards, handlePostSearchResult, epoch, resetSourceProgress, runScoringAndSpawn, triggerUSAJobsBackgroundSearch, cancelCleanSourceCardDismiss, moduleRunQueue, isMountedRef, addToast]);

  const startProcessing = useCallback((fileOrFiles, { frameSourceCards = true, runOrigin = 'initial' } = {}) => {
    const filePaths = Array.isArray(fileOrFiles) ? fileOrFiles : (fileOrFiles ? [fileOrFiles] : []);
    return runPipeline({ filePaths, frameSourceCards, runOrigin });
  }, [runPipeline]);
  const startProcessingWithProfile = useCallback(
    (profile, { frameSourceCards = true, runOrigin = 'initial' } = {}) => runPipeline({ profile, frameSourceCards, runOrigin }),
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
    if (processingRunsRef.current.active) return;
    // Read the live refs, NOT data.pendingJobs/data.scrapeWarnings: onResolved
    // merges freshly-extracted items into pendingJobsRef and then calls this
    // synchronously, before React re-renders — so the data closure still holds
    // the pre-merge list. That was the "captcha resolve inline-extracted 15
    // jobs but only 1 got scored" bug (and why the cleared warnings weren't
    // persisted). The refs are updated on every render AND synchronously by the
    // resolve/skip handlers, so they're always at least as fresh as data.
    const pending = pendingJobsRef.current;
    const pausedGatheredCount = gatheredCountRef.current ?? (Array.isArray(pending) ? pending.length : 0);
    // A resolve handler can call this synchronously before React commits the
    // paused run's data.jobRunId. Keep every completion/snapshot write scoped to
    // the live run token, just like the pending jobs and warnings above.
    const activeJobRunId = jobRunIdRef.current || data.jobRunId || null;
    const profile = data.resumeProfile;
    if (!pending || !Array.isArray(pending) || pending.length === 0) {
      // Nothing was collected (every blocked source got skipped, or a resolve
      // yielded no items) — finish in the terminal empty 'done' state instead
      // of leaving the hub stuck on the paused 'sources-ready' screen. Needed
      // now that a 0-jobs-but-blocked run pauses in 'sources-ready' with an
      // empty pendingJobs (see the block gate in runPipeline).
      // This is a real terminal zero-result run, not merely a paused state.
      // Replace the prior analysis snapshot before painting the result so
      // snapshot-only bug-report diagnostics cannot describe an earlier run.
      const activeTargetRole = data.pendingTargetRole || data.targetRole || '';
      const locationSnapshot = data.locationSnapshot || {
        searchLocation: getSearchLocation({
          searchLocation: data.searchLocation,
          preferredLocation: data.preferredLocation,
          canonicalLocation: data.canonicalLocation,
        }),
        remoteResidences: normalizeRemoteResidences(data.remoteResidences),
      };
      try {
        const saved = await window.electronAPI?.saveJobAnalysisSnapshot?.({
          jobs: [],
          profile,
          careerData: data.careerData,
          nodeId: id,
          targetRole: activeTargetRole,
          snapshotContext: {
            sourceHubId: id,
            runId: activeJobRunId,
            canvasFilePath,
            resumeSummary: buildResumeSummary(profile),
            sourceGatheredCount: pausedGatheredCount,
            locationSnapshot,
            searchLocation: locationSnapshot.searchLocation || null,
            remoteResidences: locationSnapshot.remoteResidences || null,
          },
        });
        if (saved && !saved.saved) {
          EventLogger.error(`[JobSearch][${id}] Failed to save paused empty-run analysis snapshot: ${saved.error || 'unknown error'}`);
        }
      } catch (err) {
        // Snapshot persistence is diagnostic-only; a write failure must never
        // leave the user stuck in sources-ready after they skipped the final block.
        EventLogger.error(`[JobSearch][${id}] Failed to save paused empty-run analysis snapshot:`, err);
      }
      const terminalWarnings = Array.isArray(scrapeWarningsRef.current) ? scrapeWarningsRef.current : [];
      updateGlobal(id, {
        hubState: 'done', scoredJobs: [], finalSourceCounts: {},
        jobCount: 0,
        resultCount: 0, totalScoredCount: 0, scrapedCount: 0, gatheredCount: pausedGatheredCount,
        scoreRangeMin: 0, scoreRangeMax: 100, scoreThreshold: 0,
        pendingJobs: null,
        pendingBatch: null,
        scrapeWarnings: terminalWarnings,
        jobRunId: activeJobRunId,
        rerunOutcome: 'no-new-results',
        rerunNotice: null,
      });
      pendingJobsRef.current = null;
      scrapeWarningsRef.current = terminalWarnings;
      hubStateRef.current = 'done';
      window.electronAPI?.completeJobRun?.({ canvasFilePath, runId: activeJobRunId }).catch(() => {});
      return;
    }
    if (!profile) return;
    const processingToken = processingRunsRef.current.start();
    if (!processingToken) return;
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
            rerunOutcome: null,
            rerunNotice: null,
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
        gatheredCount: pausedGatheredCount,
        scrapeWarnings: Array.isArray(scrapeWarningsRef.current) ? scrapeWarningsRef.current : [],
        activeTargetRole: data.pendingTargetRole || data.targetRole || '',
        originalPos,
        jobRunId: activeJobRunId,
        cancelled,
      });
    } catch (error) {
      if (cancelled() || isNodeDeletedAbort(error)) return;
      EventLogger.error('[JobSearch] Resume scoring failed:', error);
      updateGlobal(currentId, {
        hubState: 'sources-ready',
        errorMessage: error?.message || String(error),
        isRateLimit: !!error?.isRateLimit,
        rerunOutcome: null,
        rerunNotice: null,
      });
    } finally {
      lease?.release();
      if (isMountedRef.current && processingRunsRef.current.finish(processingToken)) {
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
  }, [id, data.resumeProfile, data.careerData, data.pendingTargetRole, data.targetRole, data.jobRunId, data.locationSnapshot, data.searchLocation, data.preferredLocation, data.canonicalLocation, data.remoteResidences, canvasFilePath, epoch, getNode, runScoringAndSpawn, updateGlobal, triggerUSAJobsBackgroundSearch, moduleRunQueue, isMountedRef]);

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
  // canResumeOffer is only the LOCATION gate. Resuming also needs the persisted
  // profile and the run's staged queries — handleResumeRun's `!profile ||
  // queries.length === 0` branch silently discards the staged run, so a button
  // offered without both is a trap that destroys what it promises to recover.
  const resumeRunActionable = canResumeOffer
    && resumeOffer?.nodeId === id
    && hasReusableCareerProfile
    && ((resumeOffer?.queries?.length ?? 0) > 0);
  useEffect(() => {
    if (!canvasFilePath || !window.electronAPI?.peekJobRun) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const info = await window.electronAPI.peekJobRun({ canvasFilePath });
        // The run sidecar is canvas-scoped but recovery must be hub-scoped.
        // Do not render a dismissible offer for another hub (or a legacy
        // node-less manifest): that button could otherwise trash its run.
        if (!cancelled) setResumeOffer(
          info?.found && info?.resumable && info?.nodeId === id ? info : null,
        );
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [canvasFilePath, id]);

  const handleResumeRun = useCallback(async () => {
    const cfp = canvasFilePath;
    const offer = resumeOffer;
    if (processingRunsRef.current.active || !offer) return;
    // Resume is bound to the manifest's original source breadth, not today’s
    // platform toggles. In particular, a fully gathered recovery can score its
    // staged rows with every current platform disabled.
    if (!canResumeOffer) {
      updateGlobal(id, {
        errorMessage: offer.locationRecorded
          ? `The unfinished run targeted ${offeredResumeLocation || 'no location'}, while this hub now targets ${activeResumeLocation || 'no location'}. Start fresh to keep locations separate.`
          : 'This unfinished run is missing location-safe resume metadata. Start fresh to keep locations separate.',
        rerunOutcome: null,
        rerunNotice: null,
      });
      return;
    }
    const profile = data.resumeProfile;
    const queries = Array.isArray(offer.queries) ? offer.queries : [];
    // Need a profile (persists in node data across restarts) + the run's queries.
    if (!profile || queries.length === 0) {
      await window.electronAPI?.discardJobRun?.({ canvasFilePath: cfp, runId: offer.runId || null }).catch(() => {});
      setResumeOffer(null);
      return;
    }
    // Preserve the recovery offer on validation failures (including no selected
    // platforms); it disappears only once we actually begin or discard the run.
    setResumeOffer(null);
    const processingToken = processingRunsRef.current.start();
    if (!processingToken) return;
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
            rerunOutcome: null,
            rerunNotice: null,
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
        enabledSourceIds,
        canvasFilePath: cfp,
        preferredLocation: data.canonicalLocation || data.preferredLocation || '',
        rawLocation: data.preferredLocation || '',
        profileLocations: profile?.locations || [],
        // A crash-resumed run must apply the same pinned-role gate as the run it
        // is continuing, or recovery would re-admit rows the original rejected.
        // The role THIS RUN was gathered under, from its manifest — never the
        // hub's current value. Editing the target role after a crash must not
        // retroactively re-filter rows collected under the old one, and a run
        // started with no role must stay ungated. A manifest written before this
        // field existed reports null, which correctly means "do not gate".
        targetRole: offer.targetRole || '',
        countryScope: data.canonicalCountry || '',
        resume: true,
        // The offer is canvas-scoped and can become stale if another run starts
        // before this click reaches the main process. Bind recovery to the exact
        // manifest token so staged results can never cross into that newer run.
        resumeRunId: offer.runId || null,
        runOrigin: 'crash-resume',
        profileInputMode: 'stored-profile',
      });
      if (cancelled()) return;
      // Same failure handling as runPipeline — resume targets exactly the
      // post-restart scenario where a browser session has expired, so an
      // unhandled failure here must not read as a genuine empty search.
      if (!searchResult?.success && searchResult?.diceApiDown) {
        throw new Error(searchResult.error || 'Dice API is unavailable — search cancelled');
      }
      if (!searchResult?.success && Array.isArray(searchResult?.notLoggedIn) && searchResult.notLoggedIn.length > 0) {
        const names = searchResult.notLoggedIn.map(loginId => JOB_SOURCE_BY_ID[loginId]?.name || loginId);
        throw Object.assign(
          new Error(`Log in to ${names.join(', ')} first (Settings → Job Platform Logins)`),
          { isLoginGate: true, notLoggedIn: searchResult.notLoggedIn }
        );
      }
      if (!searchResult?.success) {
        throw Object.assign(new Error(searchResult?.error || 'Job search failed'), {
          isRateLimit: !!searchResult?.isRateLimit,
        });
      }
      const foundJobs = Array.isArray(searchResult.jobs) ? searchResult.jobs : [];
      // A crash-resume receives the same response shape as a fresh search.
      // Prefer its source-card-aligned collection total; `rawCount` is only
      // retained as the fallback for main processes from before `gatheredCount`.
      const visibleGatheredCount = searchResult.gatheredCount ?? searchResult.rawCount ?? foundJobs.length;
      const warnings = Array.isArray(searchResult?.scrapeWarnings) ? searchResult.scrapeWarnings : [];
      const blockingWarnings = warnings.filter(isJobSourceWarningGating);
      // Same post-search disposition as runPipeline (block-gate pause / empty terminal).
      const shouldScore = await handlePostSearchResult({
        currentId, foundJobs, warnings, blockingWarnings,
        profile, activeTargetRole, canvasFilePath: cfp,
        jobRunId: searchResult?.runId || null,
        descriptionRecoveryJobs: Array.isArray(searchResult?.descriptionRecoveryJobs)
          ? searchResult.descriptionRecoveryJobs
          : null,
        gatheredCount: visibleGatheredCount,
        locationSnapshot: data.locationSnapshot || {
          searchLocation: getSearchLocation({
            searchLocation: data.searchLocation,
            preferredLocation: data.preferredLocation,
            canonicalLocation: data.canonicalLocation,
          }),
          remoteResidences: normalizeRemoteResidences(data.remoteResidences),
        },
      });
      if (!shouldScore) return;
      await runScoringAndSpawn({
        profile, jobs: foundJobs,
        gatheredCount: visibleGatheredCount,
        scrapeWarnings: warnings, activeTargetRole, originalPos,
        jobRunId: searchResult?.runId || null, cancelled,
        locationSnapshot: data.locationSnapshot || {
          searchLocation: getSearchLocation({
            searchLocation: data.searchLocation,
            preferredLocation: data.preferredLocation,
            canonicalLocation: data.canonicalLocation,
          }),
          remoteResidences: normalizeRemoteResidences(data.remoteResidences),
        },
      });
    } catch (error) {
      if (cancelled() || isNodeDeletedAbort(error)) return;
      EventLogger.error('[JobSearch] Resume run failed:', error);
      // Same policy as runPipeline's catch: a resume attempted from 'done' with
      // prior scored jobs still on the hub must not wipe the board back to empty.
      const hubHasResults = (getNode(currentId)?.data?.scoredJobs?.length || 0) > 0;
      updateGlobal(currentId, {
        hubState: hubHasResults ? 'done' : 'empty',
        errorMessage: error?.message || String(error),
        isRateLimit: !!error?.isRateLimit,
        rerunOutcome: null,
        rerunNotice: null,
      });
    } finally {
      lease?.release();
      if (isMountedRef.current) processingRunsRef.current.finish(processingToken);
    }
  }, [canvasFilePath, resumeOffer, canResumeOffer, offeredResumeLocation, activeResumeLocation, id, data.resumeProfile, data.targetRole, data.maxAgeDays, data.locationSnapshot, data.searchLocation, data.remoteResidences, collectionLimits, enabledSourceIds, data.preferredLocation, data.canonicalLocation, data.canonicalCountry, epoch, getNode, updateGlobal, runScoringAndSpawn, handlePostSearchResult, moduleRunQueue, isMountedRef]);

  const handleDiscardResume = useCallback(async () => {
    // Defense in depth for a stale async offer: only its owning hub may clear
    // the token-scoped sidecar. Unknown legacy ownership stays recoverable.
    if (resumeOffer?.nodeId !== id) return;
    const runId = resumeOffer?.runId || null;
    setResumeOffer(null);
    try { await window.electronAPI?.discardJobRun?.({ canvasFilePath, runId }); } catch { /* best-effort */ }
  }, [canvasFilePath, resumeOffer, id]);

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
        !processingRunsRef.current.active
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

  // Listen for job-source-resolved dispatched after a captcha/continue attempt.
  // Carries `items` on successful recoveries plus the active warning on failed
  // attempts, so the hub can keep its collected-listing count and warning state
  // aligned. Replacement solves do not change that collection count: they only
  // improve or replace rows that the initial source search already gathered.
  // Merge jobs into pendingJobs by (title|company|url) fingerprint so a
  // retry-of-a-retry doesn't double-count, drop the source's warning, and
  // auto-resume scoring once the last blocking warning is cleared.
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
      // Apply only an explicit collection delta. Do not infer it from the
      // source card's transient display count: during description recovery that
      // count can mean the remaining/enriched subset rather than listings the
      // provider returned, which would corrupt the source-gathered total.
      const gatheredCountDelta = Number(e.detail?.gatheredCountDelta);
      if (Number.isFinite(gatheredCountDelta)) {
        gatheredCountRef.current = Math.max(0, (Number(gatheredCountRef.current) || 0) + gatheredCountDelta);
      }
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
      const replaceMatchingItems = !!e.detail?.replaceMatchingItems;
      const removedItemKeys = Array.isArray(e.detail?.removedItemKeys) ? e.detail.removedItemKeys : [];
      const { fresh, mergedPending, replacedExisting } = mergeResolvedSourceItems(
        prevPending,
        items,
        resolvedSourceId,
        { replaceSourceItems, replaceMatchingItems, removedItemKeys },
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
      updateGlobal(id, {
        pendingJobs: mergedPending,
        jobCount: mergedPending.length,
        gatheredCount: gatheredCountRef.current,
        scrapeWarnings: remaining,
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
      const pendingNet = mergedPending.length - prevPending.length;
      EventLogger.log(
        `[JobSearch][${id}] Resolved ${resolvedSourceId}: received ${items.length} item(s); `
        + `replaced ${replacedExisting}, accepted ${fresh.length} after dedup; `
        + `net pendingJobs ${pendingNet >= 0 ? '+' : ''}${pendingNet} (${prevPending.length}→${mergedPending.length}); `
        + `${remainingBlocks.length} block warning(s) remain`,
      );
      if (
        remainingBlocks.length === 0 &&
        hubStateRef.current === 'sources-ready' &&
        !processingRunsRef.current.active
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
    if (data.filePath && hubState === 'empty' && !processingRunsRef.current.active) {
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
    if (initialDropAcceptedRef.current || dropLockReason || processingRunsRef.current.active) {
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
    const files = Array.from(e.dataTransfer?.files || []);
    const exts = summarizeFileExtensions(files);
    const ingressReason = data.locked
      ? 'locked'
      : platformsVerifying
        ? 'platforms-verifying'
        : dropLockReason
          ? dropLockReason
          : PROCESSING_STATES.includes(hubState)
            ? `processing-${hubState}`
            : files.length === 0
              ? 'no-files'
              : null;
    EventLogger.log(
      `[JobSearch][${id}] Drop ingress: ${files.length} file(s) ext=[${exts.join(', ') || 'none'}] ` +
      `${ingressReason ? `rejected reason=${ingressReason}` : 'accepted-for-validation'}`
    );
    if (ingressReason) return;

    const payloads = filesToDropPayloads(files);
    acceptCareerFiles(payloads.map(file => file.path), payloads.map(file => file.name));
  }, [acceptCareerFiles, data.locked, dropLockReason, hubState, id, platformsVerifying]);

  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.hubId !== id) return;
      const droppedFiles = (e.detail?.files || []).filter(f => f?.filePath);
      const currentHubState = hubStateRef.current;
      const ingressReason = data.locked
        ? 'locked'
        : platformsVerifying
          ? 'platforms-verifying'
          : dropLockReason
            ? dropLockReason
            : PROCESSING_STATES.includes(currentHubState)
              ? `processing-${currentHubState}`
              : droppedFiles.length === 0
                ? 'no-valid-paths'
                : null;
      EventLogger.log(
        `[JobSearch][${id}] Document-node drop ingress: ${droppedFiles.length} file(s) ` +
        `${ingressReason ? `rejected reason=${ingressReason}` : 'accepted-for-validation'}`
      );
      if (ingressReason) return;
      acceptCareerFiles(droppedFiles.map(f => f.filePath), droppedFiles.map(f => f.filename));
    };
    document.addEventListener('canvas-file-nodes-dropped-on-hub', handler);
    return () => document.removeEventListener('canvas-file-nodes-dropped-on-hub', handler);
  }, [acceptCareerFiles, data.locked, dropLockReason, id, platformsVerifying]);

  const resetHandler = useCallback((e) => {
    e?.stopPropagation();
    if (data.locked) return;

    const reanalysisRestore = reanalysisRestoreRef.current;
    if (reanalysisRestore) {
      // The processing card uses this same cancel control for a full search
      // and for saved-result re-analysis. The latter must return to its prior
      // done state, not clear the listing set or its summary counters.
      EventLogger.log(`[JobSearch][${id}] Re-analysis cancelled; restoring prior hiring-fit results`);
      epoch.bump();
      moduleRunQueue.cancelQueuedRunsForNode(id);
      window.electronAPI?.cancelNodeTask?.(id);
      updateGlobal(id, {
        hubState: 'done',
        queuedModuleRun: null,
        errorMessage: null,
        isRateLimit: false,
        ...reanalysisRestore.patch,
      });
      reanalysisRestoreRef.current = null;
      processingRunsRef.current.cancel();
      return;
    }

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
    // `data.filePath && hubState === 'empty' && !processingRunsRef.current.active`, so
    // leaving filePath set after a reset to 'empty' would immediately re-parse
    // the same resume — the user clicked Cancel, not Retry. The empty state
    // exposes an explicit Re-run Search action backed by the retained profile.
    lastDroppedPathsRef.current = null;
    // Cancel + clean up any pending async batch scoring (best-effort).
    const resetRunId = data.pendingBatch?.jobRunId || jobRunIdRef.current || data.jobRunId || null;
    if (data.pendingBatch?.batchId) {
      window.electronAPI?.discardJobBatch?.({
        canvasFilePath,
        nodeId: id,
        batchId: data.pendingBatch.batchId,
      }).catch(() => {});
    }
    // If search-jobs already returned, the renderer owns the run token and can
    // discard its recovery sidecars directly. If Reset landed during the scrape,
    // the main-process abort path performs the same token-scoped cleanup because
    // the renderer has not received the run ID yet.
    if (resetRunId) {
      window.electronAPI?.discardJobRun?.({ canvasFilePath, runId: resetRunId }).catch(() => {});
    }
    // Drop stale results too: an 'empty' hub must not keep scoredJobs from a prior
    // run — otherwise a connected Job Board could still read them (defense-in-depth
    // with the board's hubState!=='done' gate). Keep the initial career identity
    // only after parsing yielded a profile; cancelling while parsing used to leave
    // `inputLocked` behind with no profile and no possible recovery action.
    // The shared clear patch wipes a superset (the career-derived caches too),
    // which is strictly more correct here: those caches can only be non-null if
    // an earlier career life existed on this hub, in which case they are stale.
    const retainedCareerData = hasReusableCareerProfile ? {} : buildJobHubCareerClearPatch();
    initialDropAcceptedRef.current = hasReusableCareerProfile;
    pendingJobsRef.current = null;
    gatheredCountRef.current = 0;
    scrapeWarningsRef.current = [];
    handledDuringSearchRef.current.clear();
    hubStateRef.current = 'empty';
    updateGlobal(id, {
      hubState: 'empty', queuedModuleRun: null, filePath: null, errorMessage: null, isRateLimit: false, rerunOutcome: null, rerunNotice: null, testModeNote: null, pendingBatch: null,
      scoredJobs: null, finalSourceCounts: {}, resultCount: 0, totalScoredCount: 0, scrapedCount: 0, gatheredCount: 0, scoreThreshold: 0, jobRunId: null,
      aiSkipped: false, collectionOnly: false, testMode: false,
      pendingJobs: null, pendingTargetRole: null, scrapeWarnings: [],
      // A snapshot describes one completed/in-flight run, not the persistent
      // search settings. Leaving it behind lets a later legacy resume use an
      // abandoned residence while the visible fields show the new one.
      locationSnapshot: null,
      ...retainedCareerData,
    });
    jobRunIdRef.current = null;
    cancelCleanSourceCardDismiss();
    resetSourceProgress();
    cleanupAllJobChildren();
    processingRunsRef.current.cancel();
  }, [data.locked, hasReusableCareerProfile, id, updateGlobal, epoch, resetSourceProgress, cleanupAllJobChildren, cancelCleanSourceCardDismiss, data.jobRunId, data.pendingBatch, canvasFilePath, moduleRunQueue]);

  // Non-API scoring is controlled by an app-level dialog, outside this node.
  // Its Cancel action aborts the backend operation, then broadcasts the owning
  // node id here. Reuse the same full reset path as the in-card cancel control:
  // merely receiving the abort error would otherwise leave this hub in an
  // error/sources-ready state instead of returning it to its empty start card.
  useEffect(() => {
    const onManualAiNodeCancelled = (event) => {
      if (event.detail?.nodeId !== id) return;
      resetHandler();
    };
    document.addEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled);
    return () => document.removeEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled);
  }, [id, resetHandler]);

  const handleRerun = useCallback(({ frameSourceCards = true } = {}) => {
    if (data.locked || processingRunsRef.current.active) return;
    if (activeEnabledSourceIds.length === 0) {
      const message = 'Select at least one job platform before running the search.';
      updateGlobal(id, { errorMessage: message, rerunOutcome: null, rerunNotice: null });
      addToast({ title: 'Choose a Job Platform', description: message, type: 'error' });
      return;
    }
    const droppedPaths = lastDroppedPathsRef.current;
    const effectivePaths = (Array.isArray(droppedPaths) && droppedPaths.length)
      ? droppedPaths
      : (data.filePath ? [data.filePath] : []);
    if (effectivePaths.length === 0 && !data.resumeProfile) {
      updateGlobal(id, { rerunOutcome: null, rerunNotice: null });
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
    gatheredCountRef.current = 0;
    jobRunIdRef.current = null;
    updateGlobal(id, { pendingJobs: null, pendingTargetRole: null, scrapeWarnings: [], jobRunId: null, rerunOutcome: null, rerunNotice: null });
    cancelCleanSourceCardDismiss();
    resetSourceProgress();
    // Reset the persisting source cards the instant Re-run is clicked, before the
    // async re-parse — startProcessingWithProfile re-broadcasts at scrape start,
    // but this clears the stale counts immediately so they don't linger.
    document.dispatchEvent(new CustomEvent('job-source-progress-reset', { detail: { hubId: id } }));
    const profileInputMode = effectivePaths.length > 0 ? 'fresh-files' : 'stored-profile';
    EventLogger.log(`[JobSearch][${id}] Re-run button clicked; career input=${profileInputMode}`);
    if (effectivePaths.length > 0) {
      // Files still accessible — re-parse for freshness then run full pipeline
      startProcessingRef.current?.(effectivePaths, { frameSourceCards, runOrigin: 'rerun-button' });
    } else {
      // Files gone but profile is persisted — run from query step onward
      addToast({ title: 'Re-running Search', description: 'Using stored career profile — original files not needed.', type: 'info' });
      startProcessingWithProfile(data.resumeProfile, { frameSourceCards, runOrigin: 'rerun-button' });
    }
  }, [data.locked, data.filePath, data.resumeProfile, id, addToast, startProcessingWithProfile, resetSourceProgress, updateGlobal, cancelCleanSourceCardDismiss, activeEnabledSourceIds]);

  // Re-score the currently displayed listings without invoking any search,
  // scrape, seen-history, or job-run lifecycle work. This is deliberately
  // separate from Re-run Search: existing listings are often history-filtered
  // on a fresh scrape and therefore cannot be safely revisited that way.
  const handleReanalyze = useCallback(async () => {
    if (data.locked || processingRunsRef.current.active) return;

    const existingScoredJobs = Array.isArray(data.scoredJobs) ? data.scoredJobs : [];
    if (existingScoredJobs.length === 0) {
      addToast({
        title: 'No Saved Jobs to Re-analyze',
        description: 'Run a job search first, then this action can update its hiring-fit assessments.',
        type: 'info',
      });
      return;
    }
    if (!data.resumeProfile) {
      addToast({
        title: 'Career Profile Needed',
        description: 'The saved career profile is unavailable, so these jobs cannot be re-analyzed.',
        type: 'error',
      });
      return;
    }

    // A saved result is both a listing and the last scoring pass over it. Send
    // only the former back: a per-job scorer fallback spreads its input into a
    // placeholder, so retaining matchScore, reasoning, careerDirection,
    // requirementAssessments, materialGaps, strengths, experienceAssessment,
    // confidence, fitAssessment, rawScore, adjustedScore, adjustments, or
    // calibration would make that placeholder look like the old assessment.
    // Listing and compensation evidence intentionally remain intact.
    const jobsToReanalyze = existingScoredJobs.map(job => {
      const listing = { ...(job || {}) };
      [
        'matchScore', 'reasoning', 'careerDirection', 'requirementAssessments',
        'materialGaps', 'strengths', 'experienceAssessment', 'confidence',
        'fitAssessment', 'rawScore', 'adjustedScore', 'adjustments', 'calibration',
      ].forEach(field => delete listing[field]);
      return listing;
    });
    const processingToken = processingRunsRef.current.start();
    if (!processingToken) return;
    const currentId = id;
    const cancelled = epoch.start();
    const restorePatch = reanalysisRestorePatch(data);
    reanalysisRestoreRef.current = { token: processingToken, patch: restorePatch };
    let lease = null;

    try {
      lease = await moduleRunQueue.acquireModuleRun({
        nodeId: currentId,
        kind: 'jobsearch',
        label: 'Re-analyze hiring fit',
        onQueued: ({ position }) => {
          updateGlobal(currentId, {
            hubState: 'queued',
            queuedModuleRun: { label: 'Re-analyzing hiring fit', position },
            errorMessage: null,
            isRateLimit: false,
          });
        },
        onQueueUpdate: ({ position }) => {
          updateGlobal(currentId, { queuedModuleRun: { label: 'Re-analyzing hiring fit', position } });
        },
        onStart: () => {
          if (cancelled()) throw new Error('Node deleted');
          updateGlobal(currentId, { queuedModuleRun: null });
        },
      });

      const locationSnapshot = data.locationSnapshot || {
        searchLocation: getSearchLocation({
          searchLocation: data.searchLocation,
          preferredLocation: data.preferredLocation,
          canonicalLocation: data.canonicalLocation,
        }),
        remoteResidences: normalizeRemoteResidences(data.remoteResidences),
      };
      setScoringProgress(null);
      updateGlobal(currentId, { hubState: 'scoring', jobCount: jobsToReanalyze.length });
      const scoreResult = await window.electronAPI.scoreJobs({
        jobs: jobsToReanalyze,
        profile: data.resumeProfile,
        careerData: data.careerData,
        nodeId: currentId,
        targetRole: (data.targetRole || '').trim(),
        searchLocation: locationSnapshot.searchLocation,
        remoteResidences: locationSnapshot.remoteResidences,
        snapshotContext: {
          sourceHubId: currentId,
          canvasFilePath,
          resumeSummary: buildResumeSummary(data.resumeProfile),
          sourceGatheredCount: data.gatheredCount ?? jobsToReanalyze.length,
          searchLocation: locationSnapshot.searchLocation,
          remoteResidences: locationSnapshot.remoteResidences,
        },
      });
      if (cancelled()) return;
      if (!scoreResult.success) {
        const err = new Error(scoreResult.error || 'Failed to re-analyze hiring fit');
        if (scoreResult.isRateLimit) err.isRateLimit = true;
        throw err;
      }
      if (scoreResult.batchPending) {
        throw new Error('Saved-job re-analysis returned an unsupported deferred scoring task. Your existing hiring-fit results were kept.');
      }

      await finishScoringAndSpawn({
        scoredJobs: scoreResult.scoredJobs,
        gatheredCount: data.gatheredCount,
        // Re-analysis does not collect anything. Preserve the original funnel
        // rather than replacing it with the saved-listing count.
        scrapedCount: data.scrapedCount,
        scrapeWarnings: Array.isArray(data.scrapeWarnings) ? data.scrapeWarnings : [],
        aiSkipped: !!scoreResult.aiSkipped,
        collectionOnly: !!scoreResult.collectionOnly,
        testMode: !!scoreResult.testMode,
        cancelled,
        // This score-only action has no search run or history lifecycle.
        completeRun: false,
      });

      if (!cancelled()) {
        addToast({
          title: 'Hiring Fit Re-analyzed',
          description: `Updated hiring-fit assessments for ${existingScoredJobs.length} saved job${existingScoredJobs.length === 1 ? '' : 's'}.`,
          type: 'success',
        });
      }
    } catch (error) {
      if (cancelled() || isNodeDeletedAbort(error)) return;
      EventLogger.error('[JobSearch] Saved-job hiring-fit re-analysis failed:', error);
      // No mutation of scoredJobs occurs until finishScoringAndSpawn succeeds.
      // Restore all summary fields explicitly as a defense against a queued or
      // partial scorer transition, and make the failure actionable in the hub.
      updateGlobal(currentId, {
        hubState: 'done',
        queuedModuleRun: null,
        ...restorePatch,
        errorMessage: error?.message || String(error),
        isRateLimit: !!error?.isRateLimit,
      });
      addToast({
        title: 'Hiring Fit Re-analysis Failed',
        description: 'Your existing scores were kept. Try again when the AI handoff is available.',
        type: 'error',
      });
    } finally {
      lease?.release();
      if (reanalysisRestoreRef.current?.token === processingToken) {
        reanalysisRestoreRef.current = null;
      }
      if (isMountedRef.current) processingRunsRef.current.finish(processingToken);
    }
  }, [data, id, addToast, epoch, moduleRunQueue, updateGlobal, canvasFilePath, finishScoringAndSpawn, isMountedRef]);

  // Drop the hub's career identity (files + everything derived from them) while
  // keeping every search setting, so the user can drop FRESH career files onto
  // the SAME node instead of rebuilding a module from scratch.
  const handleClearCareerFiles = useCallback((e) => {
    e?.stopPropagation();
    if (data.locked) return;
    // Never a silent no-op: during the drop→preflight window this button is
    // still on screen, and clearing mid-run would race the pipeline it is
    // trying to unwind. Say so rather than swallowing the click.
    if (PROCESSING_STATES.includes(hubStateRef.current) || processingRunsRef.current.active) {
      EventLogger.log(`[JobSearch][${id}] Clear career files rejected: run in progress (${hubStateRef.current})`);
      addToast({
        title: 'Search Starting',
        description: 'A run is starting or in progress — cancel it first, then clear career files.',
        type: 'info',
      });
      return;
    }

    EventLogger.log(`[JobSearch][${id}] User cleared career files`);

    // Same cancel quartet as resetHandler: a late-settling parse can otherwise
    // write the old profile straight back onto the cleared hub.
    epoch.bump();
    moduleRunQueue.cancelQueuedRunsForNode(id);
    window.electronAPI?.cancelNodeTask?.(id);

    // Capture sidecar tokens BEFORE the updateGlobal below nulls them.
    const batchId = data.pendingBatch?.batchId || null;
    const runId = data.pendingBatch?.jobRunId || jobRunIdRef.current || data.jobRunId || null;
    if (batchId) {
      window.electronAPI?.discardJobBatch?.({ canvasFilePath, nodeId: id, batchId }).catch(() => {});
    }
    if (runId) {
      window.electronAPI?.discardJobRun?.({ canvasFilePath, runId }).catch(() => {});
    }
    // The resume offer is CANVAS-scoped, not hub-scoped: peekJobRun/discardJobRun
    // are keyed by canvasFilePath alone (one staged run per canvas), so the offer
    // showing here may belong to a different job hub. Clearing this hub must never
    // discard it — that would trash another hub's recoverable run. Only drop the
    // local banner when the run we just discarded with our OWN token is the
    // offered one. Otherwise the banner stays and its Resume button degrades on
    // its own through the profile gate below.
    if (runId && resumeOffer?.runId === runId) setResumeOffer(null);

    // initialDropAcceptedRef is latched true by the identity effect and never
    // reset by data changes — without this, every drop path reopens visually but
    // acceptCareerFiles still bounces the drop.
    initialDropAcceptedRef.current = false;
    lastDroppedPathsRef.current = null;
    pendingJobsRef.current = null;
    gatheredCountRef.current = 0;
    scrapeWarningsRef.current = [];
    handledDuringSearchRef.current.clear();
    jobRunIdRef.current = null;
    hubStateRef.current = 'empty';
    batchCompletingRef.current = false;
    updateGlobal(id, {
      hubState: 'empty', queuedModuleRun: null, errorMessage: null, isRateLimit: false, rerunOutcome: null, rerunNotice: null, testModeNote: null, pendingBatch: null,
      scoredJobs: null, finalSourceCounts: {}, resultCount: 0, totalScoredCount: 0, scrapedCount: 0, gatheredCount: 0, scoreThreshold: 0, jobRunId: null,
      jobCount: null, scoreRangeMin: null, scoreRangeMax: null,
      aiSkipped: false, collectionOnly: false, testMode: false,
      pendingJobs: null, pendingTargetRole: null, scrapeWarnings: [], dragHover: null,
      ...buildJobHubCareerClearPatch(),
    });
    cancelCleanSourceCardDismiss();
    resetSourceProgress();
    cleanupAllJobChildren();
    processingRunsRef.current.cancel();
    addToast({ title: 'Career Files Cleared', description: 'Search settings kept — drop fresh career files to run again.', type: 'info' });
  }, [data.locked, data.pendingBatch, data.jobRunId, id, canvasFilePath, resumeOffer, epoch, moduleRunQueue, updateGlobal, cancelCleanSourceCardDismiss, resetSourceProgress, cleanupAllJobChildren, addToast]);

  const isProcessing = PROCESSING_STATES.includes(hubState);

  // Compute running total from per-source progress
  const totalSourceJobs = Object.values(sourceProgress).reduce((sum, p) => sum + (p.count || 0), 0);

  useEffect(() => {
    // A manual-AI scoring handoff is intentionally process-local. Its durable
    // scrape snapshot is not: after a quit, offer it back only to the exact
    // hub/canvas that wrote it, never a different module sharing this canvas.
    if (!['empty', 'done', 'sources-ready'].includes(hubState) || !hasReusableCareerProfile) {
      setSavedAnalysisMeta(null);
      return;
    }
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
          res.snapshot?.profile &&
          isSavedAnalysisForCurrentHub(res.snapshot, res.meta, id, canvasFilePath)
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
  }, [hubState, canvasFilePath, hasReusableCareerProfile, id]);

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
    if (data.locked || !hasReusableCareerProfile || processingRunsRef.current.active || platformsVerifying) return;
    if (!window.electronAPI?.getLastJobAnalysisSnapshot) return;
    const processingToken = processingRunsRef.current.start();
    if (!processingToken) return;

    setSavedAnalysisLoading(true);
    try {
      const res = await window.electronAPI.getLastJobAnalysisSnapshot({ canvasFilePath });
      const snapshot = res?.success && res.exists ? res.snapshot : null;
      const savedJobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
      const profile = snapshot?.profile;
      // New snapshots retain the raw evidence used by the scorer. A current
      // hub can supply it for a legacy snapshot created before this field.
      const careerData = snapshot?.careerData || data.careerData || '';
      if (!snapshot || !profile || savedJobs.length === 0
        || !isSavedAnalysisForCurrentHub(snapshot, res?.meta, id, canvasFilePath)) {
        addToast({
          title: 'No Saved Scrape',
          description: 'No saved scrape data is available to resume.',
          type: 'error',
        });
        setSavedAnalysisMeta(null);
        return;
      }

      EventLogger.log(`[JobSearch][${id}] Resuming from saved scrape (${savedJobs.length} job(s))`);
      cancelCleanSourceCardDismiss();
      resetSourceProgress();
      const currentId = id;
      const cancelled = epoch.start();
      const originalPos = getNode(currentId)?.position || { x: 0, y: 0 };
      const activeTargetRole = String(snapshot.targetRole || '').trim();
      updateGlobal(currentId, {
        errorMessage: null,
        isRateLimit: false,
        rerunOutcome: null,
        rerunNotice: null,
        testModeNote: null,
        pendingJobs: null,
        pendingTargetRole: null,
        resumeProfile: profile,
        careerData,
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
          careerData,
          jobs: savedJobs,
          gatheredCount: snapshot.sourceGatheredCount
            ?? snapshot.searchFunnel?.relevanceKept
            ?? snapshot.searchFunnel?.raw
            ?? snapshot.gatheredJobCount
            ?? savedJobs.length,
          scrapeWarnings: [],
          activeTargetRole,
          originalPos,
          cancelled,
          jobRunId: snapshot.runId || null,
          // Re-analysis snapshots have no search-run lifecycle. Only complete
          // a staged search when this recovered snapshot owns that run token.
          completeRun: !!snapshot.runId,
          locationSnapshot: snapshot.locationSnapshot || snapshot.snapshotContext?.locationSnapshot || (
            snapshot.snapshotContext?.searchLocation || snapshot.snapshotContext?.remoteResidences
              ? {
                  searchLocation: normalizeStructuredLocation(snapshot.snapshotContext?.searchLocation),
                  remoteResidences: normalizeRemoteResidences(snapshot.snapshotContext?.remoteResidences),
                }
              : null
          ),
        });
      } catch (error) {
        if (cancelled() || isNodeDeletedAbort(error)) return;
        EventLogger.error('[JobSearch] Resume from saved scrape failed:', error);
        const hubHasResults = (getNode(currentId)?.data?.scoredJobs?.length || 0) > 0;
        updateGlobal(currentId, {
          hubState: hubHasResults ? 'done' : 'empty',
          errorMessage: error?.message || String(error),
          isRateLimit: !!error?.isRateLimit,
          rerunOutcome: null,
          rerunNotice: null,
        });
      }
    } finally {
      if (isMountedRef.current) processingRunsRef.current.finish(processingToken);
      if (isMountedRef.current) setSavedAnalysisLoading(false);
    }
  }, [addToast, cancelCleanSourceCardDismiss, canvasFilePath, data.careerData, data.locked, epoch, getNode, hasReusableCareerProfile, id, platformsVerifying, resetSourceProgress, runScoringAndSpawn, updateGlobal, isMountedRef]);

  const handleDismissError = useCallback(() => {
    EventLogger.log(`[JobSearch][${id}] User clicked Dismiss Error`);
    updateGlobal(id, { errorMessage: null, isRateLimit: false, rerunOutcome: null, rerunNotice: null, testModeNote: null });
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
    updateGlobal(id, { errorMessage: null, isRateLimit: false, rerunOutcome: null, rerunNotice: null, testModeNote: null });
    handleRerun({ frameSourceCards: false });
  }, [data.locked, id, updateGlobal, handleRerun]);

  const savedAnalysisWarning = getSavedAnalysisWarning(savedAnalysisMeta, id, canvasFilePath);
  const savedScoreReadyCount = Math.max(0, Number(savedAnalysisMeta?.gatheredJobCount) || 0);
  const savedSourceGatheredCount = Number.isFinite(Number(savedAnalysisMeta?.sourceGatheredCount))
    ? Math.max(savedScoreReadyCount, Math.max(0, Math.floor(Number(savedAnalysisMeta.sourceGatheredCount))))
    : savedScoreReadyCount;
  // Saved snapshots are canvas-scoped, so an older run can legitimately exist
  // beside the current done state. Only use its durable funnel when it belongs
  // to this exact run token.
  const savedAnalysisMatchesCurrentRun = !!savedAnalysisMeta?.runId
    && savedAnalysisMeta.runId === data.jobRunId;
  const doneGatheredCount = savedAnalysisMatchesCurrentRun
    ? Math.max(Number(data.gatheredCount) || 0, savedSourceGatheredCount)
    : data.gatheredCount;
  const savedAnalysisPanel = savedAnalysisMeta ? (
    <div className="mt-2 w-full rounded-md border border-white/10 bg-white/5 px-2 py-2 text-left">
      <div className="text-[9px] uppercase tracking-[0.14em] text-white/25">Saved Scrape</div>
      <div className="mt-1 text-[10px] text-white/65">
        {savedSourceGatheredCount} found
        {savedSourceGatheredCount !== savedScoreReadyCount ? ` • ${savedScoreReadyCount} score-ready` : ''}
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
          className="nodrag rounded border border-white/10 bg-white/5 px-2 py-1 text-[9px] text-white/55 hover:bg-white/10 disabled:cursor-default disabled:opacity-50"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleOpenSavedPrompt}
          type="button"
          disabled={!savedAnalysisMeta.promptPath}
          title={savedAnalysisMeta.promptPath ? 'Open the saved AI scoring prompt' : 'No verified prompt file is available for this recovered snapshot'}
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
        {/* State the observation, not an asserted cause: the offer is
            canvas-scoped and may belong to a module this one never shared
            history with, so naming a lost career-file history would be a guess
            — a virgin hub never had one. */}
        {resumeRunActionable
          ? ' Resume to continue it, or start fresh.'
          : canResumeOffer
            ? ' Start fresh — this run cannot be resumed from this module.'
            : ` Start fresh — this run targeted ${resumeOffer.locationRecorded ? (offeredResumeLocation || 'no location') : 'an unrecorded legacy location'}, not the current ${activeResumeLocation || 'no location'}.`}
      </div>
      <div className="flex gap-1.5 mt-1.5">
        {resumeRunActionable && <button
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
      width={330}
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
              ) : (inputDropsBlocked && hasCareerIdentity) ? (
                // Gated on real career identity, not merely on drops being
                // blocked: a LOCKED virgin hub has nothing retained, so it falls
                // through to the normal drop copy (drops still bounce off
                // dropsBlocked/handleDrop, and the drag chip still says "Locked").
                <>
                  <p className="text-white/40 text-sm font-medium">Career files retained</p>
                  {/* Both actions below are hidden while data.locked, so the
                      subtitle must not name them — it would describe buttons
                      that aren't there. */}
                  <p className="text-white/25 text-[10px] mt-1 text-center">{data.locked
                    ? 'Unlock this module to re-run it or change its files'
                    : 'Re-run with these files, or clear them to search with different ones'}</p>
                  {hasReusableCareerProfile && !data.locked && (
                    <button
                      type="button"
                      className="nodrag mt-3 px-3 py-1 rounded-full bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 text-[10px] border border-blue-500/20 transition-colors"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); handleRerun(); }}
                    >
                      Re-run Search
                    </button>
                  )}
                  {/* Not gated on hasReusableCareerProfile — a partially-wedged
                      identity (locked with no parsed profile) is exactly the
                      case that most needs clearing. */}
                  {!data.locked && (
                    <button
                      type="button"
                      className="nodrag mt-1.5 px-3 py-1 rounded-full bg-white/5 text-white/45 hover:bg-white/10 hover:text-white/70 text-[10px] border border-white/10 transition-colors"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); handleClearCareerFiles(e); }}
                    >
                      Clear career files
                    </button>
                  )}
                </>
              ) : (
                <>
                  {/* A LOCKED virgin hub lands here (nothing retained to describe),
                      and its drops are silently refused — don't invite one. */}
                  <p className="text-white/40 text-sm font-medium">{data.locked ? 'Module locked' : 'Drop your career files'}</p>
                  <p className="text-white/25 text-[10px] mt-1 text-center">{data.locked
                    ? 'Unlock it to drop career files'
                    : 'Résumé, portfolio, project notes — any number of files'}</p>
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
                  title="Blank: AI generates best-fit search variations. Set: skips variation generation and searches this exact role once."
                  className="w-full px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-1 focus:outline-none focus:border-blue-400/50 placeholder:text-white/25"
                />
                {roleOperators.length > 0 && (
                  <p className="text-amber-300/70 text-[9px] leading-snug px-0.5">
                    {roleOperators.join(', ')} {roleOperators.length > 1 ? 'are' : 'is'} sent as ordinary words, not search operators — job boards either ignore them or return the opposite of what you meant. Type the role in plain words.
                  </p>
                )}
                <JobSearchLocationFields
                  searchLocation={searchLocation}
                  setSearchLocation={setSearchLocation}
                  remoteResidences={remoteResidences}
                  setRemoteResidence={setRemoteResidence}
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
                {!data.locked && (
                  <JobPlatformSelectionControl
                    enabledSourceIds={enabledSourceIds}
                    setEnabledSourceIds={setEnabledSourceIds}
                    collectionLimits={collectionLimits}
                    availableSourceIds={ACTIVE_JOB_SOURCES}
                    searchLocation={searchLocation}
                  />
                )}
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

        {/* Recovery-only: an older version may have submitted a batch before
            batch scoring was removed. Poll it quietly so paid work is not
            stranded, but new modules have no way to enter this state. */}
        {hubState === 'scoring-batch' && (
          <>
            {banner}
            <div className="flex flex-col items-center py-6 px-4 gap-2 text-center" onPointerDown={(e) => e.stopPropagation()}>
              <Briefcase size={24} className="text-blue-400/50 animate-pulse" />
              <p className="text-white/70 text-sm font-medium">Finishing a previous scoring run</p>
              <p className="text-white/35 text-[10px] leading-relaxed">
                This search was started by an earlier app version. Its results will appear when the already-submitted work completes.
              </p>
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
              gatheredCount={doneGatheredCount}
              queryModel={data.queryModel || null}
              testMode={!!data.testMode}
              aiSkipped={!!data.aiSkipped}
              collectionOnly={!!data.collectionOnly}
              resumeSummary={data.resumeSummary}
              locked={!!data.locked}
              onRerun={handleRerun}
              onReanalyze={handleReanalyze}
              onClearCareerFiles={handleClearCareerFiles}
              maxAgeDays={maxAgeDays}
              setMaxAgeDays={setMaxAgeDays}
              collectionLimits={collectionLimits}
              setCollectionLimits={setCollectionLimits}
              enabledSourceIds={enabledSourceIds}
              setEnabledSourceIds={setEnabledSourceIds}
              availableSourceIds={ACTIVE_JOB_SOURCES}
              searchLocation={searchLocation}
              setSearchLocation={setSearchLocation}
              remoteResidences={remoteResidences}
              setRemoteResidence={setRemoteResidence}
              targetRole={targetRole}
              setTargetRole={setTargetRole}
              scrapeWarnings={data.scrapeWarnings || []}
              rerunOutcome={data.rerunOutcome || null}
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
