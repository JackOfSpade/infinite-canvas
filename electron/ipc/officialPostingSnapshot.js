import { extractOfficialPostingCandidates, officialDescriptionText, scanOfficialCareersPage } from './officialPostingExtractors.js';
import { officialHttpsUrl } from './officialPostingFields.js';
import { canonicalLeadUrl } from './officialPostingMatch.js';
import { extractAtsTenant } from './officialSourceHosts.js';

// ChatGPT's browser cannot run JavaScript and often cannot open job-board data
// addresses, so the app downloads each lead once and hands the judges what it
// returned. This is transport only: no field here decides identity, status or
// ownership. The judges read it as untrusted page content, like the listing.

export const SNAPSHOT_DESCRIPTION_CHARS = 30_000;
export const SNAPSHOT_TOTAL_CHARS = 100_000;
const MAX_BOARD_LINKS = 12;

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
