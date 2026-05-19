import React, { useRef, useEffect, useCallback, useContext } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { HubContainer } from '../components/HubContainer';
import { Briefcase } from 'lucide-react';
import { JOB_SOURCES, ACTIVE_JOB_SOURCES } from '../utils/constants';
import { EventLogger } from '../utils/EventLogger';
import { useToast } from '../components/ToastProvider';

import { JobHubProcessingState } from './jobhub/JobHubProcessingState';
import { JobHubDoneState } from './jobhub/JobHubDoneState';
import { HubErrorBanner } from '../components/HubErrorBanner';
import { useCheckAllConnected } from '../hooks/useCheckAllConnected';
import { useUnmountEffect } from '../hooks/useUnmountEffect';
import { useEpochCancellation } from '../hooks/useEpochCancellation';
import { useSourceProgress } from '../hooks/useSourceProgress';
import { pickEdgeHandles, structuralEdge } from './_shared/edgeHelpers';
import { deleteChildrenByHubId } from './_shared/hubChildCleanup';
import {
  partitionJobsForBranches,
  buildJobsForBucketing,
  buildJobTreeNodes,
} from './jobhub/buildJobTree';

const STATE_LABELS = {
  empty: null,
  parsing: 'Reading resume...',
  querying: 'Planning search strategy...',
  searching: 'Searching for jobs...',
  scoring: 'AI scoring matches...',
  done: null,
};

const PROCESSING_STATES = ['parsing', 'querying', 'searching', 'scoring'];

/**
 * JobHubNode — draggable canvas module for job search.
 * Phase 2: Per-source independent status tracking + source filtering.
 *
 * data.hubState: 'empty' | 'parsing' | 'querying' | 'searching' | 'scoring' | 'done'
 *                Failures set data.errorMessage (surfaced via HubErrorBanner)
 *                but stay in the logical step rather than wiping to an error wall.
 * data.filePath: string (set when auto-created from canvas file drop)
 * data.resultCount: number
 * data.errorMessage: string
 * data.resumeSummary: string
 * data.sourceFilter: string | null — if set, only show jobs from this source
 */
export function JobHubNode({ id, data }) {

  // id is stable for this component's lifetime — ReactFlow never reuses
  // instances with different ids, so we can safely close over it in callbacks.
  const { updateNodeData, setNodes, getNode, getNodes, getEdges, addNodes, addEdges, deleteElements, fitView } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const addElementsGlobally = nav?.addElementsGlobally;
  const canvasFilePath = nav?.currentFile || null;
  const processingRef = useRef(false);
  const isMountedRef = useRef(true);
  const epoch = useEpochCancellation();
  const { addToast } = useToast();
  useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);
  // Stable ref to startProcessing so handleDrop can call it without a stale closure.
  const startProcessingRef = useRef(null);

  const hubState = data.hubState || 'empty';
  const statusLabel = STATE_LABELS[hubState];
  const sourceFilter = data.sourceFilter || null;

  // Per-source progress state populated by backend `job-source-progress`
  // events. Reset via `resetSourceProgress` before each fresh run so stale
  // counts from the previous run don't bleed into the new pipeline.
  const {
    progress: sourceProgress,
    lastActive: lastActiveSource,
    reset: resetSourceProgress,
  } = useSourceProgress(window.electronAPI?.onJobSourceProgress, id);

  // Surface the live ring state to the bug-report snapshot so reports about
  // ring rendering can be diagnosed from the report alone.
  useEffect(() => {
    EventLogger.registerNodeState(id, { hubState, sourceProgress });
    return () => EventLogger.unregisterNodeState(id);
  }, [id, hubState, sourceProgress]);

  // Settings change → clear any "config missing" error so the user isn't left
  // staring at a stale warning after they've fixed it. Don't auto-rerun the
  // pipeline; the user re-triggers via Re-run Search themselves.
  useEffect(() => {
    if (!window.electronAPI?.onSettingsChanged) return;
    const cleanup = window.electronAPI.onSettingsChanged((payload) => {
      if (!payload?.changedSections?.includes('ai')) return;
      if (data.errorMessage) {
        updateGlobal(id, { errorMessage: null, isRateLimit: false });
      }
    });
    return () => cleanup?.();
  }, [id, data.errorMessage, updateGlobal]);

  // Combined card opacity: source AND score AND status filters all applied together.
  // Score filter uses the dynamic slider value. The slider's "show all" bottom
  // is the minimum matchScore on the canvas; setting scoreThreshold below or
  // equal to that minimum hides nothing.
  // Declared before toggleSourceFilter because toggleSourceFilter references it.
  const applyCardFilters = useCallback(({ sourceFilter: sf, scoreThreshold: st, statusFilters: stf } = {}) => {
    // Fall back to current data values if not passed explicitly
    const activeSrc   = sf  !== undefined ? sf  : (data.sourceFilter || null);
    const activeScore = st  !== undefined ? st  : (data.scoreThreshold ?? 0);
    const activeStats = stf !== undefined ? stf : (data.statusFilters || []);

    setNodes(nodes => nodes.map(n => {
      if (n.type !== 'jobcard') return n;
      const srcOk    = !activeSrc   || n.data?.source === activeSrc;
      const scoreOk  = (n.data?.matchScore ?? 0) >= activeScore;
      const statusOk = activeStats.length === 0 || activeStats.includes(n.data?.status || 'New');
      const visible  = srcOk && scoreOk && statusOk;
      return { ...n, style: { ...n.style, opacity: visible ? 1 : 0.15 } };
    }));
  }, [data.sourceFilter, data.scoreThreshold, data.statusFilters, setNodes]);

  // Source click-through filtering. Now invoked from the JobSourceCardNode
  // children (via a CustomEvent) rather than the old orbital ring icons.
  const toggleSourceFilter = useCallback((sourceId) => {
    const newFilter = sourceFilter === sourceId ? null : sourceId;
    updateGlobal(id, { sourceFilter: newFilter });
    applyCardFilters({ sourceFilter: newFilter });
  }, [sourceFilter, id, updateGlobal, applyCardFilters]);

  // Listen for filter-toggle dispatches from this hub's source cards. Each
  // event carries hubId so multi-hub canvases stay independent.
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.hubId !== id) return;
      if (!e.detail?.sourceId) return;
      toggleSourceFilter(e.detail.sourceId);
    };
    document.addEventListener('job-source-filter-toggle', handler);
    return () => document.removeEventListener('job-source-filter-toggle', handler);
  }, [id, toggleSourceFilter]);

  const setScoreThreshold = useCallback((val) => {
    updateGlobal(id, { scoreThreshold: val });
    applyCardFilters({ scoreThreshold: val });
  }, [id, updateGlobal, applyCardFilters]);

  const toggleStatusFilter = useCallback((status) => {
    const current = data.statusFilters || [];
    const updated = current.includes(status) ? current.filter(s => s !== status) : [...current, status];
    updateGlobal(id, { statusFilters: updated });
    applyCardFilters({ statusFilters: updated });
  }, [data.statusFilters, id, updateGlobal, applyCardFilters]);

  // How far back to look for postings on each search. Persisted on node data
  // so it survives saves and applies to re-runs. 21 days = three weeks; sits
  // between the "freshest" applicant pool and the ~30-day mark where ~43% of
  // postings have been filled (see job-listing-age research notes).
  const maxAgeDays = data.maxAgeDays || 21;
  const setMaxAgeDays = useCallback((val) => {
    const n = Math.max(1, Math.min(180, Math.floor(Number(val) || 21)));
    updateGlobal(id, { maxAgeDays: n });
  }, [id, updateGlobal]);

  // Optional target/pivot role. Free text — the AI uses it to prioritize
  // matching jobs and to flag isTargetRoleMatch during scoring. Persisted so
  // it survives saves and re-runs.
  const targetRole = data.targetRole || '';
  const setTargetRole = useCallback((val) => {
    updateGlobal(id, { targetRole: typeof val === 'string' ? val : '' });
  }, [id, updateGlobal]);

  // Cascade-delete every spawned child on hub unmount.
  const cleanupAllJobChildren = useCallback(() => {
    deleteChildrenByHubId({
      getNodes, getEdges, deleteElements, hubId: id,
      childTypes: ['jobsourcecard', 'jobcard', 'jobgroup'],
    });
  }, [id, getNodes, getEdges, deleteElements]);

  useUnmountEffect(cleanupAllJobChildren);

  // ── Job-source platform cards (persistent, one per ACTIVE_JOB_SOURCE) ─────
  // Replaces the orbital ring with real canvas nodes connected by edges.
  // Each card subscribes to its own progress events and falls back to the
  // hub's `finalSourceCounts` between runs so the last-known count is shown.
  const ensureSourceCards = useCallback(() => {
    const existing = getNodes().filter(n => n.type === 'jobsourcecard' && n.data?.hubId === id);
    const existingSourceIds = new Set(existing.map(n => n.data?.sourceId));
    const missing = ACTIVE_JOB_SOURCES
      .map(sid => JOB_SOURCES.find(s => s.id === sid))
      .filter(s => s && !existingSourceIds.has(s.id));
    if (missing.length === 0) return;

    const hubPos = getNode(id)?.position || { x: 0, y: 0 };
    // Lay cards out in a circle around the hub — matches the SellHub →
    // CompSourceCard pattern so edges fan to each card's nearest hub side
    // instead of all bunching on the left. Radius is sized for ~12 sources
    // (30° apart at r=320 → ~110px clearance between hub edge and nearest
    // card edge). The user can drag any card anywhere afterward.
    const HUB_W = 260, HUB_H = 140;     // approx hub footprint while idle
    const CARD_W = 140, CARD_H = 50;
    const RADIUS = 320;
    const cx = hubPos.x + HUB_W / 2;
    const cy = hubPos.y + HUB_H / 2;
    const total = existing.length + missing.length;
    const stamp = Date.now();

    const newNodes = missing.map((source, i) => {
      // Angle the card across the full circle; first card at top (-π/2).
      const angleIdx = existing.length + i;
      const angle = (angleIdx / total) * 2 * Math.PI - Math.PI / 2;
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
        },
      };
    });

    // Route each hub→card edge to the hub's nearest side. Both ends already
    // render the NodeHandles slots; pickEdgeHandles picks which side to use
    // so edges don't all bunch on the hub's right.
    const newEdges = newNodes.map(n => ({
      id: `edge-${id}-${n.id}`,
      source: id,
      target: n.id,
      ...pickEdgeHandles(
        { x: n.position.x + CARD_W / 2, y: n.position.y + CARD_H / 2 },
        { x: cx,                        y: cy                       },
      ),
      ...structuralEdge('rgba(96,165,250,0.5)'),
    }));

    if (addElementsGlobally) {
      addElementsGlobally(id, newNodes, newEdges, 'sibling');
    } else {
      addNodes(newNodes);
      addEdges(newEdges);
    }

    // Frame the hub + the source-card grid we just spawned. requestAnimationFrame
    // gives ReactFlow one tick to register the new nodes; a synchronous fitView
    // would frame only the hub.
    requestAnimationFrame(() => {
      fitView({ duration: 600, padding: 0.2 });
    });
  }, [id, getNode, getNodes, addElementsGlobally, addNodes, addEdges, fitView]);

  // Re-apply all filters on mount — opacities are stripped from save files to keep them clean.
  // The score filter is "active" whenever the slider is above its dynamic min,
  // since the slider's bottom is the lowest spawned score (not 0).
  useEffect(() => {
    const min = data.scoreRangeMin ?? 0;
    const hasFilter = data.sourceFilter || (data.scoreThreshold ?? min) > min || (data.statusFilters || []).length > 0;
    if (!hasFilter) return;
    applyCardFilters({});
  }, [applyCardFilters, data.scoreThreshold, data.scoreRangeMin, data.sourceFilter, data.statusFilters]);

  /**
   * Drives the full pipeline. Pass `filePath` for a fresh resume parse, or
   * `profile` to skip parsing and re-run from query construction onward.
   * `filePath` takes precedence when both are provided.
   */
  const runPipeline = useCallback(async ({ filePath, profile: providedProfile } = {}) => {
    if (!window.electronAPI || processingRef.current) return;
    if (!filePath && !providedProfile) return;
    processingRef.current = true;
    resetSourceProgress();
    const currentId = id;
    // Capture cancellation epoch at start; cancelled() returns true after
    // any reset/unmount so we can drop late settlements without mutating
    // freshly-reverted state.
    const cancelled = epoch.start();

    // Spawn (or reuse) one platform card per active job source. Cards subscribe
    // to per-source progress events themselves, so the hub doesn't need to push
    // anything to them — they update independently.
    ensureSourceCards();

    // Snapshot the node position so we can spawn siblings near it even if
    // the user navigates away and unmounts this layer of the canvas.
    const originalPos = getNode(currentId)?.position || { x: 0, y: 0 };

    try {
      let profile = providedProfile;

      // Step 1: Parse resume (only when a fresh file path was supplied)
      if (filePath) {
        updateGlobal(currentId, { hubState: 'parsing' });
        const parseResult = await window.electronAPI.parseResume({ filePath, nodeId: currentId });
        if (cancelled()) return;
        if (!parseResult.success) {
          const err = new Error(parseResult.error || 'Failed to parse resume');
          if (parseResult.isRateLimit) err.isRateLimit = true;
          throw err;
        }
        profile = parseResult.profile;

        updateGlobal(currentId, {
          hubState: 'querying',
          resumeProfile: profile,
          resumeSummary: `${profile.skills?.slice(0, 3).join(', ')}${profile.experience_years ? ` · ${profile.experience_years}y exp` : ''}`,
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
      const queriesResult = await window.electronAPI.generateJobQueries({
        profile, nodeId: currentId, targetRole: activeTargetRole,
      });
      if (cancelled()) return;
      if (!queriesResult.success) {
        const err = new Error(queriesResult.error || 'Failed to generate queries');
        if (queriesResult.isRateLimit) err.isRateLimit = true;
        throw err;
      }
      const {
        titleQueries = [], suggestedRoleQueries = [], skillsOnlyQueries = [], targetRoleQueries = [],
      } = queriesResult.queries || {};
      // Target-role queries first so the limited-query subsets per source
      // (1-2 queries on heavy-WAF sites) bias toward the pivot the user
      // actually asked for.
      const allQueries = [...targetRoleQueries, ...titleQueries, ...suggestedRoleQueries, ...skillsOnlyQueries];

      // Step 3: Search
      updateGlobal(currentId, { hubState: 'searching', queryCount: allQueries.length });
      const searchResult = await window.electronAPI.searchJobs({
        queries: allQueries,
        nodeId: currentId,
        maxAgeDays: data.maxAgeDays || 21,
        canvasFilePath,
      });
      if (cancelled()) return;

      if (!searchResult.success || !searchResult.jobs || searchResult.jobs.length === 0) {
        // Persist scrape warnings even when zero jobs returned — this path
        // is the most common "blocked everywhere" failure mode and the user
        // needs the warnings to debug why nothing came back. Also reset the
        // slider range + branch counts so the done-state UI doesn't show
        // stale values from a previous successful run.
        updateGlobal(currentId, {
          hubState: 'done',
          resultCount: 0,
          totalScoredCount: 0,
          targetCount: 0,
          otherCount: 0,
          scoreRangeMin: 0,
          scoreRangeMax: 100,
          scoreThreshold: 0,
          scrapeWarnings: Array.isArray(searchResult.scrapeWarnings) ? searchResult.scrapeWarnings : [],
        });
        return;
      }

      // Step 4: Scoring
      updateGlobal(currentId, { hubState: 'scoring', jobCount: searchResult.jobs.length });
      const scoreResult = await window.electronAPI.scoreJobs({
        jobs: searchResult.jobs, profile, nodeId: currentId, targetRole: activeTargetRole,
      });
      if (cancelled()) return;
      if (!scoreResult.success) {
        const err = new Error(scoreResult.error || 'Failed to score jobs');
        if (scoreResult.isRateLimit) err.isRateLimit = true;
        throw err;
      }

      // ── Branch construction (split + loose-fill) ──────────────────────
      // Pure list-shaping happens in buildJobTree.js. JobHubNode here is
      // just the IPC orchestrator.
      const hasTarget = !!activeTargetRole;
      const { targetList, otherList, displayedJobs } =
        partitionJobsForBranches(scoreResult.scoredJobs, hasTarget);

      // Step 4.5: Bucket displayed jobs into a category → salary-range tree.
      // Target jobs get a careerDirection override so the AI clusters them
      // under one synthetic "Target Role" category (see buildJobsForBucketing
      // and TARGET_BUCKETING_CATEGORY). Failure here degrades to flat spawn.
      let bucketTree = null;
      const bucketingInput = buildJobsForBucketing(
        displayedJobs, targetList, scoreResult.scoredJobs, hasTarget,
      );
      try {
        const bucketResult = await window.electronAPI.bucketJobs({
          jobs: bucketingInput,
          nodeId: currentId,
        });
        if (cancelled()) return;
        if (bucketResult?.success && Array.isArray(bucketResult.categories) && bucketResult.categories.length > 0) {
          bucketTree = bucketResult.categories;
        } else {
          EventLogger.error('[JobHub] Bucketing returned no categories — falling back to flat spawn');
        }
      } catch (err) {
        EventLogger.error('[JobHub] Bucketing failed — falling back to flat spawn:', err);
      }

      // Step 5: Spawn the tree. Pure node/edge construction lives in
      // buildJobTreeNodes; we just pass results to ReactFlow below.
      const baseNodeId = `job-${Date.now()}`;
      const { newNodes, newEdges, scoreRangeMin, scoreRangeMax } = buildJobTreeNodes({
        scoredJobs: scoreResult.scoredJobs,
        bucketTree,
        bucketingInput,
        targetList,
        otherList,
        displayedJobs,
        hasTarget,
        targetRole: activeTargetRole,
        profile,
        originalPos,
        hubId: currentId,
        baseNodeId,
      });
      const flatJobsToSpawn = hasTarget ? displayedJobs : scoreResult.scoredJobs;

      if (newNodes.length > 0) {
        document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
        if (addElementsGlobally) {
          addElementsGlobally(currentId, newNodes, newEdges, 'sibling');
        } else {
          // Fallback if not inside CanvasNavigationContext (dev/test).
          addNodes(newNodes);
          addEdges(newEdges);
        }

        // Frame the hub + freshly-spawned column of job cards. Same call the
        // third Controls button issues; waits one frame so ReactFlow registers
        // the new nodes before computing the bounds.
        requestAnimationFrame(() => {
          fitView({ duration: 600, padding: 0.2 });
        });
      }

      // Track spawned IDs so re-runs can clean orphans even if edges were manually deleted.
      const finalSourceCounts = {};
      scoreResult.scoredJobs.forEach(job => {
        finalSourceCounts[job.source] = (finalSourceCounts[job.source] || 0) + 1;
      });

      // Append shown jobs to the 60-day rolling history file so future runs
      // can suppress them. Best-effort: a failed write must not break the
      // user-visible pipeline. The backend handles 60-day pruning in the
      // same write.
      if (canvasFilePath && scoreResult.scoredJobs.length > 0) {
        const historyRows = scoreResult.scoredJobs.map(j => ({
          source: j.source, company: j.company, title: j.title, location: j.location, url: j.url,
        }));
        window.electronAPI.appendJobsHistory({ canvasFilePath, jobs: historyRows })
          .catch(err => EventLogger.error('[JobHub] History append failed:', err));
      }

      updateGlobal(currentId, {
        hubState: 'done',
        resultCount: flatJobsToSpawn.length,
        totalScoredCount: scoreResult.scoredJobs.length,
        targetCount: hasTarget ? targetList.length : 0,
        otherCount: hasTarget ? otherList.length : 0,
        finalSourceCounts,
        scoreRangeMin,
        scoreRangeMax,
        // Reset slider to min on every run — the previous absolute value is
        // not meaningful across runs because the underlying score range
        // changed (per spec: "show all" default).
        scoreThreshold: scoreRangeMin,
        // Persist scrape warnings so the done-state panel can show which
        // sources got blocked / throttled even on a successful run with
        // results — partial-block scenarios were previously invisible.
        scrapeWarnings: Array.isArray(searchResult.scrapeWarnings) ? searchResult.scrapeWarnings : [],
      });
    } catch (error) {
      if (cancelled()) return; // user cancelled — let resetHandler's revert stand
      EventLogger.error('JobHubNode pipeline failed:', error);
      // Revert to the logical step ('done' if any results exist on the
      // canvas, else 'empty') and surface the failure via errorMessage so
      // HubErrorBanner picks it up.
      const hubChildrenOnCanvas = getNodes().some(n =>
        (n.type === 'jobcard' || n.type === 'jobgroup') && n.data?.hubId === currentId
      );
      updateGlobal(currentId, {
        hubState: hubChildrenOnCanvas ? 'done' : 'empty',
        errorMessage: error?.message || String(error),
        isRateLimit: !!error?.isRateLimit,
      });
    } finally {
      if (isMountedRef.current) processingRef.current = false;
    }
  }, [id, updateGlobal, addElementsGlobally, addNodes, addEdges, getNode, getNodes, canvasFilePath, data.maxAgeDays, data.targetRole, ensureSourceCards, fitView, epoch, resetSourceProgress]);

  const startProcessing = useCallback((filePath) => runPipeline({ filePath }), [runPipeline]);
  const startProcessingWithProfile = useCallback((profile) => runPipeline({ profile }), [runPipeline]);

  // Keep the ref up-to-date so handleDrop always calls the latest version.
  startProcessingRef.current = startProcessing;

  // Auto-start when drop-created (must come after startProcessing is declared
  // — referencing it earlier would hit the const TDZ on first render).
  useEffect(() => {
    if (data.filePath && hubState === 'empty' && !processingRef.current) {
      startProcessing(data.filePath);
    }
  }, [data.filePath, hubState, startProcessing]);

  // Handle file drops directly onto this node
  const handleDrop = useCallback((e) => {
    if (data.locked) return;
    if (PROCESSING_STATES.includes(hubState)) return;

    e.preventDefault();
    e.stopPropagation();

    const files = Array.from(e.dataTransfer?.files || []);
    const exts = files.map(f => (f.name.match(/\.[a-z0-9]+$/i)?.[0] || '?').toLowerCase());
    EventLogger.log(`[JobHub][${id}] Drop attempt: ${files.length} file(s) ext=[${exts.join(', ') || 'none'}]`);

    // Accept any file — the backend (gemini.js/claude.js callDocument) handles
    // PDFs/DOCX inline, images via vision, and falls back to utf8 text for
    // everything else. The only true rejection is legacy .doc (binary blob
    // the API can't ingest) and oversize files, both of which surface clean
    // backend errors via the parseResume catch path below.
    const resume = files[0];
    if (!resume) return;

    const path = resume.path || (window.electronAPI?.getPathForFile ? window.electronAPI.getPathForFile(resume) : '');
    if (path) {
      EventLogger.log(`[JobHub][${id}] Drop accepted: ${resume.name}`);
      startProcessingRef.current?.(path);
    }
  }, [data.locked, hubState, id]);

  const resetHandler = useCallback((e) => {
    e?.stopPropagation();
    if (data.locked) return;

    // Bump the epoch so any in-flight runPipeline step that settles after
    // this point sees a mismatch and bails (doesn't overwrite the freshly-
    // reverted state or spawn orphan nodes).
    epoch.bump();

    // Actually abort the backend — without this the AbortControllers registered
    // against this nodeId keep running and finish a few seconds later, often
    // bouncing the UI back to a "done" state the user just dismissed.
    window.electronAPI?.cancelNodeTask?.(id);

    // Also clear filePath. The auto-start effect re-fires runPipeline whenever
    // `data.filePath && hubState === 'empty' && !processingRef.current`, so
    // leaving filePath set after a reset to 'empty' would immediately re-parse
    // the same resume — the user clicked Reset, not Retry. They can drop the
    // resume again or click Try Again on the error state.
    updateGlobal(id, { hubState: 'empty', filePath: null, errorMessage: null, isRateLimit: false });
    resetSourceProgress();
    processingRef.current = false;
  }, [data.locked, id, updateGlobal, epoch, resetSourceProgress]);

  // Bulk job-card status checks via the shared hook (same one SellHubNode
  // uses for marketplace cards). The hook also exposes getConnectedCards()
  // which we reuse for the CSV export and connected-count display.
  const {
    checkingAll: checkingAllStatuses,
    checkAll: handleCheckAllStatuses,
    getConnectedCards: getConnectedJobCardNodes,
  } = useCheckAllConnected({
    hubId: id,
    cardType: 'jobcard',
    // Application URL takes priority when the user has pasted one; otherwise
    // we check the original job posting (still useful: "is this still open?").
    getUrl: (d) => d?.applicationUrl?.trim() || d?.url || '',
    getPlatformId: (d) => d?.source || 'job',
    fields: { status: 'monitorStatus', message: 'monitorMessage', lastChecked: 'monitorLastChecked' },
    updateNode: updateNodeData,
    itemLabel: 'job',
  });
  const connectedJobCards = getConnectedJobCardNodes().map(n => n.data);

  const handleRerun = useCallback(() => {
    if (data.locked || processingRef.current) return;
    if (!data.filePath && !data.resumeProfile) {
      addToast({ title: 'No Resume', description: 'Drop a resume file onto the hub to search again.', type: 'error' });
      return;
    }

    // Remove old result tree before re-running. jobsourcecard tiles are
    // excluded — they're persistent platform tiles whose drag-adjusted
    // positions should survive a re-run.
    deleteChildrenByHubId({
      getNodes, getEdges, deleteElements, hubId: id,
      childTypes: ['jobcard', 'jobgroup'],
    });

    resetSourceProgress();
    if (data.filePath) {
      // File still accessible — re-parse for freshness then run full pipeline
      startProcessingRef.current?.(data.filePath);
    } else {
      // File gone but profile is persisted — run from query step onward
      addToast({ title: 'Re-running Search', description: 'Using stored resume profile — original file not needed.', type: 'info' });
      startProcessingWithProfile(data.resumeProfile);
    }
  }, [data.locked, data.filePath, data.resumeProfile, id, getNodes, getEdges, deleteElements, addToast, startProcessingWithProfile, resetSourceProgress]);

  const isProcessing = PROCESSING_STATES.includes(hubState);

  // Compute running total from per-source progress
  const totalSourceJobs = Object.values(sourceProgress).reduce((sum, p) => sum + (p.count || 0), 0);

  const handleDismissError = useCallback(() => {
    updateGlobal(id, { errorMessage: null, isRateLimit: false });
  }, [id, updateGlobal]);

  const handleRetryFailed = useCallback(() => {
    if (data.locked) return;
    updateGlobal(id, { errorMessage: null, isRateLimit: false });
    handleRerun();
  }, [data.locked, id, updateGlobal, handleRerun]);

  const banner = data.errorMessage ? (
    <HubErrorBanner
      errorMessage={data.errorMessage}
      isRateLimit={!!data.isRateLimit}
      locked={!!data.locked}
      onRetry={handleRetryFailed}
      onDismiss={handleDismissError}
    />
  ) : null;

  return (
    <HubContainer
      hubState={hubState}
      theme="blue"
      width={260}
      height={undefined}
      minHeight={hubState === 'empty' ? 140 : 100}
      onDrop={handleDrop}
    >
        {/* Empty state — drop zone (+ banner if a prior attempt failed) */}
        {hubState === 'empty' && (
          <>
            {banner}
            <div className="flex flex-col items-center justify-center py-8 px-4 cursor-pointer">
              <Briefcase size={28} className="text-blue-400/40 mb-3" />
              <p className="text-white/40 text-sm font-medium">Drop resume here</p>
              <div
                className="nodrag mt-4 w-full flex flex-col items-stretch gap-1.5 text-[10px] text-white/40"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <input
                  type="text"
                  value={targetRole}
                  onChange={(e) => setTargetRole(e.target.value)}
                  placeholder="Target role (optional) — e.g. Product Manager"
                  className="w-full px-2 bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-1 focus:outline-none focus:border-blue-400/50 placeholder:text-white/25"
                />
                <div className="flex items-center justify-center gap-1.5">
                  <span>Look back</span>
                  <input
                    type="number"
                    min={1}
                    max={180}
                    value={maxAgeDays}
                    onChange={(e) => setMaxAgeDays(e.target.value)}
                    className="w-10 text-center bg-white/5 border border-white/10 rounded text-white/70 text-[10px] py-0.5 focus:outline-none focus:border-blue-400/50"
                  />
                  <span>days</span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Processing state */}
        {isProcessing && (
          <JobHubProcessingState
            statusLabel={statusLabel}
            hubState={hubState}
            totalSourceJobs={totalSourceJobs}
            resumeSummary={data.resumeSummary}
            activeSourceId={lastActiveSource}
            onReset={resetHandler}
          />
        )}

        {/* Done state — shows stale results + banner above when a re-run failed */}
        {hubState === 'done' && (
          <>
            {banner}
            <JobHubDoneState
              resultCount={data.resultCount}
              targetCount={data.targetCount || 0}
              otherCount={data.otherCount || 0}
              sourceFilter={sourceFilter}
              toggleSourceFilter={toggleSourceFilter}
              resumeSummary={data.resumeSummary}
              locked={!!data.locked}
              scoreThreshold={data.scoreThreshold ?? (data.scoreRangeMin ?? 0)}
              setScoreThreshold={setScoreThreshold}
              scoreRangeMin={data.scoreRangeMin ?? 0}
              scoreRangeMax={data.scoreRangeMax ?? 100}
              statusFilters={data.statusFilters || []}
              toggleStatusFilter={toggleStatusFilter}
              onRerun={handleRerun}
              jobCards={connectedJobCards}
              maxAgeDays={maxAgeDays}
              setMaxAgeDays={setMaxAgeDays}
              targetRole={targetRole}
              setTargetRole={setTargetRole}
              onCheckAllStatuses={handleCheckAllStatuses}
              checkingAll={checkingAllStatuses}
              scrapeWarnings={data.scrapeWarnings || []}
            />
          </>
        )}
      </HubContainer>
  );
}
