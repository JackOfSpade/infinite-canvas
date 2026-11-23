// Listing identity shared by seen-history and Board dismissal. Keep both paths
// on the same key so a dismissed consolidated card covers every posting variant.
import { googleJobsDocumentId } from './jobListingUrl.js';

// Preserve a provider's listing identity while dropping search/session noise.
// Many employer boards serve every requisition through one shared URL path.
const IDENTITY_PARAMS = ['jk', 'htidocid', 'jid', 'gh_jid', 'jobId', 'jobid', 'job_id', 'requisitionId', 'requisitionid', 'reqId'];

function normUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    // URL paths and opaque ATS ids can be case-sensitive; only hosts and the
    // known case-insensitive Indeed key are safe to fold.
    const path = u.pathname.replace(/\/+$/, '');
    const googleId = googleJobsDocumentId(url);
    if (googleId) return `https://${host}/search?htidocid=${encodeURIComponent(googleId)}`;
    const identity = IDENTITY_PARAMS.find(p => u.searchParams.get(p));
    if (identity) {
      const raw = u.searchParams.get(identity);
      const value = identity === 'jk' ? raw.toLowerCase() : raw;
      return `https://${host}${path}?${identity}=${encodeURIComponent(value)}`;
    }
    if (/\/(?:rc|pagead)\/clk$/i.test(path)) return '';
    return `https://${host}${path}`;
  } catch {
    return String(url).split('?')[0].trim().toLowerCase()
      .replace(/^https?:\/\//, 'https://')
      .replace(/^https:\/\/www\./, 'https://')
      .replace(/\/+$/, '');
  }
}

function normText(value) {
  return String(value || '')
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:apos|#0*39);|&#x0*27;/gi, "'")
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

export function dedupKeysFor(item) {
  const url = normUrl(item?.url || item?.googleCardUrl);
  if (url) return [`u:${url}`];
  const title = normText(item?.title);
  const company = normText(item?.company);
  const location = normText(item?.location);
  if (!title || !company) return [];
  return [location ? `tcl:${title}|${company}|${location}` : `tc:${title}|${company}`];
}

export function jobAndVariantKeys(item) {
  const variants = Array.isArray(item?.postingVariants) ? item.postingVariants : [];
  return [...new Set([item, ...variants].flatMap(dedupKeysFor))];
}

// A card the user deletes from a Job Board stays deleted on that Board: the
// Board saves the card's listing keys (`dismissedJobKeys`) and later Combines
// leave matching rows out. A listing that still has a card on the Board is
// never treated as deleted, so a card that came back another way (Undo, a
// restored save) cannot be dropped by a stale key.
export function boardDeletedJobKeys(savedKeys, liveCards) {
  const live = new Set((Array.isArray(liveCards) ? liveCards : [])
    .flatMap(card => jobAndVariantKeys(card?.data)));
  return [...new Set((Array.isArray(savedKeys) ? savedKeys : [])
    .filter(key => typeof key === 'string' && key && !live.has(key)))];
}

export function addBoardDeletedJobKeys(savedKeys, deletedCards) {
  return [...new Set([
    ...(Array.isArray(savedKeys) ? savedKeys : []).filter(key => typeof key === 'string' && key),
    ...(Array.isArray(deletedCards) ? deletedCards : []).flatMap(card => jobAndVariantKeys(card?.data)),
  ])];
}

export function splitBoardDeletedJobs(jobs, deletedKeys) {
  const rows = Array.isArray(jobs) ? jobs : [];
  const deleted = new Set(Array.isArray(deletedKeys) ? deletedKeys : []);
  if (deleted.size === 0) return { kept: rows, removed: [] };
  const kept = [];
  const removed = [];
  for (const job of rows) {
    (jobAndVariantKeys(job).some(key => deleted.has(key)) ? removed : kept).push(job);
  }
  return { kept, removed };
}
