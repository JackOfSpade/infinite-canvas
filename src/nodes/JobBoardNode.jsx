import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { LayoutGrid, Plug, Briefcase, Combine as CombineIcon } from 'lucide-react';

import { HubContainer } from '../components/HubContainer';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { useToast } from '../components/ToastProvider';
import { useUnmountEffect } from '../hooks/useUnmountEffect';
import { EventLogger } from '../utils/EventLogger';
import { buildJobTreeNodes, computeJobTreeView } from './jobsearch/buildJobTree';
import { deleteChildrenByHubId } from './_shared/hubChildCleanup';
import { unionScoredJobs } from './jobboard/mergeJobs';
import { JobBoardDoneState } from './jobboard/JobBoardDoneState';

// Human label for a connected Job Search Module, from its search params.
function moduleLabel(d) {
  const loc = String(d?.preferredLocation || d?.canonicalLocation?.display || '').trim();
  const role = String(d?.targetRole || '').trim();
  return [role, loc].filter(Boolean).join(' · ') || 'Job Search';
}

/**
 * Job Board Module — the display + merge half of the job pipeline. It owns no
 * scraping or scoring: you connect one or more Job Search Modules to it with the
 * normal edge connectors, then Combine. It unions every connected module's stored
 * `scoredJobs`, re-runs the (cheap) AI bucketing over the union, and spawns the
 * SAME band→salary→role→cards cascade the search module used to spawn — only now
 * spanning all connected searches. See buildJobTree.js (hubId-agnostic).
 */
export const JobBoardNode = React.memo(function JobBoardNode({ id, data }) {
  const { updateNodeData, setNodes, getNode, getNodes, getEdges, addNodes, addEdges, deleteElements, fitView } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const addElementsGlobally = nav?.addElementsGlobally;
  const { addToast } = useToast();

  const hubState = data.hubState || 'empty';
  const [combining, setCombining] = useState(false);

  // Reactively track which Job Search Modules are wired into this board (either
  // edge direction — ConnectionMode.Loose). Returns a STRING signature so the
  // selector is stable (re-renders only when a connection or a module's job count
  // changes), then we derive the rich list via getNodes() keyed on that.
  const connectedSig = useStore(
    useCallback((s) => {
      const ids = new Set();
      s.edges.forEach((e) => {
        if (e.source === id) ids.add(e.target);
        else if (e.target === id) ids.add(e.source);
      });
      const parts = [];
      ids.forEach((nid) => {
        const n = s.nodeLookup.get(nid);
        if (n && n.type === 'jobhub') {
          parts.push(`${nid}:${n.data?.scoredJobs?.length || 0}:${n.data?.hubState || ''}`);
        }
      });
      parts.sort();
      return parts.join('|');
    }, [id])
  );

  const connectedModules = useMemo(() => {
    const edges = getEdges();
    const nodeIds = new Set();
    edges.forEach((e) => {
      if (e.source === id) nodeIds.add(e.target);
      else if (e.target === id) nodeIds.add(e.source);
    });
    return getNodes()
      .filter((n) => nodeIds.has(n.id) && n.type === 'jobhub')
      .map((n) => ({
        id: n.id,
        label: moduleLabel(n.data),
        count: Array.isArray(n.data?.scoredJobs) ? n.data.scoredJobs.length : 0,
        hubState: n.data?.hubState || 'empty',
      }));
    // connectedSig is the real reactive trigger; getEdges/getNodes are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedSig, id]);

  const readyModules = connectedModules.filter((m) => m.count > 0);
  const totalIncoming = readyModules.reduce((sum, m) => sum + m.count, 0);

  // ── Cascade filters (score slider + per-source), scoped to THIS board's cards.
  // computeJobTreeView REMOVES non-matching cards and any branch with no matching
  // descendant (vs. just dimming) and reflows, composing with expand/collapse.
  const applyCardFilters = useCallback(({ sourceFilter: sf, scoreThreshold: st } = {}) => {
    const filter = {
      sourceFilter: sf !== undefined ? sf : (data.sourceFilter || null),
      scoreThreshold: st !== undefined ? st : (data.scoreThreshold ?? 0),
    };
    setNodes((nodes) => computeJobTreeView(nodes, id, filter));
  }, [data.sourceFilter, data.scoreThreshold, id, setNodes]);

  const toggleSourceFilter = useCallback((sourceId) => {
    const newFilter = (data.sourceFilter || null) === sourceId ? null : sourceId;
    updateGlobal(id, { sourceFilter: newFilter });
    applyCardFilters({ sourceFilter: newFilter });
  }, [data.sourceFilter, id, updateGlobal, applyCardFilters]);

  const setScoreThreshold = useCallback((val) => {
    updateGlobal(id, { scoreThreshold: val });
    applyCardFilters({ scoreThreshold: val });
  }, [id, updateGlobal, applyCardFilters]);

  // Re-apply filters on mount — card opacities are stripped from save files.
  useEffect(() => {
    const min = data.scoreRangeMin ?? 0;
    const hasFilter = data.sourceFilter || (data.scoreThreshold ?? min) > min;
    if (!hasFilter) return;
    applyCardFilters({});
  }, [applyCardFilters, data.scoreThreshold, data.scoreRangeMin, data.sourceFilter]);

  // Cascade-delete the board's spawned cards/groups (re-combine, clear, unmount).
  const clearBoardChildren = useCallback(() => {
    deleteChildrenByHubId({ getNodes, getEdges, deleteElements, hubId: id, childTypes: ['jobcard', 'jobgroup'] });
  }, [id, getNodes, getEdges, deleteElements]);

  useUnmountEffect(clearBoardChildren);

  const handleClear = useCallback(() => {
    document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
    clearBoardChildren();
    updateGlobal(id, {
      hubState: 'empty',
      resultCount: 0, moduleCount: 0,
      scoreThreshold: 0, scoreRangeMin: 0, scoreRangeMax: 100,
      sourceFilter: null, jobTaxonomy: null, finalSourceCounts: {},
    });
  }, [id, clearBoardChildren, updateGlobal]);

  const handleCombine = useCallback(async () => {
    if (combining) return;
    if (readyModules.length === 0) {
      addToast({ title: 'Nothing to combine', description: 'Connect Job Search Modules that have finished scoring, then try again.', type: 'error' });
      return;
    }
    setCombining(true);
    try {
      // Gather each ready module's scored jobs, tagging each with its module's
      // résumé so a merged card's "Generate Résumé" uses the right origin.
      const byId = new Map(getNodes().map((n) => [n.id, n]));
      const jobArrays = readyModules.map((m) => {
        const n = byId.get(m.id);
        const profile = n?.data?.resumeProfile || null;
        return (Array.isArray(n?.data?.scoredJobs) ? n.data.scoredJobs : [])
          .map((j) => ({ ...j, resumeProfile: j.resumeProfile || profile }));
      });
      const union = unionScoredJobs(jobArrays);
      if (union.length === 0) {
        addToast({ title: 'No jobs to combine', description: 'The connected modules have no scored jobs.', type: 'error' });
        return;
      }

      // Replace any prior combine before rebuilding.
      clearBoardChildren();

      // Re-bucket over the union (compact, cheap LLM call — titles/salary only).
      let bucketTree = null;
      try {
        const res = await window.electronAPI.bucketJobs({ jobs: union, nodeId: id });
        if (res?.success && Array.isArray(res.roles)) {
          bucketTree = {
            likelihoodBands: res.likelihoodBands || [],
            salaryRanges: res.salaryRanges || [],
            roles: res.roles || [],
          };
        } else {
          EventLogger.error('[JobBoard] Bucketing returned no taxonomy — flat spawn');
        }
      } catch (err) {
        EventLogger.error('[JobBoard] Bucketing failed — flat spawn:', err);
      }

      const originalPos = getNode(id)?.position || { x: 0, y: 0 };
      const baseNodeId = `board-${id}-${Date.now()}`;
      const { newNodes, newEdges, scoreRangeMin, scoreRangeMax } = buildJobTreeNodes({
        displayedJobs: union,
        bucketTree,
        profile: null, // each job carries its own resumeProfile
        originalPos,
        hubId: id,
        baseNodeId,
      });

      if (newNodes.length > 0) {
        document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
        if (addElementsGlobally) addElementsGlobally(id, newNodes, newEdges, 'sibling');
        else { addNodes(newNodes); addEdges(newEdges); }
        requestAnimationFrame(() => fitView({ duration: 600, padding: 0.2 }));
      }

      const finalSourceCounts = {};
      union.forEach((j) => { finalSourceCounts[j.source] = (finalSourceCounts[j.source] || 0) + 1; });

      updateGlobal(id, {
        hubState: 'done',
        resultCount: union.length,
        moduleCount: readyModules.length,
        scoreRangeMin,
        scoreRangeMax,
        scoreThreshold: scoreRangeMin,
        sourceFilter: null,
        jobTaxonomy: bucketTree ? { likelihoodBands: bucketTree.likelihoodBands, salaryRanges: bucketTree.salaryRanges } : null,
        finalSourceCounts,
      });
    } catch (err) {
      EventLogger.error('[JobBoard] Combine failed:', err);
      addToast({ title: 'Combine failed', description: err?.message || String(err), type: 'error' });
    } finally {
      setCombining(false);
    }
  }, [combining, readyModules, getNodes, getNode, id, clearBoardChildren, addElementsGlobally, addNodes, addEdges, fitView, updateGlobal, addToast]);

  return (
    <HubContainer hubState={hubState} theme="blue" width={260} minHeight={hubState === 'empty' ? 150 : 100} dropsBlocked>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <div className="w-7 h-7 rounded-lg bg-indigo-500/15 flex items-center justify-center shrink-0">
          <LayoutGrid size={15} className="text-indigo-300/80" />
        </div>
        <div className="min-w-0">
          <p className="text-white/80 text-xs font-semibold leading-tight">Job Board</p>
          <p className="text-white/30 text-[9px] leading-tight">Merge connected searches</p>
        </div>
      </div>

      {hubState === 'empty' && (
        <div className="flex flex-col items-stretch px-3 pb-4 gap-2">
          {connectedModules.length === 0 ? (
            <div className="flex flex-col items-center text-center gap-1.5 py-3">
              <Plug size={18} className="text-white/20" />
              <p className="text-white/40 text-[11px] leading-relaxed">
                Connect one or more <span className="text-white/60">Job Search Modules</span> to this board, then Combine.
              </p>
              <p className="text-white/20 text-[9px]">Drag a line from each search module's handle to this board.</p>
            </div>
          ) : (
            <>
              <p className="text-white/35 text-[9px] uppercase tracking-wider px-0.5">Connected ({connectedModules.length})</p>
              <div className="flex flex-col gap-1 max-h-44 overflow-y-auto nodrag" onPointerDown={(e) => e.stopPropagation()}>
                {connectedModules.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 px-2 py-1 rounded-md bg-white/5 border border-white/5">
                    <Briefcase size={11} className="text-blue-400/50 shrink-0" />
                    <span className="flex-1 min-w-0 truncate text-white/60 text-[10px]" title={m.label}>{m.label}</span>
                    {m.count > 0 ? (
                      <span className="text-emerald-400/80 text-[10px] font-medium shrink-0">{m.count}</span>
                    ) : (
                      <span className="text-white/25 text-[9px] shrink-0">{m.hubState === 'done' ? '0' : '…'}</span>
                    )}
                  </div>
                ))}
              </div>
              <button
                onClick={handleCombine}
                onPointerDown={(e) => e.stopPropagation()}
                disabled={combining || readyModules.length === 0}
                className="nodrag mt-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/20 text-indigo-200 hover:bg-indigo-500/30 disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-medium transition-colors border border-indigo-500/20"
                title={readyModules.length === 0 ? 'Connected modules have no scored jobs yet' : 'Merge all connected searches into one ranked board'}
              >
                <CombineIcon size={12} className={combining ? 'animate-spin' : ''} />
                {combining ? 'Combining…' : `Combine ${readyModules.length || ''} (${totalIncoming} jobs)`.replace('  ', ' ')}
              </button>
            </>
          )}
        </div>
      )}

      {hubState === 'done' && (
        <JobBoardDoneState
          resultCount={data.resultCount}
          moduleCount={data.moduleCount}
          locked={!!data.locked}
          scoreThreshold={data.scoreThreshold ?? (data.scoreRangeMin ?? 0)}
          setScoreThreshold={setScoreThreshold}
          scoreRangeMin={data.scoreRangeMin ?? 0}
          scoreRangeMax={data.scoreRangeMax ?? 100}
          sourceFilter={data.sourceFilter || null}
          toggleSourceFilter={toggleSourceFilter}
          sourceCounts={data.finalSourceCounts || {}}
          onRecombine={handleCombine}
          onClear={handleClear}
          combining={combining}
        />
      )}
    </HubContainer>
  );
});
