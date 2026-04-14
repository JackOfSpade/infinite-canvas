import React from 'react';
import { QuickPriceButtons } from '../../components/QuickPriceButtons';
import { PriceJustification } from '../../components/PriceJustification';
import { PlatformToggles } from '../../components/PlatformToggles';
import { Check, Copy } from 'lucide-react';

export function SellHubPricedState({
  product,
  pricing,
  comps,
  priceInput,
  handlePriceChange,
  handleQuickPrice,
  justificationExpanded,
  toggleJustification,
  selectedPlatforms,
  togglePlatform,
  copied,
  handleCopyListing
}) {
  return (
    <div className="p-3 space-y-2" onPointerDown={(e) => e.stopPropagation()}>
      <div className="text-emerald-400/60 text-[10px] font-semibold uppercase tracking-wider">💰 Ready to List</div>

      <div className="text-white/80 text-sm font-semibold truncate">{product.generated_title || 'Item'}</div>

      {/* Price */}
      {pricing?.recommended_price && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-white/30">Recommended:</span>
          <span className="text-emerald-400 font-semibold">${pricing.recommended_price}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-white/40 text-xs">Your Price:</span>
        <div className="flex-1 flex items-center gap-1">
          <span className="text-white/40 text-sm">$</span>
          <input 
            type="number" 
            value={priceInput}
            onChange={(e) => handlePriceChange(e.target.value)}
            className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none text-right" 
            placeholder="0" 
          />
        </div>
      </div>

      {/* Quick price buttons */}
      <QuickPriceButtons pricing={pricing} onSelect={handleQuickPrice} />

      {/* Price justification */}
      <PriceJustification 
        pricing={pricing} 
        comps={comps} 
        expanded={justificationExpanded}
        onToggle={toggleJustification} 
      />

      {/* Platform toggles */}
      <div className="pt-1 border-t border-white/5">
        <div className="text-white/20 text-[9px] font-semibold uppercase tracking-wider mb-1">
          Click source icon to post →
        </div>
        <PlatformToggles selected={selectedPlatforms} onToggle={togglePlatform} />
      </div>

      {/* Copy + open actions */}
      <div className="flex gap-1.5">
        <button 
          onClick={handleCopyListing}
          className="flex-1 py-1.5 rounded text-[10px] font-medium flex items-center justify-center gap-1 bg-white/5 text-white/50 hover:bg-white/10 transition-colors"
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? 'Copied!' : 'Copy Listing'}
        </button>
      </div>
    </div>
  );
}
