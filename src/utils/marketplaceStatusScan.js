/**
 * Marketplace Status Module — canvas scan.
 *
 * Walks a node array (the canvas the status module was dropped into) plus every
 * nested sub-canvas (`group` nodes store their children under
 * `data.canvasData.nodes`, recursively — see serializationUtils.js) and collects
 * the marketplace listing cards (`marketplacecard`) spawned by Price Check
 * Modules. The result tells the status module which platforms the user actually
 * has listings on *in this canvas*, so it only ever checks those.
 *
 * The module only needs to know which platforms are represented and how many
 * cards each has. Listing URLs/titles are deliberately not collected: hub scans
 * are platform-level, and including per-card content in the subscription
 * signature caused unrelated URL/title edits to re-render the whole module.
 *
 * Returns a Map keyed by platformId:
 *   platformId → { platformId, listingCount }
 */
export function collectMarketplaceListings(nodes) {
  const byPlatform = new Map();

  const visit = (list) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!node) continue;
      if (node.type === 'marketplacecard') {
        const platformId = node.data?.platformId;
        if (platformId) {
          let entry = byPlatform.get(platformId);
          if (!entry) {
            entry = { platformId, listingCount: 0 };
            byPlatform.set(platformId, entry);
          }
          entry.listingCount += 1;
        }
      }
      // Recurse into nested canvases (group nodes hold a full canvasData tree).
      const inner = node.data?.canvasData?.nodes;
      if (Array.isArray(inner) && inner.length > 0) visit(inner);
    }
  };

  visit(nodes);
  return byPlatform;
}

/** Stable equality signature for the Marketplace Status store subscription. */
export function marketplaceListingsSignature(map) {
  if (!(map instanceof Map)) return '';
  return [...map.values()]
    .map((entry) => `${entry.platformId}:${entry.listingCount}`)
    .sort()
    .join('|');
}
