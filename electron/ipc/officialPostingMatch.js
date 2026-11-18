import { normalizeCountry, normalizeLocationInput } from '../../src/utils/jobLocation.js';
import { officialHttpsUrl } from './officialPostingFields.js';
import { strictEmployerEqual, strictEmployerTokens } from './officialSourceHosts.js';

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

/** One stated, non-remote place: not a list ("Burnaby | Vancouver"), a work mode, or "Multiple locations". */
export function isSingleStatedPlace(value) {
  const parts = locationParts(value);
  return !parts.remote && !parts.unknown && parts.places.length === 1;
}

/**
 * The one place every posting merged into a consolidated row names, or null. Boards spell one city differently
 * ("Burnaby" and "Burnaby, British Columbia, Canada"), and consolidation then labels the row "Multiple locations"
 * although all its postings are in the same place. Only when every variant states a location, none is remote, and
 * every pair is compatible is the most specific spelling returned; otherwise the row really spans places (or one is
 * unknown) and stays unresolved.
 */
export function consolidatedSinglePlace(job) {
  const variants = Array.isArray(job?.postingVariants) ? job.postingVariants : [];
  if (variants.length < 2) return null;
  const stated = variants.map(variant => text(variant?.location));
  if (stated.some(place => !place)) return null;
  const places = [...new Set(stated)];
  // A variant that itself lists several places ("Vancouver | Toronto") is not one place.
  if (!places.every(isSingleStatedPlace)) return null;
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) if (!locationsCompatible({ location: places[i] }, { location: places[j] })) return null;
  }
  const detail = place => place.split(',').filter(part => part.trim()).length;
  return places.slice().sort((a, b) => detail(b) - detail(a) || b.length - a.length || a.localeCompare(b))[0];
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
const STRICT_ROLE_HEADING_PARTS = [
  'responsibilit\\w*', 'requirements?', 'qualifications?', 'duties', 'you\\s+will', 'who\\s+you\\s+are', 'the\\s+role', 'in\\s+this\\s+(?:role|position)',
  'what\\s+you(?:[’\']ll|\\s+will|\\s+bring|\\s+need|\\s+have)', 'what\\s+we(?:[’\']re|\\s+are)\\s+looking\\s+for', 'your\\s+(?:role|responsibilities)',
  'about\\s+(?:the|this)\\s+(?:role|team|job|position|opportunity|internship)', 'about\\s+you(?:rself)?',
  '(?:role|position|job)\\s+(?:overview|summary|description|purpose|details|duties|responsibilities|requirements)',
  '(?:key|main|primary|core|essential|principal)\\s+(?:responsibilit\\w*|dut(?:y|ies)|functions?|requirements?|qualifications?|skills?)',
  '(?:minimum|basic|preferred|required|desired|additional|bonus)\\s+(?:qualifications?|requirements?|skills?|experience)',
];
const STRICT_ROLE_HEADING = new RegExp(`^(?:${STRICT_ROLE_HEADING_PARTS.join('|')})\\b`, 'iu');
const ROLE_HEADING = new RegExp(`^(?:${[...STRICT_ROLE_HEADING_PARTS,
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
const HEADING_CONNECTORS = new Set(['a', 'an', 'and', 'or', 'of', 'the', 'to', 'for', 'in', 'on', 'at', 'with', 'by', 'you', 'your', 'we', 'our', 'will', 'do', 'be', 'is', 'are', 'what', 'how', 'who']);
/** A short heading may use sentence case: no list marker, terminal sentence punctuation, or more than eight words. */
function headingLine(raw, strict = false) {
  if (LIST_MARKER.test(raw)) return false;
  const line = text(raw).replace(/^#+\s*/u, '').replace(/:$/u, '');
  const words = line.split(' ');
  return line.length > 0 && line.length <= 80 && words.length <= 8 && !/[.!?;,]$/u.test(line) && /^[\p{Lu}\p{N}]/u.test(line)
    && (!strict || words.every(word => /^[\p{Lu}\p{N}&(]/u.test(word) || HEADING_CONNECTORS.has(word.toLocaleLowerCase().replace(/[’'].*$/u, ''))));
}
const COMPANY_REGION_MAX_WORDS = 128;
function roleDescription(value, { metadata = false, strict = false } = {}) {
  const cap = strict ? Infinity : COMPANY_REGION_MAX_WORDS;
  const lines = String(value ?? '').normalize('NFKC').split(/\r\n?|\n/u);
  // A heading ends a company region only when it introduces a paragraph: a run of short headings is a list ("Paid Time Off").
  const introducesBody = from => {
    for (let index = from + 1; index < lines.length; index++) if (lines[index].trim()) return !headingLine(lines[index], strict);
    return false;
  };
  let boilerplate = false; let companyWords = 0; let hadCompanyRegion = false; const role = [];
  lines.forEach((line, lineIndex) => {
    const parts = line.split(/(?<=[.!?])\s+/u);
    for (const part of parts) {
      const sentence = text(part).replace(/^#+\s*/u, '');
      if (!sentence) continue;
      if ((strict ? STRICT_ROLE_HEADING : ROLE_HEADING).test(sentence)) boilerplate = false;
      else if (companyHeading(sentence)) {
        boilerplate = true; hadCompanyRegion = true; companyWords = normalizedDescription(sentence).length;
        if (companyWords <= cap) continue;
        boilerplate = false;
      }
      else if (boilerplate && parts.length === 1 && !COMPANY_SUBHEADING.test(sentence) && headingLine(line, strict) && introducesBody(lineIndex)) boilerplate = false;
      if (boilerplate) {
        companyWords += normalizedDescription(sentence).length;
        if (companyWords > cap) boilerplate = false;
      }
      if (!boilerplate && !BOILERPLATE_SENTENCE.test(sentence)) role.push(sentence);
    }
  });
  const retained = role.join(' ');
  return metadata ? { retained, hadCompanyRegion } : retained;
}
const descriptionGrams = words => new Set(words.slice(0, -4).map((_, index) => words.slice(index, index + 5).join(' ')));
const ANCHOR_CONTAINMENT = 0.85;
const WEAK_CONTAINMENT = 0.6;
// The cache holds a full board of postings (a cache smaller than the pool is worthless under a cyclic scan). Memory stays bounded by BOTH an entry count
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
/** Containment of the SCRAPED text's distinctive grams in the official text.
 * There is no bilateral minimum: Google often shows a partial or reformatted
 * description. A short official stub still cannot contain a full scraped text. */
function scoreDescription(scrapedText, officialText) {
  const x = roleGrams(scrapedText); const y = roleGrams(officialText);
  const shared = [...x].filter(run => y.has(run)).length;
  const containment = x.size ? shared / x.size : 0; const coverageRight = y.size ? shared / y.size : 0;
  const sufficient = normalizedDescription(scrapedText).length >= 40 && normalizedDescription(officialText).length >= 40 && shared >= 12;
  return { score: containment, containment, shared, coverageLeft: containment, coverageRight,
    anchored: sufficient && containment >= ANCHOR_CONTAINMENT, weak: sufficient && containment >= WEAK_CONTAINMENT };
}
export function descriptionOverlap(left, right) {
  return scoreDescription(left, right);
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
function frozenEmployerName(scrapedCompany, verifiedEmployer) {
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
