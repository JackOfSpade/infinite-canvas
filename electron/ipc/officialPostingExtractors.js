// Pure parsers for host-fetched posting data. No page code or network runs here.
import { JSDOM } from 'jsdom';
import { parse as parseHtml } from 'parse5';
import { htmlToText } from 'html-to-text';
import { walkJsonLdJobPostings } from '../extractors/jobPostingJsonLd.js';
import { decodeHtmlEntities } from '../../src/utils/textEncoding.js';
import { normalizeCountry } from '../../src/utils/jobLocation.js';
import { extractAtsTenant } from './officialSourceHosts.js';

const MAX_RAW_BYTES = 3 * 1024 * 1024;
const plain = value => typeof value === 'string' ? value.trim() : '';
const array = value => Array.isArray(value) ? value : value == null ? [] : [value];
const unknownSalary = () => ({ text: '', provenance: 'unknown' });

function rawText(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_RAW_BYTES || body.includes('\0')) {
    const error = new Error('Official posting source is not bounded raw text.');
    error.code = 'OFFICIAL_POSTING_EXTRACTION_REJECTED';
    throw error;
  }
  return body;
}

function structured(body) {
  try { return JSON.parse(rawText(body)); } catch { return null; }
}

function plainDescription(value) {
  return typeof value === 'string' ? rawText(value).replace(/\r\n?/gu, '\n').trim() : '';
}

export function officialDescriptionText(value, { encoded = false } = {}) {
  const source = rawText(typeof value === 'string' ? value : '');
  const fragment = JSDOM.fragment(encoded ? decodeHtmlEntities(source) : source);
  for (const node of fragment.querySelectorAll('script,style,template,noscript')) node.remove();
  // Reject pathological nesting instead of letting the converter shorten it.
  const elements = fragment.querySelectorAll('*');
  for (const element of elements) {
    let depth = 0;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) depth += 1;
    if (depth > 50) throw new Error('Official posting markup is too deeply nested.');
  }
  const container = fragment.ownerDocument.createElement('div');
  container.append(fragment);
  return htmlToText(container.innerHTML, {
    wordwrap: false,
    limits: { maxInputLength: Infinity, maxDepth: 60, maxChildNodes: Infinity },
    selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }],
  }).replace(/\r\n?/gu, '\n').trim();
}

function httpsUrl(value, base) {
  try {
    const url = new URL(String(value || ''), base);
    if (!value || url.protocol !== 'https:' || url.username || url.password) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

function identifier(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return value.map(identifier).filter(Boolean).join(' | ');
  return value && typeof value === 'object' ? identifier(value.value ?? '') : '';
}

function addressText(value) {
  if (typeof value === 'string') return plain(value);
  if (!value || typeof value !== 'object') return '';
  const address = value.address || value.postalAddress || value;
  if (typeof address === 'string') return plain(address);
  const statedCountry = plain(typeof address.addressCountry === 'object' ? address.addressCountry?.name : address.addressCountry);
  // CA is ambiguous only in free text. This field is explicitly a country;
  // leave the independently typed region untouched unless it repeats it.
  const country = normalizeCountry(/^CA$/iu.test(statedCountry) ? 'Canada' : statedCountry);
  const statedRegion = plain(address.addressRegion);
  const region = country && normalizeCountry(statedRegion).toLocaleLowerCase() === country.toLocaleLowerCase() ? '' : statedRegion;
  const parts = [address.addressLocality, region, country].map(plain).filter(Boolean);
  return [...new Set(parts)].join(', ') || plain(value.name);
}

function location(display, { remote = false, workMode = '', remoteCountry = '', remoteRegion = '' } = {}) {
  return { display: plain(display), workMode: workMode || (remote ? 'remote' : ''), remote, remoteCountry: plain(remoteCountry), remoteRegion: plain(remoteRegion) };
}

function jsonLocation(node) {
  const display = [...new Set(array(node.jobLocation).map(addressText).filter(Boolean))].join(' | ');
  const remote = /^TELECOMMUTE$/iu.test(node.jobLocationType || '');
  const countries = array(node.applicantLocationRequirements).map(value => typeof value === 'string' ? value : value?.name).map(plain).filter(Boolean);
  return location(display || (remote ? 'Remote' : ''), { remote, remoteCountry: remote ? [...new Set(countries)].join(' | ') : '' });
}

const SALARY_UNITS = Object.freeze({ YEAR: '/yr', ANNUAL: '/yr', HOUR: '/hr', HOURLY: '/hr', MONTH: '/mo', WEEK: '/wk', DAY: '/day', '1 YEAR': '/yr' });
function numericSalary({ min, max, value, currency = '', interval = '' }) {
  const number = input => ['number', 'string'].includes(typeof input) && String(input).trim() !== ''
    && Number.isFinite(Number(input)) && Number(input) >= 0 ? Number(input) : null;
  const low = number(min); const high = number(max); const fixed = number(value);
  if (low != null && high != null && low > high) return unknownSalary();
  let amount = '';
  if (low != null && high != null) amount = low === high ? String(low) : `${low} - ${high}`;
  else if (fixed != null) amount = String(fixed);
  else if (low != null) amount = `From ${low}`;
  else if (high != null) amount = `Up to ${high}`;
  if (!amount) return unknownSalary();
  return { text: `${plain(currency)} ${amount}${SALARY_UNITS[String(interval).toUpperCase()] || ''}`.trim(), provenance: 'posted' };
}

function jsonSalary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknownSalary();
  const range = value.value && typeof value.value === 'object' ? value.value : value;
  return numericSalary({ min: range.minValue, max: range.maxValue, value: typeof value.value === 'number' ? value.value : range.value, currency: value.currency, interval: range.unitText });
}

function posting(values, options = {}) {
  const sourceUrl = httpsUrl(values.sourceUrl);
  if (!plain(values.title) || !sourceUrl) return null;
  const route = extractAtsTenant(sourceUrl, { html: options.html || '' });
  const validThrough = plain(values.validThrough);
  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  const expiry = validThrough ? Date.parse(validThrough) : Infinity;
  const employer = plain(values.employer);
  return {
    title: plain(values.title), employer,
    hiringOrganization: values.hiringOrganization || { name: employer, sameAs: '' },
    sameAs: values.sameAs || '', location: values.location || location(''), salary: values.salary || unknownSalary(),
    identifier: identifier(values.identifier), validThrough, description: values.description,
    sourceUrl, officialApplyUrl: httpsUrl(values.officialApplyUrl, sourceUrl),
    ats: options.ats || route?.ats || '', tenant: options.tenant || route?.tenant || '',
    isListed: values.isListed !== false, live: values.isListed !== false && Number.isFinite(Number(now)) && expiry >= Number(now),
  };
}

export function extractJsonLdPostings(html, options = {}) {
  rawText(html);
  const canonicalUrl = value => {
    const valid = httpsUrl(value, options.sourceUrl);
    if (!valid) return '';
    const url = new URL(valid);
    for (const key of [...url.searchParams.keys()]) if (/^utm_/iu.test(key)) url.searchParams.delete(key);
    url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return url.href;
  };
  const source = canonicalUrl(options.sourceUrl);
  const nodes = walkJsonLdJobPostings(html);
  const bound = nodes.filter(node => node.url && canonicalUrl(node.url) === source);
  // A related posting's JSON-LD is not this fetched posting. Select one
  // URL-bound node, or one unambiguous node that supplies no URL at all.
  const uniqueBound = [...new Map(bound.map(node => [JSON.stringify(node), node])).values()];
  const selected = uniqueBound.length === 1 ? uniqueBound
    : uniqueBound.length === 0 && nodes.length === 1 && !nodes[0].url ? nodes : [];
  return selected.map(node => posting({
    title: officialDescriptionText(node.title), employer: officialDescriptionText(node.hiringOrganization.name),
    hiringOrganization: node.hiringOrganization, sameAs: node.hiringOrganization.sameAs,
    location: jsonLocation(node), salary: jsonSalary(node.baseSalary), identifier: node.identifier,
    validThrough: node.validThrough, description: officialDescriptionText(node.description),
    sourceUrl: options.sourceUrl, officialApplyUrl: options.sourceUrl,
  }, { ...options, html })).filter(Boolean);
}

function ashbySalary(job) {
  if (job.shouldDisplayCompensationOnJobPostings === false) return unknownSalary();
  const compensation = job.compensation;
  if (!compensation || typeof compensation !== 'object') return unknownSalary();
  if (plain(compensation.scrapeableCompensationSalarySummary)) {
    return { text: officialDescriptionText(compensation.scrapeableCompensationSalarySummary), provenance: 'posted' };
  }
  const salaries = array(compensation.summaryComponents).filter(component => component?.compensationType === 'Salary')
    .map(component => numericSalary({ min: component.minValue, max: component.maxValue, currency: component.currencyCode, interval: component.interval })).filter(item => item.text);
  return salaries.length ? { text: salaries.map(item => item.text).join(' | '), provenance: 'posted' } : unknownSalary();
}

export function extractAshbyPostings(body, options = {}) {
  const data = structured(body);
  if (!data || !Array.isArray(data.jobs)) return [];
  return data.jobs.filter(job => job && typeof job === 'object').map(job => {
    const places = [plain(job.location), ...array(job.secondaryLocations).map(value => typeof value === 'string' ? value : value?.location).map(plain)].filter(Boolean);
    const remote = job.isRemote === true || /^remote$/iu.test(job.workplaceType || '');
    return posting({
      title: job.title, employer: job.hiringOrganization?.name || job.companyName || options.employer || '',
      hiringOrganization: job.hiringOrganization, sameAs: job.hiringOrganization?.sameAs || '',
      location: location([...new Set(places)].join(' | '), { remote, workMode: /^(?:remote|hybrid|onsite)$/iu.test(job.workplaceType || '') ? job.workplaceType.toLowerCase() : '' }),
      salary: ashbySalary(job), identifier: job.id, description: plainDescription(job.descriptionPlain) || officialDescriptionText(job.descriptionHtml),
      sourceUrl: job.jobUrl, officialApplyUrl: job.applyUrl || job.jobUrl, isListed: job.isListed,
    }, { ...options, ats: 'ashby' });
  }).filter(Boolean);
}

export function extractGreenhousePostings(body, options = {}) {
  const data = structured(body);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : data && typeof data === 'object' && !Array.isArray(data) && data.id != null ? [data] : [];
  return jobs.filter(job => job && typeof job === 'object').map(job => {
    const ranges = array(job.pay_input_ranges).map(range => numericSalary({ min: typeof range?.min_cents === 'number' ? range.min_cents / 100 : null, max: typeof range?.max_cents === 'number' ? range.max_cents / 100 : null, currency: range?.currency_type, interval: range?.interval })).filter(salary => salary.text);
    return posting({ title: job.title, employer: job.company_name || options.employer || '',
      location: location(job.location?.name), salary: ranges.length ? { text: ranges.map(range => range.text).join(' | '), provenance: 'posted' } : unknownSalary(),
      identifier: job.requisition_id || job.id, validThrough: job.application_deadline,
      description: officialDescriptionText(job.content, { encoded: true }), sourceUrl: job.absolute_url, officialApplyUrl: job.absolute_url,
    }, { ...options, ats: 'greenhouse' });
  }).filter(Boolean);
}

export function extractLeverPostings(body, options = {}) {
  const data = structured(body);
  const jobs = Array.isArray(data) ? data : data && typeof data === 'object' && data.id != null ? [data] : [];
  return jobs.filter(job => job && typeof job === 'object').map(job => {
    const textOrHtml = (text, html) => plainDescription(text) || officialDescriptionText(html);
    const description = [textOrHtml(job.openingPlain, job.opening), textOrHtml(job.descriptionBodyPlain || job.descriptionPlain, job.descriptionBody || job.description),
      ...array(job.lists).filter(item => item && typeof item === 'object').map(item => [plain(item.text), officialDescriptionText(item.content)].filter(Boolean).join('\n')),
      textOrHtml(job.additionalPlain, job.additional)].filter(Boolean).join('\n\n');
    const range = job.salaryRange;
    return posting({ title: job.text, employer: job.company || options.employer || '',
      location: location([...new Set([plain(job.categories?.location), ...array(job.categories?.allLocations).map(plain)].filter(Boolean))].join(' | '), {
        remote: /^remote$/iu.test(job.workplaceType || ''), workMode: /^(?:remote|hybrid|onsite)$/iu.test(job.workplaceType || '') ? job.workplaceType.toLowerCase() : '',
      }), salary: range && typeof range === 'object' ? numericSalary({ min: range.min, max: range.max, currency: range.currency, interval: range.interval }) : unknownSalary(),
      identifier: job.id, description, sourceUrl: job.hostedUrl, officialApplyUrl: job.applyUrl || job.hostedUrl,
    }, { ...options, ats: 'lever' });
  }).filter(Boolean);
}

export function extractTeamtailorRss(body, options = {}) {
  rawText(body);
  if (/<!DOCTYPE|<!ENTITY/iu.test(body)) return [];
  let document;
  try { document = new JSDOM(body, { contentType: 'text/xml' }).window.document; } catch { return []; }
  if (!document.querySelector('rss > channel')) return [];
  const read = (node, name) => [...node.children].find(child => child.localName === name)?.textContent || '';
  return [...document.querySelectorAll('channel > item')].map(item => {
    const link = httpsUrl(read(item, 'link'), options.sourceUrl);
    const content = read(item, 'encoded') || read(item, 'description');
    const locations = [...item.children].find(child => child.localName === 'locations');
    const places = locations ? [...locations.children].filter(child => child.localName === 'location')
      .map(place => [...new Set([read(place, 'name'), read(place, 'city'), read(place, 'country')].map(plain).filter(Boolean))].join(', ')) : [];
    const remoteStatus = read(item, 'remoteStatus');
    return posting({ title: read(item, 'title'), employer: options.employer || '',
      location: location(places.join(' | ') || read(item, 'location'), {
        remote: remoteStatus === 'fully', workMode: remoteStatus === 'hybrid' ? 'hybrid' : '',
      }), salary: unknownSalary(), identifier: read(item, 'guid'),
      description: officialDescriptionText(content), sourceUrl: link, officialApplyUrl: link,
    }, { ...options, ats: 'teamtailor' });
  }).filter(Boolean);
}

export function scanOfficialCareersPage(html, sourceUrl) {
  rawText(html);
  // Keep JSDOM's script-disabled HTML grammar without constructing browser
  // elements: their inline-style setters parse CSS that this scan never uses.
  const document = parseHtml(html, { scriptingEnabled: false });
  const attributeValue = (node, name) => node.attrs?.find(attribute => attribute.name === name && !attribute.prefix)?.value ?? null;
  const textContent = node => {
    const parts = []; const pending = [node];
    while (pending.length) {
      const child = pending.pop();
      if (child.nodeName === '#text') parts.push(child.value);
      for (let index = (child.childNodes?.length || 0) - 1; index >= 0; index--) pending.push(child.childNodes[index]);
    }
    return parts.join('');
  };
  const links = []; const seen = new Set();
  let siteName = ''; let title = ''; let foundSiteName = false; let foundTitle = false;
  const pending = [document];
  while (pending.length) {
    const node = pending.pop(); const tag = node.tagName;
    if (tag === 'title' && !foundTitle) {
      foundTitle = true; title = plain(textContent(node));
    }
    if (tag === 'meta' && !foundSiteName && attributeValue(node, 'property') === 'og:site_name') {
      foundSiteName = true; siteName = plain(attributeValue(node, 'content'));
    }
    if (tag === 'a' || tag === 'script' || tag === 'iframe') {
      const attribute = tag === 'a' ? 'href' : 'src';
      const url = httpsUrl(attributeValue(node, attribute), sourceUrl);
      if (url && !seen.has(url)) { seen.add(url); links.push({ url, tag, attribute }); }
    }
    // Template content belongs to its separate fragment and was never part of
    // document.querySelectorAll. Ordinary childNodes retain document order.
    for (let index = (node.childNodes?.length || 0) - 1; index >= 0; index--) pending.push(node.childNodes[index]);
  }
  return { links, siteName, title, teamtailor: extractAtsTenant(sourceUrl, { html })?.ats === 'teamtailor' };
}

export function extractOfficialPostingCandidates({ body, sourceUrl, contentType = '', ats = '', tenant = '', employer = '', now } = {}) {
  const options = { sourceUrl, ats, tenant, employer, now };
  const json = /json/iu.test(contentType) || (typeof body === 'string' && /^\s*[[{]/u.test(body));
  if (ats === 'ashby') return json ? extractAshbyPostings(body, options) : extractJsonLdPostings(body, options);
  if (ats === 'greenhouse') return json ? extractGreenhousePostings(body, options) : extractJsonLdPostings(body, options);
  if (ats === 'lever') return json ? extractLeverPostings(body, options) : extractJsonLdPostings(body, options);
  if (ats === 'teamtailor' && /(?:xml|rss)/iu.test(contentType)) return extractTeamtailorRss(body, options);
  // Workday and iCIMS intentionally have no application-state or DOM fallback.
  return extractJsonLdPostings(body, options);
}
