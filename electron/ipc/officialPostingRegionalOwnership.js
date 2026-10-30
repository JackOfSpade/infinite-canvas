// A regional office may hire under its full legal name on a parent's account.
// This helper reports exact source relationships, never ownership proof. The
// resolver must already have proved the employer's root and careers page.
import { parse } from 'parse5';
import { strictEmployerTokens } from './officialSourceHosts.js';
import { officialPostingVendorRoute, extractOfficialPostingVendorCandidates } from './officialPostingVendorAdapters.js';
import { extractOfficialCareersCmsFacts } from './officialPostingCareersCms.js';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_NODES = 32_768;
const REGIONS = new Set(['north america', 'europe', 'canada', 'us', 'u s', 'united states', 'uk', 'u k', 'united kingdom']);
const INTERMEDIARY = /\b(?:hiring|recruiting)\s+(?:for|on\s+behalf\s+of)\s+(?:(?:our|a|the)\s+)?client\b|\b(?:staffing|recruitment)\s+(?:agency|firm)\b|\bthird[-\s]+party\s+recruiter\b|\b(?:our|a|the)\s+client\s+(?:seeks?|needs?|requires?|hires?|is\s+hiring)\b/iu;
const CLIENT_BRANDING = /\b(?:our|a|the)\s+(?:client|customer|partner)(?:['’]s)?\b/iu;
const bounded = value => typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= MAX_BYTES;
const nameTokens = value => {
  const tokens = strictEmployerTokens(value);
  // A publisher may identify the corporate group as "X Companies". This is
  // compared only to its proved parent brand, never used to rename a job.
  if (tokens.at(-1) === 'companies') tokens.pop();
  return tokens;
};
const equal = (a, b) => a.length && a.length === b.length && a.every((word, index) => word === b[index]);
const contains = (words, name) => name.length && words.some((_, start) => name.every((word, at) => words[start + at] === word));
function https(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')
      || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) || u.hostname.endsWith('.')) return null;
    u.hash = ''; return u;
  } catch { return null; }
}
function children(node) { return node.childNodes || []; }
function document(body) {
  const root = parse(body); const nodes = [root]; let seen = 0;
  while (nodes.length) {
    const node = nodes.pop(); const nested = children(node);
    if (++seen + nodes.length + nested.length > MAX_NODES) return null;
    for (let at = nested.length - 1; at >= 0; at--) nodes.push(nested[at]);
  }
  return root;
}
function text(node) {
  const stack = [node]; const parts = [];
  while (stack.length) {
    const current = stack.pop();
    if (['script', 'style', 'template', 'noscript'].includes(current.tagName)) continue;
    if (current.nodeName === '#text') parts.push(current.value || '');
    for (let at = children(current).length - 1; at >= 0; at--) stack.push(children(current)[at]);
  }
  return parts.join(' ').replace(/\s+/gu, ' ').trim();
}
function attr(node, key) { return node.attrs?.find(item => item.name === key)?.value || ''; }

export function extractRegionalEmployerAccountReceipt({ candidate, atsBody, atsSourceUrl, rootEmployer, careersBody, careersUrl } = {}) {
  if (!bounded(atsBody) || !bounded(careersBody) || typeof rootEmployer !== 'string' || rootEmployer.length > 120) return null;
  const atsDocument = document(atsBody); const careersDocument = document(careersBody);
  if (!atsDocument || !careersDocument) return null;
  const source = https(atsSourceUrl); const careers = https(careersUrl);
  if (!source || !careers || https(candidate?.sourceUrl)?.href !== source.href) return null;
  const route = officialPostingVendorRoute(source.href, { html: atsBody });
  if (route?.ats !== 'paylocity' || candidate?.ats !== route.ats || candidate?.tenant !== route.tenant) return null;
  let rawCandidates;
  try { rawCandidates = extractOfficialPostingVendorCandidates({ body: atsBody, sourceUrl: source.href, ats: route.ats, tenant: route.tenant }); }
  catch { return null; }
  if (rawCandidates.length !== 1) return null;
  const rawCandidate = rawCandidates[0];
  if (rawCandidate.title !== candidate.title || !equal(strictEmployerTokens(rawCandidate.employer), strictEmployerTokens(candidate.employer))
    || candidate.hiringOrganization?.name && !equal(strictEmployerTokens(rawCandidate.employer), strictEmployerTokens(candidate.hiringOrganization.name))
    || INTERMEDIARY.test(rawCandidate.description)) return null;
  const employer = strictEmployerTokens(rawCandidate.employer); const parent = nameTokens(rootEmployer);
  if (!parent.length || employer.length <= parent.length || !parent.every((word, at) => employer[at] === word)) return null;
  const qualifier = employer.slice(parent.length).join(' ');
  if (!REGIONS.has(qualifier)) return null;

  const publishers = new Set(); const atsNodes = [atsDocument];
  while (atsNodes.length) {
    const node = atsNodes.pop();
    if (node.tagName === 'h2' && attr(node, 'id') === 'LayoutLogoName') publishers.add(text(node));
    for (let at = children(node).length - 1; at >= 0; at--) atsNodes.push(children(node)[at]);
  }
  if (publishers.size !== 1) return null;
  const publisher = [...publishers][0];
  if (!equal(nameTokens(publisher), parent)) return null;

  const nodes = [careersDocument]; const accounts = new Set(); const branding = [];
  while (nodes.length) {
    const node = nodes.pop();
    if (['script', 'style', 'template', 'noscript'].includes(node.tagName)) continue;
    if (node.tagName === 'a' && attr(node, 'href')) {
      try {
        const linked = https(new URL(attr(node, 'href'), careers).href);
        const account = linked && officialPostingVendorRoute(linked.href);
        if (account?.ats === 'paylocity') accounts.add(account.tenant);
      } catch { /* Unrelated malformed navigation cannot supply an account. */ }
    }
    if (node.tagName === 'img' && attr(node, 'alt')) branding.push(attr(node, 'alt'));
    if (/^(?:h[1-6]|p)$/u.test(node.tagName || '')) branding.push(text(node));
    for (let at = children(node).length - 1; at >= 0; at--) nodes.push(children(node)[at]);
  }
  const declarations = extractOfficialCareersCmsFacts({ body: careersBody, sourceUrl: careers.href });
  for (const link of declarations?.links || []) accounts.add(officialPostingVendorRoute(link.url).tenant);
  for (const declaration of declarations?.branding || []) branding.push(declaration.text);
  const namedBranding = branding.filter(value => contains(strictEmployerTokens(value), employer));
  if (accounts.size !== 1 || !accounts.has(route.tenant) || !namedBranding.length
    || namedBranding.some(value => INTERMEDIARY.test(value) || CLIENT_BRANDING.test(value))) return null;
  return { ats: route.ats, tenant: route.tenant, employer: rawCandidate.employer, publisher, rootEmployer,
    regionalQualifier: qualifier, sourceUrl: source.href, careersUrl: careers.href,
    ...(declarations ? { declaredCareersFacts: declarations } : {}) };
}
