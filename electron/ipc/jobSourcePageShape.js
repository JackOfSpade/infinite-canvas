/**
 * Whether a job site's response has the structure its reader needs. A response with that structure and no results is
 * an honest zero and is never counted here. Each check answers a yes/no question about the response itself, so a
 * site's block, rate limit or login wall (which arrives with its own warning) is left to that warning.
 *
 * Sizes and markers that come from measured pages say so; the rest are provisional because no real sample is saved.
 */

/** A WWR feed is an <rss> document; an <rss> with no <item> is a real empty feed. */
export const wwrFeedShapeMissing = text => !/<rss[\s>]/iu.test(String(text ?? ''));

/** USAJobs answers every real search, even one with no matches, inside a SearchResult envelope. */
export const usaJobsEnvelopeMissing = json => !(json && typeof json === 'object' && json.SearchResult && typeof json.SearchResult === 'object');

/** Dice puts rows in `data`, and an empty search carries an empty array. */
export const diceDataArrayMissing = json => !Array.isArray(json?.data);

/** Provisional: no real LinkedIn guest response is saved. A real page of cards is tens of KB, an end-of-results reply is empty. */
export const LINKEDIN_SHAPE_MIN_BODY_CHARS = 500;
const LINKEDIN_KNOWN_EMPTY = /jobs-search-no-results|no matching jobs/iu;

/** Page one of a query returned a real-sized body, yet no card could be read from it. Later pages are the honest end of results. */
export function linkedInGuestPageUnreadable({ start, html, cardsOnPage }) {
  const body = String(html ?? '').trim();
  return start === 0 && cardsOnPage === 0 && body.length >= LINKEDIN_SHAPE_MIN_BODY_CHARS && !LINKEDIN_KNOWN_EMPTY.test(body);
}

/** Measured 2026-11-05 from saved page-size calibration: Indeed result pages are ~1,630-1,700KB, and the existing soft-block rule covers anything under this. */
export const INDEED_FULL_PAGE_MIN_CHARS = 150_000;
/** Provisional: Indeed's own words for a search with no matches; no real no-results page is saved. */
const INDEED_KNOWN_NO_RESULTS = /did not match any jobs|jobsearch-NoResult/iu;

/** A full-size first page with no job read from it. A page past the last result is the honest end of a walk, so only page one counts. */
export function indeedPageUnreadable({ pageIndex, htmlLength, parsedCount, html }) {
  return pageIndex === 0 && parsedCount === 0 && htmlLength >= INDEED_FULL_PAGE_MIN_CHARS && !INDEED_KNOWN_NO_RESULTS.test(String(html ?? ''));
}

/**
 * Whether a run's first pages show a reader that broke rather than one odd page. Every first page that answered counts
 * in `firstPages`, the honest empty ones included, so a single odd page among several queries stays quiet.
 */
export const mostFirstPagesUnreadable = ({ firstPages, unreadable }) => unreadable > 0 && firstPages > 0 && unreadable / firstPages > 0.5;

/**
 * What the Dice key harvest should tell the alarm store, or null to leave it alone. A key found clears the alarm. A miss
 * only counts after at least one script was downloaded and read, because a page that never loaded is a network or block
 * problem that already logs its own reason.
 */
export function diceKeyHarvestReport({ keyFound, scriptsRead }) {
  if (keyFound) return { failure: null };
  if (!(scriptsRead >= 1)) return null;
  return { failure: { what: 'Dice page scripts were read but no search key was found in them or by the browser fallback', attempts: scriptsRead, bad: scriptsRead } };
}
