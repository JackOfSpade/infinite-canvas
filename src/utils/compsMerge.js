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

/**
 * Decide whether a warning returned by an explicit source retry still requires
 * user action. Once a source is blocked, ANY retry warning keeps it blocked,
 * even if partial items were recovered. Only a clean, non-empty retry clears the
 * source; otherwise the user can retry indefinitely or explicitly click Skip.
 *
 * A zero-item retry is never treated as success, even if the source forgot to
 * return a warning. Otherwise the retry would silently clear the source gate,
 * which is equivalent to skipping it without the user clicking Skip.
 *
 * EXCEPTION — `opts.noChallengeConfirmed`: a Solve/resolve attempt that reached a
 * definitive conclusion in the visible window WITHOUT ever seeing a challenge
 * widget (diag.sawChallenge === false) has PROVEN there is no wall to clear.
 * Re-offering Solve in that case is an unclearable loop — the user keeps clicking
 * Solve on a page that just genuinely has few/no listings (the eBay "1 result"
 * bundle case). So the result is authoritative regardless of count: clear the
 * gate. (This only flips the empty/low-yield verdict; a real challenge the user
 * actually solved sets sawChallenge=true and is unaffected.)
 */
export function retryWarningRequiringAction(warning, items, opts = {}) {
  const itemCount = Array.isArray(items) ? items.length : 0;
  if (opts.noChallengeConfirmed) return null;
  if (itemCount === 0) {
    return warning || {
      code: 'retry-empty',
      severity: 'block',
      evidence: 'Retry returned no usable listings for this source.',
      suggestion: 'This source remains blocked. Retry again, or explicitly click Skip to continue without it.',
    };
  }
  if (!warning) return null;
  return warning;
}

/**
 * Replace one source's gate warning after a retry. A clean retry removes the
 * warning; a retry warning that still requires action replaces it so bundle
 * pricing stays paused until every item query has usable data or the user skips.
 */
export function updateResolvedSourceWarning(warnings, sourceId, retryWarning) {
  const remaining = (Array.isArray(warnings) ? warnings : []).filter(w => w?.sourceId !== sourceId);
  return retryWarning ? [...remaining, { ...retryWarning, sourceId }] : remaining;
}
