import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

/**
 * PriceJustification — expandable panel showing comp data and AI reasoning.
 */
export function PriceJustification({ pricing, comps, expanded, onToggle }) {
  if (!pricing) return null;

  const summary = pricing.market_summary || {};

  return (
    <div className="border-t border-white/5">
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        className="w-full px-3 py-1.5 flex items-center justify-between text-xs text-white/50 hover:text-white/70 transition-colors"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span>Why this price?</span>
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2" onPointerDown={(e) => e.stopPropagation()}>
          {/* AI Justification */}
          <p className="text-white/50 text-xs leading-relaxed">
            {pricing.justification}
          </p>

          {/* Market Summary */}
          {summary.sold_count > 0 && (
            <div className="bg-black/20 rounded-lg p-2 space-y-1">
              <div className="text-white/40 text-[10px] font-semibold uppercase tracking-wider">eBay Sold (Last 30 days)</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                <span className="text-white/30">Count:</span>
                <span className="text-white/70">{summary.sold_count} items</span>
                <span className="text-white/30">Median:</span>
                <span className="text-emerald-400/80">${summary.sold_median}</span>
                <span className="text-white/30">Range:</span>
                <span className="text-white/70">${summary.sold_low} – ${summary.sold_high}</span>
              </div>
            </div>
          )}

          {summary.active_count > 0 && (
            <div className="bg-black/20 rounded-lg p-2 space-y-1">
              <div className="text-white/40 text-[10px] font-semibold uppercase tracking-wider">Active Competition</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                <span className="text-white/30">Listings:</span>
                <span className="text-white/70">{summary.active_count}</span>
                <span className="text-white/30">Lowest:</span>
                <span className="text-amber-400/80">${summary.active_lowest}</span>
              </div>
            </div>
          )}

          {/* Individual Comps */}
          {comps?.sold?.length > 0 && (
            <details className="text-xs">
              <summary className="text-white/30 cursor-pointer hover:text-white/50 transition-colors">
                View {comps.sold.length} sold listing{comps.sold.length === 1 ? '' : 's'}
              </summary>
              <div className="mt-1 space-y-0.5 max-h-24 overflow-y-auto custom-scrollbar">
                {comps.sold.slice(0, 10).map((item, i) => (
                  <div key={i} className="flex justify-between text-white/40">
                    <span className="truncate flex-1 mr-2">{item.title}</span>
                    <span className="text-emerald-400/70 shrink-0">{item.priceText}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
