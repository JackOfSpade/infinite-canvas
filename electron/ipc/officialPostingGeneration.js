import crypto from 'node:crypto';
import { handleSafe } from './ipcUtils.js';
import { getHandoffBridgeStatus } from './handoffBridge/index.js';
import { officialPostingAliases, officialPostingRecordMatchesScrapedIdentity } from './officialPostingStore.js';
import { getOfficialPostingStore, mergeOfficialPostingTelemetry, resolveOfficialPostings } from './officialPostingService.js';
import { fetchOfficialPosting } from './officialPostingFetch.js';
import { extractOfficialPostingCandidates } from './officialPostingExtractors.js';
import { evaluateOfficialPostingMatch, frozenOfficialEmployer } from './officialPostingMatch.js';
import { extractAtsTenant, strictEmployerEqual } from './officialSourceHosts.js';
import { officialPostingAdapterUrl, readableOfficialPostingDescription, unresolvedOfficialPosting, verifiedOfficialPostingApplyUrl, shouldPersistOfficialPostingResult } from './officialPostingResolver.js';
import { normalizeOfficialLocation, normalizeOfficialPosting, normalizeOfficialSalary, officialHttpsUrl, boundedOfficialPostingTrail } from './officialPostingFields.js';

export const OFFICIAL_POSTING_PREPARE_TIMEOUT_MS = 15 * 60 * 1000;
const PREPARED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PREPARED_RECORDS = 128;
const MAX_PREPARED_BYTES = 32 * 1024 * 1024;
const prepared = new Map();
const officialLevels = new Set(['L1', 'L2', 'L3', 'L4']);
const textLevels = new Set(['L1', 'L2', 'L3']);
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const aliasesOf = job => officialPostingAliases(job).sort();
function errorWithCode(code) { return Object.assign(new Error(code), { code }); }
function withTrail(posting, ...codes) { return { ...posting, trail: boundedOfficialPostingTrail([...(posting.trail || []), ...codes]) }; }
function active(signal) { if (signal?.aborted) throw signal.reason || errorWithCode('bridge-aborted'); }
function available(status) { return status?.enabled === true && status?.link?.state === 'linked' && status?.chat?.pool?.active === true; }

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

function remember(scrapedJob, result, now) {
  for (const [id, entry] of prepared) if (now - entry.createdAt >= PREPARED_TTL_MS) prepared.delete(id);
  const aliases = aliasesOf(scrapedJob);
  const officialPosting = normalizeOfficialPosting(result?.officialPosting) || unresolvedOfficialPosting(scrapedJob, { outcome: 'failed', trail: ['failed'] }).officialPosting;
  const record = { scrapedJob: structuredClone(scrapedJob), officialPosting: structuredClone(officialPosting),
    description: typeof result.description === 'string' ? result.description : undefined,
    postedBy: result.postedBy || '', applyUrl: officialPosting.officialApplyUrl || '', aliases, createdAt: now };
  const resolutionId = crypto.randomUUID();
  prepared.set(resolutionId, record);
  let bytes = [...prepared.values()].reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
  while (prepared.size > MAX_PREPARED_RECORDS || bytes > MAX_PREPARED_BYTES) {
    const first = prepared.keys().next().value; bytes -= Buffer.byteLength(JSON.stringify(prepared.get(first))); prepared.delete(first);
  }
  return { resolutionId: prepared.has(resolutionId) ? resolutionId : undefined, officialPosting: record.officialPosting, postedBy: record.postedBy };
}

/** UUIDs carry no renderer authority. Failed/foreign lookups do not consume a
 * valid entry that another queued click still owns. */
export function getPreparedOfficialPosting(resolutionId, scrapedJob, { now = Date.now() } = {}) {
  if (typeof resolutionId !== 'string' || !/^[a-f0-9-]{36}$/u.test(resolutionId)) return null;
  const record = prepared.get(resolutionId);
  if (!record || now - record.createdAt >= PREPARED_TTL_MS) { prepared.delete(resolutionId); return null; }
  if (!officialPostingRecordMatchesScrapedIdentity(scrapedJob, record)
    || JSON.stringify(aliasesOf(scrapedJob)) !== JSON.stringify(record.aliases)) return null;
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

async function reverify(job, record, { fetch, signal, now, store }) {
  const prior = record.officialPosting; const url = prior.sourceUrl;
  const postedBy = strictEmployerEqual(job.company, prior.employer) ? '' : job.company;
  const preserve = async code => {
    let description;
    if (textLevels.has(prior.level) && prior.contentHash) try { description = await store.readText(prior.contentHash); } catch { /* A missing text file cannot invalidate the proof record. */ }
    active(signal);
    // A failed recheck does not turn the prior complete discovery proof into
    // a partial crawl. Keep old trail codes; classify only this new failure.
    const recheckCode = ['fetch-timeout', 'crawl-budget'].includes(code) ? 'fetch-failed' : code;
    return { postedBy, officialPosting: withTrail(prior, recheckCode, 'reverify-failed'), ...(typeof description === 'string' ? { description } : {}) };
  };
  const closed = () => unresolvedOfficialPosting(job, { outcome: 'closed', trail: ['closed'] });
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
  // Proof is inherited only for this exact stored URL. Changed content still
  // passes current employer, title, location and tenant hard gates.
  const verified = { ...candidate, tenantProven: Boolean(route && prior.tenant && route.tenant === prior.tenant),
    employerDomainProven: !route, officialPortalProven: /^(?:www\.)?usajobs\.gov$/u.test(new URL(url).hostname) };
  const evaluation = evaluateOfficialPostingMatch(job, verified, { now: now(), employerHypotheses: [prior.employer] });
  if (!strictEmployerEqual(candidate.employer, prior.employer) || (!evaluation.passed && evaluation.reason !== 'no-anchor')) {
    return preserve(strictEmployerEqual(candidate.employer, prior.employer) ? evaluation.reason : 'employer-mismatch');
  }
  if (typeof candidate.description !== 'string' || !candidate.description.trim()) return preserve('unreadable');
  const changed = sha256(candidate.description) !== prior.contentHash;
  if (!changed) {
    return { postedBy, officialPosting: withTrail(prior, 'reverified'), ...(textLevels.has(prior.level) ? { description: candidate.description } : {}) };
  }
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
  slots = semaphore, callRaw, callMatch, telemetry = { failed: 0 },
} = {}) {
  const failed = error => {
    telemetry.failed = (Number(telemetry.failed) || 0) + 1;
    console.warn('[OfficialPosting] Prepare failed:', error?.code || error?.name || 'Error');
  };
  let scrapedJob;
  try {
    scrapedJob = structuredClone(projectJob(args.job || {}));
    if (!scrapedJob || typeof scrapedJob !== 'object' || Array.isArray(scrapedJob)) throw new TypeError('Invalid scraped job projection.');
  }
  catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    failed(error);
    return { officialPosting: unresolvedOfficialPosting(args.job, { outcome: 'failed', trail: ['failed'] }).officialPosting,
      telemetry: { failed: telemetry.failed } };
  }
  delete scrapedJob.applyUrl; delete scrapedJob.officialPosting; delete scrapedJob.postedBy;
  const controller = new AbortController(); const abort = () => controller.abort(signal.reason || errorWithCode('bridge-aborted'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(errorWithCode('bridge-timeout')), timeoutMs); timer.unref?.();
  let onAbort; const cancelled = new Promise((_, reject) => { onAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener('abort', onAbort, { once: true });
  let release; let result; let bridgeAvailable = false; let verifiedFallback; let resolvedTelemetry = null;
  try {
    result = await Promise.race([(async () => {
      active(controller.signal);
      try { bridgeAvailable = available(await bridgeStatus()); } catch { bridgeAvailable = false; }
      active(controller.signal); release = await slots.acquire(controller.signal); active(controller.signal);
      store ||= getOfficialPostingStore();
      const record = await store.find(scrapedJob); active(controller.signal);
      if (record && officialPostingRecordMatchesScrapedIdentity(scrapedJob, record)) {
        const storedPosting = normalizeOfficialPosting(record.officialPosting);
        if (officialLevels.has(storedPosting?.level) && shouldPersistOfficialPostingResult(record, { signal: controller.signal })) {
          verifiedFallback = { officialPosting: storedPosting,
            postedBy: strictEmployerEqual(scrapedJob.company, storedPosting.employer) ? '' : scrapedJob.company };
          if (textLevels.has(storedPosting.level) && storedPosting.contentHash) try {
            const cachedText = await store.readText(storedPosting.contentHash);
            if (typeof cachedText === 'string') verifiedFallback.description = cachedText;
          } catch { /* Keep proof metadata when the stored text cannot be read. */ }
          active(controller.signal);
          const verified = await reverify(scrapedJob, record, { fetch, signal: controller.signal, now, store }); active(controller.signal);
          if (!bridgeAvailable) verified.officialPosting = withTrail(verified.officialPosting, 'bridge-unavailable');
          await store.save(scrapedJob, { officialPosting: verified.officialPosting, description: verified.description, expectedRecord: record }); active(controller.signal);
          return verified;
        }
        if (shouldPersistOfficialPostingResult(record, { signal: controller.signal })) return unresolvedOfficialPosting(scrapedJob, { outcome: record.officialPosting.outcome,
          trail: [...(record.officialPosting.trail || []), 'recent-miss'], alternatives: record.officialPosting.alternatives || [] });
      }
      const resolved = await resolve([scrapedJob], { store, fetch, signal: controller.signal,
        manualAiRunId: args.manualAiRunId, nodeId: args.nodeId, callRaw, callMatch, now, bridgeAvailable,
        timeoutMs });
      resolvedTelemetry = mergeOfficialPostingTelemetry(resolved.telemetry);
      active(controller.signal);
      const posting = resolved.jobs[0]?.officialPosting;
      if (!normalizeOfficialPosting(posting)) return unresolvedOfficialPosting(scrapedJob, { outcome: 'failed', trail: ['fetch-failed'] });
      return { officialPosting: posting, postedBy: resolved.jobs[0].postedBy,
        description: textLevels.has(posting.level) && posting.contentHash ? await store.readText(posting.contentHash) : undefined };
    })(), cancelled]);
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    failed(error);
    const code = controller.signal.reason?.code === 'bridge-timeout' ? 'bridge-timeout' : error?.code || 'fetch-failed';
    result = code === 'bridge-timeout' && controller.signal.aborted && verifiedFallback
      ? { ...verifiedFallback, officialPosting: withTrail(verifiedFallback.officialPosting, 'bridge-timeout', 'reverify-failed') }
      : unresolvedOfficialPosting(scrapedJob, { outcome: 'failed', trail: [code] });
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); release?.();
  }
  if (!bridgeAvailable) result.officialPosting = withTrail(result.officialPosting, 'bridge-unavailable');
  try { return { ...remember(scrapedJob, result, now()), telemetry: { failed: telemetry.failed, ...(resolvedTelemetry ? { officialPosting: resolvedTelemetry } : {}) } }; }
  catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    failed(error);
    return { officialPosting: unresolvedOfficialPosting(scrapedJob, { outcome: 'failed', trail: ['failed'] }).officialPosting,
      telemetry: { failed: telemetry.failed, ...(resolvedTelemetry ? { officialPosting: resolvedTelemetry } : {}) } };
  }
}

function validateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['job', 'nodeId', 'cardId', 'manualAiRunId'].includes(key))
    || !args.job || typeof args.job !== 'object' || Array.isArray(args.job)
    || ![args.nodeId, args.cardId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,300}$/u.test(id))
    || typeof args.manualAiRunId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/u.test(args.manualAiRunId)) throw new TypeError('Invalid official posting preparation request.');
}
export function registerOfficialPostingGenerationHandlers({ projectJob, ...dependencies } = {}) {
  if (typeof projectJob !== 'function') throw new TypeError('Official posting preparation needs the queue job projection.');
  handleSafe('prepare-official-posting-for-generation', (_event, args, signal) => prepareOfficialPostingForGeneration(args,
    { ...dependencies, projectJob, signal }), { validateArgs, additionalNodeIds: args => [args.cardId], reportCancellation: true });
}
