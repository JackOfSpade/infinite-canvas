import React, { useCallback, useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { ExternalLink, RefreshCw, Eye, ChevronDown, ChevronRight, AlertTriangle, Info } from 'lucide-react';
import { SELL_PLATFORM_BY_ID } from '../utils/constants';
import { MonitorStatusBadge } from '../components/MonitorStatusBadge';
import { PlatformBadge } from '../components/PlatformBadge';
import { useMonitorCheck } from '../hooks/useMonitorCheck';
import { useSyncWhileFocused } from '../hooks/useSyncWhileFocused';

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
 *     status: 'unknown' | 'live' | 'sold' | 'ended' | 'needs-login' | 'error',
 *     lastChecked: ISO string,
 *     statusMessage: string,
 *     attention?: Array<{ urgency: 'high' | 'low', category: string, headline: string, evidence: string }>,
 *     productSnapshot?: { title, price } // copied from parent hub for display
 *   }
 */

export function MarketplaceCardNode({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const [watchOpen, setWatchOpen] = useState(false);
  // Sync the editable draft from data.watchUrls when not focused, so an external
  // change (undo/redo, hub re-spawning the card) isn't left stale in the textarea
  // — and a subsequent blur doesn't clobber the real saved URLs with a stale
  // draft. Mirrors SettingsPanel's PlatformWatchUrlsRow, which fixed this exact
  // once-initialized-useState bug.
  const { value: watchDraft, setValue: setWatchDraft, focusProps: watchFocusProps, focusRef: watchFocusRef } =
    useSyncWhileFocused((data.watchUrls || []).join('\n'));

  const platform = SELL_PLATFORM_BY_ID[data.platformId];
  const url = data.listingUrl?.trim() || '';
  const watchUrls = Array.isArray(data.watchUrls) ? data.watchUrls : [];

  // Uses the default field names (status / statusMessage / lastChecked).
  // Per-platform watch URLs (configured in Settings) are merged in by the
  // backend, but a listing URL is still required so those pages can be anchored
  // to a specific marketplace listing.
  const { checking, check: checkStatus } = useMonitorCheck({
    id,
    url,
    platformId: data.platformId,
    watchUrls,
    productTitle: data.productSnapshot?.title,
    locked: !!data.locked,
    updateNode: updateNodeData,
  });

  const setUrl = useCallback((newUrl) => {
    updateNodeData(id, { listingUrl: newUrl });
  }, [id, updateNodeData]);

  const saveWatchUrls = useCallback(() => {
    watchFocusRef.current = false; // end the focus-pause so external syncs resume
    const lines = (watchDraft || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    updateNodeData(id, { watchUrls: lines });
  }, [watchDraft, watchFocusRef, id, updateNodeData]);

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
        <MonitorStatusBadge status={data.status || 'unknown'} lastChecked={data.lastChecked} />

        {/* Show the prose status message only when it explains a problem. For
            live/sold/ended, the badge plus attention panels carry the signal. */}
        {data.statusMessage && (data.status === 'error' || data.status === 'unknown' || data.status === 'needs-login') && (
          <div className="text-white/40 text-[9px] leading-snug px-1 break-words">
            {data.statusMessage}
          </div>
        )}

        <AttentionPanels items={data.attention} />

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

        {/* Extra Watch URLs (per-card, optional) — collapsed by default since
            most users will configure these per-platform in Settings instead. */}
        <div>
          <button
            onClick={() => setWatchOpen(v => !v)}
            onPointerDown={(e) => e.stopPropagation()}
            className="nodrag flex items-center gap-1 text-white/40 text-[9px] font-semibold uppercase tracking-wider hover:text-white/60 transition-colors"
            title="Extra URLs to scan for this listing's status (e.g. a specific notification URL)"
          >
            {watchOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <Eye size={9} />
            Extra Watch URLs ({watchUrls.length})
          </button>
          {watchOpen && (
            <textarea
              rows={2}
              data-native-undo="true"
              value={watchDraft}
              onChange={(e) => setWatchDraft(e.target.value)}
              onFocus={watchFocusProps.onFocus}
              onBlur={saveWatchUrls}
              onPointerDown={(e) => e.stopPropagation()}
              placeholder={'One URL per line. Card-specific extras\n(platform-wide go in Settings).'}
              disabled={!!data.locked}
              className="nodrag mt-1 w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-white/70 text-[10px] outline-none focus:border-blue-400/50 disabled:opacity-50 font-mono leading-snug resize-none"
            />
          )}
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
            // Watch URLs are supplemental context; the listing URL anchors the
            // check to the specific item this card represents.
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

/**
 * AttentionPanels — splits the AI-surfaced items into two lanes so the visual
 * weight matches the actual stakes:
 *
 *   - Urgent: items the prompt classified as `urgency: 'high'` (offer
 *     expiring, suspension, dispute response due, payout held, etc.).
 *     Defaults to open — burying these behind a click defeats the point.
 *   - Info: low-urgency FYI items (new watchers, price suggestions,
 *     edit recommendations). Defaults to closed.
 *
 * Each lane renders only if it has items, so a quiet listing shows nothing.
 */
function AttentionPanels({ items }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const urgent = items.filter(i => i.urgency === 'high');
  const info   = items.filter(i => i.urgency !== 'high');
  return (
    <div className="space-y-1.5">
      {urgent.length > 0 && (
        <AttentionLane
          items={urgent}
          label="Action Needed"
          icon={<AlertTriangle size={10} className="text-red-400" />}
          defaultOpen
          accent={{
            badge: 'bg-red-500/30 text-red-200',
            item:  'bg-red-500/10 border-red-500/30',
            text:  'text-red-200',
          }}
        />
      )}
      {info.length > 0 && (
        <AttentionLane
          items={info}
          label="Info"
          icon={<Info size={10} className="text-sky-400" />}
          accent={{
            badge: 'bg-sky-500/20 text-sky-200',
            item:  'bg-sky-500/[0.07] border-sky-500/20',
            text:  'text-sky-100',
          }}
        />
      )}
    </div>
  );
}

function AttentionLane({ items, label, icon, accent, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        onPointerDown={(e) => e.stopPropagation()}
        className="nodrag w-full flex items-center gap-1.5 px-2 py-1 rounded-md border bg-white/5 border-white/10 hover:bg-white/10 transition-colors"
        title={label === 'Action Needed' ? 'Items the AI thinks need your action' : 'FYI items — nothing requires action'}
      >
        {open ? <ChevronDown size={10} className="text-white/60" /> : <ChevronRight size={10} className="text-white/60" />}
        {icon}
        <span className="text-[10px] font-medium text-white/80">{label}</span>
        <span className={`ml-auto text-[9px] font-bold leading-none px-1.5 py-0.5 rounded-full ${accent.badge}`}>
          {items.length}
        </span>
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1.5">
          {items.map((item, i) => (
            <li
              key={`${item.headline}-${i}`}
              className={`px-2 py-1.5 rounded-md border text-[10px] leading-snug ${accent.item}`}
            >
              <div className={`font-medium ${accent.text}`}>{item.headline}</div>
              {item.evidence && (
                <div className="text-white/40 text-[9px] mt-0.5 italic break-words">
                  &ldquo;{item.evidence}&rdquo;
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
