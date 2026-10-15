import { useEffect, useRef, useState } from 'react';

// Display names travel only through this direct, ephemeral IPC read. They are
// never added to bridge status, activity, canvas state, or bug-report fields.
export function useBridgeLaunchAccounts(status) {
  const [names, setNames] = useState({ generation: null, values: {} });
  const requested = useRef(new Set());
  const activeGeneration = useRef(null);
  useEffect(() => {
    const pool = status?.chat?.pool;
    if (!pool?.active || !Number.isInteger(pool.generation)) {
      activeGeneration.current = null;
      requested.current.clear();
      return;
    }
    if (activeGeneration.current !== pool.generation) {
      activeGeneration.current = pool.generation;
      requested.current.clear();
    }
    for (const worker of pool.workers || []) {
      if (!['plugin_missing', 'reconnect_required'].includes(worker.launch?.reason)) continue;
      const key = `${pool.generation}:${worker.ordinal}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      const read = window.electronAPI?.handoffBridgeGetLaunchAccount;
      if (typeof read !== 'function') continue;
      void read({ generation: pool.generation, workerOrdinal: worker.ordinal }).then(result => {
        if (activeGeneration.current !== pool.generation) return;
        if (result?.success === true && typeof result.displayName === 'string' && result.displayName.length <= 80) {
          setNames(current => ({ generation: pool.generation,
            values: { ...(current.generation === pool.generation ? current.values : {}), [key]: result.displayName } }));
        }
      }).catch(() => {});
    }
  }, [status]);
  return (generation, workerOrdinal) => names.generation === generation
    ? names.values[`${generation}:${workerOrdinal}`] || '' : '';
}
