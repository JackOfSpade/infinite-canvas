import React, { useState, useRef, useEffect, useCallback, useContext } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { AnimatedSourceRing } from '../components/AnimatedSourceRing';
import { HubContainer } from '../components/HubContainer';
import { Briefcase } from 'lucide-react';
import { JOB_SOURCES, ACTIVE_JOB_SOURCES } from '../utils/constants';
import { EventLogger } from '../utils/EventLogger';

import { JobHubProcessingState } from './jobhub/JobHubProcessingState';
import { JobHubDoneState } from './jobhub/JobHubDoneState';

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
  const { updateNodeData, setNodes, addEdges, addNodes, getNode } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const addElementsGlobally = nav?.addElementsGlobally;
  const processingRef = useRef(false);
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

  // Source statuses with live text for the animated ring
  const getSourceStatuses = useCallback(() => {
    return JOB_SOURCES.map(s => {
      if (!ACTIVE_JOB_SOURCES.includes(s.id)) return { ...s, status: 'idle' };

      // Pre-search states — all sources move together
      if (hubState === 'parsing') {
        return { ...s, status: 'active', statusText: 'Reading resume...', hoverText: 'Extracting skills, titles, and experience from your resume' };
      }
      if (hubState === 'querying') {
        return { ...s, status: 'active', statusText: 'Building queries...', hoverText: 'AI generating title-based, role-pivot, and skills-only search queries' };
      }

      // During search — use per-source progress
      if (hubState === 'searching') {
        const progress = sourceProgress[s.id];
        if (!progress) return { ...s, status: 'active', statusText: 'Waiting...', hoverText: `Queued for search on ${s.name}` };

        if (progress.status === 'searching') {
          return { ...s, status: 'active', statusText: `Searching...`, hoverText: `Scanning ${s.name} for matching jobs` };
        }
        if (progress.status === 'done') {
          return {
            ...s, status: 'done',
            statusText: `${progress.count} found`,
            hoverText: `${progress.count} jobs found on ${s.name}. Click to filter.`,
            onClick: () => toggleSourceFilter(s.id),
          };
        }
        if (progress.status === 'error') {
          return { ...s, status: 'error', statusText: 'Failed', hoverText: `${s.name} returned no results (may be blocked)` };
        }
        return { ...s, status: 'active', statusText: 'Searching...', hoverText: `Scanning ${s.name}` };
      }

      // Scoring — all sources show scoring state
      if (hubState === 'scoring') {
        const progress = sourceProgress[s.id];
        if (progress?.status === 'error') {
          return { ...s, status: 'error', statusText: 'Failed', hoverText: `${s.name} returned no results` };
        }
        return { ...s, status: 'active', statusText: `Scoring...`, hoverText: `AI analyzing jobs from ${s.name}` };
      }

      // Done — show per-source counts with click filtering
      if (hubState === 'done') {
        const fallbackCount = data.finalSourceCounts?.[s.id] || 0;
        const progress = sourceProgress[s.id];
        if (progress?.status === 'error') {
          return { ...s, status: 'error', statusText: 'Failed', hoverText: `${s.name} was blocked or returned no results` };
        }
        const count = progress?.count || fallbackCount;
        const isFiltered = sourceFilter === s.id;
        return {
          ...s,
          status: count > 0 ? 'done' : 'error',
          statusText: isFiltered ? `✦ ${count} shown` : `${count} found`,
          hoverText: `${count} jobs from ${s.name}. Click to ${isFiltered ? 'show all' : 'filter'}.`,
          onClick: () => toggleSourceFilter(s.id),
        };
      }

      if (hubState === 'error') {
        return { ...s, status: 'error', statusText: 'Failed', hoverText: data.errorMessage || 'Search encountered an error' };
      }
      return { ...s, status: 'idle' };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubState, sourceProgress, data.resultCount, data.errorMessage, sourceFilter, data.finalSourceCounts]);

  // Source click-through filtering
  const toggleSourceFilter = useCallback((sourceId) => {
    const newFilter = sourceFilter === sourceId ? null : sourceId;
    updateGlobal(id, { sourceFilter: newFilter });

    // Dim/undim JobCard nodes based on source filter
    // Note: opacity changes are transient (stripped before saves by sanitizeNodesForSave)
    setNodes(nodes => nodes.map(n => {
      if (n.type !== 'jobcard') return n;
      if (!newFilter) {
        return { ...n, style: { ...n.style, opacity: 1 } };
      }
      return { ...n, style: { ...n.style, opacity: n.data?.source === newFilter ? 1 : 0.2 } };
    }));
  }, [sourceFilter, id, updateGlobal, setNodes]);

  // Re-apply source filter dim on mount — in case the filter was persisted
  // but the opacity was stripped from the save file (which prevents stale opacity on reload).
  useEffect(() => {
    if (!sourceFilter) return;
    setNodes(nodes => nodes.map(n => {
      if (n.type !== 'jobcard') return n;
      return { ...n, style: { ...n.style, opacity: n.data?.source === sourceFilter ? 1 : 0.2 } };
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally runs once on mount only

  // Auto-start or Re-sync on mount
  useEffect(() => {
    // 1. Auto-start if drop-created
    if (data.filePath && hubState === 'empty' && !processingRef.current) {
      startProcessing(data.filePath);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startProcessing = useCallback(async (filePath) => {
    if (!window.electronAPI || processingRef.current) return;
    processingRef.current = true;
    setSourceProgress({});
    const currentId = id;

    try {
      // Step 1: Parse resume
      updateGlobal(currentId, { hubState: 'parsing' });
      const parseResult = await window.electronAPI.parseResume({ filePath, nodeId: currentId });
      
      // Allow processing to finish even if unmounted or node deleted!
      if (!parseResult.success) {
        throw new Error(parseResult.error || 'Failed to parse resume');
      }

      // Step 2: Query construction
      updateGlobal(currentId, {
        hubState: 'querying',
        resumeContext: {
          skills: parseResult.profile.skills,
          experience: parseResult.profile.experience_years,
        }
      });
      
      const queriesResult = await window.electronAPI.generateJobQueries({ 
        profile: parseResult.profile,
        nodeId: currentId 
      });
      
      // Flatten all query arrays into a single list for the search step.
      const { titleQueries = [], suggestedRoleQueries = [], skillsOnlyQueries = [] } = queriesResult.queries || {};
      const allQueries = [...titleQueries, ...suggestedRoleQueries, ...skillsOnlyQueries];

      // Step 3: Search
      updateGlobal(currentId, { hubState: 'searching', queryCount: allQueries.length });
      
      const searchResult = await window.electronAPI.searchJobs({ queries: allQueries, nodeId: currentId });
      
      if (!searchResult.success || !searchResult.jobs || searchResult.jobs.length === 0) {
        updateGlobal(currentId, { hubState: 'done', resultCount: 0 });
        processingRef.current = false;
        return;
      }

      // Step 4: Scraping & Scoring
      updateGlobal(currentId, { hubState: 'scoring', jobCount: searchResult.jobs.length });
      
      const scoreResult = await window.electronAPI.scoreJobs({ jobs: searchResult.jobs, profile: parseResult.profile, nodeId: currentId });
      
      if (!scoreResult.success) {
        throw new Error(scoreResult.error || 'Failed to score jobs');
      }

      // Step 5: Spawn career direction clusters
      const hubNode = getNode(id);
      const hubx = hubNode?.position?.x ?? 0;
      const huby = hubNode?.position?.y ?? 0;
      
      const newNodes = [];
      const newEdges = [];
      let currentYOffset = 0;
      const baseNodeId = `job-${Date.now()}`;

      scoreResult.scoredJobs.forEach((job, index) => {
        const jobId = `${baseNodeId}-${index}`;
        
        newNodes.push({
          id: jobId,
          type: 'jobcard',
          position: { x: hubx + 400, y: huby + currentYOffset },
          data: {
            title: job.job_title,
            company: job.company_name,
            location: job.location,
            score: job.match_score,
            source: job.source,
            matchReason: job.match_reason,
            url: job.job_url,
            isNew: false
          }
        });

        newEdges.push({
          id: `edge-${currentId}-${jobId}`,
          source: currentId,
          target: jobId,
          type: 'smoothstep',
          animated: true,
          style: { stroke: 'rgba(96,165,250,0.5)', strokeWidth: 2 }
        });

        currentYOffset += 280;
      });

      if (newNodes.length > 0) {
        document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
        if (addElementsGlobally) {
          addElementsGlobally(currentId, newNodes, newEdges, 'sibling');
        } else {
          // Fallback if not inside CanvasNavigationContext (e.g., dev/test environment)
          addNodes(newNodes);
          addEdges(newEdges);
        }
      }

      const finalSourceCounts = {};
      scoreResult.scoredJobs.forEach(job => {
        finalSourceCounts[job.source] = (finalSourceCounts[job.source] || 0) + 1;
      });

      updateGlobal(id, { 
        hubState: 'done', 
        resultCount: scoreResult.scoredJobs.length,
        finalSourceCounts 
      });
    } catch (error) {
      EventLogger.error('JobHubNode task failed:', error);
      updateGlobal(id, { hubState: 'error', errorMessage: error?.message || String(error) });
    } finally {
      processingRef.current = false;
    }
  }, [id, updateGlobal, addElementsGlobally, addNodes, addEdges]);

  // Keep the ref up-to-date so handleDrop always calls the latest version.
  startProcessingRef.current = startProcessing;

  // Handle file drops directly onto this node
  const handleDrop = useCallback((e) => {
    if (data.locked) return;
    if (PROCESSING_STATES.includes(hubState)) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const files = Array.from(e.dataTransfer?.files || []);
    const resume = files.find(f => f.name.match(/\.(pdf|docx|doc|txt|png|jpg|jpeg)$/i));
    if (resume) {
      const path = resume.path || (window.electronAPI?.getPathForFile ? window.electronAPI.getPathForFile(resume) : '');
      if (path) startProcessingRef.current?.(path);
    }
  }, [data.locked, hubState]);

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
      extras={
        <AnimatedSourceRing
          sources={getSourceStatuses()}
          nodeId={id}
          direction="in"
          radius={140}
        />
      }
    >
        {/* Empty state — drop zone */}
        {hubState === 'empty' && (
          <div className="flex flex-col items-center justify-center py-8 px-4 cursor-pointer">
            <Briefcase size={28} className="text-blue-400/40 mb-3" />
            <p className="text-white/40 text-sm font-medium">Drop resume here</p>
            <p className="text-white/20 text-[10px] mt-1">PDF, DOCX, or image</p>
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
            <p className="text-white font-medium text-lg tracking-wide">Processing Failed</p>
            <p className="text-red-200 text-xs mt-2 opacity-90 max-w-full truncate px-2">{data.errorMessage}</p>
            <button 
              className="mt-5 px-4 py-1.5 bg-red-500/20 hover:bg-red-500/40 text-red-100 text-xs rounded-full border border-red-500/30 transition-all font-medium backdrop-blur-md shadow-[0_2px_8px_rgba(0,0,0,0.3)] hover:shadow-[0_0_12px_rgba(255,0,0,0.4)]"
              onClick={data.locked ? undefined : () => { updateGlobal(id, { hubState: 'empty', errorMessage: null }); setSourceProgress({}); }}
            >
              Try Again
            </button>
          </div>
        )}
      </HubContainer>
  );
}
