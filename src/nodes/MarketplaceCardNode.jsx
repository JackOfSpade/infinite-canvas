import React, { useCallback } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { ExternalLink } from 'lucide-react';
import { SELL_PLATFORM_BY_ID } from '../utils/constants';
import { PlatformBadge } from '../components/PlatformBadge';

/**
 * MarketplaceCardNode — one persistent canvas node per marketplace the user is
 * selling on. Spawned by a Price Check Module (sellhub) after pricing.
 *
 *   - The hub no longer auto-posts. The user posts manually on the platform's
 *     site and pastes the resulting listing URL here.
 *   - This card stays on the canvas as the record of that platform's listing —
 *     its platform + the listing URL.
 *
 * Status monitoring is no longer per-card. The Marketplace Status Module
 * (`marketplacestatus`) auto-detects these cards across the canvas and checks
 * each platform's aggregate notification hub instead — so there's no per-listing
 * Check button here anymore.
 *
 * data shape:
 *   {
 *     platformId: 'ebay' | 'mercari' | ...,
 *     listingUrl: string,
 *     productSnapshot?: { title, price } // copied from parent hub for display
 *   }
 */

export function MarketplaceCardNode({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const platform = SELL_PLATFORM_BY_ID[data.platformId];
  const url = data.listingUrl?.trim() || '';

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
        <PlatformBadge
          name={platform.name}
          letter={platform.letter}
          color={platform.color}
          domain={platform.domain}
          size={24}
        />
        <div className="flex-1 min-w-0">
          <div className="text-white text-xs font-semibold truncate">{platform.name}</div>
          {data.productSnapshot?.title && (
            <div className="text-white/40 text-[9px] truncate">{data.productSnapshot.title}</div>
          )}
        </div>
      </div>

      <div className="p-3 space-y-2">
        {/* Listing URL input */}
        <div>
          <label className="text-white/40 text-[9px] font-semibold uppercase tracking-wider block mb-1">
            Listing URL
          </label>
          <input
            type="text"
            data-native-undo="true"
            value={data.listingUrl || ''}
            onChange={(e) => setUrl(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder={`Paste your ${platform.name} listing URL…`}
            disabled={!!data.locked}
            className="nodrag w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-white/80 text-[10px] outline-none focus:border-blue-400/50 disabled:opacity-50"
          />
        </div>

        {/* Open on the marketplace */}
        <button
          onClick={openInBrowser}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/70 text-[10px] font-medium transition-colors border border-white/10"
          title={data.listingUrl ? `Open listing on ${platform.name}` : `Open ${platform.name} to create a listing`}
        >
          <ExternalLink size={10} />
          {data.listingUrl ? 'Open Listing' : 'Open Site'}
        </button>
      </div>
    </div>
  );
}
