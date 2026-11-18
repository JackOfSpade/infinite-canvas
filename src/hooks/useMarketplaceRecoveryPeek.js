import { useEffect, useRef, useState } from 'react';
import { EventLogger } from '../utils/EventLogger';
import { marketplaceTerminalReceiptApplied } from '../utils/marketplaceRunRecovery';

/**
 * Hydrates a marketplace node's renderer mirror from the canonical main-process
 * recovery sidecar before any restart effect is allowed to run. This closes the
 * debounce window where the sidecar reached disk but the canvas JSON did not.
 * Returns whether the peek for the current canvas and node has finished.
 *
 * - `kind` and `resumeKey` name the sidecar kind and the node data field that
 *   mirrors it.
 * - `isRestorable(recovery)` says whether a found sidecar can be resumed.
 * - `applyRestorable(result)` is called for a restorable sidecar whose terminal
 *   result has not already been applied here, and writes it into the node.
 * - A sidecar the main process has abandoned or completed clears the matching
 *   local mirror, and an exact terminal result already applied after a restart
 *   is acknowledged so the sidecar can be retired.
 */
export function useMarketplaceRecoveryPeek({
  id, canvasFilePath, kind, resumeKey, logTag, recoveryRef, updateGlobal, isRestorable, applyRestorable,
}) {
  const [recoveryHydrated, setRecoveryHydrated] = useState(false);
  const recoveryPeekScopeRef = useRef(null);
  const latestRef = useRef({ isRestorable, applyRestorable });
  useEffect(() => {
    latestRef.current = { isRestorable, applyRestorable };
  }, [isRestorable, applyRestorable]);

  useEffect(() => {
    const scope = `${canvasFilePath || '(unsaved)'}\u0000${id}`;
    if (recoveryPeekScopeRef.current === scope) return undefined;
    recoveryPeekScopeRef.current = scope;
    setRecoveryHydrated(false);
    let disposed = false;
    let hydrated = false;
    void (async () => {
      try {
        if (!canvasFilePath || !window.electronAPI?.peekMarketplaceRecovery) return;
        const result = await window.electronAPI.peekMarketplaceRecovery({
          canvasFilePath, nodeId: id, kind,
        });
        if (disposed || !result?.success) return;
        if (!result.found) {
          const local = recoveryRef.current;
          if (['abandoned', 'completed'].includes(result.status)
            && local?.runId === result.runId
            && local?.inputKey === result.inputKey) {
            recoveryRef.current = null;
            updateGlobal(id, { [resumeKey]: null });
          }
          return;
        }
        if (!latestRef.current.isRestorable(result.recovery)) return;
        if (marketplaceTerminalReceiptApplied(result.recovery, recoveryRef.current)) {
          const acknowledgement = await window.electronAPI?.acknowledgeMarketplaceRecovery?.({
            canvasFilePath,
            nodeId: id,
            kind,
            runId: result.recovery.runId,
            inputKey: result.recovery.inputKey,
            appliedProcessEpoch: recoveryRef.current?.terminalApplied?.appliedProcessEpoch,
            reason: 'exact-terminal-result-observed-after-restart',
          });
          if (!disposed && acknowledgement?.success && acknowledgement?.completed) {
            updateGlobal(id, { [resumeKey]: null });
          }
          return;
        }
        latestRef.current.applyRestorable(result);
      } catch (error) {
        EventLogger.error(`[${logTag}][${id}] Recovery hydration failed:`, error);
      } finally {
        if (!disposed) {
          hydrated = true;
          setRecoveryHydrated(true);
        }
      }
    })();
    return () => {
      disposed = true;
      // The disposed pass never reports hydration, so the next pass must peek
      // again rather than skip on the scope it left behind.
      if (!hydrated && recoveryPeekScopeRef.current === scope) recoveryPeekScopeRef.current = null;
    };
  }, [canvasFilePath, id, updateGlobal, kind, resumeKey, logTag, recoveryRef]);

  return recoveryHydrated;
}
