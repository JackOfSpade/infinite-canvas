import crypto from 'node:crypto';
import { stripHtmlToText } from '../../src/utils/textEncoding.js';
import { handleSafe } from './ipcUtils.js';
import { getHandoffBridgeStatus } from './handoffBridge/index.js';
import { bridgeLinked } from './handoffBridge/bridgeAvailability.js';
import { officialPostingAliases, officialPostingRecordMatchesScrapedIdentity } from './officialPostingStore.js';
import { getOfficialPostingStore, mergeOfficialPostingTelemetry, resolveOfficialPostings } from './officialPostingService.js';
import { fetchOfficialPosting } from './officialPostingFetch.js';
import { extractOfficialPostingCandidates } from './officialPostingExtractors.js';
import { evaluateOfficialPostingMatch, flatPostingText, frozenOfficialEmployer } from './officialPostingMatch.js';
import { extractAtsTenant, strictEmployerEqual } from './officialSourceHosts.js';
import { officialPostingAdapterUrl, readableOfficialPostingDescription, unresolvedOfficialPosting, verifiedOfficialPostingApplyUrl, shouldPersistOfficialPostingResult } from './officialPostingResolver.js';
import { normalizeAlternateListings, normalizeOfficialLocation, normalizeOfficialPosting, normalizeOfficialSalary, officialHttpsUrl, boundedOfficialPostingTrail, officialPostingLookupStatus } from './officialPostingFields.js';
import { checkListingForGeneration, decideGenerationListingCheck, normalizeListingAudit, recordGenerationFallbackHold } from './listingLivenessProbe.js';
import { checkPostingVariantsForGeneration } from './listingLivenessProbe.js';
import { normaliseJobPostingVariants } from './applicationBundle.js';
import { normalizeBoardClosed, normalizeListingLiveness } from './officialPostingFields.js';
import { buildListingLivenessRequest, validateListingLivenessResponse } from './listingLivenessAi.js';
import { LISTING_LIVENESS_RULES, classifyListingLiveness, evidenceFromHtml } from './listingLiveness.js';
import { cappedHandoff } from './officialPostingService.js';
import { callLLMText } from './llm.js';
import { officialPostingSemanticInputHash, officialPostingSemanticProofMatches, officialPostingSemanticSourceHash } from './officialPostingSemantic.js';

export const OFFICIAL_POSTING_PREPARE_TIMEOUT_MS = 15 * 60 * 1000;
const PREPARED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PREPARED_RECORDS = 128;
const MAX_PREPARED_BYTES = 32 * 1024 * 1024;
const STORE_DRAIN_TIMEOUT_MS = 2_000;
const prepared = new Map();
const officialLevels = new Set(['L1', 'L2', 'L3', 'L4']);
const textLevels = new Set(['L1', 'L2', 'L3']);
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const aliasesOf = job => officialPostingAliases(job).sort();
function errorWithCode(code) { return Object.assign(new Error(code), { code }); }
function withTrail(posting, ...codes) { return { ...posting, trail: boundedOfficialPostingTrail([...(posting.trail || []), ...codes]) }; }
function active(signal) { if (signal?.aborted) throw signal.reason || errorWithCode('bridge-aborted'); }
function available(status) { return bridgeLinked(status); }

export function createOfficialPostingPrepareSemaphore(limit = 3) {
  let running = 0; const waiting = [];
  const drain = () => {
    while (running < limit && waiting.length) {
      const waiter = waiting.shift();
      waiter.signal?.removeEventListener('abort', waiter.abort);
      if (waiter.signal?.aborted) { waiter.reject(waiter.signal.reason); continue; }
      running += 1; let released = false;
      waiter.resolve(() => { if (!released) { released = true; running -= 1; drain(); } });
    }
  };
  return { acquire(signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const waiter = { resolve, reject, signal, abort: () => {
        const index = waiting.indexOf(waiter); if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason || errorWithCode('bridge-aborted'));
      } };
      signal?.addEventListener('abort', waiter.abort, { once: true }); waiting.push(waiter); drain();
    });
  } };
}
const semaphore = createOfficialPostingPrepareSemaphore();

function remember(scrapedJob, result, now, semanticMatching = true) {
  for (const [id, entry] of prepared) if (now - entry.createdAt >= PREPARED_TTL_MS) prepared.delete(id);
  const aliases = aliasesOf(scrapedJob);
  const officialPosting = normalizeOfficialPosting(result?.officialPosting) || unresolvedOfficialPosting(scrapedJob, { outcome: 'failed', trail: ['failed'] }).officialPosting;
  const record = { scrapedJob: structuredClone(scrapedJob), officialPosting: structuredClone(officialPosting),
    description: typeof result.description === 'string' ? result.description : undefined,
    postedBy: result.postedBy || '', applyUrl: officialPosting.officialApplyUrl || '',
    listingAudit: normalizeListingAudit(result.listingAudit),
    listingCheck: result.listingCheck ? structuredClone(result.listingCheck) : undefined,
    listingLinkUrl: officialHttpsUrl(result.listingLinkUrl) || '',
    postingVariants: normaliseJobPostingVariants(result.postingVariants ?? scrapedJob.postingVariants),
    listingLiveness: normalizeListingLiveness(result.listingLiveness),
    boardClosed: normalizeBoardClosed(result.boardClosed), aliases, createdAt: now, semanticMatching,
    ...(semanticMatching ? { freshness: 'fresh-discovery' } : {}),
    ...(semanticMatching ? { inputHash: officialPostingSemanticInputHash(scrapedJob) } : {}) };
  const resolutionId = crypto.randomUUID();
  prepared.set(resolutionId, record);
  let bytes = [...prepared.values()].reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
  while (prepared.size > MAX_PREPARED_RECORDS || bytes > MAX_PREPARED_BYTES) {
    const first = prepared.keys().next().value; bytes -= Buffer.byteLength(JSON.stringify(prepared.get(first))); prepared.delete(first);
  }
  return { resolutionId: prepared.has(resolutionId) ? resolutionId : undefined,
    preparedAt: new Date(record.createdAt).toISOString(),
    officialPosting: record.officialPosting, postedBy: record.postedBy,
    listingCheck: result.listingCheck, listingLiveness: record.listingLiveness,
    boardClosed: record.boardClosed, listingLinkUrl: record.listingLinkUrl,
    postingVariants: record.postingVariants,
    message: String(result.message || '').slice(0, 160) };
}

async function checkAlternateLinks({ job, posting, primary, probe, callText, bridgeAvailable,
  calibrationStore, signal, now, deadline, manualAiRunId, nodeId }) {
  if (primary?.listingCheck?.basis === 'official-closed') return primary;
  if (!['refuse-final', 'refuse-retry'].includes(primary?.listingCheck?.action)
    || primary.listingCheck.verdict !== 'closed') return primary;
  const alternates = normalizeAlternateListings(job?.alternateListings);
  if (!alternates.length) return primary;
  const hold = () => ({ ...primary, listingCheck: { ...primary.listingCheck,
    action: 'hold', verdict: 'unknown', basis: 'neither', override: false },
  message: "Couldn't confirm an alternate listing is still open", listingAudit: null });
  if (signal?.aborted || now() >= deadline) return hold();
  let undecided = false;
  for (const link of alternates) {
    if (now() >= deadline) { undecided = true; break; }
    const alternateJob = { ...job, source: link.board, url: link.url,
      listingLiveness: undefined, boardClosed: undefined, alternateListings: [] };
    let checked;
    try {
      checked = await checkListingForGeneration({ job: alternateJob, posting, probe,
        callText, bridgeAvailable, calibrationStore, signal, now, deadline,
        manualAiRunId, nodeId, listingOverride: false });
      active(signal);
    } catch (error) {
      if (signal?.aborted && signal.reason?.code !== 'bridge-timeout') throw signal.reason || error;
      undecided = true;
      continue;
    }
    if (checked.listingCheck?.action === 'proceed' && checked.listingCheck.verdict === 'open') {
      const at = new Date(now()).toISOString();
      return { ...primary, listingCheck: { action: 'proceed', verdict: 'open', basis: checked.listingCheck.basis,
        board: link.board, at, override: false }, message: '', listingLinkUrl: link.url,
      listingAudit: normalizeListingAudit({ outcome: 'alternate', basis: checked.listingCheck.basis, at }) };
    }
    if (checked.listingCheck?.verdict !== 'closed') undecided = true;
  }
  if (!undecided) return primary;
  return hold();
}

/** UUIDs carry no renderer authority. Failed/foreign lookups do not consume a
 * valid entry that another queued click still owns. */
export function getPreparedOfficialPosting(resolutionId, scrapedJob, { now = Date.now() } = {}) {
  if (typeof resolutionId !== 'string' || !/^[a-f0-9-]{36}$/u.test(resolutionId)) return null;
  const record = prepared.get(resolutionId);
  if (!record || now - record.createdAt >= PREPARED_TTL_MS) { prepared.delete(resolutionId); return null; }
  if (!officialPostingRecordMatchesScrapedIdentity(scrapedJob, record)
    || JSON.stringify(aliasesOf(scrapedJob)) !== JSON.stringify(record.aliases)) return null;
  if (record.semanticMatching) {
    try { if (record.inputHash !== officialPostingSemanticInputHash(scrapedJob)) return null; }
    catch { return null; }
    if (officialLevels.has(record.officialPosting.level) && !officialPostingSemanticProofMatches(scrapedJob, record.officialPosting)) return null;
  }
  return structuredClone(record);
}

function failedBoardPayload(data) {
  return Boolean(data?.success === false || data?.ok === false || data?.error
    || Array.isArray(data?.errors) && data.errors.length || data?.errors && !Array.isArray(data.errors)
    || typeof data?.status === 'string' && /^(?:error|failed|failure|unavailable)$/iu.test(data.status)
    || Number.isFinite(data?.statusCode) && data.statusCode >= 400);
}
function failedBoardPage(page) {
  try { return failedBoardPayload(JSON.parse(page.body)); } catch { return false; }
}
function authoritativeBoardPage(page, route) {
  if (!/json/iu.test(page?.contentType || '') || typeof page.body !== 'string') return false;
  let data;
  try { data = JSON.parse(page.body); } catch { return false; }
  if (failedBoardPayload(data)) return false;
  const jobs = route.ats === 'lever' ? data : ['ashby', 'greenhouse'].includes(route.ats) ? data?.jobs : null;
  if (!Array.isArray(jobs) || data?.hasMore === true || data?.more === true || data?.nextPage || data?.nextCursor || data?.links?.next) return false;
  if (data?.meta?.total !== undefined && (!Number.isInteger(data.meta.total) || data.meta.total < 0 || data.meta.total > jobs.length)) return false;
  return jobs.every(job => {
    const url = officialHttpsUrl(route.ats === 'ashby' ? job?.jobUrl : route.ats === 'greenhouse' ? job?.absolute_url : job?.hostedUrl);
    const tenant = url && extractAtsTenant(url);
    const id = job?.id; const title = route.ats === 'lever' ? job?.text : job?.title;
    return job && typeof job === 'object' && !Array.isArray(job)
      && (typeof id === 'string' && id.trim() || typeof id === 'number' && Number.isFinite(id))
      && typeof title === 'string' && title.trim()
      && tenant?.ats === route.ats && tenant?.tenant === route.tenant;
  });
}

async function reverify(job, record, { fetch, signal, now, store, callText, bridgeAvailable, deadline, manualAiRunId, nodeId,
  semanticMatching, resolveFresh, invalidateCachedProof }) {
  const prior = record.officialPosting; const url = prior.sourceUrl;
  const postedBy = strictEmployerEqual(job.company, prior.employer) ? '' : job.company;
  const preserve = async code => {
    if (semanticMatching && code === 'unsafe-url') {
      invalidateCachedProof();
      return unresolvedOfficialPosting(job, { outcome: 'failed', trail: ['unsafe-url', 'reverify-failed'] });
    }
    let description;
    if (textLevels.has(prior.level) && prior.contentHash) try { description = await store.readText(prior.contentHash); } catch { /* A missing text file cannot invalidate the proof record. */ }
    active(signal);
    // A failed recheck does not turn the prior complete discovery proof into
    // a partial crawl. Keep old trail codes; classify only this new failure.
    const recheckCode = ['fetch-timeout', 'crawl-budget'].includes(code) ? 'fetch-failed' : code;
    return { postedBy, officialPosting: withTrail(prior, recheckCode, 'reverify-failed'), ...(typeof description === 'string' ? { description } : {}) };
  };
  const closed = () => {
    if (semanticMatching) invalidateCachedProof();
    const result = unresolvedOfficialPosting(job, { outcome: 'closed', trail: ['closed'] });
    if (semanticMatching) result.officialPosting = withTrail({ ...result.officialPosting, semanticMatch: prior.semanticMatch }, 'semantic-match-v1');
    return result;
  };
  if (!url) return preserve('unreadable');
  let page;
  try { page = await fetch(url, { signal }); active(signal); }
  catch (error) {
    active(signal);
    return [404, 410].includes(error?.statusCode) ? closed() : preserve(error?.code || 'fetch-failed');
  }
  if (!page || typeof page !== 'object') return preserve('unreadable');
  const fetchedUrl = officialHttpsUrl(page?.url || page?.sourceUrl || url);
  if (fetchedUrl !== officialHttpsUrl(url) || page.requestedUrl && officialHttpsUrl(page.requestedUrl) !== officialHttpsUrl(url)) return preserve('unsafe-url');
  if ([404, 410].includes(page.statusCode)) return closed();
  if (page.statusCode && page.statusCode !== 200) return preserve('fetch-failed');
  if (failedBoardPage(page)) return preserve('unreadable');
  if (!prior.employer) return preserve('unreadable');
  const route = extractAtsTenant(url, { html: page.body });
  const extract = value => extractOfficialPostingCandidates({ body: value.body, sourceUrl: value.url || value.sourceUrl || url,
    contentType: value.contentType, ats: route?.ats || prior.ats || '', tenant: route?.tenant || prior.tenant || '', employer: prior.employer, now });
  let candidates;
  try { candidates = extract(page).filter(candidate => officialHttpsUrl(candidate.sourceUrl) === officialHttpsUrl(url)); }
  catch { return preserve('unreadable'); }
  let authoritativeBoard = false;
  if (!candidates.length && route && route.tenant === prior.tenant && (!prior.ats || prior.ats === route.ats)) {
    const adapter = officialPostingAdapterUrl(route, url);
    if (adapter) try {
      const board = await fetch(adapter, { signal }); active(signal);
      if (officialHttpsUrl(board.url || board.sourceUrl || adapter) === officialHttpsUrl(adapter)
        && (!board.requestedUrl || officialHttpsUrl(board.requestedUrl) === officialHttpsUrl(adapter))
        && (!board.statusCode || board.statusCode === 200)) {
        if (!failedBoardPage(board)) {
          authoritativeBoard = authoritativeBoardPage(board, route);
          candidates = extract(board).filter(candidate => officialHttpsUrl(candidate.sourceUrl) === officialHttpsUrl(url));
        }
      }
    } catch { active(signal); }
  }
  if (!candidates.length) return authoritativeBoard ? closed() : preserve('unreadable');
  if (candidates.length !== 1) return preserve('ambiguous');
  const candidate = candidates[0];
  if (authoritativeBoard && candidate.isListed === false) return closed();
  // Only this exact stored URL inherits host provenance. Semantic changes
  // require a new AI comparison; the legacy contract retains its hard gates.
  const verified = { ...candidate, tenantProven: Boolean(route && prior.tenant && route.tenant === prior.tenant),
    employerDomainProven: !route, officialPortalProven: /^(?:www\.)?usajobs\.gov$/u.test(new URL(url).hostname),
    ...(semanticMatching && ['L1', 'L2', 'L3'].includes(prior.level)
      ? { provenance: { L1: 'employer', L2: 'careers', L3: 'structured' }[prior.level] } : {}) };
  const pastValidThrough = candidate.validThrough && Number.isFinite(Date.parse(candidate.validThrough))
    && Date.parse(candidate.validThrough) < now();
  if (!semanticMatching) {
    const evaluation = evaluateOfficialPostingMatch(job, verified, { now: now(), employerHypotheses: [prior.employer] });
    if (!strictEmployerEqual(candidate.employer, prior.employer)
      || (!evaluation.passed && evaluation.reason !== 'no-anchor' && !(evaluation.reason === 'closed' && pastValidThrough))) {
      return preserve(strictEmployerEqual(candidate.employer, prior.employer) ? evaluation.reason : 'employer-mismatch');
    }
  }
  if (typeof candidate.description !== 'string' || !candidate.description.trim()) return preserve('unreadable');
  const changed = sha256(candidate.description) !== prior.contentHash || semanticMatching && (
    candidate.title !== prior.title || candidate.employer !== prior.employer
    || JSON.stringify(normalizeOfficialLocation(candidate.location)) !== JSON.stringify(normalizeOfficialLocation(prior.location))
    || JSON.stringify(normalizeOfficialSalary(candidate.salary)) !== JSON.stringify(normalizeOfficialSalary(prior.salary))
    || verifiedOfficialPostingApplyUrl(candidate) !== prior.officialApplyUrl
    || officialPostingSemanticSourceHash(verified, { now }) !== prior.semanticMatch?.sourceHash);
  if (semanticMatching && changed) invalidateCachedProof();
  const evidence = evidenceFromHtml(page.body, { board: 'official', ruleKey: 'generic',
    requestedUrl: url, finalUrl: fetchedUrl, httpStatus: page.statusCode || 200,
    expectedTitle: job.title, expectedCompany: prior.employer, expectedLocation: job.location });
  const outsideClosedNotice = evidence.closedHits.some(hit => hit.insideDescription === false);
  if (pastValidThrough || outsideClosedNotice) {
    const unconfirmed = async () => {
      if (semanticMatching && changed) return resolveFresh({ candidateUrls: [url], bypassCache: true });
      const result = await preserve('closed');
      result.officialPosting = withTrail(result.officialPosting, 'official-liveness-unconfirmed');
      return result;
    };
    const classification = classifyListingLiveness(evidence, LISTING_LIVENESS_RULES.generic);
    const remaining = deadline - now();
    if (classification.verdict !== 'needs-ai' || !bridgeAvailable || remaining < 90_000 || typeof callText !== 'function') return unconfirmed();
    const members = [{ row: job, evidence }];
    const request = buildListingLivenessRequest(members);
    const stats = { handoffs: 0, handoffMs: 0 };
    try {
      const raw = await cappedHandoff(request, { call: callText, signal, timeoutMs: Math.min(5 * 60_000, remaining),
        manualAiRunId, nodeId, now, stats });
      active(signal);
      const answer = validateListingLivenessResponse(typeof raw === 'string' ? JSON.parse(raw) : raw, members).rows[0];
      const quoteKey = flatPostingText(answer.quote).replace(/\p{Cf}/gu, '').toLocaleLowerCase();
      const visibleKey = flatPostingText(stripHtmlToText(page.body).slice(0, 200_000)).replace(/\p{Cf}/gu, '').toLocaleLowerCase();
      if (answer.verdict === 'closed' && quoteKey && visibleKey.includes(quoteKey)) return closed();
    } catch { active(signal); }
    return unconfirmed();
  }
  if (!changed) {
    return { postedBy, officialPosting: withTrail(prior, 'reverified'), ...(textLevels.has(prior.level) ? { description: candidate.description } : {}) };
  }
  if (semanticMatching) return resolveFresh({ candidateUrls: [url], bypassCache: true });
  const employer = frozenOfficialEmployer(job, candidate.employer);
  const readable = employer && readableOfficialPostingDescription(candidate, job);
  if (!readable) return preserve('stub-text');
  const posting = normalizeOfficialPosting({ ...prior, employer, level: prior.level === 'L4' ? route ? 'L3' : 'L1' : prior.level,
    outcome: 'found', title: candidate.title,
    location: normalizeOfficialLocation(candidate.location) || prior.location,
    salary: normalizeOfficialSalary(candidate.salary) || { text: '', provenance: 'unknown' },
    sourceUrl: url, officialApplyUrl: verifiedOfficialPostingApplyUrl(candidate), fetchedAt: new Date(now()).toISOString(),
    contentHash: sha256(candidate.description),
    trail: withTrail(prior, 'reverified').trail });
  if (!posting) return preserve('invalid-text');
  active(signal);
  return { officialPosting: posting, postedBy: strictEmployerEqual(job.company, employer) ? '' : job.company,
    description: candidate.description };
}

/** Whole-budget prepare includes the semaphore wait. Every non-cancellation
 * failure produces a bounded host fallback for the normal application gate. */
export async function prepareOfficialPostingForGeneration(args, {
  projectJob = value => value, signal, store, fetch = fetchOfficialPosting, resolve = resolveOfficialPostings,
  bridgeStatus = getHandoffBridgeStatus, now = Date.now, timeoutMs = OFFICIAL_POSTING_PREPARE_TIMEOUT_MS,
  slots = semaphore, callRaw, callMatch, callText = callLLMText, telemetry = { failed: 0 }, listingProbe, calibrationStore,
  semanticMatching = true,
} = {}) {
  const failed = error => {
    telemetry.failed = (Number(telemetry.failed) || 0) + 1;
    console.warn('[OfficialPosting] Prepare failed:', error?.code || error?.name || 'Error');
  };
  const pair = job => ({
    listingLiveness: normalizeListingLiveness(job?.listingLiveness),
    boardClosed: normalizeBoardClosed(job?.boardClosed),
  });
  const guardOfficialLookup = (posting, listing) => {
    const lookup = officialPostingLookupStatus(posting);
    if (!semanticMatching || !['incomplete', 'unchecked'].includes(lookup.state)
      || listing.listingCheck?.action === 'refuse-final') return listing;
    return { ...listing, listingCheck: { ...listing.listingCheck,
      action: 'refuse-retry', basis: 'official-lookup', override: false },
    message: `${lookup.label}. ${posting.trail?.includes('bridge-unavailable')
      ? 'Reconnect ChatGPT, then retry Generate.' : 'Retry Generate to finish checking the official posting.'}`,
    listingAudit: null };
  };
  // The budget can expire before research or during the tail. Stored closed,
  // fresh open and unobservable decisions need neither a probe nor the AI.
  const typedFallback = (job, posting) => checkListingForGeneration({
    job, posting, calibrationStore, now, deadline: now(),
    listingOverride: args.listingOverride === true,
  });
  const holdFallback = (job, posting) => {
    if (args.listingOverride === true) {
      const stored = normalizeListingLiveness(job?.listingLiveness);
      const marker = normalizeBoardClosed(job?.boardClosed);
      const closed = stored?.verdict === 'closed' && ['structural', 'ai'].includes(stored.basis);
      const basis = stored?.basis || (marker ? 'closed-marker' : 'neither');
      const verdict = closed ? 'closed' : ['closed-marker', 'both'].includes(basis) ? 'pending' : 'unknown';
      return recordGenerationFallbackHold({
        ...decideGenerationListingCheck({ job, posting, verdict, basis, at: now(), listingOverride: true }),
        ...pair(job),
      });
    }
    return recordGenerationFallbackHold({
      listingCheck: { action: 'hold', verdict: 'unknown', basis: 'neither',
        board: normalizeListingLiveness(job?.listingLiveness)?.board || normalizeBoardClosed(job?.boardClosed)?.board
          || (/^[a-z0-9][a-z0-9-]{0,39}$/u.test(job?.source || '') ? job.source : 'listing'),
        at: new Date(now()).toISOString(), override: false },
      listingLiveness: normalizeListingLiveness(job?.listingLiveness),
      boardClosed: normalizeBoardClosed(job?.boardClosed),
      message: "Couldn't confirm the listing is still open", listingAudit: null,
    });
  };
  let scrapedJob;
  let cardPosting;
  try {
    scrapedJob = structuredClone(projectJob(args.job || {}));
    if (!scrapedJob || typeof scrapedJob !== 'object' || Array.isArray(scrapedJob)) throw new TypeError('Invalid scraped job projection.');
    cardPosting = normalizeOfficialPosting(scrapedJob.officialPosting);
  }
  catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    failed(error);
    const officialPosting = unresolvedOfficialPosting(args.job, { outcome: 'failed', trail: ['failed'] }).officialPosting;
    return { officialPosting, ...guardOfficialLookup(officialPosting, holdFallback(args.job, officialPosting)), telemetry: { failed: telemetry.failed } };
  }
  delete scrapedJob.applyUrl; delete scrapedJob.officialPosting; delete scrapedJob.postedBy;
  delete scrapedJob.listingAudit; delete scrapedJob.listingCheck;
  const deadline = now() + timeoutMs;
  const pendingStoreOperations = new Set();
  const trackedStore = target => {
    const wrapper = Object.create(target);
    for (const key of ['find', 'readText', 'save', 'restoreText']) {
      const method = target[key];
      if (typeof method !== 'function') continue;
      Object.defineProperty(wrapper, key, { value: (...values) => {
        const operation = Promise.resolve().then(() => method.apply(target, values));
        pendingStoreOperations.add(operation);
        void operation.finally(() => pendingStoreOperations.delete(operation)).catch(() => {});
        return operation;
      } });
    }
    return wrapper;
  };
  const drainStoreOperations = async () => {
    if (!pendingStoreOperations.size) return;
    let timer;
    const stopped = new Promise(resolve => { timer = setTimeout(resolve, STORE_DRAIN_TIMEOUT_MS); });
    try {
      await Promise.race([stopped, (async () => {
        while (pendingStoreOperations.size) await Promise.allSettled([...pendingStoreOperations]);
      })()]);
    } finally { clearTimeout(timer); }
  };
  const controller = new AbortController(); const abort = () => controller.abort(signal.reason || errorWithCode('bridge-aborted'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(errorWithCode('bridge-timeout')), timeoutMs); timer.unref?.();
  let onAbort; const cancelled = new Promise((_, reject) => { onAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  };
  let release; let finalPosting; let bridgeAvailable = false; let verifiedFallback; let resolvedTelemetry = null;
  try {
    finalPosting = await Promise.race([(async () => {
      active(controller.signal);
      try { bridgeAvailable = available(await bridgeStatus()); } catch { bridgeAvailable = false; }
      active(controller.signal); release = await slots.acquire(controller.signal); active(controller.signal);
      store = trackedStore(store || getOfficialPostingStore());
      const record = await store.find(scrapedJob); active(controller.signal);
      const resolveFresh = async ({ candidateUrls = [], bypassCache = false, priorOfficialRecord } = {}) => {
        if (semanticMatching && bypassCache) verifiedFallback = undefined;
        const resolved = await resolve([scrapedJob], { store, fetch, signal: controller.signal,
          manualAiRunId: args.manualAiRunId, nodeId: args.nodeId, callRaw, callMatch, now, bridgeAvailable,
          timeoutMs, semanticMatching, candidateUrls, bypassCache, bridgeStatus,
          ...(priorOfficialRecord ? { priorOfficialRecords: [priorOfficialRecord] } : {}) });
        resolvedTelemetry = mergeOfficialPostingTelemetry(resolvedTelemetry, resolved.telemetry);
        active(controller.signal);
        const posting = normalizeOfficialPosting(resolved.jobs[0]?.officialPosting);
        if (!posting || semanticMatching && officialLevels.has(posting.level) && (!officialPostingSemanticProofMatches(scrapedJob, posting)
          || !/^[a-f0-9]{64}$/u.test(posting.semanticMatch?.sourceHash))) {
          return unresolvedOfficialPosting(scrapedJob, { outcome: 'failed', trail: ['comparative-invalid'] });
        }
        return { officialPosting: posting, postedBy: resolved.jobs[0].postedBy, resolvedFresh: true,
          description: textLevels.has(posting.level) && posting.contentHash ? await store.readText(posting.contentHash) : undefined };
      };
      if (semanticMatching) {
        const boundRecord = record && officialPostingRecordMatchesScrapedIdentity(scrapedJob, record) ? record : null;
        const cachedPosting = normalizeOfficialPosting(boundRecord?.officialPosting);
        const candidateUrls = [...new Set([cachedPosting?.sourceUrl, cachedPosting?.officialApplyUrl,
          cardPosting?.sourceUrl, cardPosting?.officialApplyUrl].map(officialHttpsUrl).filter(Boolean))];
        // Every generation uses the current shared discovery and comparison
        // process. Old URLs are leads; neither cached facts nor a weak fresh
        // recheck may authorize this application's official posting.
        return resolveFresh({ candidateUrls, bypassCache: true, priorOfficialRecord: boundRecord });
      }
      if (record && officialPostingRecordMatchesScrapedIdentity(scrapedJob, record)) {
        const storedPosting = normalizeOfficialPosting(record.officialPosting);
        const reusableProof = !semanticMatching || officialPostingSemanticProofMatches(scrapedJob, storedPosting)
          && (!officialLevels.has(storedPosting?.level) || /^[a-f0-9]{64}$/u.test(storedPosting.semanticMatch?.sourceHash));
        if (reusableProof && officialLevels.has(storedPosting?.level) && shouldPersistOfficialPostingResult(record, { signal: controller.signal })) {
          verifiedFallback = { officialPosting: storedPosting,
            postedBy: strictEmployerEqual(scrapedJob.company, storedPosting.employer) ? '' : scrapedJob.company };
          if (textLevels.has(storedPosting.level) && storedPosting.contentHash) try {
            const cachedText = await store.readText(storedPosting.contentHash);
            if (typeof cachedText === 'string') verifiedFallback.description = cachedText;
          } catch { /* Keep proof metadata when the stored text cannot be read. */ }
          active(controller.signal);
          const verified = await reverify(scrapedJob, record, { fetch, signal: controller.signal, now, store,
            callText, bridgeAvailable, deadline, manualAiRunId: args.manualAiRunId, nodeId: args.nodeId,
            semanticMatching, resolveFresh, invalidateCachedProof: () => { verifiedFallback = undefined; } }); active(controller.signal);
          if (!bridgeAvailable) verified.officialPosting = withTrail(verified.officialPosting, 'bridge-unavailable');
          if (!verified.resolvedFresh) await store.save(scrapedJob, { officialPosting: verified.officialPosting, description: verified.description, expectedRecord: record }); active(controller.signal);
          return verified;
        }
        if (reusableProof && shouldPersistOfficialPostingResult(record, { signal: controller.signal })) return unresolvedOfficialPosting(scrapedJob, { outcome: record.officialPosting.outcome,
          trail: [...(record.officialPosting.trail || []), 'recent-miss'], alternatives: record.officialPosting.alternatives || [] });
        if (semanticMatching) return resolveFresh({ candidateUrls: storedPosting?.sourceUrl ? [storedPosting.sourceUrl] : [], bypassCache: true });
      }
      return resolveFresh();
    })(), cancelled]);
  } catch (error) {
    if (signal?.aborted) { cleanup(); throw signal.reason || error; }
    failed(error);
    const code = controller.signal.reason?.code === 'bridge-timeout' ? 'bridge-timeout' : error?.code || 'fetch-failed';
    finalPosting = code === 'bridge-timeout' && controller.signal.aborted && verifiedFallback
      ? { ...verifiedFallback, officialPosting: withTrail(verifiedFallback.officialPosting, 'bridge-timeout', 'reverify-failed') }
      : unresolvedOfficialPosting(scrapedJob, { outcome: 'failed', trail: [code] });
  } finally {
    // Cancellation must finish owned filesystem work before cancel-and-wait
    // releases this preparation. Research may ignore its signal, so only the
    // bounded host-store operations participate in this short drain.
    if (controller.signal.aborted) await drainStoreOperations();
    release?.();
  }
  try {
    const cachedLookup = officialPostingLookupStatus(finalPosting.officialPosting);
    const settledCache = finalPosting.officialPosting.trail?.includes('recent-miss')
      && ['not-found', 'ambiguous', 'closed'].includes(cachedLookup.state);
    if (!bridgeAvailable && !settledCache) finalPosting.officialPosting = withTrail(finalPosting.officialPosting, 'bridge-unavailable');
    let listing;
    if (controller.signal.aborted && !signal?.aborted) {
      listing = await typedFallback(scrapedJob, finalPosting.officialPosting);
    } else {
      try {
        listing = await checkListingForGeneration({
          job: scrapedJob, posting: finalPosting.officialPosting, probe: listingProbe,
          callText, bridgeAvailable, calibrationStore, signal: controller.signal,
          deadline, now, manualAiRunId: args.manualAiRunId, nodeId: args.nodeId,
          listingOverride: args.listingOverride === true,
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        listing = controller.signal.reason?.code === 'bridge-timeout' || error?.code === 'bridge-timeout'
          ? await typedFallback(scrapedJob, finalPosting.officialPosting)
          : holdFallback(scrapedJob, finalPosting.officialPosting);
      }
    }
    listing = await checkAlternateLinks({ job: scrapedJob,
      posting: finalPosting.officialPosting, primary: listing, probe: listingProbe,
      callText, bridgeAvailable, calibrationStore, signal: controller.signal, now, deadline,
      manualAiRunId: args.manualAiRunId, nodeId: args.nodeId });
    listing = guardOfficialLookup(finalPosting.officialPosting, listing);
    let postingVariants = normaliseJobPostingVariants(scrapedJob.postingVariants);
    if (!controller.signal.aborted && postingVariants.length) try {
      postingVariants = await checkPostingVariantsForGeneration({ job: scrapedJob,
        variants: postingVariants, probe: listingProbe, callText, bridgeAvailable,
        calibrationStore, signal: controller.signal, now, deadline,
        manualAiRunId: args.manualAiRunId, nodeId: args.nodeId });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      // Variant availability cannot change the primary listing decision.
    }
    if (signal?.aborted) throw signal.reason || errorWithCode('bridge-aborted');
    return { ...remember(scrapedJob, { ...finalPosting, ...listing, postingVariants }, now(), semanticMatching),
      telemetry: { failed: telemetry.failed, ...(resolvedTelemetry ? { officialPosting: resolvedTelemetry } : {}) } };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    failed(error);
    const officialPosting = normalizeOfficialPosting(finalPosting?.officialPosting)
      || unresolvedOfficialPosting(scrapedJob, { outcome: 'failed', trail: ['failed'] }).officialPosting;
    return { officialPosting, ...guardOfficialLookup(officialPosting, holdFallback(scrapedJob, officialPosting)),
      telemetry: { failed: telemetry.failed, ...(resolvedTelemetry ? { officialPosting: resolvedTelemetry } : {}) } };
  } finally {
    cleanup();
  }
}

function validateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['job', 'nodeId', 'cardId', 'manualAiRunId', 'listingOverride'].includes(key))
    || !args.job || typeof args.job !== 'object' || Array.isArray(args.job)
    || (args.listingOverride !== undefined && typeof args.listingOverride !== 'boolean')
    || ![args.nodeId, args.cardId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,300}$/u.test(id))
    || typeof args.manualAiRunId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/u.test(args.manualAiRunId)) throw new TypeError('Invalid official posting preparation request.');
}
export function registerOfficialPostingGenerationHandlers({ projectJob, ...dependencies } = {}) {
  if (typeof projectJob !== 'function') throw new TypeError('Official posting preparation needs the queue job projection.');
  handleSafe('prepare-official-posting-for-generation', (_event, args, signal) => prepareOfficialPostingForGeneration(args,
    { ...dependencies, projectJob, signal }), { validateArgs, additionalNodeIds: args => [args.cardId], reportCancellation: true });
}
