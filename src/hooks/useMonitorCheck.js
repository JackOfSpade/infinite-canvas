import { useCallback, useEffect, useRef, useState } from 'react';
import { EventLogger } from '../utils/EventLogger';
import { statusCheckWrites, statusErrorWrites } from '../utils/listingStatusWrites';

const DEFAULT_FIELDS = { status: 'status', message: 'statusMessage', lastChecked: 'lastChecked', attention: 'attention' };

/**
 * Per-card AI status check against the `check-listing-status` IPC. Used by
 * MarketplaceCardNode (the transient-card overhaul removed job-card monitoring,
 * so JobCardNode no longer uses this).
 *
 * Always defers the "is there anything to check" decision to the backend.
 * Per-platform watch URLs (configured in Settings) live in the main process
 * and are merged into the URL list there, so a renderer-side short-circuit
 * on empty `url`/`watchUrls` would false-positive when only per-platform
 * URLs are configured. The backend returns a structured 'error' status with
 * "No URLs to check..." when truly nothing is available, which the hook
 * writes through to node data the same as any other error.
 *
 * @param {object} opts
 * @param {string} opts.id — node id (target of updateNode)
 * @param {string} opts.url — listing URL (may be empty if watchUrls or per-platform URLs cover it)
 * @param {string} opts.platformId — provider tag (drives per-platform watch URL lookup + auth routing)
 * @param {string[]} [opts.watchUrls] — extra URLs to scan (notification feed, dashboard) for this listing
 * @param {string} [opts.productTitle] — fallback identifier when the URL has no recognizable item id
 * @param {boolean} [opts.locked]
 * @param {{status, message, lastChecked}} [opts.fields] — node-data keys to write
 * @param {(id, patch) => void} opts.updateNode
 * @returns {{ checking: boolean, check: () => Promise<void> }}
 */
export function useMonitorCheck({
  id,
  url,
  platformId,
  watchUrls = [],
  productTitle,
  locked = false,
  fields = DEFAULT_FIELDS,
  updateNode,
}) {
  const [checking, setChecking] = useState(false);
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const check = useCallback(async () => {
    if (checking || locked) return;

    setChecking(true);
    try {
      const res = await window.electronAPI?.checkListingStatus?.({
        url,
        platformId,
        nodeId: id,
        watchUrls,
        productTitle,
      });
      if (!isMountedRef.current) return;
      updateNode(id, statusCheckWrites(res, fields));
    } catch (err) {
      EventLogger.error('[useMonitorCheck] failed:', err);
      if (!isMountedRef.current) return;
      updateNode(id, statusErrorWrites(err, fields));
    } finally {
      if (isMountedRef.current) setChecking(false);
    }
  }, [checking, locked, url, platformId, watchUrls, productTitle, id, fields, updateNode]);

  return { checking, check };
}
