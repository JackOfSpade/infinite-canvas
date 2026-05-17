import { useCallback, useEffect, useRef, useState } from 'react';
import { EventLogger } from '../utils/EventLogger';

const DEFAULT_FIELDS = { status: 'status', message: 'statusMessage', lastChecked: 'lastChecked' };

/**
 * Per-card AI status check against the `check-listing-status` IPC. Used by
 * MarketplaceCardNode and JobCardNode — both perform exactly the same call,
 * only the field names they write back to node data differ.
 *
 * @param {object} opts
 * @param {string} opts.id — node id (target of updateNode)
 * @param {string} opts.url — URL to check; empty string short-circuits to onMissingUrl
 * @param {string} opts.platformId — provider tag for logging / future per-platform branching
 * @param {boolean} [opts.locked]
 * @param {{status, message, lastChecked}} [opts.fields] — node-data keys to write
 * @param {(id, patch) => void} opts.updateNode — caller picks updateNodeData vs nav.updateNodeDataGlobally
 * @param {() => void} [opts.onMissingUrl]
 * @returns {{ checking: boolean, check: () => Promise<void> }}
 */
export function useMonitorCheck({
  id,
  url,
  platformId,
  locked = false,
  fields = DEFAULT_FIELDS,
  updateNode,
  onMissingUrl,
}) {
  const [checking, setChecking] = useState(false);
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  const check = useCallback(async () => {
    if (checking || locked) return;
    if (!url) { onMissingUrl?.(); return; }

    setChecking(true);
    try {
      const res = await window.electronAPI?.checkListingStatus?.({ url, platformId, nodeId: id });
      if (!isMountedRef.current) return;
      const writes = { [fields.lastChecked]: new Date().toISOString() };
      if (res?.success) {
        writes[fields.status]  = res.status || 'unknown';
        writes[fields.message] = res.message || '';
      } else {
        writes[fields.status]  = 'error';
        writes[fields.message] = res?.error || 'Status check failed';
      }
      updateNode(id, writes);
    } catch (err) {
      EventLogger.error('[useMonitorCheck] failed:', err);
      if (!isMountedRef.current) return;
      updateNode(id, {
        [fields.status]:      'error',
        [fields.message]:     err?.message || String(err),
        [fields.lastChecked]: new Date().toISOString(),
      });
    } finally {
      if (isMountedRef.current) setChecking(false);
    }
  }, [checking, locked, url, platformId, id, fields, updateNode, onMissingUrl]);

  return { checking, check };
}
