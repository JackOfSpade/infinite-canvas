/**
 * Marketplace IPC handlers — photo analysis, multi-source FMV research, listing prep.
 *
 * Pricing Data Sources (7 total):
 *   Tier 1 Sold:  eBay Sold, Poshmark Sold, Swappa, StockX, Reverb
 *   Tier 1 Active: eBay Active
 *   Tier 2 Sold:  Mercari Sold
 */
import { callLLMVision, callLLMText } from './llm.js';
import { handleSafe } from './ipcUtils.js';
import { scrapeMultiple } from './browserPool.js';
import { logger } from '../logger.js';
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
async function fetchApiMarketplaceSources(query, signal = null, nodeId = null, sender = null) {
  const apiTasks = [
    { sourceId: 'reverb', fn: (s) => fetchReverbListings(query, true, s) },
    { sourceId: 'stockx', fn: (s) => fetchStockXListings(query, s) },
  ];

  return Promise.all(apiTasks.map(async ({ sourceId, fn }) => {
    try {
      if (signal?.aborted) throw new Error('Aborted');
      const items = await fn(signal);
      if (sender && !sender.isDestroyed()) {
        sender.send('price-source-progress', { nodeId, sourceId, status: 'done', count: items.length });
      }
      return { sourceId, items };
    } catch (error) {
      if (sender && !sender.isDestroyed()) {
        sender.send('price-source-progress', { nodeId, sourceId, status: 'error', count: 0 });
      }
      return { sourceId, items: [], error: error?.message || String(error) };
    }
  }));
}

/**
 * Best-effort marketplace listing status check.
 *
 * Fetches the listing URL as plain HTML and asks the LLM to classify it. This
 * is intentionally provider-agnostic — every marketplace renders slightly
 * different SOLD / ENDED / REMOVED / login-wall markup, so handing the raw
 * page to the model is more robust than writing eight bespoke scrapers (and
 * matches the "remove auto-posting, too complicated and changes often"
 * direction the user took on this module).
 *
 * Returns one of: live | sold | expired | needs-login | unknown.
 * A 4xx/5xx that smells like a login redirect maps to `needs-login` so the
 * UI can tell the user "log in to the marketplace site again."
 */
async function checkListingStatusViaAI(url, platformId, signal) {
  let html, status, finalUrl;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        // A real-browser UA avoids most marketplaces' API-shaped 403s. We're
        // not bypassing any auth — just asking for the same page the user sees.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal,
    });
    status = res.status;
    finalUrl = res.url || url;
    html = await res.text();
  } catch (err) {
    return { status: 'error', message: `Fetch failed: ${err?.message || String(err)}` };
  }

  // Cheap pre-classification: if the response redirected to a login URL or
  // returned 401/403, we don't need to burn AI tokens deciding.
  const finalLower = String(finalUrl).toLowerCase();
  if (status === 401 || status === 403 || /\/(login|signin|sign-in|account\/login)/i.test(finalLower)) {
    return { status: 'needs-login', message: `Marketplace requires a fresh login (redirected to ${finalUrl}). Sign in on the ${platformId} site in your browser, then retry.` };
  }
  if (status === 404 || status === 410) {
    return { status: 'expired', message: `Listing not found (${status}). It may have been removed or sold and de-indexed.` };
  }
  if (!html || html.length < 200) {
    return { status: 'unknown', message: `Empty or near-empty response (${html?.length || 0} bytes).` };
  }

  // Trim to keep token usage modest — most status signals live in the page
  // head and the first content section (status banner, "this listing has
  // ended", etc.). 12k chars covers that comfortably.
  const trimmed = html.slice(0, 12000).replace(/\s+/g, ' ');

  let parsed;
  try {
    parsed = await callLLMText(`
You are checking the live status of a marketplace listing. The user posted a listing on ${platformId} and pasted its URL; we fetched the page HTML and need to know whether the item is still available.

URL: ${url}
HTTP status: ${status}
HTML (truncated):
${trimmed}

Return ONLY a JSON object:
{
  "status": "live" | "sold" | "expired" | "needs-login" | "unknown",
  "message": "1 short sentence explaining the signal you saw (e.g. 'Page shows SOLD banner', 'Listing ended, no buyer', 'Login wall — cannot determine status')"
}

Classification rules:
- "live"        — page renders the product with a buy button / asking price
- "sold"        — page says SOLD, completed, item ended with buyer, etc.
- "expired"     — page says listing ended/removed/unavailable with no buyer, OR a 404-ish "not found" state inside the body
- "needs-login" — page redirected to a login form or shows a "sign in to view this" wall
- "unknown"     — none of the above is clear

Be conservative: prefer "unknown" over a wrong guess.`, signal);
  } catch (err) {
    return { status: 'error', message: `AI classification failed: ${err?.message || String(err)}` };
  }

  const allowed = new Set(['live', 'sold', 'expired', 'needs-login', 'unknown']);
  const out = {
    status:  allowed.has(parsed?.status) ? parsed.status : 'unknown',
    message: parsed?.message || '',
  };
  return out;
}

/**
 * Register all Marketplace IPC handlers.
 */
export function registerMarketplaceHandlers() {
  // ── Analyze Product Photos ────────────────────────────────────────────────
  handleSafe('analyze-photos', async (event, { imagePaths, nodeId }, signal) => {
    logger.info(`[Marketplace][${nodeId}] Analyzing`, imagePaths.length, 'photos');

    const result = await callLLMVision(imagePaths, `
You are a marketplace listing expert. Analyze these product photos and identify what is being sold.

Return a JSON object:
{
  "brand": "Identified brand name (or 'Unknown' if unclear)",
  "model": "Specific model name/number if identifiable (or 'Unknown')",
  "category": "Category > Subcategory (e.g. 'Electronics > Headphones > Over-Ear')",
  "condition": "New | Like New | Used - Excellent | Used - Good | Used - Fair | For Parts",
  "color": "Primary color(s)",
  "notable_features": "Any visible accessories, damage, special features",
  "generated_title": "An optimized selling title (80 chars max, include brand + model + key features + condition indicator)",
  "generated_description": "A detailed, buyer-friendly selling description (include specs if identifiable, condition details, what's included). 3-4 sentences."
}

Be specific about what you can clearly see. If you can't identify brand or model from the photos, say 'Unknown' — don't guess.`, signal);

    logger.info(`[Marketplace][${nodeId}] Product identified:`, result?.generated_title || 'Unknown');
    return { product: result };
  });

  // ── Research Price (Multi-Source FMV) ──────────────────────────────────────
  handleSafe('research-price', async (event, { query, condition, nodeId }, signal) => {
    logger.info(`[Marketplace][${nodeId}] Researching price for:`, query);

    const tasks = buildCompTasks(query);

    // Notify frontend that all sources are starting
    for (const t of tasks) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('price-source-progress', { nodeId, sourceId: t.id, status: 'searching', count: 0 });
      }
    }

    const scrapeResultsPromise = scrapeMultiple(tasks, (res) => {
      if (event.sender.isDestroyed()) return;
      const items = Array.isArray(res.data) ? res.data : [];
      event.sender.send('price-source-progress', {
        nodeId,
        sourceId: res.id,
        status: res.success ? 'done' : 'error',
        count: items.length,
      });
    }, signal);

    const apiSourceIds = ['reverb', 'stockx'];
    for (const sourceId of apiSourceIds) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('price-source-progress', { nodeId, sourceId, status: 'searching', count: 0 });
      }
    }
    const apiResultsPromise = fetchApiMarketplaceSources(query, signal, nodeId, event.sender);

    const [scrapeResults, apiResults] = await Promise.all([scrapeResultsPromise, apiResultsPromise]);

    const taskCategoryMap = buildTaskCategoryMap(tasks);
    const allComps = { sold: [], active: [] };

    // 1. Browser pool results
    for (const r of scrapeResults) {
      if (!r.success) {
        logger.warn(`[Marketplace] A scrape task for ${r.id} was rejected: ${r.error}`);
        continue;
      }
      const { id, data: items } = r;
      const category = taskCategoryMap[id] ?? 'sold'; // API sources (reverb, stockx) are sold
      if (Array.isArray(items)) {
        allComps[category].push(...items);
      }
    }

    // 2. API-based sources (Reverb, StockX)
    // Note: fetchApiMarketplaceSources already sent per-source progress events.
    for (const res of apiResults) {
      if (res.items.length > 0) {
        allComps.sold.push(...res.items);
      }
    }

    const totalComps = allComps.sold.length + allComps.active.length;
    logger.info(`[Marketplace] Found ${allComps.sold.length} sold, ${allComps.active.length} active comps across all sources`);

    // Guard: Research process is long. Check before heavy synthesis.
    if (signal.aborted) {
      throw new Error('Window closed');
    }

    // If we have comp data, ask Gemini to synthesize pricing + routing
    if (totalComps > 0) {
      const pricing = await callLLMText(`
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

Use platform IDs: ebay, facebook, mercari, poshmark, depop, swappa, reverb, whatnot`, signal);

      return {
        pricing,
        comps: allComps,
      };
    }

    // No comps found — return empty with message
    return {
      pricing: {
        recommended_price: null,
        justification: 'No comparable listings found across eBay, Poshmark, Swappa, StockX, Reverb, or Mercari. Try adjusting the search terms or set your own price.',
        market_summary: { sold_count: 0, active_count: 0 },
        recommended_platforms: [],
      },
      comps: { sold: [], active: [] },
    };
  });

  // ── Check listing status (per-marketplace card) ───────────────────────────
  handleSafe('check-listing-status', async (_event, { url, platformId, nodeId }, signal) => {
    logger.info(`[Marketplace][${nodeId}] Checking ${platformId} listing status: ${url}`);
    const result = await checkListingStatusViaAI(url, platformId, signal);
    return result;
  });
}
