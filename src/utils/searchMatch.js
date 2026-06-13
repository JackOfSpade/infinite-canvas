/**
 * Node-content matching for the canvas search bar — one place that knows which
 * data fields make each node type findable. Extracted from SearchBar.jsx so
 * the matrix is unit-testable (the test runner can't import .jsx).
 *
 * `q` must already be lowercased by the caller; matching is substring,
 * case-insensitive. Used for both top-level and deep (nested canvas) searches.
 */

/** Case-insensitive substring test that tolerates non-string/absent fields. */
function has(field, q) {
  return typeof field === 'string' && field.toLowerCase().includes(q);
}

export function matchesQuery(node, q) {
  const d = node?.data;
  if (!d) return false;
  switch (node?.type) {
    case 'document':
      return has(d.filename, q);
    case 'group':
      return has(d.title, q);
    case 'text':
      return has(d.text, q);
    case 'link':
      return has(d.label, q) || has(d.url, q);
    case 'jobcard':
      return has(d.title, q) || has(d.company, q);
    case 'listing':
      return has(d.product?.generated_title, q) || has(d.product?.brand, q) || has(d.product?.model, q);
    case 'jobhub':
      return has(d.resumeSummary, q);
    case 'sellhub':
      // The item hub: generated title, brand/model (parity with `listing`),
      // and — for multi-item bundles — every per-item name, so searching a
      // SECONDARY bundle item (e.g. the paddle in kayak+paddle) still lands
      // on the hub that prices it.
      return has(d.product?.generated_title, q)
        || has(d.product?.brand, q)
        || has(d.product?.model, q)
        || (Array.isArray(d.itemPricings)
          && d.itemPricings.some(it => has(it?.label, q) || has(it?.query, q)));
    case 'marketplacecard':
      // Per-platform listing card: the item name it displays (productSnapshot
      // is copied from the hub at spawn), the user's own notes, and the pasted
      // listing URL (mirrors how link nodes match on url).
      return has(d.productSnapshot?.title, q) || has(d.notes, q) || has(d.listingUrl, q);
    default:
      return false;
  }
}
