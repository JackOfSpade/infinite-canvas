import { useCallback, useEffect, useRef, useState } from 'react';
import { EventLogger } from '../utils/EventLogger';
import { statusCheckWrites, statusErrorWrites } from '../utils/listingStatusWrites';
import { useToast } from '../components/ToastProvider';

const DEFAULT_FIELDS = { status: 'status', message: 'statusMessage', lastChecked: 'lastChecked', attention: 'attention', trace: 'lastCheckTrace' };

/**
 * Per-card AI status check against the `check-listing-status` IPC. Used by
 * MarketplaceCardNode (the transient-card overhaul removed job-card monitoring,
 * so JobCardNode no longer uses this).
 *
 * A listing URL is required. Watch URLs are supplemental context for that
 * listing, not an identity source for a blank card. Per-platform watch URLs
 * (configured in Settings) live in the main process and are merged into the
 * URL list there after the backend validates the listing URL.
 *
 * @param {object} opts
 * @param {string} opts.id — node id (target of updateNode)
 * @param {string} opts.url — listing URL
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
  const { addToast } = useToast();
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
      if (res?.status === 'needs-login') {
        addToast({
          title: `${platformId || 'Marketplace'} login needed`,
          description: res.message || 'Refresh the marketplace login in Settings, then run Check again.',
          type: 'error',
          duration: 7000,
        });
      } else if (!res?.status || res?.status === 'error') {
        addToast({
          title: 'Status check failed',
          description: res?.message || res?.error || 'The listing status check did not complete.',
          type: 'error',
        });
      }
    } catch (err) {
      EventLogger.error('[useMonitorCheck] failed:', err);
      if (!isMountedRef.current) return;
      updateNode(id, statusErrorWrites(err, fields));
      addToast({
        title: 'Status check failed',
        description: err?.message || String(err),
        type: 'error',
      });
    } finally {
      if (isMountedRef.current) setChecking(false);
    }
  }, [checking, locked, url, platformId, watchUrls, productTitle, id, fields, updateNode, addToast]);

  return { checking, check };
}
