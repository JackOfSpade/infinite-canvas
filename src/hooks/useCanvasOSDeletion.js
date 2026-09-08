import { useCallback } from 'react';
import { EventLogger } from '../utils/EventLogger';
import { cancelNodeTasksRecursively, discardDeletedJobAnalysisSnapshots, discardDeletedJobRuns } from '../utils/canvasInteractions';
import { collectOrphanTextDocumentPaths, collectRemainingTextDocumentPaths, collectSurvivingRepresentedPaths, collectTrashEligiblePaths } from '../utils/osDeletionPaths';
import { textDocumentSessions } from '../utils/textDocumentSessions';

/**
 * Recursively collects OS file/folder paths from a node tree, for the "also move
 * the linked file(s) to trash?" prompt on delete.
 *
 * ONLY nodes that ARE the canvas's representation of a file/folder contribute:
 * - document nodes: their own filePath.
 * - listing nodes: their filePath + image assets.
 * - group nodes created from a folder drag: the folder path.
 * - organic sub-canvas groups: recurses into children.
 *
 * Workflow/aggregator HUBS (sellhub, jobhub) deliberately do NOT contribute.
 * A hub merely REFERENCES external user files it was handed to work on — a
 * SellHub's product photos, a Job Search Module's dropped resume — which the user owns
 * (and, for a SellHub, are usually still represented by the source document
 * nodes left on the canvas, so trashing them would orphan those). Deleting a
 * hub cancels its run (see onNodesDelete); it must NOT offer to trash the
 * user's resume/photos. This is the fix for "deleting a hub mid-run asks to
 * keep the file on disk."
 */
export function useCanvasOSDeletion({ requestConfirm, undo, canvasFilePath = null, addToast = null, enumerateAllNodes = null }) {
  const onNodesDelete = useCallback((deletedNodes) => {
    // The ignored-ID scan is independent of React Flow's callback ordering:
    // onNodesDelete runs before its controlled remove change has committed.
    // It prevents deleting one duplicate node from offering to trash the file
    // still represented by another node (including inside a nested canvas).
    const allLiveNodes = enumerateAllNodes?.() ?? [];
    const osPaths = collectTrashEligiblePaths(deletedNodes, allLiveNodes);
    const protectedPaths = collectSurvivingRepresentedPaths(deletedNodes, allLiveNodes);
    const orphanTextPaths = textDocumentSessions.filterPathsWithoutLiveAliases(
      collectOrphanTextDocumentPaths(deletedNodes, allLiveNodes),
      collectRemainingTextDocumentPaths(deletedNodes, allLiveNodes),
    );
    let analysisCleanupWarningShown = false;

    const settleOrphanTextDocuments = async () => {
      if (orphanTextPaths.length === 0) return true;
      try {
        const result = await textDocumentSessions.flushAndSettlePaths(orphanTextPaths);
        if (result.success) return true;
        undo?.();
        addToast?.({
          title: 'Deletion restored',
          description: `Could not safely save ${result.unresolvedFilePaths.join(', ')}. Resolve its text-file conflict or save error, then delete it again.`,
          type: 'error',
        });
      } catch (error) {
        undo?.();
        addToast?.({
          title: 'Deletion restored',
          description: `Could not settle the linked text file: ${error?.message || 'unknown error'}.`,
          type: 'error',
        });
      }
      return false;
    };

    // Commit all background lifecycle cleanup at the same boundary as the
    // canvas deletion. When the OS-file prompt is present its X/Escape/backdrop
    // path calls undo(), so cancelling/retiring before that choice would restore
    // a paused Job Search hub after already deleting its recovery data.
    const finalizeNodeDeletion = () => {
      if (window.electronAPI?.cancelNodeTask) {
        cancelNodeTasksRecursively(deletedNodes);
      }
      // A paused Job Search has no active IPC for cancelNodeTask to unwind.
      // Retire its exact durable run explicitly or its canvas-global manifest
      // will keep every surviving hub locked behind an owner that no longer
      // exists. Use the deleted node snapshot (not component unmount) so
      // navigating between nested canvases never discards legitimate work.
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
      // Job cards are disposable result-display nodes. Deleting a card, clearing
      // a Job Board, or replacing a board cascade must not cancel the independent
      // Local AI writer session represented by that card. A later successful
      // regeneration cleans only the exact terminal handoff it replaces.
    };

    if (osPaths.length > 0 && window.electronAPI) {
      requestConfirm({
        title: 'Delete from OS?',
        message: 'Do you also want to move the actual linked file(s) and folder(s) to trash?',
        confirmLabel: 'Move to Trash',
        cancelLabel: 'Keep OS File',
        variant: 'warning',
        onConfirm: async () => {
          if (!await settleOrphanTextDocuments()) return;
          finalizeNodeDeletion();
          for (const path of osPaths) {
            // Proceed with OS deletion even if unmounted because user confirmed
            try {
              const result = await window.electronAPI.deleteOSFile(path, protectedPaths);
              if (!result?.success) {
                addToast?.({
                  title: 'File kept on disk',
                  description: result?.error || 'The item is still represented by another canvas node and was kept on disk.',
                  type: 'warning',
                });
              }
            } catch (err) {
              EventLogger.error('Failed to trash file/folder:', err);
              addToast?.({
                title: 'File kept on disk',
                description: err?.message || 'Could not move the linked item to trash.',
                type: 'warning',
              });
            }
          }
        },
        // Declining disk deletion still commits the already-applied canvas
        // deletion, so retire its tasks and exact recovery ownership too.
        onCancel: async () => {
          if (!await settleOrphanTextDocuments()) return;
          finalizeNodeDeletion();
        },
        // X-in-the-corner: roll the canvas back so the nodes that triggered
        // this dialog reappear. ReactFlow has already pushed the deletion
        // onto the undo stack by the time onNodesDelete fires, so one undo()
        // restores both nodes and their edges. OS files were never touched
        // (we only trash on Confirm), so nothing to clean up on disk.
        onAbort: undo ? () => undo() : undefined,
      });
    } else {
      void (async () => {
        if (!await settleOrphanTextDocuments()) return;
        finalizeNodeDeletion();
      })();
    }
  }, [requestConfirm, undo, canvasFilePath, addToast, enumerateAllNodes]);

  return { onNodesDelete };
}
