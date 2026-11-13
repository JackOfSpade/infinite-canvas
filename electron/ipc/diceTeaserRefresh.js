// Dice's list API only returns a short teaser for each listing (~500 chars of
// company boilerplate).  A scoring pass that runs without a fresh search (for
// example the Job Board's "resume scoring" of saved jobs) never passes through
// the search pipeline's enrichDiceDescriptions step, so the scorer and its
// evidence validator have no requirement text to cite.  This module refreshes
// only those teaser rows before scoring, without dropping or reordering any
// row: closed listings that the enricher omits keep their original row.
export const DICE_TEASER_MAX_CHARS = 600;

const textLength = value => String(value || '').length;

export function isDiceTeaserRow(job) {
  if (!job || typeof job !== 'object' || job.source !== 'dice') return false;
  if (!String(job.url || '').trim()) return false;
  return Math.max(textLength(job.description), textLength(job.snippet)) <= DICE_TEASER_MAX_CHARS;
}

const rowTextLength = row => Math.max(textLength(row?.description), textLength(row?.snippet));

export async function refreshDiceTeaserRows(jobs, { enrich, signal } = {}) {
  const input = Array.isArray(jobs) ? jobs : [];
  const untouched = { jobs: [...input], attempted: 0, lengthened: 0 };
  if (signal?.aborted || typeof enrich !== 'function') return untouched;
  const teaserRows = input.filter(isDiceTeaserRow);
  if (teaserRows.length === 0) return untouched;

  let enrichedRows;
  try {
    enrichedRows = await enrich(teaserRows, signal);
  } catch {
    return { jobs: [...input], attempted: teaserRows.length, lengthened: 0 };
  }
  if (!Array.isArray(enrichedRows)) {
    return { jobs: [...input], attempted: teaserRows.length, lengthened: 0 };
  }

  const byUrl = new Map();
  for (const row of enrichedRows) {
    if (!row || typeof row !== 'object') continue;
    const key = String(row.url || '').trim();
    if (key) byUrl.set(key, row);
  }

  let lengthened = 0;
  const refreshed = input.map(job => {
    if (!isDiceTeaserRow(job)) return job;
    const enriched = byUrl.get(String(job.url || '').trim());
    if (!enriched) return job;
    const enrichedDescription = String(enriched.description || '');
    const enrichedSnippet = String(enriched.snippet || '');
    // When only one of the two enriched fields is present, use it for both so
    // the replacement never loses the freshly fetched requirement text.
    const description = enrichedDescription || enrichedSnippet;
    const snippet = enrichedSnippet || enrichedDescription;
    if (Math.max(description.length, snippet.length) <= rowTextLength(job)) return job;
    lengthened += 1;
    return { ...job, description, snippet };
  });
  return { jobs: refreshed, attempted: teaserRows.length, lengthened };
}
