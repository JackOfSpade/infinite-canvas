import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { AnimatedSourceRing } from '../components/AnimatedSourceRing';
import { HubContainer } from '../components/HubContainer';
import { Briefcase, Loader2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { JOB_SOURCES, ACTIVE_JOB_SOURCES } from '../utils/constants';
import { useToast } from '../components/ToastProvider';
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
  const { updateNodeData, addNodes, getNodes, setNodes } = useReactFlow();
  const { addToast } = useToast();
  const processingRef = useRef(false);
  const cleanupRef = useRef(null);

  // Per-source progress state: { google: { status, count }, indeed: { status, count }, ... }
  const [sourceProgress, setSourceProgress] = useState({});

  const hubState = data.hubState || 'empty';
  const statusLabel = STATE_LABELS[hubState];
  const sourceFilter = data.sourceFilter || null;

  // Listen for per-source progress events from the backend
  useEffect(() => {
    if (!window.electronAPI?.onJobSourceProgress) return;
    const cleanup = window.electronAPI.onJobSourceProgress(({ sourceId, status, count }) => {
      setSourceProgress(prev => ({ ...prev, [sourceId]: { status, count } }));
    });
     
    cleanupRef.current = cleanup;
    return () => cleanup?.();
  }, []);

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
        const progress = sourceProgress[s.id];
        if (progress?.status === 'error') {
          return { ...s, status: 'error', statusText: 'Failed', hoverText: `${s.name} was blocked or returned no results` };
        }
        const count = progress?.count || 0;
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
  }, [hubState, sourceProgress, data.resultCount, data.errorMessage, sourceFilter]);

  // Source click-through filtering
  const toggleSourceFilter = useCallback((sourceId) => {
    const newFilter = sourceFilter === sourceId ? null : sourceId;
    updateNodeData(id, { sourceFilter: newFilter });

    // Dim/undim JobCard nodes based on source filter
    setNodes(nodes => nodes.map(n => {
      if (n.type !== 'jobcard') return n;
      if (!newFilter) {
        return { ...n, style: { ...n.style, opacity: 1 } };
      }
      return { ...n, style: { ...n.style, opacity: n.data?.source === newFilter ? 1 : 0.2 } };
    }));
  }, [sourceFilter, id, updateNodeData, setNodes]);

  // Auto-start if filePath was provided (canvas-level drop created this node)
  useEffect(() => {
    if (data.filePath && hubState === 'empty' && !processingRef.current) {
      startProcessing(data.filePath);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startProcessing = async (filePath) => {
    if (!window.electronAPI || processingRef.current) return;
    processingRef.current = true;
    setSourceProgress({});

    try {
      // Step 1: Parse resume
      updateNodeData(id, { hubState: 'parsing' });
      const parseResult = await window.electronAPI.parseResume({ filePath });
      if (!parseResult.success) throw new Error(parseResult.error);
      const profile = parseResult.profile;

      updateNodeData(id, {
        hubState: 'querying',
        resumeSummary: profile.summary || profile.titles?.join(', ') || 'Resume parsed',
      });

      // Step 2: Generate queries
      const queryResult = await window.electronAPI.generateJobQueries({ profile });
      if (!queryResult.success) throw new Error(queryResult.error);
      const { titleQueries = [], suggestedRoleQueries = [], skillsOnlyQueries = [] } = queryResult.queries;
      const allQueries = [...titleQueries, ...suggestedRoleQueries, ...skillsOnlyQueries];

      // Step 3: Search (multi-source — backend sends per-source progress events)
      updateNodeData(id, { hubState: 'searching', queryCount: allQueries.length });
      const searchResult = await window.electronAPI.searchJobs({ queries: allQueries });
      if (!searchResult.success) throw new Error(searchResult.error);

      if (searchResult.jobs.length === 0) {
        updateNodeData(id, { hubState: 'done', resultCount: 0 });
        processingRef.current = false;
        return;
      }

      // Step 4: Score
      updateNodeData(id, { hubState: 'scoring', jobCount: searchResult.jobs.length });
      const scoreResult = await window.electronAPI.scoreJobs({ jobs: searchResult.jobs, profile });
      if (!scoreResult.success) throw new Error(scoreResult.error);

      // Step 5: Spawn career direction clusters
      const { clusters } = scoreResult;
      const hubNodes = getNodes();
      const hubNode = hubNodes.find(n => n.id === id);
      const hubX = hubNode?.position?.x || 0;
      const hubY = hubNode?.position?.y || 0;

      const newNodes = [];
      const clusterEntries = Object.entries(clusters);

      clusterEntries.forEach(([direction, jobs], clusterIdx) => {
        const angle = (clusterIdx / clusterEntries.length) * 2 * Math.PI - Math.PI / 2;
        const clusterRadius = 400;
        const gx = hubX + Math.cos(angle) * clusterRadius;
        const gy = hubY + Math.sin(angle) * clusterRadius;

        const groupId = uuidv4();
        const groupNodes = [];

        jobs.forEach((job, jobIdx) => {
          groupNodes.push({
            id: uuidv4(),
            type: 'jobcard',
            position: {
              x: 20 + (jobIdx % 3) * 290,
              y: 60 + Math.floor(jobIdx / 3) * 200,
            },
            data: { ...job, status: 'New', resumeProfile: profile },
          });
        });

        newNodes.push({
          id: groupId,
          type: 'group',
          position: { x: gx, y: gy },
          style: { width: Math.max(340, Math.min(jobs.length * 290, 900)), height: 130 },
          data: {
            title: `${direction} (${jobs.length})`,
            canvasData: { nodes: groupNodes, edges: [], drawings: [] },
          },
        });
      });

      addNodes(newNodes);
      updateNodeData(id, { hubState: 'done', resultCount: scoreResult.scoredJobs.length });
      addToast({ title: 'Job Search Complete', description: `Found and scored ${scoreResult.scoredJobs.length} jobs.`, type: 'success' });
    } catch (error) {
      console.error('[JobHub] Failed:', error);
      updateNodeData(id, { hubState: 'error', errorMessage: error.message });
      addToast({ title: 'Job Search Failed', description: error.message, type: 'error' });
    } finally {
      processingRef.current = false;
    }
  };

  // Handle file drops directly onto this node
  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (data.locked) return; // Locked nodes don't accept new drops
    const files = Array.from(e.dataTransfer?.files || []);
    const resume = files.find(f => f.name.match(/\.(pdf|docx|doc|txt|png|jpg|jpeg)$/i));
    if (resume?.path) startProcessing(resume.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.locked]);

  const isProcessing = ['parsing', 'querying', 'searching', 'scoring'].includes(hubState);

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
          direction="in"
          nodeWidth={260}
          nodeHeight={hubState === 'empty' ? 140 : 100}
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
          />
        )}

        {/* Done state */}
        {hubState === 'done' && (
          <JobHubDoneState 
            resultCount={data.resultCount}
            sourceFilter={sourceFilter}
            toggleSourceFilter={toggleSourceFilter}
            resumeSummary={data.resumeSummary}
          />
        )}

        {/* Error state */}
        {hubState === 'error' && (
          <div className="flex flex-col items-center justify-center py-6 px-4">
            <p className="text-red-400 text-xs font-medium mb-1">Search failed</p>
            <p className="text-white/30 text-[10px] text-center">{data.errorMessage}</p>
            <button
              onClick={data.locked ? undefined : () => { updateNodeData(id, { hubState: 'empty', errorMessage: null }); setSourceProgress({}); }}
              disabled={!!data.locked}
              className={`mt-2 px-3 py-1 rounded text-[10px] transition-colors ${data.locked ? 'bg-white/5 text-white/20 cursor-default' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Try again
            </button>
          </div>
        )}
      </HubContainer>
  );
}
