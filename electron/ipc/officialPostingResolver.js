import crypto from 'node:crypto';
import { fetchOfficialPosting } from './officialPostingFetch.js';
import { officialPostingEmployerText, normalizeApplyOptions, normalizeOfficialLocation, normalizeOfficialPosting, normalizeOfficialSalary, officialHttpsUrl, boundedOfficialPostingTrail, officialPostingComparativeTrail, officialPostingFetchFailure, normalizeOfficialPostingFetchFailure, OFFICIAL_FETCH_FAILURE_LIMIT, OFFICIAL_POSTING_TRAIL } from './officialPostingFields.js';
import { extractOfficialPostingCandidates, scanOfficialCareersPage, officialSmartRecruitersAdapterUrl } from './officialPostingExtractors.js';
import { domainBrandMatchesEmployer, extractAtsTenant, isAggregatorHost, isKnownAtsHost, isPosterAtsTenant, normalizedSourceHost, proveBidirectionalOwnership, proveEmployerDomain, registrableDomain, rootBrandingNamesPoster, rootFooterText, sameOwnershipHost, strictEmployerEqual } from './officialSourceHosts.js';
import { buildOfficialPostingComparisonSet, canonicalLeadUrl, coreTitle, evaluateOfficialPostingMatch, flatPostingText, frozenOfficialEmployer, locationsCompatible, posterEmployerSignals, resolveScrapedEmployer, selectOfficialPostingMatch } from './officialPostingMatch.js';
import { officialPostingAliases, officialPostingRecordMatchesScrapedIdentity } from './officialPostingStore.js';
import { validateOfficialPostingMatchResponse } from './officialPostingBridge.js';
import { resolveSemanticOfficialPosting } from './officialPostingSemanticResolution.js';
import { evaluateOfficialPostingSourceEligibility, officialPostingSemanticInputHash, officialPostingSemanticProofMatches, officialPostingSemanticSourceHash, withHostOfficialPostingLiveness } from './officialPostingSemantic.js';
import { classifyListingLiveness, evidenceFromHtml, LISTING_LIVENESS_RULES } from './listingLiveness.js';
import { recordOfficialExpiryCandidates } from './listingLivenessStore.js';

export const OFFICIAL_POSTING_BATCH_SIZE = 12;
export { adapterUrl as officialPostingAdapterUrl, readableDescription as readableOfficialPostingDescription, verifiedApplyUrl as verifiedOfficialPostingApplyUrl };
// T10: only the registrable apex or one conventional single-label careers/www host speaks for a domain. Tenant subdomains of a hosting
// platform (evil.vendor.example) and user-content subdomains never do.
const OWN_HOST_LABELS = new Set(['www', 'careers', 'career', 'jobs', 'job', 'join', 'work', 'talent']);
function speaksForDomain(host) {
  const domain = registrableDomain(host);
  if (!domain) return false;
  return host === domain || (host.endsWith(`.${domain}`) && OWN_HOST_LABELS.has(host.slice(0, -(domain.length + 1))));
}
const canonical = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const ROW_BUDGETS = new WeakMap();
const ROW_ABORT_FANOUTS = new WeakMap();
const RETRYABLE_MISS_TRAIL = new Set(['bridge-aborted', 'bridge-timeout', 'bridge-unavailable', 'research-miss',
  'fetch-failed', 'fetch-timeout', 'crawl-budget', 'crawl-partial', 'official-text-missing', 'storage-failed', 'failed', 'comparative-invalid', 'comparative-unavailable', 'comparative-truncated', 'insufficient-text', 'semantic-uncertain', 'semantic-overflow', 'official-liveness-unconfirmed']);
const DEFINITIVE_MISS_TRAIL = new Set(['closed', 'title-mismatch', 'location-mismatch', 'employer-mismatch',
  'tenant-unproven', 'poster-tenant', 'salary-mismatch', 'no-anchor', 'invalid-quotes', 'ambiguous', 'comparative-none', 'comparative-disagree']);

/** Shared by both discovery passes. Human handoff time is never charged to
 * this host-only budget; its signal also makes a stopped crawl non-durable. */
export function createOfficialPostingRowBudget({ signal, maxPages = 16, timeoutMs = 60_000, now = Date.now,
  previous, retryUrls = [] } = {}) {
  const controller = new AbortController();
  let fanout;
  if (signal?.aborted) controller.abort(signal.reason);
  else if (signal) {
    fanout = ROW_ABORT_FANOUTS.get(signal);
    if (!fanout) {
      fanout = { controllers: new Set() };
      fanout.abort = () => {
        for (const child of fanout.controllers) child.abort(signal.reason);
        fanout.controllers.clear(); ROW_ABORT_FANOUTS.delete(signal);
      };
      ROW_ABORT_FANOUTS.set(signal, fanout);
      signal.addEventListener('abort', fanout.abort, { once: true });
    }
    fanout.controllers.add(controller);
  }
  let disposed = false;
  const budget = Object.freeze({ signal: controller.signal,
    dispose: () => {
      if (disposed || !fanout) return;
      disposed = true;
      fanout.controllers.delete(controller);
      if (!fanout.controllers.size) {
        signal.removeEventListener('abort', fanout.abort); ROW_ABORT_FANOUTS.delete(signal);
      }
    } });
  const previousState = ROW_BUDGETS.get(previous);
  ROW_BUDGETS.set(budget, { controller, sourceSignal: signal, pages: new Map(previousState?.pages),
    retryUrls: new Set(retryUrls.map(officialHttpsUrl).filter(Boolean)), reads: new Set(), locales: new Map(), elapsedMs: 0,
    exhaustionReason: '', failures: new Map(), routes: new Map(),
    maxPages: Math.max(1, Math.min(16, Math.floor(Number(maxPages) || 16))),
    timeoutMs: Math.max(1, Math.min(60_000, Number(timeoutMs) || 60_000)),
    now: typeof now === 'function' ? now : () => Number(now) });
  return budget;
}

/** Reads and writes use the same rule, including historical cached results.
 * A partial crawl needs a verified identity decision; a run abort never writes. */
export function shouldPersistOfficialPostingResult(value, { signal, researchRan = false } = {}) {
  if (signal?.aborted) return false;
  const posting = normalizeOfficialPosting(value?.officialPosting || value?.posting || value);
  if (!posting) return false;
  const trail = posting.trail || [];
  if (['L1', 'L2', 'L3', 'L4'].includes(posting.level)) {
    if (posting.outcome === 'closed') return trail.includes('closed') && trail.includes('semantic-match-v1')
      && /^[a-f0-9]{64}$/u.test(posting.semanticMatch?.sourceHash || '');
    const partial = trail.includes('fetch-timeout') || trail.includes('crawl-budget') || trail.includes('crawl-partial');
    const agreedChoice = trail.find(code => /^comparative-choice-p[1-8]$/u.test(code))?.slice('comparative-choice-'.length);
    const semanticIdentity = posting.semanticMatch?.version === 1 && /^[a-f0-9]{64}$/u.test(posting.semanticMatch?.sourceHash)
      && trail.includes('semantic-match-v1') && trail.includes('comparative-match')
      && trail.includes('comparative-a-valid') && trail.includes('comparative-b-valid') && agreedChoice
      && trail.includes(`comparative-a-${agreedChoice}`) && trail.includes(`comparative-b-${agreedChoice}`);
    const identityProof = trail.includes('identifier-anchor') || semanticIdentity;
    return ['found', 'link-only'].includes(posting.outcome) && (!partial || identityProof);
  }
  if (posting.outcome === 'failed' || trail.some(code => RETRYABLE_MISS_TRAIL.has(code))) return false;
  return researchRan || trail.includes('bridge-research') || posting.outcome === 'closed'
    || trail.some(code => DEFINITIVE_MISS_TRAIL.has(code));
}

function crawlUrlAllowed(value) {
  const url = new URL(value);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return false; }
  if (/\.(?:[cm]?js|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp[34]|webm|wav|pdf|zip|gz|webmanifest|txt)$/iu.test(pathname)) return false;
  return !pathname.split('/').some(segment => /^(?:assets?|static|_next|_nuxt|images?|img|fonts?|scripts?|styles?|login|log-in|signin|sign-in|signup|sign-up|register|registration|registrationmethods|password|(?:reset|forgot|change)-?password|account|logout|log-out|privacy(?:-?policy)?|cookies?(?:-?policy)?|terms(?:-?(?:conditions|of-?use|of-?service))?|jobapplication)$/iu.test(segment.replace(/_/gu, '-')));
}

// Locale presentation does not create a second posting. Do not mistake a
// path-based ATS tenant (for example a tenant named "it") for a locale.
function crawlLocaleKey(value) {
  const url = new URL(value); const parts = url.pathname.split('/');
  const route = extractAtsTenant(value);
  const locale = /^(?:en|fr|de|es|it|pt|nl|sv|no|da|fi|pl|cs|sk|hu|ro|bg|el|tr|uk|ru|ar|he|ja|ko|zh|th|vi|id|ms|hi)(?:[-_][a-z]{4})?(?:[-_](?:[a-z]{2}|\d{3}))?$/iu;
  if (locale.test(parts[1] || '') && (!route || canonical(route.tenant) !== canonical(parts[1]))) parts.splice(1, 1);
  url.pathname = parts.join('/');
  for (const name of [...url.searchParams.keys()]) if (/^(?:lang|language|locale|culture|ui_locales|candidate_locale)$/iu.test(name)) url.searchParams.delete(name);
  url.searchParams.sort();
  return url.href;
}
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
function trailCodes(values) { return boundedOfficialPostingTrail(values); }
function fallback(job, options = {}) {
  try {
    const { outcome = 'not-found', trail = [], alternatives = [], fetchFailures = [] } = options || {};
    // Scraped identity remains untouched; only the bounded resolution display
    // fields use this projection. A malformed display cannot poison a run.
    // eslint-disable-next-line no-control-regex
    const display = (value, max) => String(value ?? '').normalize('NFKC').replace(/[<>\u0000-\u001f\u007f]/gu, '').trim().slice(0, max);
    const scraped = resolveScrapedEmployer(job || {});
    const safeAlternatives = (Array.isArray(alternatives) ? alternatives : []).slice(0, 12).flatMap(item => {
      const url = officialHttpsUrl(item?.url); const title = display(item?.title, 500);
      return url && title ? [{ url, title }] : [];
    });
    const failures = (Array.isArray(fetchFailures) ? fetchFailures : []).map(normalizeOfficialPostingFetchFailure).filter(Boolean).slice(0, OFFICIAL_FETCH_FAILURE_LIMIT);
    const officialPosting = normalizeOfficialPosting({ level: scraped.level, outcome,
      employer: display(scraped.employer, 120), trail: trailCodes(Array.isArray(trail) ? trail : []), alternatives: safeAlternatives,
      ...(failures.length ? { fetchFailures: failures } : {}) });
    if (officialPosting) return { postedBy: scraped.postedBy || undefined, officialPosting };
  } catch { /* Even the fallback must tolerate an invalid scraped row. */ }
  return { officialPosting: { level: 'L6', outcome: 'failed', employer: '', trail: ['failed'] } };
}
export function unresolvedOfficialPosting(job, options) { return fallback(job, options); }

export function freeOfficialPostingLeads(job) {
  const urls = normalizeApplyOptions(job?.applyOptions).map(option => option.href);
  for (const match of String(job?.snippet || '').matchAll(/https:\/\/[^\s<>"'`]+/gu)) {
    const token = match[0];
    // Reject an overlong token rather than clipping it into a different URL.
    // Punctuation trimming is therefore bounded by the URL validator's cap.
    if (token.length > 2000) continue;
    let end = token.length;
    while (end > 0 && '),.;'.includes(token[end - 1])) end -= 1;
    urls.push(token.slice(0, end));
  }
  urls.push(job?.url);
  return [...new Set(urls.map(officialHttpsUrl).filter(url => url && !isAggregatorHost(new URL(url).hostname) && crawlUrlAllowed(url)))].slice(0, 32);
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
  if (route.ats === 'smartrecruiters') return officialSmartRecruitersAdapterUrl(route, url);
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
  store = null, fetch = fetchOfficialPosting, candidateUrls = [], research = null, match = null, shortlist = null, semanticMatching = false,
  priorOfficialRecord = null, checkLiveness = null,
  signal, now = Date.now, bypassCache = false, persistMisses = true, persistResults = true, researchRan = false, rowBudget,
} = {}) {
  const instant = () => typeof now === 'function' ? now() : Number(now);
  const ownsBudget = !ROW_BUDGETS.has(rowBudget);
  const budget = ownsBudget ? createOfficialPostingRowBudget({ signal }) : rowBudget;
  const budgetState = ROW_BUDGETS.get(budget);
  const cancel = signal && budgetState.sourceSignal !== signal ? () => budgetState.controller.abort(signal.reason) : null;
  if (cancel) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }
  const abortBudget = code => {
    if (!budget.signal.aborted) {
      budgetState.exhaustionReason = code;
      budgetState.controller.abort(Object.assign(new Error(code), { code }));
    }
  };
  const abortCode = () => ['fetch-timeout', 'crawl-budget'].includes(budget.signal.reason?.code)
    ? budget.signal.reason.code : 'bridge-aborted';
  let researchSucceeded = researchRan === true;
  let semanticSettled = false;
  let semanticSource = null;
  const trail = []; let comparison = null; const candidates = new Map(); const pages = budgetState.pages; const fetchedCandidates = [];
  const bindPrior = record => {
    const prior = normalizeOfficialPosting(record?.officialPosting);
    return semanticMatching && prior && ['L1', 'L2', 'L3', 'L4'].includes(prior.level)
      && ['found', 'link-only', 'closed'].includes(prior.outcome) && prior.sourceUrl
      && officialPostingRecordMatchesScrapedIdentity(job, record)
      && officialPostingAliases(job).every(alias => record.aliases.includes(alias))
      && officialPostingSemanticProofMatches(job, prior) ? prior : null;
  };
  let boundPrior = bindPrior(priorOfficialRecord);
  const liveness = new Map(); let priorClosed = false; let priorUnclear = false;
  const rssCandidates = new Map(); const conflictingUrls = new Set();
  const signals = posterEmployerSignals(job);
  const hypotheses = [job?.company, ...signals.hypotheses].filter(Boolean);
  // Discovery names cannot override an employer explicitly named by the row.
  // Only an intermediary signal without an identity leaves that question open.
  const statedEmployers = signals.S1 || signals.S2 ? [signals.S1, signals.S2].filter(Boolean)
    : signals.S4.length ? signals.S4 : !signals.S3 ? [job?.company].filter(Boolean) : [];
  const domains = new Map(); const tenants = new Map(); const queue = []; const queued = new Set();
  const rootSites = new Map(); const careersPages = new Map(); const discoveredDomains = new Map(); const posterHosts = new Set();
  const scannedPages = new Map(); const followedByPage = new Map();
  // Amendment 3 section 1: which fetched root or careers pages link to a tenant or posting.
  const linkSources = new Map();
  // Round-trip ownership is decided on the pages read, not on the order they were read in. A posting whose proof had nothing to
  // work with is parked here and tried again whenever a root or link source is first learned (proofEpoch changes).
  const pendingRoundTrips = new Map(); let proofEpoch = 0;
  const noteLinks = (pageUrl, links) => {
    const host = normalizedSourceHost(pageUrl);
    if (!host || isKnownAtsHost(host) || isAggregatorHost(host) || !speaksForDomain(host)) return;
    const path = new URL(pageUrl).pathname;
    if (path !== '/' && !/\/(?:careers?|jobs?|positions?|openings?)(?:\/|$)/iu.test(path)) return;
    for (const link of links) {
      if (link.tag === 'script') continue;
      const linked = extractAtsTenant(link.url);
      for (const key of [linked ? `tenant|${linked.ats}|${linked.tenant}` : '', `posting|${officialHttpsUrl(link.url)}`]) {
        if (!key || key.endsWith('|')) continue;
        if (!linkSources.has(key)) linkSources.set(key, new Set());
        const sources = linkSources.get(key);
        if (!sources.has(host)) { sources.add(host); proofEpoch += 1; }
      }
    }
  };
  const enqueue = (value, context = {}) => {
    const url = officialHttpsUrl(value);
    if (!url || isAggregatorHost(new URL(url).hostname) || (!context.adapter && !crawlUrlAllowed(url))) return false;
    const route = context.route || extractAtsTenant(url);
    if (route) budgetState.routes.set(url, route);
    const localeKey = crawlLocaleKey(url);
    if (budgetState.locales.has(localeKey) && budgetState.locales.get(localeKey) !== url) return false;
    if (queued.has(url)) {
      const existing = queue.find(item => item.url === url);
      if (existing && context.provenEmployer) Object.assign(existing, context);
      return false;
    }
    if (queue.length >= 64) return false;
    budgetState.locales.set(localeKey, url);
    queued.add(url); queue.push({ url, ...context });
    return true;
  };
  const addLead = lead => {
    if (typeof lead === 'string') { enqueue(lead); return; }
    if (!lead || typeof lead !== 'object') return;
    if (typeof lead.employer === 'string' && lead.employer.length <= 120 && !hypotheses.includes(lead.employer)) hypotheses.push(lead.employer);
    for (const key of ['postingUrl', 'url', 'careersPageUrl', 'employerDomain']) {
      if (lead[key]) enqueue(key === 'employerDomain' && !lead[key].includes('://') ? `https://${lead[key]}/` : lead[key]);
    }
  };
  const read = async url => {
    if (budget.signal.aborted) { trail.push(abortCode()); return null; }
    if (budgetState.retryUrls.delete(url) && pages.has(url)) {
      const previous = await pages.get(url);
      if (previous.error) pages.delete(url);
    }
    if (!pages.has(url)) {
      if (budgetState.reads.size >= budgetState.maxPages) { abortBudget('crawl-budget'); trail.push('crawl-budget'); return null; }
      budgetState.reads.add(url);
      const pending = (async () => {
        let onAbort;
        const interrupted = new Promise((resolve, reject) => {
          onAbort = () => reject(Object.assign(new Error(abortCode()), { code: abortCode() }));
          budget.signal.addEventListener('abort', onAbort, { once: true });
          if (budget.signal.aborted) onAbort();
        });
        try {
          const page = await Promise.race([Promise.resolve().then(() => {
            if (budget.signal.aborted) throw Object.assign(new Error(abortCode()), { code: abortCode() });
            return fetch(url, { signal: budget.signal });
          }), interrupted]);
          return page ? { page: { ...page, requestedUrl: page.requestedUrl || url } } : { error: 'fetch-failed' };
        } catch (error) { return { error: budget.signal.aborted ? abortCode() : error?.code || 'fetch-failed',
          statusCode: error?.statusCode, reason: error?.reason, url: error?.url }; }
        finally { budget.signal.removeEventListener('abort', onAbort); }
      })();
      pages.set(url, pending);
      const result = await pending;
      const finalUrl = officialHttpsUrl(result.page?.url || result.page?.sourceUrl);
      if (finalUrl && normalizedSourceHost(finalUrl) === normalizedSourceHost(url) && !pages.has(finalUrl)) pages.set(finalUrl, pending);
    }
    const result = await pages.get(url);
    if (result.error) {
      budgetState.failures.set(url, result.error);
      // A page timeout is not a row-budget timeout. Once there is a winner,
      // only an unread page on its host or tenant can make that proof partial.
      if (result.error !== 'fetch-timeout' || budgetState.exhaustionReason) trail.push(result.error);
    } else budgetState.failures.delete(url);
    return result.page || null;
  };
  const rootProof = async (url, organization) => {
    const host = normalizedSourceHost(url);
    if (!host || isKnownAtsHost(host) || isAggregatorHost(host)) return false;
    const rootUrl = new URL('/', url).href;
    const page = await read(rootUrl);
    if (!page || !/html/iu.test(page.contentType || '')) return false;
    if (!sameOwnershipHost(page.url || page.sourceUrl || rootUrl, host)) return false;
    if (normalizedSourceHost(page.requestedUrl || rootUrl) !== host) return false;
    const scan = { ...scanOfficialCareersPage(page.body, page.url || rootUrl), footer: rootFooterText(page.body) };
    scannedPages.set(rootUrl, { scan, route: extractAtsTenant(rootUrl, { html: page.body }) });
    if (!rootSites.has(host)) proofEpoch += 1;
    rootSites.set(host, scan); noteLinks(rootUrl, scan.links);
    if (!strictEmployerEqual(job?.company, organization)
      && rootBrandingNamesPoster({ rootSiteName: scan.siteName, rootTitle: scan.title, rootFooter: scan.footer }, job?.company)) {
      posterHosts.add(host); domains.delete(host); discoveredDomains.delete(host);
      trail.push('poster-tenant'); return false;
    }
    if (posterHosts.has(host)) return false;
    const proof = proveEmployerDomain({ domain: host, employer: organization, poster: job?.company,
      rootSiteName: scan.siteName, rootTitle: scan.title, rootFooter: scan.footer,
      independentEmployer: discoveredDomains.get(host) || '' });
    const discovered = strictEmployerEqual(discoveredDomains.get(host), organization);
    if (proof || discovered) {
      const fetchedName = [scan.siteName, scan.title].find(name => strictEmployerEqual(name, organization));
      domains.set(host, fetchedName || discoveredDomains.get(host) || organization);
      trail.push('domain-proof');
    }
    return proof || discovered;
  };
  const careersLinkProof = (page, postingUrl) => {
    if (posterHosts.has(page.host) || !strictEmployerEqual(domains.get(page.host), page.employer)) return false;
    const root = rootSites.get(page.host);
    const proven = proveEmployerDomain({ domain: page.host, employer: page.employer, poster: job?.company,
      rootSiteName: root?.siteName || '', rootTitle: root?.title || '', careersPageUrl: page.url,
      rootFooter: root?.footer || '', independentEmployer: domains.get(page.host),
      careersPageEmployer: page.employer, careersLinks: page.links, postingUrl });
    return proven;
  };
  // Amendment 3 section 1. D links to T or P, T's posting names the employer and
  // points back to D, D's brand is the employer's, and no veto applies.
  const roundTripOwnership = async (candidate, route, url, organization) => {
    const sameAs = candidate.sameAs || candidate.hiringOrganization?.sameAs || '';
    const domain = registrableDomain(sameAs);
    if (!domain || !strictEmployerEqual(candidate.hiringOrganization?.name, organization) || registrableDomain(url) === domain) return false;
    const organizationHost = normalizedSourceHost(sameAs);
    if (!speaksForDomain(organizationHost)) return false;
    const linkersOf = () => [...(linkSources.get(`tenant|${route.ats}|${route.tenant}`) || []), ...(linkSources.get(`posting|${url}`) || [])]
      .filter(host => registrableDomain(host) === domain);
    if (![...rootSites.keys()].some(host => registrableDomain(host) === domain)) await rootProof(sameAs, organization);
    let linkers = linkersOf();
    if (!linkers.length) {
      // T5: the proof must not depend on which page the crawl happened to read first. Read up to two careers pages that D's own root links to.
      const rootScan = rootSites.get(organizationHost) || rootSites.get([...rootSites.keys()].find(host => registrableDomain(host) === domain));
      const careers = (rootScan?.links || []).filter(link => link.tag === 'a' && registrableDomain(link.url) === domain
        && /\/(?:careers?|jobs?|positions?|openings?)(?:\/|$)/iu.test(new URL(link.url).pathname) && crawlUrlAllowed(link.url)).slice(0, 2);
      for (const link of careers) {
        const page = await read(link.url);
        if (page && /html/iu.test(page.contentType || '')) noteLinks(link.url, scanOfficialCareersPage(page.body, link.url).links);
      }
      linkers = linkersOf();
    }
    if (!linkers.length) return false;
    const root = rootSites.get(organizationHost) || rootSites.get([...rootSites.keys()].find(host => registrableDomain(host) === domain)) || {};
    if (!proveBidirectionalOwnership({ domain, employer: organization, poster: job?.company, route, linksToTenant: true, tenantPointsBack: true,
      rootTitle: root.title || '', rootSiteName: root.siteName || '', rootFooter: root.footer || '' })) return false;
    for (const host of new Set([...linkers, organizationHost])) if (!domains.has(host)) domains.set(host, organization);
    tenants.set(`${route.ats}|${route.tenant}`, organization);
    for (const [key, earlier] of candidates) {
      if (earlier.ats === route.ats && earlier.tenant === route.tenant && strictEmployerEqual(earlier.employer, organization)) {
        candidates.set(key, { ...earlier, tenantProven: true, provenance: 'careers' });
      }
    }
    trail.push('domain-proof');
    return true;
  };
  const capture = async (candidate, context) => {
    const url = officialHttpsUrl(candidate.sourceUrl);
    if (!url) return;
    if (!semanticMatching && conflictingUrls.has(url)) return;
    if (!context.boardApi && url !== officialHttpsUrl(context.fetchedUrl)) {
      if (context.follow) context.follow(url);
      else enqueue(url);
      return;
    }
    const host = normalizedSourceHost(url); const route = extractAtsTenant(url, {
      html: url === officialHttpsUrl(context.fetchedUrl) ? context.fetchedHtml || '' : '',
    });
    if (context.route && (!route || context.route.ats !== route.ats || context.route.tenant !== route.tenant)) {
      trail.push('tenant-unproven'); return;
    }
    fetchedCandidates.push({ ...candidate, sourceUrl: url, ats: route?.ats || '', tenant: route?.tenant || '' });
    const routeKey = route ? `${route.ats}|${route.tenant}` : '';
    const careerEmployer = tenants.get(routeKey) || context.provenEmployer || '';
    const organization = candidate.employer || candidate.hiringOrganization?.name || careerEmployer;
    const matchesHypothesis = hypotheses.some(name => strictEmployerEqual(name, organization));
    if (!organization || (!semanticMatching && (!matchesHypothesis || (statedEmployers.length && !statedEmployers.some(name => strictEmployerEqual(name, organization)))))) return;
    if (!semanticMatching && route && (!strictEmployerEqual(organization, job?.company) || signals.S3) && isPosterAtsTenant(route, job?.company)) {
      trail.push('poster-tenant'); return;
    }
    const sameAs = candidate.sameAs || candidate.hiringOrganization?.sameAs || '';
    const organizationHost = normalizedSourceHost(sameAs);
    const independentlyTied = organizationHost && organizationHost !== host && await rootProof(sameAs, organization);
    const offDomain = independentlyTied && proveEmployerDomain({
      domain: organizationHost, employer: organization, poster: job?.company, postingUrl: url, sameAs,
      independentEmployer: domains.get(organizationHost) || '',
      rootSiteName: rootSites.get(organizationHost)?.siteName || '', rootTitle: rootSites.get(organizationHost)?.title || '',
      rootFooter: rootSites.get(organizationHost)?.footer || '',
    });
    const linked = Boolean(careerEmployer && strictEmployerEqual(careerEmployer, organization));
    const structured = Boolean(offDomain && candidate.hiringOrganization?.name
      && strictEmployerEqual(candidate.hiringOrganization.name, organization));
    for (const page of careersPages.values()) {
      if (page.host === host && strictEmployerEqual(page.employer, organization)) careersLinkProof(page, url);
    }
    // T11: an own-employer row whose own lead IS this self-hosted posting, on the employer's apex or conventional careers host whose
    // registrable label is the employer's name, needs no root-title match ("Snowflake Careers", "Working at Intuit" are not exact).
    const ownLead = [job?.url, ...normalizeApplyOptions(job?.applyOptions).map(option => option.href)].map(canonicalLeadUrl).includes(canonicalLeadUrl(url));
    const brandLead = !route && ownLead && strictEmployerEqual(job?.company, organization) && !signals.S3 && !signals.S1 && !signals.S2 && !signals.S4.length
      && speaksForDomain(host) && !isAggregatorHost(host) && !isKnownAtsHost(host) && domainBrandMatchesEmployer({ domain: host, employer: organization });
    const domainProven = Boolean(domains.has(host) && strictEmployerEqual(domains.get(host), organization))
      || (!route && await rootProof(url, organization))
      || Boolean(brandLead && (domains.set(host, organization), trail.push('domain-proof')));
    const officialPortalProven = /^(?:www\.)?usajobs\.gov$/u.test(host)
      && /^\/job\/\d+\/?$/u.test(new URL(url).pathname)
      && url === officialHttpsUrl(context.fetchedUrl)
      && strictEmployerEqual(candidate.hiringOrganization?.name, job?.company);
    const roundTrip = Boolean(route) && !linked && !structured && await roundTripOwnership(candidate, route, url, organization);
    const proven = linked || structured || roundTrip || (route?.ats === 'teamtailor' && domainProven);
    const enriched = { ...candidate, employer: organization, sourceUrl: url, ats: route?.ats || '', tenant: route?.tenant || '',
      tenantProven: Boolean(route && proven), employerDomainProven: domainProven,
      officialPortalProven,
      posterTenant: false,
      provenance: linked || roundTrip ? 'careers' : route ? 'structured' : 'employer' };
    if (semanticMatching) {
      // Separate host-fetched representations may disagree about the same URL.
      // Keep each intact so AI sees that disagreement rather than a merged fiction.
      const key = `${url}|${crypto.createHash('sha256').update(JSON.stringify(enriched)).digest('hex')}`;
      candidates.set(key, enriched);
    } else {
      const existing = candidates.get(url);
      if (existing && (!strictEmployerEqual(existing.employer, enriched.employer)
        || coreTitle(existing.title, { company: existing.employer, location: existing.location })
          !== coreTitle(enriched.title, { company: enriched.employer, location: enriched.location })
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
    }
    if (route && proven) {
      tenants.set(routeKey, organization);
      const adapter = adapterUrl(route, url);
      if (adapter) enqueue(adapter, { route, provenEmployer: organization, adapter: true });
    } else if (route && sameAs) pendingRoundTrips.set(url, { candidate, route, organization, epoch: proofEpoch });
  };
  // Try parked round trips again when a root or link source has been learned since their last attempt. The proof is the same
  // proof, so this only removes the dependence on which lead the crawl happened to read first.
  const retryRoundTrips = async () => {
    for (const [url, pending] of [...pendingRoundTrips]) {
      if (budget.signal.aborted) return;
      const pendingSources = [...candidates.values()].filter(candidate => candidate.sourceUrl === url);
      if (!pendingSources.length || conflictingUrls.has(url) || pendingSources.every(candidate => candidate.tenantProven)) { pendingRoundTrips.delete(url); continue; }
      if (pending.epoch === proofEpoch) continue;
      let proven = false;
      try { proven = await roundTripOwnership(pending.candidate, pending.route, url, pending.organization); }
      finally { pending.epoch = proofEpoch; }
      if (!proven) continue;
      pendingRoundTrips.delete(url);
      const adapter = adapterUrl(pending.route, url);
      if (adapter) enqueue(adapter, { route: pending.route, provenEmployer: pending.organization, adapter: true });
    }
  };
  // Source pages may precede the root that proves their ownership. Reapply
  // the same fetched-link attestations when that proof arrives; queue order
  // must not decide whether an already-read posting belongs to its employer.
  const propagateOwnership = async () => {
    let changed = true;
    while (changed && !budget.signal.aborted) {
      changed = false;
      for (const [host, employer] of discoveredDomains) {
        if (domains.has(host) || posterHosts.has(host)) continue;
        if (await rootProof(`https://${host}/`, employer)) { changed = true; proofEpoch += 1; }
      }
      for (const [sourceUrl, { scan, route }] of scannedPages) {
        const host = normalizedSourceHost(sourceUrl); const employer = domains.get(host);
        if (!employer || posterHosts.has(host)) continue;
        let followed = followedByPage.get(sourceUrl) || 0;
        if (route && !tenants.has(`${route.ats}|${route.tenant}`)) {
          tenants.set(`${route.ats}|${route.tenant}`, employer); changed = true; proofEpoch += 1;
        }
        for (const link of scan.links) {
          const linkedRoute = extractAtsTenant(link.url);
          if (linkedRoute) {
            const key = `${linkedRoute.ats}|${linkedRoute.tenant}`;
            if (!tenants.has(key)) {
              tenants.set(key, employer); changed = true; proofEpoch += 1;
            }
            continue;
          }
          const linkHost = normalizedSourceHost(link.url);
          if (link.tag !== 'a' || link.attribute !== 'href' || linkHost === host || isKnownAtsHost(linkHost)
            || isAggregatorHost(linkHost) || !crawlUrlAllowed(link.url)
            || !(/\/(?:careers?|jobs?|positions?|openings?)(?:\/|$)/iu.test(new URL(link.url).pathname)
              || /^(?:careers?|jobs?)\./iu.test(linkHost))) continue;
          if (!discoveredDomains.has(linkHost)) {
            discoveredDomains.set(linkHost, employer); changed = true;
          }
          if (followed < 8 && enqueue(link.url)) followed += 1;
        }
        followedByPage.set(sourceUrl, followed);
      }
      for (const [key, candidate] of candidates) {
        const route = candidate.ats && candidate.tenant ? candidate : extractAtsTenant(candidate.sourceUrl);
        const employer = route ? tenants.get(`${route.ats}|${route.tenant}`) : domains.get(normalizedSourceHost(candidate.sourceUrl));
        if (!strictEmployerEqual(employer, candidate.employer)) continue;
        if (route && !candidate.tenantProven) {
          candidates.set(key, { ...candidate, tenantProven: true, provenance: 'careers' });
          const adapter = adapterUrl(route, candidate.sourceUrl);
          if (adapter) enqueue(adapter, { route, provenEmployer: employer, adapter: true });
        } else if (!route && !candidate.employerDomainProven) {
          candidates.set(key, { ...candidate, employerDomainProven: true, provenance: 'employer' });
        }
      }
    }
  };
  const belongsToWinnerSite = (url, winner) => {
    const route = budgetState.routes.get(url) || extractAtsTenant(url);
    const winnerRoute = winner.ats && winner.tenant ? winner : extractAtsTenant(winner.sourceUrl);
    // Shared ATS hosts contain unrelated tenants; their tenant is the site.
    if (route && winnerRoute) return route.ats === winnerRoute.ats && route.tenant === winnerRoute.tenant;
    return !isKnownAtsHost(normalizedSourceHost(url))
      && normalizedSourceHost(url) === normalizedSourceHost(winner.sourceUrl);
  };
  const matchOptions = () => ({ now: instant(), peerCandidates: fetchedCandidates, employerHypotheses: [...new Set([...candidates.values()]
    .filter(candidate => candidate.tenantProven || candidate.employerDomainProven || candidate.officialPortalProven).map(candidate => candidate.employer))] });
  const drain = async () => {
    if (budget.signal.aborted) { trail.push(abortCode()); return; }
    const remaining = budgetState.timeoutMs - budgetState.elapsedMs;
    if (remaining <= 0) { abortBudget('fetch-timeout'); trail.push('fetch-timeout'); return; }
    const started = budgetState.now();
    const timer = setTimeout(() => abortBudget('fetch-timeout'), remaining);
    try {
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      if (budgetState.now() - started >= remaining) abortBudget('fetch-timeout');
      if (budget.signal.aborted) { trail.push(abortCode()); break; }
      const context = queue[cursor];
      // A known direct ATS detail route can expose its documented API even
      // when the public HTML is blocked. The URL-derived adapter supplies
      // source bytes only; capture still requires normal ownership proof.
      const directRoute = context.route || extractAtsTenant(context.url);
      if (!context.adapter && directRoute?.ats === 'smartrecruiters') {
        const adapter = adapterUrl(directRoute, context.url);
        if (adapter) enqueue(adapter, { route: directRoute, adapter: true,
          ...(context.provenEmployer ? { provenEmployer: context.provenEmployer } : {}) });
      }
      const page = await read(context.url);
      if (!page) continue;
      const sourceUrl = page.url || page.sourceUrl || context.url;
      if (context.adapter && officialHttpsUrl(sourceUrl) !== officialHttpsUrl(context.url)) { trail.push('tenant-unproven'); continue; }
      const route = context.route || extractAtsTenant(sourceUrl, { html: page.body });
      let followed = 0;
      let scan = null;
      if (/html/iu.test(page.contentType || '')) {
        scan = scanOfficialCareersPage(page.body, sourceUrl);
        scannedPages.set(sourceUrl, { scan, route });
        const host = normalizedSourceHost(sourceUrl);
        noteLinks(sourceUrl, scan.links);
        for (const organization of hypotheses) if (await rootProof(sourceUrl, organization)) break;
        // A path title is never authority. This host must already be tied to
        // the employer by a fetched strict root or proven-host discovery.
        const careersEmployer = domains.get(host) || '';
        if (!isKnownAtsHost(host) && !isAggregatorHost(host)
          && /\/(?:careers?|jobs?|positions?|openings?)(?:\/|$)/iu.test(new URL(sourceUrl).pathname)
          && hypotheses.some(name => strictEmployerEqual(name, careersEmployer))) {
          const page = { host, url: sourceUrl, employer: careersEmployer, links: scan.links.map(link => link.url) };
          careersPages.set(sourceUrl, page);
          for (const link of scan.links) {
            const existing = [...candidates.values()].find(candidate => candidate.sourceUrl === link.url);
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
        // Navigation wins over resource detection. A script can identify a
        // tenant and its bounded board adapter, but is never a fetch target.
        const links = [...scan.links.filter(link => link.tag !== 'script'), ...scan.links.filter(link => link.tag === 'script')];
        for (const link of links) {
          const linkedRoute = extractAtsTenant(link.url);
          if (link.tag === 'script') {
            if (linkedRoute && provenEmployer) tenants.set(`${linkedRoute.ats}|${linkedRoute.tenant}`, provenEmployer);
            const adapter = linkedRoute && adapterUrl(linkedRoute, link.url);
            if (adapter && followed < 8 && enqueue(adapter, { route: linkedRoute, ...(provenEmployer ? { provenEmployer } : {}), adapter: true })) followed += 1;
            continue;
          }
          if (followed >= 8 || !crawlUrlAllowed(link.url)) continue;
          const linkHost = normalizedSourceHost(link.url);
          if (provenEmployer && link.tag === 'a' && link.attribute === 'href' && !linkedRoute && linkHost !== host && !isKnownAtsHost(linkHost)
            && !isAggregatorHost(linkHost) && (/\/(?:careers?|jobs?|positions?|openings?)(?:\/|$)/iu.test(new URL(link.url).pathname)
              || /^(?:careers?|jobs?)\./iu.test(linkHost))) {
            discoveredDomains.set(linkHost, provenEmployer);
            if (enqueue(link.url)) followed += 1;
          }
          if (linkedRoute && provenEmployer) tenants.set(`${linkedRoute.ats}|${linkedRoute.tenant}`, provenEmployer);
          if (linkedRoute || (normalizedSourceHost(link.url) === host && /\/(?:careers?|jobs?|positions?|openings?)(?:\/|$)/iu.test(new URL(link.url).pathname))) {
            if (enqueue(link.url, { ...(linkedRoute ? { route: linkedRoute } : {}),
              ...(linkedRoute && provenEmployer ? { provenEmployer } : {}) })) followed += 1;
            if (linkedRoute && provenEmployer && followed < 8) {
              const adapter = adapterUrl(linkedRoute, link.url);
              if (adapter && enqueue(adapter, { route: linkedRoute, provenEmployer, adapter: true })) followed += 1;
            }
          }
        }
        followedByPage.set(sourceUrl, followed);
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
        let rssFollowed = 0;
        for (const candidate of extracted) {
          if (route?.ats === 'teamtailor' && /(?:xml|rss)/iu.test(page.contentType || '')) {
            // The board bytes are already fetched. Keep every description in
            // the distinctive-phrase cohort, even when its page is irrelevant.
            fetchedCandidates.push({ ...candidate, ats: route.ats, tenant: route.tenant });
            if (semanticMatching) {
              await capture(candidate, { ...context, route, provenEmployer: employer, fetchedUrl: sourceUrl, boardApi: true });
              continue;
            }
            const rowTitle = coreTitle(job?.title, { company: job?.company, location: job?.location,
              employerHypotheses: [employer, ...signals.hypotheses].filter(Boolean) });
            if (!rowTitle || rowTitle !== coreTitle(candidate.title, { company: candidate.employer || employer,
              location: candidate.location }) || !locationsCompatible(job, candidate)) continue;
            if (rssFollowed >= 8) continue;
            rssCandidates.set(officialHttpsUrl(candidate.sourceUrl), candidate);
            if (enqueue(candidate.sourceUrl, { route, provenEmployer: employer })) rssFollowed += 1;
            continue;
          }
          const rss = rssCandidates.get(officialHttpsUrl(candidate.sourceUrl));
          const idsAgree = rss && (!(rss.identifier && candidate.identifier) || rss.identifier === candidate.identifier);
          const employersAgree = rss && (!(rss.employer && candidate.employer) || strictEmployerEqual(rss.employer, candidate.employer));
          const boundRss = !semanticMatching && rss && idsAgree && employersAgree
            && coreTitle(rss.title, { company: rss.employer, location: rss.location })
              === coreTitle(candidate.title, { company: candidate.employer, location: candidate.location })
            && ((rss.identifier && candidate.identifier && rss.identifier === candidate.identifier) || locationsCompatible(rss, candidate));
          await capture(boundRss && rss.description.length > candidate.description.length
            ? { ...candidate, description: rss.description } : candidate, { ...context, provenEmployer: employer,
              fetchedUrl: sourceUrl, fetchedHtml: /html/iu.test(page.contentType || '') ? page.body : '',
              follow: url => { if (followed < 8 && enqueue(url)) followed += 1; },
              boardApi: context.adapter === true && /json/iu.test(page.contentType || '') });
        }
        if (extracted.length) trail.push(context.adapter ? 'ats-adapter' : 'json-ld');
      } catch { trail.push('unreadable'); }
      try { await propagateOwnership(); await retryRoundTrips(); } catch { trail.push('unreadable'); }
      if (semanticMatching) continue;
      const verified = selectOfficialPostingMatch(job, [...candidates.values()], matchOptions());
      if (verified.outcome === 'found' && frozenOfficialEmployer(job, verified.candidate.employer)
        && readableDescription(verified.candidate, job)) {
        // T4: stop early only on a deterministic anchor with none of the row's own leads left to read. A text-only
        // match waits until the same host or tenant has no unread queued page, so a closed twin cannot arrive after it.
        const anchor = verified.evaluations.find(item => item.passed)?.anchor;
        const winner = verified.candidate;
        const unread = queue.slice(cursor + 1);
        const ownLeads = new Set([job?.url, ...normalizeApplyOptions(job?.applyOptions).map(option => option.href)].map(canonicalLeadUrl).filter(Boolean));
        const unreadLead = unread.some(item => ownLeads.has(canonicalLeadUrl(item.url)));
        const unreadSite = unread.some(item => belongsToWinnerSite(item.url, winner));
        if (!unreadLead && (anchor === 'identifier-anchor' || !unreadSite)) break;
      }
    }
    } finally {
      clearTimeout(timer);
      budgetState.elapsedMs += Math.max(0, budgetState.now() - started);
      if (budgetState.elapsedMs >= budgetState.timeoutMs) abortBudget('fetch-timeout');
      if (budget.signal.aborted) trail.push(abortCode());
    }
  };
  const settleSourceLiveness = async () => {
    if (!semanticMatching) return;
    const sources = new Map();
    for (const candidate of candidates.values()) {
      if (!evaluateOfficialPostingSourceEligibility(candidate, { now: instant }).eligible) continue;
      const key = canonicalLeadUrl(candidate.sourceUrl);
      if (!sources.has(key)) sources.set(key, { url: candidate.sourceUrl, candidate });
    }
    const priorKey = boundPrior ? canonicalLeadUrl(boundPrior.sourceUrl) : '';
    if (priorKey && !sources.has(priorKey)) sources.set(priorKey, { url: boundPrior.sourceUrl, candidate: null });
    for (const [key, { url, candidate }] of sources) {
      if (!liveness.has(key)) {
        const fetched = await pages.get(url) || await pages.get([...pages.keys()].find(value => canonicalLeadUrl(value) === key));
        const page = fetched?.page;
        let verdict = [404, 410].includes(Number(fetched?.statusCode ?? page?.statusCode)) ? 'closed' : null;
        if (!verdict && page && /html/iu.test(page.contentType || '') && typeof page.body === 'string') {
          const evidence = evidenceFromHtml(page.body, { board: 'official', ruleKey: 'generic',
            requestedUrl: url, finalUrl: page.url || page.sourceUrl || url, httpStatus: page.statusCode || 200,
            expectedTitle: candidate?.title || boundPrior?.title || job?.title,
            expectedCompany: candidate?.employer || boundPrior?.employer || job?.company,
            expectedLocation: candidate?.location?.display || job?.location,
            descriptionText: candidate?.description || '' });
          const expired = candidate?.validThrough && Date.parse(candidate.validThrough) < instant();
          if (expired || evidence.closedHits.some(hit => hit.insideDescription === false)) {
            verdict = 'unclear';
            const classification = classifyListingLiveness(evidence, LISTING_LIVENESS_RULES.generic);
            if (classification.verdict === 'closed') verdict = 'closed';
            else if (classification.verdict === 'needs-ai' && typeof checkLiveness === 'function' && !signal?.aborted) {
              try {
                const answer = await checkLiveness(job, evidence, { signal });
                if (['open', 'closed'].includes(answer)) verdict = answer;
              } catch { /* Unresolved current closure cannot become live. */ }
            }
          }
        }
        if (!verdict && key === priorKey && (!candidate || fetched?.error || !page)) verdict = 'unclear';
        if (verdict) liveness.set(key, verdict);
      }
      const verdict = liveness.get(key);
      if (!verdict) continue;
      if (verdict === 'unclear') trail.push('official-liveness-unconfirmed');
      if (key === priorKey) {
        priorClosed ||= verdict === 'closed'; priorUnclear ||= verdict === 'unclear';
        // A current status-only page still belongs to the exact previously
        // proved identity. Its historical text remains labelled by status;
        // no old result is returned as a fresh open match.
        if (!candidate) {
          let description = '';
          if (boundPrior.contentHash && store?.readText) try { description = await store.readText(boundPrior.contentHash) || ''; } catch { /* Metadata still binds the historical identity. */ }
          const historyRoute = extractAtsTenant(boundPrior.sourceUrl);
          const atsSource = Boolean(historyRoute || isKnownAtsHost(normalizedSourceHost(boundPrior.sourceUrl)));
          const historical = { ...boundPrior, description, employer: boundPrior.employer,
            hiringOrganization: { name: boundPrior.employer, sameAs: '' },
            ats: historyRoute?.ats || boundPrior.ats || '', tenant: historyRoute?.tenant || boundPrior.tenant || '',
            tenantProven: atsSource, employerDomainProven: !atsSource,
            provenance: 'historical verified posting', sourceUrl: boundPrior.sourceUrl };
          candidates.set(`historical|${key}`, withHostOfficialPostingLiveness(historical, verdict));
        }
      }
      for (const [id, record] of candidates) if (canonicalLeadUrl(record.sourceUrl) === key) {
        candidates.set(id, withHostOfficialPostingLiveness(record, verdict));
      }
    }
  };
  const persist = async result => {
    const receipts = await Promise.all([...pages].map(async ([url, pending]) => [url, await pending]));
    // A researched lead can recover a previously failed redirect destination.
    // Do not keep blaming that hop through its older requested-URL alias.
    const recoveredUrls = new Set();
    for (const [url, receipt] of receipts) {
      if (!receipt.page || receipt.page.statusCode && receipt.page.statusCode !== 200) continue;
      for (const value of [url, receipt.page.url, receipt.page.sourceUrl]) {
        const recovered = officialHttpsUrl(value);
        if (recovered) recoveredUrls.add(recovered);
      }
    }
    const failures = new Map();
    for (const [url, page] of receipts) {
      if (!page.error) continue;
      const failure = officialPostingFetchFailure({ ...page, code: page.error }, url);
      if (failure && !recoveredUrls.has(failure.url)) failures.set(failure.url, failure);
    }
    if (result.officialPosting && failures.size) result.officialPosting.fetchFailures = [...failures.values()].slice(0, OFFICIAL_FETCH_FAILURE_LIMIT);
    if (comparison) result.comparison = comparison;
    if (semanticMatching && semanticSettled && result.officialPosting) {
      result.officialPosting.semanticMatch = { version: 1, inputHash: officialPostingSemanticInputHash(job),
        ...(semanticSource ? { sourceHash: officialPostingSemanticSourceHash(semanticSource, { now: instant }) } : {}) };
      result.officialPosting.trail = trailCodes([...(result.officialPosting.trail || []), 'semantic-match-v1']);
    }
    if (result.description) result.officialPosting.contentHash = crypto.createHash('sha256').update(result.description).digest('hex');
    // Incidental host limits end the crawl without stopping the run. The
    // shared predicate keeps a partial match durable only on a verified identity decision.
    const durability = ['L1', 'L2', 'L3', 'L4'].includes(result.officialPosting?.level)
      ? { aborted: Boolean(signal?.aborted || budgetState.sourceSignal?.aborted) } : budget.signal;
    if (store && persistResults && !result.expiryCandidates?.length
      && (persistMisses || !['L5', 'L6'].includes(result.officialPosting?.level))
      && shouldPersistOfficialPostingResult(result, { signal: durability, researchRan: researchSucceeded })) {
      try {
        result.record = await store.save(job, { officialPosting: result.officialPosting, description: result.description });
        result.officialPosting = result.record.officialPosting;
      } catch { return fallback(job, { outcome: 'failed', trail: [...(result.officialPosting?.trail || []), 'storage-failed'], fetchFailures: result.officialPosting?.fetchFailures }); }
    }
    return result;
  };
  try {
    if (store && !bypassCache) {
      const record = await store.find(job);
      if (record && officialPostingRecordMatchesScrapedIdentity(job, record)
        && (!semanticMatching || officialPostingSemanticProofMatches(job, record))) {
        if (['L5', 'L6'].includes(record.officialPosting?.level)
          && !record.officialPosting?.trail?.includes('closed')
          && shouldPersistOfficialPostingResult(record, { signal: budget.signal })) {
          const current = fallback(job, { outcome: record.officialPosting.outcome,
            trail: [...(record.officialPosting.trail || []), 'recent-miss'], alternatives: record.officialPosting.alternatives || [] });
          if (semanticMatching) current.officialPosting.semanticMatch = record.officialPosting.semanticMatch;
          return { ...current, record: { ...record, officialPosting: current.officialPosting } };
        }
        if (!['L5', 'L6'].includes(record.officialPosting?.level)
          && ['found', 'link-only'].includes(record.officialPosting.outcome)
          && shouldPersistOfficialPostingResult(record, { signal: budget.signal })) return { record, postedBy: strictEmployerEqual(record.officialPosting.employer, job?.company) ? undefined : job?.company,
          officialPosting: { ...record.officialPosting, trail: trailCodes([...(record.officialPosting.trail || []), 'cache-hit']) } };
        if (record.officialPosting?.outcome === 'closed') boundPrior ||= bindPrior(record);
      }
    }
    if (boundPrior) enqueue(boundPrior.sourceUrl);
    for (const lead of candidateUrls) addLead(lead);
    for (const url of freeOfficialPostingLeads(job)) enqueue(url);
    await drain();
    const semanticDecision = async () => {
      await settleSourceLiveness();
      const result = await resolveSemanticOfficialPosting(job, [...candidates.values()], { match, shortlist, signal, now: instant });
      trail.push(...result.trail);
      comparison = result.comparison || null; semanticSettled = result.settled;
      semanticSource = result.evaluations?.find(item => item.identityPass)?.candidate || null;
      if (result.outcome !== 'found' && priorClosed) {
        trail.push('closed');
        semanticSource = [...candidates.values()].find(candidate => canonicalLeadUrl(candidate.sourceUrl) === canonicalLeadUrl(boundPrior.sourceUrl));
        semanticSettled = true;
        return { ...result, outcome: 'closed', candidate: null, trail: [...result.trail, 'closed'] };
      }
      if (result.outcome !== 'found' && priorUnclear) return { ...result, outcome: 'unreadable', candidate: null,
        trail: [...result.trail, 'official-liveness-unconfirmed'] };
      return result;
    };
    let decision = semanticMatching ? await semanticDecision() : selectOfficialPostingMatch(job, [...candidates.values()], matchOptions());
    if (decision.outcome !== 'found' && !budget.signal.aborted && research) {
      trail.push('bridge-research');
      try {
        const leads = await research(job, { signal: budget.signal });
        if (!Array.isArray(leads)) throw Object.assign(new Error('Invalid research result'), { code: 'research-miss' });
        researchSucceeded = true;
        for (const lead of leads) addLead(lead);
        await drain();
      } catch (error) { trail.push(error?.code || (budget.signal.aborted ? abortCode() : 'research-miss')); }
      decision = semanticMatching ? await semanticDecision() : selectOfficialPostingMatch(job, [...candidates.values()], matchOptions());
    }
    // A researched row compares every identity-passing posting together. A settled
    // deterministic closed winner remains authoritative before any AI step.
    if (!semanticMatching && decision.outcome !== 'found' && decision.outcome !== 'closed' && researchSucceeded && !budget.signal.aborted) {
      const context = matchOptions();
      // A conservative floor leaves room for three independent eight-word
      // passages across the required parts. Missing input is never a settled miss.
      const sufficient = (flatPostingText(job?.snippet || job?.description || '').match(/[\p{L}\p{N}]+/gu) || []).length > 30;
      const { options, preCapCount, contradictionOnly } = sufficient
        ? buildOfficialPostingComparisonSet(job, [...candidates.values()], context) : { options: [], preCapCount: 0, contradictionOnly: [] };
      if (!sufficient) trail.unshift('insufficient-text');
      const seenText = new Set();
      const identicalText = options.some(option => {
        const flat = flatPostingText(option.description).toLocaleLowerCase();
        if (seenText.has(flat)) return true;
        seenText.add(flat); return false;
      });
      if (identicalText) {
        trail.unshift('ambiguous');
        decision = { ...decision, outcome: 'ambiguous', candidate: null,
          alternatives: options.map(option => ({ url: option.candidate.sourceUrl, title: option.title })) };
      } else if (options.length) {
        if (preCapCount > 8) trail.unshift('comparative-truncated');
        comparison = { optionCount: options.length, preCapCount, truncated: preCapCount > 8, validA: false, validB: false,
          choiceA: null, choiceB: null, agreement: false, disagreement: false,
          none: false, unavailable: false, accepted: false, invalidRuns: 0 };
        const runs = {};
        for (const run of ['A', 'B']) {
          let answer = null;
          let failure = null;
          const attempts = match?.handlesCorrections === true ? 1 : 2;
          let correction = {};
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            if (!match || budget.signal.aborted) {
              failure = Object.assign(new Error('Comparative match unavailable'), {
                code: budget.signal.aborted ? abortCode() : 'comparative-unavailable' });
              break;
            }
            try {
              const raw = await match(job, options, { run, peerCandidates: context.peerCandidates, contradictionOnly,
                employerHypotheses: context.employerHypotheses, signal: budget.signal, ...correction });
              if (budget.signal.aborted) throw Object.assign(new Error('Comparison aborted'), { code: abortCode() });
              // Host validation also covers injected callers; a stub is never an acceptance bypass.
              answer = validateOfficialPostingMatchResponse(raw, { job, options, contradictionOnly,
                peerCandidates: context.peerCandidates, employerHypotheses: context.employerHypotheses });
              failure = null;
              break;
            } catch (error) {
              failure = error;
              if (!Array.isArray(error?.correctionDetails) || !error.correctionDetails.length || attempt + 1 >= attempts) break;
              correction = { correctionDetails: [...error.correctionDetails], correctionRuleIds: [...(error.correctionRuleIds || [])], correctionAttempt: 1 };
            }
          }
          runs[run] = answer;
          comparison[`valid${run}`] = Boolean(answer);
          comparison[`choice${run}`] = answer?.choice || null;
          if (!answer) {
            comparison.invalidRuns += 1;
            const code = failure?.code === 'OFFICIAL_POSTING_COMPARATIVE_UNAVAILABLE' ? 'comparative-unavailable' : failure?.code;
            if (['comparative-unavailable', 'bridge-unavailable'].includes(code)) comparison.unavailable = true;
            if (OFFICIAL_POSTING_TRAIL.includes(code)) trail.push(code);
          }
        }
        trail.unshift(...officialPostingComparativeTrail(comparison));
        if (!runs.A || !runs.B) {
          trail.unshift(comparison.unavailable ? 'comparative-unavailable' : 'comparative-invalid');
          decision = { ...decision, outcome: 'not-found', candidate: null, alternatives: [] };
        } else if (runs.A.choice !== runs.B.choice) {
          comparison.disagreement = true;
          const chosen = new Set([runs.A.choice, runs.B.choice]);
          trail.unshift('comparative-disagree');
          decision = { ...decision, outcome: 'ambiguous', candidate: null,
            alternatives: options.filter(option => chosen.has(option.id)).map(option => ({ url: option.candidate.sourceUrl, title: option.title })) };
        } else {
          comparison.agreement = true;
          if (runs.A.choice === 'none') {
            comparison.none = true;
            trail.unshift(preCapCount > 8 ? 'comparative-truncated' : 'comparative-none');
            decision = { ...decision, outcome: 'not-found', candidate: null, alternatives: [] };
          } else {
            const chosen = options.find(option => option.id === runs.A.choice);
            const evaluation = evaluateOfficialPostingMatch(job, chosen.candidate, { ...context, now: instant(), peerCandidates: [...candidates.values(), ...context.peerCandidates] });
            if (evaluation.salaryMismatch || evaluation.reason === 'salary-mismatch') {
              trail.unshift('salary-mismatch');
              decision = { ...decision, outcome: 'not-found', candidate: null, alternatives: [] };
            } else if (evaluation.identityPass && evaluation.reason === 'closed') {
              trail.unshift('closed');
              decision = { ...decision, outcome: 'closed', candidate: null, alternatives: [] };
            } else {
              // Identity is sufficient for inclusion, never for overriding pay or R1.
              if (evaluation.closedWinner || evaluation.outranked) {
                trail.unshift(evaluation.closedWinner ? 'closed' : 'no-anchor');
                decision = { ...decision, outcome: evaluation.closedWinner ? 'closed' : 'not-found', candidate: null, alternatives: [] };
              } else if (!evaluation.identityPass || evaluation.reason === 'salary-mismatch'
                || (!evaluation.passed && evaluation.reason !== 'no-anchor')) {
                trail.unshift('comparative-invalid');
                trail.push(...(evaluation.reasons || []));
                decision = { ...decision, outcome: 'not-found', candidate: null, alternatives: [] };
              } else {
                comparison.accepted = true;
                trail.unshift('comparative-match');
                const accepted = { ...evaluation, candidate: chosen.candidate, passed: true, anchor: 'comparative-match', anchors: ['comparative-match'], reasons: [] };
                decision = { ...decision, outcome: 'found', candidate: chosen.candidate, alternatives: [],
                  evaluations: decision.evaluations.map(item => item.candidate === chosen.candidate ? accepted : item) };
              }
            }
          }
        }
      }
    }
    for (const evaluation of decision.evaluations) {
      trail.push(...(evaluation.reasons || []));
      if (evaluation.salaryMismatch) trail.push('salary-mismatch');
    }
    if (decision.outcome !== 'found') {
      if (semanticMatching && decision.outcome === 'closed' && semanticSource) {
        const candidate = semanticSource;
        const historical = boundPrior && canonicalLeadUrl(boundPrior.sourceUrl) === canonicalLeadUrl(candidate.sourceUrl);
        const level = historical ? boundPrior.level : candidate.provenance === 'careers' ? 'L2' : candidate.ats ? 'L3' : 'L1';
        const officialPosting = normalizeOfficialPosting({ ...(historical ? boundPrior : {}), level, outcome: 'closed',
          employer: candidate.employer, title: candidate.title, sourceUrl: candidate.sourceUrl,
          officialApplyUrl: verifiedApplyUrl(candidate), ats: candidate.ats || '', tenant: candidate.tenant || '',
          location: normalizeOfficialLocation(candidate.location) || undefined,
          salary: normalizeOfficialSalary(candidate.salary) || undefined,
          fetchedAt: new Date(instant()).toISOString(), trail: trailCodes([...trail, 'closed']),
        });
        if (officialPosting) return await persist({ officialPosting,
          ...(!historical && candidate.description ? { description: candidate.description } : {}) });
      }
      // A past validThrough alone is not proof that the visible page is gone.
      // Keep every otherwise passing identity as a bounded URL receipt, with
      // fetched page text only in the IPC request's evidence store. An overflow
      // remains unsettled even if every retained candidate later says closed.
      const expired = decision.evaluations.filter(evaluation => {
        const candidate = evaluation.candidate;
        const expiry = typeof candidate?.validThrough === 'string' ? Date.parse(candidate.validThrough) : NaN;
        if (evaluation.reason !== 'closed' || !evaluation.identityPass || evaluation.salaryMismatch
          || !Number.isFinite(expiry) || expiry >= instant()) return false;
        return semanticMatching || evaluateOfficialPostingMatch(job, { ...candidate, validThrough: '' }, matchOptions()).passed;
      }).map(evaluation => evaluation.candidate).sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl));
      const boundedExpired = expired.slice(0, 8);
      const expiryCandidates = boundedExpired.map(candidate => candidate.sourceUrl);
      if (expiryCandidates.length) {
        const evidence = await Promise.all(boundedExpired.map(async candidate => {
          const url = candidate.sourceUrl;
          const fetched = await pages.get(url);
          const page = fetched?.page;
          return { url, evidence: page && /html/iu.test(page.contentType || '') && typeof page.body === 'string'
            ? evidenceFromHtml(page.body, { board: 'generic', ruleKey: 'generic',
              requestedUrl: url, finalUrl: page.url || page.sourceUrl || url, httpStatus: page.statusCode,
              expectedTitle: job?.title, expectedCompany: job?.company, expectedLocation: job?.location,
              descriptionText: candidate.description }) : null };
        }));
        recordOfficialExpiryCandidates(job, evidence, { truncated: expired.length > expiryCandidates.length });
      }
      if ([...budgetState.failures.values()].includes('fetch-timeout')) trail.push('fetch-timeout');
      return await persist({ ...fallback(job, { outcome: decision.outcome, trail,
        alternatives: decision.alternatives }), ...(expiryCandidates.length ? { expiryCandidates } : {}) });
    }
    const candidate = decision.candidate;
    const unreadSite = queue.some(item => !pages.has(item.url) && belongsToWinnerSite(item.url, candidate));
    const failedSite = [...budgetState.failures].some(([url, code]) => belongsToWinnerSite(url, candidate)
      && ['fetch-failed', 'fetch-timeout', 'crawl-budget'].includes(code));
    if (budgetState.exhaustionReason || unreadSite || failedSite) trail.push('crawl-partial');
    // AI has judged employer identity; the host checks only its wire bounds.
    const employer = semanticMatching ? officialPostingEmployerText(candidate.employer) : frozenOfficialEmployer(job, candidate.employer);
    const readable = employer && (semanticMatching ? Boolean(String(candidate.description || '').trim()) : readableDescription(candidate, job));
    const level = !readable ? 'L4' : candidate.provenance === 'careers' ? 'L2' : candidate.ats ? 'L3' : 'L1';
    const evaluation = decision.evaluations.find(item => item.candidate === candidate);
    const officialPosting = normalizeOfficialPosting({ level, outcome: readable ? 'found' : 'link-only', employer,
      title: candidate.title, location: normalizeOfficialLocation(candidate.location) || { display: '', workMode: '', remote: false, remoteCountry: '', remoteRegion: '' },
      salary: normalizeOfficialSalary(candidate.salary) || { text: '', provenance: 'unknown' },
      sourceUrl: candidate.sourceUrl, officialApplyUrl: verifiedApplyUrl(candidate),
      ats: candidate.ats || '', tenant: candidate.tenant || '', fetchedAt: new Date(instant()).toISOString(),
      trail: trailCodes([...trail, ...(evaluation?.anchors || []), ...(!readable ? ['stub-text'] : [])]),
    });
    if (!officialPosting) return await persist(fallback(job, { outcome: 'unreadable', trail: [...trail, 'invalid-text'] }));
    return await persist({ postedBy: !strictEmployerEqual(job?.company, employer) ? job?.company : undefined,
      officialPosting, ...(readable ? { description: candidate.description } : {}) });
  } catch (error) {
    return await persist(fallback(job, { outcome: 'failed', trail: [...trail, error?.code || 'failed'] }));
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel);
    if (ownsBudget) budget.dispose();
  }
}
