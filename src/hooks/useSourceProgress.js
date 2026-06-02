import { useState, useEffect, useCallback } from 'react';
import { mergeSourceProgress } from '../utils/sourceProgress';

/**
 * useSourceProgress — subscribe to per-source progress events from the
 * backend and shape them into a `{ [sourceId]: { status, count, warning } }`
 * map that hub UIs render against.
 *
 * Both Job Search Module (job boards) and SellHub (comp sources) emit the same
 * payload shape: `{ nodeId, sourceId, status, count, warning }`. The
 * `warning` field is sticky — completion events sometimes omit it even when
 * an earlier scrape-progress event carried one, so we preserve the last
 * known warning per source until explicitly overwritten.
 *
 * The IPC channel name varies per feature, so the caller passes the
 * subscriber function it gets off `window.electronAPI` (e.g.
 * `window.electronAPI.onJobSourceProgress`). When the subscriber is
 * undefined the hook is a no-op — useful during tests or in browser preview
 * where the preload bridge isn't installed.
 *
 * @param {function|undefined} subscribe   The `electronAPI.on*Progress`
 *                                         function. Receives a callback,
 *                                         returns an unsubscribe cleanup.
 * @param {string} hubId                   The owning hub's node id; events
 *                                         tagged with a different nodeId
 *                                         are dropped (multi-hub safety).
 *
 * @returns {object}  { progress, lastActive, reset }
 *   progress    — { [sourceId]: { status, count, warning } }
 *   lastActive  — the sourceId most recently emitted with status='searching'
 *   reset       — clears the map (e.g. before a fresh re-run)
 */
export function useSourceProgress(subscribe, hubId) {
  const [progress, setProgress] = useState({});
  const [lastActive, setLastActive] = useState(null);

  useEffect(() => {
    if (!subscribe) return undefined;
    const cleanup = subscribe((payload) => {
      const { nodeId, sourceId, status } = payload;
      if (nodeId && nodeId !== hubId) return; // multi-hub safety
      setProgress(prev => ({
        ...prev,
        [sourceId]: mergeSourceProgress(prev?.[sourceId], payload),
      }));
      if (status === 'searching') setLastActive(sourceId);
    });
    return () => cleanup?.();
  }, [subscribe, hubId]);

  const reset = useCallback(() => {
    setProgress({});
    setLastActive(null);
  }, []);

  return { progress, lastActive, reset };
}
