/**
 * Marketplace IPC handlers — photo analysis, multi-source FMV research, listing prep.
 *
 * Pricing Data Sources (7 total):
 *   Tier 1 Sold:  eBay Sold, Poshmark Sold, Swappa, Reverb
 *   Tier 1 Active: eBay Active
 *   Tier 2 Sold:  Mercari Sold
 */
import { callLLMVision, callLLMText } from './llm.js';
import { handleSafe } from './ipcUtils.js';
import { scrapeMultiple } from './browserPool.js';
import { fetchHtmlAuthed, getSellMonitorConfig } from './stealthBrowser.js';
import { getMarketplaceWatchUrls } from './settings.js';
import { scanSellerHubPages } from './listingStatusCheck.js';
import { openCaptchaResolveWindow, getLastCaptchaHandoffAt } from './browser/authWindows.js';
import { shouldUseNativeRead, readHubUrlsViaNativeChrome } from './browser/nativeChromeReader.js';
import { withStatusCheckLock, getStatusCheckQueueDepth } from './statusCheckLock.js';
import { withMarketplaceBrowserLock, getMarketplaceBrowserQueueDepth } from './marketplaceBrowserLock.js';
import { createAggregatingProgress } from './compProgressAggregator.js';
import { getStatusCacheSync, isConfirmedDisconnectedVerdict, verifySellMonitorLogin, writeStatusCache } from './accounts.js';
import { compsForPricing } from './resultCaps.js';
import { isCompSourceEnabledInScope } from '../../src/utils/compSourceScope.js';
import { COMP_SOURCE_LOGIN_PLATFORM, getRequiredCompLoginPlatformIds } from '../../src/utils/marketplaceLoginPreflight.js';
import { retryWarningRequiringAction } from '../../src/utils/compsMerge.js';
import { deriveBundlePricingResult, roundToCents } from '../../src/utils/bundlePricing.js';
import { CONDITION_VALUES, formatConditionGuideForPrompt, formatConditionForPricingPrompt, stripConditionFromGeneratedTitle } from '../../src/utils/productConditions.js';
import { logger } from '../logger.js';
import { VISION_PRODUCT_ANALYSIS_SCHEMA, PRICE_SYNTHESIS_SCHEMA, BUNDLE_PRICE_SCHEMA, buildPlatformFitSchema } from './aiSchemas.js';
import {
  EBAY_SOLD_EXTRACTOR, EBAY_SOLD_CONFIG,
  EBAY_ACTIVE_EXTRACTOR, EBAY_ACTIVE_CONFIG,
  POSHMARK_SOLD_EXTRACTOR, POSHMARK_CONFIG,
  SWAPPA_EXTRACTOR, SWAPPA_SOLD_EXTRACTOR, SWAPPA_CONFIG,
  MERCARI_SOLD_EXTRACTOR, MERCARI_CONFIG,
  priceChartingQuery,
} from '../extractors/marketplace.js';
import {
  fetchReverbListings,
  fetchPriceChartingComps,
  fetchAptDecoComps,
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
  analyze:   null, // { ts, photos, title, rawTitle, titleCleaned, condition, model }
  scrape:    null, // { ts, sold, active, sources, warnings, blocked, browserContention }
  resolves:  {},   // { [sourceId]: { ts, extracted, category } } — keyed so a
                   // multi-source recovery (e.g. Mercari then eBay) keeps every
                   // resolve; re-resolving a source replaces its entry. Reset
                   // when a fresh scrape stamps so resolves are scoped to it.
  synthesis: null, // { ts, soldFound, activeFound, soldUsed, activeUsed, recommendedPrice, matchQuality }
  syntheses: [],   // One entry per independently-priced bundle item; synthesis = latest for back-compat.
  bundle:    null, // { ts, items, sum, quickPrice, bundlePrice, maxPrice, synergy, factors, model } — multi-item combine
  fit:       null, // { ts, platforms, good, unfit }
};

// Results can cross in transit: the next queued run may emit progress before
// the previous invoke response reaches the renderer. Wall-clock timestamps can
// tie within one millisecond, so stamp a per-process monotonic sequence too.
const marketplaceStatusProcessEpoch = `${process.pid}:${Date.now()}`;
let marketplaceStatusResultSequence = 0;

export function normalizePricingNotes(notes) {
  return String(notes || '').replace(/\s+/g, ' ').trim();
}

export function formatPricingNotesForPrompt(notes) {
  const normalized = normalizePricingNotes(notes);
  return normalized
    ? `\nUSER NOTES FROM SELLER:\n${normalized}\n`
    : '';
}

export function getMarketplaceTelemetry() {
  return marketplaceTelemetry;
}

function recordSynthesisTelemetry(entry) {
  // Stamp the owning node onto the entry itself. Synthesis runs UNLOCKED (no
  // marketplaceBrowserLock), so a second price check's scrape can begin — and
  // re-stamp the singleton's headline nodeId — while this one is still pricing.
  // Without a per-stage nodeId the report attributes this synthesis to whichever
  // node most recently touched the singleton (see buildMarketplacePipelineSnapshot).
  const stamped = entry?.nodeId ? entry : { ...entry, nodeId: marketplaceTelemetry.nodeId };
  marketplaceTelemetry.synthesis = stamped;
  const entries = Array.isArray(marketplaceTelemetry.syntheses) ? marketplaceTelemetry.syntheses : [];
  const key = stamped?.itemKey || stamped?.query || 'primary';
  const index = entries.findIndex(s => (s?.itemKey || s?.query || 'primary') === key);
  marketplaceTelemetry.syntheses = index >= 0
    ? entries.map((s, i) => (i === index ? stamped : s))
    : [...entries, stamped];
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
 * Remove an entire source only when even its BEST result is far below the best
 * result available from another source. Round-robin selection is valuable for
 * preventing source monopolies, but without this gate it also guarantees slots
 * to a wrong-product source (the report caught PriceCharting at match 0.85 vs
 * 5.84 overall). A conservative 25% floor preserves variant-title sources while
 * rejecting sources whose strongest result is still only a generic token match.
 */
export function filterGrosslyOffTargetSources(items, scoreFn, ratio = 0.25) {
  const list = Array.isArray(items) ? items : [];
  const groups = new Map();
  for (const item of list) {
    const source = item?.source || 'unknown';
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(item);
  }
  if (groups.size <= 1) return { kept: list, rejected: [], sources: [] };

  const bestBySource = new Map();
  for (const [source, group] of groups) {
    bestBySource.set(source, Math.max(...group.map(item => Number(scoreFn(item)) || 0)));
  }
  const strongest = Math.max(...bestBySource.values());
  if (!(strongest > 0)) return { kept: list, rejected: [], sources: [] };

  const rejectedSources = [...bestBySource.entries()]
    .filter(([, best]) => best < strongest * ratio)
    .map(([source]) => source);
  if (rejectedSources.length === 0 || rejectedSources.length === groups.size) {
    return { kept: list, rejected: [], sources: [] };
  }
  const rejectedSet = new Set(rejectedSources);
  return {
    kept: list.filter(item => !rejectedSet.has(item?.source || 'unknown')),
    rejected: list.filter(item => rejectedSet.has(item?.source || 'unknown')),
    sources: rejectedSources,
  };
}

// Accessories FOR an item, not the item itself — cases, covers, chargers, etc.
// These are the biggest comp pollutant: a marketplace like Poshmark (which bans
// phone sales) returns a "sold iPhone XS" page that is almost entirely $5–$75
// phone CASES. Their titles carry the full product name ("Apple iPhone XS
// Silicone Case") with no negative signal, so the title-match ranking can't tell
// them from a real phone — they tie, burn token-budget slots, and push genuine
// comps out. Site-agnostic (keys on the title, applies to every source).
const ACCESSORY_RE = /\b(cases?|covers?|chargers?|cables?|screen\s+protectors?|tempered\s+glass|glass\s+protectors?|skins?|bumpers?|holsters?|wallets?|lanyards?|straps?|docks?|adapters?|mounts?|popsockets?)\b/i;
// Strong "this is the actual device, not an accessory" signals — storage size,
// unlock status, carrier. A listing with an accessory word AND one of these
// (e.g. "iPhone XS 64GB Unlocked, charger included") is the device → kept. Keeps
// the accessory filter from false-positiving on real listings that mention an
// included accessory; absent for non-device categories, where the accessory word
// alone is the signal.
const DEVICE_SIGNAL_RE = /\b(\d{2,4}\s?gb|\dtb|unlocked|verizon|at&?t|t-?mobile|sprint|gsm|cdma|esim)\b/i;

/**
 * Drop non-genuine listings before they reach the pricing model. Two classes:
 *  1. eBay internal load/QA listings ("… Bidding Test generic N of x", $0.01–$0.90)
 *     surfaced inside ordinary search results.
 *  2. ACCESSORIES for the item rather than the item itself (see ACCESSORY_RE).
 *
 * Accessory rejection is product-AWARE: it only fires when the ITEM being priced
 * isn't itself that kind of accessory (so someone selling a phone case keeps their
 * case comps), and it spares any listing carrying a real device signal. General,
 * not per-site. Returns kept + rejected so the report names them (not a silent drop).
 */
function filterJunkComps(items, opts = {}) {
  const itemIsAccessory = ACCESSORY_RE.test(`${opts.query || ''} ${opts.productTitle || ''}`);
  const kept = [], rejected = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const title = String(it?.title || '');
    if (/\bbidding test\b/i.test(title)) { rejected.push(it); continue; }
    if (!itemIsAccessory && ACCESSORY_RE.test(title) && !DEVICE_SIGNAL_RE.test(title)) { rejected.push(it); continue; }
    kept.push(it);
  }
  return { kept, rejected };
}

/**
 * Price distribution {n, min, median, max} of a comp slice, for the report's
 * "kept vs. dropped by the cap" line — the evidence behind "by-design, not lost
 * data." The report compares the DROPPED median to the KEPT band/median to judge
 * whether the cap skewed the price (dropped median ≫/≪ kept) vs. dropped a
 * representative sample (≈ kept) vs. cheap noise (below the band — cap working
 * as intended). Returns null for an empty/price-less slice.
 */
function priceStats(items) {
  if (!Array.isArray(items)) return null;
  const prices = items.map(i => Number(i?.price) || 0).filter(p => p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
  return {
    n: prices.length,
    min: prices[0],
    median,
    max: prices[prices.length - 1],
  };
}

// ── Source → URL + Extractor mapping (browser pool sources only) ────────────
// Reverb has been moved to fetchApiMarketplaceSources (direct HTTP).
//
// Each task has a `category: 'sold' | 'active'` field so the aggregate loop can
// classify results without a separately-maintained hardcoded ID list.
function buildCompTasks(query) {
  // Swappa's /search is a MODEL picker (indexes by model, not configuration), so
  // an over-specific query like "Apple iPhone XS 64GB" can miss the model entirely
  // and fall through to featured/trending products. Strip storage/capacity tokens
  // — never part of a model slug — for Swappa ONLY; the full-text sources below
  // (eBay/Poshmark/Mercari) still want them as filters. The match-quality gate in
  // SWAPPA_EXTRACTOR guarantees correctness regardless, so this only raises
  // Swappa's recall (more real comps), never its wrong-product risk.
  const swappaQuery = String(query || '').replace(/\b\d+\s?(?:gb|tb)\b/gi, ' ').replace(/\s+/g, ' ').trim() || query;
  // Marketplace test mode (MARKETPLACE_TEST_ENABLED + MARKETPLACE_TEST_SOURCE)
  // narrows the run to a single targeted comp source; production returns all.
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
      // Swappa's real COMPLETED-SALE data: individual recent sold listings read
      // from the public `/xui/product/<slug>/sales` HTMX fragment (date ·
      // condition · carrier · storage · $price). This is the genuine "what buyers
      // actually paid" — the prior single `swappa` source scraped the /listings
      // page, which is ACTIVE asking prices (now split out below as category:active).
      id: 'swappa-sold', category: 'sold',
      url: `https://swappa.com/search?q=${encodeURIComponent(swappaQuery)}`,
      extractorJS: SWAPPA_SOLD_EXTRACTOR,
      options: SWAPPA_CONFIG,
    },
    {
      // Swappa /listings/<slug> is the ACTIVE for-sale market (asking prices), NOT
      // completed sales — verified live (availability=InStock). Kept as an ACTIVE
      // comp source (id 'swappa'); the sold prices come from 'swappa-sold' above.
      id: 'swappa', category: 'active',
      url: `https://swappa.com/search?q=${encodeURIComponent(swappaQuery)}`,
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
    // NOTE: PriceCharting (niche: video games + retro consoles) is NOT here — it
    // moved to the direct-HTTP API path (fetchPriceChartingComps). Its prices are
    // server-rendered but its client-side JS blanks them under automation, so the
    // stealth browser always read 0; a plain fetch with a browser UA gets them.
  ].filter(task => isCompSourceEnabledInScope(task.id));
}

/** Build a lookup map from task ID → category, derived once per price research call. */
function buildTaskCategoryMap(tasks) {
  const map = {};
  for (const t of tasks) map[t.id] = t.category;
  return map;
}

/**
 * The in-scope, login-capable platforms that are NOT logged in — the basis for
 * the hard login preflight (policy: a price check requires login on ALL in-scope
 * marketplaces before it runs). Derives the required platforms from the scoped
 * comp tasks, dedupes, and returns the ones whose session cache says not-connected.
 * Platforms with no login concept (pricecharting; reverb is an API key) impose no
 * requirement, so they never appear here. Exported for testing.
 * @returns {string[]} unique platform ids that must be logged in but aren't
 */
export function computeMissingLogins(tasks, sessionCache = {}) {
  const required = getRequiredCompLoginPlatformIds(tasks);
  return required.filter(p => !sessionCache[p]?.connected);
}

/**
 * Classify a FAILED comp scrape into a per-source warning.
 *
 * The decisive split is for a 0-result SITE_CHANGED, which is AMBIGUOUS: it fires
 * both for a genuine selector redesign AND for a scrape that hit a login wall /
 * anonymous page (the extractor finds 0 cards and trips SITE_CHANGED even though
 * nothing in the code is wrong). Reporting both as "stale-selectors" sends the
 * user to fix selectors when the real fix is "log in" — exactly what this report
 * hit on Poshmark. The login gate that was meant to prevent this
 * (`requiresLoginPlatform`) is currently dormant — no comp source sets it — so
 * this runtime classifier is what actually distinguishes the two, using:
 *   • the extractor's page-level `LOGIN-WALL` diag (strong, direct evidence the
 *     page was a sign-in wall) → promote to a `login-required` block; and
 *   • the session cache (the platform isn't logged in) as a softer corroborator
 *     that, short of a hard login wall, still nudges the suggestion toward login.
 */
export function classifyCompScrapeFailure(error, sourceId, sessionCache = {}) {
  const msg          = String(error || '');
  const platform     = COMP_SOURCE_LOGIN_PLATFORM[sourceId] || null;
  const notConnected = !!(platform && sessionCache[platform] && !sessionCache[platform].connected);

  if (!/SITE_CHANGED/i.test(msg)) {
    // A navigation TIMEOUT is a different failure from a clean internal throw: the
    // browser launched and the scrape ran for the WHOLE budget, then the page
    // never finished loading (typically bodyLen=0 — see "Timeout state" in Recent
    // Logs). That's a slow/hung site or an anti-bot TARPIT (holding the connection
    // open is a known anti-bot tactic) — emphatically NOT a browser-launch /
    // profile-lock conflict, which is what 'task-failed' implies. Conflating the
    // two sends the reader to chase a profile-lock bug that isn't there (this
    // report mislabeled a 45s Poshmark hang exactly that way).
    if (/timed?\s*out|timeout/i.test(msg)) {
      return {
        sourceId, severity: 'block', code: 'scrape-timeout',
        evidence: msg.slice(0, 300),
        suggestion: `Navigation didn't finish within the timeout — usually the page never loaded at all (check "Timeout state … bodyLen=0" in Recent Logs). That's a slow/hung site or an anti-bot tarpit, NOT a browser-launch/profile-lock conflict.${notConnected ? ` ${platform} is also not logged in — an anonymous request is likelier to be tarpitted; log in and retry.` : ''}`,
      };
    }
    // Genuine internal throw before completing. "Navigating frame was detached"
    // specifically = the page's browser was closed out from under it — by FAR
    // the most common cause is a CONCURRENT sell-side browser op (another node's
    // price check, or a captcha-resolve window) closing the shared stealth
    // browser mid-scrape; sell-side price checks now serialize to prevent that
    // (marketplaceBrowserLock), so a residual one points at a JOB-side
    // captcha-resolve. Other internal throws are a browser-launch/profile-lock
    // conflict or a network error. None of these are anti-bot or a nav timeout.
    const detached = /Navigating frame was detached|Target closed|Session closed|Protocol error/i.test(msg);
    return {
      sourceId, severity: 'block', code: 'task-failed',
      evidence: msg,
      suggestion: detached
        ? 'Scrape’s browser was closed mid-run ("Navigating frame was detached") — almost always a CONCURRENT browser op (another price check or a captcha-resolve window) closing the shared stealth browser, NOT anti-bot and NOT a nav timeout. Sell-side price checks now serialize (marketplaceBrowserLock); if this still fires, check whether a job-side captcha-resolve overlapped (see the Browser contention line + Recent Logs).'
        : 'Scrape threw before completing — a browser-launch/profile-lock conflict or network error (NOT anti-bot, NOT a navigation timeout). Check Recent Main-Process Logs in the bug report.',
    };
  }
  const loginWall = /LOGIN-WALL/i.test(msg);
  if (loginWall) {
    return {
      sourceId, severity: 'block', code: 'login-required',
      evidence: `Scrape returned 0 from a login wall / anonymous page${platform ? ` — ${platform} sold listings need sign-in` : ''}. ${msg.slice(0, 280)}`,
      suggestion: `Log in to ${platform || sourceId} in Settings > Accounts, then retry.`,
    };
  }
  return {
    sourceId, severity: 'warn', code: 'stale-selectors',
    // 1400, not 700: the diag payload alone (bodyHead≤200 + card0≤240 + prefix/
    // counts/path/title) commonly runs 750-900 chars, so 700 silently cut the
    // card0=[…] class skeleton off mid-token — exactly the new title/price
    // sub-selector names a redesign fix needs, discarded before any bug-report
    // filter code (even FULL) ever sees the report.
    evidence: msg.slice(0, 1400),
    suggestion: notConnected
      ? `Extractor returned 0 and ${platform} is not logged in — log in and retry FIRST. If it still returns 0 after login, the site HTML changed (the diag shows candidate cards>0 with the sub-selector at 0 = a real redesign); then update electron/extractors/marketplace.js.`
      : 'Extractor returned 0 results — site HTML may have changed. Update the scraper in electron/extractors/marketplace.js, rebuild, and retry.',
  };
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
        // Mirror the SITE_CHANGED detection from the multi-source path — when
        // page.evaluate() throws SITE_CHANGED the BrowserPool returns success:false
        // with error='SITE_CHANGED:...' and warning:null (anti-bot detector never
        // ran). Without this, the card receives warning:null → hasWarn:false →
        // Solve button reappears even though the extractor needs a code fix.
        const cbWarning = res.warning || (!res.success && /SITE_CHANGED/i.test(res.error || '')
          ? { code: 'stale-selectors', severity: 'warn', evidence: String(res.error || '').slice(0, 1400), suggestion: 'Extractor returned 0 results — site HTML may have changed. Update the scraper in electron/extractors/marketplace.js, rebuild, and retry.' }
          : null);
        send(res.success ? 'done' : 'error', items.length, cbWarning, task.url);
      }
    }, signal);
    const r = results[0];
    if (!r?.success) {
      const isSiteChanged = /SITE_CHANGED/i.test(r?.error || '');
      return {
        sourceId,
        items: [],
        warning: isSiteChanged ? {
          code: 'stale-selectors', severity: 'warn',
          evidence: String(r?.error || '').slice(0, 1400), // see classifyCompScrapeFailure — 700 clipped the card0=[…] skeleton mid-token
          suggestion: 'Extractor returned 0 results — site HTML may have changed. Update the scraper in electron/extractors/marketplace.js, rebuild, and retry.',
        } : {
          code: 'task-failed', severity: 'block',
          evidence: r?.error || 'unknown',
          suggestion: 'Scrape threw before completing.',
        },
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

  if (sourceId === 'reverb') {
    send('searching', 0);
    try {
      const result = await fetchReverbListings(query, signal);
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

  if (sourceId === 'aptdeco-active') {
    // A manual rescrape of an AptDeco card means the item IS furniture (a
    // non-furniture run auto-dismisses the card), so no category gate is needed.
    send('searching', 0);
    try {
      const result = await fetchAptDecoComps(query, signal);
      const items = Array.isArray(result?.items) ? result.items : [];
      const warning = result?.warning || null;
      send(warning ? 'error' : 'done', items.length, warning, result?.url || null);
      return { sourceId, items, warning, category: 'active' };
    } catch (error) {
      send('error', 0);
      return {
        sourceId,
        items: [],
        warning: { code: 'fetch-error', severity: 'block', evidence: error?.message || String(error), suggestion: 'API call failed during single-source rescrape.' },
        category: 'active',
      };
    }
  }

  throw new Error(`Unknown sourceId: ${sourceId}`);
}

/**
 * Fetch API-based marketplace sources in parallel (no Puppeteer needed).
 * Reverb uses an internal REST API.
 */
async function fetchApiMarketplaceSources(query, signal = null, emit = null, category = undefined) {
  // PriceCharting is a product-catalog search (not a listing index): seller-style
  // titles miss the exact product and fall back to ~100 fuzzy results, so the
  // query is normalized to the canonical product name (see priceChartingQuery).
  // `effectiveQuery` is the string actually sent — surfaced in the bug report so a
  // surprising count (e.g. 3 vs the catalog's many variants, or 0) can be told
  // apart as "normalizer over-stripped" vs "only N products exist".
  // `category` (the item's vision category) lets PriceCharting skip the request
  // for a clearly-non-collectible item — see fetchPriceChartingComps.
  const pcQuery = priceChartingQuery(query);
  // `category` is the comp bucket each source's results belong to. Reverb +
  // PriceCharting are SOLD comps; AptDeco is ACTIVE asking prices (furniture) —
  // the caller routes results by this field instead of assuming all API sources
  // are sold. AptDeco skips itself for non-furniture (isAptDecoApplicable).
  const apiTasks = [
    { sourceId: 'reverb', category: 'sold', effectiveQuery: query, fn: (s) => fetchReverbListings(query, s) },
    { sourceId: 'pricecharting', category: 'sold', effectiveQuery: pcQuery, fn: (s) => fetchPriceChartingComps(pcQuery, s, { category }) },
    { sourceId: 'aptdeco-active', category: 'active', effectiveQuery: query, fn: (s) => fetchAptDecoComps(query, s, { category }) },
  ].filter(task => isCompSourceEnabledInScope(task.sourceId));

  return Promise.all(apiTasks.map(async ({ sourceId, category: sourceCategory, effectiveQuery, fn }) => {
    try {
      if (signal?.aborted) throw new Error('Aborted');
      // Each API fetcher now returns { items, warning } so blocks/throttles
      // surface in the UI instead of silently producing an empty array.
      const result = await fn(signal);
      const items = Array.isArray(result) ? result : (result?.items || []);
      const warning = Array.isArray(result) ? null : (result?.warning || null);
      const url = Array.isArray(result) ? null : (result?.url || null);
      emit?.(sourceId, { status: 'done', count: items.length, warning });
      return { sourceId, items, warning, effectiveQuery, url, category: sourceCategory };
    } catch (error) {
      emit?.(sourceId, { status: 'error', count: 0 });
      return { sourceId, items: [], error: error?.message || String(error), effectiveQuery, category: sourceCategory };
    }
  }));
}

/**
 * Run ONE full comp scrape for a single query: every browser-pool source +
 * the API sources, assembled into { sold, active } comps plus the per-source
 * telemetry the bug report reads. Progress is reported through
 * `emit(sourceId, payload)` so the caller can ship it straight to IPC (single
 * item) or aggregate it across items (a multi-item "bundle" run). The login
 * preflight is the CALLER's job — it's per-platform, not per-query, so a
 * multi-item run only does it once.
 */
async function scrapeCompsForQuery(query, { emit, signal, sessionCache, category }) {
  const tasks = buildCompTasks(query);
  for (const t of tasks) emit(t.id, { status: 'searching', count: 0 });

  const sourceUrlById = Object.fromEntries(tasks.map(t => [t.id, t.url]));
  const scrapeResultsPromise = scrapeMultiple(tasks, (res) => {
    const items = Array.isArray(res.data) ? res.data : [];
    // Login-aware: a 0-result login wall is relabeled 'login-required' rather
    // than 'stale-selectors' so the card guides the user to log in.
    const warning = res.warning || (!res.success ? classifyCompScrapeFailure(res.error, res.id, sessionCache) : null);
    emit(res.id, {
      status: res.success ? 'done' : 'error',
      count: items.length,
      warning,
      url: sourceUrlById[res.id] || null,
    });
  }, signal);

  const apiSourceIds = ['reverb', 'pricecharting', 'aptdeco-active'].filter(isCompSourceEnabledInScope);
  for (const sourceId of apiSourceIds) emit(sourceId, { status: 'searching', count: 0 });
  const apiResultsPromise = fetchApiMarketplaceSources(query, signal, emit, category);

  const [scrapeResults, apiResults] = await Promise.all([scrapeResultsPromise, apiResultsPromise]);

  const taskCategoryMap = buildTaskCategoryMap(tasks);
  const comps = { sold: [], active: [] };
  const scrapeWarnings = [];
  const bySource = {};            // raw item count per source (drives funnel)
  const yieldBySource = {};       // {seen,noFields} per browser-pool source (partial-drift telemetry)
  const provenanceBySource = {};  // url + claimed sold/active category per source
  for (const t of tasks) provenanceBySource[t.id] = { url: t.url, category: t.category };
  const apiQueryBySource = {};    // effective (possibly-rewritten) query per API source
  const samplesBySource = {};     // top-few {title, price} per source — for the report's irrelevance check
  // A small sample of what a source ACTUALLY returned. Counts alone can't reveal
  // an off-target match (PriceCharting's fuzzy catalog hits, Poshmark accessories,
  // Swappa wrong-model); the titles make it self-evident. Capped + truncated so
  // the report stays small.
  const sampleOf = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 4).map(it => ({
    title: String(it?.title || '').slice(0, 80),
    price: Number.isFinite(Number(it?.price)) ? Number(it.price) : null,
  }));

  for (const r of scrapeResults) {
    if (!r.success) {
      logger.warn(`[Marketplace] A scrape task for ${r.id} was rejected: ${r.error}`);
      scrapeWarnings.push(classifyCompScrapeFailure(r.error, r.id, sessionCache));
      bySource[r.id] = 0;
      continue;
    }
    const { id, data: items, warning } = r;
    if (warning) scrapeWarnings.push({ sourceId: id, ...warning });
    const cat = taskCategoryMap[id] ?? 'sold';
    bySource[id] = Array.isArray(items) ? items.length : 0;
    if (r.yieldStats) yieldBySource[id] = r.yieldStats;
    if (Array.isArray(items) && items.length > 0) samplesBySource[id] = sampleOf(items);
    if (Array.isArray(items)) comps[cat].push(...items);
  }

  for (const res of apiResults) {
    if (res.warning) scrapeWarnings.push({ sourceId: res.sourceId, ...res.warning });
    bySource[res.sourceId] = Array.isArray(res.items) ? res.items.length : 0;
    if (typeof res.effectiveQuery === 'string') {
      apiQueryBySource[res.sourceId] = { query: res.effectiveQuery, url: res.url || null };
    }
    // Record provenance (url + comp bucket) for API sources too — the browser-task
    // loop above only sets it for scraped sources, leaving API sources missing from
    // the report's per-source provenance.
    provenanceBySource[res.sourceId] = { url: res.url || null, category: res.category || 'sold' };
    if (Array.isArray(res.items) && res.items.length > 0) samplesBySource[res.sourceId] = sampleOf(res.items);
    // Route by the source's bucket — most API sources are sold (reverb,
    // pricecharting) but AptDeco is active asking prices. Default sold for safety.
    if (res.items.length > 0) comps[res.category === 'active' ? 'active' : 'sold'].push(...res.items);
  }

  return { comps, scrapeWarnings, bySource, yieldBySource, provenanceBySource, apiQueryBySource, samplesBySource, sourceCount: tasks.length + apiSourceIds.length };
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
    marketplaceTelemetry.scrape = null;
    marketplaceTelemetry.resolves = {};
    marketplaceTelemetry.synthesis = null;
    marketplaceTelemetry.syntheses = [];
    marketplaceTelemetry.bundle = null;
    marketplaceTelemetry.fit = null;

    const aiMeta = {}; // populated with the model that actually served this call
    const result = await callLLMVision(imagePaths, `
You are a marketplace listing expert. Analyze these product photos and identify what is being sold.

Return a JSON object:
{
  "brand": "Identified brand name (or 'Unknown' if unclear)",
  "model": "Specific model name/number if identifiable (or 'Unknown')",
  "category": "Category > Subcategory (e.g. 'Electronics > Headphones > Over-Ear')",
  "condition": "${CONDITION_VALUES.join(' | ')} — pick the single best-fitting tier using the CONDITION GUIDE below",
  "color": "Primary color(s)",
  "notable_features": "Any visible accessories, damage, special features",
  "generated_title": "An identification-only selling title (80 chars max). Include brand + model + price-driving identity features. EXCLUDE condition, wear, damage, and words such as New, Used, Like New, Excellent Condition, Good Condition, For Parts, or Refurbished ONLY when they describe the item's condition — retain them when they are part of the official brand, model, or product name (for example, New Balance or New Nintendo 3DS). Condition details belong only in condition / notable_features / generated_description.",
  "generated_description": "A detailed, buyer-friendly selling description (include specs if identifiable, condition details, what's included). 3-4 sentences.",
  "search_query": "A short, neutral query string for marketplace search engines. Describe ONLY the single primary product identified above (the SAME one as brand / model / generated_title) — never combine two products or add words like 'bundle', 'lot', or 'set'. Include ONLY brand + model + the 1-2 most price-driving specs (storage size, screen size, year, capacity, etc. — whatever's relevant for the category). EXCLUDE condition keywords ('For Parts', 'Used', 'Refurbished'), color (unless brand-defining), and marketing fluff. Goal: broad enough to surface variants for price comparison. Examples: 'Apple iPhone XS 512GB', 'Sony WH-1000XM4', 'Nintendo Switch OLED'."
}

Be specific about what you can clearly see. If you can't identify brand or model from the photos, say 'Unknown' — don't guess.

CONDITION GUIDE — choose the condition tier whose definition best matches what the photos show. When between two tiers, pick the LOWER (more conservative) one unless the photos clearly support the higher:
${formatConditionGuideForPrompt()}

If the photos show MORE THAN ONE distinct product (a bundle/lot), pick the SINGLE most prominent / highest-value product and describe ONLY that one across every field (brand, model, generated_title, search_query). Do NOT fold the other products into the title or query — the seller lists them separately as additional items afterward.`, { signal, task: 'vision-product-analysis', responseSchema: VISION_PRODUCT_ANALYSIS_SCHEMA, meta: aiMeta });

    const rawTitle = String(result?.generated_title || '');
    const normalizedRawTitle = rawTitle.replace(/\s+/g, ' ').trim();
    const cleanTitle = stripConditionFromGeneratedTitle(rawTitle, result?.condition);
    const identityParts = [result?.brand, result?.model]
      .map((value) => String(value || '').trim())
      .filter((value) => value && !/^unknown$/i.test(value));
    const identityFallback = identityParts.length === 2
      && (identityParts[1].toLowerCase() === identityParts[0].toLowerCase()
        || identityParts[1].toLowerCase().startsWith(`${identityParts[0].toLowerCase()} `))
      ? identityParts[1]
      : [...new Set(identityParts)].join(' ');
    const finalTitle = cleanTitle || identityFallback || 'Unidentified item';
    const product = result
      ? { ...result, generated_title: finalTitle }
      : result;
    const titleCleaned = !!normalizedRawTitle && normalizedRawTitle !== finalTitle;
    if (titleCleaned) {
      logger.info(`[Marketplace][${nodeId}] Cleaned generated title: "${rawTitle}" → "${finalTitle}"`);
    }
    logger.info(`[Marketplace][${nodeId}] Product identified:`, product?.generated_title || 'Unknown', `(model: ${aiMeta.model || '?'})`);
    marketplaceTelemetry.analyze = {
      ts: Date.now(),
      nodeId,
      photos: Array.isArray(imagePaths) ? imagePaths.length : 0,
      title: product?.generated_title || '(unknown)',
      rawTitle: titleCleaned ? rawTitle : null,
      titleCleaned,
      condition: product?.condition || null,
      model: aiMeta.model || null,
      fallback: aiMeta.fallback || null,
    };
    return { product };
  });

  // ── Scrape Comps (no AI synthesis) ────────────────────────────────────────
  // Split from synthesis so the renderer can pause between scrape and AI when
  // some sources errored — gives the user a chance to solve captchas / dismiss
  // failures before the model spends tokens on partial data. The renderer
  // calls `synthesize-price` afterward with the comps it decides to use.
  handleSafe('scrape-price-comps', async (event, args = {}, signal) => {
    const { nodeId } = args;
    // Serialize against every other sell-side browser op — other nodes' price
    // checks AND captcha-resolve windows — via marketplaceBrowserLock. Without
    // it, a concurrent captcha-resolve calls closeStealthBrowser() mid-scrape
    // and detaches OUR in-flight pages ("Navigating frame was detached"), which
    // gets mis-reported as per-source anti-bot blocks (task-failed). If another
    // op is ahead, tell the renderer so the hub shows a "waiting behind N" banner.
    const aheadInQueue = getMarketplaceBrowserQueueDepth();
    if (aheadInQueue > 0) {
      logger.info(`[Marketplace][${nodeId}] Price check queued behind ${aheadInQueue} in-flight browser op(s)`);
      if (!event.sender.isDestroyed()) {
        event.sender.send('price-queue-status', { nodeId, queuedBehind: aheadInQueue });
      }
    }
    // The body runs inside the lock (one level of indentation is intentionally
    // kept flat to keep this a minimal, reviewable diff over the legacy handler).
    // The try/finally guarantees the "waiting" banner clears even on an
    // abort-while-queued, when the in-callback queuedBehind:0 below never runs.
    try {
    return await withMarketplaceBrowserLock(async () => {
    // We hold the browser now: clear the "waiting" banner and snapshot the
    // captcha-handoff watermark so we can tell, after the run, whether a
    // browser-close (a JOB-side captcha-resolve — this lock does NOT gate those)
    // detached any of our pages mid-scrape and turned them into false blocks.
    if (!event.sender.isDestroyed()) event.sender.send('price-queue-status', { nodeId, queuedBehind: 0 });
    const handoffAtStart = getLastCaptchaHandoffAt();
    // Multi-item ("bundle") support: a single listing can package several
    // independent products (kayak + paddle). Each item runs its own complete
    // pass through the pricing sources. Fall back to a single legacy `query`
    // so older callers / saved flows keep working.
    const items = (Array.isArray(args.items) && args.items.length > 0)
      ? args.items
      : [{ query: args.query, condition: args.condition }];
    marketplaceTelemetry.nodeId = nodeId;
    marketplaceTelemetry.windowId = event.sender?.id ?? null;
    // A full scrape starts a new pricing run. Clear every downstream stage now
    // so a report captured mid-run cannot mix this scrape with the previous
    // run's resolve/synthesis/bundle/fit results.
    marketplaceTelemetry.resolves = {};
    marketplaceTelemetry.synthesis = null;
    marketplaceTelemetry.syntheses = [];
    marketplaceTelemetry.bundle = null;
    marketplaceTelemetry.fit = null;
    logger.info(`[Marketplace][${nodeId}] Scraping comps for ${items.length} item(s):`, items.map(i => i.query).join(' | '));

    // The comp-source LIST is query-independent, so build once from item 0 for
    // the login preflight (the per-source cards are spawned by the renderer).
    const allTasks = buildCompTasks(items[0].query);

    // Pre-check login-required sources: skip scraping and emit login-required
    // immediately so the source card shows "Log in" guidance instead of running
    // the extractor (which would return 0 and falsely trigger SITE_CHANGED).
    const sessionCache = getStatusCacheSync();

    // ── Hard login preflight (policy: require login on ALL in-scope marketplaces) ──
    // A price check does NOT run unless every in-scope comp source backed by a
    // login-capable platform is logged in. This is the user-selected "hard-require
    // all before running" policy — it trades partial results for never scraping a
    // logged-out source anonymously (the cause of the Poshmark 0-results / 45s
    // tarpit-timeouts). When any required login is missing, the whole run is
    // blocked: every in-scope card is stamped (the missing platforms' sources as
    // `login-required`, the rest as `preflight-blocked`) and we return WITHOUT
    // scraping, so no tokens/time are spent.
    const missingLogins = computeMissingLogins(allTasks, sessionCache);
    if (missingLogins.length > 0) {
      const sourceWarnings = {};
      for (const t of allTasks) {
        const platform = COMP_SOURCE_LOGIN_PLATFORM[t.id];
        const needsThis = platform && missingLogins.includes(platform);
        const warning = needsThis ? {
          code: 'login-required', severity: 'block',
          evidence: `${platform} is not logged in — price checks require login on all in-scope marketplaces (policy).`,
          suggestion: `Log in to ${platform} in Settings > Accounts, then re-run the price check.`,
        } : {
          code: 'preflight-blocked', severity: 'block',
          evidence: `Run blocked — not logged in to: ${missingLogins.join(', ')}.`,
          suggestion: `Price checks require login on all in-scope marketplaces. Log in to ${missingLogins.join(', ')} and re-run.`,
        };
        sourceWarnings[t.id] = { code: warning.code, severity: warning.severity, evidence: warning.evidence };
        if (!event.sender.isDestroyed()) {
          event.sender.send('price-source-progress', { nodeId, sourceId: t.id, status: 'error', count: 0, url: null, warning });
        }
      }
      logger.info(`[Marketplace][${nodeId}] Price check blocked by login preflight — missing: ${missingLogins.join(', ')}`);
      marketplaceTelemetry.scrape = {
        ts: Date.now(),
        nodeId,
        sold: 0, active: 0,
        sources: allTasks.length + ['reverb', 'pricecharting'].filter(isCompSourceEnabledInScope).length,
        warnings: allTasks.length,
        blocked: 0, errored: 0, timedOut: 0,
        loginRequired: Object.values(sourceWarnings).filter(w => w.code === 'login-required').length,
        preflightBlocked: true, missingLogins,
        bySource: Object.fromEntries(allTasks.map(t => [t.id, 0])),
        sourceWarnings,
      };
      marketplaceTelemetry.resolves = {};
      return { items: [], comps: { sold: [], active: [] }, scrapeWarnings: [], preflightBlocked: true, missingLogins };
    }

    // Every source that reaches here is in scope. Run each item's full scrape
    // SEQUENTIALLY (safer for single-IP rate limits than fanning out N items at
    // once), routing per-source progress through an aggregator so a source card
    // only reports its terminal (done/error) — and thus only disappears — after
    // the LAST item finishes it. Single-item runs pass terminals straight
    // through, so the existing one-item flow is unchanged.
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('price-source-progress', { nodeId, ...payload });
    };
    const progressFactory = createAggregatingProgress({ totalItems: items.length, send });

    // Hub-level product category (vision analysis of the primary item) — lets
    // PriceCharting skip the request for a clearly-non-collectible listing. A
    // bundle is thematically coherent (a vacuum + its formula), so the primary's
    // category applies to every item; the per-item synthesis relevance gate is
    // the backstop for a genuinely mixed bundle.
    const productCategory = typeof args.category === 'string' ? args.category : undefined;

    const perItem = [];
    // Telemetry accumulators across items (the bug report reads these).
    const bySource = {};            // summed raw item count per source
    const yieldBySource = {};       // {seen,noFields} per browser-pool source
    const provenanceBySource = {};  // url + claimed category per source
    const apiQueryBySource = {};    // effective query per API source
    const samplesBySource = {};     // last-item sample of extracted comp titles per source
    let sourceCount = 0;
    for (let k = 0; k < items.length; k++) {
      if (signal.aborted) throw new Error('Window closed');
      const emit = progressFactory(k);
      const res = await scrapeCompsForQuery(items[k].query, { emit, signal, sessionCache, category: productCategory });
      perItem.push({
        query: items[k].query,
        label: items[k].label || null,
        condition: items[k].condition || null,
        comps: res.comps,
        scrapeWarnings: res.scrapeWarnings,
        bySource: res.bySource,
      });
      for (const [sid, n] of Object.entries(res.bySource)) bySource[sid] = (bySource[sid] || 0) + n;
      Object.assign(yieldBySource, res.yieldBySource);
      Object.assign(provenanceBySource, res.provenanceBySource);
      Object.assign(apiQueryBySource, res.apiQueryBySource);
      Object.assign(samplesBySource, res.samplesBySource);
      sourceCount = res.sourceCount;
    }

    // Union the per-item warnings by sourceId — a source blocked in ANY item
    // surfaces ONE blocked card (Solve/Skip then apply across all items).
    const scrapeWarnings = [];
    const seenWarn = new Set();
    for (const it of perItem) {
      for (const w of it.scrapeWarnings) {
        if (w?.sourceId && !seenWarn.has(w.sourceId)) { seenWarn.add(w.sourceId); scrapeWarnings.push(w); }
      }
    }

    const totalSold = perItem.reduce((n, it) => n + (it.comps.sold?.length || 0), 0);
    const totalActive = perItem.reduce((n, it) => n + (it.comps.active?.length || 0), 0);
    logger.info(`[Marketplace][${nodeId}] Bundle scrape done: ${items.length} item(s), ${totalSold} sold, ${totalActive} active, ${scrapeWarnings.length} warning(s)`);

    // Per-source warning reason so the funnel can explain a count (esp. a 0).
    const sourceWarnings = {};
    for (const w of scrapeWarnings) {
      if (w?.sourceId && !sourceWarnings[w.sourceId]) {
        sourceWarnings[w.sourceId] = { code: w.code, severity: w.severity, evidence: w.evidence };
      }
    }
    // Did a captcha-resolve browser-close land DURING this scrape? We hold the
    // sell-side lock, so a handoff inside our window can only be a JOB-side
    // captcha-resolve (un-gated) closing the shared browser — which would have
    // detached our in-flight pages. If so, the `task-failed` sources below are
    // internal browser contention, not anti-bot, and the report should say so.
    const detachedSources = scrapeWarnings.filter(w => w?.code === 'task-failed').map(w => w.sourceId);
    const handoffNow = getLastCaptchaHandoffAt();
    const browserContention = (handoffNow > handoffAtStart && detachedSources.length > 0)
      ? { handoffAt: handoffNow, detachedSources }
      : null;
    marketplaceTelemetry.scrape = {
      ts: Date.now(),
      nodeId,
      sold: totalSold,
      active: totalActive,
      sources: sourceCount,
      items: items.length,
      warnings: scrapeWarnings.length,
      browserContention,
      // Anti-bot blocks vs. internal scrape errors vs. timeouts vs. not-logged-in
      // are different failures with different fixes — keep them separate.
      blocked: scrapeWarnings.filter(w => w?.severity === 'block' && !['task-failed', 'scrape-timeout', 'login-required'].includes(w?.code)).length,
      errored: scrapeWarnings.filter(w => w?.code === 'task-failed').length,
      timedOut: scrapeWarnings.filter(w => w?.code === 'scrape-timeout').length,
      loginRequired: scrapeWarnings.filter(w => w?.code === 'login-required').length,
      bySource,
      yieldBySource,
      provenanceBySource,
      apiQueryBySource,
      samplesBySource,
      sourceWarnings,
      itemDetails: perItem.map((it, index) => ({
        index,
        query: it.query,
        label: it.label,
        condition: it.condition,
        sold: it.comps.sold?.length || 0,
        active: it.comps.active?.length || 0,
        warnings: it.scrapeWarnings.map(w => ({ sourceId: w.sourceId, code: w.code, severity: w.severity })),
        bySource: it.bySource,
      })),
    };

    if (signal.aborted) throw new Error('Window closed');

    // `comps` = the PRIMARY item (back-compat for any single-comps reader);
    // `items` is the per-item breakdown the renderer prices individually.
    return { items: perItem, comps: perItem[0].comps, scrapeWarnings };
    }, signal);   // end withMarketplaceBrowserLock — releases the shared browser
    } finally {
      // Bulletproof the hub's "waiting behind N" banner: if this op was aborted
      // while still queued, the in-callback queuedBehind:0 never fired — emit it
      // here so the renderer's queueWait can't strand > 0.
      if (!event.sender.isDestroyed()) event.sender.send('price-queue-status', { nodeId, queuedBehind: 0 });
    }
  });

  // ── Synthesize Price (AI step, takes pre-scraped comps) ───────────────────
  // Renderer calls this after `scrape-price-comps` once it decides to proceed
  // (either all sources clean, or user clicked "Skip & Price" with partial
  // data). Kept separate so we never spend AI tokens on a request the user
  // hasn't approved.
  handleSafe('synthesize-price', async (event, { query, condition, comps, nodeId, itemKey, itemLabel, productSpec, pricingNotes }, signal) => {
    const synthesisStartedAt = Date.now();
    const userPricingNotes = normalizePricingNotes(pricingNotes);
    // Reject non-genuine listings (eBay internal test items, etc.) at the single
    // gate every comp passes through before pricing — covers both the scrape and
    // captcha-resolve paths. The rejection is surfaced in the report (not silent).
    const junkOpts = { query, productTitle: productSpec?.title };
    const { kept: sold,   rejected: soldJunk }   = filterJunkComps(Array.isArray(comps?.sold) ? comps.sold : [], junkOpts);
    const { kept: active, rejected: activeJunk } = filterJunkComps(Array.isArray(comps?.active) ? comps.active : [], junkOpts);
    const junk = [...soldJunk, ...activeJunk];
    if (junk.length > 0) {
      logger.info(`[Marketplace][${nodeId}] Rejected ${junk.length} non-genuine listing(s) before pricing (e.g. "${(junk[0]?.title || '').slice(0, 60)}")`);
    }
    const total = sold.length + active.length;
    logger.info(`[Marketplace][${nodeId}] Synthesizing price from ${sold.length} sold + ${active.length} active comps`);
    marketplaceTelemetry.nodeId = nodeId;
    marketplaceTelemetry.windowId = event.sender?.id ?? null;

    if (total === 0) {
      recordSynthesisTelemetry({
        ts: Date.now(), startedAt: synthesisStartedAt, itemKey, itemLabel, query,
        soldFound: 0, activeFound: 0, soldUsed: 0, activeUsed: 0,
        junkRejected: junk.length, junkExample: junk[0]?.title ? String(junk[0].title).slice(0, 60) : null,
        recommendedPrice: null, matchQuality: 'none',
      });
      return {
        pricing: {
          recommended_price: null,
          justification: 'No similar listings to synthesize from — set your own price or resolve blocked sources and retry.',
          market_summary: { sold_count: 0, active_count: 0 },
          recommended_platforms: [],
        },
      };
    }

    // Deterministic pre-sort: rank each listing by how closely its title matches
    // the item, so exact-spec matches survive the slice cap below (without it,
    // close-but-not-exact variants push true matches out of the 25-item window
    // the AI sees). Two ideas keep the ranking from degenerating to "everything
    // ties", which made the kept set arbitrary:
    //   1. Score against the FULL extracted spec (model/color/condition/title),
    //      not just `query`. The search query is deliberately broad — brand+model
    //      only, condition/color stripped (see the search_query prompt) — so it
    //      appears in nearly every title and can't discriminate. The spec words
    //      ("Silver", "Good", "64GB") are what separate an exact match from an
    //      XS-Max-gold-parts lot or a $5 charger whose title also says "iPhone XS".
    //   2. Weight each token by inverse document frequency over the scraped
    //      titles: a word in ~every title (the generic query) contributes ≈0; a
    //      word in only some (the real discriminators) dominates. Fully general —
    //      no per-category keyword lists, just whatever the AI extracted. Falls
    //      back to query-only behaviour when productSpec is absent (older callers).
    const tokenize = (s) => String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2);
    const specTokenSet = new Set([
      ...tokenize(query),
      ...tokenize(productSpec?.model),
      ...tokenize(productSpec?.color),
      ...tokenize(productSpec?.title),
      ...tokenize(condition),
    ]);
    // Seller notes still go to the pricing model as high-priority context, but
    // they do NOT rank comp titles. Notes are often pasted retail-page text; now
    // that they are uncapped, tokenizing them here would let delivery/policy
    // boilerplate decide which listings survive the comp budget.
    // df/idf over the union of everything we're ranking (sold + active titles),
    // tokenized once per comp and cached by object identity (scoreFn is hot).
    const rankPool = [...sold, ...active];
    const compTokenCache = new Map();
    const docFreq = new Map();
    for (const c of rankPool) {
      const toks = new Set(tokenize(c?.title));
      compTokenCache.set(c, toks);
      for (const t of toks) docFreq.set(t, (docFreq.get(t) || 0) + 1);
    }
    const poolSize = rankPool.length || 1;
    const idf = (t) => Math.log(1 + poolSize / (1 + (docFreq.get(t) || 0)));
    const scoreByTitleMatch = (item) => {
      const toks = compTokenCache.get(item) || new Set(tokenize(item?.title));
      let score = 0;
      for (const t of specTokenSet) if (toks.has(t)) score += idf(t);
      return score;
    };
    const byMatchDesc = (a, b) => scoreByTitleMatch(b) - scoreByTitleMatch(a);
    // How many comps actually reach the model: scaled to what's available and
    // bounded by the price-synthesis token budget (see resultCaps).
    // Source balancing happens only after a conservative source-level relevance
    // gate. Otherwise round-robin guarantees slots to a source whose BEST result
    // is still a wrong product.
    const soldRelevance = filterGrosslyOffTargetSources(sold, scoreByTitleMatch);
    const activeRelevance = filterGrosslyOffTargetSources(active, scoreByTitleMatch);
    if (soldRelevance.rejected.length + activeRelevance.rejected.length > 0) {
      logger.info(
        `[Marketplace][${nodeId}] Rejected ${soldRelevance.rejected.length + activeRelevance.rejected.length} grossly off-target comp(s) from source(s): ` +
        [...new Set([...soldRelevance.sources, ...activeRelevance.sources])].join(', '),
      );
    }
    const rankableSold = soldRelevance.kept;
    const rankableActive = activeRelevance.kept;
    const { sold: soldN, active: activeN } = compsForPricing(rankableSold.length, rankableActive.length);
    // Pick FAIRLY across sources (round-robin), then present best-match-first so
    // the prompt's "pre-sorted by keyword match" hint still holds. The plain
    // top-N slice was order-dependent and let one source monopolize the cap when
    // title-match couldn't discriminate (see selectAcrossSources).
    const soldComps   = selectAcrossSources(rankableSold, soldN, scoreByTitleMatch).sort(byMatchDesc);
    const activeComps = selectAcrossSources(rankableActive, activeN, scoreByTitleMatch).sort(byMatchDesc);
    // Dropped = everything not picked (for the report's kept-vs-dropped lines).
    const soldKeptSet   = new Set(soldComps);
    const activeKeptSet = new Set(activeComps);
    const soldDropped   = sold.filter(x => !soldKeptSet.has(x));
    const activeDropped = active.filter(x => !activeKeptSet.has(x));

    // Median title-match relevance of kept vs dropped. The cap selects by this
    // score, so kept normally out-scores dropped; HOW MUCH is the signal the
    // report needs to tell a price gap caused by correctly shedding low-relevance
    // comps (kept score ≫ dropped) from one where comparably-relevant comps were
    // dropped (a real cap/ranking skew).
    const medianScore = (items) => {
      const xs = (Array.isArray(items) ? items : []).map(scoreByTitleMatch).sort((a, b) => a - b);
      return xs.length ? Math.round(xs[Math.floor(xs.length / 2)] * 100) / 100 : null;
    };
    // Median match score PER SOURCE among the kept comps. A source far below the
    // rest is returning off-target results (e.g. Swappa serving "Apple Vision
    // Pro" for an "Apple iPhone XS" query — title shares only the brand token),
    // which the round-robin selection then forces into the priced set. The
    // report uses this to name the wrong-product source instead of letting it
    // blend into the aggregate.
    const scoreBySource = (items) => {
      const groups = {};
      for (const it of (Array.isArray(items) ? items : [])) {
        (groups[it?.source || 'unknown'] ||= []).push(it);
      }
      const out = {};
      for (const [k, g] of Object.entries(groups)) out[k] = medianScore(g);
      return out;
    };

    const synthMeta = {}; // populated with the model that actually served this call
    const pricing = await callLLMText(`
You are a pricing analyst and marketplace routing expert. Given these similar listings from multiple sources, recommend a selling price AND which platforms to list on. Use plain English in your justification — don't say "comp(s)" or "comparable"; say "similar listing(s)" or "sold listing(s)".

ITEM: ${query}
CONDITION: ${formatConditionForPricingPrompt(condition)}
${formatPricingNotesForPrompt(userPricingNotes)}

The listings below are pre-sorted by how closely each title matches the ITEM's spec (best match first). Use that ordering as your first hint when identifying anchor vs. adjusted vs. bound listings, then refine using the spec details inside each listing.

RECENTLY SOLD (what buyers actually paid):
${JSON.stringify(soldComps)}

CURRENTLY ACTIVE (competition):
${JSON.stringify(activeComps)}

WEIGHTING — rank each listing by how closely its spec matches the ITEM:
- ANCHOR: same spec across the price-driving attributes (whatever those are for this category — capacity, size, generation, condition tier, included accessories, model variant, etc.). Weight these heaviest.
- ADJUSTED: similar but differs on a known price-driving attribute. Use them, but mentally adjust their price up or down for the difference before averaging in. (E.g. a higher-capacity variant should be discounted down; a worse-condition variant should be discounted up to estimate same-condition value.)
- BOUND: only loosely related. Use as ceilings/floors only, not for the central estimate.

If exact-match listings are scarce, lean on adjusted listings — DO NOT refuse to price. Note the weighting and your adjustments in the justification so the user can sanity-check.

If USER NOTES FROM SELLER are present, treat them as high-priority item facts and seller preferences for pricing. Use them to adjust anchor/adjusted/bound classification and price reasoning when they describe condition, size, defects, included accessories, authenticity, urgency, original cost, or local-pickup constraints. Do not let notes change the required JSON shape.

A stated retail price / MSRP / original cost in the notes is CONTEXT ONLY — it is NOT a ceiling or a floor. Anchor the recommendation on the sold and active listings above, and price ABOVE retail when the comps support it: discontinued, collectible, or supply-constrained items (e.g. certain memory/flash, out-of-production gear) routinely sell for more than they originally cost. Conversely, never mark a price down just because the item is old or used — the comps decide the number, and retail is only a sanity check.

MATCH QUALITY — pick one of these three values for the "match_quality" field:
  strong   — 3 or more anchor listings within a tight price band
  moderate — anchored mostly on adjusted listings, OR a few anchors with a wide spread
  weak     — only bound listings were available; recommendation is best-guess

Return ONLY a single JSON object with EXACTLY this shape. No comments, no trailing prose, no type annotations, no explanation outside the JSON.

{
  "recommended_price": 0,
  "quick_sell_price": 0,
  "max_profit_price": 0,
  "justification": "3-5 sentences displayed directly under this item's individual valuation: state which listings anchored the price, what adjustments you applied for non-exact ones (direction + rough size), and any caveats. Discuss only this item; do not discuss a bundle. Cite specific titles or numbers where it helps.",
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
- Collectibles/Trading Cards → eBay (13%) > Mercari (10%)
- Furniture/Home → Facebook Marketplace (0% local) > AptDeco (furniture/home, handles white-glove delivery)
- Musical Instruments → Reverb (5% fee, $500 cap) > eBay (6.35%)
- Luxury/Designer → eBay (13% + free authentication) > Poshmark
- General/Mixed → Mercari (10%) > eBay (13%) > Facebook (0% local)

Use platform IDs: ebay, facebook, mercari, poshmark, depop, swappa, reverb, aptdeco`, {
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
    recordSynthesisTelemetry({
      ts: Date.now(),
      startedAt: synthesisStartedAt,
      itemKey,
      itemLabel,
      query,
      soldFound: sold.length,
      activeFound: active.length,
      // Distinct listings among what was found — a found≫unique gap means an
      // extractor double-counted, silently inflating the set fed to pricing.
      soldUnique: uniqueCompCount(sold),
      activeUnique: uniqueCompCount(active),
      soldUsed: soldComps.length,
      activeUsed: activeComps.length,
      soldRankable: rankableSold.length,
      activeRankable: rankableActive.length,
      budgetLimited: rankableSold.length > soldComps.length || rankableActive.length > activeComps.length,
      // Price distribution of what the cap KEPT vs. DROPPED, so "prices dropped
      // from analysis?" is answerable from the report: the renderer compares the
      // dropped median to the kept band to tell a representative drop (price
      // unaffected) from one that skewed the price (dropped median ≫/≪ kept) or
      // cheap noise (dropped below the band — cap working as intended).
      soldKeptStats:      priceStats(soldComps),
      soldDroppedStats:   priceStats(soldDropped),
      activeKeptStats:    priceStats(activeComps),
      activeDroppedStats: priceStats(activeDropped),
      // Median title-match relevance of kept vs dropped (the cap ranks on this),
      // so the report can tell correct low-relevance shedding from a real skew.
      soldKeptScore:      medianScore(soldComps),
      soldDroppedScore:   medianScore(soldDropped),
      activeKeptScore:    medianScore(activeComps),
      activeDroppedScore: medianScore(activeDropped),
      // Per-source composition of kept vs dropped — surfaces a source monopoly
      // (e.g. "kept: poshmark=25" while "dropped: ebay-sold=25") at a glance,
      // instead of having to read the raw comp JSON.
      soldKeptBySource:    countBySource(soldComps),
      soldDroppedBySource: countBySource(soldDropped),
      // Per-source median match score among kept comps — a source far below the
      // overall kept score returned wrong-product results that polluted pricing.
      soldKeptScoreBySource: scoreBySource(soldComps),
      offTargetRejected: soldRelevance.rejected.length + activeRelevance.rejected.length,
      offTargetRejectedSources: [...new Set([...soldRelevance.sources, ...activeRelevance.sources])],
      // Non-genuine listings (eBay test items, …) removed before pricing — surfaced
      // so the rejection is transparent, not a silent drop. soldFound/activeFound
      // above are already the post-rejection counts.
      junkRejected: junk.length,
      junkExample: junk[0]?.title ? String(junk[0].title).slice(0, 60) : null,
      userNotesChars: userPricingNotes.length,
      userNotesPreview: userPricingNotes ? userPricingNotes.slice(0, 240) : null,
      recommendedPrice: pricing?.recommended_price ?? null,
      matchQuality: pricing?.match_quality || '(unknown)',
      model: synthMeta.model || null,
      fallback: synthMeta.fallback || null,
      // The model's OWN classification of the comps we fed it: anchor (weighted
      // heaviest) vs adjusted (price-corrected) vs bound (ceiling/floor only).
      // The sum is typically < fed because the model weights the rest out. This
      // is the LAST funnel stage and the one place a "silent drop from analysis"
      // could hide: the found→fed cap drop is reported above (kept/dropped bands),
      // but the fed→actually-weighted gap was invisible until now.
      compBreakdown: pricing?.comp_breakdown || null,
      // The model's own market summary — how many sold/active it actually
      // counted (its internal view after it classified each comp). The
      // fed→model-counted gap is the last invisible drop: we feed 15 active
      // comps but the model may count 0 if it judged them all as accessories/
      // parts. Without this, the report shows "15 active fed" with no signal
      // that the model internally rejected them all.
      marketSummary: pricing?.market_summary || null,
    });

    return { pricing };
  });

  // ── Combine independently-priced items into ONE bundle asking price ────────
  // A SellHub listing can package several independent items (kayak + paddle);
  // each is priced on its own from real comps (synthesize-price, above), then
  // this call identifies attributable pricing factors. Complementary items can
  // add premium factors, while a forced bundle can add discount factors. Code
  // sums those factors and derives every dollar price + explanation from them,
  // so the rationale and price cannot drift. Text-only (no photos): the items
  // were already identified/priced; this step reasons over those results.
  handleSafe('synthesize-bundle-price', async (event, { items, sumOfPrices, nodeId } = {}, signal) => {
    marketplaceTelemetry.nodeId = nodeId;
    marketplaceTelemetry.windowId = event.sender?.id ?? null;
    const list = Array.isArray(items) ? items : [];
    // Bundling is only meaningful with 2+ items, and we can only reason about
    // synergy for the ones that actually got a price. Fewer than 2 priced → let
    // the caller fall back to the arithmetic sum.
    const priced = list.filter(it => (
      it
      && it.recommended_price !== null
      && it.recommended_price !== undefined
      && it.recommended_price !== ''
      && Number.isFinite(Number(it.recommended_price))
      && roundToCents(it.recommended_price) > 0
    ));
    if (priced.length < 2) {
      return { bundlePricing: null };
    }
    const sum = roundToCents(priced.reduce((n, it) => n + roundToCents(it.recommended_price), 0));
    const suppliedSum = sumOfPrices !== null && sumOfPrices !== undefined && sumOfPrices !== '' && Number.isFinite(Number(sumOfPrices))
      ? Number(sumOfPrices)
      : null;
    if (suppliedSum != null && Math.abs(suppliedSum - sum) >= 0.01) {
      logger.warn(`[Marketplace][${nodeId}] Ignoring stale bundle sum $${suppliedSum}; priced items currently sum to $${sum}`);
    }
    if (sum <= 0) {
      logger.warn(`[Marketplace][${nodeId}] Skipping bundle factor synthesis because priced items sum to non-positive value $${sum}`);
      return { bundlePricing: null };
    }
    logger.info(`[Marketplace][${nodeId}] Synthesizing bundle price for ${priced.length} item(s) (sum $${sum})`);

    // Only the priced items inform the combined price; an unpriced item ("set
    // your own price") has no market anchor to reason from, so feeding it would
    // just invite the model to invent a value.
    const itemsForPrompt = priced.map((it, i) => ({
      item: i + 1,
      label: it.label,
      condition: it.condition,
      individual_price: roundToCents(it.recommended_price),
      individual_quick_sell_price: it.quick_sell_price != null
        && Number.isFinite(Number(it.quick_sell_price))
        && roundToCents(it.quick_sell_price) > 0
        ? roundToCents(it.quick_sell_price)
        : undefined,
      individual_max_profit_price: it.max_profit_price != null
        && Number.isFinite(Number(it.max_profit_price))
        && roundToCents(it.max_profit_price) > 0
        ? roundToCents(it.max_profit_price)
        : undefined,
      match_quality: it.match_quality || undefined,
      seller_notes: (it.notes || '').trim() || undefined,
      individual_reasoning: (it.reasoning || '').trim() || undefined,
    }));

    const bundleMeta = {};
    const decision = await callLLMText(`
You are a pricing analyst. A seller is listing MULTIPLE independent items together in ONE listing. Each item has ALREADY been priced individually from real market evidence. Your job is to identify STRUCTURED, ATTRIBUTABLE pricing factors. Do NOT calculate or return dollar prices, a final relationship label, or a final adjustment. Application code will derive them by summing your factors.

Selling items together can change their total value versus selling them separately:
- PREMIUM: the items complement each other and are more useful as a set, so a buyer will pay more for the convenience of getting them together (e.g. a watering system + a jug to hold the water; a camera body + a matching lens; a kayak + its paddle). The bundle can ask MORE than the sum.
- DISCOUNT: bundling forces the buyer to take items they may not all want, OR the seller accepts a small markdown to move everything in one faster transaction. The bundle may ask LESS than the sum.
- NEUTRAL: the items are unrelated and bundling adds nothing — the bundle ≈ the sum.

Encode each reason and its numerical effect together:
- bundle_factors: every independent reason the bundle should differ from separate value. direction="premium" adds percent; direction="discount" subtracts percent. An empty list means neutral. Code sums these signed factors to derive Best and the relationship badge.
- quick_sell_factors: every independent liquidity reason to reduce Best for a likely sale in 1-3 days. Code sums their percentages.
- max_profit_factors: every independent reason a patient seller might increase Best for a 3-4 week sale. Code sums their percentages.

Each factor MUST have a specific reason that supports its direction and percentage. Do not add a factor unless it changes price. Avoid double-counting overlapping reasons. Bundle factors are usually modest and should normally net within ±15%. Hard aggregate limits enforced by code: bundle net ±50%, quick reduction 75%, max increase 100%. Return at most 8 factors in each list. Do NOT repeat each item's individual pricing justification; those are displayed separately. Do not calculate or state dollar prices. Do not use the word "comps"; say "similar listings" or "sold listings."

SUM OF INDIVIDUAL PRICES: $${sum}

ITEMS (each already priced individually):
${JSON.stringify(itemsForPrompt, null, 2)}

Return ONLY a single JSON object with EXACTLY this shape. No prose outside the JSON.

{
  "bundle_factors": [
    { "direction": "premium", "percent": 8, "reason": "The items form a complete ready-to-use system." },
    { "direction": "discount", "percent": 3, "reason": "A buyer must take all items in one purchase." }
  ],
  "quick_sell_factors": [
    { "percent": 10, "reason": "The complete set has a focused buyer pool." }
  ],
  "max_profit_factors": [
    { "percent": 10, "reason": "A patient seller can wait for a buyer seeking the complete set." }
  ]
}`, {
      signal,
      task: 'bundle-price-synthesis',
      hints: { itemCount: priced.length },
      responseSchema: BUNDLE_PRICE_SCHEMA,
      meta: bundleMeta,
    });
    const result = deriveBundlePricingResult(decision, sum, priced.length);

    marketplaceTelemetry.bundle = {
      ts: Date.now(),
      nodeId,
      items: priced.length,
      unpriced: list.length - priced.length,
      sum,
      quickPrice: result?.quick_sell_price ?? null,
      bundlePrice: result?.bundle_price ?? null,
      maxPrice: result?.max_profit_price ?? null,
      synergy: result?.synergy || null,
      adjustmentPercent: result?.bundle_adjustment_percent ?? null,
      quickReductionPercent: result?.quick_sell_reduction_percent ?? null,
      maxIncreasePercent: result?.max_profit_increase_percent ?? null,
      bundleFactors: result?.bundle_factors || [],
      quickFactors: result?.quick_sell_factors || [],
      maxFactors: result?.max_profit_factors || [],
      factorCapsApplied: result?.factor_caps_applied || null,
      rejectedFactors: result?.rejected_factors || null,
      model: bundleMeta.model || null,
      fallback: bundleMeta.fallback || null,
    };
    if (result) {
      logger.info(`[Marketplace][${nodeId}] Bundle price: $${result.bundle_price} (${result.synergy}, sum $${sum})`);
    } else {
      logger.warn(`[Marketplace][${nodeId}] Invalid bundle factor response; using separate-item sum $${sum}`);
    }
    return { bundlePricing: result };
  });

  // ── Rescrape a single comp source ─────────────────────────────────────────
  // Used after a captcha resolve to refetch ONLY the unblocked source,
  // instead of throwing away the prior scrape's ~70 successful comps and
  // re-paying for a full multi-source run. The renderer merges the returned
  // items into pendingComps and drops the source from scrapeWarnings.
  handleSafe('rescrape-source', async (event, { sourceId, query, items, nodeId, noChallengeConfirmed = false }, signal) => {
    // Serialize on the shared browser like the full scrape — a rescrape runs
    // headless scrapes on the one stealth browser, so it must not overlap
    // another node's captcha-resolve closing that browser. See marketplaceBrowserLock.
    const aheadInQueue = getMarketplaceBrowserQueueDepth();
    if (aheadInQueue > 0 && !event.sender.isDestroyed()) {
      event.sender.send('price-queue-status', { nodeId, sourceId, queuedBehind: aheadInQueue });
    }
    return withMarketplaceBrowserLock(async () => {
    if (!event.sender.isDestroyed()) event.sender.send('price-queue-status', { nodeId, sourceId, queuedBehind: 0 });
    // Multi-item bundle: re-scrape this source once per item's query so a Solve
    // recovers comps for EVERY item, not just the primary. Returns per-item
    // results the renderer merges into each item's comps.
    if (Array.isArray(items) && items.length > 0) {
      logger.info(`[Marketplace][${nodeId}] Rescraping source ${sourceId} across ${items.length} item(s)`);
      const perItem = [];
      for (const it of items) {
        if (signal.aborted) throw new Error('Window closed');
        const r = await scrapeOneSource(sourceId, it.query, event.sender, signal, nodeId);
        // noChallengeConfirmed: the visible Solve proved this host/session has no
        // wall, so a per-item empty (incl. a readiness-loop timeout on a genuine
        // 0-results page) is the page's real answer — clear it instead of re-arming
        // retry-empty, which would strand a truly-empty bundle source forever.
        const warning = retryWarningRequiringAction(r.warning, r.items, { noChallengeConfirmed });
        perItem.push({
          key: it.key ?? null,
          query: it.query,
          items: r.items,
          warning,
          category: r.category,
        });
      }
      const extracted = perItem.reduce((n, it) => n + (Array.isArray(it.items) ? it.items.length : 0), 0);
      const warningCount = perItem.filter(it => it.warning).length;
      marketplaceTelemetry.resolves[sourceId] = {
        ts: Date.now(),
        extracted,
        category: perItem[0]?.category || 'sold',
        via: 'bundle-rescrape',
        warningCount,
        itemCounts: perItem.map(it => ({
          query: it.query,
          count: it.items?.length || 0,
          warning: it.warning?.code || null,
        })),
      };
      // scrapeOneSource emits progress per query. Re-assert one aggregate
      // terminal event after the bundle retry so the card cannot disappear just
      // because the LAST query succeeded while an earlier bundle item failed.
      const finalWarning = perItem.find(it => it.warning)?.warning || null;
      if (!event.sender.isDestroyed()) {
        event.sender.send('price-source-progress', {
          nodeId,
          sourceId,
          status: finalWarning ? 'error' : 'done',
          count: extracted,
          warning: finalWarning,
        });
      }
      logger.info(`[Marketplace][${nodeId}] Rescrape ${sourceId} across bundle → ${extracted} item(s), ${warningCount}/${perItem.length} query warning(s) remain`);
      return { sourceId, perItem, category: perItem[0]?.category || 'sold' };
    }

    logger.info(`[Marketplace][${nodeId}] Rescraping single source: ${sourceId}`);
    const result = await scrapeOneSource(sourceId, query, event.sender, signal, nodeId);
    const warning = retryWarningRequiringAction(result.warning, result.items, { noChallengeConfirmed });
    const normalizedResult = {
      ...result,
      warning,
    };
    // Re-assert the NORMALIZED retry verdict after scrapeOneSource's raw
    // progress event. In particular, a raw clean 0-item result becomes the
    // synthetic retry-empty block here; without this correction the card would
    // see "done / no warning", auto-dismiss, and strand a still-blocked source.
    if (!event.sender.isDestroyed()) {
      event.sender.send('price-source-progress', {
        nodeId,
        sourceId,
        status: warning ? 'error' : 'done',
        count: result.items.length,
        warning,
      });
    }
    logger.info(`[Marketplace][${nodeId}] Rescrape ${sourceId} → ${result.items.length} item(s), warning=${warning?.code || 'none'}`);
    // This records what reached the renderer, not whether it was merged into the
    // final priced snapshot. The bug report compares this timestamp with pricing
    // start so a late retry cannot be mislabeled as having influenced the price.
    marketplaceTelemetry.resolves[sourceId] = {
      ts: Date.now(),
      extracted: Array.isArray(result?.items) ? result.items.length : 0,
      category: result.category || 'sold',
      via: 'rescrape',
      warningCount: warning ? 1 : 0,
    };
    return normalizedResult;
    }, signal);   // end withMarketplaceBrowserLock
  });

  // ── Resolve captcha / anti-bot challenge that blocked a comp scrape ───────
  // Opens the exact failed URL in a visible browser sharing our scrape
  // userDataDir. Polls for the challenge page to disappear; auto-closes
  // when cleared. Resulting cookies persist for the userDataDir's session
  // TTL, so the renderer's follow-up "Refresh Prices" call lands on a
  // clean page instead of bouncing back into the same wall.
  handleSafe('resolve-captcha', async (event, { url, sourceId, nodeId } = {}, signal) => {
    // Hold the sell-side browser lock for the WHOLE resolve: this op CLOSES the
    // shared stealth browser to hand its profile to a visible Chrome, so it must
    // not run while a price-check scrape still has pages in flight (that is the
    // exact collision that detached them). Holding across the manual solve is
    // fine — the visible window holds the profile, so no scrape could run anyway.
    const aheadInQueue = getMarketplaceBrowserQueueDepth();
    if (aheadInQueue > 0 && !event.sender.isDestroyed()) {
      event.sender.send('price-queue-status', { nodeId, sourceId, queuedBehind: aheadInQueue });
    }
    return withMarketplaceBrowserLock(async () => {
    if (!event.sender.isDestroyed()) event.sender.send('price-queue-status', { nodeId, sourceId, queuedBehind: 0 });
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

    // The inline extractor threw SITE_CHANGED — this means the scraper code is
    // broken, not the captcha. Flip the source card from Solve (block) to Retry
    // (stale-selectors/warn) so the user knows to fix the extractor, not solve a
    // captcha. Don't trigger a headless rescrape — it would fail identically.
    if (result.siteChangedError && !event.sender.isDestroyed()) {
      const evidence = String(result.siteChangedError).slice(0, 1400); // see classifyCompScrapeFailure — 700 clipped the card0=[…] skeleton mid-token
      event.sender.send('price-source-progress', {
        nodeId, sourceId, status: 'error',
        warning: {
          code: 'stale-selectors', severity: 'warn', evidence,
          suggestion: 'Extractor returned 0 results — the site HTML may have changed. Update the scraper code in electron/extractors/marketplace.js, rebuild, and retry.',
        },
        url: null,
      });
      marketplaceTelemetry.resolves[sourceId] = { ts: Date.now(), extracted: 0, category, via: 'inline' };
      return { ...result, category };
    }

    // Sync the card's visible state with the merged data. Without this fake
    // "done, no warning" event, the comp-source-card keeps showing its
    // original captcha-presented warning + Solve/Skip buttons even after
    // the hub merged the inline-extracted items into pendingComps — leaving
    // the user thinking nothing happened. The card's existing 3s auto-dismiss
    // timer then removes it from the canvas naturally.
    // If the visible window auto-resolved (reached a definitive conclusion) and
    // NEVER saw a challenge widget, there is no wall to clear — a sub-floor or
    // empty result is the page's real answer, not a block. Accept it instead of
    // re-arming an unclearable Solve (the eBay "1 result" loop). diag.sawChallenge
    // is recorded by the inline extractor in openCaptchaResolveWindow.
    const noChallengeConfirmed = result.resolved === true && result.diag?.sawChallenge === false;
    let inlineWarning = null;
    if (result.resolved && Array.isArray(result.items)) {
      inlineWarning = retryWarningRequiringAction(null, result.items, { noChallengeConfirmed });
    }
    if (result.resolved && Array.isArray(result.items) && !event.sender.isDestroyed()) {
      event.sender.send('price-source-progress', {
        nodeId,
        sourceId,
        status: inlineWarning ? 'error' : 'done',
        count: result.items.length,
        warning: inlineWarning,
        // Keep the retry target while blocked so the user can Solve again as
        // many times as needed. Clear it only after a clean, non-empty result.
        url: inlineWarning ? url : null,
      });
    }
    // Keyed by sourceId so a multi-source recovery keeps every resolve;
    // re-resolving the same source replaces its entry (latest wins). `via`
    // records HOW the items were recovered: 'inline' = extracted in the visible
    // session here. When inline comes back empty the renderer falls back to
    // rescrape-source, which updates this entry to via:'rescrape' (see below) —
    // without that, a rescrape recovery shows as "inline-extracted 0" and a
    // successful recovery reads as a failure in the report.
    marketplaceTelemetry.resolves[sourceId] = {
      ts: Date.now(),
      extracted: Array.isArray(result?.items) ? result.items.length : 0,
      category,
      via: 'inline',
    };
    return { ...result, category, warning: inlineWarning };
    }, signal);   // end withMarketplaceBrowserLock
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
- Fashion items: Swappa and Reverb are unfit. Poshmark, Depop, Mercari, eBay are good.
- Musical instruments: Reverb is the obvious fit. eBay also good. Others usually unfit unless mainstream-consumer audio.
- Furniture / bulky home goods: Facebook (local) and AptDeco (furniture/home specialist with white-glove delivery) are good; everything else unfit (shipping kills the deal).
- AptDeco: GOOD only for furniture and home furnishings (sofas, tables, dressers, rugs, lighting, decor). UNFIT for electronics, fashion, instruments, collectibles, and anything not furniture/home.
- Collectibles / cards: eBay is good; Mercari is plausible for mainstream collectibles; others usually unfit.

Be confident — don't mark everything "good." If you're unsure, lean "good" unless there's a real policy/audience reason.`, { signal, task: 'platform-fit-assessment', responseSchema: buildPlatformFitSchema(platforms.map(p => p.id)), meta: fitMeta });

    logger.info(`[Marketplace][${nodeId}] Fit verdicts:`, Object.entries(verdict || {}).map(([k, v]) => `${k}=${v?.fit}`).join(' '));
    const verdicts = Object.values(verdict || {});
    marketplaceTelemetry.fit = {
      ts: Date.now(),
      nodeId,
      platforms: platforms.length,
      good: verdicts.filter(v => v?.fit === 'good').length,
      unfit: verdicts.filter(v => v?.fit === 'unfit').length,
      model: fitMeta.model || null,
      fallback: fitMeta.fallback || null,
    };
    return { fit: verdict || {} };
  });

  // ── Marketplace Status Module: aggregate hub scan ─────────────────────────
  // Instead of checking each listing individually (slow + token-heavy at 20+
  // listings), scan each platform's aggregate notification hub — the watch URLs
  // the user configured in Settings — ONCE per platform, and surface anything
  // across all their listings that needs action. The renderer only sends
  // platforms that have BOTH a listing on this canvas AND a configured watch URL.
  handleSafe('check-marketplace-status', async (event, { platformIds, nodeId, runId } = {}, signal) => {
    const ids = [...new Set(Array.isArray(platformIds) ? platformIds.filter(Boolean) : [])];
    if (ids.length === 0) return { results: {} };

    // Share the listing-status FIFO mutex: hub scans read the same auth-walled
    // seller dashboards and must not double the single-IP burst against any
    // residual per-listing check (see statusCheckLock).
    const ahead = getStatusCheckQueueDepth();
    if (ahead > 0) {
      logger.info(`[MarketplaceStatus][${nodeId}] queued behind ${ahead} in-flight status check(s)`);
    }
    return withStatusCheckLock(async () => {
      const results = {};
      const recordResult = (platformId, result) => {
        const completedResult = {
          ...result,
          lastChecked: new Date().toISOString(),
          _statusUpdate: {
            epoch: marketplaceStatusProcessEpoch,
            sequence: ++marketplaceStatusResultSequence,
          },
        };
        results[platformId] = completedResult;
        if (!event.sender.isDestroyed()) {
          try {
            event.sender.send('marketplace-status-progress', {
              nodeId,
              runId: runId || null,
              platformId,
              result: completedResult,
              completed: Object.keys(results).length,
              total: ids.length,
            });
          } catch (error) {
            // Progress delivery is best-effort; the invoke response still
            // returns every result and must not lose later platforms because a
            // renderer navigated away or closed between isDestroyed() and send().
            logger.warn(`[MarketplaceStatus][${nodeId}] Could not emit ${platformId} progress:`, error?.message || String(error));
          }
        }
      };
      // Process CDP-readable platforms first, then the native-read ones. Native
      // reads must close the headless stealth browser to take the shared Chrome
      // profile (one Chrome per userDataDir); grouping them last means the
      // stealth browser is torn down ONCE at the end instead of thrashing
      // close→relaunch between every interleaved headless platform.
      const orderedIds = [
        ...ids.filter((id) => !shouldUseNativeRead(id)),
        ...ids.filter((id) => shouldUseNativeRead(id)),
      ];
      for (const platformId of orderedIds) {
        if (signal?.aborted) break;

        // Native-read platforms (Swappa/Mercari) are CDP-walled: the headless
        // verify can't reach their pages either (403 / 35s reload-loop wedge), so
        // running the session gate would just waste that time and can't produce a
        // useful verdict. Skip it — the native read below reports its own outcome
        // (real content → ok; /login bounce or challenge → a precise blocked msg).
        const useNative = shouldUseNativeRead(platformId);
        const monitorConfig = getSellMonitorConfig(platformId);
        if (!useNative) {
          // Session gate: a dead cookie should read as an explicit needs-login,
          // not a vague "unknown" from an auth-walled hub page. Mirrors the per-listing
          // session gate the Marketplace Status Module replaced — kept inline so
          // this handler stays self-contained.
          const cached = monitorConfig ? getStatusCacheSync()[platformId] : null;
          let gateReason; // undefined = pass; otherwise the needs-login reason
          if (cached && cached.connected === false) {
            gateReason = cached.lastReason || '';
          } else if (monitorConfig) {
            const verdict = await verifySellMonitorLogin(platformId).catch(() => null);
            // A transient/inconclusive verifier failure is not proof of logout.
            // Continue into the actual hub reads, which report their own transport
            // outcome, instead of poisoning the cache with a false needs-login.
            if (isConfirmedDisconnectedVerdict(verdict)) {
              try { await writeStatusCache(platformId, false, { lastReason: verdict?.reason, lastTrace: verdict?.trace }); }
              catch { /* cache write failures are non-fatal for the verdict */ }
              gateReason = verdict?.reason || '';
            }
          }
          if (gateReason !== undefined) {
            const name = monitorConfig?.name || platformId;
            recordResult(platformId, {
              status: 'needs-login',
              message: `${name} session needs login.${gateReason ? ` ${gateReason}` : ''} Open Settings → Marketplace Login, then run Check All again.`,
              summary: '', attention: [], sources: [],
            });
            continue;
          }
        }

        const watchUrls = getMarketplaceWatchUrls(platformId);
        if (watchUrls.length === 0) {
          recordResult(platformId, {
            status: 'unknown',
            message: 'No watch URL configured — add one in Settings → Marketplace Monitors.',
            summary: '', attention: [], sources: [],
          });
          continue;
        }

        let urlSpecs;
        if (useNative) {
          // CDP-walled platform: read the hub pages through a non-CDP native
          // Chrome (the only thing that gets past Cloudflare/anti-bot here), then
          // feed the pre-fetched HTML into the SAME scanSellerHubPages analysis
          // via no-op fetchers — reusing all the LLM scan / read-state / status
          // logic. See browser/nativeChromeReader.js.
          logger.info(`[MarketplaceStatus][${nodeId}] Scanning ${platformId} across ${watchUrls.length} hub URL(s) via native (non-CDP) Chrome`);
          const nativeResults = await readHubUrlsViaNativeChrome(watchUrls, { platformId, signal });
          urlSpecs = watchUrls.map((url) => ({
            url,
            urlLabel: 'hub',
            fetcher: () => nativeResults.get(url) || { ok: false, error: 'Native read produced no result for this URL.' },
          }));
        } else {
          urlSpecs = watchUrls.map((url) => ({
            url,
            urlLabel: 'hub',
            fetcher: (u, sig) => fetchHtmlAuthed(u, { signal: sig }),
          }));
          logger.info(`[MarketplaceStatus][${nodeId}] Scanning ${platformId} across ${watchUrls.length} hub URL(s)`);
        }
        try {
          const scan = await scanSellerHubPages({ urlSpecs, platformId, signal });
          logger.info(`[MarketplaceStatus][${nodeId}] ${platformId}: ${scan.status} — ${scan.attention.length} attention item(s)`);
          recordResult(platformId, scan);
        } catch (error) {
          if (signal?.aborted) break;
          const message = error?.message || String(error);
          logger.error(`[MarketplaceStatus][${nodeId}] ${platformId} failed:`, message);
          recordResult(platformId, {
            status: 'error',
            message: `Could not complete the ${platformId} hub scan: ${message}`,
            summary: '',
            attention: [],
            sources: [],
          });
        }
      }
      return { results };
    }, signal);
  });
}
