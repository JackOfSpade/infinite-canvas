import React, { useState, useRef, useEffect, useCallback, useContext } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { HubContainer } from '../components/HubContainer';
import { Briefcase } from 'lucide-react';
import { JOB_SOURCES, ACTIVE_JOB_SOURCES } from '../utils/constants';
import { EventLogger } from '../utils/EventLogger';
import { useToast } from '../components/ToastProvider';

import { JobHubProcessingState } from './jobhub/JobHubProcessingState';
import { JobHubDoneState } from './jobhub/JobHubDoneState';
import { useCheckAllConnected } from '../hooks/useCheckAllConnected';

const STATE_LABELS = {
  empty: null,
  parsing: 'Reading resume...',
  querying: 'Planning search strategy...',
  searching: 'Searching for jobs...',
  scoring: 'AI scoring matches...',
  done: null,
  error: null,
};

const PROCESSING_STATES = ['parsing', 'querying', 'searching', 'scoring'];

/**
 * JobHubNode — draggable canvas module for job search.
 * Phase 2: Per-source independent status tracking + source filtering.
 *
 * data.hubState: 'empty' | 'parsing' | 'querying' | 'searching' | 'scoring' | 'done' | 'error'
 * data.filePath: string (set when auto-created from canvas file drop)
 * data.resultCount: number
 * data.errorMessage: string
 * data.resumeSummary: string
 * data.sourceFilter: string | null — if set, only show jobs from this source
 */
export function JobHubNode({ id, data }) {

  // id is stable for this component's lifetime — ReactFlow never reuses
  // instances with different ids, so we can safely close over it in callbacks.
  const { updateNodeData, setNodes, getNode, getNodes, getEdges, addNodes, addEdges, deleteElements } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const addElementsGlobally = nav?.addElementsGlobally;
  const canvasFilePath = nav?.currentFile || null;
  const processingRef = useRef(false);
  const isMountedRef = useRef(true);
  const { addToast } = useToast();
  useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);
  // Stable ref to startProcessing so handleDrop can call it without a stale closure.
  const startProcessingRef = useRef(null);

  // Per-source progress state: { sourceId: { status, count }, ... }
  const [sourceProgress, setSourceProgress] = useState({});
  const [lastActiveSource, setLastActiveSource] = useState(null);

  const hubState = data.hubState || 'empty';
  const statusLabel = STATE_LABELS[hubState];
  const sourceFilter = data.sourceFilter || null;

  // Listen for per-source progress events from the backend
  useEffect(() => {
    if (!window.electronAPI?.onJobSourceProgress) return;
    const cleanup = window.electronAPI.onJobSourceProgress((payload) => {
      const { nodeId, sourceId, status, count } = payload;

      // Multi-hub safety: ignore events for other hubs
      if (nodeId && nodeId !== id) return;

      setSourceProgress(prev => ({ ...prev, [sourceId]: { status, count } }));
      if (status === 'searching') setLastActiveSource(sourceId);
    });
    return () => cleanup?.();
  }, [id]);

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
      if (hubState === 'error') {
        updateGlobal(id, { hubState: 'empty', errorMessage: null, isRateLimit: false });
      }
    });
    return () => cleanup?.();
  }, [id, hubState, updateGlobal]);

  // Combined card opacity: source AND score AND status filters all applied together.
  // Declared before toggleSourceFilter because toggleSourceFilter references it.
  const applyCardFilters = useCallback(({ sourceFilter: sf, scoreThreshold: st, statusFilters: stf } = {}) => {
    // Fall back to current data values if not passed explicitly
    const activeSrc   = sf  !== undefined ? sf  : (data.sourceFilter || null);
    const activeScore = st  !== undefined ? st  : (data.scoreThreshold || 0);
    const activeStats = stf !== undefined ? stf : (data.statusFilters || []);

    setNodes(nodes => nodes.map(n => {
      if (n.type !== 'jobcard') return n;
      const srcOk    = !activeSrc   || n.data?.source === activeSrc;
      const scoreOk  = !activeScore || (n.data?.matchScore || 0) >= activeScore;
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
  // so it survives saves and applies to re-runs.
  const maxAgeDays = data.maxAgeDays || 14;
  const setMaxAgeDays = useCallback((val) => {
    const n = Math.max(1, Math.min(180, Math.floor(Number(val) || 14)));
    updateGlobal(id, { maxAgeDays: n });
  }, [id, updateGlobal]);

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
    // Lay missing cards out in a 3-column grid to the left of the hub. The
    // user can drag them anywhere afterward — initial placement just keeps
    // them out of the way and visually grouped.
    const COLS = 3;
    const CARD_W = 140, CARD_H = 50, GAP_X = 12, GAP_Y = 12;
    const startOffset = existing.length; // append after any pre-existing cards
    const stamp = Date.now();

    const newNodes = missing.map((source, i) => {
      const idx = startOffset + i;
      const col = idx % COLS;
      const row = Math.floor(idx / COLS);
      return {
        id: `js-${id}-${source.id}-${stamp}`,
        type: 'jobsourcecard',
        position: {
          x: hubPos.x - (COLS * (CARD_W + GAP_X)) - 40 + col * (CARD_W + GAP_X),
          y: hubPos.y + row * (CARD_H + GAP_Y),
        },
        data: {
          sourceId: source.id,
          name:     source.name,
          letter:   source.letter,
          color:    source.color,
          hubId:    id,
        },
      };
    });

    const newEdges = newNodes.map(n => ({
      id: `edge-${id}-${n.id}`,
      source: id,
      target: n.id,
      type: 'smoothstep',
      animated: true,
      style: { stroke: 'rgba(96,165,250,0.5)', strokeWidth: 2 },
    }));

    if (addElementsGlobally) {
      addElementsGlobally(id, newNodes, newEdges, 'sibling');
    } else {
      addNodes(newNodes);
      addEdges(newEdges);
    }
  }, [id, getNode, getNodes, addElementsGlobally, addNodes, addEdges]);

  // Re-apply all filters on mount — opacities are stripped from save files to keep them clean.
  useEffect(() => {
    const hasFilter = data.sourceFilter || (data.scoreThreshold || 0) > 0 || (data.statusFilters || []).length > 0;
    if (!hasFilter) return;
    applyCardFilters({});
  }, [applyCardFilters, data.scoreThreshold, data.sourceFilter, data.statusFilters]);

  /**
   * Drives the full pipeline. Pass `filePath` for a fresh resume parse, or
   * `profile` to skip parsing and re-run from query construction onward.
   * `filePath` takes precedence when both are provided.
   */
  const runPipeline = useCallback(async ({ filePath, profile: providedProfile } = {}) => {
    if (!window.electronAPI || processingRef.current) return;
    if (!filePath && !providedProfile) return;
    processingRef.current = true;
    setSourceProgress({});
    const currentId = id;

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
      const queriesResult = await window.electronAPI.generateJobQueries({ profile, nodeId: currentId });
      if (!queriesResult.success) {
        const err = new Error(queriesResult.error || 'Failed to generate queries');
        if (queriesResult.isRateLimit) err.isRateLimit = true;
        throw err;
      }
      const { titleQueries = [], suggestedRoleQueries = [], skillsOnlyQueries = [] } = queriesResult.queries || {};
      const allQueries = [...titleQueries, ...suggestedRoleQueries, ...skillsOnlyQueries];

      // Step 3: Search
      updateGlobal(currentId, { hubState: 'searching', queryCount: allQueries.length });
      const searchResult = await window.electronAPI.searchJobs({
        queries: allQueries,
        nodeId: currentId,
        maxAgeDays: data.maxAgeDays || 14,
        canvasFilePath,
      });

      if (!searchResult.success || !searchResult.jobs || searchResult.jobs.length === 0) {
        updateGlobal(currentId, { hubState: 'done', resultCount: 0 });
        return;
      }

      // Step 4: Scoring
      updateGlobal(currentId, { hubState: 'scoring', jobCount: searchResult.jobs.length });
      const scoreResult = await window.electronAPI.scoreJobs({ jobs: searchResult.jobs, profile, nodeId: currentId });
      if (!scoreResult.success) {
        const err = new Error(scoreResult.error || 'Failed to score jobs');
        if (scoreResult.isRateLimit) err.isRateLimit = true;
        throw err;
      }

      // Step 5: Spawn job-card nodes adjacent to the hub
      const baseNodeId = `job-${Date.now()}`;
      const newNodes = [];
      const newEdges = [];
      scoreResult.scoredJobs.forEach((job, index) => {
        const jobId = `${baseNodeId}-${index}`;
        newNodes.push({
          id: jobId,
          type: 'jobcard',
          position: { x: originalPos.x + 400, y: originalPos.y + index * 280 },
          data: {
            title: job.title, company: job.company, location: job.location,
            salary: job.salary, snippet: job.snippet, matchScore: job.matchScore,
            reasoning: job.reasoning, careerDirection: job.careerDirection,
            strengthLabel: job.strengthLabel, source: job.source,
            url: job.url, posted: job.posted, resumeProfile: profile, isNew: false,
          },
        });
        newEdges.push({
          id: `edge-${currentId}-${jobId}`,
          source: currentId, target: jobId,
          type: 'smoothstep', animated: true,
          style: { stroke: 'rgba(96,165,250,0.5)', strokeWidth: 2 },
        });
      });

      if (newNodes.length > 0) {
        document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
        if (addElementsGlobally) {
          addElementsGlobally(currentId, newNodes, newEdges, 'sibling');
        } else {
          // Fallback if not inside CanvasNavigationContext (dev/test).
          addNodes(newNodes);
          addEdges(newEdges);
        }
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
        resultCount: scoreResult.scoredJobs.length,
        finalSourceCounts,
        spawnedNodeIds: newNodes.map(n => n.id),
      });
    } catch (error) {
      EventLogger.error('JobHubNode pipeline failed:', error);
      updateGlobal(currentId, { 
        hubState: 'error', 
        errorMessage: error?.message || String(error),
        isRateLimit: !!error?.isRateLimit
      });
    } finally {
      if (isMountedRef.current) processingRef.current = false;
    }
  }, [id, updateGlobal, addElementsGlobally, addNodes, addEdges, getNode, canvasFilePath, data.maxAgeDays, ensureSourceCards]);

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

    const ACCEPTED_RE = /\.(pdf|docx|doc|txt|png|jpe?g|heic|heif)$/i;
    const resume = files.find(f => ACCEPTED_RE.test(f.name));
    if (!resume) {
      if (files.length > 0) {
        EventLogger.log(`[JobHub][${id}] Drop rejected: no supported resume in ${files.length} file(s)`);
        addToast({
          title: 'Unsupported file type',
          description: `Dropped ${files.length} file(s) but none are supported resumes. Accepted: PDF, DOCX, DOC, TXT, PNG, JPG, HEIC, HEIF.`,
          type: 'error',
        });
      }
      return;
    }

    const path = resume.path || (window.electronAPI?.getPathForFile ? window.electronAPI.getPathForFile(resume) : '');
    if (path) {
      EventLogger.log(`[JobHub][${id}] Drop accepted: ${resume.name}`);
      startProcessingRef.current?.(path);
    }
  }, [data.locked, hubState, id, addToast]);

  const resetHandler = useCallback((e) => {
    e?.stopPropagation();
    if (data.locked) return;

    // Actually abort the backend — without this the AbortControllers registered
    // against this nodeId keep running and finish a few seconds later, often
    // bouncing the UI back to a "done" state the user just dismissed.
    window.electronAPI?.cancelNodeTask?.(id);

    updateGlobal(id, { hubState: 'empty', errorMessage: null, isRateLimit: false });
    setSourceProgress({});
    processingRef.current = false;
  }, [data.locked, id, updateGlobal]);

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

    // Remove old connected job cards before re-running. 
    // We check both active edges AND our tracked spawned IDs to ensure orphaned cards are cleaned up.
    const edges = getEdges().filter(e => e.source === id);
    const trackedIds = data.spawnedNodeIds || [];
    const nodesToDelete = [...new Set([...edges.map(e => e.target), ...trackedIds])].map(targetId => ({ id: targetId }));
    const edgesToDelete = edges.map(e => ({ id: e.id }));

    if (nodesToDelete.length > 0 || edgesToDelete.length > 0) {
      deleteElements({ nodes: nodesToDelete, edges: edgesToDelete });
    }

    setSourceProgress({});
    if (data.filePath) {
      // File still accessible — re-parse for freshness then run full pipeline
      startProcessingRef.current?.(data.filePath);
    } else {
      // File gone but profile is persisted — run from query step onward
      addToast({ title: 'Re-running Search', description: 'Using stored resume profile — original file not needed.', type: 'info' });
      startProcessingWithProfile(data.resumeProfile);
    }
  }, [data.locked, data.filePath, data.resumeProfile, data.spawnedNodeIds, id, getEdges, deleteElements, addToast, startProcessingWithProfile]);

  const isProcessing = PROCESSING_STATES.includes(hubState);

  // Compute running total from per-source progress
  const totalSourceJobs = Object.values(sourceProgress).reduce((sum, p) => sum + (p.count || 0), 0);

  return (
    <HubContainer
      hubState={hubState}
      theme="blue"
      width={260}
      height={undefined}
      minHeight={hubState === 'empty' ? 140 : 100}
      onDrop={handleDrop}
    >
        {/* Empty state — drop zone */}
        {hubState === 'empty' && (
          <div className="flex flex-col items-center justify-center py-8 px-4 cursor-pointer">
            <Briefcase size={28} className="text-blue-400/40 mb-3" />
            <p className="text-white/40 text-sm font-medium">Drop resume here</p>
            <p className="text-white/20 text-[10px] mt-1">PDF, DOCX, or image</p>
            <div
              className="nodrag mt-4 flex items-center gap-1.5 text-[10px] text-white/40"
              onPointerDown={(e) => e.stopPropagation()}
            >
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

        {/* Done state */}
        {hubState === 'done' && (
          <JobHubDoneState
            resultCount={data.resultCount}
            sourceFilter={sourceFilter}
            toggleSourceFilter={toggleSourceFilter}
            resumeSummary={data.resumeSummary}
            locked={!!data.locked}
            scoreThreshold={data.scoreThreshold || 0}
            setScoreThreshold={setScoreThreshold}
            statusFilters={data.statusFilters || []}
            toggleStatusFilter={toggleStatusFilter}
            onRerun={handleRerun}
            jobCards={connectedJobCards}
            maxAgeDays={maxAgeDays}
            setMaxAgeDays={setMaxAgeDays}
            onCheckAllStatuses={handleCheckAllStatuses}
            checkingAll={checkingAllStatuses}
          />
        )}

        {/* Error state */}
        {hubState === 'error' && (
          <div className="absolute inset-0 bg-red-900/50 flex flex-col items-center justify-center p-4 text-center rounded-2xl z-20 backdrop-blur-sm shadow-[inset_0_2px_15px_rgba(255,0,0,0.2)]">
            <div className="bg-red-900/80 p-3 rounded-full mb-3 shadow-[0_0_15px_rgba(255,0,0,0.5)]">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-200">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
            </div>
            <p className="text-white font-medium text-lg tracking-wide">
              {data.isRateLimit ? 'Usage Limit Reached' : 'Processing Failed'}
            </p>
            <p className="text-red-200 text-xs mt-2 opacity-90 max-w-full truncate px-2">{data.errorMessage}</p>
            <div className="flex gap-2 mt-5">
              {data.isRateLimit && (
                <button 
                  className="px-4 py-1.5 bg-blue-500/20 hover:bg-blue-500/40 text-blue-100 text-xs rounded-full border border-blue-500/30 transition-all font-medium backdrop-blur-md shadow-[0_2px_8px_rgba(0,0,0,0.3)] hover:shadow-[0_0_12px_rgba(59,130,246,0.4)]"
                  onClick={data.locked ? undefined : () => {
                    document.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'ai' } }));
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  Change Model
                </button>
              )}
              <button 
                className="px-4 py-1.5 bg-red-500/20 hover:bg-red-500/40 text-red-100 text-xs rounded-full border border-red-500/30 transition-all font-medium backdrop-blur-md shadow-[0_2px_8px_rgba(0,0,0,0.3)] hover:shadow-[0_0_12px_rgba(255,0,0,0.4)]"
                onClick={data.locked ? undefined : () => { 
                  updateGlobal(id, { errorMessage: null, isRateLimit: false }); 
                  setSourceProgress({}); 
                  if (data.filePath || data.resumeProfile) {
                    handleRerun();
                  } else {
                    updateGlobal(id, { hubState: 'empty' });
                  }
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                Try Again
              </button>
            </div>
          </div>
        )}
      </HubContainer>
  );
}
