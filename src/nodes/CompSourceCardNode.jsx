import React, { useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Loader2, CheckCircle2, ShieldAlert, ExternalLink, SkipForward } from 'lucide-react';
import { PlatformBadge } from '../components/PlatformBadge';
import { NodeHandles } from './_shared/NodeHandles';
import { SourceWarningPanel } from './_shared/SourceWarningPanel';
import { mergeSourceProgress } from '../utils/sourceProgress';

/**
 * CompSourceCardNode — ephemeral card spawned by SellHubNode during price
 * research, one per PRICE_COMP_SOURCE. Replaces the orbital ring UX with
 * the same node+edge pattern that MarketplaceCardNode uses in the priced
 * state, so the user sees consistent "real canvas node" controls instead
 * of two different visualizations for the same hub.
 *
 * Lifecycle:
 *   - Spawned with `data.hubId` pointing at the SellHub that owns this run.
 *   - Subscribes to `price-source-progress` events filtered by its sourceId
 *     so each card manages its own status/count independently.
 *   - Cleaned up by the hub when research completes (priced/error/cancel).
 *
 * data shape:
 *   {
 *     sourceId, name, letter, color,   // PRICE_COMP_SOURCES entry
 *     hubId,                           // owning SellHubNode id (multi-hub safety)
 *     ephemeral: true,                 // marker so the hub knows to clean it up
 *   }
 */
export function CompSourceCardNode({ id, data }) {
  // Prime from persistedProgress so a save-quit-reopen during 'comps-ready'
  // restores Solve/Skip buttons without waiting for a fresh progress event
  // (none will arrive — the scrape isn't running on reload).
  const [progress, setProgress] = useState(data.persistedProgress || null);
  const [resolving, setResolving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { deleteElements, updateNodeData, getNode } = useReactFlow();

  // The card can auto-dismiss (3s after a clean 'done') while a Solve/Retry IPC
  // is still in flight; guard the finally setState so it doesn't run after
  // unmount. Matches the isMountedRef pattern every sibling node/hook uses.
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // Hub-cascading lock: when the owning SellHub is locked, Solve/Skip
  // become no-ops. Card stays visible and informational.
  const hubLocked = !!getNode(data.hubId)?.data?.locked;

  useEffect(() => {
    if (!window.electronAPI?.onPriceSourceProgress) return;
    const cleanup = window.electronAPI.onPriceSourceProgress((payload) => {
      // Filter twice — by hub (multi-hub safety) and by source (only my row).
      if (payload?.nodeId && payload.nodeId !== data.hubId) return;
      if (payload?.sourceId !== data.sourceId) return;
      // Carry warning + url forward across events — see mergeSourceProgress
      // for the rationale (per-source completion events sometimes omit fields
      // the earlier scrape-progress event carried).
      setProgress(prev => mergeSourceProgress(prev, payload));
    });
    return () => cleanup?.();
  }, [data.hubId, data.sourceId]);

  // Mirror progress into node data ONLY on terminal states (done / error).
  // The sanitizer keeps comp-source cards only when persistedProgress carries
  // a warning or error, so writing intermediate 'searching' states is wasted
  // — and worse, it dirties the workspace on every progress event during a
  // scrape (~7 sources × multiple updates = constant auto-save churn).
  useEffect(() => {
    if (!progress) return;
    if (progress.status !== 'done' && progress.status !== 'error') return;
    updateNodeData(id, { persistedProgress: progress });
  }, [progress, id, updateNodeData]);

  // Auto-dismiss clean-success cards a few seconds after they report done so
  // the canvas isn't littered with green checkmarks while the user is
  // deciding what to do about the blocked ones. Errored/warned cards stick
  // around indefinitely so the user can act on them.
  useEffect(() => {
    const isCleanDone = progress?.status === 'done' && !progress.warning;
    if (!isCleanDone) return;
    const timeout = setTimeout(() => {
      deleteElements({ nodes: [{ id }] });
    }, 3000);
    return () => clearTimeout(timeout);
  }, [progress?.status, progress?.warning, id, deleteElements]);

  // Open the original scrape URL in a visible browser sharing our scrape
  // userDataDir. The window auto-closes when the challenge is gone (cookies
  // now set for the rest of the TTL). On success, dispatch an event the
  // owning hub catches to auto-trigger a Refresh Prices — the user's
  // captcha solve only buys a short cookie window, so we want the retry
  // to fire immediately while it's still valid.
  const handleResolveCaptcha = async () => {
    if (resolving || hubLocked || !progress?.url || !window.electronAPI?.resolveCaptcha) return;
    setResolving(true);
    try {
      const result = await window.electronAPI.resolveCaptcha({
        url: progress.url,
        sourceId: data.sourceId,
        nodeId: data.hubId,
      });
      if (result?.resolved) {
        // Pass through items extracted inline in the visible browser. The
        // hub listener will merge them directly and skip the headless
        // rescrape (which would re-hit the same anti-bot wall on sites
        // that fingerprint, like Mercari). Category drives which bucket
        // (sold vs. active) the items merge into.
        document.dispatchEvent(new CustomEvent('comp-captcha-resolved', {
          detail: {
            hubId: data.hubId,
            sourceId: data.sourceId,
            items: result.items || null,
            category: result.category || null,
          },
        }));
      }
    } finally {
      if (isMountedRef.current) setResolving(false);
    }
  };

  const status = progress?.status || 'waiting';
  const count  = progress?.count;
  const warning = progress?.warning;
  const isSearching = status === 'searching' || status === 'waiting';
  const isDone      = status === 'done';
  const isError     = status === 'error';
  const hasBlock    = warning?.severity === 'block';
  const hasThrottle = warning?.severity === 'throttle';
  const hasWarn     = warning?.severity === 'warn';

  const statusLine = isError
    ? (hasWarn ? 'HTML changed' : 'Blocked')
    : isDone
      ? `${count ?? 0} found`
      : status === 'searching'
        ? 'Scanning…'
        : 'Queued';

  // Stale-selector errors (warn severity) are amber, not red — they need a code
  // fix, not a captcha solve, and the red accent misleadingly implies a bot block.
  const accentColor = ((isError && !hasWarn) || hasBlock) ? '#ef4444' : (hasThrottle || hasWarn) ? '#f59e0b' : data.color;

  return (
    <div
      className="w-[140px] rounded-xl bg-neutral-900/95 border-2 shadow-lg overflow-hidden"
      style={{ borderColor: `${accentColor}55` }}
    >
      <NodeHandles className="!w-2 !h-2 !bg-white/30 !border-white/10" />

      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <PlatformBadge
          name={data.name}
          letter={data.letter}
          color={accentColor}
          domain={data.domain}
          size={24}
        />
        <div className="flex-1 min-w-0">
          <div className="text-white text-[11px] font-semibold truncate">{data.name}</div>
          <div className="flex items-center gap-1 mt-0.5">
            {isSearching && <Loader2 size={9} className="text-white/40 animate-spin shrink-0" />}
            {isDone && !warning && <CheckCircle2 size={9} className="text-emerald-400 shrink-0" />}
            {((isError && !hasWarn) || hasBlock) && <ShieldAlert size={9} className="text-red-400 shrink-0" />}
            {(hasThrottle || hasWarn) && !hasBlock && <ShieldAlert size={9} className="text-amber-400 shrink-0" />}
            <span
              className="text-[9px] truncate"
              style={{ color: ((isError && !hasWarn) || hasBlock) ? '#fca5a5' : (hasThrottle || hasWarn) ? '#fcd34d' : isDone ? '#a7f3d0' : 'rgba(255,255,255,0.45)' }}
            >
              {warning ? warning.code : statusLine}
            </span>
          </div>
        </div>
      </div>
      {/* Selectable embedded warning text — full evidence + suggestion so the
          user can copy/paste the whole line into a bug report or chat. */}
      <SourceWarningPanel warning={warning} hasBlock={hasBlock} />
      {/* Decision row — action depends on what went wrong:
          stale-selectors (code fix needed) → Retry re-runs the extractor after rebuild.
          bot block → Solve opens the URL in a cookie-shared browser.
          Skip always available so the hub can proceed without this source. */}
      {(warning || isError) && (
        <div className="flex border-t border-white/10">
          {hasWarn ? (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                if (retrying || hubLocked) return;
                const hubProduct = getNode(data.hubId)?.data?.product || {};
                const query = hubProduct.search_query?.trim()
                  || `${hubProduct.brand || ''} ${hubProduct.model || ''} ${hubProduct.generated_title || ''}`.trim();
                if (!query || !window.electronAPI?.rescrapeSource) return;
                setRetrying(true);
                try {
                  const result = await window.electronAPI.rescrapeSource({ sourceId: data.sourceId, query, nodeId: data.hubId });
                  if (result?.items?.length > 0) {
                    document.dispatchEvent(new CustomEvent('comp-captcha-resolved', {
                      detail: { hubId: data.hubId, sourceId: data.sourceId, items: result.items, category: result.category || 'sold' },
                    }));
                  }
                } finally {
                  if (isMountedRef.current) setRetrying(false);
                }
              }}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={retrying || hubLocked}
              className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[9px] font-medium text-white/70 hover:text-white bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-default border-r border-white/10"
              title={hubLocked ? 'Hub is locked' : 'Re-run the extractor — update the scraper code and rebuild first'}
            >
              <ExternalLink size={9} />
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          ) : progress?.url && (
            <button
              onClick={(e) => { e.stopPropagation(); handleResolveCaptcha(); }}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={resolving || hubLocked}
              className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[9px] font-medium text-white/70 hover:text-white bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-default border-r border-white/10"
              title={hubLocked ? 'Hub is locked' : 'Open the failed page so you can solve the captcha — cookies will carry over to the next refresh'}
            >
              <ExternalLink size={9} />
              {resolving ? 'Window open…' : 'Solve'}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (hubLocked) return;
              // Tell the hub to drop this source from its blocked set; hub
              // auto-fires synthesis once nothing's left blocking.
              document.dispatchEvent(new CustomEvent('comp-source-skip', {
                detail: { hubId: data.hubId, sourceId: data.sourceId },
              }));
            }}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={hubLocked}
            className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[9px] font-medium text-white/60 hover:text-white bg-white/[0.03] hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-default"
            title={hubLocked ? 'Hub is locked' : "Price without this source — fine if you don't care about its data this run"}
          >
            <SkipForward size={9} />
            Skip
          </button>
        </div>
      )}
    </div>
  );
}
