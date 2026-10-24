import { googleJobsDocumentId, isGoogleJobsInternalUrl } from './jobListingUrl.js';

// Match postings, never just title/company: a later requisition can reuse both.
export function applicationListingKeys(job = {}) {
  const keys = [];
  for (const row of [job, ...(Array.isArray(job.postingVariants) ? job.postingVariants : [])]) {
    for (const raw of [row?.url, row?.googleCardUrl]) {
      try {
        const url = new URL(raw);
        if (!['https:', 'http:'].includes(url.protocol)) continue;
        // Google stores posting ids in either the query or fragment. Search
        // text and display-route variations must not identify the posting.
        if (isGoogleJobsInternalUrl(raw)) {
          const documentId = googleJobsDocumentId(raw);
          if (documentId) keys.push(`google-job:${documentId}`);
          continue;
        }
        url.protocol = 'https:';
        url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
        // Other job sites may use fragment routes too; preserve them.
        for (const key of [...url.searchParams.keys()]) {
          if (/^(utm_.+|trk|trackingId|refId)$/i.test(key)) url.searchParams.delete(key);
        }
        url.searchParams.sort();
        url.pathname = url.pathname.replace(/\/+$/, '') || '/';
        keys.push(url.href);
      } catch { /* missing or invalid public listing */ }
    }
  }
  return [...new Set(keys)].sort();
}

export function selectSavedApplicationBundle(job, bundles) {
  const keys = new Set(applicationListingKeys(job));
  const matches = bundles.filter(bundle => bundle.listingKeys.some(key => keys.has(key)));
  // Regeneration may leave several receipts for the SAME destination. Distinct
  // matching folders are ambiguous and require the user to keep their choice.
  if (new Set(matches.map(bundle => bundle.localApplication.savedDir)).size !== 1) return null;
  return matches.sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')))[0]?.localApplication || null;
}
