/**
 * Privacy-preserving URL canonicalization for Interview Helper.
 *
 * Interview setup and research citations are saved into a shareable canvas
 * and supplied to workers.  A normal web URL's query and fragment are not
 * safe metadata: they commonly carry signed links, identity, tracking, or
 * session state.  Keep only the small public Google Jobs identity needed to
 * reopen a repaired Jobs-card route.
 */
import {
  googleJobsDocumentId,
  isGoogleJobsInternalUrl,
  normalizeJobListingExternalUrl,
} from './jobListingUrl.js';

const MAX_URL_CHARS = 2048;
// Google's opaque Jobs ids are base64-shaped and usually end in '=' padding
// (`...AAAAAA==`, sent as `%3D%3D`). Allow only that trailing padding; '=' is
// never permitted elsewhere, so a second key cannot be smuggled into the id.
const SAFE_GOOGLE_DOCUMENT_ID = /^[A-Za-z0-9._:-]{1,512}={0,2}$/u;
const SAFE_GOOGLE_LOCALE = /^[a-z]{2}(?:-[A-Z]{2})?$/u;

function hasControl(value) {
  return [...String(value || '')].some(character => {
    const code = character.codePointAt(0);
    return code <= 0x1F || (code >= 0x7F && code <= 0x9F) || /\p{Cf}/u.test(character);
  });
}

/**
 * Return an http(s) URL safe to persist, display, or include in an Interview
 * Helper prompt.  It intentionally drops every general query parameter and
 * all fragments.  The Google Jobs exception retains only an opaque,
 * constrained Jobs document id, `udm=8`, and a validated UI locale.
 */
export function normalizeInterviewPublicUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_CHARS || hasControl(value)) return '';
  const candidate = value.trim();
  if (!/^https?:\/\//iu.test(candidate)) return '';
  try {
    const original = new URL(candidate);
    if (!['http:', 'https:'].includes(original.protocol) || !original.hostname || original.username || original.password) return '';
  } catch {
    return '';
  }

  // Do the established Google Jobs repair before stripping metadata.  It is
  // used only in this local calculation; the repaired free-form `q` never
  // crosses this function's boundary.
  const repaired = normalizeJobListingExternalUrl({ url: candidate });
  if (!repaired || repaired.length > MAX_URL_CHARS || hasControl(repaired)) return '';
  try {
    const url = new URL(repaired);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return '';

    const isGoogleJobs = isGoogleJobsInternalUrl(candidate) || isGoogleJobsInternalUrl(repaired);
    const documentId = isGoogleJobs ? googleJobsDocumentId(repaired) : '';
    const language = isGoogleJobs ? url.searchParams.get('hl') || '' : '';
    url.search = '';
    url.hash = '';
    if (isGoogleJobs) {
      url.searchParams.set('udm', '8');
      if (SAFE_GOOGLE_DOCUMENT_ID.test(documentId)) url.searchParams.set('htidocid', documentId);
      if (SAFE_GOOGLE_LOCALE.test(language)) url.searchParams.set('hl', language);
    }
    const publicUrl = url.href;
    return publicUrl.length <= MAX_URL_CHARS && !hasControl(publicUrl) ? publicUrl : '';
  } catch {
    return '';
  }
}
