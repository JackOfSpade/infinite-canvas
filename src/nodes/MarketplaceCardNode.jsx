import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, useStore } from '@xyflow/react';
import { ExternalLink, TrendingDown } from 'lucide-react';
import { SELL_PLATFORM_BY_ID } from '../utils/constants';
import { syncUncontrolledTextValue } from '../utils/uncontrolledTextValue';
import { createdAtMsFromCardId, isPriceDropReminderDue } from '../utils/priceDropReminder';
import { PlatformBadge } from '../components/PlatformBadge';

/**
 * MarketplaceCardNode — one persistent canvas node per marketplace the user is
 * selling on. Spawned by a Price Check Module (sellhub) after pricing.
 *
 *   - The hub no longer auto-posts. The user posts manually on the platform's
 *     site and pastes the resulting listing URL here.
 *   - This card stays on the canvas as the record of that platform's listing —
 *     its platform, listing URL, and user-authored notes.
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
 *     notes?: string, // user-only reminder; not consumed by app logic
 *     productSnapshot?: { title, price } // copied from parent hub for display
 *     createdAt?: string,            // ISO — card creation, shown in the footer
 *     lastPriceDropAt?: string,      // ISO — price-drop reminder anchor (falls back to createdAt)
 *     priceDropReminderDue?: boolean // reminder fired, awaiting "price lowered" ack
 *   }
 */

/** "Jun 12, 2026" from an ms timestamp, or null. */
function formatDayLabel(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function MarketplaceNotesTextarea({ value, onChange, locked }) {
  const [initialValue] = useState(() => String(value ?? ''));
  const inputRef = useRef(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    syncUncontrolledTextValue(inputRef.current, value, focusedRef.current);
  }, [value]);

  const handleBlur = (e) => {
    focusedRef.current = false;
    onChange(e.currentTarget.value);
  };

  return (
    <textarea
      ref={inputRef}
      defaultValue={initialValue}
      data-native-undo="true"
      onInput={(e) => onChange(e.currentTarget.value)}
      onFocus={() => { focusedRef.current = true; }}
      onBlur={handleBlur}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      rows={3}
      placeholder="Add a reminder about this listing..."
      disabled={locked}
      className="nodrag nowheel w-full resize-none bg-black/40 border border-white/10 rounded px-2 py-1.5 text-white/80 placeholder:text-white/25 text-[10px] leading-snug outline-none focus:border-blue-400/50 disabled:opacity-50 disabled:cursor-default"
    />
  );
}

export function MarketplaceCardNode({ id, data }) {
  const { updateNodeData } = useReactFlow();
  const platform = SELL_PLATFORM_BY_ID[data.platformId];
  const url = data.listingUrl?.trim() || '';

  // Creation time: persisted by spawn/migration; the id's Date.now() suffix is
  // a defensive fallback for nodes that slipped past both (e.g. undo snapshots
  // taken before the field existed).
  const createdAtParsed = Date.parse(data.createdAt || '');
  const createdAtMs = Number.isFinite(createdAtParsed) ? createdAtParsed : createdAtMsFromCardId(id);
  const createdLabel = formatDayLabel(createdAtMs);

  // Price-drop reminder. The cadence is PER-ITEM: it lives on this card's
  // parent hub (data.priceDropReminderWeeks, set in the hub's priced state)
  // and is read reactively here — a getNode() read would go stale, since
  // editing the hub doesn't re-render this card. Hub gone or unset → 0 → off.
  // Anchor = last acknowledged drop, else creation. While the hub's setting is
  // off (weeks <= 0) nothing fires or renders, but an already-due flag is kept
  // so re-enabling restores the pulse.
  const reminderWeeks = useStore(
    useCallback((s) => Number(s.nodeLookup.get(data.hubId)?.data?.priceDropReminderWeeks) || 0, [data.hubId])
  );
  const anchorIso = data.lastPriceDropAt || data.createdAt || null;
  const reminderActive = !!data.priceDropReminderDue && reminderWeeks > 0;

  useEffect(() => {
    if (data.priceDropReminderDue || !(reminderWeeks > 0) || !anchorIso) return undefined;
    const check = () => {
      if (!isPriceDropReminderDue({ anchorIso, weeks: reminderWeeks })) return;
      // On fire the anchor resets to NOW — not anchor + interval — so a
      // listing far older than the interval reminds once and then waits a
      // full fresh interval after the ack instead of immediately re-firing.
      updateNodeData(id, { priceDropReminderDue: true, lastPriceDropAt: new Date().toISOString() });
    };
    check();
    const timer = setInterval(check, 60_000);
    return () => clearInterval(timer);
  }, [data.priceDropReminderDue, reminderWeeks, anchorIso, id, updateNodeData]);

  const acknowledgePriceDrop = useCallback(() => {
    updateNodeData(id, { priceDropReminderDue: false, lastPriceDropAt: new Date().toISOString() });
  }, [id, updateNodeData]);

  const setUrl = useCallback((newUrl) => {
    updateNodeData(id, { listingUrl: newUrl });
  }, [id, updateNodeData]);

  const setNotes = useCallback((notes) => {
    updateNodeData(id, { notes });
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
      className={`w-[240px] rounded-2xl bg-neutral-900/95 border-2 shadow-lg overflow-hidden ${reminderActive ? 'price-reminder-pulse' : ''}`}
      style={{ borderColor: reminderActive ? 'rgba(245,158,11,0.9)' : `${platform.color}55` }}
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

        {/* User-only reminder. No status or marketplace logic consumes this. */}
        <div>
          <label className="text-white/40 text-[9px] font-semibold uppercase tracking-wider block mb-1">
            Notes
          </label>
          <MarketplaceNotesTextarea
            value={data.notes || ''}
            onChange={setNotes}
            locked={!!data.locked}
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

        {/* Price-drop reminder — pulses until the user marks the price lowered */}
        {reminderActive && (
          <div className="rounded-md bg-amber-500/10 border border-amber-500/30 p-2 space-y-1.5">
            <div className="text-amber-300/90 text-[10px] leading-snug">
              Still listed — consider lowering the price.
            </div>
            {/* Enabled even when the card is locked — lock freezes content
                (URL, notes), not actions (see Open Listing); a disabled ack
                would leave a locked card pulsing with no way to clear it. */}
            <button
              onClick={acknowledgePriceDrop}
              onPointerDown={(e) => e.stopPropagation()}
              className="nodrag w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-[10px] font-medium transition-colors border border-amber-500/30"
              title={`Clears the reminder and restarts the ${reminderWeeks}-week timer from now`}
            >
              <TrendingDown size={10} />
              I lowered the price
            </button>
          </div>
        )}

        {/* Card creation date */}
        {createdLabel && (
          <div
            className="text-white/25 text-[9px] text-center pt-0.5"
            title={new Date(createdAtMs).toLocaleString()}
          >
            Created {createdLabel}
          </div>
        )}
      </div>
    </div>
  );
}
