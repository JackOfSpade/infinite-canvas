import { getScopedJobSourceIds } from './jobSourceScope.js';
import { getScopedCompSourceIds } from './compSourceScope.js';

export const DEFAULT_EDGE_OPTIONS = { type: 'smoothstep', animated: true, style: { strokeWidth: 3, opacity: 0.8 } };
export const EDGE_STYLE = { stroke: '#a855f7', strokeWidth: 3 };
export const CANVAS_ZOOM_LIMITS = {
  min: 0.01, // 1%
  max: 9.99, // 999%
};

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
  { id: 'aptdeco',   name: 'AptDeco',    letter: 'AD', color: '#00a66c', domain: 'aptdeco.com',   postUrl: 'https://www.aptdeco.com/sell/new' },
];

export const SELL_PLATFORM_BY_ID = Object.fromEntries(SELL_PLATFORMS.map(platform => [platform.id, platform]));

/** Job search sources.
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
  { id: 'usajobs',        name: 'USAJobs',     letter: 'US', color: '#003366', domain: 'usajobs.gov' },
];

export const JOB_SOURCE_BY_ID = Object.fromEntries(JOB_SOURCES.map(source => [source.id, source]));
export const ALL_JOB_SOURCE_IDS = JOB_SOURCES.map(source => source.id);
export const ACTIVE_JOB_SOURCES = getScopedJobSourceIds(ALL_JOB_SOURCE_IDS);

/** Price comparison sources for marketplace research.
 *  `color` matches the matching SELL_PLATFORMS entry so a marketplace and its
 *  price-comp source read as the same brand on the canvas. */
export const PRICE_COMP_SOURCES = [
  // Tier 1 — Sold comps (gold standard for FMV)
  { id: 'ebay-sold',    name: 'eBay Sold',     letter: 'eB', color: '#e53238',   domain: 'ebay.com' },
  { id: 'poshmark',     name: 'Poshmark Sold', letter: 'PM', color: '#731a4b',   domain: 'poshmark.com' },
  { id: 'swappa-sold',  name: 'Swappa Sold',   letter: 'Sw', color: '#27ae60',   domain: 'swappa.com' },
  // Tier 1 — Active competition
  { id: 'ebay-active',  name: 'eBay Active',   letter: 'eB', color: '#e5323880', domain: 'ebay.com' },
  { id: 'swappa',       name: 'Swappa Active', letter: 'Sw', color: '#27ae6080', domain: 'swappa.com' },
  // Reverb: sold Price Guide API retired by Reverb (mid-2026) → now the live
  // listings API = ACTIVE asking prices (musical gear). See fetchReverbListings.
  { id: 'reverb',       name: 'Reverb Active', letter: 'Rv', color: '#f04d2380', domain: 'reverb.com' },
  // Tier 2 — Supplementary sold
  { id: 'mercari',      name: 'Mercari Sold',  letter: 'M',  color: '#6357ff',   domain: 'mercari.com' },
  // Niche specialist: AptDeco indexes secondhand FURNITURE / home furnishings
  // (active asking prices). Returns empty for non-furniture queries (the category
  // gate auto-skips them), so its card auto-dismisses for the common item.
  { id: 'aptdeco-active', name: 'AptDeco Active', letter: 'AD', color: '#00a66c', domain: 'aptdeco.com' },
  // Niche specialist: aggregated sold-price data for video games + retro
  // consoles. Returns empty for non-game queries (auto-dismisses).
  { id: 'pricecharting', name: 'PriceCharting', letter: 'PC', color: '#1d72b8',   domain: 'pricecharting.com' },
];

export const ALL_COMP_SOURCE_IDS = PRICE_COMP_SOURCES.map(source => source.id);
// Comp sources after applying the marketplace test-mode scope. In production
// (test mode off) this is the full list; with MARKETPLACE_TEST_ENABLED +
// MARKETPLACE_TEST_SOURCE set, it narrows to the single targeted source so the
// SellHub spawns only that comp card. Mirrors ACTIVE_JOB_SOURCES above.
export const ACTIVE_COMP_SOURCES = (() => {
  const scoped = new Set(getScopedCompSourceIds(ALL_COMP_SOURCE_IDS));
  return PRICE_COMP_SOURCES.filter(source => scoped.has(source.id));
})();

export const MINIMAP_NODE_COLORS = {
  group: '#3b82f6',
  document: '#8b5cf6',
  text: '#10b981',
  link: '#60a5fa',
  listing: '#f59e0b',
  jobcard: '#22c55e',
  jobhub: '#4285f4',
  sellhub: '#10b981',
  // Matches JobBoardNode's own header accent (bg-indigo-500/15 / text-indigo-300).
  jobboard: '#6366f1',
  // Matches JobGroupNode's 'role' (leaf/most common) kind accent border #14b8a655.
  jobgroup: '#14b8a6',
  // No single brand color (JobSourceCardNode's accent is per-platform/dynamic);
  // rose keeps it visually distinct from every other entry above.
  jobsourcecard: '#f43f5e',
  // Matches MarketplaceStatusNode's own accent (border-sky-500/30 / text-sky-400).
  marketplacestatus: '#0ea5e9',
  // No single brand color (CompSourceCardNode's accent is per-platform/dynamic);
  // fuchsia keeps it visually distinct from every other entry above.
  compsourcecard: '#d946ef',
};

/** Default dimensions per node type */
const NODE_DIMS = {
  text:     { w: 180, h: 36  },
  link:     { w: 180, h: 50  },
  document: { w: 180, h: 36  },
  group:    { w: 160, h: 160 },
  listing:  { w: 240, h: 180 },
  jobcard:  { w: 180, h: 90  },
  jobhub:   { w: 280, h: 350 },
  sellhub:  { w: 280, h: 350 },
  // JobBoardNode's HubContainer is a fixed width={260} (JobBoardNode.jsx). Height
  // is content-driven (no fixed prop) — estimated from a typical connected+done
  // render: header (~56px) + JobBoardSearchSelection (legend + a source list
  // capped at max-h-44 = 176px, JobBoardSearchSelection.jsx) + JobBoardDoneState's
  // result summary (~110px), matching the jobhub/sellhub height convention above.
  jobboard: { w: 260, h: 320 },
  // MarketplaceStatusNode computes nodeWidth dynamically per platform-card grid
  // (marketplaceStatusLayout.js) — no single fixed size exists. This is the
  // node's own single-platform-row size: marketplaceStatusNodeWidth(1) = 1*CARD_W
  // + 2*PAD = 296; height = OVERHEAD_EST (HEADER_H + BUTTON_BLOCK_H + 2*PAD = 110)
  // + CARD_H_EST (104) = 214 — the smallest realistic non-empty layout (the
  // all-empty state uses its own fixed 300px width with no cards, per
  // MarketplaceStatusNode.jsx).
  marketplacestatus: { w: 296, h: 214 },
};

/** Extracts or estimates width/height of a node */
function resolveNodeDimension(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (
      typeof value === 'string'
      && /^\s*(?:\d+\.?\d*|\.\d+)(?:px)?\s*$/i.test(value)
    ) {
      const parsed = Number.parseFloat(value);
      if (parsed > 0) return parsed;
    }
  }
  return 0;
}

export function getNodeDims(node) {
  const fallback = NODE_DIMS[node?.type];
  return {
    w: resolveNodeDimension(node?.width, node?.measured?.width, node?.style?.width, fallback?.w, 120),
    h: resolveNodeDimension(node?.height, node?.measured?.height, node?.style?.height, fallback?.h, 40),
  };
}

/**
 * Axis-aligned bounding box of a node set, using each node's estimated dims.
 * Pure. For an empty set returns Infinity/-Infinity bounds, so callers that may
 * pass an empty array should guard (every current caller has ≥1 node).
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number }}
 */
export function getNodesBounds(nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const { w, h } = getNodeDims(n);
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  return { minX, minY, maxX, maxY };
}
