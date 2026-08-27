import { normalizeExternalHttpUrl } from './urlSafety.js';

// Google search routes use a small set of country-code and second-level
// country-code domains (google.com, google.ca, google.co.uk, google.com.br,
// and so on). Matching only those suffix shapes prevents lookalikes such as
// `google.com.evil` from being treated as a trusted Google Jobs route.
const GOOGLE_PUBLIC_SUFFIX = /^(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/;
const SAFE_ROUTE_SEGMENTS = new Set([
  'apply', 'career', 'careers', 'detail', 'details', 'job', 'jobs', 'search', 'view',
]);

function isGoogleHost(hostname) {
  const labels = String(hostname || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const googleIndex = labels.lastIndexOf('google');
  return googleIndex >= 0 && GOOGLE_PUBLIC_SUFFIX.test(labels.slice(googleIndex + 1).join('.'));
}

function fragmentParams(url) {
  const raw = String(url?.hash || '').replace(/^#/, '');
  return new URLSearchParams(raw);
}

function compactSearchQuery(job) {
  const parts = [job?.title, job?.company, job?.location]
    .map(value => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const joined = parts.join(' ');
  return /\bjobs?\b/i.test(joined) ? joined : `${joined || 'jobs'} jobs`;
}

/** True when a URL is Google's internal Jobs-card identity/share route. */
export function isGoogleJobsInternalUrl(value) {
  const safe = normalizeExternalHttpUrl(value);
  if (!safe) return false;
  try {
    const url = new URL(safe);
    if (!isGoogleHost(url.hostname)) return false;
    const fragment = fragmentParams(url);
    return !!(
      url.searchParams.get('htidocid')
      || fragment.get('htidocid')
      || /(?:^|\/)docid=/i.test(decodeURIComponent(url.hash || ''))
      || url.searchParams.get('ibp') === 'htl;jobs'
      || url.searchParams.get('udm') === '8'
      || fragment.get('htivrt') === 'jobs'
      || fragment.get('vssid') === 'jobs-detail-viewer'
    );
  } catch {
    return false;
  }
}

function googleDocumentId(url) {
  const fragment = fragmentParams(url);
  const direct = url.searchParams.get('htidocid') || fragment.get('htidocid');
  if (direct) return direct;
  try {
    const decoded = decodeURIComponent(url.hash || '');
    const match = decoded.match(/(?:^|\/)docid=([^&/]+)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

/** Return Google's opaque Jobs-card id when `value` is a genuine Google URL. */
export function googleJobsDocumentId(value) {
  const safe = normalizeExternalHttpUrl(value);
  if (!safe) return '';
  try {
    const url = new URL(safe);
    return isGoogleHost(url.hostname) ? googleDocumentId(url) : '';
  } catch {
    return '';
  }
}

/**
 * Return the user-facing destination for a saved job.
 *
 * New Google rows carry a direct employer/apply URL in `url` and keep the
 * internal result-card identity in `googleCardUrl`. Legacy canvases stored that
 * internal share route in `url`; repair those at click time so an old canvas no
 * longer opens Google's broken `webhp?ibp=htl;jobs` redirect.
 */
export function normalizeJobListingExternalUrl(job) {
  const raw = job?.url || job?.googleCardUrl;
  const safe = normalizeExternalHttpUrl(raw);
  if (!safe || !isGoogleJobsInternalUrl(safe)) return safe;

  try {
    const input = new URL(safe);
    const fragment = fragmentParams(input);
    const query = String(
      input.searchParams.get('q')
      || fragment.get('htiq')
      || compactSearchQuery(job),
    ).replace(/\s+/g, ' ').trim();
    const documentId = googleDocumentId(input);
    const output = new URL('https://www.google.com/search');
    output.searchParams.set('q', query);
    output.searchParams.set('udm', '8');
    if (documentId) output.searchParams.set('htidocid', documentId);
    const language = input.searchParams.get('hl');
    if (language && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) output.searchParams.set('hl', language);
    if (documentId) {
      output.hash = `vhid=vt%3D20/docid%3D${encodeURIComponent(documentId)}&vssid=jobs-detail-viewer`;
    }
    return output.href;
  } catch {
    return '';
  }
}

/** Bounded, listing-value-free facts suitable for renderer event logs. */
export function summarizeJobListingUrl(job, normalizedValue = '') {
  const raw = normalizeExternalHttpUrl(job?.url || job?.googleCardUrl);
  const normalized = normalizedValue || normalizeJobListingExternalUrl(job);
  const inspect = (value) => {
    try {
      const url = new URL(value);
      return {
        // A job identifier or tracking token can live in the path too. Keep
        // only a tiny static route vocabulary and replace every other segment.
        route: summarizeRoute(url),
        query: url.searchParams.get('q') ? 'present' : 'empty',
        documentId: googleDocumentId(url) ? 'present' : 'missing',
      };
    } catch {
      return { route: 'invalid', query: 'empty', documentId: 'missing' };
    }
  };
  const before = inspect(raw);
  const after = inspect(normalized);
  return {
    rawRoute: before.route,
    rawQuery: before.query,
    documentId: before.documentId === 'present' || after.documentId === 'present' ? 'present' : 'missing',
    targetRoute: after.route,
    repaired: !!raw && !!normalized && raw !== normalized,
  };
}

function summarizeRoute(url) {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return `${url.hostname}/`;
  const routeSegments = segments.slice(0, 6).map((segment) => {
    const normalized = segment.toLowerCase();
    return SAFE_ROUTE_SEGMENTS.has(normalized) ? normalized : ':segment';
  });
  if (segments.length > routeSegments.length) routeSegments.push(':more');
  return `${url.hostname}/${routeSegments.join('/')}`;
}
