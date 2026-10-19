import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useModuleRunQueue } from '../contexts/useModuleRunQueue';
import { useJobSearchCoordinator } from '../contexts/useJobSearchCoordinator';
import { createQuitWorkflowPauseCoordinator } from '../utils/quitWorkflowPause';
import { settlePreFenceCanvasBatches } from '../utils/quitCommitSettle';

export function useQuitWorkflowPause({ navigation, getCurrentFile }) {
  const queue = useModuleRunQueue();
  const registry = useJobSearchCoordinator();
  const context = useRef({ navigation, getCurrentFile, queue, registry });
  useLayoutEffect(() => { context.current = { navigation, getCurrentFile, queue, registry }; }, [navigation, getCurrentFile, queue, registry]);
  const [coordinator] = useState(() => createQuitWorkflowPauseCoordinator({
    enumerateNodes: () => context.current.navigation.enumerateAllNodes(),
    updateNode: (...args) => context.current.navigation.updateNodeDataGlobally(...args),
    currentFile: () => context.current.getCurrentFile(),
    queue: {
      suspendAdmissions: () => context.current.queue.suspendAdmissions(),
      getSnapshot: () => context.current.queue.getSnapshot(),
      cancelQueuedRunsOwnedByNode: (...args) => context.current.queue.cancelQueuedRunsOwnedByNode(...args),
      waitForActiveRunsToSettle: (...args) => context.current.queue.waitForActiveRunsToSettle(...args),
    },
    registry: {
      pauseBoardModule: (...args) => context.current.registry.pauseBoardModule(...args),
      pauseSearchModule: (...args) => context.current.registry.pauseSearchModule(...args),
    },
    api: {
      peekJobRun: (...args) => window.electronAPI?.peekJobRun?.(...args),
      pauseJobRunAndCancel: (...args) => window.electronAPI?.pauseJobRunAndCancel?.(...args),
    },
    waitForCommit: settlePreFenceCanvasBatches,
  }));
  const pauseWorkflowsForQuit = useCallback(options => coordinator.pause(options), [coordinator]);
  const releaseQuitPause = useCallback(() => coordinator.release(), [coordinator]);
  return { pauseWorkflowsForQuit, releaseQuitPause };
}
