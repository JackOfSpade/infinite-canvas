import React, { useState } from 'react';
import { PhotoStrip } from '../../components/PhotoStrip';
import { Check, Copy, RefreshCw, ChevronDown, ChevronRight, Plus, Activity, Sparkles, TrendingUp, TrendingDown, Minus, ChevronUp } from 'lucide-react';
import { TIMINGS } from '../../utils/timings';
import { SELL_PLATFORMS } from '../../utils/constants';
import { useToast } from '../../components/ToastProvider';
import { ScrapeWarningsPanel } from '../../components/ScrapeWarningsPanel';
import { selectListingPriceTiers } from '../../utils/bundlePricing';

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
  return `$${Number.isInteger(price) ? price : price.toFixed(2)}`;
}

function buildFinalExplanation({ pricing, itemPricings, bundlePricing, bundleTotal, best }) {
  const isBundle = Array.isArray(itemPricings) && itemPricings.length > 1;
  if (!isBundle) return pricing?.justification || '';
  return bundlePricing?.justification
    || (best != null && bundleTotal != null
      ? `The combined listing price is ${formatPrice(best)} versus ${formatPrice(bundleTotal)} if the items were sold separately.`
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
  onCheckAllStatuses,         // () => trigger checkStatus on every connected card
  checkingAll = false,
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
}) {
  const [showUnfit, setShowUnfit] = useState(false);
  const [expandedItemReasons, setExpandedItemReasons] = useState({});
  const { addToast } = useToast();
  const tiers = selectListingPriceTiers({ pricing, itemPricings, bundlePricing, bundleTotal });
  const resultItems = tiers.isBundle
    ? itemPricings
    : [{ key: 'primary', label: product.generated_title || 'Item', pricing }];
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
    bundlePricing,
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

      <ExpandableTitle title={product.generated_title || 'Item'} addToast={addToast} />

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

          <div className="grid grid-cols-3 gap-1.5">
            {[
              { label: 'Quick', subline: '1–3 days', price: tiers.quick, cls: 'border-amber-500/20 bg-amber-500/[0.08] text-amber-300' },
              { label: 'Best', subline: '1–2 weeks', price: tiers.best, cls: 'border-emerald-500/30 bg-emerald-500/[0.12] text-emerald-300' },
              { label: 'Max', subline: '3–4 weeks', price: tiers.max, cls: 'border-purple-500/20 bg-purple-500/[0.08] text-purple-200' },
            ].map(tier => (
              <div key={tier.label} className={`rounded-lg border px-1.5 py-1.5 text-center ${tier.cls}`}>
                <div className="text-[8px] font-semibold uppercase tracking-wider opacity-70">{tier.label}</div>
                <div className="text-[12px] font-bold">{formatPrice(tier.price)}</div>
                <div className="text-white/25 text-[7px]">{tier.subline}</div>
              </div>
            ))}
          </div>

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
              <span className="text-white/35">Value if sold separately</span>
              <span className="shrink-0 text-white/50">{formatPrice(bundleTotal)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Marketplace cards — spawn one per platform you list on.
          Each card persists on the canvas, holds its own listing URL, and can
          be status-checked independently. Replaces the old auto-post toggles. */}
      <div className="pt-1 border-t border-white/5 space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-white/20 text-[9px] font-semibold uppercase tracking-wider">
            Marketplaces
          </div>
          {spawnedMarketplaceIds.length > 0 && !locked && (
            <button
              onClick={onCheckAllStatuses}
              disabled={checkingAll}
              onPointerDown={(e) => e.stopPropagation()}
              className="nodrag flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 text-[9px] font-medium border border-blue-500/20 transition-colors disabled:opacity-50"
              title="Ask AI to check the current status of every connected marketplace listing"
            >
              <Activity size={9} className={checkingAll ? 'animate-pulse' : ''} />
              {checkingAll ? 'Checking…' : 'Check All'}
            </button>
          )}
        </div>
        <div className="text-white/30 text-[9px] leading-snug">
          Spawn a card for each marketplace you list on. Each card holds a listing URL you paste after posting manually.
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
