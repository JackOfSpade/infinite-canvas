import { getScopedJobSourceIds } from './jobSourceScope.js';

export const DEFAULT_EDGE_OPTIONS = { type: 'smoothstep', animated: true, style: { strokeWidth: 3, opacity: 0.8 } };
export const EDGE_STYLE = { stroke: '#a855f7', strokeWidth: 3 };

/** Selling platforms — single source of truth for ListingNode and SellHubNode.
 *  `color` is sampled from the live favicon (src/assets/favicons/<domain>.png)
 *  so card outlines visually match the favicon a user sees in the badge. */
export const SELL_PLATFORMS = [
  // Generalists (broad multi-category reach)
  { id: 'ebay',      name: 'eBay',       letter: 'eB', color: '#e53238', domain: 'ebay.com',      postUrl: 'https://www.ebay.com/sell/create' },
  { id: 'facebook',  name: 'Facebook',   letter: 'FB', color: '#1877f2', domain: 'facebook.com',  postUrl: 'https://www.facebook.com/marketplace/create/item' },
  { id: 'mercari',   name: 'Mercari',    letter: 'M',  color: '#6357ff', domain: 'mercari.com',   postUrl: 'https://www.mercari.com/sell/' },
  // Fashion specialists
  { id: 'poshmark',  name: 'Poshmark',   letter: 'PM', color: '#731a4b', domain: 'poshmark.com',  postUrl: 'https://poshmark.com/create-listing' },
  { id: 'depop',     name: 'Depop',      letter: 'Dp', color: '#ff2300', domain: 'depop.com',     postUrl: 'https://www.depop.com/products/create/' },
  // Category specialists
  { id: 'swappa',    name: 'Swappa',     letter: 'Sw', color: '#27ae60', domain: 'swappa.com',    postUrl: 'https://swappa.com/sell' },
  { id: 'reverb',    name: 'Reverb',     letter: 'Rv', color: '#f04d23', domain: 'reverb.com',    postUrl: 'https://reverb.com/my/selling/listings/new' },
  { id: 'whatnot',   name: 'Whatnot',    letter: 'Wn', color: '#fff200', domain: 'whatnot.com',   postUrl: 'https://www.whatnot.com/sell' },
];

/** Job search sources — 10 platforms.
 *  `color` is sampled from the live favicon so card outlines match. */
export const JOB_SOURCES = [
  { id: 'google',         name: 'Google for Jobs', letter: 'GJ', color: '#4285f4', domain: 'google.com' },
  { id: 'indeed',         name: 'Indeed',      letter: 'IN', color: '#2164f3', domain: 'indeed.com' },
  { id: 'linkedin',       name: 'LinkedIn',    letter: 'Li', color: '#0a66c2', domain: 'linkedin.com' },
  { id: 'remoteok',       name: 'RemoteOK',    letter: 'RO', color: '#1a1a1a', domain: 'remoteok.com' },
  { id: 'weworkremotely', name: 'WWRemotely',  letter: 'WW', color: '#1a1a1a', domain: 'weworkremotely.com' },
  { id: 'ziprecruiter',   name: 'ZipRecruiter',letter: 'ZR', color: '#50c878', domain: 'ziprecruiter.com' },
  { id: 'glassdoor',      name: 'Glassdoor',   letter: 'GD', color: '#0caa41', domain: 'glassdoor.com' },
  { id: 'dice',           name: 'Dice',        letter: 'Di', color: '#eb1c26', domain: 'dice.com' },
  { id: 'wellfound',      name: 'Wellfound',   letter: 'WF', color: '#000000', domain: 'wellfound.com' },
  { id: 'usajobs',        name: 'USAJobs',     letter: 'US', color: '#003366', domain: 'usajobs.gov' },
];

export const ALL_JOB_SOURCE_IDS = [
  'google', 'indeed', 'linkedin', 'remoteok', 'weworkremotely',
  'ziprecruiter', 'glassdoor', 'dice', 'wellfound',
  'usajobs',
];

export const ACTIVE_JOB_SOURCES = getScopedJobSourceIds(ALL_JOB_SOURCE_IDS);

/** Price comparison sources for marketplace research.
 *  `color` matches the matching SELL_PLATFORMS entry so a marketplace and its
 *  price-comp source read as the same brand on the canvas. */
export const PRICE_COMP_SOURCES = [
  // Tier 1 — Sold comps (gold standard for FMV)
  { id: 'ebay-sold',    name: 'eBay Sold',     letter: 'eB', color: '#e53238',   domain: 'ebay.com' },
  { id: 'poshmark',     name: 'Poshmark Sold', letter: 'PM', color: '#731a4b',   domain: 'poshmark.com' },
  { id: 'swappa',       name: 'Swappa',        letter: 'Sw', color: '#27ae60',   domain: 'swappa.com' },
  { id: 'reverb',       name: 'Reverb Sold',   letter: 'Rv', color: '#f04d23',   domain: 'reverb.com' },
  // Tier 1 — Active competition
  { id: 'ebay-active',  name: 'eBay Active',   letter: 'eB', color: '#e5323880', domain: 'ebay.com' },
  // Tier 2 — Supplementary sold
  { id: 'mercari',      name: 'Mercari Sold',  letter: 'M',  color: '#6357ff',   domain: 'mercari.com' },
  // Niche specialist: aggregated sold-price data for video games + retro
  // consoles. Returns empty for non-game queries (auto-dismisses).
  { id: 'pricecharting', name: 'PriceCharting', letter: 'PC', color: '#1d72b8',   domain: 'pricecharting.com' },
  // StockX dropped — PerimeterX systematically blocks bootstrap-key
  // extraction, and the hardcoded fallback keys 403 at the Algolia edge.
  // Result: zero usable data on every run regardless of category. The
  // fetchStockXListings code in apiExtractors.js stays around in case we
  // revisit with a working bypass, but it's no longer invoked anywhere.
];

export const MINIMAP_NODE_COLORS = {
  group: '#3b82f6',
  document: '#8b5cf6',
  text: '#10b981',
  link: '#60a5fa',
  listing: '#f59e0b',
  jobcard: '#22c55e',
  jobhub: '#4285f4',
  sellhub: '#10b981',
};

/** Default dimensions per node type */
export const NODE_DIMS = {
  text:     { w: 180, h: 36  },
  link:     { w: 180, h: 50  },
  document: { w: 180, h: 36  },
  group:    { w: 160, h: 160 },
  listing:  { w: 240, h: 180 },
  jobcard:  { w: 180, h: 90  },
  jobhub:   { w: 280, h: 350 },
  sellhub:  { w: 280, h: 350 },
};

/** Extracts or estimates width/height of a node */
export function getNodeDims(node) {
  return {
    w: node.width  || node.measured?.width  || node.style?.width  || NODE_DIMS[node.type]?.w || 120,
    h: node.height || node.measured?.height || node.style?.height || NODE_DIMS[node.type]?.h || 40,
  };
}
