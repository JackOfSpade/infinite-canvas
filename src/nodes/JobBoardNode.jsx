import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { LayoutGrid, Plug, Briefcase, Combine as CombineIcon } from 'lucide-react';

import { HubContainer } from '../components/HubContainer';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { useToast } from '../components/ToastProvider';
import { useUnmountEffect } from '../hooks/useUnmountEffect';
import { useEpochCancellation } from '../hooks/useEpochCancellation';
import { EventLogger } from '../utils/EventLogger';
import { buildJobTreeNodes, computeJobTreeView } from './jobsearch/buildJobTree';
import { deleteChildrenByHubId } from './_shared/hubChildCleanup';
import { unionScoredJobs, moduleFingerprint, combineSignature, staleReason, isLegacyCombineSignature } from './jobboard/mergeJobs';
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
  const canvasFilePath = nav?.currentFile || null;
  const { addToast } = useToast();
  const epoch = useEpochCancellation();

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
          // Fingerprint (not just length) so re-running a module — same count,
          // different jobs/scores — registers as changed data, not a no-op.
          parts.push(`${nid}:${moduleFingerprint(n.data?.scoredJobs)}:${n.data?.hubState || ''}`);
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
        fingerprint: moduleFingerprint(n.data?.scoredJobs),
        hubState: n.data?.hubState || 'empty',
      }));
    // connectedSig is the real reactive trigger; getEdges/getNodes are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedSig, id]);

  // Keep every terminal source in the staleness signature, INCLUDING a source
  // that just completed with zero jobs. Otherwise a genuine empty re-run looks
  // indistinguishable from disconnecting that source, and the board cannot
  // explain or safely replace its old cascade. Only positive-result modules
  // contribute jobs to the actual merge.
  const completedModules = useMemo(
    () => connectedModules.filter((m) => m.hubState === 'done'),
    [connectedModules],
  );
  const readyModules = useMemo(
    () => completedModules.filter((m) => m.count > 0),
    [completedModules],
  );
  const allConnectedModulesDone = connectedModules.length > 0 && completedModules.length === connectedModules.length;
  const totalIncoming = readyModules.reduce((sum, m) => sum + m.count, 0);

  // Signature of every terminal module (id + data fingerprint). Compared against
  // the signature captured at the last Combine to tell whether the cached board
  // is still valid, including a terminal zero-result re-run.
  const liveSignature = useMemo(
    () => combineSignature(completedModules),
    [completedModules],
  );
  const stale = hubState === 'done' && !!data.stale;
  const staleReasonText = useMemo(
    () => (stale ? (data.staleReason || staleReason(data.combineSignature, completedModules, connectedModules)) : ''),
    [stale, data.staleReason, data.combineSignature, completedModules, connectedModules]
  );
  const canReplaceWithEmpty = stale && allConnectedModulesDone && readyModules.length === 0;

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
    EventLogger.log(`[JobBoard] source filter ${newFilter || 'cleared'} id=${id}`);
  }, [data.sourceFilter, id, updateGlobal, applyCardFilters]);

  const setScoreThreshold = useCallback((val) => {
    updateGlobal(id, { scoreThreshold: val });
    applyCardFilters({ scoreThreshold: val });
    EventLogger.log(`[JobBoard] score filter ≥${val}% id=${id}`);
  }, [id, updateGlobal, applyCardFilters]);

  // Re-apply filters on mount — card opacities are stripped from save files.
  useEffect(() => {
    if (data.stale) return; // stale → cascade is hidden; don't reveal it here
    const min = data.scoreRangeMin ?? 0;
    const hasFilter = data.sourceFilter || (data.scoreThreshold ?? min) > min;
    if (!hasFilter) return;
    applyCardFilters({});
  }, [applyCardFilters, data.scoreThreshold, data.scoreRangeMin, data.sourceFilter, data.stale]);

  // Hide every spawned card/group (results "disappear") without touching their
  // expand/collapse state, so the exact view can be restored later.
  const hideBoardChildren = useCallback(() => {
    setNodes((nodes) => {
      let changed = false;
      const next = nodes.map((n) => {
        if ((n.type === 'jobcard' || n.type === 'jobgroup') && n.data?.hubId === id && !n.hidden) {
          changed = true;
          return { ...n, hidden: true };
        }
        return n;
      });
      return changed ? next : nodes;
    });
  }, [id, setNodes]);

  // Re-reveal the cascade exactly as it was: computeJobTreeView derives `hidden`
  // from each group's preserved `data.expanded` × the active filter, so the prior
  // expand/collapse + filter view comes back intact.
  const showBoardChildren = useCallback(() => {
    setNodes((nodes) => computeJobTreeView(nodes, id, {
      sourceFilter: data.sourceFilter || null,
      scoreThreshold: data.scoreThreshold ?? 0,
    }));
  }, [id, setNodes, data.sourceFilter, data.scoreThreshold]);

  // Detect connection/data drift vs. the last Combine. A deleted connection (or a
  // re-run, or a newly added module) makes the cached board stale → hide results +
  // prompt re-combine. Restoring the exact connections+data (e.g. re-adding the
  // same edge with unchanged jobs) clears staleness → results reappear, no
  // re-combine or LLM call needed. Old boards (no stored signature) adopt the
  // current connections as their baseline instead of falsely going stale.
  useEffect(() => {
    if (hubState !== 'done' || data.locked) return; // locked = frozen snapshot
    // No stored signature (pre-staleness boards) OR a signature in the legacy
    // pre-versioned fingerprint format (its math can't be compared against
    // live fingerprints) → adopt the current connections as the baseline
    // instead of falsely going stale.
    if (data.combineSignature == null || isLegacyCombineSignature(data.combineSignature)) {
      updateGlobal(id, { combineSignature: liveSignature, stale: false, staleReason: null });
      return;
    }
    const nextStale = liveSignature !== data.combineSignature;
    const nextStaleReason = nextStale ? staleReason(data.combineSignature, completedModules, connectedModules) : null;
    if (nextStale === !!data.stale) {
      // A stale marker can be persisted independently from a child `hidden`
      // update (or arrive from an older file). Reconcile it on mount too. The
      // helper returns the original nodes array when every child is already
      // hidden, so this is idempotent and does not churn the canvas store.
      if (nextStale) hideBoardChildren();
      // A re-run first leaves `done`, then returns to it. Keep the persisted
      // reason current when that terminal result arrives (especially zero),
      // rather than preserving an earlier transient "updating" label.
      if (nextStale && data.staleReason !== nextStaleReason) {
        updateGlobal(id, { staleReason: nextStaleReason });
        EventLogger.log(`[JobBoard] stale inputs updated id=${id} reason=${nextStaleReason}`);
      }
      return;
    }
    updateGlobal(id, { stale: nextStale, staleReason: nextStaleReason });
    if (nextStale) {
      hideBoardChildren();
      // Do not read staleReasonText here: state has not yet committed, so that
      // render intentionally sees stale=false and would log a blank reason.
      EventLogger.log(`[JobBoard] results hidden as stale id=${id} reason=${nextStaleReason}`);
    } else {
      showBoardChildren();
      EventLogger.log(`[JobBoard] results restored after stale state cleared id=${id}`);
    }
  }, [hubState, data.locked, liveSignature, data.combineSignature, data.stale, data.staleReason, completedModules, connectedModules, id, updateGlobal, hideBoardChildren, showBoardChildren]);

  // Cascade-delete the board's spawned cards/groups (re-combine, clear, unmount).
  const clearBoardChildren = useCallback(() => {
    deleteChildrenByHubId({ getNodes, getEdges, deleteElements, hubId: id, childTypes: ['jobcard', 'jobgroup'] });
  }, [id, getNodes, getEdges, deleteElements]);

  const cleanupBoard = useCallback(() => {
    epoch.bump();
    window.electronAPI?.cancelNodeTask?.(id);
    clearBoardChildren();
  }, [clearBoardChildren, epoch, id]);

  useUnmountEffect(cleanupBoard);

  const handleClear = useCallback(() => {
    epoch.bump();
    window.electronAPI?.cancelNodeTask?.(id);
    setCombining(false);
    document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
    clearBoardChildren();
    updateGlobal(id, {
      hubState: 'empty',
      resultCount: 0, moduleCount: 0,
      scoreThreshold: 0, scoreRangeMin: 0, scoreRangeMax: 100,
      sourceFilter: null, jobTaxonomy: null, finalSourceCounts: {}, mergeStats: null,
      combineSignature: null, stale: false, staleReason: null,
    });
    EventLogger.log(`[JobBoard] cleared id=${id}`);
  }, [id, clearBoardChildren, updateGlobal, epoch]);

  const handleCombine = useCallback(async () => {
    if (combining) return;
    if (readyModules.length === 0 && allConnectedModulesDone) {
      // A source may legitimately complete with no matching/new jobs. Replace
      // the hidden previous cascade with a truthful empty board instead of
      // trapping the user behind a Re-combine button that cannot act.
      document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
      clearBoardChildren();
      const perModule = completedModules.map((m) => ({ label: m.label, count: m.count }));
      updateGlobal(id, {
        hubState: 'done', resultCount: 0, moduleCount: completedModules.length,
        scoreThreshold: 0, scoreRangeMin: 0, scoreRangeMax: 100,
        sourceFilter: null, jobTaxonomy: null, finalSourceCounts: {},
        mergeStats: {
          totalIncoming: 0, unique: 0, duplicatesRemoved: 0,
          collisions: 0, collisionUpgrades: 0, modules: completedModules.length, perModule,
        },
        combineSignature: combineSignature(completedModules), stale: false, staleReason: null,
      });
      EventLogger.log(`[JobBoard] replaced stale results with empty completed inputs id=${id} modules=${completedModules.length}`);
      addToast({ title: 'Board updated', description: 'The completed searches have no current jobs; old results were cleared.', type: 'info' });
      return;
    }
    if (readyModules.length === 0) {
      addToast({ title: 'Nothing to combine', description: 'Connect Job Search Modules that have finished scoring, then try again.', type: 'error' });
      return;
    }
    setCombining(true);
    const cancelled = epoch.start();
    try {
      // Capture the input signature NOW so a connection change mid-combine is
      // correctly detected as stale afterwards (matches the live-signature math).
      const sigAtCombine = combineSignature(completedModules);
      // Gather each positive-result module's scored jobs, tagging each with its ORIGIN
      // module id so a merged card's "Generate Résumé" reads career data from
      // the right search module (a string per card, not a deep résumé copy —
      // the old per-job resumeProfile clone persisted N identical profile
      // objects into the canvas file and was read by nothing).
      const byId = new Map(getNodes().map((n) => [n.id, n]));
      const jobArrays = readyModules.map((m) => {
        const n = byId.get(m.id);
        return (Array.isArray(n?.data?.scoredJobs) ? n.data.scoredJobs : [])
          .map((j) => ({ ...j, originHubId: j.originHubId || m.id }));
      });
      const mergeStats = {};
      const union = unionScoredJobs(jobArrays, mergeStats);
      const perModule = completedModules.map((m) => ({ label: m.label, count: m.count }));
      EventLogger.log(`[JobBoard] combine started id=${id} signature=${sigAtCombine} incoming=${union.length}`);
      EventLogger.log(
        `[JobBoard] Combined ${completedModules.length} completed module(s): ` +
        `${perModule.map((p) => p.count).join('+')}=${mergeStats.totalIncoming} → ` +
        `${mergeStats.unique} unique (${mergeStats.duplicatesRemoved} dup removed, ` +
        `${mergeStats.collisionUpgrades} score-upgrade(s))`
      );
      if (union.length === 0) {
        addToast({ title: 'No jobs to combine', description: 'The connected modules have no scored jobs.', type: 'error' });
        return;
      }

      // Re-bucket over the union. Ship only the projection the taxonomy needs
      // (the handler strips to exactly these fields anyway) — the full union
      // carries snippets/reasoning and used to serialize hundreds of KB over
      // IPC for nothing. Index alignment with `union` is what matters.
      let bucketTree = null;
      try {
        const compactJobs = union.map((j) => ({
          careerDirection: j.careerDirection || '',
          matchScore: typeof j.matchScore === 'number' ? j.matchScore : 0,
          salary: j.salary || '',
          title: j.title || '',
          source: j.source || '',
        }));
        const res = await window.electronAPI.bucketJobs({ jobs: compactJobs, nodeId: id });
        if (cancelled() || !getNode(id)) {
          EventLogger.log(`[JobBoard] combine cancelled before spawn id=${id}`);
          return;
        }
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
        if (cancelled() || !getNode(id)) return;
        EventLogger.error('[JobBoard] Bucketing failed — flat spawn:', err);
      }

      if (cancelled() || !getNode(id)) return;

      const originalPos = getNode(id)?.position || { x: 0, y: 0 };
      const baseNodeId = `board-${id}-${Date.now()}`;
      const { newNodes, newEdges, scoreRangeMin, scoreRangeMax } = buildJobTreeNodes({
        displayedJobs: union,
        bucketTree,
        originalPos,
        hubId: id,
        baseNodeId,
      });

      // Replace the prior combine only now that the new cascade is BUILT — the
      // clear used to run before the multi-second bucketing await, so any
      // failure in that window left a board claiming "N unique jobs" over an
      // empty canvas. Clearing and adding back-to-back (no await between)
      // closes that orphan window: a throw above leaves the old board intact.
      clearBoardChildren();
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
        moduleCount: completedModules.length,
        scoreRangeMin,
        scoreRangeMax,
        scoreThreshold: scoreRangeMin,
        sourceFilter: null,
        jobTaxonomy: bucketTree ? { likelihoodBands: bucketTree.likelihoodBands, salaryRanges: bucketTree.salaryRanges } : null,
        finalSourceCounts,
        // Merge provenance for the bug report — the dedup is otherwise invisible.
        mergeStats: { ...mergeStats, modules: completedModules.length, perModule },
        // Baseline for staleness detection (connection/data drift vs. this combine).
        combineSignature: sigAtCombine, stale: false, staleReason: null,
      });

      // A scored job becomes "seen" only after this Combine/Re-combine has
      // completed and displayed its cards. Search/scoring completion — even
      // while connected to this board — is intentionally not enough.
      if (newNodes.length > 0 && canvasFilePath) {
        const historyRows = union.map((j) => ({
          source: j.source, company: j.company, title: j.title, location: j.location, url: j.url,
        }));
        const historyResult = await window.electronAPI?.appendJobsHistory?.({
          canvasFilePath, jobs: historyRows, nodeId: id, historyStage: 'boardDisplay',
        });
        if (!historyResult?.success || historyResult?.error) {
          EventLogger.error('[JobBoard] Displayed-results history append failed:', historyResult?.error || 'unknown error');
        }
      }
      EventLogger.log(`[JobBoard] combine completed id=${id} signature=${sigAtCombine} results=${union.length} children=${newNodes.length}`);
    } catch (err) {
      if (cancelled() || !getNode(id)) return;
      EventLogger.error('[JobBoard] Combine failed:', err);
      addToast({ title: 'Combine failed', description: err?.message || String(err), type: 'error' });
    } finally {
      if (!cancelled() && getNode(id)) setCombining(false);
    }
  }, [combining, completedModules, readyModules, allConnectedModulesDone, getNodes, getNode, id, clearBoardChildren, addElementsGlobally, addNodes, addEdges, fitView, updateGlobal, addToast, epoch, canvasFilePath]);

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
          totalIncoming={data.mergeStats?.totalIncoming || 0}
          duplicatesRemoved={data.mergeStats?.duplicatesRemoved || 0}
          stale={stale}
          staleReason={staleReasonText}
          canReplaceWithEmpty={canReplaceWithEmpty}
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
