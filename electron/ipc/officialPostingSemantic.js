import crypto from 'node:crypto';
import { LOCAL_AI_APPLICATION_SNIPPET_MAX_CHARS, SALARY_PROVENANCES, normalizeApplyOptions, officialHttpsUrl } from './officialPostingFields.js';
import { projectOfficialPostingSourceFields } from './officialPostingSourceProjection.js';
import { isUnsafeControlCharacter } from './structuredResume.js';
import { normalizeJobListingExternalUrl } from '../../src/utils/jobListingUrl.js';
import { MULTIPLE_LOCATIONS_LABEL } from '../../src/utils/jobLocationConsolidation.js';
import { isAggregatorHost } from './officialSourceHosts.js';
import { plainPostingText } from './officialPostingMatch.js';

const text = value => typeof value === 'string' ? value.trim() : '';
const header = value => text(value).normalize('NFKC').replace(/\s+/gu, ' ');
const sourceOf = value => value?.candidate && typeof value.candidate === 'object' ? value.candidate : value;

function sourceStatus(candidate, now) {
  const code = Number(candidate.statusCode ?? candidate.httpStatus);
  if ([404, 410].includes(code) || candidate.isListed === false) return 'closed';
  const instant = typeof now === 'function' ? Number(now()) : Number(now);
  const expiry = typeof candidate.validThrough === 'string' ? Date.parse(candidate.validThrough) : NaN;
  // An expired structured date is a lead for the host's closure check. It is
  // not itself proof that the employer has closed this requisition.
  if (candidate.live === false || (Number.isFinite(expiry) && Number.isFinite(instant) && expiry < instant)) return 'unavailable';
  return 'live';
}

/** The availability a saved source hash covers; an unusable source is unavailable. */
function sourceHashStatus(value, now) {
  const candidate = sourceOf(value);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return 'unavailable';
  const sourceUrl = officialHttpsUrl(candidate.sourceUrl || candidate.url);
  if (!sourceUrl || isAggregatorHost(new URL(sourceUrl).hostname)) return 'unavailable';
  return sourceStatus(candidate, now);
}

function locationText(value) {
  if (typeof value === 'string') return header(value);
  if (!value || typeof value !== 'object') return '';
  return header(value.display) || [value.city, value.subdivision ?? value.state ?? value.province, value.country]
    .map(header).filter(Boolean).join(', ');
}

function identifierText(value) {
  if (Array.isArray(value)) return value.map(identifierText).filter(Boolean).join(' | ');
  if (value && typeof value === 'object') return identifierText(value.value);
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : header(value);
}

function salaryText(value) {
  if (typeof value === 'string') return header(value);
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return header(value.text);
  return [value.currency, value.min, value.max, value.period]
    .map(item => typeof item === 'number' && Number.isFinite(item) ? String(item) : header(item)).filter(Boolean).join(' ');
}

function evidenceView(value, { scraped = false, status } = {}) {
  const candidate = sourceOf(value) || {};
  const location = candidate.location;
  return {
    employer: header(candidate.employer || candidate.company || candidate.hiringOrganization?.name),
    title: header(candidate.title),
    location: locationText(location),
    workMode: header(location?.workMode || candidate.workMode),
    remote: typeof location?.remote === 'boolean' ? location.remote : typeof candidate.remote === 'boolean' ? candidate.remote : null,
    remoteCountry: header(location?.remoteCountry || candidate.remoteCountry),
    remoteRegion: header(location?.remoteRegion || candidate.remoteRegion),
    salary: scraped && candidate.salaryProvenance !== 'posted' ? '' : salaryText(candidate.salary),
    salaryProvenance: header(candidate.salaryProvenance || candidate.salary?.provenance) || 'unknown',
    identifier: identifierText(candidate.identifier ?? candidate.requisitionId ?? candidate.reqId),
    employmentType: identifierText(candidate.employmentType),
    seniority: identifierText(candidate.seniority ?? candidate.jobLevel),
    locations: Array.isArray(candidate.locations) ? candidate.locations.map(locationText).filter(Boolean) : [],
    status: status || (scraped ? 'scraped reference' : value?.status || sourceHashStatus(candidate, Date.now)),
    validThrough: header(candidate.validThrough),
    isListed: typeof candidate.isListed === 'boolean' ? candidate.isListed : null,
    statusCode: Number.isFinite(Number(candidate.statusCode ?? candidate.httpStatus)) ? Number(candidate.statusCode ?? candidate.httpStatus) : null,
    description: plainPostingText(scraped && typeof candidate.snippet === 'string' && candidate.snippet.trim()
      ? candidate.snippet : typeof candidate.description === 'string' && candidate.description.trim()
        ? candidate.description : typeof candidate.snippet === 'string' ? candidate.snippet : ''),
    sourceUrl: text(candidate.sourceUrl || candidate.url || candidate.googleCardUrl),
    provenance: header(candidate.provenance || (scraped ? candidate.source : '')),
  };
}

function evidenceText(view) {
  return [
    `Employer: ${view.employer}`,
    `Title: ${view.title}`,
    `Location: ${view.location}`,
    `Work mode: ${view.workMode}`,
    `Remote: ${view.remote === null ? 'unspecified' : String(view.remote)}`,
    `Remote country: ${view.remoteCountry}`,
    `Remote region: ${view.remoteRegion}`,
    `Advertised salary: ${view.salary}`,
    `Salary provenance: ${view.salaryProvenance}`,
    `Identifier: ${view.identifier}`,
    `Employment type: ${view.employmentType}`,
    `Seniority or job level: ${view.seniority}`,
    `Additional locations: ${view.locations.join(' | ')}`,
    `Source status: ${view.status}`,
    `Valid through: ${view.validThrough}`,
    `Listed: ${view.isListed === null ? 'unspecified' : String(view.isListed)}`,
    `HTTP status: ${view.statusCode === null ? 'unspecified' : String(view.statusCode)}`,
    `Source URL: ${view.sourceUrl}`,
    `Provenance: ${view.provenance}`,
    'Description:',
    view.description,
  ].join('\n');
}

export function officialPostingSemanticScrapedEvidence(job) {
  return evidenceText(evidenceView(job, { scraped: true }));
}

export function officialPostingSemanticCandidateEvidence(option) {
  return evidenceText(evidenceView(option, { status: option?.status }));
}

function canonicalRecord(value, stack = new Set()) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
      || typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Official source records must be serializable data.');
    return JSON.stringify(value);
  }
  if (stack.has(value)) throw new TypeError('Official source records must not contain cycles.');
  stack.add(value);
  const result = Array.isArray(value)
    ? `[${value.map(item => canonicalRecord(item, stack)).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalRecord(value[key], stack)}`).join(',')}}`;
  stack.delete(value);
  return result;
}

/** A saved semantic decision belongs to the full source input it judged. */
export function officialPostingSemanticInputHash(job = {}) {
  const normalized = value => {
    if (typeof value === 'string') return plainPostingText(value).replace(/\s+/gu, ' ').trim();
    if (Array.isArray(value)) return value.map(normalized);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])]));
    return value;
  };
  const input = Object.fromEntries(['title', 'company', 'employer', 'hiringOrganization', 'location', 'locations',
    'workMode', 'remote', 'remoteCountry', 'remoteRegion', 'salary', 'salaryProvenance',
    'employmentType', 'seniority', 'jobLevel', 'identifier', 'requisitionId', 'reqId',
    'url', 'sourceUrl', 'googleCardUrl', 'applyOptions', 'source', 'provenance', 'snippet', 'description']
    .map(key => [key, normalized(job[key])]));
  return crypto.createHash('sha256').update(canonicalRecord(input), 'utf8').digest('hex');
}

export function officialPostingSemanticSourceHash(candidate, { now = Date.now } = {}) {
  const status = sourceHashStatus(candidate, now);
  return crypto.createHash('sha256').update(canonicalRecord(evidenceView(candidate, { status })), 'utf8').digest('hex');
}

const projectedText = (value, max) => Array.from(String(value ?? ''), char => (
  char === '\r' || isUnsafeControlCharacter(char) ? ' ' : char)).join('').slice(0, max).trim();

/**
 * The hashed fields of a card as card refresh and Prepare judge it: the renderer's
 * projectOfficialPostingGenerationJob, then the host queue projection (safeJob), which fills
 * defaults the raw Board row lacks (salaryProvenance 'unknown', applyOptions [], empty strings).
 * A proof saved by those paths hashes this shape, so the raw row it came from never reproduced it.
 */
export function officialPostingSemanticProjectedInput(job = {}) {
  return {
    ...projectOfficialPostingSourceFields(job),
    title: projectedText(job.title, 500), company: projectedText(job.company, 500),
    snippet: projectedText(job.snippet, LOCAL_AI_APPLICATION_SNIPPET_MAX_CHARS), location: projectedText(job.location, 500),
    salary: projectedText(job.salary, 500), url: projectedText(normalizeJobListingExternalUrl(job), 2_000),
    googleCardUrl: projectedText(job.googleCardUrl, 2_000), source: projectedText(job.source, 500),
    applyOptions: normalizeApplyOptions(job.applyOptions),
    salaryProvenance: SALARY_PROVENANCES.includes(job.salaryProvenance) ? job.salaryProvenance : 'unknown',
  };
}

const CONSOLIDATED_MEMBER_SHAPES = 64;
/**
 * Consolidation keeps one member's row and renames its location, so a proof saved for any member
 * (before consolidation, or for another member whose record shares the same official text) no
 * longer hashes. Each member is rebuilt only from this row and its own variant. Only a row that
 * consolidation itself shaped qualifies; any other row gets no extra shapes.
 */
export function officialPostingConsolidatedMemberShapes(job) {
  if (!(Number(job?.consolidatedPostingCount) > 1) || job.location !== MULTIPLE_LOCATIONS_LABEL
    || !Array.isArray(job.postingVariants) || job.postingVariants.length < 2) return [];
  return job.postingVariants.slice(0, CONSOLIDATED_MEMBER_SHAPES).flatMap(variant => {
    if (!variant || typeof variant !== 'object' || typeof variant.location !== 'string' || !variant.location.trim()) return [];
    const member = { ...job, location: variant.location };
    for (const key of ['url', 'googleCardUrl', 'source', 'salary']) if (typeof variant[key] === 'string') member[key] = variant[key];
    return [member];
  });
}

/**
 * A proof holds when its input hash is this row, or this row as refresh/Prepare projected it. For a
 * consolidated row with a live (found or link-only) posting, a member rebuilt from its own variant
 * also holds; a closed or missing verdict about one member never speaks for the whole row.
 */
export function officialPostingSemanticProofMatches(job, value) {
  const posting = value?.officialPosting || value;
  const proof = posting?.semanticMatch;
  if (proof?.version !== 1 || typeof proof.inputHash !== 'string' || !/^[a-f0-9]{64}$/iu.test(proof.inputHash)
    || !Array.isArray(posting?.trail) || !posting.trail.includes('semantic-match-v1')) return false;
  if (['L1', 'L2', 'L3', 'L4'].includes(posting.level)
    && (typeof proof.sourceHash !== 'string' || !/^[a-f0-9]{64}$/iu.test(proof.sourceHash))) return false;
  const want = proof.inputHash.toLowerCase();
  const holds = shape => {
    try { if (want === officialPostingSemanticInputHash(shape)) return true; } catch { /* An unhashable shape proves nothing. */ }
    try { return want === officialPostingSemanticInputHash(officialPostingSemanticProjectedInput(shape)); } catch { return false; }
  };
  if (holds(job)) return true;
  return ['found', 'link-only'].includes(posting.outcome) && officialPostingConsolidatedMemberShapes(job).some(holds);
}
