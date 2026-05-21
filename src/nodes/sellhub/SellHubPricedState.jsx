import React, { useState } from 'react';
import { PriceJustification } from '../../components/PriceJustification';
import { PhotoStrip } from '../../components/PhotoStrip';
import { Check, Copy, RefreshCw, ChevronDown, ChevronRight, Plus, Activity, Sparkles } from 'lucide-react';
import { TIMINGS } from '../../utils/timings';
import { SELL_PLATFORMS } from '../../utils/constants';
import { useToast } from '../../components/ToastProvider';
import { ScrapeWarningsPanel } from '../../components/ScrapeWarningsPanel';

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

/**
 * Tiny inline badge showing how confident the AI is in its recommendation
 * + how many comps fed each weighting bucket. Reads two optional fields
 * from the synthesis response — older `pricing` blobs without them just
 * render nothing.
 *
 * Strong  = anchored on a tight cluster of exact-match listings.
 * Moderate = mostly adjusted (similar-but-not-exact) listings, OR few anchors with wide spread.
 * Weak    = mostly bound (loosely related) listings — best-guess.
 */
function PriceConfidence({ matchQuality, compBreakdown }) {
  if (!matchQuality && !compBreakdown) return null;
  const quality = matchQuality || 'moderate';
  const palette = {
    strong:   { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', dot: 'bg-emerald-400',  text: 'text-emerald-300/80', label: 'Strong match' },
    moderate: { bg: 'bg-amber-500/10',   border: 'border-amber-500/30',   dot: 'bg-amber-400',    text: 'text-amber-300/80',   label: 'Moderate match' },
    weak:     { bg: 'bg-red-500/10',     border: 'border-red-500/30',     dot: 'bg-red-400',      text: 'text-red-300/80',     label: 'Weak match' },
  }[quality] || null;
  if (!palette) return null;
  const { anchor_count = 0, adjusted_count = 0, bound_count = 0 } = compBreakdown || {};
  const breakdownTxt = [
    anchor_count   > 0 && `${anchor_count} exact`,
    adjusted_count > 0 && `${adjusted_count} adjusted`,
    bound_count    > 0 && `${bound_count} loose`,
  ].filter(Boolean).join(' · ');
  return (
    <div
      className={`flex items-center justify-between gap-2 px-2 py-1 rounded ${palette.bg} border ${palette.border}`}
      title="AI confidence in the recommended price based on how closely listings matched the item spec"
    >
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${palette.dot}`} />
        <span className={`text-[10px] font-medium ${palette.text}`}>{palette.label}</span>
      </div>
      {breakdownTxt && (
        <span className="text-white/40 text-[9px] font-mono">{breakdownTxt}</span>
      )}
    </div>
  );
}

export function SellHubPricedState({
  product,
  pricing,
  comps,
  scrapeWarnings = [],
  justificationExpanded,
  toggleJustification,
  locked = false,
  imagePaths = [],
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
  const { addToast } = useToast();

  return (
    <div className="p-3 space-y-2">
      <div className="text-emerald-400/60 text-[10px] font-semibold uppercase tracking-wider">💰 Ready to List</div>

      <PhotoStrip imagePaths={imagePaths} size="sm" />

      <ExpandableTitle title={product.generated_title || 'Item'} addToast={addToast} />

      {/* Anti-bot / throttle warnings collected during the multi-source
          scrape. The comp-source cards are ephemeral (reaped after research),
          so without this panel the user has no way to see WHY a source
          returned 0 comps. The full evidence + suggestion is selectable so
          you can copy/paste the whole block back to debug or optimize. */}
      <ScrapeWarningsPanel warnings={scrapeWarnings} addToast={addToast} />

      {/* Price tiers — read-only reference. The user picks one in their
          head and types it directly into the marketplace's form. */}
      {pricing?.recommended_price != null && (
        <>
          <div className="grid grid-cols-3 gap-1.5 text-[11px]">
            <div className="rounded px-1.5 py-1 bg-amber-500/10 border border-amber-500/20 text-center">
              <div className="text-amber-400/70 text-[9px] uppercase tracking-wider">Quick</div>
              <div className="text-amber-300 font-semibold">${pricing.quick_sell_price ?? '—'}</div>
            </div>
            <div className="rounded px-1.5 py-1 bg-emerald-500/10 border border-emerald-500/20 text-center">
              <div className="text-emerald-400/70 text-[9px] uppercase tracking-wider">Best</div>
              <div className="text-emerald-300 font-semibold">${pricing.recommended_price}</div>
            </div>
            <div className="rounded px-1.5 py-1 bg-purple-500/10 border border-purple-500/20 text-center">
              <div className="text-purple-300/70 text-[9px] uppercase tracking-wider">Max</div>
              <div className="text-purple-200 font-semibold">${pricing.max_profit_price ?? '—'}</div>
            </div>
          </div>
          <PriceConfidence
            matchQuality={pricing.match_quality}
            compBreakdown={pricing.comp_breakdown}
          />
        </>
      )}

      {/* Price justification */}
      <PriceJustification
        pricing={pricing}
        comps={comps}
        expanded={justificationExpanded}
        onToggle={toggleJustification}
      />

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
