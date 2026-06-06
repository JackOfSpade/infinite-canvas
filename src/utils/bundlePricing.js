// Pure helpers for multi-item ("bundle") price research — a single listing that
// packages several independent products (e.g. kayak + paddle). The primary item
// comes from the AI photo analysis (`data.product`); the user can attach extra
// items by hand (`data.extraItems`). Each item runs its own complete pricing
// pass, then the hub shows per-item FMV + a suggested bundle total.
//
// Kept dependency-free so the test runner can exercise it without React/Electron.

const DEFAULT_CONDITION = 'Used - Good';

/**
 * Neutral, search-friendly query for the PRIMARY item. Mirrors
 * useListingActions.buildSearchQuery: prefer the AI `search_query`
 * (brand+model+price-driving specs, no condition/color fluff), else fall back
 * to the brand+model+title concat for pre-search_query workspaces.
 */
export function buildPrimaryQuery(product = {}) {
  const ai = (product.search_query || '').trim();
  if (ai) return ai;
  return `${product.brand || ''} ${product.model || ''} ${product.generated_title || ''}`.trim();
}

/**
 * Ordered list of items to research — the primary (from the AI analysis) first,
 * then each user-added extra. Extras with a blank query are dropped (an empty
 * input row shouldn't spawn a wasted scrape). Each extra inherits the primary's
 * condition only when it didn't set its own.
 *
 * @param {object} product       data.product (AI analysis of the photos)
 * @param {Array}  extraItems    data.extraItems — [{ id, query, condition }]
 * @returns {Array} [{ key, label, query, condition }] — primary keyed 'primary'
 */
export function buildResearchItems(product = {}, extraItems = []) {
  const primaryCondition = product.condition || DEFAULT_CONDITION;
  const items = [{
    key: 'primary',
    label: product.generated_title || `${product.brand || ''} ${product.model || ''}`.trim() || 'Main item',
    query: buildPrimaryQuery(product),
    condition: primaryCondition,
  }];

  for (const extra of Array.isArray(extraItems) ? extraItems : []) {
    const query = (extra?.query || '').trim();
    if (!query) continue;
    items.push({
      key: extra.id || query,
      label: query,
      query,
      condition: extra.condition || primaryCondition,
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
