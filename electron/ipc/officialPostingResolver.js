import crypto from 'node:crypto';
import { normalizeOfficialPosting, officialHttpsUrl, boundedOfficialPostingTrail, normalizeOfficialPostingFetchFailure, OFFICIAL_FETCH_FAILURE_LIMIT } from './officialPostingFields.js';
import { officialSmartRecruitersAdapterUrl } from './officialPostingExtractors.js';
import { extractAtsTenant } from './officialSourceHosts.js';
import { resolveScrapedEmployer } from './officialPostingMatch.js';
import { officialPostingNegativeNeedsRecheck } from './officialPostingNegativePolicy.js';
import { officialPostingVendorAdapterUrl } from './officialPostingVendorAdapters.js';

const OFFICIAL_POSTING_BATCH_SIZE = 12;
export { adapterUrl as officialPostingAdapterUrl, readableDescription as readableOfficialPostingDescription, verifiedApplyUrl as verifiedOfficialPostingApplyUrl };

const canonical = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const RETRYABLE_MISS_TRAIL = new Set(['worker-aborted', 'worker-timeout', 'worker-unavailable', 'research-miss',
  'fetch-failed', 'fetch-timeout', 'unsafe-url', 'unsafe-address', 'unsupported-content-type', 'oversize', 'invalid-text',
  'crawl-budget', 'crawl-partial', 'official-text-missing', 'storage-failed', 'failed', 'comparative-invalid', 'comparative-unavailable', 'comparative-truncated', 'insufficient-text', 'judge-title-split', 'judge-employer-split', 'semantic-uncertain', 'semantic-overflow', 'official-liveness-unconfirmed', 'source-unproven']);
const DEFINITIVE_MISS_TRAIL = new Set(['closed', 'title-mismatch', 'location-mismatch', 'employer-mismatch',
  'tenant-unproven', 'poster-tenant', 'salary-mismatch', 'no-anchor', 'invalid-quotes', 'ambiguous', 'comparative-none', 'comparative-disagree']);

/** Reads and writes use the same rule, including historical cached results.
 * A partial crawl needs a verified identity decision; a run abort never writes. */
export function shouldPersistOfficialPostingResult(value, { signal, researchRan = false } = {}) {
  if (signal?.aborted) return false;
  const posting = normalizeOfficialPosting(value?.officialPosting || value?.posting || value);
  if (!posting) return false;
  if (officialPostingNegativeNeedsRecheck(posting)) return false;
  const trail = posting.trail || [];
  if (['L1', 'L2', 'L3', 'L4'].includes(posting.level)) {
    if (posting.outcome === 'closed') return trail.includes('closed') && trail.includes('semantic-match-v1')
      && /^[a-f0-9]{64}$/u.test(posting.semanticMatch?.sourceHash || '');
    const partial = trail.includes('fetch-timeout') || trail.includes('crawl-budget') || trail.includes('crawl-partial');
    const agreedChoice = trail.find(code => /^comparative-choice-p[1-8]$/u.test(code))?.slice('comparative-choice-'.length);
    // An equivalent split (same live posting chosen as two options) needs the representative to be one run's choice and the other run a real option.
    const equivalentSplit = trail.includes('comparative-equivalent') && agreedChoice
      && trail.includes(`comparative-a-${agreedChoice}`) !== trail.includes(`comparative-b-${agreedChoice}`)
      && trail.some(code => /^comparative-[ab]-p[1-8]$/u.test(code) && code !== `comparative-a-${agreedChoice}` && code !== `comparative-b-${agreedChoice}`);
    const semanticIdentity = posting.semanticMatch?.version === 1 && /^[a-f0-9]{64}$/u.test(posting.semanticMatch?.sourceHash)
      && trail.includes('semantic-match-v1') && trail.includes('comparative-match')
      && trail.includes('comparative-a-valid') && trail.includes('comparative-b-valid') && agreedChoice
      && (equivalentSplit || (trail.includes(`comparative-a-${agreedChoice}`) && trail.includes(`comparative-b-${agreedChoice}`)));
    const identityProof = trail.includes('identifier-anchor') || semanticIdentity;
    return ['found', 'link-only'].includes(posting.outcome) && (!partial || identityProof);
  }
  if (posting.outcome === 'failed' || posting.fetchFailures?.length || trail.some(code => RETRYABLE_MISS_TRAIL.has(code))) return false;
  return researchRan || trail.includes('worker-research') || posting.outcome === 'closed'
    || trail.some(code => DEFINITIVE_MISS_TRAIL.has(code));
}

export function officialPostingRequestId(job) {
  return crypto.createHash('sha256').update([job?.title, job?.company, job?.url || job?.googleCardUrl, job?.location].map(canonical).join('|')).digest('hex').slice(0, 24);
}
export function officialPostingChunks(jobs) {
  const members = (Array.isArray(jobs) ? jobs : []).map(job => ({ id: officialPostingRequestId(job), job }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const chunks = [];
  for (let index = 0; index < members.length; index += OFFICIAL_POSTING_BATCH_SIZE) chunks.push(members.slice(index, index + OFFICIAL_POSTING_BATCH_SIZE));
  return chunks;
}
function trailCodes(values) { return boundedOfficialPostingTrail(values); }
function fallback(job, options = {}) {
  try {
    const { outcome = 'not-found', trail = [], alternatives = [], fetchFailures = [] } = options || {};
    // Scraped identity remains untouched; only the bounded resolution display
    // fields use this projection. A malformed display cannot poison a run.
    // eslint-disable-next-line no-control-regex
    const display = (value, max) => String(value ?? '').normalize('NFKC').replace(/[<>\u0000-\u001f\u007f]/gu, '').trim().slice(0, max);
    const scraped = resolveScrapedEmployer(job || {});
    const safeAlternatives = (Array.isArray(alternatives) ? alternatives : []).slice(0, 12).flatMap(item => {
      const url = officialHttpsUrl(item?.url); const title = display(item?.title, 500);
      return url && title ? [{ url, title }] : [];
    });
    const failures = (Array.isArray(fetchFailures) ? fetchFailures : []).map(normalizeOfficialPostingFetchFailure).filter(Boolean).slice(0, OFFICIAL_FETCH_FAILURE_LIMIT);
    const officialPosting = normalizeOfficialPosting({ level: scraped.level, outcome,
      employer: display(scraped.employer, 120), trail: trailCodes(Array.isArray(trail) ? trail : []), alternatives: safeAlternatives,
      ...(failures.length ? { fetchFailures: failures } : {}) });
    if (officialPosting) return { postedBy: scraped.postedBy || undefined, officialPosting };
  } catch { /* Even the fallback must tolerate an invalid scraped row. */ }
  return { officialPosting: { level: 'L6', outcome: 'failed', employer: '', trail: ['failed'] } };
}
export function unresolvedOfficialPosting(job, options) { return fallback(job, options); }

function verifiedApplyUrl(candidate) {
  const source = new URL(candidate.sourceUrl);
  const value = officialHttpsUrl(candidate.officialApplyUrl);
  if (!value) return source.href;
  const apply = new URL(value);
  const sourcePath = source.pathname.replace(/\/+$/u, '');
  const applyPath = apply.pathname.replace(/\/+$/u, '');
  return apply.host === source.host && apply.search === source.search && (applyPath === sourcePath
    || ['application', 'apply', 'applications/new'].some(suffix => applyPath === `${sourcePath}/${suffix}`))
    ? apply.href : source.href;
}
function adapterUrl(route, url) {
  const tenant = encodeURIComponent(route.tenant);
  if (route.ats === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${tenant}?includeCompensation=true`;
  if (route.ats === 'greenhouse') {
    let id = '';
    try {
      const source = new URL(url); const actual = extractAtsTenant(source.href);
      if (actual?.ats === route.ats && actual.tenant === route.tenant) id = /\/jobs\/(\d+)\/?$/u.exec(source.pathname)?.[1] || '';
    } catch { /* Only a URL-bound detail identifier may narrow the adapter. */ }
    return id ? `https://boards-api.greenhouse.io/v1/boards/${tenant}/jobs/${id}?questions=false`
      : `https://boards-api.greenhouse.io/v1/boards/${tenant}/jobs?content=true`;
  }
  if (route.ats === 'lever') return `https://api.lever.co/v0/postings/${tenant}?mode=json`;
  if (route.ats === 'teamtailor') return new URL('/jobs.rss', url).href;
  if (route.ats === 'smartrecruiters') return officialSmartRecruitersAdapterUrl(route, url);
  return officialPostingVendorAdapterUrl(route, url);
}
function readableDescription(candidate, job) {
  const description = String(candidate?.description || '');
  const scraped = String(job?.snippet || '');
  return description.split(/\s+/u).filter(Boolean).length >= 40
    && !(scraped.length > 600 && description.length < scraped.length * 0.3)
    && /\b(?:requirements?|qualifications?|responsibilit\w*|you will|what you|we are looking|experience|skills?)\b/iu.test(description);
}
