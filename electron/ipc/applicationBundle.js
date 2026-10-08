/**
 * Application-artifact naming and the original-listing Markdown companion.
 *
 * A generated résumé is deliberately HTML-first (design §5); this module owns
 * the two pieces shared by the saved workspace regardless of how it is laid
 * out on disk: a portable, Windows-safe folder/file name derived from the
 * company, and a pretty, source-faithful Markdown rendering of the scraped
 * job listing.
 */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export function sanitizeApplicationBundlePart(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[\s\S]/g, char => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ? ' ' : char)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim();
  const capped = [...cleaned].slice(0, 100).join('').replace(/[. ]+$/g, '').trim();
  if (!capped || capped === '.' || capped === '..') return fallback;
  const stem = capped.split('.')[0].toUpperCase();
  return WINDOWS_RESERVED_NAMES.has(stem) ? fallback : capped;
}

function markdownSingleLine(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function markdownInlineText(value) {
  return markdownSingleLine(value).replace(/[\\`*_{}<>()#+.!|-]/g, '\\$&').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function safeHttpUrl(value) {
  const raw = markdownSingleLine(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    // Job URLs can originate in scraped markup. Never persist a URL containing
    // credentials into the portable listing companion: it is both unnecessary
    // for a public posting and can leak a source/session secret if the scraper
    // was handed an authenticated redirect URL.
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.hostname && !parsed.username && !parsed.password
      ? parsed.href
      : '';
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Posting variants
// ---------------------------------------------------------------------------
//
// When a Board consolidation collapses several mirrors of the same posting
// into one card, the Board package hands us `job.postingVariants`: an array of
// per-mirror targets (location/url/googleCardUrl/source/posted/salary/
// applySource). The application pipeline treats those as *application targets*
// for the one shared description — never as separate generations. Everything
// that freezes, renders, or serialises a variant goes through this one
// normalizer so bounds and security rules cannot drift between the Markdown
// companion, the inert workspace bundle JSON, and the rendered link list.
//
// The contract, in order:
//   1. Only an actual array is accepted, and only plain data objects (never
//      Arrays, class instances, null, primitives) become variants.
//   2. Every string field is stripped of ASCII control characters, collapsed,
//      and capped, so an untrusted value can never smuggle formatting.
//   3. URLs are canonicalised absolute http/https values with a real host and
//      no embedded credentials; anything else is dropped rather than stored
//      raw. A variant with no safe URL at all has no application target and is
//      rejected.
//   4. The count is bounded and duplicates (by URL plus location) are removed
//      deterministically in source order.
export const MAX_POSTING_VARIANTS = 25;
export const MAX_POSTING_VARIANT_URL_LENGTH = 2048;
export const MAX_POSTING_VARIANT_FIELD_LENGTH = 200;
export const MAX_POSTING_VARIANT_LOCATION_LENGTH = 160;

const CONTROL_CHAR_RE = new RegExp(String.raw`[\u0000-\u001F\u007F-\u009F]`);
const CONTROL_CHAR_GLOBAL_RE = new RegExp(String.raw`[\u0000-\u001F\u007F-\u009F]`, 'g');

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Strip control characters + collapse whitespace, then cap on code points. */
function safeVariantText(value, maxLength) {
  if (value == null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const raw = String(value).replace(CONTROL_CHAR_GLOBAL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (raw.length > maxLength * 4) return [...raw].slice(0, maxLength).join('').trim();
  return [...raw].slice(0, maxLength).join('').trim();
}

/**
 * Shared, bounded, security-safe normalization for one listing URL.
 *
 * Mirrors the workspace renderer's `safeJobPostingUrl` policy (absolute
 * http/https, real host, no credentials/control characters) and additionally
 * rejects when the canonical href exceeds the length cap. Returns '' for
 * anything unusable so callers can drop the value without ever echoing input.
 */
export function normalizeJobListingExternalUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > MAX_POSTING_VARIANT_URL_LENGTH * 2) return '';
  if (CONTROL_CHAR_RE.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    if (!parsed.hostname || parsed.username || parsed.password) return '';
    const href = parsed.href;
    return href.length > MAX_POSTING_VARIANT_URL_LENGTH ? '' : href;
  } catch { return ''; }
}

/**
 * Normalize `job.postingVariants` into a bounded, deduplicated array of safe
 * posting targets. Preserves legacy callers by returning `[]` for anything
 * that is not an array; a single-posting job simply never produces variants.
 */
export function normaliseJobPostingVariants(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const url = normalizeJobListingExternalUrl(entry.url);
    const googleCardUrl = normalizeJobListingExternalUrl(entry.googleCardUrl);
    if (!url && !googleCardUrl) continue;
    const location = safeVariantText(entry.location, MAX_POSTING_VARIANT_LOCATION_LENGTH);
    const key = `${(url || googleCardUrl).toLowerCase()}\u0000${location.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      location,
      url,
      googleCardUrl,
      source: safeVariantText(entry.source, MAX_POSTING_VARIANT_FIELD_LENGTH),
      posted: safeVariantText(entry.posted, MAX_POSTING_VARIANT_FIELD_LENGTH),
      salary: safeVariantText(entry.salary, MAX_POSTING_VARIANT_FIELD_LENGTH),
      applySource: safeVariantText(entry.applySource, MAX_POSTING_VARIANT_FIELD_LENGTH),
    });
    if (out.length >= MAX_POSTING_VARIANTS) break;
  }
  return out;
}

function textFence(value) {
  const source = String(value || '');
  const longest = Math.max(2, ...(source.match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${source}\n${fence}`;
}

// The heading the posting body sits under, and the note that takes its place
// when the source returned no body at all. The paste contract has to tell the
// responder which of those two it is looking at — a quote is validated as a
// raw substring of this companion, so "the posting text" is a lie when the
// only quotable strings are these scaffolding lines. Exported so that contract
// interpolates them instead of hand-copying text that can drift.
export const ORIGINAL_JOB_LISTING_BODY_HEADING = '## Original scraped listing';
export const EMPTY_JOB_LISTING_BODY_NOTE = '_No listing text was returned by the source._';
export const ORIGINAL_JOB_LISTING_TARGETS_HEADING = '## Posting locations';

/** One safe, escaped `- Location: <url>` line per retained posting target. */
function postingTargetLines(variants) {
  return variants.map(variant => {
    const label = markdownInlineText(variant.location) || 'Unspecified location';
    const url = normalizeJobListingExternalUrl(variant.url) || normalizeJobListingExternalUrl(variant.googleCardUrl);
    return `- **${label}:** <${url}>`;
  });
}

/** Pretty-print exactly the source-side information supplied for a job card. */
export function formatOriginalJobListingMarkdown(job = {}) {
  const title = markdownInlineText(job.title) || 'Untitled role';
  const company = markdownInlineText(job.company) || 'Unknown company';
  const description = String(job.description || '');
  const snippet = String(job.snippet || '');
  const lines = [
    `# ${title}`,
    '',
    `**Company:** ${company}`,
  ];
  const metadata = [
    ['Location', job.location],
    ['Compensation', job.salary],
    ['Posted', job.posted],
    ['Source', job.source],
    ['Language', job.language],
  ];
  for (const [label, value] of metadata) {
    const text = markdownInlineText(value);
    if (!text) continue;
    lines.push(`**${label}:** ${text}`);
  }
  const url = safeHttpUrl(job.url);
  const variants = normaliseJobPostingVariants(job.postingVariants);
  if (url) lines.push(`**Listing URL:** <${url}>`);
  // The shared description is emitted EXACTLY ONCE below; posting locations
  // and their safe listing URLs are appended after it so a consolidated card
  // never repeats the scraped body per mirror. Every variant field is escaped
  // through markdownInlineText or the URL normalizer, so no untrusted value
  // can become raw Markdown/HTML.
  lines.push('', '---', '', ORIGINAL_JOB_LISTING_BODY_HEADING, '');
  if (description) lines.push(textFence(description));
  else if (snippet) lines.push(textFence(snippet));
  else lines.push(EMPTY_JOB_LISTING_BODY_NOTE);
  if (variants.length) {
    lines.push('', ORIGINAL_JOB_LISTING_TARGETS_HEADING, '', ...postingTargetLines(variants));
  }
  lines.push('');
  return lines.join('\n');
}
