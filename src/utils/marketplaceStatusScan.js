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
 * Returns a Map keyed by platformId:
 *   platformId → { platformId, listingCount, listingUrls: string[], titles: string[] }
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
            entry = { platformId, listingCount: 0, listingUrls: [], titles: [] };
            byPlatform.set(platformId, entry);
          }
          entry.listingCount += 1;
          const url = String(node.data?.listingUrl || '').trim();
          if (url) entry.listingUrls.push(url);
          const title = node.data?.productSnapshot?.title;
          if (title) entry.titles.push(title);
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
