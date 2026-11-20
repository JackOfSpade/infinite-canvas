/**
 * How much two versions of a person's career files differ, as a share of
 * their text (0 = same text, 1 = nothing in common).
 *
 * Compared by consecutive word pairs: each version becomes a bag of word
 * pairs read straight through the text (case, punctuation and line breaks
 * ignored), and the pairs both versions contain count as shared, weighted by
 * their length. Re-wrapping text is not a change, moving a section changes
 * only the pairs at its edges, and a two-word edit in a long paragraph changes
 * a few pairs, not the paragraph. Pairs rather than single words keep two
 * unrelated résumés from looking alike just because they share common words.
 * The result is 1 - 2 * shared / (characters in A + characters in B).
 *
 * Used to decide whether new career data is different enough (more than half
 * changed) to search platforms again inside their 24-hour cooldown.
 */
export const CAREER_CHANGE_RESCRAPE_THRESHOLD = 0.5;

function wordPairBag(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const counts = new Map();
  let total = 0;
  // A one-word text has no pairs; compare its word on its own.
  const units = words.length < 2 ? words : words.slice(1).map((word, index) => `${words[index]} ${word}`);
  for (const unit of units) {
    counts.set(unit, (counts.get(unit) || 0) + 1);
    total += unit.length;
  }
  return { counts, total };
}

export function careerTextDifference(previousText, currentText) {
  const before = wordPairBag(previousText);
  const after = wordPairBag(currentText);
  const totalChars = before.total + after.total;
  if (totalChars === 0) return 0;
  let shared = 0;
  for (const [pair, count] of before.counts) {
    const other = after.counts.get(pair);
    if (other) shared += Math.min(count, other) * pair.length;
  }
  return Math.min(1, Math.max(0, 1 - (2 * shared) / totalChars));
}

/** True only for a measured difference strictly above the threshold. */
export function careerChangeLiftsCooldown(difference) {
  return Number.isFinite(difference) && difference > CAREER_CHANGE_RESCRAPE_THRESHOLD;
}
