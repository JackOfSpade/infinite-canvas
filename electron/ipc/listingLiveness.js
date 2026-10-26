// Listing-page evidence is deliberately transient. Only the small verdict pair
// belongs on a job row; page text stays in the invocation-local evidence map.
import { stripHtmlToText } from '../../src/utils/textEncoding.js';
import { detectApiAntiBotSignal } from './antiBotDetector.js';
import { coreTitle, flatPostingText } from './officialPostingMatch.js';
import { isAggregatorHost, isKnownAtsHost, normalizedSourceHost } from './officialSourceHosts.js';
import { walkJsonLdJobPostings } from '../extractors/jobPostingJsonLd.js';

const MAX_HTML_CHARS = 3_000_000;
const MAX_PAGE_TEXT_CHARS = 200_000;
const MAX_DESCRIPTION_CHARS = 80_000;
const MAX_CHROME_CHARS = 3_000;
const MAX_HITS = 6;
const MAX_SIGNALS = 6;

const closedRules = Object.freeze([
  Object.freeze({ id: 'no-longer-accepting', pattern: 'no\\s+longer\\s+accepting\\s+applications' }),
  Object.freeze({ id: 'job-no-longer-available', pattern: '(?:this\\s+)?job\\s+is\\s+no\\s+longer\\s+available' }),
  Object.freeze({ id: 'listing-no-longer-available', pattern: '(?:this\\s+)?listing\\s+is\\s+no\\s+longer\\s+available' }),
  Object.freeze({ id: 'no-longer-available', pattern: 'no\\s+longer\\s+available' }),
  Object.freeze({ id: 'job-expired', pattern: '(?:this\\s+)?job\\s+has\\s+expired' }),
  Object.freeze({ id: 'page-not-found', pattern: '(?:page\\s+not\\s+found|we\\s+can[’\x27]t\\s+find\\s+this\\s+page)' }),
  Object.freeze({ id: 'position-filled', pattern: '(?:this\\s+)?position\\s+has\\s+been\\s+filled' }),
]);

const rule = (id, selectors) => Object.freeze({ id, version: 1, state: 'shadow', selectors: Object.freeze(selectors) });
const commonDescriptionSelectors = Object.freeze([
  '#job-details', '#jobDescriptionText', '[data-testid="job-description"]',
  '.jobs-description-content__text', '.jobs-description__content',
  '.jobs-box__html-content', '.description__text', '.show-more-less-html__markup',
  '[itemprop="description"]', '.job-description', '.jobDescription',
]);

function boardRules(descriptionSelectors, openRules, structuralRules = []) {
  return Object.freeze({
    descriptionSelectors: Object.freeze(descriptionSelectors),
    closedRules,
    openRules: Object.freeze(openRules),
    structuralRules: Object.freeze(structuralRules),
  });
}

/** Candidate open controls begin in shadow until independent AI checks calibrate them. */
export const LISTING_LIVENESS_RULES = Object.freeze({
  linkedin: boardRules(
    ['#job-details', '.jobs-description-content__text', '.jobs-description__content', '.jobs-box__html-content', '.description__text', '.show-more-less-html__markup'],
    [rule('linkedin-enabled-apply', ['button.jobs-apply-button', 'a.jobs-apply-button'])],
  ),
  indeed: boardRules(
    ['#jobDescriptionText', '.jobsearch-JobComponent-description', '[data-testid="jobDescriptionText"]'],
    [rule('indeed-enabled-apply', ['#indeedApplyButton', 'button[data-testid="apply-button"]'])],
  ),
  ziprecruiter: boardRules(
    ['[data-testid="job-description"]', '[class~="whitespace-pre-line"]', '.whitespace-pre-line',
      '.job_description', '.job-description', '[itemprop="description"]'],
    [rule('ziprecruiter-enabled-apply', ['button[data-testid="apply-button"]', 'a[data-testid="apply-button"]', '.apply_button'])],
    ['closed_job_redirect', 'workday-posting-unavailable'],
  ),
  dice: boardRules(
    ['[data-testid="job-description"]', '#jobDescription', '.job-description', '[itemprop="description"]'],
    [rule('dice-enabled-apply', ['button[data-testid="apply-button"]', 'a[data-testid="apply-button"]'])],
  ),
  generic: boardRules(
    commonDescriptionSelectors,
    [rule('generic-enabled-apply', ['button[data-testid="apply-button"]', 'a[data-testid="apply-button"]'])],
    ['workday-posting-unavailable'],
  ),
});

const bounded = (value, limit) => String(value ?? '').slice(0, limit);
const flatCase = value => flatPostingText(value).replace(/\p{Cf}/gu, '').toLocaleLowerCase();

function hostClass(url) {
  const host = normalizedSourceHost(url);
  if (!host) return 'other';
  if (isKnownAtsHost(host) || host === 'usajobs.gov' || host.endsWith('.usajobs.gov')) return 'ats';
  return isAggregatorHost(host) ? 'aggregator' : 'other';
}

function nativeListingId(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  if (/(?:^|\.)indeed\./u.test(host)) return parsed.searchParams.get('jk') || null;
  if (/(?:^|\.)linkedin\.com$/u.test(host)) return parsed.pathname.match(/\/jobs\/view\/([^/?#]+)/iu)?.[1] || null;
  if (/(?:^|\.)dice\.com$/u.test(host)) return parsed.pathname.match(/\/job-detail\/([^/?#]+)/iu)?.[1] || null;
  if (/(?:^|\.)ziprecruiter\.com$/u.test(host)) {
    const path = parsed.pathname.replace(/\/+$/u, '');
    if (/^\/(?:jobs\/|c\/[^/]+\/Job\/)/iu.test(path)) {
      return parsed.searchParams.get('jid') || parsed.searchParams.get('lvk')
        || path.split('/').filter(Boolean).at(-1) || null;
    }
  }
  return null;
}

function redirectedAway(requestedUrl, finalUrl) {
  if (!finalUrl || !isAggregatorHost(finalUrl)) return null;
  const id = nativeListingId(requestedUrl);
  if (!id) return null;
  try {
    const destination = new URL(finalUrl);
    return !(`${destination.pathname}${destination.search}`.toLocaleLowerCase().includes(id.toLocaleLowerCase()));
  } catch { return null; }
}

function titleMatchesPage(evidence) {
  const options = { company: evidence.expectedCompany, location: evidence.expectedLocation };
  const want = coreTitle(evidence.expectedTitle, options).split(' ').filter(Boolean);
  const candidates = [evidence.title, evidence.h1].filter(value => String(value || '').trim());
  if (!want.length || !candidates.length) return null;
  return candidates.some(value => {
    const have = new Set(coreTitle(value, options).split(' ').filter(Boolean));
    return want.filter(token => have.has(token)).length >= Math.max(1, Math.ceil(want.length * 0.8));
  });
}

function dateExpired(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const raw = value.trim();
  const expiry = /^\d{4}-\d{2}-\d{2}$/u.test(raw)
    ? Date.parse(`${raw}T23:59:59.999Z`) : Date.parse(raw);
  return Number.isFinite(expiry) && expiry < now;
}

/** The marker check is shared with calibration eligibility; it never decides closure. */
export function listingClosedMarkerPresent(evidence, now = Date.now()) {
  return (Array.isArray(evidence?.closedHits) && evidence.closedHits.some(hit => hit && hit.insideDescription === false))
    || evidence?.jsonLd?.isListed === false
    || dateExpired(evidence?.jsonLd?.validThrough, now);
}

function isZipClosedRedirect(finalUrl) {
  try {
    const parsed = new URL(finalUrl);
    const host = parsed.hostname.toLowerCase();
    return (host === 'ziprecruiter.com' || host.endsWith('.ziprecruiter.com'))
      && parsed.pathname.replace(/\/+$/u, '') === '/jobseeker/home'
      && ['1', 'true', 'yes'].includes(String(parsed.searchParams.get('closed_job_redirect') || '').toLowerCase());
  } catch { return false; }
}

function httpWall(evidence) {
  const status = Number(evidence.httpStatus);
  if (status === 0 || status === 401 || status === 403 || status === 429 || status >= 500) return 'http-status';
  const text = `${evidence.title || ''} ${evidence.chromeText || ''}`;
  if (text.length >= 2_000) return null;
  const signal = detectApiAntiBotSignal({ status: 200, bodyText: text.slice(0, 2_000) });
  return ['api-captcha', 'api-access-denied'].includes(signal?.code) ? signal.code : null;
}

/** Fill derived facts on the Node side, after a closure-free page probe returns. */
export function finalizeListingEvidence(raw = {}, meta = {}) {
  const input = { ...raw, ...meta };
  const evidence = {
    board: bounded(input.board, 40),
    ruleKey: bounded(input.ruleKey || input.board || 'generic', 40),
    requestedUrl: bounded(input.requestedUrl, 2_048),
    finalUrl: input.finalUrl ? bounded(input.finalUrl, 2_048) : null,
    finalHostClass: ['aggregator', 'ats', 'other'].includes(input.finalHostClass) ? input.finalHostClass : null,
    httpStatus: Number.isInteger(input.httpStatus) ? input.httpStatus : null,
    title: bounded(input.title, 500),
    h1: bounded(input.h1, 500),
    expectedTitle: bounded(input.expectedTitle, 500),
    expectedCompany: bounded(input.expectedCompany, 500),
    expectedLocation: input.expectedLocation ?? '',
    wall: input.wall ? bounded(input.wall, 80) : null,
    chromeText: bounded(input.chromeText, MAX_CHROME_CHARS),
    descriptionText: bounded(input.descriptionText, MAX_DESCRIPTION_CHARS),
    descriptionIsPage: input.descriptionIsPage === true,
    closedHits: (Array.isArray(input.closedHits) ? input.closedHits : []).slice(0, MAX_HITS)
      .map(hit => ({ ruleId: bounded(hit.ruleId, 64), insideDescription: hit.insideDescription === true,
        context: bounded(hit.context, 400) })),
    openSignals: (Array.isArray(input.openSignals) ? input.openSignals : []).slice(0, MAX_SIGNALS)
      .map(signal => ({ ruleId: bounded(signal.ruleId, 64), state: signal.state === 'active' ? 'active' : 'shadow' })),
    jsonLd: { validThrough: bounded(input.jsonLd?.validThrough, 64),
      isListed: input.jsonLd?.isListed === true ? true : input.jsonLd?.isListed === false ? false : null },
    workdayPostingAvailable: input.workdayPostingAvailable === true ? true : input.workdayPostingAvailable === false ? false : null,
    redirectedAway: input.redirectedAway === true ? true : input.redirectedAway === false ? false : null,
    titleMatchesPage: input.titleMatchesPage === true ? true : input.titleMatchesPage === false ? false : null,
  };
  // A bare 404 in the document title is a marker for AI review, never a
  // structural close. Keep this separate from HTTP 404/410.
  if (evidence.title.includes('404') && evidence.closedHits.length < MAX_HITS
    && !evidence.closedHits.some(hit => hit.ruleId === 'title-404')) {
    evidence.closedHits.push({ ruleId: 'title-404', insideDescription: false,
      context: evidence.title.slice(0, 400) });
  }
  const finalUrl = evidence.finalUrl || null;
  evidence.finalHostClass = evidence.finalHostClass || hostClass(finalUrl || evidence.requestedUrl);
  evidence.redirectedAway = evidence.redirectedAway === true || evidence.redirectedAway === false
    ? evidence.redirectedAway : redirectedAway(evidence.requestedUrl, finalUrl);
  evidence.titleMatchesPage = evidence.titleMatchesPage === true || evidence.titleMatchesPage === false
    ? evidence.titleMatchesPage : titleMatchesPage(evidence);
  return evidence;
}

/** Pure four-way verdict. Unknown means the visit supplied no usable page. */
export function classifyListingLiveness(rawEvidence = {}, rules = null) {
  const evidence = finalizeListingEvidence(rawEvidence);
  const selectedRules = rules || LISTING_LIVENESS_RULES[evidence.ruleKey] || LISTING_LIVENESS_RULES.generic;
  const wall = evidence.wall || (evidence.httpStatus != null ? httpWall(evidence) : null);
  if (wall) return { verdict: 'unknown', basis: 'wall' };
  if ([404, 410].includes(Number(evidence.httpStatus)) || isZipClosedRedirect(evidence.finalUrl)
    || evidence.workdayPostingAvailable === false) return { verdict: 'closed', basis: 'structural' };
  if (`${evidence.title || ''}${evidence.chromeText || ''}`.trim().length < 80) return { verdict: 'unknown', basis: 'thin' };
  const activeOpen = (selectedRules?.openRules || []).some(ruleEntry => ruleEntry.state === 'active'
    && evidence.openSignals.some(signal => signal.ruleId === ruleEntry.id));
  const eligibleOpen = activeOpen && evidence.redirectedAway !== true && evidence.titleMatchesPage === true;
  if (listingClosedMarkerPresent(evidence)) return { verdict: 'needs-ai', basis: eligibleOpen ? 'both' : 'closed-marker' };
  if (eligibleOpen) return { verdict: 'open', basis: 'open-marker' };
  return { verdict: 'needs-ai', basis: 'neither' };
}

function collectHits(pageText, descriptionText, rules) {
  const hits = [];
  const description = flatCase(descriptionText);
  const flatPage = flatCase(pageText);
  const descriptionStart = description ? flatPage.indexOf(description) : -1;
  const uniqueDescription = descriptionStart >= 0 && flatPage.indexOf(description, descriptionStart + 1) < 0;
  for (const item of rules?.closedRules || []) {
    let pattern;
    try { pattern = new RegExp(item.pattern, 'giu'); } catch { continue; }
    let best = null;
    for (const match of pageText.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      const inner = flatCase(pageText.slice(Math.max(0, start - 40), Math.min(pageText.length, end + 40)));
      const insideDescription = Boolean(inner && description.includes(inner));
      const marker = flatCase(match[0]);
      const markerAt = uniqueDescription ? flatCase(pageText.slice(0, end)).lastIndexOf(marker) : -1;
      const inside = uniqueDescription && markerAt >= 0
        ? markerAt >= descriptionStart && markerAt + marker.length <= descriptionStart + description.length
        : insideDescription;
      const hit = { ruleId: item.id, insideDescription: inside,
        context: pageText.slice(Math.max(0, start - 160), Math.min(pageText.length, end + 160)) };
      if (!best || (best.insideDescription && !inside)) best = hit;
      if (!inside) break;
    }
    if (best) hits.push(best);
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

function jsonLdFromHtml(html) {
  const result = walkJsonLdJobPostings(html, node => ({
    validThrough: typeof node.validThrough === 'string' ? node.validThrough : '',
    isListed: node.isListed === true ? true : node.isListed === false ? false : null,
    description: typeof node.description === 'string' ? node.description : '',
  }));
  return result || { validThrough: '', isListed: null, description: '' };
}

function htmlElementText(html, tag) {
  const match = html.match(new RegExp(`<${tag}(?:\\s[^>]{0,1000})?>([\\s\\S]{0,12000}?)<\\/${tag}\\s*>`, 'iu'));
  return bounded(stripHtmlToText(match?.[1] || '').trim(), 500);
}

function htmlContainerText(html, selectors = []) {
  // The HTML path avoids a DOM allocation for every Dice response. This is a
  // bounded best-effort container read.
  for (const selector of selectors) {
    const fragment = selector.match(/^([#.])([\w-]+)$/u);
    if (!fragment) continue;
    const attr = fragment[1] === '#' ? 'id' : 'class';
    const name = fragment[2].replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const opening = new RegExp(`<([a-z][\\w-]*)\\b[^>]{0,2000}\\b${attr}=["'][^"']*\\b${name}\\b[^"']*["'][^>]*>`, 'iu').exec(html);
    if (!opening) continue;
    const tag = opening[1].toLowerCase();
    const from = opening.index + opening[0].length;
    const tags = /<\s*(\/?)\s*([a-z][\w-]*)\b[^>]*>/giu;
    tags.lastIndex = from;
    let depth = 1;
    let match;
    while ((match = tags.exec(html))) {
      if (match.index - from > MAX_DESCRIPTION_CHARS) break;
      if (match[2].toLowerCase() !== tag) continue;
      if (match[1]) depth -= 1;
      else if (!/\/\s*>$/u.test(match[0])) depth += 1;
      if (depth === 0) return stripHtmlToText(html.slice(from, match.index));
    }
  }
  return '';
}

function htmlOpenSignals(html, rules) {
  // Dice supplies a fetched HTML response, not a page.evaluate DOM. Read only
  // configured apply controls, excluding inert markup and disabled controls.
  const visible = html.replace(/<!--[^]*?-->|<(script|style|template)\b[^>]*>[^]*?<\/\1\s*>/giu, '');
  const controls = [];
  const tags = /<([a-z][\w-]*)\b([^>]{0,2000})>/giu;
  let tag;
  while ((tag = tags.exec(visible)) && controls.length < 4_000) {
    const attributes = new Map();
    const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;
    let attribute;
    while ((attribute = attrPattern.exec(tag[2]))) {
      attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    if (attributes.has('disabled') || attributes.get('aria-disabled') === 'true'
      || attributes.get('aria-hidden') === 'true') continue;
    controls.push({ tag: tag[1].toLowerCase(), attributes });
  }
  const matches = (control, selector) => {
    const byId = selector.match(/^#([\w-]+)$/u);
    if (byId) return control.attributes.get('id') === byId[1];
    const byClass = selector.match(/^([a-z][\w-]*)?\.([\w-]+)$/iu);
    if (byClass) return (!byClass[1] || control.tag === byClass[1].toLowerCase())
      && String(control.attributes.get('class') || '').split(/\s+/u).includes(byClass[2]);
    const byAttr = selector.match(/^([a-z][\w-]*)\[([\w-]+)=["']([^"']+)["']\]$/iu);
    return Boolean(byAttr && control.tag === byAttr[1].toLowerCase()
      && control.attributes.get(byAttr[2].toLowerCase()) === byAttr[3]);
  };
  const signals = [];
  for (const item of rules?.openRules || []) {
    if ((item.selectors || []).some(selector => controls.some(control => matches(control, selector)))) {
      signals.push({ ruleId: item.id, state: item.state === 'active' ? 'active' : 'shadow' });
      if (signals.length >= MAX_SIGNALS) break;
    }
  }
  return signals;
}

function isWholePageDescription({ description, pageText, heading, hasContainer, hasJsonLd, descriptionCapture }) {
  if (descriptionCapture === 'external-page-full-text') return true;
  if (!hasContainer && !hasJsonLd) return true;
  const flatDescription = flatCase(description);
  const flatPage = flatCase(pageText);
  if (flatDescription && flatPage && flatDescription.length > flatPage.length * 0.7) return true;
  return Boolean(heading && flatDescription.includes(flatCase(heading)));
}

/** Parse HTTP-fetched HTML without a per-response JSDOM allocation. */
export function evidenceFromHtml(html, options = {}) {
  const source = bounded(html, MAX_HTML_CHARS);
  const ruleKey = options.ruleKey || options.board || 'generic';
  const rules = options.rules || LISTING_LIVENESS_RULES[ruleKey] || LISTING_LIVENESS_RULES.generic;
  const pageText = bounded(stripHtmlToText(source), MAX_PAGE_TEXT_CHARS);
  const title = htmlElementText(source, 'title');
  const h1 = htmlElementText(source, 'h1');
  const json = jsonLdFromHtml(source);
  const container = htmlContainerText(source, rules.descriptionSelectors);
  const jsonDescription = json.description ? stripHtmlToText(json.description) : '';
  const selectedContainer = container && !(container.length < 80 && jsonDescription.length >= 160) ? container : '';
  const description = bounded(selectedContainer || jsonDescription || options.descriptionText, MAX_DESCRIPTION_CHARS);
  const descriptionIsPage = isWholePageDescription({ description, pageText, heading: h1,
    hasContainer: Boolean(selectedContainer), hasJsonLd: Boolean(json.description), descriptionCapture: options.descriptionCapture });
  const pageLower = pageText.toLocaleLowerCase();
  const titleAt = title ? pageLower.indexOf(title.toLocaleLowerCase()) : -1;
  const headingAt = h1 ? pageLower.indexOf(h1.toLocaleLowerCase(), titleAt >= 0 ? titleAt + title.length : 0) : -1;
  const chromeStart = headingAt >= 0 ? headingAt : 0;
  return finalizeListingEvidence({
    ...options, board: options.board || ruleKey, ruleKey, title, h1,
    chromeText: pageText.slice(chromeStart, chromeStart + MAX_CHROME_CHARS),
    descriptionText: description, descriptionIsPage,
    closedHits: collectHits(pageText, descriptionIsPage ? '' : description, rules),
    openSignals: htmlOpenSignals(source, rules), jsonLd: { validThrough: json.validThrough, isListed: json.isListed },
    workdayPostingAvailable: options.workdayPostingAvailable ?? null,
  });
}

/**
 * Closure-free DOM producer for page.evaluate. Keep every dependency inside
 * this function: JSDOM tests execute its serialized source in isolation.
 */
export function listingLivenessPageProbe({ rules = {}, expectedTitle = '', descriptionCapture = '',
  descriptionText = '', excludeSelectors = [] } = {}) {
  const cap = (value, limit) => String(value ?? '').slice(0, limit);
  const textOf = element => String(element?.innerText ?? element?.textContent ?? '').trim();
  const flat = value => String(value ?? '').normalize('NFKC')
    .replace(/[‘’‚‛′]/gu, "'").replace(/[“”„‟″]/gu, '"').replace(/[‐‑‒–—―−]/gu, '-')
    .replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
  const compact = value => {
    const unlisted = String(value ?? '').normalize('NFKC').replace(/[‐‑‒–—―−]/gu, '-')
      .split(/\r\n?|\n/u).map(line => line.replace(
        /^([ \t]*)(?:(?:[*•·●○◦▪▫■□‣⁃-]|\d{1,3}[.)])(?:[ \t]+|$))+/u, '$1')).join('\n');
    return flat(unlisted).replace(/[^\p{L}\p{N}]+/gu, '');
  };
  const callerExclusions = Array.isArray(excludeSelectors) ? excludeSelectors : [];
  const excluded = new Set();
  for (const selector of ['#__ic-panel', ...callerExclusions]) {
    try {
      document.querySelectorAll(selector).forEach(node => {
        if (node !== document.body && node?.style) excluded.add(node);
      });
    } catch { /* a bad exclusion selector cannot remove page evidence */ }
  }
  const originalStyles = [];
  let body;
  try {
    for (const node of excluded) {
      originalStyles.push([node, node.getAttribute('style')]);
      node.style.setProperty('display', 'none', 'important');
    }
    const hasRenderedText = typeof document.body.innerText === 'string';
    body = cap(textOf(document.body), 200_000);
    // JSDOM has no innerText, so hiding a node does not change its textContent.
    if (!hasRenderedText) {
      for (const node of excluded) {
        const excludedText = textOf(node);
        if (excludedText) body = body.replace(excludedText, ' ');
      }
    }
  } finally {
    for (const [node, style] of originalStyles) {
      if (style === null) node.removeAttribute('style');
      else node.setAttribute('style', style);
    }
  }
  const title = cap(document.title || '', 500);
  const firstH1 = document.querySelector('h1');
  const h1 = cap(textOf(firstH1), 500);
  let container = null;
  for (const selector of rules.descriptionSelectors || []) {
    try { container = document.querySelector(selector); } catch { /* bad selector is not evidence */ }
    if (container) break;
  }
  const descriptionFromContainer = cap(textOf(container), 80_000);
  let json = { validThrough: '', isListed: null, description: '' };
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 16)) {
    let root;
    try { root = JSON.parse(cap(script.textContent, 300_000)); } catch { continue; }
    const nodes = [root];
    for (let index = 0; index < nodes.length && index < 200; index += 1) {
      const node = nodes[index];
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) { nodes.push(...node); continue; }
      const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
      if (types.some(type => typeof type === 'string' && /(?:^|[/#])JobPosting$/u.test(type))) {
        json = { validThrough: typeof node.validThrough === 'string' ? cap(node.validThrough, 64) : '',
          isListed: node.isListed === true ? true : node.isListed === false ? false : null,
          description: typeof node.description === 'string' ? cap(node.description, 80_000) : '' };
        break;
      }
      for (const value of Object.values(node)) if (value && typeof value === 'object') nodes.push(value);
    }
    if (json.description || json.validThrough || json.isListed !== null) break;
  }
  const jsonHost = document.createElement('template');
  jsonHost.innerHTML = json.description;
  const jsonDescriptionText = cap(textOf(jsonHost.content), 80_000);
  const description = cap(descriptionFromContainer || descriptionText || jsonDescriptionText, 80_000);
  const descriptionIsPage = descriptionCapture === 'external-page-full-text'
    || (!container && !json.description)
    || (flat(description) && flat(body) && flat(description).length > flat(body).length * 0.7)
    || Boolean(h1 && flat(description).includes(flat(h1)));
  const expected = flat(expectedTitle);
  let heading = null;
  if (expected) {
    for (const candidate of document.querySelectorAll('h1,h2,h3,[data-testid="job-title"]')) {
      if (flat(textOf(candidate)).includes(expected)) { heading = candidate; break; }
    }
  }
  const headingText = textOf(heading);
  const headingIndex = headingText ? body.toLocaleLowerCase().indexOf(headingText.toLocaleLowerCase()) : -1;
  const chromeText = cap(body.slice(Math.max(0, headingIndex)), 3_000);
  const closedHits = [];
  const flatBody = compact(body);
  const flatDescription = descriptionIsPage ? '' : compact(description);
  const descriptionStart = flatDescription ? flatBody.indexOf(flatDescription) : -1;
  const uniqueDescription = descriptionStart >= 0 && flatBody.indexOf(flatDescription, descriptionStart + 1) < 0;
  for (const item of rules.closedRules || []) {
    let pattern;
    try { pattern = new RegExp(item.pattern, 'giu'); } catch { continue; }
    let best = null;
    for (const match of body.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      const inner = compact(body.slice(Math.max(0, start - 40), Math.min(body.length, end + 40)));
      const insideDescription = !descriptionIsPage && Boolean(inner && flatDescription.includes(inner));
      const marker = compact(match[0]);
      const markerAt = uniqueDescription ? compact(body.slice(0, end)).lastIndexOf(marker) : -1;
      const inside = uniqueDescription && markerAt >= 0
        ? markerAt >= descriptionStart && markerAt + marker.length <= descriptionStart + flatDescription.length
        : insideDescription;
      const hit = { ruleId: item.id, insideDescription: inside,
        context: body.slice(Math.max(0, start - 160), Math.min(body.length, end + 160)) };
      if (!best || (best.insideDescription && !inside)) best = hit;
      if (!inside) break;
    }
    if (best) closedHits.push(best);
    if (closedHits.length >= 6) break;
  }
  const openSignals = [];
  for (const item of rules.openRules || []) {
    try {
      const fired = (item.selectors || []).some(selector => {
        const control = document.querySelector(selector);
        return Boolean(control && !control.disabled && control.getAttribute('aria-disabled') !== 'true'
          && !control.hasAttribute('disabled') && control.getAttribute('aria-hidden') !== 'true');
      });
      if (fired) openSignals.push({ ruleId: item.id, state: item.state === 'active' ? 'active' : 'shadow' });
    } catch { /* a changed selector cannot prove openness */ }
    if (openSignals.length >= 6) break;
  }
  return { title, h1, chromeText, descriptionText: description,
    descriptionIsPage: Boolean(descriptionIsPage), closedHits, openSignals,
    jsonLd: { validThrough: json.validThrough, isListed: json.isListed },
    workdayPostingAvailable: typeof window.workday?.postingAvailable === 'boolean'
      ? window.workday.postingAvailable : null };
}
