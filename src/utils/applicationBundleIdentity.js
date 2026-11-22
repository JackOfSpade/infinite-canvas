import { googleJobsDocumentId, isGoogleJobsInternalUrl } from './jobListingUrl.js';

const TRACKING_PARAM_RE = /^(utm_.+|trk|trackingId|refId)$/i;
// Kept in step with OFFICIAL_LEVELS in electron/ipc/officialPostingFields.js.
const OFFICIAL_POSTING_LEVELS = ['L1', 'L2', 'L3', 'L4'];

// The employer's own posting page names one job whichever board listed it.
// Two spellings are returned: the page address as given, and the same address
// without parameters that only repeat its last path segment or record where the
// visitor came from (Greenhouse serves /jobs/123 and /jobs/123?gh_jid=123).
export function officialPostingUrlKeys(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return [];
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM_RE.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    const full = url.href;
    const lastSegment = decodeURIComponent(url.pathname.split('/').pop() || '');
    for (const [key, value] of [...url.searchParams.entries()]) {
      if (key === 'gh_src' || (lastSegment && value === lastSegment)) url.searchParams.delete(key);
    }
    return [...new Set([full, url.href])];
  } catch { return []; }
}

// Only a verified employer-source posting counts; a lead or a miss names nothing.
function verifiedOfficialPostingKeys(posting) {
  if (!posting || typeof posting !== 'object' || Array.isArray(posting)) return [];
  if (!OFFICIAL_POSTING_LEVELS.includes(posting.level) || !['found', 'link-only'].includes(posting.outcome)) return [];
  return officialPostingUrlKeys(posting.sourceUrl || posting.officialApplyUrl);
}

// Match postings, never just title/company: a later requisition can reuse both.
export function applicationListingKeys(job = {}) {
  const keys = [...verifiedOfficialPostingKeys(job.officialPosting)];
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
          if (TRACKING_PARAM_RE.test(key)) url.searchParams.delete(key);
        }
        url.searchParams.sort();
        url.pathname = url.pathname.replace(/\/+$/, '') || '/';
        keys.push(url.href);
      } catch { /* missing or invalid public listing */ }
    }
  }
  return [...new Set(keys)].sort();
}

// When a row passed the applied-listing check below (an ISO time). A Board card
// whose stamp is later than a matching bundle's save would have been dropped by
// that check had it known the link (found later, e.g. its verified official
// posting), so it is removed instead of shown with the X. Rows without a stamp
// (every row checked before the stamp existed, or never checked) keep the X.
export const APPLIED_CHECK_FIELD = 'appliedCheckAt';

/** The row's applied-listing check time in epoch ms, or null. */
export function appliedCheckTime(job) {
  const value = job?.[APPLIED_CHECK_FIELD];
  if (typeof value !== 'string' || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * The stamp a row standing for all of `rows` (merged duplicates, location
 * variants, a re-found carried listing) may carry: the EARLIEST check, so it is
 * removable only when every merged posting was checked after the save. Any row
 * without a stamp leaves the merged row without one (null).
 */
export function earliestAppliedCheckAt(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let earliest = null;
  for (const row of list) {
    const at = appliedCheckTime(row);
    if (at == null) return null;
    if (earliest == null || at < earliest.at) earliest = { at, value: row[APPLIED_CHECK_FIELD] };
  }
  return earliest ? earliest.value : null;
}

/** `row` carrying the merged stamp of `rows`; the same object when unchanged. */
export function withMergedAppliedCheck(row, rows) {
  if (!row || typeof row !== 'object') return row;
  const merged = earliestAppliedCheckAt(rows);
  if (merged === null) {
    if (!Object.hasOwn(row, APPLIED_CHECK_FIELD)) return row;
    const { [APPLIED_CHECK_FIELD]: _dropped, ...rest } = row;
    return rest;
  }
  return row[APPLIED_CHECK_FIELD] === merged ? row : { ...row, [APPLIED_CHECK_FIELD]: merged };
}

/** In-place form of withMergedAppliedCheck, for callers that track rows by identity. */
export function foldAppliedCheckInto(row, rows) {
  if (!row || typeof row !== 'object') return row;
  const merged = earliestAppliedCheckAt(rows);
  if (merged === null) delete row[APPLIED_CHECK_FIELD];
  else row[APPLIED_CHECK_FIELD] = merged;
  return row;
}

// Drop search results whose posting is already part of a saved application.
// Every kept row is stamped with the time of this check (one time per call). A
// row that already carries an earlier valid stamp keeps it: the first check is
// the one a card shown from it was judged by. Kept rows are stamped in place so
// callers' row identity (maps, checkpoints) is unchanged.
export function filterAppliedListings(jobs, appliedListingKeys, { checkedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(jobs)) return { kept: [], removed: 0, samples: [] };
  const applied = appliedListingKeys instanceof Set ? appliedListingKeys
    : new Set(Array.isArray(appliedListingKeys) ? appliedListingKeys : []);
  const checkedAtMs = Date.parse(checkedAt);
  const stamp = (job) => {
    if (!job || typeof job !== 'object' || !Number.isFinite(checkedAtMs)) return;
    const prior = appliedCheckTime(job);
    if (prior == null || prior > checkedAtMs) job[APPLIED_CHECK_FIELD] = new Date(checkedAtMs).toISOString();
  };
  const kept = [];
  const samples = [];
  let removed = 0;
  for (const job of jobs) {
    if (applied.size && job && applicationListingKeys(job).some(key => applied.has(key))) {
      removed++;
      if (samples.length < 5) samples.push({ title: job.title, company: job.company, url: job.url });
    } else {
      stamp(job);
      kept.push(job);
    }
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
