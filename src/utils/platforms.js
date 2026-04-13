/**
 * Platform definitions — single source of truth.
 * Used by Sidebar (drag source) and ListingNode (color lookup).
 */
import { Store, ShoppingCart, Globe } from 'lucide-react';

export const PLATFORMS = [
  { id: 'ebay',       name: 'eBay',       color: '#e53238', icon: ShoppingCart },
  { id: 'amazon',     name: 'Amazon',     color: '#ff9900', icon: Store },
  { id: 'craigslist', name: 'Craigslist', color: '#5a1a8a', icon: Store },
  { id: 'custom',     name: 'Custom',     color: '#10b981', icon: Globe },
];

/** Quick lookup: platform ID → brand color */
export const PLATFORM_COLORS = Object.fromEntries(
  PLATFORMS.map(p => [p.id, p.color])
);
