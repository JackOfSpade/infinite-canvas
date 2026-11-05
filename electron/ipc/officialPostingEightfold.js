import { JSDOM } from 'jsdom';
import { officialDescriptionText } from './officialPostingExtractors.js';
import { officialHttpsUrl } from './officialPostingFields.js';

// Careers sites run on Eightfold (often under the employer's own domain) send a page shell: the posting and its
// "No longer accepting applications" notice arrive only through the site's own public data, after JavaScript runs.
// A plain download can read that data directly. Two records exist per posting:
// - position_details is the current board: it answers for a posting people can apply to, and not found once it closes.
// - apply/v2/jobs keeps the posting's record after it closes, so it identifies a posting the board no longer lists.
// Transport only: the judges still decide, from what these records say.

const JOB_PATH = /^\/careers\/job\/(\d{6,20})(?:-[^/]*)?\/?$/u;
const PLATFORM_MARK = /eightfold/iu;
const BOARD_ENABLED = /"pcsxConfig":\s*\{\s*"enabled":\s*true/u;
const SITE_DOMAIN = /"domain":\s*"([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)"/iu;

const unescaped = body => body.replace(/&#34;|&quot;/gu, '"');

/** The data addresses for a job page whose own markup shows it runs on this platform's current board. */
export function eightfoldPostingRoute(body, pageUrl) {
  const url = officialHttpsUrl(pageUrl);
  if (!url || typeof body !== 'string' || !PLATFORM_MARK.test(body)) return null;
  const parsed = new URL(url);
  const id = JOB_PATH.exec(parsed.pathname)?.[1];
  if (!id) return null;
  const markup = unescaped(body);
  const domain = BOARD_ENABLED.test(markup) ? SITE_DOMAIN.exec(markup)?.[1]?.toLowerCase() : '';
  if (!domain) return null;
  const query = `domain=${encodeURIComponent(domain)}`;
  return { id, boardUrl: `${parsed.origin}/api/pcsx/position_details?position_id=${id}&${query}&hl=en`,
    recordUrl: `${parsed.origin}/api/apply/v2/jobs/${id}?${query}` };
}

const parsedJson = body => { try { return JSON.parse(String(body ?? '')); } catch { return null; } };
const sameId = (record, id) => record && typeof record === 'object' && String(record.id ?? '') === id;
const places = record => [...new Set((Array.isArray(record.locations) && record.locations.length ? record.locations : [record.location])
  .filter(place => typeof place === 'string' && place.trim()).map(place => place.trim()))].join(' | ');

/** The posting in a position_details answer, or null when the answer is not about this posting. */
export function eightfoldBoardPosting(body, id) {
  const record = parsedJson(body)?.data;
  if (!sameId(record, id)) return null;
  return { title: record.name, location: places(record), html: record.jobDescription, listed: Boolean(officialHttpsUrl(record.publicUrl)) };
}

/** The retained record in an apply/v2/jobs answer, or null when the answer is not about this posting. */
export function eightfoldRetainedPosting(body, id) {
  const record = parsedJson(body);
  if (!sameId(record, id)) return null;
  return { title: record.name, location: places(record), html: record.job_description, listed: false };
}

/** Some employers' descriptions leave inline tags unclosed, which nests them past the normal converter's limit.
 * Their words are still all there, so read them as plain text with line breaks kept. */
export function eightfoldDescriptionText(html) {
  if (typeof html !== 'string' || !html) return '';
  try { return officialDescriptionText(html); } catch { /* read it as plain text below */ }
  try {
    const fragment = JSDOM.fragment(html.replace(/<(?:\/p|\/h[1-6]|\/li|\/div|br\b[^>]{0,200})>/giu, '$&\n'));
    for (const node of fragment.querySelectorAll('script,style,template,noscript')) node.remove();
    return fragment.textContent.replace(/[^\S\n]+/gu, ' ').replace(/ ?\n ?/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
  } catch { return ''; }
}
