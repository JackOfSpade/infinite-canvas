import { extractOfficialPostingCandidates, officialDescriptionText, scanOfficialCareersPage } from './officialPostingExtractors.js';
import { officialHttpsUrl } from './officialPostingFields.js';
import { canonicalLeadUrl } from './officialPostingMatch.js';
import { extractAtsTenant, normalizedSourceHost } from './officialSourceHosts.js';

// Claude's WebFetch cannot run JavaScript and returns a summary of a page rather than
// its text, so the app downloads each lead once and hands the judges what it
// returned: their main input. This is transport only: no field here decides identity,
// status or ownership. The judges read it as untrusted page content, like the listing.

export const SNAPSHOT_DESCRIPTION_CHARS = 30_000;
export const SNAPSHOT_TOTAL_CHARS = 100_000;
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

async function read(fetch, url, signal) {
  try { return { page: await fetch(url, { signal }) }; }
  catch (error) { return { error: error?.code || 'fetch-failed', httpStatus: httpStatus(error) }; }
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
  let boardLinks = [];
  if (lead.kind === 'careers' && /html/iu.test(result.page.contentType || '')) {
    try {
      boardLinks = [...new Set(scanOfficialCareersPage(body, finalUrl).links
        .filter(link => link.tag === 'a' || link.tag === 'iframe').map(link => link.url).filter(url => extractAtsTenant(url)))].slice(0, MAX_BOARD_LINKS);
    } catch { boardLinks = []; }
    try { boardLinks = [...new Set([...boardLinks, ...jobBoardsInMarkup(body, boardLinks)])].slice(0, MAX_BOARD_LINKS); } catch { /* The plain links still stand. */ }
  }
  return { id: lead.id, at, source: 'page', read: true, ...(finalUrl !== lead.url ? { finalUrl } : {}),
    ...(match ? postingFacts(match) : pageText ? { pageText, ...(pageTextTruncated ? { pageTextTruncated: true } : {}) } : {}), ...(boardLinks.length ? { jobBoardLinks: boardLinks } : {}) };
}

/** Snapshots for every lead, trimmed so the judgment prompt stays within its bound. */
export async function snapshotOfficialPostingLeads(leads, { fetch, signal } = {}) {
  const snapshots = await Promise.all(leads.map(lead => snapshotOfficialPostingLead(lead, { fetch, signal })
    .catch(() => ({ id: lead.id, at: new Date().toISOString(), read: false }))));
  let total = JSON.stringify(snapshots).length;
  for (const snapshot of [...snapshots].sort((a, b) => (b.description || b.pageText || '').length - (a.description || a.pageText || '').length)) {
    if (total <= SNAPSHOT_TOTAL_CHARS) break;
    for (const key of ['pageText', 'description']) {
      if (!snapshot[key]) continue;
      const keep = Math.max(1000, snapshot[key].length - (total - SNAPSHOT_TOTAL_CHARS));
      total -= snapshot[key].length - Math.min(keep, snapshot[key].length);
      if (keep < snapshot[key].length) { snapshot[key] = snapshot[key].slice(0, keep); snapshot[`${key}Truncated`] = true; }
    }
  }
  return snapshots;
}
