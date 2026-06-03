/**
 * Derive the Sidebar Dashboard-tab aggregate stats from the canvas nodes.
 * Computed once per nodes change by the owner (Canvas) and passed to <Sidebar>
 * as primitives, so a plain shallow React.memo can skip the Sidebar re-render
 * during drags (no per-frame full-array rescans in a custom comparator).
 */
export function getStats(nodes) {
  let jobCardsCount = 0, sellHubsCount = 0, totalValue = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === 'jobcard') {
      jobCardsCount++;
    } else if (n.type === 'sellhub') {
      sellHubsCount++;
      if (n.data?.hubState === 'priced') {
        // A SellHub stores its price at data.pricing.recommended_price (set in
        // SellHubNode on synthesis); `userPrice` is a ListingNode field a sellhub
        // never has — reading it made this stat permanently $0. recommended_price
        // is null for the "no comps found" case, which correctly contributes 0.
        totalValue += parseFloat(n.data?.pricing?.recommended_price) || 0;
      }
    }
  }
  return { jobCardsCount, sellHubsCount, totalValue };
}
