import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, useStore } from '@xyflow/react';
import { LayoutGrid, Plug, Briefcase, Combine as CombineIcon } from 'lucide-react';

import { HubContainer } from '../components/HubContainer';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { useToast } from '../components/ToastProvider';
import { useUnmountEffect } from '../hooks/useUnmountEffect';
import { useEpochCancellation } from '../hooks/useEpochCancellation';
import { EventLogger } from '../utils/EventLogger';
import { hubCardFilter } from '../utils/jobCardFilters';
import { buildJobTreeNodes, computeJobTreeView } from './jobsearch/buildJobTree';
import { deleteChildrenByHubId } from './_shared/hubChildCleanup';
import { attachCompensationRemoteResidences, unionScoredJobs, moduleFingerprint, combineSignature, normalizeJobMatchScore, staleReason, isLegacyCombineSignature, emptyReplacementIneligibilityReason } from './jobboard/mergeJobs';
import { JobBoardDoneState } from './jobboard/JobBoardDoneState';
import { isLegacyUnbucketedJobBoard, validateJobBoardTaxonomy } from '../utils/jobBoardAiProvider';

function createManualAiRunId(nodeId) {
  const entropy = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `job-board:${nodeId}:${entropy}`;
}

// Human label for a connected Job Search Module, from its search params.
function moduleLabel(d) {
  const loc = String(d?.preferredLocation || d?.canonicalLocation || '').trim();
  const role = String(d?.targetRole || '').trim();
  return [role, loc].filter(Boolean).join(' · ') || 'Job Search';
}

// A collection-only/test run deliberately finishes in the normal `done` state
// with no `scoredJobs`: it has gathered listings but did not produce mergeable
// hiring-fit results. It must never masquerade as a truthful scored-empty re-run
// and authorize replacement of an existing board cascade.
function isExplicitlyUnscoredModule(data) {
  return !!(data?.aiSkipped || data?.collectionOnly || data?.testMode);
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
  // `setCombining(true)` is not synchronous. A rapid double click (or an
  // imperative duplicate call before React has rendered) would otherwise let
  // two combines start from the same stale closure, race their LLM work, and
  // let the later settlement replace the other cascade. Keep the active run
  // token in a ref so the admission check takes effect within this call stack.
  const combineRunRef = useRef(null);
  // Progress events need a request-level identity too. Node ids alone cannot
  // distinguish a newly started Combine from an older cancelled IPC call that
  // is still unwinding and emitting its final progress events.
  const compensationRequestIdRef = useRef(null);
  const compensationRequestSequenceRef = useRef(0);
  // The compensation stage begins only after global taxonomy validation. Its
  // progress uses the same main-process event as a Job Search node, but the
  // node id below keeps concurrent boards/searches completely isolated.
  const [compensationProgress, setCompensationProgress] = useState(null);
  const [emptyReplacementPrompt, setEmptyReplacementPrompt] = useState(null);

  useEffect(() => {
    if (!window.electronAPI?.onCompensationProgress) return undefined;
    return window.electronAPI.onCompensationProgress((payload) => {
      // Board work is always scoped. Do not accept legacy/unscoped events here:
      // an unrelated search's progress is worse than no cosmetic indicator.
      const activeRequestId = compensationRequestIdRef.current;
      if (!activeRequestId || payload?.nodeId !== id || payload?.requestId !== activeRequestId) return;
      setCompensationProgress({ processed: payload.processed ?? 0, total: payload.total ?? 0 });
    });
  }, [id]);

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
          // Include scoring provenance too. A collection-only completion has the
          // same empty array/state shape as a real zero-result search, but it is
          // not safe to use as a replacement input for an existing board.
          parts.push(`${nid}:${moduleFingerprint(n.data?.scoredJobs)}:${n.data?.hubState || ''}:${n.data?.aiSkipped ? 1 : 0}:${n.data?.collectionOnly ? 1 : 0}:${n.data?.testMode ? 1 : 0}:${n.data?.resultDisposition || ''}`);
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
        aiSkipped: !!n.data?.aiSkipped,
        collectionOnly: !!n.data?.collectionOnly,
        testMode: !!n.data?.testMode,
        isScored: !isExplicitlyUnscoredModule(n.data),
        resultDisposition: n.data?.resultDisposition || null,
      }));
    // connectedSig is the real reactive trigger; getEdges/getNodes are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedSig, id]);

  // Positive scored jobs always remain mergeable, even from an older canvas
  // that predates resultDisposition. A zero-result module is mergeable only
  // when Job Search explicitly marked it `empty-complete`; recovery/error
  // branches can also end in `done` with an empty array but must never erase a
  // board. Collection-only/test completions are likewise never empty inputs.
  const mergeableModules = useMemo(
    () => connectedModules.map((m) => ({
      ...m,
      hasPositiveResults: m.count > 0,
      isAuthoritativeEmpty: m.isScored && m.resultDisposition === 'empty-complete',
    })),
    [connectedModules],
  );

  // Keep every valid terminal input in the staleness signature, INCLUDING a
  // genuinely completed zero-result re-run. Only positive-result modules
  // contribute jobs to the actual merge.
  const completedModules = useMemo(
    () => mergeableModules.filter((m) => m.hubState === 'done' && (m.hasPositiveResults || m.isAuthoritativeEmpty)),
    [mergeableModules],
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
  const emptyReplacementBlockReason = emptyReplacementIneligibilityReason({
    stale,
    allConnectedModulesDone,
    readyModuleCount: readyModules.length,
  });
  const canReplaceWithEmpty = emptyReplacementBlockReason === null;

  // ── Cascade filters (score slider + per-source), scoped to THIS board's cards.
  // computeJobTreeView REMOVES non-matching cards and any branch with no matching
  // descendant (vs. just dimming) and reflows, composing with expand/collapse.
  const applyCardFilters = useCallback(({ sourceFilter: sf, scoreThreshold: st } = {}) => {
    const base = hubCardFilter({ sourceFilter: data.sourceFilter, scoreThreshold: data.scoreThreshold });
    const filter = {
      sourceFilter: sf !== undefined ? sf : base.sourceFilter,
      scoreThreshold: st !== undefined ? st : base.scoreThreshold,
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
    EventLogger.log(`[JobBoard] hiring-fit filter ≥${val}/100 id=${id}`);
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
    setNodes((nodes) => computeJobTreeView(nodes, id, hubCardFilter({ sourceFilter: data.sourceFilter, scoreThreshold: data.scoreThreshold })));
  }, [id, setNodes, data.sourceFilter, data.scoreThreshold]);

  // Detect connection/data drift vs. the last Combine. A deleted connection (or a
  // re-run, or a newly added module) makes the cached board stale → hide results +
  // prompt re-combine. Restoring the exact connections+data (e.g. re-adding the
  // same edge with unchanged jobs) clears staleness → results reappear, no
  // re-combine or LLM call needed. Old boards (no stored signature) adopt the
  // current connections as their baseline instead of falsely going stale.
  useEffect(() => {
    if (hubState !== 'done' || data.locked) return; // locked = frozen snapshot
    // A released flat-board build persisted direct cards with no taxonomy.
    // They were never successfully bucketed, so hide them after upgrade and
    // require one successful API-backed Re-combine to restore board results.
    // (Locked boards remain historical snapshots by design.)
    if (isLegacyUnbucketedJobBoard(data, getNodes(), id)) {
      const legacyReason = 'This legacy board was never taxonomized — re-combine successfully to restore results';
      hideBoardChildren();
      if (!data.stale || data.staleReason !== legacyReason) {
        updateGlobal(id, { stale: true, staleReason: legacyReason });
        EventLogger.log(`[JobBoard] hid legacy unbucketed results id=${id}`);
      }
      return;
    }
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
  }, [hubState, data, data.locked, liveSignature, data.combineSignature, data.stale, data.staleReason, completedModules, connectedModules, id, getNodes, updateGlobal, hideBoardChildren, showBoardChildren]);

  // Cascade-delete the board's spawned cards/groups (re-combine, clear, unmount).
  const clearBoardChildren = useCallback(() => {
    deleteChildrenByHubId({ getNodes, getEdges, deleteElements, hubId: id, childTypes: ['jobcard', 'jobgroup'] });
  }, [id, getNodes, getEdges, deleteElements]);

  const requestEmptyReplacement = useCallback(() => {
    const owned = getNodes().filter((node) =>
      (node.type === 'jobcard' || node.type === 'jobgroup') && node.data?.hubId === id
    );
    const resultCardCount = owned.filter((node) => node.type === 'jobcard').length;
    const resultGroupCount = owned.filter((node) => node.type === 'jobgroup').length;
    setEmptyReplacementPrompt({ resultCardCount, resultGroupCount });
    EventLogger.log(`[JobBoard] empty replacement confirmation requested id=${id} cards=${resultCardCount} groups=${resultGroupCount}`);
  }, [getNodes, id]);

  const cancelEmptyReplacement = useCallback(() => {
    const prompt = emptyReplacementPrompt;
    EventLogger.log(`[JobBoard] empty replacement cancelled id=${id} cards=${prompt?.resultCardCount ?? 0} groups=${prompt?.resultGroupCount ?? 0}`);
    setEmptyReplacementPrompt(null);
  }, [emptyReplacementPrompt, id]);

  const confirmEmptyReplacement = useCallback(() => {
    setEmptyReplacementPrompt(null);
    // The input state may have changed while the confirmation was open. Never
    // delete the prior cascade unless every connected module is still a genuine
    // scored terminal zero-result input.
    if (!canReplaceWithEmpty) {
      EventLogger.log(`[JobBoard] empty replacement confirmation ignored id=${id} reason=${emptyReplacementBlockReason}`);
      return;
    }
    document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
    clearBoardChildren();
    const perModule = completedModules.map((m) => ({ label: m.label, count: m.count }));
    updateGlobal(id, {
      hubState: 'done', resultCount: 0, moduleCount: completedModules.length,
      scoreThreshold: 0, scoreRangeMin: 0, scoreRangeMax: 100,
      sourceFilter: null, jobTaxonomy: null, finalSourceCounts: {},
      mergeStats: {
        totalIncoming: 0, unique: 0, duplicatesRemoved: 0,
        collisions: 0, collisionUpgrades: 0, collisionAssessmentUpgrades: 0, modules: completedModules.length, perModule,
      },
      combineSignature: combineSignature(completedModules), stale: false, staleReason: null,
    });
    EventLogger.log(`[JobBoard] confirmed empty replacement id=${id} modules=${completedModules.length}`);
    addToast({ title: 'Board updated', description: 'The completed searches have no current jobs; old results were cleared. Undo restores them.', type: 'info' });
  }, [addToast, canReplaceWithEmpty, emptyReplacementBlockReason, clearBoardChildren, completedModules, id, updateGlobal]);

  const cleanupBoard = useCallback(() => {
    epoch.bump();
    combineRunRef.current = null;
    compensationRequestIdRef.current = null;
    window.electronAPI?.cancelNodeTask?.(id);
    clearBoardChildren();
  }, [clearBoardChildren, epoch, id]);

  useUnmountEffect(cleanupBoard);

  const handleClear = useCallback(() => {
    epoch.bump();
    combineRunRef.current = null;
    compensationRequestIdRef.current = null;
    window.electronAPI?.cancelNodeTask?.(id);
    setCombining(false);
    setCompensationProgress(null);
    document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
    clearBoardChildren();
    updateGlobal(id, {
      hubState: 'empty',
      resultCount: 0, moduleCount: 0,
      scoreThreshold: 0, scoreRangeMin: 0, scoreRangeMax: 100,
      sourceFilter: null, jobTaxonomy: null, finalSourceCounts: {}, mergeStats: null,
      combineSignature: null, stale: false, staleReason: null,
      manualAiResume: null,
    });
    EventLogger.log(`[JobBoard] cleared id=${id}`);
  }, [id, clearBoardChildren, updateGlobal, epoch]);

  const completeManualAiRun = useCallback((runId) => {
    if (!runId) return;
    if (getNode(id)?.data?.manualAiResume?.runId === runId) {
      updateGlobal(id, { manualAiResume: null });
    }
    void window.electronAPI?.completeNonApiAiRun?.(runId).catch(() => {});
  }, [getNode, id, updateGlobal]);

  const handleCombine = useCallback(async (options = {}) => {
    // State alone cannot make this atomic: React applies setState after the
    // handler returns, so two calls in one event turn both see combining=false.
    if (combineRunRef.current) return;
    if (readyModules.length === 0 && allConnectedModulesDone) {
      // A source may legitimately complete with no matching/new jobs. Replace
      // the hidden previous cascade only after an explicit confirmation. The
      // prompt makes the affected board-owned node count visible and defaults to
      // retaining the stale results.
      if (canReplaceWithEmpty) {
        requestEmptyReplacement();
      } else {
        addToast({
          title: 'Board already current',
          description: 'The completed searches have no jobs and this board already reflects that result.',
          type: 'info',
        });
      }
      return;
    }
    if (readyModules.length === 0) {
      addToast({ title: 'Nothing to combine', description: 'Connect Job Search Modules that have finished scoring, then try again.', type: 'error' });
      return;
    }
    const combineToken = Symbol('job-board-combine');
    // UUID makes this safe across an unmount/remount of the same board id;
    // the counter keeps the fallback unique within one mounted component.
    const entropy = globalThis.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${++compensationRequestSequenceRef.current}-${Math.random().toString(36).slice(2)}`;
    const compensationRequestId = `board-compensation:${id}:${entropy}`;
    const manualAiRunId = options?.manualAiRunId || createManualAiRunId(id);
    combineRunRef.current = combineToken;
    compensationRequestIdRef.current = compensationRequestId;
    setCombining(true);
    setCompensationProgress(null);
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
      let union = unionScoredJobs(jobArrays, mergeStats);
      const perModule = completedModules.map((m) => ({ label: m.label, count: m.count }));
      EventLogger.log(`[JobBoard] combine started id=${id} signature=${sigAtCombine} incoming=${union.length}`);
      EventLogger.log(
        `[JobBoard] Combined ${completedModules.length} completed module(s): ` +
        `${perModule.map((p) => p.count).join('+')}=${mergeStats.totalIncoming} → ` +
        `${mergeStats.unique} unique (${mergeStats.duplicatesRemoved} dup removed, ` +
        `${mergeStats.collisionUpgrades} score-upgrade(s), ` +
        `${mergeStats.collisionAssessmentUpgrades} assessment-upgrade(s))`
      );
      if (union.length === 0) {
        addToast({ title: 'No jobs to combine', description: 'The connected modules have no scored jobs.', type: 'error' });
        return;
      }

      // Re-bucket over the union. Ship only the projection the taxonomy needs
      // (the handler strips to exactly these fields anyway) — the full union
      // carries snippets/reasoning and used to serialize hundreds of KB over
      // IPC for nothing. Index alignment with `union` is what matters.
      let bucketTree;
      try {
        const compactJobs = union.map((j) => ({
          careerDirection: j.careerDirection || '',
          matchScore: normalizeJobMatchScore(j.matchScore),
          salary: j.salary || '',
          title: j.title || '',
          source: j.source || '',
        }));
        const res = await window.electronAPI.bucketJobs({ jobs: compactJobs, nodeId: id, manualAiRunId });
        if (cancelled() || !getNode(id)) {
          EventLogger.log(`[JobBoard] combine cancelled before spawn id=${id}`);
          return;
        }
        if (!res?.success) {
          const error = new Error(res?.error || 'Job Board taxonomy generation failed.');
          error.code = res?.errorCode;
          throw error;
        }
        bucketTree = {
          likelihoodBands: res.likelihoodBands,
          salaryRanges: res.salaryRanges,
          roles: res.roles,
        };
        const taxonomyCheck = validateJobBoardTaxonomy(bucketTree, union.length);
        if (!taxonomyCheck.valid) throw new Error(`Job Board taxonomy was invalid: ${taxonomyCheck.reason}`);
      } catch (err) {
        if (cancelled() || !getNode(id)) return;
        // Do not replace the existing board when its required taxonomy could
        // not be generated. Clearing only happens after this whole try block.
        EventLogger.error('[JobBoard] Bucketing failed; preserving prior board:', err);
        throw err;
      }

      if (cancelled() || !getNode(id)) return;

      // Compensation has to run while `union` still carries the scorer-only
      // context (especially compensationContext). Job cards intentionally do
      // not persist that internal prompt material, so researching after spawn
      // would fragment or skip the cohort work. The main-process cache makes a
      // repeat Combine reuse unchanged cohorts when the provider supports it.
      try {
        const remoteResidencesByOrigin = Object.fromEntries(readyModules.map((module) => {
          const sourceData = byId.get(module.id)?.data || {};
          return [module.id, sourceData.locationSnapshot?.remoteResidences || sourceData.remoteResidences || {}];
        }));
        // Keep this transient routing input on the full union rather than
        // choosing one module's residence for every remote listing. The card
        // builder's explicit whitelist omits it after research is complete.
        union = attachCompensationRemoteResidences(union, remoteResidencesByOrigin);
        const compensationResult = await window.electronAPI?.researchJobCompensation?.({
          jobs: union,
          nodeId: id,
          requestId: compensationRequestId,
          manualAiRunId,
        });
        if (cancelled() || !getNode(id)) {
          EventLogger.log(`[JobBoard] combine cancelled during compensation research id=${id}`);
          return;
        }
        if (!compensationResult?.success || !Array.isArray(compensationResult.jobs)) {
          const error = new Error(compensationResult?.error || 'Job Board compensation research failed.');
          error.code = compensationResult?.errorCode;
          throw error;
        }
        union = compensationResult.jobs;
      } catch (err) {
        if (cancelled() || !getNode(id)) return;
        // Like failed taxonomy, a failed research invocation must leave the
        // previously displayed board intact rather than replacing it with a
        // partial set of cards.
        EventLogger.error('[JobBoard] Compensation research failed; preserving prior board:', err);
        throw err;
      }

      const originalPos = getNode(id)?.position || { x: 0, y: 0 };
      const baseNodeId = `board-${id}-${Date.now()}`;
      const { newNodes, newEdges, scoreRangeMin, scoreRangeMax, taxonomy } = buildJobTreeNodes({
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
        // Only a validated API taxonomy reaches this point, so diagnostics and
        // reload state describe the hierarchy the provider actually generated.
        jobTaxonomy: { likelihoodBands: taxonomy.likelihoodBands, salaryRanges: taxonomy.salaryRanges },
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
      completeManualAiRun(manualAiRunId);
    } catch (err) {
      if (cancelled() || !getNode(id)) return;
      EventLogger.error('[JobBoard] Combine failed:', err);
      addToast({ title: 'Combine failed', description: err?.message || String(err), type: 'error' });
    } finally {
      // Clear only the run that acquired this token. A Clear/unmount releases
      // the lock synchronously; a late former run must never unlock, clear
      // progress, or otherwise alter a newer Combine.
      if (combineRunRef.current === combineToken) {
        combineRunRef.current = null;
        compensationRequestIdRef.current = null;
        setCompensationProgress(null);
        if (!cancelled() && getNode(id)) setCombining(false);
      }
    }
  }, [completedModules, readyModules, allConnectedModulesDone, canReplaceWithEmpty, getNodes, getNode, id, clearBoardChildren, requestEmptyReplacement, addElementsGlobally, addNodes, addEdges, fitView, updateGlobal, addToast, epoch, canvasFilePath, completeManualAiRun]);

  useEffect(() => {
    const onManualAiNodeCancelled = (event) => {
      if (event.detail?.nodeId !== id) return;
      updateGlobal(id, { manualAiResume: null });
    };
    document.addEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled);
    return () => document.removeEventListener('non-api-ai-node-cancelled', onManualAiNodeCancelled);
  }, [id, updateGlobal]);

  useEffect(() => {
    const onPending = (event) => {
      const detail = event.detail || {};
      if (detail.nodeId !== id || !detail.runId) return;
      updateGlobal(id, {
        manualAiResume: {
          runId: detail.runId,
          task: detail.task || null,
          stepKey: detail.stepKey || null,
          recoveryMode: detail.recoveryMode || null,
          updatedAt: Date.now(),
        },
      });
    };
    document.addEventListener('non-api-ai-node-pending', onPending);
    return () => {
      document.removeEventListener('non-api-ai-node-pending', onPending);
    };
  }, [id, updateGlobal]);

  const autoResumedManualAiRunRef = useRef(null);
  useEffect(() => {
    const resume = data.manualAiResume;
    if (!resume?.runId || autoResumedManualAiRunRef.current === resume.runId) return;
    if (!canvasFilePath) return;
    if (combineRunRef.current || data.locked || readyModules.length === 0) return;
    autoResumedManualAiRunRef.current = resume.runId;
    EventLogger.log(`[JobBoard] Auto-resuming manual AI run id=${id} task=${resume.task || 'pending step'}`);
    void handleCombine({ manualAiRunId: resume.runId });
  }, [canvasFilePath, data.manualAiResume, data.locked, handleCombine, id, readyModules.length]);

  return (
    <>
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

      {combining && compensationProgress?.total > 0 && (
        <p className="px-3 pb-2 text-center text-blue-300/70 text-[10px]">
          Researching pay for {compensationProgress.processed} / {compensationProgress.total} jobs…
        </p>
      )}

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

      {emptyReplacementPrompt && (
        <ConfirmDialog
          title="Clear stale board results?"
          message={`The completed scored searches have no current jobs. This will remove ${emptyReplacementPrompt.resultCardCount} board-owned result card${emptyReplacementPrompt.resultCardCount === 1 ? '' : 's'} and ${emptyReplacementPrompt.resultGroupCount} board-owned group${emptyReplacementPrompt.resultGroupCount === 1 ? '' : 's'}. Undo restores them.`}
          confirmLabel="Clear stale results"
          cancelLabel="Keep stale results"
          variant="warning"
          onConfirm={confirmEmptyReplacement}
          onCancel={cancelEmptyReplacement}
        />
      )}
    </>
  );
});
