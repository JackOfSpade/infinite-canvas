import React, { useMemo, useState } from 'react';
import { createModuleRunQueue } from '../utils/moduleRunQueue';
import { ModuleRunQueueContext } from './moduleRunQueueShared';

export function ModuleRunQueueProvider({ children }) {
  const [snapshot, setSnapshot] = useState({ active: null, queued: [] });
  const [queue] = useState(() => createModuleRunQueue({ onChange: setSnapshot }));

  const value = useMemo(() => ({
    acquireModuleRun: queue.acquireModuleRun,
    runExclusive: queue.runExclusive,
    cancelQueuedRunsForNode: queue.cancelQueuedRunsForNode,
    getSnapshot: queue.getSnapshot,
    snapshot,
  }), [queue, snapshot]);

  return (
    <ModuleRunQueueContext.Provider value={value}>
      {children}
    </ModuleRunQueueContext.Provider>
  );
}
