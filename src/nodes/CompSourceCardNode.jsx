import React, { useEffect, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Loader2, CheckCircle2, ShieldAlert, ExternalLink, SkipForward } from 'lucide-react';
import { PlatformBadge } from '../components/PlatformBadge';
import { NodeHandles } from './_shared/NodeHandles';
import { SourceWarningPanel } from './_shared/SourceWarningPanel';
import { mergeSourceProgress } from '../utils/sourceProgress';
import { useIsMountedRef } from '../hooks/useIsMountedRef';

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
 *   - Clean cards dismiss together ~10s after every card is terminal, via the
 *     hub's `comp-source-dismiss-clean` event; blocked ones stay until acted on.
 *   - Also reaped by the hub when research completes (priced/error/cancel).
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
  // How many sell-side browser ops are ahead of this card's Solve while it waits
  // for the shared-browser lock (marketplaceBrowserLock). 0 = not waiting.
  const [queuedAhead, setQueuedAhead] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const { deleteElements, updateNodeData, getNode } = useReactFlow();

  // The card can be dismissed by the hub's grace timer while a Solve/Retry IPC
  // is still in flight; guard the finally setState so it doesn't run after
  // unmount.
  const isMountedRef = useIsMountedRef();

  // Hub-cascading lock: when the owning SellHub is locked, Solve/Skip
  // become no-ops. Card stays visible and informational.
  const hubData = getNode(data.hubId)?.data || {};
  const hubLocked = !!hubData.locked || hubData.hubState === 'queued';

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

  // While this card's Solve is queued behind another sell-side browser op the
  // backend emits queuedBehind>0 (then 0 once it acquires the shared browser).
  // Reflect it on the button so a queued resolve reads "Queued…" instead of a
  // misleading "Window open…" while no window has actually opened yet.
  useEffect(() => {
    if (!window.electronAPI?.onPriceQueueStatus) return;
    const cleanup = window.electronAPI.onPriceQueueStatus((payload) => {
      if (payload?.nodeId && payload.nodeId !== data.hubId) return;
      // Only MY own resolve's queue position — a per-node event is broadcast to
      // every card, so without the sourceId filter a sibling card queuing behind
      // me would corrupt my "Window open…" into "Queued…". The hub scrape's
      // emit carries no sourceId and is correctly ignored here (hub-level only).
      if (payload?.sourceId !== data.sourceId) return;
      setQueuedAhead(payload?.queuedBehind || 0);
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

  // The owning SellHub coordinates clean-card dismissal: all comp-source cards
  // stay visible as a set during the price check, then the clean ones dismiss
  // TOGETHER ~10s after EVERY card has reached a terminal state (the hub fires
  // `comp-source-dismiss-clean`). Purely visual — synthesis already ran — so the
  // user gets a steady "all sources done" FYI instead of cards popping away one
  // by one. Errored/warned cards ignore the event and stay actionable. Mirrors
  // JobSourceCardNode + Job Search Module's job-source-dismiss-clean.
  useEffect(() => {
    const onDismiss = (event) => {
      if (event.detail?.hubId !== data.hubId) return;
      const isCleanTerminal = progress?.status === 'done' && !progress.warning;
      if (!isCleanTerminal) return;
      deleteElements({ nodes: [{ id }] });
    };
    document.addEventListener('comp-source-dismiss-clean', onDismiss);
    return () => document.removeEventListener('comp-source-dismiss-clean', onDismiss);
  }, [data.hubId, progress?.status, progress?.warning, id, deleteElements]);

  // Open the original scrape URL in a visible browser sharing our scrape
  // userDataDir. The window auto-closes when the challenge is gone (cookies
  // now set for the rest of the TTL). On success, dispatch an event the
  // owning hub catches to auto-trigger a Refresh Prices — the user's
  // captcha solve only buys a short cookie window, so we want the retry
  // to fire immediately while it's still valid.
  const handleResolveCaptcha = async () => {
    if (resolving || hubLocked || !progress?.url || !window.electronAPI?.resolveCaptcha) return;
    setQueuedAhead(0);
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
            warning: result.warning || null,
            // The visible window auto-resolved without ever seeing a challenge
            // widget → there is no wall to clear, so a low/empty result is the
            // page's real answer. Lets the hub clear the gate instead of re-arming
            // an unclearable Solve (the eBay "1 result" loop) on the single-item path.
            noChallengeConfirmed: result.diag?.sawChallenge === false,
          },
        }));
      }
    } finally {
      if (isMountedRef.current) { setResolving(false); setQueuedAhead(0); }
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
          sources without a browser URL → Retry directly.
          Skip always available so the hub can proceed without this source. */}
      {(warning || isError) && (
        <div className="flex border-t border-white/10">
          {(hasWarn || !progress?.url) ? (
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
                      detail: {
                        hubId: data.hubId,
                        sourceId: data.sourceId,
                        items: result.items,
                        category: result.category || 'sold',
                        warning: result.warning || null,
                      },
                    }));
                  }
                } finally {
                  if (isMountedRef.current) setRetrying(false);
                }
              }}
              onPointerDown={(e) => e.stopPropagation()}
              disabled={retrying || hubLocked}
              className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[9px] font-medium text-white/70 hover:text-white bg-white/5 hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-default border-r border-white/10"
              title={hubLocked
                ? 'Hub is locked'
                : hasWarn
                  ? 'Re-run the extractor — update the scraper code and rebuild first'
                  : 'Retry this source'}
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
              {resolving ? (queuedAhead > 0 ? `Queued behind ${queuedAhead}…` : 'Window open…') : 'Solve'}
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
