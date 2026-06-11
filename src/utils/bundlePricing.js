// Pure helpers for multi-item ("bundle") price research — a single listing that
// packages several independent products (e.g. kayak + paddle). The primary item
// comes from the AI photo analysis (`data.product`); the user can attach extra
// items by hand (`data.extraItems`). Each item runs its own complete pricing
// pass, then the hub shows per-item FMV + a suggested bundle total.
//
// Kept dependency-free so the test runner can exercise it without React/Electron.

const DEFAULT_CONDITION = 'Used - Good';
const MAX_BUNDLE_ADJUSTMENT_PERCENT = 50;
const MAX_QUICK_REDUCTION_PERCENT = 75;
const MAX_MAX_INCREASE_PERCENT = 100;
const MAX_FACTORS_PER_TIER = 8;

// A brand/model the AI couldn't identify comes back as the literal "Unknown" —
// concatenating it into a search query ("Unknown Unknown Glass Jug") poisons the
// comp scrape, so it's stripped like an empty field.
function cleanToken(t) {
  const s = (t || '').trim();
  return (!s || s.toLowerCase() === 'unknown') ? '' : s;
}

// True when `title` already states `token` as a whole word (case-insensitive),
// so we don't re-prepend a brand/model the title already leads with — a
// user-typed title "Zippo Butane Fuel" + brand "Zippo" must not become "Zippo
// Zippo Butane Fuel". The neighbour check (non-alphanumeric on both sides)
// approximates a word boundary without a regex, so model numbers carrying
// punctuation (e.g. "WH-1000XM4") stay safe.
function titleContainsToken(title, token) {
  if (!token) return false;
  const hay = title.toLowerCase();
  const needle = token.toLowerCase();
  for (let from = 0; ;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx === 0 ? '' : hay[idx - 1];
    const after = idx + needle.length >= hay.length ? '' : hay[idx + needle.length];
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = idx + 1;
  }
}

/**
 * Neutral, search-friendly query for ANY item (primary or a user-added extra),
 * built from the same shape `data.product` has. Prefers an explicit
 * `search_query` (the AI's brand+model+price-driving-specs string, condition/
 * color stripped) — but the draft CLEARS that field when the user edits the
 * title/brand/model (useListingActions.handleFieldEdit), so an edited item falls
 * through to the title-derived path below: "what you priced = what you saw".
 * That fallback is brand+model+title with "Unknown"/blank tokens dropped AND any
 * brand/model the title already contains skipped (so a title that already leads
 * with them isn't doubled — "Zippo Zippo Butane Fuel").
 */
export function buildItemQuery(item = {}) {
  const explicit = (item.search_query || '').trim();
  if (explicit) return explicit;
  const title = (item.generated_title || '').trim();
  const brand = cleanToken(item.brand);
  const model = cleanToken(item.model);
  const tokens = [];
  if (brand && !titleContainsToken(title, brand)) tokens.push(brand);
  if (model && model.toLowerCase() !== brand.toLowerCase() && !titleContainsToken(title, model)) {
    tokens.push(model);
  }
  if (title) tokens.push(title);
  return tokens.filter(Boolean).join(' ').trim();
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
 * Build research inputs when refreshing an already-priced hub. Normal hubs
 * retain `extraItems`; older saved bundle results may only retain
 * `itemPricings`. Recover those saved items so Refresh Prices cannot silently
 * collapse an existing bundle into a single-item run.
 */
export function buildRefreshResearchItems(product = {}, extraItems = [], itemPricings = [], primaryNotes = '') {
  const explicitExtras = Array.isArray(extraItems) ? extraItems.filter(it => buildItemQuery(it)) : [];
  if (explicitExtras.length > 0 || !Array.isArray(itemPricings) || itemPricings.length <= 1) {
    return buildResearchItems(product, extraItems, primaryNotes);
  }
  const recoveredExtras = itemPricings.slice(1).map((it, index) => ({
    id: it?.key || `recovered-extra-${index + 1}`,
    generated_title: it?.label || it?.query || `Item ${index + 2}`,
    search_query: it?.query || '',
    condition: it?.condition || product.condition || DEFAULT_CONDITION,
    pricingNotes: it?.pricingNotes || '',
  }));
  return buildResearchItems(product, recoveredExtras, primaryNotes);
}

/**
 * Final listing title shown after pricing. Bundles name every individual item
 * in order so the visible/copyable title describes the whole listing instead
 * of only the primary photo-analysis result.
 */
export function buildFinalListingTitle(product = {}, itemPricings = null) {
  const primaryTitle = String(product?.generated_title || '').trim() || 'Item';
  if (!Array.isArray(itemPricings) || itemPricings.length <= 1) return primaryTitle;

  return itemPricings.map((item, index) => (
    String(item?.label || item?.query || (index === 0 ? primaryTitle : `Item ${index + 1}`)).trim()
      || `Item ${index + 1}`
  )).join(' + ');
}

/**
 * Suggested bundle price = sum of every positive recommended_price. Items whose
 * synthesis produced no usable price (null/undefined/non-finite/non-positive)
 * are skipped. Returns null when no item yielded a price (so the UI can hide the
 * total rather than show "$0").
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
    const rounded = Number.isFinite(price) ? roundToCents(price) : null;
    if (rounded != null && rounded > 0) { total += rounded; any = true; }
  }
  return any ? roundToCents(total) : null;
}

function finiteBundlePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const price = Number(value);
  return Number.isFinite(price) ? price : null;
}

function finitePositiveBundlePrice(value) {
  const price = finiteBundlePrice(value);
  if (price == null) return null;
  const rounded = roundToCents(price);
  return rounded > 0 ? rounded : null;
}

function formatBundleAmount(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  return rounded.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function boundedNonNegativePercent(value, maximum) {
  const percent = finiteBundlePrice(value);
  return percent == null ? 0 : Math.min(maximum, Math.max(0, percent));
}

function roundToCents(value) {
  return Math.round(Number(value) * 100) / 100;
}

function roundDerivedPrice(value, referencePrice) {
  const safe = Math.max(0, value);
  const cents = roundToCents(safe);
  const reference = finiteBundlePrice(referencePrice);
  if (safe < 10 || reference == null) return cents;

  // Prefer listing-friendly whole dollars only when that rounding error is
  // small relative to the adjustment the factors actually requested. Otherwise
  // a tiny factor near a dollar boundary can become a much larger price move.
  const whole = Math.round(safe);
  const intendedChange = Math.abs(safe - reference);
  const roundingError = Math.abs(whole - safe);
  return intendedChange > 0 && roundingError <= intendedChange * 0.25 ? whole : cents;
}

function deriveAdjustedPrice(referencePrice, signedPercent) {
  const reference = roundToCents(referencePrice);
  if (signedPercent === 0) return reference;
  const exact = reference * (1 + signedPercent / 100);
  let price = roundDerivedPrice(exact, reference);

  // A nonzero factor must visibly move its tier in the declared direction.
  // One cent is the smallest honest movement when currency rounding collapses
  // the exact adjustment back onto the reference price.
  if (signedPercent > 0 && price <= reference) {
    price = (Math.round(reference * 100) + 1) / 100;
  }
  if (signedPercent < 0 && price >= reference) {
    price = Math.max(0, (Math.round(reference * 100) - 1) / 100);
  }
  return price;
}

function deriveRelationshipPrice(separateTotal, relationship, adjustmentPercent) {
  if (relationship === 'neutral') return roundToCents(separateTotal);
  const signedPercent = relationship === 'premium' ? adjustmentPercent : -adjustmentPercent;
  return deriveAdjustedPrice(separateTotal, signedPercent);
}

function relationshipSentence(bundlePrice, separateTotal, synergy) {
  const delta = bundlePrice - separateTotal;
  const deltaPct = separateTotal !== 0 ? Math.round(Math.abs(delta) / Math.abs(separateTotal) * 100) : null;
  const percentPhrase = deltaPct != null ? ` (${deltaPct}%)` : '';
  if (synergy === 'premium') {
    return `At $${formatBundleAmount(bundlePrice)}, the bundle is $${formatBundleAmount(Math.abs(delta))}${percentPhrase} above the $${formatBundleAmount(separateTotal)} combined individual value.`;
  }
  if (synergy === 'discount') {
    return `At $${formatBundleAmount(bundlePrice)}, the bundle is $${formatBundleAmount(Math.abs(delta))}${percentPhrase} below the $${formatBundleAmount(separateTotal)} combined individual value.`;
  }
  return `At $${formatBundleAmount(bundlePrice)}, the bundle matches the $${formatBundleAmount(separateTotal)} combined individual value.`;
}

function cleanReason(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatPercent(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function clampSigned(value, maximum) {
  return Math.max(-maximum, Math.min(maximum, value));
}

function normalizeBundleFactors(rawFactors) {
  const factors = [];
  const input = Array.isArray(rawFactors) ? rawFactors : [];
  let rejected = Math.max(0, input.length - MAX_FACTORS_PER_TIER);
  let factorBounded = input.length > MAX_FACTORS_PER_TIER;
  for (const raw of input.slice(0, MAX_FACTORS_PER_TIER)) {
    if (raw?.direction !== 'premium' && raw?.direction !== 'discount') {
      rejected += 1;
      continue;
    }
    const proposedPercent = finiteBundlePrice(raw.percent);
    const percent = boundedNonNegativePercent(raw.percent, MAX_BUNDLE_ADJUSTMENT_PERCENT);
    const reason = cleanReason(raw.reason);
    if (proposedPercent != null && proposedPercent > MAX_BUNDLE_ADJUSTMENT_PERCENT) factorBounded = true;
    if (percent <= 0 || !reason || bundleJustificationContradicts(reason, raw.direction)) {
      rejected += 1;
      continue;
    }
    factors.push({ direction: raw.direction, percent, reason });
  }
  const rawTotal = factors.reduce((total, factor) => (
    total + (factor.direction === 'premium' ? factor.percent : -factor.percent)
  ), 0);
  const appliedTotal = clampSigned(rawTotal, MAX_BUNDLE_ADJUSTMENT_PERCENT);
  const aggregateCapped = rawTotal !== appliedTotal;
  return { factors, rawTotal, appliedTotal, factorBounded, aggregateCapped, capped: factorBounded || aggregateCapped, rejected };
}

function normalizeTierFactors(rawFactors, maximum) {
  const factors = [];
  const input = Array.isArray(rawFactors) ? rawFactors : [];
  let rejected = Math.max(0, input.length - MAX_FACTORS_PER_TIER);
  let factorBounded = input.length > MAX_FACTORS_PER_TIER;
  for (const raw of input.slice(0, MAX_FACTORS_PER_TIER)) {
    const proposedPercent = finiteBundlePrice(raw?.percent);
    const percent = boundedNonNegativePercent(raw?.percent, maximum);
    const reason = cleanReason(raw?.reason);
    if (proposedPercent != null && proposedPercent > maximum) factorBounded = true;
    if (percent <= 0 || !reason) {
      rejected += 1;
      continue;
    }
    factors.push({ percent, reason });
  }
  const rawTotal = factors.reduce((total, factor) => total + factor.percent, 0);
  const appliedTotal = Math.min(maximum, rawTotal);
  const aggregateCapped = rawTotal !== appliedTotal;
  return { factors, rawTotal, appliedTotal, factorBounded, aggregateCapped, capped: factorBounded || aggregateCapped, rejected };
}

function bundleFactorsSentence({ factors, rawTotal, appliedTotal, factorBounded, aggregateCapped }) {
  if (factors.length === 0) {
    return 'No bundle-value factors were identified, so the bundle remains at the combined individual value.';
  }
  const details = factors.map(factor => (
    `${factor.direction === 'premium' ? '+' : '-'}${formatPercent(factor.percent)}%: ${factor.reason}`
  )).join(' ');
  const net = `${appliedTotal > 0 ? '+' : ''}${formatPercent(appliedTotal)}%`;
  const cap = [
    factorBounded ? 'One or more proposed factors were bounded before aggregation.' : '',
    aggregateCapped ? `The raw ${rawTotal > 0 ? '+' : ''}${formatPercent(rawTotal)}% total was bounded to ${net}.` : '',
  ].filter(Boolean).join(' ');
  return `Bundle factors: ${details} Net bundle adjustment: ${net}.${cap ? ` ${cap}` : ''}`;
}

function tierFactorsSentence(label, sign, aggregate) {
  const { factors, rawTotal, appliedTotal, factorBounded, aggregateCapped } = aggregate;
  if (factors.length === 0) return `No ${label.toLowerCase()} adjustment factors were identified.`;
  const details = factors.map(factor => `${sign}${formatPercent(factor.percent)}%: ${factor.reason}`).join(' ');
  const cap = [
    factorBounded ? 'One or more proposed factors were bounded before aggregation.' : '',
    aggregateCapped ? `The raw ${formatPercent(rawTotal)}% total was bounded to ${formatPercent(appliedTotal)}%.` : '',
  ].filter(Boolean).join(' ');
  return `${label} factors: ${details} Total ${label.toLowerCase()} adjustment: ${sign}${formatPercent(appliedTotal)}%.${cap ? ` ${cap}` : ''}`;
}

/**
 * Derive the only synergy label consistent with the bundle price and the sum
 * of the individual prices. Compare rounded cents so floating-point noise
 * cannot turn an equal price into a premium or discount.
 */
export function bundleSynergyForPrices(bundlePrice, separateTotal) {
  const bundle = finiteBundlePrice(bundlePrice);
  const separate = finiteBundlePrice(separateTotal);
  if (bundle == null || separate == null) return null;
  const deltaCents = Math.round(bundle * 100) - Math.round(separate * 100);
  return deltaCents > 0 ? 'premium' : deltaCents < 0 ? 'discount' : 'neutral';
}

function correctedBundleJustification(result, separateTotal, synergy, itemCount) {
  const bundlePrice = finiteBundlePrice(result?.bundle_price);
  const quickPrice = finiteBundlePrice(result?.quick_sell_price);
  const maxPrice = finiteBundlePrice(result?.max_profit_price);
  const itemPhrase = itemCount > 1 ? ` for all ${itemCount} items` : '';

  let relationship;
  if (synergy === 'premium') {
    relationship = `${relationshipSentence(bundlePrice, separateTotal, synergy).slice(0, -1)}, reflecting the added convenience and value of buying the set together.`;
  } else if (synergy === 'discount') {
    relationship = `${relationshipSentence(bundlePrice, separateTotal, synergy).slice(0, -1)}, giving the buyer a modest discount${itemPhrase} in exchange for one transaction.`;
  } else {
    relationship = `${relationshipSentence(bundlePrice, separateTotal, synergy).slice(0, -1)}, so neither a premium nor a discount is applied.`;
  }

  if (quickPrice != null && maxPrice != null) {
    return `${relationship} The $${formatBundleAmount(quickPrice)} quick price prioritizes a faster sale, while $${formatBundleAmount(maxPrice)} tests the upper end for a patient seller.`;
  }
  return relationship;
}

function bundleJustificationContradicts(justification, expectedSynergy) {
  const text = String(justification || '').toLowerCase();
  if (!text) return false;
  // Ignore explicit negations such as "without a premium"; remaining opposite
  // relationship terms are treated as asserted contradictions.
  const withoutNegations = text
    .replace(/\b(?:no|not|without|avoids?|avoiding)\s+(?:a\s+)?(?:premium|discount)\b/g, '')
    .replace(/\brather than\s+(?:a\s+|at\s+a\s+)?(?:premium|discount)\b/g, '');
  if (expectedSynergy === 'premium') return /\b(?:discount|below|less than)\b/.test(withoutNegations);
  if (expectedSynergy === 'discount') return /\b(?:premium|above|more than)\b/.test(withoutNegations);
  return /\b(?:premium|discount|above|below|more than|less than)\b/.test(withoutNegations);
}

/**
 * Turn attributable AI pricing factors into the complete bundle result. Every
 * percentage that changes a price carries its reason in the same structured
 * factor; code owns aggregation, caps, arithmetic, labels, and explanation.
 */
export function deriveBundlePricingResult(decision, separateTotal, itemCount = null) {
  const sum = finitePositiveBundlePrice(separateTotal);
  if (
    !decision
    || typeof decision !== 'object'
    || sum == null
    || !Array.isArray(decision.bundle_factors)
    || !Array.isArray(decision.quick_sell_factors)
    || !Array.isArray(decision.max_profit_factors)
  ) return null;
  const bundleFactors = normalizeBundleFactors(decision.bundle_factors);
  const quickFactors = normalizeTierFactors(decision.quick_sell_factors, MAX_QUICK_REDUCTION_PERCENT);
  const maxFactors = normalizeTierFactors(decision.max_profit_factors, MAX_MAX_INCREASE_PERCENT);
  // Never price from a partial factor response. Dropping one malformed,
  // contradictory, or over-limit factor can materially reverse the net result;
  // falling back to the separate-item sum is safer than silently using a biased
  // subset of the model's decision.
  if (bundleFactors.rejected || quickFactors.rejected || maxFactors.rejected) return null;
  const adjustmentPercent = bundleFactors.appliedTotal;
  const relationship = adjustmentPercent > 0 ? 'premium' : adjustmentPercent < 0 ? 'discount' : 'neutral';
  const bundlePrice = deriveRelationshipPrice(sum, relationship, Math.abs(adjustmentPercent));
  if (bundlePrice <= 0) return null;
  const quickReductionPercent = quickFactors.appliedTotal;
  const maxIncreasePercent = maxFactors.appliedTotal;
  const quickPrice = deriveAdjustedPrice(bundlePrice, -quickReductionPercent);
  const maxPrice = deriveAdjustedPrice(bundlePrice, maxIncreasePercent);
  if (quickPrice <= 0 || maxPrice <= 0) return null;
  const exactRelationship = relationshipSentence(bundlePrice, sum, relationship);
  const exactTiers = quickPrice === bundlePrice && maxPrice === bundlePrice
    ? `Quick and Max remain at $${formatBundleAmount(bundlePrice)} because no tier adjustment was derived.`
    : `The derived Quick price is $${formatBundleAmount(quickPrice)}, while the derived Max price is $${formatBundleAmount(maxPrice)}.`;
  const justification = [
    exactRelationship,
    bundleFactorsSentence(bundleFactors),
    exactTiers,
    tierFactorsSentence('Quick-sale', '-', quickFactors),
    tierFactorsSentence('Max-profit', '+', maxFactors),
  ].join(' ');
  const capsApplied = {
    bundle: bundleFactors.capped,
    quick: quickFactors.capped,
    max: maxFactors.capped,
  };
  const rejectedFactors = {
    bundle: bundleFactors.rejected,
    quick: quickFactors.rejected,
    max: maxFactors.rejected,
  };

  return {
    quick_sell_price: quickPrice,
    bundle_price: bundlePrice,
    max_profit_price: maxPrice,
    synergy: relationship,
    justification,
    bundle_adjustment_percent: adjustmentPercent,
    quick_sell_reduction_percent: quickReductionPercent,
    max_profit_increase_percent: maxIncreasePercent,
    bundle_factors: bundleFactors.factors,
    quick_sell_factors: quickFactors.factors,
    max_profit_factors: maxFactors.factors,
    factor_caps_applied: Object.values(capsApplied).some(Boolean) ? capsApplied : null,
    rejected_factors: Object.values(rejectedFactors).some(Boolean) ? rejectedFactors : null,
    item_count: itemCount,
  };
}

/**
 * Make the numeric bundle relationship authoritative. Models occasionally
 * return a price below the individual sum while labeling and explaining it as
 * a premium (or vice versa). When that happens, replace both the categorical
 * label and contradictory prose before the result reaches the UI.
 */
export function normalizeBundlePricingResult(result, separateTotal, itemCount = null) {
  if (!result || typeof result !== 'object') return result;
  if (finitePositiveBundlePrice(result.bundle_price) == null) return null;
  const expectedSynergy = bundleSynergyForPrices(result.bundle_price, separateTotal);
  if (!expectedSynergy) return result;
  const labelContradicts = result.synergy !== expectedSynergy;
  // Factor-derived explanations intentionally preserve both premium and
  // discount contributors before stating their net. The legacy prose guard
  // must not mistake an attributable opposing factor for a contradiction.
  const hasStructuredFactorContract = (
    Array.isArray(result.bundle_factors)
    && Array.isArray(result.quick_sell_factors)
    && Array.isArray(result.max_profit_factors)
  );
  const explanationContradicts = !hasStructuredFactorContract
    && bundleJustificationContradicts(result.justification, expectedSynergy);
  if (!labelContradicts && !explanationContradicts) return result;
  return {
    ...result,
    synergy: expectedSynergy,
    justification: correctedBundleJustification(result, Number(separateTotal), expectedSynergy, itemCount),
  };
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
  const validAi = finitePositiveBundlePrice(bundlePricing?.bundle_price);
  const validTotal = finitePositiveBundlePrice(bundleTotal);
  const headline = validAi ?? validTotal;
  const showSumRef = validAi != null && validTotal != null && validAi !== validTotal;
  return {
    headline,
    aiPrice: validAi,
    showSumRef,
    synergy: validAi != null ? bundlePricing?.synergy || null : null,
  };
}

function sumItemTier(itemPricings, field) {
  const pricedItems = (Array.isArray(itemPricings) ? itemPricings : [])
    .filter(it => finitePositiveBundlePrice(it?.pricing?.recommended_price) != null);
  if (pricedItems.length === 0) return null;

  let total = 0;
  for (const item of pricedItems) {
    const value = finitePositiveBundlePrice(item?.pricing?.[field]);
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
    const best = finitePositiveBundlePrice(pricing?.recommended_price);
    const quick = finitePositiveBundlePrice(pricing?.quick_sell_price);
    const max = finitePositiveBundlePrice(pricing?.max_profit_price);
    return {
      quick: quick != null && best != null ? Math.min(quick, best) : quick,
      best,
      max: max != null && best != null ? Math.max(max, best) : max,
      isBundle: false,
    };
  }

  const bundleHeadline = selectBundleHeadline(bundlePricing, bundleTotal);
  const best = finitePositiveBundlePrice(bundleHeadline.headline);
  const separateBest = finitePositiveBundlePrice(bundleTotal);
  const adjustment = best != null && separateBest != null && separateBest > 0
    ? best / separateBest
    : 1;
  const fallbackQuick = sumItemTier(itemPricings, 'quick_sell_price');
  const fallbackMax = sumItemTier(itemPricings, 'max_profit_price');
  const explicitQuick = bundleHeadline.aiPrice != null
    ? finitePositiveBundlePrice(bundlePricing?.quick_sell_price)
    : null;
  const explicitMax = bundleHeadline.aiPrice != null
    ? finitePositiveBundlePrice(bundlePricing?.max_profit_price)
    : null;
  const quick = explicitQuick ?? (fallbackQuick != null ? Math.round(fallbackQuick * adjustment) : null);
  const max = explicitMax ?? (fallbackMax != null ? Math.round(fallbackMax * adjustment) : null);

  return {
    quick: quick != null && best != null ? Math.min(quick, best) : quick,
    best,
    max: max != null && best != null ? Math.max(max, best) : max,
    isBundle: true,
  };
}
