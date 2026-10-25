import crypto from 'node:crypto';
import { fetchOfficialPosting } from './officialPostingFetch.js';
import { normalizeApplyOptions, normalizeOfficialLocation, normalizeOfficialPosting, normalizeOfficialSalary, officialHttpsUrl, OFFICIAL_POSTING_TRAIL } from './officialPostingFields.js';
import { extractOfficialPostingCandidates, scanOfficialCareersPage } from './officialPostingExtractors.js';
import { careersPageEmployerFromTitle, extractAtsTenant, isAggregatorHost, isKnownAtsHost, normalizedSourceHost, proveEmployerDomain, strictEmployerEqual } from './officialSourceHosts.js';
import { coreTitle, evaluateOfficialPostingMatch, frozenOfficialEmployer, locationsCompatible, posterEmployerSignals, resolveScrapedEmployer, selectOfficialPostingMatch } from './officialPostingMatch.js';
import { officialPostingRecordMatchesScrapedIdentity } from './officialPostingStore.js';

export const OFFICIAL_POSTING_BATCH_SIZE = 12;
export { adapterUrl as officialPostingAdapterUrl, readableDescription as readableOfficialPostingDescription, verifiedApplyUrl as verifiedOfficialPostingApplyUrl };
const canonical = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
export function officialPostingRequestId(job) {
  return crypto.createHash('sha256').update([job?.title, job?.company, job?.url || job?.googleCardUrl, job?.location].map(canonical).join('|')).digest('hex').slice(0, 24);
}
export function officialPostingChunks(jobs) {
  const members = (Array.isArray(jobs) ? jobs : []).map(job => ({ id: officialPostingRequestId(job), job }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const chunks = [];
  for (let index = 0; index < members.length; index += OFFICIAL_POSTING_BATCH_SIZE) chunks.push(members.slice(index, index + OFFICIAL_POSTING_BATCH_SIZE));
  return chunks;
}
function trailCodes(values) { return [...new Set(values.filter(value => OFFICIAL_POSTING_TRAIL.includes(value)))].slice(0, 32); }
function fallback(job, { outcome = 'not-found', trail = [], alternatives = [] } = {}) {
  const scraped = resolveScrapedEmployer(job);
  return { postedBy: scraped.postedBy || undefined, officialPosting: normalizeOfficialPosting({ level: scraped.level,
    outcome, employer: scraped.employer, trail: trailCodes(trail), alternatives }) };
}
export function unresolvedOfficialPosting(job, options) { return fallback(job, options); }

export function freeOfficialPostingLeads(job) {
  const urls = normalizeApplyOptions(job?.applyOptions).map(option => option.href);
  for (const match of String(job?.snippet || '').matchAll(/https:\/\/[^\s<>"'`]+/gu)) urls.push(match[0].replace(/[),.;]+$/gu, ''));
  urls.push(job?.url);
  return [...new Set(urls.map(officialHttpsUrl).filter(url => url && !isAggregatorHost(new URL(url).hostname)))].slice(0, 32);
}
function verifiedApplyUrl(candidate) {
  const source = new URL(candidate.sourceUrl);
  const value = officialHttpsUrl(candidate.officialApplyUrl);
  if (!value) return source.href;
  const apply = new URL(value);
  const sourcePath = source.pathname.replace(/\/+$/u, '');
  const applyPath = apply.pathname.replace(/\/+$/u, '');
  return apply.host === source.host && apply.search === source.search && (applyPath === sourcePath
    || ['application', 'apply', 'applications/new'].some(suffix => applyPath === `${sourcePath}/${suffix}`))
    ? apply.href : source.href;
}
function adapterUrl(route, url) {
  const tenant = encodeURIComponent(route.tenant);
  if (route.ats === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${tenant}?includeCompensation=true`;
  if (route.ats === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${tenant}/jobs?content=true`;
  if (route.ats === 'lever') return `https://api.lever.co/v0/postings/${tenant}?mode=json`;
  if (route.ats === 'teamtailor') return new URL('/jobs.rss', url).href;
  return '';
}
function readableDescription(candidate, job) {
  const description = String(candidate?.description || '');
  const scraped = String(job?.snippet || '');
  return description.split(/\s+/u).filter(Boolean).length >= 40
    && !(scraped.length > 600 && description.length < scraped.length * 0.3)
    && /\b(?:requirements?|qualifications?|responsibilit\w*|you will|what you|we are looking|experience|skills?)\b/iu.test(description);
}

/** Host-owned discovery. AI supplies leads and quoted comparisons only. All
 * page bytes, employer attestations, tenant proofs and decisions originate
 * here. This core has no IPC, bridge registration or renderer dependency. */
export async function resolveOfficialPosting(job, {
  store = null, fetch = fetchOfficialPosting, candidateUrls = [], research = null, match = null,
  signal, now = Date.now, bypassCache = false, persistMisses = true,
} = {}) {
  const instant = () => typeof now === 'function' ? now() : Number(now);
  const trail = []; const candidates = new Map(); const pages = new Map();
  const rssCandidates = new Map(); const conflictingUrls = new Set();
  const signals = posterEmployerSignals(job);
  const hypotheses = [job?.company, ...signals.hypotheses].filter(Boolean);
  // Discovery names cannot override an employer explicitly named by the row.
  // Only an intermediary signal without an identity leaves that question open.
  const statedEmployers = signals.S1 || signals.S2 ? [signals.S1, signals.S2].filter(Boolean)
    : signals.S4.length ? signals.S4 : !signals.S3 ? [job?.company].filter(Boolean) : [];
  const domains = new Map(); const tenants = new Map(); const queue = []; const queued = new Set();
  const rootSites = new Map(); const careersPages = new Map();
  const ownPoster = canonical(job?.company);
  const enqueue = (value, context = {}) => {
    const url = officialHttpsUrl(value);
    if (!url || isAggregatorHost(new URL(url).hostname)) return;
    if (queued.has(url)) {
      const existing = queue.find(item => item.url === url);
      if (existing && context.provenEmployer) Object.assign(existing, context);
      return;
    }
    if (queue.length >= 64) return;
    queued.add(url); queue.push({ url, ...context });
  };
  const addLead = lead => {
    if (typeof lead === 'string') { enqueue(lead); return; }
    if (!lead || typeof lead !== 'object') return;
    if (typeof lead.employer === 'string' && lead.employer.length <= 120 && !hypotheses.includes(lead.employer)) hypotheses.push(lead.employer);
    for (const key of ['careersPageUrl', 'postingUrl', 'url', 'employerDomain']) {
      if (lead[key]) enqueue(key === 'employerDomain' && !lead[key].includes('://') ? `https://${lead[key]}/` : lead[key]);
    }
  };
  const read = async url => {
    if (!pages.has(url)) pages.set(url, Promise.resolve().then(() => fetch(url, { signal })).catch(error => {
      trail.push(error?.code || 'fetch-failed'); return null;
    }));
    return pages.get(url);
  };
  const rootProof = async (url, organization) => {
    const host = normalizedSourceHost(url);
    if (!host || isKnownAtsHost(host) || isAggregatorHost(host)) return false;
    if (domains.has(host)) return strictEmployerEqual(domains.get(host), organization);
    const rootUrl = new URL('/', url).href;
    const page = await read(rootUrl);
    if (!page || !/html/iu.test(page.contentType || '')) return false;
    if (normalizedSourceHost(page.url || page.sourceUrl || rootUrl) !== host) return false;
    const scan = scanOfficialCareersPage(page.body, page.url || rootUrl);
    rootSites.set(host, scan);
    const proof = proveEmployerDomain({ domain: host, employer: organization, poster: job?.company,
      rootSiteName: scan.siteName, rootTitle: scan.title });
    if (proof) { domains.set(host, organization); trail.push('domain-proof'); }
    return proof;
  };
  const careersLinkProof = (page, postingUrl) => {
    if (domains.has(page.host) && !strictEmployerEqual(domains.get(page.host), page.employer)) return false;
    const root = rootSites.get(page.host);
    const proven = proveEmployerDomain({ domain: page.host, employer: page.employer, poster: job?.company,
      rootSiteName: root?.siteName || '', rootTitle: root?.title || '', careersPageUrl: page.url,
      careersPageEmployer: page.employer, careersLinks: page.links, postingUrl });
    if (proven) { domains.set(page.host, page.employer); trail.push('domain-proof'); }
    return proven;
  };
  const capture = async (candidate, context) => {
    const url = officialHttpsUrl(candidate.sourceUrl);
    if (!url) return;
    if (conflictingUrls.has(url)) return;
    if (!context.boardApi && url !== officialHttpsUrl(context.fetchedUrl)) { enqueue(url); return; }
    const host = normalizedSourceHost(url); const route = extractAtsTenant(url, {
      html: url === officialHttpsUrl(context.fetchedUrl) ? context.fetchedHtml || '' : '',
    });
    if (context.route && (!route || context.route.ats !== route.ats || context.route.tenant !== route.tenant)) {
      trail.push('tenant-unproven'); return;
    }
    const routeKey = route ? `${route.ats}|${route.tenant}` : '';
    const careerEmployer = tenants.get(routeKey) || context.provenEmployer || '';
    const organization = candidate.employer || candidate.hiringOrganization?.name || careerEmployer;
    const matchesHypothesis = hypotheses.some(name => strictEmployerEqual(name, organization));
    if (!organization || !matchesHypothesis || (statedEmployers.length && !statedEmployers.some(name => strictEmployerEqual(name, organization)))) return;
    const sameAs = candidate.sameAs || candidate.hiringOrganization?.sameAs || '';
    const organizationHost = normalizedSourceHost(sameAs);
    const offDomain = organizationHost && organizationHost !== host && proveEmployerDomain({
      domain: organizationHost, employer: organization, poster: job?.company, postingUrl: url, sameAs,
    });
    if (offDomain) domains.set(organizationHost, organization);
    const linked = Boolean(careerEmployer && strictEmployerEqual(careerEmployer, organization));
    const structured = Boolean(offDomain && candidate.hiringOrganization?.name
      && strictEmployerEqual(candidate.hiringOrganization.name, organization));
    for (const page of careersPages.values()) {
      if (page.host === host && strictEmployerEqual(page.employer, organization)) careersLinkProof(page, url);
    }
    const domainProven = Boolean(domains.has(host) && strictEmployerEqual(domains.get(host), organization))
      || (!route && await rootProof(url, organization));
    const officialPortalProven = /^(?:www\.)?usajobs\.gov$/u.test(host)
      && /^\/job\/\d+\/?$/u.test(new URL(url).pathname)
      && url === officialHttpsUrl(context.fetchedUrl)
      && strictEmployerEqual(candidate.hiringOrganization?.name, job?.company);
    const proven = linked || structured || (route?.ats === 'teamtailor' && domainProven);
    const enriched = { ...candidate, employer: organization, sourceUrl: url, ats: route?.ats || '', tenant: route?.tenant || '',
      tenantProven: Boolean(route && proven), employerDomainProven: domainProven,
      officialPortalProven,
      posterTenant: Boolean(route && !strictEmployerEqual(organization, job?.company) && context.provenEmployer && canonical(context.provenEmployer) === ownPoster),
      provenance: linked ? 'careers' : route ? 'structured' : 'employer' };
    const existing = candidates.get(url);
    if (existing && (!strictEmployerEqual(existing.employer, enriched.employer)
      || coreTitle(existing.title) !== coreTitle(enriched.title)
      || !locationsCompatible(existing, enriched)
      || (existing.identifier && enriched.identifier && existing.identifier !== enriched.identifier))) {
      candidates.delete(url); conflictingUrls.add(url); trail.push('ambiguous'); return;
    }
    // RSS provides full text while the same page's JSON-LD adds posted pay.
    const best = existing ? { ...existing, ...enriched,
      description: existing.description.length > enriched.description.length ? existing.description : enriched.description,
      salary: enriched.salary?.provenance === 'posted' ? enriched.salary : existing.salary,
      tenantProven: existing.tenantProven || enriched.tenantProven,
      provenance: existing.provenance === 'careers' ? 'careers' : enriched.provenance,
    } : enriched;
    candidates.set(url, best);
    if (route && proven) {
      tenants.set(routeKey, organization);
      const adapter = adapterUrl(route, url);
      if (adapter) enqueue(adapter, { route, provenEmployer: organization, adapter: true });
    }
  };
  const matchOptions = () => ({ now: instant(), employerHypotheses: [...new Set([...candidates.values()]
    .filter(candidate => candidate.tenantProven || candidate.employerDomainProven || candidate.officialPortalProven).map(candidate => candidate.employer))] });
  const drain = async () => {
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      if (signal?.aborted) { trail.push('bridge-aborted'); break; }
      const context = queue[cursor];
      const page = await read(context.url);
      if (!page) continue;
      const sourceUrl = page.url || page.sourceUrl || context.url;
      if (context.adapter && officialHttpsUrl(sourceUrl) !== officialHttpsUrl(context.url)) { trail.push('tenant-unproven'); continue; }
      const route = context.route || extractAtsTenant(sourceUrl, { html: page.body });
      let scan = null;
      if (/html/iu.test(page.contentType || '')) {
        scan = scanOfficialCareersPage(page.body, sourceUrl);
        const host = normalizedSourceHost(sourceUrl);
        for (const organization of hypotheses) if (await rootProof(sourceUrl, organization)) break;
        // Section 5.3(b) accepts an explicit employer careers page plus its
        // actual links. A marketing root title still cannot satisfy 5.3(c).
        const careersEmployer = careersPageEmployerFromTitle(scan.title);
        if (!isKnownAtsHost(host) && !isAggregatorHost(host)
          && /\/(?:careers?|jobs?|positions?|openings?)(?:\/|$)/iu.test(new URL(sourceUrl).pathname)
          && hypotheses.some(name => strictEmployerEqual(name, careersEmployer))) {
          const page = { host, url: sourceUrl, employer: careersEmployer, links: scan.links.map(link => link.url) };
          careersPages.set(sourceUrl, page);
          for (const link of scan.links) {
            const existing = candidates.get(link.url);
            if (!(extractAtsTenant(link.url) || (existing && normalizedSourceHost(link.url) === host
              && strictEmployerEqual(existing.employer, careersEmployer)))) continue;
            if (!careersLinkProof(page, link.url)) continue;
            if (existing && normalizedSourceHost(link.url) === host && strictEmployerEqual(existing.employer, careersEmployer)) {
              existing.employerDomainProven = true; existing.provenance = 'employer';
            }
          }
        }
        const provenEmployer = domains.get(host) || '';
        if (route && provenEmployer) tenants.set(`${route.ats}|${route.tenant}`, provenEmployer);
        for (const link of scan.links) {
          const linkedRoute = extractAtsTenant(link.url);
          if (linkedRoute && provenEmployer) tenants.set(`${linkedRoute.ats}|${linkedRoute.tenant}`, provenEmployer);
          if (linkedRoute || (normalizedSourceHost(link.url) === host && /\/(?:careers?|jobs?|positions?|openings?)(?:\/|$)/iu.test(new URL(link.url).pathname))) {
            enqueue(link.url, { ...(linkedRoute ? { route: linkedRoute } : {}),
              ...(linkedRoute && provenEmployer ? { provenEmployer } : {}) });
            if (linkedRoute && provenEmployer) {
              const adapter = adapterUrl(linkedRoute, link.url);
              if (adapter) enqueue(adapter, { route: linkedRoute, provenEmployer, adapter: true });
            }
          }
        }
      }
      if (route && !context.adapter) {
        const employer = tenants.get(`${route.ats}|${route.tenant}`) || '';
        const adapter = adapterUrl(route, sourceUrl);
        if (adapter) enqueue(adapter, { route, ...(employer ? { provenEmployer: employer } : {}), adapter: true });
      }
      try {
        const employer = context.provenEmployer || (route ? tenants.get(`${route.ats}|${route.tenant}`) : '') || '';
        const extracted = extractOfficialPostingCandidates({ body: page.body, sourceUrl, contentType: page.contentType,
          ats: route?.ats || '', tenant: route?.tenant || '', employer, now: instant });
        for (const candidate of extracted) {
          if (route?.ats === 'teamtailor' && /(?:xml|rss)/iu.test(page.contentType || '')) {
            rssCandidates.set(officialHttpsUrl(candidate.sourceUrl), candidate);
            enqueue(candidate.sourceUrl, { route, provenEmployer: employer }); continue;
          }
          const rss = rssCandidates.get(officialHttpsUrl(candidate.sourceUrl));
          const idsAgree = rss && (!(rss.identifier && candidate.identifier) || rss.identifier === candidate.identifier);
          const employersAgree = rss && (!(rss.employer && candidate.employer) || strictEmployerEqual(rss.employer, candidate.employer));
          const boundRss = rss && idsAgree && employersAgree && coreTitle(rss.title) === coreTitle(candidate.title)
            && ((rss.identifier && candidate.identifier && rss.identifier === candidate.identifier) || locationsCompatible(rss, candidate));
          await capture(boundRss && rss.description.length > candidate.description.length
            ? { ...candidate, description: rss.description } : candidate, { ...context, provenEmployer: employer,
              fetchedUrl: sourceUrl, fetchedHtml: /html/iu.test(page.contentType || '') ? page.body : '',
              boardApi: context.adapter === true && /json/iu.test(page.contentType || '') });
        }
        if (extracted.length) trail.push(context.adapter ? 'ats-adapter' : 'json-ld');
      } catch { trail.push('unreadable'); }
      const verified = selectOfficialPostingMatch(job, [...candidates.values()], matchOptions());
      if (verified.outcome === 'found' && frozenOfficialEmployer(job, verified.candidate.employer)
        && readableDescription(verified.candidate, job)) break;
    }
  };
  const persist = async result => {
    if (result.description) result.officialPosting.contentHash = crypto.createHash('sha256').update(result.description).digest('hex');
    if (store && (persistMisses || !['L5', 'L6'].includes(result.officialPosting.level))) {
      try {
        result.record = await store.save(job, { officialPosting: result.officialPosting, description: result.description });
        result.officialPosting = result.record.officialPosting;
      } catch { return fallback(job, { outcome: 'failed', trail: [...(result.officialPosting?.trail || []), 'fetch-failed'] }); }
    }
    return result;
  };
  try {
    if (store && !bypassCache) {
      const record = await store.find(job);
      if (record && officialPostingRecordMatchesScrapedIdentity(job, record)) {
        if (['L5', 'L6'].includes(record.officialPosting.level)) {
          const current = fallback(job, { outcome: record.officialPosting.outcome,
            trail: [...(record.officialPosting.trail || []), 'recent-miss'], alternatives: record.officialPosting.alternatives || [] });
          return { ...current, record: { ...record, officialPosting: current.officialPosting } };
        }
        return { record, postedBy: strictEmployerEqual(record.officialPosting.employer, job?.company) ? undefined : job?.company,
          officialPosting: { ...record.officialPosting, trail: trailCodes([...(record.officialPosting.trail || []), 'cache-hit']) } };
      }
    }
    for (const url of freeOfficialPostingLeads(job)) enqueue(url);
    for (const lead of candidateUrls) addLead(lead);
    await drain();
    let decision = selectOfficialPostingMatch(job, [...candidates.values()], matchOptions());
    if (decision.outcome !== 'found' && !signal?.aborted && research) {
      trail.push('bridge-research');
      try {
        const leads = await research(job, { signal });
        for (const lead of Array.isArray(leads) ? leads : []) addLead(lead);
        await drain();
      } catch (error) { trail.push(error?.code || (signal?.aborted ? 'bridge-aborted' : 'research-miss')); }
      decision = selectOfficialPostingMatch(job, [...candidates.values()], matchOptions());
    }
    const tieBreakers = new Map();
    if (decision.outcome !== 'found' && match && !signal?.aborted) {
      for (const candidate of candidates.values()) {
        const evaluation = evaluateOfficialPostingMatch(job, candidate, matchOptions());
        if (!evaluation.hardPass || evaluation.reason !== 'no-anchor') continue;
        try { tieBreakers.set(candidate.sourceUrl, await match(job, candidate, { signal })); }
        catch (error) { trail.push(error?.code || (signal?.aborted ? 'bridge-aborted' : 'research-miss')); }
      }
      decision = selectOfficialPostingMatch(job, [...candidates.values()], { ...matchOptions(), tieBreakers });
    }
    for (const evaluation of decision.evaluations) trail.push(...(evaluation.reasons || []));
    if (decision.outcome !== 'found') return persist(fallback(job, { outcome: decision.outcome, trail,
      alternatives: decision.alternatives }));
    const candidate = decision.candidate;
    const employer = frozenOfficialEmployer(job, candidate.employer);
    const readable = employer && readableDescription(candidate, job);
    const level = !readable ? 'L4' : candidate.provenance === 'careers' ? 'L2' : candidate.ats ? 'L3' : 'L1';
    const evaluation = decision.evaluations.find(item => item.candidate === candidate);
    const officialPosting = normalizeOfficialPosting({ level, outcome: readable ? 'found' : 'link-only', employer,
      title: candidate.title, location: normalizeOfficialLocation(candidate.location) || { display: '', workMode: '', remote: false, remoteCountry: '', remoteRegion: '' },
      salary: normalizeOfficialSalary(candidate.salary) || { text: '', provenance: 'unknown' },
      sourceUrl: candidate.sourceUrl, officialApplyUrl: verifiedApplyUrl(candidate),
      ats: candidate.ats || '', tenant: candidate.tenant || '', fetchedAt: new Date(instant()).toISOString(),
      trail: trailCodes([...trail, ...(evaluation?.anchors || []), ...(!readable ? ['stub-text'] : [])]),
    });
    if (!officialPosting) return persist(fallback(job, { outcome: 'unreadable', trail: [...trail, 'invalid-text'] }));
    return persist({ postedBy: !strictEmployerEqual(job?.company, employer) ? job?.company : undefined,
      officialPosting, ...(readable ? { description: candidate.description } : {}) });
  } catch (error) {
    return persist(fallback(job, { outcome: 'failed', trail: [...trail, error?.code || 'fetch-failed'] }));
  }
}
