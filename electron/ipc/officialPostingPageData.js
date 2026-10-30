// First-party job detail pages need not publish JobPosting JSON-LD. These
// parsers retain explicit URL-bound application data or a single job article;
// callers must supply an employer established independently by the host.
import { JSDOM } from 'jsdom';
import { htmlToText } from 'html-to-text';
import { isKnownAtsHost, strictEmployerEqual } from './officialSourceHosts.js';
import { extractOfficialPostingNuxtData } from './officialPostingNuxtData.js';
import { normalizeLocationInput } from '../../src/utils/jobLocation.js';

const MAX_BYTES = 3 * 1024 * 1024;
const plain = value => typeof value === 'string' ? value.trim() : '';
function https(value, base) {
  try { if (typeof value !== 'string' || !value) return null;
    const u = new URL(value, base); return u.protocol === 'https:' && !u.username && !u.password ? u : null; }
  catch { return null; }
}
function text(value) {
  const source = typeof value === 'string' ? value : '';
  if (Buffer.byteLength(source) > MAX_BYTES) throw new Error('Unbounded job article.');
  const fragment = JSDOM.fragment(source);
  for (const node of fragment.querySelectorAll('script,style,template,noscript,nav,footer,header')) node.remove();
  for (const el of fragment.querySelectorAll('*')) {
    let depth = 0;
    for (let parent = el.parentElement; parent; parent = parent.parentElement) if (++depth > 50) throw new Error('Deep job article.');
  }
  const container = fragment.ownerDocument.createElement('div'); container.append(fragment);
  return htmlToText(container.innerHTML, { wordwrap: false,
    limits: { maxInputLength: Infinity, maxDepth: 60, maxChildNodes: Infinity },
    selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] }).trim();
}
const location = display => ({ display, workMode: '', remoteCountry: '', remoteRegion: '' });
function nativeCareersDetailRoute(value) {
  const source = https(value); if (!source) return null;
  const match = /^((?:\/[a-z]{2}_[a-z]{2})?\/careers)\/JobDetail\/[^/]{1,500}\/([1-9]\d{0,15})\/?$/iu.exec(source.pathname);
  if (!match || source.searchParams.has('jobId') && (source.searchParams.getAll('jobId').length !== 1
    || source.searchParams.get('jobId') !== match[2])) return null;
  return { source, prefix: match[1], id: match[2] };
}
function queryJobDescriptionRoute(value) {
  const source = https(value);
  if (!source || !/^\/job-description\/?$/u.test(source.pathname) || [...source.searchParams.keys()].length !== 1
    || source.searchParams.getAll('gh_jid').length !== 1 || !/^[1-9]\d{0,15}$/u.test(source.searchParams.get('gh_jid'))) return null;
  return { source, id: source.searchParams.get('gh_jid') };
}
function conflictingNativeJobDescriptionId(source) {
  const id = /^\/job-description\/([1-9]\d{0,15})\/?$/iu.exec(source.pathname)?.[1];
  return Boolean(id && source.searchParams.has('gh_jid') && (source.searchParams.getAll('gh_jid').length !== 1
    || source.searchParams.get('gh_jid') !== id));
}
function currentJobRoute(value) {
  const source = https(value);
  const id = source && /^\/job\/([1-9]\d{0,15})\/[^/]{1,500}\/?$/u.exec(source.pathname)?.[1];
  return id && !source.port && !source.search && !source.hash ? { source, id } : null;
}
function nativeRolesRoute(value) {
  const source = https(value);
  const id = source && /^(?:\/company)?\/careers\/roles\/([1-9]\d{0,15})\/?$/u.exec(source.pathname)?.[1];
  return Boolean(id && !source.hash && (!source.search || [...source.searchParams.keys()].length === 1
    && source.searchParams.getAll('gh_jid').length === 1 && source.searchParams.get('gh_jid') === id));
}
const presentationText = value => String(value || '').normalize('NFKC').replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"')
  .replace(/\s+/gu, ' ').trim().toLowerCase();
const sameText = (a, b) => presentationText(a) === presentationText(b);
const currentJobFieldText = value => text(value.replace(/\[#video#https:\/\/[^\s<>[\]]{1,2000}#\/video#\]/gu, ''));
const currentJobScripts = doc => [...doc.querySelectorAll('script')].filter(node =>
  /^\s*(?:var|let|const)\s+current_job\s*=/u.test(node.textContent));
const CURRENT_JOB_FIELDS = Object.freeze({ description: 'Company Summary', responsibilities: 'Responsibilities',
  qualifications: 'Qualifications', businessSummary: 'Business Summary', compensation: 'Compensation', travel: 'Travel',
  compliance: 'Compliance', EEO: 'EEO', 'E-Verify': 'E-Verify', Privacy: 'Privacy' });
function currentJobLocation(main, job, display) {
  const facts = { display, workMode: '', remoteCountry: '', remoteRegion: '' };
  const setups = [...main.querySelectorAll('li')].map(node => plain(node.textContent)).filter(value => /^Work Setup\s*:/iu.test(value));
  if (setups.length > 1 || job.location_type != null && typeof job.location_type !== 'string') return null;
  const visible = setups[0]?.replace(/^Work Setup\s*:\s*/iu, '') || '';
  const declared = plain(job.location_type);
  const mode = value => { const normalized = value.toLowerCase().replace(/^on[- ]site$/u, 'onsite');
    return ['remote', 'hybrid', 'onsite'].includes(normalized) ? normalized : ''; };
  const statedMode = mode(declared); const visibleMode = mode(visible);
  if (declared && visible && (statedMode && visibleMode ? statedMode !== visibleMode : !sameText(declared, visible))) return null;
  // Neither a missing work arrangement nor an unknown label means onsite.
  // Structured facts require the actual displayed and typed labels to agree.
  if (!statedMode || statedMode !== visibleMode) return facts;
  if (statedMode !== 'remote' && /\bremote\b/iu.test(display)) return null;
  facts.workMode = statedMode; facts.remote = statedMode === 'remote';
  if (facts.remote && /\bremote\b/iu.test(display)) {
    const restriction = normalizeLocationInput(display.replace(/\bremote\b/giu, '').replace(/[()–—-]/gu, ' ').trim());
    if (restriction.scope === 'country' && restriction.countryExplicit && !restriction.countryConflict) facts.remoteCountry = restriction.country;
  }
  return facts;
}
function currentJobDetail(doc, route, { sourceUrl, employer }) {
  if (!plain(employer)) return [];
  const scripts = currentJobScripts(doc);
  if (scripts.length !== 1 || scripts[0].hasAttribute('src') || scripts[0].namespaceURI !== 'http://www.w3.org/1999/xhtml'
    || scripts[0].closest('template,svg')
    || !['', 'text/javascript', 'application/javascript'].includes(plain(scripts[0].getAttribute('type')).toLowerCase())) return [];
  const assignment = /^\s*(?:var|let|const)\s+current_job\s*=\s*(\{[\s\S]*\})\s*;?\s*$/u.exec(scripts[0].textContent);
  let job; try { job = assignment && JSON.parse(assignment[1]); } catch { return []; }
  if (!job || Array.isArray(job) || !['string', 'number'].includes(typeof job.id)
    || typeof job.id === 'number' && !Number.isSafeInteger(job.id) || String(job.id) !== route.id
    || !strictEmployerEqual(employer, job.company_name) || !plain(job.title)
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(plain(job.ref)) || job.clientid !== job.ref
    || !['open', 'closed'].includes(plain(job.entity_status).toLowerCase())) return [];
  const own = currentJobRoute(job.url);
  if (!own || own.source.origin !== route.source.origin || own.id !== route.id) return [];
  const canonicals = [...doc.querySelectorAll('link[rel~="canonical"]')];
  if (canonicals.length !== 1) return [];
  for (const node of [...canonicals, ...doc.querySelectorAll('meta[property="og:url"]')]) {
    const declared = https(node.getAttribute('href') || node.getAttribute('content'), sourceUrl);
    if (!declared || declared.origin !== route.source.origin || currentJobRoute(declared.href)?.id !== route.id) return [];
  }
  const mains = [...doc.querySelectorAll('main')];
  const headings = [...doc.querySelectorAll('h1')];
  if (mains.length !== 1 || headings.length !== 1 || !mains[0].contains(headings[0])) return [];
  const main = mains[0]; const title = text(headings[0].innerHTML);
  if (!sameText(title, text(job.title))) return [];
  const identities = [...main.querySelectorAll('li')].map(node => plain(node.textContent)).filter(value => /^Job ID\s*:/iu.test(value));
  if (identities.length !== 1 || !sameText(identities[0].replace(/^Job ID\s*:\s*/iu, ''), job.ref)) return [];
  const declaredApply = https(job.seo_url);
  if (!declaredApply || declaredApply.port || declaredApply.hash || !isKnownAtsHost(declaredApply.href)
    || declaredApply.pathname === '/') return [];
  const applications = [...main.querySelectorAll('a.apply-btn[href]')];
  if (!applications.length || applications.some(node =>
    !/^Apply for job on [\p{L}\p{N} ._-]{2,80}$/iu.test(plain(node.getAttribute('aria-label')))
    || https(node.getAttribute('href'), sourceUrl)?.href !== declaredApply.href)) return [];
  const fields = [...main.querySelectorAll('.job-desc [data-field]')];
  const retained = new Map();
  for (const field of fields) {
    const name = field.getAttribute('data-field');
    if (!Object.hasOwn(CURRENT_JOB_FIELDS, name)) continue;
    if (retained.has(name) || typeof job[name] !== 'string' || field.querySelector('[data-field]')) return [];
    const clone = field.cloneNode(true);
    const label = clone.firstElementChild;
    if (label?.classList.contains('jd-field-label') && sameText(label.textContent, CURRENT_JOB_FIELDS[name])) label.remove();
    const actual = currentJobFieldText(clone.outerHTML); const declared = currentJobFieldText(job[name]);
    if (!actual || !sameText(actual, declared)) return [];
    retained.set(name, actual);
  }
  // Only the actual complete DOM representation is retained. A typed value
  // corroborates a field but never fills a section missing from the page.
  for (const name of Object.keys(CURRENT_JOB_FIELDS)) {
    if (typeof job[name] === 'string' && currentJobFieldText(job[name]) && !retained.has(name)) return [];
  }
  if ((retained.get('responsibilities')?.length || 0) < 100 || (retained.get('qualifications')?.length || 0) < 100) return [];
  const description = [...retained].map(([name, value]) => `${CURRENT_JOB_FIELDS[name]}\n\n${value}`).join('\n\n');
  if (description.length < 500 || Buffer.byteLength(description) > MAX_BYTES) return [];
  const locations = [...main.querySelectorAll('li')].map(node => plain(node.textContent)).filter(value => /^Location\s*:/iu.test(value));
  if (locations.length !== 1) return [];
  const locationFacts = currentJobLocation(main, job, locations[0].replace(/^Location\s*:\s*/iu, ''));
  if (!locationFacts) return [];
  const notices = [...main.querySelectorAll('.job-notice,.job-status,[data-job-status],[role="alert"]')].map(node => text(node.innerHTML)).join('\n');
  const closed = /\b(?:no longer accepting applications|position has been filled|job is no longer available)\b/iu.test(description + '\n' + notices);
  const flag = value => value === true || value === 'true';
  const off = value => value === false || value === 'false';
  if (['hidden', 'is_posted', 'publish_to_cws'].some(name => job[name] !== undefined
    && ![true, false, 'true', 'false'].includes(job[name]))) return [];
  return candidate({ title, description, identifier: job.ref, applyUrl: declaredApply.href,
    locationFacts,
    live: plain(job.entity_status).toLowerCase() === 'open' && !closed && !flag(job.hidden) && !off(job.is_posted) && !off(job.publish_to_cws),
  }, { sourceUrl, employer });
}
/** A single JSON-valued assignment is data, never evaluated JavaScript. */
export function extractOfficialPostingCurrentJobData({ body, sourceUrl, employer = '' } = {}) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BYTES) return [];
  const route = currentJobRoute(sourceUrl); if (!route) return [];
  try { return currentJobDetail(JSDOM.fragment(body), route, { sourceUrl, employer }); } catch { return []; }
}
export function isOfficialPostingDetailUrl(value) {
  const parsed = https(value);
  if (!parsed || conflictingNativeJobDescriptionId(parsed)) return false;
  return Boolean(nativeCareersDetailRoute(value) || queryJobDescriptionRoute(value)
    || nativeRolesRoute(value)
    || /\/(?:jobs?|job-description|positions?|openings?)\/(?:[^/]+\/)*[^/]+\/?$/iu.test(parsed.pathname)
    || /\/careers\/single-job\.html$/u.test(parsed.pathname) && parsed.searchParams.getAll('job_id').length === 1
      && /^[1-9]\d{0,15}$/u.test(parsed.searchParams.get('job_id')) && [...parsed.searchParams.keys()].length === 1);
}
function candidate(values, { sourceUrl, employer }) {
  const apply = https(values.applyUrl || sourceUrl, sourceUrl);
  if (!values.title || !values.description || !apply) return [];
  return [{ title: values.title, employer, hiringOrganization: { name: employer, sameAs: '' }, sameAs: '',
    location: values.locationFacts || location(values.location || ''), salary: { text: '', provenance: 'unknown' },
    identifier: values.identifier || '', description: values.description, sourceUrl, officialApplyUrl: apply.href,
    ats: '', tenant: '', isListed: values.live, live: values.live }];
}

function nativeCareersDetail(doc, route, { sourceUrl, employer }) {
  // This native careers template uses a banner H2 and named role-ID field;
  // its site-brand H1 must never be mistaken for the posting's title.
  if (!plain(employer)) return [];
  const mains = [...doc.querySelectorAll('main')];
  const headings = [...doc.querySelectorAll('h2.banner__text__title')];
  if (mains.length !== 1 || headings.length !== 1) return [];
  const title = text(headings[0].innerHTML); if (!title) return [];
  // Canonical declarations may repeat this exact page, never another role or
  // host. A banner from a related listing cannot become this route's title.
  for (const node of doc.querySelectorAll('link[rel~="canonical"],meta[property="og:url"]')) {
    const declared = https(node.getAttribute('href') || node.getAttribute('content'), sourceUrl);
    if (!declared || declared.origin !== route.source.origin || declared.pathname !== route.source.pathname
      || nativeCareersDetailRoute(declared.href)?.id !== route.id) return [];
  }
  const titles = [...doc.querySelectorAll('meta[property="og:title"]')].map(node => plain(node.getAttribute('content')));
  if (titles.some(value => value !== title)) return [];
  const main = mains[0];
  const fields = [...main.querySelectorAll('.article__content__view__field')];
  const identities = fields.filter(field => [...field.children].some(node =>
    node.classList.contains('article__content__view__field__label') && /^(?:Role|Job) ID$/iu.test(plain(node.textContent))));
  if (identities.length !== 1) return [];
  const ids = [...identities[0].children].filter(node => node.classList.contains('article__content__view__field__value'));
  if (ids.length !== 1 || plain(ids[0].textContent) !== route.id) return [];
  const articles = [...main.querySelectorAll('article.article--details')].filter(article => {
    const labels = [...article.querySelectorAll('.article__header h2,.article__header h3')]
      .filter(node => node.closest('article') === article);
    return labels.length === 1 && /^(?:Description\s*(?:&|and)\s*Requirements|Job Description)$/iu.test(text(labels[0].innerHTML));
  });
  if (articles.length !== 1) return [];
  const contents = [...articles[0].children].filter(node => node.classList.contains('article__content'));
  if (contents.length !== 1) return [];
  const description = text(contents[0].innerHTML);
  if (description.length < 500 || !/\b(?:responsibilities|requirements|qualifications|you will)\b/iu.test(description)) return [];
  const applications = [...main.querySelectorAll('a[href]')].filter(node =>
    /^Apply(?: now| for (?:this|the) (?:role|job|position))?$/iu.test(text(node.innerHTML)));
  if (!applications.length) return [];
  const targets = new Set();
  for (const node of applications) {
    const target = https(node.getAttribute('href'), sourceUrl);
    if (!target || target.origin !== route.source.origin || target.pathname !== `${route.prefix}/ApplicationMethods`
      || [...target.searchParams.keys()].length !== 1 || target.searchParams.getAll('jobId').length !== 1
      || target.searchParams.get('jobId') !== route.id || target.hash) return [];
    targets.add(target.href);
  }
  if (targets.size !== 1) return [];
  const locations = [...main.querySelectorAll('.field--locations .article__content__view__field__value')];
  if (locations.length > 1) return [];
  return candidate({ title, description, identifier: route.id, applyUrl: [...targets][0],
    location: locations.length ? text(locations[0].innerHTML).replace(/^Locations?\s*:\s*/iu, '') : '',
    live: !/\b(?:no longer accepting applications|position has been filled|job is no longer available)\b/iu.test(description),
  }, { sourceUrl, employer });
}

function queryJobDescriptionCanonical(doc, route) {
  const canonical = [...doc.querySelectorAll('link[rel~="canonical"]')];
  if (canonical.length !== 1) return false;
  for (const node of [...canonical, ...doc.querySelectorAll('meta[property="og:url"]')]) {
    const declared = https(node.getAttribute('href') || node.getAttribute('content'), route.source.href);
    if (!declared || declared.origin !== route.source.origin || queryJobDescriptionRoute(declared.href)?.id !== route.id) return false;
  }
  return true;
}
function queryJobDescriptionForm(article, route) {
  const forms = [...article.querySelectorAll('form')].filter(form =>
    [...form.querySelectorAll('button[type="submit"],button:not([type]),input[type="submit"]')].some(node =>
      /^(?:Submit (?:your )?application|Apply(?: now| for (?:this|the) (?:role|job|position))?)$/iu.test(
        text(node.innerHTML || node.getAttribute('value') || node.getAttribute('aria-label')))));
  if (forms.length !== 1) return false;
  const form = forms[0]; const names = /^(?:gh_jid|job_?id)$/iu;
  for (const node of [form, ...form.querySelectorAll('[data-job-id],[data-gh-jid],input[name]')]) {
    for (const attr of ['data-job-id', 'data-gh-jid']) if (node.hasAttribute(attr) && node.getAttribute(attr) !== route.id) return false;
    if (names.test(node.getAttribute('name') || '') && node.getAttribute('value') !== route.id) return false;
  }
  if (form.getAttribute('action')) {
    const action = https(form.getAttribute('action'), route.source.href);
    if (!action || action.origin !== route.source.origin) return false;
    for (const name of [...action.searchParams.keys()].filter(name => names.test(name))) {
      if (action.searchParams.getAll(name).length !== 1 || action.searchParams.get(name) !== route.id) return false;
    }
    const pathId = /\/(\d+)\/?$/u.exec(action.pathname)?.[1];
    if (pathId && pathId !== route.id) return false;
  }
  return true;
}

export function extractOfficialPostingPageData({ body, sourceUrl, employer = '', now } = {}) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_BYTES) return [];
  const source = https(sourceUrl); if (!source || conflictingNativeJobDescriptionId(source)) return [];
  const nuxt = extractOfficialPostingNuxtData({ body, sourceUrl, employer, now });
  if (nativeRolesRoute(sourceUrl)) return nuxt;
  const doc = JSDOM.fragment(body);
  const currentRoute = currentJobRoute(sourceUrl);
  if (currentRoute && currentJobScripts(doc).length) {
    try { return currentJobDetail(doc, currentRoute, { sourceUrl, employer }); } catch { return []; }
  }
  const queryRoute = queryJobDescriptionRoute(sourceUrl);
  if (queryRoute && (!plain(employer) || !queryJobDescriptionCanonical(doc, queryRoute))) return [];
  // Inertia's public page envelope carries its canonical URL and exact detail
  // record. Never walk arbitrary application state or nested related jobs.
  const states = [...doc.querySelectorAll('[data-page]')];
  if (states.length === 1) {
    let page; try { page = JSON.parse(states[0].getAttribute('data-page')); } catch { /* No state parser fallback. */ }
    const bound = page && https(page.url, sourceUrl); const job = page?.props?.job_object;
    const id = plain(job?.unique_identifier);
    if (bound?.origin === source.origin && bound.pathname === source.pathname && job && id
      && source.pathname.split('/').filter(Boolean).at(-1) === id && plain(job.title) && plain(job.content)
      && [0, 1, false, true].includes(job.live)) {
      const statedEmployer = plain(employer) || plain(page.props?.tenantConfig?.branding?.customer_name);
      if (!statedEmployer) return [];
      return candidate({ title: text(job.title), description: text(job.content), identifier: plain(job.job_code) || id,
        location: plain(job.address), applyUrl: job.application || sourceUrl,
        live: (job.live === 1 || job.live === true) && !job.deleted_at && !job.closed }, { sourceUrl, employer: statedEmployer });
    }
  }
  const nativeRoute = nativeCareersDetailRoute(sourceUrl);
  if (nativeRoute) return nativeCareersDetail(doc, nativeRoute, { sourceUrl, employer });
  // Restrict the DOM fallback to a detail path, one heading and one article.
  // A careers index, navigation list or arbitrary body is not a posting.
  if (!plain(employer) || !isOfficialPostingDetailUrl(sourceUrl)) return [];
  const headings = [...doc.querySelectorAll('h1')]; if (headings.length !== 1) return [];
  const heading = headings[0];
  const article = heading.closest('article') || heading.closest('main') || heading.closest('[role="main"]'); if (!article) return [];
  const description = text(article.outerHTML);
  if (description.length < 500 || !/\b(?:responsibilities|requirements|qualifications|what you(?:'|’)ll|about (?:the|this) (?:role|job)|you will)\b/iu.test(description)) return [];
  if (queryRoute && !queryJobDescriptionForm(article, queryRoute)) return [];
  const applyLinks = [...article.querySelectorAll('a[href],form,button')].filter(el => /\b(?:apply|submit (?:your )?application)\b/iu.test(el.textContent || el.getAttribute('aria-label') || ''));
  const applyUrl = applyLinks.map(el => https(el.getAttribute('href') || el.getAttribute('action'), sourceUrl)).find(Boolean);
  const localForm = article.querySelector('form') && /\bapply (?:for|to) (?:this|the) (?:role|job|position)\b/iu.test(description);
  if (!applyUrl && !localForm) return [];
  const closed = /\b(?:no longer accepting applications|position has been filled|job is no longer available)\b/iu.test(description);
  return candidate({ title: text(heading.innerHTML), description, live: !closed, applyUrl: sourceUrl, identifier: queryRoute?.id || '',
    location: plain(article.querySelector('[itemprop="jobLocation"],[data-job-location]')?.textContent) }, { sourceUrl, employer });
}
