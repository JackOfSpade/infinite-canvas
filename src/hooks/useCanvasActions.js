import { useCallback } from 'react';
import { addEdge, useReactFlow } from '@xyflow/react';
import { setupDragGhost, setupCanvasDragGhost } from '../utils/dragUtils';
import { EDGE_STYLE, getNodesBounds } from '../utils/constants';
import { cloneNode, reassignCanvasDataIDs } from '../utils/nodeFactory';
import { EventLogger } from '../utils/EventLogger';
import { generateId } from '../utils/idGenerator';
import { cancelNodeTasksRecursively, collectDeletedManualAiWorkflowNodes, discardDeletedJobAnalysisSnapshots, discardDeletedJobRuns, restoreJobWorkflowSnapshots, retireDeletedManualAiRuns } from '../utils/canvasInteractions';
import { getReactFlowContainerSize } from '../utils/reactFlowDom';
import { strokePoints } from '../utils/geometry';
import { collectOrphanTextDocumentPaths, collectRemainingTextDocumentPaths } from '../utils/osDeletionPaths';
import { textDocumentSessions } from '../utils/textDocumentSessions';
import { remapCopiedJobModuleReferences } from '../utils/jobBoardSearchSelection';
import { useJobSearchCoordinator } from '../contexts/useJobSearchCoordinator';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import {
  collectJobBoardsAffectedByDeletion,
  getClearCanvasRetainedNodes,
  isClearCanvasDeletionFenceIntact,
  jobBoardHasCancellableRecovery,
  markJobWorkflowDeletionPending,
  settleJobWorkflowDeletion,
} from '../utils/nodeDeletionLifecycle';

const CLIPBOARD_KEY = 'infinite-canvas-clipboard';
const PASTE_REPEAT_OFFSET = 40;
let applicationClipboardFallback = null;

export function useCanvasActions({
  setNodes,
  setEdges,
  setDrawings,
  drawings,
  setCurrentFile,
  setHasUnsavedChanges,
  takeSnapshot,
  requestClearConfirm,
  resetStack,
  depth,
  isAnimatingRef,
  canvasFilePath = null,
  addToast = null,
  enumerateAllNodes = null,
}) {
  const jobSearchCoordinator = useJobSearchCoordinator();
  const moduleRunQueue = useModuleRunQueue();
  const { getNodes, getEdges, setEdges: rfSetEdges, getViewport } = useReactFlow();

  const onConnect = useCallback((params) => {
    if (isAnimatingRef?.current) return;
    if (params.source === params.target) return;
    takeSnapshot();
    setEdges((eds) => addEdge({ ...params, animated: true, style: EDGE_STYLE }, eds));
  }, [setEdges, takeSnapshot, isAnimatingRef]);

  const onDragStart = useCallback((e, type) => {
    e.dataTransfer.setData('app/node-type', type);
    e.dataTransfer.effectAllowed = 'copy';
    if (type === 'group') {
      setupCanvasDragGhost(e);
    } else {
      setupDragGhost(e, type === 'text' ? 'text' : 'link', type === 'text' ? 'rgba(255, 255, 255, 0.9)' : 'rgb(96, 165, 250)');
    }
  }, []);

  const duplicateNodes = useCallback((nodesToDuplicate) => {
    if (isAnimatingRef?.current) return;
    if (!nodesToDuplicate || nodesToDuplicate.length === 0) return;
    takeSnapshot?.();
    const sourceEdges = getEdges();
    const oldIdToNewId = new Map();
    const clonedNodes = nodesToDuplicate.map(original => {
      let clone = cloneNode(original);
      oldIdToNewId.set(original.id, clone.id);
      clone = reassignCanvasDataIDs(clone);
      return clone;
    });
    const newNodes = remapCopiedJobModuleReferences(nodesToDuplicate, clonedNodes, oldIdToNewId, sourceEdges);
    const retainedNewNodeIds = new Set(newNodes.map(node => node?.id).filter(Boolean));

    const newEdges = [];
    sourceEdges.forEach(eEdge => {
      const source = oldIdToNewId.get(eEdge.source);
      const target = oldIdToNewId.get(eEdge.target);
      if (source && target && retainedNewNodeIds.has(source) && retainedNewNodeIds.has(target)) {
        newEdges.push({
          ...eEdge,
          id: generateId(),
          source,
          target,
          selected: true,
        });
      }
    });

    setNodes(nds => {
      const unselected = nds.map(n => ({ ...n, selected: false }));
      return unselected.concat(newNodes);
    });
    
    if (newEdges.length > 0) {
      rfSetEdges(eds => {
        const unselected = eds.map(edge => ({ ...edge, selected: false }));
        return unselected.concat(newEdges);
      });
    }

    EventLogger.log(`Duplicated ${newNodes.length} nodes and ${newEdges.length} edges`);
  }, [takeSnapshot, getEdges, setNodes, rfSetEdges, isAnimatingRef]);

  const copyNodes = useCallback((nodesToCopy) => {
    if (isAnimatingRef?.current) return;
    if (!nodesToCopy || nodesToCopy.length === 0) return;
    const oldIds = new Set(nodesToCopy.map(n => n.id));
    const edgesToCopy = getEdges().filter(e => oldIds.has(e.source) && oldIds.has(e.target));
    
    // Find intersecting drawings perfectly bounded by the copied nodes selection box
    let drawingsToCopy = [];
    if (drawings && drawings.length > 0) {
      const { minX, maxX, minY, maxY } = getNodesBounds(nodesToCopy);
      drawingsToCopy = drawings.filter(d =>
        strokePoints(d).some(p => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)
      );
    }

    // Deep clone to prevent unintended reference mutations while in clipboard
    const clipboardData = {
      nodes: structuredClone(nodesToCopy),
      edges: structuredClone(edgesToCopy),
      drawings: structuredClone(drawingsToCopy),
      pasteCount: 0
    };

    try {
      localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clipboardData));
      applicationClipboardFallback = clipboardData; // Always update memory state safely
      EventLogger.log(`Copied ${nodesToCopy.length} nodes, ${edgesToCopy.length} edges, and ${drawingsToCopy.length} drawings to localStorage.`);
    } catch (e) {
      EventLogger.error('Failed to write to localStorage clipboard, using isolated memory fallback:', e);
      applicationClipboardFallback = clipboardData;
    }
  }, [getEdges, drawings, isAnimatingRef]);

  const pasteNodes = useCallback(() => {
    if (isAnimatingRef?.current) return;
    let clipboardData = applicationClipboardFallback;
    try {
      const dataStr = localStorage.getItem(CLIPBOARD_KEY);
      if (dataStr) {
        const parsed = JSON.parse(dataStr);
        // Only overwrite clipboard fallback if parsed representation is genuinely populated
        if (parsed && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
           clipboardData = parsed;
           applicationClipboardFallback = clipboardData; // Re-sync memory on successful parse
        }
      }
    } catch (e) {
      EventLogger.error('Failed to parse localStorage clipboard, utilizing isolated memory fallback:', e);
    }

    if (!clipboardData || !clipboardData.nodes || clipboardData.nodes.length === 0) return;
    takeSnapshot?.();

    const { x: vpx, y: vpy, zoom } = getViewport();
    const { width: containerW, height: containerH } = getReactFlowContainerSize();
    const flowWidth  = containerW / zoom;
    const flowHeight = containerH / zoom;
    
    // Compute center of current viewport in flow coordinates. Repeat pastes of
    // the same clipboard step down-right instead of stacking invisibly: the
    // re-saved cluster below is already centred, so without this the next
    // paste's offsets would all be zero.
    const pasteRepeat = Number.isFinite(clipboardData.pasteCount) ? clipboardData.pasteCount : 0;
    const centerX = -vpx / zoom + flowWidth / 2 + pasteRepeat * PASTE_REPEAT_OFFSET;
    const centerY = -vpy / zoom + flowHeight / 2 + pasteRepeat * PASTE_REPEAT_OFFSET;

    // Compute bounding box of copied cluster to find its local center
    const { minX, maxX, minY, maxY } = getNodesBounds(clipboardData.nodes);
    const clusterCenterX = (minX + maxX) / 2;
    const clusterCenterY = (minY + maxY) / 2;

    const oldIdToNewId = new Map();
    const clonedNodes = clipboardData.nodes.map(original => {
      let clone = cloneNode(original, 0, 0); 
      oldIdToNewId.set(original.id, clone.id);
      clone = reassignCanvasDataIDs(clone);
      
      // Position relative to viewport center
      const offsetX = original.position.x - clusterCenterX;
      const offsetY = original.position.y - clusterCenterY;
      clone.position = { x: centerX + offsetX, y: centerY + offsetY };
      clone.selected = true;
      return clone;
    });
    const newNodes = remapCopiedJobModuleReferences(
      clipboardData.nodes,
      clonedNodes,
      oldIdToNewId,
      clipboardData.edges || [],
    );
    const retainedNewNodeIds = new Set(newNodes.map(node => node?.id).filter(Boolean));

    const newEdges = (clipboardData.edges || [])
      .filter(eEdge => {
        const source = oldIdToNewId.get(eEdge?.source);
        const target = oldIdToNewId.get(eEdge?.target);
        return !!source && !!target && retainedNewNodeIds.has(source) && retainedNewNodeIds.has(target);
      })
      .map(eEdge => ({
        ...eEdge,
        id: generateId(),
        source: oldIdToNewId.get(eEdge.source),
        target: oldIdToNewId.get(eEdge.target),
        selected: true,
      }));

    const newDrawings = (clipboardData.drawings || []).map(originalDrawing => {
      // Legacy strokes can be a bare points array; spreading one would turn its
      // indices into numeric keys on the pasted stroke.
      return {
        ...(Array.isArray(originalDrawing) ? {} : originalDrawing),
        id: generateId(),
        points: strokePoints(originalDrawing).map(p => ({
          x: centerX + (p.x - clusterCenterX),
          y: centerY + (p.y - clusterCenterY)
        }))
      };
    });

    setNodes(nds => {
      const unselected = nds.map(n => ({ ...n, selected: false }));
      return unselected.concat(newNodes);
    });

    if (newEdges.length > 0) {
      rfSetEdges(eds => {
        const unselected = eds.map(edge => ({ ...edge, selected: false }));
        return unselected.concat(newEdges);
      });
    }

    if (newDrawings.length > 0) {
      setDrawings(drws => drws.concat(newDrawings));
    }
    
    // Re-save pasted items into clipboard so consecutive pastes offset incrementally
    const nextClipboard = {
      nodes: newNodes.map(n => ({...n, selected: false})),
      edges: newEdges.map(e => ({...e, selected: false})),
      drawings: newDrawings,
      pasteCount: pasteRepeat + 1
    };
    try {
      applicationClipboardFallback = nextClipboard;
      localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(nextClipboard));
    } catch {
      // Ignored clipboard update failure
    }

    EventLogger.log(`Pasted ${newNodes.length} nodes, ${newEdges.length} edges, and ${newDrawings.length} drawings from localStorage.`);
  }, [takeSnapshot, setNodes, rfSetEdges, setDrawings, isAnimatingRef, getViewport]);

  const doClear = useCallback(async () => {
    if (isAnimatingRef?.current) return;

    const allNodes = getNodes();
    const allEdges = getEdges();
    const retainedNodes = getClearCanvasRetainedNodes(allNodes);
    const retainedIds = new Set(retainedNodes.map((node) => node.id));
    let commitRetainedNodes = retainedNodes;
    let commitRetainedIds = retainedIds;
    let commitRemovedNodes = null;

    // Programmatic node-array replacement does not pass through React Flow's
    // onNodesDelete callback. Retire paused/checkpointing Job Search runs here
    // as the equivalent deletion boundary, using the file path captured before
    // root Clear Canvas turns the workspace into an untitled canvas.
    const removedNodes = allNodes.filter(node => !retainedIds.has(node.id));
    const removedIds = new Set(removedNodes.map(node => node.id));
    const removedWorkflowIds = new Set(
      collectDeletedManualAiWorkflowNodes(removedNodes).map(entry => entry.nodeId),
    );
    const pendingWorkflowIds = markJobWorkflowDeletionPending(removedNodes);
    let lifecycleSettled = false;
    const settlePendingLifecycle = () => {
      if (lifecycleSettled) return;
      lifecycleSettled = true;
      settleJobWorkflowDeletion(pendingWorkflowIds);
    };
    try {
      for (const workflowId of removedWorkflowIds) {
        moduleRunQueue.cancelQueuedRunsForNode(workflowId, 'Canvas clear pending');
      }

      // Clear Canvas bypasses React Flow's onBeforeDelete callback. Elect the
      // same complete Board set here, including a locked surviving Board wired
      // to a removed Search and an in-memory Combine with no durable marker.
      const liveWorkflowRoots = enumerateAllNodes?.() ?? allNodes;
      const liveWorkflowEdges = allEdges;
      const affectedBoards = collectJobBoardsAffectedByDeletion(
        liveWorkflowRoots,
        liveWorkflowEdges,
        removedWorkflowIds,
      );
      const fallbackClaims = [];
      await Promise.all(affectedBoards.map(async (board) => {
        try {
          const result = await jobSearchCoordinator.cancelBoardModule(board.id, {
            boardRunId: null,
            reason: 'node-deleted',
            suppressToast: true,
          });
          if (result?.cancelled === true) return;
          if (result?.status === 'none') {
            const latestWorkflowRoots = enumerateAllNodes?.() ?? getNodes();
            const latestBoard = latestWorkflowRoots.find(node => (
              node?.id === board.id && node.type === 'jobboard'
            ));
            if (!latestBoard || !jobBoardHasCancellableRecovery(latestBoard)) return;
          }
          throw new Error(
            result?.error
            || (result?.status === 'stale'
              ? 'An affected Job Board changed while Clear Canvas was pending. Try again.'
              : 'An affected Job Board could not be cancelled safely.'),
          );
        } catch (error) {
          if (error?.code !== 'JOB_BOARD_MODULE_UNAVAILABLE') throw error;
          const plan = board.data?.boardScanResume;
          const boardWillBeRemoved = removedWorkflowIds.has(board.id);
          if (
            boardWillBeRemoved
            && plan?.phase === 'searches'
            && plan.activeSourceId
            && !removedWorkflowIds.has(plan.activeSourceId)
          ) {
            fallbackClaims.push({
              orchestratorNodeId: board.id,
              boardRunId: plan.boardRunId,
              sourceId: plan.activeSourceId,
              plan,
            });
          } else if (!boardWillBeRemoved && jobBoardHasCancellableRecovery(board)) {
            throw error;
          }
          // A deleted Board's durable handoffs are retired below. A surviving
          // unmounted idle Board has no renderer work to acknowledge.
        }
      }));

      const childCancellations = fallbackClaims.map(async (claim) => {
        const result = await jobSearchCoordinator.cancelSearchModule(claim.sourceId, {
          orchestratorNodeId: claim.orchestratorNodeId,
          boardRunId: claim.boardRunId,
          reason: 'node-deleted',
          durablePlanOverride: claim.plan,
        });
        if (result?.cancelled !== true) {
          throw new Error(
            result?.status === 'stale'
              ? 'A removed Job Board\'s active Search changed while Clear Canvas was pending. Try again.'
              : 'A removed Job Board\'s active Search could not be cancelled safely.',
          );
        }
      });
      await Promise.all(childCancellations);
      await retireDeletedManualAiRuns(removedNodes);

      // Cancellation and durable retirement await IPC. A node added during
      // that window was never lifecycle-marked or acknowledged, so the stale
      // `retainedNodes` snapshot must not be allowed to erase it. Exact owned
      // child restoration is expected during cancellation; recompute that part
      // of the live partition, while a changed root graph uses exact snapshot
      // targets so concurrent additions survive untouched.
      const liveNodesBeforeCommit = getNodes();
      const clearGraphStayedStable = isClearCanvasDeletionFenceIntact(
        allNodes,
        liveNodesBeforeCommit,
        allEdges,
        getEdges(),
      );
      if (clearGraphStayedStable) {
        commitRetainedNodes = getClearCanvasRetainedNodes(liveNodesBeforeCommit);
        commitRetainedIds = new Set(commitRetainedNodes.map(node => node.id));
        commitRemovedNodes = liveNodesBeforeCommit.filter(node => !commitRetainedIds.has(node.id));
      } else {
        // Snapshot semantics are safer than aborting after durable retirement:
        // remove only roots authorized at Clear admission plus any exact child
        // restored for those workflows. A newly created Board/Search (and an
        // already-started run on it) survives untouched because it was never
        // lifecycle-marked or acknowledged by this transaction.
        commitRemovedNodes = liveNodesBeforeCommit.filter(node => (
          removedIds.has(node.id) || removedWorkflowIds.has(node.data?.hubId)
        ));
        const commitRemovedIds = new Set(commitRemovedNodes.map(node => node.id));
        commitRetainedNodes = liveNodesBeforeCommit.filter(node => !commitRemovedIds.has(node.id));
        commitRetainedIds = new Set(commitRetainedNodes.map(node => node.id));
        EventLogger.log('[JobSearch] Clear Canvas preserved nodes added or rewired during acknowledged cleanup.');
      }
    } catch (error) {
      if (Array.isArray(error?.manualAiRetirementReceipts)) {
        setNodes(nodes => restoreJobWorkflowSnapshots(
          nodes,
          allNodes,
          removedWorkflowIds,
          error.manualAiRetirementReceipts,
        ));
      } else if (removedWorkflowIds.size > 0) {
        setNodes(nodes => restoreJobWorkflowSnapshots(nodes, allNodes, removedWorkflowIds));
      }
      EventLogger.error('[JobSearch] Clear Canvas manual-AI cleanup failed; canvas retained:', error);
      addToast?.({
        title: 'Canvas was not cleared',
        description: error?.message || 'A saved manual-AI handoff could not be retired safely.',
        type: 'error',
      });
      settlePendingLifecycle();
      return false;
    }

    // Every remaining operation is synchronous controlled-canvas commit work.
    // Schedule lifecycle release now so an unexpected snapshot/state-setter
    // exception cannot strand a global deletion guard forever, while the next
    // macrotask still occurs after React has received the removal updates.
    setTimeout(settlePendingLifecycle, 0);

    // Workflow nodes were acknowledged above so their pre-marker run ids could
    // be captured. Only now issue the generic recursive abort for every other
    // removed node; doing this first could unregister that sole metadata owner.
    if (window.electronAPI?.cancelNodeTask) {
      cancelNodeTasksRecursively(commitRemovedNodes || removedNodes);
    }

    takeSnapshot();

    // If we're nested, we only clear the current canvas level (this is fully undoable).
    // At root level this becomes an untitled workspace rather than silently
    // overwriting the prior file on auto-save. It is still unsaved work: closing
    // immediately after clearing must offer a chance to save or undo it.
    if (depth === 0) {
      resetStack?.();
      setCurrentFile(null);
      setHasUnsavedChanges(true);
    }

    let analysisCleanupWarningShown = false;
    const showJobCleanupWarning = () => {
      if (analysisCleanupWarningShown) return;
      analysisCleanupWarningShown = true;
      addToast?.({
        title: 'Canvas cleared with a warning',
        description: 'An abandoned Job Search run or its saved recovery data for one or more removed hubs could not be fully cleared.',
        type: 'error',
      });
    };
    discardDeletedJobRuns(
      commitRemovedNodes || removedNodes,
      canvasFilePath,
      (error, discard, result) => {
        EventLogger.error(`[JobSearch][${discard.nodeId}] Failed to discard cleared hub run ${discard.runId}:`, error, result);
        showJobCleanupWarning();
      },
    );
    // A completed hub can retain career-derived analysis with no active run
    // token. Capture exact ownership before visual removal; Undo restores only
    // node content, never this intentionally retired recovery.
    discardDeletedJobAnalysisSnapshots(
      commitRemovedNodes || removedNodes,
      canvasFilePath,
      (error, discard, result) => {
        EventLogger.error(
          `[JobSearch][${discard.nodeId}] Failed to discard cleared hub analysis recovery:`,
          error,
          result,
        );
        showJobCleanupWarning();
      },
    );
    // Local AI handoffs outlive their disposable result cards. Clearing the
    // canvas removes the display but does not erase a writer's in-progress
    // files; exact prior handoffs are cleaned only by successful regeneration.

    setNodes(commitRetainedNodes);
    setEdges(allEdges => allEdges.filter(
      (e) => commitRetainedIds.has(e.source) && commitRetainedIds.has(e.target)
    ));
    setDrawings([]);
    return true;
  }, [takeSnapshot, resetStack, depth, enumerateAllNodes, getEdges, getNodes, setNodes, setEdges, setDrawings, setCurrentFile, setHasUnsavedChanges, isAnimatingRef, canvasFilePath, addToast, jobSearchCoordinator, moduleRunQueue]);

  const preflightClear = useCallback(async () => {
    if (isAnimatingRef?.current) return;
    const allNodes = getNodes();
    // Use the identical workflow-aware partition as the eventual commit. A
    // locked Board/Search retains its owned result/source cards, so preflighting
    // those children as removed could flush or conflict-prompt a document that
    // Clear Canvas will actually leave on the canvas.
    const retainedIds = new Set(
      getClearCanvasRetainedNodes(allNodes).map(node => node.id),
    );
    const removedNodes = allNodes.filter(node => !retainedIds.has(node.id));
    const allLiveNodes = enumerateAllNodes?.() ?? allNodes;
    const orphanTextPaths = textDocumentSessions.filterPathsWithoutLiveAliases(
      collectOrphanTextDocumentPaths(removedNodes, allLiveNodes),
      collectRemainingTextDocumentPaths(removedNodes, allLiveNodes),
    );
    if (orphanTextPaths.length > 0) {
      try {
        const result = await textDocumentSessions.flushAndSettlePaths(orphanTextPaths);
        if (!result.success) {
          addToast?.({
            title: 'Canvas was not cleared',
            description: `Could not safely save ${result.unresolvedFilePaths.join(', ')}. Resolve its text-file conflict or save error first.`,
            type: 'error',
          });
          return;
        }
      } catch (error) {
        addToast?.({
          title: 'Canvas was not cleared',
          description: `Could not settle the linked text file: ${error?.message || 'unknown error'}.`,
          type: 'error',
        });
        return;
      }
    }
    await doClear();
  }, [addToast, doClear, enumerateAllNodes, getNodes, isAnimatingRef]);

  const clearCanvas = useCallback(() => {
    if (requestClearConfirm) {
      requestClearConfirm(preflightClear);
    } else {
      void preflightClear();
    }
  }, [requestClearConfirm, preflightClear]);

  return { onConnect, onDragStart, clearCanvas, duplicateNodes, copyNodes, pasteNodes };
}
