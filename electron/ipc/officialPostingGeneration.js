import crypto from 'node:crypto';
import { handleSafe } from './ipcUtils.js';
import { getHandoffBridgeStatus } from './handoffBridge/index.js';
import { officialPostingAliases, officialPostingRecordMatchesScrapedIdentity } from './officialPostingStore.js';
import { getOfficialPostingStore, resolveOfficialPostings } from './officialPostingService.js';
import { fetchOfficialPosting } from './officialPostingFetch.js';
import { extractOfficialPostingCandidates } from './officialPostingExtractors.js';
import { evaluateOfficialPostingMatch, frozenOfficialEmployer } from './officialPostingMatch.js';
import { extractAtsTenant, strictEmployerEqual } from './officialSourceHosts.js';
import { officialPostingAdapterUrl, readableOfficialPostingDescription, unresolvedOfficialPosting, verifiedOfficialPostingApplyUrl } from './officialPostingResolver.js';
import { normalizeOfficialLocation, normalizeOfficialPosting, normalizeOfficialSalary, officialHttpsUrl, OFFICIAL_POSTING_TRAIL } from './officialPostingFields.js';

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
function withTrail(posting, ...codes) { return { ...posting, trail: [...new Set([...(posting.trail || []), ...codes].filter(code => OFFICIAL_POSTING_TRAIL.includes(code)))].slice(-32) }; }
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
  const record = { scrapedJob: structuredClone(scrapedJob), officialPosting: structuredClone(result.officialPosting),
    description: typeof result.description === 'string' ? result.description : undefined,
    postedBy: result.postedBy || '', applyUrl: result.officialPosting.officialApplyUrl || '', aliases, createdAt: now };
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

async function reverify(job, record, { fetch, signal, now }) {
  const prior = record.officialPosting; const url = prior.sourceUrl;
  if (!url || !prior.employer) return unresolvedOfficialPosting(job, { outcome: 'unreadable', trail: ['unreadable'] });
  let page;
  try { page = await fetch(url, { signal }); active(signal); }
  catch (error) {
    active(signal);
    if (error?.code === 'closed') return unresolvedOfficialPosting(job, { outcome: 'closed', trail: ['closed'] });
    return { postedBy: strictEmployerEqual(job.company, prior.employer) ? '' : job.company,
      officialPosting: withTrail({ ...prior, level: 'L4', outcome: 'unreadable', contentHash: undefined }, error?.code || 'fetch-failed') };
  }
  if (page.statusCode && page.statusCode !== 200) return unresolvedOfficialPosting(job, { outcome: 'closed', trail: ['closed'] });
  const fetchedUrl = officialHttpsUrl(page.url || page.sourceUrl || url);
  if (fetchedUrl !== officialHttpsUrl(url)) return unresolvedOfficialPosting(job, { outcome: 'not-found', trail: ['unsafe-url'] });
  const route = extractAtsTenant(url, { html: page.body });
  const extract = value => extractOfficialPostingCandidates({ body: value.body, sourceUrl: value.url || value.sourceUrl || url,
    contentType: value.contentType, ats: route?.ats || prior.ats || '', tenant: route?.tenant || prior.tenant || '', employer: prior.employer, now });
  let candidates = extract(page).filter(candidate => officialHttpsUrl(candidate.sourceUrl) === officialHttpsUrl(url));
  if (!candidates.length && route) {
    const adapter = officialPostingAdapterUrl(route, url);
    if (adapter) try {
      const board = await fetch(adapter, { signal }); active(signal);
      if (officialHttpsUrl(board.url || board.sourceUrl || adapter) === officialHttpsUrl(adapter)) candidates = extract(board)
        .filter(candidate => officialHttpsUrl(candidate.sourceUrl) === officialHttpsUrl(url));
    } catch { active(signal); }
  }
  if (!candidates.length) return { postedBy: strictEmployerEqual(job.company, prior.employer) ? '' : job.company,
    officialPosting: withTrail({ ...prior, level: 'L4', outcome: 'unreadable', contentHash: undefined }, 'unreadable', 'reverified') };
  if (candidates.length !== 1) return unresolvedOfficialPosting(job, { outcome: 'ambiguous', trail: ['ambiguous'] });
  const candidate = candidates[0];
  // These proof flags come only from the original host record and its exact
  // canonical URL. New page fields must still pass every current hard gate.
  const verified = { ...candidate, tenantProven: Boolean(route && prior.tenant && route.tenant === prior.tenant),
    employerDomainProven: !route, officialPortalProven: /^(?:www\.)?usajobs\.gov$/u.test(new URL(url).hostname) };
  const evaluation = evaluateOfficialPostingMatch(job, verified, { now: now(), employerHypotheses: [prior.employer] });
  if (!strictEmployerEqual(candidate.employer, prior.employer) || (!evaluation.passed && evaluation.reason !== 'no-anchor')) {
    const code = strictEmployerEqual(candidate.employer, prior.employer) ? evaluation.reason : 'employer-mismatch';
    return unresolvedOfficialPosting(job, { outcome: code === 'closed' ? 'closed' : 'not-found', trail: [code] });
  }
  const employer = frozenOfficialEmployer(job, candidate.employer);
  const readable = employer && readableOfficialPostingDescription(candidate, job);
  const posting = normalizeOfficialPosting({ ...prior, employer, level: readable ? prior.level === 'L4' ? route ? 'L3' : 'L1' : prior.level : 'L4',
    outcome: readable ? 'found' : 'link-only', title: candidate.title,
    location: normalizeOfficialLocation(candidate.location) || prior.location,
    salary: normalizeOfficialSalary(candidate.salary) || { text: '', provenance: 'unknown' },
    sourceUrl: url, officialApplyUrl: verifiedOfficialPostingApplyUrl(candidate), fetchedAt: new Date(now()).toISOString(),
    contentHash: readable ? sha256(candidate.description) : undefined,
    trail: [...new Set([...(prior.trail || []), 'reverified', ...(!readable ? ['stub-text'] : [])])].slice(-32) });
  if (!posting) return unresolvedOfficialPosting(job, { outcome: 'unreadable', trail: ['invalid-text'] });
  active(signal);
  return { officialPosting: posting, postedBy: strictEmployerEqual(job.company, employer) ? '' : job.company,
    description: readable ? candidate.description : undefined };
}

/** Whole-budget prepare includes the semaphore wait. Every non-cancellation
 * failure produces a bounded host fallback for the normal application gate. */
export async function prepareOfficialPostingForGeneration(args, {
  projectJob = value => value, signal, store, fetch = fetchOfficialPosting, resolve = resolveOfficialPostings,
  bridgeStatus = getHandoffBridgeStatus, now = Date.now, timeoutMs = OFFICIAL_POSTING_PREPARE_TIMEOUT_MS,
  slots = semaphore, callRaw,
} = {}) {
  const scrapedJob = structuredClone(projectJob(args.job || {}));
  delete scrapedJob.applyUrl; delete scrapedJob.officialPosting; delete scrapedJob.postedBy;
  const controller = new AbortController(); const abort = () => controller.abort(signal.reason || errorWithCode('bridge-aborted'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(errorWithCode('bridge-timeout')), timeoutMs); timer.unref?.();
  let onAbort; const cancelled = new Promise((_, reject) => { onAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener('abort', onAbort, { once: true });
  let release; let result; let bridgeAvailable = false;
  try {
    result = await Promise.race([(async () => {
      active(controller.signal);
      try { bridgeAvailable = available(await bridgeStatus()); } catch { bridgeAvailable = false; }
      active(controller.signal); release = await slots.acquire(controller.signal); active(controller.signal);
      store ||= getOfficialPostingStore();
      const record = await store.find(scrapedJob); active(controller.signal);
      if (record && officialPostingRecordMatchesScrapedIdentity(scrapedJob, record)) {
        if (officialLevels.has(record.officialPosting.level)) {
          const verified = await reverify(scrapedJob, record, { fetch, signal: controller.signal, now }); active(controller.signal);
          if (!bridgeAvailable) verified.officialPosting = withTrail(verified.officialPosting, 'bridge-unavailable');
          await store.save(scrapedJob, { officialPosting: verified.officialPosting, description: verified.description, expectedRecord: record }); active(controller.signal);
          return verified;
        }
        return unresolvedOfficialPosting(scrapedJob, { outcome: record.officialPosting.outcome,
          trail: [...(record.officialPosting.trail || []), 'recent-miss'] });
      }
      const resolved = await resolve([scrapedJob], { store, fetch, signal: controller.signal,
        manualAiRunId: args.manualAiRunId, nodeId: args.nodeId, callRaw, now, bridgeAvailable,
        timeoutMs });
      active(controller.signal);
      const posting = resolved.jobs[0]?.officialPosting;
      if (!normalizeOfficialPosting(posting)) return unresolvedOfficialPosting(scrapedJob, { outcome: 'failed', trail: ['fetch-failed'] });
      return { officialPosting: posting, postedBy: resolved.jobs[0].postedBy,
        description: textLevels.has(posting.level) && posting.contentHash ? await store.readText(posting.contentHash) : undefined };
    })(), cancelled]);
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    const code = controller.signal.reason?.code === 'bridge-timeout' ? 'bridge-timeout' : error?.code || 'fetch-failed';
    result = unresolvedOfficialPosting(scrapedJob, { outcome: 'failed', trail: [code] });
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); release?.();
  }
  if (!bridgeAvailable) result.officialPosting = withTrail(result.officialPosting, 'bridge-unavailable');
  return remember(scrapedJob, result, now());
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
