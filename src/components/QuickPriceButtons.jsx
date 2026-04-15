import React from 'react';

/**
 * QuickPriceButtons — renders Quick / Market / Max price shortcut buttons.
 * Shared by ListingNode and SellHubNode.
 *
 * @param {object}   pricing   - { quick_sell_price, recommended_price, max_profit_price }
 * @param {function} onSelect  - Called with the selected price value
 */
export function QuickPriceButtons({ pricing, onSelect, disabled = false }) {
  if (!pricing?.quick_sell_price) return null;

  const baseClass = `px-1.5 py-0.5 rounded text-[9px] transition-colors`;
  const disabledClass = disabled ? 'opacity-30 cursor-default' : '';

  return (
    <div className="flex gap-1 text-[9px]">
      <button
        onClick={disabled ? undefined : () => onSelect(pricing.quick_sell_price)}
        disabled={disabled}
        className={`${baseClass} ${disabledClass} bg-amber-500/10 text-amber-400/70 hover:bg-amber-500/20`}
      >
        Quick ${pricing.quick_sell_price}
      </button>
      <button
        onClick={disabled ? undefined : () => onSelect(pricing.recommended_price)}
        disabled={disabled}
        className={`${baseClass} ${disabledClass} bg-emerald-500/10 text-emerald-400/70 hover:bg-emerald-500/20`}
      >
        Market ${pricing.recommended_price}
      </button>
      {pricing.max_profit_price && (
        <button
          onClick={disabled ? undefined : () => onSelect(pricing.max_profit_price)}
          disabled={disabled}
          className={`${baseClass} ${disabledClass} bg-purple-500/10 text-purple-400/70 hover:bg-purple-500/20`}
        >
          Max ${pricing.max_profit_price}
        </button>
      )}
    </div>
  );
}
