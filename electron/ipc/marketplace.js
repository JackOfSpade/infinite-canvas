/**
 * Marketplace IPC handlers — photo analysis, multi-source FMV research, listing prep.
 *
 * Pricing Data Sources (7 total):
 *   Tier 1 Sold:  eBay Sold, Poshmark Sold, Swappa, StockX, Reverb
 *   Tier 1 Active: eBay Active
 *   Tier 2 Sold:  Mercari Sold
 */
import { ipcMain } from 'electron';
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
function buildCompTasks(query) {
  return [
    // Tier 1 — Sold comps (gold standard)
    {
      id: 'ebay-sold',
      url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Complete=1&LH_Sold=1&_sop=13`,
      extractorJS: EBAY_SOLD_EXTRACTOR,
      options: EBAY_SOLD_CONFIG,
    },
    {
      id: 'poshmark',
      url: `https://poshmark.com/search?query=${encodeURIComponent(query)}&availability=sold_out&type=listings`,
      extractorJS: POSHMARK_SOLD_EXTRACTOR,
      options: POSHMARK_CONFIG,
    },
    {
      id: 'swappa',
      url: `https://swappa.com/search?q=${encodeURIComponent(query)}`,
      extractorJS: SWAPPA_EXTRACTOR,
      options: SWAPPA_CONFIG,
    },
    // Tier 1 — Active competition
    {
      id: 'ebay-active',
      url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&_sop=15`,
      extractorJS: EBAY_ACTIVE_EXTRACTOR,
      options: EBAY_ACTIVE_CONFIG,
    },
    // Tier 2 — Supplementary sold (Mercari: use %20 not + for cleaner sold results)
    {
      id: 'mercari',
      url: `https://www.mercari.com/search/?keyword=${query.replace(/\s+/g, '%20')}&status=sold_out`,
      extractorJS: MERCARI_SOLD_EXTRACTOR,
      options: MERCARI_CONFIG,
    },
  ];
}

/**
 * Fetch API-based marketplace sources in parallel (no Puppeteer needed).
 * Reverb uses internal REST API, StockX uses Algolia bypass.
 */
async function fetchApiMarketplaceSources(query) {
  const apiTasks = [
    { sourceId: 'reverb',  fn: () => fetchReverbListings(query, true) },
    { sourceId: 'stockx',  fn: () => fetchStockXListings(query) },
  ];

  const results = await Promise.allSettled(apiTasks.map(async ({ sourceId, fn }) => {
    try {
      const items = await fn();
      return { sourceId, items };
    } catch (error) {
      return { sourceId, items: [], error: error.message };
    }
  }));

  return results.map(r => r.status === 'fulfilled' ? r.value : { sourceId: 'unknown', items: [], error: 'Rejected' });
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
      console.error('[Marketplace] Photo analysis failed:', error.message);
      return { success: false, error: error.message };
    }
  });

  // ── Research Price (Multi-Source FMV) ──────────────────────────────────────
  ipcMain.handle('research-price', async (event, { query, condition }) => {
    try {
      console.log('[Marketplace] Researching price for:', query);

      const tasks = buildCompTasks(query);

      // Notify frontend that all sources are starting
      for (const t of tasks) {
        event.sender.send('price-source-progress', { sourceId: t.id, status: 'searching', count: 0 });
      }

      // Run all scrapes concurrently through the pool
      const scrapeResults = await Promise.allSettled(
        tasks.map(async (task) => {
          try {
            const data = await queueScrape(task.url, task.extractorJS, task.options);
            const items = Array.isArray(data) ? data : [];
            event.sender.send('price-source-progress', {
              sourceId: task.id,
              status: items.length > 0 ? 'done' : 'error',
              count: items.length,
            });
            return { id: task.id, items };
          } catch (e) {
            console.warn(`[Marketplace] Source ${task.id} failed:`, e.message);
            event.sender.send('price-source-progress', { sourceId: task.id, status: 'error', count: 0 });
            return { id: task.id, items: [] };
          }
        })
      );

      // Aggregate all comps by type
      const soldSourceIds = ['ebay-sold', 'poshmark', 'swappa', 'reverb', 'stockx', 'mercari'];
      const allComps = { sold: [], active: [] };

      // 1. Browser pool results
      for (const r of scrapeResults) {
        if (r.status !== 'fulfilled') continue;
        const { id, items } = r.value;
        if (soldSourceIds.includes(id)) {
          allComps.sold.push(...items);
        } else {
          allComps.active.push(...items);
        }
      }

      // 2. API-based sources (Reverb REST API, StockX Algolia bypass)
      const apiResults = await fetchApiMarketplaceSources(query);
      for (const res of apiResults) {
        if (res.items.length > 0) {
          allComps.sold.push(...res.items);
          event.sender.send('price-source-progress', { sourceId: res.sourceId, status: 'done', count: res.items.length });
        } else {
          event.sender.send('price-source-progress', { sourceId: res.sourceId, status: res.error ? 'error' : 'done', count: 0 });
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
      console.error('[Marketplace] Price research failed:', error.message);
      return { success: false, error: error.message };
    }
  });

}
