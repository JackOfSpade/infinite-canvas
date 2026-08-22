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
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch { return ''; }
}

function textFence(value) {
  const source = String(value || '');
  const longest = Math.max(2, ...(source.match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${source}\n${fence}`;
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
  if (url) lines.push(`**Listing URL:** <${url}>`);
  lines.push('', '---', '', '## Original scraped listing', '');
  if (description) lines.push(textFence(description));
  else if (snippet) lines.push(textFence(snippet));
  else lines.push('_No listing text was returned by the source._');
  lines.push('');
  return lines.join('\n');
}
