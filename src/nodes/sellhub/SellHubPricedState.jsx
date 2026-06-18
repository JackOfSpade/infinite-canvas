import React, { useState, useRef, useEffect } from 'react';
import { PhotoStrip } from '../../components/PhotoStrip';
import { syncUncontrolledTextValue } from '../../utils/uncontrolledTextValue';
import { Check, Copy, RefreshCw, ChevronDown, ChevronRight, Plus, Activity, Sparkles, TrendingUp, TrendingDown, Minus, ChevronUp, CheckSquare, Square, CopyPlus } from 'lucide-react';
import { TIMINGS } from '../../utils/timings';
import { SELL_PLATFORMS } from '../../utils/constants';
import { useToast } from '../../components/ToastProvider';
import { ScrapeWarningsPanel } from '../../components/ScrapeWarningsPanel';
import { useSyncWhileFocused } from '../../hooks/useSyncWhileFocused';
import { buildFinalListingTitle, normalizeBundlePricingResult, selectListingPriceTiers } from '../../utils/bundlePricing';
import {
  normalizePriceDropReminderWeeks,
  normalizePriceDropTargetPrice,
  priceDropReminderCountThroughMustSell,
  resolvePriceDropStartingTier,
} from '../../utils/priceDropReminder';

/**
 * Per-item price-drop plan stored on the hub and read by its marketplace cards.
 * The cadence enables the pulse. An optional must-sell date + target price walk
 * the listing from the selected Quick/Best/Max tier down to that target by the
 * date — the final reminder on or before the date reaches the exact target.
 *
 * Plain-text input with blur-commit (useSyncWhileFocused) so decimals like
 * "1.5" type naturally and there are no number-spinner artifacts.
 */
/**
 * Must-sell date — uncontrolled (defaultValue + ref-synced while unfocused) so
 * background re-renders never reconcile its value and snap the open native
 * calendar popup shut. A controlled `<input type="date" value=…>` here flickered
 * closed ("press open, it closes") whenever the hub re-rendered mid-interaction —
 * notably during the ~40s startup login-verification, which re-renders the hub
 * once per platform. The sibling weeks/target inputs dodge this via
 * useSyncWhileFocused; this is the date-input analogue (MarketplaceNotesTextarea
 * uses the same pattern).
 */
function MustSellDateInput({ value, onChange, locked }) {
  const [initialValue] = useState(() => String(value ?? ''));
  const inputRef = useRef(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    syncUncontrolledTextValue(inputRef.current, value, focusedRef.current);
  }, [value]);

  return (
    <input
      ref={inputRef}
      type="date"
      defaultValue={initialValue}
      onChange={(e) => onChange?.(e.target.value)}
      onFocus={() => { focusedRef.current = true; }}
      onBlur={() => { focusedRef.current = false; syncUncontrolledTextValue(inputRef.current, value, false); }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label="Must sell by"
      disabled={locked}
      className="nodrag min-w-0 flex-1 bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-white/65 text-[9px] outline-none focus:border-blue-400/50 disabled:opacity-50 [color-scheme:dark]"
    />
  );
}

function PriceDropReminderPlan({ plan, locked, onChange, applyTargetCount = 0, onApplyToAll, excluded = false, onToggleExcluded }) {
  const weeksEditor = useSyncWhileFocused(plan.weeks > 0 ? String(plan.weeks) : '');
  const targetEditor = useSyncWhileFocused(plan.targetPrice != null ? String(plan.targetPrice) : '');
  const remindersThroughDeadline = priceDropReminderCountThroughMustSell({
    scheduleStartedAtIso: plan.scheduleStartedAt,
    mustSellDate: plan.mustSellDate,
    weeks: plan.weeks,
  });
  // "Apply to all" only broadcasts a plan that actually does something: without
  // a cadence (weeks > 0) there are no reminders, so enabling the button would
  // just silently reset every sibling's plan to off — a footgun, not a feature.
  const hasCadenceToApply = plan.weeks > 0;
  const hasTarget = plan.targetPrice != null;
  const hasStart = plan.startingPrice != null;
  const targetBelowStart = hasTarget && hasStart && plan.targetPrice < plan.startingPrice;
  const targetTooHigh = hasTarget && hasStart && plan.targetPrice >= plan.startingPrice;
  // The full plan needs a date AND a usable target below the starting price.
  const planActive = !!plan.mustSellDate && targetBelowStart;
  // A must-sell date requires a target — without one the date does nothing.
  const dateNeedsTarget = !!plan.mustSellDate && !hasTarget;

  const commitWeeks = () => {
    weeksEditor.focusProps.onBlur();
    const next = normalizePriceDropReminderWeeks(weeksEditor.value);
    onChange?.({ weeks: next });
    weeksEditor.setValue(next > 0 ? String(next) : '');
  };

  const commitTarget = () => {
    targetEditor.focusProps.onBlur();
    const raw = targetEditor.value.trim();
    if (raw === '') {
      onChange?.({ targetPrice: '' }); // empty clears the target
      targetEditor.setValue('');
      return;
    }
    const next = normalizePriceDropTargetPrice(raw);
    if (next == null) {
      targetEditor.setValue(plan.targetPrice != null ? String(plan.targetPrice) : '');
      return;
    }
    onChange?.({ targetPrice: next });
    targetEditor.setValue(String(next));
  };

  return (
    <div className="pt-1 space-y-1">
      <div className="flex items-center gap-1.5">
        <TrendingDown size={9} className="text-white/25 shrink-0" />
        <span className="text-white/35 text-[9px]">Remind to lower price every</span>
        <input
          type="text"
          inputMode="decimal"
          value={weeksEditor.value}
          onChange={(e) => weeksEditor.setValue(e.target.value)}
          onFocus={weeksEditor.focusProps.onFocus}
          onBlur={commitWeeks}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="off"
          aria-label="Price-drop reminder interval in weeks"
          disabled={locked}
          className="nodrag w-10 bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-white/70 text-[9px] text-center outline-none focus:border-blue-400/50 disabled:opacity-50 placeholder:text-white/20"
        />
        <span className="text-white/35 text-[9px]">weeks</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-[9px] shrink-0" />
        <span className="text-white/35 text-[9px]">Must sell by</span>
        <MustSellDateInput
          value={plan.mustSellDate}
          onChange={(v) => onChange?.({ mustSellDate: v })}
          locked={locked}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-[9px] shrink-0" />
        <span className="text-white/35 text-[9px]">Target price by then</span>
        <span className="text-white/30 text-[9px]">$</span>
        <input
          type="text"
          inputMode="decimal"
          value={targetEditor.value}
          onChange={(e) => targetEditor.setValue(e.target.value)}
          onFocus={targetEditor.focusProps.onFocus}
          onBlur={commitTarget}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="off"
          aria-label="Target price by must-sell date"
          disabled={locked}
          className="nodrag w-16 bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-white/70 text-[9px] text-right outline-none focus:border-blue-400/50 disabled:opacity-50 placeholder:text-white/20"
        />
      </div>
      <div className="text-white/20 text-[9px] leading-snug mt-0.5">
        Cards share a cadence starting from the oldest listing card. The price steps down to your target by the last reminder on or before the must-sell date.
      </div>
      {planActive && remindersThroughDeadline > 0 && (
        <div className="text-white/25 text-[9px] leading-snug">
          Steps from {formatPrice(plan.startingPrice)} down to {formatPrice(plan.targetPrice)} across {remindersThroughDeadline} reminder{remindersThroughDeadline === 1 ? '' : 's'}.
        </div>
      )}
      {dateNeedsTarget && (
        <div className="text-amber-300/70 text-[9px] leading-snug">
          Enter a target price to activate the must-sell plan — until then reminders won&apos;t stop at the date.
        </div>
      )}
      {targetTooHigh && (
        <div className="text-amber-300/70 text-[9px] leading-snug">
          Target must be below the starting price ({formatPrice(plan.startingPrice)}). Pick a lower target or a higher starting tier.
        </div>
      )}
      {planActive && remindersThroughDeadline === 0 && (
        <div className="text-amber-300/70 text-[9px] leading-snug">
          No reminder fits on or before this date. Choose a later date or a shorter interval to reach the target.
        </div>
      )}
      {/* Bulk apply + per-card opt-out. "Apply to all" copies this plan onto the
          other priced item cards on the CURRENT canvas only (not sub-canvases or
          the parent). The exclude toggle shields THIS card from any sibling's
          "apply to all" — it stays an independent source for its own button. */}
      <div className="flex items-center justify-between gap-2 pt-1 mt-0.5 border-t border-white/[0.06]">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleExcluded?.(); }}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={locked || !onToggleExcluded}
          aria-pressed={excluded}
          title={excluded
            ? 'This item is excluded from another item’s “Apply to all” — click to include it again'
            : 'Exclude this item so another item’s “Apply to all” skips it'}
          className="nodrag flex items-center gap-1 text-[9px] text-white/35 hover:text-white/65 transition-colors disabled:opacity-50"
        >
          {excluded
            ? <CheckSquare size={10} className="text-amber-300/80 shrink-0" />
            : <Square size={10} className="shrink-0" />}
          <span className={excluded ? 'text-amber-300/70' : ''}>Exclude from &ldquo;Apply to all&rdquo;</span>
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onApplyToAll?.(); }}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={locked || !onApplyToAll || applyTargetCount === 0 || !hasCadenceToApply}
          title={!hasCadenceToApply
            ? 'Set a reminder cadence above before applying this plan to other items'
            : applyTargetCount === 0
              ? 'No other priced item cards on this canvas to apply to'
              : `Apply this price-drop plan to ${applyTargetCount} other item${applyTargetCount === 1 ? '' : 's'} on this canvas`}
          className="nodrag flex shrink-0 items-center gap-1 rounded border border-blue-400/30 bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-medium text-blue-200/80 transition-colors hover:bg-blue-500/20 hover:text-blue-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-blue-500/10"
        >
          <CopyPlus size={9} />
          Apply to all{applyTargetCount > 0 ? ` (${applyTargetCount})` : ''}
        </button>
      </div>
    </div>
  );
}

/**
 * Title that toggles between one-line truncate and full wrapped text on click,
 * paired with a copy icon. Lives here (not in /components) because it's only
 * used in the priced state right now — promote if a second caller appears.
 */
function ExpandableTitle({ title, addToast }) {
  const [expanded, setExpanded] = useState(false);
  const [justCopied, setJustCopied] = useState(false);

  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(title);
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), TIMINGS.FEEDBACK_MS);
      addToast?.({ title: 'Title copied', description: title, type: 'success' });
    } catch {
      addToast?.({ title: 'Copy failed', description: 'Clipboard unavailable', type: 'error' });
    }
  };

  return (
    <div className="flex items-start gap-1.5">
      <div
        onClick={() => setExpanded(v => !v)}
        onPointerDown={(e) => e.stopPropagation()}
        title={expanded ? 'Click to collapse' : 'Click to show full title'}
        className={`nodrag flex-1 text-white/80 text-sm font-semibold cursor-pointer rounded px-1 -mx-1 py-0.5 hover:bg-white/5 transition-colors ${
          expanded ? 'whitespace-normal break-words leading-snug' : 'truncate'
        }`}
      >
        {title}
      </div>
      <button
        onClick={handleCopy}
        onPointerDown={(e) => e.stopPropagation()}
        title="Copy title to clipboard"
        className="nodrag shrink-0 mt-0.5 p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/5 transition-colors"
      >
        {justCopied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function formatPrice(value) {
  if (value === null || value === undefined || value === '') return '—';
  const price = Number(value);
  if (!Number.isFinite(price)) return '—';
  const rounded = Math.round(price * 100) / 100;
  if (rounded <= 0) return '—';
  return `$${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}`;
}

function hasPositivePrice(value) {
  if (value === null || value === undefined || value === '') return false;
  const price = Number(value);
  return Number.isFinite(price) && Math.round(price * 100) / 100 > 0;
}

function buildFinalExplanation({ pricing, itemPricings, bundlePricing, bundleTotal, best }) {
  const isBundle = Array.isArray(itemPricings) && itemPricings.length > 1;
  if (!isBundle) return pricing?.justification || '';
  const pricedCount = itemPricings.filter(it => hasPositivePrice(it?.pricing?.recommended_price)).length;
  const unpricedCount = itemPricings.length - pricedCount;
  return bundlePricing?.justification
    || (best != null && bundleTotal != null
      ? `The combined listing price is ${formatPrice(best)} versus ${formatPrice(bundleTotal)} if the priced items were sold separately.${unpricedCount > 0 ? ` ${unpricedCount} unpriced item${unpricedCount === 1 ? ' was' : 's were'} excluded from the recommendation.` : ''}`
      : '');
}

function ReasonDisclosure({ expanded, onToggle, children, className = '' }) {
  if (!children) return null;
  return (
    <div className={className}>
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        onPointerDown={(e) => e.stopPropagation()}
        className="nodrag flex w-full items-center justify-between py-1 text-[9px] text-white/35 transition-colors hover:text-white/65"
      >
        <span className="flex items-center gap-1">
          <Sparkles size={8} className="text-emerald-300/50" />
          Why this price?
        </span>
        {expanded ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
      </button>
      {expanded && (
        <p
          className="nodrag pb-1 text-[9px] leading-relaxed text-white/50 whitespace-pre-wrap select-text"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {children}
        </p>
      )}
    </div>
  );
}

export function SellHubPricedState({
  product,
  pricing,
  // Per-item breakdown for multi-item ("bundle") listings (null for single item).
  itemPricings = null,
  bundleTotal = null,
  // AI whole-listing result { quick_sell_price, bundle_price,
  // max_profit_price, synergy, justification }.
  // Null → fall back to the arithmetic sum (bundleTotal) as the headline.
  bundlePricing = null,
  scrapeWarnings = [],
  justificationExpanded,
  toggleJustification,
  locked = false,
  imagePaths = [],
  editablePhotos = false,
  onRemovePhoto,
  onAddPhotos,
  onReresearch,
  // Phase-2 redesign: marketplace cards replace the platform-toggles UX.
  spawnedMarketplaceIds = [], // ids already represented by a connected MarketplaceCardNode
  onSpawnMarketplaceCard,     // (platformId) => spawn a card next to the hub
  // { ebay: { fit: 'good' }, mercari: { fit: 'unfit', reason: '...' }, ... }
  // null/undefined means assessment not yet complete (or failed) — UI falls
  // back to showing every platform unfiltered. Always-clickable; "unfit" only
  // hides the button behind an expandable section, never disables it.
  platformFit = null,
  // True while the background fit assessment is still running. We hold the
  // marketplace list in a "selecting…" state until it lands so the user never
  // sees every platform flash as "good" and then collapse unfit ones a moment
  // later. Cleared on success OR failure (failure → platformFit stays null →
  // fall back to the unfiltered list below).
  platformFitPending = false,
  // Shared price-drop plan, persisted on the hub and consumed by its cards.
  priceDropPlan = {
    weeks: 0,
    mustSellDate: '',
    targetPrice: null,
    scheduleStartedAt: null,
    startingPrice: null,
    startingTier: 'best',
  },
  onChangePriceDropPlan,
  // "Apply to all" broadcasts this hub's plan to sibling item cards on the
  // current canvas; applyPlanTargetCount is how many would receive it.
  applyPlanTargetCount = 0,
  onApplyPriceDropPlanToAll,
  // Per-card opt-out from being a target of another card's "Apply to all".
  priceDropApplyAllExcluded = false,
  onToggleApplyAllExcluded,
}) {
  const [showUnfit, setShowUnfit] = useState(false);
  const [expandedItemReasons, setExpandedItemReasons] = useState({});
  const { addToast } = useToast();
  const pricedItemCount = Array.isArray(itemPricings)
    ? itemPricings.filter(it => hasPositivePrice(it?.pricing?.recommended_price)).length
    : 0;
  const unpricedItemCount = Array.isArray(itemPricings) ? itemPricings.length - pricedItemCount : 0;
  // Also normalize on read so results saved before the consistency guard was
  // added cannot keep showing contradictory bundle explanation text.
  const displayBundlePricing = normalizeBundlePricingResult(
    bundlePricing,
    bundleTotal,
    bundlePricing?.item_count ?? pricedItemCount,
  );
  const tiers = selectListingPriceTiers({ pricing, itemPricings, bundlePricing: displayBundlePricing, bundleTotal });
  const selectedStartingTier = resolvePriceDropStartingTier(tiers, priceDropPlan.startingTier);
  const planStartingPrice = priceDropPlan.startingPrice ?? tiers[selectedStartingTier] ?? null;
  const resultItems = tiers.isBundle
    ? itemPricings
    : [{ key: 'primary', label: product.generated_title || 'Item', pricing }];
  const finalListingTitle = buildFinalListingTitle(product, itemPricings);
  const bundleDelta = tiers.isBundle && tiers.best != null && bundleTotal != null
    ? tiers.best - bundleTotal
    : null;
  const bundleSignal = bundleDelta > 0
    ? { Icon: TrendingUp, label: `${formatPrice(Math.abs(bundleDelta))} bundle premium`, cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' }
    : bundleDelta < 0
      ? { Icon: TrendingDown, label: `${formatPrice(Math.abs(bundleDelta))} bundle discount`, cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20' }
      : bundleDelta === 0
        ? { Icon: Minus, label: 'Matches separate value', cls: 'text-white/45 bg-white/5 border-white/10' }
        : null;
  const finalExplanation = buildFinalExplanation({
    pricing,
    itemPricings,
    bundlePricing: displayBundlePricing,
    bundleTotal,
    best: tiers.best,
  });
  const toggleItemReason = (key) => {
    setExpandedItemReasons(prev => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="p-3 space-y-2">
      <div className="text-emerald-400/60 text-[10px] font-semibold uppercase tracking-wider">💰 Ready to List</div>

      <PhotoStrip
        imagePaths={imagePaths}
        size="sm"
        editable={editablePhotos}
        onRemoveImage={onRemovePhoto}
        onAddImages={onAddPhotos}
      />

      <ExpandableTitle title={finalListingTitle} addToast={addToast} />

      {/* Anti-bot / throttle warnings collected during the multi-source
          scrape. The comp-source cards are ephemeral (reaped after research),
          so without this panel the user has no way to see WHY a source
          returned 0 comps. The full evidence + suggestion is selectable so
          you can copy/paste the whole block back to debug or optimize. */}
      <ScrapeWarningsPanel warnings={scrapeWarnings} addToast={addToast} />

      {/* One listing-level result. For bundles, every headline tier belongs to
          the entire bundle; individual prices only explain how it was built. */}
      <div className="overflow-hidden rounded-xl border border-emerald-500/25 bg-gradient-to-b from-emerald-500/[0.10] to-white/[0.02]">
        <div className="px-3 pt-2.5 pb-2 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-emerald-300/60 text-[9px] font-semibold uppercase tracking-[0.16em]">
                {tiers.isBundle ? `Bundle recommendation · ${resultItems.length} items` : 'Listing recommendation'}
              </div>
              <div className="mt-0.5 flex items-baseline gap-1.5">
                <span className="text-emerald-300 text-2xl font-bold leading-none">{formatPrice(tiers.best)}</span>
                <span className="text-white/30 text-[9px] uppercase tracking-wider">Best</span>
              </div>
            </div>
            {bundleSignal && (
              <div className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[8px] font-medium ${bundleSignal.cls}`}>
                <bundleSignal.Icon size={8} />
                {bundleSignal.label}
              </div>
            )}
          </div>

          <div className="text-white/25 text-[8px] leading-snug">
            Price-drop starting value: {formatPrice(planStartingPrice)}. Select a tier to use its current price.
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {[
              { id: 'quick', label: 'Quick', subline: '1–3 days', price: tiers.quick, cls: 'border-amber-500/20 bg-amber-500/[0.08] text-amber-300' },
              { id: 'best', label: 'Best', subline: '1–2 weeks', price: tiers.best, cls: 'border-emerald-500/30 bg-emerald-500/[0.12] text-emerald-300' },
              { id: 'max', label: 'Max', subline: '3–4 weeks', price: tiers.max, cls: 'border-purple-500/20 bg-purple-500/[0.08] text-purple-200' },
            ].map(tier => (
              <button
                type="button"
                key={tier.id}
                onClick={() => onChangePriceDropPlan?.({ startingTier: tier.id })}
                onPointerDown={(e) => e.stopPropagation()}
                disabled={locked || !hasPositivePrice(tier.price)}
                aria-label={`Use ${tier.label} price as price-drop starting value`}
                aria-pressed={selectedStartingTier === tier.id}
                title={`Use ${tier.label} price as the price-drop plan's starting value`}
                className={`nodrag rounded-lg border px-1.5 py-1.5 text-center transition-shadow disabled:opacity-50 ${tier.cls} ${
                  selectedStartingTier === tier.id ? 'ring-1 ring-inset ring-blue-300/80' : ''
                }`}
              >
                <div className="text-[8px] font-semibold uppercase tracking-wider opacity-70">{tier.label}</div>
                <div className="text-[12px] font-bold">{formatPrice(tier.price)}</div>
                <div className="text-white/25 text-[7px]">{tier.subline}</div>
              </button>
            ))}
          </div>
          {tiers.isBundle && unpricedItemCount > 0 && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-2 py-1 text-[8px] leading-snug text-amber-200/70">
              {unpricedItemCount} item{unpricedItemCount === 1 ? ' has' : 's have'} no market price and {unpricedItemCount === 1 ? 'is' : 'are'} excluded from this recommendation.
            </div>
          )}

          {finalExplanation && (
            <ReasonDisclosure
              expanded={justificationExpanded}
              onToggle={toggleJustification}
              className="border-t border-white/[0.07] pt-1"
            >
              {finalExplanation}
            </ReasonDisclosure>
          )}
        </div>

        <div className="border-t border-white/[0.07] bg-black/10 px-3 py-2 space-y-1.5">
          <div className="flex items-center justify-between text-[8px] font-semibold uppercase tracking-[0.14em]">
            <span className="text-white/30">{tiers.isBundle ? 'Individual market values' : 'Item value'}</span>
            <span className="text-white/20">Best price</span>
          </div>
          <ul className="space-y-1">
            {resultItems.map((it, i) => {
              const itemKey = String(it.key || i);
              return (
                <li key={itemKey} className="rounded-md border border-white/[0.05] bg-white/[0.015] px-2 py-1">
                  <div className="flex items-center justify-between gap-2 text-[10px]">
                    <span className="min-w-0 truncate text-white/60" title={it.label || it.query}>
                      {it.label || it.query || `Item ${i + 1}`}
                    </span>
                    <span className="shrink-0 font-medium text-white/80">{formatPrice(it.pricing?.recommended_price)}</span>
                  </div>
                  {tiers.isBundle && (
                    <ReasonDisclosure
                      expanded={!!expandedItemReasons[itemKey]}
                      onToggle={() => toggleItemReason(itemKey)}
                    >
                      {it.pricing?.justification}
                    </ReasonDisclosure>
                  )}
                </li>
              );
            })}
          </ul>
          {tiers.isBundle && bundleTotal != null && (
            <div className="flex items-center justify-between gap-2 border-t border-white/[0.07] pt-1.5 text-[9px]">
              <span className="text-white/35">{unpricedItemCount > 0 ? 'Priced-item value if sold separately' : 'Value if sold separately'}</span>
              <span className="shrink-0 text-white/50">{formatPrice(bundleTotal)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Marketplace cards — spawn one per platform you list on.
          Each card persists on the canvas and holds its own listing URL and
          personal notes. Replaces the old auto-post toggles. */}
      <div className="pt-1 border-t border-white/5 space-y-1.5">
        <div className="text-white/20 text-[9px] font-semibold uppercase tracking-wider">
          Marketplaces
        </div>
        <div className="text-white/30 text-[9px] leading-snug">
          Spawn a card for each marketplace you list on. Each card holds a listing URL and personal notes. Use a Marketplace Status Module to monitor them.
        </div>
        {platformFitPending ? (
          // Fit assessment still running — hold the list rather than show every
          // platform as "good" and then collapse unfit ones a moment later.
          <div className="flex items-center gap-1.5 text-white/30 text-[10px] py-1">
            <Activity size={10} className="animate-pulse" />
            Selecting best marketplaces for this item…
          </div>
        ) : (() => {
          // Partition by AI fit verdict. Without a verdict (assessment failed),
          // treat every platform as "good" — never hide options when we don't
          // have data to justify hiding them.
          const fitGood = [];
          const fitUnfit = [];
          for (const p of SELL_PLATFORMS) {
            const verdict = platformFit?.[p.id]?.fit;
            const alreadySpawned = spawnedMarketplaceIds.includes(p.id);
            // Already-spawned cards stay in the primary list even if the AI
            // would mark them unfit — the user already committed, and hiding
            // the card behind a toggle would be disorienting.
            if (verdict === 'unfit' && !alreadySpawned) fitUnfit.push(p);
            else fitGood.push(p);
          }
          const renderButton = (p, { unfit } = {}) => {
            const spawned = spawnedMarketplaceIds.includes(p.id);
            const reason = platformFit?.[p.id]?.reason;
            const title = spawned
              ? `${p.name} card already on canvas`
              : unfit
                ? `AI flagged ${p.name} as a poor fit${reason ? `: ${reason}` : ''} — click to add anyway`
                : `Add ${p.name} marketplace card`;
            return (
              <button
                key={p.id}
                onClick={locked || spawned ? undefined : () => onSpawnMarketplaceCard?.(p.id)}
                disabled={locked || spawned}
                onPointerDown={(e) => e.stopPropagation()}
                title={title}
                className={`nodrag flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors border ${
                  spawned
                    ? 'bg-emerald-500/10 text-emerald-400/70 border-emerald-500/20 cursor-default'
                    : locked
                      ? 'bg-white/5 text-white/20 border-white/5 cursor-default'
                      : unfit
                        ? 'bg-white/[0.02] text-white/35 border-white/5 hover:bg-white/5 hover:text-white/60'
                        : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10 hover:text-white/90'
                }`}
                style={spawned ? undefined : { borderLeftColor: p.color, borderLeftWidth: 2, opacity: unfit ? 0.7 : 1 }}
              >
                {spawned ? <Check size={8} /> : <Plus size={8} />}
                {p.name}
              </button>
            );
          };
          return (
            <>
              <div className="flex flex-wrap gap-1">
                {fitGood.map(p => renderButton(p))}
              </div>
              {fitUnfit.length > 0 && (
                <div className="pt-1">
                  <button
                    onClick={() => setShowUnfit(v => !v)}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="nodrag flex items-center gap-1 text-white/30 text-[9px] hover:text-white/50 transition-colors"
                    title="Platforms the AI flagged as a poor fit for this item — still selectable if you disagree"
                  >
                    {showUnfit ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
                    <Sparkles size={8} />
                    {showUnfit ? 'Hide' : 'Show'} {fitUnfit.length} AI-flagged poor fit
                  </button>
                  {showUnfit && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {fitUnfit.map(p => renderButton(p, { unfit: true }))}
                    </div>
                  )}
                </div>
              )}
            </>
          );
        })()}
        <PriceDropReminderPlan
          plan={{
            ...priceDropPlan,
            weeks: normalizePriceDropReminderWeeks(priceDropPlan.weeks),
          }}
          locked={locked}
          onChange={onChangePriceDropPlan}
          applyTargetCount={applyPlanTargetCount}
          onApplyToAll={onApplyPriceDropPlanToAll}
          excluded={priceDropApplyAllExcluded}
          onToggleExcluded={onToggleApplyAllExcluded}
        />
      </div>

      {/* Refresh prices */}
      {!locked && onReresearch && (
        <button
          onClick={onReresearch}
          onPointerDown={(e) => e.stopPropagation()}
          className="nodrag w-full py-1 rounded text-[10px] font-medium flex items-center justify-center gap-1 bg-white/5 text-white/30 hover:bg-amber-500/10 hover:text-amber-400/70 transition-colors border border-white/5"
          title="Discard current pricing and re-research live similar listings"
        >
          <RefreshCw size={9} />
          Refresh Prices
        </button>
      )}

    </div>
  );
}
