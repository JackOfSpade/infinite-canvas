import React, { useRef, useEffect, useCallback, useContext } from 'react';
import { useReactFlow } from '@xyflow/react';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';
import { HubContainer } from '../components/HubContainer';
import { Briefcase } from 'lucide-react';
import { JOB_SOURCES, ACTIVE_JOB_SOURCES } from '../utils/constants';
import { radialRadius, fitViewDuration } from '../utils/layoutGeometry';
import { EventLogger } from '../utils/EventLogger';
import { useToast } from '../components/ToastProvider';

import { JobHubProcessingState } from './jobhub/JobHubProcessingState';
import { JobHubDoneState } from './jobhub/JobHubDoneState';
import { JobHubSourcesReadyState } from './jobhub/JobHubSourcesReadyState';
import { HubErrorBanner } from '../components/HubErrorBanner';
import { useCheckAllConnected } from '../hooks/useCheckAllConnected';
import { useUnmountEffect } from '../hooks/useUnmountEffect';
import { useEpochCancellation, isNodeDeletedAbort } from '../hooks/useEpochCancellation';
import { useSourceProgress } from '../hooks/useSourceProgress';
import { pickEdgeHandles, structuralEdge } from './_shared/edgeHelpers';
import { deleteChildrenByHubId } from './_shared/hubChildCleanup';
import {
  partitionJobsForBranches,
  buildJobsForBucketing,
  buildJobTreeNodes,
  LIKELY_THRESHOLD,
} from './jobhub/buildJobTree';

// "Other Strong Matches" cutoff for the append path. Prefer the per-hub gate
// persisted by the initial run (data.strongMatchGate) so appended jobs bucket
// the same way; fall back to the absolute bar for hubs created before the gate
// was persisted.
const otherStrongGate = (storedGate) => storedGate ?? LIKELY_THRESHOLD;

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
  'sources-ready': null,
  done: null,
};

const PROCESSING_STATES = ['parsing', 'querying', 'searching', 'scoring'];

// Monitor-status codes (set by "Check All Statuses") that mean the posting is
// no longer open — eligible for "Clear closed". 'expired' is the back-compat
// alias for 'ended'. 'needs-login' / 'error' are excluded: those mean we
// couldn't determine status, not that the job is gone.
const CLOSED_MONITOR_STATUSES = ['sold', 'ended', 'expired'];

const COL_X_WITH_TARGET    = { branch: 400, category: 700, bucket: 1000, job: 1400 };
const COL_X_WITHOUT_TARGET = { category: 400, bucket: 700, job: 1100 };
const ROW_H = { branch: 90, category: 70, bucket: 70, job: 280 };

function parseSalaryToNumeric(salaryStr) {
  if (!salaryStr) return 0;
  const clean = salaryStr.toLowerCase().replace(/[$,]/g, '');
  const m = clean.match(/(\d+)\s*(k)?/);
  if (!m) return 0;
  let val = parseFloat(m[1]);
  if (m[2] === 'k') val *= 1000;
  if (val < 1000) {
    if (clean.includes('hour') || clean.includes('hr')) {
      val = val * 40 * 52;
    } else if (clean.includes('day')) {
      val = val * 5 * 52;
    }
  }
  return val;
}

/**
 * JobHubNode — draggable canvas module for job search.
 * Phase 2: Per-source independent status tracking + source filtering.
 *
 * data.hubState: 'empty' | 'parsing' | 'querying' | 'searching' | 'scoring' |
 *                'sources-ready' | 'done'
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
export function JobHubNode({ id, data }) {

  // id is stable for this component's lifetime — ReactFlow never reuses
  // instances with different ids, so we can safely close over it in callbacks.
  const { updateNodeData, setNodes, getNode, getNodes, getEdges, addNodes, addEdges, deleteElements, fitView } = useReactFlow();
  const nav = useContext(CanvasNavigationContext);
  const updateGlobal = nav?.updateNodeDataGlobally || updateNodeData;
  const addElementsGlobally = nav?.addElementsGlobally;
  const canvasFilePath = nav?.currentFile || null;
  const processingRef = useRef(false);
  const pendingUSAJobsRefreshRef = useRef(false);
  const scrapeWarningsRef = useRef(data.scrapeWarnings);
  const hubStateRef = useRef(data.hubState);
  const pendingJobsRef = useRef(data.pendingJobs);
  const resumeScoringRef = useRef(null);
  const isMountedRef = useRef(true);
  const settingsDebounceTimerRef = useRef(null);
  const epoch = useEpochCancellation();
  const { addToast } = useToast();
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (settingsDebounceTimerRef.current) {
        clearTimeout(settingsDebounceTimerRef.current);
      }
    };
  }, []);
  // Stable ref to startProcessing so handleDrop can call it without a stale closure.
  const startProcessingRef = useRef(null);

  const hubState = data.hubState || 'empty';
  const statusLabel = STATE_LABELS[hubState];
  const sourceFilter = data.sourceFilter || null;

  scrapeWarningsRef.current = data.scrapeWarnings;
  hubStateRef.current       = data.hubState;
  pendingJobsRef.current    = data.pendingJobs;

  // Per-source progress state populated by backend `job-source-progress`
  // events. Reset via `resetSourceProgress` before each fresh run so stale
  // counts from the previous run don't bleed into the new pipeline.
  const {
    progress: sourceProgress,
    lastActive: lastActiveSource,
    reset: resetSourceProgress,
  } = useSourceProgress(window.electronAPI?.onJobSourceProgress, id);

  const getPrimaryQuery = useCallback(() => {
    const q = data.queries;
    if (!q) return '';
    const {
      targetRoleQueries = [], titleQueries = [], suggestedRoleQueries = [], skillsOnlyQueries = []
    } = q;
    const all = [...targetRoleQueries, ...titleQueries, ...suggestedRoleQueries, ...skillsOnlyQueries];
    return all[0] || '';
  }, [data.queries]);

  const appendJobsToDoneCanvas = useCallback(({ scoredJobs, filteredWarnings }) => {
    const currentId = id;
    const existingNodes = getNodes();
    const existingEdges = getEdges();

    const hasTarget = !!(data.targetRole || '').trim();
    const activeTargetRole = (data.targetRole || '').trim();
    const profile = data.resumeProfile;

    // Layout columns mapping
    const COL_X = hasTarget ? COL_X_WITH_TARGET : COL_X_WITHOUT_TARGET;

    const originalPos = getNode(currentId)?.position || { x: 0, y: 0 };
    const baseNodeId = `job-append-${Date.now()}`;

    const newNodes = [];
    const newEdges = [];

    // Helper to find parent-child relationship in existing edges
    const getConnectedChildIds = (parentId) => {
      const allEdges = [...existingEdges, ...newEdges];
      return allEdges.filter(e => e.source === parentId).map(e => e.target);
    };

    // Keep track of count updates needed for existing nodes
    const nodeCountDeltas = {};

    let nextJobNodeIdx = 0;

    scoredJobs.forEach((job) => {
      // Determine logical category and parent
      let categoryLabel = job.careerDirection || 'Other';
      let parentNodeId = currentId; // Default parent is the hub itself (flat structure)
      let isUnderTargetBranch = false;

      if (hasTarget) {
        if (job.isTargetRoleMatch) {
          // Under Target Role branch (no Category level)
          const targetBranch = existingNodes.find(n => 
            n.type === 'jobgroup' && 
            n.data?.kind === 'branch' && 
            n.data?.hubId === currentId && 
            n.data?.label?.startsWith('Target Role')
          );
          if (targetBranch) {
            parentNodeId = targetBranch.id;
            isUnderTargetBranch = true;
          } else {
            parentNodeId = currentId;
          }
        } else {
          // Under Other Strong Matches branch, under Category
          if ((job.matchScore || 0) < otherStrongGate(data.strongMatchGate)) {
            return; // Skip non-target jobs below this run's strong-match bar
          }
          const otherBranch = existingNodes.find(n => 
            n.type === 'jobgroup' && 
            n.data?.kind === 'branch' && 
            n.data?.hubId === currentId && 
            n.data?.label === 'Other Strong Matches'
          );
          if (otherBranch) {
            parentNodeId = otherBranch.id;
          } else {
            parentNodeId = currentId;
          }
        }
      }

      // If we are not under target branch, we must have a Category node under the parentNodeId.
      let categoryNodeId = parentNodeId;
      if (!isUnderTargetBranch) {
        const connectedChildren = getConnectedChildIds(parentNodeId);
        let catNode = existingNodes.find(n => 
          n.type === 'jobgroup' && 
          n.data?.kind === 'category' && 
          n.data?.hubId === currentId && 
          n.data?.label === categoryLabel
        ) || newNodes.find(n => 
          n.type === 'jobgroup' && 
          n.data?.kind === 'category' && 
          n.data?.hubId === currentId && 
          n.data?.label === categoryLabel
        );

        if (!catNode) {
          // Create new Category node
          const catId = `${baseNodeId}-cat-${categoryLabel.replace(/\s+/g, '-')}`;
          
          // Compute Y coordinate
          const siblingCats = [...existingNodes, ...newNodes].filter(n => 
            n.type === 'jobgroup' && 
            n.data?.kind === 'category' && 
            n.data?.hubId === currentId &&
            connectedChildren.includes(n.id)
          );
          let maxY = originalPos.y;
          if (siblingCats.length > 0) {
            maxY = Math.max(...siblingCats.map(n => n.position.y));
          } else {
            const pNode = existingNodes.find(n => n.id === parentNodeId);
            maxY = pNode ? pNode.position.y : originalPos.y;
          }
          const catY = maxY + ROW_H.category;

          catNode = {
            id: catId,
            type: 'jobgroup',
            position: { x: originalPos.x + COL_X.category, y: catY },
            hidden: hasTarget && parentNodeId !== currentId,
            data: {
              kind: 'category',
              hubId: currentId,
              label: categoryLabel,
              count: 0,
              childIds: [],
              expanded: false,
            },
          };
          newNodes.push(catNode);
          newEdges.push({
            id: `edge-${parentNodeId}-${catId}`,
            source: parentNodeId,
            target: catId,
            ...structuralEdge('rgba(96,165,250,0.5)'),
          });
        }
        categoryNodeId = catNode.id;
      }

      // Now find or create Bucket node under categoryNodeId
      const connectedBuckets = getConnectedChildIds(categoryNodeId);
      const bucketNodes = [...existingNodes, ...newNodes].filter(n => 
        n.type === 'jobgroup' && 
        n.data?.kind === 'bucket' && 
        n.data?.hubId === currentId &&
        connectedBuckets.includes(n.id)
      );

      // Match bucket by salary
      const jobSalary = parseSalaryToNumeric(job.salary);
      let matchedBucket = null;

      if (jobSalary === 0) {
        matchedBucket = bucketNodes.find(n => n.data?.minSalary === 0 && n.data?.maxSalary === 0);
      } else {
        matchedBucket = bucketNodes.find(n => 
          n.data?.minSalary <= jobSalary && 
          (n.data?.maxSalary === 0 || jobSalary <= n.data?.maxSalary)
        );
      }

      // Fallback 1: match by label
      if (!matchedBucket) {
        matchedBucket = bucketNodes.find(n => 
          n.data?.label === 'Unspecified' || 
          n.data?.label === 'All'
        );
      }

      // Fallback 2: use the last bucket in category
      if (!matchedBucket && bucketNodes.length > 0) {
        matchedBucket = bucketNodes[bucketNodes.length - 1];
      }

      if (!matchedBucket) {
        // Create a new "Unspecified" Bucket node
        const bucId = `${categoryNodeId}-buc-fallback-${Date.now()}`;
        
        // Compute Y coordinate
        let maxY = originalPos.y;
        if (bucketNodes.length > 0) {
          maxY = Math.max(...bucketNodes.map(n => n.position.y));
        } else {
          const catNode = [...existingNodes, ...newNodes].find(n => n.id === categoryNodeId);
          maxY = catNode ? catNode.position.y : originalPos.y;
        }
        const bucY = maxY + ROW_H.bucket;

        matchedBucket = {
          id: bucId,
          type: 'jobgroup',
          position: { x: originalPos.x + COL_X.bucket, y: bucY },
          hidden: true,
          data: {
            kind: 'bucket',
            hubId: currentId,
            label: 'Unspecified',
            count: 0,
            childIds: [],
            visibleCount: 10,
            expanded: false,
            minSalary: 0,
            maxSalary: 0,
          },
        };
        newNodes.push(matchedBucket);
        newEdges.push({
          id: `edge-${categoryNodeId}-${bucId}`,
          source: categoryNodeId,
          target: bucId,
          ...structuralEdge('rgba(96,165,250,0.5)'),
        });
      }

      // Create new jobcard node stacked under matchedBucket
      const jobId = `${baseNodeId}-job-${nextJobNodeIdx++}`;
      
      const connectedJobs = getConnectedChildIds(matchedBucket.id);
      const existingJobCardsCount = connectedJobs.length;
      const jobY = matchedBucket.position.y + existingJobCardsCount * ROW_H.job;

      const jobNode = {
        id: jobId,
        type: 'jobcard',
        position: { x: originalPos.x + COL_X.job, y: jobY },
        hidden: true,
        data: {
          hubId: currentId,
          title: job.title,
          company: job.company,
          location: job.location,
          salary: job.salary,
          snippet: job.snippet,
          matchScore: job.matchScore,
          reasoning: job.reasoning,
          careerDirection: job.careerDirection,
          strengthLabel: job.strengthLabel,
          source: job.source,
          url: job.url,
          posted: job.posted,
          resumeProfile: profile,
          isNew: true,
          isTargetRoleMatch: !!job.isTargetRoleMatch,
        },
      };

      newNodes.push(jobNode);
      newEdges.push({
        id: `edge-${matchedBucket.id}-${jobId}`,
        source: matchedBucket.id,
        target: jobId,
        ...structuralEdge('rgba(96,165,250,0.5)'),
      });

      // Update matchedBucket childIds and counts
      if (existingNodes.find(n => n.id === matchedBucket.id)) {
        nodeCountDeltas[matchedBucket.id] = nodeCountDeltas[matchedBucket.id] || { childIds: [], count: 0 };
        nodeCountDeltas[matchedBucket.id].childIds.push(jobId);
        nodeCountDeltas[matchedBucket.id].count += 1;
      } else {
        matchedBucket.data.childIds.push(jobId);
        matchedBucket.data.count += 1;
        matchedBucket.data.visibleCount = Math.min(10, matchedBucket.data.count);
      }

      // Propagate counts to parent Category/Branch nodes
      let currParentId = categoryNodeId;
      while (currParentId && currParentId !== currentId) {
        if (existingNodes.find(n => n.id === currParentId)) {
          nodeCountDeltas[currParentId] = nodeCountDeltas[currParentId] || { count: 0 };
          nodeCountDeltas[currParentId].count += 1;
        } else {
          const newParentNode = newNodes.find(n => n.id === currParentId);
          if (newParentNode) {
            newParentNode.data.count += 1;
          }
        }

        const edge = [...existingEdges, ...newEdges].find(e => e.target === currParentId);
        currParentId = edge ? edge.source : null;
      }
    });

    if (newNodes.length > 0) {
      document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));

      setNodes((nodes) => {
        return nodes.map((n) => {
          const delta = nodeCountDeltas[n.id];
          if (delta) {
            const updatedData = { ...n.data };
            if (delta.childIds) {
              updatedData.childIds = [...(updatedData.childIds || []), ...delta.childIds];
              updatedData.visibleCount = Math.min(10, updatedData.childIds.length);
            }
            if (typeof delta.count === 'number') {
              updatedData.count = (updatedData.count || 0) + delta.count;
            }
            return { ...n, data: updatedData };
          }
          return n;
        });
      });

      if (addElementsGlobally) {
        addElementsGlobally(currentId, newNodes, newEdges, 'sibling');
      } else {
        addNodes(newNodes);
        addEdges(newEdges);
      }
    }

    const finalSourceCounts = { ...data.finalSourceCounts };
    scoredJobs.forEach(job => {
      finalSourceCounts[job.source] = (finalSourceCounts[job.source] || 0) + 1;
    });

    const hasTargetRole = !!activeTargetRole;
    const targetCandidates = scoredJobs.filter(j => j.isTargetRoleMatch);
    const otherCandidates = scoredJobs.filter(j => !j.isTargetRoleMatch && (j.matchScore || 0) >= otherStrongGate(data.strongMatchGate));

    const targetDelta = hasTargetRole ? targetCandidates.length : 0;
    const otherDelta = hasTargetRole ? otherCandidates.length : 0;

    const allAddedScores = scoredJobs.map(j => j.matchScore || 0);
    const scoreRangeMin = Math.min(data.scoreRangeMin ?? 0, ...allAddedScores);
    const scoreRangeMax = Math.max(data.scoreRangeMax ?? 100, ...allAddedScores);

    updateGlobal(currentId, {
      hubState: 'done',
      resultCount: (data.resultCount || 0) + (hasTargetRole ? (targetDelta + otherDelta) : scoredJobs.length),
      totalScoredCount: (data.totalScoredCount || 0) + scoredJobs.length,
      targetCount: (data.targetCount || 0) + targetDelta,
      otherCount: (data.otherCount || 0) + otherDelta,
      finalSourceCounts,
      scoreRangeMin,
      scoreRangeMax,
      scrapeWarnings: filteredWarnings,
    });
  }, [id, data.targetRole, data.finalSourceCounts, data.resultCount, data.totalScoredCount, data.targetCount, data.otherCount, data.scoreRangeMin, data.scoreRangeMax, data.strongMatchGate, data.resumeProfile, getNodes, getEdges, getNode, setNodes, addElementsGlobally, addNodes, addEdges, updateGlobal]);

  const triggerUSAJobsBackgroundSearch = useCallback(async () => {
    if (processingRef.current) return;
    const query = getPrimaryQuery();
    if (!query) {
      EventLogger.log(`[JobHub][${id}] No stored queries found to run USAJobs background search.`);
      return;
    }

    processingRef.current = true;
    const currentId = id;
    const cancelled = epoch.start();

    try {
      EventLogger.log(`[JobHub][${id}] Starting USAJobs background search for query: "${query}"`);
      
      const res = await window.electronAPI.searchJobsSingleSource({
        query,
        sourceId: 'usajobs',
        // Read straight off `data` rather than the `maxAgeDays` const, which is
        // declared further down the component body — referencing it here (and in
        // this callback's deps) would hit the temporal dead zone on every render
        // and crash the node. Mirrors runPipeline's `data.maxAgeDays || 21`.
        maxAgeDays: data.maxAgeDays || 21,
        canvasFilePath,
        nodeId: currentId,
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
        const seen = new Set(prevPending.map(j => `${j.title}|${j.company}|${j.url || ''}`));
        const fresh = freshJobs.filter(j => {
          const k = `${j.title}|${j.company}|${j.url || ''}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        const mergedPending = [...prevPending, ...fresh];
        pendingJobsRef.current = mergedPending;
        scrapeWarningsRef.current = filteredWarnings;

        updateGlobal(currentId, {
          pendingJobs: mergedPending,
          jobCount: mergedPending.length,
          scrapeWarnings: filteredWarnings,
        });

        const remainingBlocks = filteredWarnings.filter(w => w?.severity === 'block');
        if (remainingBlocks.length === 0 && mergedPending.length > 0) {
          EventLogger.log(`[JobHub][${id}] Auto-resuming scoring from sources-ready state.`);
          processingRef.current = false;
          await resumeScoringRef.current?.();
        }
      } else if (currentState === 'done') {
        if (freshJobs.length > 0) {
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
          });

          if (cancelled()) return;

          if (!scoreResult.success) {
            throw new Error(scoreResult.error || 'Failed to score background USAJobs');
          }

          appendJobsToDoneCanvas({
            scoredJobs: scoreResult.scoredJobs,
            filteredWarnings,
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
      EventLogger.error(`[JobHub][${id}] USAJobs background search/integrate failed:`, err);
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
  }, [id, data.maxAgeDays, canvasFilePath, getPrimaryQuery, epoch, updateGlobal, addToast, data.resumeProfile, data.targetRole, appendJobsToDoneCanvas]);

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
          EventLogger.log(`[JobHub][${id}] USAJobs credentials detected/updated. Refreshing USAJobs...`);
          if (processingRef.current) {
            pendingUSAJobsRefreshRef.current = true;
            EventLogger.log(`[JobHub][${id}] Pipeline is currently active. Queued USAJobs background refresh.`);
          } else {
            triggerUSAJobsBackgroundSearch();
          }
        }
      } catch (err) {
        EventLogger.error(`[JobHub][${id}] Error handling jobs settings change:`, err);
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
          EventLogger.log(`[JobHub][${id}] Settings changed with active error; keeping error banner open for explicit user action`);
        }
      }
      if (payload?.changedSections?.includes('jobs')) {
        handleJobsSettingsChange();
      }
    });
    return () => cleanup?.();
  }, [id, data.errorMessage, handleJobsSettingsChange]);

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
    const n = Math.max(1, Math.min(JOB_MAX_AGE_DAYS_LIMIT, Math.floor(Number(val) || JOB_DEFAULT_AGE_DAYS)));
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
    EventLogger.log(`[JobHub][${id}] Cleaning up all children (source cards, jobs, groups)`);
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
    // instead of all bunching on the left. The user can drag any card anywhere
    // afterward.
    const HUB_W = 260, HUB_H = 140;     // approx hub footprint while idle
    const CARD_W = 140, CARD_H = 50;
    const cx = hubPos.x + HUB_W / 2;
    const cy = hubPos.y + HUB_H / 2;
    const total = existing.length + missing.length;
    const stamp = Date.now();
    // Radius derived from card count + footprint so cards never overlap as the
    // source list grows (replaces a fixed 320 that only worked for ~12 sources).
    const RADIUS = radialRadius({ count: total, cardW: CARD_W, cardH: CARD_H, hubW: HUB_W, hubH: HUB_H });

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
      fitView({ duration: fitViewDuration(total), padding: 0.2 });
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
   * Steps 4-5 of the pipeline: scoring → bucketing → spawn → set 'done'.
   * Extracted so the resume-after-pause path (user cleared their last block
   * warning) can re-enter scoring without re-fetching the resume + search.
   *
   * The caller is responsible for: setting processingRef true, capturing the
   * cancellation epoch, finally-clearing processingRef. Mirrors the marketplace
   * synthesizeAndPrice pattern.
   */
  const runScoringAndSpawn = useCallback(async ({
    profile, jobs, scrapeWarnings, activeTargetRole, originalPos, cancelled,
  }) => {
    const currentId = id;

    // Step 4: Scoring
    updateGlobal(currentId, { hubState: 'scoring', jobCount: jobs.length });
    const scoreResult = await window.electronAPI.scoreJobs({
      jobs, profile, nodeId: currentId, targetRole: activeTargetRole,
    });
    if (cancelled()) return;
    if (!scoreResult.success) {
      const err = new Error(scoreResult.error || 'Failed to score jobs');
      if (scoreResult.isRateLimit) err.isRateLimit = true;
      throw err;
    }

    // ── Branch construction (split + loose-fill) ──────────────────────
    const hasTarget = !!activeTargetRole;
    const { targetList, otherList, displayedJobs, gate: strongMatchGate } =
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
      requestAnimationFrame(() => {
        fitView({ duration: 600, padding: 0.2 });
      });
    }

    const finalSourceCounts = {};
    scoreResult.scoredJobs.forEach(job => {
      finalSourceCounts[job.source] = (finalSourceCounts[job.source] || 0) + 1;
    });

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
      // Persist this run's "Other Strong" cutoff so later appends (USAJobs
      // background search, captcha-resolve) bucket non-target jobs identically.
      strongMatchGate,
      finalSourceCounts,
      scoreRangeMin,
      scoreRangeMax,
      scoreThreshold: scoreRangeMin,
      // Clear pendingJobs once we've successfully consumed them so a re-run
      // doesn't pick up the old paused buffer.
      pendingJobs: null,
      scrapeWarnings: Array.isArray(scrapeWarnings) ? scrapeWarnings : [],
    });
  }, [id, updateGlobal, addElementsGlobally, addNodes, addEdges, canvasFilePath, fitView]);

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
      updateGlobal(currentId, { hubState: 'searching', queryCount: allQueries.length, queries: queriesResult.queries });
      const searchResult = await window.electronAPI.searchJobs({
        queries: allQueries,
        nodeId: currentId,
        maxAgeDays: data.maxAgeDays || 21,
        canvasFilePath,
      });
      if (cancelled()) return;

      const searchWarnings = Array.isArray(searchResult.scrapeWarnings) ? searchResult.scrapeWarnings : [];
      const blockingWarnings = searchWarnings.filter(w => w?.severity === 'block');
      const foundJobs = (searchResult.success && Array.isArray(searchResult.jobs)) ? searchResult.jobs : [];

      // ── Block gate ──────────────────────────────────────────────────
      // If any source hit a block-severity warning (captcha, login wall),
      // pause in 'sources-ready' so the user can Solve / Skip each blocked
      // source before we spend AI tokens, then auto-resume when the last
      // warning clears (or "Score current results" with partial data).
      //
      // This MUST come before the zero-jobs terminal branch below: a run can
      // legitimately return 0 jobs *because* the only productive source was
      // blocked (e.g. Indeed served a captcha while every other source was
      // history-deduped). Going straight to 'done' there showed "0 jobs
      // matched" prematurely AND stranded the jobs the user later unlocked via
      // Solve — the resolve merged them into pendingJobs, but auto-resume only
      // fires from 'sources-ready', so they were never scored.
      //
      // info-severity warnings (USAJobs config-missing) and throttles don't
      // gate — they're informational and shouldn't require a manual click.
      if (blockingWarnings.length > 0) {
        updateGlobal(currentId, {
          hubState: 'sources-ready',
          pendingJobs: foundJobs,
          pendingTargetRole: activeTargetRole,
          jobCount: foundJobs.length,
          scrapeWarnings: searchWarnings,
        });
        return;
      }

      if (foundJobs.length === 0) {
        // Genuinely empty — no blocked sources left to recover. Terminal 'done'.
        // Reset the slider range + branch counts so the done-state UI doesn't
        // show stale values from a previous successful run.
        updateGlobal(currentId, {
          hubState: 'done',
          resultCount: 0,
          totalScoredCount: 0,
          targetCount: 0,
          otherCount: 0,
          scoreRangeMin: 0,
          scoreRangeMax: 100,
          scoreThreshold: 0,
          scrapeWarnings: searchWarnings,
        });
        return;
      }

      await runScoringAndSpawn({
        profile,
        jobs: foundJobs,
        scrapeWarnings: searchWarnings,
        activeTargetRole,
        originalPos,
        cancelled,
      });
    } catch (error) {
      // User cancelled (Reset) OR deleted the hub mid-pipeline. The
      // Node-deleted branch handles the race where the backend abort
      // settles BEFORE the unmount effect has bumped the epoch — without
      // it, we'd write a useless errorMessage onto data that's about to
      // be discarded and log a misleading "pipeline failed" line.
      if (cancelled() || isNodeDeletedAbort(error)) return;
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
  }, [id, updateGlobal, getNode, getNodes, canvasFilePath, data.maxAgeDays, data.targetRole, ensureSourceCards, epoch, resetSourceProgress, runScoringAndSpawn, triggerUSAJobsBackgroundSearch]);

  const startProcessing = useCallback((filePath) => runPipeline({ filePath }), [runPipeline]);
  const startProcessingWithProfile = useCallback((profile) => runPipeline({ profile }), [runPipeline]);

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
        hubState: 'done', resultCount: 0, totalScoredCount: 0, targetCount: 0,
        otherCount: 0, scoreRangeMin: 0, scoreRangeMax: 100, scoreThreshold: 0,
        pendingJobs: null,
        scrapeWarnings: Array.isArray(scrapeWarningsRef.current) ? scrapeWarningsRef.current : [],
      });
      return;
    }
    if (!profile) return;
    processingRef.current = true;
    const currentId = id;
    const cancelled = epoch.start();
    const originalPos = getNode(currentId)?.position || { x: 0, y: 0 };
    try {
      await runScoringAndSpawn({
        profile,
        jobs: pending,
        scrapeWarnings: Array.isArray(scrapeWarningsRef.current) ? scrapeWarningsRef.current : [],
        activeTargetRole: data.pendingTargetRole || data.targetRole || '',
        originalPos,
        cancelled,
      });
    } catch (error) {
      if (cancelled() || isNodeDeletedAbort(error)) return;
      EventLogger.error('[JobHub] Resume scoring failed:', error);
      updateGlobal(currentId, {
        hubState: 'sources-ready',
        errorMessage: error?.message || String(error),
        isRateLimit: !!error?.isRateLimit,
      });
    } finally {
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
  }, [id, data.resumeProfile, data.pendingTargetRole, data.targetRole, epoch, getNode, runScoringAndSpawn, updateGlobal, triggerUSAJobsBackgroundSearch]);

  resumeScoringRef.current = resumeScoring;

  // Listen for individual job-source skips dispatched from JobSourceCardNode.
  // Each event drops the matching warning from data.scrapeWarnings; once the
  // remaining list is empty AND we're in the paused 'sources-ready' state,
  // auto-resume scoring with whatever the partial search collected.
  useEffect(() => {
    const onSkip = (e) => {
      if (e.detail?.hubId !== id) return;
      const skippedSourceId = e.detail?.sourceId;
      if (!skippedSourceId) return;
      const remaining = (scrapeWarningsRef.current || []).filter(w => w.sourceId !== skippedSourceId);
      scrapeWarningsRef.current = remaining;
      updateGlobal(id, { scrapeWarnings: remaining });
      // The gate that paused the pipeline was block-severity only (captcha,
      // login walls). info-severity warnings (e.g. USAJobs config-missing,
      // shown so the user knows why that source returned 0 but not requiring
      // action) and throttles should NOT keep the resume from firing — the
      // user already addressed every actionable block by this point.
      const remainingBlocks = remaining.filter(w => w?.severity === 'block');
      if (
        remainingBlocks.length === 0 &&
        hubStateRef.current === 'sources-ready' &&
        !processingRef.current
      ) {
        // resumeScoring scores pendingJobs, or finishes in empty 'done' when
        // none were collected — so skipping the last blocked source never
        // leaves the hub stuck on the paused screen.
        resumeScoringRef.current?.();
      }
    };
    document.addEventListener('job-source-skip', onSkip);
    return () => document.removeEventListener('job-source-skip', onSkip);
  }, [id, updateGlobal]);

  // Listen for job-source-resolved dispatched after a successful Solve.
  // Carries `items` — jobs extracted inline from the visible browser session
  // that just cleared the bot challenge. Merge them into pendingJobs by
  // (title|company|url) fingerprint so a retry-of-a-retry doesn't double-
  // count, drop the source's warning, and auto-resume scoring if this was
  // the last block.
  useEffect(() => {
    const onResolved = (e) => {
      if (e.detail?.hubId !== id) return;
      const resolvedSourceId = e.detail?.sourceId;
      if (!resolvedSourceId) return;
      const items = Array.isArray(e.detail?.items) ? e.detail.items : [];
      // Merge new items into pendingJobs, replacing same-source entries so
      // a retry brings fresh data rather than stacking on top of old.
      const prevPending = Array.isArray(pendingJobsRef.current) ? pendingJobsRef.current : [];
      const keep = prevPending.filter(j => j?.source !== resolvedSourceId);
      const seen = new Set(keep.map(j => `${j.title}|${j.company}|${j.url || ''}`));
      const fresh = items.filter(j => {
        const k = `${j.title}|${j.company}|${j.url || ''}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const mergedPending = [...keep, ...fresh];
      pendingJobsRef.current = mergedPending;
      // Drop the resolved source's warning.
      const remaining = (scrapeWarningsRef.current || []).filter(w => w.sourceId !== resolvedSourceId);
      scrapeWarningsRef.current = remaining;
      updateGlobal(id, { pendingJobs: mergedPending, jobCount: mergedPending.length, scrapeWarnings: remaining });
      // Auto-resume on no remaining BLOCK warnings (info / throttle stays).
      const remainingBlocks = remaining.filter(w => w?.severity === 'block');
      // Record the merge so a "resolve extracted N jobs but only M got scored"
      // discrepancy is visible in the bug-report event history (pair this with
      // the main-process "Scoring N jobs" line to spot a stale-state regression).
      EventLogger.log(`[JobHub][${id}] Resolved ${resolvedSourceId}: received ${items.length} item(s), +${fresh.length} new → pendingJobs ${prevPending.length}→${mergedPending.length}; ${remainingBlocks.length} block warning(s) remain`);
      if (
        remainingBlocks.length === 0 &&
        hubStateRef.current === 'sources-ready' &&
        !processingRef.current
      ) {
        // resumeScoring scores the merged jobs, or finishes in empty 'done' if
        // the resolve cleared the last block but yielded nothing to score.
        resumeScoringRef.current?.();
      }
    };
    document.addEventListener('job-source-resolved', onResolved);
    return () => document.removeEventListener('job-source-resolved', onResolved);
  }, [id, updateGlobal]);

  // "Score current results" button on the paused-state UI: clear all
  // remaining warnings (user chose to proceed without resolving) and resume.
  const handleScoreCurrentResults = useCallback(() => {
    if (data.hubState !== 'sources-ready') return;
    scrapeWarningsRef.current = [];
    updateGlobal(id, { scrapeWarnings: [] });
    resumeScoring();
  }, [id, data.hubState, updateGlobal, resumeScoring]);

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

    EventLogger.log(`[JobHub][${id}] User clicked Reset`);

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
    cleanupAllJobChildren();
    processingRef.current = false;
  }, [data.locked, id, updateGlobal, epoch, resetSourceProgress, cleanupAllJobChildren]);

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

  // Bulk-remove job cards a status sweep flagged as Filled/Closed/expired.
  // They're already in the jobs-history ledger (written at discovery), so they
  // won't re-surface on a future search — this just declutters dead listings.
  // Cascades up the result tree so emptied bucket/category groups are removed
  // too (rather than leaving empty shells), and trims/recomputes the counts on
  // groups that only lost some children.
  const handleClearClosed = useCallback(() => {
    if (data.locked) return;
    const cards = getConnectedJobCardNodes();
    const closed = cards.filter(c => CLOSED_MONITOR_STATUSES.includes(c.data?.monitorStatus));
    if (closed.length === 0) return;

    const allNodes = getNodes();
    const nodeById = new Map(allNodes.map(n => [n.id, n]));
    const removeIds = new Set(closed.map(c => c.id));

    // Cascade up: drop any group whose entire child set is being removed,
    // repeating until stable (a category goes once all its buckets go).
    const groups = allNodes.filter(n => n.type === 'jobgroup' && n.data?.hubId === id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const g of groups) {
        if (removeIds.has(g.id)) continue;
        const kids = Array.isArray(g.data?.childIds) ? g.data.childIds : [];
        if (kids.length > 0 && kids.every(k => removeIds.has(k))) {
          removeIds.add(g.id);
          changed = true;
        }
      }
    }

    // Surviving job-card descendants of a group (walk childIds; guard cycles).
    const countSurvivingJobs = (nodeId, seen = new Set()) => {
      if (seen.has(nodeId)) return 0;
      seen.add(nodeId);
      const n = nodeById.get(nodeId);
      if (!n) return 0;
      if (n.type === 'jobcard') return removeIds.has(nodeId) ? 0 : 1;
      const kids = Array.isArray(n.data?.childIds) ? n.data.childIds : [];
      return kids.reduce((sum, k) => sum + countSurvivingJobs(k, seen), 0);
    };

    // Trim childIds + recompute count on surviving groups that lost children.
    const groupUpdates = new Map();
    for (const g of groups) {
      if (removeIds.has(g.id)) continue;
      const kids = Array.isArray(g.data?.childIds) ? g.data.childIds : [];
      const survivingKids = kids.filter(k => !removeIds.has(k));
      if (survivingKids.length !== kids.length) {
        const patch = { childIds: survivingKids, count: countSurvivingJobs(g.id) };
        if (g.data?.kind === 'bucket') {
          patch.visibleCount = Math.min(g.data?.visibleCount ?? 10, survivingKids.length);
        }
        groupUpdates.set(g.id, patch);
      }
    }

    // Snapshot for undo, apply group trims, then delete removed nodes + edges.
    document.dispatchEvent(new CustomEvent('canvas-take-snapshot'));
    if (groupUpdates.size > 0) {
      setNodes(nds => nds.map(n => groupUpdates.has(n.id)
        ? { ...n, data: { ...n.data, ...groupUpdates.get(n.id) } }
        : n));
    }
    const edgesToDelete = getEdges()
      .filter(e => removeIds.has(e.source) || removeIds.has(e.target))
      .map(e => ({ id: e.id }));
    deleteElements({ nodes: [...removeIds].map(rid => ({ id: rid })), edges: edgesToDelete });

    // Keep the hub's headline counts consistent with what's left on the canvas.
    const remaining = cards.filter(c => !removeIds.has(c.id));
    const newTarget = remaining.filter(c => c.data?.isTargetRoleMatch).length;
    updateGlobal(id, {
      resultCount: remaining.length,
      targetCount: newTarget,
      otherCount: remaining.length - newTarget,
    });

    // Re-snapshot the post-clear state next tick so the undo stack holds a clean
    // [pre-clear, post-clear] pair. The pre-clear snapshot above captures the
    // cards WITH their found Filled/Closed statuses; this deferred one makes
    // useUndoRedo's lastFingerprint track the live (post-clear) state, so an
    // undo fired inside the 500ms auto-snapshot window restores that pre-clear
    // snapshot (statuses intact) instead of mis-targeting and skipping it.
    // Same deferred-snapshot pattern as useNodeAutoEdit's auto-delete.
    setTimeout(() => document.dispatchEvent(new CustomEvent('canvas-take-snapshot')), 0);

    const groupsRemoved = removeIds.size - closed.length;
    EventLogger.log(`[JobHub][${id}] Cleared ${closed.length} closed job(s)${groupsRemoved > 0 ? ` + ${groupsRemoved} empty group(s)` : ''}`);
    addToast({
      title: 'Cleared closed jobs',
      description: `Removed ${closed.length} closed listing${closed.length === 1 ? '' : 's'} — kept in history, so they won't reappear.`,
      type: 'success',
    });
  }, [data.locked, id, getConnectedJobCardNodes, getNodes, getEdges, setNodes, deleteElements, updateGlobal, addToast]);

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

    // Clear any paused-pipeline buffer so the new run doesn't accidentally
    // resume the previous attempt's partial results.
    updateGlobal(id, { pendingJobs: null, pendingTargetRole: null });
    resetSourceProgress();
    if (data.filePath) {
      // File still accessible — re-parse for freshness then run full pipeline
      startProcessingRef.current?.(data.filePath);
    } else {
      // File gone but profile is persisted — run from query step onward
      addToast({ title: 'Re-running Search', description: 'Using stored resume profile — original file not needed.', type: 'info' });
      startProcessingWithProfile(data.resumeProfile);
    }
  }, [data.locked, data.filePath, data.resumeProfile, id, getNodes, getEdges, deleteElements, addToast, startProcessingWithProfile, resetSourceProgress, updateGlobal]);

  const isProcessing = PROCESSING_STATES.includes(hubState);

  // Compute running total from per-source progress
  const totalSourceJobs = Object.values(sourceProgress).reduce((sum, p) => sum + (p.count || 0), 0);

  const handleDismissError = useCallback(() => {
    EventLogger.log(`[JobHub][${id}] User clicked Dismiss Error`);
    updateGlobal(id, { errorMessage: null, isRateLimit: false });
    // Cleanup orphaned platform cards if there are no job result nodes on the canvas
    const hubChildrenOnCanvas = getNodes().some(n =>
      (n.type === 'jobcard' || n.type === 'jobgroup') && n.data?.hubId === id
    );
    if (!hubChildrenOnCanvas) {
      EventLogger.log(`[JobHub][${id}] Dismissing error with empty canvas; cleaning up orphaned source cards`);
      cleanupAllJobChildren();
    }
  }, [id, updateGlobal, getNodes, cleanupAllJobChildren]);

  const handleRetryFailed = useCallback(() => {
    if (data.locked) return;
    EventLogger.log(`[JobHub][${id}] User clicked Try Again on error banner`);
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

        {/* Paused on blocked sources — show the resolve/skip decision UI.
            Banner stays visible above (e.g. if a prior scoring attempt
            failed and we reverted here). */}
        {hubState === 'sources-ready' && (
          <>
            {banner}
            <JobHubSourcesReadyState
              // Count DISTINCT blocked sources, not raw warnings: a source can
              // hit a captcha on several queries (indeed-0, indeed-1, …) and
              // store one warning each, but the canvas shows one card per
              // source — so counting warnings made it say "2 sources blocked"
              // with only one Indeed card visible. Skip/resolve already filters
              // warnings by sourceId, so distinct-source count is the truth.
              blockedCount={new Set((data.scrapeWarnings || []).filter(w => w?.severity === 'block').map(w => w.sourceId)).size}
              jobsAvailable={Array.isArray(data.pendingJobs) ? data.pendingJobs.length : (data.jobCount || 0)}
              resumeSummary={data.resumeSummary}
              locked={!!data.locked}
              onScoreCurrent={handleScoreCurrentResults}
            />
          </>
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
              onClearClosed={handleClearClosed}
              scrapeWarnings={data.scrapeWarnings || []}
            />
          </>
        )}
      </HubContainer>
  );
}
