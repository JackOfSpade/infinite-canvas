/**
 * Merge one source's freshly-resolved comp items into a `{ sold, active }` comps
 * object, REPLACING any prior items carrying the same `source` tag (so a retry —
 * or a retry-of-a-retry — replaces that source's items cleanly instead of
 * accumulating duplicates). The other category is carried through untouched.
 *
 * Pure. Used by every SellHub path that folds a resolved/retried source back
 * into pendingComps (early-resolve drain + captcha-resolved success).
 *
 * @param {{sold?: object[], active?: object[]}|null} prev
 * @param {{ sourceId: string, category?: 'sold'|'active', items?: object[] }} update
 * @returns {{sold: object[], active: object[]}}
 */
export function mergeSourceIntoComps(prev, { sourceId, category = 'sold', items = [] }) {
  const other = category === 'sold' ? 'active' : 'sold';
  return {
    [category]: [...((prev?.[category] || []).filter(i => i?.source !== sourceId)), ...(items || [])],
    [other]: prev?.[other] || [],
  };
}
