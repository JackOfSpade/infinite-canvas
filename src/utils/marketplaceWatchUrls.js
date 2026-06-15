/**
 * Normalize the user-configured hub pages for one marketplace.
 *
 * Settings accepts one URL per line, so whitespace and accidental duplicate
 * lines are common. Normalize at every boundary that consumes the list so a
 * duplicate never causes a second authenticated fetch or AI input section.
 */
export function normalizeMarketplaceWatchUrls(urls) {
  if (!Array.isArray(urls)) return [];

  const seen = new Set();
  const normalized = [];
  for (const raw of urls) {
    if (typeof raw !== 'string') continue;
    const url = raw.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
  }
  return normalized;
}
