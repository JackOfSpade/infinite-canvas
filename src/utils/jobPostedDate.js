/**
 * Display formatting for a job's `posted` value.
 *
 * Sources store `posted` in whatever shape they publish it, and the card renders
 * that value directly. Two families arrive:
 *   • RELATIVE / already human ("3 days ago", "Posted today", "30d+") — these
 *     are what the browser sources scrape, and they read perfectly as-is.
 *   • ABSOLUTE ISO 8601 timestamps — what the API sources return (Dice's
 *     postedDate, USAJobs' PublicationStartDate, and now WeWorkRemotely, which
 *     had to move to ISO because a locale-formatted date is unparseable outside
 *     en-US and silently disabled the age filter for that source).
 *
 * The ISO family rendered raw, so a card could read
 * "2026-08-27T17:11:55.000Z" where its neighbour read "3 days ago".
 *
 * This ONLY reformats a value that is unambiguously a full ISO timestamp, and
 * returns everything else byte-identical. That restraint is the point: a
 * date-ish heuristic applied to the relative family would turn good strings into
 * worse ones, and `posted` is also read by parsePostedDate for the age filter,
 * so the stored value must never be rewritten — only its presentation.
 */

/** Full ISO 8601 with a time part; the only shape this module rewrites. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * @param {string} posted Raw stored value.
 * @param {Date} [now] Injectable for tests.
 * @returns {string} A short human date for ISO input; the input unchanged otherwise.
 */
export function formatPostedForDisplay(posted, now = new Date()) {
  const raw = typeof posted === 'string' ? posted.trim() : '';
  if (!raw || !ISO_TIMESTAMP.test(raw)) return typeof posted === 'string' ? posted : '';

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return posted;

  const dayMs = 86400000;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / dayMs);

  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  // Beyond a week an absolute date is more useful than a widening "N days ago".
  // The year is included only when it is not the current one.
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}
