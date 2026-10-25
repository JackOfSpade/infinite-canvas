// Host categories identify discovery routes; an ATS hostname alone never
// proves which employer owns the tenant or whether a posting is the same job.
import { parse } from 'parse5';
export const AGGREGATOR_BASE_DOMAINS = Object.freeze([
  'talent.com', 'dice.com', 'builtin.com', 'wellfound.com', 'angel.co', 'remoteok.com', 'remoteok.io',
  'weworkremotely.com', 'flexjobs.com', 'snagajob.com', 'lensa.com', 'jobgether.com', 'theladders.com',
  'ladders.com', 'otta.com', 'joblist.com', 'jobrapido.com', 'neuvoo.com', 'learn4good.com',
  'workatastartup.com', 'ycombinator.com', 'levels.fyi', 'jobs.google.com', 'careerjet.com',
  'recruit.net', 'jobleads.com', 'whatjobs.com', 'jobisjob.com', 'trovit.com', 'ziprecruiter.com',
  'themuse.com', 'hired.com', 'jobspresso.co', 'justremote.co', 'nodesk.co', 'remote.co',
  'getwork.com', 'jobcase.com', 'monster.com', 'jobs.com', 'idealist.org',
  'bebee.com', 'trabajo.org', 'jobright.ai', 'careerbeacon.com',
]);
const AGGREGATOR_LABEL_RE = /(?:^|\.)(?:indeed|linkedin|glassdoor|ziprecruiter|monster|simplyhired|careerbuilder|jooble|adzuna|reed|totaljobs|seek|naukri|stepstone)\.(?:[a-z]{2,3}\.)?[a-z]{2,}$/iu;
export const ATS_BASE_DOMAINS = Object.freeze([
  'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'myworkdaysite.com', 'ashbyhq.com',
  'smartrecruiters.com', 'icims.com', 'jobvite.com', 'workable.com', 'bamboohr.com', 'taleo.net',
  'successfactors.com', 'successfactors.eu', 'recruitee.com', 'breezy.hr', 'teamtailor.com',
  'personio.de', 'personio.com', 'join.com', 'rippling.com', 'paylocity.com', 'ultipro.com',
  'dayforcehcm.com', 'eightfold.ai', 'applytojob.com', 'pinpointhq.com', 'comeet.com',
  'brassring.com', 'avature.net', 'csod.com', 'oraclecloud.com', 'workforcenow.adp.com',
  'recruiting.adp.com', 'hrmdirect.com', 'jazz.co', 'freshteam.com', 'zohorecruit.com',
  'gohire.io', 'greenhouse.com', 'ripplematch.com', 'phenompeople.com',
]);
const LEGAL_SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'plc', 'ag', 'sa', 'bv', 'nv', 'lp', 'llp']);
const hostMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);
export function normalizedSourceHost(value) {
  if (typeof value !== 'string') return '';
  try {
    const raw = String(value ?? '').trim();
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    return host && host.includes('.') && !host.includes(':') && !/^\d+(?:\.\d+){3}$/u.test(host) ? host : '';
  } catch { return ''; }
}
export function isAggregatorHost(host) {
  const value = normalizedSourceHost(host);
  return Boolean(value) && (AGGREGATOR_BASE_DOMAINS.some(domain => hostMatches(value, domain)) || AGGREGATOR_LABEL_RE.test(value));
}
export function isKnownAtsHost(host) {
  const value = normalizedSourceHost(host);
  return Boolean(value) && ATS_BASE_DOMAINS.some(domain => hostMatches(value, domain));
}
export function strictEmployerTokens(value) {
  const tokens = String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/&/gu, ' and ').match(/[\p{L}\p{N}]+/gu) || [];
  while (tokens.length && LEGAL_SUFFIXES.has(tokens.at(-1))) tokens.pop();
  return tokens;
}
export function strictEmployerEqual(left, right) {
  const a = strictEmployerTokens(left); const b = strictEmployerTokens(right);
  return a.length > 0 && a.length === b.length && a.every((token, index) => token === b[index]);
}

const nameTokens = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/&/gu, ' and ').match(/[\p{L}\p{N}]+/gu) || [];
const containsTokens = (haystack, needle) => needle.length > 0 && haystack.some((_, index) => needle.every((token, offset) => haystack[index + offset] === token));
export function rootBrandingNamesPoster({ rootTitle = '', rootSiteName = '', rootFooter = '' } = {}, poster = '') {
  const tokens = strictEmployerTokens(poster);
  return tokens.length > 0 && [rootTitle, rootSiteName, rootFooter].some(value => containsTokens(nameTokens(value), tokens));
}

/** Only actual footer text from a host-fetched root contributes ownership vetoes. */
export function rootFooterText(html) {
  if (typeof html !== 'string' || !html) return '';
  const stack = [{ node: parse(html), footer: false }]; const parts = [];
  while (stack.length) {
    const { node, footer } = stack.pop();
    if (['script', 'style', 'template'].includes(node.tagName)) continue;
    const inFooter = footer || (node.namespaceURI === 'http://www.w3.org/1999/xhtml' && node.tagName === 'footer');
    if (inFooter && node.nodeName === '#text') parts.push(node.value || '');
    const children = node.childNodes || [];
    for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index], footer: inFooter });
  }
  return parts.join(' ').replace(/\s+/gu, ' ').trim();
}

// Words a recruiter adds to its own name to make a tenant slug ("acme-careers", "acmetalentjobs", "acme-recruiting-inc").
const TENANT_FILLER_WORDS = ['careers', 'career', 'jobs', 'job', 'recruiting', 'recruitment', 'recruiter', 'recruiters', 'hiring', 'hire', 'hires', 'talent', 'staffing',
  'work', 'working', 'team', 'apply', 'openings', 'positions', 'opportunities', 'employment', 'hr', 'join', 'inc', 'llc', 'ltd', 'corp'];
/** True when the whole string is made of filler words (or is empty). */
function onlyTenantFiller(value) {
  const reachable = Array.from({ length: value.length + 1 }, (_, end) => end === 0);
  for (let end = 1; end <= value.length; end++) {
    reachable[end] = TENANT_FILLER_WORDS.some(word => end >= word.length && reachable[end - word.length] && value.startsWith(word, end - word.length));
  }
  return reachable[value.length];
}
/** The slug is the poster's name, or its leading words (four characters or more unless the whole name), with only filler words around it. */
function slugExtendsPosterName(compact, posterTokens) {
  let prefix = '';
  for (let count = 1; count <= posterTokens.length; count++) {
    prefix += posterTokens[count - 1];
    if (count < posterTokens.length && prefix.length < 4) continue;
    for (let at = compact.indexOf(prefix); at >= 0; at = compact.indexOf(prefix, at + 1)) {
      if (onlyTenantFiller(compact.slice(0, at)) && onlyTenantFiller(compact.slice(at + prefix.length))) return true;
    }
  }
  return false;
}

/** A tenant is a discovery key. Matching a poster-owned slug is a veto,
 * never affirmative proof that a different slug belongs to the employer. */
export function isPosterAtsTenant(route, poster) {
  if (!route || typeof route.tenant !== 'string') return false;
  const posterTokens = strictEmployerTokens(poster).filter(token => token !== 'and');
  let slug = route.tenant.toLocaleLowerCase();
  if (['adp', 'paylocity'].includes(route.ats)) return false; // opaque company IDs carry no name claim
  if (route.ats === 'workday') slug = slug.split('/')[0];
  else if (slug.includes('/')) slug = slug.split('/').at(-1);
  else if (route.ats === 'teamtailor' && slug.endsWith('.teamtailor.com')) slug = slug.slice(0, -'.teamtailor.com'.length);
  else if (route.ats === 'icims' && slug.endsWith('.icims.com')) slug = slug.slice(0, -'.icims.com'.length).replace(/^(?:careers?|jobs?)-/u, '');
  else if (route.ats === 'oracle' && slug.endsWith('.oraclecloud.com')) slug = slug.slice(0, -'.oraclecloud.com'.length);
  else if (slug.includes('.')) slug = slug.split('.').filter(token => !['www', 'jobs', 'careers', 'career'].includes(token)).slice(0, -1).join(' ');
  const tokens = nameTokens(slug).filter(token => token !== 'and');
  const compact = tokens.join('');
  const compactPosterRun = posterTokens.some((_, start) => {
    let run = '';
    for (let end = start; end < posterTokens.length && run.length < compact.length; end++) {
      run += posterTokens[end];
      if (run === compact) return true;
    }
    return false;
  });
  return tokens.length > 0 && posterTokens.length > 0
    && (containsTokens(posterTokens, tokens) || compactPosterRun || slugExtendsPosterName(compact, posterTokens));
}

/** A careers-page declaration only; it never replaces full root-title proof. */
export function careersPageEmployerFromTitle(value) {
  const title = String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const name = /^Careers at ([^|]+?)(?: \| .+)?$/iu.exec(title)?.[1]?.trim() || '';
  return name.length <= 120 ? name : '';
}

function teamtailorCareerHtml(html, sourceUrl) {
  if (typeof html !== 'string' || !html) return false;
  const stack = [parse(html)]; const visibleText = [];
  while (stack.length) {
    const node = stack.pop();
    if (node.namespaceURI === 'http://www.w3.org/1999/xhtml' && ['script', 'link', 'iframe'].includes(node.tagName)) {
      const attribute = node.tagName === 'link' ? 'href' : 'src';
      const value = node.attrs?.find(item => !item.prefix && item.name === attribute)?.value;
      if (typeof value === 'string' && value.trim()) {
        try {
          const resource = new URL(value, sourceUrl);
          if (resource.protocol === 'https:' && !resource.username && !resource.password && !resource.port
            && /^(?:cdn\d*|assets-aws)\.teamtailor-cdn\.com$/u.test(resource.hostname.toLowerCase().replace(/\.$/u, ''))) return true;
        } catch { /* Only a parsed resource URL can attest the vendor. */ }
      }
    }
    if (['script', 'style', 'template'].includes(node.tagName)) continue;
    if (node.nodeName === '#text') visibleText.push(node.value || '');
    const children = node.childNodes || [];
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  return /\b(?:powered\s+by|careers?\s+(?:site|page)\s+by)\s+teamtailor(?![\p{L}\p{N}_-])/iu.test(visibleText.join(' '));
}

/** A URL-derived tenant identity is a route, never an employer attestation. */
export function extractAtsTenant(value, { html = '' } = {}) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  const host = normalizedSourceHost(value);
  if (!host || isAggregatorHost(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch { return ''; }
  });
  const first = parts[0] || '';
  const slug = value => typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,119}$/u.test(value)
    && !['jobs', 'job', 'companies', 'careers', 'career', 'login', 'register', 'signin', 'signup', 'account'].includes(value.toLowerCase())
    ? value.toLocaleLowerCase() : '';
  const tenant = slug(first);
  const hasPathTenant = Boolean(tenant);
  if (host === 'jobs.ashbyhq.com') return hasPathTenant ? { ats: 'ashby', tenant } : null;
  if (host === 'boards.greenhouse.io' || /^job-boards(?:\.[a-z]{2})?\.greenhouse\.io$/u.test(host)) {
    if (first === 'embed') {
      const embeddedTenant = url.searchParams.get('for') || '';
      return /^\/embed\/job_board(?:\/js)?\/?$/u.test(url.pathname) && url.searchParams.getAll('for').length === 1
        && /^[a-z0-9][a-z0-9_-]{0,119}$/iu.test(embeddedTenant)
        ? { ats: 'greenhouse', tenant: embeddedTenant.toLowerCase() } : null;
    }
    return hasPathTenant ? { ats: 'greenhouse', tenant } : null;
  }
  if (host === 'jobs.lever.co') return hasPathTenant ? { ats: 'lever', tenant } : null;
  const workday = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/u.exec(host);
  if (workday) {
    // Workday commonly inserts a locale before the actual career-site name.
    // Localized links to one site must retain the same tenant identity.
    const site = /^[a-z]{2,3}-[a-z]{2}(?:-[a-z0-9]+)*$/iu.test(first) ? parts[1] : first;
    return slug(site) ? { ats: 'workday', tenant: `${workday[1]}/${slug(site)}` } : null;
  }
  const teamtailorHost = /^(?!www\.|app\.|api\.|help\.|support\.)[a-z0-9-]+\.teamtailor\.com$/u.test(host);
  if (teamtailorHost || (!hostMatches(host, 'teamtailor.com') && teamtailorCareerHtml(html, url.href))) {
    return { ats: 'teamtailor', tenant: host };
  }
  if (hostMatches(host, 'workforcenow.adp.com') || hostMatches(host, 'recruiting.adp.com')) {
    const id = url.searchParams.get('cid') || url.searchParams.get('client') || '';
    return slug(id) ? { ats: 'adp', tenant: slug(id) } : null;
  }
  if (host === 'join.com' || host === 'www.join.com') return first.toLowerCase() === 'companies' && slug(parts[1]) ? { ats: 'join', tenant: slug(parts[1]) } : null;
  if (host === 'comeet.com' || host === 'www.comeet.com') return first.toLowerCase() === 'jobs' && slug(parts[1]) ? { ats: 'comeet', tenant: slug(parts[1]) } : null;
  if (host === 'jobs.dayforcehcm.com') return /^[a-z]{2,3}-[a-z]{2}$/iu.test(first) && slug(parts[1]) ? { ats: 'dayforce', tenant: slug(parts[1]) } : null;
  if (host === 'recruiting.paylocity.com') {
    const company = parts[3] || '';
    return parts.slice(0, 3).join('/').toLowerCase() === 'recruiting/jobs/all'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(company)
      ? { ats: 'paylocity', tenant: company.toLowerCase() } : null;
  }
  for (const [vendorHost, ats] of [['apply.workable.com', 'workable'], ['jobs.smartrecruiters.com', 'smartrecruiters'], ['jobs.jobvite.com', 'jobvite'], ['ats.rippling.com', 'rippling']]) {
    if (host === vendorHost) return tenant ? { ats, tenant } : null;
  }
  if (/^(?!www\.|jobs\.|careers\.|app\.|api\.)[a-z0-9-]+\.oraclecloud\.com$/u.test(host)) return { ats: 'oracle', tenant: host };
  if (/^(?!www\.|jobs\.|careers\.|app\.|api\.|help\.|support\.)[a-z0-9-]+\.icims\.com$/u.test(host)) return { ats: 'icims', tenant: host };
  return null;
}

/** Proof is supplied only from pages fetched by the host, never AI verdicts. */
export function proveEmployerDomain({ domain, employer, poster = '', posterDomain = '', postingUrl = '', sameAs = '', careersPageUrl = '', careersPageEmployer = '', careersLinks = [], rootSiteName = '', rootTitle = '', rootFooter = '', independentEmployer = '', offDomainAttestations = [] } = {}) {
  const host = normalizedSourceHost(domain);
  const sameDomain = value => normalizedSourceHost(value) === host;
  if (!host || isAggregatorHost(host) || isKnownAtsHost(host)) return false;
  if (posterDomain && sameDomain(posterDomain) && !strictEmployerEqual(poster, employer)) return false;
  if (rootBrandingNamesPoster({ rootSiteName, rootTitle, rootFooter }, poster) && !strictEmployerEqual(poster, employer)) return false;
  const independentlyTied = strictEmployerEqual(independentEmployer, employer);
  const offDomainProof = (url, organization, organizationSite) => normalizedSourceHost(url)
    && independentlyTied && !sameDomain(url) && strictEmployerEqual(organization, employer) && sameDomain(organizationSite);
  if (offDomainProof(postingUrl, employer, sameAs)) return true;
  if (offDomainAttestations.some(page => offDomainProof(page?.url, page?.employer, page?.sameAs))) return true;
  const rootProof = strictEmployerEqual(rootSiteName, employer) || strictEmployerEqual(rootTitle, employer);
  if (rootProof) return true;
  const pageProof = independentlyTied && sameDomain(careersPageUrl) && strictEmployerEqual(careersPageEmployer, employer);
  if (pageProof && careersLinks.some(link => {
    try {
      const found = new URL(String(link), careersPageUrl);
      const posting = new URL(postingUrl);
      if (found.href === posting.href) return true;
      const a = extractAtsTenant(found.href); const b = extractAtsTenant(posting.href);
      return a && b && a.ats === b.ats && a.tenant === b.tenant;
    } catch { return false; }
  })) return true;
  return false;
}

// Amendment 3, section 1: a mutual (round-trip) attestation. The employer's
// own domain links to the ATS tenant, the tenant's posting names the employer
// and points back to that domain, and the domain's brand is the employer's.
const SECOND_LEVEL_SUFFIXES = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);
export function registrableDomain(value) {
  const host = normalizedSourceHost(value);
  if (!host) return '';
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  return labels.at(-1).length === 2 && SECOND_LEVEL_SUFFIXES.has(labels.at(-2)) ? labels.slice(-3).join('.') : labels.slice(-2).join('.');
}
const registrableLabel = value => registrableDomain(value).split('.')[0] || '';
const distinctiveTokens = employer => strictEmployerTokens(employer).filter(token => !['the', 'a', 'an', 'and'].includes(token));
/** The text before the first | – — : · or " - ". */
export function leadingTitleSegment(value) {
  const title = String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return title.split(/\s+-\s+|[|–—:·]/u)[0].trim();
}
export function domainBrandMatchesEmployer({ domain, employer, rootTitle = '', rootSiteName = '' } = {}) {
  const label = registrableLabel(domain).toLocaleLowerCase();
  const tokens = distinctiveTokens(employer); const first = tokens[0] || '';
  const joined = strictEmployerTokens(employer).join('');
  if (!label || !first) return false;
  if (label === first || label === joined || label.replace(/-/gu, '') === joined) return true;
  // A looser label (getbirch.com, birchhq.com) is accepted only when the root
  // page's own leading segment is the employer or its first distinctive token.
  const lead = [rootTitle, rootSiteName].map(leadingTitleSegment).filter(Boolean);
  const leadMatches = lead.some(segment => strictEmployerEqual(segment, employer) || nameTokens(segment).join(' ') === first);
  return leadMatches && first.length >= 3 && (label.startsWith(first) || label.endsWith(first));
}
export function proveBidirectionalOwnership({ domain, employer, poster = '', route = null, linksToTenant = false, tenantPointsBack = false, rootTitle = '', rootSiteName = '', rootFooter = '' } = {}) {
  const host = normalizedSourceHost(domain);
  if (!host || !linksToTenant || !tenantPointsBack || isAggregatorHost(host) || isKnownAtsHost(host)) return false;
  if (!domainBrandMatchesEmployer({ domain: host, employer, rootTitle, rootSiteName })) return false;
  if (strictEmployerEqual(poster, employer)) return true;
  // Neither the label, the root title or site name, nor the tenant slug may carry the poster's name.
  return !rootBrandingNamesPoster({ rootTitle, rootSiteName, rootFooter }, poster)
    && !isPosterAtsTenant({ ats: 'domain', tenant: registrableLabel(host) }, poster)
    && !isPosterAtsTenant(route, poster);
}

export function classifyOfficialSourceHost(host, company, proof = {}) {
  const value = normalizedSourceHost(host);
  if (!value) return 'invalid';
  if (isAggregatorHost(value)) return 'aggregator';
  if (value === 'usajobs.gov' || value.endsWith('.usajobs.gov')) return 'official';
  if (isKnownAtsHost(value)) return 'ats';
  return proveEmployerDomain({ ...proof, domain: value, employer: company }) ? 'employer' : 'unrelated';
}
