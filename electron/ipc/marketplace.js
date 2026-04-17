/**
 * Marketplace IPC handlers — photo analysis, multi-source FMV research, listing prep.
 *
 * Pricing Data Sources (7 total):
 *   Tier 1 Sold:  eBay Sold, Poshmark Sold, Swappa, StockX, Reverb
 *   Tier 1 Active: eBay Active
 *   Tier 2 Sold:  Mercari Sold
 */
import electronPkg from 'electron';
const { ipcMain } = electronPkg;
import { callGeminiVision, callGeminiText } from './gemini.js';
import { queueScrape } from './browserPool.js';
import {
  EBAY_SOLD_EXTRACTOR, EBAY_SOLD_CONFIG,
  EBAY_ACTIVE_EXTRACTOR, EBAY_ACTIVE_CONFIG,
  POSHMARK_SOLD_EXTRACTOR, POSHMARK_CONFIG,
  SWAPPA_EXTRACTOR, SWAPPA_CONFIG,
  MERCARI_SOLD_EXTRACTOR, MERCARI_CONFIG,
} from '../extractors/marketplace.js';
import {
  fetchReverbListings,
  fetchStockXListings,
} from '../extractors/apiExtractors.js';

// ── Source → URL + Extractor mapping (browser pool sources only) ────────────
// Reverb and StockX have been moved to fetchApiMarketplaceSources (direct HTTP).
//
// Each task has a `category: 'sold' | 'active'` field so the aggregate loop can
// classify results without a separately-maintained hardcoded ID list.
function buildCompTasks(query) {
  return [
    // Tier 1 — Sold comps (gold standard)
    {
      id: 'ebay-sold', category: 'sold',
      url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Complete=1&LH_Sold=1&_sop=13`,
      extractorJS: EBAY_SOLD_EXTRACTOR,
      options: EBAY_SOLD_CONFIG,
    },
    {
      id: 'poshmark', category: 'sold',
      url: `https://poshmark.com/search?query=${encodeURIComponent(query)}&availability=sold_out&type=listings`,
      extractorJS: POSHMARK_SOLD_EXTRACTOR,
      options: POSHMARK_CONFIG,
    },
    {
      id: 'swappa', category: 'sold',
      url: `https://swappa.com/search?q=${encodeURIComponent(query)}`,
      extractorJS: SWAPPA_EXTRACTOR,
      options: SWAPPA_CONFIG,
    },
    // Tier 1 — Active competition
    {
      id: 'ebay-active', category: 'active',
      url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&_sop=15`,
      extractorJS: EBAY_ACTIVE_EXTRACTOR,
      options: EBAY_ACTIVE_CONFIG,
    },
    // Tier 2 — Supplementary sold (Mercari: use %20 not + for cleaner sold results)
    {
      id: 'mercari', category: 'sold',
      url: `https://www.mercari.com/search/?keyword=${query.replace(/\s+/g, '%20')}&status=sold_out`,
      extractorJS: MERCARI_SOLD_EXTRACTOR,
      options: MERCARI_CONFIG,
    },
  ];
}

/** Build a lookup map from task ID → category, derived once per price research call. */
function buildTaskCategoryMap(tasks) {
  const map = {};
  for (const t of tasks) map[t.id] = t.category;
  return map;
}

/**
 * Fetch API-based marketplace sources in parallel (no Puppeteer needed).
 * Reverb uses internal REST API, StockX uses Algolia bypass.
 */
async function fetchApiMarketplaceSources(query) {
  const apiTasks = [
    { sourceId: 'reverb', fn: () => fetchReverbListings(query, true) },
    { sourceId: 'stockx', fn: () => fetchStockXListings(query) },
  ];

  return Promise.all(apiTasks.map(async ({ sourceId, fn }) => {
    try {
      const items = await fn();
      return { sourceId, items };
    } catch (error) {
      return { sourceId, items: [], error: error?.message || String(error) };
    }
  }));
}

/**
 * Register all Marketplace IPC handlers.
 */
export function registerMarketplaceHandlers() {

  // ── Analyze Product Photos ────────────────────────────────────────────────
  ipcMain.handle('analyze-photos', async (_event, { imagePaths }) => {
    try {
      console.log('[Marketplace] Analyzing', imagePaths.length, 'photos');

      const result = await callGeminiVision(imagePaths, `
You are a marketplace listing expert. Analyze these product photos and identify what is being sold.

Return a JSON object:
{
  "brand": "Identified brand name (or 'Unknown' if unclear)",
  "model": "Specific model name/number if identifiable (or 'Unknown')",
  "category": "Category > Subcategory (e.g. 'Electronics > Headphones > Over-Ear')",
  "condition": "New | Like New | Used - Excellent | Used - Good | Used - Fair | For Parts",
  "color": "Primary color(s)",
  "notable_features": "Any visible accessories, damage, special features",
  "generated_title": "An optimized selling title (60 chars max, include brand + model + key features + condition indicator)",
  "generated_description": "A detailed, buyer-friendly selling description (include specs if identifiable, condition details, what's included). 3-4 sentences."
}

Be specific about what you can clearly see. If you can't identify brand or model from the photos, say 'Unknown' — don't guess.`);

      console.log('[Marketplace] Product identified:', result.generated_title);
      return { success: true, product: result };
    } catch (error) {
      console.error('[Marketplace] Photo analysis failed:', error?.message || String(error));
      return { success: false, error: error?.message || String(error) };
    }
  });

  // ── Research Price (Multi-Source FMV) ──────────────────────────────────────
  ipcMain.handle('research-price', async (event, { query, condition }) => {
    try {
      console.log('[Marketplace] Researching price for:', query);

      const tasks = buildCompTasks(query);

      // Notify frontend that all sources are starting
      for (const t of tasks) {
        if (!event.sender.isDestroyed()) {
          event.sender.send('price-source-progress', { sourceId: t.id, status: 'searching', count: 0 });
        }
      }

      // Run all scrapes concurrently through the pool AND start API tasks
      const scrapeResultsPromise = Promise.allSettled(
        tasks.map(async (task) => {
          try {
            const data = await queueScrape(task.url, task.extractorJS, task.options);
            const items = Array.isArray(data) ? data : [];
            if (!event.sender.isDestroyed()) {
              event.sender.send('price-source-progress', {
                sourceId: task.id,
                status: 'done',
                count: items.length,
              });
            }
            return { id: task.id, items };
          } catch (e) {
            console.warn(`[Marketplace] Source ${task.id} failed:`, e?.message || String(e));
            if (!event.sender.isDestroyed()) {
              event.sender.send('price-source-progress', { sourceId: task.id, status: 'error', count: 0 });
            }
            return { id: task.id, items: [] };
          }
        })
      );

      const apiResultsPromise = fetchApiMarketplaceSources(query);

      const [scrapeResults, apiResults] = await Promise.all([scrapeResultsPromise, apiResultsPromise]);

      // Aggregate all comps by type — category comes from the task definition,
      // so there's no separate list to keep in sync with buildCompTasks.
      const taskCategoryMap = buildTaskCategoryMap(tasks);
      const allComps = { sold: [], active: [] };

      // 1. Browser pool results
      for (const r of scrapeResults) {
        if (r.status !== 'fulfilled') {
          // Rare: the outer map callback itself threw — there is no task.id available
          // here (the task object is opaque at this point), so emit a generic error.
          console.warn('[Marketplace] A scrape task promise was rejected unexpectedly.');
          continue;
        }
        const { id, items } = r.value;
        const category = taskCategoryMap[id] ?? 'sold'; // API sources (reverb, stockx) are sold
        allComps[category].push(...items);
      }

      // 2. API-based sources (Reverb REST API, StockX Algolia bypass)
      for (const res of apiResults) {
        if (res.items.length > 0) {
          allComps.sold.push(...res.items);
          if (!event.sender.isDestroyed()) {
            event.sender.send('price-source-progress', { sourceId: res.sourceId, status: 'done', count: res.items.length });
          }
        } else {
          if (!event.sender.isDestroyed()) {
            event.sender.send('price-source-progress', { sourceId: res.sourceId, status: res.error ? 'error' : 'done', count: 0 });
          }
        }
      }

      const totalComps = allComps.sold.length + allComps.active.length;
      console.log(`[Marketplace] Found ${allComps.sold.length} sold, ${allComps.active.length} active comps across all sources`);

      // If we have comp data, ask Gemini to synthesize pricing + routing
      if (totalComps > 0) {
        const pricing = await callGeminiText(`
You are a pricing analyst and marketplace routing expert. Given these comparable listings from multiple sources, recommend a selling price AND which platforms to list on.

ITEM: ${query}
CONDITION: ${condition}

RECENTLY SOLD (what buyers actually paid):
${JSON.stringify(allComps.sold.slice(0, 25), null, 2)}

CURRENTLY ACTIVE (competition):
${JSON.stringify(allComps.active.slice(0, 15), null, 2)}

Return a JSON object:
{
  "recommended_price": number (your best single price recommendation for a sale within 1-2 weeks),
  "quick_sell_price": number (price that would likely sell in 1-3 days),
  "max_profit_price": number (highest reasonable price, may take 3-4 weeks),
  "justification": "2-3 sentences explaining your reasoning with specific data points (median sold price, number of comps, active competition, demand signals)",
  "market_summary": {
    "sold_count": number,
    "sold_median": number,
    "sold_low": number,
    "sold_high": number,
    "active_count": number,
    "active_lowest": number
  },
  "recommended_platforms": [
    {
      "id": "platform_id",
      "name": "Platform Name",
      "reason": "Why this platform is optimal for this item (1 sentence)",
      "estimated_fee_pct": number (total fee percentage including processing),
      "net_payout": number (recommended_price minus fees)
    }
  ]
}

Platform routing rules for recommended_platforms (pick 2-4 most relevant):
- Electronics → Swappa (3% fee) > eBay (13%) > Mercari (10%)
- Fashion/Apparel → Depop (3.3% fee) > Poshmark (20% fee but 40-60% STR) > Mercari (10%)
- Sneakers → eBay (8% fee + Authenticity Guarantee) > StockX/GOAT
- Collectibles/Trading Cards → Whatnot (11% fee, live auction premium) > eBay (13%)
- Furniture/Home → Facebook Marketplace (0% local) only
- Musical Instruments → Reverb (5% fee, $500 cap) > eBay (6.35%)
- Luxury/Designer → eBay (13% + free authentication) > Poshmark
- General/Mixed → Mercari (10%) > eBay (13%) > Facebook (0% local)

Use platform IDs: ebay, facebook, mercari, poshmark, depop, swappa, reverb, whatnot`);

        return {
          success: true,
          pricing,
          comps: allComps,
        };
      }

      // No comps found — return empty with message
      return {
        success: true,
        pricing: {
          recommended_price: null,
          justification: 'No comparable listings found across eBay, Poshmark, Swappa, StockX, Reverb, or Mercari. Try adjusting the search terms or set your own price.',
          market_summary: { sold_count: 0, active_count: 0 },
          recommended_platforms: [],
        },
        comps: { sold: [], active: [] },
      };
    } catch (error) {
      console.error('[Marketplace] Price research failed:', error?.message || String(error));
      return { success: false, error: error?.message || String(error) };
    }
  });

}
