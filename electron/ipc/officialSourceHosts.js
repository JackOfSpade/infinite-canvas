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
  const hasPathTenant = /^[\p{L}\p{N}_.-]{1,120}$/u.test(first);
  if (host === 'jobs.ashbyhq.com') return hasPathTenant ? { ats: 'ashby', tenant: first } : null;
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    if (first === 'embed') {
      const embeddedTenant = url.searchParams.get('for') || '';
      return /^\/embed\/job_board(?:\/js)?\/?$/u.test(url.pathname) && url.searchParams.getAll('for').length === 1
        && /^[a-z0-9][a-z0-9_-]{0,119}$/iu.test(embeddedTenant)
        ? { ats: 'greenhouse', tenant: embeddedTenant } : null;
    }
    return hasPathTenant ? { ats: 'greenhouse', tenant: first } : null;
  }
  if (host === 'jobs.lever.co') return hasPathTenant ? { ats: 'lever', tenant: first } : null;
  const workday = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/u.exec(host);
  if (workday) {
    // Workday commonly inserts a locale before the actual career-site name.
    // Localized links to one site must retain the same tenant identity.
    const site = /^[a-z]{2,3}-[a-z]{2}(?:-[a-z0-9]+)*$/iu.test(first) ? parts[1] : first;
    return site && /^[\p{L}\p{N}_.-]{1,120}$/u.test(site) && !/^job$/iu.test(site)
      ? { ats: 'workday', tenant: `${workday[1]}/${site}` } : null;
  }
  if (hostMatches(host, 'teamtailor.com') || teamtailorCareerHtml(html, url.href)) {
    return { ats: 'teamtailor', tenant: host };
  }
  if (hostMatches(host, 'workforcenow.adp.com') || hostMatches(host, 'recruiting.adp.com')) {
    const tenant = url.searchParams.get('cid') || url.searchParams.get('client') || first;
    return tenant ? { ats: 'adp', tenant } : null;
  }
  if (hostMatches(host, 'oraclecloud.com')) return { ats: 'oracle', tenant: `${host}/${first}` };
  if (hostMatches(host, 'icims.com')) return { ats: 'icims', tenant: host };
  return isKnownAtsHost(host) ? { ats: 'other', tenant: `${host}/${first}` } : null;
}

/** Proof is supplied only from pages fetched by the host, never AI verdicts. */
export function proveEmployerDomain({ domain, employer, poster = '', posterDomain = '', postingUrl = '', sameAs = '', careersPageUrl = '', careersPageEmployer = '', careersLinks = [], rootSiteName = '', rootTitle = '', offDomainAttestations = [] } = {}) {
  const host = normalizedSourceHost(domain);
  const sameDomain = value => normalizedSourceHost(value) === host;
  if (!host || isAggregatorHost(host) || isKnownAtsHost(host)) return false;
  if (posterDomain && sameDomain(posterDomain) && !strictEmployerEqual(poster, employer)) return false;
  if ((strictEmployerEqual(rootSiteName, poster) || strictEmployerEqual(rootTitle, poster)) && !strictEmployerEqual(poster, employer)) return false;
  const offDomainProof = (url, organization, organizationSite) => normalizedSourceHost(url)
    && !sameDomain(url) && strictEmployerEqual(organization, employer) && sameDomain(organizationSite);
  if (offDomainProof(postingUrl, employer, sameAs)) return true;
  if (offDomainAttestations.some(page => offDomainProof(page?.url, page?.employer, page?.sameAs))) return true;
  const rootProof = strictEmployerEqual(rootSiteName, employer) || strictEmployerEqual(rootTitle, employer);
  if (rootProof) return true;
  const pageProof = sameDomain(careersPageUrl) && strictEmployerEqual(careersPageEmployer, employer);
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

export function classifyOfficialSourceHost(host, company, proof = {}) {
  const value = normalizedSourceHost(host);
  if (!value) return 'invalid';
  if (isAggregatorHost(value)) return 'aggregator';
  if (value === 'usajobs.gov' || value.endsWith('.usajobs.gov')) return 'official';
  if (isKnownAtsHost(value)) return 'ats';
  return proveEmployerDomain({ ...proof, domain: value, employer: company }) ? 'employer' : 'unrelated';
}
