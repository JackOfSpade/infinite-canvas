// Combining two research answers for the same identities (Claude with its
// built-in web search, and Claude with Tavily) into one answer the host parser
// already understands. Pure and dependency-free: the callers own cost, usage
// and fallback.
//
// Ids are matched by exact marker lines, so an id that prefixes another
// (c1 / c10) never picks up its neighbour's body. This is the logic measured
// in scripts/web-research-ab.mjs, ported here (that script is not an app
// dependency).

/** One reply's body for one id, or null when that reply lacks a non-empty section. */
function sectionBody(text, id, begin, end) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const from = lines.findIndex(line => line.trim() === String(begin(id)).trim());
  if (from < 0) return null;
  const tail = String(end(id)).trim();
  const to = lines.findIndex((line, index) => index > from && line.trim() === tail);
  const body = to < 0 ? '' : lines.slice(from + 1, to).join('\n').trim();
  return body || null;
}

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Combine the replies per section id, in the given id order.
 *
 * `replies` is an ordered array of { label, text } (text may be null). For each
 * id every reply that has a body contributes one SOURCE SET; a single body is
 * copied unchanged, several are labelled in reply order. Ids with no body are
 * dropped, and the result is null when no id has one.
 */
export function mergeResearchSections({ ids = [], replies = [], begin, end } = {}) {
  const list = Array.isArray(replies) ? replies.filter(reply => reply && typeof reply === 'object') : [];
  const sections = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    // Letters count only replies that actually had a body for this id.
    const bodies = [];
    for (const reply of list) {
      const body = sectionBody(reply.text, id, begin, end);
      if (body) bodies.push({ label: reply.label, body });
    }
    if (!bodies.length) continue;
    const body = bodies.length === 1 ? bodies[0].body : bodies
      .map((entry, index) => `SOURCE SET ${LABELS[index] || index + 1} (${entry.label}):\n${entry.body}`)
      .join('\n\n');
    sections.push(`${begin(id)}\n${body}\n${end(id)}`);
  }
  return sections.length ? sections.join('\n') : null;
}
