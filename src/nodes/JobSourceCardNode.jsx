import React, { useEffect, useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { Loader2, CheckCircle2, AlertCircle, Filter } from 'lucide-react';

/**
 * JobSourceCardNode — persistent canvas node representing one job source
 * (LinkedIn, Indeed, Greenhouse, etc.) that a JobHubNode searches against.
 *
 * Replaces the orbital ring of source icons. Each card is a real ReactFlow
 * node connected to its hub by a native edge, leaving room for per-platform
 * features to grow on each card later (login state, custom filters, etc.).
 *
 * Lifecycle:
 *   - Spawned by the owning JobHubNode the first time its pipeline runs.
 *   - Reused across re-runs — the hub looks up existing cards by hubId+sourceId
 *     before deciding what to spawn.
 *   - Subscribes to `job-source-progress` events filtered by its sourceId.
 *   - Falls back to the hub's `data.finalSourceCounts` between runs so the
 *     last-known count is still visible after Electron restart.
 *   - Clicking the card dispatches `job-source-filter-toggle` so the hub can
 *     toggle its source filter (the same UX the old ring icons offered).
 *
 * data shape:
 *   {
 *     sourceId, name, letter, color,  // JOB_SOURCES entry
 *     hubId,                          // owning JobHubNode id (multi-hub safety)
 *   }
 */
export function JobSourceCardNode({ data }) {
  const { getNode } = useReactFlow();
  const [progress, setProgress] = useState(null); // { status, count } | null

  useEffect(() => {
    if (!window.electronAPI?.onJobSourceProgress) return;
    const cleanup = window.electronAPI.onJobSourceProgress((payload) => {
      if (payload?.nodeId && payload.nodeId !== data.hubId) return;
      if (payload?.sourceId !== data.sourceId) return;
      setProgress({ status: payload.status, count: payload.count });
    });
    return () => cleanup?.();
  }, [data.hubId, data.sourceId]);

  // Hub state is read fresh on every render so changes (filter, finalCounts,
  // hubState) flow through without a separate subscription on this card.
  const hub = getNode(data.hubId);
  const hubData = hub?.data || {};
  const isFiltered = hubData.sourceFilter === data.sourceId;
  const hubBusy = ['parsing', 'querying', 'searching', 'scoring'].includes(hubData.hubState);
  const fallbackCount = hubData.finalSourceCounts?.[data.sourceId];

  // Pick what to display. Live progress wins; otherwise show the last-known
  // count from the most recent completed run, otherwise neutral idle.
  let status;
  let count;
  if (progress) {
    status = progress.status;
    count  = progress.count;
  } else if (fallbackCount != null) {
    status = 'done';
    count  = fallbackCount;
  } else {
    status = hubBusy ? 'searching' : 'idle';
    count  = undefined;
  }

  const isSearching = status === 'searching';
  const isDone      = status === 'done';
  const isError     = status === 'error';

  const statusLine = isError
    ? 'Failed'
    : isDone
      ? `${count ?? 0} jobs`
      : isSearching
        ? 'Searching…'
        : 'Idle';

  const accentColor = isError ? '#ef4444' : data.color;

  const handleClick = (e) => {
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent('job-source-filter-toggle', {
      detail: { hubId: data.hubId, sourceId: data.sourceId },
    }));
  };

  return (
    <div
      onClick={handleClick}
      onPointerDown={(e) => e.stopPropagation()}
      className={`nodrag w-[140px] rounded-xl bg-neutral-900/95 border-2 shadow-lg overflow-hidden cursor-pointer transition-all hover:brightness-110 ${
        isFiltered ? 'ring-2 ring-offset-1 ring-offset-black' : ''
      }`}
      style={{
        borderColor: `${accentColor}55`,
        ...(isFiltered ? { '--tw-ring-color': accentColor } : {}),
      }}
      title={`Click to ${isFiltered ? 'show all sources' : `filter to ${data.name} only`}`}
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
          <div className="text-white text-[11px] font-semibold truncate flex items-center gap-1">
            {data.name}
            {isFiltered && <Filter size={8} className="text-white/60 shrink-0" />}
          </div>
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
