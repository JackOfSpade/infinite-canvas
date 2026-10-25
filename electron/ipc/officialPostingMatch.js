import { normalizeCountry, normalizeLocationInput } from '../../src/utils/jobLocation.js';
import { parseGuaranteedCashOffer } from './jobCompensation.js';
import { normalizeApplyOptions, officialHttpsUrl } from './officialPostingFields.js';
import { extractAtsTenant, isAggregatorHost, isPosterAtsTenant, strictEmployerEqual, strictEmployerTokens } from './officialSourceHosts.js';

const text = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const key = value => text(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const TITLE_ABBREVIATIONS = new Map([['sr', 'senior'], ['jr', 'junior'], ['eng', 'engineer'], ['dev', 'developer']]);

/** Exact title identity, after presentation suffixes rather than role words. */
export function coreTitle(value, { company = '', location = '', employerHypotheses = [] } = {}) {
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
  if (company) title = title.replace(new RegExp(`\\s*[-–—|]\\s*${escape(text(company))}\\s*$`, 'iu'), '');
  for (let pass = 0; pass < 3; pass++) {
    title = title.replace(/\s*[-–—|]\s*(?:hiring|apply)\s+now\s*$/iu, '');
    title = title.replace(/\s*(?:[-–—|,]\s*)?\(?\b(?:remote|hybrid|on[- ]?site)\b(?:\s*[-–—,:]\s*[^()]+)?\)?\s*$/iu, '');
    for (const place of places) title = title.replace(new RegExp(`\\s*(?:[-–—|,]|\\()\\s*${escape(text(place))}\\)?\\s*$`, 'iu'), '');
    const employerSuffix = title.match(/\s+(?:[-–—|]\s*)?at\s+(.+)$/iu);
    if (employerSuffix && [company, ...(Array.isArray(employerHypotheses) ? employerHypotheses : [])]
      .some(name => name && strictEmployerEqual(employerSuffix[1], name))) title = title.slice(0, employerSuffix.index);
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
const SIGNAL_GENERIC_WORDS = new Set(('this it there that these those our your their we you the a an role job position opportunity mission vision '
  + 'communication collaboration teamwork remote hybrid onsite sql python javascript typescript java ruby rust go excel experience education '
  + 'knowledge proficiency familiarity software engineer engineering developer manager analyst senior junior staff principal team store site scale edge').split(' '));
function employerPresentationTokens(value) { return strictEmployerTokens(value).filter(token => token !== 'the'); }
function employerPresentationRelated(left, right, { subset = false } = {}) {
  const a = employerPresentationTokens(left); const b = employerPresentationTokens(right);
  if (!a.length || !b.length) return false;
  const smaller = a.length <= b.length ? a : b; const larger = a.length <= b.length ? b : a;
  return subset ? smaller.every(token => larger.includes(token)) : smaller.every((token, index) => token === larger[index]);
}
function plausibleOrganization(value, following = '') {
  const tokens = employerPresentationTokens(value);
  if (!tokens.length || SIGNAL_GENERIC_WORDS.has(tokens[0]) || tokens.every(token => SIGNAL_GENERIC_WORDS.has(token))) return false;
  const organizationNoun = /\b(?:labs?|works|systems|group|partners|technologies|solutions|company|corporation|organization|organisation|provider|business|agency|firm|startup|university|college|hospital|institute|nonprofit)\b/iu;
  return organizationNoun.test(tokens.join(' ')) || organizationNoun.test(following.split(/[.!?](?:\s|$)/u)[0]);
}
/** S1 and S2 corroborate one title signal; S3 is never employer proof. */
export function posterEmployerSignals(row = {}) {
  const company = text(row.company); const description = text(row.snippet || row.description).slice(0, 800);
  // Keep heading boundaries for organization subjects. Flattening a company
  // heading into the next sentence can invent a doubled employer name.
  const subjectText = String(row.snippet || row.description || '').normalize('NFKC')
    .replace(/\r\n?/gu, '\n').replace(/[^\S\n]+/gu, ' ').trim().slice(0, 800);
  const rawSuffix = text(row.title).match(/\s+at\s+(.+?)\s*$/iu)?.[1] || '';
  const suffix = rawSuffix ? coreTitle(rawSuffix.replace(/\s*(?:[|–—-]\s*)?(?:hiring|apply)\s+now\s*$/iu, ''), { location: row.location }) : '';
  const S1 = suffix && !SIGNAL_GENERIC_WORDS.has(employerPresentationTokens(suffix)[0])
    && !employerPresentationRelated(suffix, company) && !schoolWithinDistrict(row, suffix) ? suffix : '';
  let S2 = '';
  try {
    const url = new URL(row.url || row.googleCardUrl);
    if (/(?:^|\.)linkedin\.com$/iu.test(url.hostname)) {
      const slug = decodeURIComponent(url.pathname).match(/-at-(.+?)-at-(.+?)-\d+\/?$/iu);
      if (slug) {
        const first = slug[1].replace(/-/gu, ' '); const second = slug[2].replace(/-/gu, ' ');
        const slugEqualsCompany = value => strictEmployerEqual(value, company.replace(/&/gu, ' '));
        const different = slugEqualsCompany(second) && !slugEqualsCompany(first) ? first
          : slugEqualsCompany(first) && !slugEqualsCompany(second) ? second : '';
        if (different && !schoolWithinDistrict(row, different)) S2 = different;
      }
    }
  } catch { /* A malformed scraped link supplies no signal. */ }
  const organization = String.raw`([\p{Lu}][\p{L}\p{N}&'’.-]*(?:[^\S\r\n]+(?:(?:of|the|and|&)[^\S\r\n]+)?[\p{Lu}][\p{L}\p{N}&'’.-]*){0,7})`;
  const namedRecruiting = [...description.matchAll(new RegExp(`\\b(?:recruiting|hiring)\\s+for\\s+${organization}`, 'gu'))]
    .some(match => plausibleOrganization(match[1], 'company') && !employerPresentationRelated(match[1], company, { subset: true }));
  const S3 = /\bour\s+client\b|\bon\s+behalf\s+of\s+(?:(?:our|a|the)\s+)?client\b/iu.test(description) || namedRecruiting;
  const subjects = [
    ...subjectText.matchAll(new RegExp(`\\bCompany\\s+Description\\s*[:–—-]?\\s*${organization}[^\\S\\r\\n]+is\\b`, 'gu')),
    ...subjectText.matchAll(new RegExp(`(?:^|[.!?]\\s+|\\n+)${organization}[^\\S\\r\\n]+is\\s+(?:a|an|the)\\b`, 'gu')),
  ].filter(match => plausibleOrganization(match[1].replace(/^Company\s+Description\s+/u, ''), subjectText.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 100)))
    .map(match => match[1].replace(/^Company\s+Description\s+/u, '')).filter(name => !employerPresentationRelated(name, company, { subset: true }) && !schoolWithinDistrict(row, name));
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

// T13: scrapers that drop the separator at a heading or line boundary glue words together ("About this roleTeam Overview"). Split a
// lower-to-upper case change and punctuation glued to a letter in BOTH texts before the five-word runs are built.
const normalizedDescription = value => text(value).replace(/([\p{Ll}])(\p{Lu})/gu, '$1 $2').replace(/([.!?:;,])(\p{L})/gu, '$1 $2')
  .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean);
// A recognized company, benefits or EEO heading opens a boilerplate region that runs until a role heading. "About <Name>" opens one
// only when it names an organization: it is tested case-sensitively for a capitalized name (under /i, \p{Lu} matches any letter, so
// "About this role" once opened a region and dropped the whole role summary) and never for the role-bearing continuations below.
const BOILERPLATE_HEADING = /^(?:about\s+(?:us|(?:the|our|this)\s+(?:company|organization)|what\s+we\s+do|how\s+we\s+work)|(?:our\s+)?benefits|what\s+we\s+offer|compensation\s+(?:and|&)\s+benefits|(?:equal\s+(?:employment\s+)?opportunity|diversity\s+(?:and|&)\s+inclusion))\b/iu;
// Other company sub-headings never open a region. Inside one they keep it open instead of reading as a short role heading.
const COMPANY_SUBHEADING = /^(?:perks|eeo|total\s+rewards|who\s+we\s+are|life\s+at|why\s+(?:join|work)|our\s+(?:mission|values|culture|story|vision|people)|company\s+(?:overview|description|culture|values|background|profile))\b/iu;
const ABOUT_SUBJECT = /^about\s+(\S.*)$/iu;
const ROLE_ABOUT_SUBJECT = /^(?:this|these|your?|you|yourself|our\s+team|what|working|why|how|who|(?:the\s+)?(?:job|role|position|opportunity|team|internship|work))\b/iu;
const ROLE_HEADING = new RegExp(`^(?:${[
  'responsibilit\\w*', 'requirements?', 'qualifications?', 'duties', 'you\\s+will', 'who\\s+you\\s+are', 'the\\s+role', 'in\\s+this\\s+(?:role|position)',
  'what\\s+you(?:[’\']ll|\\s+will|\\s+bring|\\s+need|\\s+have)', 'what\\s+we(?:[’\']re|\\s+are)\\s+looking\\s+for', 'your\\s+(?:role|responsibilities)',
  'about\\s+(?:the|this)\\s+(?:role|team|job|position|opportunity|internship)', 'about\\s+you(?:rself)?',
  '(?:role|position|job)\\s+(?:overview|summary|description|purpose|details|duties|responsibilities|requirements)',
  '(?:key|main|primary|core|essential|principal)\\s+(?:responsibilit\\w*|dut(?:y|ies)|functions?|requirements?|qualifications?|skills?)',
  '(?:minimum|basic|preferred|required|desired|additional|bonus)\\s+(?:qualifications?|requirements?|skills?|experience)',
  'overview', 'summary', 'description', 'the\\s+opportunity', 'your\\s+(?:impact|day\\s+to\\s+day)',
  'a\\s+day\\s+in\\s+the\\s+life', 'who\\s+we[’\']re\\s+looking\\s+for', 'why\\s+this\\s+role\\s+matters',
].join('|')})\\b`, 'iu');
const BOILERPLATE_SENTENCE = /^(?:(?:we|our\s+company)\s+(?:offer|value|welcome|celebrate|are\s+(?:an?\s+)?equal)|(?:[\p{L}\p{N}&'’.-]+\s+){0,8}is\s+an?\s+equal\s+opportunity|all\s+(?:qualified\s+)?applicants\b|(?:qualified\s+)?applicants\s+(?:will\s+receive|are\s+considered)|reasonable\s+accommodations?\b|(?:health|medical|dental|vision|parental\s+leave|paid\s+time\s+off)\s+(?:coverage|insurance|benefits?)\b)/iu;
const LIST_MARKER = /^([ \t]*)(?:(?:[*•·●○◦▪▫■□‣⁃-]|\d{1,3}[.)])(?:[ \t]+|$))+/u;
function companyHeading(sentence) {
  if (BOILERPLATE_HEADING.test(sentence)) return true;
  const subject = ABOUT_SUBJECT.exec(sentence)?.[1];
  return Boolean(subject) && /^\p{Lu}/u.test(subject) && !ROLE_ABOUT_SUBJECT.test(subject);
}
/** A short heading may use sentence case: no list marker, terminal sentence punctuation, or more than eight words. */
function headingLine(raw) {
  if (LIST_MARKER.test(raw)) return false;
  const line = text(raw).replace(/^#+\s*/u, '').replace(/:$/u, '');
  const words = line.split(' ');
  return line.length > 0 && line.length <= 80 && words.length <= 8 && !/[.!?;,]$/u.test(line) && /^[\p{Lu}\p{N}]/u.test(line);
}
const COMPANY_REGION_MAX_WORDS = 128;
function roleDescription(value, { metadata = false } = {}) {
  const lines = String(value ?? '').normalize('NFKC').split(/\r\n?|\n/u);
  // A heading ends a company region only when it introduces a paragraph: a run of short headings is a list ("Paid Time Off").
  const introducesBody = from => {
    for (let index = from + 1; index < lines.length; index++) if (lines[index].trim()) return !headingLine(lines[index]);
    return false;
  };
  let boilerplate = false; let companyWords = 0; let hadCompanyRegion = false; const role = [];
  lines.forEach((line, lineIndex) => {
    const parts = line.split(/(?<=[.!?])\s+/u);
    for (const part of parts) {
      const sentence = text(part).replace(/^#+\s*/u, '');
      if (!sentence) continue;
      if (ROLE_HEADING.test(sentence)) boilerplate = false;
      else if (companyHeading(sentence)) {
        boilerplate = true; hadCompanyRegion = true; companyWords = normalizedDescription(sentence).length;
        if (companyWords <= COMPANY_REGION_MAX_WORDS) continue;
        boilerplate = false;
      }
      else if (boilerplate && parts.length === 1 && !COMPANY_SUBHEADING.test(sentence) && headingLine(line) && introducesBody(lineIndex)) boilerplate = false;
      if (boilerplate) {
        companyWords += normalizedDescription(sentence).length;
        if (companyWords > COMPANY_REGION_MAX_WORDS) boilerplate = false;
      }
      if (!boilerplate && !BOILERPLATE_SENTENCE.test(sentence)) role.push(sentence);
    }
  });
  const retained = role.join(' ');
  return metadata ? { retained, hadCompanyRegion } : retained;
}
const descriptionGrams = words => new Set(words.slice(0, -4).map((_, index) => words.slice(index, index + 5).join(' ')));
function companyStrippingPreservesAnchor(scraped, official) {
  if (![scraped, official].some(source => roleDescription(source, { metadata: true }).hadCompanyRegion)) return true;
  // A company region can swallow an unrecognized role summary, even when
  // shared requirements are most of the source; a cap alone can instead leak
  // huge company copy. Require exact containment of the unstripped text as
  // corroboration before either effect can name a posting by description.
  const left = descriptionGrams(normalizedDescription(scraped)); const right = descriptionGrams(normalizedDescription(official));
  if (!left.size || !right.size) return false;
  const smaller = left.size <= right.size ? left : right; const larger = left.size <= right.size ? right : left;
  return [...smaller].every(gram => larger.has(gram));
}
// Amendment 3, section 2. A gram is boilerplate when it occurs in at least
// max(3, 20%) of the fetched peer postings on the host or tenant. Fewer than
// four peers cannot estimate that, so only the recognized sections go.
const BOILERPLATE_MIN_PEERS = 4;
const BOILERPLATE_MIN_COUNT = 3;
const ANCHOR_CONTAINMENT = 0.85;
const WEAK_CONTAINMENT = 0.6;
const RIVAL_MARGIN = 0.05;
const SMALL_POOL_NESTING = 0.98;
const EPSILON = 1e-9;
// Every evaluation re-derives the grams of the whole fetched peer pool, so the cache must hold a full board: a cache smaller than the
// pool is worthless under a cyclic scan (the oldest entry is always the next one needed). Memory stays bounded by BOTH an entry count
// and a total weight (grams plus the retained source string), and the least recently used entries leave first.
const GRAM_CACHE_MAX_ENTRIES = 4096;
const GRAM_CACHE_MAX_WEIGHT = 1_500_000;
const gramCache = new Map();
let gramCacheWeight = 0;
function roleGrams(value) {
  const source = String(value ?? '');
  const known = gramCache.get(source);
  if (known) {
    // A Map iterates in insertion order, so re-inserting a hit marks it most recently used.
    gramCache.delete(source); gramCache.set(source, known);
    return known.grams;
  }
  const grams = descriptionGrams(normalizedDescription(roleDescription(source)));
  const weight = grams.size + Math.ceil(source.length / 80) + 1;
  if (weight > GRAM_CACHE_MAX_WEIGHT) return grams;
  gramCache.set(source, { grams, weight }); gramCacheWeight += weight;
  for (const [oldest, entry] of gramCache) {
    if (gramCache.size <= GRAM_CACHE_MAX_ENTRIES && gramCacheWeight <= GRAM_CACHE_MAX_WEIGHT) break;
    gramCache.delete(oldest); gramCacheWeight -= entry.weight;
  }
  return grams;
}
const gramCacheStats = () => ({ entries: gramCache.size, weight: gramCacheWeight, maxEntries: GRAM_CACHE_MAX_ENTRIES, maxWeight: GRAM_CACHE_MAX_WEIGHT });
/** The frequency estimate and whether the pool can support one: a peer that contributes no five-word run (a stub, a cleared text) is not a peer. */
function boilerplateEstimate(peerTexts) {
  const peers = (Array.isArray(peerTexts) ? peerTexts : []).map(roleGrams).filter(grams => grams.size);
  if (peers.length < BOILERPLATE_MIN_PEERS) return { grams: new Set(), estimable: false };
  const threshold = Math.max(BOILERPLATE_MIN_COUNT, Math.ceil(peers.length / 5));
  const counts = new Map();
  for (const grams of peers) for (const gram of grams) counts.set(gram, (counts.get(gram) || 0) + 1);
  return { grams: new Set([...counts].filter(([, count]) => count >= threshold).map(([gram]) => gram)), estimable: true };
}
const boilerplateGrams = peerTexts => boilerplateEstimate(peerTexts).grams;
/** Containment of the SCRAPED text's distinctive grams in the official text.
 * There is no bilateral minimum: Google often shows a partial or reformatted
 * description. A short official stub still cannot contain a full scraped text. */
function scoreDescription(scrapedText, officialText, boilerplate) {
  const distinctive = grams => new Set([...grams].filter(run => !boilerplate.has(run)));
  const x = distinctive(roleGrams(scrapedText)); const y = distinctive(roleGrams(officialText));
  const shared = [...x].filter(run => y.has(run)).length;
  const containment = x.size ? shared / x.size : 0; const coverageRight = y.size ? shared / y.size : 0;
  const sufficient = normalizedDescription(scrapedText).length >= 40 && normalizedDescription(officialText).length >= 40 && shared >= 12;
  return { score: containment, containment, shared, coverageLeft: containment, coverageRight,
    anchored: sufficient && containment >= ANCHOR_CONTAINMENT, weak: sufficient && containment >= WEAK_CONTAINMENT };
}
export function descriptionOverlap(left, right, { peerDescriptions = [] } = {}) {
  return scoreDescription(left, right, boilerplateGrams(peerDescriptions));
}
function description(row) { return String(row?.description || row?.snippet || ''); }
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
const QUOTE_FUNCTION_WORDS = new Set(('a an the and or but for from to in on at by of with as that this these those is are was were be been being '
  + 'will would can could should may might must has have had do does did we our us you your they their it its who which when where how').split(' '));
function substantialQuoteVocabulary(left, right) {
  const vocabulary = value => new Set(normalizedDescription(roleDescription(value)).filter(word => word.length > 2 && !QUOTE_FUNCTION_WORDS.has(word)));
  const a = vocabulary(left); const b = vocabulary(right); const shared = [...a].filter(word => b.has(word)).length;
  return shared >= 4 && shared / Math.max(a.size, b.size) >= 0.35;
}
// Quote normalization. A host-fetched official text arrives as converter output ("* item", "1. item", upper-cased headings) while the
// model quotes plain prose, so BOTH texts and BOTH quotes are compared in the same plain form. Only presentation is removed: leading list
// markers at line starts (LIST_MARKER, above), typographic quotes and dashes, non-breaking spaces and whitespace runs. Wording and word order are untouched.
/** Plain form shown to the model: list markers and typographic variants removed, case and line breaks kept. */
export function plainPostingText(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/[‘’‚‛′]/gu, "'").replace(/[“”„‟″]/gu, '"').replace(/[‐‑‒–—―−]/gu, '-')
    .split(/\r\n?|\n/u).map(line => line.replace(LIST_MARKER, '$1')).join('\n');
}
/** The plain form with whitespace collapsed: what the host compares verbatim (case-sensitive). */
export const flatPostingText = value => plainPostingText(value).replace(/\s+/gu, ' ').trim();

/** A quote pair is rejected only when a quote is boilerplate (the section 2
 * frequency) or also occurs in another candidate that passes every hard gate.
 * Without gate information (`rivalDescriptions` omitted) every peer counts.
 * Quotes are located in the normalized, case-folded texts. */
export function verifiedTieBreakerMatch(scrapedText, officialText, answer, { peerDescriptions = [], rivalDescriptions = null } = {}) {
  if (!answer || answer.sameJob !== true || !Array.isArray(answer.matchingPairs) || answer.matchingPairs.length < 3 || !Array.isArray(answer.conflicts) || answer.conflicts.length) return false;
  const a = flatPostingText(scrapedText).toLocaleLowerCase(); const b = flatPostingText(officialText).toLocaleLowerCase();
  const boilerplate = boilerplateGrams(peerDescriptions);
  const boilerplateQuote = quote => {
    const grams = descriptionGrams(normalizedDescription(quote));
    return grams.size > 0 && [...grams].filter(gram => boilerplate.has(gram)).length * 2 >= grams.size;
  };
  const rivals = (Array.isArray(rivalDescriptions) ? rivalDescriptions : Array.isArray(peerDescriptions) ? peerDescriptions : [])
    .map(value => ` ${normalizedDescription(flatPostingText(value)).join(' ')} `);
  const positionsA = []; const positionsB = []; const seen = new Set();
  for (const pair of answer.matchingPairs) {
    const left = flatPostingText(pair?.scrapedQuote); const right = flatPostingText(pair?.officialQuote);
    if ((left.match(/[\p{L}\p{N}]+/gu) || []).length < 8 || (right.match(/[\p{L}\p{N}]+/gu) || []).length < 8) return false;
    if (!substantialQuoteVocabulary(left, right) || boilerplateQuote(left) || boilerplateQuote(right)
      || rivals.some(rival => rival.includes(` ${normalizedDescription(left).join(' ')} `) || rival.includes(` ${normalizedDescription(right).join(' ')} `))) return false;
    const foldedLeft = left.toLocaleLowerCase(); const foldedRight = right.toLocaleLowerCase();
    const atA = a.indexOf(foldedLeft); const atB = b.indexOf(foldedRight);
    if (atA < 0 || atB < 0 || seen.has(`${atA}|${atB}`)) return false;
    seen.add(`${atA}|${atB}`); positionsA.push([atA, atA + foldedLeft.length]); positionsB.push([atB, atB + foldedRight.length]);
  }
  // Distinct parts must be disjoint passages in both texts, rather than three
  // overlapping excerpts carved out of one sentence.
  const separated = (spans, length) => new Set(spans.map(([at]) => Math.min(2, Math.floor(at * 3 / length)))).size >= 2
    && spans.some((a, index) => spans.some((b, other) => index !== other && (a[1] <= b[0] || b[1] <= a[0])));
  return separated(positionsA, a.length) && separated(positionsB, b.length);
}
/** Fetched postings on the candidate's host or tenant, one entry per URL.
 * Same-requisition duplicates of the candidate are not peers. */
function peerPostings(candidate, candidates) {
  const url = officialHttpsUrl(candidate?.sourceUrl || candidate?.url);
  if (!url) return [];
  const routeOf = item => extractAtsTenant(item.sourceUrl || item.url)
    || (item.ats && item.tenant ? { ats: item.ats, tenant: item.tenant } : null);
  const route = routeOf(candidate); const host = new URL(url).hostname;
  const byUrl = new Map();
  for (const peer of Array.isArray(candidates) ? candidates : []) {
    if (!peer || peer === candidate) continue;
    const peerUrl = officialHttpsUrl(peer.sourceUrl || peer.url);
    if (!peerUrl || peerUrl === url) continue;
    if (identifier(candidate) && identifier(candidate) === identifier(peer)
      && strictEmployerEqual(candidate.employer || candidate.hiringOrganization?.name, peer.employer || peer.hiringOrganization?.name)) continue;
    const peerRoute = routeOf(peer);
    const sameSite = route || peerRoute
      ? Boolean(route && peerRoute && route.ats === peerRoute.ats && text(route.tenant).toLocaleLowerCase() === text(peerRoute.tenant).toLocaleLowerCase())
      : new URL(peerUrl).hostname === host;
    if (!sameSite) continue;
    const known = byUrl.get(peerUrl);
    if (!known) byUrl.set(peerUrl, peer);
    else {
      const richer = description(peer).length > description(known).length ? peer : known;
      byUrl.set(peerUrl, { ...richer, employer: richer.employer || peer.employer || known.employer });
    }
  }
  return [...byUrl.values()].filter(peer => description(peer));
}
function postingIsLive(item, instant) {
  const expiry = item?.validThrough ? Date.parse(item.validThrough) : null;
  return !(expiry !== null && (!Number.isFinite(expiry) || expiry < instant))
    && (item?.live === true || item?.isListed === true || item?.listed === true || item?.statusCode === 200);
}
// Amendment 3, section 4. Only the row's own scraped url or its own apply
// options count. Description text and bridge candidates never do.
const TRACKING_PARAMETER = new RegExp(`^(?:${[
  'utm_.*', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'igshid', 'twclid', 'ttclid', 'yclid', 'mc_.*', '_hs.*', '_ga.*', '_gl', 'li_.*',
  'ref', 'referrer', 'referral', 'source', 'source_?id', 'src', 'src_?id', 'job_?source', 'trk', 'trk_?id', 'trid', 'tracking.*', 'sid', 'cmpid', 'campaign.*', 'medium', 's_cid',
  'lever-.*', 'gh_src', '__jv.*', 'iis', 'iisn', 'ccuid', 'codes', 'rx_(?:source|medium|campaign|ch|group|r|ts|viewer)', 'lang', 'locale', 'language', 'hl',
].join('|')})$`, 'iu');
// A display-mode flag (iCIMS "mode=job") names no posting, but any other "mode" value is kept.
const DISPLAY_MODE_VALUE = /^(?:job|apply|view)$/iu;
// The apply page of a posting is the same posting: only a trailing /apply, /application or /applications/new segment goes, never a whole path.
const APPLY_PAGE_SUFFIX = /\/(?:apply|application|applications\/new)$/iu;
export function canonicalLeadUrl(value) {
  const href = officialHttpsUrl(value);
  if (!href) return '';
  const url = new URL(href);
  // Every parameter that is not known tracking identifies the posting: an unknown job-id name must not collapse two postings.
  const kept = [...url.searchParams].filter(([name, setting]) => {
    const parameter = name.replace(/\[\]$/u, '');
    return !TRACKING_PARAMETER.test(parameter) && !(/^mode$/iu.test(parameter) && DISPLAY_MODE_VALUE.test(setting));
  }).sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
  const query = new URLSearchParams(kept).toString();
  const path = url.pathname.replace(/\/+$/u, '');
  return `${url.origin}${path.replace(APPLY_PAGE_SUFFIX, '') || path || '/'}${query ? `?${query}` : ''}`;
}
function leadIdentity(row, candidate) {
  const target = canonicalLeadUrl(candidate?.sourceUrl || candidate?.url);
  if (!target) return false;
  const leads = [row?.url, ...normalizeApplyOptions(row?.applyOptions).map(option => option.href)];
  return leads.some(lead => canonicalLeadUrl(lead) === target);
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

export function evaluateOfficialPostingMatch(row, candidate, { now = Date.now(), tieBreaker = null, employerHypotheses = [], peerCandidates = [] } = {}) {
  const reject = (reason, hardPassed = false) => ({ passed: false, hardPassed, hardPass: hardPassed, reason, reasons: [reason], anchors: [] });
  const url = officialHttpsUrl(candidate?.sourceUrl || candidate?.url);
  if (!url || isAggregatorHost(new URL(url).hostname)) return reject('unsafe-url');
  const employer = text(candidate?.employer || candidate?.hiringOrganization?.name);
  const signals = posterEmployerSignals(row);
  const hypotheses = [row?.employer || row?.company, ...signals.hypotheses,
    ...(Array.isArray(employerHypotheses) ? employerHypotheses : [])].filter(name => typeof name === 'string' && name);
  if (!hypotheses.some(name => strictEmployerEqual(name, employer))) return reject('employer-mismatch');
  if (!coreTitle(row?.title, { company: row?.company, location: row?.location, employerHypotheses: hypotheses })
    || coreTitle(row.title, { company: row.company, location: row.location, employerHypotheses: hypotheses }) !== coreTitle(candidate?.title, { company: employer, location: candidate?.location })) return reject('title-mismatch');
  if (!locationsCompatible(row, candidate)) return reject('location-mismatch');
  const tenant = extractAtsTenant(url) || (candidate?.ats && candidate?.tenant ? { ats: candidate.ats, tenant: candidate.tenant } : null);
  const identityPointsAway = Boolean(signals.S1 || signals.S2 || signals.S4.length);
  const ownEmployer = strictEmployerEqual(employer, row?.company);
  if (ownEmployer && (identityPointsAway || signals.S3)) return reject('poster-tenant');
  if ((!ownEmployer || signals.S3) && tenant && isPosterAtsTenant(tenant, row?.company)) return reject('poster-tenant');
  if (candidate?.posterTenant === true || (candidate?.posterTenant && candidate.posterTenant === (candidate?.tenant || tenant?.tenant))) return reject('poster-tenant');
  if (tenant && candidate?.tenantProven !== true) return reject('tenant-unproven');
  const portal = new URL(url);
  const officialPortal = candidate?.officialPortalProven === true
    && (portal.hostname === 'usajobs.gov' || portal.hostname === 'www.usajobs.gov')
    && /^\/job\/\d+\/?$/u.test(portal.pathname) && strictEmployerEqual(employer, row?.company);
  if (!tenant && candidate?.employerDomainProven !== true && !officialPortal) return reject('tenant-unproven');
  const instant = typeof now === 'function' ? Number(now()) : Number(now);
  if (!postingIsLive(candidate, instant)) return reject('closed');
  const scrapedPay = salaryOffer(row); const officialPay = salaryOffer(candidate);
  const payEqual = scrapedPay && officialPay && ['min', 'max', 'currency', 'period', 'cadence'].every(field => scrapedPay[field] === officialPay[field]);
  if (scrapedPay && officialPay && !payEqual) return reject('salary-mismatch', true);
  const sameIdentifier = identifier(row) && identifier(row) === identifier(candidate);
  const accept = anchor => ({ passed: true, hardPassed: true, hardPass: true, anchor, anchors: [anchor], reasons: [], employer, candidate });
  // Deterministic anchors that name this exact posting: its requisition id or the board's own link for this card.
  if (sameIdentifier || leadIdentity(row, candidate)) return accept('identifier-anchor');
  const peers = peerPostings(candidate, peerCandidates);
  const rowTitle = coreTitle(row.title, { company: row.company, location: row.location, employerHypotheses: hypotheses });
  const peerTitle = peer => coreTitle(peer.title, { company: text(peer.employer || peer.hiringOrganization?.name) || employer, location: peer.location });
  // T3: same-title postings in other cities are twins, not company-wide copy; they never feed the frequency estimate.
  const frequencyPool = peers.filter(peer => peerTitle(peer) !== rowTitle);
  const peerDescriptions = frequencyPool.map(description);
  // Small means the frequency estimate itself is unavailable: stub peers that contribute no text do not make a pool large.
  const { grams: boilerplate, estimable } = boilerplateEstimate(peerDescriptions);
  const smallPool = !estimable;
  const own = scoreDescription(description(row), description(candidate), boilerplate);
  const sameIdentity = peer => {
    const peerEmployer = text(peer.employer || peer.hiringOrganization?.name) || employer;
    return (!postingIsLive(peer, instant) || hypotheses.some(name => strictEmployerEqual(name, peerEmployer)))
      && peerTitle(peer) === rowTitle && locationsCompatible(row, peer);
  };
  const rivals = peers.filter(sameIdentity).map(peer => ({ peer, live: postingIsLive(peer, instant),
    ...scoreDescription(description(row), description(peer), boilerplate) }));
  const best = rivals.reduce((top, rival) => Math.max(top, rival.containment), 0);
  const top = Math.max(own.containment, best);
  // The scraped job is the closed posting: never anchor its live sibling.
  if (rivals.some(rival => !rival.live && rival.anchored && rival.containment >= top - EPSILON)) return { ...reject('no-anchor'), closedWinner: true };
  // A live posting that anchors and beats this one by the margin is the match.
  if (rivals.some(rival => rival.live && rival.anchored && rival.containment - own.containment >= RIVAL_MARGIN - EPSILON)) return { ...reject('no-anchor'), outranked: true };
  // T1: equal posted pay never overrides the closed-twin and outranked checks (pay bands are shared by same-title postings).
  if (payEqual) return accept('salary-anchor');
  const leads = own.containment - best >= RIVAL_MARGIN - EPSILON;
  if (own.anchored && leads && (!smallPool || Math.max(own.containment, own.coverageRight) >= SMALL_POOL_NESTING)
    && companyStrippingPreservesAnchor(description(row), description(candidate))) return accept('description-anchor');
  // T6: a quote shared with ANY same-identity twin, closed or live, is not evidence for this posting.
  const rivalDescriptions = rivals.map(rival => description(rival.peer));
  if (tieBreaker && verifiedTieBreakerMatch(description(row), description(candidate), tieBreaker, { peerDescriptions, rivalDescriptions })) return accept('quoted-match');
  return reject(tieBreaker ? 'invalid-quotes' : 'no-anchor', true);
}
export function selectOfficialPostingMatch(row, candidates, { now = Date.now(), tieBreakers = null, employerHypotheses = [], peerCandidates = [] } = {}) {
  const unique = [...new Map((Array.isArray(candidates) ? candidates : []).map(candidate => [officialHttpsUrl(candidate?.sourceUrl || candidate?.url), candidate]).filter(([url]) => url)).values()];
  const evaluations = unique.map(candidate => ({ candidate, ...evaluateOfficialPostingMatch(row, candidate, {
    now, employerHypotheses, peerCandidates: [...unique, ...(Array.isArray(peerCandidates) ? peerCandidates : [])], tieBreaker: tieBreakers instanceof Map ? tieBreakers.get(candidate.sourceUrl || candidate.url) : null,
  }) }));
  // T12: one requisition represented on two URLs (the ATS board and the employer's embed page) is one posting, not two rivals.
  // A placeholder identifier (fewer than four characters) never merges anything.
  const mentions = (item, id) => id.length >= 6 && new RegExp(`(?<![\\p{L}\\p{N}])${escape(id)}(?![\\p{L}\\p{N}])`, 'iu').test(item.candidate.sourceUrl || item.candidate.url || '');
  const sameRequisition = (a, b) => strictEmployerEqual(a.candidate.employer || a.candidate.hiringOrganization?.name, b.candidate.employer || b.candidate.hiringOrganization?.name)
    && ((identifier(a.candidate).length >= 4 && identifier(a.candidate) === identifier(b.candidate))
      || (identifier(a.candidate) && mentions(b, identifier(a.candidate))) || (identifier(b.candidate) && mentions(a, identifier(b.candidate))));
  const merge = list => [...list].sort((a, b) => Number(Boolean(b.candidate.tenantProven)) - Number(Boolean(a.candidate.tenantProven)))
    .filter((item, index, all) => !all.slice(0, index).some(earlier => sameRequisition(earlier, item)));
  const passing = merge(evaluations.filter(result => result.passed));
  // A requisition id or the card's own apply link names this exact posting. A same-title sibling that merely failed to anchor is not a
  // rival of that: only a sibling that itself passes (it is then in `passing`) makes the outcome ambiguous, whatever order the pages were read in.
  // A placeholder identifier (fewer than four characters) names nothing, as in the requisition merge above.
  const named = evaluations.some(result => result.passed && result.anchor === 'identifier-anchor'
    && (leadIdentity(row, result.candidate) || (identifier(row).length >= 4 && identifier(row) === identifier(result.candidate))));
  const unresolved = named ? [] : merge(evaluations.filter(result => result.hardPassed && result.reason === 'no-anchor'))
    .filter(item => !passing.some(winner => sameRequisition(winner, item)));
  if (passing.length === 1 && !unresolved.length) return { outcome: 'found', candidate: passing[0].candidate, alternatives: [], evaluations };
  const ambiguous = passing.length > 1 || (passing.length + unresolved.length > 1);
  const alternatives = ambiguous ? [...passing, ...unresolved].slice(0, 12).map(({ candidate }) => ({ url: candidate.sourceUrl || candidate.url, title: text(candidate.title) })) : [];
  const closed = !ambiguous && !passing.length && evaluations.some(result => result.closedWinner);
  return { outcome: ambiguous ? 'ambiguous' : closed ? 'closed' : 'not-found', candidate: null, alternatives, evaluations };
}

export const __debug = { boilerplateGrams, roleGrams, gramCacheStats, descriptionGrams, normalizedDescription, roleDescription, substantialQuoteVocabulary, text, scoreDescription };
