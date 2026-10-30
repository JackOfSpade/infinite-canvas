import crypto from 'node:crypto';
import { officialHttpsUrl } from './officialPostingFields.js';
import { extractAtsTenant, isAggregatorHost, isHostedAtsSurface } from './officialSourceHosts.js';
import { plainPostingText } from './officialPostingMatch.js';

export const OFFICIAL_POSTING_SEMANTIC_INVENTORY_CAP = 1024;
export const OFFICIAL_POSTING_SEMANTIC_OPTION_CAP = 8;

const text = value => typeof value === 'string' ? value.trim() : '';
const header = value => text(value).normalize('NFKC').replace(/\s+/gu, ' ');
const sourceOf = value => value?.candidate && typeof value.candidate === 'object' ? value.candidate : value;
const hostLiveness = new WeakMap();

/** Host-only receipt: object fields from a renderer or fetched JSON cannot
 * manufacture a current availability verdict. Preserve it across snapshots. */
export function withHostOfficialPostingLiveness(candidate, verdict) {
  if (!['open', 'closed', 'unclear'].includes(verdict)) throw new TypeError('Invalid host official posting liveness.');
  const result = { ...candidate };
  hostLiveness.set(result, verdict);
  return result;
}

function sourceStatus(candidate, now) {
  const code = Number(candidate.statusCode ?? candidate.httpStatus);
  if ([404, 410].includes(code) || candidate.isListed === false) return 'closed';
  const observed = hostLiveness.get(candidate);
  if (observed) return observed === 'open' ? 'live' : observed === 'closed' ? 'closed' : 'unavailable';
  const instant = typeof now === 'function' ? Number(now()) : Number(now);
  const expiry = typeof candidate.validThrough === 'string' ? Date.parse(candidate.validThrough) : NaN;
  // An expired structured date is a lead for the host's closure check. It is
  // not itself proof that the employer has closed this requisition.
  if (candidate.live === false || (Number.isFinite(expiry) && Number.isFinite(instant) && expiry < instant)) return 'unavailable';
  return 'live';
}

/** Host ownership and transport evidence admit sources; AI decides job identity. */
export function evaluateOfficialPostingSourceEligibility(value, { now = Date.now } = {}) {
  const candidate = sourceOf(value);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { eligible: false, reason: 'invalid-source', status: 'unavailable' };
  }
  const sourceUrl = officialHttpsUrl(candidate.sourceUrl || candidate.url);
  if (!sourceUrl) return { eligible: false, reason: 'unsafe-url', status: 'unavailable' };
  const host = new URL(sourceUrl).hostname;
  if (isAggregatorHost(host)) return { eligible: false, reason: 'aggregator-source', status: 'unavailable' };
  const status = sourceStatus(candidate, now);
  const ats = extractAtsTenant(sourceUrl) || isHostedAtsSurface(host);
  const proven = ats ? candidate.tenantProven === true
    : candidate.employerDomainProven === true || candidate.officialPortalProven === true;
  return { eligible: proven, reason: proven ? '' : 'source-unproven', status };
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
    status: status || (scraped ? 'scraped reference' : value?.status || evaluateOfficialPostingSourceEligibility(candidate).status),
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

export function officialPostingSemanticEvidenceText(value) {
  return officialPostingSemanticCandidateEvidence(value);
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

function inventoryError(message, code = 'OFFICIAL_POSTING_SEMANTIC_INVENTORY_INVALID') {
  return Object.assign(new Error(message), { code });
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
  const status = evaluateOfficialPostingSourceEligibility(candidate, { now }).status;
  return crypto.createHash('sha256').update(canonicalRecord(evidenceView(candidate, { status })), 'utf8').digest('hex');
}

export function officialPostingSemanticProofMatches(job, value) {
  const posting = value?.officialPosting || value;
  const proof = posting?.semanticMatch;
  if (proof?.version !== 1 || typeof proof.inputHash !== 'string' || !/^[a-f0-9]{64}$/iu.test(proof.inputHash)
    || !Array.isArray(posting?.trail) || !posting.trail.includes('semantic-match-v1')) return false;
  if (['L1', 'L2', 'L3', 'L4'].includes(posting.level)
    && (typeof proof.sourceHash !== 'string' || !/^[a-f0-9]{64}$/iu.test(proof.sourceHash))) return false;
  try { return proof.inputHash.toLowerCase() === officialPostingSemanticInputHash(job); }
  catch { return false; }
}

/** Stable exact-record dedup keeps conflicting same-URL representations visible. */
export function buildOfficialPostingSemanticInventory(candidates, { now = Date.now } = {}) {
  if (!Array.isArray(candidates)) throw inventoryError('Official source inventory must be an array.');
  const records = new Map();
  for (const candidate of candidates) {
    const eligibility = evaluateOfficialPostingSourceEligibility(candidate, { now });
    if (!eligibility.eligible) continue;
    let key;
    try { key = canonicalRecord({ candidate, status: eligibility.status }); }
    catch (error) { throw inventoryError(error.message); }
    if (!records.has(key)) {
      // The prompt and its later quote checks share one source snapshot even
      // if a caller updates a fetched record while a handoff is outstanding.
      let snapshot;
      try { snapshot = structuredClone(candidate); }
      catch { throw inventoryError('Official source records must be cloneable data.'); }
      if (hostLiveness.has(candidate)) hostLiveness.set(snapshot, hostLiveness.get(candidate));
      records.set(key, { candidate: snapshot, eligibility });
    }
  }
  if (records.size > OFFICIAL_POSTING_SEMANTIC_INVENTORY_CAP) {
    throw Object.assign(inventoryError('Official source inventory exceeds its structural limit; identity remains unsettled.',
      'OFFICIAL_POSTING_SEMANTIC_INVENTORY_OVERFLOW'), { candidateCount: records.size, cap: OFFICIAL_POSTING_SEMANTIC_INVENTORY_CAP });
  }
  return [...records.keys()].sort().map((key, index) => {
    const { candidate, eligibility } = records.get(key);
    const view = evidenceView(candidate, { status: eligibility.status });
    return { id: `C${index + 1}`, candidate, ...view, evidenceText: evidenceText(view) };
  });
}

/** Only an explicit AI shortlist can reduce a full inventory to final options. */
export function buildOfficialPostingSemanticOptions(inventory, selectedIds) {
  if (!Array.isArray(inventory) || inventory.some(item => !item || !/^C[1-9]\d*$/u.test(item.id))
    || new Set(inventory.map(item => item.id)).size !== inventory.length) throw inventoryError('Official source inventory identifiers are invalid.');
  if (!Array.isArray(selectedIds) || selectedIds.length > OFFICIAL_POSTING_SEMANTIC_OPTION_CAP
    || selectedIds.some(id => typeof id !== 'string') || new Set(selectedIds).size !== selectedIds.length) {
    throw inventoryError('An official posting shortlist must contain up to eight distinct inventory identifiers.');
  }
  const selected = new Set(selectedIds);
  if (selectedIds.some(id => !inventory.some(item => item.id === id))) throw inventoryError('An official posting shortlist contains an unknown inventory identifier.');
  const candidates = inventory.filter(item => selected.has(item.id));
  return {
    options: candidates.map((item, index) => ({ ...item, candidateId: item.id, id: `P${index + 1}` })),
    candidateIds: candidates.map(item => item.id),
  };
}
