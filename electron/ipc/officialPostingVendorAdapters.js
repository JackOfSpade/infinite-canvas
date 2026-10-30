// Public ATS protocols only. These helpers parse host-fetched bytes and derive
// bounded GET routes; a tenant route is never evidence of employer ownership.
import { JSDOM } from 'jsdom';
import { htmlToText } from 'html-to-text';
import { parse } from 'parse5';
import { walkJsonLdJobPostings } from '../extractors/jobPostingJsonLd.js';

const MAX_BYTES = 3 * 1024 * 1024;
const slug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{0,119}$/iu.test(value) ? value.toLowerCase() : '';
const tenantSlug = value => ['jobs', 'job', 'careers', 'career', 'login', 'register', 'signin', 'signup', 'account', 'api', 'app', 'apply', 'companies'].includes(slug(value)) ? '' : slug(value);
const token = value => typeof value === 'string' && /^[a-z0-9_-]{1,160}$/iu.test(value) ? value : '';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
const plain = value => typeof value === 'string' ? value.trim() : '';
const list = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values.map(plain).filter(Boolean))];

// This is a read-only public query, not arbitrary GraphQL provided by a model
// or page. In particular it never requests applications or candidate fields.
const GEM_QUERY = 'query OfficialPosting($boardId:String!,$extId:String!){oatsExternalJobPosting(boardId:$boardId,extId:$extId){id extId title descriptionHtml companyUrl isUnlistedExternally locations{name city isoCountry isRemote}job{requisitionId locationType teamDisplayName}jobPostSectionHtml{introHtml outroHtml}compensationHtml}}';

function raw(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BYTES || body.includes('\0')) throw new Error('Unbounded ATS source.');
  return body;
}
function json(body) { try { return JSON.parse(raw(body)); } catch { return null; } }
function document(body) { return JSDOM.fragment(raw(body)); }
function text(value) {
  const fragment = JSDOM.fragment(raw(typeof value === 'string' ? value : ''));
  for (const el of fragment.querySelectorAll('script,style,template,noscript')) el.remove();
  for (const el of fragment.querySelectorAll('*')) {
    let depth = 0;
    for (let node = el.parentElement; node; node = node.parentElement) if (++depth > 50) throw new Error('Deep ATS markup.');
  }
  const container = fragment.ownerDocument.createElement('div'); container.append(fragment);
  return htmlToText(container.innerHTML, { wordwrap: false,
    limits: { maxInputLength: Infinity, maxDepth: 60, maxChildNodes: Infinity },
    selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }],
  }).replace(/\r\n?/gu, '\n').trim();
}
function url(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')
      || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) || parsed.hostname.endsWith('.')) return null;
    parsed.hash = ''; return parsed;
  } catch { return null; }
}
function parts(parsed) { try { return parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return []; } }
function route(ats, tenant, detail = {}) { return { ats, tenant, ...detail }; }
function oneParam(parsed, name) { return parsed.searchParams.getAll(name).length === 1 ? parsed.searchParams.get(name) : ''; }

/** URL identity only. Callers must establish employer-to-tenant ownership from
 * independently fetched employer links before accepting any candidate. */
export function officialPostingVendorRoute(value, { html = '' } = {}) {
  const parsed = url(value); if (!parsed) return null;
  const host = parsed.hostname.toLowerCase(); const p = parts(parsed);
  const bamboo = /^(?!www\.|app\.|api\.|support\.)\b([a-z0-9-]+)\.bamboohr\.com$/u.exec(host);
  if (bamboo && p[0] === 'careers' && (!p[1] || /^\d+$/u.test(p[1]))
    && (p.length <= 2 || (p.length === 3 && p[2] === 'detail'))) return route('bamboohr', bamboo[1]);
  if (host === 'apply.workable.com') {
    if (p[0] === 'api' && p[1] === 'v2' && p[2] === 'accounts' && slug(p[3]) && p[4] === 'jobs' && token(p[5]) && p.length === 6) return route('workable', slug(p[3]));
    if (tenantSlug(p[0]) && (p.length === 1 || (p[1] === 'j' && token(p[2]) && p.length === 3))) return route('workable', tenantSlug(p[0]));
  }
  if (host === 'jobs.workable.com' && p[0] === 'company' && token(p[1])?.length >= 6
    && (p.length === 2 || (p.length === 3 && /^jobs-at-[a-z0-9-]+$/iu.test(p[2])))) return route('workable-public', p[1]);
  const wd = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/u.exec(host);
  if (wd) {
    if (p[0] === 'wday') return p[1] === 'cxs' && p[2]?.toLowerCase() === wd[1] && tenantSlug(p[3])
      ? route('workday', `${wd[1]}/${tenantSlug(p[3])}`) : null;
    const at = /^[a-z]{2,3}-[a-z]{2}(?:-[a-z0-9]+)*$/iu.test(p[0] || '') ? 1 : 0;
    if (tenantSlug(p[at])) return route('workday', `${wd[1]}/${tenantSlug(p[at])}`);
  }
  if (host === 'ats.rippling.com') {
    const at = /^[a-z]{2,3}-[a-z]{2}$/iu.test(p[0] || '') ? 1 : 0;
    if (tenantSlug(p[at]) && p[at + 1] === 'jobs' && (!p[at + 2] || uuid(p[at + 2]))) return route('rippling', tenantSlug(p[at]));
  }
  const jazz = /^(?!www\.|app\.|api\.)\b([a-z0-9-]+)\.applytojob\.com$/u.exec(host);
  if (jazz && (!p.length || (p[0] === 'apply' && token(p[1])))) return route('jazzhr', jazz[1]);
  // Gem's documented public job-board listing for one board.
  if (host === 'api.gem.com' && p.length === 4 && p[0] === 'job_board' && p[1] === 'v0' && p[3] === 'job_posts' && !parsed.search
    && tenantSlug(p[2])) return route('gem', tenantSlug(p[2]));
  if (host === 'jobs.gem.com') {
    if (p.join('/') === 'api/public/graphql') {
      if (oneParam(parsed, 'query') !== GEM_QUERY) return null;
      try { const v = JSON.parse(oneParam(parsed, 'variables')); return slug(v.boardId) && token(v.extId) ? route('gem', slug(v.boardId)) : null; } catch { return null; }
    }
    if (tenantSlug(p[0]) && (p.length === 1 || (token(p[1]) && p.length <= 3 && (!p[2] || p[2] === 'application')))) return route('gem', tenantSlug(p[0]));
  }
  if (host === 'recruiting.paylocity.com') {
    if (p.slice(0, 3).join('/').toLowerCase() === 'recruiting/jobs/all' && uuid(p[3])) return route('paylocity', p[3].toLowerCase());
    if (p.slice(0, 3).join('/').toLowerCase() === 'recruiting/jobs/details' && /^\d+$/u.test(p[3] || '') && p.length === 4 && html) {
      const tenants = new Set();
      for (const anchor of document(html).querySelectorAll('a[href]')) {
        let linked;
        try { linked = url(new URL(anchor.getAttribute('href'), parsed).href); } catch { continue; }
        if (!linked || linked.host !== parsed.host) continue;
        const lp = parts(linked);
        if (lp.slice(0, 3).join('/').toLowerCase() === 'recruiting/jobs/all' && uuid(lp[3])) tenants.add(lp[3].toLowerCase());
      }
      if (tenants.size === 1) return route('paylocity', [...tenants][0]);
    }
  }
  if (/^career\d+\.successfactors\.(?:com|eu)$/u.test(host) && parsed.pathname === '/career') {
    const company = oneParam(parsed, 'company');
    if (slug(company)) return route('successfactors', slug(company));
  }
  return null;
}

/** A single public GET derived from an exact detail URL. No supplied URL or
 * response field can change the vendor, tenant, method, or query selection. */
export function officialPostingVendorAdapterUrl(expected, value) {
  const parsed = url(value); const actual = officialPostingVendorRoute(value);
  if (!parsed || !actual || actual.ats !== expected?.ats || actual.tenant !== expected?.tenant) return '';
  const p = parts(parsed);
  if (actual.ats === 'bamboohr' && p.length === 2 && /^\d+$/u.test(p[1])) return `${parsed.origin}/careers/${p[1]}/detail`;
  if (actual.ats === 'workable' && p[1] === 'j' && token(p[2])) return `${parsed.origin}/api/v2/accounts/${actual.tenant}/jobs/${encodeURIComponent(p[2])}`;
  if (actual.ats === 'workday' && p[0] !== 'wday') {
    const at = /^[a-z]{2,3}-[a-z]{2}(?:-[a-z0-9]+)*$/iu.test(p[0] || '') ? 1 : 0;
    const detail = p.slice(at + 1);
    // Public application landing pages carry the same exact posting path.
    // Remove only this terminal operation, never arbitrary nested actions.
    if (detail.at(-1) === 'apply') {
      if (!/\/apply\/?$/u.test(parsed.pathname) || parsed.pathname.includes('//')) return '';
      detail.pop();
    }
    if (detail[0] !== 'job' || detail.length < 2 || !/_[a-z0-9-]+$/iu.test(detail.at(-1))
      || detail.slice(1).some(part => /^apply$/iu.test(part) || /[/\\?#]/u.test(part))) return '';
    const [tenant] = actual.tenant.split('/');
    return `${parsed.origin}/wday/cxs/${tenant}/${encodeURIComponent(p[at])}/${detail.map(encodeURIComponent).join('/')}`;
  }
  // A client-rendered board root has no postings in its markup; its public listing has the same board's posts.
  if (actual.ats === 'gem' && parsed.hostname === 'jobs.gem.com' && p.length === 1) return `https://api.gem.com/job_board/v0/${encodeURIComponent(actual.tenant)}/job_posts/`;
  if (actual.ats === 'gem' && p.length >= 2 && p[0] !== 'api') {
    const out = new URL('/api/public/graphql', parsed);
    out.searchParams.set('query', GEM_QUERY); out.searchParams.set('variables', JSON.stringify({ boardId: actual.tenant, extId: p[1] }));
    return out.href;
  }
  return '';
}

// Workable's public company board and its apply-site account use different
// URL identifiers. The public page names the account's UUID in a JSON state
// record. Read that exact record as data; never evaluate its JavaScript.
function stateObject(script) {
  const prefix = /^\s*window\.jobBoard\s*=\s*\{/u.exec(script);
  if (!prefix || [...script.matchAll(/\bwindow\.jobBoard\s*=/gu)].length !== 1) return null;
  let depth = 1; let quote = ''; let escaped = false; let found = null; let propertyStart = true;
  for (let at = prefix[0].length; at < script.length; at++) {
    const char = script[at];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (depth === 1 && propertyStart && !/\s/u.test(char)) {
      propertyStart = false;
      const key = /^(?:initialState|"initialState"|'initialState')\s*:\s*/u.exec(script.slice(at));
      if (key) {
        if (found) return null;
        const start = at + key[0].length;
        if (script[start] !== '{') return null;
        let innerDepth = 0; let innerQuote = false; let innerEscape = false; let end = -1;
        for (let pos = start; pos < script.length; pos++) {
          const inner = script[pos];
          if (innerQuote) {
            if (innerEscape) innerEscape = false;
            else if (inner === '\\') innerEscape = true;
            else if (inner === '"') innerQuote = false;
          } else if (inner === '"') innerQuote = true;
          else if (inner === '{' || inner === '[') { if (++innerDepth > 50) return null; }
          else if (inner === '}' || inner === ']') { if (--innerDepth === 0) { end = pos; break; } }
        }
        if (end < start) return null;
        found = json(script.slice(start, end + 1));
        if (!found || Array.isArray(found) || typeof found !== 'object') return null;
        at = end; continue;
      }
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '`' || (char === '/' && ['/', '*'].includes(script[at + 1]))) return null;
    else if (char === '{' || char === '[') { if (++depth > 50) return null; }
    else if (char === '}' || char === ']') { if (--depth === 0) return found; }
    else if (char === ',' && depth === 1) propertyStart = true;
  }
  return null;
}

/** An unproved provider-account receipt. The resolver must independently have
 * a proved employer page's actual link to this exact public company board. */
export function extractOfficialPostingVendorAccountReceipt({ body, sourceUrl } = {}) {
  raw(body);
  const r = officialPostingVendorRoute(sourceUrl); const parsed = url(sourceUrl);
  if (r?.ats !== 'workable-public' || !parsed) return null;
  const scripts = []; const stack = [parse(body)];
  while (stack.length) {
    const node = stack.pop();
    if (node.tagName === 'script' && !node.attrs?.some(attr => attr.name === 'src')) {
      const script = (node.childNodes || []).filter(child => child.nodeName === '#text').map(child => child.value || '').join('');
      if (/^\s*window\.jobBoard\s*=/u.test(script)) scripts.push(script);
    }
    stack.push(...(node.childNodes || []));
  }
  if (scripts.length !== 1) return null;
  const state = stateObject(scripts[0]); const key = `api/v1/companies/${r.tenant}`;
  const record = state && Object.hasOwn(state, key) && state[key];
  const data = record?.status === 200 && record.data;
  if (!data || !uuid(data.id) || !uuid(data.workableUid) || data.id.toLowerCase() !== data.workableUid.toLowerCase()
    || !plain(data.title) || data.isHidden === true) return null;
  const board = officialPostingVendorRoute(data.url);
  if (board?.ats !== r.ats || board.tenant !== r.tenant) return null;
  return { ats: 'workable', accountUid: data.id.toLowerCase(), publicBoardUrl: url(data.url).href,
    employer: plain(data.title), sourceUrl: parsed.href };
}

function location(display, remote = false) { return { display: plain(display), remote, workMode: remote ? 'remote' : '', remoteCountry: '', remoteRegion: '' }; }
function address(value) {
  const a = value?.address || value?.postalAddress || value;
  return typeof a === 'string' ? a : unique([a?.addressLocality, a?.addressRegion,
    typeof a?.addressCountry === 'string' ? a.addressCountry : a?.addressCountry?.name]).join(', ');
}
function salary(min, max, currency, interval = '') {
  const valid = v => (typeof v === 'string' || typeof v === 'number') && String(v).trim() && Number.isFinite(Number(v)) && Number(v) >= 0;
  if (!valid(min) || !valid(max) || Number(min) > Number(max)) return { text: '', provenance: 'unknown' };
  const units = { YEAR: '/yr', MONTH: '/mo', HOUR: '/hr', WEEK: '/wk' };
  return { text: `${plain(currency)} ${min} - ${max}${units[String(interval).toUpperCase()] || ''}`.trim(), provenance: 'posted' };
}
function candidate(values, context) {
  if (!plain(values.title) || !plain(values.description) || !url(values.sourceUrl)) return null;
  const employer = plain(values.employer) || plain(context.employer);
  const sameAs = url(values.sameAs)?.href || '';
  return { title: plain(values.title), employer, hiringOrganization: { name: employer, sameAs }, sameAs,
    location: values.location || location(''), salary: values.salary || { text: '', provenance: 'unknown' },
    identifier: String(values.identifier || ''), validThrough: plain(values.validThrough), description: values.description,
    sourceUrl: values.sourceUrl, officialApplyUrl: values.sourceUrl, ats: context.route.ats, tenant: context.route.tenant,
    ...(uuid(values.accountUid) ? { accountUid: values.accountUid.toLowerCase() } : {}),
    isListed: values.isListed !== false, live: values.isListed !== false && (!values.validThrough || Date.parse(values.validThrough) >= context.now),
  };
}
function sameRoute(value, expected) {
  const r = officialPostingVendorRoute(value);
  return r?.ats === expected.ats && r.tenant === expected.tenant;
}

/** Every returned posting remains unproved. The caller retains raw source
 * bytes and applies its usual ownership, semantic-match and liveness gates. */
export function extractOfficialPostingVendorCandidates({ body, sourceUrl, ats = '', tenant = '', employer = '', now = Date.now() } = {}) {
  raw(body);
  const parsed = url(sourceUrl); const r = officialPostingVendorRoute(sourceUrl, { html: body });
  if (!parsed || !r || (ats && ats !== r.ats) || (tenant && tenant !== r.tenant)) return [];
  const ctx = { employer, route: r, now: typeof now === 'function' ? now() : now }; const p = parts(parsed);
  let values;
  if (r.ats === 'gem' && parsed.hostname === 'api.gem.com') {
    // Each listed post must name its own canonical page on this same board.
    return list(json(body)).flatMap(j => {
      const source = url(j?.absolute_url);
      if (!j || !source || source.hostname !== 'jobs.gem.com' || !sameRoute(source.href, r) || parts(source)[1] !== j.id) return [];
      const places = unique([j.location?.name, ...list(j.offices).map(office => office?.location?.name)]);
      return [candidate({ title: j.title, description: plain(j.content_plain) || text(j.content), sourceUrl: `https://jobs.gem.com/${r.tenant}/${encodeURIComponent(j.id)}`,
        identifier: j.requisition_id || j.id, location: location(places.join(' | '), j.location_type === 'remote'), isListed: true }, ctx)].filter(Boolean);
    });
  }
  if (r.ats === 'bamboohr' && p[2] === 'detail') {
    const j = json(body)?.result?.jobOpening;
    if (!j || j.jobOpeningShareUrl !== `${parsed.origin}/careers/${p[1]}`) return [];
    values = { title: j.jobOpeningName, description: text(j.description), sourceUrl: j.jobOpeningShareUrl, identifier: p[1],
      location: location(unique([j.atsLocation?.city || j.location?.city, j.atsLocation?.state || j.location?.state,
        j.atsLocation?.country || j.location?.addressCountry]).join(', ')), isListed: j.jobOpeningStatus === 'Open' };
  } else if (r.ats === 'workable' && p[0] === 'api') {
    const j = json(body);
    if (!j || j.shortcode !== p[5]) return [];
    const display = unique((list(j.locations).length ? j.locations : [j.location]).map(a => unique([a?.city, a?.region, a?.country]).join(', '))).join(' | ');
    values = { title: j.title, description: [j.description, j.requirements, j.benefits].map(text).filter(Boolean).join('\n\n'),
      sourceUrl: `${parsed.origin}/${r.tenant}/j/${p[5]}/`, identifier: j.shortcode, accountUid: j.accountUid, location: location(display, j.remote === true),
      salary: salary(j.salary_from, j.salary_to, j.salary_currency_iso_code, j.salary_frequency), isListed: j.state === 'published' && j.isInternal !== true };
  } else if (r.ats === 'workday' && p[0] === 'wday') {
    const j = json(body)?.jobPostingInfo;
    if (!j || p[4] !== 'job' || p.length < 6 || !plain(j.jobPostingId) || j.jobPostingId !== p.at(-1) || !plain(j.jobReqId)
      || !p.at(-1).endsWith(`_${j.jobReqId}`)) return [];
    const inferred = `${parsed.origin}/${encodeURIComponent(p[3])}/${p.slice(4).map(encodeURIComponent).join('/')}`;
    const external = j.externalUrl || inferred;
    if (!sameRoute(external, r) || parts(url(external)).at(-1) !== j.jobPostingId) return [];
    values = { title: j.title, description: text(j.jobDescription), sourceUrl: external, identifier: j.jobReqId,
      location: location(j.location, /remote/iu.test(j.remoteType || '')), isListed: j.posted === true && j.canApply === true };
  } else if (r.ats === 'rippling') {
    const doc = document(body); const next = json(doc.querySelector('script#__NEXT_DATA__[type="application/json"]')?.textContent || '');
    const data = next?.props?.pageProps?.apiData; const j = data?.jobPost; const board = data?.jobBoard || j?.board;
    if (!j || !uuid(p.at(-1)) || j.uuid !== p.at(-1) || plain(board?.slug).toLowerCase() !== r.tenant
      || !sameRoute(j.url, r) || parts(url(j.url)).at(-1) !== j.uuid) return [];
    const ranges = list(j.payRangeDetails).map(pay => salary(pay.rangeStart, pay.rangeEnd, pay.currency, pay.frequency)).filter(pay => pay.provenance === 'posted');
    values = { title: j.name, employer: j.companyName || board?.companyName, sameAs: board?.boardURL,
      description: [j.description?.company, j.description?.role].map(text).filter(Boolean).join('\n\n'), sourceUrl: j.url, identifier: j.uuid,
      location: location(unique(list(j.workLocations)).join(' | ')), salary: ranges.length === 1 ? ranges[0] : undefined,
      isListed: Boolean(j.activeJobApplication) && j.unlistedFromSearch !== true && board?.isTest !== true };
  } else if (r.ats === 'gem' && p.join('/') === 'api/public/graphql') {
    const v = JSON.parse(oneParam(parsed, 'variables')); const response = json(body); const j = response?.data?.oatsExternalJobPosting;
    if (!j || response.errors?.length || j.extId !== v.extId) return [];
    values = { title: j.title, employer: j.job?.teamDisplayName, sameAs: j.companyUrl,
      description: [j.jobPostSectionHtml?.introHtml, j.descriptionHtml, j.compensationHtml, j.jobPostSectionHtml?.outroHtml].map(text).filter(Boolean).join('\n\n'),
      sourceUrl: `https://jobs.gem.com/${r.tenant}/${encodeURIComponent(j.extId)}`, identifier: j.job?.requisitionId || j.extId,
      location: location(unique(list(j.locations).map(a => plain(a.name) || unique([a.city, a.isoCountry]).join(', '))).join(' | '), j.job?.locationType === 'REMOTE'),
      isListed: j.isUnlistedExternally === false };
  } else if (['jazzhr', 'paylocity'].includes(r.ats)) {
    const nodes = walkJsonLdJobPostings(body);
    const bound = nodes.filter(j => !j.url || url(j.url)?.href === parsed.href);
    if (bound.length !== 1 || (r.ats === 'jazzhr' && p[0] !== 'apply') || (r.ats === 'paylocity' && p[2]?.toLowerCase() !== 'details')) return [];
    const j = bound[0]; const pay = j.baseSalary?.value;
    values = { title: text(j.title), employer: text(j.hiringOrganization?.name), sameAs: j.hiringOrganization?.sameAs,
      description: text(j.description), sourceUrl: parsed.href, identifier: String(typeof j.identifier === 'object' ? j.identifier?.value || '' : j.identifier || (r.ats === 'jazzhr' ? p[1] : p[3])),
      location: location(unique((Array.isArray(j.jobLocation) ? j.jobLocation : [j.jobLocation]).map(address)).join(' | '), j.jobLocationType === 'TELECOMMUTE'),
      salary: salary(pay?.minValue, pay?.maxValue, j.baseSalary?.currency, pay?.unitText), validThrough: j.validThrough };
  } else if (r.ats === 'successfactors' && oneParam(parsed, 'career_ns') === 'job_listing') {
    const id = oneParam(parsed, 'career_job_req_id'); if (!/^\d{1,12}$/u.test(id)) return [];
    const doc = document(body); const heading = plain(doc.querySelector('#candidateProfileTitle')?.textContent);
    const match = /^Career Opportunities:\s*(.+?)\s*\((\d+)\)$/u.exec(heading);
    const desc = doc.querySelector('.joqReqDescription .externalPosting');
    if (!match || match[2] !== id || !desc) return [];
    const intro = desc.querySelector('p'); const strong = intro ? [...intro.querySelectorAll('strong')] : [];
    values = { title: match[1], description: text(desc.innerHTML), sourceUrl: parsed.href, identifier: id,
      location: location(strong.length > 1 ? text(strong[1].innerHTML) : '') };
  }
  const found = values && candidate(values, ctx);
  return found ? [found] : [];
}
