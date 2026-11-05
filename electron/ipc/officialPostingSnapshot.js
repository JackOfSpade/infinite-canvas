import { extractOfficialPostingCandidates, officialDescriptionText, scanOfficialCareersPage } from './officialPostingExtractors.js';
import { eightfoldBoardPosting, eightfoldDescriptionText, eightfoldPostingRoute, eightfoldRetainedPosting } from './officialPostingEightfold.js';
import { officialHttpsUrl } from './officialPostingFields.js';
import { canonicalLeadUrl } from './officialPostingMatch.js';
import { MIN_RENDERED_CHARS } from './officialPostingRenderedPage.js';
import { extractAtsTenant, normalizedSourceHost, registrableDomain } from './officialSourceHosts.js';

// Claude's WebFetch cannot run JavaScript and returns a summary of a page rather than
// its text, so the app downloads each lead once and hands the judges what it
// returned: their main input. This is transport only: no field here decides identity,
// status or ownership. The judges read it as untrusted page content, like the listing.

export const SNAPSHOT_DESCRIPTION_CHARS = 30_000;
export const SNAPSHOT_TOTAL_CHARS = 250_000;
// The whole page as the browser shows it. Only the prompt's size bound can shorten it.
export const SNAPSHOT_PAGE_TEXT_CHARS = 120_000;
const MAX_BOARD_LINKS = 12;
const MAX_MARKUP_URLS = 20_000;
const MAX_MARKUP_URL_CHARS = 300;
// Hosts on an ATS vendor's domain that name the vendor's own service, not a company.
const SHARED_ATS_LABELS = new Set(['www', 'www2', 'app', 'api', 'cdn', 'static', 'assets', 'jobs', 'job', 'boards', 'job-boards', 'apply', 'careers',
  'ats', 'hire', 'secure', 'my', 'login', 'auth', 'developers', 'support', 'help', 'docs', 'status', 'blog', 'go', 'info']);

const text = (value, max) => String(value ?? '').replace(/\s+\n/gu, '\n').trim().slice(0, max);
const httpStatus = error => Number.isInteger(error?.statusCode) ? error.statusCode : null;

// Posting identifiers in a URL: long numbers (Greenhouse, Workday) and UUIDs (Ashby, Lever). Boards move postings between
// hosts (boards. and job-boards.greenhouse.io), so the identifier, not the whole address, names the posting.
const postingIds = value => (String(value || '').match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|\d{6,}/giu) || []).map(id => id.toLowerCase());
function sameposting(candidate, url) {
  const want = canonicalLeadUrl(url);
  if ([candidate?.sourceUrl, candidate?.officialApplyUrl].some(value => value && canonicalLeadUrl(value) === want)) return true;
  const ids = new Set(postingIds(url));
  return ids.size > 0 && [candidate?.sourceUrl, candidate?.officialApplyUrl, candidate?.identifier].some(value => postingIds(value).some(id => ids.has(id)));
}

function postingFacts(candidate) {
  return { title: text(candidate.title, 500), location: text(candidate.location?.display ?? candidate.location, 500),
    description: text(candidate.description, SNAPSHOT_DESCRIPTION_CHARS),
    descriptionTruncated: String(candidate.description || '').length > SNAPSHOT_DESCRIPTION_CHARS };
}

// Most careers pages put their job board in a script tag or a page's embedded data
// rather than a plain link. One address per board is enough to show the page names it.
function jobBoardsInMarkup(body, known = []) {
  const unescaped = body.replace(/\\u002f/giu, '/').replace(/\\\//gu, '/');
  const routeKey = route => route && `${route.ats}\u0000${route.tenant}`;
  const seen = new Set(known.map(url => routeKey(extractAtsTenant(url))));
  const boards = new Map(); const companyHosts = new Set(known.map(url => normalizedSourceHost(url))); let scanned = 0;
  for (const [url] of unescaped.matchAll(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'<>\\`()]*)?/giu)) {
    if (++scanned > MAX_MARKUP_URLS) break;
    if (url.length > MAX_MARKUP_URL_CHARS) continue;
    const route = extractAtsTenant(url);
    const key = routeKey(route);
    if (key && !seen.has(key) && !boards.has(key)) boards.set(key, url);
    if (key) companyHosts.add(normalizedSourceHost(url));
  }
  // An embed script or a settings value can name the company's board host with no board path.
  scanned = 0;
  for (const [host] of unescaped.matchAll(/(?<![a-z0-9.-])[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+){2,}(?![a-z0-9-])/giu)) {
    if (++scanned > MAX_MARKUP_URLS) break;
    const name = normalizedSourceHost(`https://${host}/`);
    // The same rule that recognises a company's board at a full address decides here.
    if (!name || companyHosts.has(name) || SHARED_ATS_LABELS.has(name.split('.')[0]) || !['careers', 'board'].some(path => extractAtsTenant(`https://${name}/${path}`))) continue;
    companyHosts.add(name);
    boards.set(`host\u0000${name}`, `https://${name}/`);
  }
  return [...boards.values()];
}

// A careers landing page often sends people to a separate page on the same site
// that holds the board: /careers/positions, /about/open-positions.aspx.
const JOBS_PAGE_PATH = /(?:^|[/_-])(?:positions?|openings?|open-roles|job-openings|jobs)(?:[/._-]|$)/iu;
const MAX_FOLLOWED_JOBS_PAGES = 2;
const htmlBoards = (body, finalUrl) => {
  const plain = [...new Set(scanOfficialCareersPage(body, finalUrl).links
    .filter(link => link.tag === 'a' || link.tag === 'iframe').map(link => link.url).filter(url => extractAtsTenant(url)))];
  return [...new Set([...plain, ...jobBoardsInMarkup(body, plain)])].slice(0, MAX_BOARD_LINKS);
};
async function boardsOnJobsPage(body, finalUrl, { fetch, signal }) {
  const domain = registrableDomain(normalizedSourceHost(finalUrl));
  const pages = [...new Set(scanOfficialCareersPage(body, finalUrl).links.filter(link => link.tag === 'a').map(link => link.url))]
    .filter(url => url !== finalUrl && registrableDomain(normalizedSourceHost(url)) === domain && JOBS_PAGE_PATH.test(new URL(url).pathname))
    .slice(0, MAX_FOLLOWED_JOBS_PAGES);
  for (const url of pages) {
    const { page } = await read(fetch, url, signal);
    if (!page || !/html/iu.test(page.contentType || '')) continue;
    const links = htmlBoards(String(page.body || ''), officialHttpsUrl(page.url || page.sourceUrl) || url);
    if (links.length) return { links, url };
  }
  return null;
}

async function read(fetch, url, signal) {
  try { return { page: await fetch(url, { signal }) }; }
  catch (error) { return { error: error?.code || 'fetch-failed', httpStatus: httpStatus(error) }; }
}

/** The posting's own public data when the page is an Eightfold shell. Null means this page says nothing
 * either way: only a board that answers not found and a retained record of this posting mean it left the board. */
async function eightfoldBoardSnapshot(body, finalUrl, { fetch, signal }) {
  const route = eightfoldPostingRoute(body, finalUrl);
  if (!route) return null;
  const board = await read(fetch, route.boardUrl, signal);
  let posting = board.page ? eightfoldBoardPosting(board.page.body, route.id) : null;
  if (!posting) {
    if (board.page || (board.httpStatus !== 404 && board.httpStatus !== 410 && board.error !== 'closed')) return null;
    const retained = await read(fetch, route.recordUrl, signal);
    posting = retained.page ? eightfoldRetainedPosting(retained.page.body, route.id) : null;
    if (!posting) return null;
  }
  return { source: 'board-data', postingsInData: 1, listedInBoardData: posting.listed,
    ...postingFacts({ title: posting.title, location: posting.location, description: eightfoldDescriptionText(posting.html) }) };
}

/** What one lead returned to a plain download, right now. */
export async function snapshotOfficialPostingLead(lead, { fetch, signal } = {}) {
  const at = new Date().toISOString();
  const route = lead.kind === 'posting' ? extractAtsTenant(lead.url) : null;
  if (lead.dataUrl) {
    const result = await read(fetch, lead.dataUrl, signal);
    if (result.error) {
      return { id: lead.id, at, source: 'board-data', read: false, ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
        ...(result.httpStatus === 404 || result.httpStatus === 410 || result.error === 'closed' ? { notFound: true } : {}) };
    }
    let candidates = [];
    try {
      candidates = extractOfficialPostingCandidates({ body: result.page.body, sourceUrl: result.page.url || lead.dataUrl,
        contentType: result.page.contentType, ats: route?.ats || '', tenant: route?.tenant || '' });
    } catch { candidates = []; }
    const match = candidates.find(candidate => sameposting(candidate, lead.url));
    return { id: lead.id, at, source: 'board-data', read: true, postingsInData: candidates.length,
      listedInBoardData: Boolean(match), ...(match ? postingFacts(match) : {}) };
  }
  const result = await read(fetch, lead.url, signal);
  if (result.error) {
    return { id: lead.id, at, source: 'page', read: false, ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
      ...(result.httpStatus === 404 || result.httpStatus === 410 || result.error === 'closed' ? { notFound: true } : {}) };
  }
  const body = String(result.page.body || '');
  const finalUrl = officialHttpsUrl(result.page.url || result.page.sourceUrl) || lead.url;
  const boardData = await eightfoldBoardSnapshot(body, finalUrl, { fetch, signal });
  if (boardData) return { id: lead.id, at, read: true, ...(finalUrl !== lead.url ? { finalUrl } : {}), ...boardData };
  let candidates = [];
  try { candidates = extractOfficialPostingCandidates({ body, sourceUrl: finalUrl, contentType: result.page.contentType }); } catch { candidates = []; }
  const match = candidates.find(candidate => sameposting(candidate, lead.url) || sameposting(candidate, finalUrl))
    || (lead.kind === 'posting' && candidates.length === 1 ? candidates[0] : null);
  let pageText = '';
  let pageTextTruncated = false;
  if (!match && /html/iu.test(result.page.contentType || '')) {
    try {
      const full = officialDescriptionText(body);
      pageText = text(full, SNAPSHOT_DESCRIPTION_CHARS);
      pageTextTruncated = String(full || '').length > SNAPSHOT_DESCRIPTION_CHARS;
    } catch { pageText = ''; pageTextTruncated = false; }
  }
  let boardLinks = []; let boardLinksFrom = '';
  if (lead.kind === 'careers' && /html/iu.test(result.page.contentType || '')) {
    try {
      boardLinks = htmlBoards(body, finalUrl);
      if (!boardLinks.length) {
        const followed = await boardsOnJobsPage(body, finalUrl, { fetch, signal });
        if (followed) { boardLinks = followed.links; boardLinksFrom = followed.url; }
      }
    } catch { boardLinks = []; boardLinksFrom = ''; }
  }
  return { id: lead.id, at, source: 'page', read: true, ...(finalUrl !== lead.url ? { finalUrl } : {}),
    ...(match ? postingFacts(match) : pageText ? { pageText, ...(pageTextTruncated ? { pageTextTruncated: true } : {}) } : {}), ...(boardLinks.length ? { jobBoardLinks: boardLinks } : {}), ...(boardLinksFrom ? { jobBoardLinksFrom: boardLinksFrom } : {}) };
}

/** A posting lead's closed or open status is read from the full page, whatever its data says. A careers lead is only
 * for finding the board, so it opens when the plain download found none. */
const needsRender = (lead, snapshot) => lead.kind !== 'careers' || !snapshot.jobBoardLinks?.length;

/** The plain snapshot plus what the page showed a person. Null when it showed too little to read. */
function renderedSnapshot(lead, plain, page) {
  const { pageText: _plain, pageTextTruncated: _plainTruncated, notFound: _notFound, httpStatus: _status, ...kept } = plain;
  const base = { ...kept, id: lead.id, at: new Date().toISOString(), read: true,
    // A board's data that failed to download says nothing, so what the judges read here is the page.
    source: plain.read && plain.source ? plain.source : 'page', rendered: true,
    ...(page.settled ? {} : { settled: false }), ...(page.finalUrl !== lead.url ? { finalUrl: page.finalUrl } : {}) };
  if (page.status === 404 || page.status === 410) {
    return plain.source === 'board-data' && plain.read ? { ...base, pageHttpStatus: page.status }
      : { ...base, read: false, httpStatus: page.status, notFound: true };
  }
  let boardLinks = [];
  let match = null;
  try {
    boardLinks = lead.kind === 'careers' ? htmlBoards(page.html, page.finalUrl) : [];
    const candidates = extractOfficialPostingCandidates({ body: page.html, sourceUrl: page.finalUrl, contentType: 'text/html' });
    match = candidates.find(candidate => sameposting(candidate, lead.url) || sameposting(candidate, page.finalUrl))
      || (lead.kind === 'posting' && candidates.length === 1 ? candidates[0] : null);
  } catch { /* The visible text below is still what the page showed. */ }
  const errorStatus = page.status >= 400 ? { pageHttpStatus: page.status } : {};
  // A short settled page can be the whole answer ("This job is no longer available"). A short unsettled one is still loading.
  const shown = page.text.trim().length;
  if (!boardLinks.length && !match && (!shown || (!page.settled && shown < MIN_RENDERED_CHARS))) return null;
  return { ...base, ...errorStatus, ...(match && String(match.description || '').length > String(plain.description || '').length ? postingFacts(match) : {}),
    pageText: page.text.slice(0, SNAPSHOT_PAGE_TEXT_CHARS), ...(page.text.length > SNAPSHOT_PAGE_TEXT_CHARS ? { pageTextTruncated: true } : {}),
    ...(boardLinks.length ? { jobBoardLinks: boardLinks } : {}) };
}

async function withRenderedPages(leads, snapshots, { render, signal }) {
  await Promise.all(leads.map(async (lead, index) => {
    if (!needsRender(lead, snapshots[index])) return;
    let page;
    try { page = await render(lead.url, { signal }); } catch { page = { ok: false, reason: 'load-failed' }; }
    let seen = null;
    try { seen = page?.ok ? renderedSnapshot(lead, snapshots[index], page) : null; } catch { page = { ok: false, reason: 'load-failed' }; }
    snapshots[index] = seen || { ...snapshots[index], renderFailed: page?.ok ? 'empty' : String(page?.reason || 'load-failed') };
  }));
}

/** Snapshots for every lead, trimmed so the judgment prompt stays within its bound. */
export async function snapshotOfficialPostingLeads(leads, { fetch, render, signal } = {}) {
  const snapshots = await Promise.all(leads.map(lead => snapshotOfficialPostingLead(lead, { fetch, signal })
    .catch(() => ({ id: lead.id, at: new Date().toISOString(), read: false }))));
  if (render) await withRenderedPages(leads, snapshots, { render, signal });
  return trimOfficialPostingSnapshots(snapshots);
}

/** Keeps the judgment prompt within its bound by shortening only the longest texts, all to one length, so no page loses most of its text for another. */
export function trimOfficialPostingSnapshots(snapshots) {
  const fields = snapshots.flatMap(snapshot => ['pageText', 'description'].filter(key => snapshot[key]).map(key => ({ snapshot, key, length: snapshot[key].length })));
  const excess = JSON.stringify(snapshots).length - SNAPSHOT_TOTAL_CHARS;
  if (excess <= 0 || !fields.length) return snapshots;
  // Each shortened field also gains its truncation flag.
  const budget = fields.reduce((sum, field) => sum + field.length, 0) - excess - fields.length * 32;
  // Longest last: each field below the even share leaves its unused share to the rest.
  fields.sort((a, b) => a.length - b.length);
  let remaining = Math.max(0, budget); let left = fields.length; let cap = 0;
  for (const field of fields) {
    cap = Math.floor(remaining / left);
    if (field.length > cap) break;
    remaining -= field.length; left -= 1;
  }
  for (const { snapshot, key, length } of fields) {
    if (length <= cap) continue;
    snapshot[key] = snapshot[key].slice(0, cap);
    snapshot[`${key}Truncated`] = true;
  }
  return snapshots;
}
