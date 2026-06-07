// Pure helpers for multi-item ("bundle") price research — a single listing that
// packages several independent products (e.g. kayak + paddle). The primary item
// comes from the AI photo analysis (`data.product`); the user can attach extra
// items by hand (`data.extraItems`). Each item runs its own complete pricing
// pass, then the hub shows per-item FMV + a suggested bundle total.
//
// Kept dependency-free so the test runner can exercise it without React/Electron.

const DEFAULT_CONDITION = 'Used - Good';

// A brand/model the AI couldn't identify comes back as the literal "Unknown" —
// concatenating it into a search query ("Unknown Unknown Glass Jug") poisons the
// comp scrape, so it's stripped like an empty field.
function cleanToken(t) {
  const s = (t || '').trim();
  return (!s || s.toLowerCase() === 'unknown') ? '' : s;
}

/**
 * Neutral, search-friendly query for ANY item (primary or a user-added extra),
 * built from the same shape `data.product` has. Prefers an explicit
 * `search_query` (the AI's brand+model+price-driving-specs string, condition/
 * color stripped), else the brand+model+title concat with "Unknown"/blank tokens
 * dropped.
 */
export function buildItemQuery(item = {}) {
  const explicit = (item.search_query || '').trim();
  if (explicit) return explicit;
  return [cleanToken(item.brand), cleanToken(item.model), (item.generated_title || '').trim()]
    .filter(Boolean).join(' ').trim();
}

/** Back-compat alias — the primary item is just an item. */
export function buildPrimaryQuery(product = {}) {
  return buildItemQuery(product);
}

/**
 * Ordered list of items to research — the primary (from the AI analysis) first,
 * then each user-added extra. Extras with a blank query are dropped (an empty
 * input row shouldn't spawn a wasted scrape). Each extra inherits the primary's
 * condition only when it didn't set its own.
 *
 * @param {object} product       data.product (AI analysis of the photos)
 * @param {Array}  extraItems    data.extraItems — full item shape:
 *                               [{ id, generated_title, brand, model, condition, pricingNotes }]
 * @param {string} primaryNotes  data.pricingNotes — the hub-level notes, which
 *                               belong to the primary item's pricing pass
 * @returns {Array} [{ key, label, query, condition, pricingNotes }] — primary keyed 'primary'
 */
export function buildResearchItems(product = {}, extraItems = [], primaryNotes = '') {
  const primaryCondition = product.condition || DEFAULT_CONDITION;
  const items = [{
    key: 'primary',
    label: product.generated_title || `${product.brand || ''} ${product.model || ''}`.trim() || 'Main item',
    query: buildItemQuery(product),
    condition: primaryCondition,
    pricingNotes: primaryNotes || '',
  }];

  for (const extra of Array.isArray(extraItems) ? extraItems : []) {
    // Each extra carries the same editable fields as the primary (title/brand/
    // model/condition/notes); its query is derived the same way. An extra with
    // nothing to search on (no title/brand/model) is dropped, not scraped.
    const query = buildItemQuery(extra);
    if (!query) continue;
    items.push({
      key: extra.id || query,
      label: (extra.generated_title || '').trim() || query,
      query,
      condition: extra.condition || primaryCondition,
      pricingNotes: extra.pricingNotes || '',
    });
  }
  return items;
}

/**
 * Suggested bundle price = sum of every item's recommended_price. Items whose
 * synthesis produced no price (null/undefined/non-finite) are skipped. Returns
 * null when no item yielded a price (so the UI can hide the total rather than
 * show "$0").
 *
 * @param {Array} itemPricings — [{ pricing: { recommended_price } }, ...]
 * @returns {number|null}
 */
export function computeBundleTotal(itemPricings = []) {
  let total = 0;
  let any = false;
  for (const it of Array.isArray(itemPricings) ? itemPricings : []) {
    const raw = it?.pricing?.recommended_price;
    // Guard before Number(): Number(null) === 0 (finite), which would let a
    // priceless item silently count as $0.
    if (raw === null || raw === undefined || raw === '') continue;
    const price = Number(raw);
    if (Number.isFinite(price)) { total += price; any = true; }
  }
  return any ? total : null;
}

/**
 * Decide what the bundle UI shows as its headline figure. The AI's synergy-aware
 * combined price (bundlePricing.bundle_price) wins when present; otherwise we
 * fall back to the arithmetic sum (bundleTotal). `showSumRef` is true only when
 * the AI actually moved the price off the sum — so the UI shows the
 * "sum if sold separately" reference line instead of two identical numbers.
 *
 * @param {object|null} bundlePricing — { quick_sell_price, bundle_price, max_profit_price, synergy, justification }
 * @param {number|null} bundleTotal   — arithmetic sum of per-item prices
 * @returns {{ headline:number|null, aiPrice:number|null, showSumRef:boolean, synergy:string|null }}
 */
export function selectBundleHeadline(bundlePricing, bundleTotal = null) {
  const aiPrice = (bundlePricing && bundlePricing.bundle_price != null) ? Number(bundlePricing.bundle_price) : null;
  const validAi = aiPrice != null && Number.isFinite(aiPrice) ? aiPrice : null;
  const headline = validAi != null ? validAi : (bundleTotal != null ? bundleTotal : null);
  const showSumRef = validAi != null && bundleTotal != null && validAi !== bundleTotal;
  return { headline, aiPrice: validAi, showSumRef, synergy: bundlePricing?.synergy || null };
}

function finitePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const price = Number(value);
  return Number.isFinite(price) ? price : null;
}

function sumItemTier(itemPricings, field) {
  const pricedItems = (Array.isArray(itemPricings) ? itemPricings : [])
    .filter(it => finitePrice(it?.pricing?.recommended_price) != null);
  if (pricedItems.length === 0) return null;

  let total = 0;
  for (const item of pricedItems) {
    const value = finitePrice(item?.pricing?.[field]);
    if (value == null) return null;
    total += value;
  }
  return total;
}

/**
 * Select the three prices shown in the Sell Hub result. For bundles, every tier
 * is listing-level: the AI's explicit bundle quick/best/max values win. Older
 * saved results only have `bundle_price`, so their quick/max tiers are derived
 * from the corresponding per-item sums and adjusted by the same ratio the AI
 * applied to the recommended bundle price.
 *
 * @returns {{ quick:number|null, best:number|null, max:number|null, isBundle:boolean }}
 */
export function selectListingPriceTiers({
  pricing = null,
  itemPricings = null,
  bundlePricing = null,
  bundleTotal = null,
} = {}) {
  const isBundle = Array.isArray(itemPricings) && itemPricings.length > 1;
  if (!isBundle) {
    const best = finitePrice(pricing?.recommended_price);
    const quick = finitePrice(pricing?.quick_sell_price);
    const max = finitePrice(pricing?.max_profit_price);
    return {
      quick: quick != null && best != null ? Math.min(quick, best) : quick,
      best,
      max: max != null && best != null ? Math.max(max, best) : max,
      isBundle: false,
    };
  }

  const best = finitePrice(selectBundleHeadline(bundlePricing, bundleTotal).headline);
  const separateBest = finitePrice(bundleTotal);
  const adjustment = best != null && separateBest != null && separateBest > 0
    ? best / separateBest
    : 1;
  const fallbackQuick = sumItemTier(itemPricings, 'quick_sell_price');
  const fallbackMax = sumItemTier(itemPricings, 'max_profit_price');
  const explicitQuick = finitePrice(bundlePricing?.quick_sell_price);
  const explicitMax = finitePrice(bundlePricing?.max_profit_price);
  const quick = explicitQuick ?? (fallbackQuick != null ? Math.round(fallbackQuick * adjustment) : null);
  const max = explicitMax ?? (fallbackMax != null ? Math.round(fallbackMax * adjustment) : null);

  return {
    quick: quick != null && best != null ? Math.min(quick, best) : quick,
    best,
    max: max != null && best != null ? Math.max(max, best) : max,
    isBundle: true,
  };
}
