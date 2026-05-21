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
import { fetchHtmlAuthed } from './stealthBrowser.js';
import { getMarketplaceWatchUrls } from './settings.js';
import {
  classifyMultipleUrls,
  aggregateStrongest,
  extractListingIdentifier,
  plainFetcher,
} from './listingStatusCheck.js';
import { openCaptchaResolveWindow } from './browser/authWindows.js';
import { compsForPricing } from './resultCaps.js';
import { logger } from '../logger.js';
import { VISION_PRODUCT_ANALYSIS_SCHEMA, PRICE_SYNTHESIS_SCHEMA, buildPlatformFitSchema } from './aiSchemas.js';
import {
  EBAY_SOLD_EXTRACTOR, EBAY_SOLD_CONFIG,
  EBAY_ACTIVE_EXTRACTOR, EBAY_ACTIVE_CONFIG,
  POSHMARK_SOLD_EXTRACTOR, POSHMARK_CONFIG,
  SWAPPA_EXTRACTOR, SWAPPA_CONFIG,
  MERCARI_SOLD_EXTRACTOR, MERCARI_CONFIG,
  PRICECHARTING_EXTRACTOR, PRICECHARTING_CONFIG,
  COMP_EXTRACT_CAPS,
} from '../extractors/marketplace.js';
import {
  fetchReverbListings,
} from '../extractors/apiExtractors.js';

// ── Pipeline telemetry ───────────────────────────────────────────────────────
// Sell-side analog of jobs.js's getJobsTelemetry: records the last marketplace
// pipeline run so the bug reporter can answer "did we analyze all the comps we
// found and did pricing work?" without depending on the renderer node tree
// (gone the instant the SellHub is deleted) or the 60-line log ring buffer
// (scrolls). Each stage stamps independently — a captcha-resolve or single-
// source rescrape can run without a fresh full scrape.
const marketplaceTelemetry = {
  // The hub node that produced this run. Stamped by every stage handler so the
  // bug report can flag when the funnel belongs to a node that ISN'T in the
  // canvas the report was generated from — these telemetry objects are
  // main-process singletons shared by every open window/canvas, so without this
  // a marketplace run from one canvas leaks into another canvas's report.
  nodeId:    null,
  analyze:   null, // { ts, photos, title, mock }
  scrape:    null, // { ts, sold, active, sources, warnings, blocked }
  resolves:  {},   // { [sourceId]: { ts, extracted, category } } — keyed so a
                   // multi-source recovery (e.g. Mercari then eBay) keeps every
                   // resolve; re-resolving a source replaces its entry. Reset
                   // when a fresh scrape stamps so resolves are scoped to it.
  synthesis: null, // { ts, soldFound, activeFound, soldUsed, activeUsed, recommendedPrice, matchQuality }
  fit:       null, // { ts, platforms, good, unfit }
};

export function getMarketplaceTelemetry() {
  return marketplaceTelemetry;
}

/**
 * Count distinct listings in a comp array, mirroring the extractors' dedup key:
 * the listing URL when present, else title+price. Lets the funnel surface
 * "found vs. unique" so an extractor that double-counts (e.g. nested-DOM
 * matches) can't hide behind a healthy-looking raw total.
 */
function uniqueCompCount(items) {
  if (!Array.isArray(items)) return 0;
  const seen = new Set();
  for (const it of items) {
    const key = (it?.url && String(it.url).trim()) || `${it?.title || ''}|${it?.price ?? ''}`;
    seen.add(key);
  }
  return seen.size;
}

/** Count comps per source, for the report's kept/dropped composition. */
function countBySource(items) {
  const out = {};
  for (const it of (Array.isArray(items) ? items : [])) {
    const k = it?.source || 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * Pick the top `n` comps for the model FAIRLY across sources (round-robin),
 * best-title-match first within each source.
 *
 * Replaces a plain `sorted.slice(0, n)`, which was order-dependent and let one
 * source monopolize the whole cap: when the title-match score can't discriminate
 * (e.g. query "Apple iPhone X" → tokens drop the 1-char "x", so cases and real
 * phones all tie), the slice degenerates to array order. A run where Poshmark
 * (mostly $5-$35 cases) merged before eBay-sold kept all 25 sold slots as
 * Poshmark and dropped every gold-standard eBay-sold phone — doubling the price
 * ($85→$185) purely on merge order. Round-robin guarantees each source is
 * represented regardless of order, and the source ordering is deterministic
 * (best-in-group score, then name) so the result no longer depends on whether a
 * source arrived via the headless scrape or a later captcha-resolve.
 */
function selectAcrossSources(items, n, scoreFn) {
  const arr = Array.isArray(items) ? items : [];
  if (n <= 0 || arr.length === 0) return [];
  const groups = new Map();
  for (const it of arr) {
    const key = it?.source || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const g of groups.values()) g.sort((a, b) => scoreFn(b) - scoreFn(a));
  const sources = [...groups.keys()].sort((a, b) => {
    const d = scoreFn(groups.get(b)[0]) - scoreFn(groups.get(a)[0]);
    return d !== 0 ? d : (a < b ? -1 : a > b ? 1 : 0);
  });
  const picked = [];
  const cursor = new Map(sources.map(s => [s, 0]));
  let advanced = true;
  while (picked.length < n && advanced) {
    advanced = false;
    for (const s of sources) {
      if (picked.length >= n) break;
      const g = groups.get(s);
      const i = cursor.get(s);
      if (i < g.length) { picked.push(g[i]); cursor.set(s, i + 1); advanced = true; }
    }
  }
  return picked;
}

/**
 * Drop non-genuine listings before they reach the pricing model. eBay surfaces
 * its own internal load/QA listings (titled "… Bidding Test generic N of x",
 * priced $0.01–$0.90) inside ordinary sold/active search results — they are not
 * real market comps, so they inflate counts and could skew pricing. Conservative
 * on purpose: only the unmistakable test-harness title signature (no real phone
 * listing is titled "bidding test"). Extend the pattern if other artifacts show
 * up. Returns the kept comps + the rejected ones (so the report can name them).
 */
function filterJunkComps(items) {
  const kept = [], rejected = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    if (/\bbidding test\b/i.test(String(it?.title || ''))) rejected.push(it);
    else kept.push(it);
  }
  return { kept, rejected };
}

/**
 * Price distribution {n, min, median, max} of a comp slice, for the report's
 * "kept vs. dropped by the cap" line — the evidence behind "by-design, not lost
 * data." If the DROPPED slice's prices reach into the KEPT band, the title-match
 * cap dropped relevant comps, not just noise; if they sit below it, the cap is
 * working as intended. Returns null for an empty/price-less slice.
 */
function priceStats(items) {
  if (!Array.isArray(items)) return null;
  const prices = items.map(i => Number(i?.price) || 0).filter(p => p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return null;
  return {
    n: prices.length,
    min: prices[0],
    median: prices[Math.floor(prices.length / 2)],
    max: prices[prices.length - 1],
  };
}

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
    // Niche: video games + retro electronics. Returns empty for unrelated
    // queries (cheap), but for games it has clean aggregated sold-price
    // data that eBay's noisy search results often miss.
    {
      id: 'pricecharting', category: 'sold',
      url: `https://www.pricecharting.com/search-products?q=${encodeURIComponent(query)}&type=prices`,
      extractorJS: PRICECHARTING_EXTRACTOR,
      options: PRICECHARTING_CONFIG,
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
 * Scrape a SINGLE comp source by id. Used by the captcha-resolved auto-retry
 * flow so a freshly-unblocked source can fetch in isolation instead of
 * triggering a full re-scrape of every other (already-successful) source.
 *
 * Returns the same shape per source as the multi-source path:
 * `{ sourceId, items, warning, category }`. Emits per-source progress
 * events (`searching` then `done`/`error`) so the existing comp card
 * subscribes and updates in place.
 */
async function scrapeOneSource(sourceId, query, sender, signal, nodeId) {
  const allTasks = buildCompTasks(query);
  const taskCategoryMap = buildTaskCategoryMap(allTasks);
  const task = allTasks.find(t => t.id === sourceId);

  const send = (status, count, warning = null, url = null) => {
    if (sender && !sender.isDestroyed()) {
      sender.send('price-source-progress', { nodeId, sourceId, status, count, warning, url });
    }
  };

  // Browser-pool source (ebay-sold, poshmark, swappa, ebay-active, mercari).
  if (task) {
    send('searching', 0);
    const results = await scrapeMultiple([task], (res) => {
      if (sender && !sender.isDestroyed()) {
        const items = Array.isArray(res.data) ? res.data : [];
        send(res.success ? 'done' : 'error', items.length, res.warning || null, task.url);
      }
    }, signal);
    const r = results[0];
    if (!r?.success) {
      return {
        sourceId,
        items: [],
        warning: { code: 'task-failed', severity: 'block', evidence: r?.error || 'unknown', suggestion: 'Scrape threw before completing.' },
        category: taskCategoryMap[sourceId] || 'sold',
      };
    }
    return {
      sourceId,
      items: Array.isArray(r.data) ? r.data : [],
      warning: r.warning || null,
      category: taskCategoryMap[sourceId] || 'sold',
    };
  }

  // API source (reverb only — StockX was removed from comp sources because
  // PerimeterX systematically blocks both the key bootstrap and the
  // hardcoded fallback).
  if (sourceId === 'reverb') {
    send('searching', 0);
    try {
      const result = await fetchReverbListings(query, true, signal);
      const items = Array.isArray(result) ? result : (result?.items || []);
      const warning = Array.isArray(result) ? null : (result?.warning || null);
      send('done', items.length, warning);
      return { sourceId, items, warning, category: 'sold' };
    } catch (error) {
      send('error', 0);
      return {
        sourceId,
        items: [],
        warning: { code: 'fetch-error', severity: 'block', evidence: error?.message || String(error), suggestion: 'API call failed during single-source rescrape.' },
        category: 'sold',
      };
    }
  }

  throw new Error(`Unknown sourceId: ${sourceId}`);
}

/**
 * Fetch API-based marketplace sources in parallel (no Puppeteer needed).
 * Reverb uses internal REST API, StockX uses Algolia bypass.
 */
async function fetchApiMarketplaceSources(query, signal = null, nodeId = null, sender = null) {
  // StockX removed — PerimeterX systematically blocks both the stealth-
  // browser key bootstrap and the hardcoded-key fallback, so it returned
  // zero usable data on every run. fetchStockXListings stays exported from
  // apiExtractors for the day someone has a working bypass.
  const apiTasks = [
    { sourceId: 'reverb', fn: (s) => fetchReverbListings(query, true, s) },
  ];

  return Promise.all(apiTasks.map(async ({ sourceId, fn }) => {
    try {
      if (signal?.aborted) throw new Error('Aborted');
      // Each API fetcher now returns { items, warning } so blocks/throttles
      // surface in the UI instead of silently producing an empty array.
      const result = await fn(signal);
      const items = Array.isArray(result) ? result : (result?.items || []);
      const warning = Array.isArray(result) ? null : (result?.warning || null);
      if (sender && !sender.isDestroyed()) {
        sender.send('price-source-progress', { nodeId, sourceId, status: 'done', count: items.length, warning });
      }
      return { sourceId, items, warning };
    } catch (error) {
      if (sender && !sender.isDestroyed()) {
        sender.send('price-source-progress', { nodeId, sourceId, status: 'error', count: 0 });
      }
      return { sourceId, items: [], error: error?.message || String(error) };
    }
  }));
}

/**
 * Multi-source marketplace listing status check.
 *
 * For each URL provided (the listing URL, per-card watchUrls, and per-platform
 * watchUrls from Settings), fetches the page and asks the LLM "what is the
 * state of listing X?" — not "what is on this page?" That identifier anchoring
 * is what lets the same engine handle:
 *   - the listing's own page (SOLD banner above the buy button)
 *   - a notifications/activity center ("Your item just sold for $180")
 *   - the seller's account dashboard with N listings (find this row's status)
 *
 * Public listing URLs go through plain fetch. Per-card watchUrls and
 * per-platform watchUrls (typically dashboards / notification feeds) route
 * through the stealth browser so the persistent userDataDir's cookies — set
 * by a prior `openLoginWindow` — keep us logged in.
 *
 * Returns { status, message, sources } where status is the strongest signal
 * across all URLs (sold > expired > needs-login > live > unknown), message is
 * a human sentence quoting that evidence, and sources is the per-URL trace.
 */
async function checkListingStatusMultiSource({
  listingUrl,
  platformId,
  watchUrls = [],
  productTitle,
  listingId,
  signal,
}) {
  // Identity anchor — model uses this to find the right row/banner across
  // any page format. Falls back to product title when the URL has no
  // recognizable item id.
  const identifier = listingId || extractListingIdentifier(listingUrl, productTitle);

  // Per-platform watch URLs are configured once and apply to every card on
  // that platform. Plus optional per-card watchUrls (rare; for power users).
  const platformWatchUrls = getMarketplaceWatchUrls(platformId);
  const cardWatchUrls     = (watchUrls || []).filter(Boolean);

  // De-duplicate while preserving order: listingUrl first (cheapest, public),
  // then per-card overrides, then platform-wide watch URLs.
  const seen = new Set();
  const all = [];
  const pushUnique = (u, source) => {
    const key = String(u || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    all.push({ url: key, source });
  };
  pushUnique(listingUrl, 'listing');
  cardWatchUrls.forEach(u => pushUnique(u, 'card-watch'));
  platformWatchUrls.forEach(u => pushUnique(u, 'platform-watch'));

  if (all.length === 0) {
    return { status: 'error', message: 'No URLs to check (paste a listing URL or configure a platform watch URL in Settings)', sources: [] };
  }

  // Watch URLs are almost always auth-walled (dashboards, notification
  // feeds), so route them through the cookie-bearing stealth browser. The
  // canonical listing URL stays on plain fetch for speed. classifyMultipleUrls
  // fetches all N URLs in parallel, then makes ONE consolidated LLM call so
  // the instruction block + listing identity preamble is paid once instead
  // of N times — meaningful savings when N≥2.
  const urlSpecs = all.map(({ url, source }) => ({
    url,
    urlLabel: source === 'listing' ? 'listing' : source === 'card-watch' ? 'card watch' : 'platform watch',
    fetcher:  source === 'listing' ? plainFetcher : fetchHtmlAuthed,
  }));

  const perUrl = await classifyMultipleUrls({
    urlSpecs,
    listingIdentifier: identifier,
    productTitle,
    platformId,
    signal,
  });

  return aggregateStrongest(perUrl);
}

/**
 * Register all Marketplace IPC handlers.
 */
export function registerMarketplaceHandlers() {
  // ── Analyze Product Photos ────────────────────────────────────────────────
  handleSafe('analyze-photos', async (event, { imagePaths, nodeId }, signal) => {
    logger.info(`[Marketplace][${nodeId}] Analyzing`, imagePaths.length, 'photos');
    marketplaceTelemetry.nodeId = nodeId;
    marketplaceTelemetry.windowId = event.sender?.id ?? null;

    const aiMeta = {}; // populated with the model that actually served this call
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
  "generated_description": "A detailed, buyer-friendly selling description (include specs if identifiable, condition details, what's included). 3-4 sentences.",
  "search_query": "A short, neutral query string for marketplace search engines. Include ONLY brand + model + the 1-2 most price-driving specs (storage size, screen size, year, capacity, etc. — whatever's relevant for the category). EXCLUDE condition keywords ('For Parts', 'Used', 'Refurbished'), color (unless brand-defining), and marketing fluff. Goal: broad enough to surface variants for price comparison. Examples: 'Apple iPhone XS 512GB', 'Sony WH-1000XM4', 'Nintendo Switch OLED'."
}

Be specific about what you can clearly see. If you can't identify brand or model from the photos, say 'Unknown' — don't guess.`, { signal, task: 'vision-product-analysis', responseSchema: VISION_PRODUCT_ANALYSIS_SCHEMA, meta: aiMeta });

    logger.info(`[Marketplace][${nodeId}] Product identified:`, result?.generated_title || 'Unknown', `(model: ${aiMeta.model || '?'})`);
    marketplaceTelemetry.analyze = {
      ts: Date.now(),
      photos: Array.isArray(imagePaths) ? imagePaths.length : 0,
      title: result?.generated_title || '(unknown)',
      mock: !!result?._mockMode,
      model: aiMeta.model || null,
    };
    return { product: result };
  });

  // ── Scrape Comps (no AI synthesis) ────────────────────────────────────────
  // Split from synthesis so the renderer can pause between scrape and AI when
  // some sources errored — gives the user a chance to solve captchas / dismiss
  // failures before the model spends tokens on partial data. The renderer
  // calls `synthesize-price` afterward with the comps it decides to use.
  handleSafe('scrape-price-comps', async (event, { query, nodeId }, signal) => {
    logger.info(`[Marketplace][${nodeId}] Scraping comps for:`, query);
    marketplaceTelemetry.nodeId = nodeId;
    marketplaceTelemetry.windowId = event.sender?.id ?? null;

    const tasks = buildCompTasks(query);

    for (const t of tasks) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('price-source-progress', { nodeId, sourceId: t.id, status: 'searching', count: 0 });
      }
    }

    const sourceUrlById = Object.fromEntries(tasks.map(t => [t.id, t.url]));
    const scrapeResultsPromise = scrapeMultiple(tasks, (res) => {
      if (event.sender.isDestroyed()) return;
      const items = Array.isArray(res.data) ? res.data : [];
      event.sender.send('price-source-progress', {
        nodeId,
        sourceId: res.id,
        status: res.success ? 'done' : 'error',
        count: items.length,
        warning: res.warning || null,
        url: sourceUrlById[res.id] || null,
      });
    }, signal);

    const apiSourceIds = ['reverb'];
    for (const sourceId of apiSourceIds) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('price-source-progress', { nodeId, sourceId, status: 'searching', count: 0 });
      }
    }
    const apiResultsPromise = fetchApiMarketplaceSources(query, signal, nodeId, event.sender);

    const [scrapeResults, apiResults] = await Promise.all([scrapeResultsPromise, apiResultsPromise]);

    const taskCategoryMap = buildTaskCategoryMap(tasks);
    const allComps = { sold: [], active: [] };
    const scrapeWarnings = [];
    // Raw item count per source so the bug report can show which source
    // contributed what (and, paired with the synthesis "unique" count, expose
    // a single source double-counting).
    const bySource = {};

    for (const r of scrapeResults) {
      if (!r.success) {
        logger.warn(`[Marketplace] A scrape task for ${r.id} was rejected: ${r.error}`);
        // code 'task-failed' = the scrape threw before completing (browser-launch
        // / profile-lock conflict, network, nav timeout) — an INTERNAL error, not
        // an anti-bot wall. The report classifies it separately so a self-inflicted
        // browser-lock race never masquerades as a captcha the user must "solve."
        scrapeWarnings.push({ sourceId: r.id, severity: 'block', code: 'task-failed', evidence: r.error, suggestion: 'Scrape threw before completing — likely a browser-launch/profile-lock conflict or network error, NOT anti-bot. Check Recent Main-Process Logs in the bug report.' });
        bySource[r.id] = 0;
        continue;
      }
      const { id, data: items, warning } = r;
      if (warning) scrapeWarnings.push({ sourceId: id, ...warning });
      const category = taskCategoryMap[id] ?? 'sold';
      bySource[id] = Array.isArray(items) ? items.length : 0;
      if (Array.isArray(items)) allComps[category].push(...items);
    }

    for (const res of apiResults) {
      if (res.warning) scrapeWarnings.push({ sourceId: res.sourceId, ...res.warning });
      bySource[res.sourceId] = Array.isArray(res.items) ? res.items.length : 0;
      if (res.items.length > 0) allComps.sold.push(...res.items);
    }

    logger.info(`[Marketplace][${nodeId}] Scrape done: ${allComps.sold.length} sold, ${allComps.active.length} active, ${scrapeWarnings.length} warning(s)`);
    // Per-source warning reason so the funnel can explain a count (esp. a 0):
    // "swappa=0 ⚠️zero-extracted" tells stale-selectors/empty apart from a block,
    // turning a silently-empty source into a diagnosable one.
    const sourceWarnings = {};
    for (const w of scrapeWarnings) {
      if (w?.sourceId && !sourceWarnings[w.sourceId]) {
        sourceWarnings[w.sourceId] = { code: w.code, severity: w.severity, evidence: w.evidence };
      }
    }
    // Flag sources whose returned count sits at their extraction cap — a strong
    // "the page held more than we gathered" signal (see COMP_EXTRACT_CAPS). The
    // funnel surfaces this so a per-source count isn't mistaken for the full
    // available total.
    const bySourceAtCap = {};
    for (const [id, n] of Object.entries(bySource)) {
      const cap = COMP_EXTRACT_CAPS[id];
      if (cap != null && n >= cap) bySourceAtCap[id] = cap;
    }
    marketplaceTelemetry.scrape = {
      ts: Date.now(),
      sold: allComps.sold.length,
      active: allComps.active.length,
      sources: tasks.length + apiSourceIds.length,
      warnings: scrapeWarnings.length,
      // Anti-bot blocks vs. internal scrape errors are different failures with
      // different fixes — keep them separate instead of one "block-severity" bucket.
      blocked: scrapeWarnings.filter(w => w?.severity === 'block' && w?.code !== 'task-failed').length,
      errored: scrapeWarnings.filter(w => w?.code === 'task-failed').length,
      bySource,
      bySourceAtCap,
      sourceWarnings,
    };
    // A fresh full scrape starts a new run — drop any resolves recorded for a
    // previous product/run so the report's funnel only shows this run's.
    marketplaceTelemetry.resolves = {};

    if (signal.aborted) throw new Error('Window closed');

    return { comps: allComps, scrapeWarnings };
  });

  // ── Synthesize Price (AI step, takes pre-scraped comps) ───────────────────
  // Renderer calls this after `scrape-price-comps` once it decides to proceed
  // (either all sources clean, or user clicked "Skip & Price" with partial
  // data). Kept separate so we never spend AI tokens on a request the user
  // hasn't approved.
  handleSafe('synthesize-price', async (event, { query, condition, comps, nodeId }, signal) => {
    // Reject non-genuine listings (eBay internal test items, etc.) at the single
    // gate every comp passes through before pricing — covers both the scrape and
    // captcha-resolve paths. The rejection is surfaced in the report (not silent).
    const { kept: sold,   rejected: soldJunk }   = filterJunkComps(Array.isArray(comps?.sold) ? comps.sold : []);
    const { kept: active, rejected: activeJunk } = filterJunkComps(Array.isArray(comps?.active) ? comps.active : []);
    const junk = [...soldJunk, ...activeJunk];
    if (junk.length > 0) {
      logger.info(`[Marketplace][${nodeId}] Rejected ${junk.length} non-genuine listing(s) before pricing (e.g. "${(junk[0]?.title || '').slice(0, 60)}")`);
    }
    const total = sold.length + active.length;
    logger.info(`[Marketplace][${nodeId}] Synthesizing price from ${sold.length} sold + ${active.length} active comps`);
    marketplaceTelemetry.nodeId = nodeId;
    marketplaceTelemetry.windowId = event.sender?.id ?? null;

    if (total === 0) {
      marketplaceTelemetry.synthesis = {
        ts: Date.now(), soldFound: 0, activeFound: 0, soldUsed: 0, activeUsed: 0,
        junkRejected: junk.length, junkExample: junk[0]?.title ? String(junk[0].title).slice(0, 60) : null,
        recommendedPrice: null, matchQuality: 'none',
      };
      return {
        pricing: {
          recommended_price: null,
          justification: 'No similar listings to synthesize from — set your own price or resolve blocked sources and retry.',
          market_summary: { sold_count: 0, active_count: 0 },
          recommended_platforms: [],
        },
      };
    }

    // Deterministic pre-sort: rank each listing by how many tokens of the
    // ITEM query its title contains, descending. This guarantees exact-spec
    // matches survive the slice cap below — without it, similar-but-not-
    // exact listings could push true exact matches out of the 25-item
    // window the AI sees, leaving the AI to over-weight close variants
    // when better data was available but truncated.
    const queryTokens = String(query || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2);
    const scoreByTitleMatch = (item) => {
      const title = String(item?.title || '').toLowerCase();
      if (!title) return 0;
      let hits = 0;
      for (const t of queryTokens) if (title.includes(t)) hits++;
      return hits;
    };
    const byMatchDesc = (a, b) => scoreByTitleMatch(b) - scoreByTitleMatch(a);
    // How many comps actually reach the model: scaled to what's available and
    // bounded by the price-synthesis token budget (see resultCaps).
    const { sold: soldN, active: activeN } = compsForPricing(sold.length, active.length);
    // Pick FAIRLY across sources (round-robin), then present best-match-first so
    // the prompt's "pre-sorted by keyword match" hint still holds. The plain
    // top-N slice was order-dependent and let one source monopolize the cap when
    // title-match couldn't discriminate (see selectAcrossSources).
    const soldComps   = selectAcrossSources(sold, soldN, scoreByTitleMatch).sort(byMatchDesc);
    const activeComps = selectAcrossSources(active, activeN, scoreByTitleMatch).sort(byMatchDesc);
    // Dropped = everything not picked (for the report's kept-vs-dropped lines).
    const soldKeptSet   = new Set(soldComps);
    const activeKeptSet = new Set(activeComps);
    const soldDropped   = sold.filter(x => !soldKeptSet.has(x));
    const activeDropped = active.filter(x => !activeKeptSet.has(x));

    const synthMeta = {}; // populated with the model that actually served this call
    const pricing = await callLLMText(`
You are a pricing analyst and marketplace routing expert. Given these similar listings from multiple sources, recommend a selling price AND which platforms to list on. Use plain English in your justification — don't say "comp(s)" or "comparable"; say "similar listing(s)" or "sold listing(s)".

ITEM: ${query}
CONDITION: ${condition}

The listings below are pre-sorted by how many ITEM keywords appear in each title (highest match first). Use that ordering as your first hint when identifying anchor vs. adjusted vs. bound listings, then refine using the spec details inside each listing.

RECENTLY SOLD (what buyers actually paid):
${JSON.stringify(soldComps)}

CURRENTLY ACTIVE (competition):
${JSON.stringify(activeComps)}

WEIGHTING — rank each listing by how closely its spec matches the ITEM:
- ANCHOR: same spec across the price-driving attributes (whatever those are for this category — capacity, size, generation, condition tier, included accessories, model variant, etc.). Weight these heaviest.
- ADJUSTED: similar but differs on a known price-driving attribute. Use them, but mentally adjust their price up or down for the difference before averaging in. (E.g. a higher-capacity variant should be discounted down; a worse-condition variant should be discounted up to estimate same-condition value.)
- BOUND: only loosely related. Use as ceilings/floors only, not for the central estimate.

If exact-match listings are scarce, lean on adjusted listings — DO NOT refuse to price. Note the weighting and your adjustments in the justification so the user can sanity-check.

MATCH QUALITY — pick one of these three values for the "match_quality" field:
  strong   — 3 or more anchor listings within a tight price band
  moderate — anchored mostly on adjusted listings, OR a few anchors with a wide spread
  weak     — only bound listings were available; recommendation is best-guess

Return ONLY a single JSON object with EXACTLY this shape. No comments, no trailing prose, no type annotations, no explanation outside the JSON.

{
  "recommended_price": 0,
  "quick_sell_price": 0,
  "max_profit_price": 0,
  "justification": "3-5 sentences: state which listings anchored the price, what adjustments you applied for non-exact ones (direction + rough size), and any caveats. Cite specific titles or numbers where it helps.",
  "match_quality": "strong",
  "comp_breakdown": {
    "anchor_count": 0,
    "adjusted_count": 0,
    "bound_count": 0
  },
  "market_summary": {
    "sold_count": 0,
    "sold_median": 0,
    "sold_low": 0,
    "sold_high": 0,
    "active_count": 0,
    "active_lowest": 0
  },
  "recommended_platforms": [
    {
      "id": "ebay",
      "name": "eBay",
      "reason": "Why this platform is optimal for this item (1 sentence)",
      "estimated_fee_pct": 0,
      "net_payout": 0
    }
  ]
}

Field guidance:
- recommended_price: best single price for a sale within 1-2 weeks
- quick_sell_price: price that would likely sell in 1-3 days
- max_profit_price: highest reasonable price (may take 3-4 weeks)
- match_quality: one of "strong" | "moderate" | "weak" — use exactly one of those three string values
- comp_breakdown.*_count: integers (how many listings you treated as anchor / adjusted / bound)
- recommended_platforms: 2-4 entries from the list below

Platform routing rules for recommended_platforms (pick 2-4 most relevant):
- Electronics → Swappa (3% fee) > eBay (13%) > Mercari (10%)
- Fashion/Apparel → Depop (3.3% fee) > Poshmark (20% fee but 40-60% STR) > Mercari (10%)
- Sneakers → eBay (8% fee + Authenticity Guarantee) > StockX/GOAT
- Collectibles/Trading Cards → Whatnot (11% fee, live auction premium) > eBay (13%)
- Furniture/Home → Facebook Marketplace (0% local) only
- Musical Instruments → Reverb (5% fee, $500 cap) > eBay (6.35%)
- Luxury/Designer → eBay (13% + free authentication) > Poshmark
- General/Mixed → Mercari (10%) > eBay (13%) > Facebook (0% local)

Use platform IDs: ebay, facebook, mercari, poshmark, depop, swappa, reverb, whatnot`, {
      signal,
      task: 'price-synthesis',
      // Cap scales with comp count — the prompt asks the AI to classify
      // each listing as anchor/adjusted/bound, so thinking tokens grow
      // roughly linearly with input size. See llm.js TASK_MAX_TOKENS.
      hints: { itemCount: soldComps.length + activeComps.length },
      // Schema enforces: match_quality enum, comp_breakdown shape, platform
      // id enum, all numeric fields actually numeric. Eliminates the
      // recurring "AI returned invalid JSON" / "echoed the union type
      // notation literally" failures we hit twice this session.
      responseSchema: PRICE_SYNTHESIS_SCHEMA,
      meta: synthMeta,
    });

    // soldUsed/activeUsed are the counts that ACTUALLY reached the model after
    // the quality-ordered, budget-bounded slice above (see resultCaps) — the
    // "used vs. found" gap is the sell-side analog of the jobs funnel's expected
    // drops (by-design, not lost data). recommended_price=null is the "scraped
    // comps but produced no price" signal.
    marketplaceTelemetry.synthesis = {
      ts: Date.now(),
      soldFound: sold.length,
      activeFound: active.length,
      // Distinct listings among what was found — a found≫unique gap means an
      // extractor double-counted, silently inflating the set fed to pricing.
      soldUnique: uniqueCompCount(sold),
      activeUnique: uniqueCompCount(active),
      soldUsed: soldComps.length,
      activeUsed: activeComps.length,
      // Price distribution of what the cap KEPT vs. DROPPED, so "prices dropped
      // from analysis?" is answerable from the report: dropped prices below the
      // kept band = low-relevance noise (cap working); dropped prices reaching
      // into the kept band = the title-match ranking dropped relevant comps.
      soldKeptStats:      priceStats(soldComps),
      soldDroppedStats:   priceStats(soldDropped),
      activeKeptStats:    priceStats(activeComps),
      activeDroppedStats: priceStats(activeDropped),
      // Per-source composition of kept vs dropped — surfaces a source monopoly
      // (e.g. "kept: poshmark=25" while "dropped: ebay-sold=25") at a glance,
      // instead of having to read the raw comp JSON.
      soldKeptBySource:    countBySource(soldComps),
      soldDroppedBySource: countBySource(soldDropped),
      // Non-genuine listings (eBay test items, …) removed before pricing — surfaced
      // so the rejection is transparent, not a silent drop. soldFound/activeFound
      // above are already the post-rejection counts.
      junkRejected: junk.length,
      junkExample: junk[0]?.title ? String(junk[0].title).slice(0, 60) : null,
      recommendedPrice: pricing?.recommended_price ?? null,
      matchQuality: pricing?.match_quality || '(unknown)',
      model: synthMeta.model || null,
      // The model's OWN classification of the comps we fed it: anchor (weighted
      // heaviest) vs adjusted (price-corrected) vs bound (ceiling/floor only).
      // The sum is typically < fed because the model weights the rest out. This
      // is the LAST funnel stage and the one place a "silent drop from analysis"
      // could hide: the found→fed cap drop is reported above (kept/dropped bands),
      // but the fed→actually-weighted gap was invisible until now.
      compBreakdown: pricing?.comp_breakdown || null,
    };

    return { pricing };
  });

  // ── Rescrape a single comp source ─────────────────────────────────────────
  // Used after a captcha resolve to refetch ONLY the unblocked source,
  // instead of throwing away the prior scrape's ~70 successful comps and
  // re-paying for a full multi-source run. The renderer merges the returned
  // items into pendingComps and drops the source from scrapeWarnings.
  handleSafe('rescrape-source', async (event, { sourceId, query, nodeId }, signal) => {
    logger.info(`[Marketplace][${nodeId}] Rescraping single source: ${sourceId}`);
    const result = await scrapeOneSource(sourceId, query, event.sender, signal, nodeId);
    logger.info(`[Marketplace][${nodeId}] Rescrape ${sourceId} → ${result.items.length} item(s), warning=${result.warning?.code || 'none'}`);
    return result;
  });

  // ── Resolve captcha / anti-bot challenge that blocked a comp scrape ───────
  // Opens the exact failed URL in a visible browser sharing our scrape
  // userDataDir. Polls for the challenge page to disappear; auto-closes
  // when cleared. Resulting cookies persist for the userDataDir's session
  // TTL, so the renderer's follow-up "Refresh Prices" call lands on a
  // clean page instead of bouncing back into the same wall.
  handleSafe('resolve-captcha', async (event, { url, sourceId, nodeId } = {}, signal) => {
    logger.info(`[Marketplace][${nodeId}] User opening captcha-resolve window for ${sourceId}: ${url}`);
    // Look up the source's extractor + category (browser-pool sources only —
    // API sources like reverb/stockx don't have one and never go through
    // the captcha-resolve flow anyway since they have no URL to open). The
    // extractor runs inline in the visible session before close so we get
    // data from the same fingerprint that passed the bot check — a
    // headless rescrape after close just re-triggers the same wall.
    // Category travels with the result so the renderer drops items into
    // the right bucket (sold vs. active).
    const task = buildCompTasks('').find(t => t.id === sourceId);
    const inlineExtractorJS = task?.extractorJS || null;
    const category = task?.category || 'sold';
    // Pass through the abort signal so resetHandler → cancelNodeTask(hubId)
    // → abortNodeTasks aborts this controller and openCaptchaResolveWindow
    // closes the puppeteer browser. Without it the visible window persisted
    // beyond the in-canvas state that spawned it.
    const result = await openCaptchaResolveWindow(url, event.sender, signal, inlineExtractorJS);
    logger.info(`[Marketplace][${nodeId}] Captcha-resolve window closed for ${sourceId}; auto-detected=${result.resolved}, items=${result.items?.length ?? 'none'}`);

    // Sync the card's visible state with the merged data. Without this fake
    // "done, no warning" event, the comp-source-card keeps showing its
    // original captcha-presented warning + Solve/Skip buttons even after
    // the hub merged the inline-extracted items into pendingComps — leaving
    // the user thinking nothing happened. The card's existing 3s auto-dismiss
    // timer then removes it from the canvas naturally.
    if (result.resolved && Array.isArray(result.items) && !event.sender.isDestroyed()) {
      event.sender.send('price-source-progress', {
        nodeId,
        sourceId,
        status: 'done',
        count: result.items.length,
        warning: null,
        url: null,
      });
    }
    // Keyed by sourceId so a multi-source recovery keeps every resolve;
    // re-resolving the same source replaces its entry (latest wins).
    marketplaceTelemetry.resolves[sourceId] = {
      ts: Date.now(),
      extracted: Array.isArray(result?.items) ? result.items.length : 0,
      category,
    };
    return { ...result, category };
  });

  // ── Assess platform fit (which marketplaces suit this specific item) ──────
  // Separate from research-price so the pricing prompt stays focused on price,
  // and so the UI can show pricing immediately while fit populates a moment
  // later. Returns a per-platform verdict the SellHub uses to hide unfit
  // platforms behind a "show all" toggle.
  handleSafe('assess-platform-fit', async (event, { product, platforms, nodeId }, signal) => {
    logger.info(`[Marketplace][${nodeId}] Assessing platform fit across ${platforms?.length || 0} platforms`);
    marketplaceTelemetry.nodeId = nodeId;
    marketplaceTelemetry.windowId = event.sender?.id ?? null;
    if (!Array.isArray(platforms) || platforms.length === 0 || !product) {
      return { fit: {} };
    }

    const platformLines = platforms.map(p => `- ${p.id} (${p.name})`).join('\n');
    const productSummary = JSON.stringify({
      brand:             product.brand,
      model:             product.model,
      category:          product.category,
      condition:         product.condition,
      color:             product.color,
      notable_features:  product.notable_features,
      generated_title:   product.generated_title,
      generated_description: product.generated_description,
    }, null, 2);

    const fitMeta = {}; // populated with the model that actually served this call
    const verdict = await callLLMText(`
You are a marketplace policy + audience expert. For each marketplace, decide whether this specific item is a GOOD fit or UNFIT to list there.

UNFIT means at least one of: the platform's policies don't allow this category/condition, the platform's audience is wrong for this item (e.g. fashion-only platform getting electronics), or the item is so off-brand for the platform that it would barely get views.

GOOD means: the listing would be allowed AND the audience is plausible for this item.

ITEM:
${productSummary}

PLATFORMS:
${platformLines}

Return a JSON object with one entry per platform id. The "reason" field is REQUIRED for unfit verdicts (one short sentence), and may be omitted or empty for good fits.

{
  "<platform_id>": { "fit": "good" | "unfit", "reason": "..." },
  ...
}

Notes:
- "For Parts" or "Used - Fair" electronics: Mercari, Poshmark, Depop are unfit. eBay + Swappa + Facebook are good.
- Fashion items: Swappa, Reverb, Whatnot are unfit. Poshmark, Depop, Mercari, eBay are good.
- Musical instruments: Reverb is the obvious fit. eBay also good. Others usually unfit unless mainstream-consumer audio.
- Furniture / bulky home goods: Facebook (local) is good; everything else unfit (shipping kills the deal).
- Collectibles / cards: Whatnot + eBay are good; others usually unfit.

Be confident — don't mark everything "good." If you're unsure, lean "good" unless there's a real policy/audience reason.`, { signal, task: 'platform-fit-assessment', responseSchema: buildPlatformFitSchema(platforms.map(p => p.id)), meta: fitMeta });

    logger.info(`[Marketplace][${nodeId}] Fit verdicts:`, Object.entries(verdict || {}).map(([k, v]) => `${k}=${v?.fit}`).join(' '));
    const verdicts = Object.values(verdict || {});
    marketplaceTelemetry.fit = {
      ts: Date.now(),
      platforms: platforms.length,
      good: verdicts.filter(v => v?.fit === 'good').length,
      unfit: verdicts.filter(v => v?.fit === 'unfit').length,
      model: fitMeta.model || null,
    };
    return { fit: verdict || {} };
  });

  // ── Check listing status (per-marketplace card) ───────────────────────────
  // Renderer passes the listing URL + optional per-card watch URLs + the
  // product title (for identifier fallback + AI context). Per-platform watch
  // URLs are merged in from settings server-side so the renderer never has
  // to re-fetch them.
  handleSafe('check-listing-status', async (_event, args = {}, signal) => {
    const { url, platformId, nodeId, watchUrls, productTitle, listingId } = args;
    const urlCount = 1 + (Array.isArray(watchUrls) ? watchUrls.length : 0) + getMarketplaceWatchUrls(platformId).length;
    logger.info(`[Marketplace][${nodeId}] Checking ${platformId} status across ${urlCount} URL(s); listing=${url}`);
    const result = await checkListingStatusMultiSource({
      listingUrl: url,
      platformId,
      watchUrls,
      productTitle,
      listingId,
      signal,
    });
    logger.info(`[Marketplace][${nodeId}] Result: ${result.status} — ${result.message}`);
    return result;
  });
}
