import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, useStore } from '@xyflow/react';
import { ExternalLink, Palette, TrendingDown } from 'lucide-react';
import { SELL_PLATFORM_BY_ID } from '../utils/constants';
import { syncUncontrolledTextValue } from '../utils/uncontrolledTextValue';
import { normalizeStaticGlowColor } from '../utils/staticGlowColor';
import {
  calculatePriceDropSuggestion,
  createdAtMsFromCardId,
  effectivePriceDropTargetPercent,
  INITIAL_PRICE_DROP_CHECK_DELAY_MS,
  MAX_PRICE_DROP_TIMER_DELAY_MS,
  normalizePriceDropMustSellDate,
  normalizePriceDropReminderWeeks,
  normalizePriceDropStartingPrice,
  oldestPriceDropCardCreatedAtIso,
  priceDropDeadlineReminderDelayMs,
  priceDropStartingPrice,
  priceDropReminderDelayMs,
} from '../utils/priceDropReminder';
import { selectListingPriceTiers } from '../utils/bundlePricing';
import { getConnectedHubCards } from '../utils/connectedHubCards';
import { PlatformBadge } from '../components/PlatformBadge';
import { CanvasNavigationContext } from '../contexts/CanvasNavigationContext';

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
 *     lastPriceDropAt?: string,      // ISO — last acknowledgment on the shared cadence
 *     priceDropReminderDue?: boolean // reminder fired, awaiting "price lowered" ack
 *     staticGlowColor?: string       // user-selected persistent glow; empty/absent = off
 *   }
 */

/** "Jun 12, 2026" from an ms timestamp, or null. */
function formatDayLabel(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatReminderPrice(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
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
  const navigation = useContext(CanvasNavigationContext);
  const updateGlobal = navigation?.updateNodeDataGlobally || updateNodeData;
  const platform = SELL_PLATFORM_BY_ID[data.platformId];
  const url = data.listingUrl?.trim() || '';

  // Creation time: persisted by spawn/migration; the id's Date.now() suffix is
  // a defensive fallback for nodes that slipped past both (e.g. undo snapshots
  // taken before the field existed).
  const createdAtParsed = Date.parse(data.createdAt || '');
  const createdAtMs = Number.isFinite(createdAtParsed) ? createdAtParsed : createdAtMsFromCardId(id);
  const createdLabel = formatDayLabel(createdAtMs);

  // Price-drop reminder. All connected cards use a fixed cadence that starts
  // at their oldest creation date. Hub settings and card membership are read
  // reactively so every card stays on the same schedule.
  const reminderWeeks = useStore(
    useCallback((s) => normalizePriceDropReminderWeeks(s.nodeLookup.get(data.hubId)?.data?.priceDropReminderWeeks), [data.hubId])
  );
  const mustSellDate = useStore(
    useCallback((s) => normalizePriceDropMustSellDate(s.nodeLookup.get(data.hubId)?.data?.priceDropMustSellDate), [data.hubId])
  );
  const targetPercent = useStore(
    useCallback((s) => effectivePriceDropTargetPercent(s.nodeLookup.get(data.hubId)?.data?.priceDropTargetPercent), [data.hubId])
  );
  const scheduleStartedAtIso = useStore(
    useCallback((s) => oldestPriceDropCardCreatedAtIso(getConnectedHubCards({
      nodes: s.nodes,
      edges: s.edges,
      hubId: data.hubId,
      cardType: 'marketplacecard',
    })), [data.hubId])
  );
  const startingPrice = useStore(
    useCallback((s) => {
      const hubData = s.nodeLookup.get(data.hubId)?.data;
      if (!hubData) return null;
      const savedStartingPrice = normalizePriceDropStartingPrice(hubData.priceDropPlanStartingPrice);
      if (savedStartingPrice != null) return savedStartingPrice;
      const tiers = selectListingPriceTiers({
        pricing: hubData.pricing,
        itemPricings: hubData.itemPricings,
        bundlePricing: hubData.bundlePricing,
        bundleTotal: hubData.bundleTotal,
      });
      return priceDropStartingPrice(tiers, hubData.priceDropStartingTier);
    }, [data.hubId])
  );
  const reminderActive = !!data.priceDropReminderDue && reminderWeeks > 0;
  const suggestedPrice = reminderActive && mustSellDate
    ? calculatePriceDropSuggestion({
      startingPrice,
      targetPercent,
      scheduleStartedAtIso,
      mustSellDate,
      weeks: reminderWeeks,
    })
    : null;
  const staticGlowColor = normalizeStaticGlowColor(data.staticGlowColor);
  const hasStaticGlow = !!staticGlowColor;

  useEffect(() => {
    if (data.priceDropReminderDue || !(reminderWeeks > 0) || !scheduleStartedAtIso) return undefined;
    let timer;
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      const delay = mustSellDate
        ? priceDropDeadlineReminderDelayMs({
          scheduleStartedAtIso,
          lastAcknowledgedAtIso: data.lastPriceDropAt,
          mustSellDate,
          weeks: reminderWeeks,
        })
        : priceDropReminderDelayMs({
          scheduleStartedAtIso,
          lastAcknowledgedAtIso: data.lastPriceDropAt,
          weeks: reminderWeeks,
        });
      if (delay == null) return;
      if (delay > 0) {
        // Browser timers cap around 24.8 days. Long reminder intervals wake at
        // that cap and schedule the remaining delay without minute polling.
        timer = setTimeout(schedule, Math.min(delay, MAX_PRICE_DROP_TIMER_DELAY_MS));
        return;
      }
      // Firing is not a price drop. Acknowledgment advances only this card
      // through the shared fixed cadence.
      updateGlobal(id, { priceDropReminderDue: true });
    };
    // A loaded workspace is marked clean shortly after its first render. Let
    // that settle before an overdue reminder writes controlled node state, or
    // the loader's cleanup can clear the dirty flag and prevent autosave.
    timer = setTimeout(schedule, INITIAL_PRICE_DROP_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    data.lastPriceDropAt,
    data.priceDropReminderDue,
    reminderWeeks,
    scheduleStartedAtIso,
    mustSellDate,
    id,
    updateGlobal,
  ]);

  const acknowledgePriceDrop = useCallback(() => {
    updateGlobal(id, { priceDropReminderDue: false, lastPriceDropAt: new Date().toISOString() });
  }, [id, updateGlobal]);

  const setUrl = useCallback((newUrl) => {
    updateGlobal(id, { listingUrl: newUrl });
  }, [id, updateGlobal]);

  const setNotes = useCallback((notes) => {
    updateGlobal(id, { notes });
  }, [id, updateGlobal]);

  const openGlowCustomizer = useCallback(() => {
    if (navigation?.isAnimating) return;
    document.dispatchEvent(new CustomEvent('open-multi-customize', { detail: { ids: [id] } }));
  }, [id, navigation?.isAnimating]);

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
      className={`marketplace-listing-card w-[240px] rounded-2xl bg-neutral-900/95 border-2 shadow-lg overflow-hidden ${hasStaticGlow ? 'marketplace-static-glow' : ''} ${reminderActive ? 'price-reminder-pulse' : ''}`}
      style={{
        borderColor: hasStaticGlow
          ? staticGlowColor
          : (reminderActive ? 'rgba(245,158,11,0.9)' : `${platform.color}55`),
        ...(hasStaticGlow ? { '--listing-static-glow-color': staticGlowColor } : {}),
      }}
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
        <button
          type="button"
          onClick={openGlowCustomizer}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={!!navigation?.isAnimating}
          className="nodrag relative shrink-0 w-7 h-7 rounded-md border border-white/10 bg-black/20 hover:bg-white/10 text-white/55 hover:text-white/90 flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-default"
          title="Customize static glow"
          aria-label="Customize static glow"
        >
          <Palette size={13} />
          {hasStaticGlow && (
            <span
              className="absolute right-0.5 bottom-0.5 w-2 h-2 rounded-full border border-white/50 shadow-[0_0_3px_rgba(0,0,0,0.9)] pointer-events-none"
              style={{ backgroundColor: staticGlowColor }}
            />
          )}
        </button>
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
              {suggestedPrice != null
                ? `Lower price to $${formatReminderPrice(suggestedPrice)}.`
                : 'Still listed — consider lowering the price.'}
            </div>
            {/* Enabled even when the card is locked — lock freezes content
                (URL, notes), not actions (see Open Listing); a disabled ack
                would leave a locked card pulsing with no way to clear it. */}
            <button
              onClick={acknowledgePriceDrop}
              onPointerDown={(e) => e.stopPropagation()}
              className="nodrag w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-[10px] font-medium transition-colors border border-amber-500/30"
              title={`Marks this reminder handled; the next reminder stays on the shared ${reminderWeeks}-week schedule`}
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
