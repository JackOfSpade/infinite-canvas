import React from 'react';
import { SELL_PLATFORMS } from '../utils/constants';

/**
 * PlatformToggles — renders a row of platform selection toggle buttons.
 * Shared by ListingNode and SellHubNode.
 *
 * @param {string[]} selected   - Array of currently selected platform IDs
 * @param {function} onToggle   - Called with platform ID when toggled
 */
export function PlatformToggles({ selected, onToggle, disabled = false }) {
  return (
    <div className="flex flex-wrap gap-1">
      {SELL_PLATFORMS.map(p => (
        <button
          key={p.id}
          onClick={disabled ? undefined : () => onToggle(p.id)}
          disabled={disabled}
          className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-all border ${
            disabled ? 'opacity-20 cursor-default' :
            selected.includes(p.id) ? 'opacity-100' : 'opacity-30 hover:opacity-50'
          }`}
          style={{
            backgroundColor: selected.includes(p.id) ? p.color + '15' : 'transparent',
            color: p.color,
            borderColor: p.color + '30',
          }}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}
