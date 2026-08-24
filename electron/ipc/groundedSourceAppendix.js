// Grounded providers return source metadata separately from their prose. Keep
// that provenance available to the next extraction pass without copying raw
// provider payloads (which can contain encrypted search content).

const MAX_SOURCE_TITLE_CHARS = 200;
const MAX_GROUNDED_SOURCES = 40;
export const GROUNDED_SOURCE_METADATA_MARKER = 'Grounded source URLs (provider metadata):';

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    // Source metadata should never turn an embedded credential into text that
    // is persisted with research. Web search results have public URLs, so a
    // credential-bearing URL is not a valid source for this purpose.
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function safeTitle(value, fallback) {
  const withoutControls = [...String(value || '')]
    .map((char) => (char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127 ? ' ' : char))
    .join('');
  const normalized = withoutControls
    .replaceAll(GROUNDED_SOURCE_METADATA_MARKER, 'Grounded source URLs (source title):')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return fallback;
  return normalized.length <= MAX_SOURCE_TITLE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_SOURCE_TITLE_CHARS - 1).trimEnd()}…`;
}

// Raw provider prose is not a trusted envelope. If it happens to include our
// reserved header, make it visibly prose so it cannot masquerade as metadata
// when a later stage parses the stored research string.
function neutralizeMetadataMarker(value) {
  return String(value || '').trim()
    .replaceAll(GROUNDED_SOURCE_METADATA_MARKER, 'Grounded source URLs (model prose):');
}

/**
 * Read only URL-first source rows from the prefix that this module writes.
 * This deliberately ignores arbitrary URLs in model prose and in page titles.
 */
export function groundedMetadataUrls(research) {
  const lines = String(research || '').split(/\r?\n/);
  if (lines[0] !== GROUNDED_SOURCE_METADATA_MARKER) return [];
  const seen = new Set();
  const urls = [];
  for (let i = 1; i < lines.length && lines[i] !== ''; i++) {
    const match = /^-\s+(https?:\/\/\S+)\s+—\s+.*$/.exec(lines[i]);
    const url = safeHttpUrl(match?.[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/**
 * Prefix grounded research with a small, deterministic source appendix.
 *
 * `sources` deliberately accepts only already-selected `{url, title}` values:
 * provider adapters must never pass raw result objects, whose encrypted
 * content is intentionally opaque and must not be persisted or echoed.
 */
export function appendGroundedSourceAppendix(prose, sources) {
  const text = neutralizeMetadataMarker(prose);
  // Source metadata is provenance for an answer, not an answer in its own
  // right. Keep the callers' existing no-prose failure behavior intact.
  if (!text) return text;
  const seen = new Set();
  const rows = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (rows.length >= MAX_GROUNDED_SOURCES) break;
    const url = safeHttpUrl(source?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    rows.push({ url, title: safeTitle(source?.title, `Source ${rows.length + 1}`) });
  }
  if (!rows.length) return text;
  // Downstream structured extraction deliberately retains only the first
  // portion of raw research. Keep provenance ahead of potentially long model
  // prose so it is never sliced away before source validation.
  return `${GROUNDED_SOURCE_METADATA_MARKER}\n${rows.map(({ title, url }) => `- ${url} — ${title}`).join('\n')}\n\n${text}`;
}
