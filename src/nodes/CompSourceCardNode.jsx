import React, { useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

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
export function CompSourceCardNode({ data }) {
  const [progress, setProgress] = useState(null); // { status, count } | null = waiting

  useEffect(() => {
    if (!window.electronAPI?.onPriceSourceProgress) return;
    const cleanup = window.electronAPI.onPriceSourceProgress((payload) => {
      // Filter twice — by hub (multi-hub safety) and by source (only my row).
      if (payload?.nodeId && payload.nodeId !== data.hubId) return;
      if (payload?.sourceId !== data.sourceId) return;
      setProgress({ status: payload.status, count: payload.count });
    });
    return () => cleanup?.();
  }, [data.hubId, data.sourceId]);

  const status = progress?.status || 'waiting';
  const count  = progress?.count;
  const isSearching = status === 'searching' || status === 'waiting';
  const isDone      = status === 'done';
  const isError     = status === 'error';

  const statusLine = isError
    ? 'Blocked'
    : isDone
      ? `${count ?? 0} found`
      : status === 'searching'
        ? 'Scanning…'
        : 'Queued';

  const accentColor = isError ? '#ef4444' : data.color;

  return (
    <div
      className="w-[140px] rounded-xl bg-neutral-900/95 border-2 shadow-lg overflow-hidden"
      style={{ borderColor: `${accentColor}55` }}
    >
      <Handle type="target" position={Position.Left} className="!bg-white/30 !border-white/10" />

      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <div
          className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
          style={{ background: accentColor }}
        >
          {data.letter}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-white text-[11px] font-semibold truncate">{data.name}</div>
          <div className="flex items-center gap-1 mt-0.5">
            {isSearching && <Loader2 size={9} className="text-white/40 animate-spin shrink-0" />}
            {isDone && <CheckCircle2 size={9} className="text-emerald-400 shrink-0" />}
            {isError && <AlertCircle size={9} className="text-red-400 shrink-0" />}
            <span
              className="text-[9px] truncate"
              style={{ color: isError ? '#fca5a5' : isDone ? '#a7f3d0' : 'rgba(255,255,255,0.45)' }}
            >
              {statusLine}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
