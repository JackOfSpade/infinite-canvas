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

// Drop search results whose posting is already part of a saved application.
export function filterAppliedListings(jobs, appliedListingKeys) {
  if (!Array.isArray(jobs)) return { kept: [], removed: 0, samples: [] };
  const applied = appliedListingKeys instanceof Set ? appliedListingKeys
    : new Set(Array.isArray(appliedListingKeys) ? appliedListingKeys : []);
  if (!applied.size) return { kept: [...jobs], removed: 0, samples: [] };
  const kept = [];
  const samples = [];
  let removed = 0;
  for (const job of jobs) {
    if (job && applicationListingKeys(job).some(key => applied.has(key))) {
      removed++;
      if (samples.length < 5) samples.push({ title: job.title, company: job.company, url: job.url });
    } else kept.push(job);
  }
  return { kept, removed, samples };
}

function normalizeRolePart(value) {
  return String(value ?? '')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:-]+$/, '')
    .trim();
}

export function applicationRoleKey({ company, title } = {}) {
  const c = normalizeRolePart(company);
  const t = normalizeRolePart(title);
  return c && t ? `${c}|${t}` : '';
}

// A repost of an applied role at a different URL: informational only, never
// the same application. Any listing-key overlap belongs to the exact-link path.
export function selectPriorRoleApplication(job, bundles) {
  if (!job || !Array.isArray(bundles)) return null;
  const keys = new Set(applicationListingKeys(job));
  if (bundles.some(bundle => (bundle.listingKeys || []).some(key => keys.has(key)))) return null;
  const roleKey = applicationRoleKey(job);
  if (!roleKey) return null;
  const matches = bundles.filter(bundle => bundle.role && applicationRoleKey(bundle.role) === roleKey);
  if (!matches.length) return null;
  const bundle = [...matches].sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')))[0];
  const app = bundle.localApplication || {};
  return {
    id: app.id,
    canvasFilePath: app.canvasFilePath,
    savedDir: app.savedDir,
    appliedAt: bundle.importedAt,
    company: bundle.role.company,
    title: bundle.role.title,
    location: bundle.role.location,
    listingUrl: bundle.listingUrl || '',
    ...(app.savedDocuments ? { savedDocuments: app.savedDocuments } : {}),
  };
}

export function selectSavedApplicationBundle(job, bundles) {
  const keys = new Set(applicationListingKeys(job));
  const matches = bundles.filter(bundle => bundle.listingKeys.some(key => keys.has(key)));
  // Regeneration may leave several receipts for the SAME destination. Distinct
  // matching folders are ambiguous and require the user to keep their choice.
  if (new Set(matches.map(bundle => bundle.localApplication.savedDir)).size !== 1) return null;
  return matches.sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')))[0]?.localApplication || null;
}
