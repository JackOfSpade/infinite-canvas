import { normalizeCountry, normalizeLocationInput } from '../../src/utils/jobLocation.js';
import { parseGuaranteedCashOffer } from './jobCompensation.js';
import { officialHttpsUrl } from './officialPostingFields.js';
import { extractAtsTenant, isAggregatorHost, strictEmployerEqual, strictEmployerTokens } from './officialSourceHosts.js';

const text = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const key = value => text(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const TITLE_ABBREVIATIONS = new Map([['sr', 'senior'], ['jr', 'junior'], ['eng', 'engineer'], ['dev', 'developer']]);

/** Exact title identity, after presentation suffixes rather than role words. */
export function coreTitle(value, { company = '', location = '' } = {}) {
  let title = text(value);
  const suppliedPlaces = [typeof location === 'object' ? location?.display : location,
    ...(typeof location === 'object' ? [location?.remoteCountry] : [])]
    .flatMap(place => String(place ?? '').split(/\s*\|\s*/u)).filter(Boolean);
  const places = [...new Set(suppliedPlaces.flatMap(place => {
    const parsed = normalizeLocationInput(place.replace(/\b(?:remote|hybrid|on[- ]?site)\b/giu, '').replace(/^[\s,()–—-]+|[\s,()–—-]+$/gu, ''));
    return [place, parsed.boardReady, parsed.city, parsed.subdivision, parsed.country].filter(Boolean);
  }))].sort((a, b) => b.length - a.length);
  // Several boards append a pay/equity blurb after the title. A currency or
  // explicit pay label is required; level numbers remain identity-bearing.
  title = title.replace(/\s*(?:[-–—|,(]\s*)?(?:[$€£]|(?:USD|CAD|US\$|CA\$|C\$)\s*\d|(?:salary|pay|compensation|equity)\s*[:$€£\d])[^]*$/iu, '');
  title = title.replace(/\s+(?:[-–—|]\s*)?at\s+[^]+$/iu, '');
  if (company) title = title.replace(new RegExp(`\\s*[-–—|]\\s*${escape(text(company))}\\s*$`, 'iu'), '');
  for (let pass = 0; pass < 3; pass++) {
    title = title.replace(/\s*(?:[-–—|,]\s*)?\(?\b(?:remote|hybrid|on[- ]?site)\b(?:\s*[-–—,:]\s*[^()]+)?\)?\s*$/iu, '');
    for (const place of places) title = title.replace(new RegExp(`\\s*(?:[-–—|,]|\\()\\s*${escape(text(place))}\\)?\\s*$`, 'iu'), '');
  }
  return key(title).split(' ').map(token => TITLE_ABBREVIATIONS.get(token) || token).filter(Boolean).join(' ');
}

function locationParts(value) {
  const location = value && typeof value === 'object' ? value : { display: value };
  const display = text(location?.display);
  const remote = location.remote === true || location.workMode === 'remote' || /\b(?:remote|work from home)\b/iu.test(display);
  const mode = remote ? 'remote' : /hybrid/iu.test(location.workMode || display) ? 'hybrid' : /on[- ]?site/iu.test(location.workMode || display) ? 'onsite' : '';
  const explicitRemoteCountry = text(location.remoteCountry);
  const cleaned = display.replace(/\b(?:remote|hybrid|on[- ]?site|work from home)\b/giu, '').replace(/^[\s,()|:–—-]+|[\s,()|:–—-]+$/gu, '');
  const places = cleaned.split(/\s*[|;]\s*|\s+or\s+/iu).filter(Boolean).map(place => normalizeLocationInput(place));
  const unknown = !places.length || /^(?:multiple|various|several)\s+locations?$/iu.test(cleaned);
  const remoteCountry = explicitRemoteCountry || (remote && places.length === 1 ? places[0].country : '');
  return { remote, mode, remoteCountry: key(normalizeCountry(remoteCountry)), remoteRegion: key(location.remoteRegion), places, unknown,
    worldwide: /^(?:worldwide|global|anywhere)$/iu.test(explicitRemoteCountry || cleaned || location.remoteRegion) };
}
function placesAgree(left, right) {
  if (left.countryConflict || right.countryConflict) return false;
  if (left.country && right.country && key(left.country) !== key(right.country)) return false;
  if (left.subdivision && right.subdivision && key(left.subdivision) !== key(right.subdivision)) return false;
  // A country shared with a more specific place does not establish that city
  // or region. Compare at the most specific stated level on either side.
  if (left.city || right.city) return Boolean(left.city && right.city && key(left.city) === key(right.city));
  if (left.subdivision || right.subdivision) return Boolean(left.subdivision && right.subdivision && key(left.subdivision) === key(right.subdivision));
  return Boolean(left.country && right.country);
}
/** Every stated city/region/country constrains a match; unknown is no proof. */
export function locationsCompatible(row, candidate) {
  const locationOf = value => value?.location !== undefined
    ? { ...value, ...(typeof value.location === 'object' ? value.location : { display: value.location }) }
    : value;
  const left = locationParts(locationOf(row)); const right = locationParts(locationOf(candidate));
  if (left.remote !== right.remote) return false;
  if (left.mode && right.mode && left.mode !== right.mode) return false;
  if (left.remote) {
    if (left.worldwide || right.worldwide) return left.worldwide && right.worldwide;
    if (!left.remoteCountry || !right.remoteCountry || left.remoteCountry !== right.remoteCountry) return false;
    if (left.remoteRegion && right.remoteRegion && left.remoteRegion !== right.remoteRegion) return false;
    return true;
  }
  if (left.unknown || right.unknown) return false;
  return left.places.some(a => right.places.some(b => placesAgree(a, b)));
}

function schoolWithinDistrict(row, namedSchool) {
  // A district posting a teacher at its own named school is an ordinary
  // school location, not evidence of an employment intermediary. Require the
  // school/district identity to be explicit in the description.
  const district = text(row?.company); const description = text(row?.snippet || row?.description);
  return /\b(?:school\s+district|district\s+school\s+board|public\s+schools|school\s+board)\b/iu.test(district)
    && /\b(?:teacher|educator|principal|teaching)\b/iu.test(row?.title || '')
    && /\b(?:school|academy|elementary|secondary)\b/iu.test(namedSchool)
    && description.toLocaleLowerCase().includes(namedSchool.toLocaleLowerCase())
    && description.toLocaleLowerCase().includes(district.toLocaleLowerCase())
    && /\b(?:part\s+of|within|operated\s+by|belongs\s+to|school\s+in)\b/iu.test(description);
}
/** S1 and S2 corroborate one title signal; S3 is never employer proof. */
export function posterEmployerSignals(row = {}) {
  const company = text(row.company); const description = text(row.snippet || row.description).slice(0, 800);
  // Keep heading boundaries for organization subjects. Flattening a company
  // heading into the next sentence can invent a doubled employer name.
  const subjectText = String(row.snippet || row.description || '').normalize('NFKC')
    .replace(/\r\n?/gu, '\n').replace(/[^\S\n]+/gu, ' ').trim().slice(0, 800);
  const suffix = text(row.title).match(/\s+at\s+(.+?)\s*$/iu)?.[1] || '';
  const S1 = suffix && !strictEmployerEqual(suffix, company) && !schoolWithinDistrict(row, suffix) ? suffix : '';
  let S2 = '';
  try {
    const url = new URL(row.url || row.googleCardUrl);
    if (/(?:^|\.)linkedin\.com$/iu.test(url.hostname)) {
      const slug = decodeURIComponent(url.pathname).match(/-at-(.+?)-at-(.+?)-\d+\/?$/iu);
      if (slug) {
        const first = slug[1].replace(/-/gu, ' '); const second = slug[2].replace(/-/gu, ' ');
        const different = strictEmployerEqual(second, company) && !strictEmployerEqual(first, company) ? first
          : strictEmployerEqual(first, company) && !strictEmployerEqual(second, company) ? second : '';
        if (different && !schoolWithinDistrict(row, different)) S2 = different;
      }
    }
  } catch { /* A malformed scraped link supplies no signal. */ }
  const S3 = /\b(?:on\s+behalf\s+of|our\s+clients?|our\s+customers?|recruiting\s+for|hiring\s+for)\b/iu.test(description);
  const organization = String.raw`([\p{Lu}][\p{L}\p{N}&'’.-]*(?:[^\S\r\n]+(?:(?:of|the|and|&)[^\S\r\n]+)?[\p{Lu}][\p{L}\p{N}&'’.-]*){0,7})`;
  const subjects = [
    ...subjectText.matchAll(new RegExp(`\\bCompany\\s+Description\\s*[:–—-]?\\s*${organization}[^\\S\\r\\n]+is\\b`, 'gu')),
    ...subjectText.matchAll(new RegExp(`(?:^|[.!?]\\s+|\\n+)${organization}[^\\S\\r\\n]+is\\s+(?:a|an|the)\\b`, 'gu')),
  ].map(match => match[1].replace(/^Company\s+Description\s+/u, '')).filter(name => !strictEmployerEqual(name, company) && !/^(?:the\s+role|the\s+job|our\s+client|our\s+company|company\s+description)$/iu.test(name) && !schoolWithinDistrict(row, name));
  const S4 = [...new Map(subjects.map(name => [strictEmployerTokens(name).join(' '), name])).values()];
  const hypotheses = [...new Map([S1, S2, ...S4].filter(Boolean).map(name => [strictEmployerTokens(name).join(' '), name])).values()];
  return { S1, S2, S3, S4, strongCount: S1 || S2 ? 1 : 0, hypotheses, pointsAway: Boolean(S1 || S2 || S4.length || S3) };
}
export function resolveScrapedEmployer(row = {}) {
  const signals = posterEmployerSignals(row);
  const strong = signals.S1 || signals.S2;
  const titleSignalsAgree = !(signals.S1 && signals.S2) || strictEmployerEqual(signals.S1, signals.S2);
  const corroborated = signals.S3 && strong && titleSignalsAgree && signals.S4.length === 1 && strictEmployerEqual(strong, signals.S4[0]);
  if (corroborated) return { level: 'L5', employer: text(signals.S4[0]).slice(0, 120), postedBy: text(row.company), signals };
  if (signals.pointsAway) return { level: 'L6', employer: '', postedBy: text(row.company), signals };
  return { level: 'L5', employer: text(row.company).slice(0, 120), postedBy: '', signals };
}

const normalizedDescription = value => text(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean);
/** Five-word runs resist generic shared vocabulary. Threshold is deliberately
 * conservative: >=6 unique shared runs and >=60% containment, with >=40 words
 * on each side. Synthetic twin/evergreen controls pin this calibration. */
export function descriptionOverlap(left, right) {
  const a = normalizedDescription(left); const b = normalizedDescription(right);
  const grams = words => new Set(words.slice(0, -4).map((_, i) => words.slice(i, i + 5).join(' ')));
  const x = grams(a); const y = grams(b); const shared = [...x].filter(run => y.has(run)).length;
  const score = Math.min(x.size, y.size) ? shared / Math.min(x.size, y.size) : 0;
  return { score, shared, anchored: a.length >= 40 && b.length >= 40 && shared >= 6 && score >= 0.6 };
}
function description(row) { return text(row?.description || row?.snippet); }
function salaryOffer(row) {
  const salary = row?.salary;
  const provenance = typeof salary === 'object' ? salary?.provenance : row?.salaryProvenance;
  if (provenance !== 'posted') return null;
  const location = typeof row?.location === 'object' ? row.location.display : row?.location;
  const offer = parseGuaranteedCashOffer({ ...row, salary: typeof salary === 'object' ? salary?.text : salary, location }, location);
  const cashText = typeof salary === 'object' ? salary?.text : salary;
  const cadence = /\b(?:hour|hourly|hr)\b|\/h\b/iu.test(cashText) ? 'hourly'
    : /\b(?:week|weekly|wk)\b/iu.test(cashText) ? 'weekly'
      : /\b(?:month|monthly|mo)\b/iu.test(cashText) ? 'monthly' : /\b(?:day|daily)\b/iu.test(cashText) ? 'daily' : 'annual';
  // A location-based currency guess is useful market context, but supplies
  // neither exact equality nor a conflict between two posted cash offers.
  return offer.usable && !offer.currencyInferredFromLocation ? { ...offer, cadence } : null;
}
function identifier(row) {
  const value = row?.identifier ?? row?.requisitionId ?? row?.reqId;
  return key(typeof value === 'object' ? value?.value : value);
}
export function verifiedTieBreakerMatch(scrapedText, officialText, answer) {
  if (!answer || answer.sameJob !== true || !Array.isArray(answer.matchingPairs) || answer.matchingPairs.length < 3 || !Array.isArray(answer.conflicts) || answer.conflicts.length) return false;
  const a = text(scrapedText); const b = text(officialText);
  const positionsA = []; const positionsB = []; const seen = new Set();
  for (const pair of answer.matchingPairs) {
    const left = text(pair?.scrapedQuote); const right = text(pair?.officialQuote);
    if ((left.match(/[\p{L}\p{N}]+/gu) || []).length < 8 || (right.match(/[\p{L}\p{N}]+/gu) || []).length < 8) return false;
    const atA = a.indexOf(left); const atB = b.indexOf(right);
    if (atA < 0 || atB < 0 || seen.has(`${atA}|${atB}`)) return false;
    seen.add(`${atA}|${atB}`); positionsA.push([atA, atA + left.length]); positionsB.push([atB, atB + right.length]);
  }
  // Distinct parts must be disjoint passages in both texts, rather than three
  // overlapping excerpts carved out of one sentence.
  const separated = (spans, length) => new Set(spans.map(([at]) => Math.min(2, Math.floor(at * 3 / length)))).size >= 2
    && spans.some((a, index) => spans.some((b, other) => index !== other && (a[1] <= b[0] || b[1] <= a[0])));
  return separated(positionsA, a.length) && separated(positionsB, b.length);
}
export function frozenEmployerName(scrapedCompany, verifiedEmployer) {
  const original = text(scrapedCompany);
  if (strictEmployerEqual(original, verifiedEmployer) && original.length <= 120 && !/[<>;]|https?:\/\//iu.test(original)) return original;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>;–—-]|https?:\/\//iu.test(String(verifiedEmployer ?? ''))) return '';
  const verified = text(verifiedEmployer);
  return verified && verified.length <= 120 && !/[<>;–—-]|https?:\/\//iu.test(verified) ? verified : '';
}
export function frozenOfficialEmployer(row, verifiedEmployer) {
  return frozenEmployerName(row?.company, verifiedEmployer);
}

export function evaluateOfficialPostingMatch(row, candidate, { now = Date.now(), tieBreaker = null, employerHypotheses = [] } = {}) {
  const reject = (reason, hardPassed = false) => ({ passed: false, hardPassed, hardPass: hardPassed, reason, reasons: [reason], anchors: [] });
  const url = officialHttpsUrl(candidate?.sourceUrl || candidate?.url);
  if (!url || isAggregatorHost(new URL(url).hostname)) return reject('unsafe-url');
  const employer = text(candidate?.employer || candidate?.hiringOrganization?.name);
  const signals = posterEmployerSignals(row);
  const hypotheses = [row?.employer || row?.company, ...signals.hypotheses,
    ...(Array.isArray(employerHypotheses) ? employerHypotheses : [])].filter(name => typeof name === 'string' && name);
  if (!hypotheses.some(name => strictEmployerEqual(name, employer))) return reject('employer-mismatch');
  if (!coreTitle(row?.title, { company: row?.company, location: row?.location })
    || coreTitle(row.title, { company: row.company, location: row.location }) !== coreTitle(candidate?.title, { company: employer, location: candidate?.location })) return reject('title-mismatch');
  if (!locationsCompatible(row, candidate)) return reject('location-mismatch');
  const tenant = extractAtsTenant(url) || (candidate?.ats && candidate?.tenant ? { ats: candidate.ats, tenant: candidate.tenant } : null);
  const identityPointsAway = Boolean(signals.S1 || signals.S2 || signals.S4.length);
  if (strictEmployerEqual(employer, row?.company) && (identityPointsAway || (signals.S3 && tenant))) return reject('poster-tenant');
  if (candidate?.posterTenant === true || (candidate?.posterTenant && candidate.posterTenant === (candidate?.tenant || tenant?.tenant))) return reject('poster-tenant');
  if (tenant && candidate?.tenantProven !== true) return reject('tenant-unproven');
  const portal = new URL(url);
  const officialPortal = candidate?.officialPortalProven === true
    && (portal.hostname === 'usajobs.gov' || portal.hostname === 'www.usajobs.gov')
    && /^\/job\/\d+\/?$/u.test(portal.pathname) && strictEmployerEqual(employer, row?.company);
  if (!tenant && candidate?.employerDomainProven !== true && !officialPortal) return reject('tenant-unproven');
  const instant = typeof now === 'function' ? Number(now()) : Number(now);
  const expiry = candidate?.validThrough ? Date.parse(candidate.validThrough) : null;
  if ((expiry !== null && (!Number.isFinite(expiry) || expiry < instant))
    || !(candidate?.live === true || candidate?.isListed === true || candidate?.listed === true || candidate?.statusCode === 200)) return reject('closed');
  const scrapedPay = salaryOffer(row); const officialPay = salaryOffer(candidate);
  const payEqual = scrapedPay && officialPay && ['min', 'max', 'currency', 'period', 'cadence'].every(field => scrapedPay[field] === officialPay[field]);
  if (scrapedPay && officialPay && !payEqual) return reject('salary-mismatch', true);
  const sameIdentifier = identifier(row) && identifier(row) === identifier(candidate);
  const overlap = descriptionOverlap(description(row), description(candidate));
  const anchor = payEqual ? 'salary-anchor' : sameIdentifier ? 'identifier-anchor' : overlap.anchored ? 'description-anchor' : '';
  if (anchor) return { passed: true, hardPassed: true, hardPass: true, anchor, anchors: [anchor], reasons: [], employer, candidate };
  if (tieBreaker && verifiedTieBreakerMatch(description(row), description(candidate), tieBreaker)) return { passed: true, hardPassed: true, hardPass: true, anchor: 'quoted-match', anchors: ['quoted-match'], reasons: [], employer, candidate };
  return reject(tieBreaker ? 'invalid-quotes' : 'no-anchor', true);
}
export function selectOfficialPostingMatch(row, candidates, { now = Date.now(), tieBreakers = null, employerHypotheses = [] } = {}) {
  const unique = [...new Map((Array.isArray(candidates) ? candidates : []).map(candidate => [officialHttpsUrl(candidate?.sourceUrl || candidate?.url), candidate]).filter(([url]) => url)).values()];
  const evaluations = unique.map(candidate => ({ candidate, ...evaluateOfficialPostingMatch(row, candidate, {
    now, employerHypotheses, tieBreaker: tieBreakers instanceof Map ? tieBreakers.get(candidate.sourceUrl || candidate.url) : null,
  }) }));
  const passing = evaluations.filter(result => result.passed);
  const unresolved = evaluations.filter(result => result.hardPassed && result.reason === 'no-anchor');
  if (passing.length === 1 && !unresolved.length) return { outcome: 'found', candidate: passing[0].candidate, alternatives: [], evaluations };
  const ambiguous = passing.length > 1 || (passing.length + unresolved.length > 1);
  const alternatives = ambiguous ? [...passing, ...unresolved].slice(0, 12).map(({ candidate }) => ({ url: candidate.sourceUrl || candidate.url, title: text(candidate.title) })) : [];
  return { outcome: ambiguous ? 'ambiguous' : 'not-found', candidate: null, alternatives, evaluations };
}
