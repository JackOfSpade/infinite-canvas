// Node types
import { DocumentNode } from '../nodes/DocumentNode';
import { TextNode } from '../nodes/TextNode';
import { CanvasNode } from '../nodes/CanvasNode';
import { LinkNode } from '../nodes/LinkNode';
import { ListingNode } from '../nodes/ListingNode';
import { JobCardNode } from '../nodes/JobCardNode';
import { JobHubNode } from '../nodes/JobHubNode';
import { SellHubNode } from '../nodes/SellHubNode';

export const nodeTypes = {
  document: DocumentNode,
  text: TextNode,
  group: CanvasNode, // Keep 'group' key for backward compatibility of saved nodes, but map it to CanvasNode
  link: LinkNode,
  listing: ListingNode,
  jobcard: JobCardNode,
  jobhub: JobHubNode,
  sellhub: SellHubNode,
};

export const DEFAULT_EDGE_OPTIONS = { type: 'bezier', animated: true, style: { strokeWidth: 3, opacity: 0.8 } };
export const EDGE_STYLE = { stroke: '#a855f7', strokeWidth: 3 };

/** Selling platforms — single source of truth for ListingNode and SellHubNode. */
export const SELL_PLATFORMS = [
  // Generalists (broad multi-category reach)
  { id: 'ebay',      name: 'eBay',       letter: 'eB', color: '#e53238', postUrl: 'https://www.ebay.com/sell/create' },
  { id: 'facebook',  name: 'Facebook',   letter: 'FB', color: '#1877f2', postUrl: 'https://www.facebook.com/marketplace/create/item' },
  { id: 'mercari',   name: 'Mercari',    letter: 'M',  color: '#ff4747', postUrl: 'https://www.mercari.com/sell/' },
  // Fashion specialists
  { id: 'poshmark',  name: 'Poshmark',   letter: 'PM', color: '#7b2d8e', postUrl: 'https://poshmark.com/create-listing' },
  { id: 'depop',     name: 'Depop',      letter: 'Dp', color: '#ff2300', postUrl: 'https://www.depop.com/products/create/' },
  // Category specialists
  { id: 'swappa',    name: 'Swappa',     letter: 'Sw', color: '#27ae60', postUrl: 'https://swappa.com/sell' },
  { id: 'reverb',    name: 'Reverb',     letter: 'Rv', color: '#3d9edc', postUrl: 'https://reverb.com/my/selling/listings/new' },
  { id: 'whatnot',   name: 'Whatnot',    letter: 'Wn', color: '#6c5ce7', postUrl: 'https://www.whatnot.com/sell' },
];

/** Job search sources — 12 platforms: DOM scrape + API. */
export const JOB_SOURCES = [
  { id: 'google', name: 'Google Jobs', letter: 'G', color: '#4285f4' },
  { id: 'indeed', name: 'Indeed', letter: 'IN', color: '#2164f3' },
  { id: 'linkedin', name: 'LinkedIn', letter: 'Li', color: '#0a66c2' },
  { id: 'remoteok', name: 'RemoteOK', letter: 'RO', color: '#ff4742' },
  { id: 'weworkremotely', name: 'WWRemotely', letter: 'WW', color: '#01b2b0' },
  { id: 'ziprecruiter', name: 'ZipRecruiter', letter: 'ZR', color: '#50c878' },
  { id: 'glassdoor', name: 'Glassdoor', letter: 'GD', color: '#0caa41' },
  { id: 'dice', name: 'Dice', letter: 'Di', color: '#eb1c26' },
  { id: 'wellfound', name: 'Wellfound', letter: 'WF', color: '#000000' },
  { id: 'greenhouse', name: 'Greenhouse', letter: 'GH', color: '#24a47f' },
  { id: 'lever', name: 'Lever', letter: 'Lv', color: '#4c4cff' },
  { id: 'usajobs', name: 'USAJobs', letter: 'US', color: '#003366' },
];

export const ACTIVE_JOB_SOURCES = [
  'google', 'indeed', 'linkedin', 'remoteok', 'weworkremotely',
  'ziprecruiter', 'glassdoor', 'dice', 'wellfound',
  'greenhouse', 'lever', 'usajobs',
];

/** Price comparison sources for marketplace research. */
export const PRICE_COMP_SOURCES = [
  // Tier 1 — Sold comps (gold standard for FMV)
  { id: 'ebay-sold',    name: 'eBay Sold',     letter: 'eB', color: '#e53238' },
  { id: 'poshmark',     name: 'Poshmark Sold', letter: 'PM', color: '#7b2d8e' },
  { id: 'swappa',       name: 'Swappa',        letter: 'Sw', color: '#27ae60' },
  { id: 'stockx',       name: 'StockX',        letter: 'SX', color: '#1b8b6a' },
  { id: 'reverb',       name: 'Reverb Sold',   letter: 'Rv', color: '#3d9edc' },
  // Tier 1 — Active competition
  { id: 'ebay-active',  name: 'eBay Active',   letter: 'eB', color: '#e5323880' },
  // Tier 2 — Supplementary sold
  { id: 'mercari',      name: 'Mercari Sold',  letter: 'M',  color: '#ff4747' },
];

/** MiniMap node colors — keyed by node type. */
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
