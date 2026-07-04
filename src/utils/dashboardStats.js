import { selectBundleHeadline } from './bundlePricing.js';

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
        // Bundles contribute their combined listing price, not just the primary
        // item's recommendation. Single-item hubs fall back to recommended_price.
        const bundleHeadline = selectBundleHeadline(n.data?.bundlePricing, n.data?.bundleTotal).headline;
        totalValue += parseFloat(bundleHeadline ?? n.data?.pricing?.recommended_price) || 0;
      }
    }
  }
  return { jobCardsCount, sellHubsCount, totalValue };
}

/**
 * Cheap per-render fingerprint of exactly the fields getStats() reads, built
 * from plain property reads (no selectBundleHeadline call, no parseFloat).
 * `nodes`' array reference changes on every drag/pan frame (ReactFlow rebuilds
 * it for any position change), which used to make a plain `useMemo(() =>
 * getStats(nodes), [nodes])` rescan + re-price every sellhub on every frame of
 * ANY drag, anywhere on the canvas. Callers instead memoize on THIS signature
 * — identical during a pure position-only drag, so getStats() only actually
 * re-runs when a jobcard/sellhub is added/removed or a hub's price/state changes.
 */
export function getStatsSignature(nodes) {
  let sig = '';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.type === 'jobcard') {
      sig += 'j;';
    } else if (n.type === 'sellhub') {
      const d = n.data || {};
      sig += `s:${d.hubState || ''}:${d.bundleTotal ?? ''}:${d.bundlePricing?.bundle_price ?? ''}:${d.bundlePricing?.synergy ?? ''}:${d.pricing?.recommended_price ?? ''};`;
    }
  }
  return sig;
}
