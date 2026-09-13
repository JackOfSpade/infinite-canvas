import { useCallback, useRef } from 'react';
import { EventLogger } from '../utils/EventLogger';
import {
  applyManualAiRetirementReceiptsToNodes,
  cancelNodeTasksRecursively,
  collectDeletedManualAiWorkflowNodes,
  discardDeletedJobAnalysisSnapshots,
  discardDeletedJobRuns,
  retireDeletedManualAiRuns,
  restoreJobWorkflowSnapshots,
} from '../utils/canvasInteractions';
import {
  collectOrphanTextDocumentPaths,
  collectRemainingTextDocumentPaths,
  collectSurvivingRepresentedPaths,
  collectTrashEligiblePaths,
} from '../utils/osDeletionPaths';
import { textDocumentSessions } from '../utils/textDocumentSessions';
import { useJobSearchCoordinator } from '../contexts/useJobSearchCoordinator';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import {
  collectJobBoardsAffectedByDeletion,
  jobBoardHasCancellableRecovery,
  markJobWorkflowDeletionPending,
  settleJobWorkflowDeletion,
} from '../utils/nodeDeletionLifecycle';

function deletionTransactionKey(nodes) {
  return (Array.isArray(nodes) ? nodes : [])
    .map(node => node?.id)
    .filter(Boolean)
    .sort()
    .join('\u0000');
}

/**
 * Owns the complete deletion boundary for linked files and resumable Job
 * workflows. React Flow awaits `onBeforeDelete`, so an OS prompt, acknowledged
 * cancellation, or failed durable cleanup never briefly unmounts a node and
 * invalidates the very continuation that must be kept when deletion is aborted.
 */
export function useCanvasOSDeletion({
  requestConfirm,
  canvasFilePath = null,
  addToast = null,
  enumerateAllNodes = null,
  getNodes = null,
  getEdges = null,
  setNodes = null,
}) {
  const jobSearchCoordinator = useJobSearchCoordinator();
  const moduleRunQueue = useModuleRunQueue();
  const committedTransactionsRef = useRef(new Map());

  const onBeforeDelete = useCallback(async ({ nodes: requestedNodes, edges: requestedEdges }) => {
    const lockedIds = new Set((requestedNodes || [])
      .filter(node => node?.data?.locked)
      .map(node => node.id));
    const deletedNodes = (requestedNodes || []).filter(node => !lockedIds.has(node?.id));
    const deletedIds = new Set(deletedNodes.map(node => node?.id).filter(Boolean));

    // A request containing only locked nodes is rejected before onNodesDelete
    // can retire their external state. Keep unrelated explicitly selected edges.
    if (deletedNodes.length === 0) {
      return {
        nodes: [],
        edges: (requestedEdges || []).filter(edge => (
          !lockedIds.has(edge?.source) && !lockedIds.has(edge?.target)
        )),
      };
    }

    const allLiveNodes = enumerateAllNodes?.() ?? [];
    const pendingWorkflowIds = markJobWorkflowDeletionPending(deletedNodes);
    const deletedWorkflowIds = new Set(pendingWorkflowIds);
    let lifecycleSettled = false;

    const settlePendingLifecycle = () => {
      if (lifecycleSettled) return;
      lifecycleSettled = true;
      settleJobWorkflowDeletion(pendingWorkflowIds);
    };
    const rejectDeletion = (receipts = null, rollbackNodes = null, rollbackWorkflowIds = deletedWorkflowIds) => {
      // A cancellation acknowledgement can discover a manual-AI run before
      // its renderer pending event. Materialize that exact receipt on the node
      // which is being retained so Retry remains possible.
      if (Array.isArray(rollbackNodes) && typeof setNodes === 'function') {
        setNodes(nodes => restoreJobWorkflowSnapshots(
          nodes,
          rollbackNodes,
          rollbackWorkflowIds,
          receipts,
        ));
      } else if (Array.isArray(receipts) && receipts.length > 0 && typeof setNodes === 'function') {
        setNodes(nodes => applyManualAiRetirementReceiptsToNodes(nodes, receipts));
      }
      settlePendingLifecycle();
      return false;
    };

    const osPaths = collectTrashEligiblePaths(deletedNodes, allLiveNodes);
    const protectedPaths = collectSurvivingRepresentedPaths(deletedNodes, allLiveNodes);
    const orphanTextPaths = textDocumentSessions.filterPathsWithoutLiveAliases(
      collectOrphanTextDocumentPaths(deletedNodes, allLiveNodes),
      collectRemainingTextDocumentPaths(deletedNodes, allLiveNodes),
    );

    let diskChoice = 'keep';
    if (osPaths.length > 0 && window.electronAPI) {
      diskChoice = await new Promise((resolve) => {
        try {
          requestConfirm({
            title: 'Delete from OS?',
            message: 'Do you also want to move the actual linked file(s) and folder(s) to trash?',
            confirmLabel: 'Move to Trash',
            cancelLabel: 'Keep OS File',
            variant: 'warning',
            onConfirm: () => resolve('trash'),
            onCancel: () => resolve('keep'),
            onAbort: () => resolve('abort'),
          });
        } catch (error) {
          EventLogger.error('Failed to open the OS deletion confirmation:', error);
          resolve('abort');
        }
      });
      if (diskChoice === 'abort') return rejectDeletion();
    }

    if (orphanTextPaths.length > 0) {
      try {
        const result = await textDocumentSessions.flushAndSettlePaths(orphanTextPaths);
        if (!result.success) {
          addToast?.({
            title: 'Deletion cancelled',
            description: `Could not safely save ${result.unresolvedFilePaths.join(', ')}. Resolve its text-file conflict or save error, then delete it again.`,
            type: 'error',
          });
          return rejectDeletion();
        }
      } catch (error) {
        addToast?.({
          title: 'Deletion cancelled',
          description: `Could not settle the linked text file: ${error?.message || 'unknown error'}.`,
          type: 'error',
        });
        return rejectDeletion();
      }
    }

    let cleanupSnapshotNodes = null;
    let cleanupDeletedNodes = deletedNodes;
    let cleanupWorkflowIds = deletedWorkflowIds;
    try {
      // The OS prompt can remain open while a Board advances from one selected
      // Search to the next. Re-resolve every plan, marker, and owned card from
      // the live graph immediately before cancellation; the originally clicked
      // snapshot is not authority for an exact child rollback.
      cleanupSnapshotNodes = getNodes?.() ?? deletedNodes;
      const requestedIds = new Set(deletedNodes.map(node => node.id));
      cleanupDeletedNodes = cleanupSnapshotNodes.filter(node => requestedIds.has(node.id));
      for (const original of deletedNodes) {
        if (!cleanupDeletedNodes.some(node => node.id === original.id)) cleanupDeletedNodes.push(original);
      }
      cleanupWorkflowIds = new Set(
        collectDeletedManualAiWorkflowNodes(cleanupDeletedNodes).map(entry => entry.nodeId),
      );
      for (const workflowId of cleanupWorkflowIds) {
        moduleRunQueue.cancelQueuedRunsForNode(workflowId, 'Node deletion pending');
      }
      const liveWorkflowRoots = enumerateAllNodes?.() ?? cleanupSnapshotNodes;
      const liveWorkflowEdges = getEdges?.() ?? requestedEdges ?? [];
      const affectedBoards = collectJobBoardsAffectedByDeletion(
        liveWorkflowRoots,
        liveWorkflowEdges,
        cleanupWorkflowIds,
      );
      const fallbackClaims = [];
      const boardCancellations = affectedBoards.map(async (board) => {
        try {
          const result = await jobSearchCoordinator.cancelBoardModule(board.id, {
            // Deletion is cancelling the Board's current work, not a stale UI
            // snapshot. A null expected id lets the registered component catch
            // an in-memory queued/Combine run before it has published a durable
            // marker; its own identity guards still protect every child run.
            boardRunId: null,
            reason: 'node-deleted',
            suppressToast: true,
          });
          if (result?.cancelled === true) return;
          if (result?.status === 'none') {
            // A mounted Board's handler checks both its in-memory refs and live
            // durable data synchronously. `none` is therefore safe only for a
            // genuinely idle Board; fail closed if the observable graph still
            // carries recovery authority.
            const latestWorkflowRoots = enumerateAllNodes?.() ?? getNodes?.() ?? [];
            const latestBoard = latestWorkflowRoots.find(node => (
              node?.id === board.id && node.type === 'jobboard'
            ));
            if (!latestBoard || !jobBoardHasCancellableRecovery(latestBoard)) return;
          }
          // In particular, `stale` only says the supplied observation lost
          // ownership. It never acknowledges cancellation of the replacement
          // run and therefore cannot authorize a destructive boundary.
          throw new Error(
            result?.error
            || (result?.status === 'stale'
              ? 'The affected Job Board changed while deletion was pending. Try deleting again.'
              : 'The affected Job Board could not be cancelled safely.'),
          );
        } catch (error) {
          if (error?.code !== 'JOB_BOARD_MODULE_UNAVAILABLE') throw error;
          const plan = board.data?.boardScanResume;
          const boardWillBeDeleted = cleanupWorkflowIds.has(board.id);
          const activeSourceIds = [...new Set([
            ...(Array.isArray(plan?.activeSourceIds) ? plan.activeSourceIds : []),
            plan?.activeSourceId,
          ].filter(sourceId => !cleanupWorkflowIds.has(sourceId)))];
          if (
            boardWillBeDeleted
            && plan?.phase === 'searches'
            && activeSourceIds.length > 0
          ) {
            activeSourceIds.forEach(sourceId => {
              fallbackClaims.push({
                orchestratorNodeId: board.id,
                boardRunId: plan.boardRunId,
                sourceId,
                plan,
              });
            });
          } else if (!boardWillBeDeleted && jobBoardHasCancellableRecovery(board)) {
            // A surviving affected Board must be mounted so its renderer queue
            // and durable plan can be cancelled together.
            throw error;
          }
          // An unmounted idle Board has no renderer work to acknowledge. It can
          // be safely ignored; a deleted Board's durable manual-AI receipts are
          // still retired by retireDeletedManualAiRuns below.
        }
      });
      await Promise.all(boardCancellations);
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
              ? 'The deleted Job Board\'s active Search changed while deletion was pending. Try deleting again.'
              : 'The deleted Job Board\'s active Search could not be cancelled safely.',
          );
        }
      });
      // Snapshot task-registry metadata before any fire-and-forget abort can
      // unregister a manual run which has not published its renderer marker.
      await Promise.all(childCancellations);
      await retireDeletedManualAiRuns(cleanupDeletedNodes);
    } catch (error) {
      EventLogger.error('[JobSearch] Deleted node cleanup failed; deletion cancelled:', error);
      addToast?.({
        title: 'Deletion cancelled',
        description: error?.message || 'The saved manual-AI handoff could not be retired safely.',
        type: 'error',
      });
      return rejectDeletion(
        error?.manualAiRetirementReceipts,
        cleanupSnapshotNodes,
        cleanupWorkflowIds,
      );
    }

    if (diskChoice === 'trash') {
      for (const path of osPaths) {
        try {
          const result = await window.electronAPI.deleteOSFile(path, protectedPaths);
          if (!result?.success) {
            addToast?.({
              title: 'File kept on disk',
              description: result?.error || 'The item is still represented by another canvas node and was kept on disk.',
              type: 'warning',
            });
          }
        } catch (error) {
          EventLogger.error('Failed to trash file/folder:', error);
          addToast?.({
            title: 'File kept on disk',
            description: error?.message || 'Could not move the linked item to trash.',
            type: 'warning',
          });
        }
      }
    }

    // Job source/result cards are owned display state. Include them in the
    // same React Flow removal rather than relying on the hub's unmount cleanup,
    // which is deliberately suppressed until this transaction commits.
    const commitLevelNodes = getNodes?.() ?? cleanupSnapshotNodes;
    const commitLevelEdges = getEdges?.() ?? requestedEdges ?? [];
    const ownedChildIds = new Set(commitLevelNodes
      .filter(node => cleanupWorkflowIds.has(node?.data?.hubId))
      .map(node => node.id));
    const committedNodeIds = new Set([...deletedIds, ...ownedChildIds]);
    const committedNodes = commitLevelNodes.filter(node => committedNodeIds.has(node.id));
    for (const node of cleanupDeletedNodes) {
      if (!committedNodeIds.has(node.id)) committedNodes.push(node);
    }
    const requestedEdgeIds = new Set((requestedEdges || [])
      .filter(edge => (
        committedNodeIds.has(edge?.source)
        || committedNodeIds.has(edge?.target)
        || (!lockedIds.has(edge?.source) && !lockedIds.has(edge?.target))
      ))
      .map(edge => edge?.id)
      .filter(Boolean));
    const committedEdges = commitLevelEdges.filter(edge => (
      requestedEdgeIds.has(edge?.id)
      || committedNodeIds.has(edge?.source)
      || committedNodeIds.has(edge?.target)
    ));
    const transactionKey = deletionTransactionKey(committedNodes);
    const pendingCommits = committedTransactionsRef.current.get(transactionKey) || [];
    pendingCommits.push({
      deletedNodes: cleanupDeletedNodes,
      deletedWorkflowIds: cleanupWorkflowIds,
      pendingWorkflowIds,
    });
    committedTransactionsRef.current.set(transactionKey, pendingCommits);
    return { nodes: committedNodes, edges: committedEdges };
  }, [addToast, enumerateAllNodes, getEdges, getNodes, jobSearchCoordinator, moduleRunQueue, requestConfirm, setNodes]);

  const onNodesDelete = useCallback((committedNodes) => {
    const transactionKey = deletionTransactionKey(committedNodes);
    const pendingCommits = committedTransactionsRef.current.get(transactionKey);
    const transaction = pendingCommits?.shift();
    if (!transaction) return;
    if (pendingCommits.length === 0) committedTransactionsRef.current.delete(transactionKey);

    const { deletedNodes, deletedWorkflowIds, pendingWorkflowIds } = transaction;
    const committedIds = new Set((committedNodes || []).map(node => node?.id).filter(Boolean));
    // The normal change batch already removes these nodes. This direct update
    // additionally covers hub-owned cards the user had locked: a lock protects
    // an independently selected node, not an otherwise orphaned child whose
    // owning workflow was just deleted.
    if (typeof setNodes === 'function') {
      setNodes(nodes => nodes.filter(node => !committedIds.has(node.id)));
    }
    // Workflow roots were already cancelled with acknowledgement. This raw
    // post-commit sweep handles ordinary nested node tasks without racing the
    // durable manual-AI registry snapshot above.
    cancelNodeTasksRecursively(deletedNodes, deletedWorkflowIds);

    let analysisCleanupWarningShown = false;
    const showJobCleanupWarning = () => {
      if (analysisCleanupWarningShown) return;
      analysisCleanupWarningShown = true;
      addToast?.({
        title: 'Hub deleted with a warning',
        description: 'An abandoned Job Search run or its saved recovery data could not be fully cleared.',
        type: 'error',
      });
    };
    discardDeletedJobRuns(deletedNodes, canvasFilePath, (error, discard, result) => {
      EventLogger.error(`[JobSearch][${discard.nodeId}] Failed to discard deleted hub run ${discard.runId}:`, error, result);
      showJobCleanupWarning();
    });
    discardDeletedJobAnalysisSnapshots(deletedNodes, canvasFilePath, (error, discard, result) => {
      EventLogger.error(`[JobSearch][${discard.nodeId}] Failed to discard deleted hub analysis recovery:`, error, result);
      showJobCleanupWarning();
    });

    // onNodesDelete fires just before React Flow applies its controlled remove
    // changes. Keep the guard through that commit so component unmount cleanup
    // cannot duplicate or broaden the exact transaction above.
    setTimeout(() => settleJobWorkflowDeletion(pendingWorkflowIds), 0);
  }, [addToast, canvasFilePath, setNodes]);

  return { onBeforeDelete, onNodesDelete };
}
