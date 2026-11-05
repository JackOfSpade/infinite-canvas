import { reportScrapeHealth, scrapeShareBroken } from './scrapeAlarms.js';

/**
 * Decides whether a price check or a listing status scan has likely broken, from facts the scrape already holds.
 * Assessment is pure, and scrapeAlarms only touches Electron lazily, so a live harness can import this and call it directly.
 * Only reportMarketplaceScrapeHealth touches the alarm store, and it never throws into the scrape.
 *
 * Limits are PROVISIONAL: no real saved marketplace rows exist on disk. Healthy yield comes from the April fixtures and
 * one set of live runs on 2026-11-05 (eBay active 60 seen, 0 bad; Poshmark 144 seen, 0 no price; Mercari 9 seen, 0 bad).
 */
export const MARKETPLACE_FIELD_LIMITS = { minAttempts: 8, minBad: 5, maxShare: 0.5 };
// Poshmark's selector also matches nested non-tile elements: the healthy April fixture reads seen 144 / noFields 77 / noPrice 0,
// so noFields cannot be judged by share there. Only noPrice is clean on healthy data; a price-stripped copy reads 42 of 144.
export const POSHMARK_FIELD_LIMITS = { minAttempts: 8, minBad: 5, maxShare: 0.2 };
export const HUB_SCAN_LIMITS = { minAttempts: 5, minBad: 3, maxShare: 0.5 };
const HUB_RECENT_READS = 10;
const recentHubReads = new Map();

const SURFACE_PRICE = 'price checks';
const SURFACE_HUB = 'listing status scans';
const SOURCE_LABEL = {
  'ebay-sold': 'eBay sold', 'ebay-active': 'eBay active', poshmark: 'Poshmark', mercari: 'Mercari',
  swappa: 'Swappa', 'swappa-sold': 'Swappa sold', reverb: 'Reverb', pricecharting: 'PriceCharting', 'aptdeco-active': 'AptDeco',
};
const SHAPE_TEXT = {
  'no-listings-array': 'answered 200 but its response had no listings array',
  'no-results-table': 'returned a page with no results table and no product page',
  'no-hits-array': 'returned a page with no embedded search hits array',
  'fetch-failed': 'could not load its model page from inside the page',
  'empty-body': 'returned an almost empty model page',
};

const VOLUME_GUESS_WARNINGS = new Set(['zero-extracted', 'suspicious-empty']);
/**
 * Poshmark and Mercari throw SITE_CHANGED on any zero, so one rare item that truly has no listings looks the same as a
 * redesign. Items in a row with no cards, for one source, are what a redesign looks like. Provisional.
 */
export const STALE_ZERO_ITEMS_IN_A_ROW = 3;
const staleZeroStreaks = new Map();
export function resetMarketplaceScrapeHealthForTests() { staleZeroStreaks.clear(); recentHubReads.clear(); }


/** Reverb: an honest zero carries `listings: []`. Anything else (HTML, an error envelope, no key) is not the API we read. */
export function reverbShapeMissing(json) {
  return Array.isArray(json?.listings) ? null : 'no-listings-array';
}

/**
 * PriceCharting: zero parsed rows is honest only when the page has a results table, is a product page (an exact match
 * redirects there), or says it found nothing. Provisional: the product-page and no-results markers come from code
 * knowledge of the site, not from a saved page.
 */
export function priceChartingShapeMissing({ html, finalUrl, parsedCount }) {
  if (parsedCount > 0) return null;
  const body = String(html || '');
  if (/id=["']games_table["']/i.test(body)) return null;
  if (/\/game\//i.test(String(finalUrl || '')) || /id=["']product_name["']/i.test(body)) return null;
  if (/\bno (?:matching )?(?:products?|results?|games?) found\b|\b0 results\b/i.test(body)) return null;
  return 'no-results-table';
}

/** AptDeco: `"hits":[` must be present and its array must parse. `rawHitCount` is extractAlgoliaHits(html).length. */
export function aptDecoShapeMissing(html, rawHitCount) {
  const body = String(html || '');
  const marker = '"hits":[';
  const at = body.indexOf(marker);
  if (at < 0) return 'no-hits-array';
  if (rawHitCount > 0) return null;
  return /^\s*\]/.test(body.slice(at + marker.length)) ? null : 'no-hits-array';
}

const total = (...values) => values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);

/**
 * Folds one query's results into running totals, so a multi-item run is judged on everything it read rather than on
 * whichever item finished last. `result` is scrapeCompsForQuery's return value.
 */
export function accumulateMarketplaceObservations(acc, result, streaks = staleZeroStreaks) {
  const next = acc || { yieldBySource: {}, shapeBySource: {}, bySource: {} };
  const staleThisItem = new Set((Array.isArray(result?.scrapeWarnings) ? result.scrapeWarnings : [])
    .filter(warning => warning?.code === 'stale-selectors' && warning.platformLoggedOut !== true).map(warning => warning.sourceId));
  for (const id of staleThisItem) streaks.set(id, (streaks.get(id) || 0) + 1);
  for (const [id, count] of Object.entries(result?.bySource || {})) if (count > 0 && !staleThisItem.has(id)) streaks.delete(id);
  for (const [id, stats] of Object.entries(result?.yieldBySource || {})) if (stats?.seen > 0 && !staleThisItem.has(id)) streaks.delete(id);
  next.staleZeroStreaks = Object.fromEntries(streaks);
  for (const [id, stats] of Object.entries(result?.yieldBySource || {})) {
    const have = next.yieldBySource[id] || { seen: 0, noFields: 0, noTitle: 0, noPrice: 0, noLink: 0 };
    next.yieldBySource[id] = {
      seen: total(have.seen, stats?.seen), noFields: total(have.noFields, stats?.noFields), noTitle: total(have.noTitle, stats?.noTitle),
      noPrice: total(have.noPrice, stats?.noPrice), noLink: total(have.noLink, stats?.noLink),
    };
    if (typeof stats?.shapeFlag === 'string') next.shapeBySource[id] = next.shapeBySource[id] || stats.shapeFlag;
  }
  for (const [id, flag] of Object.entries(result?.shapeBySource || {})) {
    // A flag from any item sticks; null (checked, fine) only fills a source that has no flag yet.
    if (typeof flag === 'string') next.shapeBySource[id] = next.shapeBySource[id] || flag;
    else if (!(id in next.shapeBySource)) next.shapeBySource[id] = null;
  }
  for (const [id, count] of Object.entries(result?.bySource || {})) next.bySource[id] = total(next.bySource[id], count);
  return next;
}

function fieldFailure(id, stats) {
  const limits = id === 'poshmark' ? POSHMARK_FIELD_LIMITS : MARKETPLACE_FIELD_LIMITS;
  const attempts = total(stats?.seen);
  const bad = id === 'poshmark' ? total(stats?.noPrice) : total(stats?.noFields);
  if (attempts < limits.minAttempts) return undefined;
  if (!scrapeShareBroken({ attempts, bad, ...limits })) return null;
  const label = SOURCE_LABEL[id] || id;
  return { what: `${label} listings were found but ${id === 'poshmark' ? 'prices' : 'title, price or link'} could not be read from most of them`, attempts, bad };
}

/**
 * One entry per source that can be judged: { key, surface, site, failure }. `failure` is an object (raise), null (clear)
 * or the source is left out (say nothing, an existing alarm stays). A source carrying any block, throttle or failure
 * warning is left out so its own message stands alone. Only the stale-selectors zero warning also raises an alarm.
 */
export function assessMarketplaceScrape({ yieldBySource = {}, shapeBySource = {}, bySource = {}, sourceWarnings = {}, staleZeroStreaks: streaks = {} } = {}) {
  const out = [];
  const ids = new Set([...Object.keys(yieldBySource), ...Object.keys(shapeBySource), ...Object.keys(bySource), ...Object.keys(sourceWarnings)]);
  for (const id of ids) {
    const label = SOURCE_LABEL[id] || id;
    const warning = sourceWarnings[id];
    const push = (kind, failure) => out.push({ key: `marketplace:${id}:${kind}`, surface: SURFACE_PRICE, site: label, failure });
    const streak = total(streaks[id]);
    if (streak >= STALE_ZERO_ITEMS_IN_A_ROW) {
      push('shape', { what: `${label} found no listing cards for ${streak} items in a row, and the source card shows stale selectors`, attempts: streak, bad: streak });
      continue;
    }
    // zero-extracted and suspicious-empty are the anti-bot detector's guess from a thin count, not a known block, so they do not silence a source.
    if (warning && warning.code !== 'stale-selectors' && !VOLUME_GUESS_WARNINGS.has(warning.code)) continue;
    // One zero says nothing yet, either way.
    if (warning?.code === 'stale-selectors' && streak > 0) continue;
    const flag = shapeBySource[id];
    if (typeof flag === 'string') {
      push('shape', { what: `${label} ${SHAPE_TEXT[flag] || 'returned a page without the structure we read'}`, attempts: 1, bad: 1 });
    } else if (flag === null || total(bySource[id]) > 0 || total(yieldBySource[id]?.seen) > 0) {
      push('shape', null);
    }
    const fields = yieldBySource[id] ? fieldFailure(id, yieldBySource[id]) : undefined;
    if (fields !== undefined) push('fields', fields);
  }
  return out;
}

/**
 * Judges one platform's hub page reads from prepareHubPages' result. A page counts as bad only when its terminal
 * outcome carries readFailure and no known cause (anti-bot wall, login, challenge). Known-cause pages are left out
 * of the sample so they neither fire nor dilute it.
 */
export function assessHubScan(prepared, { earlierReads = [] } = {}) {
  const platformId = String(prepared?.platformId || '').trim();
  if (!platformId) return null;
  const sources = Array.isArray(prepared?.sources) ? prepared.sources : [];
  const readable = Array.isArray(prepared?.llmInputs) ? prepared.llmInputs.length : 0;
  const known = source => Boolean(source?.antiBot || source?.warning || source?.challenged || source?.loggedOut
    || source?.loginBounce || source?.appleEventsDisabled || source?.status === 'needs-login');
  const counted = sources.filter(source => !known(source));
  const reads = [...earlierReads, ...Array.from({ length: readable }, () => false), ...counted.map(source => source?.readFailure === true)].slice(-HUB_RECENT_READS);
  const attempts = reads.length;
  const bad = reads.filter(Boolean).length;
  const base = { key: `hub-scan:${platformId}`, surface: SURFACE_HUB, site: platformId };
  if (attempts < HUB_SCAN_LIMITS.minAttempts) return { ...base, failure: undefined };
  if (scrapeShareBroken({ attempts, bad, ...HUB_SCAN_LIMITS })) {
    return { ...base, failure: { what: 'Most hub pages in this scan came back empty or with an HTTP error, with no login or anti-bot cause', attempts, bad } };
  }
  return { ...base, failure: null };
}

/** A platform often watches one to three pages, so reads from recent scans are judged together. */
export function assessHubScanWithHistory(prepared) {
  const platformId = String(prepared?.platformId || '').trim();
  const verdict = assessHubScan(prepared, { earlierReads: recentHubReads.get(platformId) || [] });
  if (!verdict) return null;
  const known = source => Boolean(source?.antiBot || source?.warning || source?.challenged || source?.loggedOut
    || source?.loginBounce || source?.appleEventsDisabled || source?.status === 'needs-login');
  const fresh = [...Array.from({ length: Array.isArray(prepared?.llmInputs) ? prepared.llmInputs.length : 0 }, () => false),
    ...(Array.isArray(prepared?.sources) ? prepared.sources : []).filter(source => !known(source)).map(source => source?.readFailure === true)];
  recentHubReads.set(platformId, [...(recentHubReads.get(platformId) || []), ...fresh].slice(-HUB_RECENT_READS));
  return verdict;
}

/** Sends each judged entry to the alarm store. */
export function reportMarketplaceScrapeHealth(entries) {
  try {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || entry.failure === undefined) continue;
      reportScrapeHealth({ key: entry.key, surface: entry.surface, site: entry.site, failure: entry.failure });
    }
  } catch { /* alarm bookkeeping must never disturb the scrape */ }
}
