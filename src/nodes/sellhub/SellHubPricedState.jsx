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
  handleCopyListing,
  locked = false,
}) {
  return (
    <div className="p-3 space-y-2">
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
            onChange={locked ? undefined : (e) => handlePriceChange(e.target.value)}
            disabled={locked}
            className={`flex-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-white text-sm outline-none text-right ${locked ? 'opacity-50 cursor-default' : ''}`}
            placeholder="0" 
          />
        </div>
      </div>

      {/* Quick price buttons — disabled when locked */}
      <QuickPriceButtons pricing={pricing} onSelect={locked ? undefined : handleQuickPrice} disabled={locked} />

      {/* Price justification — read-only regardless of lock */}
      <PriceJustification 
        pricing={pricing} 
        comps={comps} 
        expanded={justificationExpanded}
        onToggle={toggleJustification} 
      />

      {/* Platform toggles — disabled when locked */}
      <div className="pt-1 border-t border-white/5">
        <div className="text-white/20 text-[9px] font-semibold uppercase tracking-wider mb-1">
          Click source icon to post →
        </div>
        <PlatformToggles selected={selectedPlatforms} onToggle={locked ? undefined : togglePlatform} disabled={locked} />
      </div>

      {/* Copy listing — disabled when locked */}
      <div className="flex gap-1.5">
        <button 
          onClick={locked ? undefined : handleCopyListing}
          disabled={locked}
          className={`flex-1 py-1.5 rounded text-[10px] font-medium flex items-center justify-center gap-1 transition-colors ${
            locked ? 'bg-white/5 text-white/20 cursor-default' : 'bg-white/5 text-white/50 hover:bg-white/10'
          }`}
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          {copied ? 'Copied!' : 'Copy Listing'}
        </button>
      </div>
    </div>
  );
}
