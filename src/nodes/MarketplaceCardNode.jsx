import React, { useCallback } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { SELL_PLATFORMS } from '../utils/constants';
import { MonitorStatusBadge } from '../components/MonitorStatusBadge';
import { useMonitorCheck } from '../hooks/useMonitorCheck';

/**
 * MarketplaceCardNode — one persistent canvas node per marketplace the user
 * is selling on. Replaces the old "ring of platform icons" UX:
 *
 *   - The hub no longer auto-posts. The user posts manually on the platform's
 *     site and pastes the resulting listing URL here.
 *   - This card stays on the canvas as the source of truth for that platform's
 *     listing — its URL, its current status, its last-checked time.
 *   - Clicking the hub's "Check All Statuses" walks every connected
 *     MarketplaceCardNode and runs an AI status check on each URL.
 *
 * data shape:
 *   {
 *     platformId: 'ebay' | 'mercari' | ...,
 *     listingUrl: string,
 *     status: 'unknown' | 'live' | 'sold' | 'expired' | 'needs-login' | 'error',
 *     lastChecked: ISO string,
 *     statusMessage: string,
 *     productSnapshot?: { title, price } // copied from parent hub for display
 *   }
 */

export function MarketplaceCardNode({ id, data }) {
  const { updateNodeData } = useReactFlow();

  const platform = SELL_PLATFORMS.find(p => p.id === data.platformId);
  const url = data.listingUrl?.trim() || '';

  const { checking, check: checkStatus } = useMonitorCheck({
    id,
    url,
    platformId: data.platformId,
    locked: !!data.locked,
    updateNode: updateNodeData,
    // The marketplace card uses the default field names (status / statusMessage / lastChecked).
    onMissingUrl: () => {
      updateNodeData(id, {
        status: 'error',
        statusMessage: 'Paste a listing URL first',
        lastChecked: new Date().toISOString(),
      });
    },
  });

  const setUrl = useCallback((newUrl) => {
    updateNodeData(id, { listingUrl: newUrl });
  }, [id, updateNodeData]);

  const openInBrowser = useCallback(() => {
    // No listing URL yet → open the marketplace's "create listing" page so the
    // user can post manually. Once they have a URL pasted, open that instead.
    const target = url || platform?.postUrl;
    if (!target) return;
    window.electronAPI?.openExternal?.(target);
  }, [url, platform]);

  if (!platform) {
    // Defensive: a saved card whose platformId disappeared from constants.
    return (
      <div className="w-[240px] p-3 rounded-2xl bg-red-900/40 border border-red-500/30 text-red-200 text-xs">
        Unknown platform: <code>{data.platformId}</code>
      </div>
    );
  }

  return (
    <div
      className="w-[240px] rounded-2xl bg-neutral-900/95 border-2 shadow-lg overflow-hidden"
      style={{ borderColor: `${platform.color}55` }}
    >
      <Handle type="target" position={Position.Left} className="!bg-white/30 !border-white/10" />

      {/* Header — platform branding */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-white/5"
        style={{ background: `${platform.color}15` }}
      >
        <div
          className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
          style={{ background: platform.color }}
        >
          {platform.letter}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-white text-xs font-semibold truncate">{platform.name}</div>
          {data.productSnapshot?.title && (
            <div className="text-white/40 text-[9px] truncate">{data.productSnapshot.title}</div>
          )}
        </div>
      </div>

      <div className="p-3 space-y-2">
        <MonitorStatusBadge status={data.status || 'unknown'} lastChecked={data.lastChecked} />

        {data.statusMessage && (
          <div className="text-white/40 text-[9px] leading-snug px-1 break-words">
            {data.statusMessage}
          </div>
        )}

        {/* Listing URL input */}
        <div>
          <label className="text-white/40 text-[9px] font-semibold uppercase tracking-wider block mb-1">
            Listing URL
          </label>
          <input
            type="text"
            value={data.listingUrl || ''}
            onChange={(e) => setUrl(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder={`Paste your ${platform.name} listing URL…`}
            disabled={!!data.locked}
            className="nodrag w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-white/80 text-[10px] outline-none focus:border-blue-400/50 disabled:opacity-50"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-1.5">
          <button
            onClick={openInBrowser}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/70 text-[10px] font-medium transition-colors border border-white/10"
            title={data.listingUrl ? `Open listing on ${platform.name}` : `Open ${platform.name} to create a listing`}
          >
            <ExternalLink size={10} />
            {data.listingUrl ? 'Open Listing' : 'Open Site'}
          </button>
          <button
            onClick={checkStatus}
            disabled={checking || data.locked || !data.listingUrl?.trim()}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 text-[10px] font-medium transition-colors border border-blue-500/20 disabled:opacity-40 disabled:cursor-default"
            title="Ask AI to fetch the listing and report its current status"
          >
            <RefreshCw size={10} className={checking ? 'animate-spin' : ''} />
            {checking ? 'Checking…' : 'Check'}
          </button>
        </div>
      </div>
    </div>
  );
}
